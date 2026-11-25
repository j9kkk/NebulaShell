# 02 B0 实施记录 —— 失效 token 引用清理

> 批次：B0（对应 `01-style-debt-audit.md` §2 F1）
> 决策依据：用户 2026-11-25 明确「`.io-*` 那些描边不要」→ 采用**删除失效声明、保持现状外观**，而不是补 `--line` 让边框出现。
> 结果：**零视觉变化**（像素级 4 组全等）。

## 1. 范围

只做「让声明回到实际生效状态」这一件事，不引入任何新尺寸/颜色档位。

| 类 | 处数 | 处置 |
|---|---|---|
| `--line` 失效描边（导出/导入模块） | 11 | 删除声明（用户要求不要这些边框） |
| `--line` 连带死声明 | 2 | 删 `.io-chip.warn` 的 `border-color`、删 `.io-seg + .io-seg` 整条规则 |
| `--fg`（无回落，文字色退化） | 2 | 按**实测现值**落地：`.rdp-adv-title`→`--text`；`.rdp-chk` 整条删掉、保持继承（父级实测就是 `rgb(139,150,168)` = `--muted`） |
| 幻名带回落（现值即回落值） | 4 | `--text-dim`→`--muted`、`--warn-bg`/`--danger-bg`→`--bg2`、`--input-bg`→`--panel`、`--accent-soft`→`--bg2` |
| `--accent-contrast` | 2 | → 新语义 token `--text-on-accent`（亮/暗两套均 `#ffffff`，与回落值一致） |
| `--accent-soft` + `--bg3` 双缺失 | 1 | 改 `background: transparent` 并留注释，**留给 B2 定 `--hover-bg`** |

## 2. 两处必须说明的非纯删除改动

**(a) `.io-mini-sel` 补 `border: 0`**

这是本批唯一的真实回归风险。CSS 规范：`var()` 无回落且未定义 → 整条声明作废 → 属性取**初始值**（`border-style: none`）。此时它**压制了 UA 默认样式**。一旦把这条声明删掉，`<select>` 会重新吃到 UA 的 `border: 1px solid`（实测出现 `1px solid rgb(118,118,118)` + `background rgb(239,239,239)`）。

> 教训：**删除失效声明 ≠ 零变化**，对表单控件（`select` / `input` / `button`）要先补 `border: 0` 再删，或直接改写为 `border: 0`。

首轮截图比对抓到的差异正是这 409 个像素（x836-892 / y405-426）。补上 `border: 0` 后归零。

**(b) `.rdp-chk` 删掉整条 `color: var(--fg)`、保持继承**

源码原意写的是 `var(--fg)`（= 前景 = `--text`），但今天实测渲染是 `rgb(139,150,168)` = `--muted`（从父级继承）。B0 的验收口径是零变化，所以不钉死 token，直接删掉这条失效声明并留注释。**如果视觉上希望勾选标签更亮，这是 B3 字号/字色批量复核时一起定的事**，不要在 B0 里偷偷改。

## 3. 验证（全部实测）

| 项 | 改前 | 改后 | 判定 |
|---|---|---|---|
| `npm run lint:css` | error 0 / warn 322 / info 10 | **error 0 / warn 322 / info 10** | 持平（B0 不动 token 档位，符合预期） |
| 未定义 `var()` 引用 | 21 个名字 | **12 个**（其中 10 个是 JS 注入的内联自定义属性，属正常；剩 `--radius-xs` 13 处、`--radius-pill` 1 处归 B1） | 14 处失效引用归零 |
| `npm run test:unit` | — | **575 / 575 通过** | 通过 |
| 计算样式逐项比对 | 15 个选择器 × 暗/亮 = 30 项 | 30 项中 **28 项逐字相同**；`io-chip.warn` 2 项只差 `border-color`（宽度 0、样式 none，不可见） | 通过 |
| 像素比对（导入弹窗「校验预览」+「完成报告」× 暗/亮） | — | **4 组差异像素 0 / 1152000，SHA256 相同** | 通过 |

像素比对的夹具：`dist/__harness.html`（空后端 stub）+ `dist/__before.css`（`7982dfb:src/style.css`），同一份忠实 DOM（按 `transfer.js` 渲染器的列结构生成 4 行：新增 / 冲突+diff 行+下拉 / 无变化 / 仅凭据），视口 1280×900。

## 4. 遗留（明确不在 B0）

- `.ai-confirm-host-tag` 的软强调底色 → B2（定 `--hover-bg`，会有可见变化，要过截图）
- `--radius-xs`（13 处）/ `--radius-pill`（1 处）→ B1
- `.ai-confirm-host-tag` 的 `--accent-soft` 幻名已改注释，B2 一并处理

## 5. 复现

```bash
npm run lint:css
npm run test:unit
# 视觉夹具
npm run build:web && node <harness 生成器> && python3 -m http.server -d dist 8917
# 像素比对:after 用 dist/app.css,before 用 git show 7982dfb:src/style.css
```
