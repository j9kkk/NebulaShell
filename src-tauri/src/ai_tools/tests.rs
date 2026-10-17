use super::files::{clip_long_lines, complete_utf8_len, fmt_time, human_size};
use super::run::{clean_output, finalize, split_pgid, take_complete_utf8, wrap, HeadTail};
use super::*;

#[test]
fn linked_sessions_whitelist_rejects_unlisted_sessions() {
    // 未带白名单(旧路径):不限制。
    assert!(session_allowed(&json!({ "sessionId": "s1" }), "s1"));
    // 带白名单:只放行列表内。
    let p = json!({ "sessionId": "s2", "linkedSessions": ["s1", "s2"] });
    assert!(session_allowed(&p, "s1"));
    assert!(session_allowed(&p, "s2"));
    assert!(!session_allowed(&p, "s3"), "不在白名单的会话必须被拒");
    // 空数组=一台都没链接,一律拒绝。
    assert!(!session_allowed(&json!({ "linkedSessions": [] }), "s1"));
}

#[test]
fn head_tail_keeps_both_ends() {
    let mut h = HeadTail::new(4, 4);
    h.push(b"abc");
    let (text, truncated, total) = h.finish();
    assert_eq!((text.as_str(), truncated, total), ("abc", false, 3));

    let mut h = HeadTail::new(4, 4);
    h.push(b"0123");
    h.push(b"4567");
    assert_eq!(h.finish(), ("01234567".to_string(), false, 8));

    let mut h = HeadTail::new(4, 4);
    h.push(b"0123456");
    h.push(b"789");
    assert_eq!(
        h.finish(),
        ("0123\n…（中间省略 2 字节）…\n6789".to_string(), true, 10)
    );

    let mut h = HeadTail::new(4, 4);
    h.push(b"head-middle-");
    h.push(b"error: boom");
    let (text, truncated, total) = h.finish();
    assert!(truncated);
    assert_eq!(total, 23);
    assert!(text.starts_with("head"), "{text}");
    assert!(text.ends_with("boom"), "{text}");
    assert!(text.contains("省略 15 字节"), "{text}");
}

#[test]
fn clean_output_strips_ansi_and_progress_frames() {
    assert_eq!(clean_output("\x1b[31mred\x1b[0m ok"), "red ok");
    assert_eq!(clean_output("\x1b]0;title\x07done"), "done");
    assert_eq!(clean_output("10%\r50%\r100%\nnext"), "100%\nnext");
    assert_eq!(clean_output("a\r\nb\r\n"), "a\nb\n");
    assert_eq!(clean_output("tab\there\x08"), "tab\there");
}

#[test]
fn pgid_marker_is_split_from_output() {
    assert_eq!(
        split_pgid(b"__NB_PGID 4242\nhello"),
        Some((Some(4242), b"hello".to_vec()))
    );
    assert_eq!(
        split_pgid(b"motd line\n__NB_PGID 7\nrest"),
        Some((Some(7), b"motd line\nrest".to_vec()))
    );
    assert_eq!(split_pgid(b"__NB_PGID 42"), None, "标记行未完整时继续等");
    assert!(split_pgid(&vec![b'x'; 9000]).is_some_and(|(p, _)| p.is_none()));
}

#[test]
fn utf8_chunks_never_split_characters() {
    let mut buf = "中文".as_bytes().to_vec();
    buf.pop();
    let text = take_complete_utf8(&mut buf);
    assert_eq!(text, "中");
    assert_eq!(buf.len(), 2);
    assert_eq!(complete_utf8_len("ab中".as_bytes()), 5);
    assert_eq!(complete_utf8_len(&"ab中".as_bytes()[..4]), 2);
}

#[test]
fn finalize_masks_secrets_and_sudo_password() {
    let (out, n) = finalize("password=abc\nhunter2 echoed", Some("hunter2"));
    assert_eq!(out, "password=[已脱敏]\n[已脱敏] echoed");
    assert_eq!(n, 2);
}

#[test]
fn wrapper_quotes_every_layer() {
    let w = wrap("/var/log", "echo 'hi' && ls", false);
    assert!(w.starts_with("exec sh -c '"));
    assert!(
        w.ends_with("nb '/var/log' 'echo '\\''hi'\\'' && ls'"),
        "{w}"
    );
    let s = wrap("", "sudo apt-get update", true);
    assert!(s.contains("SUDO_ASKPASS"));
    assert!(s.contains("nb '' "));
}

#[test]
fn host_info_parsing() {
    let out = "Linux 5.15.0-91-generic x86_64\n__NB_SEP\nPRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\nID=ubuntu\n__NB_SEP\nroot\n0\n/bin/bash\n__NB_SEP\nsystemd\njournald\nprintenv\n";
    let i = hostinfo::parse(out);
    assert!(i.os_known && i.is_root && i.systemd && i.journald && i.askpass);
    assert_eq!(i.os, "Ubuntu 22.04.4 LTS");
    assert_eq!(i.os_id, "ubuntu");
    assert_eq!(i.user, "root");
    assert_eq!(i.shell, "/bin/bash");

    let mac = hostinfo::parse(
        "Darwin 23.1.0 arm64\n__NB_SEP\n__NB_SEP\nalice\n501\n/bin/zsh\n__NB_SEP\n",
    );
    assert!(mac.os_known && !mac.is_root);
    assert_eq!(mac.os, "Darwin");

    let unknown = hostinfo::parse("% Invalid input detected\n");
    assert!(!unknown.os_known);
    assert!(hostinfo::summary(&unknown).contains("都需要用户确认"));
}

#[test]
fn read_only_commands_quote_user_input() {
    assert_eq!(
        tail_cmd("/var/log/a b.log", 50, false),
        "tail -n 50 -- '/var/log/a b.log'"
    );
    assert_eq!(
        tail_cmd("/x.gz", 10, true),
        "gzip -dc -- '/x.gz' | tail -n 10"
    );
    let args = json!({ "pattern": "it's; rm -rf /", "context": 9, "ignoreCase": true });
    assert_eq!(
        search_cmd("/var/log/syslog", &args, false),
        "grep -n -F -i -C 5 -m 200 -e 'it'\\''s; rm -rf /' -- '/var/log/syslog'"
    );
    assert_eq!(
        journal_cmd(&json!({ "unit": "nginx", "since": "10 min ago", "lines": 9999 })),
        "journalctl --no-pager -o short-iso -u 'nginx' --since '10 min ago' -n 500"
    );
    assert_eq!(
        journal_cmd(&json!({ "grep": "OOM" })),
        "journalctl --no-pager -o short-iso -n 20000 | grep -F -i -e 'OOM' | tail -n 200"
    );
}

#[test]
fn sudo_detection_is_lexical() {
    assert!(mentions_sudo("sudo apt-get update"));
    assert!(mentions_sudo("cd /x && sudo -E make install"));
    assert!(mentions_sudo("echo hi | /usr/bin/sudo tee /x"));
    assert!(!mentions_sudo("pseudo-random"));
    assert!(!mentions_sudo("grep sudoers /etc/group"));
}

#[test]
fn small_formatters() {
    assert_eq!(human_size(512), "512 B");
    assert_eq!(human_size(1536), "1.5 KB");
    assert_eq!(fmt_time(0), "1970-01-01 00:00");
    assert_eq!(fmt_time(1_760_400_000), "2025-10-14 00:00");
    assert_eq!(
        clip_long_lines("ab\ncdef", 3),
        "ab\ncde…（此行过长，已截断）"
    );
}
