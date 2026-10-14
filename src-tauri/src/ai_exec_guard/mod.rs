//! AI 执行命令守卫：命令分级的唯一规则源（纯函数，无副作用）。
//!
//! 定位是安全网而不是沙箱：shell 图灵完备，任何黑名单都能被足够刻意的写法
//! 绕过。真正的边界是「只作用于绑定主机 + 用户确认 + 全程可见可中断」；这里
//! 负责把常见的破坏性、外联与混淆写法拦到确认环节，并对看不透的结构
//! fail-closed（命令名动态、内联脚本、管道喂给解释器等一律要求确认）。

mod lexer;
mod paths;
mod preview;
mod redact;
mod rules;
mod rules_net;
#[cfg(test)]
mod tests_classify;
#[cfg(test)]
mod tests_paths;

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

/// 分级上下文：目标主机 OS 是否已知、当前是否 root。
#[derive(Debug, Clone, Copy, Default)]
pub struct GuardCtx {
    pub os_known: bool,
    pub is_root: bool,
}

/// 分级结论。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub tier: Tier,
    pub reasons: Vec<String>,
    pub as_root: bool,
    /// 目标环境无法判断（未知 OS）：任何模式都要确认。
    pub force_confirm: bool,
    /// 非追加写入的目标；调用方在远端确认已存在时升级为「覆盖已有文件」。
    pub redirect_targets: Vec<String>,
    pub delete_targets: Vec<String>,
}

pub const R_RECURSIVE_DELETE: &str = "递归删除";
pub const R_DELETE: &str = "删除文件";
pub const R_DISK: &str = "格式化或写入磁盘";
pub const R_POWER: &str = "关机或重启";
pub const R_ACCOUNT: &str = "修改账户或密码";
pub const R_PERM_RECURSIVE: &str = "递归修改权限";
pub const R_PERM: &str = "修改文件权限";
pub const R_GIT: &str = "破坏不可逆的 git 操作";
pub const R_KILL: &str = "结束进程";
pub const R_UNINSTALL: &str = "卸载软件包";
pub const R_CRON: &str = "删除或覆盖定时任务";
pub const R_TRUNCATE: &str = "清空文件内容";
pub const R_CONTAINER: &str = "删除容器或数据";
pub const R_CLUSTER: &str = "删除集群资源";
pub const R_DB: &str = "删除数据库对象或数据";
pub const R_DISCONNECT: &str = "可能切断当前 SSH 连接";
pub const R_SENSITIVE_WRITE: &str = "写入敏感系统位置";
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
pub const R_NETWORK: &str = "访问外部网络";
pub const R_REMOTE: &str = "连接或传输到其他主机";
pub const R_TMP_EXEC: &str = "执行临时目录中的文件";

impl Verdict {
    pub fn empty() -> Self {
        Verdict {
            tier: Tier::Normal,
            reasons: Vec::new(),
            as_root: false,
            force_confirm: false,
            redirect_targets: Vec::new(),
            delete_targets: Vec::new(),
        }
    }

    /// 升档并记录原因（去重保序）。
    pub fn add(&mut self, tier: Tier, reason: &str) {
        if tier > self.tier {
            self.tier = tier;
        }
        if tier > Tier::Normal && !self.reasons.iter().any(|r| r == reason) {
            self.reasons.push(reason.to_string());
        }
    }

    fn merge(&mut self, other: Verdict) {
        for r in &other.reasons {
            if !self.reasons.contains(r) {
                self.reasons.push(r.clone());
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
    }
}

pub(crate) fn push_unique(list: &mut Vec<String>, item: String) {
    if !list.contains(&item) {
        list.push(item);
    }
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
    for idx in 0..lx.segments.len() {
        rules::classify_segment(&lx, idx, ctx, depth, &mut v);
    }
    v
}

/// 嵌套命令文本（`sh -c` 参数、heredoc 正文等）的递归入口。
fn classify_nested(cmd: &str, ctx: &GuardCtx, depth: usize, v: &mut Verdict) {
    v.merge(classify_at(cmd, ctx, depth + 1));
}
