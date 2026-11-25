# B4 · 亮色差异下沉到 token 层

> 批次：token 层还债 第 4 批（B0 失效引用 → B1 圆角 → B2 色值 → B3 字号 → **B4 亮色覆盖** → B5 media-sizing）
> 基线：`60ad88a`（B3 完成态）
> 目标：亮色与暗色的**色值差异只写在 token 层**，组件段不再出现 `[data-theme="light"] .某组件 { 色值 }` 这类散落覆盖。

## 1. 验收标准与结论

| # | 验收标准（可执行断言） | 实测 | 结论 |
|---|---|---|---|
| 1 | `lint:css` 的 `token-color` 归零；error 0 | **19 → 0**；error **0** / warn **26 → 7**（只剩 media-sizing 7） | ✅ |
| 2 | 亮色组件覆盖里出现的色值字面量 = 0（字面量只许在 `:root` / `[data-theme="light"]` 的 token 块里） | 带字面量的亮色规则 **13 条 → 0 条**；规则块 **25 → 10**（1 个 token 块 + 9 条结构覆盖） | ✅ |
| 3 | 亮色对外观**零变化**：同一批选择器计算样式逐字相同 + 像素净差 0 | 探针 16 个选择器（亮/暗各一次）`styles 无差异`、`net 0`；亮色 5 个真实场景 `net 0`；暗色 3 个场景 `net 0` | ✅ |
| 4 | 每改一处都记下「原覆盖值 → 落到的 token」 | §3 全表 19 条 | ✅ |
| 5 | 亮色单独渲染一遍截图并人工过目 | 亮色 6 张（含探针卡）+ 暗色 3 张 | ✅ |
| 6 | `build:web` ok、`test:unit` 575/575 | ok；**575 pass / 0 fail** | ✅ |

## 2. 做法

1. 在 `:root` 里加一档**亮色差异层**（暗值在前、注释说明「亮色块里另给值」）；
2. 在 `[data-theme="light"]` token 块里给这批 token 的亮值 —— 值来自原来那条组件覆盖；
3. 组件规则改成引用 token，删掉组件覆盖；
4. 只有「亮色下结构不同」的覆盖留下（半透明叠加换成实心底 `--bg2`、压掉阴影、压掉 SVG 底色），集中到 `style.css` 顶部的一个区块，标题写明**规则里只允许引用 token**。

## 3. 19 条覆盖的去向

| 原覆盖（亮色） | 原值 | → 落到 |
|---|---|---|
| `.ai-context-trigger:hover` | `rgba(0,0,0,.05)` | `--surface-hover-weak`（暗 `rgba(255,255,255,.08)` = 原 `--surface-hover` 值） |
| `.ai-context-ring .mon-ring-bg` | `rgba(0,0,0,.08)` | `--ring-track`（暗 `var(--progress-track)`）→ 见 §5 的坑 |
| `.ai-ctx-pop-bar-wrap` | `rgba(0,0,0,.08)` | 已有 token `--surface-inset`，亮值改为 `rgba(0,0,0,.08)` |
| `.ai-context-popover` 阴影 | `0 10px 30px rgba(31,35,40,.12), 0 1px 3px rgba(31,35,40,.08)` | 新 `--shadow-overlay`（暗 `var(--menu-shadow)`） |
| `.mon-deck` 发丝影 | `0 1px 2px rgba(31,35,40,.04)` | 新 `--shadow-hairline`（暗 `none`，基础规则里新增这条声明） |
| `.mon-lat-item .mon-item` 发丝影 | 同上 | 同上 |
| `.mon-dir.mon-up` | `#0284c7` | `--net-rx-color`（暗 `#38bdf8`） |
| `.mon-dir.mon-down` | `#7c3aed` | `--net-tx-color`（暗 `#a78bfa`） |
| `.mon-cpu-popover` 阴影 | 同 `.ai-context-popover` | `--shadow-popover` 的亮值（暗值不变） |
| `.mon-pop-dot` 光晕 | `0 0 4px rgba(9,105,218,.35)` | 新 `--glow-accent`（暗 `0 0 6px var(--accent)`） |
| `.mon-mem-dot` 底色 / 光晕 | `#059669` / `0 0 4px rgba(5,150,105,.35)` | 新 `--mem-color`（暗 `var(--accent2)`）/ `--glow-mem` |
| `.mon-mem-cur` | `#059669` | `--mem-color` |
| `#mon-mem-pop-line` / `#mon-mem-pop-point` / `#mon-mem-grad stop:*` | `#059669` | `--mem-color`（3 处 fill/stroke/stop-color 合并成 1 个 token） |
| `.mon-net-dot` 底色 / 光晕 | `#7c3aed` / `0 0 4px rgba(124,58,237,.35)` | `--net-tx-color` / `--glow-net` |
| `.mon-pop-grid` | `rgba(31,35,40,.08)` | 已有 token `--chart-grid`，亮值改为 `rgba(31,35,40,.08)` |
| `.ai-reasoning-thumb` | `0 1px 4px rgba(0,0,0,.2), 0 0 0 1px rgba(31,35,40,.25)` | 新 `--shadow-thumb`（暗 = 原 `--shadow-xs` 的 `0 1px 3px rgba(0,0,0,.25)`） |

新增 10 个 token（暗/亮各一份），修正 3 个已有 token 的亮值（`--surface-inset`、`--chart-grid`、`--shadow-popover`）。亮色 token 块现在共 **87** 个。

留下的 9 条结构覆盖（都只引用 token）：

```
.ai-context-trigger   background/border/box-shadow: none     ← 亮色下不带按钮壳
.ai-context-popover   实心底 --bg2
.mon-deck             实心底 --bg2 + --border
.mon-lat-item .mon-item 同上
.mon-cpu-popover      实心底 --bg2 + --border
.mon-pop-chart        实心底 --panel
#mon-pop-point        stroke --bg2   ← 折线点用底色描边挖洞
#mon-net-pop-{rx,tx}-point 同上
.ai-context-ring .mon-ring-bg  stroke --ring-track  ← 见 §5
```

## 4. 等价性证据（`ab --ref 60ad88a`）

新增场景 **`light-probe`**：把「只在亮色下改过值」的那批组件（`.mon-deck`、`.mon-item`、`.mon-pop-dot`、`.mon-mem-dot/.mon-mem-cur`、`.mon-net-dot`、`.mon-dir`、`.ai-ctx-pop-bar-wrap`、`.ai-context-trigger`+`.mon-ring-bg`、`.ai-reasoning-thumb`、`.mon-pop-grid`、`#mon-mem-pop-line/point`、`#mon-pop-point`）塞进真实 DOM，**连 `.mon-ring` 这层包裹一起复刻**，再用计算样式对照旧 CSS。

| 场景 | 主题 | 样式差异 | 像素 净差 |
|---|---|---|---|
| `light-probe`（16 选择器） | 亮 | **无差异** | **0** |
| `light-probe`（16 选择器） | 暗 | **无差异** | **0**（像素完全一致，连噪声都没有） |
| `hosts` / `import-preview` / `rdp-top` / `host-library` / `settings` | 亮 | 无差异 | **0**（原始差异 0/44/283/12/13 全被噪声地板吃掉） |
| `hosts` / `import-preview` / `settings` | 暗 | 无差异 | **0**（0/42/13） |

## 5. 这一批踩的两个坑（都靠实测抓出来的）

**坑 1：`:root` 里后出现的暗色定义会盖掉亮色块。**
`--net-rx-color / --net-tx-color` 这对变量当初是在文件第 3435 行的**第二个 `:root`** 里定义的（因为加得晚，要压在亮色块后面），于是作者只好在它后面再补一个 `[data-theme="light"] { --net-rx-color: #0284c7 }`。
我删掉那个亮色补偿块、把值搬进主 `:root` 之后忘了删那个第二 `:root` → 亮色下环形/箭头又变回暗色（探针当场报 `.mon-dir.mon-up` `rgb(2,132,199) → rgb(56,189,248)`）。
修：把这两个暗值并进主 `:root`（文件顶部，天然在亮色块之前），删掉第二个 `:root`。
**教训：整个文件只允许一个 `:root` 装 token；谁要在中途补 token，就得回去改顶部那块，而不是再开一个。**

**坑 2：`.mon-ring-bg` 这个类被监控环和 AI 上下文环共用，胜负靠位置。**
`.ai-context-ring .mon-ring-bg { stroke: var(--ring-track) }`（2 个类）和 `.mon-ring .mon-ring-bg { stroke: var(--progress-track) }`（也是 2 个类）**特异性相同**，而 AI 触发钮的真实 DOM 里外面正好有一层 `.mon-ring` 包裹 —— 后者在后面，于是前者一直是哑声明，亮色靠 `[data-theme="light"]`（3 个类）那条覆盖才赢。
我把覆盖删掉后，亮色环立刻退回 `--progress-track`（探针报 `rgba(0,0,0,.08) → rgba(140,150,165,.25)`）。
修：基础规则里删掉那条哑声明，改成在亮色区块里显式写一条 `[data-theme="light"] .ai-context-ring .mon-ring-bg { stroke: var(--ring-track) }` 并注明原因；探针场景同步复刻 `.mon-ring` 包裹层，否则这类「属性被结构决定」的问题永远测不出来。

**坑 3（工具侧）：前端资源是编译进二进制的。**
改完 CSS 只跑 `npm run build:web` 不会生效 —— 真实窗口里加载的还是 `up --build` 那一刻嵌进二进制的 `dist/`。必须 `npm run build:web && npm run ui:check -- up --build`。这一条已写进 `docs/design-refactor/README.md` 的操作规程，否则后面的批次会反复拿旧 CSS 做验收。

## 6. 给换皮阶段的观察

亮色下监控卡（`.mon-deck`、`.mon-lat-item .mon-item`）与三个小圆点在白底上对比度偏低 —— 这是**既有状态**（与 `60ad88a` 像素完全一致，不是本批引入），B4 的职责只是把「亮色需要不同值」这件事从组件段搬到 token 层。要不要加深，属于换皮时对 `--surface-sunken / --surface-inset-dim / --glow-*` 的一次性取值决策，可以在 token 层一处改完。
