# C2：门禁归零、侧栏选中态与欢迎态 CTA、导入计数口径

C1 换皮落地后做的一轮收口：把样式契约门禁做到真正 0/0/0 并接进 CI，
用实测取代「看着差不多」来判断两处视觉层级问题，最后修掉评审截图里发现的导入计数 bug。

三个批次各自独立验收，提交分别是 `2dd8f74`（C2-1）、`b1b0dad`（C2-2）、`7d73435`（导入计数）。

---

## 1. C2-1：样式门禁真归零（`2dd8f74`）

### 起因：门禁报了「安全的 0」，但漏了整整一族属性

C1 收口时 `lint:css` 已经是 `error 0 / warn 0 / info 10`。深挖三条问题：

1. **`COLOR_PROPS` 根本没有 `border` 简写族**。原来只认 `border-color` / `border-top-color` 等长写，
   于是 `border: 1px solid rgba(…)` 这种最常见的写法完全不进色值检查。
   用技能脚本 `css-token-audit.mjs` 交叉扫描，抓到 **9 行 10 条**漏网硬编码描边：
   3085 / 3088 / 3113 / 3116 / 3184 / 3862 / 3931 / 4909 / 4983。
2. **`row-decoration` 那 10 条 info 是误报**。规则写的是 `/^var\(--/`，不认 `1px solid var(--border)`，
   于是所有「已经走 token 的表格分隔线」被当成字面量告警。真正的字面量一条都没有。
3. **CI 只跑了契约 lint，没跑对比度门禁**。以后谁把主按钮对比度调回 4.5 以下都不会被拦。

### 改动

**`scripts/lint-css-contract.mjs`**

- `COLOR_PROPS` 补 `border` / `border-top` / `border-bottom` / `border-left` / `border-right` / `outline`。
- `token-color` 在匹配字面量前先剥掉**无回落**的 `var(--x)`，再跑正则：

  ```js
  const stripped = value.replace(/var\(\s*--[\w-]+\s*\)/g, '');
  const m = COLOR_LITERAL.exec(stripped);
  ```

  两个目的：变量名里含颜色词（`--gray`、`--red-line`）不再误报；
  但 `var(--x, #fff)` 这种**带字面回落**的仍然会被拦（回落值也是写死的色值）。
- `row-decoration` 放行 `1px solid var(--…)`，只拦真正出现字面色值的声明。

**`src/style.css`：9 处硬编码描边全部改 `color-mix`**

| 行 | 选择器 | before | after |
|---|---|---|---|
| 3085 | `.cloud-vendor-pill.tencent` | `rgba(0, 164, 255, 0.3)` | `color-mix(in srgb, var(--vendor-tencent) 30%, transparent)` |
| 3088 | `.cloud-vendor-pill.aliyun` | `rgba(255, 106, 0, 0.3)` | `color-mix(in srgb, var(--vendor-aliyun) 30%, transparent)` |
| 3113 | `.cloud-card-test-result.success` | `rgba(52, 211, 153, 0.25)` | `color-mix(in srgb, var(--ok-color) 25%, transparent)` |
| 3116 | `.cloud-card-test-result.error` | `rgba(255, 107, 107, 0.25)` | `color-mix(in srgb, var(--danger) 25%, transparent)` |
| 3184 | `.strip-manage-link` | `rgba(56, 189, 248, 0.2)` | `color-mix(in srgb, var(--accent-sky) 20%, transparent)` |
| 3862 | `.rp-ic` | `rgba(91, 140, 255, .16)` | `color-mix(in srgb, var(--accent) 16%, transparent)` |
| **3931** | **`.rp-host.on .rp-cb::after`** | **`#fff`（×2）** | **`var(--text-on-accent)`** |
| 4909 | `.hl-tag` | `rgba(91, 140, 255, 0.28)` | `color-mix(in srgb, var(--accent) 28%, transparent)` |
| 4983 | `.hl-sel` | `rgba(91, 140, 255, 0.3)` | `color-mix(in srgb, var(--accent) 30%, transparent)` |

前 8 处有个共同病根：`background` 早就改成了 `color-mix(...var(--ok-color)...)`，
只有 `border` 忘了跟，于是亮色主题下**背景跟着主题换、描边还停在暗色值**。
暗色下 `color-mix(var(--x) N%, transparent)` 与其原 `rgba` 值逐像素等价，暗色观感零变化。

**3931 行是真缺陷**：批量命令的勾选标记画在 `background: var(--accent)` 上，
写死 `#fff` 在 C1 之后的暗色 `--accent #5b8cff` 上只有 **3.16:1**，而 C1 刚定的
`--text-on-accent: #08101c` 是 6.03:1。同一份 CSS 里两套勾选口径，改成 token 后暗 6.03 / 亮 5.19。

另外删掉 `src/style.css:5064` 那句过时注释（还写着「见文件末尾的 `@media`」，B6 已删）。

**`.github/workflows/ci.yml`**：`frontend-unit` 在契约 lint 之后加一步

```yaml
- name: 主题对比度与层次体检
  run: node scripts/token-contrast.mjs
```

### 验收

| 项 | 结果 |
|---|---|
| `npm run lint:css -- --strict --all` | **error 0 / warn 0 / info 0**（exit 0） |
| 反证：临时塞 `border: 1px solid rgba(1,2,3,.4)` 与 `td { border-bottom: 1px solid #333 }` | 精准命中 `token-color ×2` + `row-decoration ×1` |
| `css-token-audit.mjs`（技能脚本） | `rgb/rgba` **0 处**；`#fff` 4→2（仅剩焦点环提亮）、`#000` ×8（仅 `mask-image`） |
| `node scripts/token-contrast.mjs` | **26/26** |
| `npm run test:unit` | **575/575** |
| `ab --ref b10ad46`（hosts / host-library） | `styles 无差异`，像素净差 **0 / 0** |
| 真机 DOM 实测（暗/亮） | 9 处全部随主题切换：`.rp-cb::after` 暗 `rgb(8,16,28)` / 亮 `rgb(255,255,255)`；`.hl-tag`、`.hl-sel`、`.cloud-card-test-result` 亮色全跟 `#0969da` / `#1a7f37` / `#cf222e` |

**6 张表格空态核查结论**（`row-decoration` 的前提）：`cloud-table` / `fw-table` / `fp-table` /
`batch-results` 空态用 `.hidden` 隐藏整表；`hl-table` 切 `.is-empty` 显示表外 `#hl-empty`
（`host-library.js:457`）；`keys-table` 是固定键位映射表，筛选只切行显隐（`settings.js:62`）。
没有一张表把空态塞进 `<td>` 行槽位。

---

## 2. C2-2：侧栏激活态 + 欢迎态 CTA（`b1b0dad`）

### 先测量，再动手

两处问题的性质完全不同，得先分清：

**（a）侧栏选中态**：`.host-item.active` 早就有 `--row-active` 底色 + 2px 左侧指示条
（`style.css:477-482`）。之前评审说「选中态偏弱」，其实是因为 `hosts` 场景根本没有激活主机
（`isActiveHost()` 恒为 false），**画面上压根没有激活行**。所以先补一个能复现的场景再谈调优。

新增 `ui-check` 场景 `hosts-active`：只在 `#host-list` 里克隆两行临时 DOM（1 台 active + 1 台普通），
不碰 `state.hosts` / 不写盘；`applyScene` 开头统一清理 `[data-probe-host]`，切走即恢复。

亮色实测出真问题：

```
亮色 --row-active #dbe6f5  vs  --panel #e7ecf3   ΔL* = 2.3   ← 几乎贴在一起
暗色 --row-active #2a3750  vs  --panel #101722   ΔL* = 14.6  ← 清晰
```

**（b）欢迎态双 Primary**：`#btn-add-host`（侧栏「+ 新建」）与 `#btn-welcome-add`（主区「+ 新建主机」）
同为实心蓝 Primary，指向同一个动作。`ux-patterns.md` §按钮层级写的是「每个页面/区域只有一个」，
两次中立视觉复核也都点出「视线在左上角和中心之间被拉扯」。

### 亮色 `--row-active` 的选值推导

目标是「与 panel 拉开 ≥3.0 L\*，同时行内所有文字仍 ≥4.5:1」。逐档试：

| 值 | ΔL\* vs panel | `--text` | `--muted` | `--accent`（指示条） |
|---|---|---|---|---|
| `#dbe6f5`（原） | 2.3 | 12.52 | 5.07 | 4.12 |
| **`#d2e2f7`（采用）** | **3.9** | **12.01** | **4.86** | 3.95 |
| `#ccdcf4` | 5.9 | 11.37 | 4.60 | 3.74 |
| `#c5daf5` | 6.9 | 11.07 | 4.48 | ✗ 破 4.5 |

`#d2e2f7` 是「ΔL\* 过 3.0 门槛 + 所有正文仍达标」的最后一档。

### `#btn-add-host` 降级方案的选择

试过「浅色品牌底 + 品牌蓝字」，亮色只有 **3.72:1**，直接出局。最终用品类里已有的
**次级强调态**（`--bg2` 底 + `--accent` 字 + 混色描边）：

| 主题 | 实测 | 对比度 |
|---|---|---|
| 暗 | `rgb(91,140,255)` on `rgb(26,35,51)` | **4.98:1** |
| 亮 | `rgb(9,105,218)` on `rgb(255,255,255)` | **5.19:1** |

hover 用 `color-mix(in srgb, var(--accent) 6%, var(--bg2))`，暗 4.47 / 亮 4.77，仍 ≥4.5
（试 8% 时暗色掉到 4.47 边缘，10% 直接破线，所以停在 6%）。

### 改动

- `src/index.html`：`#btn-add-host` 去掉 `.primary`。
- `src/style.css`：
  - `#btn-add-host` 改次级强调描边态；
  - 亮色 `--row-active` `#dbe6f5` → `#d2e2f7`；
  - `.host-item.active` 补 `inset 0 0 0 1px color-mix(--accent 22%)` 描边，左指示条 2px→3px、
    `top/bottom 11px→8px`，`.host-name` 字重 560→650。全部不参与布局。
- `scripts/ui-check.mjs`：新增 `hosts-active` 场景 + 探针清理。

### 验收

真机 `scene hosts-active`（重建容器后），暗/亮结果一致：

```
{ actBg: rgb(42,55,80) | rgb(210,226,247), actFw: 650, normFw: 560,
  actH: 44, normH: 44, dx: 0, rows: 3 }
```

`dx = 0` 是关键断言：描边、加粗、指示条加宽都没有推动文字。
切回 `scene hosts` 后列表自动恢复 1 行。窄侧栏（180px）实测 `#btn-add-host` 收敛为 **26×26**
（`.lbl` `display: none`），容器查询没被改坏。

中立视觉复核两张终稿（`c22-after-dark.png` / `c22-after-light.png`）双主题均判
「激活态一眼清楚、文字对齐无错位」+「主次层级清晰自然、无焦点打架」。

---

## 3. 导入预览计数口径（`7d73435`）

### 根因

`transfer.js` 的 `writableRows()` 只看「勾选 / 一致 / 问题行」三件，**没看逐行处置**：

```js
// 改前
const writableRows = () =>
  (im.inspect?.rows || []).filter((r) => !isExcluded(r) && r.kind !== 'identical' && !isInvalid(r));
```

冲突行默认 `decision: 'skip'`，于是「跳过」的冲突行照样进 `writableRows()`，
摘要「将导入 N 台」与主按钮「导入 N 台」都多算一台（实际只写 3 台）。
同一份数据里 `overwriteCount` 却已经正确判了 `effectiveDecision(r) === 'overwrite'`——两套口径。

### 修法：收成单一口径的纯逻辑

新增 `src/shared/import-plan.js`，把四件事一起定义，预览与落盘同源：

| 导出 | 职责 |
|---|---|
| `effectiveConflictDecision(row, opts)` | 单行处置优先于全局策略 |
| `selectWritableRows(rows, opts)` | 会真正写盘的行（含「冲突行非覆盖则排除」） |
| `countOverwrites(rows, opts)` | 覆盖计数，与上一行同源 |
| `buildImportDecisions(rows, opts)` | 发给 `hosts:importApply` 的 decisions 映射 |

`transfer.js` 里 `writableRows()`、`overwriteCount`、`runApply()` 的 decisions 全部改走这四个函数，
`renderSummary()` 里已失效的 `writable` 计算删掉。

顺带把「没有选中任何主机」的 title 改成「没有可导入的主机」——冲突全跳过时按钮变灰
并不是因为「没勾选」，原文案归因错了。

### 同类修正：9px 勾号看起来像横杠

前一次视觉复核在亮色整图上把复选框判成「半选横杠」。3 倍像素裁剪证明**画的是勾**，
但 24 viewBox / `stroke-width: 2` 缩到 9px 后实际描边只有 **0.75px**，在浅色底上确实发虚。
`.hl-box.on svg { stroke-width: 2.8 }` 把它提到约 1px，不影响任何尺寸。

### 验收

真机 `scene import-preview`（4 台含 1 冲突，亮/暗结果完全相同）：

| 操作 | 摘要 | 主按钮 |
|---|---|---|
| 默认（冲突跳过） | 将导入 **3** 台 | `导入 3 台` |
| 全局切「覆盖」 | 将导入 **4** 台 | `覆盖 1 台并导入` |
| 切回「跳过」 | 将导入 **3** 台 | `导入 3 台` |
| 单行下拉改「覆盖」 | 将导入 **4** 台 | `覆盖 1 台并导入` |
| 单行下拉改「跳过」 | 将导入 **3** 台 | `导入 3 台` |

表头全选 `aria-checked="true"`，实测 `stroke-width` 2 → **2.8px**；
3 倍裁剪复核「三个复选框均为完整白色对勾，笔画连续无断笔」。

`tests/import-plan.test.mjs` 新增 6 例：默认跳过 3 台 / 全局覆盖 4 台 / 逐行双向覆盖 /
取消勾选独立于处置 / 一致与问题行不写 / 全冲突跳过时为 0。单测 **580/580**。

`ab --ref b1b0dad` 净差 0，确认没有引入布局位移。
（复核提到的「处置表头左对齐 vs 列内容偏右」经 A/B 验证是既有布局，不在本批范围内。）

---

## 4. 三条可复用的结论

1. **门禁报 0 不等于真的 0**。要拿**另一个口径**（技能脚本 `css-token-audit.mjs`）交叉扫一遍：
   这次正是两套工具的并集才暴露出 `border` 简写整族漏检。
2. **「视觉上偏弱」先问「画面上到底有没有它」**。侧栏选中态所谓偏弱，一半原因是场景里根本没有激活行；
   补一个能复现的场景（`hosts-active`）花的成本，远低于盲改一版 CSS 再被驳。
3. **同一份数据的两处显示必须同源**。导入计数的 bug 不是算错，是「摘要」和「按钮」各自算了一遍，
   其中一份漏了条件。抽成纯函数后这类漂移结构上就发生不了。
