# 菜单规范落地记录(实施 t_9f2daf78)

> 依据:`docs/menu-conventions.md`(提交 `429087e`)。本文只记录**实施时的偏离与验证结果**,
> 规范本身未改动;凡与规范不一致处都在下面如实列出。

## 1. 落地方式

| 层 | 文件 | 做法 |
| --- | --- | --- |
| canonical 文案 | `src/modules/entry.js` | 45 条注册命令按 §6.1 逐行替换;`pane.zoom` / `workspace.close` 动态变体收进 N5 白名单 |
| 省略号 | `src/modules/commands.js` | 新增 `asksForInput()` + `menuLabelOf()`;`commandState().label` 返回裸文案;`commandMenuItem` 不再接受 `label` / `noEllipsis` |
| 键位 | `src/modules/keymap.js` | 12 条 label 逐字对齐;`ai.cycleEffort` → `⌘⌥E`;新增 `palette.connectNewTab` 并加入 `COMPONENT_ACTIONS` |
| 键位渲染 | `src/modules/core.js` | `accel()` 按平台排序修饰键 + 范围键渲染 |
| 菜单结构 | `src/shared/menu-spec.js` | 删 `text` / `accelerator: false`;`紧凑列表` 移到「主机」组末;PC 编辑补 `全选` |
| 菜单渲染 | `native-menu.js` / `menubar.js` | 文案一律 `menuLabelOf`;删 `entry.text` 覆盖 |
| 右键 / 下拉 / 面板 | `terminal.js`、`hosts.js`、`sftp.js`、`host-library.js`、`ai-agent-ui.js`、`palette.js`、`index.html` | 按 §6.7–§6.12 逐行替换 |

## 2. 与规范的偏离(3 处,均为规范内部前后不一致导致)

1. **新增第 46 条命令 `term.selectAll`**。§6.5 要求 PC「编辑」菜单追加
   `cmd('term.selectAll', { only: 'pc' })`,但该 id 原先只存在于 keymap、没有注册命令,
   菜单项会渲染成空。因此在 `entry.js` 补了一条注册(`category: 'session'`, 名称`全选`,
   作用于当前/右键的终端),`registerCommand` 由 45 条变 46 条。设置页因此出现
   「终端内全选」与「全选文件」两行 —— 正是 §6.13 / S5 要求的可区分写法。
2. **`files.selectAll` 仍不是命令**。§6.9 建议文件条目右键改用
   `commandMenuItem('files.selectAll', ctx)`,但该 id 同样只在 keymap 里。为避免新增一条
   无 ctx 语义的命令(会进命令面板),这里用静态项
   `{ label: '全选文件', key: accelOf('files.selectAll'), run: ... }` 实现:
   名称取自 keymap canonical,键位进专用列,满足 S4/S6/N4。
3. **e2e 断言同步**。§6.14 写「`e2e/**` 无菜单文案断言」,实际 `e2e/ui.e2e.mjs` 有 6 处
   直接断言旧文案(T70b / T50c / T58 两处点击 / T59 / T92),已随改名更新;`npm test`
   仍未运行(项目铁律)。

另:hosts 侧栏星标按钮、主机库常用按钮的 `title` 由「标记为常用」改为「设为常用」(N8),
这两处不在 §6.8/§6.10 的表里,但属同一动作的同一名字(N4)。

## 3. 验证结果

```
node build.mjs                 → exit 0
npm run lint:css               → exit 0
node --experimental-vm-modules --test tests/*.test.mjs src/modules/*.test.mjs
                               → 471 pass / 0 fail
grep -rn "noEllipsis" src/     → 只剩 commands.js 里"忽略覆盖"的那一行
grep -rn "commandMenuItem(.*label:" src/  → 无命中
```

按平台渲染(临时脚本按 keymap + menu-spec 逐项求值,未入库):

- 35 个 keymap 动作 × 3 平台,显示文案与 §7.1 终态表逐字一致(含 `⌘1…⌘9`、`⌘⌥B`、`⌘⌥E`);
- 同平台重复键位:**仅 `⌘A` 一对**(`term.selectAll` / `files.selectAll`,作用域隔离,S5 豁免);
  Windows/Linux 为 0;
- `specFor('mac')` / `specFor('pc')` 的每条 `cmd` 都已注册,菜单渲染文案与 §6 改名表一致,
  `menu-spec` 里 `cmd` 项不再带 `text` 字段(仅系统预定义项 `pre()` 保留显示文本);
- 注册表 46 条中:32 条有键位,14 条无键位(§6.3 末段的 11 条 + 3 条 internal 别名);
  keymap 35 条中 32 条有同名命令(其余 3 条是 `tab.switch` / `files.selectAll` /
  `palette.connectNewTab`,按规范只作键位、不进菜单)。

## 4. 仍需人工确认

- ~~真机菜单外观(右对齐键位列、原生菜单加速键)未截图~~ → 已由 `t_c6b73c82` 的定点验收覆盖,见 §5;
  全量 e2e 按项目铁律仍未跑。
- 设置页若曾把 `cmd+T` 录给「切换思考强度」,需重新录制(S11,已写入 CHANGELOG)。

## 5. 验收结果(t_c6b73c82)

| 项 | 结果 | 位置 |
| --- | --- | --- |
| 回归守门(13 个用例,覆盖 §9.3 的 5 项并加静态项/HTML 检查) | 13/13 PASS | `tests/menu-conventions.test.mjs` + `tests/menu-conventions.data.mjs` |
| 单测全量 | 519/519 PASS | `node --experimental-vm-modules --test tests/*.test.mjs src/modules/*.test.mjs e2e/*.test.mjs` |
| macOS 菜单栏(8 组 / 40 命令项,文案 + 加速键 + 勾选) | PASS | `reports/menu-verify-2026-11-02/result.json` |
| Windows / Linux 菜单栏(各 6 组 / 42 条) | PASS | 同上 |
| 布局(无截断/换行、键位列右对齐、无溢出/遮挡) | PASS | 同 `report.md` §3 |
| 设置页快捷键表(46 行,行名无 …) | PASS | 同上 §5 |
| 实机按键(mac 8 / Win 8 / Linux 8 次触发) | PASS | `liveShortcuts` |
| 变异测试:注入 5 类违规(三个点 / 漏 … / 撞键 / 菜单第二份文案 / 静态项三个点) | 全部被抓住并还原 | `report.md` §8 |

> 只做定点验收:真 Chromium + 假后端跑菜单渲染,不启 Tauri、不跑全量 e2e。
> 详细逐菜单表见 `reports/menu-verify-2026-11-02/report.md`。
