use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// 主机名 → 文件名标签:保留字母数字(含中文)、`.`、`-`、`_`,其余换成 `_`,
/// 连续 `_` 合并,截到 60 个字符;为空时用 `session`。
pub fn sanitize_label(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars() {
        let c = if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
            c
        } else {
            '_'
        };
        if c == '_' && out.ends_with('_') {
            continue;
        }
        out.push(c);
        if out.chars().count() >= 60 {
            break;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "session".into()
    } else {
        trimmed
    }
}

/// 在 dir 下找第一个不存在的 `{label}_{stamp}[_N].log`,不覆盖已有文件。
/// 并发场景由调用方的 create_new 兜底:仍撞名则继续顺延。
pub fn next_log_file(dir: &Path, label: &str, stamp: &str) -> PathBuf {
    let base = dir.join(format!("{}_{}.log", label, stamp));
    if !base.exists() {
        return base;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{}_{}_{}.log", label, stamp, n));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{}_{}_{}.log", label, stamp, uuid::Uuid::new_v4()))
}

/// 常见文件系统错误转成用户能懂的说法;其余保留系统原文。
pub fn friendly_io_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "权限不足".into(),
        std::io::ErrorKind::StorageFull => "磁盘空间不足".into(),
        std::io::ErrorKind::ReadOnlyFilesystem => "只读文件系统".into(),
        std::io::ErrorKind::NotFound => "路径不存在".into(),
        _ => error.to_string(),
    }
}

/// 建日志文件(exclusive create,Unix 上 0600)。目标已存在时按 `_2`、`_3` 顺延,
/// 绝不覆盖。返回最终路径与文件句柄。
pub fn open_log_file(
    dir: &Path,
    label: &str,
    stamp: &str,
) -> std::io::Result<(PathBuf, std::fs::File)> {
    let mut candidate = next_log_file(dir, label, stamp);
    loop {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(handle) => return Ok((candidate, handle)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = next_log_file(&candidate.parent().unwrap_or(dir), label, stamp);
            }
            Err(error) => return Err(error),
        }
    }
}

pub struct LogEntry {
    pub file: PathBuf,
    sender: Mutex<Option<mpsc::SyncSender<String>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    error: LogError,
    timestamps: bool,
    bytes: AtomicU64,
    /// 该会话此前是否连上过:连接成功时由 mark_connected 查询并置位。
    /// 初值 connected_at_start:手动开始时日志开在已连接的会话上( true,
    /// 下一次连接成功必是重连);0.5.0 连接即录时开在连接之前( false,
    /// 首次连接成功不算重连)。
    ever_connected: AtomicBool,
}

impl LogEntry {
    pub fn new(
        file: PathBuf,
        handle: std::fs::File,
        timestamps: bool,
        connected_at_start: bool,
        on_error: impl Fn(String) + Send + 'static,
    ) -> Result<Arc<Self>, String> {
        Self::with_writer(file, handle, timestamps, connected_at_start, 1024, on_error)
    }

    fn with_writer(
        file: PathBuf,
        mut handle: impl Write + Send + 'static,
        timestamps: bool,
        connected_at_start: bool,
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
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
            error,
            timestamps,
            bytes: AtomicU64::new(0),
            ever_connected: AtomicBool::new(connected_at_start),
        }))
    }

    pub fn active(&self) -> bool {
        let failed = self.error.lock().unwrap().is_some();
        !failed && self.sender.lock().unwrap().is_some()
    }

    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    pub fn name(&self) -> String {
        self.file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    /// 连接成功时调用:返回置位前的值 —— true 表示这是重连续录。
    pub fn mark_connected(&self) -> bool {
        self.ever_connected.swap(true, Ordering::Relaxed)
    }

    fn send(&self, line: String) -> Result<(), String> {
        // The first failure is reported once. Later output is discarded rather
        // than flooding log events for every terminal frame.
        let failed = self.error.lock().unwrap().is_some();
        if failed {
            self.sender.lock().unwrap().take();
            return Ok(());
        }
        let mut guard = self.sender.lock().unwrap();
        let Some(sender) = guard.as_ref() else {
            return Ok(());
        };
        if let Err(error) = sender.try_send(line) {
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

    pub fn record(&self, data: &str) -> Result<(), String> {
        let line = if self.timestamps {
            format!("[OUT] {} {}", chrono::Local::now().to_rfc3339(), data)
        } else {
            data.to_string()
        };
        self.send(line.clone())?;
        self.bytes.fetch_add(line.len() as u64, Ordering::Relaxed);
        Ok(())
    }

    /// 断开/重连/停止等事件:独立一行,自带时间,不加输出前缀。
    pub fn event(&self, text: &str) -> Result<(), String> {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let line = format!("\r\n----- {} {} -----\r\n", stamp, text);
        self.send(line.clone())?;
        self.bytes.fetch_add(line.len() as u64, Ordering::Relaxed);
        Ok(())
    }

    /// 停止:先写结束标记(注明原因),再关闭队列并等待写线程排空。
    pub fn stop(&self, reason: &str) -> Result<(), String> {
        let _ = self.event(&format!("记录停止（{}）", reason));
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

    fn temp_log_path() -> PathBuf {
        std::env::temp_dir().join(format!("nebula-log-{}.txt", uuid::Uuid::new_v4()))
    }

    #[test]
    fn output_goes_to_file_and_stop_writes_marker() {
        let path = temp_log_path();
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            false,
            false,
            |_| {},
        )
        .unwrap();
        entry.record("server output\n").unwrap();
        let before = entry.bytes();
        entry.stop("手动停止").unwrap();
        entry.record("after stop").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("server output\n"));
        assert!(content.contains("记录停止（手动停止）"));
        assert!(!content.contains("after stop"));
        assert!(entry.bytes() > before);
        assert!(!entry.active());
        entry.stop("手动停止").unwrap();
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
            entry.record("output").unwrap();
            let error = entry.stop("手动停止").unwrap_err();
            assert!(error.contains(if fail_flush {
                "flush failed"
            } else {
                "write failed"
            }));
            assert!(!entry.active());
            entry.record("later output").unwrap();
            assert_eq!(errors.lock().unwrap().len(), 1);
            assert_eq!(entry.stop("手动停止").unwrap_err(), error);
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
            false,
            1,
            |_| panic!("queue failure is returned to the caller"),
        )
        .unwrap();
        entry.record("first").unwrap();
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        entry.event("连接已断开：网络中断").unwrap();
        assert!(entry
            .record("overflow")
            .unwrap_err()
            .contains("日志队列不可用"));
        assert!(!entry.active());
        assert!(entry.sender.lock().unwrap().is_none());
        entry.record("later").unwrap();
        resume_tx.send(()).unwrap();
        resume_tx.send(()).unwrap();
        resume_tx.send(()).unwrap();
        assert!(entry.stop("手动停止").is_err());
        let written = output.lock().unwrap().clone();
        assert!(written.windows(5).any(|w| w == b"first"));
        assert!(String::from_utf8_lossy(&written).contains("连接已断开：网络中断"));
    }

    #[test]
    fn mark_connected_reports_reconnection() {
        let path = temp_log_path();
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            false,
            false,
            |_| {},
        )
        .unwrap();
        assert!(!entry.mark_connected());
        assert!(entry.mark_connected());
        entry.stop("会话已关闭").unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn sanitize_label_keeps_readable_names() {
        assert_eq!(sanitize_label("web-01.example.com"), "web-01.example.com");
        assert_eq!(sanitize_label("生产环境 Web 服务器"), "生产环境_Web_服务器");
        assert_eq!(sanitize_label("a///b:"), "a_b");
        assert_eq!(sanitize_label("___"), "session");
        assert_eq!(sanitize_label(""), "session");
        assert_eq!(sanitize_label("root@10.0.0.1:22"), "root_10.0.0.1_22");
        let long = sanitize_label("x".repeat(100).as_str());
        assert_eq!(long.chars().count(), 60);
    }

    #[test]
    fn next_log_file_never_collides() {
        let dir = std::env::temp_dir().join(format!("nebula-logdir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = next_log_file(&dir, "web", "2026-10-11_10-00-00");
        assert_eq!(first.file_name().unwrap(), "web_2026-10-11_10-00-00.log");
        std::fs::File::create(&first).unwrap();
        let second = next_log_file(&dir, "web", "2026-10-11_10-00-00");
        assert_eq!(second.file_name().unwrap(), "web_2026-10-11_10-00-00_2.log");
        std::fs::File::create(&second).unwrap();
        let third = next_log_file(&dir, "web", "2026-10-11_10-00-00");
        assert_eq!(third.file_name().unwrap(), "web_2026-10-11_10-00-00_3.log");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn open_log_file_picks_free_name_with_owner_only_mode() {
        let dir = std::env::temp_dir().join(format!("nebula-logdir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (path, handle) = open_log_file(&dir, "web", "2026-10-11_10-00-00").unwrap();
        drop(handle);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let (path2, handle2) = open_log_file(&dir, "web", "2026-10-11_10-00-00").unwrap();
        drop(handle2);
        assert_ne!(path, path2);
        assert!(path2
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("_2.log"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
