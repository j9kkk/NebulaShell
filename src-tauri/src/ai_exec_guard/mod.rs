//! AI 执行命令守卫：命令分级的唯一规则源（纯函数，无副作用）。
//!
//! 定位是安全网而不是沙箱：shell 图灵完备，任何黑名单都能被足够刻意的写法
//! 绕过。真正的边界是「只作用于绑定主机 + 用户确认 + 全程可见可中断」；这里
//! 负责把常见的破坏性、外联与混淆写法拦到确认环节，并对看不透的结构
//! fail-closed（命令名动态、内联脚本、管道喂给解释器等一律要求确认）。
//!
//! 会话授权（自动模式下按「授权类 + 目标」免确认）也只在这里判定：
//! `grant::evaluate` + `grant::covered` 是唯一入口，前端只保存授权列表。

pub mod grant;
mod lexer;
mod paths;
mod preview;
mod redact;
mod rules;
mod rules_net;
#[cfg(test)]
mod tests_allow;
#[cfg(test)]
mod tests_classify;
#[cfg(test)]
mod tests_grant;
#[cfg(test)]
mod tests_paths;

use grant::GrantTarget;
pub use paths::{path_policy, shell_quote, PathPolicy};
pub use preview::preview_command;
pub use redact::{redact, MASK};

/// 严重度等级，声明顺序即严重度，可直接比较（Normal < Egress < Danger）。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Normal,
    Egress,
    Danger,
}

/// 分级上下文：目标主机 OS 是否已知、当前是否 root、执行目录与本会话下载产物。
#[derive(Debug, Clone, Copy, Default)]
pub struct GuardCtx<'a> {
    pub os_known: bool,
    pub is_root: bool,
    /// 本会话下载产物的绝对路径（文件或 git clone 目录）：执行、安装、移动它们需确认。
    pub tainted: &'a [String],
    /// 命令执行目录，用于把相对路径解析为绝对路径；未知时为空。
    pub cwd: &'a str,
}

/// 分级结论。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub tier: Tier,
    pub reasons: Vec<String>,
    /// 与 reasons 下标对齐的稳定规则 ID，在 `add` 时一并登记，补判升档也不会过期。
    pub rule_ids: Vec<String>,
    pub as_root: bool,
    /// 目标环境无法判断（未知 OS）：任何模式都要确认。
    pub force_confirm: bool,
    /// 非追加写入的目标（已按执行目录解析）；调用方在远端确认已存在时升级为「覆盖已有文件」。
    pub redirect_targets: Vec<String>,
    pub delete_targets: Vec<String>,
    /// cp/mv/install/ln 的目标若是已有目录，实际覆盖的是「目录/源文件名」，由调用方展开查。
    #[serde(skip)]
    pub copy_dests: Vec<CopyDest>,
    /// 下载类命令访问的外部主机（会话授权的记账键）。
    #[serde(skip)]
    pub net_hosts: Vec<String>,
    /// 不可会话授权的原因（只记第一条）。
    #[serde(skip)]
    pub allow_block: Option<String>,
    /// 高危可授权原因登记的目标（与授权复核事实按下标对齐）。
    #[serde(skip)]
    pub grant_targets: Vec<GrantTarget>,
    /// 下载产物路径（已按执行目录解析），执行后由调用方并入会话污点。
    #[serde(skip)]
    pub downloads: Vec<String>,
}

/// 复制/移动的目标与来源（均已按执行目录解析）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyDest {
    pub dest: String,
    /// (来源, 是否可在远端安全展开的通配)；动态来源记为 None。
    pub srcs: Vec<Option<(String, bool)>>,
    /// 递归复制：同名目录会被合并（覆盖其中文件）。
    pub recursive: bool,
}

/// 可授权的结论：规则、给人看的类别名、需要逐一授权的目标。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Allowable {
    pub rule: &'static str,
    pub label: &'static str,
    pub keys: Vec<String>,
}

pub const R_RECURSIVE_DELETE: &str = "递归删除";
pub const R_DELETE: &str = "删除文件";
pub const R_DISK: &str = "格式化或写入磁盘";
pub const R_POWER: &str = "关机或重启";
pub const R_ACCOUNT: &str = "修改账户或密码";
pub const R_PRIV_GROUP: &str = "加入特权用户组（等同 root 权限）";
pub const R_PERM_RECURSIVE: &str = "递归修改权限";
pub const R_PERM: &str = "修改文件权限";
pub const R_GIT: &str = "破坏不可逆的 git 操作";
pub const R_KILL: &str = "结束进程";
pub const R_UNINSTALL: &str = "卸载软件包";
pub const R_CRON: &str = "删除或覆盖定时任务";
pub const R_TRUNCATE: &str = "清空文件内容";
pub const R_CONTAINER: &str = "删除容器或数据";
pub const R_CONTAINER_ESCAPE: &str = "容器可获得宿主机 root 权限";
pub const R_CLUSTER: &str = "删除集群资源";
pub const R_DB: &str = "删除数据库对象或数据";
pub const R_DISCONNECT: &str = "可能切断当前 SSH 连接";
pub const R_SENSITIVE_WRITE: &str = "写入敏感系统位置";
pub const R_TRUST_SOURCE: &str = "添加软件源或信任密钥";
pub const R_INPLACE: &str = "原地修改文件";
pub const R_OVERWRITE_EXISTING: &str = "覆盖已有文件";
pub const R_DYNAMIC_TARGET: &str = "写入目标无法确定";
pub const R_OBFUSCATED: &str = "混淆或动态执行结构";
pub const R_INLINE_SCRIPT: &str = "内联脚本无法检查";
pub const R_PIPE_SHELL: &str = "管道内容直接交给解释器执行";
pub const R_DOWNLOAD_SHELL: &str = "下载内容直接交给 shell";
pub const R_UNPARSABLE: &str = "命令结构无法解析";
pub const R_DEFERRED: &str = "延迟执行任意命令";
pub const R_SENSITIVE: &str = "访问敏感文件（密钥/凭据）";
pub const R_UPLOAD: &str = "上传数据到外部地址";
pub const R_DOWNLOAD: &str = "从外部地址下载";
pub const R_NETWORK: &str = "访问外部网络";
pub const R_LISTEN: &str = "开放网络服务（可能暴露本机文件）";
pub const R_PKG_SOURCE: &str = "从非默认源安装软件包（安装时会执行其代码）";
pub const R_REMOTE: &str = "连接或传输到其他主机";
pub const R_TMP_EXEC: &str = "执行临时目录中的文件";
pub const R_EXEC_DOWNLOADED: &str = "执行或安装本会话下载的文件";

/// 稳定规则 ID：reason 是给人看的文案，ID 是机器判定键（会话授权按它记账）。
pub const RULE_DOWNLOAD: &str = "egress.download";

/// reason → 稳定规则 ID。reason 集合封闭于上面的常量；补判生成的带路径原因
/// （「覆盖已有文件：/etc/x」）按前缀归类；未知原因归入 `unknown`，永不可授权。
fn rule_id(reason: &str) -> &'static str {
    match reason {
        R_RECURSIVE_DELETE => "danger.recursive-delete",
        R_DELETE => "danger.delete",
        R_DISK => "danger.disk",
        R_POWER => "danger.power",
        R_ACCOUNT => "danger.account",
        R_PRIV_GROUP => "danger.priv-group",
        R_PERM_RECURSIVE => "danger.perm-recursive",
        R_PERM => "danger.perm",
        R_GIT => "danger.git",
        R_KILL => "danger.kill",
        R_UNINSTALL => "danger.uninstall",
        R_CRON => "danger.cron",
        R_TRUNCATE => "danger.truncate",
        R_CONTAINER => "danger.container",
        R_CONTAINER_ESCAPE => "danger.container-escape",
        R_CLUSTER => "danger.cluster",
        R_DB => "danger.db",
        R_DISCONNECT => "danger.disconnect",
        R_SENSITIVE_WRITE => "danger.sensitive-write",
        R_TRUST_SOURCE => "danger.trust-source",
        R_INPLACE => "danger.inplace",
        R_DYNAMIC_TARGET => "danger.dynamic-target",
        R_OBFUSCATED => "danger.obfuscated",
        R_INLINE_SCRIPT => "danger.inline-script",
        R_PIPE_SHELL => "danger.pipe-shell",
        R_DOWNLOAD_SHELL => "danger.download-shell",
        R_UNPARSABLE => "danger.unparsable",
        R_DEFERRED => "danger.deferred",
        R_SENSITIVE => "danger.sensitive",
        R_UPLOAD => "egress.upload",
        R_DOWNLOAD => RULE_DOWNLOAD,
        R_NETWORK => "egress.network",
        R_LISTEN => "egress.listen",
        R_PKG_SOURCE => "egress.package-source",
        R_REMOTE => "egress.remote",
        R_TMP_EXEC => "egress.tmp-exec",
        R_EXEC_DOWNLOADED => "egress.exec-downloaded",
        r if r.starts_with(R_OVERWRITE_EXISTING) => "danger.overwrite-existing",
        _ => "unknown",
    }
}

impl Verdict {
    pub fn empty() -> Self {
        Verdict {
            tier: Tier::Normal,
            reasons: Vec::new(),
            rule_ids: Vec::new(),
            as_root: false,
            force_confirm: false,
            redirect_targets: Vec::new(),
            delete_targets: Vec::new(),
            copy_dests: Vec::new(),
            net_hosts: Vec::new(),
            allow_block: None,
            grant_targets: Vec::new(),
            downloads: Vec::new(),
        }
    }

    /// 升档并记录原因与规则 ID（去重保序）。高危可授权原因不带目标登记即视为
    /// 目标看不清，阻断会话授权（见 `grant::needs_target`）。
    pub fn add(&mut self, tier: Tier, reason: &str) {
        self.record(tier, reason);
        if grant::needs_target(reason) {
            self.block_allow(grant::B_TARGET);
        }
    }

    /// 升档并登记该原因的授权目标（目标须已静态确定、按执行目录解析）。
    pub(crate) fn add_targets(
        &mut self,
        tier: Tier,
        reason: &str,
        targets: impl IntoIterator<Item = GrantTarget>,
    ) {
        self.record(tier, reason);
        let before = self.grant_targets.len();
        self.grant_targets.extend(targets);
        if self.grant_targets.len() == before {
            self.block_allow(grant::B_TARGET);
        }
    }

    fn record(&mut self, tier: Tier, reason: &str) {
        if tier > self.tier {
            self.tier = tier;
        }
        if tier > Tier::Normal && !self.reasons.iter().any(|r| r == reason) {
            self.reasons.push(reason.to_string());
            self.rule_ids.push(rule_id(reason).to_string());
        }
    }

    fn merge(&mut self, other: Verdict) {
        for (r, id) in other.reasons.iter().zip(&other.rule_ids) {
            if !self.reasons.contains(r) {
                self.reasons.push(r.clone());
                self.rule_ids.push(id.clone());
            }
        }
        self.tier = self.tier.max(other.tier);
        self.as_root |= other.as_root;
        self.force_confirm |= other.force_confirm;
        for t in other.redirect_targets {
            push_unique(&mut self.redirect_targets, t);
        }
        for t in other.delete_targets {
            push_unique(&mut self.delete_targets, t);
        }
        for c in other.copy_dests {
            if !self.copy_dests.contains(&c) {
                self.copy_dests.push(c);
            }
        }
        for h in other.net_hosts {
            push_unique(&mut self.net_hosts, h);
        }
        if self.allow_block.is_none() {
            self.allow_block = other.allow_block;
        }
        self.grant_targets.extend(other.grant_targets);
        for d in other.downloads {
            push_unique(&mut self.downloads, d);
        }
    }

    /// 登记一条「不可会话授权」的原因（只留第一条，够解释）。
    pub(crate) fn block_allow(&mut self, why: &str) {
        if self.allow_block.is_none() {
            self.allow_block = Some(why.to_string());
        }
    }
}

pub(crate) fn push_unique(list: &mut Vec<String>, item: String) {
    if !list.contains(&item) {
        list.push(item);
    }
}

/// 把命令里的路径按执行目录解析为绝对路径并做词法归一（`.` 与 `..`）。
/// `~` 开头的路径无法得知家目录，按原样归一：污点记账与比对走同一函数，口径一致。
pub(crate) fn resolve_path(cwd: &str, p: &str) -> String {
    let joined = if p.starts_with('/') || p.starts_with('~') || cwd.is_empty() {
        p.to_string()
    } else {
        format!("{}/{p}", cwd.trim_end_matches('/'))
    };
    let abs = joined.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." if parts.last().is_some_and(|s| *s != "..") => {
                parts.pop();
            }
            ".." if abs => {}
            s => parts.push(s),
        }
    }
    let body = parts.join("/");
    if abs {
        format!("/{body}")
    } else {
        body
    }
}

/// 路径是否落在下载产物上（本会话之前的命令，或本条命令前面的分段）：
/// 等于某个产物，或位于产物目录（git clone）之下。
pub(crate) fn is_tainted(ctx: &GuardCtx, v: &Verdict, raw: &str) -> bool {
    if raw.is_empty() || (ctx.tainted.is_empty() && v.downloads.is_empty()) {
        return false;
    }
    let p = resolve_path(ctx.cwd, raw);
    ctx.tainted.iter().chain(&v.downloads).any(|t| {
        p == *t
            || p.strip_prefix(t.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// 命令替换、`sh -c` 等嵌套的最大递归深度；更深即视为混淆。
const MAX_DEPTH: usize = 4;

/// 对整条命令行做分级：所有分段与嵌套命令取最高档，原因去重保序。
pub fn classify(cmd: &str, ctx: &GuardCtx) -> Verdict {
    let mut v = classify_at(cmd, ctx, 0);
    if !ctx.os_known {
        v.force_confirm = true;
    }
    if ctx.is_root {
        v.as_root = true;
    }
    v
}

fn classify_at(cmd: &str, ctx: &GuardCtx, depth: usize) -> Verdict {
    let mut v = Verdict::empty();
    if depth > MAX_DEPTH {
        v.add(Tier::Danger, R_OBFUSCATED);
        return v;
    }
    let lx = lexer::lex(cmd);
    if lx.unbalanced {
        v.add(Tier::Danger, R_UNPARSABLE);
    }
    if lx.func_def {
        v.add(Tier::Danger, R_OBFUSCATED);
    }
    for body in lx.substitutions.iter().chain(&lx.proc_substitutions) {
        v.merge(classify_at(body, ctx, depth + 1));
    }
    // `cd 目录 && …` 之后的分段在新目录下解析相对路径（污点比对与授权目标依赖它）。
    // 目录推不准（动态、`cd -`、popd、子 shell 里切换）或有条件/循环结构时，
    // 后续路径都不可信：分级照常，会话授权一律阻断。
    let mut cwd = ctx.cwd.to_string();
    for idx in 0..lx.segments.len() {
        let seg = &lx.segments[idx];
        if seg
            .words
            .first()
            .is_some_and(|w| !w.quoted && rules::is_flow_keyword(&w.text))
        {
            v.block_allow(grant::B_FLOW);
        }
        let seg_ctx = GuardCtx { cwd: &cwd, ..*ctx };
        rules::classify_segment(&lx, idx, &seg_ctx, depth, &mut v);
        match rules::cd_target(seg) {
            Some(dir) => {
                if lx.subshell {
                    v.block_allow(grant::B_CWD);
                }
                cwd = resolve_path(&cwd, &dir);
            }
            None if matches!(
                rules::segment_head(seg).as_deref(),
                Some("cd" | "pushd" | "popd")
            ) =>
            {
                v.block_allow(grant::B_CWD);
            }
            None => {}
        }
    }
    v
}

/// 嵌套命令文本（`sh -c` 参数、heredoc 正文等）的递归入口。
fn classify_nested(cmd: &str, ctx: &GuardCtx, depth: usize, v: &mut Verdict) {
    v.merge(classify_at(cmd, ctx, depth + 1));
}
