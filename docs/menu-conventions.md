# 功能菜单命名与快捷键展示规范

> 任务:`t_b23c24ec`。输入:`docs/menu-audit.md`(基线 `main` @ `03a53e4`,v0.6.25)的盘点表与 §8 Problems found(6 P0 / 12 P1 / 6 P2)。
>
> 本文是后续改名/重排的**唯一依据**:凡本文与源码现有文案冲突,一律以本文为准;凡本文没列出的文案,保持原样。改名的实施任务(`t_9f2daf78`)只允许按第 6 章逐行替换,不做二次判断。

---

## 0. 四条总规则

| # | 规则 | 一句话 |
| --- | --- | --- |
| E | 省略号 | `…` 只在动作**会向用户要东西**(填/选)时出现,由渲染层追加,标签里永不手写 |
| N | 命名 | 一个动作一个名字,动词+宾语,大小写与标点统一,不写实现术语 |
| G | 分组 | 菜单位置、组内顺序、分组标题三处固定;危险动作在组末 |
| S | 快捷键 | 一套渲染、一列位置、一个占用者;显示了就必须真绑得上 |

违反任意一条即为阻塞级问题。四条规则的检查方式见第 9 章(四个回归测试 + 两条 grep)。

---

## 1. 三层模型:名字只有两份,显示有两种

```
entry.js  registerCommand(id, { label })          ← 唯一的 canonical 文案(第 1 份)
keymap.js DEFAULT_KEYMAP[id].label                ← 必须与上一份逐字相同(第 2 份,设置页用)
             │
    ┌────────┴─────────────────────────────────────────────┐
    ▼                                                      ▼
menuLabelOf(id, ctx)                                  canonical label(裸)
= canonical + (asks ? '…' : '')                       = 命令面板 / 设置页快捷键表 / 提示
macOS 菜单栏 · PC 菜单栏 · 右键菜单 · 下拉菜单 · AI 面板菜单
```

### 1.1 不变量(改名的红线)

| 编号 | 不变量 | 理由 |
| --- | --- | --- |
| I1 | **命令 id 一律不改**。改 id = 改 keymap 动作名、改设置页已保存的自定义键位、改 `panel.*` 兼容别名 | `commands.js` 用 id 当 keymap 动作名 |
| I2 | **菜单不得自带文案**:删除 `menu-spec.js` 的 `text` 字段支持、删除 `commandMenuItem(id, ctx, { label })` 的 `label` 覆盖、删除 `menubar.js` 的 `entry.text → overrides.label` 分支 | 这 4 处各存一份名字是 P0-6 的成因 |
| I3 | **标签里不得出现 `…`**(U+2026),也不得出现 `...`(三个点)。省略号只能由 `menuLabelOf()` 追加 | P0-4 就是手写导致的 |
| I4 | **不允许 `noEllipsis` 之类的"剥回"开关**。`commands.js` 里的 `info.label.replace(/…$/,'')` 分支删除 | 有"加"又有"减",同一动作必然两副面孔(P0-1) |
| I5 | **`kind` 描述行为**:`dialog` = 需要用户输入/选择才能完成;`toggle` = 有勾选态;`action` = 立即完成。`kind` 与 `asks` 不一致时显式写 `asks` | P0-2 / P0-3 都是 kind 用错 |
| I6 | **HTML 里的动作名只有 `data-title` 一处**,格式恒为 `canonical(%1)`,`%1` 由 `data-accel` 填键位;不再出现第二个 `title=` 里写动作名 | P2-5 的第五份副本 |

### 1.2 渲染接口(实施任务需落地的唯一 API 变化)

```js
// commands.js
function asksForInput(command, ctx) {
  if (typeof command.asks === 'function') return !!command.asks(ctx);
  if (typeof command.asks === 'boolean') return command.asks;
  return (command.kind || (command.checked ? 'toggle' : 'action')) === 'dialog';
}

/// 菜单面用的文案:canonical + 需要输入时补一个 …(U+2026)。
export function menuLabelOf(id, ctx) {
  const command = commands.get(id);
  if (!command) return id;
  const label = evaluate(command.label, ctx) || '';
  return label && asksForInput(command, ctx) ? label + '…' : label;
}
```

- `commandState(id, ctx).label` 改为返回**裸 canonical**(不再补 `…`),因此 `listCommands()` 天然干净,命令面板与设置页自动不再泄漏省略号(P0-5)。
- 菜单构造方(`commandMenuItem`、`native-menu.js` 的 `textOf`、`menubar.js`)一律走 `menuLabelOf`。
- `native-menu.js` 的 `toAccelerator('cmd+1..9')` 仍返回 `''`(原生菜单不支持范围键),这是允许的:范围键位由 webview 全局分发,见 S9。

---

## 2. 规则 E —— 省略号

**E1 字符**:省略号是单个 U+2026(`…`)。全库不得用 `...` 表示省略号。标签源码里不得出现 `…`(由 I3 保证)。

**E2 判定(唯一标准)**:动作在开始执行后、结果落地前,**必须由用户提供数据或做出选择**才能继续 → 带 `…`。具体只有三类:

| 类 | 特征 | 例子 |
| --- | --- | --- |
| E2-a 文本/表单 | 弹窗或行内输入框要用户打字 | 重命名标签、新建主机、编辑主机、导入主机、导出主机、批量执行、端口转发、重命名分组、权限、管理书签、管理模型、新建文件夹 |
| E2-b 选择目标是流程的一步 | 弹出菜单只是**多步命令的第一步**,选完才真正开始执行 | 广播输入(先选会话)、下载(先选保存位置)、复制到(先选会话+目录) |
| E2-c 打开可操作窗口 | 打开一个"要在里面做事"的窗口(设置/管理面板),不是"只读一眼" | 设置、命令面板、命令历史、常用命令、主机库、主机指纹 |

**E3 不触发(必须是硬清单,不许类推)**:
1. 立即执行且无需数据的动作:清屏、分屏、新增文件分屏、整理标签分屏、放大/还原窗格、在文件夹中显示最近下载、打开日志文件夹、复制、粘贴、全选、复制名称/路径/地址、重新连接、克隆主机、切换到已有标签、新建标签、关闭类。
2. 开关类(kind `toggle`,带 `✓`):主机侧栏、AI 助手、只读模式、会话日志、紧凑列表、标签平铺、**所有 toggle 一律不带 `…`**。
3. 就地弹出的**列表菜单就是动作本身**,点开即选、点掉即消失,没有第二步:全部标签、书签下拉、AI 模型/对话/主机/执行模式下拉、移动到分组的目录列表。
4. **纯信息窗口**:只有一个关闭按钮、不需要用户做任何决定 —— 目前唯一一例是「关于 NebulaShell」。这是 `关于` 不带 `…` 的正式依据(P0-3),不允许再新增此类例外。
5. **一次性确认(是/否)**:删除、删除分组、断开连接、关闭窗口、退出。确认框不是"要输入",按 P2-4 的结论**不加 `…`**,也**不允许**因为"有时会弹确认"而给标签加 `…`(标签必须与状态无关,E4)。

> E2-b 与 E3-3 的分界:**菜单是过程**还是**菜单是目的地**。`广播输入` 选完会话才进入广播(过程,带 `…`);`全部标签` 选中即完成(目的地,不带 `…`)。

**E4 状态无关性**:同一个命令 id 的 canonical 文案里不得出现 `…`;`…` 的有无只允许随 `asks` 变化,而 `asks` 默认是静态的。全库只有 **一个** 命令声明的 `asks` 随上下文变化:`tools.broadcast`(选择菜单态才带 `…`)。

**E5 三个显示面**:

| 显示面 | 文案来源 | 是否带 `…` |
| --- | --- | --- |
| macOS 菜单栏、PC 菜单栏、右键/下拉菜单、AI 面板菜单 | `menuLabelOf(id, ctx)` | 是,按 asks |
| 命令面板(命令行)、设置页快捷键表(行名) | `commandState().label`(裸) | 否 |
| 按钮 tooltip / `aria-label` | `canonical(%1)`,不带 `…` | 否 |

**E6 菜单标题(分组标题)不带 `…`**:分组标题不是动作(例:`终端菜单`、`标签菜单`、`文件操作`、`移动到分组`、`布局`)。

**E7 45 条命令的判定结果**(实施时照抄,不需再判):

**带 `…` 的 17 条**:15 条公开命令 `palette.open`、`settings.open`、`tab.rename`、`session.history`、`tools.snippets`、`session.search`、`hosts.library`、`settings.fingerprints`、`host.new`、`cloud.import`、`hosts.import`、`hosts.export`、`tools.forwards`、`tools.batch`、`tools.broadcast`(仅选择菜单态),加 2 条 internal 别名 `panel.history`、`panel.snippets`(它们从不显示,但 kind 与目标一致)。

**不带 `…` 的 28 条**:其余全部,包括 `app.about`(E3-4)、`tabs.list`(E3-3)、`session.disconnect`/`window.close`/`app.quit`(E3-5)、`window.fullscreen`、`files.revealLastDownload`、`session.log.folder`、`view.hostDensity`、`panel.sidebar`、`panel.tools`、`ai.newThread`、`ai.cycleEffort`、`workspace.tile`、`term.*`、`pane.*`、`tab.new`、`tab.file.add`、`session.clear`、`session.reconnect`、`session.readonly`、`session.log`、`session.diagnose`、`workspace.close`,以及 internal 别名 `panel.ai`。

> 与现状的净变化:去掉 `tabs.list` 的 `…`(P0-2);`tools.broadcast` 的 `…` 改由渲染层给(P0-4);其余 14 条的 `…` 保持不变。新增带 `…` 的静态项只有 `新建文件夹…`(sftp)与 `管理模型…`(AI 模型下拉),因为它们同样是"点了要你填/进设置改"。

---

## 3. 规则 N —— 命名

**N1 结构:动词 + 宾语**,宾语可以是名词或名词短语。例:`导出主机`、`删除分组`、`在文件夹中显示最近下载`。
- 宾语可省略**仅当**同一表面只有一类对象且动作显然:文件条目右键的 `重命名`、`权限`;分组右键的 `重命名分组`(此处仍写宾语,因同屏还有主机对象)。
- 禁止倒装、禁止名词化:`AI 诊断报错` → `用 AI 诊断报错`;`广播输入`(动词在前,保留)。

**N2 句式**:
- 中文标签不加句末标点(`。`、`!`),不用书名号/引号;已有括号只用于"范围/数量/状态"说明。
- canonical 文案**不得含上下文指代词**`该`、`当前`、`本`。菜单里需要具体化时只能改动词后的修饰(见 N5)。
- 一个标签内**至多一对括号**。`分屏(自动最优布局)(⌘D)` 这种双括号是违规(P2-2),键位永远进独立槽位(S4)。

**N3 大小写与专名**:英文词用 sentence case(仅首词与专名大写);`NebulaShell`、`AI` 保持官方拼写;不出现全大写英文。

**N4 一名一义、一义一名**:同一动作在注册表、keymap、菜单、tooltip、右键菜单里**必须逐字相同**(由回归测试 1、5 守住)。同义合并结果:

| 概念 | 唯一写法 | 被合并掉的写法 |
| --- | --- | --- |
| 主机库 | `主机库` | 主机管理(侧栏项 / 下拉标题项名) |
| 端口转发 | `端口转发` | 端口转发规则 |
| 终端内查找 | `在终端中查找` | 搜索、在终端中搜索 |
| 重连 | `重新连接` | 重连当前会话 |
| 新建标签 | `新建标签` | 新建标签页 |
| 分屏 | `分屏` | 终端分屏、分屏(自动最优布局) |
| AI 面板 | `AI 助手` | 右侧工具栏 |
| 广播 | `广播输入` | 广播输入…(手写省略号) |
| 命令面板 | `命令面板` | 命令与快捷键(帮助菜单旧文案) |
| 复制主机地址 | `复制主机地址` | 复制 user@host |
| 退出 | `退出 NebulaShell` | 退出(仅 keymap 标签) |
| 重命名分组 | `重命名分组` | 重命名(分组右键) |
| 紧凑列表 | `紧凑列表` | (无别名,仅调整所属菜单) |

**N5 动态标签白名单**:只有下列 5 个命令允许文案随状态变化,且变体必须落在给出的枚举里(不许新增写法):

| 命令 | 允许的变体 |
| --- | --- |
| `pane.zoom` | canonical `放大或还原窗格`;显式目标 `放大窗格` / `还原窗格` |
| `workspace.close` | canonical `关闭窗格或标签`;多窗格 `关闭窗格`;单窗格 `关闭标签` |
| `tools.broadcast` | canonical `广播输入`;广播中 `停止广播`;显式目标 `加入广播` / `退出广播` |
| `sftp` 批量项 | `<动词>(N 项)`(`下载(3 项)…`、`复制到(3 项)…`、`删除(3 项)`) |
| 书签列表 | `全部书签(N)…`(N 为书签条数,单位省略) |

**N6 数量后缀格式**:
- 动词短语用 `(N 项)`,**紧贴动词短语之后、省略号之前**:`下载(3 项)…`、`复制到(3 项)…`、`删除(3 项)`。
- 无动词的清单标题用 `(N)`: `全部书签(12)…`。
- 计数后缀不得出现在省略号之后(现状 `复制到…(3 项)` 违规,P1-2)。

**N7 禁用写法**:
- 实现术语:`command`/`action`/`dialog`/`modal`/`kebab`/`ID`/`override`/`flag` 等一律不进文案。`复制会话 ID` 是唯一例外(会话 ID 是产品概念)。
- 装饰符号前缀:`＋ 新建分组并移入…` 的 `＋` 删除(图标由 `icon` 字段给);菜单文案里不出现 `⋯`、`▾`、`→`。
- 缩写与英文混排:`AI`、`SSH`、`SFTP` 保留;`user@host` 这类字面量不进标签(`复制 user@host` → `复制主机地址`)。
- 空动词:`管理`、`处理`、`操作` 单独成项(必须带宾语)。

**N8 开关(kind `toggle`)的命名**:写"开启后的状态",用名词短语,`✓` 表示开启。成对可逆的**动作**(非 toggle)用 `设为 X` / `取消 X`,不许 `标记为 X` / `取消 X` 混用。当前需改:`标记为常用` → `设为常用`;`记录会话日志` → `会话日志`(状态而非动作,P1-9)。

**N9 纯信息窗口例外**:见 E3-4,`关于 NebulaShell` 保持无 `…`。

---

## 4. 规则 G —— 分组、顺序与标题

**G1 一级菜单**:顺序固定为 `NebulaShell(mac) / 文件 / 编辑 / 视图 / 主机 / 会话 / 窗口(mac) / 帮助`,不新增一级菜单,不合并。平台差异只有两处,且为规范(P1-12):

| 命令 | macOS | Windows/Linux |
| --- | --- | --- |
| `settings.open` | 应用菜单第 2 项 | 文件菜单(倒数第二组) |
| `app.about` | 应用菜单第 1 项 | 帮助菜单 |

**G2 组内顺序**(自上而下,缺项不留空行):
1. 新建/创建类(`新建主机…`、`新建标签`、`新建 AI 对话`)
2. 导入/导出类(`从云导入…`、`导入主机…`、`导出主机…`)
3. 管理/列表类(`主机库…`、`主机指纹…`、`命令历史…`、`常用命令…`、`全部标签`)
4. 工具/执行类(`批量执行…`、`端口转发…`、`广播输入…`、`用 AI 诊断报错`)
5. 状态开关类(`只读模式`、`会话日志`、`紧凑列表`)
6. **危险动作**(`删除主机`、`删除分组`、`删除文件`,带 `danger: true`)

**G3 分隔线**:一组一件事,用 `-` 分隔;同一组内不得再插分隔线;平台裁剪后不留空组(`specFor` 已处理)。新增项必须明确落在哪一组。

**G4 分组标题(section label)**:名词短语、不带 `…`、**不得与组内任何项同名**(P2-3)。

| 位置 | 现标题 | 规范标题 |
| --- | --- | --- |
| 分屏下拉(`#btn-split-menu`) | 分屏与布局 | **布局** |
| 侧栏 ⠇(`#btn-host-manage`) | 主机管理 | 主机管理(项名改为`主机库`后不再重复,保留) |
| 标签右键 | 标签菜单 | 标签菜单 |
| 终端右键 | 终端菜单 | 终端菜单 |
| 文件面板 ⋯ | 文件操作 | 文件操作 |
| 批量移动下拉 | 移动到分组 | 移动到分组 |
| 分组右键 | 分组 | 分组 |
| 全部标签列表 | 全部标签 | 全部标签(与命令 `全部标签` 逐字相同,不再有 `…` 差异) |

**G5 `category`(命令面板分组)**:取值只能是 `app / layout / panel / session / host`,顺序固定为 `app → layout → panel → session → host`(与一级菜单从左到右一致,不重排)。**约束:一个命令的 category 不得与它在一级菜单里的落点矛盾**。需修正 3 条(P1-11):

| 命令 | 现 category | 现菜单位置 | 改为 |
| --- | --- | --- | --- |
| `tools.batch` | session | 主机 | **host** |
| `view.hostDensity` | panel | 视图 | **host**,并把菜单项移到「主机」组末(它是主机列表密度) |
| `files.revealLastDownload` | app | 文件 | **layout**(「标签与文件」组;`CATEGORY_LABEL.layout` 由`标签与分屏`改为`标签与文件`) |

**G6 同一动作在菜单栏出现两次**:只允许 `palette.open`(视图 + 帮助,平台惯例),两处文案与键位必须完全相同。其余动作在菜单栏只能出现一次;右键菜单不受此限(语境不同)。

**G7 危险与破坏性**:
- 不可逆的删除类永远排在所在组最后,并带 `danger: true`。
- `断开连接`、`关闭窗口`、`退出 NebulaShell` 属"可恢复 / 系统确认",**不算危险动作**,可以与配对的`重新连接`相邻、可以不在组末;也不加 `…`(P2-4)。

---

## 5. 规则 S —— 快捷键展示

**S1 唯一渲染器**:`core.js` 的 `accel()` + `MAC_KEY`/`PC_KEY` 符号表。UI 文案、HTML、模板字符串里**禁止**出现 `⌘`、`Ctrl+`、`⌥` 等键位字符(keymap 注释除外,`tests/keymap.test.mjs:239` 已有守卫)。

**S2 规范书写**:spec 用小写修饰键名 `cmd/ctrl/alt/shift` + 键名(`cmd+shift+H`、`ctrl+shift+alt+B`、`F2`、`cmd+,`)。显示由 `accel()` 决定:
- macOS:无连接符,修饰键顺序 **⌘ ⌃ ⌥ ⇧**;
- Windows/Linux:用 `+` 连接,顺序 **Ctrl+Shift+Alt(+Win)**。

为实现"与书写顺序无关",`accel()` 内部按上表排序修饰键(现 `alt+cmd+B` 会显示成 `⌘⌥B`)。范围写法 `1..9` 见 S9。

**S3 多键位**:一个动作可有多个键位(数组),列表/菜单**只显示第一个(主键位)**,不得把两个键位拼在同一槽位;设置页可显示全部,用 ` / ` 分隔。

**S4 位置:专用列,右对齐**。每个菜单元件只有一个快捷键槽位,文案里不得夹带键位:

| 表面 | 槽位 |
| --- | --- |
| 右键/下拉菜单(`showCtxMenu`) | 项右侧的 key 列(`item.key`) |
| macOS 原生菜单 | `accelerator`(系统列) |
| PC 菜单栏 / 命令面板 | `commandMenuItem().key` / `.pal-key` |
| 设置页快捷键表 | `.keys-accel` 列 |
| 标题栏按钮 | `title` 结尾的 `(⌘D)`(`data-title` 的 `%1`) |

**现存违规必须清掉**:`sftp.js:635` 的 `全选(⌘A 范围内)` 把键位写进了文案 → 改为走命令表的 `全选文件`,键位进槽位。

**S5 唯一性**:同一平台上,**不同命令不得占用同一键位**。唯一豁免是作用域隔离的一对:

| 键位 | 动作 A(作用域) | 动作 B(作用域) | 处理 |
| --- | --- | --- | --- |
| `⌘A` | `term.selectAll`(终端) | `files.selectAll`(文件面板) | 保留;设置页行名必须可区分(`终端内全选` / `全选文件`),不允许两行同名 |

除上表外,任何"同一键位挂两个动作"都算违规,包括跨作用域(`⌘T` 的 `tab.new` vs `ai.cycleEffort` 就是这样漏掉的,P1-4)。验证:同作用域冲突 **0**、跨作用域重复 **仅上表 1 对**。

**S6 显示 ⇒ 绑定;绑定 ⇒ 可发现**:
- 菜单/按钮上显示的键位必须真的能触发该命令(不得显示未绑定的键)。
- 反过来,每个绑定至少有一处可发现位置:菜单栏、右键/下拉菜单、面板菜单、命令面板、设置页快捷键表,或按钮 tooltip。
- **例外(唯一)**:范围键位 `⌘1..9` / `Ctrl+1..9` 不设菜单项 —— 点击入口由「全部标签」列表承担,键位在设置页行名「切换到指定标签」与 tab 列表按钮的 tooltip(`全部标签(⌥⌘L)`)上暴露。理由:为它单设菜单项会与「全部标签」形成两个等价点击目标(P1-8 的处置)。

**S7 平台缺失**:平台没有对应键时,菜单项**不显示**键位(如 macOS 无 F11,`window.fullscreen` 只出现在 PC 菜单)。**不得**为了版面整齐而隐藏已有键位 —— `menu-spec.js:36` 给 `ai.newThread`/`ai.cycleEffort` 的 `accelerator: false` 删除(P1-5):只要绑了,菜单就显示。

**S8 功能键例外**:`F2`(重命名标签)、`F11`(全屏)在所有平台保持字面 `F` 键,不改写为 ⌘ 组合,也不做 `Fn+F2` 标注。理由:这两个是跨平台编辑/显示动词的肌肉记忆,优先级高于"mac 只用 ⌘ 组合"的一般约定(P2-1 的处置,记录为规范而非缺陷)。

**S9 范围键位渲染**:`cmd+1..9` 显示为 `⌘1…⌘9`,`ctrl+1..9` 显示为 `Ctrl+1…Ctrl+9`(两端各一个,中间用 U+2026)。原生菜单不设 accelerator(菜单项不带键),按键由 webview 全局分发,因此点击菜单项仍可用。

**S10 面板内修饰键进 keymap**:命令面板的 `⌘↵ / Ctrl+Enter` 不得用 `IS_MAC ? … : …` 手写(P1-6),必须新增 keymap 动作 `palette.connectNewTab`,渲染走 `accelOf()`。

**S11 键位改名要迁移**:修改/删除默认键位时,必须在 `CHANGELOG` 记录旧→新,并在设置页对受影响的旧自定义键位做提示(现有 `settings.keybindings` 里 `cmd+T` 指向 `ai.cycleEffort` 的用户需要重新录制)。

---

## 6. 改名表(逐文件)

> 约定:`旧 → 新`;`—` 表示不变。所有删除项都写明"删什么",不留"看着办"。

### 6.1 `src/modules/entry.js` —— 注册表 45 条(canonical 文案唯一来源)

列说明:`菜单显示` 是 macOS/PC 菜单栏、右键菜单里看到的文本;`asks` 为是时渲染层追加 `…`。

| # | id | 旧 label | 新 canonical | 菜单显示 旧 → 新 | asks | kind 旧 → 新 | 分类 旧 → 新 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `palette.open` | 命令面板 | 命令面板 | 命令面板… → 命令面板… | 是 | dialog | app |
| 2 | `settings.open` | 设置 | 设置 | 设置… → 设置… | 是 | dialog | app |
| 3 | `app.about` | 关于 NebulaShell | 关于 NebulaShell | 关于 NebulaShell(仍无 …) | 否 | action | app |
| 4 | `window.close` | 关闭窗口 | 关闭窗口 | — | 否 | action | app |
| 5 | `app.quit` | 退出 NebulaShell | 退出 NebulaShell | — | 否 | action | app |
| 6 | `window.fullscreen` | 全屏 | 全屏 | — | 否 | action | app |
| 7 | `term.copy` | 复制 | 复制 | — | 否 | action | session |
| 8 | `term.paste` | 粘贴 | 粘贴 | — | 否 | action | session |
| 9 | `tab.new` | 新建标签 | 新建标签 | — | 否 | action | layout |
| 10 | `tab.rename` | 重命名标签 | 重命名标签 | — | 是 | dialog | layout |
| 11 | `pane.split` | 分屏 | 分屏 | — | 否 | action | layout |
| 12 | `tab.file.add` | 新增文件分屏 | 新增文件分屏 | — | 否 | action | layout |
| 13 | `files.revealLastDownload` | 打开最近下载位置 | **在文件夹中显示最近下载** | 打开最近下载位置 → 在文件夹中显示最近下载 | 否 | action | app → **layout** |
| 14 | `pane.zoom` | 放大当前窗格 / 放大该窗格 / 还原分屏布局 | **放大或还原窗格** | 放大当前窗格 → 放大或还原窗格;放大该窗格 → **放大窗格**;还原分屏布局 → **还原窗格** | 否 | action | layout |
| 15 | `pane.reflow` | 整理当前标签分屏 | **整理标签分屏** | 去「当前」 | 否 | action | layout |
| 16 | `tabs.list` | 全部标签 | 全部标签 | **全部标签… → 全部标签** | **是 → 否** | **dialog → action** | layout |
| 17 | `workspace.tile` | 标签平铺 | 标签平铺 | — | 否 | toggle(checked 缺省) | layout |
| 18 | `workspace.close` | 关闭该窗格 / 关闭标签 / 关闭当前窗格 / 关闭当前标签 | **关闭窗格或标签** | 关闭该窗格 → **关闭窗格**;关闭当前窗格 → **关闭窗格**;关闭标签 → 关闭标签;关闭当前标签 → **关闭标签** | 否 | action | layout |
| 19 | `panel.sidebar` | 主机侧栏 | 主机侧栏 | — | 否 | toggle | panel |
| 20 | `panel.tools` | AI 助手 | AI 助手 | — | 否 | toggle | panel |
| 21 | `ai.newThread` | 新建 AI 对话 | 新建 AI 对话 | —(菜单开始显示 ⌘N) | 否 | action | panel |
| 22 | `ai.cycleEffort` | 切换思考强度 | 切换思考强度 | —(菜单开始显示 ⌘⌥E) | 否 | action | panel |
| 23 | `session.history` | 命令历史 | 命令历史 | — | 是 | dialog | session |
| 24 | `tools.snippets` | 常用命令 | 常用命令 | — | 是 | dialog | session |
| 25 | `session.search` | 在终端中查找 | 在终端中查找 | 右键菜单 搜索… → **在终端中查找…** | 是 | dialog | session |
| 26 | `session.clear` | 清屏 | 清屏 | — | 否 | action | session |
| 27 | `session.reconnect` | 重连当前会话 | **重新连接** | 重连当前会话 → 重新连接;右键覆盖「重新连接」删除 | 否 | action | session |
| 28 | `session.disconnect` | 断开连接 | 断开连接 | — | 否 | action | session |
| 29 | `session.readonly` | 只读模式 | 只读模式 | — | 否 | toggle | session |
| 30 | `session.log` | 记录会话日志 | **会话日志** | 记录会话日志 → 会话日志 | 否 | toggle | session |
| 31 | `session.log.folder` | 打开日志文件夹 | 打开日志文件夹 | — | 否 | action | session |
| 32 | `session.diagnose` | AI 诊断报错 | **用 AI 诊断报错** | AI 诊断报错 → 用 AI 诊断报错 | 否 | action | session |
| 33 | `tools.broadcast` | 广播输入… / 停止广播 / 加入广播 / 退出广播 | **广播输入** | 广播输入… → 广播输入…(… 改由渲染层加);其余三态 — | 是(仅选择菜单态) | action(显式 `asks`) | session |
| 34 | `tools.batch` | 批量执行 | 批量执行 | 侧栏 批量执行 → 批量执行… | 是 | dialog | session → **host** |
| 35 | `tools.forwards` | 端口转发 | 端口转发 | 侧栏 端口转发规则 → **端口转发…** | 是 | dialog | session |
| 36 | `host.new` | 新建主机 | 新建主机 | — | 是 | dialog | host |
| 37 | `cloud.import` | 从云导入 | 从云导入 | 侧栏 从云导入 → 从云导入… | 是 | dialog | host |
| 38 | `hosts.import` | 导入主机 | 导入主机 | 侧栏 导入主机 → 导入主机… | 是 | dialog | host |
| 39 | `hosts.export` | 导出主机 | 导出主机 | 侧栏 导出主机 → 导出主机… | 是 | dialog | host |
| 40 | `settings.fingerprints` | 主机指纹 | 主机指纹 | 侧栏 主机指纹 → 主机指纹… | 是 | dialog | host |
| 41 | `hosts.library` | 主机库 | 主机库 | 侧栏 主机管理 → **主机库…** | 是 | dialog | host |
| 42 | `view.hostDensity` | 紧凑列表 | 紧凑列表 | —(**菜单项从「视图」移到「主机」组末**) | 否 | toggle | panel → **host** |
| 43 | `panel.ai` | AI 助手(internal 别名) | AI 助手 | 不显示 | 否 | toggle | panel |
| 44 | `panel.history` | 命令历史(internal 别名) | 命令历史 | 不显示 | 是 | dialog | panel |
| 45 | `panel.snippets` | 常用命令(internal 别名) | 常用命令 | 不显示 | 是 | dialog | panel |

**entry.js 其它改动**

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `pane.zoom` label 函数 | 三态含`当前/该` | 三态按上表;无 `ctx` 时返回 `放大或还原窗格` |
| `workspace.close` label 函数 | 四态含`当前/该` | 三态按上表;无 `ctx` 时返回 `关闭窗格或标签` |
| 终端右键菜单 | `item('session.search', { label: '搜索…' })` | `item('session.search')`(删覆盖) |
| 终端右键菜单 | `item('session.reconnect', { label: '重新连接' })` | `item('session.reconnect')`(删覆盖) |
| 终端右键菜单 | `全选` 直接调 `term.selectAll()` | `item('term.selectAll')`(走命令表,键位进槽位) |
| 终端右键菜单 | `复制`/`粘贴` 内联实现 | 保持不变(选中文本快照依赖内联),但标签与键位与 canonical 一致 |
| 分屏下拉 | `commandMenuItem('pane.split', undefined, { label: '终端分屏' })` | `commandMenuItem('pane.split')`(删覆盖) |
| 分屏下拉标题 | `分屏与布局` | `布局` |
| 侧栏 ⠇ 菜单 | 7 处 `noEllipsis: true` + `label: '主机管理'`/`'批量执行'`/`'端口转发规则'` | 全部删除;项文案由注册表给(`主机库…`、`批量执行…`、`端口转发…`) |
| 侧栏 ⠇ 菜单标题 | `主机管理` | 主机管理(保留) |
| `bindMenuButton` 调用 | `{ label: '主机管理' }` | 不变 |

### 6.2 `src/modules/commands.js`(渲染机制)

| 改动 | 说明 |
| --- | --- |
| 删 | `labelOf()` 里 `kind === 'dialog' → label + '…'` 的追加逻辑,改为 `menuLabelOf()`(§1.2) |
| 删 | `commandMenuItem()` 里 `overrides.noEllipsis ? info.label.replace(/…$/,'') : info.label` 分支 |
| 删 | `commandMenuItem()` 的 `overrides.label` 支持(所有调用方已不再传) |
| 改 | `CATEGORY_LABEL.layout`:`标签与分屏` → `标签与文件` |
| 改 | 注释:`kind: dialog` 的定义改为"需要用户输入/选择",与 E5 对齐 |

### 6.3 `src/modules/keymap.js`(标签 + 键位)

| # | 动作 | 旧 label | 新 label | macOS 旧 → 新 | Win/Linux 旧 → 新 |
| --- | --- | --- | --- | --- | --- |
| 1 | `tab.new` | 新建标签页 | 新建标签 | ⌘T | Ctrl+Shift+T |
| 2 | `workspace.close` | 关闭当前窗格或标签 | 关闭窗格或标签 | ⌘W | Ctrl+Shift+W |
| 3 | `session.search` | 在终端中搜索 | 在终端中查找 | ⌘F | Ctrl+Shift+F |
| 4 | `pane.split` | 分屏(自动最优布局) | 分屏 | ⌘D | Ctrl+Shift+D |
| 5 | `pane.zoom` | 放大/还原当前窗格 | 放大或还原窗格 | ⌘⇧↵ | Ctrl+Shift+Enter |
| 6 | `tab.switch` | 切换到第 N 个标签 | 切换到指定标签 | `⌘1..9` → 显示 **⌘1…⌘9** | 显示 **Ctrl+1…Ctrl+9** |
| 7 | `files.selectAll` | 全选(焦点文件分屏内) | 全选文件 | ⌘A | Ctrl+A |
| 8 | `term.copy` | 复制 | 复制 | ⌘C | Ctrl+C(主)/Ctrl+Shift+C |
| 9 | `term.paste` | 粘贴 | 粘贴 | ⌘V | Ctrl+V(主)/Ctrl+Shift+V |
| 10 | `term.selectAll` | 全选 | 全选 | ⌘A | Ctrl+Shift+A |
| 11 | `palette.open` | 命令面板 | 命令面板 | ⌘⇧P | Ctrl+Shift+P |
| 12 | `settings.open` | 设置 | 设置 | ⌘, | Ctrl+, |
| 13 | `session.clear` | 清屏 | 清屏 | ⌘K | —(无) |
| 14 | `panel.sidebar` | 主机侧栏 | 主机侧栏 | ⌘B | Ctrl+Shift+B |
| 15 | `panel.tools` | AI 助手 | AI 助手 | 规格 `alt+cmd+B` → 显示 **⌘⌥B** | Ctrl+Shift+Alt+B |
| 16 | `ai.newThread` | 新建 AI 对话 | 新建 AI 对话 | ⌘N | Ctrl+Shift+N |
| 17 | `ai.cycleEffort` | 切换思考强度 | 切换思考强度 | **⌘T → ⌘⌥E** | **Ctrl+T → Ctrl+Shift+Alt+E** |
| 18 | `session.history` | 命令历史 | 命令历史 | ⌘⇧H | Ctrl+Shift+H |
| 19 | `tools.snippets` | 常用命令 | 常用命令 | ⌘⇧S | Ctrl+Shift+S |
| 20 | `window.fullscreen` | 全屏 | 全屏 | —(系统 ⌃⌘F 由 macOS 菜单项负责) | F11 |
| 21 | `host.new` | 新建主机 | 新建主机 | ⌘⇧N | Ctrl+Shift+Alt+N |
| 22 | `tab.rename` | 重命名标签 | 重命名标签 | F2 | F2 |
| 23 | `tab.file.add` | 新增文件分屏 | 新增文件分屏 | ⌘⇧E | Ctrl+Shift+E |
| 24 | `tabs.list` | 全部标签 | 全部标签 | 显示 **⌘⌥L** | Ctrl+Shift+Alt+L |
| 25 | `workspace.tile` | 标签平铺 | 标签平铺 | 显示 **⌘⌥T** | Ctrl+Shift+Alt+T |
| 26 | `pane.reflow` | 整理当前标签分屏 | 整理标签分屏 | 显示 **⌘⌥R** | Ctrl+Shift+Alt+R |
| 27 | `session.reconnect` | 重连当前会话 | 重新连接 | ⌘⇧R | Ctrl+Shift+R |
| 28 | `session.readonly` | 只读模式 | 只读模式 | ⌘⇧L | Ctrl+Shift+L |
| 29 | `session.log` | 记录会话日志 | 会话日志 | ⌘⇧J | Ctrl+Shift+J |
| 30 | `session.diagnose` | AI 诊断报错 | 用 AI 诊断报错 | 显示 **⌘⌥D** | Ctrl+Shift+Alt+D |
| 31 | `tools.broadcast` | 广播输入 | 广播输入 | ⌘⇧G | Ctrl+Shift+G |
| 32 | `tools.forwards` | 端口转发 | 端口转发 | 显示 **⌘⌥F** | Ctrl+Shift+Alt+F |
| 33 | `window.close` | 关闭窗口 | 关闭窗口 | ⌘⇧W | —(无) |
| 34 | `app.quit` | 退出 | **退出 NebulaShell** | ⌘Q | —(无) |
| 35 | `palette.connectNewTab` | **新增** | 在新标签中连接 | **⌘↵** | **Ctrl+Enter** |

- 第 17 行是唯一的功能性重绑(P1-4):`⌘T` 归还 `tab.new`。
- 第 35 行是新增动作(P1-6),只用于命令面板的主机行与页脚,不进一级菜单。**必须同时加入 `keymap.js` 的 `COMPONENT_ACTIONS`**,否则它会随 `DEFAULT_KEYMAP` 一起进 `APP_ACTIONS`,在全局分发里把终端里的 `Ctrl+Enter` 吃掉(表现为 shell 收不到该键、面板外按了没反应)。加入 `COMPONENT_ACTIONS` 后:不进全局分发、默认键位仍可在设置页改、冲突检测归 `component` 作用域。
- 未绑键位、因此键位列显示「未设置」的命令 11 条:`app.about`、`cloud.import`、`files.revealLastDownload`、`hosts.export`、`hosts.import`、`hosts.library`、`session.disconnect`、`session.log.folder`、`settings.fingerprints`、`tools.batch`、`view.hostDensity`。

### 6.4 `src/modules/core.js`

| 改动 | 说明 |
| --- | --- |
| 改 | `accel()`:修饰键按平台规范顺序排序(mac `cmd,ctrl,alt,shift`;pc `ctrl,shift,alt,cmd`),使显示与 spec 书写顺序无关(S2) |
| 改 | `accel()`:`1..9` 范围写法渲染为 `⌘1…⌘9` / `Ctrl+1…Ctrl+9`(S9) |
| 不改 | 符号表 `MAC_KEY`/`PC_KEY`、`applyAccelTitles()` |

### 6.5 `src/shared/menu-spec.js`(结构)

| 行 | 旧 | 新 |
| --- | --- | --- |
| 视图 · `ai.newThread` | `cmd('ai.newThread', { accelerator: false })` | `cmd('ai.newThread')`(恢复显示 ⌘N) |
| 视图 · `ai.cycleEffort` | `cmd('ai.cycleEffort', { accelerator: false })` | `cmd('ai.cycleEffort')`(恢复显示 ⌘⌥E) |
| 视图 · `view.hostDensity` | 在「视图」组 | **移到「主机」组末**(`settings.fingerprints, tools.forwards, tools.batch` 之后) |
| 帮助 · 第一项 | `cmd('palette.open', { text: '命令与快捷键…', accelerator: false, alias: 'help' })` | `cmd('palette.open', { alias: 'help' })`(删 `text` 与 `accelerator: false`) |
| 编辑 | 只有 `term.copy`/`term.paste`(pc) | 追加 `cmd('term.selectAll', { only: 'pc' })`,排在 `term.paste` 之后、`session.search` 之前(P1-7) |

- `text` 字段从此不再被 `native-menu.textOf` / `menubar.menuItems` 使用 → 一并删除这两处的读取分支(I2)。
- `specFor()` / `menuCommandIds()` 不改。

### 6.6 `src/modules/native-menu.js` / `src/modules/menubar.js`

| 文件 | 改动 |
| --- | --- |
| `native-menu.js` | `textOf()` 改为 `menuLabelOf(entry.cmd, undefined)`;删 `entry.text` 分支 |
| `menubar.js` | `menuItems()` 删 `if (entry.text) overrides.label = entry.text`;`accelerator === false` 分支保留(S7 允许平台缺失) |

### 6.7 `src/modules/terminal.js`

| 位置 | 旧 | 新 |
| --- | --- | --- |
| 标签右键 · 关闭标签 | `{ label:'关闭标签', key: accelOf('workspace.close') }`(直接 `closeTab`) | 保留标签与直接调用,**删除 `key`**(该键位属于活动标签,不是右键的那个标签;违反 S6) |
| 标签右键 · 重命名 | `commandMenuItem('tab.rename', {tabId}, { label: '重命名…' })` | `commandMenuItem('tab.rename', { tabId })` → `重命名标签…` |
| 标签右键 · 关闭其他/右侧 | 关闭其他标签 / 关闭右侧标签 | 不变 |
| 标签右键 · 复制主机地址 | 不变 | — |
| 全部标签列表标题 | `全部标签` | 不变(与命令同名,已无 `…` 差异) |
| tab 列表按钮 | `title="全部标签"`,无 `data-accel` | `data-title="全部标签(%1)" data-accel="tabs.list"`(S6 可发现性) |

### 6.8 `src/modules/hosts.js`(主机行 ⋯ / 右键,一份菜单两处入口)

| 旧 | 新 | 说明 |
| --- | --- | --- |
| `连接` | **删除整项** | 与下一项行为完全相同(P1-1),保留描述更准确的一条 |
| `在新标签连接` | **在新标签中连接** | 唯一保留的连接入口,行为不变 |
| `切换到已有标签` | 不变 | — |
| `标记为常用` / `取消常用` | **设为常用** / 取消常用 | N8 |
| `编辑…` | **编辑主机…** | N1 宾语 |
| `克隆` | **克隆主机** | N1 宾语 |
| `复制 user@host` | **复制主机地址** | N4(与标签右键同名) |
| `删除…` | **删除主机** | E3-5:确认框不加 `…`;仍在组末 + `danger` |

### 6.9 `src/modules/sftp.js`

| 位置 | 旧 | 新 |
| --- | --- | --- |
| 文件面板 ⋯ · 新建文件夹 | `新建文件夹` | **新建文件夹…**(P1-3,与 `重命名…`/`权限…` 一致) |
| 文件面板 ⋯ · 前进 / 全选(全不选) / 反选 | 不变 | — |
| 文件面板 ⋯ 标题 | 文件操作 | 不变 |
| 路径栏右键 | 收藏当前目录 / 取消收藏当前目录 / 复制当前路径 | 不变 |
| 文件条目 · 下载 | `下载…` / `下载(N 项)…` | 不变(已合规) |
| 文件条目 · 复制到 | `复制到…` / `复制到…(3 项)` | **`复制到…` / `复制到(3 项)…`**(N6) |
| 文件条目 · 全选 | ``全选(${accelOf('files.selectAll')} 范围内)`` | **`全选文件`**,用 `commandMenuItem('files.selectAll', ctx)` 生成,键位进槽位(S4) |
| 文件条目 · 重命名 / 权限 | `重命名…` / `权限…` | 不变 |
| 文件条目 · 删除 | 删除文件 / 删除目录 / `删除(N 项)` | 不变 |
| 复制目标菜单 | 会话行 / `取消` | 不变 |
| 书签下拉 | `全部书签(N)…` / `管理书签…` / 状态项 | 不变 |

### 6.10 `src/modules/host-library.js`

| 旧 | 新 |
| --- | --- |
| 分组右键 `重命名…` | **重命名分组…** |
| 分组右键 `删除分组…` | **删除分组**(E3-5) |
| 批量移动 `＋ 新建分组并移入…` | **新建分组并移入…**(删 `＋`,N7) |
| 下拉标题 `移动到分组` | 不变 |

### 6.11 `src/modules/ai.js`、`src/modules/ai-agent-ui.js`、`src/index.html`

| 文件 | 旧 | 新 |
| --- | --- | --- |
| `index.html:1154` | `管理模型` | **管理模型…**(点开进设置 AI 页,E2-c) |
| `ai-agent-ui.js`(目标菜单第 2 项) | `跟随命令窗口` | **跟随模式**(P2-6,与`对话模式`/`多主机模式`成套) |
| `ai-agent-ui.js` 其余 | 对话模式 / 多主机模式 / 执行模式三项 / 说明文案 | 不变 |
| `ai.js` 代码块 ▾ | `复制` / `执行` / `仅填入终端` / `更多命令操作` | 不变 |
| `index.html:29` | `aria-label="右侧工具栏" data-title="右侧工具栏(%1)"` | `aria-label="AI 助手" data-title="AI 助手(%1)"` |
| `index.html:103` | `data-title="新建标签页(%1)"` | `data-title="新建标签(%1)"` |
| `index.html:105` | `data-title="分屏(自动最优布局)(%1)"` | `data-title="分屏(%1)"`(P2-2 双括号) |
| `index.html:201` | `title="新建对话" data-title="新建对话(%1)"` | `title="新建 AI 对话" data-title="新建 AI 对话(%1)"`(I6) |
| `index.html:102`(tab 列表按钮) | 见 6.7 | `data-title="全部标签(%1)" data-accel="tabs.list"` |

> `title=` 与 `data-title=` 同时存在时,`applyAccelTitles` 会覆写 `title`;保留静态 `title` 只为无障碍兜底,文本必须等于 canonical(I6)。

### 6.12 `src/modules/palette.js`(命令面板)

| 旧 | 新 |
| --- | --- |
| `` `↵ 连接　${accel(IS_MAC ? 'cmd+Enter' : 'ctrl+Enter')} 新标签` ``(主机行 key 列) | key 列只放一个提示:`↵ 连接`(`⌘↵` 的组合提示移到页脚,避免一个槽位塞两个键位,S3/S4) |
| `` `↑↓ 选择 · ↵ 执行 · ${accel(...)} 在新标签连接 · Esc 关闭` `` | `` `↑↓ 选择 · ↵ 连接 · ${accelOf('palette.connectNewTab')} 在新标签中连接 · Esc 关闭` `` |
| `newTabModifier` 手写 `IS_MAC ? metaKey : ctrlKey` | 保留(事件判断),但文案/渲染一律走 keymap(S10) |
| 命令行名称 | 已是 `listCommands()` 裸标签,自动去掉 `…`(P0-5) |

### 6.13 `src/modules/settings.js`

- 行名取 `listCommands()` 裸标签,随 §6.2 自动修正(P0-5),**文件本身不用改**。
- 保留 `id.startsWith('term.') ? \`终端内${label}\`` 前缀:它让 `终端内全选` 与 `全选文件` 两行可区分(S5)。

### 6.14 明确不改的文件

`src-tauri/**`(无菜单定义)、`e2e/**`(无菜单文案断言)、`build.mjs`、`src/style.css`(快捷键列样式已有)、`tests/keymap.test.mjs` **除** 下面三处期望字符串(受 S2/S9 显示变化影响,必须同步):

| 测试 | 现期望 | 改为 |
| --- | --- | --- |
| `tests/keymap.test.mjs:173` | `⌘1..9` | `⌘1…⌘9`(PC 同理 `Ctrl+1…Ctrl+9`) |
| `tests/keymap.test.mjs:294` | `⌥⌘B` | `⌘⌥B`(排序后) |
| `tests/keymap.test.mjs:170` | `⌘⇧↵` | 不变(cmd 在 shift 前,排序不影响) |

另:第 315 行 `toAccelerator('cmd+1..9') === ''`、第 373 行 `bindingSignature('cmd+1..9')` 断言的是 spec 而不是显示,保持不变。

---

## 7. 键位终态与唯一性核验

### 7.1 终态表(按平台,含全部 35 个动作)

| 动作 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `tab.new` | ⌘T | Ctrl+Shift+T | Ctrl+Shift+T |
| `workspace.close` | ⌘W | Ctrl+Shift+W | Ctrl+Shift+W |
| `session.search` | ⌘F | Ctrl+Shift+F | Ctrl+Shift+F |
| `pane.split` | ⌘D | Ctrl+Shift+D | Ctrl+Shift+D |
| `pane.zoom` | ⌘⇧↵ | Ctrl+Shift+Enter | Ctrl+Shift+Enter |
| `tab.switch` | ⌘1…⌘9 | Ctrl+1…Ctrl+9 | Ctrl+1…Ctrl+9 |
| `files.selectAll` | ⌘A(文件面板) | Ctrl+A | Ctrl+A |
| `term.copy` | ⌘C | Ctrl+C / Ctrl+Shift+C | Ctrl+Shift+C / Ctrl+C |
| `term.paste` | ⌘V | Ctrl+V / Ctrl+Shift+V | Ctrl+Shift+V |
| `term.selectAll` | ⌘A(终端) | Ctrl+Shift+A | Ctrl+Shift+A |
| `palette.open` | ⌘⇧P | Ctrl+Shift+P | Ctrl+Shift+P |
| `palette.connectNewTab` | ⌘↵ | Ctrl+Enter | Ctrl+Enter |
| `settings.open` | ⌘, | Ctrl+, | Ctrl+, |
| `session.clear` | ⌘K | — | — |
| `panel.sidebar` | ⌘B | Ctrl+Shift+B | Ctrl+Shift+B |
| `panel.tools` | ⌘⌥B | Ctrl+Shift+Alt+B | Ctrl+Shift+Alt+B |
| `ai.newThread` | ⌘N | Ctrl+Shift+N | Ctrl+Shift+N |
| `ai.cycleEffort` | ⌘⌥E | Ctrl+Shift+Alt+E | Ctrl+Shift+Alt+E |
| `session.history` | ⌘⇧H | Ctrl+Shift+H | Ctrl+Shift+H |
| `tools.snippets` | ⌘⇧S | Ctrl+Shift+S | Ctrl+Shift+S |
| `window.fullscreen` | —(系统) | F11 | F11 |
| `host.new` | ⌘⇧N | Ctrl+Shift+Alt+N | Ctrl+Shift+Alt+N |
| `tab.rename` | F2 | F2 | F2 |
| `tab.file.add` | ⌘⇧E | Ctrl+Shift+E | Ctrl+Shift+E |
| `tabs.list` | ⌘⌥L | Ctrl+Shift+Alt+L | Ctrl+Shift+Alt+L |
| `workspace.tile` | ⌘⌥T | Ctrl+Shift+Alt+T | Ctrl+Shift+Alt+T |
| `pane.reflow` | ⌘⌥R | Ctrl+Shift+Alt+R | Ctrl+Shift+Alt+R |
| `session.reconnect` | ⌘⇧R | Ctrl+Shift+R | Ctrl+Shift+R |
| `session.readonly` | ⌘⇧L | Ctrl+Shift+L | Ctrl+Shift+L |
| `session.log` | ⌘⇧J | Ctrl+Shift+J | Ctrl+Shift+J |
| `session.diagnose` | ⌘⌥D | Ctrl+Shift+Alt+D | Ctrl+Shift+Alt+D |
| `tools.broadcast` | ⌘⇧G | Ctrl+Shift+G | Ctrl+Shift+G |
| `tools.forwards` | ⌘⌥F | Ctrl+Shift+Alt+F | Ctrl+Shift+Alt+F |
| `window.close` | ⌘⇧W | — | — |
| `app.quit` | ⌘Q | — | — |

**唯一性结论**:三个平台上不同命令之间**只有一对**共用键位 —— `⌘A`(终端 `term.selectAll` / 文件面板 `files.selectAll`),按 S5 作为作用域隔离豁免并在设置页用不同行名标注。其余 34 个动作各自独占。(`⌘T` 的 P1-4 重叠已由 `ai.cycleEffort → ⌘⌥E` 解除。)

### 7.2 核验方式

复用 `docs/menu-audit.md` 附录 A2 的 `keymap-audit.mjs`:期望输出

```
同作用域冲突: 0
跨作用域同键: 1  (cmd+A: term.selectAll / files.selectAll)
有键位无菜单入口: 1  (tab.switch —— S6 允许的范围键位例外)
有菜单项无键位: 11  (app.about, cloud.import, files.revealLastDownload, hosts.export,
                     hosts.import, hosts.library, session.disconnect, session.log.folder,
                     settings.fingerprints, tools.batch, view.hostDensity)
```

> `palette.connectNewTab` 不在 `menuCommandIds()` 的口径里(它不是命令,是面板内的修饰键),脚本会把它算作"无菜单入口",按 S10 属于预期;若脚本按 `APP_ACTIONS` 统计,则它已在 `COMPONENT_ACTIONS` 中被排除。

---

## 8. 审计问题 → 处置映射(验收对照表)

| 问题 | 处置 | 落点 |
| --- | --- | --- |
| P0-1 同一动作一带有 `…` 一带没有(7 条) | 规则 + 删机制:删 `noEllipsis` 与 7 处调用 | E4、I4、§6.1(34、35、37、38、39、40、41 行)、§6.2 |
| P0-2 `tabs.list`/`session.search` kind 与行为不符 | 规则 + 行:`tabs.list` 改 action(去 `…`);`session.search` 保留 dialog(内嵌查找要输入,与`新建文件夹…`一致) | E2-a、E3-3、§6.1(16、25 行) |
| P0-3 `app.about` 弹窗却无 `…` | 规则:纯信息窗口是唯一例外,四类信息窗口判定口径统一 | E3-4、E7、N9 |
| P0-4 `tools.broadcast` 手写 `…` 且随状态漂移 | 规则 + 机制:标签去 `…`,改 `asks(ctx)` 仅选择菜单态为真 | E4、I3、§6.1(33 行)、§1.2 |
| P0-5 `…` 泄漏到命令面板/设置页 | 机制:`commandState().label` 返回裸文案 | §1.2、§6.2、§6.13 |
| P0-6 同一动作 8 组名字 | 规则 + 逐行:8 组全部定唯一写法,并删 4 处二级存储 | N4、I2、§6.1–§6.11 |
| P1-1 `连接` 与 `在新标签连接` 同行为 | 行:删除 `连接`,保留 `在新标签中连接` | §6.8 |
| P1-2 批量后缀位置三种写法 | 规则:`(N 项)` 在动词后、`…` 前 | N6、§6.9 |
| P1-3 `新建文件夹` 缺 `…` | 规则 + 行:补 `…` | E2-a、§6.9 |
| P1-4 `⌘T` 双占用 | 行:`ai.cycleEffort` 改 `⌘⌥E` / `Ctrl+Shift+Alt+E` | §6.3(17)、§7.1 |
| P1-5 有键位但菜单刻意不显示 | 规则:删 `accelerator: false`(只在平台无键时用) | S7、§6.5 |
| P1-6 `⌘↵` 不在 keymap | 行:新增 `palette.connectNewTab`,命令面板改走 `accelOf` | S10、§6.3(35)、§6.12 |
| P1-7 PC 编辑菜单缺项 | 行(PC 编辑补 `term.selectAll`)+ 规则(撤销/重做/剪切不进应用命令) | §6.5、S6 |
| P1-8 3 个键位无菜单入口 | 行:`term.selectAll` 进 PC 编辑并改走命令表、`files.selectAll` 进文件条目右键;`tab.switch` 作为范围键位例外 | §6.5、§6.7、§6.9、S6 |
| P1-9 4 个标签名含糊 | 行:改名/改归属 4 条(`打开最近下载位置`→`在文件夹中显示最近下载`、`记录会话日志`→`会话日志`、`AI 诊断报错`→`用 AI 诊断报错`;`紧凑列表` 保留名字但按 toggle 语义归入「主机」菜单) | N1、N8、G5、§6.1(13、30、32、42 行) |
| P1-10 动态标签措辞漂移 | 规则 + 行:白名单 + 去 `该/当前` | N2、N5、§6.1(14、18 行) |
| P1-11 category 与菜单不一致 | 规则 + 行:3 条修正,`view.hostDensity` 移菜单 | G5、§6.1(13、34、42 行) |
| P1-12 mac/PC 落点不同 | 规则:以平台差异表为准,不改 | G1 |
| P2-1 `F2` 在 mac | 规则:功能键例外,记录为规范 | S8 |
| P2-2 标题双括号 | 行:`分屏(%1)` | N2、§6.11 |
| P2-3 分组标题与项名重复 | 规则 + 行:标题改 `布局`;`主机管理` 标题因项名改为 `主机库` 而不再重复 | G4 |
| P2-4 条件确认没有 `…` | 规则:确认不加 `…`,且标签与状态无关 | E3-5、E4、G7 |
| P2-5 一个名字存 4 处 | 规则 + 机制:收敛到 2 处(注册表 + keymap),HTML 只留 `data-title` | I2、I6、§9.3 测试 1/5 |
| P2-6 AI 目标菜单三模式不成套 | 行:`跟随命令窗口` → `跟随模式` | §6.11 |

**P0/P1/P2 共 24 条,全部有规则依据或明确改名行,无遗留。**

---

## 9. 落地与验收

### 9.1 建议的提交切分(便于回滚)

1. `refactor(menu): 省略号改由渲染层决定,删除 noEllipsis 与 label 覆盖`(E/I 系列,§1.2、§6.2、§6.5、§6.6)
2. `refactor(menu): 标签收敛为注册表唯一来源`(§6.1、§6.7–§6.11、keymap 标签逐字对齐 N4)
3. `feat(keymap): ⌘T 归还 tab.new,ai.cycleEffort 改 ⌘⌥E;新增 palette.connectNewTab`(S5/S10,§6.3)
4. `style(menu): 快捷键显示排序与范围键位渲染`(S2/S9,§6.4 + 同步测试期望)
5. `feat(menu): PC 编辑补全选、文件右键改用 files.selectAll、视图补标签切换入口`(P1-7/P1-8)
6. `test(menu): 菜单文案与键位唯一性回归`(§9.3)

### 9.2 定点验收(不跑全量 e2e —— 项目铁律)

```bash
# 1) 机制已删除:不应有任何命中
grep -rn "noEllipsis" src/
grep -rn "overrides.label\|{ label: '[^']*' }" src/modules/entry.js | grep commandMenuItem
grep -rn "\.\.\." src/modules/*.js | grep -v "\.\.\.pc(\|\.\.\.[a-zA-Z]"   # 三个点的省略号
# 2) 标签里不应有 …(只能出现在渲染代码里)
grep -rn "label.*…" src/modules/*.js
# 3) keymap 与注册表标签逐字一致、键位唯一
node --experimental-vm-modules --test tests/keymap.test.mjs tests/menu-conventions.test.mjs
# 4) 构建
node build.mjs
```

### 9.3 必须新增的回归测试(`tests/menu-conventions.test.mjs`)

| # | 断言 | 守住的规则 |
| --- | --- | --- |
| 1 | 每个 `DEFAULT_KEYMAP[id].label` 与注册表 `label()` 逐字相同 | N4 / P0-6 复发 |
| 2 | 任何 `label()` 结果都不含 `…` 或 `...`;`menuLabelOf()` 只在 asks 为真时以单个 U+2026 结尾,且不以 `……` 或空格结尾 | E1 / I3 |
| 3 | 同一平台,不同 action 的键位签名无重复(仅允许 `⌘A` 的 term/files 一对),且 `⌘T` 只属于 `tab.new` | S5 / P1-4 |
| 4 | `index.html` 每个 `data-accel` 都能在 `DEFAULT_KEYMAP` 找到同名动作(或解析为裸 spec);`data-title` 去掉 `(%1)` 后等于该动作的 canonical 文案 | I6 / S6 / P2-5 |
| 5 | `MENU_SPEC` 里不存在 `text` 字段;`specFor()` 对 `mac` / `pc` 两侧的每一项 `cmd` 都有注册;同一 submenu 内无重复 `cmd`(除 视图/帮助 的 `palette.open`) | I2 / G6 |

### 9.4 明确不做

- 不改任何命令 id、不改行为逻辑(除 §6.8 删除重复项、§6.9 `files.selectAll` 改走命令表这两处等价替换)。
- 不动 `src/style.css`(快捷键列样式已存在),不新建菜单组件。
- 不跑 `npm test` / `e2e/ui.e2e.mjs`(发布前另行跑);不重建 `dist/` 以外的产物。
- 不引入 i18n 层(规范只要求"一个名字一份 canonical",不要求多语言)。
