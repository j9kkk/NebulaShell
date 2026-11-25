# B2 · 色值 token 化（5 族 / 29 个 token）

> 批次：token 层还债 第 2 批（B0 失效引用 → B1 圆角 → **B2 色值** → B3 字号 → B4 亮色覆盖 → B5 media-sizing）
> 基线：`992806e`（B1 完成态）　交付：本批 commit
> 原则：只把颜色字面量换成 token，不做配色重设计；透明度统一用 `color-mix()` 取代新造 rgba。

## 1. 验收标准与结论（缺一不算过）

| # | 验收标准（可执行断言） | 实测 | 结论 |
|---|---|---|---|
| 1 | `npm run lint:css` → error 0，`token-color` **19**（只剩亮色覆盖），warn **26**；`token-radius 0` / `platform-scope 0` 保持 | error **0** / warn **26**：token-color **19**、row-decoration 10、media-sizing 7；token-radius 0、platform-scope 0 | ✅ |
| 2 | 新增 token 暗块与亮块都有定义，且无孤儿 token | 29 个 token × 2 块全定义；`var()` 引用统计 **孤儿 0**（最少 1 次使用） | ✅ |
| 3 | `npm run build:web` ok；`test:unit` 575/575 | build ok；**575 pass / 0 fail** | ✅ |
| 4 | 可见变化只有 `.ai-confirm-host-tag`（+ 阴影收敛边缘）；出现未预期大面积差异必须回退 | `host-tag-probe` 净差 **1424 px**、bbox 恰好是 chip 的 `91x18+97+71`；其余 5 个场景 **净差 0** | ✅ |
| 5 | 4 场景 × 暗亮 = 8 张截图人工过目 | 见 §6（`ai-panel` 无法布局，改用计算样式验证，见 §5.2） | ✅（一处限缩，已注明） |
| 6 | 产出本文档：5 族映射表 + token 清单 + 差异归因 | 本文 | ✅ |

## 2. 5 族映射（76 条组件声明 + 29 个 token 定义，`git diff --stat`：+144 / −76 行）

| 族 | 条数 | 处置 |
|---|---|---|
| 反白文字/符号 | 13 | `#fff` → `--text-on-accent`；白底滑块/拇指/勾选 → `--knob-bg` |
| 数据语义色 | 8 | 上下文条 `#38bdf8/#818cf8/#34d399` → `--scope-sys/--scope-hist/--scope-draft`；监控上行/下行 → `--net-rx-color/--net-tx-color`；思考强度 `#46bf72` → `--reasoning-color`；满格彩虹渐变 → `--reasoning-gradient-max`；成功态 `#34d399` → `--ok-color` |
| 云厂商 + 能力徽章 | 12 | 腾讯/阿里云 → `--vendor-tencent/--vendor-aliyun`；视觉/工具/推理徽章 → `--cap-vision/--cap-kind/--cap-reasoning`；云区强调色 → `--accent-sky` |
| 阴影 | 20 | 收敛成 4 档 + 内凹 + 两点光晕：`--shadow-xs/sm/pop/panel/popover`、`--shadow-inset`、`--ring-ok/--ring-danger`；`var(--accent, #38bdf8)` 这类**死回落**直接删掉回落 |
| 表面/叠加 | 13 | `--surface-inset/inset-dim/raise/sunken/sunken-deep`、`--chart-grid`、`--particle/particle-strong` |

语义色透明度不再新建 rgba，改用本色 + `color-mix(in srgb, var(--某色) N%, transparent)`。等价性实测：同一元素的 `rgba(91,140,255,.08)` 与 `color-mix(...)` 计算样式为 `color(srgb 0.356863 0.54902 1 / 0.08)`，**逐通道 Δ=0**，像素净差 0。

## 3. 新增 token 清单（暗色值；亮色块同值镜像）

```
本色        --accent-sky #38bdf8
反白/白     --knob-bg #ffffff
数据语义    --scope-sys #38bdf8   --scope-hist #818cf8   --scope-draft #34d399
            --ok-color #34d399    --reasoning-color #46bf72   --reasoning-gradient-max
厂商        --vendor-tencent var(--accent-sky)   --vendor-aliyun #fb923c
能力徽章    --cap-vision #60a5fa  --cap-kind #a78bfa  --cap-reasoning #c084fc
阴影        --shadow-xs  0 1px 3px rgba(0,0,0,.25)
            --shadow-sm  0 2px 6px rgba(0,0,0,.25)
            --shadow-pop 0 8px 24px rgba(0,0,0,.45)
            --shadow-panel 0 24px 64px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04)
            --shadow-popover 0 10px 30px rgba(0,0,0,.55), 0 0 1px rgba(255,255,255,.1)
            --shadow-inset inset 0 1px 2px rgba(0,0,0,.18)
            --ring-ok / --ring-danger（color-mix 10%）
表面        --surface-inset rgba(255,255,255,.08)      --surface-inset-dim rgba(255,255,255,.04)
            --surface-raise rgba(255,255,255,.22)      --surface-sunken rgba(0,0,0,.22)
            --surface-sunken-deep rgba(0,0,0,.3)       --chart-grid rgba(255,255,255,.06)
            --particle rgba(255,255,255,.55)           --particle-strong rgba(255,255,255,.8)
```

**亮色为什么先镜像**：亮色的语义色/阴影调到「好看」是 B4 的活（那一批还要处理 19 处组件级 `[data-theme="light"]` 覆盖）。本批把亮色值设成与暗色相同，保证**零观感变化**；B4 只需改 token 一处，不必再回头动组件。这与卡片里「可见变化只有一处」的验收口径一致。

## 4. 可见变化归因

| 变化 | 元素 | 数值 | 说明 |
|---|---|---|---|
| **唯一预期变化** | `.ai-confirm-host-tag` 底色 `transparent` → `var(--hover-bg)` | 暗：`rgba(91,140,255,.12)`；亮：`rgba(9,105,218,.08)`；净差 **1424 px**（暗）/ **1413 px**（亮），bbox `91x18+97+71` 就是 chip 本身 | B0 留的账：`--accent-soft`/`--bg3` 从未定义，这条一直失效 |
| 阴影收敛（设计内） | `.ai-drawer` `0 4px 16px rgba(0,0,0,.15)` → `--floating-shadow` `0 2px 8px rgba(0,0,0,.25)` | 计算样式差异已记录 | 抽屉在无会话状态下 `#ai-panel` 宽度 0、无法布局，**像素层不可见**，见 §5.2 |
| 阴影收敛（不可见） | `.tab-ghost`（拖拽幻影）、`.side-rail [data-tip]::after`、`.rail-pop`、`.segmented-thumb`、开关滑块、`.ai-reasoning-thumb`、`.mon-*` | `--shadow-pop/-panel/-sm/-xs` | 这些都只在拖拽/悬停/监控面板出现，同场景像素净差 0 |

## 5. 实测（`ab --ref 992806e`，同场景连拍扣噪声）

暗色：

| 场景 | 样式差异 | 净差像素 | bbox |
|---|---|---|---|
| `host-tag-probe` | `.ai-confirm-host-tag` `backgroundColor: rgba(0,0,0,0) → rgba(91,140,255,.12)` | **1424** | `91x18+97+71` |
| `import-preview` | 无 | **0** | — |
| `rdp-top` | 无 | **0** | — |
| `host-library` | 仅 `color-mix` 的序列化差异（逐通道 Δ=0） | **0** | — |
| `settings` | 无 | **0** | — |
| `ai-panel` | `#ai-drawer` 阴影（见 §5.2） | **0**（抽屉未布局） | — |

亮色（`theme light` 后同法）：`import-preview` / `rdp-top` / `host-library` / `settings` 均 **净差 0**、样式无差异；`host-tag-probe` **1413 px**。

### 5.1 为什么 0 不是「没验到」
- 同一批里 `host-tag-probe` 有 1424 px，说明比对链路是活的；
- `host-library` 那一轮抓到两处 `backgroundColor` 的序列化差异（`rgba(...)` vs `color(srgb ...)`），逐通道算下来 Δ=0——说明比对粒度到「属性级」，不是只看哈希。

### 5.2 `ai-panel` 场景的限缩（诚实记录）
`#ai-drawer` 在测试环境里 `#ai-panel` 父容器宽度为 0（无会话），抽屉无法真正布局，`getBoundingClientRect().width = 0`。
因此 AI 面板只在**计算样式层**验收（`#ai-drawer` 的 `box-shadow` 前后值已记录），像素层无法作证。要真机验证 AI 面板配色，需要先建立一次会话——留到有会话的场景补。

顺带修掉一个工具 bug：`ai-drawer` 是 toggle，`ab` 会连跑两次场景，第二次把抽屉关回去（场景里已改成「只有关着才点」）。

## 6. 截图（`.ui-check/shots/`，不入库）

| 主题 | 场景 | 文件 |
|---|---|---|
| 暗 | 导入预览 | `b2-dark-import-preview.png` |
| 暗 | 新建主机·RDP | `b2-dark-rdp-top.png` |
| 暗 | 确认卡 chip 探针 | `b2-dark-host-tag-probe.png` |
| 暗 | 设置 | `b2-dark-settings.png` |
| 亮 | 导入预览 | `b2-light-import-preview.png` |
| 亮 | 新建主机·RDP | `b2-light-rdp-top.png` |
| 亮 | 确认卡 chip 探针 | `b2-light-host-tag-probe.png` |
| 亮 | 设置 | `b2-light-settings.png` |

人工过目：chip 底色「可见但不抢戏」、文字对比够读；亮色设置页无控件发灰/透明/截断。其余 6 张对应的场景净差为 0，像素层无需再审。

## 7. 工具改动

1. `ui-check` 新增场景 `host-tag-probe`（用真实类名造一个 chip，不触发真实命令执行——这是验收标准 4 指定的做法）与 `ai-panel`。
2. `theme <light|dark|nebula>` 有一个真 bug：`nebula` 被映射成 `light`，所以「切到暗色」其实一直停在亮色（`--ref` 比对没暴露它，因为两边都是亮色）。已修 + 断言「切完必须是目标主题」，切错直接抛错。
3. 场景前置清理会先移除探针节点，避免污染后续截图。

## 8. 残留与下一批

- `token-color 19` 全是 `[data-theme="light"]` 组件级覆盖（监控面板 11 条、AI 上下文面板 5 条、`ai-reasoning-thumb` 等），属 **B4**。
- `row-decoration 10` + `media-sizing 7` 属 **B5**。
- 亮色语义色/阴影的真实调色在 B4 做；那时把 19 条覆盖删掉、只改 token 即可。
- 未做：`border` 简写里的颜色（`.badge-vision` 那类）不在 lint 的 `COLOR_PROPS` 里，属**规则盲区**；本批顺手也换了（`color-mix(...)`），但规则本身要不要覆盖简写，留给 B5 开 `--strict` 时定。
