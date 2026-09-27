# Tauri 2 全量改造报告

日期:2026-09-26 · 状态:完成(端到端验证通过)

## 一、改造范围

按"Tauri 2 全量改造"执行:**Rust 重写后端 + 复用全部前端**。前端(HTML/CSS/app.js,xterm.js 终端)
与测试资产 100% 保留,通过 `app/src/renderer/nebula-shim.js` 把 `window.nebula` 的 IPC 契约
(原 Electron preload 提供的 `invoke`/`on`)适配到 Tauri 命令通道,前端零改动。

## 二、技术栈对照

| 层 | Electron 版 | Tauri 版 |
| --- | --- | --- |
| 壳 | Electron 33(Chromium+Node) | Tauri 2(系统 WebView) |
| SSH | ssh2(JS 协议 + OpenSSL 原生加密) | russh 0.46(纯 Rust,含跳板链/端口转发) |
| SFTP | ssh2 sftp 子系统 | russh-sftp 2.4 |
| HTTP | Node fetch/undici | reqwest + rustls |
| 凭据加密 | safeStorage | keyring(macOS Keychain),不可用时 base64 回退 |
| 文件对话框 | Electron dialog | rfd |
| 存储 | JSON + safeStorage | JSON + keyring,格式与原版同构 |

## 三、后端模块(全部 Rust,src-tauri/src/)

- `config.rs` 配置存储:主机 CRUD/克隆/导入导出/云幂等/凭据留空语义/设置校验
- `ssh.rs` SSH 服务:密码/私钥/键盘交互认证、TOFU 指纹、跳板链(逐级 forwardOut)、
  shell 数据泵(resize/write 经 mpsc 进泵循环)、exec、direct-tcpip、远程转发监听
- `sftp.rs` 列目录/建目录/删除/重命名/权限/上传/下载(带进度 emit)
- `forward.rs` 端口转发:本地(L)/远程(R)/动态 SOCKS5(D)
- `monitor.rs` /proc 采集解析(CPU/内存/网络/磁盘差分)
- `ai.rs` AI 流式对话(OpenAI 兼容 + Anthropic 双协议)+ /models 发现
- `cloud.rs` + `signing.rs` 腾讯云 TC3-HMAC-SHA256、阿里云 RPC V1(HMAC-SHA1)
- `commands.rs` IPC 分发:`{channel, payload}` → `{ok, data|error}` 信封(与 Electron 契约一致)
- `bridge.rs` NEBULA_TEST 测试桥(评估用,见下)
- `plugins.rs` 扩展点注册表(L4 架构预留,与 Electron 版一致)

## 四、验证

**Rust 测试 21 项全绿**
- `cargo test`(20 单测):云厂商签名用官方文档向量(TC3 payload/canonical/最终签名、
  阿里云 canonical/StringToSign/Signature)、/proc 解析(差分/降级/磁盘)、存储
  (CRUD/留空保持/克隆/幂等/导入导出/指纹)
- `cargo test --test integration`(1 集成,真实协议):拉起 node mock sshd,验证
  密码认证连接 → exec 回包与退出码 → resize(window-change)→ 错误密码拒绝 →
  SFTP 列目录/上传/下载(内容一致)/删除

**Electron 版回归 51 项全绿**:unit 28 + services 12 + UI e2e 全流程 —— 前端与测试资产
未被改造破坏,两条技术栈并存。

## 五、量化收益(实测)

| 指标 | Electron 版 | Tauri 版 | 变化 |
| --- | --- | --- | --- |
| .app 体积 | 248 MB | **9.7 MB** | **↓96%(实测成立)** |
| 运行时内存(含渲染引擎) | 218 MB(4 进程) | **223 MB(4 进程)** | ≈ 持平 |
| 主进程/可执行 | — | 8.7 MB | — |

**体积构成**:9.7 MB = 可执行文件 8.7 MB + 资源 1.0 MB。`otool -L` 确认动态链接系统的
`/System/Library/Frameworks/WebKit.framework`,包内无 Chromium/blink 二进制 —— 这是体积收益的来源。

**内存为何没有变少**:Tauri 不打包浏览器引擎,但**运行时会启动系统 WebKit**,其子进程与 Electron 的
Chromium 子进程量级相当。实测(启动前后差分法):

| 进程 | Tauri 版 |
| --- | --- |
| nebulashell(Rust 主进程) | 106.5 MB |
| WebKit GPU 子进程 | 40.3 MB |
| WebKit Networking 子进程 | 15.7 MB |
| WebKit WebContent 子进程(渲染引擎) | 60.7 MB |
| **合计** | **223.2 MB** |

> ⚠️ 早期版本的本文档曾记录"内存 218MB → 71MB(↓67%)",那是**测量错误**:只统计了进程名含
> `nebulashell` 的进程,漏掉了由系统 WebKit 启动、进程名不含该关键字的三个 XPC 子进程。
> 正确结论是**体积大幅下降、内存基本持平**。测量方法:启动前后各取一次 `ps -Ao pid,rss,comm`
> 快照并做差分(避免把系统中其他应用的 WebKit 进程算进来)。

## 六、已知限制与后续

1. **测试桥**:`NEBULA_TEST=1` 时启动本地 HTTP 桥用于自动化;macOS WKWebView 下
   `fetch`/IPC 回传受 ATS 与权限模型限制,当前走 URL-hash 轮询方案,仅用于诊断。
   **UI 级自动化仍以 Electron 版 e2e 为准**(Electron 保留完整可测性)。
2. **打包分发**:Tauri 版已可 `npx tauri build` 出 dmg;签名/公证(notarization)未做。
3. **未覆盖**:WebView2(Windows)/Linux 未实测;runtime 侧 dialog/keyring 仅在 macOS 验证。
4. 两栈并存期建议:Electron 版作为**功能主干与测试基线**,Tauri 版作为**分发形态**,
   待 Tauri 版补全 UI 自动化后切换主干。
