// 传输任务:跨主机复制(本机有界缓冲流式中继)、递归目录、冲突决策、
// 取消、.part 临时文件与安全发布、断连中断、遗留临时文件清理台账。
//
// 设计要点(见 multi-host-file-management-design.md):
// - 编排全在 Rust,文件字节不进 JS/IPC;源/目标各是一条 SFTP 通道。
// - 默认不覆盖:发布用 rename,目标已存在时回到冲突决策;覆盖也走
//   rename(OpenSSH 的 SSH_FXP_RENAME 是 POSIX 原子替换),服务端拒绝时
//   如实报错,绝不"先删旧文件再改名"。
// - 中间态写入目标目录下任务私有的 .nbpart-* 临时文件,失败/取消即清理;
//   清理不了的记入台账,下次连接同主机时再试(只删台账登记且仍匹配
//   .nbpart 命名的路径,绝不按后缀盲扫)。
// - 会话代次(epoch)校验:重连后旧任务不得悄悄挪到新连接上继续跑。
// - 并发:全局 2 个传输任务、每条连接同时只参与 1 个数据传输;锁按
//   sessionId 排序获取,防 A→B 与 B→A 死锁。

use crate::ai::emit_evt;
use crate::ssh::SshService;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

const CHUNK: usize = 64 * 1024;
const MAX_DEPTH: usize = 128;
const MAX_ENTRIES: usize = 100_000;
const GLOBAL_CONCURRENCY: usize = 2;
const RENAME_ATTEMPTS: usize = 1000;
/// 注册表里的终态任务上限:超出后先淘汰最早的终态任务(UI 自己留快照)
const MAX_RETAINED: usize = 100;

/// 传输端点:会话 + 连接代次。epoch 不匹配 = 连接已重连/更换,任务失效。
#[derive(Clone)]
pub struct Endpoint {
    pub session_id: String,
    pub epoch: u64,
    pub label: String,
    pub summary: String,
}

pub fn host_summary_of(host: &Value) -> String {
    format!(
        "{}@{}:{}",
        host["username"].as_str().unwrap_or(""),
        host["host"].as_str().unwrap_or(""),
        host["port"].as_u64().unwrap_or(22)
    )
}

pub fn label_of(host: &Value) -> String {
    let name = host["name"].as_str().unwrap_or("");
    let summary = host_summary_of(host);
    if name.is_empty() {
        summary
    } else {
        format!("{name}({summary})")
    }
}

#[derive(Default)]
struct Counts {
    done: u64,
    skipped: u64,
    failed: u64,
    cancelled: u64,
}

impl Counts {
    fn to_json(&self) -> Value {
        json!({ "done": self.done, "skipped": self.skipped, "failed": self.failed, "cancelled": self.cancelled })
    }
}

struct TaskState {
    stage: &'static str,
    bytes: u64,
    total: u64,
    files: Counts,
    dirs: Counts,
    current: String,
    error: Option<String>,
    /// 触碰深度/条目数上限:未执行范围必须可见,不能悄悄成功
    truncated: bool,
}

pub struct Task {
    id: String,
    batch_id: String,
    src: Endpoint,
    dst: Endpoint,
    src_dir: String,
    dst_dir: String,
    items: Vec<String>,
    /// "应用到同类冲突"记忆:files→skip/overwrite/rename;dirs→merge/skip/rename
    rest_files: Mutex<Option<String>>,
    rest_dirs: Mutex<Option<String>>,
    /// 一次只挂起一个冲突;决策经 oneshot 送达执行循环
    conflict_slot: tokio::sync::Mutex<Option<(String, tokio::sync::oneshot::Sender<Value>)>>,
    conflict_seq: AtomicU64,
    state: Mutex<TaskState>,
    cancel: AtomicBool,
    /// 目标端本任务拥有的远端临时文件;发布/清理成功即移出
    temps: Mutex<Vec<String>>,
    app: tauri::AppHandle,
}

impl Task {
    fn snapshot(&self) -> Value {
        let st = self.state.lock().unwrap();
        json!({
            "taskId": self.id,
            "batchId": self.batch_id,
            "src": { "sessionId": self.src.session_id, "label": self.src.label, "summary": self.src.summary },
            "dst": { "sessionId": self.dst.session_id, "label": self.dst.label, "summary": self.dst.summary },
            "srcDir": self.src_dir,
            "dstDir": self.dst_dir,
            "items": self.items,
            "stage": st.stage,
            "bytes": st.bytes,
            "total": st.total,
            "files": st.files.to_json(),
            "dirs": st.dirs.to_json(),
            "current": st.current,
            "error": st.error,
            "truncated": st.truncated,
        })
    }

    fn stage(&self) -> String {
        self.state.lock().unwrap().stage.to_string()
    }

    fn emit_task(&self) {
        emit_evt(
            &self.app,
            "transfer:event",
            json!({ "kind": "task", "task": self.snapshot() }),
        );
    }

    fn set_stage(&self, stage: &'static str) {
        self.state.lock().unwrap().stage = stage;
        self.emit_task();
    }

    fn is_terminal(&self) -> bool {
        is_terminal_stage(self.stage().as_str())
    }
}

fn is_terminal_stage(stage: &str) -> bool {
    matches!(
        stage,
        "done" | "done-partial" | "partial" | "failed" | "cancelled" | "interrupted"
    )
}

pub struct TransferManager {
    ssh: Arc<SshService>,
    tasks: Mutex<Vec<Arc<Task>>>,
    schedule: Arc<Semaphore>,
    endpoint_sems: Mutex<HashMap<String, Arc<Semaphore>>>,
    ledger_path: PathBuf,
    /// 主机摘要 → 待清理的远端临时文件路径(跨重启持久化)
    ledger: Mutex<HashMap<String, Vec<String>>>,
}

enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

/// 用 lstat 的权限位精确区分 REG/DIR/LNK/FIFO/CHR/BLK/SOCK。
/// 部分服务器不回传完整 st_mode(高 4 位为 0):此时退回 is_dir/is_symlink,
/// 其余按普通文件处理(与列目录口径一致,不能把可复制的文件误判成特殊文件)。
fn classify(meta: &russh_sftp::protocol::FileAttributes) -> Kind {
    if meta.is_symlink() {
        return Kind::Symlink;
    }
    if meta.is_dir() {
        return Kind::Dir;
    }
    match meta.permissions.map(|p| (p >> 12) & 0xf) {
        Some(0x8) => Kind::File,
        Some(0x4) => Kind::Dir,
        Some(0xa) => Kind::Symlink,
        Some(0x1) | Some(0x2) | Some(0x5) | Some(0x6) | Some(0xc) => Kind::Other,
        _ => Kind::File,
    }
}

fn join_remote(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

fn parent_of(path: &str) -> String {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].to_string(),
    }
}

/// 在 parent 下为 base 找一个不存在的名字:base → "base (1)" → "base (2)"…
/// 与上传自动重命名同规则(扩展名保留、点文件整体加后缀)。
async fn free_name(
    sftp: &Arc<russh_sftp::client::SftpSession>,
    parent: &str,
    base: &str,
) -> Option<String> {
    for i in 0..RENAME_ATTEMPTS {
        let candidate = if i == 0 {
            base.to_string()
        } else {
            match base.rfind('.').filter(|i| *i > 0) {
                Some(dot) => format!("{} ({}){}", &base[..dot], i, &base[dot..]),
                None => format!("{} ({})", base, i),
            }
        };
        let full = format!("{parent}/{candidate}");
        if sftp.symlink_metadata(&full).await.is_err() {
            return Some(candidate);
        }
    }
    None
}

/// 在目标目录下以独占创建分配任务私有的 .part 临时文件
async fn alloc_part(
    sftp: &Arc<russh_sftp::client::SftpSession>,
    dir: &str,
    name: &str,
    task_id: &str,
) -> Option<String> {
    use russh_sftp::protocol::OpenFlags;
    let tag = &task_id[..8.min(task_id.len())];
    for i in 0..8 {
        let candidate = format!("{dir}/.{name}.nbpart-{tag}-{i}");
        let flags = OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE;
        if let Ok(f) = sftp.open_with_flags(&candidate, flags).await {
            let _ = f.close().await;
            return Some(candidate);
        }
    }
    None
}

enum FileDecision {
    Skip,
    Overwrite,
    Rename,
    Cancel,
}

enum DirDecision {
    Merge,
    Skip,
    Rename,
    Cancelled,
}

impl TransferManager {
    pub fn new(ssh: Arc<SshService>, ledger_dir: PathBuf) -> Self {
        let ledger_path = ledger_dir.join("transfer-cleanup.json");
        let ledger = std::fs::read_to_string(&ledger_path)
            .ok()
            .and_then(|t| serde_json::from_str::<HashMap<String, Vec<String>>>(&t).ok())
            .unwrap_or_default();
        TransferManager {
            ssh,
            tasks: Mutex::new(Vec::new()),
            schedule: Arc::new(Semaphore::new(GLOBAL_CONCURRENCY)),
            endpoint_sems: Mutex::new(HashMap::new()),
            ledger_path,
            ledger: Mutex::new(ledger),
        }
    }

    fn endpoint_sem(&self, session_id: &str) -> Arc<Semaphore> {
        let mut map = self.endpoint_sems.lock().unwrap();
        map.entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }

    /// 提交跨主机复制任务。expected_src_epoch/expected_dst_epoch 由前端在
    /// 拖放/菜单点击时捕获:提交时连接已重连或换绑(代次变化)则拒绝,
    /// 防止"看着 A 拖的、落到重连后的 A′"。
    pub async fn submit_copy(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        src_session: &str,
        src_dir: &str,
        expected_src_epoch: Option<u64>,
        dst_session: &str,
        dst_dir: &str,
        expected_dst_epoch: Option<u64>,
        items: Vec<String>,
        batch_id: &str,
        auto_rename: bool,
    ) -> Result<Value, String> {
        if items.is_empty() {
            return Err("没有可复制的条目".into());
        }
        if !src_dir.starts_with('/') || !dst_dir.starts_with('/') || dst_dir.contains('\0') {
            return Err("复制源与目标必须是绝对目录".into());
        }
        for name in &items {
            if name.is_empty()
                || name == "."
                || name == ".."
                || name.contains('/')
                || name.contains('\\')
                || name.contains('\0')
            {
                return Err(format!("无效的条目名称: {name:?}"));
            }
        }
        let (src, dst) = tokio::join!(
            self.ssh.session_endpoint(src_session),
            self.ssh.session_endpoint(dst_session)
        );
        let src = src.ok_or("源会话不存在或已断开")?;
        let dst = dst.ok_or("目标会话不存在或已断开")?;
        if let Some(want) = expected_src_epoch {
            if want != src.epoch {
                return Err("源连接已变化,请重新操作".into());
            }
        }
        if let Some(want) = expected_dst_epoch {
            if want != dst.epoch {
                return Err("目标连接已变化,请重新操作".into());
            }
        }
        // 同连接自复制防护:同目录拒绝(「创建副本」场景除外,其冲突走
        // 自动重命名);目录复制进自身子树一律拒绝。
        // 规范化路径后按 '/' 边界比较,不用字符串前缀。
        if src.session_id == dst.session_id {
            let sftp = self.ssh.open_sftp(&src.session_id).await?;
            let cwd = sftp
                .canonicalize(src_dir)
                .await
                .map_err(|e| e.to_string())?;
            let target = sftp
                .canonicalize(dst_dir)
                .await
                .map_err(|e| e.to_string())?;
            let target = target.trim_end_matches('/');
            if !auto_rename && target == cwd.trim_end_matches('/') {
                return Err("源与目标目录相同;需要副本请用「创建副本」".into());
            }
            for name in &items {
                let src_root = format!("{}/{}", cwd.trim_end_matches('/'), name);
                if target == src_root || target.starts_with(&format!("{src_root}/")) {
                    return Err(format!("不能把 {name} 复制进它自己的子目录"));
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let task = Arc::new(Task {
            id: id.clone(),
            batch_id: batch_id.to_string(),
            src,
            dst,
            src_dir: src_dir.to_string(),
            dst_dir: dst_dir.to_string(),
            items,
            conflict_slot: tokio::sync::Mutex::new(None),
            conflict_seq: AtomicU64::new(0),
            rest_files: Mutex::new(if auto_rename {
                Some("rename".into())
            } else {
                None
            }),
            rest_dirs: Mutex::new(if auto_rename {
                Some("rename".into())
            } else {
                None
            }),
            state: Mutex::new(TaskState {
                stage: "queued",
                bytes: 0,
                total: 0,
                files: Counts::default(),
                dirs: Counts::default(),
                current: String::new(),
                error: None,
                truncated: false,
            }),
            cancel: AtomicBool::new(false),
            temps: Mutex::new(Vec::new()),
            app,
        });
        {
            let mut tasks = self.tasks.lock().unwrap();
            tasks.push(task.clone());
            while tasks.len() > MAX_RETAINED {
                // 先淘汰最早的终态任务;全是活跃任务时按 FIFO 兜底
                if let Some(idx) = tasks.iter().position(|t| t.is_terminal()) {
                    tasks.remove(idx);
                } else {
                    tasks.remove(0);
                }
            }
        }
        task.emit_task();
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.run(task).await;
        });
        Ok(json!({ "taskId": id, "batchId": batch_id }))
    }

    pub fn cancel(&self, task_id: &str) -> Result<Value, String> {
        let task = self.find(task_id).ok_or("任务不存在")?;
        task.cancel.store(true, Ordering::SeqCst);
        // 冲突等待中以"取消剩余"结算,执行循环尽快退出
        if let Ok(mut slot) = task.conflict_slot.try_lock() {
            if let Some((_, sender)) = slot.take() {
                let _ = sender.send(json!({ "policy": "cancelRest" }));
            }
        }
        if !task.is_terminal() {
            task.set_stage("cancelling");
        }
        Ok(json!({ "ok": true }))
    }

    pub async fn resolve_conflict(
        &self,
        task_id: &str,
        conflict_id: &str,
        decision: Value,
    ) -> Result<Value, String> {
        let task = self.find(task_id).ok_or("任务不存在")?;
        let mut slot = task.conflict_slot.lock().await;
        match slot.take() {
            Some((pending_id, sender)) if pending_id == conflict_id => {
                let _ = sender.send(decision);
                Ok(json!({ "ok": true }))
            }
            other => {
                if other.is_some() {
                    *slot = other;
                }
                Err("冲突已失效或已被处理".into())
            }
        }
    }

    pub fn list(&self) -> Vec<Value> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .map(|t| t.snapshot())
            .collect()
    }

    /// 未终态任务中涉及这些会话的任务列表 —— 关闭连接前的确认提示
    pub fn active_for_sessions(&self, session_ids: &[String]) -> Vec<Value> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .filter(|t| {
                !t.is_terminal()
                    && (session_ids.contains(&t.src.session_id)
                        || session_ids.contains(&t.dst.session_id))
            })
            .map(|t| t.snapshot())
            .collect()
    }

    fn find(&self, task_id: &str) -> Option<Arc<Task>> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == task_id)
            .cloned()
    }

    async fn run(self: Arc<Self>, task: Arc<Task>) {
        let _global = self
            .schedule
            .clone()
            .acquire_owned()
            .await
            .expect("semaphore closed");
        // 每连接同时只跑 1 个数据传输;按 sessionId 排序获取防死锁。
        // 同端点复制(src/dst 同 sessionId)时,两个"端点信号量"是同一个
        // 容量 1 的许可 —— join! 里双 acquire,第一个 future 把唯一许可握在
        // 自己的输出里,第二个永远 Pending,任务会永久卡在排队中。
        // 同端点只 acquire 一次:本来只占这一条连接,一个许可同时覆盖两端。
        let same_endpoint = task.src.session_id == task.dst.session_id;
        let sems = [
            self.endpoint_sem(&task.src.session_id),
            self.endpoint_sem(&task.dst.session_id),
        ];
        let (first, second) = if task.src.session_id <= task.dst.session_id {
            (sems[0].clone(), sems[1].clone())
        } else {
            (sems[1].clone(), sems[0].clone())
        };
        let (permits, sf, df) = if same_endpoint {
            let (p, sf, df) = tokio::join!(
                first.acquire_owned(),
                self.ssh.open_sftp(&task.src.session_id),
                self.ssh.open_sftp(&task.dst.session_id)
            );
            (vec![p], sf, df)
        } else {
            let (a, b, sf, df) = tokio::join!(
                first.acquire_owned(),
                second.acquire_owned(),
                self.ssh.open_sftp(&task.src.session_id),
                self.ssh.open_sftp(&task.dst.session_id)
            );
            (vec![a, b], sf, df)
        };
        let _endpoint_permits = match permits.into_iter().collect::<Result<Vec<_>, _>>() {
            Ok(p) => p,
            Err(_) => return self.fail(&task, "传输调度失败".into()).await,
        };
        let (sf, df) = match (sf, df) {
            (Ok(s), Ok(d)) => (s, d),
            (Err(e), _) => return self.fail(&task, format!("源连接不可用: {e}")).await,
            (_, Err(e)) => return self.fail(&task, format!("目标连接不可用: {e}")).await,
        };
        if !self.endpoints_valid(&task).await {
            return self
                .interrupt(&task, "连接已断开或已重连,任务中断".into())
                .await;
        }
        task.set_stage("transferring");
        for name in task.items.clone() {
            if task.cancel.load(Ordering::SeqCst) {
                break;
            }
            let r = self
                .copy_top(
                    &task,
                    &sf,
                    &df,
                    &task.src_dir.clone(),
                    &task.dst_dir.clone(),
                    &name,
                    0,
                )
                .await;
            if let Err(e) = r {
                if e == "__cancelled__" {
                    break;
                }
                if e == "__interrupted__" {
                    return self
                        .interrupt(&task, "连接已断开或已重连,任务中断".into())
                        .await;
                }
                if e == "__truncated__" {
                    break;
                }
            }
        }
        self.finish(&task).await;
    }

    async fn endpoints_valid(&self, task: &Arc<Task>) -> bool {
        let (a, b) = tokio::join!(
            self.ssh.session_epoch(&task.src.session_id),
            self.ssh.session_epoch(&task.dst.session_id)
        );
        a == Some(task.src.epoch) && b == Some(task.dst.epoch)
    }

    async fn fail(&self, task: &Arc<Task>, error: String) {
        self.cleanup_temps(task).await;
        {
            let mut st = task.state.lock().unwrap();
            st.stage = "failed";
            st.error = Some(error);
        }
        task.emit_task();
    }

    async fn interrupt(&self, task: &Arc<Task>, msg: String) {
        self.cleanup_temps(task).await;
        {
            let mut st = task.state.lock().unwrap();
            st.stage = "interrupted";
            st.error = Some(msg);
        }
        task.emit_task();
    }

    async fn finish(&self, task: &Arc<Task>) {
        self.cleanup_temps(task).await;
        let cancelled = task.cancel.load(Ordering::SeqCst);
        {
            let mut st = task.state.lock().unwrap();
            if cancelled {
                st.stage = "cancelled";
            } else if st.files.failed + st.dirs.failed > 0 {
                st.stage = "partial";
            } else if st.files.skipped + st.dirs.skipped > 0 {
                st.stage = "done-partial";
            } else {
                st.stage = "done";
            }
        }
        task.emit_task();
    }

    #[allow(clippy::too_many_arguments)]
    async fn copy_top(
        self: &Arc<Self>,
        task: &Arc<Task>,
        sf: &Arc<russh_sftp::client::SftpSession>,
        df: &Arc<russh_sftp::client::SftpSession>,
        src_dir: &str,
        dst_dir: &str,
        name: &str,
        depth: usize,
    ) -> Result<(), String> {
        let src_path = join_remote(src_dir, name);
        let meta = match sf.symlink_metadata(&src_path).await {
            Ok(m) => m,
            Err(e) => {
                self.count_fail(task, true, &format!("读取源 {name} 失败: {e}"));
                return Ok(());
            }
        };
        match classify(&meta) {
            Kind::Symlink | Kind::Other => {
                self.count_skip(task, true, "符号链接/特殊文件按策略跳过");
                Ok(())
            }
            Kind::Dir => {
                self.copy_dir(
                    task,
                    sf,
                    df,
                    &src_path,
                    &join_remote(dst_dir, name),
                    name,
                    depth,
                )
                .await
            }
            Kind::File => {
                self.copy_file(task, sf, df, &src_path, &join_remote(dst_dir, name), name)
                    .await;
                Ok(())
            }
        }
    }

    async fn copy_dir(
        self: &Arc<Self>,
        task: &Arc<Task>,
        sf: &Arc<russh_sftp::client::SftpSession>,
        df: &Arc<russh_sftp::client::SftpSession>,
        src_dir: &str,
        dst_dir: &str,
        display: &str,
        depth: usize,
    ) -> Result<(), String> {
        if task.cancel.load(Ordering::SeqCst) {
            return Err("__cancelled__".into());
        }
        {
            let st = task.state.lock().unwrap();
            if st.truncated {
                return Err("__truncated__".into());
            }
        }
        if !self.endpoints_valid(task).await {
            return Err("__interrupted__".into());
        }
        if depth >= MAX_DEPTH {
            task.state.lock().unwrap().truncated = true;
            self.count_skip(
                task,
                false,
                &format!("{display} 超过最大递归深度 {MAX_DEPTH}"),
            );
            return Ok(());
        }
        // 目标目录:不存在直接建;存在(或位置被非目录占用)走目录冲突决策
        let dst_dir = match df.symlink_metadata(dst_dir).await {
            Ok(m) => {
                let is_dir = m.is_dir();
                match self.dir_conflict(task, display, is_dir).await {
                    DirDecision::Merge if is_dir => dst_dir.to_string(),
                    DirDecision::Skip => {
                        self.count_skip(task, false, &format!("目录 {display} 已存在,已跳过"));
                        return Ok(());
                    }
                    DirDecision::Rename => {
                        let parent = parent_of(dst_dir);
                        match free_name(df, &parent, &join_base(display)).await {
                            Some(n) => format!("{parent}/{n}"),
                            None => {
                                self.count_fail(
                                    task,
                                    false,
                                    &format!("目录 {display} 重命名失败:无可名"),
                                );
                                return Ok(());
                            }
                        }
                    }
                    DirDecision::Merge | DirDecision::Cancelled => {
                        return Err("__cancelled__".into())
                    }
                }
            }
            Err(_) => {
                if let Err(e) = df.create_dir(dst_dir).await {
                    self.count_fail(task, false, &format!("创建目录 {display} 失败: {e}"));
                    return Ok(());
                }
                dst_dir.to_string()
            }
        };
        task.state.lock().unwrap().dirs.done += 1;
        task.emit_task();
        let entries = match sf.read_dir(src_dir).await {
            Ok(e) => e,
            Err(e) => {
                self.count_fail(task, false, &format!("读取目录 {display} 失败: {e}"));
                return Ok(());
            }
        };
        for entry in entries {
            if task.cancel.load(Ordering::SeqCst) {
                return Err("__cancelled__".into());
            }
            {
                let mut st = task.state.lock().unwrap();
                if st.files.done
                    + st.files.failed
                    + st.files.skipped
                    + st.files.cancelled
                    + st.dirs.done
                    + st.dirs.skipped
                    + st.dirs.failed
                    >= MAX_ENTRIES as u64
                {
                    st.truncated = true;
                }
                if st.truncated {
                    break;
                }
            }
            let child = entry.file_name();
            if child == "." || child == ".." {
                continue;
            }
            let meta = entry.metadata();
            let child_display = format!("{display}/{child}");
            match classify(&meta) {
                Kind::Symlink | Kind::Other => {
                    self.count_skip(task, true, "符号链接/特殊文件按策略跳过");
                }
                Kind::Dir => {
                    // 递归目录:async fn 递归需要 Box::pin
                    Box::pin(self.copy_dir(
                        task,
                        sf,
                        df,
                        &format!("{src_dir}/{child}"),
                        &format!("{dst_dir}/{child}"),
                        &child_display,
                        depth + 1,
                    ))
                    .await?;
                }
                Kind::File => {
                    self.copy_file(
                        task,
                        sf,
                        df,
                        &format!("{src_dir}/{child}"),
                        &format!("{dst_dir}/{child}"),
                        &child,
                    )
                    .await;
                }
            }
        }
        Ok(())
    }

    async fn copy_file(
        self: &Arc<Self>,
        task: &Arc<Task>,
        sf: &Arc<russh_sftp::client::SftpSession>,
        df: &Arc<russh_sftp::client::SftpSession>,
        src_path: &str,
        dst_path: &str,
        name: &str,
    ) {
        let dir = parent_of(dst_path);
        let src_meta = match sf.symlink_metadata(src_path).await {
            Ok(m) => m,
            Err(e) => return self.count_fail(task, true, &format!("读取源 {name} 失败: {e}")),
        };
        let total = src_meta.size.unwrap_or(0);
        {
            let mut st = task.state.lock().unwrap();
            st.total += total;
            st.current = name.to_string();
        }
        task.emit_task();
        let mut final_dst = dst_path.to_string();
        let mut overwrite = false;
        if let Ok(existing) = df.symlink_metadata(&final_dst).await {
            match self.file_conflict(task, name, existing.is_dir()).await {
                FileDecision::Skip => return self.count_skip(task, true, "同名文件已跳过"),
                FileDecision::Cancel => {
                    task.cancel.store(true, Ordering::SeqCst);
                    return;
                }
                FileDecision::Rename => match free_name(df, &dir, name).await {
                    Some(n) => final_dst = format!("{dir}/{n}"),
                    None => return self.count_fail(task, true, "自动重命名失败:无可名"),
                },
                FileDecision::Overwrite => overwrite = true,
            }
        }
        if task.cancel.load(Ordering::SeqCst) {
            self.count_cancel(task, true);
            return;
        }
        let Some(part) = alloc_part(df, &dir, name, &task.id).await else {
            return self.count_fail(task, true, "无法创建临时文件");
        };
        self.ledger_add(&task.dst.summary, &part);
        task.temps.lock().unwrap().push(part.clone());
        let mut written = 0u64;
        let mut last_pct = -1i64;
        match stream_copy(
            sf,
            src_path,
            df,
            &part,
            total,
            &mut written,
            &mut last_pct,
            task,
        )
        .await
        {
            Err(e) if e == "__cancelled__" => {
                let _ = df.remove_file(&part).await;
                task.temps.lock().unwrap().retain(|p| *p != part);
                self.ledger_remove(&task.dst.summary, &part);
                self.count_cancel(task, true);
            }
            Err(e) => {
                let _ = df.remove_file(&part).await;
                task.temps.lock().unwrap().retain(|p| *p != part);
                self.ledger_remove(&task.dst.summary, &part);
                self.count_fail(task, true, &format!("传输 {name} 失败: {e}"));
            }
            Ok(()) => {
                // 发布:独占 rename(OpenSSH = 原子替换)。发布前目标又出现
                // 同名 → 回到冲突决策;覆盖前确认目标不是目录/符号链接。
                loop {
                    let existing = df.symlink_metadata(&final_dst).await.ok();
                    if existing.is_some() && !overwrite {
                        let dst_is_dir = existing.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                        match self.file_conflict(task, name, dst_is_dir).await {
                            FileDecision::Skip => break,
                            FileDecision::Cancel => {
                                task.cancel.store(true, Ordering::SeqCst);
                                break;
                            }
                            FileDecision::Rename => {
                                if let Some(n) = free_name(df, &dir, name).await {
                                    final_dst = format!("{dir}/{n}");
                                    continue;
                                }
                                self.count_fail(task, true, "自动重命名失败:无可名");
                                break;
                            }
                            FileDecision::Overwrite => {
                                overwrite = true;
                                continue;
                            }
                        }
                    }
                    if let Some(m) = &existing {
                        if m.is_dir() || m.is_symlink() {
                            self.count_fail(task, true, "不能覆盖目录或符号链接");
                            break;
                        }
                    }
                    match df.posix_rename(&part, &final_dst).await {
                        Ok(()) => {
                            task.temps.lock().unwrap().retain(|p| *p != part);
                            self.ledger_remove(&task.dst.summary, &part);
                            task.state.lock().unwrap().files.done += 1;
                            task.emit_task();
                        }
                        Err(e) => {
                            // rename 失败:目标原文件仍在;临时文件留给清理
                            self.count_fail(task, true, &format!("发布 {name} 失败: {e}"));
                        }
                    }
                    break;
                }
            }
        }
    }

    async fn file_conflict(&self, task: &Arc<Task>, name: &str, dst_is_dir: bool) -> FileDecision {
        if let Some(p) = task.rest_files.lock().unwrap().clone() {
            return match p.as_str() {
                "overwrite" => FileDecision::Overwrite,
                "rename" => FileDecision::Rename,
                _ => FileDecision::Skip,
            };
        }
        if task.cancel.load(Ordering::SeqCst) {
            return FileDecision::Cancel;
        }
        let decision = self
            .ask_conflict(task, "file", name, dst_is_dir)
            .await
            .unwrap_or(json!({ "policy": "cancelRest" }));
        if task.cancel.load(Ordering::SeqCst) {
            return FileDecision::Cancel;
        }
        let policy = decision["policy"].as_str().unwrap_or("skip").to_string();
        if decision["applyToAll"] == json!(true) && policy != "cancelRest" {
            *task.rest_files.lock().unwrap() = Some(policy.clone());
        }
        match policy.as_str() {
            "overwrite" => FileDecision::Overwrite,
            "rename" => FileDecision::Rename,
            "cancelRest" => FileDecision::Cancel,
            _ => FileDecision::Skip,
        }
    }

    async fn dir_conflict(&self, task: &Arc<Task>, name: &str, dst_is_dir: bool) -> DirDecision {
        if let Some(p) = task.rest_dirs.lock().unwrap().clone() {
            return match p.as_str() {
                "rename" => DirDecision::Rename,
                "merge" if dst_is_dir => DirDecision::Merge,
                _ => DirDecision::Skip,
            };
        }
        if task.cancel.load(Ordering::SeqCst) {
            return DirDecision::Cancelled;
        }
        let decision = self
            .ask_conflict(task, "dir", name, dst_is_dir)
            .await
            .unwrap_or(json!({ "policy": "cancelRest" }));
        if task.cancel.load(Ordering::SeqCst) {
            return DirDecision::Cancelled;
        }
        let policy = decision["policy"].as_str().unwrap_or("skip").to_string();
        if decision["applyToAll"] == json!(true) && policy != "cancelRest" {
            *task.rest_dirs.lock().unwrap() = Some(policy.clone());
        }
        match policy.as_str() {
            "merge" if dst_is_dir => DirDecision::Merge,
            "rename" => DirDecision::Rename,
            "cancelRest" => DirDecision::Cancelled,
            // 目标位置被非目录占用时"合并"退化为跳过:不能删目标、不能散落内容
            _ => DirDecision::Skip,
        }
    }

    /// 挂起任务等用户决策;事件带任务与目标身份,前端据此弹共用冲突框
    async fn ask_conflict(
        &self,
        task: &Arc<Task>,
        src_kind: &str,
        name: &str,
        dst_is_dir: bool,
    ) -> Option<Value> {
        task.set_stage("waiting");
        let conflict_id = format!("c-{}", task.conflict_seq.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
        {
            let mut slot = task.conflict_slot.lock().await;
            *slot = Some((conflict_id.clone(), tx));
        }
        emit_evt(
            &task.app,
            "transfer:event",
            json!({
                "kind": "conflict",
                "taskId": task.id,
                "conflictId": conflict_id,
                "name": name,
                "srcPath": join_remote(&task.src_dir, name),
                "dstPath": join_remote(&task.dst_dir, name),
                "srcKind": src_kind,
                "dstKind": if dst_is_dir { "dir" } else { "file" },
                "taskLabel": format!("{} → {}", task.src.label, task.dst.label),
                "dstLabel": task.dst.label,
            }),
        );
        let decision = rx.await;
        task.set_stage("transferring");
        decision.ok()
    }

    fn count_skip(&self, task: &Arc<Task>, file: bool, _why: &str) {
        {
            let mut st = task.state.lock().unwrap();
            if file {
                st.files.skipped += 1;
            } else {
                st.dirs.skipped += 1;
            }
        }
        task.emit_task();
    }

    fn count_fail(&self, task: &Arc<Task>, file: bool, why: &str) {
        {
            let mut st = task.state.lock().unwrap();
            if file {
                st.files.failed += 1;
            } else {
                st.dirs.failed += 1;
            }
            st.error = Some(why.to_string());
        }
        task.emit_task();
    }

    fn count_cancel(&self, task: &Arc<Task>, file: bool) {
        let mut st = task.state.lock().unwrap();
        if file {
            st.files.cancelled += 1;
        } else {
            st.dirs.cancelled += 1;
        }
    }

    // ---- 临时文件清理与台账 ----

    fn ledger_add(&self, summary: &str, path: &str) {
        {
            let mut ledger = self.ledger.lock().unwrap();
            ledger
                .entry(summary.to_string())
                .or_default()
                .push(path.to_string());
        }
        self.save_ledger();
    }

    fn ledger_remove(&self, summary: &str, path: &str) {
        let mut empty = false;
        {
            let mut ledger = self.ledger.lock().unwrap();
            if let Some(list) = ledger.get_mut(summary) {
                list.retain(|p| p != path);
                empty = list.is_empty();
            }
            if empty {
                ledger.remove(summary);
            }
        }
        self.save_ledger();
    }

    fn save_ledger(&self) {
        let tmp = self.ledger_path.with_extension("json.tmp");
        if std::fs::create_dir_all(self.ledger_path.parent().unwrap_or(&self.ledger_path)).is_ok()
            && serde_json::to_string(&*self.ledger.lock().unwrap())
                .ok()
                .and_then(|t| std::fs::write(&tmp, t).ok())
                .is_some()
        {
            let _ = std::fs::rename(&tmp, &self.ledger_path);
        }
    }

    /// 任务收尾:清理还挂在自己名下的临时文件;清理不掉的记入台账,
    /// 下次连接同一主机时重试。绝不冒充"已清理"。
    async fn cleanup_temps(&self, task: &Arc<Task>) {
        let temps = task.temps.lock().unwrap().clone();
        task.temps.lock().unwrap().clear();
        if temps.is_empty() {
            return;
        }
        let mut stuck = Vec::new();
        if self.endpoints_valid(task).await {
            if let Ok(df) = self.ssh.open_sftp(&task.dst.session_id).await {
                for p in &temps {
                    if df.remove_file(p).await.is_err() && df.symlink_metadata(p).await.is_ok() {
                        stuck.push(p.clone());
                    }
                }
            } else {
                stuck = temps.clone();
            }
        } else {
            stuck = temps.clone();
        }
        for p in &stuck {
            self.ledger_add(&task.dst.summary, p);
        }
        for p in temps.iter().filter(|p| !stuck.contains(p)) {
            self.ledger_remove(&task.dst.summary, p);
        }
        if !stuck.is_empty() {
            let mut st = task.state.lock().unwrap();
            st.error = Some(format!(
                "有 {} 个临时文件未能清理,将在下次连接时重试",
                stuck.len()
            ));
        }
    }

    /// 会话建立后调用:清理该主机上次任务遗留的临时文件。
    /// 只处理台账登记、且仍匹配 .nbpart 命名的路径。
    pub fn on_session_connected(self: Arc<Self>, session_id: String) {
        let ssh = self.ssh.clone();
        tauri::async_runtime::spawn(async move {
            let Some(summary) = ssh.session_summary(&session_id).await else {
                return;
            };
            let paths = self
                .ledger
                .lock()
                .unwrap()
                .get(&summary)
                .cloned()
                .unwrap_or_default();
            if paths.is_empty() {
                return;
            }
            let Ok(sftp) = ssh.open_sftp(&session_id).await else {
                return;
            };
            let mut remaining = Vec::new();
            for p in paths {
                let name_ok = p
                    .rsplit('/')
                    .next()
                    .map(|n| n.contains(".nbpart-"))
                    .unwrap_or(false);
                if !name_ok {
                    remaining.push(p);
                    continue;
                }
                let gone =
                    sftp.remove_file(&p).await.is_ok() || sftp.symlink_metadata(&p).await.is_err();
                if !gone {
                    remaining.push(p);
                }
            }
            {
                let mut ledger = self.ledger.lock().unwrap();
                if remaining.is_empty() {
                    ledger.remove(&summary);
                } else {
                    ledger.insert(summary.clone(), remaining);
                }
            }
            self.save_ledger();
        });
    }
}

fn join_base(display: &str) -> String {
    // 目录冲突改名时按源条目自身的名字(不含路径)生成候选
    display.rsplit('/').next().unwrap_or(display).to_string()
}

async fn stream_copy(
    sf: &Arc<russh_sftp::client::SftpSession>,
    src_path: &str,
    df: &Arc<russh_sftp::client::SftpSession>,
    part_path: &str,
    total: u64,
    written: &mut u64,
    last_pct: &mut i64,
    task: &Arc<Task>,
) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    let mut src = sf.open(src_path).await.map_err(|e| e.to_string())?;
    let mut dst = df
        .open_with_flags(part_path, OpenFlags::WRITE)
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if task.cancel.load(Ordering::SeqCst) {
            return Err("__cancelled__".into());
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        *written += n as u64;
        task.state.lock().unwrap().bytes += n as u64;
        if total > 0 {
            let pct = (*written * 100 / total) as i64;
            if pct != *last_pct {
                *last_pct = pct;
                task.emit_task();
            }
        }
    }
    dst.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod transfer_tests {
    use super::*;
    use russh_sftp::protocol::FileAttributes;

    fn attrs(perms: Option<u32>) -> FileAttributes {
        let mut m = FileAttributes::default();
        m.permissions = perms;
        m
    }

    #[test]
    fn classify_uses_mode_type_bits_and_falls_back_safely() {
        // 完整 st_mode:REG/DIR/LNK/特殊文件
        assert!(matches!(classify(&attrs(Some(0o100_644))), Kind::File));
        assert!(matches!(classify(&attrs(Some(0o040_755))), Kind::Dir));
        assert!(matches!(classify(&attrs(Some(0o120_777))), Kind::Symlink));
        assert!(matches!(classify(&attrs(Some(0o010_644))), Kind::Other));
        assert!(matches!(classify(&attrs(Some(0o020_600))), Kind::Other));
        // 无类型位(部分服务器只回权限位):按普通文件兜底,可复制
        assert!(matches!(classify(&attrs(Some(0o644))), Kind::File));
        assert!(matches!(classify(&attrs(None)), Kind::File));
    }

    #[test]
    fn remote_path_helpers_use_server_semantics() {
        assert_eq!(parent_of("/a/b"), "/a");
        assert_eq!(parent_of("/a"), "/");
        assert_eq!(parent_of("/"), "/");
        assert_eq!(join_remote("/a", "b"), "/a/b");
        assert_eq!(join_remote("/a/", "b"), "/a/b");
        assert_eq!(join_base("assets/sub"), "sub");
        assert_eq!(join_base("assets"), "assets");
    }

    #[test]
    fn terminal_stages_cannot_be_regressed() {
        for stage in [
            "done",
            "done-partial",
            "partial",
            "failed",
            "cancelled",
            "interrupted",
        ] {
            assert!(is_terminal_stage(stage));
        }
        for stage in ["queued", "transferring", "waiting", "cancelling"] {
            assert!(!is_terminal_stage(stage));
        }
    }
}
