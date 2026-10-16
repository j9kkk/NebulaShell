//! 第 3 步高危子集授权：静态目标采集、授权前提、远端事实解析与模拟输出解析。

use super::grant::*;
use super::*;

fn ctx(cwd: &str) -> GuardCtx<'_> {
    GuardCtx {
        os_known: true,
        is_root: false,
        tainted: &[],
        cwd,
    }
}

fn file(class: &'static str, path: &str) -> GrantTarget {
    GrantTarget::File {
        class,
        path: path.to_string(),
    }
}

fn allow(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(r, k)| (r.to_string(), k.to_string()))
        .collect()
}

fn facts(targets: Vec<TargetFact>) -> Facts {
    Facts {
        home: Some("/home/u".into()),
        targets,
        ..Default::default()
    }
}

fn proc_(pid: u32, ppid: u32, uid: u32, comm: &str) -> Proc {
    Proc {
        pid,
        ppid,
        uid,
        comm: comm.into(),
    }
}

const ME: Who = Who {
    uid: Some(1000),
    as_root: false,
};

#[test]
fn file_targets_are_collected_with_cwd() {
    let v = classify("sed -i.bak 's/80/8080/' conf/app.conf", &ctx("/srv/app"));
    assert_eq!(v.grant_targets, [file(G_MODIFY, "/srv/app/conf/app.conf")]);
    assert!(candidate(&v));

    let v = classify("sed -i -e s/a/b/ -e s/c/d/ a.txt b.txt", &ctx("/srv"));
    assert_eq!(
        v.grant_targets,
        [file(G_MODIFY, "/srv/a.txt"), file(G_MODIFY, "/srv/b.txt")],
        "-e 给出脚本时位置参数全是文件"
    );
    let v = classify("sed -ie 's/a/b/' f", &ctx("/srv"));
    assert_eq!(
        v.grant_targets,
        [file(G_MODIFY, "/srv/f")],
        "-ie 的 e 是备份后缀"
    );

    let v = classify("cd /srv/app && rm -f old.log new.tmp", &ctx("/home/u"));
    assert_eq!(
        v.grant_targets,
        [
            file(G_DELETE, "/srv/app/old.log"),
            file(G_DELETE, "/srv/app/new.tmp")
        ]
    );
    assert!(candidate(&v));

    for (cmd, why) in [
        ("sed -i 's/a/b/' *.conf", B_TARGET),
        ("rm *.log", B_TARGET),
        ("rm \"$F\"", B_TARGET),
        ("shred -u secret.txt", B_WIPE),
        ("find . -name '*.tmp' | xargs rm", B_TARGET),
        ("rsync -a --delete src/ dst/", B_TARGET),
        ("cd \"$D\" && rm x", B_CWD),
        ("cd - && rm x", B_CWD),
        ("(cd /srv; rm a); rm b", B_CWD),
        ("env -C /srv rm a", B_CWD),
        ("sudo -D /srv rm a", B_CWD),
        ("chroot /mnt rm a", B_CWD),
        ("if true; then rm a; fi", B_FLOW),
    ] {
        let v = classify(cmd, &ctx("/home/u"));
        assert_eq!(v.allow_block.as_deref(), Some(why), "{cmd}");
        assert!(!candidate(&v), "{cmd}");
    }
    assert!(
        !candidate(&classify("rm -rf /srv/app/tmp", &ctx("/"))),
        "递归删除是 L0"
    );
}

#[test]
fn writes_resolve_against_cwd() {
    let v = classify("cd /etc && echo x > sudoers", &ctx("/home/u"));
    assert!(
        v.reasons.iter().any(|r| r == R_SENSITIVE_WRITE),
        "相对路径写入敏感位置"
    );
    let v = classify("echo x > out.txt", &ctx("/srv/app"));
    assert_eq!(v.redirect_targets, ["/srv/app/out.txt"]);
}

#[test]
fn copy_into_directory_is_expanded_remotely() {
    let v = classify("cp a.conf /srv/app/", &ctx("/home/u"));
    assert_eq!(
        v.copy_dests,
        [CopyDest {
            dest: "/srv/app".into(),
            srcs: vec![Some(("/home/u/a.conf".into(), false))],
            recursive: false,
        }]
    );
    let v = classify("cp -t /srv/app a b", &ctx("/home/u"));
    assert_eq!(v.copy_dests[0].dest, "/srv/app");
    assert_eq!(v.copy_dests[0].srcs.len(), 2);
    assert!(v.redirect_targets.is_empty(), "-t 的目录本身不算覆盖目标");
    let v = classify("cp -rt /srv/app src", &ctx("/home/u"));
    assert!(v.copy_dests[0].recursive);
    assert_eq!(v.copy_dests[0].dest, "/srv/app");
    let v = classify("cp *.conf /srv/app/", &ctx("/home/u"));
    assert_eq!(
        v.copy_dests[0].srcs,
        [Some(("/home/u/*.conf".into(), true))]
    );
    let v = classify("cp \"$X\" /srv/app/", &ctx("/home/u"));
    assert_eq!(v.copy_dests[0].srcs, [None]);
    assert!(classify("cp -T a /srv/app", &ctx("/"))
        .copy_dests
        .is_empty());

    let s = overwrite_script(
        "/srv",
        &["/srv/a b".into()],
        &classify("cp x *.conf /srv/app/", &ctx("/srv")).copy_dests,
    );
    assert!(s.contains("[ -f \"$f\" ]") && s.contains("'/srv/a b'"));
    assert!(s.contains("for s in '/srv/x' /srv/*.conf;"), "{s}");
}

#[test]
fn kill_targets_only_for_plain_forms() {
    let v = classify("kill -9 1234 5678", &ctx("/"));
    assert_eq!(
        v.grant_targets,
        [GrantTarget::Kill(KillSel::Pids(vec![1234, 5678]))]
    );
    let v = classify("pkill -x nginx", &ctx("/"));
    assert_eq!(
        v.grant_targets,
        [GrantTarget::Kill(KillSel::Name {
            pattern: "nginx".into(),
            exact: true
        })]
    );
    let v = classify("killall -9 php-fpm node", &ctx("/"));
    assert_eq!(v.grant_targets.len(), 2);
    for cmd in [
        "kill -9 -1",
        "kill %1",
        "kill 0",
        "kill -- -4321",
        "pkill -f 'python app.py'",
        "pkill -U alice",
        "pkill -u alice",
        "pkill 'node.*'",
        "killall -r 'php.*'",
        "killall5",
        "docker kill web",
    ] {
        let v = classify(cmd, &ctx("/"));
        assert!(v.reasons.iter().any(|r| r == R_KILL), "{cmd}");
        assert!(v.allow_block.is_some() && !candidate(&v), "{cmd}");
    }
    for cmd in [
        "pkill sshd",
        "killall sshd",
        "pkill ssh",
        "pkill -x sshd-session",
    ] {
        let v = classify(cmd, &ctx("/"));
        assert!(
            v.reasons.iter().any(|r| r == R_DISCONNECT),
            "{cmd} 等同切断 SSH"
        );
        assert!(!candidate(&v), "{cmd}");
    }
}

#[test]
fn uninstall_targets_only_for_plain_remove() {
    let v = classify("sudo apt-get remove -y nginx", &ctx("/"));
    assert!(v.as_root);
    assert_eq!(
        v.grant_targets,
        [GrantTarget::Pkg {
            mgr: PkgMgr::Apt,
            pkgs: vec!["nginx".into()]
        }]
    );
    assert!(candidate(&v), "提权不单独阻止授权");
    for (cmd, mgr) in [
        ("dnf remove -y httpd", PkgMgr::Dnf),
        ("yum erase httpd", PkgMgr::Yum),
        ("pacman -R --noconfirm vim", PkgMgr::Pacman),
        ("dpkg -r nginx", PkgMgr::Dpkg),
        ("rpm -e nginx", PkgMgr::Rpm),
        ("snap remove lxd", PkgMgr::Snap),
        ("flatpak uninstall -y org.gimp.GIMP", PkgMgr::Flatpak),
        ("pip3 uninstall -y requests", PkgMgr::Pip),
    ] {
        let v = classify(cmd, &ctx("/"));
        assert!(
            matches!(&v.grant_targets[..], [GrantTarget::Pkg { mgr: m, .. }] if *m == mgr),
            "{cmd}: {:?}",
            v.grant_targets
        );
    }
    for (cmd, why) in [
        ("apt purge nginx", B_PKG_MODE),
        ("apt-get remove --purge nginx", B_PKG_MODE),
        ("apt-get autoremove", B_PKG_MODE),
        ("apt remove 'nginx*'", B_PKG_MODE),
        ("apt remove nginx=1.18.0", B_PKG_MODE),
        (
            "apt-get -o Dpkg::Options::=--force-all remove nginx",
            B_PKG_MODE,
        ),
        ("pacman -Rs vim", B_PKG_MODE),
        ("dpkg -P nginx", B_PKG_MODE),
        ("rpm -e --nodeps nginx", B_PKG_MODE),
        ("pip uninstall -r req.txt", B_PKG_MODE),
        ("/tmp/x/apt-get remove nginx", B_PKG_MGR),
        ("./apt-get remove nginx", B_PKG_MGR),
        ("zypper rm nginx", B_PKG_MGR),
        ("apk del nginx", B_PKG_MGR),
        ("aptitude remove nginx", B_PKG_MGR),
    ] {
        let v = classify(cmd, &ctx("/"));
        assert!(v.reasons.iter().any(|r| r == R_UNINSTALL), "{cmd}");
        assert_eq!(v.allow_block.as_deref(), Some(why), "{cmd}");
    }
}

#[test]
fn file_grants_by_real_directory_prefix() {
    let mut v = classify("sed -i.bak s/a/b/ /srv/app/conf/a.conf", &ctx("/"));
    let f = facts(vec![TargetFact::Dir("/srv/app/conf".into())]);
    let items = evaluate(&v, &f, &[], ME).expect("可授权");
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].rule, items[0].label), (G_MODIFY, "修改文件"));
    assert_eq!(items[0].keys, ["/srv/app/conf/"]);
    assert!(covered(&items, &allow(&[(G_MODIFY, "/srv/app/conf/")])));
    assert!(
        covered(&items, &allow(&[(G_MODIFY, "/srv/app/")])),
        "上级目录前缀覆盖子目录"
    );
    assert!(!covered(&items, &allow(&[(G_MODIFY, "/srv/app/con")])));
    assert!(!covered(&items, &allow(&[(G_MODIFY, "/srv/application/")])));
    assert!(
        !covered(&items, &allow(&[(G_DELETE, "/srv/app/conf/")])),
        "删除授权不顶替修改"
    );

    // 符号链接把写入引到授权目录外：按真实目录记账，链接本身直接不可授权。
    let link = facts(vec![TargetFact::Link]);
    assert_eq!(
        evaluate(&v, &link, &[], ME),
        Err(Some("目标是符号链接".into()))
    );
    let elsewhere = facts(vec![TargetFact::Dir("/etc/ssh".into())]);
    assert_eq!(
        evaluate(&v, &elsewhere, &[], ME),
        Err(Some("目标在敏感位置".into()))
    );
    assert!(evaluate(&v, &facts(vec![TargetFact::Missing]), &[], ME).is_err());

    for dir in ["/", "/srv", "/home/u", "/root"] {
        let r = evaluate(&v, &facts(vec![TargetFact::Dir(dir.into())]), &[], ME);
        assert!(
            matches!(&r, Err(Some(e)) if e.starts_with("目录范围过宽")),
            "{dir}: {r:?}"
        );
    }
    let bin = facts(vec![TargetFact::Dir("/usr/local/bin".into())]);
    assert_eq!(
        evaluate(&v, &bin, &[], ME),
        Err(Some("目标在可执行目录".into()))
    );
    let tainted = ["/srv/app/conf/a.conf".to_string()];
    assert_eq!(
        evaluate(&v, &f, &tainted, ME),
        Err(Some("目标是本会话下载的文件".into()))
    );

    // 远端补判出的「覆盖已有文件」随目标登记；混入下载时两类都要授权。
    v = classify("curl -o /srv/app/a.bin https://a.io/a", &ctx("/"));
    v.add_targets(
        Tier::Danger,
        &format!("{R_OVERWRITE_EXISTING}：/srv/app/a.bin"),
        [file(G_MODIFY, "/srv/app/a.bin")],
    );
    let items = evaluate(
        &v,
        &facts(vec![TargetFact::Dir("/srv/app".into())]),
        &[],
        ME,
    )
    .unwrap();
    assert_eq!(
        items.iter().map(|a| a.rule).collect::<Vec<_>>(),
        [G_DOWNLOAD, G_MODIFY]
    );
    assert!(!covered(&items, &allow(&[(G_DOWNLOAD, "a.io")])));
    assert!(covered(
        &items,
        &allow(&[(G_DOWNLOAD, "A.io"), (G_MODIFY, "/srv/app/")])
    ));
    // 不带目标直接升档（看不清目标）：整条命令不可授权。
    v.add(Tier::Danger, R_DELETE);
    assert_eq!(
        evaluate(&v, &Facts::default(), &[], ME),
        Err(Some(B_TARGET.into()))
    );
}

#[test]
fn kill_grants_need_resolved_unprotected_processes() {
    let v = classify("kill 2001 2002", &ctx("/"));
    let mut f = facts(vec![TargetFact::Missing]);
    f.procs = vec![
        proc_(1, 0, 0, "/sbin/init"),
        proc_(900, 1, 0, "sshd"),
        proc_(901, 900, 1000, "bash"),
        proc_(2001, 901, 1000, "node"),
        proc_(2002, 901, 1000, "/usr/bin/node"),
        proc_(3001, 1, 1001, "node"),
    ];
    let items = evaluate(&v, &f, &[], ME).unwrap();
    assert_eq!(
        (items[0].rule, items[0].keys.clone()),
        (G_KILL, vec!["node".to_string()])
    );
    assert!(covered(&items, &allow(&[(G_KILL, "node")])));
    assert!(!covered(&items, &allow(&[(G_KILL, "nod")])));
    assert_eq!(
        kill_preview(&v, &f),
        [(2001, "node".into()), (2002, "node".into())]
    );

    let other = classify("kill 3001", &ctx("/"));
    assert!(matches!(evaluate(&other, &f, &[], ME), Err(Some(e)) if e.contains("其他用户")));
    let root = Who {
        uid: Some(0),
        as_root: true,
    };
    assert!(
        evaluate(&other, &f, &[], root).is_ok(),
        "以 root 执行不限属主"
    );
    for (cmd, needle) in [
        ("kill 1", "PID 1"),
        ("kill 900", "sshd"),
        ("kill 901", "SSH 会话"),
        ("kill 4444", "不存在"),
    ] {
        let r = evaluate(&classify(cmd, &ctx("/")), &f, &[], root);
        assert!(
            matches!(&r, Err(Some(e)) if e.contains(needle)),
            "{cmd}: {r:?}"
        );
    }

    let byname = classify("pkill -x node", &ctx("/"));
    let mut g = f.clone();
    g.targets = vec![TargetFact::Pids(vec![2001, 2002])];
    assert!(evaluate(&byname, &g, &[], ME).is_ok());
    g.targets = vec![TargetFact::Pids(vec![])];
    assert_eq!(
        evaluate(&byname, &g, &[], ME),
        Err(Some("没有匹配的进程".into()))
    );
    g.targets = vec![TargetFact::Pids((5000..5021).collect())];
    assert!(matches!(evaluate(&byname, &g, &[], ME), Err(Some(e)) if e.contains("超过")));
    assert!(
        evaluate(&byname, &Facts::default(), &[], ME).is_err(),
        "复核失败按不可授权"
    );
}

const APT_OK: &str = "NOTE: This is only a simulation!\n      apt-get needs root privileges for real execution.\nReading package lists...\nThe following packages will be REMOVED:\n  nginx\n0 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.\nRemv nginx [1.18.0-6ubuntu14.4]\n";
const APT_CASCADE: &str = "The following packages will be REMOVED:\n  libnginx-mod-http-geoip2 nginx nginx-core\nRemv nginx [1.18.0]\nRemv nginx-core:amd64 [1.18.0]\nRemv libnginx-mod-http-geoip2 [1.18.0]\n";
const DNF_OK: &str = "Dependencies resolved.\n================================================================================\n Package          Architecture   Version              Repository          Size\n================================================================================\nRemoving:\n httpd            x86_64         2.4.57-5.el9         @appstream         59 k\n\nTransaction Summary\n================================================================================\nRemove  1 Package\n\nFreed space: 59 k\nOperation aborted.\n";
const DNF_CASCADE: &str = "Removing:\n httpd            x86_64   2.4.57-5.el9   @appstream   59 k\nRemoving dependent packages:\n mod_ssl          x86_64   1:2.4.57-5.el9 @appstream  267 k\nRemoving unused dependencies:\n httpd-core       x86_64   2.4.57-5.el9   @appstream  4.7 M\n\nTransaction Summary\n";
const YUM_DEPS: &str = "Removing:\n httpd        x86_64   2.4.6-99.el7   @updates   9.4 M\nRemoving for dependencies:\n mod_ssl      x86_64   1:2.4.6-99.el7 @updates   224 k\n\nTransaction Summary\n";

#[test]
fn simulation_output_parsing() {
    assert_eq!(parse_apt_sim(APT_OK).unwrap(), ["nginx"]);
    assert_eq!(
        parse_apt_sim(APT_CASCADE).unwrap(),
        ["nginx", "nginx-core", "libnginx-mod-http-geoip2"]
    );
    assert!(parse_apt_sim("E: Unable to locate package nginxx\n").is_err());
    assert!(parse_apt_sim(
        "WARNING: The following essential packages will be removed.\nRemv bash [5]\n"
    )
    .is_err());
    assert!(parse_apt_sim("Package 'x' is not installed, so not removed\n").is_err());
    assert_eq!(parse_dnf_sim(DNF_OK).unwrap(), ["httpd"]);
    assert_eq!(
        parse_dnf_sim(DNF_CASCADE).unwrap(),
        ["httpd", "mod_ssl", "httpd-core"]
    );
    assert_eq!(parse_dnf_sim(YUM_DEPS).unwrap(), ["httpd", "mod_ssl"]);
    assert!(
        parse_dnf_sim("Error: This command has to be run with superuser privileges.\n").is_err()
    );
    assert!(parse_dnf_sim(
        "No match for argument: httpdx\nError: No packages marked for removal.\n"
    )
    .is_err());
}

#[test]
fn uninstall_grants_refuse_cascades_and_core_packages() {
    let v = classify("apt-get remove -y nginx", &ctx("/"));
    let ok = facts(vec![TargetFact::Sim(APT_OK.into())]);
    let items = evaluate(&v, &ok, &[], ME).unwrap();
    assert_eq!((items[0].rule, items[0].label), (G_UNINSTALL, "卸载"));
    assert_eq!(items[0].keys, ["nginx"]);
    assert!(covered(&items, &allow(&[(G_UNINSTALL, "nginx")])));
    let cascade = facts(vec![TargetFact::Sim(APT_CASCADE.into())]);
    assert!(
        matches!(evaluate(&v, &cascade, &[], ME), Err(Some(e)) if e.starts_with("会连带卸载") && e.contains("nginx-core"))
    );
    assert_eq!(pkg_preview(&v, &cascade).len(), 3);
    assert!(
        evaluate(&v, &facts(vec![TargetFact::Missing]), &[], ME).is_err(),
        "模拟失败不可授权"
    );

    let dnf = classify("dnf remove -y httpd", &ctx("/"));
    assert!(evaluate(&dnf, &facts(vec![TargetFact::Sim(DNF_OK.into())]), &[], ME).is_ok());
    assert!(evaluate(
        &dnf,
        &facts(vec![TargetFact::Sim(DNF_CASCADE.into())]),
        &[],
        ME
    )
    .is_err());

    for cmd in [
        "apt-get remove -y openssh-server",
        "pip uninstall -y pip",
        "dpkg -r linux-image-6.8.0-45-generic",
        "rpm -e systemd",
    ] {
        let v = classify(cmd, &ctx("/"));
        let sim = format!("Remv {} [1]\n", cmd.rsplit(' ').next().unwrap());
        let r = evaluate(&v, &facts(vec![TargetFact::Sim(sim)]), &[], ME);
        assert!(
            matches!(&r, Err(Some(e)) if e.starts_with("关键软件包")),
            "{cmd}: {r:?}"
        );
    }
    let pip = classify("pip3 uninstall -y requests", &ctx("/"));
    assert_eq!(
        evaluate(&pip, &facts(vec![TargetFact::Missing]), &[], ME).unwrap()[0].keys,
        ["requests"],
        "pip 不连带，无需模拟"
    );
}

#[test]
fn facts_script_and_parsing() {
    let targets = vec![
        file(G_MODIFY, "/srv/it's here/a.conf"),
        file(G_DELETE, "~/logs/x.log"),
        GrantTarget::Kill(KillSel::Name {
            pattern: "node".into(),
            exact: true,
        }),
        GrantTarget::Pkg {
            mgr: PkgMgr::Apt,
            pkgs: vec!["nginx".into()],
        },
    ];
    let s = facts_script("/srv", &targets);
    assert!(
        s.starts_with("PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH\n"),
        "复核不走用户 PATH"
    );
    assert!(s.contains("'/srv/it'\\''s here/a.conf'"), "{s}");
    assert!(s.contains("[ -L ~/'logs/x.log' ]"), "{s}");
    assert!(s.contains("pgrep -x -- 'node'"));
    assert!(s.contains("LC_ALL=C apt-get -s remove 'nginx'"));
    assert!(s.contains("ps -A -o pid= -o ppid= -o uid= -o comm="));
    assert!(s.contains("A=\"$A,$p\""), "按名字命中的 PID 也要取命令行");
    assert!(s.contains("ps -o pid= -o args= -p \"$A\""));
    let by_pid = facts_script("", &[GrantTarget::Kill(KillSel::Pids(vec![12, 34]))]);
    assert!(by_pid.contains("A=\"$A,12,34\""), "{by_pid}");

    let out = "@@HOME /home/u\n@@T 0 D /srv/it's here\n@@T 1 L\n@@T 2 P 2001 2002\n@@T 3 S\nReading package lists...\nRemv nginx [1.18]\n\n@@E 3\n@@PS\n    1     0     0 /sbin/init\n 2001   901  1000 node\n 2002   901  1000 Google Chrome Helper\n@@PSEND\n@@ARGS\n 2001 node /srv/app/server.js --port 3000\n 2002 /Applications/Google Chrome.app/Helper --type=gpu\n@@ARGSEND\n";
    let f = parse_facts(out, 4);
    assert_eq!(
        f.args,
        [
            (2001, "node /srv/app/server.js --port 3000".to_string()),
            (
                2002,
                "/Applications/Google Chrome.app/Helper --type=gpu".to_string()
            )
        ]
    );
    let v = classify("pkill -x node", &ctx("/"));
    let mut g = f.clone();
    g.targets = vec![TargetFact::Pids(vec![2001])];
    assert_eq!(
        kill_snapshot(&v, &g),
        [(
            2001,
            "node".to_string(),
            Some(1000),
            "node /srv/app/server.js --port 3000".to_string()
        )]
    );
    assert_eq!(f.home.as_deref(), Some("/home/u"));
    assert_eq!(f.targets[0], TargetFact::Dir("/srv/it's here".into()));
    assert_eq!(f.targets[1], TargetFact::Link);
    assert_eq!(f.targets[2], TargetFact::Pids(vec![2001, 2002]));
    assert!(matches!(&f.targets[3], TargetFact::Sim(s) if s.contains("Remv nginx")));
    assert_eq!(f.procs.len(), 3);
    assert_eq!(f.procs[2].comm, "Google Chrome Helper");
    let partial = parse_facts("@@T 0 X\n@@T 9 L\n", 2);
    assert_eq!(partial.targets, [TargetFact::Missing, TargetFact::Missing]);
    assert!(partial.home.is_none());
}
