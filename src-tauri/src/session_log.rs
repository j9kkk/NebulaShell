//! 会话日志(J1/J2):后台线程异步写入。
//!
//! 0.5.0 起日志格式分两种(设置 settings.sessionLog.format):
//! - `text`(默认):纯文本 —— 转义序列还原成屏幕上看到的行(单行编辑、`\r`
//!   进度条),颜色/窗口标题等装饰丢弃,每个非空行行首带 `[hh:mm:ss]`(该行
//!   结束的时刻),全屏程序折叠为进出两行标记。
//! - `raw`:原始终端流原样落盘,可用 `cat`/`less -R` 回放,不加时间戳。
//!
//! 日志属于会话而非某一次连接:断开只写标记(数据泵侧),重连续录同一个文件;
//! 停止时机只有用户操作、关闭会话与应用退出。写线程是唯一持有"当前行"状态的
//! 地方,数据泵只把数据和接收时间入队;队列积压超过字节上限时丢弃新数据并在
//! 追上后于日志里标注,不再因队列满而永久停止。

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use chrono::{DateTime, Local};

type LogError = Arc<Mutex<Option<String>>>;

/// 队列积压字节上限:超过即丢弃新数据(磁盘写入跟不上时宁可丢,不能卡住
/// 终端输出的热路径,也不能无声停录)。
const MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;
/// 单行截断列数:没有换行的超大输出按此切行,避免内存无界。
const MAX_COLS: usize = 16 * 1024;
/// 半截转义序列的暂存上限(跨数据块拼接用)。
const MAX_PENDING: usize = 4096;

fn fail_once(error: &LogError, message: String) -> bool {
    let mut error = error.lock().unwrap();
    if error.is_some() {
        return false;
    }
    *error = Some(message);
    true
}

// ===== 文件命名 =====

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

// ===== 消息模型 =====

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum LogFormat {
    Text,
    Raw,
}

impl LogFormat {
    pub fn parse(value: &str) -> Self {
        match value {
            "raw" => Self::Raw,
            _ => Self::Text,
        }
    }
}

/// 会话事件:标记行(断开/重连等)与结束行(停止原因 + 已记录大小)。
pub enum LogEvent {
    Marker { text: String },
    Stopped { reason: String },
}

pub enum LogMsg {
    /// 文件头(主机信息),必须是发往该日志的第一条消息。
    Header { name: String, userhost: String },
    /// 开始记录前屏幕上已有的内容(无时间戳,前后带分隔标记)。
    Preamble { lines: Vec<String> },
    /// 数据泵收到的一块输出,带接收时刻。
    Data { at: DateTime<Local>, text: String },
    Event {
        at: DateTime<Local>,
        event: LogEvent,
    },
}

impl LogMsg {
    fn wire_len(&self) -> usize {
        match self {
            LogMsg::Header { name, userhost } => name.len() + userhost.len() + 160,
            LogMsg::Preamble { lines } => lines.iter().map(|l| l.len() + 1).sum::<usize>() + 120,
            LogMsg::Data { text, .. } => text.len(),
            LogMsg::Event { event, .. } => match event {
                LogEvent::Marker { text } => text.len() + 40,
                LogEvent::Stopped { reason } => reason.len() + 80,
            },
        }
    }
}

/// record() 的失败语义:Dropped = 积压超限被丢弃(日志仍在录,前端提示一次),
/// Fatal = 写线程/队列故障(已停止)。
#[derive(Debug)]
pub enum RecordError {
    Dropped,
    Fatal(String),
}

// ===== 纯文本格式化器 =====

#[derive(Clone, Copy, PartialEq)]
enum Cell {
    /// 一个可见字符(宽字符占头格,尾格记 Tail)
    Ch(char),
    Tail,
    Blank,
}

/// 简化显示宽度:CJK/全角/常见 emoji 记 2 列,其余记 1 列。日志还原只求可读,
/// 不追求完整的 Unicode 宽度表。
fn char_width(c: char) -> usize {
    let cp = c as u32;
    if cp == 0 {
        return 0;
    }
    let wide = matches!(cp,
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xA960..=0xA97F
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE10..=0xFE19
        | 0xFE30..=0xFE6F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1F64F
        | 0x1F680..=0x1F6FF
        | 0x1F900..=0x1F9FF
        | 0x20000..=0x2FFFD
        | 0x30000..=0x3FFFD
    );
    if wide {
        2
    } else {
        1
    }
}

/// OSC/DCS/SOS/PM/APC 字符串的结束(BEL 或 ST)位置;未结束返回 None。
fn find_string_end(chars: &[char], from: usize, bel: bool) -> Option<usize> {
    let mut j = from;
    while j < chars.len() {
        if bel && chars[j] == '\x07' {
            return Some(j + 1);
        }
        if chars[j] == '\x1b' {
            return if chars.get(j + 1) == Some(&'\\') {
                Some(j + 2)
            } else {
                Some(j)
            };
        }
        j += 1;
    }
    None
}

pub(crate) struct TextFormatter {
    cells: Vec<Cell>,
    col: usize,
    /// 跨数据块拼接的半截转义序列
    pending: String,
    alt_screen: bool,
    last_date: Option<chrono::NaiveDate>,
    timestamps: bool,
}

impl TextFormatter {
    pub(crate) fn new(timestamps: bool, alt_screen: bool) -> Self {
        Self {
            cells: Vec::new(),
            col: 0,
            pending: String::new(),
            alt_screen,
            last_date: None,
            timestamps,
        }
    }

    /// 喂入一块输出(at = 接收时刻),把已完成的行追加到 out;残行留在状态里,
    /// 由下一条数据或事件(断开/停止)收尾。
    pub(crate) fn feed(&mut self, at: DateTime<Local>, text: &str, out: &mut String) {
        for c in text.chars() {
            if !self.pending.is_empty() {
                self.feed_pending(c, at, out);
                continue;
            }
            match c {
                '\x1b' => self.pending.push(c),
                // 备用屏幕内容不记录;只有转义路径能退出
                _ if self.alt_screen => {}
                '\n' | '\x0b' | '\x0c' => self.flush_line(at, out, true),
                '\r' => self.col = 0,
                '\x08' => self.col = self.col.saturating_sub(1),
                '\t' => self.col = (self.col / 8 + 1) * 8,
                c if (c as u32) < 0x20 || (c as u32) == 0x7f => {}
                c => self.print(c),
            }
            if self.col >= MAX_COLS {
                self.flush_line(at, out, false);
            }
        }
    }

    /// 结束当前行。allow_blank:显式换行时空行也要落盘(保留段落结构);
    /// 光标移动/事件收尾的空行不落盘。
    fn flush_line(&mut self, at: DateTime<Local>, out: &mut String, allow_blank: bool) {
        while let Some(last) = self.cells.last() {
            if matches!(last, Cell::Ch(_)) {
                break;
            }
            self.cells.pop();
        }
        let has_content = self
            .cells
            .iter()
            .any(|c| matches!(c, Cell::Ch(x) if !x.is_whitespace()));
        if has_content {
            let date = at.date_naive();
            // 日期标记只在跨天时插入;首行日期写在文件头里
            match self.last_date {
                Some(d) if d != date => {
                    out.push_str(&format!("----- {} -----\n", at.format("%Y-%m-%d")));
                    self.last_date = Some(date);
                }
                None => self.last_date = Some(date),
                _ => {}
            }
            if self.timestamps {
                out.push_str(&format!("[{}] ", at.format("%H:%M:%S")));
            }
            let mut line = String::new();
            let mut i = 0;
            while i < self.cells.len() {
                match self.cells[i] {
                    Cell::Ch(c) => {
                        line.push(c);
                        i += if char_width(c) == 2 { 2 } else { 1 };
                    }
                    // 宽字符尾巴或空洞:渲染为空格
                    _ => {
                        line.push(' ');
                        i += 1;
                    }
                }
            }
            out.push_str(line.trim_end());
            out.push('\n');
        } else if allow_blank {
            out.push('\n');
        }
        self.cells.clear();
        self.col = 0;
    }

    fn print(&mut self, c: char) {
        let w = char_width(c);
        if w == 0 {
            return;
        }
        while self.cells.len() < self.col {
            self.cells.push(Cell::Blank);
        }
        // 覆盖宽字符尾巴时,把它的头一并清掉,避免渲染错位
        if self.cells.len() > self.col && self.cells[self.col] == Cell::Tail && self.col > 0 {
            self.cells[self.col - 1] = Cell::Blank;
        }
        let need = self.col + w;
        while self.cells.len() < need {
            self.cells.push(Cell::Blank);
        }
        self.cells[self.col] = Cell::Ch(c);
        for i in self.col + 1..need {
            self.cells[i] = if w == 2 && i == self.col + 1 {
                Cell::Tail
            } else {
                Cell::Blank
            };
        }
        self.col += w;
    }

    fn feed_pending(&mut self, c: char, at: DateTime<Local>, out: &mut String) {
        self.pending.push(c);
        if self.pending.chars().count() > MAX_PENDING {
            self.pending.clear();
            return;
        }
        let chars: Vec<char> = self.pending.chars().collect();
        match chars.get(1) {
            None => {}
            Some('[') => {
                // CSI:参数 0x30-0x3F,中间字节 0x20-0x2F,终结符 0x40-0x7E
                let mut j = 2;
                while j < chars.len() && ('\x30'..='\x3f').contains(&chars[j]) {
                    j += 1;
                }
                while j < chars.len() && ('\x20'..='\x2f').contains(&chars[j]) {
                    j += 1;
                }
                if j < chars.len() {
                    self.pending.clear();
                    if ('\x40'..='\x7e').contains(&chars[j]) {
                        let params: String = chars[2..j].iter().collect();
                        self.handle_csi(&params, chars[j], at, out);
                    }
                }
            }
            Some(']') => {
                if find_string_end(&chars, 2, true).is_some() {
                    self.pending.clear();
                }
            }
            Some('P' | 'X' | '^' | '_') => {
                if find_string_end(&chars, 2, false).is_some() {
                    self.pending.clear();
                }
            }
            Some(c2) => {
                // 两字节序列(ESC 7)或带中间字节的序列(ESC ( B)
                if ('\x20'..='\x2f').contains(c2) {
                    let mut j = 2;
                    while j < chars.len() && ('\x20'..='\x2f').contains(&chars[j]) {
                        j += 1;
                    }
                    if j < chars.len() {
                        self.pending.clear();
                    }
                } else {
                    self.pending.clear();
                }
            }
        }
    }

    fn handle_csi(&mut self, params: &str, final_ch: char, at: DateTime<Local>, out: &mut String) {
        let param = |idx: usize| -> usize {
            params
                .trim_start_matches('?')
                .split(&[';', ':'][..])
                .nth(idx)
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0)
        };
        let count = || {
            let v = param(0);
            if v == 0 {
                1
            } else {
                v
            }
        };
        match final_ch {
            'h' | 'l' => {
                // 备用屏幕:smcup/rmcup(?47 / ?1047 / ?1049)
                if params
                    .trim_start_matches('?')
                    .split(';')
                    .any(|s| matches!(s, "1049" | "1047" | "47"))
                {
                    let entering = final_ch == 'h';
                    if entering != self.alt_screen {
                        self.flush_line(at, out, false);
                        out.push_str(if entering {
                            "----- 进入全屏程序，界面内容不记录 -----\n"
                        } else {
                            "----- 全屏程序已退出 -----\n"
                        });
                        self.alt_screen = entering;
                    }
                }
            }
            _ if self.alt_screen => {}
            'K' => {
                let len = self.cells.len();
                match param(0) {
                    0 => {
                        for i in self.col.min(len)..len {
                            self.cells[i] = Cell::Blank;
                        }
                    }
                    1 => {
                        if len > 0 {
                            for i in 0..=self.col.min(len - 1) {
                                self.cells[i] = Cell::Blank;
                            }
                        }
                    }
                    _ => self.cells.clear(),
                }
            }
            'J' => {
                self.flush_line(at, out, false);
                if param(0) != 1 {
                    self.cells.clear();
                    self.col = 0;
                }
            }
            'C' => self.col += count(),
            'D' => self.col = self.col.saturating_sub(count()),
            'G' | '`' => self.col = param(0).saturating_sub(1),
            // 跨行移动不做多行还原:先结束当前行(已知限制,原始模式兜底)
            'A' | 'B' | 'H' | 'f' | 'd' => self.flush_line(at, out, false),
            'P' => {
                let n = count();
                let end = (self.col + n).min(self.cells.len());
                if self.col < end {
                    self.cells.drain(self.col..end);
                }
            }
            '@' => {
                let n = count();
                let at_col = self.col.min(self.cells.len());
                for _ in 0..n {
                    self.cells.insert(at_col, Cell::Blank);
                }
            }
            'X' => {
                let n = count();
                let len = self.cells.len();
                for i in self.col.min(len)..(self.col + n).min(len) {
                    self.cells[i] = Cell::Blank;
                }
            }
            _ => {}
        }
    }
}

// ===== 写入线程 =====

enum LogFormatState {
    Text(TextFormatter),
    Raw,
}

struct Worker {
    writer: BufWriter<std::fs::File>,
    format: LogFormat,
    state: LogFormatState,
    /// 已写入文件的字节(含文件头/标记)
    written: u64,
    /// 队列积压字节数(与 LogEntry.queued 共享,处理完一条减一条)
    queued: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    has_content: Arc<AtomicBool>,
    error: LogError,
    on_error: Box<dyn Fn(String) + Send>,
}

impl Worker {
    fn process(&mut self, msg: LogMsg) {
        let len = msg.wire_len();
        match &msg {
            LogMsg::Header { name, userhost } => self.header(name, userhost),
            LogMsg::Preamble { lines } => self.preamble(lines),
            LogMsg::Data { at, text } => self.data(*at, text),
            LogMsg::Event { at, event } => self.event(*at, event),
        }
        self.queued.fetch_sub(len as u64, Ordering::Relaxed);
        self.note_dropped();
    }

    fn write_str(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if let Err(error) = self.writer.write_all(s.as_bytes()) {
            let message = format!("日志写入失败：{}", error);
            if fail_once(&self.error, message.clone()) {
                (self.on_error)(message);
            }
        } else {
            self.written += s.len() as u64;
        }
    }

    fn flush(&mut self) {
        if let Err(error) = self.writer.flush() {
            let message = format!("日志保存失败：{}", error);
            if fail_once(&self.error, message.clone()) {
                (self.on_error)(message);
            }
        }
    }

    fn header(&mut self, name: &str, userhost: &str) {
        let now = Local::now();
        let head = format!(
            "===== NebulaShell 会话日志 =====\n主机：{name}（{userhost}）\n开始：{stamp}（UTC{offset}）\n{format_line}\n================================\n",
            name = name,
            userhost = userhost,
            stamp = now.format("%Y-%m-%d %H:%M:%S"),
            offset = now.format("%:z"),
            format_line = match (self.format, self.timestamps_of()) {
                (LogFormat::Text, true) => "格式：纯文本；行首时间为该行结束的时间".to_string(),
                (LogFormat::Text, false) => "格式：纯文本（无时间戳）".to_string(),
                (LogFormat::Raw, _) => "格式：原始终端流；可用 cat / less -R 回放，不加时间戳".to_string(),
            },
        );
        self.write_str(&head);
        self.flush();
    }

    fn timestamps_of(&self) -> bool {
        match &self.state {
            LogFormatState::Text(f) => f.timestamps,
            LogFormatState::Raw => false,
        }
    }

    fn preamble(&mut self, lines: &[String]) {
        self.write_str(&format!(
            "----- 以下为开始记录前屏幕上已有的内容（共 {} 行）-----\n",
            lines.len()
        ));
        for line in lines {
            self.write_str(line);
            self.write_str("\n");
        }
        self.write_str("----- 以下为实时记录 -----\n");
        self.flush();
        self.has_content.store(true, Ordering::Relaxed);
    }

    fn data(&mut self, at: DateTime<Local>, text: &str) {
        match &mut self.state {
            LogFormatState::Text(formatter) => {
                let mut out = String::new();
                formatter.feed(at, text, &mut out);
                self.write_str(&out);
            }
            LogFormatState::Raw => self.write_str(text),
        }
        self.has_content.store(true, Ordering::Relaxed);
    }

    fn event(&mut self, at: DateTime<Local>, event: &LogEvent) {
        match (&mut self.state, event) {
            (LogFormatState::Text(formatter), LogEvent::Marker { text }) => {
                let mut out = String::new();
                // 残行(通常是提示符)以事件时刻收尾,再写标记
                formatter.flush_line(at, &mut out, false);
                self.write_str(&out);
                self.write_str(&format!("----- {} -----\n", text));
            }
            (LogFormatState::Text(formatter), LogEvent::Stopped { reason }) => {
                let mut out = String::new();
                formatter.flush_line(at, &mut out, false);
                self.write_str(&out);
                self.write_str(&format!(
                    "===== 记录结束 {}（{}）· {} =====\n",
                    at.format("%Y-%m-%d %H:%M:%S"),
                    reason,
                    human_size(self.written),
                ));
            }
            (LogFormatState::Raw, LogEvent::Marker { text }) => {
                self.write_str(&format!(
                    "\r\n----- {} {} -----\r\n",
                    at.format("%Y-%m-%d %H:%M:%S"),
                    text
                ));
            }
            (LogFormatState::Raw, LogEvent::Stopped { reason }) => {
                self.write_str(&format!(
                    "\r\n===== 记录结束 {}（{}）· {} =====\r\n",
                    at.format("%Y-%m-%d %H:%M:%S"),
                    reason,
                    human_size(self.written),
                ));
            }
        }
        self.flush();
    }

    /// 积压追上后补写丢弃标注(累计一次缺口总量)。
    fn note_dropped(&mut self) {
        let dropped = self.dropped.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            self.write_str(&format!(
                "----- 此处丢失约 {} 输出（磁盘写入跟不上）-----\n",
                human_size(dropped)
            ));
        }
    }
}

fn human_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{} B", bytes);
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut v = bytes as f64 / 1024.0;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{:.1} {}", v, units[i])
}

pub struct LogEntry {
    pub file: PathBuf,
    pub format: LogFormat,
    sender: Mutex<Option<mpsc::SyncSender<LogMsg>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    error: LogError,
    bytes: Arc<AtomicU64>,
    /// 见 mark_connected:初值 = 日志是否开在已连接的会话上
    ever_connected: AtomicBool,
    /// 连接即录:连接失败/取消时据此判断是否删除空文件
    has_content: Arc<AtomicBool>,
    queued: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    drop_notified: AtomicBool,
}

impl LogEntry {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        file: PathBuf,
        handle: std::fs::File,
        format: LogFormat,
        timestamps: bool,
        alt_screen: bool,
        connected_at_start: bool,
        on_error: impl Fn(String) + Send + 'static,
    ) -> Result<Arc<Self>, String> {
        let (sender, receiver) = mpsc::sync_channel::<LogMsg>(4096);
        let error = Arc::new(Mutex::new(None));
        let worker_error = error.clone();
        let queued = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let has_content = Arc::new(AtomicBool::new(false));
        let bytes = Arc::new(AtomicU64::new(0));
        let state = if format == LogFormat::Text {
            LogFormatState::Text(TextFormatter::new(timestamps, alt_screen))
        } else {
            LogFormatState::Raw
        };
        let mut worker = Worker {
            writer: BufWriter::new(handle),
            format,
            state,
            written: 0,
            queued: queued.clone(),
            dropped: dropped.clone(),
            has_content: has_content.clone(),
            error: worker_error,
            on_error: Box::new(on_error),
        };
        let handle = std::thread::Builder::new()
            .name("session-log".into())
            .spawn(move || {
                // 空闲即刷盘:recv 阻塞取一条,再把就绪的一并处理完,队列空了就 flush。
                // 注意不能"try_recv 探测空闲"——Ok 分支会把消息吞掉丢弃。
                while let Ok(msg) = receiver.recv() {
                    worker.process(msg);
                    while let Ok(next) = receiver.try_recv() {
                        worker.process(next);
                    }
                    worker.flush();
                }
                worker.flush();
            })
            .map_err(|error| format!("日志线程启动失败：{}", error))?;
        Ok(Arc::new(Self {
            file,
            format,
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(handle)),
            error,
            bytes,
            ever_connected: AtomicBool::new(connected_at_start),
            has_content,
            queued,
            dropped,
            drop_notified: AtomicBool::new(false),
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

    pub fn has_content(&self) -> bool {
        self.has_content.load(Ordering::Relaxed)
    }

    fn send(&self, msg: LogMsg) -> Result<(), RecordError> {
        let failed = self.error.lock().unwrap().is_some();
        if failed {
            self.sender.lock().unwrap().take();
            return Ok(());
        }
        let len = msg.wire_len();
        if self.queued.load(Ordering::Relaxed) + len as u64 > MAX_QUEUED_BYTES as u64 {
            return self.note_drop(len);
        }
        let mut guard = self.sender.lock().unwrap();
        let Some(sender) = guard.as_ref() else {
            return Ok(());
        };
        match sender.try_send(msg) {
            Ok(()) => {
                self.queued.fetch_add(len as u64, Ordering::Relaxed);
                Ok(())
            }
            Err(mpsc::TrySendError::Full(_)) => self.note_drop(len),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                // Closing the queue lets the worker drain accepted data and exit.
                guard.take();
                let message = "日志队列不可用，已停止记录".to_string();
                let first = fail_once(&self.error, message.clone());
                if first {
                    Err(RecordError::Fatal(message))
                } else {
                    Ok(())
                }
            }
        }
    }

    fn note_drop(&self, len: usize) -> Result<(), RecordError> {
        self.dropped.fetch_add(len as u64, Ordering::Relaxed);
        if !self.drop_notified.swap(true, Ordering::Relaxed) {
            Err(RecordError::Dropped)
        } else {
            Ok(())
        }
    }

    /// 一块终端输出(at = 数据泵接收时刻)。
    pub fn record(&self, at: DateTime<Local>, data: &str) -> Result<(), RecordError> {
        self.send(LogMsg::Data {
            at,
            text: data.to_string(),
        })?;
        self.bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
        Ok(())
    }

    /// 会话事件(已重新连接/连接已断开/已手动断开):独立标记行。
    pub fn event_marker(&self, text: &str) -> Result<(), RecordError> {
        self.send(LogMsg::Event {
            at: Local::now(),
            event: LogEvent::Marker {
                text: text.to_string(),
            },
        })?;
        self.bytes
            .fetch_add(text.len() as u64 + 40, Ordering::Relaxed);
        Ok(())
    }

    /// 文件头:必须是发往该日志的第一条消息(在插入会话表之前发送)。
    pub fn push_header(&self, name: &str, userhost: &str) {
        let _ = self.send(LogMsg::Header {
            name: name.to_string(),
            userhost: userhost.to_string(),
        });
    }

    /// 开始记录前屏幕上已有的内容。
    pub fn set_preamble(&self, lines: Vec<String>) {
        if lines.is_empty() {
            return;
        }
        let n: usize = lines.iter().map(|l| l.len() + 1).sum();
        let _ = self.send(LogMsg::Preamble { lines });
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }

    /// 停止:先写结束标记(注明原因),再关闭队列并等待写线程排空。
    pub fn stop(&self, reason: &str) -> Result<(), String> {
        let _ = self.send(LogMsg::Event {
            at: Local::now(),
            event: LogEvent::Stopped {
                reason: reason.to_string(),
            },
        });
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
    use chrono::TimeZone;

    fn at(secs: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 11, 14, 0, secs).unwrap()
    }

    /// 驱动格式化器:按 (秒, 文本) 依次喂入,返回产出的行。
    fn feed(chunks: &[(u32, &str)], timestamps: bool) -> String {
        let mut f = TextFormatter::new(timestamps, false);
        let mut out = String::new();
        for (t, text) in chunks {
            f.feed(at(*t), text, &mut out);
        }
        f.flush_line(at(59), &mut out, false);
        out
    }

    // ---- 核心:按行结束时刻打时间戳 ----

    #[test]
    fn timestamps_are_per_line_at_line_end() {
        let out = feed(&[(1, "ab"), (2, "c\r\nd"), (3, "e\r\n")], true);
        assert_eq!(out, "[14:00:02] abc\n[14:00:03] de\n");
    }

    #[test]
    fn per_char_echo_collapses_into_one_line() {
        // 手敲命令:服务器逐字回显,每个字符一块 —— 必须还是一行
        let owned: Vec<(u32, String)> = "ls -la\r\n"
            .chars()
            .enumerate()
            .map(|(i, c)| (i as u32, c.to_string()))
            .collect();
        let chunks: Vec<(u32, &str)> = owned.iter().map(|(t, s)| (*t, s.as_str())).collect();
        let out = feed(&chunks, true);
        assert_eq!(out.lines().count(), 1);
        assert!(out.ends_with("ls -la\n"));
    }

    #[test]
    fn blank_lines_have_no_timestamp() {
        let out = feed(&[(1, "a\r\n\r\nb\r\n")], true);
        assert_eq!(out, "[14:00:01] a\n\n[14:00:01] b\n");
    }

    // ---- 单行编辑还原 ----

    #[test]
    fn backspace_edit_yields_what_user_saw() {
        let out = feed(&[(1, "lss"), (2, "\x08 \x08"), (3, " -la\r\n")], true);
        assert_eq!(out, "[14:00:03] ls -la\n");
    }

    #[test]
    fn carriage_return_progress_bar_keeps_last_frame() {
        let out = feed(&[(1, "10%\r50%\r100%\r\n")], true);
        assert_eq!(out, "[14:00:01] 100%\n");
    }

    #[test]
    fn el_clears_to_end_of_line() {
        let out = feed(&[(1, "ls -la XX"), (2, "\x1b[2D\x1b[K\r\n")], true);
        assert_eq!(out, "[14:00:02] ls -la\n");
    }

    // ---- 装饰性序列丢弃 ----

    #[test]
    fn decorative_sequences_are_dropped() {
        let out = feed(&[(1, "\x1b[31mred\x1b[0m plain\r\n")], true);
        assert_eq!(out, "[14:00:01] red plain\n");
        let out = feed(&[(1, "\x1b]0;title\x07text\r\n")], true);
        assert_eq!(out, "[14:00:01] text\n");
        let out = feed(&[(1, "\x1b[?2004hprompt\r\n")], true);
        assert_eq!(out, "[14:00:01] prompt\n");
        let out = feed(&[(1, "a\x07b\r\n")], true);
        assert_eq!(out, "[14:00:01] ab\n");
    }

    #[test]
    fn escape_split_across_chunks_is_stitched() {
        let out = feed(&[(1, "\x1b[3"), (2, "1mRED\x1b[0m\r\n")], true);
        assert_eq!(out, "[14:00:02] RED\n");
    }

    #[test]
    fn alt_screen_is_folded_to_markers() {
        let mut f = TextFormatter::new(true, false);
        let mut out = String::new();
        f.feed(at(1), "prompt# \r\n", &mut out);
        f.feed(at(2), "\x1b[?1049h\x1b[2Jgarbage\x1b[1;1Hmore", &mut out);
        f.feed(at(3), "\x1b[?1049lback to shell\r\n", &mut out);
        assert_eq!(
            out,
            "[14:00:01] prompt#\n----- 进入全屏程序，界面内容不记录 -----\n----- 全屏程序已退出 -----\n[14:00:03] back to shell\n"
        );
    }

    #[test]
    fn starting_inside_alt_screen_ignores_until_exit() {
        let mut f = TextFormatter::new(true, true);
        let mut out = String::new();
        f.feed(at(1), "\x1b[?1049lrestored\r\n", &mut out);
        assert_eq!(out, "----- 全屏程序已退出 -----\n[14:00:01] restored\n");
    }

    #[test]
    fn cursor_up_ends_line_without_crash() {
        let out = feed(&[(1, "abc\x1b[Adef\r\n")], true);
        assert_eq!(out, "[14:00:01] abc\n[14:00:01] def\n");
    }

    #[test]
    fn wide_chars_backspace_and_el() {
        // 中文占 2 列:\b\b 退一个字,EL 清到行尾
        let out = feed(&[(1, "中文"), (2, "\x08\x08"), (3, "\x1b[K\r\n")], true);
        assert_eq!(out, "[14:00:03] 中\n");
    }

    #[test]
    fn oversized_line_is_split() {
        let long = "x".repeat(MAX_COLS + 10);
        let out = feed(&[(1, &long)], true);
        assert_eq!(out.lines().count(), 2);
    }

    #[test]
    fn day_rollover_writes_date_marker() {
        let mut f = TextFormatter::new(true, false);
        let mut out = String::new();
        f.feed(
            Local.with_ymd_and_hms(2026, 10, 11, 23, 59, 59).unwrap(),
            "night\r\n",
            &mut out,
        );
        f.feed(
            Local.with_ymd_and_hms(2026, 10, 12, 0, 0, 1).unwrap(),
            "morning\r\n",
            &mut out,
        );
        assert_eq!(
            out,
            "[23:59:59] night\n----- 2026-10-12 -----\n[00:00:01] morning\n"
        );
    }

    // ---- LogEntry:线程、顺序、标记、停止 ----

    fn temp_log_path() -> PathBuf {
        std::env::temp_dir().join(format!("nebula-log-{}.log", uuid::Uuid::new_v4()))
    }

    #[test]
    fn header_preamble_data_and_footer_land_in_order() {
        let path = temp_log_path();
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            LogFormat::Text,
            true,
            false,
            false,
            |_| {},
        )
        .unwrap();
        entry.push_header("web-01", "root@10.0.0.1:22");
        entry.set_preamble(vec!["old line".into()]);
        entry.record(at(5), "hello\r\n").unwrap();
        entry.stop("会话已关闭").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("===== NebulaShell 会话日志 ====="));
        assert!(content.contains("主机：web-01（root@10.0.0.1:22）"));
        assert!(content.contains("----- 以下为开始记录前屏幕上已有的内容（共 1 行）-----"));
        assert!(content.contains("old line\n"));
        assert!(content.contains("----- 以下为实时记录 -----\n"));
        assert!(content.contains("[14:00:05] hello"));
        assert!(content.contains("记录结束") && content.contains("（会话已关闭）"));
        assert!(!entry.active());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn raw_mode_keeps_bytes_and_marks_events() {
        let path = temp_log_path();
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            LogFormat::Raw,
            false,
            false,
            false,
            |_| {},
        )
        .unwrap();
        entry.push_header("web-01", "root@10.0.0.1:22");
        entry.record(at(5), "\x1b[31mraw\x1b[0m\r\n").unwrap();
        entry.event_marker("连接已断开：网络中断").unwrap();
        entry.stop("手动停止").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("\x1b[31mraw\x1b[0m\r\n"), "原始字节不变");
        assert!(!content.contains("[14:00:05]"), "raw 模式没有时间戳");
        assert!(content.contains("连接已断开：网络中断"));
        assert!(content.contains("记录结束"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn no_timestamps_mode_stamps_nothing() {
        let path = temp_log_path();
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            LogFormat::Text,
            false,
            false,
            false,
            |_| {},
        )
        .unwrap();
        entry.record(at(5), "hello\r\n").unwrap();
        entry.stop("手动停止").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("hello\n"), "{}", content);
        assert!(!content.contains("[14:00:05]"));
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

    fn failing_entry(fail_flush: bool, reported: Arc<Mutex<Vec<String>>>) -> Arc<LogEntry> {
        // 绕过 File 类型手动搭一条最小管道,复刻 Worker 的失败上报语义
        let (sender, receiver) = mpsc::sync_channel::<LogMsg>(16);
        let error = Arc::new(Mutex::new(None));
        let worker_error = error.clone();
        let handle = std::thread::spawn(move || {
            let mut w = FailingWriter { fail_flush };
            for msg in receiver {
                if let LogMsg::Data { text, .. } = msg {
                    if let Err(e) = w.write_all(text.as_bytes()) {
                        let m = format!("日志写入失败：{}", e);
                        if fail_once(&worker_error, m.clone()) {
                            reported.lock().unwrap().push(m);
                        }
                    }
                }
            }
            if let Err(e) = w.flush() {
                let m = format!("日志保存失败：{}", e);
                if fail_once(&worker_error, m.clone()) {
                    reported.lock().unwrap().push(m);
                }
            }
        });
        Arc::new(LogEntry {
            file: PathBuf::new(),
            format: LogFormat::Text,
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(handle)),
            error,
            bytes: Arc::new(AtomicU64::new(0)),
            ever_connected: AtomicBool::new(false),
            has_content: Arc::new(AtomicBool::new(false)),
            queued: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            drop_notified: AtomicBool::new(false),
        })
    }

    #[test]
    fn write_and_flush_failures_are_reported_once_and_returned_by_stop() {
        for fail_flush in [false, true] {
            let errors = Arc::new(Mutex::new(Vec::new()));
            let entry = failing_entry(fail_flush, errors.clone());
            entry.record(at(1), "output").unwrap();
            let error = entry.stop("手动停止").unwrap_err();
            assert!(error.contains(if fail_flush {
                "flush failed"
            } else {
                "write failed"
            }));
            assert!(!entry.active());
            entry.record(at(2), "later output").unwrap();
            for _ in 0..100 {
                if errors.lock().unwrap().len() == 1 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert_eq!(errors.lock().unwrap().len(), 1);
            assert_eq!(entry.stop("手动停止").unwrap_err(), error);
        }
    }

    #[test]
    fn mark_connected_reports_reconnection() {
        let path = temp_log_path();
        let entry = LogEntry::new(
            path.clone(),
            std::fs::File::create(&path).unwrap(),
            LogFormat::Text,
            false,
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
