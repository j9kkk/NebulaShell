//! 输出脱敏：把私钥、令牌与口令值替换为 [`MASK`]。
//!
//! 工具输出回填给模型前都要过这里（含 exec 输出），宁可多遮也不漏遮；但只遮
//! 「值」，保留键名与上下文，让模型仍能读懂日志结构。

pub const MASK: &str = "[已脱敏]";

/// 返回（脱敏后文本, 替换次数）。
pub fn redact(text: &str) -> (String, usize) {
    let mut n = 0;
    let s = redact_pem(text, &mut n);
    let s = redact_inline(&s, &mut n);
    (s, n)
}

/// PEM 私钥整块替换；没有 END（输出被截断）时遮到文本末尾。
fn redact_pem(text: &str, n: &mut usize) -> String {
    const BEGIN: &str = "-----BEGIN ";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(b) = rest.find(BEGIN) {
        let block = &rest[b..];
        let header_end = block.find('\n').unwrap_or(block.len());
        if !block[..header_end].contains("PRIVATE KEY-----") {
            out.push_str(&rest[..b + BEGIN.len()]);
            rest = &rest[b + BEGIN.len()..];
            continue;
        }
        out.push_str(&rest[..b]);
        out.push_str(MASK);
        *n += 1;
        rest = match block.find("-----END ") {
            Some(e) => {
                let tail = &block[e + 9..];
                let close = tail.find("-----").map_or(tail.len(), |x| x + 5);
                &tail[close..]
            }
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn is_tok(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn starts(c: &[char], i: usize, pat: &str) -> bool {
    let mut k = i;
    for p in pat.chars() {
        if c.get(k) != Some(&p) {
            return false;
        }
        k += 1;
    }
    true
}

fn starts_ci(c: &[char], i: usize, pat: &str) -> bool {
    let mut k = i;
    for p in pat.chars() {
        if !c.get(k).is_some_and(|x| x.eq_ignore_ascii_case(&p)) {
            return false;
        }
        k += 1;
    }
    true
}

fn run(c: &[char], from: usize, ok: impl Fn(char) -> bool) -> usize {
    c[from.min(c.len())..]
        .iter()
        .take_while(|&&x| ok(x))
        .count()
}

/// 已知格式的令牌：返回从 `i` 起需要遮住的长度。
fn known_token(c: &[char], i: usize) -> Option<usize> {
    let alnum = |x: char| x.is_ascii_alphanumeric();
    let word = |x: char| x.is_ascii_alphanumeric() || x == '_';
    let dash = |x: char| x.is_ascii_alphanumeric() || x == '_' || x == '-';
    let upper = |x: char| x.is_ascii_uppercase() || x.is_ascii_digit();
    let at_least = |len: usize, min: usize, prefix: usize| (len >= min).then_some(prefix + len);

    if starts(c, i, "AKIA") || starts(c, i, "ASIA") {
        if let Some(n) = at_least(run(c, i + 4, upper), 16, 4) {
            return Some(n);
        }
    }
    for p in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if starts(c, i, p) {
            return at_least(run(c, i + 4, alnum), 36, 4);
        }
    }
    let prefixed: [(&str, usize, &dyn Fn(char) -> bool); 4] = [
        ("github_pat_", 22, &word),
        ("glpat-", 20, &dash),
        ("sk-", 20, &dash),
        ("AIza", 30, &dash),
    ];
    for (p, min, ok) in prefixed {
        if starts(c, i, p) {
            if let Some(n) = at_least(run(c, i + p.len(), ok), min, p.len()) {
                return Some(n);
            }
        }
    }
    if starts(c, i, "xox")
        && c.get(i + 3).is_some_and(|x| "baprs".contains(*x))
        && c.get(i + 4) == Some(&'-')
    {
        if let Some(n) = at_least(run(c, i + 5, dash), 10, 5) {
            return Some(n);
        }
    }
    // JWT：三段 base64url。
    if starts(c, i, "eyJ") {
        let a = run(c, i, dash);
        if a >= 10 && c.get(i + a) == Some(&'.') {
            let b = run(c, i + a + 1, dash);
            if b >= 8 && c.get(i + a + 1 + b) == Some(&'.') {
                let d = run(c, i + a + b + 2, dash);
                if d >= 8 {
                    return Some(a + b + d + 2);
                }
            }
        }
    }
    // crypt(3) 口令哈希（/etc/shadow 等）。
    for p in [
        "$1$", "$2a$", "$2b$", "$2y$", "$5$", "$6$", "$7$", "$y$", "$gy$", "$argon2",
    ] {
        if starts(c, i, p) {
            return at_least(run(c, i, |x| !x.is_whitespace() && x != ':'), 12, 0);
        }
    }
    None
}

/// 键名看起来是口令/密钥（`DB_PASSWORD`、`api_key`、`x-auth-token`…）。
fn is_secret_key(id: &str) -> bool {
    const KEYS: &[&str] = &[
        "password",
        "passwd",
        "passphrase",
        "secret",
        "token",
        "api_key",
        "apikey",
        "api-key",
        "access_key",
        "accesskey",
        "private_key",
        "privatekey",
        "credential",
    ];
    let l = id.to_ascii_lowercase();
    !l.is_empty()
        && (KEYS.iter().any(|k| l.contains(k))
            || l.ends_with("_pwd")
            || l.ends_with("_pass")
            || l == "pass")
}

/// `out` 末尾的标识符（跳过空白与一个收尾引号），即 `=`/`:` 前的键名。
fn trailing_ident(out: &str) -> &str {
    let s = out.trim_end_matches([' ', '\t']);
    let s = s.strip_suffix(['"', '\'']).unwrap_or(s);
    let start = s
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .last()
        .map_or(s.len(), |(i, _)| i);
    &s[start..]
}

fn worth_masking(v: &str) -> bool {
    !v.is_empty()
        && v != MASK
        && !v.chars().all(|c| c == '*' || c == 'x' || c == 'X')
        && !v.starts_with('$')
        && !matches!(
            v.to_ascii_lowercase().as_str(),
            "null" | "none" | "true" | "false" | "\"\"" | "''"
        )
}

fn redact_inline(text: &str, n: &mut usize) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let boundary = i == 0 || !is_tok(c[i - 1]);
        if boundary {
            if let Some(len) = known_token(&c, i) {
                out.push_str(MASK);
                *n += 1;
                i += len;
                continue;
            }
            // Authorization: Bearer/Basic <凭据>
            for scheme in ["bearer ", "basic "] {
                if starts_ci(&c, i, scheme) {
                    let k = i + scheme.len();
                    let len = run(&c, k, |x| {
                        x.is_ascii_alphanumeric() || "._~+/=-".contains(x)
                    });
                    if len >= 8 {
                        out.extend(&c[i..k]);
                        out.push_str(MASK);
                        *n += 1;
                        i = k + len;
                    }
                }
            }
            if i >= c.len() {
                break;
            }
        }
        // URL 里的口令：scheme://user:pass@host
        if starts(&c, i, "://") {
            out.push_str("://");
            i += 3;
            let len = run(&c, i, |x| {
                !matches!(x, '/' | '@' | '"' | '\'') && !x.is_whitespace()
            });
            if c.get(i + len) == Some(&'@') {
                let userinfo: String = c[i..i + len].iter().collect();
                if let Some((user, pass)) = userinfo.split_once(':') {
                    if !pass.is_empty() {
                        out.push_str(user);
                        out.push(':');
                        out.push_str(MASK);
                        *n += 1;
                        i += len;
                    }
                }
            }
            continue;
        }
        let ch = c[i];
        if (ch == '=' || ch == ':') && is_secret_key(trailing_ident(&out)) {
            out.push(ch);
            i += 1;
            let mut j = i;
            while c.get(j).is_some_and(|x| *x == ' ' || *x == '\t') {
                j += 1;
            }
            let quote = c.get(j).copied().filter(|x| *x == '"' || *x == '\'');
            if quote.is_some() {
                j += 1;
            }
            let start = j;
            while let Some(&x) = c.get(j) {
                let end = match quote {
                    Some(q) => x == q,
                    None => x.is_whitespace() || ",;&'\"<>)}]".contains(x),
                };
                if end {
                    break;
                }
                j += 1;
            }
            let value: String = c[start..j].iter().collect();
            out.extend(&c[i..start]);
            if worth_masking(&value) {
                out.push_str(MASK);
                *n += 1;
            } else {
                out.push_str(&value);
            }
            i = j;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}
