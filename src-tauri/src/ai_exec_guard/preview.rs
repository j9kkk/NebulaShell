//! 只读预览：在确认卡上展示删除/递归改权限类命令将影响的对象。
//!
//! 预览命令必须是纯只读的；任何无法安全重建的写法（命令替换、多段命令、
//! 重定向、动态参数）都返回 None，宁可不预览也不能让预览本身有副作用。

use super::lexer::{lex, Sep, Word};
use super::rules::basename;
use super::shell_quote;

pub fn preview_command(cmd: &str) -> Option<String> {
    let lx = lex(cmd);
    if lx.unbalanced
        || lx.func_def
        || !lx.substitutions.is_empty()
        || !lx.proc_substitutions.is_empty()
    {
        return None;
    }
    // 支持单段，或 `cd 目录 && <单段>`。
    let (prefix, seg) = match lx.segments.as_slice() {
        [s] => (String::new(), s),
        [c, s]
            if s.sep_before == Sep::And
                && c.redirects.is_empty()
                && c.words.len() == 2
                && c.words[0].text == "cd"
                && !c.words[1].dynamic =>
        {
            (format!("cd -- {} && ", quote_path(&c.words[1])?), s)
        }
        _ => return None,
    };
    if !seg.redirects.is_empty() || seg.words.iter().any(|w| w.dynamic) {
        return None;
    }
    // 预览不带 sudo：权限不足时 ls/find 自己会报错，不需要提权。带选项的
    // sudo（-u 等）会让 k 停在选项上，随后按未知命令返回 None。
    let k = seg
        .words
        .iter()
        .position(|w| !matches!(w.text.as_str(), "sudo" | "nohup" | "command"))?;
    let args = &seg.words[k + 1..];
    let body = match basename(&seg.words[k].text) {
        "rm" | "rmdir" | "unlink" | "shred" => preview_rm(args)?,
        "find" => preview_find(args)?,
        "chmod" | "chown" | "chgrp" => preview_recursive(args)?,
        _ => return None,
    };
    Some(prefix + &body)
}

/// 路径参数转成 shell 文本：保留 `~/` 与 glob 让远端展开，其余单引号包裹。
fn quote_path(w: &Word) -> Option<String> {
    let t = w.text.as_str();
    if t.is_empty() {
        return None;
    }
    if w.glob {
        let safe = t
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./*?[]-+@%:,=~".contains(c));
        let tilde_ok = !t.contains('~') || (t.starts_with("~/") && !t[1..].contains('~'));
        return (safe && tilde_ok).then(|| t.to_string());
    }
    Some(match t.strip_prefix("~/") {
        Some(rest) => format!("~/{}", shell_quote(rest)),
        None => shell_quote(t),
    })
}

fn quote_arg(w: &Word) -> Option<String> {
    let plain = !w.text.is_empty()
        && w.text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=+:,@%".contains(c));
    if plain {
        Some(w.text.clone())
    } else if w.text.starts_with("~/") {
        quote_path(w)
    } else {
        Some(shell_quote(&w.text))
    }
}

fn targets(args: &[Word]) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut opts = true;
    for w in args {
        if opts && w.text == "--" {
            opts = false;
            continue;
        }
        if opts && w.text.starts_with('-') {
            continue;
        }
        out.push(quote_path(w)?);
    }
    (!out.is_empty()).then_some(out)
}

fn preview_rm(args: &[Word]) -> Option<String> {
    let t = targets(args)?.join(" ");
    Some(format!(
        "ls -ld -- {t} 2>&1 | head -n 200; du -sch -- {t} 2>/dev/null | tail -n 1"
    ))
}

fn preview_find(args: &[Word]) -> Option<String> {
    let mut out = vec!["find".to_string()];
    let mut changed = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].text.as_str() {
            "-delete" => {
                out.push("-print".to_string());
                changed = true;
            }
            "-exec" | "-execdir" | "-ok" | "-okdir" => {
                // 只预览删除类 -exec；其他命令的副作用无法用列表代替。
                let cmd = args.get(i + 1).map(|w| basename(&w.text))?;
                if !matches!(cmd, "rm" | "unlink" | "shred" | "rmdir") {
                    return None;
                }
                let mut end = i + 1;
                while end < args.len() && !matches!(args[end].text.as_str(), ";" | "+") {
                    end += 1;
                }
                out.push("-print".to_string());
                changed = true;
                i = end;
            }
            "-fprint" | "-fprint0" | "-fprintf" | "-fls" => return None,
            _ => out.push(quote_arg(&args[i])?),
        }
        i += 1;
    }
    changed.then(|| {
        format!(
            "{} 2>/dev/null | awk 'NR<=200{{print}} END{{print \"共 \" NR \" 项\"}}'",
            out.join(" ")
        )
    })
}

fn preview_recursive(args: &[Word]) -> Option<String> {
    let recursive = args.iter().any(|w| {
        w.text == "--recursive"
            || (w.text.starts_with('-') && !w.text.starts_with("--") && w.text.contains('R'))
    });
    if !recursive {
        return None;
    }
    // 第一个非选项参数是模式/属主，其后才是路径。
    let paths = targets(args)?;
    if paths.len() < 2 && !args.iter().any(|w| w.text.starts_with("--reference")) {
        return None;
    }
    let skip = usize::from(!args.iter().any(|w| w.text.starts_with("--reference")));
    let t = paths[skip..].join(" ");
    Some(format!(
        "find {t} 2>/dev/null | awk 'END{{print \"共 \" NR \" 项\"}}'"
    ))
}
