//! 路径敏感级别判定与 POSIX 单引号转义。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathPolicy {
    Allow,
    /// 密钥/凭据：工具拒绝读取，命令里引用即要确认。
    Deny,
    /// 可读，但输出必须脱敏（.env、shell 历史）。
    Redact,
}

/// 把 `~`、`$HOME` 开头与相对路径规范成绝对形态。不访问文件系统，家目录按
/// `/root` 近似、相对路径按根目录近似 —— 只用于模式匹配，不用于真实访问。
pub(super) fn normalize(path: &str) -> String {
    let p = path.trim();
    let p = p.strip_prefix("file://").unwrap_or(p);
    if matches!(p, "~" | "$HOME" | "${HOME}") {
        return "/root".to_string();
    }
    for pre in ["~/", "$HOME/", "${HOME}/"] {
        if let Some(rest) = p.strip_prefix(pre) {
            return format!("/root/{rest}");
        }
    }
    if let Some(rest) = p.strip_prefix('~') {
        return format!("/home/{rest}");
    }
    if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{}", p.trim_start_matches("./"))
    }
}

/// 判定路径的敏感级别。支持任意用户家目录与 `~`/`$HOME` 写法。
pub fn path_policy(path: &str) -> PathPolicy {
    let p = normalize(path);
    if is_deny(&p) {
        return PathPolicy::Deny;
    }
    let base = p.rsplit('/').next().unwrap_or("");
    if base.starts_with(".env") || base.ends_with("_history") || base == ".my.cnf" {
        return PathPolicy::Redact;
    }
    PathPolicy::Allow
}

fn is_deny(p: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "/etc/shadow",
        "/etc/gshadow",
        "/etc/sudoers",
        "/etc/master.passwd",
        "/etc/ssl/private/",
    ];
    const CONTAINS: &[&str] = &["/.ssh/", "/.gnupg/", "/.password-store/"];
    const SUFFIXES: &[&str] = &[
        ".pem",
        ".key",
        "/.aws/credentials",
        "/.kube/config",
        "/.docker/config.json",
        "/.git-credentials",
        "/.netrc",
        "/.pgpass",
        "/.npmrc",
        "/.vault-token",
        "/.config/gcloud/credentials.db",
        "/.azure/accessTokens.json",
    ];
    if PREFIXES.iter().any(|x| p.starts_with(x))
        || CONTAINS.iter().any(|x| p.contains(x))
        || SUFFIXES.iter().any(|x| p.ends_with(x))
    {
        return true;
    }
    if p.starts_with("/proc/") && p.ends_with("/environ") {
        return true;
    }
    // 不在 .ssh 目录里的私钥文件、SSH 主机私钥（公钥 .pub 放行）。
    let base = p.rsplit('/').next().unwrap_or("");
    if base.ends_with(".pub") {
        return false;
    }
    base.starts_with("ssh_host_")
        || matches!(
            base.trim_end_matches("_sk"),
            "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519"
        )
}

/// POSIX 单引号转义：内部 `'` → `'\''`。
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
