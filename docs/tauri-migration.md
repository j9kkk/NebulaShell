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

## 六、运行时内存优化(2026-09-27)

### 6.1 先纠正测量口径:RSS 会高估约 2 倍

此前用 `ps` 的 RSS 统计,会把各进程共享的只读系统库页(WebKit、系统框架)重复计入。
用 `vmmap -summary` 的 **physical footprint**(去重后真实占用)重测 release 版冷启动:

| 进程 | Physical footprint | RSS |
| --- | --- | --- |
| nebulashell(Rust 主进程) | 24.7 MB | 96.6 MB |
| WebKit WebContent | 37.6 MB | 51.3 MB |
| WebKit GPU | 15.5 MB | 32.7 MB |
| WebKit Networking | 6.3 MB | 12.8 MB |
| **合计** | **84.1 MB** | **188.4 MB** |

> 做优化对比时应统一用 footprint,否则改进会被共享页噪声淹没。

### 6.2 已修复的资源泄漏(附实测)

| 问题 | 根因 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 重连泄漏 SSH 连接 | `sessions.insert` 覆盖旧会话,而 russh 的 `Handle::drop` 只打日志、不关连接 | 重连 3 次 → 服务端 4 条连接 / 4 个 shell 通道(20 次重连 fd 64→96) | 恒定 1 条 |
| 监控任务累积 | `monitors.insert` 覆盖旧 `JoinHandle`,而 tokio 的 `JoinHandle::drop` 只解绑、不 abort | 重连 3 次后探测速率 4 倍(12 次/9s) | 1 倍(≤6 次/9s) |
| 远端断开后会话残留 | 数据泵收到 `Close` 只 break,不从 `sessions` 移除 | 连接永久留存 | 自动回收 |
| 多字节 UTF-8 跨包损坏 | 对每条 `ChannelMsg` 独立 `from_utf8_lossy` | `中` 被切成 `��` | 增量解码,完整还原 |

修复要点:连接/会话引入**代际 token**,覆盖与自回收都校验"我是否仍是当前主人",
避免旧数据泵误删新会话;并新增 `shut_down_session` 显式断开(不依赖 drop 语义)。

### 6.3 其他内存优化

| 项 | 措施 | 实测效果 |
| --- | --- | --- |
| 终端回滚缓冲 | 默认 5000→2000 行,上限 50000→20000;改为运行时即时生效 | 缓冲 5045→1045 行,WebContent −9 MB |
| russh 通道窗口 | 2 MB→512 KB(该值按"连接数 × 通道数"占用内存) | 每通道接收缓冲 ↓75% |
| SFTP 通道 | 按 sessionId 缓存复用(原先每次操作都重开通道 + 子系统协商) | 5 次操作 5 条通道 → 1 条 |
| 终端数据泵 | 合帧:同一 tick 的多块数据合并为单个事件 | 降低 IPC 调用与前端 GC 压力 |
| 命令历史落盘 | 每敲一条命令全量重写配置 → 脏位 + 2s 去抖(退出时 flush) | 写盘从"每命令"降到"至多每 2s 一次" |
| AI 上下文/消息区 | `aiHistory` 限 20 轮、`#ai-messages` DOM 限 200 条 | 长会话不再无界增长 |

> 补充实测:单会话固定成本约 **5.3 MB**(4 分屏会话 21.4 MB);
> 灌入 150 MB 输出时 WebContent 峰值 140.7 MB、静置回落 111 MB —— **数据通路本身无界增长**。

### 6.4 顺手修复的阻塞性缺陷(此前 UI e2e 从未跑通)

1. **测试桥不认 chunked 请求体**:Node 的 http 客户端默认用 `Transfer-Encoding: chunked`,
   而桥只解析 `Content-Length` → 读到空 body,`/eval` 永不执行。
2. **eval 契约不一致**:桥把注入 JS 当**函数体**执行,而 e2e 用 devtools 式的
   "最后一条表达式即结果"写法 → 全部返回 `undefined`。现同时支持两种写法。
3. **SFTP 未套统一信封**:`sftp:*` 直接返回裸数据,前端 `api()` 要求 `{ok:true,data}` →
   文件面板所有操作被判失败(报"调用失败")。

修完后 `npm run test:web` 从 **0/12** 变为 **12/12 通过**。

## 七、已知限制与后续

1. **UI 自动化**:Tauri 版 e2e(`e2e/ui.e2e.mjs`,走 `NEBULA_TEST=1` 本地 HTTP 桥)**已可用**
   (12/12);macOS WKWebView 仍无 WebDriver,ATS 限制见上文 6.4。
2. **打包分发**:Tauri 版已可 `npx tauri build` 出 dmg;签名/公证(notarization)未做。
3. **未覆盖**:WebView2(Windows)/Linux 未实测;runtime 侧 dialog/keyring 仅在 macOS 验证。
4. **测试体系**:`npm test` = Rust(`cargo test`)+ UI e2e(12 步)。其中
   `src-tauri/tests/resource_lifecycle.rs`、`monitor_lifecycle.rs` 与 `ssh.rs::utf8_test`
   专门回归连接/通道/监控任务泄漏与 UTF-8 跨包损坏。

