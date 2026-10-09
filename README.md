<div align="center">

# NebulaShell 星云终端

**跨平台 SSH 客户端 · 内置 AI 助手 · 云主机自动发现**

[![CI](https://github.com/j9kkk/NebulaShell/actions/workflows/ci.yml/badge.svg)](https://github.com/j9kkk/NebulaShell/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/j9kkk/NebulaShell?include_prereleases)](https://github.com/j9kkk/NebulaShell/releases)
[![License](https://img.shields.io/github/license/j9kkk/NebulaShell)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.80%2B-orange)](https://www.rust-lang.org/)

</div>

基于 **Tauri 2 + Rust** 构建的现代 SSH 客户端。安装包仅 **9.7 MB**，无 Electron/Chromium 运行时依赖，
使用系统 WebView 渲染，启动快、分发轻。

---

## ✨ 功能特性

### 终端与多会话
- **分屏**：按窗口尺寸自动布局、拖拽调宽、单窗格放大（⌘D / ⌘⇧↵），窗口尺寸变化自动同步远端 PTY
- **多标签**：多会话并行，⌘1..9 快速切换，标签自动滚动定位
- **广播输入**：一条命令同步下发到多个会话
- **终端能力**：xterm.js 渲染、Cmd/Ctrl+F 搜索、链接可点击、只读模式、清屏、命令历史采集与回填

### 连接与认证
- **多协议**：SSH（密码 / 私钥 / keyboard-interactive）、本地 Shell
- **跳板链**：多级 ProxyJump，逐级 `direct-tcpip` 串联
- **主机指纹 TOFU**：首次信任并记录，指纹变更拒绝连接，支持指纹管理
- **凭据加密**：AES-256-GCM 本地加密（密钥由机器标识派生），与配置同迁
- **快速连接**：`user@host:port` 即连，不入库

### 文件传输
- **SFTP 面板**：浏览 / 新建目录 / 上传 / 下载 / 重命名 / 权限（八进制）/ 删除
- **传输进度**：百分比实时推送，完成后系统通知
- **目录书签**、拖拽上传

### 网络隧道
- **端口转发**：本地（L）/ 远程（R）/ 动态 SOCKS5（D）三类规则
- **规则持久化**：可选随会话自动建立（autoStart）

### 运维能力
- **资源监控**：CPU / 内存 / 磁盘（容量 + IO）/ 网络速率，免服务端插件（解析 `/proc`），迷你趋势图，非 Linux 优雅降级
- **批量执行**：多主机并行执行命令并汇总结果（并发上限、超时控制）
- **会话日志**：输出/输入落盘，可选时间戳

### AI 助手
- **双协议**：OpenAI 兼容 与 Anthropic
- **模型管理**：一键拉取 `/v1/models`，候选含名称与属性（归属 / 创建时间），多选弹框勾选启用，支持搜索过滤
- **流式对话**：等待态 / 流式光标，助手消息按 Markdown 渲染（安全转义），每条消息一键复制
- **能力**：对话、解释选中内容、诊断终端报错（自动附带最后一次命令及其输出）

### 云主机导入
- **腾讯云**：CVM 与轻量应用服务器（TC3-HMAC-SHA256 签名）
- **阿里云**：ECS（RPC V1 / HMAC-SHA1 签名）
- 实例列表勾选导入，按 `provider + instanceId` 幂等去重

---

## 📦 安装

### 下载预编译包

前往 [Releases](https://github.com/j9kkk/NebulaShell/releases) 下载对应平台安装包：

| 平台 | 文件 | 大小 |
| --- | --- | --- |
| macOS (Apple Silicon) | `NebulaShell_0.1.1_aarch64.dmg` | 5.4 MB |
| macOS (Intel) | `NebulaShell_0.1.1_x64.dmg` | 5.7 MB |
| Windows (64 位) | `NebulaShell_0.1.1_x64-setup.exe` | 3.6 MB |
| Windows (MSI) | `NebulaShell_0.1.1_x64_en-US.msi` | 5.1 MB |
| Linux (AppImage) | `NebulaShell_0.1.1_amd64.AppImage` | 79.7 MB |
| Linux (deb / rpm) | `NebulaShell_0.1.1_amd64.deb` / `-1.x86_64.rpm` | 5.4 MB |

> 所有平台均由 GitHub Actions 在打 tag 时自动构建发布，见
> [.github/workflows/release.yml](.github/workflows/release.yml)。
>
> **首次运行提示**：应用未做代码签名与公证，系统可能拦截 ——
> macOS：若提示"已损坏，无法打开"，先在终端执行
> `sudo xattr -rd com.apple.quarantine /Applications/NebulaShell.app`
> （或将 DMG 里的 .app 拖进"应用程序"后对该 .app 执行），再正常打开；
> 也可右键 App 选「打开」（旧版 macOS）。Windows 在 SmartScreen 提示中选「仍要运行」；
> Linux AppImage 需先 `chmod +x`。

### 从源码构建

**前置要求**
- [Rust](https://rustup.rs/) 1.80+
- Node.js 18+
- 系统依赖：macOS 需 Xcode Command Line Tools；Linux 需 `libwebkit2gtk-4.1-dev` 等（见 [Tauri 前置要求](https://tauri.app/start/prerequisites/)）

```bash
git clone https://github.com/j9kkk/NebulaShell.git
cd NebulaShell
npm install
npm run build          # 构建当前平台安装包
npm run dev            # 开发模式（热重载）
```

构建产物位于 `src-tauri/target/release/bundle/`。

---

## 🚀 快速上手

1. **添加主机**：点击「＋ 新建主机」，填写地址、端口、用户名与凭据
2. **连接**：点击主机项（按住 `⌘` / `Ctrl` 点击在新标签打开）
3. **分屏**：连上后按 `⌘D` / `Ctrl+Shift+D`，自动按窗口尺寸选择最优布局
4. **配置 AI**：点击 ✨ → ⚙ 填写 Base URL / API Key，点「拉取模型」选择模型
5. **导入云主机**：点击「☁ 导入云主机」，填写云厂商密钥（弹窗内有获取指引）

### 快捷键

Windows / Linux 的应用快捷键统一为 `Ctrl+Shift+字母`，`Ctrl+字母` 留给 shell（如 `Ctrl+W` 删词、`Ctrl+D` 结束输入）；macOS 用 `⌘`，`Ctrl` 组合全部留给 shell。

| 操作 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 新建标签 | `⌘T` | `Ctrl+Shift+T` | `Ctrl+Shift+T` |
| 关闭当前窗格或标签 | `⌘W` | `Ctrl+Shift+W` | `Ctrl+Shift+W` |
| 分屏 | `⌘D` | `Ctrl+Shift+D` | `Ctrl+Shift+D` |
| 放大 / 还原窗格 | `⌘⇧↵` | `Ctrl+Shift+Enter` | `Ctrl+Shift+Enter` |
| 在终端中查找 | `⌘F` | `Ctrl+Shift+F` | `Ctrl+Shift+F` |
| 切换到第 N 个标签 | `⌘1..9` | `Ctrl+1..9` | `Ctrl+1..9` |
| 复制 | `⌘C` | `Ctrl+Shift+C`；有选区时 `Ctrl+C` | `Ctrl+Shift+C`；有选区时 `Ctrl+C` |
| 粘贴 | `⌘V` | `Ctrl+V` 或 `Ctrl+Shift+V` | `Ctrl+Shift+V` |
| 终端全选 | `⌘A` | `Ctrl+Shift+A` | `Ctrl+Shift+A` |

macOS 上 `Ctrl+C` 始终发送中断信号（SIGINT），不会复制选区。

---

## 🏗 技术架构

```
├── src/                     # 前端(xterm.js 终端 UI)
│   ├── app.js               # 入口(装配模块 + 引入全局样式),约 10 行
│   ├── modules/             # 按域拆分的实现(见下)
│   ├── index.html           # 界面结构
│   ├── style.css            # 样式
│   ├── nebula-shim.js       # IPC 适配层(前端 ↔ Rust 后端)
│   └── shared/              # 前后端共享常量(AI 预设)
├── src-tauri/               # Rust 后端 + Tauri 配置(官方约定的 Rust 侧目录)
│   ├── src/
│   │   ├── lib.rs           # 应用入口 / 状态管理 / 监控任务
│   │   ├── main.rs          # 二进制入口
│   │   ├── commands.rs      # IPC 分发(统一 {ok, data|error} 信封)
│   │   ├── config.rs        # 配置存储 + AES-256-GCM 凭据加密
│   │   ├── ssh.rs           # SSH 会话(russh):认证/跳板/数据泵/转发
│   │   ├── sftp.rs          # SFTP 操作(列目录/上传/下载/权限)
│   │   ├── forward.rs       # 端口转发(L/R/D)
│   │   ├── monitor.rs       # /proc 资源采集解析
│   │   ├── ai.rs            # AI 流式对话(双协议)+ 模型发现
│   │   ├── cloud.rs         # 腾讯云 / 阿里云实例查询
│   │   ├── signing.rs       # 云厂商签名算法
│   │   ├── bridge.rs        # 测试桥(NEBULA_TEST 时启用)
│   │   └── *_test.rs        # 单元测试(与业务文件同目录,独立文件)
│   └── tests/               # Rust 集成测试(真实 SSH 协议)
├── e2e/                     # 前端 UI e2e(Node)+ mock 服务(mock sshd / 云 API / AI)
└── docs/                    # 需求文档 / 原型 / 迁移报告
```

**前端模块划分**(`src/modules/`,按域拆分):

| 模块 | 职责 |
| --- | --- |
| `core.js` | 共享底座:DOM 查询、IPC 封装、全局状态、通用弹窗/toast、标签与窗格访问器 |
| `terminal.js` | 终端会话:连接、标签与窗格、分屏、搜索、广播输入、只读、日志 |
| `hosts.js` | 主机列表、主机编辑弹窗、指纹管理 |
| `cloud.js` | 云主机导入:多账号凭据 + 全区域一键拉取 |
| `ai.js` | AI 助手:流式对话、模型切换、设置弹窗、诊断 |
| `monitor.js` | 资源监控:指标采集与监控条 |
| `sftp.js` | SFTP 文件面板:列目录、上传下载、权限、书签 |
| `settings.js` | 终端设置(字号 / 回滚 / 配色) |
| `tools.js` | 批量执行、命令历史、端口转发 |
| `entry.js` | 应用入口:右键菜单、事件绑定、启动 |

> **关于两个 `src/`**:`src/` 是前端(web 侧)、`src-tauri/` 是 Rust 侧,这是
> [Tauri 官方约定的项目结构](https://v2.tauri.app/start/project-structure/),
> 并非历史遗留。前端源码经 `build.mjs`(esbuild)打包到 `dist/`,再由
> `tauri.conf.json` 的 `frontendDist` 引用并在编译期内嵌进二进制 ——
> **改了前端必须重新打包 + `cargo build`**,否则跑的是旧前端。
> 顶层 `e2e/` 与 `src-tauri/tests/` 分工不同:前者是 Node 驱动的 UI 端到端,
> 后者是 Rust 集成测试(通过 `../e2e/helpers/` 复用同一批 mock 服务)。

**技术选型**

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 应用框架 | Tauri 2 | 系统 WebView，无浏览器引擎打包 |
| SSH/SFTP | russh + russh-sftp | 纯 Rust 实现，无 OpenSSL 依赖 |
| 终端渲染 | xterm.js | 成熟的终端模拟器 |
| HTTP | reqwest + rustls | HTTPS 与云 API |
| 凭据加密 | aes-gcm | 密钥由机器标识派生 |

> **关于体积与内存**：安装包 9.7 MB（对比典型 Electron 应用约 250 MB），因为不打包浏览器引擎、
> 动态链接系统 WebKit。但**运行时内存与 Electron 相当**（约 220 MB，含系统 WebKit 的
> WebContent/GPU/Networking 子进程）—— 体积收益不等于内存收益，详见
> [docs/tauri-migration.md](docs/tauri-migration.md)。

---

## 🧪 测试

```bash
npm test                 # 全部（Rust + UI）
npm run test:rust        # Rust 单元 + 集成测试
npm run test:web         # UI 端到端测试(驱动真实窗口)
```

测试分层：

| 层次 | 覆盖内容 |
| --- | --- |
| Rust 单元 + 回归测试(47) | 云厂商签名(官方文档测试向量)、云凭据校验前置守卫、主机指纹格式兼容、`/proc` 解析、配置存储 CRUD/克隆/幂等导入、凭据往返与模拟重启持久化 |
| Rust 集成测试(1) | 真实 SSH 协议:启动 mock sshd → 认证 → exec → resize → SFTP 全链路 |
| UI e2e(88) | 应用启动、建主机、连接(含 legacy 指纹兼容)、分屏、删除确认、文件面板导航/路径栏/临时副本打开、AI(多选模型/Markdown 渲染/流式态/诊断素材)、云导入(凭据表单/测试连接/密钥帮助/拉取/编辑) |

---

## 🔄 持续集成

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| [ci.yml](.github/workflows/ci.yml) | push / PR | Rust 测试(三平台)、格式与 Clippy 检查、UI e2e(macOS)、构建验证 |
| [release.yml](.github/workflows/release.yml) | 打 tag `v*` | 四平台并行构建并发布到 Release(macOS arm64/x64、Windows、Linux) |

发布新版本：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## 🤝 贡献

欢迎提交 Issue 与 PR。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发流程与代码规范。

## 📄 许可

[MIT](LICENSE) © 2026 NebulaShell Contributors

## 🙏 致谢

[russh](https://github.com/Eugeny/russh) · [Tauri](https://tauri.app/) · [xterm.js](https://xtermjs.org/)
