# UI 布局契约（前置约束 + 门禁分层）

日期:2026-11-01 · 状态:提案（未实施）

## 〇、这份文档的由来

一次具体 bug:主机库选中空分组时,右侧空态区域多出一条横贯的分割线。
原因不是"某个人写错了",而是**一类结构性坏味道**:装饰（行分隔线）挂在
会被复用、且数量可能为 0 或 1 的容器（`<td>`）上。

清点全仓库,这个模式不是孤例:

| 位置 | 现状 | 状态 |
|---|---|---|
| `src/style.css` `.hl-table tbody td` | `border-bottom` 挂在 td 上 | 本次已加 `td.hl-empty{border-bottom:0}` 修补 |
| `.keys-table td` | 同样挂在 td 上 | **潜在同类问题**(空表/单行) |
| `#cloud-table td` | 同样挂在 td 上 | **潜在同类问题** |
| `#fw-table / #fp-table` th+td | 同样挂在 th 与 td 上 | **潜在同类问题**(表头也有线,首行会与表头线重叠) |
| `#batch-results` | 已有 `tbody tr:last-child td{border-bottom:none}` | **同类问题已经发生过一次,当时是修补而非根治** |
| `#ai-model-table-empty` | 空态是表格**外面**的兄弟 div | **同一个仓库里已有的正例** |

结论:同一类 bug 至少出现过两次,一次已用 `:last-child` 打了补丁。所以需要的不是
再打第三次补丁,而是把这类问题抽象成可执行的规则 + 静态检查,让它**写不出来**。

---

## 一、七条通用规则

每条给:规则 → 为什么（失败模式）→ 正/反例 → 怎么自动检出。

### R1 装饰归属于"关系",不归属于可复用容器

行分隔线、圆角、阴影这类**只在与邻居共存时才有意义**的装饰,不能无条件挂在
会被复用、且数量可能为 0 或 1 的容器上。

- 反例(A 类事故的源头):把"非数据"塞进数据槽位 ——
  `<tr><td colspan=9 class="empty">…</td></tr>`。此时 `td { border-bottom }` 变成一条
  悬在空白里的横线,还要额外对抗单元格的省略号、紧凑内距和垂直对齐。
- 反例(B 类,写法本身就错):`tbody tr + tr > td { border-bottom }` —— 它让**第 1、2 行之间**
  丢掉分隔线(该选择器从第 2 行开始命中),视觉回归。
  正确写法二选一:`tr + tr > td { border-top }`,或"所有行 `border-bottom` + 末行按需收口"。
- **本次采用的规则(更强,且改动最小)**:*数据槽位只放数据行*。空/加载/错误态一律用
  表外的 `.empty-state` 兄弟节点,于是 `td` 上的行级装饰回到安全状态,零视觉变化。
- 检出:stylelint 无法可靠判定"谁是数据行",因此这条靠 ①结构约定(§四 `.empty-state` 原语)
  ②dev 自检断言 `expectDataRowsOnly(tbody)`(tbody 内不得存在无 `data-id` 的行)。

### R1b 表格末端是否需要"终线",看宿主有没有边框

- 宿主自带 `border`(如 `.batch-table-wrap`、`#batch-results`)→ 末行不画线,否则叠出双线。
  这正是 `#batch-results tbody tr:last-child td { border-bottom: none }` 的由来,
  **它不属于 R1 的 bug,是边界收口的正常处理**。
- 宿主内区敞开(如 `.hl-body` 里的表格)→ 末行保留一线作为收口。

### R2 集合组件必须先定义三态

任何列表/表格/网格,实现前先画出 **N=0 / N=1 / 筛选无结果** 的布局,再写第一行代码。
N=0 一律不复用数据行容器。

- 反例:空态塞进 `<tr><td colspan=9>` → 被迫对抗 td 的省略号、内距、行线、垂直对齐
- 正例(仓库内已有):`#ai-model-table-empty` 是表格外的兄弟 div
- 检出:dev 自检在每种状态下跑几何断言(§四);代码审查 7 问(§六)

### R3 装饰默认可撤销,由状态类开启

任何只在特定状态有意义的装饰,基础选择器里必须是"无",由 `.is-empty / .is-loading /
.is-error / .has-next` 之类状态类开启。

- 反例:先给 td 画线,再在空态里 `border-bottom: 0` 抵消
- 正例:`tr + tr` 天然实现;或容器上 `.list > .item:not(:last-child)`
- 检出:同 R1

### R4 尺寸来自 token,预算显式化

列宽预算、最小控件高、圆角、内距必须来自 CSS 变量,并在注释里写清预算算式;
测试**从变量读值**而不是硬编码。当前 `e2e/helpers/layout-audit.mjs` 里
`[180,196,220,264,320,480]` 这类档位与 CSS 各写一份,样式改了测试不会红。

- 正例:`.hl-w-name { width: var(--hl-col-name) }`,审计脚本读同一个变量
- 检出:stylelint 限制 `padding/margin/border-radius/width` 的裸值(§三)

### R5 平台差异只能在覆盖层表达

`platform-darwin / platform-nonmacos` 是唯一的平台分支入口;差异集中在一处
token 覆盖层,禁止在 `@media` 或组件规则里散写尺寸差异。

- 例子:胶囊按钮 `--radius-pill: 999px`(macOS)/ `--radius-btn: 6px`(非 macOS)
- 检出:stylelint `selector-disallowed-list` 限定平台选择器可用范围

### R6 断言写关系式,不写绝对像素

`|上留白 − 下留白| ≤ 1`、`scrollHeight ≤ clientHeight + 1`、`无多余边框`、
`控件不出容器`、`兄弟控件不重叠` —— 这类断言在字体度量漂移、平台差异下依然成立。
绝对像素断言只在**同平台同引擎**的基线里用。

### R7 三种非数据态共用一个语义容器

`is-empty / is-loading / is-error` 挂在**容器**上(如 `#hl-table-wrap`),组件只读这些类,
不各自发明 `empty-row / no-data / placeholder` 等新范式。

- 现状:`#hl-table-wrap.is-empty` 已经是这个方向,继续扩展即可
- 检出:新增状态类必须先在 §四 的断言库里注册

---

## 二、影响面清单

改动按"结构性 / token / 静态检查 / 自检 / 门禁"分组。每项标影响面与验证方式。

### A. 结构性改造

| # | 改动 | 文件 | 影响面 | 验证 |
|---|---|---|---|---|
| A1 | ~~表格行线统一改为 `tbody tr + tr > td`~~ **已否决**:该写法会让第 1、2 行之间丢线(见 R1)。改为"数据槽位只放数据行",行线保持原样 | — | 零视觉变化 | 非空列表 `rowH/tableH/theadH` 与改动前逐项相等 |
| A2 | `#batch-results tbody tr:last-child td` 保留 | `style.css` | 属 R1b 的边界收口,不动 | 注释已说明 |
| A3 | 空态原语化:新增 `.empty-state`(表外兄弟节点 + flex 撑满居中),主机库空态迁移 | `index.html` / `host-library.js` / `style.css` | 删除三处 hack(`td.hl-empty` 覆盖、`height:100%`、`thead tr height:1px`) | 居中偏差 0、无多余线、无滚动;见 §八 |
| A4 | 清点其余集合组件是否有同类风险:`#host-list`、命令历史、`#file-tree`、标签行、分组导航、AI 消息流 | 全仓库 | 需逐个看"容器默认装饰 + 子元素数量可变"的组合 | 逐个跑 §四 的 `expectNoStrayDecoration` |
| A5 | 状态类规范化 `is-empty/is-loading/is-error` | 各模块 | 命名与挂载点统一 | 单测 + dev 自检 |

### B. Token 化

| # | 改动 | 现状 | 建议 |
|---|---|---|---|
| B1 | 新增 `--divider-w / --divider-color / --radius-pill / --radius-btn / --row-h / --cell-pad-x` | 105 个变量已存在,但 `1px solid` 直写 169 处、`padding` 裸值 300 行 | 先让新代码强制走 token,旧代码用 codemod 分批收敛 |
| B2 | 平滑密度/主题/平台覆盖层 | 现分散在各组件 | 新建 `platform-tokens.css`,平台差异集中于此 |

### C. 静态检查（当前完全没有）

| # | 内容 | 说明 |
|---|---|---|
| C1 | ~~引入 stylelint~~ **已改为零依赖脚本** `scripts/lint-css-contract.mjs`(5 条规则,见 §三) | 已实施 |
| C2 | 接 CI:待 warn 收敛到 <30 后用 `--strict` 接入 | 现状 322 warn,直接开等于假门禁 |
| C3 | 接入 PR 门禁 | 与单测同层,`npm run lint:css:strict` |

### D. 运行时自检（前置到写代码的 30 秒内）

| # | 内容 | 说明 |
|---|---|---|
| D1 | 抽 `src/dev/ui-contract.mjs` 断言库 | 复用 `e2e/helpers/layout-audit.mjs` 的关系式逻辑 |
| D2 | 挂载点:模态打开 / 分组切换 / 窗口 resize(debounce) / 状态类变更 | dev 构建生效,生产包由 `build.mjs` 摇掉 |
| D3 | 输出 console 表格 + `window.__uiContract` | 可选:失败时右上角红色 toast |

### E. 门禁分层

| 层 | 内容 | 阻断 |
|---|---|---|
| PR | 单测 + stylelint + 关系式审计(L1/L2 数值) | 是 |
| 发布前 | 5–8 张全页像素基线(真身引擎),不做跨平台比对 | 是 |
| 日常 | 无像素 | — |

顺带修:C1 之外,`e2e/host_cloud_ux.test.mjs`(234 行)、`e2e/file-tools.unit.test.mjs`(801 行)
目前是孤儿——`test:unit` 的 glob 只覆盖 `tests/*.test.mjs` 与 `src/modules/*.test.mjs`,CI 也没引用。

---

## 三、静态检查规则集（C1,已实施）

**没有引入 stylelint**:存量裸值太多(见下方基线),而需要的规则多是"选择器 × 属性 × 值"
的交叉判定,stylelint 原生表达不了,反而要引 3–4 个插件。改为**零依赖脚本**
`scripts/lint-css-contract.mjs`(自带极简 CSS 扫描器,识别规则链与 @media 上下文)。

```bash
npm run lint:css          # 报告,退出码恒为 0(warn 不阻断)
npm run lint:css:all      # 每规则展示全部条目(默认只展示前 5 条)
node scripts/lint-css-contract.mjs --strict   # 有 warn 即退出码 1(接门禁用)
```

已实现的 5 条规则(对应契约 R1/R1b/R4/R5):

| 规则 | 级别 | 内容 |
|---|---|---|
| `token-color` | warn | `color/background/box-shadow/fill/…` 出现 `#hex`/`rgb()`/`hsl()`/命名色 → 走 `var(--…)`(含 `box-shadow` 里的阴影色) |
| `token-radius` | warn | `border-radius` 裸值 → 走 `var(--radius-*)`;`0/50%/inherit` 例外 |
| `platform-scope` | warn | `999px/9999px` 胶囊尺寸出现在 `platform-*` 作用域之外 |
| `media-sizing` | warn | `@media (min/max-width/height)` 内声明 `width/height/padding/margin/gap/border-radius` |
| `row-decoration` | **info** | `td/th/li` 上的 `border*` 用了字面量值 → 提示"行级装饰走 token,并确认空态不占行槽位" |

> `row-decoration` 刻意只做 info:`td` 上的行线本身不是错误(错误是"非数据态占了行槽位"),
> 而"谁是数据行"无法静态判定。真正的守门靠结构约定(R1 + `.empty-state` 原语)和
> dev 自检的 `expectDataRowsOnly(tbody)`。

**当前基线**:`error 0 / warn 322 / info 10`,分布 `token-radius 202`、`token-color 97`、
`platform-scope 16`、`media-sizing 7`、`row-decoration 10`。

**收敛计划**:`token-radius` 先建 4 个尺寸 token(`--radius-sm/md/lg/pill`)后可用 codemod 批量替换,
预计 warn 降到 <30 再开 `--strict` 作为 PR 门禁;在此之前**不进 CI**,避免重演
`ui-e2e` 那种"常年 continue-on-error"的假门禁。

---

## 四、断言库清单（D1,已实施）

落地在 `src/modules/ui-contract.js`(生产默认不装观察器,见 §六 D2)。全部为"关系式"断言,
返回 `{ok, detail}`,可跨平台共用:

| 函数 | 断言 | 覆盖的历史 bug |
|---|---|---|
| `expectContained(container, child, tol=1)` | 子元素不出容器 | 面板窄宽度下按钮溢出 |
| `expectNoOverlap(a, b, tol=1)` | 兄弟控件不重叠 | 标题栏与二级区重叠 |
| `expectNoOverflowText(el)` | `scrollWidth ≤ clientWidth+1` | 长主机名/长模型名截断 |
| `expectMinTarget(el, h=25)` | 可点控件不小于最小高 | 压缩高度 |
| `expectCentered(el, container, axis, tol=1)` | 内容中心与容器中心偏差 ≤ tol | **本次垂直居中** |
| `expectNoStrayDecoration(el, sides)` | 指定边无 border/shadow | **本次多余分割线** |
| `expectNoUnexpectedScroll(container)` | `scrollHeight ≤ clientHeight+1` | 空态出滚动条 |
| `expectHairlineAt(container, y, colorToken)` | 指定 y 存在 1px 线且颜色在 token ±ΔE 内 | 分隔线错位/丢失 |
| `expectStateClass(container, name)` | 三态类存在且互斥 | R7 |（待做）

已实现的导出:`expectContained`、`expectNoOverlap`、`expectNoOverflowText`、`expectCentered`、
`expectDataRowsOnly`、`expectNoUnexpectedScroll`;运行时通过 `window.__uiContract` 暴露
(`run(scope)` / `last` / `runs` / `on()` / `off()`)。

**自动巡检覆盖**(弹窗显隐、列表重绘、窗口 resize 后去抖触发):
① `tbody` 内不得出现"跨列且无内容标记"的占位行;
② `.empty-state` 双向居中(参考系是元素自身内容盒,避免 scrollbar-gutter 误报)、无边框、父容器不滚动;
③ 模态卡内可见控件不越界(跳过内部滚动区)、成组按钮不重叠。

---

## 五、新组件落地 7 问（PR 模板勾选项）

1. N=0 / N=1 / 筛选无结果 三种状态都画过、都截图了吗?
2. 装饰挂在**关系**上(相邻选择器/状态类),还是挂在可复用容器上?
3. 基础选择器里的装饰是否"默认可撤销",由状态类开启?
4. 尺寸/圆角/内距是否来自 token?测试是否从同一 token 读值?
5. 平台差异是否只写在 `platform-*` 覆盖层?
6. 新增断言是否为关系式?是否注册进 §四 断言库?
7. 是否在 dev 自检的挂载点里覆盖(模态/切态/resize)?

---

## 六、工作量与顺序

| 阶段 | 内容 | 估时 | 风险 |
|---|---|---|---|
| P0-1 | A1 + A2(表格线统一到 `tr + tr`) | 0.5 天 | 末行线消失的视觉变化,需两种引擎对照确认 |
| P0-2 | A3 空态原语化 + 删掉 `height:100%/tr height` 的拉伸 hack | 0.5 天 | 需同步 `emptyRow()`、状态类、断言 |
| P0-3 | 两个孤儿测试接进 `test:unit` | 1 小时 | 无 |
| P1-1 | ~~stylelint~~ → 契约 lint 脚本（已实施：5 条规则 + warn 基线 322） | 完成 | 存量裸值收敛是持续工作 |
| P1-2 | D1/D2 断言库与 dev 自检 | 1 天 | 断言误报会打扰开发,需先窄后宽 |
| P2 | A4 全仓清点其余集合组件 + B2 平台 token 覆盖层 | 2 天 | 影响面最广,建议独立 PR |
| P3 | 发布前像素基线(5–8 张,真身引擎) | 2–3 天 | 见前文讨论:`/shot` 端点 macOS 便宜、Windows 昂贵 |

顺序理由:先把"这类 bug 写不出来"的低成本项做完(A1/A2/A3),再上静态检查守住新代码,
最后才谈像素基线——像素是兜底,不是主防线。

---

## 七、验证口径（本次改动怎么算通过）

1. **几何**:`expectCentered` 偏差 ≤1px、`expectNoStrayDecoration` 通过、`expectNoUnexpectedScroll` 通过。
2. **像素**:裁剪区域逐行亮度扫描,空态下方不得出现亮度高出中位数 >1.5 的横贯行
   (本次定位手段,可保留为一次性复核,不进回归)。
3. **回归**:非空列表行分隔线仍在(第二行起),表头线仍在,首行无顶线。
4. **范围**:不跑全量 e2e;只做上述定点验证(项目约定)。

---

## 八、实施记录（P0 已完成）

改动文件:`src/index.html`、`src/modules/host-library.js`、`src/style.css`、
`e2e/host_cloud_ux.test.mjs`、`package.json`。

1. **空态原语化**:`#hl-table-wrap` 改为纵向 flex;`.hl-table` 固定 `flex:0 0 auto` 不参与拉伸;
   新增表外 `.empty-state`(flex:1 + 双向居中)。`emptyRow()/mkEmptyAction()` 删除,
   改为 `fillEmptyState()` 填 `#hl-empty` 里的标题/提示/动作三个节点。
2. **删除三处 hack**:`td.hl-empty` 边框覆盖、`.hl-table-wrap.is-empty .hl-table{height:100%}`、
   `thead tr{height:1px}`。`is-empty` 保留为纯状态类(R7),不再承担布局。
3. **行线不动**:确认原 `.hl-table tbody td{border-bottom}` 在"非数据不占行槽位"后已安全,
   改动前后几何逐项相等(`rowH 35 / tableH 102 / theadH 32`,WebKit;Chromium 33/103 同比例)。
4. **孤儿测试接线**:`test:unit` 增加 `e2e/*.test.mjs`。修了两处桩缺失导致 8 例失败:
   合成 `./terminal.js` 补 `rankPickerHosts` 导出;vm 上下文补 `Event` / `document.dispatchEvent` /
   `document.getElementById`。现 `npm run test:unit` 506/506 通过。

定点验证数据(Playwright + 假后端,WebKit / Chromium 双引擎):

| 场景 | 结果 |
|---|---|
| 空分组的空态 | 居中偏差 0(上 140 / 下 140);无滚动;表格仅剩表头(32px) |
| 空态像素扫描 | 无横贯细线;仅表头线与按钮自身边框(60px 跨度,非整行) |
| 空态 → 「查看全部」 | 回到 2 行列表,状态类 `is-empty` 正确摘除 |
| 搜索无匹配 | 同一节点复用,文案/按钮换成「清空搜索」,提示行隐藏 |
| 长表(11 台、窗口 560 高) | 容器溢出滚动,表头吸顶 `thTop=0` |
| 控制台错误 | 无 |

---

## 九、实施记录（P1-2 已完成：运行时自检）

新增 `src/modules/ui-contract.js`（约 230 行），在 `entry.js` 的 `boot()` 之后
`installUiContract()`。开关：`?ui-contract` / `localStorage['nb.uiContract']=1` /
`window.__NB_UI_CONTRACT__` / `window.nebula.testMode`；全关时只做一次判断，不装观察器。
干净时不打印任何东西，有 issue 才输出折叠分组（`console.groupCollapsed`）。

**自证**（WebKit / Chromium 双引擎，注入式回归）：

| 场景 | 结果 |
|---|---|
| 打开主机库（非空） | 0 issue |
| 空分组空态 + observer 自动触发 | 0 issue（`runs` 递增，说明自动巡检真的在跑） |
| 注入①：把空态塞回 `<tr><td colspan=9>` 并画线 | 报 `tbody#hl-tbody — 第 1 行是跨列占位行…且带 1px 行线` |
| 注入②：空态 `justify-content:flex-start` | 报 `div#hl-empty.empty-state — 纵向偏差 -255px` |
| 注入③：按钮挪到 `left:2000px` | 报 `button#hl-new-host…右侧超出 950px` |

**假阳性扫描**：11 个模态（主机库 / 设置 / 指纹 / 批量 / 转发 / 片段 / 历史 / 云导入 /
命令面板 / 新建主机 / 关于）逐个打开巡检，两引擎均 **11/11 零误报**。

**顺带修掉一个真实缺陷**：扫描时 `settings.fingerprints` 报出
`tbody#fp-tbody — 第 1 行是跨列占位行，且带 1px 行线` —— 指纹弹窗的"暂无记录"正是
R1 的同类写法（空态塞进 `<tr><td colspan=3>`）。已改为表外 `.empty-state`
（`index.html` + `hosts.js`），并给断言加了例外：带 class / `data-*` 的跨列行
（云主机按地域分组的标题行）不算占位，避免误报。

**两处跨引擎教训**（都已写进代码注释）：
1. `expectCentered` 的横向参考系必须用**元素自身内容盒**。初版用父容器边框盒，WebKit
   通过而 Chromium 报"横向偏差 9px"——`scrollbar-gutter: stable` 在经典滚动条下真的吃掉 9px。
2. 断言容差与参考系的选择，比断言本身更容易出错；跨引擎双跑是廉价的自检手段。

---

## 十、实施记录（P2 已完成：集合组件清点 + 平台覆盖层归档）

### A4 集合组件清点

判定标准只有两条:①行级装饰(分隔线/斑马纹/圆角)挂在**数据行**上;②空态**不占**数据槽位。

| 组件 | 行装饰策略 | 空态策略 | 结论 |
|---|---|---|---|
| 主机库表格 `.hl-table` | `td` 行线(数据行安全) | 表外 `.empty-state` | ✅ 已改造 |
| 指纹表 `#fp-table` | `th/td` 行线 | 表外 `#fp-empty`(本次修) | ✅ 已改造 |
| 批量结果 `#batch-results` | 行线 + `tr:last-child` 收口(容器有边框) | 表外 `#batch-empty` | ✅ R1b 正常 |
| 云主机 `#cloud-table` | 行线 + 分组标题行(带 class 的内容行) | 表格 `hidden` | ✅ 无需改 |
| 快捷键 `#keys-table` | 行线 | 表头常驻,行永远存在 | ✅ 无需改 |
| 转发/指纹规则 `#fw-table` | 行线 + `tr:last-child` 收口 | 表格 `hidden` | ✅ R1b 正常 |
| 侧栏主机 `.host-item` | **无行线**(圆角+背景) | `.host-empty` 是 `#host-list` 的子 div,不占 item 槽位 | ✅ 结构正确 |
| 文件列表 `.file-row` | 无行线 | `.file-empty`(hist-list 子节点) | ✅ |
| 命令历史 `.hist-row` | 无行线 | `.file-empty` | ✅ |
| 片段 `.snippet-row` | 无行线 | `.empty-state` 系(模态内) | ✅ |
| 标签行 `.tab` | 边框用于选中态,非行分割 | — | ✅ |
| 分组导航 `.hl-group` | 圆角+`border: transparent`,选中态染色 | — | ✅ |
| AI 消息 / 线程 | 气泡圆角 | `.ai-drawer-empty` | ✅ |
| 模型表 `.model-table-row` | 行线 + `:last-child` 收口 | `#ai-model-table-empty` 兄弟节点 | ✅ R1b 正常 |
| 传输任务 `.fp-task` | 行线 + `:last-child` 收口 | `.fp-task-empty` 兄弟节点 | ✅ R1b 正常 |
| 命令面板 `.pal-item` | 无行线 | `.pal-empty`(`#palette-list` 子节点) | ✅ |
| 常用命令 `.rp-snip` | 无行线 | `.rp-empty` | ✅ |

结论:**R1 违规已清零**。存量里只有表格类会用行线,而非表格列表一律"圆角+背景",
天然不受该 bug 影响;两个 `:last-child` 补丁属 R1b(容器有边框时的收口),保留。

实测(WebKit/Chromium 双引擎,契约自检):侧栏搜索无结果、命令面板无匹配、片段、历史、
AI 抽屉、传输任务、主机库、指纹、设置、批量、转发、云导入 —— **全部 0 issue**。

### B2 平台覆盖层归档

**先修正一个前提**:本仓库的平台差异面只有 9 条规则,且全部集中在标题栏结构
(红绿灯 vs 菜单栏+窗口按钮、以及由此产生的内距/顺序),**不存在**"macOS 胶囊按钮 vs
Windows 6px 圆角"这类参数化差异(圆角 999px 的胶囊是全平台一致的)。
所以没有新建 token 层 —— 为 9 条结构差异造 token 只会增加间接层,不会带来可配置性。

实际做的是**归档 + 守门**:

1. 9 条 `platform-*` 规则全部移到 `src/style.css` 末尾的「平台覆盖层」段落,段落开头写明
   政策(新差异只能加在这里)与现状说明;其他地方只留平台无关的基准规则。
2. 混写选择器拆开:`body.platform-darwin #win-controls, body.is-fullscreen #win-controls`
   → 平台部分归入段落,`is-fullscreen`(状态)留在原位。
3. 契约 lint 新增 `platform-section` 规则:平台选择器出现在「平台覆盖层」段落之前 → warn。
   自测:构造 `platform-darwin` 规则放在标记前,能准确报出「第 1 行 < 2 行」。

**零视觉变化的证明**:对 33 个关键选择器 × 27 个计算属性,在 `platform-darwin` 与
`platform-nonmacos` 两种构建下各拍一次计算样式快照,重排前后逐项对比 ——
**差异 0 处 / 0 处**(两平台各 891 项)。
