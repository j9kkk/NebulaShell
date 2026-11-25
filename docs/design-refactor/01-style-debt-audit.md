# 01 样式债审计（UI/UX 重构基线）

> 状态：**只读审计，未改任何样式**。本文是「重构前基线」，后续每轮改动的验收都对着这里的数字。
> 复现命令见 §7。机器可读明细：`docs/design-refactor/01-audit-data.json`（332 条 lint 原文 + 全部聚合表）。

## 0. 一句话结论

`src/style.css` 单文件 5959 行、2008 条规则，**能用，但已经失去"改一处、全局一致"的能力**：21 处引用根本不存在的 token（其中 13 处无回落，整条声明在浏览器里直接失效）、圆角有 15 种裸值、字号 17 档、亮色主题的 19 处覆盖散落在组件段中间。所以这轮重构的顺序必须是 **先把 token 层修对，再谈换皮**——否则任何调色板改动都会被这 187 处硬编码吃掉一半。

## 1. 基线数字

| 指标 | 现状 |
|---|---|
| `src/style.css` | 5959 行 / 2008 条规则 / 单文件 |
| 契约静态检查（C1） | **error 0 / warn 322 / info 10** |
| warn 分布 | `token-radius 199`、`token-color 96`、`platform-scope 20`、`media-sizing 7` |
| 定义的 CSS 变量 | 63 个（暗色 55、亮色 46 + 散落块 2、9 个尺寸/字体类主题无关） |
| `var()` 引用 | 83 个名字 / **21 个从未定义** / 1 个定义后从未引用 |
| 组件层硬编码色值 | 113 处 hex（27 唯一）+ 74 处 rgba（63 唯一） |
| 字号 | 17 个唯一值，含 4 个半像素档 |
| 圆角 | 15 种裸值 + 31 种写法 |

> 与 `docs/ui-layout-contract.md` §三 记录的旧基线（`token-radius 202 / token-color 97 / platform-scope 16`）相比有轻微漂移——说明**没有门禁时基线会往上走**，这正是 C2「接 CI」要解决的问题。

## 2. 发现（按危害排序）

### F1 21 处引用不存在的 token，13 处声明整条失效 —— 唯一的真 bug

引用但全仓库（CSS 无定义、JS 无 `setProperty`）都不存在的变量：

| 变量 | 次数 | 回落 | 位置 | 后果 |
|---|---|---|---|---|
| `--line` | 11 | **无** | 全部 `.io-*`（导入/导出）：`.io-foot` `.io-list` `.io-list-head` `.io-item` `.io-list-more` `.io-chip` `.io-stat` `.io-report` `.io-mini-sel` `.io-seg-row` `.io-seg + .io-seg` | **描边整条不渲染**（已实测） |
| `--fg` | 2 | **无** | `.rdp-adv-title` L5894、`.rdp-chk` L5917 | 文字色退化为继承色 |
| `--accent-soft` → `--bg3` | 1 组 | **两级都未定义** | `.ai-confirm-host-tag` L1745 | 底色失效（恒为透明） |
| `--radius-xs` | 13 | 有（4/5/6px 三种） | 见 F3 | 三套隐式圆角 |
| `--accent-contrast` | 2 | 有（`#fff`） | `.ai-thread-count-badge` L728、`.ai-drawer-badge.busy` L783 | 无害（渲染即白） |
| `--text-dim` `--warn-bg` `--danger-bg` `--input-bg` | 5 | 有 | 各 1 处 | 无害 |
| `--radius-pill` | 1 | 有（11px） | `.ai-chip` L1396 | 无害 |

> 真正"声明整条失效"的是 **13 处**（`--line` 11 + `--fg` 2），加 1 处双级未定义共 **14 处**。其余 7 处只是 token 名被随手发明，回落值兜住了。

**机制已实测**（headless Chromium，见附录 A）：`var()` 无回落且未定义时，整条声明在计算值阶段失效（invalid at computed-value time）。实测 `border: 1px solid var(--line)` 的计算结果是 `border-top-width: 0px; border-top-style: none` —— **不是退回某个颜色，是边框完全消失**。

**含义**：`.io-*` 这 11 处描边从来没显示过。修 F1 不等于"恢复原状"，等于**首次让 11 处边框出现**。

> **已决（2026-11-25）**：这些边框**不要**。处置改为删除失效声明、保持现状外观 → 见 `02-b0-dead-token-fix.md`。实测零视觉变化（像素 4 组全等）。
> **但有一个陷阱**：删除失效声明对表单控件不等于零变化 —— 失效声明原本压制了 UA 默认样式，删掉后 `<select>` 会重新长出 UA 边框。B0 里靠 `.io-mini-sel` 补 `border: 0` 解决。

### F2 亮色主题不可维护：19 处覆盖散落在组件段中间

- 第 1 个 token 块 `:root, [data-theme="nebula"]`（L1-72，55 个变量）
- 第 2 个 token 块 `[data-theme="light"]`（L74 起，46 个变量）
- **第 3 个 token 块藏在 L3361**，只定义 `--net-rx-color / --net-tx-color` 两个变量，夹在 `mon-*` 规则之间
- 另有 **19 条 `[data-theme="light"] .某组件` 覆盖散落在 L2002-4685**，其中 **16 条集中在 L3367-3415 的 `mon-*` 监控段**

这是"双主题"最贵的结构债：亮色适配是**跟着组件写的**，新增组件时要记得回来补一条覆盖，漏了就漏了。且 16 条全在监控模块，说明当初是"亮色下监控面板发灰 → 就地打补丁"。

处置：这 19 条全部可归约成 token（`--net-rx-color`、`--shadow-sm`、`--surface-sunken` 等），按 R5「平台/主题差异只能在覆盖层表达」收进一个主题层。

### F3 圆角：15 种裸值 + 2 个引用未定义变量

| 值 | 次数 | 主要归属 | 建议 |
|---|---|---|---|
| `6px` | 58 | ai×20 rp×4 tag×3 file×3 | 按站点分派：独立控件→`--radius-sm(8px)`；容器内标记→`--radius-xs(4px)` |
| `8px` | 48 | ai×10 cloud×6 side×3 pp×3 | → `--radius-sm` |
| `4px` | 34 | ai×10 hl×4 model×3 snippet×3 | → `--radius-xs` |
| `999px` | 20 | ai×4 io×4 hl×3 model×2 | → `--radius-pill` |
| `7px` | 9 | rp×6 host settings hl | 消灭（→ 8 或 4） |
| `2px` | 7 | io×2 host fp collapsed | 消灭（→ 4） |
| `5px` | 6 | hlg×2 ai rp batch | 消灭 |
| `3px` | 6 | jump×2 tag×2 model ai | 消灭 |
| `12px` / `10px` / `22px` / `9px` / `11px` / `1px` | 12 | collapsed ai toast cloud host switch | → `--radius-lg(12px)` 或 4px，逐站点 |

另有 `var(--radius-sm, 6px)` 15 处、`var(--radius-xs, 4px)` 10 处、`var(--radius-xs, 5px)` 2 处、`var(--radius-xs, 6px)` 1 处、`var(--radius-pill, 11px)` 1 处 —— **回落值就是第二套真相**，`--radius-sm` 已被改成 8px，那 15 个写 `6px` 的地方实际早就渲染成 8px 了。

`--radius-pill, 11px`（`.ai-chip`，18px 高）改成 999px 视觉等价（999px 在此高度会被钳成胶囊，11px 也已超过半高）。`--radius-xs, 5px`/`6px` 三处会真的缩 1-2px，需人工确认。

### F4 字号：17 档，含 4 个半像素档

| 值 | 次数 | 主要归属 | 建议归档 |
|---|---|---|---|
| `12px` | 132 | ai×36 rdp×8 cloud×6 | `--fs-sm`（正文基准，不动） |
| `11px` | 100 | ai×41 io×8 rdp×6 | `--fs-xs` |
| `13px` | 55 | ai×8 io×5 cloud×3 | `--fs-md` |
| `11.5px` | 32 | **io×10** ai×8 cloud×4 host×3 | → 11 |
| `10.5px` | 29 | **io×18** ai×3 rp×2 hl×2 | → 10 |
| `10px` | 21 | ai×5 io×3 model mon | `--fs-2xs` |
| `14px` | 7 | tb ai palette-input | `--fs-lg` |
| `12.5px` | 6 | io×2 host ai-input strip | → 12 |
| `15px` | 5 | file icon io rdp | → 14 |
| `9px`×2 `9.5px`×1 `8px`×1 | 4 | tab hl mon | → 10 |
| `16px`×2 `20px`×1 | 3 | ai io welcome | `--fs-xl` / `--fs-2xl` |
| `40px`×1 `46px`×1 | 2 | about welcome | `--fs-hero`（合并为 44） |

**收敛到 8 档，76 处会位移 ≤1px**（8/9/9.5/10.5/11.5/12.5/15 这些档）。这是收益最大也最容易出事的一项：必须逐模块截图，不能整包一次性替换。

`io-*`（主机导入/导出）在两个维度上都是密度最高的模块：10.5px 占全仓库 18/29、11.5px 占 10/32、`--line` 11/11。**重构时把它单独排一批。**

### F5 96 条 `token-color` warn 的真实构成：74 真硬编码 + 19 主题覆盖 + 3 死回落

不分类会把它当成 96 个独立错误去改，实际是 5 个语义族：

| 族 | 次数 | 代表 | 处置 |
|---|---|---|---|
| 反白文字 `#fff` / `#ffffff` | 14 | `.ai-root-badge` `.win-ctl-close:hover` `.segmented-item.active` | 新增 `--text-on-accent` |
| 数据语义色 | ~14 | `#38bdf8`(sys) `#818cf8`(hist) `#34d399`(draft) `#a78bfa`(net-tx) `#059669`(mem) | 提为 `--scope-*` / `--net-*` / `--mem-color` |
| 云厂商品牌色 | 6 | tencent `#00a4ff→#38bdf8`、aliyun `#ff6a00→#fb923c` | `--vendor-*`，亮暗各一套 |
| 阴影 | ~20 | `0 8px 24px rgba(0,0,0,.45)` 等 14 种 | 收敛成 `--shadow-xs/sm/md/lg` 4 档 |
| 表面/叠加 | ~10 | `rgba(255,255,255,.08)`、`rgba(0,0,0,.22)` | 已有 `--surface-hover`，其余新增 `--surface-sunken/raised` |

亮色主题的 19 条覆盖全部集中在阴影与语义色上（`#0284c7` `#7c3aed` `#059669`），跟 F2 是同一件事的两面。

### F6 `platform-scope` 20 处 + `media-sizing` 7 处

- `999px` 出现在平台层之外 **20 处**（`.side-count` `.badge` `.model-chip` `.hl-count` `.io-badge` `.pp-chip` `.reasoning-chip` 等）→ 应统一走 `--radius-pill`，而 `--radius-pill` 按 R5 应当在 `platform-*` 覆盖层定义。
- `@media` 内声明尺寸 **7 处**（`.modal-*` 2、`.form-*` 2、`.cloud-*` 1、`.batch-results` 1）→ 按 R5 迁到平台覆盖层。

两项都不影响观感，但会卡住 C2「warn < 30 后开 `--strict` 门禁」——它们是最后 27 条。

## 3. 目标 token 提案（可直接落地）

```css
/* 圆角：6 档 + 1 例外 */
--radius-xs: 4px;     /* 容器内标记：复选框、徽章内块、行内 chip */
--radius-sm: 8px;     /* 控件：按钮、输入、下拉、表格内块（沿用现值） */
--radius-tab: 8px;    /* 标签上圆角（已有） */
--radius: 10px;       /* 卡片、面板（已有） */
--radius-lg: 12px;    /* 大浮层、弹窗（新增） */
--radius-pill: 999px; /* 胶囊（新增，进 platform-* 层） */
/* 50% 由 lint 放行，不建 token */

/* 字号：8 档 */
--fs-2xs: 10px;  --fs-xs: 11px;  --fs-sm: 12px;  --fs-md: 13px;
--fs-lg: 14px;   --fs-xl: 16px;  --fs-2xl: 20px; --fs-hero: 44px;

/* 语义色：把"随手发明"的 8 个名字补齐或替换 */
--line: var(--border);        /* 或直接替换成 --border，见 F1 */
--fg: var(--text);
--accent-contrast: #fff;      /* 与 --text-on-accent 合一 */
--text-on-accent: #fff;
--accent-soft / --text-dim / --warn-bg / --danger-bg / --bg3 / --input-bg
--scope-sys / --scope-hist / --scope-draft
--vendor-tencent / --vendor-aliyun
--net-rx-color / --net-tx-color（已有，提升为全局）
--mem-color
--shadow-xs / --shadow-sm / --shadow-md / --shadow-lg
--surface-sunken / --surface-raised（--surface-hover 已有）

/* 尺寸 token：把 --ctl-h 那把尺子补齐（对应契约 B1） */
--divider-w: 1px;  --cell-pad-x: 8px;  --row-h: 28px;
```

## 4. 迁移批次（每批独立可验收）

| 批次 | 内容 | lint 预期 | 视觉风险 |
|---|---|---|---|
| **B0** | 修 F1 的 14 处失效引用（`--line`/`--fg`/`--accent-contrast`） | warn 322→322（不改数量） | 低：用户已定「不要 io 描边」→ 删除声明而非补 token；实测零像素变化（见 `03`） |
| **B1** | 圆角 token 化 + `--radius-pill` 进平台层 | `token-radius 199→0`、`platform-scope 20→0`；warn **322→103** | 低：绝对值映射，8px 主体不动 |

> 已落地：见 `04-b1-radius-tokens.md`（含 `--radius-xs` 补定义、分段滑块同心圆角、`token-undefined` 新规则）。
| **B2** | 色值 token 化（5 族） | `token-color 96→19`(仅剩 light 覆盖)；warn **103→26** | 低-中：阴影统一会让部分浮层变浅/变深 |

> 已落地：见 `05-b2-color-tokens.md`（29 个 token 暗亮双定义、透明度改走 `color-mix`、唯一可见变化是确认卡 chip）。
| **B3** | 字号收敛 17→8 档 | 无 lint 规则覆盖（新规则 C-new 可加） | **高**：76 处位移 ≤1px |
| **B4** | light 覆盖归位（19 条 → 主题层） | warn **26→7** | 中：亮色下需逐屏复核 |
| **B5** | `media-sizing 7` 迁平台层 | warn **7→0** → 可开 `--strict` 门禁 | 低 |

顺序不可颠倒：B0 修的是"声明失效"，B1/B2 依赖 token 层正确，B3 必须最后做（字号一动，所有对像素的视觉判断基线全变）。

## 5. 与既有契约的关系

本审计不推翻 `docs/ui-layout-contract.md`，而是给它补上可执行的前置：

- **R1/R1b/R2/R3/R7**（行装饰、三态、空态原语）：与本次无冲突，`row-decoration` 10 条保持 info 级不动。
- **R4「尺寸来自 token，预算显式化」**：F3/F4/F6 全是 R4 的存量欠账，本报告给的就是 R4 的还款计划。
- **R5「平台/主题差异只能在覆盖层表达」**：F2（19 处散落 light 覆盖）和 F6（20 处 pill 越界）正是 R5 的违约。
- **R6「断言写关系式」**：B0-B5 全部用截图 + `?ui-contract` 自检验收，不引入像素基线。
- **R8「布尔控件只有一种关」**：`--radius-xs` 修好后要回查 `.sw.*` 是否出现圆角变体。

## 6. 未纳入本次范围

- 信息架构/布局重排（用户已定：本轮只换视觉）
- `src/modules/*.js` 里内联 style 写死的尺寸（264 处 `style.` 赋值未审计，属脚本层）
- `index.html` 内联 class 结构（未审计）
- 图表选型（`mon-*` 用 sparkline/环形是否该换 gauge/分组条形）——属设计决策，需先出方案

## 7. 复现命令

```bash
npm run lint:css                  # 基线：error 0 / warn 322 / info 10
node scripts/lint-css-contract.mjs --all > lint-all.txt

# 未定义 token 清单（21 个）
node -e 'const fs=require("fs");const css=fs.readFileSync("src/style.css","utf8").replace(/\/\*[\s\S]*?\*\//g,"");const d=new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m=>m[1]));const u={};for(const m of css.matchAll(/var\(\s*--([a-z0-9-]+)/g))u[m[1]]=(u[m[1]]||0)+1;Object.keys(u).filter(k=>!d.has(k)).sort((a,b)=>u[b]-u[a]).forEach(k=>console.log("--"+k,u[k]))'

# 字号/圆角/色值直方图
node -e 'const fs=require("fs");const css=fs.readFileSync("src/style.css","utf8").replace(/\/\*[\s\S]*?\*\//g,"");const h=re=>{const c={};for(const m of css.matchAll(re))c[m[1].trim()]=(c[m[1].trim()]||0)+1;return Object.entries(c).sort((a,b)=>b[1]-a[1])};console.log(h(/font-size:\s*([^;]+);/g).map(([v,n])=>v+"×"+n).join("  "))'
```

## 附录 A：`var()` 失效机制的实测记录

夹具（headless Chromium，780×437）：

```html
<style>
  #a { border: 1px solid var(--line); }      /* --line 未定义、无回落 */
  #b { border: 1px solid var(--border); }    /* --border 同样未定义 */
</style>
```

计算结果：

```json
{"a":{"color":"rgb(230, 237, 243)","width":"0px","style":"none"},
 "b":{"color":"rgb(230, 237, 243)","width":"0px","style":"none"}}
```

结论：`border` 简写里出现未定义且无回落的 `var()`，**整条简写失效**（style 回到 `none`，宽度计算为 0），不是"退回某个默认颜色"。所以 `.io-*` 的 11 处描边当前是**完全不渲染**，而非渲染成错误颜色。

## 9. 批次索引

流程与定点验证入口见 `README.md`；每批都按「lint → 单测 → ui-check ab → 截图」四步验收。

| 批次 | 记录 | 状态 |
|---|---|---|
| B0 失效 token 引用清理 | `02-b0-dead-token-fix.md`、`03-b0-real-ui-verification.md` | ✅ 已完成，待验收 |
| B1 圆角 token 化 | — | ✅ `04-b1-radius-tokens.md` |
| B2 色值 token 化 | — | ✅ `05-b2-color-tokens.md` |
| B3 字号收敛 | — | ✅ `06-b3-type-scale.md` |
| B4 light 覆盖归位 | — | 未开始 |
| B5 media-sizing 迁平台层 | — | 未开始 |
