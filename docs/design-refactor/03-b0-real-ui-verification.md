# 03 · B0 真实 UI 验收记录（真身 Electron/Tauri 窗口，不是浏览器夹具）

目的：回答两个问题——**(1) 改动范围是否只在声明层、用户看到的像素有没有变**；**(2) 用户走一遍真实操作路径，行为是否符合预期**。
前置批次见 `01-style-debt-audit.md`、`02-b0-dead-token-fix.md`。

## 1. 被测对象

| 项 | 值 |
|---|---|
| 二进制 | `nebula-buildenv:1` 内 `cargo build` 产物（debug），前端资源用**工作区当前 `dist/`**（即含 B0 的 `src/style.css`） |
| 窗口 | Xvfb `:101` 1600×1000，容器 `ns-app`（`nebula-runenv:1`，`--net=host`），无窗口管理器 |
| 引擎 | WebKitGTK（Tauri 真实渲染引擎，**非 Chromium**） |
| 数据 | 本地库 1 台 `cache-prod-02/10.0.4.12/生产`；导入文件 v4 共 4 台（其中 `cache-prod-02` 分组 生产→数据库，构成 1 条冲突） |
| 驱动 | 应用自带测试桥（`NEBULA_TEST=1` + `NEBULA_TEST_BRIDGE_FILE`）→ `POST /eval` 注入 JS、`GET /result/<id>` 取回；截图 `import -window root` |

桥就绪证据：`[bridge] listening on 127.0.0.1:<port>` + `[page] loaded: tauri://localhost`。

## 2. A/B 方法（在真实引擎里比对「旧 CSS / 新 CSS」）

不用另建二进制，而是把 v0.7.6 的样式表**注入到同一个窗口**里当基线：

1. 取基线：`git show 7982dfb:src/style.css`（B0 之前的线上版本）。
2. 注入为第二个 `<style id="old-baseline">`，落在 `app.css` 之后 → 同优先级下**后出现者胜**，等于「同一份 DOM 用旧 CSS 重渲染一遍」。
3. **控制组**（证明注入真的生效）：另插一条 `.io-import .io-item{outline:3px solid red}` → 计算值 `outline-width` 从 `0px` 变 `3px`，移除后回 `0px`。
4. 两面各截一帧 → 逐像素比；再连拍两帧取「时间噪声掩码」，把光标闪烁/动画造成的像素从差异里剔除，剩下的才是 CSS 造成的净变化。

## 3. 结果（全部实测）

| 界面 | 主题 | 计算样式差异（12 选择器 × 23 属性） | 截图差异像素 | 净 CSS 差异 |
|---|---|---|---|---|
| 导入主机 → 校验预览（4 行含 1 冲突） | 暗（nebula） | 0 | 0 / 1,600,000（SHA256 相同） | **0** |
| 导入主机 → 校验预览 | 亮（日蚀亮） | — | 44 / 1,600,000，逐像素归因后均属时间噪声 | **0** |
| 新建主机 → 协议 RDP → 显示与体验（含 11 个勾选项） | 暗 | 0 | 7 / 1,600,000，同上 | **0** |

- `--text-on-accent` 在真实引擎里生效：`.ai-thread-count-badge` 计算值 `color: rgb(255,255,255)` / `background: rgb(91,140,255)`。
- `.rdp-adv-title` 计算值 `rgb(230,237,243)` = `--text`；`.rdp-chk` 继承值 `rgb(139,150,168)` = `--muted` —— 与 B0 之前的渲染值一致。
- 结论：**B0 的 23 处替换在真实渲染引擎里零像素变化**，与 `02` 文档里浏览器夹具的结论一致。

## 4. 真实操作路径（全部由真实事件驱动，不调内部函数）

| # | 用户动作 | 断言结果 |
|---|---|---|
| 1 | `Ctrl+Shift+P` | 命令面板打开，焦点落在 `#palette-input` |
| 2 | 输入「主机库」→ `Enter` | 唯一命中 `hosts.library` → `#modal-host-library` 打开，`hl-summary` = `共 1 台` |
| 3 | 点「导入主机」 | 导入弹窗打开，停在第 1 步（步骤条 `aria-current=step` = 选择文件） |
| 4 | 点「选择文件」 | 152 ms 后进入第 2 步；路径回填；4 行渲染；统计 `共 4 台 · 将导入 4 台 · 新增 3 · 冲突 1` |
| 5 | 冲突行内下拉 跳过→覆盖 | 按钮文案随之变 `覆盖 1 台并导入`；改回 `跳过` 又变 `导入 4 台` |
| 6 | 分段控件点「覆盖」 | `aria-checked` 翻转（跳过=false / 覆盖=true）；行内下拉同步为 `overwrite` |
| 7 | 点「重新选择」 | 回到第 1 步（`aria-current=step` = 选择文件），文件与预览保留 |
| 8 | 再点「选择文件」 | 121 ms 回第 2 步 |
| 9 | 点「导入 4 台」 | 151 ms 进第 3 步：「已导入 4 台主机 / 新增 3 / 覆盖 1 / 跳过 0」，逐台结果与统计一致，备份写到 `userdata/backup/nebulashell-backup-<ts>.json` |
| 10 | 点「完成」 | 弹窗关闭，回到主机库：`共 4 台`，分组「数据库 2 / 生产 1 / 跳板 1」 |
| 11 | 校验落盘 | `nebulashell-config.json` 4 台，`cache-prod-02` 的 `group` 已由 `生产` 变 `数据库`（覆盖确实生效） |
| 12 | 设置 → 终端 → 主题改「日蚀亮」 | 只是**预览**；不点保存直接关窗会回滚（符合设计），点「保存」后 `data-theme=light` 且写入磁盘 |

## 5. 两条「看起来像 bug、实测正常」的结论（防止下次误判）

- **RDP 端口显示 22**：视觉复核一度报告「RDP 下端口默认 22 是 bug」。实测为**测试脚本绕过 UI** 所致：真实入口是分段控件 `#host-protocol-slider .segmented-item[data-value=rdp]`，点它会走 `setHostProtocol()`，端口同步 `3389`、用户名同步 `Administrator`。直接改隐藏 `<select>` 的 value 不会触发这段逻辑。
- **RDP 高级区底部备注被弹窗下边缘切断**：实测 `.modal-card` `overflow-y: auto`、`scrollHeight 977 > clientHeight 758`，滚到底（`scrollTop 219`）后备注完整可见（`noteBottom 576 ≤ cardBottom 790`）。属视口高度不足时的正常内滚，不是截断。

## 6. 环境坑（复现时必看）

- `docker restart ns-app` 会留下 `/tmp/.X101-lock`，Xvfb 启动失败 → `Failed to initialize GTK` panic → 测试桥永不出现。**每次必须重建容器**（`docker rm -f` 后 `docker run`），启动脚本里先 `rm -f /tmp/.X101-lock`。
- 容器内无 `xwininfo`/`xdotool`（在 `nebula-shotenv:1` 里），只有 `import`（ImageMagick）→ 直接 `import -window root` 再按 `innerWidth/Height` 裁剪即可，无窗口管理器时窗口贴在 0,0。
- 无 dbus / 无 `dbus-run-session` 也能跑（托盘相关不影响窗口与测试桥）；`XDG_RUNTIME_DIR` 需 `mkdir -p /tmp/xdg && chmod 700`。

## 7. 复现

```bash
# 1) 二进制（B0 之后重编，前端资源走工作区 dist/）
docker run --rm -v "$PWD":/w -v nebula-cargo:/cargo -v nebula-target:/target -w /w \
  nebula-buildenv:1 bash -c 'CARGO_NET_OFFLINE=true cargo build'

# 2) 起真实窗口 + 测试桥（脚本在 scratch，可复制到 scripts/ 固化）
bash ~/.hermes/cache/scratch/ns-audit/start-app.sh
# → bridge ready on <port>

# 3) 驱动 / 比对：见本文 §2、§4（JS 走 POST /eval，截图 import -window root）
```
