# 样式重构批次（B0–B6 + C1–C2）：流程与定点验证入口

本轮只换视觉、不动信息架构。样式改动全部落在 `src/style.css` 的 token 层与覆盖层，
按批次推进，**每批独立验收，通过后才动下一批**。

## 1. 批次与当前状态

| 批次 | 内容 | lint 预期 | 视觉风险 | 状态 |
|---|---|---|---|---|
| **B0** | 14 处失效 token 引用清理（`--line`/`--fg`/`--accent-contrast`/幻名） | warn 322→322 | 低，实测零像素变化 | ✅ 已完成（验收中） |
| **B1** | 圆角 token 化（15 种裸值 → `--radius*`）+ `--radius-pill` 进平台层 + `token-undefined` 规则 | `token-radius 199→0`、`platform-scope 20→0`，warn **322→103**；实测 232 条 1:1 替换，可见变化仅「控件 6→8」「标记 6→4」 | 低：绝对值映射，8px 主体不动 | ✅ 已完成（`04-b1-radius-tokens.md`） |
| **B2** | 色值 token 化（5 族 / 29 token）＋ 定 `--hover-bg`（B0 里留的 `.ai-confirm-host-tag`） | `token-color 96→19`，warn **103→26**；6 场景里只有 chip 一处净差 1424px，其余全 0 | 低-中：阴影统一会让部分浮层变浅/变深 | ✅ 已完成（`05-b2-color-tokens.md`） |
| **B3** | 字号收敛 17→8 档（先加 `token-font` 规则） | `token-font 410→0`；唯一允许画面变化的一批：396 条声明 1:1 换档，净差 839–17875px，行高/列宽红线未破 | **高**：全屏重排，前面各批像素基线失效 | ✅ 已完成（`06-b3-type-scale.md`） |
| **B4** | light 覆盖归位（19 条散落色值 → token 层） | `token-color 19→0`；亮色/暗色对外观零变化（6 场景 + 16 选择器探针 净差 0） | 中：亮色下逐屏复核 | ✅ 已完成（`07-b4-light-theme.md`） |
| **B5** | `media-sizing 7` 收口（实测不是平台差异 → `css-contract:allow` 记账） | `media-sizing 0`；warn **7→0**；`--strict` **退出码 0** | 低 | ✅ 已完成（`08-b5-media-sizing.md`） |
| **B6** | 清死代码：52 处 `var(--token, 落回值)` 的落回值（token 全部已定义）+ 3 个永不命中的窄窗 `@media` 块 | warn 0 / info 10；7 场景 `ab --ref fd364f5` 全部 `styles 无差异` + `net 0` | 无：净差 0 | ✅ 已完成 |
| **C1** | 换皮第一轮：31 个 token 值（暗 20 / 亮 11），采方向 A「深空冷调·克制」 | 组件规则零改动；`token-contrast` 26/26；修掉基线 8 项不达标（主按钮白字 3.68→5.05、表面台阶 1.8/2.4→4.8/6.0 等） | 中：全站观感变化，逐屏截图复核 | ✅ 已完成（`09-c1-skin.md`） |
| **C2-1** | 门禁真归零：`border` 简写族纳入 `token-color` + 清 9 处漏网硬编码描边 + `row-decoration` 修正 + `token-contrast` 进 CI | **error 0 / warn 0 / info 0**；技能脚本交叉扫 `rgb/rgba` 0 处 | 低：暗色下 `color-mix` 与原 `rgba` 逐像素等价 | ✅ 已完成（`10-c2-gates-selection-import.md`） |
| **C2-2** | 侧栏激活态实测调优（亮色 `--row-active` ΔL 2.3→3.9 + inset 描边 + 3px 指示条）+ 侧栏「+ 新建」降为次级强调态 | `lint:css` 0/0/0；真机 `dx=0`、`actH=normH=44` | 中：色阶/权重变化，暗亮双拍 | ✅ 已完成（同上） |
| **C2-3** | 导入预览冲突行设「跳过」后不再计入「将导入 N 台」（抽 `src/shared/import-plan.js` 单一口径） | 单测 575→**580**；真机五态断言 | 无：`ab --ref b1b0dad` 净差 0 | ✅ 已完成（同上） |
| **C2-4** | 导入预览「处置」表头右对齐 + 主机库「凭据」列宽 48→62px（「待补全」零截断）+ `.hl-th-act` 特异性提权 | `lint:css` 0/0/0；真机 `dR=0`、9 列 `trunc: false` | 低：仅改两处表格列宽与对齐，暗亮 4 屏复核通过 | ✅ 已完成（同上） |
| **D0** | 统一四档动效 token（`--dur-1..4` / `--ease-*`）至主 `:root` 并补齐 `token-motion` 契约门禁 | `lint:css --strict` 0/0/0；`ab --ref` 净差 0 | 无 | ✅ 已完成（`12-d-direction-motion.md`） |
| **D1** | 三栏浮岛分层、表面 L* 台阶拉开与减描边体系 | `lint:css --strict` 0/0/0；`token-contrast` 全绿 | 中：主工作区骨架与描边层次变化，暗亮双拍复核 | ✅ 已完成（同上） |
| **D2** | 运动反馈层（标签/主机 FLIP 滑移指示器、面板方向性交错进场、命令面板动效） | `lint:css --strict` 0/0/0；支持 `prefers-reduced-motion` | 低-中：交互态动效升级 | ✅ 已完成（同上） |
| **D3** | 发射台首屏、GPU 进度条、多窗格焦点环与列表底噪收尾 | `lint:css --strict` 0/0/0；单测全绿 | 中：欢迎页与多窗格聚焦态暗亮复核 | ✅ 已完成（同上） |
| **E1** | 常驻 44px 全局图标轨、滑动激活指示条与主机跨组小标题 | `lint:css --strict` 0/0/0；`__uiContract` 0 issues | 中：左侧新增 44px 固定轨与收起态联动 | ✅ 已完成（`13-e-fusion-layout.md`） |
| **E2** | 拆解底部 `#statusbar` 为简洁顶部会话条 + 底部轻量脉冲条 | `lint:css --strict` 0/0/0；`__uiContract` 0 issues | 中：终端会话上下栏重组，保持 xterm 零裁切 | ✅ 已完成（同上） |
| **E3** | 右侧统一抽屉（AI 助手 / 实时监控 / 连接诊断）与 `<1024px` 窄屏浮层适配 | `lint:css --strict` 0/0/0；单测补齐监控模块 | 中：三合一右侧抽屉与 980px 窄窗浮层复核 | ✅ 已完成（同上） |
| **E4** | 非 macOS 顶栏 6 组菜单收进左上角 Logo 级联下拉（macOS 保持原生菜单栏零影响） | `lint:css --strict` 0/0/0；`token-contrast` 44/44；单测 **584/584** | 中：顶栏减噪、级联子菜单对齐 `y=36px` 零侵入 | ✅ 已完成（同上） |

顺序不可颠倒：B0 修「声明失效」→ B1/B2 依赖 token 层正确 → B3 必须最后（字号一动，所有对像素的判断基线全变）→ B4/B5/B6 收尾（B6 把死回落与不可达断点删干净，换皮时才不会被残留值干扰）→ C1 起才换皮 → C2 把门禁补严、用实测收敛视觉层级。
详见 `01-style-debt-audit.md`（含 332 条 findings 明细与 `01-audit-data.json`）。

## 2. 每批的验收动作（四步，缺一不算过）

```bash
npm run build:web && npm run lint:css      # 1) 契约 lint：C2 起基线就是 0/0/0
node scripts/token-contrast.mjs            #    对比度/表面台阶门禁（C2-1 起进 CI）
npm run test:unit                          # 2) 单测（580 用例，日常必跑；全量 e2e 不跑）
npm run ui:check -- up --build             # 3) 起真实窗口（首次 --build 约 1 分钟，之后增量几秒）
npm run ui:check -- ab bN --scene import-preview   # 4) 旧 CSS vs 现状：样式 + 像素净差异
```

`ab` 的判定：`styles: "无差异"` 且 `pixels.net === 0` 才算「与基线一致」；
只要有一项非 0，退出码就是 **2**（可直接进 CI），并打印净差异的 bbox 与两张截图路径。
净差异已经**扣掉了光标闪烁/动画造成的时间噪声**，不需要人肉分辨。

> **改完 CSS 必须重编译二进制。** 前端资源在 `build.rs` 里嵌进可执行文件，
> 只跑 `npm run build:web` 的话真实窗口加载的仍是上一次 `up --build` 时的 `dist/`——
> 会拿着旧样式做验收、得出「改错了」的假结论（B4 在这个坑上浪费过两轮）。
> 顺序固定为 `build:web` → `up --build` → 再取数据。

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
| `resize <W>x<H>` | 真实改窗口尺寸（验收 `@media` 断点；受 `tauri.conf` 的 `minWidth/minHeight` 夹取） |
| `scene hosts\|hosts-active\|import-preview\|rdp-advanced` | 把应用驱动到可复现状态（走真实点击与键盘事件）。`hosts-active` 克隆 2 行临时主机演示选中态，切走自动清理 |
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
| `04-b1-radius-tokens.md` | B1 验收表、232 条映射表、两次返工（`--radius-xs` 未定义 / 滑块同心圆角） |
| `05-b2-color-tokens.md` | B2 5 族映射、29 个 token 清单、color-mix 等价性证明、`ai-panel` 验收限缩 |
| `06-b3-type-scale.md` | B3 17→8 映射表、每场景位移、行高/溢出红线断言、两处「被裁」的排除证明 |
| `07-b4-light-theme.md` | B4 19 条覆盖去向表、`light-probe` 探针场景、两个级联坑（第二 `:root` / 同特异性靠位置） |
| `08-b5-media-sizing.md` | B5 7 条去向、`css-contract:allow` 机制与反证、「断点在最小窗口下永不命中」的实测、六批总账 |
| `09-c1-skin.md` | C1 换皮：A/B 拍板记录、31 条 token 变更全表、8 项缺陷 before→after、一次「带结论提问」的误判纠正 |
| `10-c2-gates-selection-import.md` | C2：`border` 简写族漏检的发现路径、`--row-active` 选值推导、次级强调态对比度预算、导入计数单一口径 |
| `12-d-direction-motion.md` | D0–D3：四档动效 token、三栏浮岛减描边、FLIP 滑移指示器与发射台首屏规格 |
| `13-e-fusion-layout.md` | E1–E4：44px 图标轨、顶/底会话脉冲栏拆解、右侧统一抽屉与非 macOS Logo 级联菜单规格（原型见 `proto/`） |
