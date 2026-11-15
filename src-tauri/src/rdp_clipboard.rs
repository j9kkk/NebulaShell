//! 远程桌面的剪贴板共享（CLIPRDR 静态通道，文本部分）。
//!
//! 与 mstsc 的差别：mstsc 靠系统剪贴板回调自动同步。这里的 macOS 端没有挂钩，
//! 改用**轮询 + 按需拉取**，对用户仍然是「复制就带过去、复制就带回来」：
//!
//! - 本机 → 远端：后台线程每 1.2s 跑一次 `pbpaste`，文本变了就 `initiate_copy`
//!   发一个 FormatList；Windows 侧按下 Ctrl+V 时服务端来要数据，我们回 UTF-16。
//! - 远端 → 本机：服务端发来 FormatList 说明远端剪贴板变了，`pending_paste` 置位，
//!   会话循环随即 `initiate_paste` 拉一次文本，写回 `pbcopy`。
//!
//! 只做文本。文件/图片（FileGroupDescriptorW、CF_DIB 等）明确不广告，避免
//! 服务端发来我们处理不了的格式而卡住整条通道。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ironrdp_cliprdr::backend::CliprdrBackend;
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
};

/// 本机剪贴板轮询间隔。太短会把 pbpaste 的 fork 成本摊到帧率上，太长手感像丢按键。
pub const LOCAL_POLL_INTERVAL: Duration = Duration::from_millis(1200);

/// 双方共享的剪贴板状态（后端回调与会话循环各持一份 Arc）。
#[derive(Debug)]
pub struct ClipState {
    /// 本机剪贴板当前文本（轮询线程写）
    pub local_text: String,
    /// 服务端最近一次索取数据的格式（会话循环负责应答）
    pub pending_request: Option<u32>,
    /// 远端剪贴板变了，需要主动拉一次
    pub pending_paste: bool,
    /// 已协商出的能力位
    pub negotiated: ClipboardGeneralCapabilityFlags,
    /// 通道握手完成（服务端发过 MonitorReady）
    pub ready: bool,
    /// 本机文本的变化计数，用来判断轮询要不要发 FormatList
    pub local_seq: u64,
    /// 已经广告出去的 local_seq，避免同一份文本反复发
    pub advertised_seq: u64,
    /// 收到的远端文本，会话循环负责写回本机
    pub incoming_text: Option<String>,
}

impl Default for ClipState {
    fn default() -> Self {
        Self {
            local_text: String::new(),
            pending_request: None,
            pending_paste: false,
            negotiated: ClipboardGeneralCapabilityFlags::empty(),
            ready: false,
            local_seq: 0,
            advertised_seq: 0,
            incoming_text: None,
        }
    }
}

pub type SharedClip = Arc<Mutex<ClipState>>;

/// CLIPRDR 后端：只维护状态，真正的收发包由会话循环做。
#[derive(Debug)]
pub struct ClipboardBridge {
    shared: SharedClip,
    temp_dir: String,
    formats: Vec<ClipboardFormat>,
}

impl ClipboardBridge {
    pub fn new(shared: SharedClip) -> Self {
        Self {
            shared,
            temp_dir: std::env::temp_dir().to_string_lossy().to_string(),
            formats: vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)],
        }
    }
}

impl ironrdp_core::AsAny for ClipboardBridge {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl CliprdrBackend for ClipboardBridge {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        // 显式只要文本能力：文件传输与锁数据一律不广告
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        if let Ok(mut st) = self.shared.lock() {
            st.ready = true;
        }
    }

    fn on_request_format_list(&mut self) {
        // 客户端不发初始 FormatList：等本机剪贴板真的变了再广告
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        if let Ok(mut st) = self.shared.lock() {
            st.negotiated = capabilities;
        }
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        // 远端有新内容；只有文本格式才值得去拉
        let has_text = available_formats
            .iter()
            .any(|f| f.id == ClipboardFormatId::CF_UNICODETEXT);
        if let Ok(mut st) = self.shared.lock() {
            st.pending_paste = has_text;
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        if let Ok(mut st) = self.shared.lock() {
            st.pending_request = Some(request.format.0);
        }
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        let Ok(text) = response.to_unicode_string() else {
            return;
        };
        if text.is_empty() {
            return;
        }
        if let Ok(mut st) = self.shared.lock() {
            st.incoming_text = Some(text);
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {
        // 没广告文件格式，服务端不该来要；来了就忽略
    }

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

/// 读本机剪贴板文本（macOS: pbpaste）。
pub fn read_local_clipboard() -> Option<String> {
    let out = std::process::Command::new("pbpaste").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// 写本机剪贴板（macOS: pbcopy）。调用方负责放到后台线程，别堵帧泵。
pub fn write_local_clipboard(text: &str) {
    use std::io::Write as _;
    let Ok(mut child) = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
    else {
        return;
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(text.as_bytes());
    }
    let _ = child.wait();
}

/// 轮询本机剪贴板，文本一变就把 `local_seq` 推进（不在这里发包）。
///
/// 用独立 std 线程：`pbpaste` 是 fork + exec，放进 tokio 里会跟帧泵抢同一个
/// LocalSet 线程，一秒钟卡一帧的代价远比省下的这几行代码贵。
pub fn spawn_local_poller(
    shared: SharedClip,
    alive: Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("rdp-clipboard-poll".to_string())
        .spawn(move || {
            let mut last = Instant::now() - LOCAL_POLL_INTERVAL;
            loop {
                if !alive.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(LOCAL_POLL_INTERVAL);
                if last.elapsed() < LOCAL_POLL_INTERVAL {
                    continue;
                }
                last = Instant::now();
                let Some(text) = read_local_clipboard() else {
                    continue;
                };
                let Ok(mut st) = shared.lock() else { return };
                if st.local_text == text {
                    continue;
                }
                st.local_text = text;
                st.local_seq = st.local_seq.wrapping_add(1);
            }
        })
        .expect("spawn clipboard poller")
}

/// 服务端索取某格式的数据时的应答：只认 UTF-16 文本，其余报错帧。
pub fn build_format_data_response(format: u32, local_text: &str) -> FormatDataResponse<'static> {
    if format == ClipboardFormatId::CF_UNICODETEXT.0 {
        FormatDataResponse::new_unicode_string(local_text)
    } else {
        FormatDataResponse::new_error()
    }
}

#[cfg(test)]
mod tests;
