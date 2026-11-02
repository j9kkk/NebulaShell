# 功能菜单盘点:标签、省略号与快捷键展示

> 任务:`t_3c4662a2`(看板 `nebulashell`)。目的:在下一次「重排功能菜单」之前,把当前**所有**菜单项的文案、省略号、行为、快捷键与定义位置一次性盘清,并把已经能判定的缺陷逐条挂到 `file:line`。
>
> 盘点基线:`main` @ `03a53e4`(`fix(store): 导入备份只保留最近 20 份`,2026-11-02),版本 0.6.25。**注意:审计期间工作区有并发未提交改动**——`src/index.html`、`src/modules/transfer.js`、`src/style.css` 正在被另一路修改(导出弹卡改版,见 `index.html` 第 982–1030 行附近),菜单与快捷键相关代码未变。本文全部 `file:line` 在 2026-11-02 20:52 对当时磁盘内容复核过;若这三份文件继续被改,**重跑附录 A 的脚本再引用行号**。
> 表格是用一次性脚本(`extract-menus.mjs` / `keymap-audit.mjs` / `gen-inventory.mjs`)从源码抽出来生成的,不是手抄;三个脚本的完整源码在**附录 A**,可直接重跑。

## 0. 摘要

- **菜单标签只有一个静态来源**:`src/modules/entry.js` 的 45 条 `registerCommand(...)`(其中 3 条是 `internal` 兼容别名,不进面板)。一级菜单(`src/shared/menu-spec.js`)只存**命令 id + 分组**,标签、快捷键、勾选、禁用原因全部运行时取自注册表与 `keymap.js`。
- **省略号不是写在文案里的,而是由 `kind: 'dialog'` 自动追加**(`src/modules/commands.js:34`)。这带来两个方向的失真,见 §8 的 P0-1 ~ P0-5:同一个动作在不同菜单一次带 `…` 一次不带;不是弹窗的动作被追加 `…`;是弹窗的动作没有 `…`;`…` 还会泄漏到命令面板和设置页的快捷键表里。
- **快捷键的渲染是统一的**(`src/modules/core.js:123` 的 `accel()`,mac 用 `⌘⇧⌥`、PC 用 `Ctrl+Shift+Alt`)。全库没有 `Ctrl + S`、`Ctrl+S` 这类手写变体,也没有在界面文案里硬编码 `⌘`(只有注释里有)。**这一项基本没问题**,问题出在"同一个键位挂两个动作"和"有键位但菜单不显示"。
- 规模:一级菜单 macOS 54 项(含 14 项系统预定义)、Windows/Linux 42 项;右键/下拉菜单 13 处共 68 条静态条目(另 5 处是动态列表);AI 面板菜单 5 处(4 个浮层 + 代码块 ▾ 下拉);标题栏带快捷键提示的按钮 6 个;设置页快捷键表按 `keymap` + 注册表动态生成(45 行 = 34 个 keymap 动作 ∪ 42 条非 internal 命令,其中 11 条命令无内置键位,显示「未设置」)。
- 发现 **6 个 P0 / 12 个 P1 / 6 个 P2**,全部带 `file:line`,逐条列在 §8。

## 1. 取证方法

1. 静态抽取:`extract-menus.mjs` 对 `src/modules/*.js` 做括号配平扫描(尊重字符串与注释),取出每条 `registerCommand(id, {...})` 的 `id / label / kind / category / internal` 和所在行号 → `commands-raw.json`(45 条,与 `grep -c registerCommand` 的 45 处调用一致,函数定义那一处已排除)。
2. `keymap-audit.mjs` 读出 `DEFAULT_KEYMAP` 文本求值,按 `bindingScope()`(`src/modules/keymap.js:338`)的作用域规则逐平台展开 33 / 33 / 32 条绑定,做同作用域冲突检测 + 跨作用域同键检测;再用 `menu-spec.js` 的 `menuCommandIds()` 反查「有键位但没有任何菜单入口」。
3. 菜单表用 `specFor('mac'|'pc')` 真实过滤(不是人肉删行),行号按分组内顺位合并,因此同一命令出现两次时(如 `settings.open` 在 mac 在应用菜单、在 PC 在文件菜单)能取到各自的 `menu-spec.js` 行。
4. 逐条读 `run` 函数确认行为分类:`D`=需要输入的弹窗、`I`=信息/管理弹窗、`M`=弹出列表或选择菜单(不遮挡主界面)、`A`=立即执行。分类结果见 §4/§5 的「行为」列。
5. 没有起应用、没有跑 `npm test` / `e2e/ui.e2e.mjs`(项目铁律:全量 e2e 只在发布前或用户明确要求时跑)。本报告所有结论都能由源码路径直接复核;`dist/` 未重建,因为本次不改 `src/`。

## 2. 菜单定义位置总表(完备性声明)

下表是"菜单项文案或结构可能被定义/改写"的**全部**位置。凡是会显示菜单项名字、快捷键或勾选态的地方都在里面;表后 §10 列出了核对过但确认不属于菜单的文件。

| # | 文件 | 定义什么 | 规模 | 关键行 |
| --- | --- | --- | --- | --- |
| 1 | `src/modules/entry.js` | **标签的唯一静态来源**:全部 `registerCommand` | 45 条 + 3 条 internal | 343–491,514–516 |
| 2 | `src/shared/menu-spec.js` | 一级菜单的**结构**(分组、顺序、分隔线、平台限定),不含文案 | 8 个分组,54/42 项 | 11–60 |
| 3 | `src/modules/commands.js` | 省略号规则、菜单项构造、省略号剥离开关 | 规则 3 处 | 7(`CATEGORY_LABEL`)、34、95 |
| 4 | `src/modules/keymap.js` | 快捷键唯一事实源 + 显示渲染 + 冲突检测 | 34 个动作 | 25–74、255、317 |
| 5 | `src/modules/core.js` | 快捷键符号表与 `accel()`、`applyAccelTitles()` | 1 个渲染器 | 118–158 |
| 6 | `src/modules/native-menu.js` | macOS 原生菜单渲染(读 1+2+4) | — | 42–71 |
| 7 | `src/modules/menubar.js` | Windows/Linux 标题栏菜单渲染(读 1+2+4) | — | 39–47 |
| 8 | `src/modules/palette.js` | 命令面板(读注册表,按 `category` 分组) | 动态 | 30–39、114–122 |
| 9 | `src/modules/terminal.js` | 标签右键菜单、全部标签列表 | 8 项 + 动态 | 92–115、174–189 |
| 10 | `src/modules/entry.js` | 终端右键菜单、分屏下拉、侧栏 ⠇ 主机菜单 | 16 / 5 / 9 项 | 46–80、83–92、98–113 |
| 11 | `src/modules/hosts.js` | 主机行「⋯」与右键菜单(共用一份) | 8 项 | 375–404 |
| 12 | `src/modules/host-library.js` | 分组右键、批量「移动到分组」下拉 | 2 + 动态 | 214–222、924–941 |
| 13 | `src/modules/sftp.js` | 路径栏右键、文件面板 ⋯、书签、文件条目右键、复制目标菜单 | 2 / 4 / 动态 / 13 / 动态 | 250–257、221–230、946–962、610–643、648–660 |
| 14 | `src/modules/ai.js` | AI 模型下拉(动态模型列表 + 管理模型)、代码块 ▾ 菜单 | 动态 + 1 + 1 | 2900–2911、1199–1211 |
| 15 | `src/modules/ai-agent-ui.js` | AI 主机目标菜单(3 模式 + 清单)、执行模式菜单 | 3 + 动态 / 3 | 763–870、408–412 |
| 16 | `src/index.html` | 一级菜单容器、AI 面板 4 个下拉容器、6 个 `data-accel` 提示、设置页分栏 | — | 27、24/29/103/105/201/1128、1121–1174、413–417 |
| 17 | `src/modules/settings.js` | 设置页快捷键表(读注册表 label + keymap) | 动态 | 64–96 |
| 18 | `src-tauri/src/*.rs` | **无菜单定义**:未使用 `tauri::menu`,菜单全部由前端 `window.__TAURI__.menu` 生成 | 0 | — |
| 19 | i18n / locale 目录 | **不存在**:全库无 `i18n`/`locale` 资源,文案硬编码 | 0 | — |

## 3. 标签的显示链路(多数问题的根因)

```
entry.js  registerCommand(id, { label, kind, category })
              │
keymap.js     │  shortcut: keymap 动作名(缺省同 id)→ accelOf() → core.accel() 渲染
              ▼
commands.js  commandState(id) → labelOf()  ← 若 kind==='dialog' 且标签不以 … 结尾,自动加 '…'
              │
      ┌───────┼────────────┬───────────────┬─────────────────┐
      ▼       ▼            ▼               ▼                 ▼
 native-menu  menubar   commandMenuItem  listCommands      listCommands
 (mac 菜单)  (PC 菜单)  (右键/下拉)      (命令面板)        (设置页快捷键表)
```

- 自动追加在 `src/modules/commands.js:32-35`:`command.kind === 'dialog' && !label.endsWith('…') → label + '…'`。
- 反向剥离在 `src/modules/commands.js:95`:菜单项可传 `noEllipsis: true` 把 `…` 去掉,目前只有侧栏 ⠇ 菜单用(`src/modules/entry.js:100-109`)。
- 因为 `listCommands()` 返回的是**已追加过 `…` 的 label**(`src/modules/commands.js:72`),命令面板(`src/modules/palette.js:32`)和设置页快捷键表(`src/modules/settings.js:66,72,81`)都继承了这些 `…`——这两处点击**不会**弹出任何对话框。
- 菜单项覆盖标签的入口只有两处:`menu-spec.js` 里条目上的 `text`(目前只有「命令与快捷键…」一处,`:57`)和 `commandMenuItem(id, ctx, overrides)` 的 `overrides.label`(终端右键、标签右键、侧栏菜单在用)。**这 4 处(注册表、keymap `label`、menu-spec `text`、overrides)各存一份名字,是 §8 里"同名不同词"的直接成因。**

## 4. 盘点 A:应用菜单栏

一级菜单由 `menu-spec.js` 定结构、`entry.js` 定文案、`keymap.js` 定快捷键。「行为」列按 `run` 函数实际做的事分类(D 输入弹窗 / I 信息管理弹窗 / M 弹出菜单 / A 立即),不是按 `kind` 字段——两者不一致的地方正是 §8 的缺陷。

### macOS 菜单栏(54 项,含预定义)

| 菜单 | 标签(实际显示) | … | 行为 | 快捷键 | 定义位置 |
| --- | --- | --- | --- | --- | --- |
| NebulaShell | 关于 NebulaShell | 否 | I 弹窗(关于) | — | menu-spec.js:13 → entry.js:347 |
| NebulaShell | 设置… | **是** | D 弹窗(设置) | ⌘, | menu-spec.js:14 → entry.js:344 |
| NebulaShell | 服务 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:15 |
| NebulaShell | 隐藏 NebulaShell | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:16 |
| NebulaShell | 隐藏其他 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:16 |
| NebulaShell | 全部显示 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:16 |
| NebulaShell | 退出 NebulaShell | 否 | A/退出(活动会话时确认) | ⌘Q | menu-spec.js:17 → entry.js:349 |
| 文件 | 新建标签 | 否 | A 立即 | ⌘T | menu-spec.js:20 → entry.js:371 |
| 文件 | 重命名标签… | **是** | D 弹窗(输入框) | F2 | menu-spec.js:20 → entry.js:372 |
| 文件 | 分屏 | 否 | A 立即 | ⌘D | menu-spec.js:21 → entry.js:373 |
| 文件 | 新增文件分屏 | 否 | A 立即 | ⌘⇧E | menu-spec.js:21 → entry.js:376 |
| 文件 | 打开最近下载位置 | 否 | A 立即(Finder) | — | menu-spec.js:22 → entry.js:380 |
| 文件 | ⟨动态,见正文⟩ | 否 | A 立即(有传输时确认) | ⌘W | menu-spec.js:24 → entry.js:404 |
| 文件 | 关闭窗口 | 否 | A/关窗(系统确认) | ⌘⇧W | menu-spec.js:24 → entry.js:348 |
| 编辑 | 撤销 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:27 |
| 编辑 | 重做 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:27 |
| 编辑 | 剪切 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:28 |
| 编辑 | 拷贝 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:28 |
| 编辑 | 粘贴 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:28 |
| 编辑 | 全选 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:28 |
| 编辑 | 在终端中查找… | **是** | M 内嵌查找栏 | ⌘F | menu-spec.js:30 → entry.js:426 |
| 编辑 | 清屏 | 否 | A 立即 | ⌘K | menu-spec.js:30 → entry.js:427 |
| 编辑 | 命令历史… | **是** | I 弹窗(列表) | ⌘⇧H | menu-spec.js:31 → entry.js:424 |
| 视图 | 命令面板… | **是** | D 弹窗(命令面板) | ⌘⇧P | menu-spec.js:34 → entry.js:343 |
| 视图 | 主机侧栏 | 否 | A 开关 | ⌘B | menu-spec.js:35 → entry.js:417 |
| 视图 | AI 助手 | 否 | A 开关 | ⌥⌘B | menu-spec.js:35 → entry.js:419 |
| 视图 | 新建 AI 对话 | 否 | A 立即 | **空**(刻意) (keymap 有 ⌘N / Ctrl+Shift+N) | menu-spec.js:36 → entry.js:420 |
| 视图 | 切换思考强度 | 否 | A 立即 | **空**(刻意) (keymap 有 ⌘T / Ctrl+T) | menu-spec.js:36 → entry.js:421 |
| 视图 | 全部标签… | **是** | M 弹出列表 | ⌥⌘L | menu-spec.js:37 → entry.js:402 |
| 视图 | 标签平铺 | 否 | A 立即 | ⌥⌘T | menu-spec.js:37 → entry.js:403 |
| 视图 | 整理当前标签分屏 | 否 | A 立即 | ⌥⌘R | menu-spec.js:37 → entry.js:401 |
| 视图 | ⟨动态,见正文⟩ | 否 | A 立即 | ⌘⇧↵ | menu-spec.js:37 → entry.js:384 |
| 视图 | 紧凑列表 | 否 | A 开关 | — | menu-spec.js:38 → entry.js:481 |
| 视图 | 进入全屏 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:39 |
| 主机 | 新建主机… | **是** | D 弹窗 | ⌘⇧N | menu-spec.js:42 → entry.js:474 |
| 主机 | 从云导入… | **是** | D 弹窗 | — | menu-spec.js:42 → entry.js:475 |
| 主机 | 主机库… | **是** | I 弹窗(库) | — | menu-spec.js:43 → entry.js:479 |
| 主机 | 导入主机… | **是** | D 弹窗 | — | menu-spec.js:44 → entry.js:476 |
| 主机 | 导出主机… | **是** | D 弹窗 | — | menu-spec.js:44 → entry.js:477 |
| 主机 | 主机指纹… | **是** | I 弹窗(列表) | — | menu-spec.js:45 → entry.js:478 |
| 主机 | 端口转发… | **是** | D 弹窗 | ⌥⌘F | menu-spec.js:45 → entry.js:470 |
| 主机 | 批量执行… | **是** | D 弹窗 | — | menu-spec.js:45 → entry.js:469 |
| 会话 | 重连当前会话 | 否 | A 立即 | ⌘⇧R | menu-spec.js:48 → entry.js:428 |
| 会话 | 断开连接 | 否 | A 立即(有传输时确认) | — | menu-spec.js:48 → entry.js:430 |
| 会话 | 只读模式 | 否 | A 开关 | ⌘⇧L | menu-spec.js:49 → entry.js:432 |
| 会话 | 记录会话日志 | 否 | A 开关 | ⌘⇧J | menu-spec.js:49 → entry.js:433 |
| 会话 | 打开日志文件夹 | 否 | A 立即(Finder) | — | menu-spec.js:49 → entry.js:437 |
| 会话 | 常用命令… | **是** | I 弹窗(列表) | ⌘⇧S | menu-spec.js:50 → entry.js:425 |
| 会话 | ⟨动态,见正文⟩ | 否 | M 弹出选择菜单 | ⌘⇧G | menu-spec.js:50 → entry.js:445 |
| 会话 | AI 诊断报错 | 否 | A 立即 | ⌥⌘D | menu-spec.js:50 → entry.js:438 |
| 窗口 | 最小化 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:53 |
| 窗口 | 缩放 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:53 |
| 窗口 | 前置全部窗口 | 否 | 系统预定义(原生实现) | mac 系统键 | menu-spec.js:54 |
| 帮助 | 命令与快捷键… | **是** | D 弹窗(命令面板) | **空**(刻意) (keymap 有 ⌘⇧P / Ctrl+Shift+P) | menu-spec.js:57 → entry.js:343 |

### Windows/Linux 菜单栏(42 项,含预定义)

| 菜单 | 标签(实际显示) | … | 行为 | 快捷键 | 定义位置 |
| --- | --- | --- | --- | --- | --- |
| 文件 | 新建标签 | 否 | A 立即 | Ctrl+Shift+T | menu-spec.js:20 → entry.js:371 |
| 文件 | 重命名标签… | **是** | D 弹窗(输入框) | F2 | menu-spec.js:20 → entry.js:372 |
| 文件 | 分屏 | 否 | A 立即 | Ctrl+Shift+D | menu-spec.js:21 → entry.js:373 |
| 文件 | 新增文件分屏 | 否 | A 立即 | Ctrl+Shift+E | menu-spec.js:21 → entry.js:376 |
| 文件 | 打开最近下载位置 | 否 | A 立即(Finder) | — | menu-spec.js:22 → entry.js:380 |
| 文件 | 设置… | **是** | D 弹窗(设置) | Ctrl+, | menu-spec.js:23 → entry.js:344 |
| 文件 | ⟨动态,见正文⟩ | 否 | A 立即(有传输时确认) | Ctrl+Shift+W | menu-spec.js:24 → entry.js:404 |
| 文件 | 退出 NebulaShell | 否 | A/退出(活动会话时确认) | — | menu-spec.js:24 → entry.js:349 |
| 编辑 | 复制 | 否 | A 立即 | Ctrl+C | menu-spec.js:29 → entry.js:355 |
| 编辑 | 粘贴 | 否 | A 立即 | Ctrl+V | menu-spec.js:29 → entry.js:361 |
| 编辑 | 在终端中查找… | **是** | M 内嵌查找栏 | Ctrl+Shift+F | menu-spec.js:30 → entry.js:426 |
| 编辑 | 清屏 | 否 | A 立即 | — | menu-spec.js:30 → entry.js:427 |
| 编辑 | 命令历史… | **是** | I 弹窗(列表) | Ctrl+Shift+H | menu-spec.js:31 → entry.js:424 |
| 视图 | 命令面板… | **是** | D 弹窗(命令面板) | Ctrl+Shift+P | menu-spec.js:34 → entry.js:343 |
| 视图 | 主机侧栏 | 否 | A 开关 | Ctrl+Shift+B | menu-spec.js:35 → entry.js:417 |
| 视图 | AI 助手 | 否 | A 开关 | Ctrl+Shift+Alt+B | menu-spec.js:35 → entry.js:419 |
| 视图 | 新建 AI 对话 | 否 | A 立即 | **空**(刻意) (keymap 有 ⌘N / Ctrl+Shift+N) | menu-spec.js:36 → entry.js:420 |
| 视图 | 切换思考强度 | 否 | A 立即 | **空**(刻意) (keymap 有 ⌘T / Ctrl+T) | menu-spec.js:36 → entry.js:421 |
| 视图 | 全部标签… | **是** | M 弹出列表 | Ctrl+Shift+Alt+L | menu-spec.js:37 → entry.js:402 |
| 视图 | 标签平铺 | 否 | A 立即 | Ctrl+Shift+Alt+T | menu-spec.js:37 → entry.js:403 |
| 视图 | 整理当前标签分屏 | 否 | A 立即 | Ctrl+Shift+Alt+R | menu-spec.js:37 → entry.js:401 |
| 视图 | ⟨动态,见正文⟩ | 否 | A 立即 | Ctrl+Shift+Enter | menu-spec.js:37 → entry.js:384 |
| 视图 | 紧凑列表 | 否 | A 开关 | — | menu-spec.js:38 → entry.js:481 |
| 视图 | 全屏 | 否 | A 立即 | F11 | menu-spec.js:39 → entry.js:351 |
| 主机 | 新建主机… | **是** | D 弹窗 | Ctrl+Shift+Alt+N | menu-spec.js:42 → entry.js:474 |
| 主机 | 从云导入… | **是** | D 弹窗 | — | menu-spec.js:42 → entry.js:475 |
| 主机 | 主机库… | **是** | I 弹窗(库) | — | menu-spec.js:43 → entry.js:479 |
| 主机 | 导入主机… | **是** | D 弹窗 | — | menu-spec.js:44 → entry.js:476 |
| 主机 | 导出主机… | **是** | D 弹窗 | — | menu-spec.js:44 → entry.js:477 |
| 主机 | 主机指纹… | **是** | I 弹窗(列表) | — | menu-spec.js:45 → entry.js:478 |
| 主机 | 端口转发… | **是** | D 弹窗 | Ctrl+Shift+Alt+F | menu-spec.js:45 → entry.js:470 |
| 主机 | 批量执行… | **是** | D 弹窗 | — | menu-spec.js:45 → entry.js:469 |
| 会话 | 重连当前会话 | 否 | A 立即 | Ctrl+Shift+R | menu-spec.js:48 → entry.js:428 |
| 会话 | 断开连接 | 否 | A 立即(有传输时确认) | — | menu-spec.js:48 → entry.js:430 |
| 会话 | 只读模式 | 否 | A 开关 | Ctrl+Shift+L | menu-spec.js:49 → entry.js:432 |
| 会话 | 记录会话日志 | 否 | A 开关 | Ctrl+Shift+J | menu-spec.js:49 → entry.js:433 |
| 会话 | 打开日志文件夹 | 否 | A 立即(Finder) | — | menu-spec.js:49 → entry.js:437 |
| 会话 | 常用命令… | **是** | I 弹窗(列表) | Ctrl+Shift+S | menu-spec.js:50 → entry.js:425 |
| 会话 | ⟨动态,见正文⟩ | 否 | M 弹出选择菜单 | Ctrl+Shift+G | menu-spec.js:50 → entry.js:445 |
| 会话 | AI 诊断报错 | 否 | A 立即 | Ctrl+Shift+Alt+D | menu-spec.js:50 → entry.js:438 |
| 帮助 | 命令与快捷键… | **是** | D 弹窗(命令面板) | **空**(刻意) (keymap 有 ⌘⇧P / Ctrl+Shift+P) | menu-spec.js:57 → entry.js:343 |
| 帮助 | 关于 NebulaShell | 否 | I 弹窗(关于) | — | menu-spec.js:58 → entry.js:347 |

## 5. 盘点 B:命令注册表(标签的唯一静态来源)

下表是 `registerCommand` 的全量(含 3 条 `internal` 别名)。「标签(静态)」列是**已按 `commands.js:34` 规则追加过 `…`**、菜单里会看到的文案;kind 不是 dialog 的命令直接取自注册表原文。`⟨动态,见正文⟩` 的三条在 §8 P1-10 与 P0-4 里展开了全部取值。

| id | 标签(静态) | kind | 分类 | 键位 mac / win / linux | 行为 | 定义位置 |
| --- | --- | --- | --- | --- | --- | --- |
| `palette.open` | 命令面板… | dialog | app | ⌘⇧P / Ctrl+Shift+P / Ctrl+Shift+P | D 弹窗(命令面板) | src/modules/entry.js:343 |
| `settings.open` | 设置… | dialog | app | ⌘, / Ctrl+, / Ctrl+, | D 弹窗(设置) | src/modules/entry.js:344 |
| `app.about` | 关于 NebulaShell | action | app | — / — / — | I 弹窗(关于) | src/modules/entry.js:347 |
| `window.close` | 关闭窗口 | action | app | ⌘⇧W / — / — | A/关窗(系统确认) | src/modules/entry.js:348 |
| `app.quit` | 退出 NebulaShell | action | app | ⌘Q / — / — | A/退出(活动会话时确认) | src/modules/entry.js:349 |
| `window.fullscreen` | 全屏 | action | app | — / F11 / F11 | A 立即 | src/modules/entry.js:351 |
| `term.copy` | 复制 | action | session | ⌘C / Ctrl+C, Ctrl+Shift+C / Ctrl+Shift+C, Ctrl+C | A 立即 | src/modules/entry.js:355 |
| `term.paste` | 粘贴 | action | session | ⌘V / Ctrl+V, Ctrl+Shift+V / Ctrl+Shift+V | A 立即 | src/modules/entry.js:361 |
| `tab.new` | 新建标签 | action | layout | ⌘T / Ctrl+Shift+T / Ctrl+Shift+T | A 立即 | src/modules/entry.js:371 |
| `tab.rename` | 重命名标签… | dialog | layout | F2 / F2 / F2 | D 弹窗(输入框) | src/modules/entry.js:372 |
| `pane.split` | 分屏 | action | layout | ⌘D / Ctrl+Shift+D / Ctrl+Shift+D | A 立即 | src/modules/entry.js:373 |
| `tab.file.add` | 新增文件分屏 | action | layout | ⌘⇧E / Ctrl+Shift+E / Ctrl+Shift+E | A 立即 | src/modules/entry.js:376 |
| `files.revealLastDownload` | 打开最近下载位置 | action | app | — / — / — | A 立即(Finder) | src/modules/entry.js:380 |
| `pane.zoom` | ⟨动态,见正文⟩ | action | layout | ⌘⇧↵ / Ctrl+Shift+Enter / Ctrl+Shift+Enter | A 立即 | src/modules/entry.js:384 |
| `pane.reflow` | 整理当前标签分屏 | action | layout | ⌥⌘R / Ctrl+Shift+Alt+R / Ctrl+Shift+Alt+R | A 立即 | src/modules/entry.js:401 |
| `tabs.list` | 全部标签… | dialog | layout | ⌥⌘L / Ctrl+Shift+Alt+L / Ctrl+Shift+Alt+L | M 弹出列表 | src/modules/entry.js:402 |
| `workspace.tile` | 标签平铺 | action | layout | ⌥⌘T / Ctrl+Shift+Alt+T / Ctrl+Shift+Alt+T | A 立即 | src/modules/entry.js:403 |
| `workspace.close` | ⟨动态,见正文⟩ | action | layout | ⌘W / Ctrl+Shift+W / Ctrl+Shift+W | A 立即(有传输时确认) | src/modules/entry.js:404 |
| `panel.sidebar` | 主机侧栏 | action | panel | ⌘B / Ctrl+Shift+B / Ctrl+Shift+B | A 开关 | src/modules/entry.js:417 |
| `panel.tools` | AI 助手 | action | panel | ⌥⌘B / Ctrl+Shift+Alt+B / Ctrl+Shift+Alt+B | A 开关 | src/modules/entry.js:419 |
| `ai.newThread` | 新建 AI 对话 | action | panel | ⌘N / Ctrl+Shift+N / Ctrl+Shift+N | A 立即 | src/modules/entry.js:420 |
| `ai.cycleEffort` | 切换思考强度 | action | panel | ⌘T / Ctrl+T / Ctrl+T | A 立即 | src/modules/entry.js:421 |
| `session.history` | 命令历史… | dialog | session | ⌘⇧H / Ctrl+Shift+H / Ctrl+Shift+H | I 弹窗(列表) | src/modules/entry.js:424 |
| `tools.snippets` | 常用命令… | dialog | session | ⌘⇧S / Ctrl+Shift+S / Ctrl+Shift+S | I 弹窗(列表) | src/modules/entry.js:425 |
| `session.search` | 在终端中查找… | dialog | session | ⌘F / Ctrl+Shift+F / Ctrl+Shift+F | M 内嵌查找栏 | src/modules/entry.js:426 |
| `session.clear` | 清屏 | action | session | ⌘K / — / — | A 立即 | src/modules/entry.js:427 |
| `session.reconnect` | 重连当前会话 | action | session | ⌘⇧R / Ctrl+Shift+R / Ctrl+Shift+R | A 立即 | src/modules/entry.js:428 |
| `session.disconnect` | 断开连接 | action | session | — / — / — | A 立即(有传输时确认) | src/modules/entry.js:430 |
| `session.readonly` | 只读模式 | action | session | ⌘⇧L / Ctrl+Shift+L / Ctrl+Shift+L | A 开关 | src/modules/entry.js:432 |
| `session.log` | 记录会话日志 | action | session | ⌘⇧J / Ctrl+Shift+J / Ctrl+Shift+J | A 开关 | src/modules/entry.js:433 |
| `session.log.folder` | 打开日志文件夹 | action | session | — / — / — | A 立即(Finder) | src/modules/entry.js:437 |
| `session.diagnose` | AI 诊断报错 | action | session | ⌥⌘D / Ctrl+Shift+Alt+D / Ctrl+Shift+Alt+D | A 立即 | src/modules/entry.js:438 |
| `tools.broadcast` | ⟨动态,见正文⟩ | action | session | ⌘⇧G / Ctrl+Shift+G / Ctrl+Shift+G | M 弹出选择菜单 | src/modules/entry.js:445 |
| `tools.batch` | 批量执行… | dialog | session | — / — / — | D 弹窗 | src/modules/entry.js:469 |
| `tools.forwards` | 端口转发… | dialog | session | ⌥⌘F / Ctrl+Shift+Alt+F / Ctrl+Shift+Alt+F | D 弹窗 | src/modules/entry.js:470 |
| `host.new` | 新建主机… | dialog | host | ⌘⇧N / Ctrl+Shift+Alt+N / Ctrl+Shift+Alt+N | D 弹窗 | src/modules/entry.js:474 |
| `cloud.import` | 从云导入… | dialog | host | — / — / — | D 弹窗 | src/modules/entry.js:475 |
| `hosts.import` | 导入主机… | dialog | host | — / — / — | D 弹窗 | src/modules/entry.js:476 |
| `hosts.export` | 导出主机… | dialog | host | — / — / — | D 弹窗 | src/modules/entry.js:477 |
| `settings.fingerprints` | 主机指纹… | dialog | host | — / — / — | I 弹窗(列表) | src/modules/entry.js:478 |
| `hosts.library` | 主机库… | dialog | host | — / — / — | I 弹窗(库) | src/modules/entry.js:479 |
| `view.hostDensity` | 紧凑列表 | action | panel | — / — / — | A 开关 | src/modules/entry.js:481 |
| `panel.ai` | AI 助手 | action | panel (internal) | — / — / — | A 开关 | src/modules/entry.js:514 |
| `panel.history` | 命令历史… | dialog | panel (internal) | — / — / — | I 弹窗(列表) | src/modules/entry.js:515 |
| `panel.snippets` | 常用命令… | dialog | panel (internal) | — / — / — | I 弹窗(列表) | src/modules/entry.js:516 |

## 6. 盘点 C:右键菜单与弹出菜单(13 处)

这些菜单**不走** `menu-spec.js`,但多数项走 `commandMenuItem()`,所以标签与快捷键仍从注册表/keymap 取;`overrides` 会改写标签(这就是同名不同词的来源之一)。

### C1 终端右键菜单 — `src/modules/entry.js:55-79`(`openTermCtxMenu`,16 项)

| 标签 | … | 行为 | 快捷键 | 行 |
| --- | --- | --- | --- | --- |
| 复制 | 否 | 立即(组件内) | ⌘C / Ctrl+C | 56 |
| 粘贴 | 否 | 立即(组件内) | ⌘V / Ctrl+V | 59 |
| 全选 | 否 | 立即(组件内) | ⌘A / Ctrl+Shift+A | 60 |
| 搜索… | 是 | 内嵌查找栏(override 覆盖了「在终端中查找…」) | ⌘F / Ctrl+Shift+F | 62 |
| AI 诊断报错 | 否 | 立即(带 tips title) | ⌥⌘D | 64 |
| 清屏 | 否 | 立即 | ⌘K | 65 |
| 只读模式 | 否 | 开关 | ⌘⇧L | 66 |
| 记录会话日志 | 否 | 开关 | ⌘⇧J | 67 |
| 分屏 | 否 | 立即 | ⌘D | 69 |
| 新增文件分屏 | 否 | 立即 | ⌘⇧E | 70 |
| 放大当前窗格 | 否 | 立即 | ⌘⇧↵ | 71 |
| 关闭当前窗格 / 关闭当前标签 | 否 | 立即(danger) | ⌘W | 72 |
| 断开连接 / 重新连接 | 否 | 立即(断开在有传输时确认) | 断开无键 / 重连 ⌘⇧R | 74 |
| 广播输入… / 停止广播 | **是(仅未广播时)** | 弹出选择菜单 | ⌘⇧G | 75 |
| 端口转发… | 是 | 弹窗 | ⌥⌘F | 76 |
| 复制会话 ID | 否 | 立即 | — | 78 |

### C2 分屏下拉(`#btn-split-menu`)— `src/modules/entry.js:83-92`,菜单标题「分屏与布局」(5 项)

| 标签 | … | 行为 | 快捷键 | 行 |
| --- | --- | --- | --- | --- |
| 终端分屏(override,注册表叫「分屏」) | 否 | 立即 | ⌘D | 85 |
| 新增文件分屏 | 否 | 立即 | ⌘⇧E | 86 |
| 整理当前标签分屏 | 否 | 立即 | ⌥⌘R | 88 |
| 放大当前窗格 | 否 | 立即 | ⌘⇧↵ | 89 |
| 标签平铺 | 否 | 开关 | ⌥⌘T | 90 |

### C3 侧栏 ⠇ 主机菜单 — `src/modules/entry.js:98-113`,菜单标题「主机管理」(9 项)

| 标签 | … | 行为 | 快捷键 | 行 |
| --- | --- | --- | --- | --- |
| 从云导入(**noEllipsis**,一级菜单显示「从云导入…」) | 否 | 弹窗 | — | 100 |
| 主机管理(**noEllipsis**,注册表叫「主机库」) | 否 | 弹窗(库) | — | 102 |
| 批量执行(**noEllipsis**) | 否 | 弹窗 | — | 103 |
| 导入主机(**noEllipsis**) | 否 | 弹窗 | — | 105 |
| 导出主机(**noEllipsis**) | 否 | 弹窗 | — | 106 |
| 主机指纹(**noEllipsis**) | 否 | 弹窗(列表) | — | 108 |
| 端口转发规则(**noEllipsis**,注册表叫「端口转发」) | 否 | 弹窗 | ⌥⌘F | 109 |
| 紧凑列表 | 否 | 开关 | — | 111 |

### C4 标签右键菜单 — `src/modules/terminal.js:92-114`(8 项)

| 标签 | … | 行为 | 快捷键 | 行 |
| --- | --- | --- | --- | --- |
| 关闭标签 | 否 | 立即(danger,不走 `workspace.close`) | ⌘W | 99 |
| 关闭其他标签 | 否 | 立即 | — | 100 |
| 关闭右侧标签 | 否 | 立即 | — | 101 |
| 重命名… | 是 | 弹窗(输入框) | F2 | 103 |
| 复制主机地址 | 否 | 立即 | — | 105 |
| 新增文件分屏 | 否 | 立即 | ⌘⇧E | 111 |
| 新建标签 | 否 | 立即 | ⌘T | 113 |

> 注:「关闭标签」这一项**没有**用 `workspace.close` 命令,而是直接 `closeTab(tabId)` 却手工挂了 `accelOf('workspace.close')` 的 ⌘W;同一语义在两处实现(命令 + 直接调用),改文案时容易只改一处。

### C5 全部标签列表 — `src/modules/terminal.js:174-189`(`tabListItems`,每标签一项)

动态项:标签标题 + `checked` 勾选当前标签。菜单标题「全部标签」(`terminal.js:188`),而命令标签是「全部标签…」(`entry.js:402`)——**同一表面两个写法**。

### C6 主机行「⋯」/ 右键 — `src/modules/hosts.js:375-404`(一份菜单两处入口,9 项)

| 标签 | … | 行为 | 行 |
| --- | --- | --- | --- |
| 连接 | 否 | 立即(**与下一项完全相同**) | 380 |
| 在新标签连接 | 否 | 立即 | 381 |
| 切换到已有标签(仅有会话时) | 否 | 立即 | 382 |
| 标记为常用 / 取消常用 | 否 | 立即 | 384 |
| 编辑… | 是 | 弹窗 | 385 |
| 克隆 | 否 | 立即 | 386 |
| 复制 user@host | 否 | 立即 | 387 |
| 删除… | 是 | 确认弹窗 | 391 |

### C7 分组右键 — `src/modules/host-library.js:218-221`(2 项)

「重命名…」「删除分组…」,均打开输入/确认弹窗,省略号正确。

### C8 批量「移动到分组」— `src/modules/host-library.js:924-941`

动态:真实分组各一项 + 「＋ 新建分组并移入…」(`:935`)。标题「移动到分组」。

### C9 文件路径栏右键 — `src/modules/sftp.js:250-257`(2 项)

「收藏当前目录 / 取消收藏当前目录」「复制当前路径」,均立即执行,无省略号(正确)。

### C10 文件面板 ⋯ — `src/modules/sftp.js:221-230`(4 项,标题「文件操作」)

| 标签 | … | 行为 | 行 |
| --- | --- | --- | --- |
| 前进(仅按钮被收起时出现) | 否 | 立即 | 225 |
| 新建文件夹 | **否(但会打开行内输入框)** | 进入输入态 | 226 |
| 全选 / 全不选 | 否 | 立即 | 227 |
| 反选 | 否 | 立即 | 228 |

### C11 书签下拉 — `src/modules/sftp.js:946-962`

动态:书签项(带 `checked`,`:956`)、「全部书签(N)…」(`:959`)、「管理书签…」(`:960`);空态「还没有书签」、未连接态「未连接主机」、加载态「正在读取书签…」。

### C12 文件条目右键 — `src/modules/sftp.js:625-642`(最多 13 项)

| 标签(单条目 / 多选) | … | 行为 | 行 |
| --- | --- | --- | --- |
| 打开目录(仅目录) | 否 | 立即 | 627 |
| 下载… / 下载(N 项)… | 是 | 选目标(save dialog / 目录选择) | 628 |
| 复制到… / 复制到…(N 项) | 是 | 选会话 + 输入目录 | 630 |
| 创建副本(仅单条目、非目录) | 否 | 立即 | 631 |
| 重命名… | 是 | 行内输入 | 633 |
| 权限… | 是 | 行内输入 | 634 |
| 全选(⌘A 范围内) | 否 | 立即(**快捷键写进了标签**) | 635 |
| 反选 | 否 | 立即 | 636 |
| 复制名称 | 否 | 立即 | 638 |
| 复制完整路径 | 否 | 立即 | 639 |
| 删除文件 / 删除目录 / 删除(N 项) | 否 | 立即(danger) | 641 |

### C13 「复制到…」目标菜单 — `src/modules/sftp.js:648-660`

动态:每个已连接会话一项(`:653`,标签 `主机名 · user@host:port`)+ 分隔线 + 「取消」(`:658`)。

## 7. 盘点 D:AI 面板菜单、标题栏按钮、设置页

这些也是"功能菜单"的一部分(用户点开就有条目可选),但条目多为动态数据,静态文案如下。

| 表面 | 定义位置 | 静态文案 | 动态内容 |
| --- | --- | --- | --- |
| AI 模型下拉 | `src/index.html:1121-1155`,`ai.js:2900-2911` | 「管理模型」(`index.html:1154`)、分区标题「思考强度」(`:1125`)、`<kbd>` 快捷键徽标(`:1128`,`data-accel="ai.cycleEffort"`) | 模型名 + `✓` |
| AI 对话下拉 | `src/index.html:1157-1159` | 无静态项 | 对话标题 |
| AI 主机目标下拉 | `src/index.html:1162-1165`,`ai-agent-ui.js:763-870` | 「对话模式」(`:832`)、「跟随命令窗口」(`:838`)、「多主机模式」(`:842`)、页脚「已链接 N 台主机 / 未链接主机」(`:1070`) | 主机清单 + 搜索 |
| AI 执行模式下拉 | `src/index.html:1168-1174`,`ai-agent-ui.js:408-412` | 「手动确认」「自动执行」「完全托管」+ 各自说明;头部主机摘要;`?` 帮助浮层 | 本会话授权行(`renderGrants`) |
| AI 代码块「更多命令操作」(`<details>` 下拉,不是 `showCtxMenu`) | `src/modules/ai.js:1199-1211` | 工具栏「复制」「执行」;`▾` 下拉里一项「仅填入终端」;`summary` 的 aria-label 是「更多命令操作」 | 每个代码块一份 |
| 标题栏 6 个带键提示的按钮 | `src/index.html:24,29,103,105,201,1128` | 「主机侧栏(⌘B)」「右侧工具栏(⌥⌘B)」「新建标签页(⌘T)」「分屏(自动最优布局)(⌘D)」「新建对话(⌘N)」+ 思考强度 `<kbd>` | — |
| 设置页分栏 | `src/index.html:413-417` | 「终端」「AI」「云账号」「会话日志」「快捷键」 | — |
| 设置页快捷键表 | `src/modules/settings.js:64-96` | 表头「操作 / 快捷键 / 恢复默认」;正文 `Esc` 取消、`Backspace` 恢复默认(`index.html:579`) | 45 行,标签取自 `listCommands()`,键位取自 `specsOf()` |

## 8. Problems found

分类:`P0` = 会直接导致重排后仍然错、必须先定规则;`P1` = 明确的用户可见缺陷;`P2` = 体验债务/记录项。
省略号规则的两面我按「`…` 只用于**会向用户要输入**的动作」来判;纯信息弹窗(关于/历史/指纹)归为「可带可不带,但必须**全场统一**」,当前不统一。

### P0

**P0-1 同一动作在不同菜单一次带 `…`、一次不带(7 条命令)。**
`src/modules/commands.js:95` 提供 `noEllipsis` 把自动追加的 `…` 再去掉,`src/modules/entry.js:100-109` 对 7 个 dialog 命令用了它。结果:

| 命令 | 一级菜单(带 …) | 侧栏 ⠇ 菜单(不带) |
| --- | --- | --- |
| `cloud.import` | 从云导入…(`menu-spec.js:42`) | 从云导入(`entry.js:100`) |
| `hosts.library` | 主机库…(`menu-spec.js:43`) | 主机管理(`entry.js:102`) |
| `tools.batch` | 批量执行…(`menu-spec.js:45`) | 批量执行(`entry.js:103`) |
| `hosts.import` | 导入主机…(`menu-spec.js:44`) | 导入主机(`entry.js:105`) |
| `hosts.export` | 导出主机…(`menu-spec.js:44`) | 导出主机(`entry.js:106`) |
| `settings.fingerprints` | 主机指纹…(`menu-spec.js:45`) | 主机指纹(`entry.js:108`) |
| `tools.forwards` | 端口转发…(`menu-spec.js:45`) | 端口转发规则(`entry.js:109`) |

**P0-2 不是弹窗的动作被追加了 `…`(kind 用错)。**
- `tabs.list` 声明 `kind: 'dialog'`(`entry.js:402`),实际是弹出一个**列表菜单**(`terminal.js:183-188` 调 `showCtxMenu`),菜单被点掉即消失,没有对话框。显示为「全部标签…」。
- `session.search` 声明 `kind: 'dialog'`(`entry.js:426`),实际只展开终端内嵌查找栏(`terminal.js:2861-2864` 操作 `#term-search`)。显示为「在终端中查找…」。若按"需要输入"的规则保留 `…` 也说得过去,但必须与同类(内嵌输入)统一——目前 C10 的「新建文件夹」是不带 `…` 的。

**P0-3 打开弹窗却没有 `…`,而且 `kind` 不是 `dialog`。**
`app.about`(`entry.js:347`)→ `openAbout()` → `openModal('#modal-about')`(`entry.js:204`),但标签「关于 NebulaShell」无 `…`。同类信息弹窗的 `hosts.library`/`settings.fingerprints`/`session.history` 都有 `…`。要么四者都带,要么都不带,不能混。命令面板里的表现也一样(`palette.js:32`)。

**P0-4 `tools.broadcast` 把 `…` 写死在文案里,且随状态漂移。**
`entry.js:445-449`:未广播时返回「广播输入…」,广播中返回「停止广播」,显式目标下返回「退出广播 / 加入广播」;`kind` 却是 `'action'`。结果:**同一个菜单项,打开选择菜单时带 `…`,执行后不带**。`keymap.js:69` 的动作名又是「广播输入」(第三个写法)。

**P0-5 `…` 泄漏到命令面板和设置页快捷键表。**
`listCommands()` 返回的是 `commandState()` 处理过的 label,已含 `…`(`commands.js:72`)。于是:
- 命令面板每行显示「命令面板…」「设置…」「主机库…」「导入主机…」等 16 条带 `…` 的条目(15 条 dialog + `tools.broadcast` 的动态标签)(`palette.js:32`),而面板项点击**就是**执行命令,不存在"还要再确认一层"的语义。
- 设置页快捷键表把同一批 label 用作行名(`settings.js:66,72,81`),表里点一下只是开始录制键位,却显示「设置…」「命令历史…」。
macOS/Windows 的菜单栏是唯一应当出现 `…` 的地方,这两处都应剥掉。

**P0-6 同一个动作有 8 组不同名字(跨 4 个存储位置)。**
| 动作 | 写法 A | 写法 B | 写法 C |
| --- | --- | --- | --- |
| 主机库弹窗 | 主机库(`entry.js:479`)/ 主机库…(菜单) | 主机管理(`entry.js:102`) | 主机管理(`entry.js:506` 下拉标题) |
| 端口转发弹窗 | 端口转发(`entry.js:470`) | 端口转发规则(`entry.js:109`) | 端口转发…(菜单) |
| 终端内查找 | 在终端中查找(`entry.js:426`) | 搜索…(`entry.js:62`) | 在终端中搜索(`keymap.js:28`) |
| 重连 | 重连当前会话(`entry.js:428`) | 重新连接(`entry.js:74`) | 重连当前会话(`keymap.js:65`) |
| 新建标签 | 新建标签(`entry.js:371`) | 新建标签页(`keymap.js:26`) | 新建标签页(`index.html:103` title) |
| 分屏 | 分屏(`entry.js:373`) | 终端分屏(`entry.js:85`) | 分屏(自动最优布局)(`index.html:105` title / `keymap.js:29`) |
| AI 面板开关 | AI 助手(`entry.js:419`) | 右侧工具栏(`index.html:29`) | — |
| 广播 | 广播输入…(`entry.js:448`) | 广播输入(`keymap.js:69`) | 停止广播/加入广播/退出广播(同函数) |

### P1

**P1-1 「连接」与「在新标签连接」是两个菜单项、一个行为。** `hosts.js:380` 与 `hosts.js:381` 调用完全相同:`connectHost(h.id, null, { newTab: true })`。用户看不出区别,点了也没区别。

**P1-2 批量项的后缀位置不一致(同一个文件里三种写法)。** `sftp.js:628` `下载(3 项)…`(计数在 `…` 前)、`sftp.js:630` `复制到…(3 项)`(计数在 `…` 后)、`sftp.js:641` `删除(3 项)`(无 `…`);书签又是 `全部书签(12)…`(`sftp.js:959`)。

**P1-3 「新建文件夹」缺 `…`,但同样会进入输入态。** `sftp.js:226`(菜单项)与 `sftp.js:231-241`(点开 `#fp-mkdir-row` 输入框);同面板的「重命名…」「权限…」(`sftp.js:633-634`)是同一套行内输入却带 `…`。

**P1-4 `⌘T` 被两个动作占用,而应用的冲突检测看不到。** `keymap.js:26` `tab.new`(全局)与 `keymap.js:49` `ai.cycleEffort`(面板作用域)都是 `cmd+T`;`findKeyConflicts()` 按作用域分组(`keymap.js:317-333`,`bindingScope()` 在 `:338`),面板与全局不同组,所以设置页**不报冲突**,但两行都显示 `⌘T`。实际行为:AI 面板获得焦点时按 ⌘T 不会新建标签,而是切思考强度。

**P1-5 键位存在、菜单刻意不显示,但面板里又显示。** `menu-spec.js:36` 给 `ai.newThread`(⌘N)、`ai.cycleEffort`(⌘T)设了 `accelerator: false`;同时 AI 面板的按钮 title(`index.html:201` `新建对话(⌘N)`)和思考强度徽标(`index.html:1128` `data-accel="ai.cycleEffort"`)把同一个键位显示出来。**同一键位,菜单里没有、面板里有。**

**P1-6 命令面板的 `⌘↵` 不在 keymap 里。** `palette.js:120`(主机行尾「↵ 连接　⌘↵ 新标签」)与 `palette.js:215`(页脚)直接用 `accel('cmd+Enter')` 渲染;真正的绑定是 `palette.js:223-227` 里手写的 `newTabModifier`,不经 keymap。后果:不可改键、不进冲突检测、设置页看不到、跨平台文案靠 `IS_MAC` 三元手写。

**P1-7 Windows/Linux 的「编辑」菜单缺一整组项。** `menu-spec.js:27-29` 的撤销/重做/剪切/拷贝/粘贴/全选全是 `pre()`(内部固定 `only: 'mac'`),PC 侧只剩复制/粘贴/查找/清屏/历史。于是 PC 的编辑菜单里没有「全选」,用户只能用终端右键菜单里的「全选」(`entry.js:60`,组件内直调,不经命令表);命令 `term.selectAll`(`keymap.js:38`,PC `Ctrl+Shift+A`)本身没有任何菜单项。

**P1-8 三个键位在一级菜单里没有入口,只能靠设置页发现。** `keymap-audit.mjs` 用 `menuCommandIds()` 反查:`tab.switch`(`keymap.js:31`,⌘1..9)、`files.selectAll`(`:32`,⌘A)、`term.selectAll`(`:38`,⌘A / Ctrl+Shift+A)。`term.selectAll` 在终端右键菜单里有「全选」一项(`entry.js:60`),只是不走命令表;`files.selectAll` 只在文件条目右键的批量项里以括号形式露过一次(`sftp.js:635`);`tab.switch`(`bindingScope` 归 global)则完全没有任何入口。

**P1-9 标签名与行为不符 / 含糊。**
- 「紧凑列表」(`entry.js:482`):是个带 `✓` 的开关,名字读起来像一次性命令,也没说会切到「紧凑」还是「舒适」。
- 「打开最近下载位置」(`entry.js:380`):位置指什么(文件所在目录?下载目录?)不明确,实际是"在文件夹中显示最近下载的那一项"(`file-transfer.js:147`)。
- 「AI 诊断报错」(`entry.js:438`):名词化,不像动作;同族动作都是动词开头。
- 「记录会话日志」(`entry.js:433`):是开关(带 `✓`,`checked`),名字却是纯动作,收起态读不出"已在记录"。

**P1-10 两个动态标签在同一动作内措辞漂移。**
- `pane.zoom`(`entry.js:384-388`):显式目标时「放大该窗格」/「还原分屏布局」,无目标时「放大当前窗格」——"该/当前"混用,且「还原分屏布局」比「还原窗格」冗长。
- `workspace.close`(`entry.js:404-409`):四种写法「关闭该窗格 / 关闭标签 / 关闭当前窗格 / 关闭当前标签」。

**P1-11 `category` 与所在菜单不一致(命令面板分组会跟菜单分组打架)。**
- `tools.batch` 分类 `session`(`entry.js:469`),却挂在「主机」菜单(`menu-spec.js:45`)与侧栏主机菜单(`entry.js:103`)。
- `view.hostDensity` 分类 `panel`(`entry.js:482`),却挂在「视图」菜单(`menu-spec.js:38`)。
- `files.revealLastDownload` 分类 `app`(`entry.js:380`),却挂在「文件」菜单(`menu-spec.js:22`)。
命令面板按 `category` 分组(`palette.js:15,30-39`),所以同一个功能在菜单栏和面板里落在不同分组。

**P1-12 同一功能在 mac 与 PC 落在不同菜单。**
- `settings.open`:`menu-spec.js:14`(mac,应用菜单)vs `:23`(PC,文件菜单)。
- `app.about`:`menu-spec.js:13`(mac,应用菜单)vs `:58`(PC,帮助菜单)。
这是平台惯例差异,但重排时需要明确"以哪一侧为准",否则改名表会出现两套结构。

### P2

**P2-1 `F2` 作为 macOS 快捷键**(`keymap.js:60`):笔记本上要按 `Fn+F2`,与项目自己的"mac 用 ⌘ 组合"约定(`keymap.js:10-11`)不符。

**P2-2 标题双括号。** `index.html:105` `data-title="分屏(自动最优布局)(%1)"` → 实际显示「分屏(自动最优布局)(⌘D)」。

**P2-3 分组标题与项名重复。** 侧栏下拉标题「主机管理」里有一项也叫「主机管理」(`entry.js:506` vs `:102`);分屏下拉标题「分屏与布局」里的第一项叫「终端分屏」(`entry.js:85`)。

**P2-4 条件性确认没有 `…`(记录,不建议当缺陷改)。** 「断开连接」(`entry.js:430`)、「关闭窗口」(`entry.js:348`)、「退出 NebulaShell」(`entry.js:349`)在"有传输/有会话"时会弹确认(`file-transfer.js:761`、`entry.js:286`),但四个状态里三个没有 `…`。这类确认是**安全提示**而非"要用户填什么",按 macOS 惯例不加 `…` 是对的;写在这里只是提醒改名时别顺手加上。

**P2-5 没有 i18n/locale 层,一个名字存 4 份。** 注册表 label(`entry.js`)、keymap label(`keymap.js`)、`menu-spec` 的 `text`(`:57`)、菜单 override(`entry.js:85,102,109`、`terminal.js:103`)各一份,HTML title 再一份(`index.html:24,29,103,105,201`)。改一次名要动 2–5 个文件,这是 P0-6 的结构性原因。

**P2-6 AI 主机目标菜单三模式命名不成套。** 「对话模式」「跟随命令窗口」「多主机模式」(`ai-agent-ui.js:832,838,842`):两个带「模式」后缀、中间那个是动词短语。

## 9. 快捷键总表与冲突分析

渲染唯一实现:`src/modules/core.js:123` `accel()`;符号表 `MAC_KEY`/`PC_KEY` 在 `:118-119`;**界面文案禁止写死 `⌘` 已有回归测试**(`tests/keymap.test.mjs:239-259`)。因此"`Ctrl+S` / `⌘S` / `Ctrl + S` 混用"这一类问题在当前代码里**不存在**,唯一的不一致是 `F2` 这类非符号键与"同一键位挂两个动作"。

**同作用域冲突:0 条。** **跨作用域同键:2 条**(`⌘T`/`Ctrl+T` 的 `tab.new` vs `ai.cycleEffort`;`⌘A` 的 `term.selectAll` vs `files.selectAll`,后者是设计如此)。`⌘T` 见 P1-4。

| 动作 | keymap 标签 | macOS | Windows | Linux | 菜单里出现的位置 |
| --- | --- | --- | --- | --- | --- |
| `tab.new` | 新建标签页 | ⌘T | Ctrl+Shift+T | Ctrl+Shift+T | 文件 |
| `workspace.close` | 关闭当前窗格或标签 | ⌘W | Ctrl+Shift+W | Ctrl+Shift+W | 文件 |
| `session.search` | 在终端中搜索 | ⌘F | Ctrl+Shift+F | Ctrl+Shift+F | 编辑 |
| `pane.split` | 分屏(自动最优布局) | ⌘D | Ctrl+Shift+D | Ctrl+Shift+D | 文件 |
| `pane.zoom` | 放大/还原当前窗格 | ⌘⇧↵ | Ctrl+Shift+Enter | Ctrl+Shift+Enter | 视图 |
| `tab.switch` | 切换到第 N 个标签 | ⌘1..9 | Ctrl+1..9 | Ctrl+1..9 | **无** |
| `files.selectAll` | 全选(焦点文件分屏内) | ⌘A | Ctrl+A | Ctrl+A | **无** |
| `term.copy` | 复制 | ⌘C | Ctrl+C, Ctrl+Shift+C | Ctrl+Shift+C, Ctrl+C | 编辑(PC) |
| `term.paste` | 粘贴 | ⌘V | Ctrl+V, Ctrl+Shift+V | Ctrl+Shift+V | 编辑(PC) |
| `term.selectAll` | 全选 | ⌘A | Ctrl+Shift+A | Ctrl+Shift+A | **无** |
| `palette.open` | 命令面板 | ⌘⇧P | Ctrl+Shift+P | Ctrl+Shift+P | 视图 / 帮助(不显示键) |
| `settings.open` | 设置 | ⌘, | Ctrl+, | Ctrl+, | 应用菜单(mac)/ 文件(PC) |
| `session.clear` | 清屏 | ⌘K | — | — | 编辑 |
| `panel.sidebar` | 主机侧栏 | ⌘B | Ctrl+Shift+B | Ctrl+Shift+B | 视图 |
| `panel.tools` | AI 助手 | ⌥⌘B | Ctrl+Shift+Alt+B | Ctrl+Shift+Alt+B | 视图 |
| `ai.newThread` | 新建 AI 对话 | ⌘N | Ctrl+Shift+N | Ctrl+Shift+N | 视图(**不显示键**) |
| `ai.cycleEffort` | 切换思考强度 | ⌘T | Ctrl+T | Ctrl+T | 视图(**不显示键**) |
| `session.history` | 命令历史 | ⌘⇧H | Ctrl+Shift+H | Ctrl+Shift+H | 编辑 |
| `tools.snippets` | 常用命令 | ⌘⇧S | Ctrl+Shift+S | Ctrl+Shift+S | 会话 |
| `window.fullscreen` | 全屏 | —(系统 ⌃⌘F) | F11 | F11 | 视图(PC) |
| `host.new` | 新建主机 | ⌘⇧N | Ctrl+Shift+Alt+N | Ctrl+Shift+Alt+N | 主机 |
| `tab.rename` | 重命名标签 | F2 | F2 | F2 | 文件 |
| `tab.file.add` | 新增文件分屏 | ⌘⇧E | Ctrl+Shift+E | Ctrl+Shift+E | 文件 |
| `tabs.list` | 全部标签 | ⌥⌘L | Ctrl+Shift+Alt+L | Ctrl+Shift+Alt+L | 视图 |
| `workspace.tile` | 标签平铺 | ⌥⌘T | Ctrl+Shift+Alt+T | Ctrl+Shift+Alt+T | 视图 |
| `pane.reflow` | 整理当前标签分屏 | ⌥⌘R | Ctrl+Shift+Alt+R | Ctrl+Shift+Alt+R | 视图 |
| `session.reconnect` | 重连当前会话 | ⌘⇧R | Ctrl+Shift+R | Ctrl+Shift+R | 会话 |
| `session.readonly` | 只读模式 | ⌘⇧L | Ctrl+Shift+L | Ctrl+Shift+L | 会话 |
| `session.log` | 记录会话日志 | ⌘⇧J | Ctrl+Shift+J | Ctrl+Shift+J | 会话 |
| `session.diagnose` | AI 诊断报错 | ⌥⌘D | Ctrl+Shift+Alt+D | Ctrl+Shift+Alt+D | 会话 |
| `tools.broadcast` | 广播输入 | ⌘⇧G | Ctrl+Shift+G | Ctrl+Shift+G | 会话 |
| `tools.forwards` | 端口转发 | ⌥⌘F | Ctrl+Shift+Alt+F | Ctrl+Shift+Alt+F | 主机 |
| `window.close` | 关闭窗口 | ⌘⇧W | — | — | 文件(mac) |
| `app.quit` | 退出 | ⌘Q | — | — | 应用菜单(mac)/ 文件(PC) |

> 有键位但没有一级菜单入口的 3 条(§P1-8)在表里标了「无」;有菜单项但**没有键位**的 11 条:`app.about`、`cloud.import`、`files.revealLastDownload`、`hosts.export`、`hosts.import`、`hosts.library`、`session.disconnect`、`session.log.folder`、`settings.fingerprints`、`tools.batch`、`view.hostDensity`。

## 10. 已核对、确认没有问题的部分(完备性)

- **快捷键书写格式统一**:全部走 `accel()`(`core.js:123`),mac 出 `⌘⇧⌥` 且不加连接符,PC 出 `Ctrl+Shift+Alt+` 带 `+`。没有发现 `Ctrl + S`、`⌘S` 手写变体;`tests/keymap.test.mjs:239` 还有一条回归测试专门拦"UI 文案写死 ⌘"。
- **没有用三点省略号 `...` 当省略号**:全库 label 里 0 处,唯一出现 `...` 的地方是 `core.js:152` 的注释。
- **所有弹出菜单共用一套渲染与交互**:`core.showCtxMenu()`(`core.js:603`)统一处理分隔线、勾选、禁用原因、键盘导航、焦点归还;13 处菜单都没有各写一套。
- **没有 Rust 侧菜单定义**:`src-tauri/src/` 未出现 `tauri::menu` / `MenuItem` / `Submenu`,菜单完全由前端经 `window.__TAURI__.menu` 生成(`native-menu.js:42-71`),所以"改菜单"只需改前端。
- **没有 i18n/locale 资源**:不存在需要同步的翻译文件(这也是 P2-5 的另一面)。
- **核对过、确认不属于"菜单项"的界面**(避免遗漏误判):主机表单的标签/跳板自动补全面板(`hosts.js:545-620`、`:745-780`,数据选择器)、命令历史/常用命令弹窗内的列表(`tools.js:487`、`monitor.js:106`)、监控与挂载卡(`monitor.js`、`rail-cards.js`)、云账号列表(`cloud.js`)、设置页各分栏表单、欢迎页的按钮组(`index.html` 的 `#welcome`)。这些都没有"菜单项 + 快捷键 + 省略号"三元组。
- **e2e 未断言菜单文案**:`e2e/ui.e2e.mjs` 没有调用 `menubarSnapshot()` / `nativeMenuSnapshot()` / `paletteSnapshot()`,单测里也没有真实标签断言(用的是合成命令,`tests/interaction-ux.test.mjs:558`)。**结论:重命名标签不会红测试,但命令 id 不能改**(keymap 动作名缺省就是命令 id,见 `commands.js:70` 与 `keymap.js:117`)。

## 11. 给下游(命名规范 / 改名)的硬约束

1. **只改名字,别改 id**:`command id` 同时是 keymap 动作名(`commands.js:70`,`keymap.js` 全表以 id 作键),改 id 等于改键位表、设置页覆盖项与用户已保存的自定义键位。
2. **一处定义、五处引用**:注册表 label(`entry.js`)、keymap label(`keymap.js`)、`menu-spec` 的 `text`、菜单 override(`entry.js:85,102,109`、`terminal.js:103`)、HTML `title`(`index.html:24,29,103,105,201`)。改名表必须覆盖这 5 处,否则就是 P0-6 的复现。
3. **省略号只在渲染层决定,不进数据**:改法是删掉 `commands.js:95` 的 `noEllipsis` 分支与 `entry.js:100-109` 的用法,并让 `listCommands()`(`commands.js:65`)、`palette.js:32`、`settings.js:66-81` 用不带 `…` 的裸标签;**不要**在 label 文案里手写 `…`(P0-4 就是手写导致的)。
4. **`kind` 必须与行为一致**:`tabs.list` / `session.search` 要么改成非 dialog,要么把弹出的东西真的做成弹窗;`app.about` 若要带 `…` 必须改成 `kind: 'dialog'`。
5. **`⌘T` 必须解掉**(P1-4):`ai.cycleEffort` 换键,或把它并入 `ai.newThread` 的组合键族;改完跑 `findKeyConflicts()` 应仍为 0,且跨作用域同键应为 1(`⌘A` 的终端/文件分屏)。
6. **命令面板的 `⌘↵` 要进 keymap**(P1-6),否则它永远是"看不见的快捷键"。
7. **PC 的「编辑」菜单要补齐**(P1-7),至少 `term.selectAll`;否则 `Ctrl+Shift+A` 只能靠设置页发现。

## 附录 A:生成脚本(一次性工具,随文档保存在此,便于复核与重跑)

三个脚本按顺序跑即可复现 §4/§5/§9 的全部表格与结论:

```bash
cd <repo>                      # ~/Desktop/work/NebulaShell/code
OUT=/tmp node extract-menus.mjs .        # → /tmp/commands-raw.json(45 条命令)
node keymap-audit.mjs .                  # → 键位冲突 / 可达性报告(§9)
node gen-inventory.mjs .                 # → inventory.md(§4/§5 表格)
```

`gen-inventory.mjs` 需要 `commands-raw.json` 与它同目录(工作目录)。脚本只读源码,不改任何文件。

### A1 `extract-menus.mjs`(抽取 `registerCommand`)

```js
// 静态提取 registerCommand(...) 的 id / label / kind / category / shortcut,带 file:line。
// 只做文本扫描 + 括号配平(尊重字符串与注释),不引入解析器。
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const files = fs.readdirSync(path.join(root, 'src/modules')).filter((f) => f.endsWith('.js') && !f.includes('.test.'));

function stripMask(src) {
  // 与源码等长,注释/字符串内容替换成空格,保留换行;用于括号匹配与顶层冒号查找
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === q) { j++; break; } j++; }
      blank(i + 1, j - 1);
      i = j; continue;
    }
    i++;
  }
  return out.join('');
}

function lineOf(src, idx) { let l = 1; for (let i = 0; i < idx; i++) if (src[i] === '\n') l++; return l; }

function matchObject(masked, openIdx) {
  // openIdx 指向 '{'
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function topKeys(raw, masked, start, end) {
  // 对象字面量顶层 key: value 的 value 起止位置
  const res = {};
  let depth = 0;
  let i = start + 1;
  let keyStart = -1;
  const flush = (from, to) => {
    const seg = raw.slice(from, to);
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg);
    if (!m) return;
    res[m[1]] = { text: seg.slice(m[0].length).trim(), start: from + m[0].length, end: to };
  };
  let segStart = i;
  for (; i < end; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { flush(segStart, i); segStart = i + 1; }
  }
  flush(segStart, end);
  return res;
}

const rows = [];
for (const f of files) {
  const full = path.join(root, 'src/modules', f);
  const src = fs.readFileSync(full, 'utf8');
  const masked = stripMask(src);
  const re = /registerCommand\(/g;
  let m;
  while ((m = re.exec(masked))) {
    const openParen = m.index + m[0].length - 1;
    // 收集参数:( id , { ... } )
    let depth = 0, closeParen = -1;
    for (let i = openParen; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { closeParen = i; break; } }
    }
    if (closeParen < 0) continue;
    const argsRaw = src.slice(openParen + 1, closeParen);
    const argsMasked = masked.slice(openParen + 1, closeParen);
    const idM = /^\s*'([^']+)'/.exec(argsRaw) || /^\s*"([^"]+)"/.exec(argsRaw);
    const id = idM ? idM[1] : '?';
    // 对象起点:参数中第一个 '{'
    let objStart = -1, d2 = 0;
    for (let i = 0; i < argsMasked.length; i++) {
      const c = argsMasked[i];
      if (c === '(' || c === '[') d2++;
      else if (c === ')' || c === ']') d2--;
      else if (c === '{' && d2 === 0) { objStart = openParen + 1 + i; break; }
    }
    if (objStart < 0) continue;
    const objEnd = matchObject(masked, objStart);
    const keys = topKeys(src, masked, objStart, objEnd);
    const line = lineOf(src, m.index);
    rows.push({
      file: `src/modules/${f}`,
      line,
      id,
      label: (keys.label?.text || '').replace(/\s+/g, ' ').trim(),
      kind: (keys.kind?.text || '').replace(/\s+/g, ' ').trim(),
      category: (keys.category?.text || '').replace(/\s+/g, ' ').trim(),
      shortcut: (keys.shortcut?.text || '').replace(/\s+/g, ' ').trim(),
      internal: (keys.internal?.text || '').trim(),
    });
  }
}
fs.writeFileSync(path.join(process.env.OUT || '.', 'commands-raw.json'), JSON.stringify(rows, null, 2));
console.log(rows.length + ' registerCommand calls');
for (const r of rows) console.log(`${r.file}:${r.line}\t${r.id}\tkind=${r.kind || '-'}\tcat=${r.category}\t${r.label.slice(0, 120)}`);
```

### A2 `keymap-audit.mjs`(键位冲突与可达性)

```js
// 键位冲突 + 菜单可达性分析:读 keymap.js 的 DEFAULT_KEYMAP 文本求值,读 menu-spec.js 求值。
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const code = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function evalLiteral(src, anchor) {
  const start = src.indexOf(anchor) + anchor.length;
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const text = src.slice(src.indexOf('{', start), i + 1);
  const pc = (spec) => ({ win: spec, linux: spec });
  // eslint-disable-next-line no-new-func
  return new Function('pc', `return (${text});`)(pc);
}

const keymap = evalLiteral(code('src/modules/keymap.js'), 'export const DEFAULT_KEYMAP =');
const menuMod = await import('file://' + path.join(root, 'src/shared/menu-spec.js'));
const { MENU_SPEC, specFor, menuCommandIds } = menuMod;

const COMPONENT = ['term.copy', 'term.paste', 'term.selectAll', 'files.selectAll'];
const MENU_ONLY = ['window.close', 'app.quit'];
const PANEL_SCOPED = ['ai.newThread', 'ai.cycleEffort'];
const scopeOf = (id) => COMPONENT.includes(id)
  ? (id.startsWith('term.') ? 'terminal' : 'files')
  : PANEL_SCOPED.includes(id) ? 'panel' : 'global';

const platforms = { mac: 'mac', win: 'win', linux: 'linux' };
const sig = (spec) => spec.split('+').map((s) => s.trim().toLowerCase()).sort().join('+');

for (const plat of Object.keys(platforms)) {
  const owners = new Map();
  const rows = [];
  for (const [id, def] of Object.entries(keymap)) {
    const raw = def[plat];
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
    for (const spec of list) rows.push({ id, spec, scope: scopeOf(id), key: sig(spec) });
  }
  console.log(`\n===== ${plat} : ${rows.length} bindings =====`);
  for (const r of rows) {
    const k = r.scope + '|' + r.key;
    if (!owners.has(k)) owners.set(k, []);
    owners.get(k).push(r);
  }
  for (const [k, list] of owners) {
    if (list.length > 1) {
      const scopes = new Set(list.map((x) => x.scope));
      console.log(`${scopes.size > 1 ? 'CROSS-SCOPE' : 'CONFLICT'} ${k.split('|')[1]}  ->  ` +
        list.map((x) => `${x.id} [${x.scope}] (${x.spec})`).join('  vs  '));
    }
  }
  // 跨作用域同一键位(不报错,但同一组合在不同焦点下做不同事)
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  console.log('--- 同一键位多动作(含跨作用域) ---');
  for (const [k, list] of byKey) {
    if (list.length > 1) console.log(`  ${k}: ` + list.map((x) => `${x.id}[${x.scope}]`).join(' vs '));
  }
  console.log('--- 全部绑定 ---');
  for (const r of rows.sort((a, b) => a.key.localeCompare(b.key))) console.log(`  ${r.key.padEnd(22)} ${r.id} [${r.scope}]`);
}

// 菜单可达性
const inMenu = new Set(menuCommandIds(MENU_SPEC));
const bound = Object.keys(keymap);
console.log('\n===== 有键位但完全不在任何一级菜单里 =====');
for (const id of bound) if (!inMenu.has(id)) console.log(`  ${id}  (${keymap[id].label})`);
console.log('\n===== 菜单里的命令没有键位 =====');
for (const id of [...inMenu].sort()) if (!keymap[id]) console.log(`  ${id}`);
console.log('\n===== 注册命令(entry.js)有键位但菜单里没有的标准 ====');
console.log('mac 菜单项数:', specFor('mac', MENU_SPEC).reduce((n, g) => n + g.items.filter((x) => x !== '-').length, 0));
console.log('pc  菜单项数:', specFor('pc', MENU_SPEC).reduce((n, g) => n + g.items.filter((x) => x !== '-').length, 0));
```

### A3 `gen-inventory.mjs`(生成 §4/§5 表格)

```js
// 生成菜单盘点表(markdown 片段):菜单栏 × 平台、命令注册表、键位表。
// 行号按「分组内顺序合并」定位,避免同一命令出现两次时取到第一处。
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const here = path.dirname(new URL(import.meta.url).pathname);
const raw = JSON.parse(fs.readFileSync(path.join(here, 'commands-raw.json'), 'utf8'));
const code = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function evalLiteral(src, anchor) {
  const start = src.indexOf(anchor) + anchor.length;
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const text = src.slice(src.indexOf('{', start), i + 1);
  const pc = (spec) => ({ win: spec, linux: spec });
  return new Function('pc', `return (${text});`)(pc);
}
const keymap = evalLiteral(code('src/modules/keymap.js'), 'export const DEFAULT_KEYMAP =');
const { MENU_SPEC, specFor } = await import('file://' + path.join(root, 'src/shared/menu-spec.js'));

const MAC_KEY = { mod: '⌘', cmd: '⌘', meta: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', enter: '↵', tab: '⇥', space: 'Space', esc: 'Esc' };
const PC_KEY = { mod: 'Ctrl', cmd: 'Win', meta: 'Win', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', tab: 'Tab', space: 'Space', esc: 'Esc' };
const accel = (spec, mac) => String(spec || '').split('+').map((s) => s.trim()).filter(Boolean)
  .map((p) => (mac ? MAC_KEY : PC_KEY)[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p))
  .join(mac ? '' : '+');
const specOf = (id, plat) => {
  const def = keymap[id];
  const v = def && def[plat];
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.filter(Boolean);
};

// 行为分类(逐条人工核对过 run 函数):D=输入弹窗 I=信息/管理弹窗 M=弹出菜单 A=立即
const BEHAVIOR = {
  'palette.open': 'D 弹窗(命令面板)', 'settings.open': 'D 弹窗(设置)', 'app.about': 'I 弹窗(关于)',
  'window.close': 'A/关窗(系统确认)', 'app.quit': 'A/退出(活动会话时确认)', 'window.fullscreen': 'A 立即',
  'term.copy': 'A 立即', 'term.paste': 'A 立即', 'tab.new': 'A 立即', 'tab.rename': 'D 弹窗(输入框)',
  'pane.split': 'A 立即', 'tab.file.add': 'A 立即', 'files.revealLastDownload': 'A 立即(Finder)',
  'pane.zoom': 'A 立即', 'pane.reflow': 'A 立即', 'tabs.list': 'M 弹出列表', 'workspace.tile': 'A 立即',
  'workspace.close': 'A 立即(有传输时确认)', 'panel.sidebar': 'A 开关', 'panel.tools': 'A 开关',
  'ai.newThread': 'A 立即', 'ai.cycleEffort': 'A 立即', 'session.history': 'I 弹窗(列表)',
  'tools.snippets': 'I 弹窗(列表)', 'session.search': 'M 内嵌查找栏', 'session.clear': 'A 立即',
  'session.reconnect': 'A 立即', 'session.disconnect': 'A 立即(有传输时确认)', 'session.readonly': 'A 开关',
  'session.log': 'A 开关', 'session.log.folder': 'A 立即(Finder)', 'session.diagnose': 'A 立即',
  'tools.broadcast': 'M 弹出选择菜单', 'tools.batch': 'D 弹窗', 'tools.forwards': 'D 弹窗',
  'host.new': 'D 弹窗', 'cloud.import': 'D 弹窗', 'hosts.import': 'D 弹窗', 'hosts.export': 'D 弹窗',
  'settings.fingerprints': 'I 弹窗(列表)', 'hosts.library': 'I 弹窗(库)', 'view.hostDensity': 'A 开关',
  'panel.ai': 'A 开关', 'panel.history': 'I 弹窗(列表)', 'panel.snippets': 'I 弹窗(列表)',
};

const byId = new Map(raw.map((r) => [r.id, r]));
const staticLabel = (r) => {
  const t = r.label;
  if (!t.startsWith("'")) return '';
  const base = t.replace(/^'/, '').replace(/'$/, '');
  return r.kind === "'dialog'" && base && !base.endsWith('…') ? base + '…' : base;
};
const labelOf = (r) => staticLabel(r) || '⟨动态,见正文⟩';

// —— 菜单源文件行号:按分组顺位合并 ——
const menuLines = code('src/shared/menu-spec.js').split('\n');
const groups = [];
let cur = null;
menuLines.forEach((line, i) => {
  const g = /submenu: '([^']+)'/.exec(line);
  if (g) { cur = { name: g[1], entries: [] }; groups.push(cur); }
  if (!cur) return;
  const found = [];
  for (const m of line.matchAll(/cmd\('([^']+)'/g)) found.push({ kind: 'cmd', id: m[1], at: m.index });
  for (const m of line.matchAll(/pre\('([^']+)'/g)) found.push({ kind: 'pre', id: m[1], at: m.index });
  found.sort((a, b) => a.at - b.at);
  for (const f of found) cur.entries.push({ kind: f.kind, id: f.id, line: i + 1 });
});

const lines = [];
const push = (s) => lines.push(s);

for (const plat of ['mac', 'pc']) {
  const spec = specFor(plat, MENU_SPEC);
  const platName = plat === 'mac' ? 'macOS' : 'Windows/Linux';
  const rows = [];
  for (const group of spec) {
    const src = groups.find((g) => g.name === group.submenu);
    let p = 0;
    for (const entry of group.items) {
      if (entry === '-') continue;
      // 在源条目里向前找匹配项(过滤掉的平台项跳过)
      let hit = null;
      while (p < (src?.entries.length || 0)) {
        const cand = src.entries[p++];
        if (entry.predefined ? cand.id === entry.predefined : cand.id === entry.cmd) { hit = cand; break; }
      }
      const at = `menu-spec.js:${hit?.line ?? '?'}`;
      if (entry.predefined) {
        rows.push([group.submenu, entry.text, '否', '系统预定义(原生实现)', 'mac 系统键', at]);
        continue;
      }
      const r = byId.get(entry.cmd);
      const label = entry.text || labelOf(r);
      const keyMac = specOf(entry.cmd, 'mac');
      const keyWin = specOf(entry.cmd, 'win');
      const hidden = entry.accelerator === false;
      const shown = hidden ? '**空**(刻意)' : plat === 'mac'
        ? (keyMac.length ? accel(keyMac[0], true) : '—')
        : (keyWin.length ? accel(keyWin[0], false) : '—');
      const note = hidden && (keyMac[0] || keyWin[0])
        ? ` (keymap 有 ${[accel(keyMac[0] || '', true), keyWin[0] ? accel(keyWin[0], false) : ''].filter(Boolean).join(' / ')})`
        : '';
      rows.push([group.submenu, label, label.endsWith('…') ? '**是**' : '否',
        BEHAVIOR[entry.cmd] || '?', shown + note, `${at} → entry.js:${r?.line ?? '?'}`]);
    }
  }
  push(`\n### ${platName} 菜单栏(${rows.length} 项,含预定义)\n`);
  push('| 菜单 | 标签(实际显示) | … | 行为 | 快捷键 | 定义位置 |');
  push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) push('| ' + r.join(' | ') + ' |');
}

push('\n## 5. 盘点 B:命令注册表(标签的唯一静态来源)\n\n下表是 `registerCommand` 的全量(含 3 条 `internal` 别名)。「标签(静态)」列是**已按 `commands.js:34` 规则追加过 `…`**、菜单里会看到的文案;kind 不是 dialog 的命令直接取自注册表原文。`⟨动态,见正文⟩` 的三条在 §8 P1-10 与 P0-4 里展开了全部取值。\n');
push('| id | 标签(静态) | kind | 分类 | 键位 mac / win / linux | 行为 | 定义位置 |');
push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of [...raw].sort((a, b) => a.line - b.line)) {
  const k = (p) => specOf(r.id, p).map((s) => accel(s, p === 'mac')).join(', ') || '—';
  push(`| \`${r.id}\` | ${labelOf(r)} | ${(r.kind || "'action'").replace(/'/g, '')} | ${r.category.replace(/'/g, '')}${r.internal === 'true' ? ' (internal)' : ''} | ${k('mac')} / ${k('win')} / ${k('linux')} | ${BEHAVIOR[r.id] || '?'} | ${r.file}:${r.line} |`);
}

fs.writeFileSync(path.join(here, 'inventory.md'), lines.join('\n') + '\n');
console.log('lines:', lines.length);
```
