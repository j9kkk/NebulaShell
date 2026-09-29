# 贡献指南

感谢参与 NebulaShell 开发。本文档说明开发环境、代码规范与提交流程。

## 开发环境

**前置要求**

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Rust | 1.80+ | `rustup` 安装 |
| Node.js | 18+ | 仅用于前端构建与测试 |
| 系统依赖 | — | macOS: Xcode CLT；Linux: `libwebkit2gtk-4.1-dev` 等（见 [Tauri 前置](https://tauri.app/start/prerequisites/)） |

**启动**

```bash
npm install
npm run dev          # 开发模式(前端 + Tauri 热重载)
```

## 项目结构

- `src/` — 前端（xterm.js 终端 UI）。改 UI 只动这里
  - `app.js` 是启动/事件绑定入口与全局状态；按域拆分的实现放在 `src/modules/`
- `src-tauri/src/` — Rust 后端。每个模块职责单一：
  - `commands.rs` 是唯一的 IPC 入口，新增功能在此注册 channel
  - `ssh.rs` / `sftp.rs` / `forward.rs` 是协议层
  - `config.rs` 是持久化层
  - 单元测试一律独立成 `*_test.rs`（在 `lib.rs` 里 `#[cfg(test)] mod x_test;` 挂载），
    不在业务文件里夹带 `#[cfg(test)]` 内联模块
- `e2e/` — UI 端到端测试与 mock 服务（mock sshd / 云 API / AI API，均为进程内实现，无需外部依赖）
- `src-tauri/tests/` — Rust 集成测试，通过 `../e2e/helpers/` 复用同一批 mock 服务

> 两个 `src/`（`src/` 前端、`src-tauri/` Rust）是 [Tauri 官方项目结构](https://v2.tauri.app/start/project-structure/)，不是历史遗留。
> 前端经 `build.mjs` 打包到 `dist/`，编译期内嵌进二进制 —— 改前端后必须重跑 `npm run build:web` **且** `cargo build`，否则跑的是旧前端。

## 代码规范

**Rust**
- 遵循 `cargo fmt` 与 `cargo clippy`（提交前请运行）
- 错误用 `Result<T, String>` 向上传递，在 `commands.rs` 统一转成 `{ok:false, error}` 信封
- 注释只写"为什么"，不写"是什么"；对非直觉的取舍（如为何不用某方案）必须留注释

**前端**
- 无框架，原生 DOM。保持与现有代码风格一致
- 所有 IPC 调用经 `api(channel, payload)` 封装，不直接调 `window.nebula.invoke`
- 跨技术栈行为差异要封装（例：不用 `window.confirm()`，用 `askConfirm()`）

## 测试

```bash
npm test              # 全部
npm run test:rust     # Rust 单元 + 集成(含真实 SSH 协议测试)
npm run test:web      # UI e2e(驱动真实窗口)
```

**测试要求**

| 改动类型 | 需补的测试 |
| --- | --- |
| 新增 IPC 命令 | Rust 单元测试 + UI e2e 步骤 |
| 协议层改动 | `src-tauri/tests/integration.rs`（对 mock sshd 走真实协议） |
| 存储/加密改动 | 必须覆盖"重启后仍可读回"（`persistence_across_restart.rs`） |
| Bug 修复 | 先写能复现的失败测试，再修 —— 否则容易修错 |

> 加密/持久化类改动请务必验证**跨进程**行为：同一进程内通过不代表重启后可用（这类 bug 真实发生过）。

## 提交规范

提交信息用[约定式提交](https://www.conventionalcommits.org/zh-hans/)：

```
<类型>(<范围>): <简述>

类型: feat | fix | docs | test | refactor | perf | chore
范围: ssh | sftp | forward | monitor | ai | cloud | ui | store | ci
```

示例：
```
feat(sftp): 支持目录书签
fix(ui): 删除操作改用应用内确认框(WKWebView 下 confirm 失效)
test(store): 补凭据重启持久化回归
```

## 提交流程

1. Fork 仓库并创建特性分支：`git checkout -b feat/your-feature`
2. 开发 + 补测试，确保 `npm test` 全绿
3. 提交（信息遵循上述规范）
4. 发起 PR，描述中说明：改动目的、实现方式、测试覆盖

PR 需通过 CI（Rust 测试 + UI e2e + 构建检查）方可合并。

## 平台差异注意

本项目跨 macOS（WKWebView）/ Windows（WebView2）/ Linux（WebKitGTK）。以下 API 在不同
WebView 下行为不一致，**新增代码时避免依赖**：

- `window.confirm()` / `alert()` — WKWebView 下可能不返回（wry 未实现对应委托）
- `fetch()` 访问 http:// —— macOS ATS 会拦截

需要这类能力时，走 Rust 侧实现或应用内 UI。
