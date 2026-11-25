# B5 · `@media` 尺寸声明收口 + `--strict` 门禁

> 批次：token 层还债 最后一批（B0 → B1 → B2 → B3 → B4 → **B5**）
> 基线：`9d7e08c`（B4 完成态）
> 目标：`media-sizing` 归零、`npm run lint:css -- --strict` 退出码 0，为换皮开门禁。

## 1. 验收标准与结论

| # | 验收标准（可执行断言） | 实测 | 结论 |
|---|---|---|---|
| 1 | `lint:css` → error 0 / warn **0** / info 10 | error **0** / warn **0** / info 10（row-decoration 10） | ✅ |
| 2 | `lint:css -- --strict` 退出码 0 | **退出码 0** | ✅ |
| 3 | `media-sizing 0`；迁移后两个平台类下取值正确 | **7 → 0**（7 条按注释豁免并记账）；实测这 7 处**与平台类无关**（切 `platform-darwin` / `platform-nonmacos` 取值逐字相同），因此**没有一条迁到平台层** | ✅（口径改写，见 §2） |
| 4 | `ab --scene import-preview`、`rdp-advanced` 净差 0 | 两场景 `styles 无差异`、`net **0**` | ✅ |
| 5 | `build:web` ok、单测 575/575 | ok；**575 pass / 0 fail** | ✅ |
| 6 | 窄窗口截图：弹窗不破版、无横向滚动 | 最小窗口 **980×640**（`tauri.conf.json` 下限）实测：弹窗 560×520 完整落在视口内、`overflowX = 0`、底部三按钮可见 | ✅（口径改写，见 §3） |
| 7 | 本文档 | 本文 | ✅ |

## 2. 这 7 条到底是什么

| 位置 | 声明 | 常态 → 断点值 |
|---|---|---|
| `@media (max-width:480px)` | `.form-grid { gap }` | `10px 12px` → `8px` |
| 同上 | `.form-grid label { margin-top }` | `0` → `4px` |
| 同上 | `.cloud-account-form { padding }` | `10px 12px` → `10px` |
| 同上 | `.modal-actions { gap }` | `10px` → `8px` |
| 同上 | `#batch-results th, td { padding }` | `5px 8px` → `5px 4px` |
| `@media (max-width:700px), (max-height:500px)` | `.modal { padding }` | `0` → `8px` |
| 同上 | `.modal-card { padding }` | `20px` → `14px`（并把 `max-width/max-height` 各放宽 24px） |

**它们是窗口断点，不是平台差异。** 判断依据是实测而不是读代码：
切 `body.platform-darwin` / `platform-nonmacos` 后，这 7 处的 `gap / padding / margin-top` 计算值逐字相同（`same: true`）—— 平台类对它们零影响，迁到平台层等于把响应式规则搬进一个永不匹配的分支。

所以按卡片 §3 的第二条路走：**保留响应式行为，为 lint 补一条可审计的白名单注释**，而不是为了过门禁去删真行为。

## 3. 一个必须先说的事实：这 3 个断点在真机上永不命中

`src-tauri/tauri.conf.json` 的窗口下限是 `minWidth: 980 / minHeight: 640`。
`ui-check resize 460x700`（本轮新增能力）实测被夹到 **980×700** —— 宽度低于 980 的窗口根本不存在，于是：

- `max-width: 700px` —— 永不命中
- `max-width: 480px` —— 永不命中
- `max-height: 500px` —— 永不命中（下限 640）

也就是说这 7 条声明在当前产品形态下是**防御性响应式**（等哪天放宽 `minWidth` 才可能生效）。
B5 的边界写了「不为过 lint 而删掉真实的响应式行为」，所以本批**只记账、不删**；但这构成一个待你拍板的决策项（§6）。

因此验收第 6 条用**产品真实的最小窗口 980×640** 来做，而不是构造一个产品不存在的 460px 窗口。

## 4. 实现的机制：`css-contract:allow`

`scripts/lint-css-contract.mjs` 新增豁免注释：

```css
@media (max-width: 480px) {
  /* css-contract:allow media-sizing — 窄窗(<480px)把表单压成一列后要收紧间距: … */
  .form-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; }
```

规则：
1. 注释写在声明的规则块内（块内任意位置）或作用域上方一行即可；
2. **按规则 id 生效** —— `allow media-sizing` 不会放过 `token-color`；
3. **不静默吞掉** —— 汇总行固定打印 `(另有 N 条按 css-contract:allow 注释豁免: media-sizing N)`，谁要放开什么、放开了多少，一眼能看见；
4. 只想放行某一条声明，就把注释紧贴那条声明上方（作用域 = 该 @media 块），而不是把整个块放开。

**反证**：把 src 里两处注释的 id 改成 `token-color` 后重跑，`media-sizing` 的 7 条原样报出（warn 7）—— 说明豁免确实按 id 生效，不是把规则关掉了。

## 5. 工具的另外两处补强

1. **`ui-check resize <W>x<H>`**（测试桥新增 `GET /resize?w=&h=`）：真实改窗口尺寸，用来验收 `@media` 断点。B1–B4 都没法验响应式，这一批补上。
2. `ab` 的 `PROPS` 增加 `stroke / fill / stopColor / outlineColor`（B4 加），本轮继续沿用 —— SVG 上的颜色变化不会再漏。

## 6. 交给换皮阶段的两个决策项（本批不擅自处理）

1. **3 个断点是死代码**：`minWidth 980 / minHeight 640` 之下它们永不命中。两个选项——
   (a) 删掉这 3 个 `@media` 块（连同 `.batch-grid` 单列重排等未报 lint 的响应式内容），代码更干净；
   (b) 放宽 `minWidth`（比如 720），让窄窗布局真正可用。**只能二选一，不能两边都留着。**
2. `row-decoration` 还剩 10 条 info（表格行分隔线用绝对 1px + token 颜色）。它不在 `--strict` 的拦截范围（info 不挡门禁），但它是「行级装饰必须保证空态不占行槽位」那类隐患的钩子，换皮时表格重做要一起看。

## 7. 六批总账

| 批次 | 关键数字 | 视觉变化 |
|---|---|---|
| B0 失效引用 | 11 处 `var(--line)` 死声明删除 | 零 |
| B1 圆角 | 232 条 → 6 档；lint `token-radius` 199 → 0 | 控件 6→8px、标记 6→4px（净差 434/238/105） |
| B2 色值 | 96 条字面量 → 5 族 29 token；`token-color` 96 → 19 | 仅 `.ai-confirm-host-tag`（1424px） |
| B3 字号 | 396 条 → 8 档；`token-font` 410 → 0 | 全屏重排（839–17875px），行高/列宽未破 |
| B4 亮色 | 19 条散落覆盖 → 10 个 token；`token-color` 19 → 0 | 零（亮/暗 8 场景 + 16 选择器探针 净差 0） |
| B5 media | `media-sizing` 7 → 0；`--strict` 退出码 0 | 零（两场景净差 0） |

最终门禁：`error 0 / warn 0 / info 10`，`--strict` 可挂 CI。
