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
- **分屏**：垂直/水平分屏、拖拽调宽、单窗格放大（⌘D / ⌘⇧D / ⌘⇧↵），窗口尺寸变化自动同步远端 PTY
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
- **模型发现**：一键拉取 `/v1/models` 列表
- **能力**：对话、解释选中内容、生成命令、诊断终端报错（自动附带最近输出）

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
| macOS (Apple Silicon) | `NebulaShell_1.0.0_aarch64.dmg` | 5.4 MB |
| macOS (Intel) | `NebulaShell_1.0.0_x64.dmg` | 5.7 MB |
| Windows (64 位) | `NebulaShell_1.0.0_x64-setup.exe` | 3.6 MB |
| Windows (MSI) | `NebulaShell_1.0.0_x64_en-US.msi` | 5.1 MB |
| Linux (AppImage) | `NebulaShell_1.0.0_amd64.AppImage` | 79.7 MB |
| Linux (deb / rpm) | `NebulaShell_1.0.0_amd64.deb` / `-1.x86_64.rpm` | 5.3 MB |

> 所有平台均由 GitHub Actions 在打 tag 时自动构建发布，见
> [.github/workflows/release.yml](.github/workflows/release.yml)。
>
> **首次运行提示**：应用未做代码签名，系统可能拦截 ——
> macOS 需右键「打开」；Windows 在 SmartScreen 提示中选「仍要运行」；
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
2. **连接**：点击主机项；或按 `⌘K` 打开命令面板
3. **分屏**：连上后按 `⌘D`（垂直）或 `⌘⇧D`（水平）
4. **配置 AI**：点击 ✨ → ⚙ 填写 Base URL / API Key，点「拉取模型」选择模型
5. **导入云主机**：点击「☁ 导入云主机」，填写云厂商密钥（弹窗内有获取指引）

### 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 命令面板 | `⌘K` | `Ctrl+K` |
| 垂直 / 水平分屏 | `⌘D` / `⌘⇧D` | `Ctrl+D` / `Ctrl+Shift+D` |
| 放大 / 还原窗格 | `⌘⇧↵` | `Ctrl+Shift+Enter` |
| 终端搜索 | `⌘F` | `Ctrl+F` |
| 关闭标签 | `⌘W` | `Ctrl+W` |
| 切换标签 | `⌘1..9` | `Ctrl+1..9` |
| 复制 / 粘贴 | `⌘C` / `⌘V` | `Ctrl+C` / `Ctrl+V` |

---

## 🏗 技术架构

```
├── src/                     # 前端(xterm.js 终端 UI)
│   ├── app.js               # 渲染层主逻辑
│   ├── index.html           # 界面结构
│   ├── style.css            # 样式
│   ├── nebula-shim.js       # IPC 适配层(前端 ↔ Rust 后端)
│   └── shared/              # 前后端共享常量(AI 预设 / 云地域)
├── src-tauri/               # Rust 后端 + Tauri 配置
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
│   │   └── bridge.rs        # 测试桥(NEBULA_TEST 时启用)
│   └── tests/               # Rust 集成测试(真实 SSH 协议)
├── tests/                   # 前端 UI e2e + mock 服务
└── docs/                    # 需求文档 / 原型 / 迁移报告
```

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
| Rust 单元测试(20) | 云厂商签名(官方文档测试向量)、`/proc` 解析、配置存储 CRUD/克隆/幂等导入 |
| Rust 回归测试(5) | 凭据往返、模拟重启持久化(捕获"密码保存后失效")、私钥/口令 |
| Rust 集成测试(1) | 真实 SSH 协议:启动 mock sshd → 认证 → exec → resize → SFTP 全链路 |
| UI e2e(12) | 应用启动、建主机、连接、分屏、删除确认、AI 对话、SFTP、云导入 |

---

## 🔄 持续集成

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| [ci.yml](.github/workflows/ci.yml) | push / PR | Rust 测试(三平台)、格式与 Clippy 检查、UI e2e(macOS)、构建验证 |
| [release.yml](.github/workflows/release.yml) | 打 tag `v*` | 四平台并行构建并发布到 Release(macOS arm64/x64、Windows、Linux) |

发布新版本：

```bash
git tag v1.0.1 && git push origin v1.0.1
```

## 🤝 贡献

欢迎提交 Issue 与 PR。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发流程与代码规范。

## 📄 许可

[MIT](LICENSE) © 2026 NebulaShell Contributors

## 🙏 致谢

[russh](https://github.com/Eugeny/russh) · [Tauri](https://tauri.app/) · [xterm.js](https://xtermjs.org/)
