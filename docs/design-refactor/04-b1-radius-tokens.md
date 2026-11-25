# B1 · 圆角 token 化（15 种裸值 → 6 档）

> 批次：token 层还债 第 1 批（B0 修失效引用 → **B1 圆角** → B2 色值 → B3 字号 → B4 亮色覆盖 → B5 media-sizing）
> 基线：`4d1c460`（B0 完成态）　交付：本批 commit
> 原则：只改「圆角的写法与档位」，不碰颜色/字号/间距/布局。

## 1. 验收标准与结论（缺一不算过）

| # | 验收标准（可执行断言） | 实测 | 结论 |
|---|---|---|---|
| 1 | `npm run lint:css` → error 0，`token-radius 0`、`platform-scope 0`，warn 总数 103（token-color 96 / row-decoration 10 / media-sizing 7 不变） | error **0** / warn **103**：token-radius **0**、platform-scope **0**、token-color 96、row-decoration 10、media-sizing 7 | ✅ |
| 2 | `border-radius` 里不得残留 px 裸值（只允许 `0` 与 `50%`；胶囊走 token） | `grep -cE 'border-radius: *[0-9]+px'` = **0**；`50%` 31 处、`0` 5 处 | ✅ |
| 3 | `npm run build:web` 成功；`npm run test:unit` 575/575 | build ok；**575 pass / 0 fail** | ✅ |
| 4 | 真实窗口里所有可见元素的计算 `borderRadius` ∈ {`0`,`4px`,`5px`,`8px`,`10px`,`12px`,`999px`,`50%`}；`5px` 只允许出现在分段滑块（同心圆角） | 6 个场景全场普查 `bad = {}`；`5px` 只命中 `.segmented-thumb`（4 个角） | ✅ |
| 5 | **布局不得位移**：`height` / `grid-template-columns` / `grid-template-rows` / `display` / `padding` 与改前逐字相同 | `ab` 加了这 4 个属性后，`import-preview` 与 `rdp-advanced` 的 `styles = 无差异` | ✅ |
| 6 | `ab` 净差像素必须给出数值与 bbox，并说明来源 | 见 §4（3 个场景，净差 105–434 px，全部落在控件/标记的 1–4px 圆角弧上） | ✅ |
| 7 | 产出本文档：映射表 + 像素数据 + 截图路径 | 本文 | ✅ |

`ui:check` 场景全部走真实事件（Ctrl+Shift+P → 输入「主机库」→ Enter；点 `#btn-add-host`；点 `.segmented-item[data-value=rdp]`），因此第 4/5/6 条同时验收了「操作路径」。

## 2. 目标档位（两套主题同值）

```
--radius-xs: 4px    容器内标记:徽标 / chip / 计数 / 分段滑块外的碎块
--radius-sm: 8px    独立控件:按钮 / 输入 / 下拉 / 卡片内块 / 分段控件轨道
--radius:    10px   卡片 / 弹层内的面板
--radius-lg: 12px   大浮层 / 侧面板(本批新增)
--radius-tab: 8px   标签页(原有,值同 --radius-sm)
--radius-pill: 999px 胶囊:开关轨道 / 徽章 / 选中指示条(本批新增)
0 / 50%             无圆角 / 圆点圆头像,保持裸值
```

**同心圆角（第 7 档，写法而非 token）**：嵌套在圆角容器里的内块，圆角必须 = 外层圆角 − 内边距，即 `calc(var(--radius-sm) - 3px)`。分段滑块 `.segmented-thumb` 是唯一实例（轨道 8px、内边距 3px → 5px）。

## 3. 映射表（232 条声明，1:1 替换，来自 `git diff --unified=0 src/style.css`）

| 原值 | → token | 句数 | 折算 | 视觉 |
|---|---|---|---|---|
| `8px` | `--radius-sm` | 48 | 8→8 | 不变 |
| `6px` | `--radius-sm` | 46 | 6→8 | **+2px** |
| `4px` | `--radius-xs` | 34 | 4→4 | 不变 |
| `999px` | `--radius-pill` | 20 | 999→999 | 不变 |
| `var(--radius-sm, 6px)` | `--radius-sm` | 15 | 6→8 | **+2px**（回落值一直是错的：`--radius-sm` 从没定义过） |
| `6px` | `--radius-xs` | 11 | 6→4 | **−2px**（容器内标记） |
| `var(--radius-xs, 4px)` | `--radius-xs` | 10 | 0→4 | **+4px**（此前 token 未定义 → 整条失效 → 方角） |
| `7px` | `--radius-sm` | 9 | 7→8 | +1px |
| `2px` | `--radius-xs` | 7 | 2→4 | 钳位后不变（2px 宽指示条，浏览器按宽度一半封顶） |
| `5px` | `--radius-xs` | 6 | 5→4 | −1px |
| `3px` | `--radius-xs` | 6 | 3→4 | +1px（3px 高进度条同样被钳位） |
| `12px` | `--radius-lg` | 3 | 12→12 | 不变 |
| `10px` | `--radius` | 2 | 10→10 | 不变 |
| `var(--radius-sm, 8px)` / `var(--radius-xs, 5px)` / `var(--radius, 8px)` / `var(--radius, 10px)` / `var(--radius-pill, 11px)` / `var(--radius-xs, 6px)` | 各归其 token，去掉回落 | 6 | — | 「回落值就是第二套真相」，回落全部删掉 |
| `0 8px 8px 0` / `0 0 8px 8px` | `0 var(--radius-sm) var(--radius-sm) 0` 等 | 2 | 8→8 | 不变（逐角写法） |
| `22px` | `--radius-pill` | 1 | 22→999 | 不变（`.empty-icon-circle` 44×44，22px 已是圆） |
| `11px` | `--radius-pill` | 1 | 11→999 | 不变（`.switch-slider` 38×22，11px 已是胶囊） |
| `9px` | `--radius-sm` | 1 | 9→8 | −1px（`.host-empty .he-ico` 34×34 图标） |
| `1px` | `--radius-xs` | 1 | 1→4 | 钳位后不变（`.hl-box.part::after` 7×2） |
| `6px` | `calc(var(--radius-sm) - 3px)` | 1 | 6→5 | −1px（分段滑块，见 §5 返工） |

**真正看得见的只有两类**：控件 6px→8px（61 条含回落）、标记 6px→4px（11 条）。其余是钳位/取整，肉眼不可辨。

## 4. 像素证据（`ab --ref 4d1c460`，同场景连拍求噪声地板后扣除）

| 场景 | 选择器 | 样式差异 | 净差像素 | bbox | 来源 |
|---|---|---|---|---|---|
| `import-preview` | `.io-item` 等 7 个 | 无 | **434** | `206x381+137+4` | 弹层内 `.io-*` 的 1–4px 圆角弧 + 侧栏 `.tb-btn` 6→8 |
| `rdp-top` | `#host-protocol-slider` 等 | `.segmented-item` 6→8、`.segmented-thumb` 6→5 | **238** | `762x615+137+4` | 两个选项块 + 滑块的角部 |
| `rdp-advanced` | `.rdp-adv` 等 4 个 | 无 | **105** | `762x785+137+4` | 弹层内勾选框/字段角部（散在全宽，单点仅几像素） |

`rdp-top` 那轮噪声地板 309 px（高于平时的 ~45），原因是连拍之间有滚动条淡出动画；净差已扣除。

截图（`.ui-check/shots/`，不入库）：
- `ab-b1-import-preview-old.png` / `-new.png`
- `ab-b1-rdp-top-old.png` / `-new.png`
- `ab-b1-rdp-advanced-old.png` / `-new.png`
- `seg-end.png` —— 分段控件右端 1000% 放大对照（上=改前 6px，下=改后 5px）
- 人工过目结论：列宽/行高无位移、无「该圆的变方」、无圆角溢出、无文字贴边。

## 5. 两次返工（都是验收拦下来的）

### 5.1 `--radius-xs` 从未定义 → 4px 全变 0px（方角）

批量替换时把 `var(--radius-xs, 4px)` 的回落值删了，而 `--radius-xs` **在 `:root` 里根本不存在** → 声明在计算值阶段整条作废 → 所有「容器内标记」变方角。计算样式断言（标准 4）当场命中：`.segmented-thumb` 的 `borderRadius` 从 `6px` 变 `0px`。

修法：`:root` 补 `--radius-xs: 4px`，并给 lint 加 **`token-undefined`** 规则（R3 前置）——引用未定义 token 且没写回落，直接 warn。反证：把 `--radius-xs: 4px` 删掉跑 lint → 该规则报 **79** 条；补回 → 0 条。JS 运行时注入的 6 个自定义属性（`--x/--y/--s/--delay/--i/--n`）在白名单里。

### 5.2 分段滑块用 `4px` 显得「方块塞进圆轨道」

按「容器内标记 = 4px」机械套档后，滑块（4px）比轨道（8px）明显更方。1000% 放大对照确认为视觉缺陷（不是错觉）：轨道内壁圆角是 8 − 3(内边距) = 5px，滑块就该 5px 才同心。

修法：`.segmented-thumb` 改 `calc(var(--radius-sm) - 3px)`，并在 lint 的 `token-radius` 里允许 `calc()` —— 但**要求 calc 里必须引用 `--radius-*`**（禁止 `calc(8px - 3px)` 这种绕过 token 的写法）。

修后复核：滑块 5px、轨道 8px，1000% 放大「两张几乎一样」，同心无缺口。

## 6. 工具改动（`scripts/`）

1. `ui-check.mjs` 新增场景 `rdp-top`（协议选 RDP 且停在顶部，分段控件在视口内）。原 `rdp-advanced` 滚到底，分段控件被推出视口，等于没验到。
2. `ui-check.mjs` 的弹窗清理改为**走各自关闭按钮**（`CLEAR_MODALS` 前置）。原来直接 `classList.add('hidden')` 绕过应用的弹窗记账，导致后续 `openModal` 静默失效、场景在弹窗没打开的情况下截图。
3. `PROPS` 增加 `gridTemplateColumns / gridTemplateRows / display / flexBasis` —— 圆角批次的红线是「布局零位移」，这四项不比对就等于没验。
4. lint 新增 `token-undefined`；`token-radius` 支持 `calc()` 同心写法。

## 7. 残留与下一批

- `0px` 占比最高（每个场景 900–1500 个角），是行/单元格/容器不设圆角的正常态，不属债。
- `--radius-tab` 与 `--radius-sm` 同值（8px）保留：语义不同（标签页可能单独调整），值相同不算重复。
- `.host-item.active::before` 等 2px 指示条用 `--radius-xs`（4px），实际被浏览器钳位成 1px 半圆；语义上更贴 `--radius-pill`，但两者渲染一致，留到 B2 一起看是否顺手改。
- 下一批 **B2 色值 token 化**（token-color 96）：反白/语义色/厂商色/阴影/表面 5 族；B2 完成后 warn 总数预计落到个位数。
