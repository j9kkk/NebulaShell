//! 路径策略、脱敏、转义与只读预览测试。

use super::*;

#[test]
fn path_policy_levels() {
    let cases = [
        ("/home/u/.ssh/id_rsa", PathPolicy::Deny),
        ("~/.ssh/authorized_keys", PathPolicy::Deny),
        ("/etc/shadow", PathPolicy::Deny),
        ("/etc/sudoers.d/90-cloud", PathPolicy::Deny),
        ("/proc/123/environ", PathPolicy::Deny),
        ("/etc/ssh/ssh_host_ed25519_key", PathPolicy::Deny),
        ("/opt/backup/id_ed25519", PathPolicy::Deny),
        ("/srv/tls/server.key", PathPolicy::Deny),
        ("$HOME/.aws/credentials", PathPolicy::Deny),
        (".ssh/config", PathPolicy::Deny),
        ("/etc/ssh/ssh_host_ed25519_key.pub", PathPolicy::Allow),
        ("/var/log/nginx/error.log", PathPolicy::Allow),
        ("/etc/passwd", PathPolicy::Allow),
        ("/srv/app/.env.production", PathPolicy::Redact),
        ("/root/.bash_history", PathPolicy::Redact),
    ];
    for (p, want) in cases {
        assert_eq!(path_policy(p), want, "{p}");
    }
}

#[test]
fn redact_masks_values_but_keeps_keys() {
    let cases = [
        (
            "db password=hunter2 token: abc",
            "db password=[已脱敏] token: [已脱敏]",
            2,
        ),
        (
            r#"{"password": "s3 cr3t", "user": "bob"}"#,
            r#"{"password": "[已脱敏]", "user": "bob"}"#,
            1,
        ),
        ("MYSQL_ROOT_PASSWORD=abc123 x", "MYSQL_ROOT_PASSWORD=[已脱敏] x", 1),
        (
            "Authorization: Bearer abcdefghijklmnop",
            "Authorization: Bearer [已脱敏]",
            1,
        ),
        (
            "git clone https://user:pa55@example.com/r.git",
            "git clone https://user:[已脱敏]@example.com/r.git",
            1,
        ),
        ("key AKIAABCDEFGHIJKLMNOP end", "key [已脱敏] end", 1),
        (
            "t=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
            "t=[已脱敏]",
            1,
        ),
        ("export OPENAI=sk-abcdefghijklmnopqrstuvwx", "export OPENAI=[已脱敏]", 1),
        (
            "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok",
            "jwt [已脱敏] ok",
            1,
        ),
        (
            "root:$6$saltsalt$abcdefghijklmnopqrstuv:19000:0:99999:7:::",
            "root:[已脱敏]:19000:0:99999:7:::",
            1,
        ),
        (
            "a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\nb",
            "a\n[已脱敏]\nb",
            1,
        ),
        ("a\n-----BEGIN RSA PRIVATE KEY-----\nAAAA (truncated", "a\n[已脱敏]", 1),
        ("-----BEGIN CERTIFICATE-----\nMIIB\n", "-----BEGIN CERTIFICATE-----\nMIIB\n", 0),
    ];
    for (input, want, n) in cases {
        assert_eq!(redact(input), (want.to_string(), n), "{input:?}");
    }
}

#[test]
fn redact_leaves_ordinary_output_alone() {
    for s in [
        "GET /index.html 200 user=bob",
        "PWD=/root OLDPWD=/tmp",
        "password=",
        "password=${DB_PASS}",
        "password: ********",
        "task-abcdefghijklmnopqrstuvwxyz0123",
        "2026-10-14T10:30:00 nginx: upstream timed out",
    ] {
        assert_eq!(redact(s), (s.to_string(), 0), "{s:?}");
    }
}

#[test]
fn shell_quote_escapes_single_quotes() {
    assert_eq!(shell_quote("it's"), "'it'\\''s'");
    assert_eq!(shell_quote("a b"), "'a b'");
}

#[test]
fn preview_builds_read_only_commands() {
    let awk_count = r#"awk 'NR<=200{print} END{print "共 " NR " 项"}'"#;
    let cases: [(&str, Option<String>); 10] = [
        (
            "rm -rf /var/log/app/*.gz",
            Some("ls -ld -- /var/log/app/*.gz 2>&1 | head -n 200; du -sch -- /var/log/app/*.gz 2>/dev/null | tail -n 1".into()),
        ),
        (
            "sudo rm -f '/srv/a b.txt'",
            Some("ls -ld -- '/srv/a b.txt' 2>&1 | head -n 200; du -sch -- '/srv/a b.txt' 2>/dev/null | tail -n 1".into()),
        ),
        (
            "find /var/log/app -name '*.gz' -mtime +7 -delete",
            Some(format!("find /var/log/app -name '*.gz' -mtime +7 -print 2>/dev/null | {awk_count}")),
        ),
        (
            "find . -name '*.tmp' -exec rm {} \\;",
            Some(format!("find . -name '*.tmp' -print 2>/dev/null | {awk_count}")),
        ),
        (
            "chmod -R 755 /srv",
            Some(r#"find '/srv' 2>/dev/null | awk 'END{print "共 " NR " 项"}'"#.into()),
        ),
        (
            "cd /var/log/app && rm -rf old",
            Some("cd -- '/var/log/app' && ls -ld -- 'old' 2>&1 | head -n 200; du -sch -- 'old' 2>/dev/null | tail -n 1".into()),
        ),
        ("find . -exec chmod 600 {} \\;", None),
        ("rm -rf $(cat list)", None),
        ("rm x > /tmp/log", None),
        ("ls -la", None),
    ];
    for (cmd, want) in cases {
        assert_eq!(preview_command(cmd), want, "{cmd:?}");
    }
}
