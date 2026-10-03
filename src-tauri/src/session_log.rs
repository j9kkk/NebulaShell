use std::io::Write;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};

type LogError = Arc<Mutex<Option<String>>>;

fn fail_once(error: &LogError, message: String) -> bool {
    let mut error = error.lock().unwrap();
    if error.is_some() {
        return false;
    }
    *error = Some(message);
    true
}

pub struct LogEntry {
    pub file: PathBuf,
    pub record_input: bool,
    sender: Mutex<Option<mpsc::SyncSender<String>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    error: LogError,
    timestamps: bool,
}

impl LogEntry {
    pub fn new(
        file: PathBuf,
        handle: std::fs::File,
        timestamps: bool,
        record_input: bool,
        on_error: impl Fn(String) + Send + 'static,
    ) -> Result<Arc<Self>, String> {
        Self::with_writer(file, handle, timestamps, record_input, 1024, on_error)
    }

    fn with_writer(
        file: PathBuf,
        mut handle: impl Write + Send + 'static,
        timestamps: bool,
        record_input: bool,
        capacity: usize,
        on_error: impl Fn(String) + Send + 'static,
    ) -> Result<Arc<Self>, String> {
        let (sender, receiver) = mpsc::sync_channel::<String>(capacity);
        let error = Arc::new(Mutex::new(None));
        let worker_error = error.clone();
        let worker = std::thread::Builder::new()
            .name("session-log".into())
            .spawn(move || {
                for message in receiver {
                    if let Err(error) = handle.write_all(message.as_bytes()) {
                        let message = format!("日志写入失败：{}", error);
                        if fail_once(&worker_error, message.clone()) {
                            on_error(message);
                        }
                        return;
                    }
                }
                if let Err(error) = handle.flush() {
                    let message = format!("日志保存失败：{}", error);
                    if fail_once(&worker_error, message.clone()) {
                        on_error(message);
                    }
                }
            })
            .map_err(|error| format!("日志线程启动失败：{}", error))?;
        Ok(Arc::new(Self {
            file,
            record_input,
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
            error,
            timestamps,
        }))
    }

    pub fn active(&self) -> bool {
        let failed = self.error.lock().unwrap().is_some();
        !failed && self.sender.lock().unwrap().is_some()
    }

    pub fn record(&self, data: &str, input: bool) -> Result<(), String> {
        if input && !self.record_input {
            return Ok(());
        }
        // The first failure is reported once. Later output is discarded rather
        // than flooding log:error events for every terminal frame.
        let failed = self.error.lock().unwrap().is_some();
        if failed {
            self.sender.lock().unwrap().take();
            return Ok(());
        }
        let prefix = if self.timestamps {
            format!(
                "[{}] {} ",
                if input { "IN " } else { "OUT" },
                chrono::Local::now().to_rfc3339()
            )
        } else {
            String::new()
        };
        let mut guard = self.sender.lock().unwrap();
        let Some(sender) = guard.as_ref() else {
            return Ok(());
        };
        if let Err(error) = sender.try_send(format!("{}{}", prefix, data)) {
            let message = format!("日志队列不可用，已停止记录：{}", error);
            let first = fail_once(&self.error, message.clone());
            // Closing the queue lets the worker drain accepted data and exit.
            guard.take();
            if first {
                return Err(message);
            }
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.sender.lock().unwrap().take();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            if worker.join().is_err() {
                fail_once(&self.error, "日志线程异常退出".into());
            }
        }
        match self.error.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for LogEntry {
    fn drop(&mut self) {
        self.sender.get_mut().unwrap().take();
        if let Some(worker) = self.worker.get_mut().unwrap().take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_output_log_does_not_record_input() {
        let path = std::env::temp_dir().join(format!("nebula-log-{}.txt", uuid::Uuid::new_v4()));
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            false,
            false,
            |_| {},
        )
        .unwrap();
        entry.record("secret-password\r", true).unwrap();
        entry.record("server output\n", false).unwrap();
        entry.stop().unwrap();
        entry.record("after stop", false).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "server output\n");
        assert!(!entry.active());
        entry.stop().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    struct FailingWriter {
        fail_flush: bool,
    }

    impl Write for FailingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if self.fail_flush {
                Ok(data.len())
            } else {
                Err(std::io::Error::other("write failed"))
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            if self.fail_flush {
                Err(std::io::Error::other("flush failed"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn write_and_flush_failures_are_reported_once_and_returned_by_stop() {
        for fail_flush in [false, true] {
            let errors = Arc::new(Mutex::new(Vec::new()));
            let reported = errors.clone();
            let entry = LogEntry::with_writer(
                PathBuf::new(),
                FailingWriter { fail_flush },
                false,
                false,
                16,
                move |error| reported.lock().unwrap().push(error),
            )
            .unwrap();
            entry.record("output", false).unwrap();
            let error = entry.stop().unwrap_err();
            assert!(error.contains(if fail_flush {
                "flush failed"
            } else {
                "write failed"
            }));
            assert!(!entry.active());
            entry.record("later output", false).unwrap();
            assert_eq!(errors.lock().unwrap().len(), 1);
            assert_eq!(entry.stop().unwrap_err(), error);
        }
    }

    struct BlockedWriter {
        entered: mpsc::Sender<()>,
        resume: mpsc::Receiver<()>,
        output: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for BlockedWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.entered.send(()).unwrap();
            self.resume.recv().unwrap();
            self.output.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn full_queue_closes_and_drains_without_repeating_errors() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let output = Arc::new(Mutex::new(Vec::new()));
        let entry = LogEntry::with_writer(
            PathBuf::new(),
            BlockedWriter {
                entered: entered_tx,
                resume: resume_rx,
                output: output.clone(),
            },
            false,
            true,
            1,
            |_| panic!("queue failure is returned to the caller"),
        )
        .unwrap();
        entry.record("first", false).unwrap();
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        entry.record("second", true).unwrap();
        assert!(entry
            .record("overflow", false)
            .unwrap_err()
            .contains("日志队列不可用"));
        assert!(!entry.active());
        assert!(entry.sender.lock().unwrap().is_none());
        entry.record("later", false).unwrap();
        resume_tx.send(()).unwrap();
        resume_tx.send(()).unwrap();
        assert!(entry.stop().is_err());
        assert_eq!(*output.lock().unwrap(), b"firstsecond");
    }
}
