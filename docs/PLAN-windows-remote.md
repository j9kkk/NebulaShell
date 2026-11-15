# NebulaShell Windows 远程连接总体架构与分阶段实施方案

> **版本**：v1.0  
> **状态**：已立项（Hermes Kanban `nebulashell` 看板追踪：卡片 `#20` ~ `#25`）  
> **覆盖范围**：路线 A（Windows OpenSSH 端口 22 全链路兼容）+ 路线 B（内置纯 Rust IronRDP 端口 3389 图形桌面窗格）

---

## 1. 架构目标与核心决策

NebulaShell 同时纳入两条正交且互补的 Windows 远程连接能力：

1. **路线 A · Windows OpenSSH (端口 22)**：
   - 针对已启用 Windows OpenSSH Server（Windows Server 2019+ / Windows 10 1809+ / Windows 11 原生内置 ConPTY）的主机，复用现有 `russh` + `xterm.js` + `russh-sftp` 通道。
   - 消除后端 5 处 POSIX/Linux 硬编码假设：OS 家族识别、Ping 延迟回显探针、SFTP `/C:/` 盘符路径模型、状态栏 PowerShell/WMI 资源监控、AI 助手命令执行包装与 Windows 敏感路径守卫。
2. **路线 B · 内置 RDP 图形桌面 (端口 3389)**：
   - 采用 Devolutions 纯 Rust `ironrdp` 协议栈（`ironrdp-connector`, `ironrdp-session`, `ironrdp-pdu`, `ironrdp-tokio`, `ironrdp-graphics`, `ironrdp-dvc`, `ironrdp-cliprdr`），零 C 动态库依赖。
   - **100% 复用 SSH 跳板机隧道**：直接调用 `SshService` 的 `channel_open_direct_tcpip` 获取 `BoxStream` (`AsyncRead + AsyncWrite + Unpin + Send`)，将其作为底层字节流交给 `ironrdp` 执行 TLS + CredSSP (NLA) 握手。
   - **工作区原生融合**：扩展前端布局树 `pane.kind` 为 `'terminal' | 'file' | 'rdp'`，RDP 会话作为 `.term-pane.rdp-pane` HTML5 `<canvas>` 窗格运行，天然支持多标签、左右/上下二叉分屏、窗格最大化 (`pane.zoom`) 与工作区平铺 (`workspace.tile`)。

---

## 2. 数据契约（阶段 1 规范）

### 2.1 主机对象 (`Host`) 新增与扩展字段

在 `nebulashell-config.json` 及导入导出文件（v4）中，主机对象扩展如下字段，**所有新增字段在旧配置缺失时均具备确定性默认值，100% 向后兼容**：

| 字段名 | 类型 | 默认值 | 枚举 / 校验约束 | 说明 |
|---|---|---|---|---|
| `protocol` | `string` | `"ssh"` | `"ssh"` \| `"rdp"`（非法值报错码 `E_ENUM`） | 连接协议类型；旧配置缺省自动归一为 `"ssh"` |
| `port` | `i64` | `22` (`ssh`) / `3389` (`rdp`) | `1..=65535`（非法值报错码 `E_PORT`） | 新建主机未显式传端口时，`ssh` 默认 `22`，`rdp` 默认 `3389` |
| `username` | `string` | `"root"` (`ssh`) / `"Administrator"` (`rdp`) | 最长 128 字符，不含控制字符 | 新建主机未显式传用户名时按协议给默认值 |
| `domain` | `string` | `""` | 最长 128 字符，不含控制字符（非法值报错码 `E_DOMAIN`） | RDP 域账号（NetBIOS / AD 域名，如 `CORP`）；SSH 下忽略或留空 |
| `authType` | `string` | `"password"` | `"password"` \| `"key"` \| `"agent"` | 当 `protocol == "rdp"` 时仅支持 `"password"` |

### 2.2 导入导出与等价性判定 (`config.rs` / `host_io.rs`)

1. **`merge_host`**：
   - 新建主机时，先归一 `protocol`（缺省 `"ssh"`，仅接受 `"ssh"` / `"rdp"`）；
   - 默认端口按 `protocol` 决定（`"rdp"` → `3389`，`"ssh"` → `22`）；
   - 默认用户名按 `protocol` 决定（`"rdp"` → `"Administrator"`，`"ssh"` → `"root"`）；
   - 保存并归一化 `domain`（去首尾空白，缺省 `""`）。
2. **`public_host` & `export_hosts_scoped`**：
   - 输出字段包含 `"protocol"`（归一后 `"ssh"` 或 `"rdp"`）与 `"domain"`（默认 `""`）。
3. **`fields_identical` & 导入预检 `diff`**：
   - `same_enum(local, file, "protocol", "ssh")`：协议不同判定为 `conflict`，`diff` 展示 `"协议 SSH → RDP"`；
   - `same_str(local, file, "domain")`：域不同判定为 `conflict`，`diff` 展示 `"域 <旧> → <新>"`；
   - 端口等价比较按条目各自的协议默认端口（`ssh: 22` / `rdp: 3389`）对齐。
4. **`validate_items` (`host_io.rs`)**：
   - `protocol` 若存在且不为 `null`/`""`，必须是字符串 `"ssh"` 或 `"rdp"`，否则报 `field: "protocol", code: "E_ENUM"`；
   - 当 `protocol == "rdp"` 且 `authType` 显式设为 `"key"` 或 `"agent"` 时，报 `field: "authType", code: "E_AUTH"`（原因：`RDP 协议仅支持密码认证`）；
   - `domain` 若存在且不为 `null`，必须是字符串且长度 ≤ 128、不含控制字符，否则报 `field: "domain", code: "E_DOMAIN"`。
5. **云主机同步 (`cloud.rs`)**：
   - `map_tencent_instances` 与 `map_aliyun_instances` 检测到 `os.to_lowercase().contains("windows")` 时，返回 `"protocol": "rdp", "port": 3389, "username": "Administrator"`；非 Windows 实例返回 `"protocol": "ssh", "port": 22, "username": "root"`。
   - 当对已存在于本地的主机执行云刷新（`preserve == true`）时，保留用户已自定义的 `protocol`、`port`、`username`、`domain`（避免用户将 Windows 主机改为 SSH 22 后被云同步重置回 RDP 3389）。

---

## 3. UI/UX 统一规范与控制面归属契约（阶段 2 & 5 准则）

严格遵守 `docs/ui-layout-contract.md` 与 `nebulashell-ui` 技能中的控制面收敛法则（R1–R4）：

### 3.1 控制面归属表（严禁跨区堆砌重复入口）

| 功能 / 动作 | 唯一主归属面 | 键盘/次级入口 | 明确禁止事项（违反即打回） |
|---|---|---|---|
| **切换主机协议 (`SSH` / `RDP`)** | 新建/编辑主机弹窗 (`#modal-host`) 顶部首行 `.auth-seg` 分段控件 | — | 禁止做成独立的新建弹窗或第二套表单 |
| **主机协议标识 (`RDP` 徽标)** | 主机树条目副信息区 / 主机库协议列 | — | 禁止使用刺眼高饱和彩色胶囊，统一用次级文字令牌 `--muted` / `--accent` 弱徽标 |
| **RDP 组合键 (`Ctrl+Alt+Del` / `Win+R` / `Alt+Tab` / `锁屏`)** | RDP 会话标签右键菜单「发送按键 ▸」二级子菜单 (`.ctx-parent`) | 命令面板 (`⌘K`) | **严禁在 `.term-bar` 顶栏或状态栏塞入常驻「发送按键」按钮** |
| **RDP 窗格放大 / 关闭** | 多窗格时右上角悬浮工具簇 `.pane-toolbar`（仅 `⤢` 与 `✕` 两个按钮） | 快捷键 | 单窗格 (`data-solo="1"`) 时 `.pane-toolbar` 必须隐藏 |
| **Windows SFTP 盘符切换 (`C:` / `D:`)** | `.file-pane` 路径栏左侧盘符下拉胶囊 | 面包屑点击根级 | 禁止在 `.file-pane` 增加第二行工具栏 |
| **Windows SFTP 权限修改 (`chmod`)** | Windows 会话下自动隐藏 | — | 禁止在 Windows SFTP 右键菜单展示无效的 `chmod` |

### 3.2 状态矩阵

1. **新建/编辑主机弹窗 (`#modal-host`)**：
   - `protocol = "ssh"`（默认）：显示地址/端口(`22`)/用户(`root`)/认证方式(`密码|密钥`)/密码或私钥/跳板机/启动命令/终端日志/AI 访问。
   - `protocol = "rdp"`：端口未手动修改时自动联动为 `3389`，用户名默认填充 `Administrator`；显示「域 (Domain，选填)」与「密码」；隐藏「认证方式切换、私钥路径、启动命令 (`initcmd`)、终端日志、AI 访问」；**保留「跳板机 (`jumpIds`)」**。
2. **RDP 桌面窗格 (`.term-pane.rdp-pane`) 四态**：
   - `connecting`：居中加载卡片（显示目标 `host:port`、经由跳板信息、取消连接按钮）。
   - `cert-confirm`（TOFU 首次信任 / 证书变更拦截）：复用现有主机指纹弹窗/内嵌卡片视觉，展示 SHA-256 指纹并提供「信任并连接 / 取消」。
   - `connected`：全画布 `<canvas>` 自适应铺满窗格，支持 HiDPI 与远端光标同步；右上角在多窗格时仅显示 `⤢` 与 `✕`。
   - `disconnected`：半透明毛玻璃覆盖层，展示断开原因与「立即重连 / 关闭窗格」按钮。

---

## 4. 六阶段看板追踪与验收门禁总表

| 阶段 | 看板卡号 | 标题 | 前置依赖 | 核心门禁要求 |
|---|---|---|---|---|
| **阶段 1** | `t_0fd6280a` (`#20`) | 规格与数据契约（SSH/RDP 双协议主机模型 + 云发现 Windows 识别） | 无 | `cargo test` 全绿 + 新增双协议存储/导入导出/云识别验收单测 |
| **阶段 2** | `t_ffbf45c5` (`#21`) | UI/UX 原型与视觉规范评审（主机弹窗 + Win-SFTP + RDP 窗格） | 阶段 1 | 走 `视觉设计` 子智能体出稿 + Chromium/WebKit 双引擎零越界 + `vision_analyze` 逐张验收 |
| **阶段 3** | `t_b7d39c8c` (`#22`) | 路线 A 实现与验收：Windows OpenSSH (端口 22) 全链路兼容 | 阶段 2 | Windows Ping/SFTP 盘符/PowerShell 监控/AI 执行器单测与双引擎 UI 验收全绿 |
| **阶段 4** | `t_bd5080d0` (`#23`) | 路线 B1 后端核心：Rust IronRDP 协议栈接入（TLS+NLA+跳板+帧流） | 阶段 2 | 零 C 依赖编译通过 + `rdp_test.rs` 状态机/跳板取消/TOFU/帧编码单测全绿 |
| **阶段 5** | `t_a93f3742` (`#24`) | 路线 B2 前端集成与 UX 验收：主机弹窗改造 + RDP 画布窗格 + 分屏融合 | 阶段 3 & 4 | Chromium/WebKit 8 项几何契约全过 + 截图视觉复核 + `lint:css` & `test:unit` 全绿 |
| **阶段 6** | `t_a3abbf16` (`#25`) | 剪贴板/文件映射增强 + 全量端到端回归 + macOS 打包交付 | 阶段 5 | 独立 `verify-all.mjs` 全绿 + 全量 Rust/JS 测试通过 + Release `.app` 打包签名核验 |

---

## 5. 阶段 4 实现说明（路线 B1 后端核心，2026-11-14 结项）

### 5.1 模块与依赖

| 项目 | 内容 |
|---|---|
| 新增模块 | `src-tauri/src/rdp.rs`（`RdpService` / `RdpSession` / 帧协议 / TOFU / 输入映射） |
| 单元测试 | `src-tauri/src/rdp_test.rs`（18 项） |
| IronRDP 版本 | `core 0.3` / `pdu 0.11` / `connector 0.12` / `session 0.13` / `graphics 0.11` / `input 0.9` / `displaycontrol 0.10` / `dvc 0.10` / `svc 0.10` / `tokio 0.12` / `tls 0.3`（`rustls-ring`）|
| 证书栈 | `x509-cert 0.3`（与 `ironrdp-tls 0.3` 传递依赖的 0.3.0 同版本，否则 `Certificate` 类型不互通）+ `sha2` |
| C 依赖 | 无系统 C 库：`cargo tree` 中不存在 `openssl` / `native-tls`；已存在的 `ring 0.17`（russh 传递依赖）继续复用 |

### 5.2 IPC 契约

| 通道 | 载荷 | 返回 |
|---|---|---|
| `rdp:connect` | `{hostId, sessionId?, width?, height?, frameChannel?, promptCert?}` | `{ok, data:{sessionId,width,height,hops,epoch}}` |
| `rdp:input` | `{sessionId, input:{kind, ...}}` | `{ok}` |
| `rdp:resize` | `{sessionId, width, height, scaleFactor?}` | `{ok}` |
| `rdp:disconnect` | `{sessionId}` | `{ok}` |
| `rdp:cert_reply` | `{requestId, accept}` | `{ok}` |
| `rdp:sessions` | — | `{ok, data:[sessionId]}` |

事件（`nebula-shim` 会把 `:` 映射为 `__`）：

- `rdp:state` → `{sessionId, state: connecting|cert-confirm|connected|resized|disconnected|error, width?, height?, hops?, code?, message?, rawError?, reason?}`
- `rdp:cert_confirm` → `{requestId, sessionId, host, fingerprint, sha256Hex, subject, issuer, validFrom, validTo}`

### 5.3 画面帧二进制协议（`frameChannel`）

`rdp:connect` 传入的 Tauri `Channel` 收二进制；不用 JSON 事件传帧，避免整帧 Base64 阻塞 IPC。

```
magic(4)="NBFR" version(2) kind(2) x(2) y(2) w(2) h(2) dw(2) dh(2) reserved(4) + RGBA 像素
```

- 全部小端；`kind`：`0` = 脏矩形，`1` = 整帧；
- 一帧内多个 `GraphicsUpdate` 先合并成包围盒（`union_rect`）再推一次；
- 像素每点 4 字节（`PixelFormat::RgbA32`），行跨距 `w*4`，与 `DecodeFramePacket`（前端待实现）一一对应。

### 5.4 关键设计决定

1. **专用运行时**：握手链路里有 `!Send` 未来（`ironrdp_async::NetworkClient::send` 返回的 `impl Future` 无 `Send` 约束，`Framed::read_by_hint(&dyn PduHint)` 也把 trait object 跨 await 持有），直接 `tokio::spawn` 编译不过。因此 RDP 全链路独占一个 `current_thread` runtime + `LocalSet` 线程（`LocalRuntime`），IO 与未来同源；Tauri 侧只通过 `oneshot` 取握手结果，命令处理函数保持 `Send`。
2. **TOFU 复用 SSH 的主机指纹表**：键为 `rdp:{host}:{port}`，与 SSH 的 `host:port` 互不覆盖。首次见到的证书默认直接信任并落盘（与 SSH 一致）；`promptCert=true` 时改为等前端确认（60s 超时按拒绝处理）；**指纹变更一律硬拒**并返回带 `[NB-FP key|旧|新]` 标记的错误，前端既有 `parseFpError` + `offerFpRetrust` 可直接复用。
3. **多级跳板存活**：`SetupHandles` 由帧泵任务持有到会话结束，Drop 时断开沿途跳板机；会话失败/取消也一并回收。
4. **动态分辨率**：`DrdynvcClient` 挂 `DisplayControlClient`；`rdp:resize` → `encode_resize` → 收到 `DeactivateAll` 时驱动 `ConnectionActivationSequence` 到 `Finalized`，重建 `DecodedImage` 并广播 `rdp:state{state:"resized"}`。
5. **退出与关窗**：`AppState.rdp` 参与关窗拦截（`active_sessions()` 同步计数）；`ExitRequested` 时 `disconnect_all()`。

### 5.5 验收结果

- `cargo test`：**303 项全绿**（lib 245 含 RDP 18 + 集成 58），0 失败。
- 取消路径有真链路覆盖：`cancel_during_handshake_closes_stream_and_session` 起真实 TCP 监听，验证「取消后 socket EOF + 会话表清零 + `connect` 返回取消错误」。
- 同时修掉一处阶段 3 遗留回归：`PING_ECHO_CMD` 从 `cat` 改为 `cat 2>/dev/null || powershell …` 后，`e2e/helpers/ssh-server.mjs` 仍按整串等于 `cat` 匹配，导致 `latency_probe` 三项失败；改为按首个 token 匹配后恢复。

---

## 6. 阶段 5 实现说明（路线 B2 前端集成，2026-11-14 结项）

### 6.1 改动面

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/modules/rdp.js` | 新增 676 行 | 帧解码（`decodeFramePacket`）、窗格状态机（`idle/connecting/cert/connected/down`）、画布渲染（1:1 offscreen fb + `drawImage` 重采样）、键鼠映射（XT Set 1 扫描码 / unicode 兜底 / 滚轮 120 步进）、组合键、`bindRdpEvents` 全局事件路由 |
| `src/modules/rdp.test.mjs` | 新增 8 项 | 帧头逐字段对齐、截断拒绝、扫描码、鼠标键、滚轮量化、远端尺寸推导 |
| `src/modules/terminal.js` | 改 | `kind==='rdp'` 的窗格创建 / 工具条 / 关闭 / 激活 / 标签样式；`addRdpPane`（与 `addFilePane` 对称，ratio 0.62 横向切分）；`connectHost` 协议分叉；`toggleReadonly` 作用于桌面窗格；右键菜单「分屏与布局 ▸ 新增远程桌面分屏」「发送按键 ▸ 4 项」；`renderPickers` / `refreshPickers` 跳过桌面窗格 |
| `src/modules/entry.js` | 改 | `bindRdpEvents()`、协议滑块点击与键盘事件 |
| `src/modules/hosts.js` | 改 | `syncProtocolSliderUI` / `toggleProtocolRows` / `setHostProtocol`；弹窗预填与 `saveHostModal` 协议化 payload；主机行 `proto-badge` |
| `src/modules/host-library.js` | 改 | 主机库名称列同样打 `RDP` 徽标 |
| `src/modules/terminal-layout.js` | 改 | `paneMinSize` 增桌面窗格 420×300 |
| `src/index.html` | 改 | 弹窗顶部 `#host-protocol-slider` 分段控件（隐藏 `#host-protocol` 为真值源）；`row-initcmd/row-sessionlog/row-aiaccess` 改 `.form-row` 包裹以便整行折叠 |
| `src/style.css` | 改 | RDP 窗格样式段（`.rdp-pane` / `.rdp-surface` / `.rdp-canvas` / `.rdp-overlay` / `.rdp-card` 等），全部走设计 token |
| `reports/win-remote-acceptance/` | 新增 | `site.mjs`（构建产物 + 假后端）、`stub-rdp.js`（主机库 + 视频会话状态机 + 合成帧）、`verify-ui.mjs`（96 项断言）、`selfcheck.json`、12 张截图 |

### 6.2 关键设计决定

1. **协议是主机第一等属性**：唯一切换点是弹窗顶部的分段控件；RDP 时折叠 `row-auth` / `row-password` / `row-key` / `row-initcmd` / `row-sessionlog` / `row-aiaccess`，只保留 `row-domain`。旧配置缺 `protocol` 一律按 SSH 兜底。
2. **桌面窗格复用 `.term-pane` 布局契约**：不新造分屏体系，`addRdpPane` 与 `addFilePane` 同构，因此拖动分隔条、放大、平铺、容量上限全部免费继承；最小尺寸 420×300（终端 320×180、文件 300×220）。
3. **画布 1:1 缓冲 + 重采样**：`putImageData` 不支持变换，因此远端缓冲画到 offscreen canvas，可见画布按 `devicePixelRatio` 用 `drawImage` 缩放。
4. **组合键只在右键菜单**：Ctrl+Alt+Del / Win+R / Alt+Tab / Win+L 只出现在标签右键「发送按键」二级菜单，常驻面严禁放置（设计稿 R1，防误触）。
5. **浮层不吃事件**：`.rdp-overlay` 默认 `pointer-events: none`，只有卡片自身收回事件，避免证书卡把画布的可点击区吞掉。
6. **证书阶段没有 sessionId 也要能归位**：后端在等前端回执时 `rdp:connect` 尚未返回，事件里带的 sessionId 前端还不认识；`route()` 因此在「唯一处于 connecting 的桌面窗格」上兜底，多个在连则不猜。

### 6.3 验收结果（`reports/win-remote-acceptance/selfcheck.json`）

- **164/164 断言全过**（`allPassed`，退出码 0），覆盖 Chromium + WebKit 双引擎、nebula/dark + light 双主题、12 个场景：主机弹窗（默认 SSH → 切 RDP → 保存）、已连接、证书确认、断开、指纹变更、分屏、标签菜单与发送按键二级菜单。
- 断言分两层：**几何契约**（最小字号 ≥11px、无横向溢出、表单 label 单行且中线偏差 ≤1.5px、菜单 ≤10 行、二级菜单首行与父项对齐 ≤2px、分屏两格 ≥420×300、TOFU 指纹按行高判定单行、标题行高 ≥28px 且不压画面、浅色主题底色必须真的变亮）与**行为契约**（保存带 `protocol`/`domain`、按 `a` 发出扫描码 `0x1E`、滚轮发 `-120`、信任回执 `accept:true` 并进入已连接、菜单项真的切到新窗格）。
- `npm run test:unit`：**536/536 绿**（新增 8 项 RDP 契约单测）；`npm run lint:css`：0 失败。

### 6.4 本阶段修掉的真实缺陷（非测试脚本问题）

1. **空窗格的选择器盖住桌面窗格**：`.pane-picker` 的 `z-index: 6` 压在 canvas 之上，而 SSH 路径靠 `pane.innerHTML=''` 顺带清掉它，RDP 只 append 就整块被挡。改为 `buildRdpPane` 主动移除并复位 `pane.pickerRendered`，同时让 `renderPickers`/`refreshPickers` 跳过 `kind==='rdp'`（否则主机列表一变又被挂回来）。
2. **信任证书后卡在「正在连接」**：回执发出后后端的 `connect` Promise 可能已先落地并写入 `connected`，信任按钮回调随即把它覆盖成 `connecting`，此后再无人改回。改为回执返回后仅在尚未 connected 时写 `connecting`。
3. **二级菜单首行与父项错位 2px**：`#ctx-sub` 面板自带 6px 内边距，原先把面板顶边贴到父项顶边（-4px 硬调），首行实际低了 4px。改为按面板内边距对齐首行（`pr.top - 6`），并把断言改成量「父项行首 ↔ 二级首行」。

4. **指纹折成两行**（视觉复核查出）：`.rdp-fp` 只有 `overflow-wrap: anywhere`，32 字节指纹在 420px 宽卡片里折成两行，卡片被撑高、按钮整体下移。改为 `nowrap + text-overflow: ellipsis`。原来的断言用 `scrollWidth <= clientWidth` 判定「单行」——折行后两者相等，属**假通过**，已改成按行高判定（单行高度 = 行高 + 上下内边距 + 边框）。
5. **浅色主题根本没被验证**（视觉复核查出）：假后端的 `settings:get` 写死 `theme:'nebula'`，`?theme=light` 的用例拍到的仍是深色画面，两张图字节相同。stub 改为按 URL 参数返回主题，并补两条断言：`data-theme` 必须等于用例主题、卡片底色亮度必须与该主题一致。
6. **分屏下 ✕⤢ 悬浮压住远端画面**（视觉复核查出）：桌面窗格原来复用终端的右上角浮层工具条，分屏时两枚按钮直接压在远端桌面右上角，且画面上没有任何窗格标签（分屏后无法辨认这一格是哪台机器）。改为桌面窗格自带 36px 标题行 `.rdp-bar`（主机名 + `用户@地址:端口` + 状态文案，✕⤢ 收进行尾，与文件分屏同一套做法）；错误状态的文案与浮层同源。

7. **分屏把画面横向压扁**（第二轮视觉复核查出）：`blitFull` 无条件把缓冲区拉伸到画布尺寸，分屏把窗格宽度砍半后远端桌面被压成 0.81:1。改为**等比适应**（`fitRect`：`scale = min(cw/dw, ch/dh)`，居中留边），脏矩形与鼠标坐标换算同步走这套变换；验收脚本直接量画布上不透明像素的宽高比，必须等于远端分辨率比例（容差 3%），并让假后端固定 1280×800 以确保分屏时真的出现留边。
8. **指纹被省略号截断**（第二轮视觉复核查出）：改成 `nowrap + ellipsis` 后单行虽然成立，但 71 字符在缺等宽字体的环境里要 676px（`ui-monospace` 回退到比例字体时字符宽度涨到 1.5 倍），实际只显示一半，证书确认失去意义。改为**固定两行、每行 16 字节**（`fingerprintRows`，95 字符全部可见、行数固定所以高度不随字体抖动），并在指纹框右侧加「复制完整指纹」按钮、`title` 带完整值。

9. **状态栏与窗格自相矛盾**（第三轮视觉复核查出）：两个桌面窗格标题行都显示绿色「已连接」时，底部状态栏仍写「就绪 — 尚未建立连接」，断开/重连/只读五个按钮全灰。原因是 RDP 没有 SSH 会话对象，状态栏只认 `state.sessions`。新增 `updateRdpStatusbar`：按窗格四态写状态栏（`已连接 Administrator@host:port · RDP` / 正在连接 / 已断开 + 原因），只点亮远程桌面真正支持的动作（断开 / 重连 / 只读），清屏与会话日志保持禁用并写明「远程桌面不支持」；`session.disconnect` / `session.reconnect` / `session.readonly` 三条命令各加 RDP 分支，否则按钮能用也会打空。
10. **验收截图只框到一格**（第三轮视觉复核查出）：分屏用例原来是元素级裁切，双栏布局与状态栏都不在证据里。改为整窗截图，并把状态栏文案与按钮可用性纳入断言。

### 缺陷 11:实机连接后黑屏(0.6.30 修)

**现象**：0.6.29 装到本机后走 RDP 连 `192.168.31.129`，状态栏与窗格标题行都显示「已连接」，但画面全黑，无报错。

**根因（两层）**：

1. **首帧按整帧处理**。`applyFramePacket` 的条件是 `kind === FULL || !pane.fb || 尺寸不符`，而服务端登录后的首帧通常只是一块脏矩形（例如任务栏或欢迎屏重绘区域）。这条分支用 `desktopWidth × desktopHeight` 去构造 `ImageData`，像素数却只有 `width × height × 4`，浏览器抛 `IndexSizeError`，绘制断在第一帧，此后再也没有 `putImageData` 成功过 —— 画面停在画布底色（黑）。验收用假后端一直先发整帧，所以 164 项断言全绿也照不出来。
2. **帧像素第 4 字节当 alpha**。解码格式是 `PixelFormat::RgbA32`，Windows 32bpp 位图的填充字节常是 `0x00`，原样转给画布等于全透明，即使画上去也看不见。

**修法**：

- 前端：缓冲区一律按桌面尺寸分配，像素按 `(x, y)` 贴回；`kind === FULL` 或缓冲区刚重建时才整体重绘，其余走脏矩形重采样。像素数不足的包直接丢弃，不再抛异常打断绘制。
- 后端：`force_opaque_rgba` 在推帧前把每像素第 4 字节写成 `0xFF`；会话建立与分辨率重激活后各补推一帧整桌面（`encode_full_frame`），前端不依赖服务端首帧形态即可建立缓冲区。
- 假后端改成**先脏矩形后整帧**（与真机顺序一致），并在前端单测里用「首帧即脏矩形」直接覆盖这条崩溃路径。

**覆盖**：`src/modules/rdp.test.mjs` 3 项（首帧脏矩形、脏块只重采样一块、像素不足丢弃）、`rdp_test.rs` 2 项（alpha 强制、整帧包字段）、`verify-ui.mjs` 164/164。

### 缺陷 12:连上瞬间弹「已手动断开」(0.6.31 修)

**现象**：0.6.30 实连后窗格先显示「已连接」，随即弹「远程桌面已断开 · 已手动断开」，反复重连都一样。

**根因**：`rdp:connect` 握手成功后执行了 `service.cancels.remove(&sid)`，把取消信号的 `watch::Sender` 丢弃；而 `run_session` 里的帧泵仍持有对应的 `Receiver`。`tokio::sync::watch` 的 `Receiver::changed()` 在发送端全部丢失时返回 `Err`，`wait_cancelled` 把它当成「已取消」，于是帧泵在 `tokio::select!` 的第一个分支（biased）立刻命中，带 `已手动断开` 退出。这条路径只在**真实握手成功**后才会走到，之前所有实机验证都停在证书/CredSSP 阶段，因此没暴露。

**修法**：握手结束后不再删除发送端；改为在帧泵退出、`drop_session` 之后统一回收。

**覆盖**：Rust lib 247 项通过；实机连 `192.168.31.129` 验证（不再立即断开）。

### 性能问题:画面能动能操作,但卡顿与输入延迟高(0.6.32 修)

**现象**：内网机器(排除网络因素)上画面能刷新、能操作，但拖动和点击明显落后几十到几百毫秒。

**根因**：

1. **每块脏矩形立刻发一帧**。Windows 在动画、拖窗、光标移动时以几十上百 Hz 推小更新，`write_outputs` 每次都走一次 `Channel.send`；Tauri 对 >1KB 的 raw 负载走的是「eval 注入 + fetch 回取」这条路（`MAX_RAW_DIRECT_EXECUTE_THRESHOLD = 1024`），也就是每次更新一个 webview fetch。帧率越高队列越长，输入事件排在后面 —— 这不是带宽问题，是**主线程排队**。
2. **远端分辨率按 DPR 放大到 2 倍**。1280×800 的窗格在 2 倍屏下请求 2560×1600 的远端桌面，每整帧 16MB 未压缩 RGBA。
3. **缩小画面用 `imageSmoothingQuality = 'high'`**，每帧整块重采样都是 CPU 重活。

**修法**：

- 后端 `FrameOut`：脏矩形先合并，发送间隔 30ms(约 30fps)，期间只保留最新状态；`select!` 增加「挂起帧超时补发」分支，避免服务端停推时画面停在半截。
- 前端 `queueFramePacket` + `compositePackets`：按动画帧(batch) 取包，所有脏块贴进离屏缓冲后只按包围盒重绘一次。
- `REMOTE_PIXEL_BUDGET = 1_600_000`：超过预算按比例缩小远端分辨率，宽高仍取偶数。
- 缩小时 `imageSmoothingQuality = 'low'`。

**覆盖**：`FrameOut` 合帧/节流单测 1 项、前端合帧与像素预算单测 2 项；前端 543 项、Rust lib 248 项、`verify-ui` 164/164。

### 性能问题第二轮:压缩与 EGFX(0.6.33)

第一轮(0.6.32)把帧率压到 30fps、按动画帧合并重绘、给远端分辨率加像素预算后仍卡顿,说明瓶颈是**每帧体积**本身:1600×1000 的整帧 RGBA 是 6.4MB,30fps 就是每秒近 200MB 跨进程拷贝。

**两处改动**:

1. **帧体 deflate 压缩(协议层)**。帧包头部 `version` 字段升级:1 = 原样像素,2 = zlib 压缩体。后端在 `FrameOut::flush` 里对 ≥4KB 的帧体压一次(压缩后不更小就退回原样),前端用 `DecompressionStream('deflate')` 解压,并用一条 Promise 链保证贴图顺序。前端能力通过 `rdp:connect` 的 `compression: 'deflate'` 协商,老引擎不受影响。
2. **EGFX(RDP Graphics Pipeline)**。`support_dyn_vc_gfx_protocol` 打开,并把 `GraphicsPipelineClient` 注册到 `DrdynvcClient`;服务端改用 RFX / Progressive / ClearCodec 编码,传输量降一个数量级,且只发变化区域。没有 H.264 解码器时 ironrdp 会自动只广告非 AVC 能力集,避免服务端发我们画不了的帧。`NB_RDP_LEGACY_GFX=1` 可关闭。

**覆盖**:Rust `deflate_frames_round_trip_and_fall_back_when_small`、前端「v2 头解析」「inflate 往返」「预算内等比缩放」「一帧合包」;`verify-ui` 172/172(新增压缩帧到达与像素落图断言)。

## 与 Microsoft Remote Desktop (mstsc) 的配置项对照

| mstsc 页签 | 项 | NebulaShell | 落点 |
|---|---|---|---|
| 显示 | 分辨率 / 缩放 / 颜色深度 | ✅ | `rdpDisplay.resolution / scaleFactor / colorDepth` |
| 显示 | 多显示器 | ❌ 单窗格单桌面 | — |
| 体验 | 检测连接质量、带宽自动 | ⚠️ 手动画质预设 | `rdpNetwork.qualityPreset` |
| 体验 | 桌面背景 / 字体平滑 / 桌面合成 / 视觉样式 / 菜单动画 / 窗口动画 / 光标阴影 / 拖动时显示内容 | ✅ | `PerformanceFlags` |
| 本地资源 | 剪贴板文本 | ✅ 双向自动(CLIPRDR) | `rdpExperience.clipboard` |
| 本地资源 | 驱动器 / 打印机 / 音频 | ❌ 未接 rdpdr / rdpsnd | — |
| — | 剪贴板文件传输 | ❌ 只做文本 | — |
| 高级 | 服务器身份验证 / 网关 / 自动登录 | ⚠️ TOFU 指纹确认,无 NLA 开关 | `rdp:cert_reply` |
| 高级 | 连接时启动程序 | ❌ | — |
| — | 帧率上限(144fps) | ✅ 自家扩展 | `rdpDisplay.frameRate` |
| — | 像素上限 | ✅ 自家扩展 | `rdpDisplay.pixelBudget` |
| — | 带宽硬闸 | ✅ 自家扩展 | `rdpNetwork.bandwidthKbps` |

下一阶段(Stage 7)候选,按性价比排序:
1. ~~剪贴板文本重定向~~ —— 0.6.38 已完成(它是静态通道不是 dvc,`rdp_clipboard.rs`)。
2. 自适应帧率:按脏区面积/编码耗时动态调 `interval`,取代固定档位。
3. 多矩形分包:现在合包围盒会把两块小更新放大成一整块。
4. 驱动器重定向(`rdpdr`)—— 工作量大,可与 SFTP 面板复用传输逻辑。
