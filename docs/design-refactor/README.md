# 样式重构批次（B0–B5）：流程与定点验证入口

本轮只换视觉、不动信息架构。样式改动全部落在 `src/style.css` 的 token 层与覆盖层，
按批次推进，**每批独立验收，通过后才动下一批**。

## 1. 批次与当前状态

| 批次 | 内容 | lint 预期 | 视觉风险 | 状态 |
|---|---|---|---|---|
| **B0** | 14 处失效 token 引用清理（`--line`/`--fg`/`--accent-contrast`/幻名） | warn 322→322 | 低，实测零像素变化 | ✅ 已完成（验收中） |
| **B1** | 圆角 token 化（15 种裸值 → `--radius*`）+ `--radius-pill` 进平台层 | `token-radius 199→0`、`platform-scope 20→0`，warn **322→103** | 低：绝对值映射，8px 主体不动 | 未开始 |
| **B2** | 色值 token 化（5 族）＋ 定 `--hover-bg`（B0 里留的 `.ai-confirm-host-tag`） | `token-color 96→19`，warn **103→26** | 低-中：阴影统一会让部分浮层变浅/变深 | 未开始 |
| **B3** | 字号收敛 17→8 档 | 无 lint 规则覆盖（可加 C-new） | **高**：76 处位移 ≤1px，全部像素基线失效 | 未开始 |
| **B4** | light 覆盖归位（19 条散落覆盖 → 主题层） | warn **26→7** | 中：亮色下逐屏复核 | 未开始 |
| **B5** | `media-sizing 7` 迁平台层 | warn **7→0** → 开 `--strict` 门禁 | 低 | 未开始 |

顺序不可颠倒：B0 修「声明失效」→ B1/B2 依赖 token 层正确 → B3 必须最后（字号一动，所有对像素的判断基线全变）→ B4/B5 收尾。
详见 `01-style-debt-audit.md`（含 332 条 findings 明细与 `01-audit-data.json`）。

## 2. 每批的验收动作（四步，缺一不算过）

```bash
npm run build:web && npm run lint:css      # 1) 契约 lint：看 warn 是否落在本批预期
npm run test:unit                          # 2) 单测（575 用例，日常必跑；全量 e2e 不跑）
npm run ui:check -- up --build             # 3) 起真实窗口（首次 --build 约 1 分钟，之后增量几秒）
npm run ui:check -- ab bN --scene import-preview   # 4) 旧 CSS vs 现状：样式 + 像素净差异
```

`ab` 的判定：`styles: "无差异"` 且 `pixels.net === 0` 才算「与基线一致」；
只要有一项非 0，退出码就是 **2**（可直接进 CI），并打印净差异的 bbox 与两张截图路径。
净差异已经**扣掉了光标闪烁/动画造成的时间噪声**，不需要人肉分辨。

有意的视觉改变（B2 的阴影、B3 的字号）本来就会让 `net > 0`，这时用 `shot` 出稳定态截图，人看一眼再拍板：

```bash
npm run ui:check -- shot b3-after-import
npm run ui:check -- theme light && npm run ui:check -- shot b3-after-import-light
```

## 3. `ui-check` 速查

| 命令 | 用途 |
|---|---|
| `up [--build] [--fresh]` | 起真实 Tauri 窗口（Xvfb + 应用自带测试桥）。`--fresh` 重置夹具数据 |
| `down` / `status` | 停容器 / 看状态 |
| `scene hosts\|import-preview\|rdp-advanced` | 把应用驱动到可复现状态（走真实点击与键盘事件） |
| `eval '<js>'` | 在真实页面执行 JS（多语句需显式 `return`） |
| `styles 'a,b,c'` | 取计算样式 JSON |
| `shot <名字>` | 截图 → `.ui-check/shots/<名字>.png` |
| `theme dark\|light` | 走真实 UI 切主题并保存（命令面板 → 设置 → 终端 → 主题 → 保存） |
| `ab <名字> [--ref R \| --css 文件] [--scene S] [--selectors a,b]` | 基线 CSS 注入同窗口，比计算样式与像素 |

要点/坑：

- `--ref` 默认 `v0.7.6`（B0 之前的线上样式）；`--css` 可直接给任意文件，用来比两个设计变体。
- 选择器只取**首个命中**：要量非首行（如冲突行以外的主机行）就写更具体的选择器，否则会量到 `.has-diff` 变体。
- 夹具：本地 1 台 `cache-prod-02`（生产）+ 导入文件 4 台（含 1 条 `生产→数据库` 冲突），`up --fresh` 重置。
- 容器重建必须由脚本做：`docker restart` 会留下 `/tmp/.X<b>-lock`，Xvfb 起不来 → `Failed to initialize GTK`。
- 需要 docker；本机在 `docker` 组之外时脚本自动改走 `sg docker`。
- 产物都在 `.ui-check/`（已 git 忽略）：`bin/nebulashell`、`run/app.log`、`shots/`。

## 4. 记录

| 文档 | 内容 |
|---|---|
| `01-style-debt-audit.md` | 样式债量化：332 findings、字号/圆角/色值直方图、批次计划 |
| `01-audit-data.json` | 逐条 findings 明细（level/line/rule/decl/selector） |
| `02-b0-dead-token-fix.md` | B0 实施口径与两处非纯删除改动（含 UA 边框陷阱） |
| `03-b0-real-ui-verification.md` | B0 在真实窗口内的 A/B 方法与操作路径断言 |
