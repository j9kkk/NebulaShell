# vendored russh-sftp 2.4.0

为什么 vendor:russh-sftp 2.4.0 的 `read_dir` 逐批"发送 READDIR → 等响应",
大目录(OpenSSH 每批 ≤100 条)的列目录延迟 = 批数 × RTT;而其 `RawSftpSession::send`
是私有方法,外部无法自行流水线化。这里给 vendored 副本打补丁:

- `src/client/rawsession.rs`:新增 `readdir_windowed` —— 同 handle 至多 `window`
  笔 READDIR 在途(协议允许并发未应答请求,按 id 配对),按请求顺序收割;
  首个 EOF 停发,在途请求按协议再次返回 EOF,照常收割丢弃。
- `src/client/session.rs`:`read_dir` 改调上述方法,`READDIR_WINDOW = 8`。

受影响面:`sftp::list`、目录/批量下载(`download_tree`)、跨主机复制引擎的
目录枚举全部经由 `SftpSession::read_dir`,自动加速。除列目录外与上游 2.4.0
无任何差异;`Cargo.toml` 仅删除了 vendored 时不需要的 `[[example]]`/`[[bench]]` 段。

退出条件:流水线 READDIR 已作为上游 PR 提交(见仓库 issue/PR 记录),上游合并
发布后,删除 `[patch.crates-io]` 段与本目录即可。
