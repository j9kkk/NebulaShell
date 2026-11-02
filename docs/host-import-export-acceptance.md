# 主机导入 / 导出：验收记录

- 验收卡：kanban `t_ee51f4f5`（回归验证主机导入导出全流程）
- 验收时间：2026-11-03 01:35–02:10 (CST)
- 验收基线：`45816fb`（界面改版）；本轮闭合项随本验收记录同一个提交（`git log -1 -- docs/host-import-export-acceptance.md`）
- 依据：`reports/host-io-audit-2026-11-03/ANALYSIS.md`（F-01…F-16 / U-01…U-15，共 31 条）
  + `docs/host-import-export-design.md`（D1–D17）+ `docs/host-import-format.md`（格式契约）
- 环境：macOS 27.2（本机）；前端 `dist/` 由 `node build.mjs` 现编；
  浏览器 Chromium 与 WebKit（Tauri 在 macOS 用 WKWebView）双引擎，假 `window.nebula` 后端。

---

## 0. 结论速览

| 维度 | 结果 |
|---|---|
| 清单 P0（2 条） | **2/2 闭合**（F-01、F-02；F-02 的导入侧文案残留本轮补掉） |
| 清单 P1（13 条） | **11 修复 / 1 部分（F-09）/ 1 未修复（F-04）**；F-04 需要后端文件指纹契约，已开跟进卡 |
| 清单 P2（16 条） | **12 修复 / 3 部分（F-15、F-16、U-10）/ 1 未修复（F-14，死通道）**；每条都有明确结论（§2） |
| 31 条验证覆盖率 | **31/31 都有可复核结论**（修复 25 / 部分 4 / 未修复 2，明细见 §2 备注） |
| 界面层断言（独立验收脚本） | Chromium **83/83**、WebKit **83/83**，0 控制台错误 |
| 数据层验收用例 | `import_export_acceptance` **22/22**；`cargo test --lib` **218/218** |
| 前端单测 | `npm run test:unit` **520/520** |
| 往返一致性 | 全库 → 空库 → 再导入 → 三代往返字段稳定（case02/03/04）；子集导出 + 跳板闭包可被空库吃下（case17） |
| 相邻功能（列表/分组/搜索/导入后刷新） | 4/4 通过，无回归 |
| 上线建议 | **可上线**，附带 1 条 P1 遗留（F-04）与 4 条 P2 遗留，均不阻断（理由见 §5） |

> 口径说明：`验证通过率` 与 `修复通过率` 分开记。31 条全部**验证**过（100%）；
> 修复上 P1 还差 F-04 一条，所以没有把它写成"P1 100% 修复"。

---

## 1. 验收方法与覆盖边界

### 1.1 三层验证

| 层 | 手段 | 覆盖什么 |
|---|---|---|
| 数据层 | `cargo test --test import_export_acceptance`（22 条，直驱真实 `config::Store`） | 解析、逐行校验、编码、上限、冲突决策、落盘原子性、备份、导出范围、往返一致 |
| 界面层 | `reports/host-io-acceptance-2026-11-03/acceptance.mjs`（真浏览器 + 假后端，83 条断言） | 卡片状态机、文案、禁用条件、焦点、范围、错误定位、逐行勾选、结果报告、窄屏 |
| 相邻功能 | 同上脚本 §I + 数据层 case20 | 主机列表渲染、分组筛选、搜索、导入后刷新与再筛选 |

**独立脚本**：本卡没有复用实现卡的 `reports/host-io-2026-11-03/verify.mjs`，
另写了一份只按"用户可见用例 + 审计条目"组织的脚本，避免"用实现者的断言验收实现者的代码"。
两套脚本都跑，结论一致。

### 1.2 明确没覆盖的（不要当成已验证）

| 项 | 原因 |
|---|---|
| 真实 Tauri 窗口里的系统文件选择框 / 拖放事件 | 用假 `invoke` 替换了 `hosts:importInspect` 与 `dialog:*`；拖放只验证了虚线区不再抢占点击 |
| 导出文件 `0600` 的端到端实测 | 命令层 `write_export_file` 需要 `AppHandle`；本卡只做代码级确认（`commands.rs` `set_permissions(0o600)`） |
| 5000 台在界面上的实际等待体验 | 数据层实测 apply 10.4s（debug）；界面只有不确定进度条，未在真机上计时 |
| F-04 TOCTOU | 功能未实现，无法验证；见 §5 |
| 全量 e2e | 项目铁律：只在发布前或用户明确要求时跑 |

---

## 2. 审计清单逐条结论

### 2.1 功能缺陷（F-01 … F-16）

| 编号 | 级别 | 结论 | 证据 / 说明 |
|---|---|---|---|
| F-01 | P0 | **已修复** | 导出卡新增「包含凭据」开关（默认开）+ 行内注记「文件内含 N 台主机的密码/私钥」；关闭后注记变「不含凭据,导入后需重新填写」、私钥行隐藏、payload `withCredentials:false`，后端 `export_hosts_with` 不写 `credentials` 块。UI 断言 5 条 |
| F-02 | P0 | **已修复**（导入侧残留本轮闭合） | 导出卡常驻黄块「文件里是真实凭据：内置密钥只能防误读,不能防人。设一个文件口令再发出去」+「设置文件口令」。**导入卡原本文案仍是「凭据用内置密钥保护,请按密码本对待」**（设计 §4 明确禁止的写法），本轮改为「凭据用内置密钥加密:同一版本的 App 都能解开,等同明文,请按密码本对待」——验收时实测发现，见 §4 |
| F-03 | P1 | **已修复** | `host_io::decode_import_bytes`：UTF-8(BOM 剥离) / UTF-16 LE / UTF-16 BE 全部可读；GBK 等非 UTF-8 报「文件「x.json」不是 UTF-8 编码（第 N 字节无法解码），请另存为 UTF-8 或 UTF-16 后重试」；`host_io_test::import_accepts_utf8_bom_utf16_and_rejects_non_utf8` 断言；界面层 8 类失败态无一条英文 OS 原文（AC-19） |
| F-04 | P1 | **已修复**（`t_9e44ae71`，见 §8） | `inspect` 返回 `digest`（`sha256:` + sha256 前 16 字节）+ `bytes`，`apply` 必带 `digest` 并先真读一次文件核对，不符/缺失 → `E_FILE_CHANGED` 且一个字节都不写。用例 `case23_file_changed_between_inspect_and_apply_is_rejected` |
| F-05 | P1 | **已修复**（本轮） | 原实现「先改内存 → `save()?`」，save 失败时内存已变。改为先 `write_data_at(快照)` 成功再 `*data = next`，且写盘与换内存都在锁内（否则并发导入互相覆盖）。`case18` 断言从"磁盘未变"加严为"磁盘与内存都未变"，实测 1→1 |
| F-06 | P1 | **已修复** | 「附带」行写「附带 N 台跳板机(连同其凭据)」/「不含跳板机」；徽标、结果态、toast 共用 `scopeSummary()` 一次计算。UI 实测：只选 2 台（其中一台挂了跳板）→ 徽标 `3 台`、附带行 `附带 1 台跳板机(连同其凭据)`；数据层 case17 `includedJumps=1` 且子集文件可被空库导入 |
| F-07 | P1 | **已修复**（本轮补齐） | 覆盖 diff 原先只有 name/host/port/username/group，本轮补 认证方式 / 私钥路径 / 初始命令 / 标签 / 跳板机，与 `merge_host` 实际覆盖的字段集对齐；新增单测 `import_diff_covers_every_field_overwrite_would_change`。UI 断言：冲突行展示「端口 22 → 6022」等字段级差异 |
| F-08 | P1 | **已修复** | 预览逐行勾选（含表头全选/半选），取消勾选的行进 `decisions[key]='skip'`；后端 `import_run` 对 skip 的**新增**主机在规划阶段就不创建（UI 卡 §3 的补充改动），界面不再说假话。实测取消一行：`导入 8 台 → 导入 7 台` |
| F-09 | P1 | **已修复**（`t_9e44ae71`，见 §8） | 行号/台序/字段定位已做到；本轮补齐结构化：`inspect` 返回 `invalidRows[{index,line,name,field,code,reason}]`（坏行 `kind:"invalid"` 不可勾选），`apply` 支持 `allowPartial` 只导有效行、坏行记 `result:"invalid"`，默认仍整份拒绝。用例 `case24`/`case25`/`case26`/`case27` |
| F-10 | P2 | **已修复** | `normalizeExportPath`：扩展名不是 `.json` 纠正；实测 `backup.txt` → 文件名为 `backup.json` |
| F-11 | P2 | **已修复** | 填 `~/Downloads` → `dir:"~/Downloads"` + 默认文件名（不再拆成 `dir:"~"`/`filename:"Downloads"`） |
| F-12 | P2 | **已修复**（代码级） | `write_export_file` 写盘后 `set_permissions(0o600)`；未做端到端权限实测（见 §1.2） |
| F-13 | P2 | **已修复** | 导入成功不再弹 toast（实测 `#toasts` 内可见 toast = 0），结果报告是唯一报数处；后端 `skipped` 口径未变，但界面按 `rows[]` 统计，不再出现两套数字 |
| F-14 | P2 | **已修复**（`t_153b5212`） | `hosts:importFile` 注册分支与其独有的 `file_has_credentials` 已删除，前端只剩 `importInspect → importApply`；`grep -r hosts:importFile src/` 零命中。见 §9 |
| F-15 | P2 | **已修复**（`t_153b5212`） | 私钥落盘名已是 `keys/<host-id>-<name>`；写盘失败不再静默——结果行 `warnings[]` 带「私钥写入失败：<原因>」，结果明细标黄、副标题报「N 个私钥写入失败」，复制报告同样带出；`case28_key_install_failure_is_reported` 用「把 keys 位置占成普通文件」逼出写失败验证。见 §9 |
| F-16 | P2 | **已修复**（性能部分，`t_153b5212`） | 匹配改索引（`MatchIndex`）：5000 台 debug apply **10.4 s → 0.44 s**，inspect 118 ms 不变，二次导入（最坏路径）0.56 s，`case16` 加了二次导入 <5 s 断言。按设计 §4.2 **不做**后台任务队列，仍是不确定进度条 |

### 2.2 体验 / 设计问题（U-01 … U-15）

| 编号 | 级别 | 结论 | 证据 / 说明 |
|---|---|---|---|
| U-01 | P1 | **已修复** | 预览首屏 10 行 + 整行按钮「查看全部 13 台 / 收起」；实测展开后 13 行全在 DOM |
| U-02 | P1 | **已修复** | 读取失败只有一条错误条（图标 + 中文原因 +「重新选择」），路径框 `aria-invalid`；8 类失败态均无英文 OS 原文、无「这个文件里没有可导入的主机」这类矛盾结论、无上一份文件的口令框残留 |
| U-03 | P1 | **已修复** | 冲突策略成为预览里的一段，第二层弹窗删除；导入相关浮层只有 1 个（`#modal-import`），三个 io 弹窗均带 `modal-stack` |
| U-04 | P1 | **已修复** | 导入卡打开焦点 = `io-import-pick`（选择文件）；导出卡 = `io-export-scope`（范围下拉），不再是右上角 ✕ |
| U-05 | P1 | **已修复** | 范围进卡内：`全部 N 台` / `当前筛选 M 台`（仅确有筛选时出现）/ `已选 K 台`；入口只给默认值。实测筛选 4 台导出走 `scope.mode=ids` 且 ids=4 |
| U-06 | P1 | **已修复**（按设计不合并） | 主机库工具栏收敛为 `导入主机 / 导出主机 / 新建主机`；命名取注册表、侧栏 ⠇ 分组加分隔线。设计 §5.1 明确**不合并**成「添加主机」三选一并向导（云导入带账号/区域/分页状态），本条按该决定验收 |
| U-07 | P2 | **已修复**（`t_153b5212`） | 「用口令加密（推荐）」后要求输入两遍；<8 位红框+底栏原因+禁用；两次不一致时第二个输入框 `aria-invalid` + 禁用。原观察项已闭合：口令为空 → 底栏「请输入文件口令(至少 8 位)」，只输一遍 → 「请再次输入文件口令」，不再等输入第一个字符才出现（脚本里已由 observation 转为断言） |
| U-08 | P2 | **已修复** | 步骤 1 只有「选择文件」一个入口（+ 拖放）；路径框 `readonly`；虚线区不再是 `role=button` |
| U-09 | P2 | **已修复** | 手打路径的场景消失（路径框只读），不再有"失焦静默回退" |
| U-10 | P2 | **已修复**（`t_153b5212`） | 开关文案「用口令加密（推荐）」（原「启用加密」，缺少设计要求的「（推荐）」）；关闭态行内说明「用内置密钥：任何拿到本 App 的人都能解开，等同明文」，开启态同一行换成「文件口令不会写入文件;丢失后文件里的凭据无法找回」——两态互斥、与开关同屏，不再只靠常驻警示块兜底 |
| U-11 | P2 | **已修复** | 冲突段在卡内：全局跳过/覆盖 + 每行下拉；覆盖时显示「会改:地址、端口、用户、认证方式、私钥路径、分组、标签、初始命令、凭据」 |
| U-12 | P2 | **已修复** | 主按钮只写台数：`导入 8 台` / `覆盖 3 台并导入`，冲突数在统计 chip |
| U-13 | P2 | **已修复** | 导出卡现在是 范围 / 附带（跳板台数）/ 格式 / 包含凭据 / 包含私钥 / 用口令加密，不再报"分组汇总"这种无意义信息 |
| U-14 | P2 | **已修复** | 导入成功只在结果报告报数（无 toast）；导出成功是结果态 + 同一句摘要的 toast（`exportSummary` 唯一来源） |
| U-15 | P2 | **已修复** | 按钮不手写省略号，菜单面由渲染层按 `asks` 追加（`docs/menu-conventions.md` E1/E5）；工具栏 `导入主机` vs 菜单 `导入主机…` 的差异是规范要求的，不是遗漏 |

### 2.3 汇总

| 结论 | P0 | P1 | P2 | 合计 |
|---|---|---|---|---|
| 已修复 | 2 | 13 | 16 | 31 |
| 部分修复 | 0 | 0 | 0 | 0 |
| 未修复 | 0 | 0 | 0 | 0 |
| 合计 | 2 | 13 | 16 | 31 |

> 表是**两批收尾之后**的最终状态：P2 打包在 `t_153b5212`（§9），F-04 / F-09 在 `t_9e44ae71`（§8）。

编号与级别的实际分布：P0 = F-01/F-02；P1 = F-03…F-09（7）+ U-01…U-06（6）；
P2 = F-10…F-16（7）+ U-07…U-15（9）。审计元数据里写的「P1 11 / P2 18」与正文编号不一致，
本表按正文编号逐条统计。

---

## 3. 用例矩阵（任务要求的 11 类）

| # | 用例 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| 1 | 正常导入（13 台，add/credOnly/conflict/identical 混合） | 进预览、台数正确、落盘后进结果态 | 摘要「共 13 台 · 将导入 8 台」+ 四类 chip；落盘后步骤 3；库 11→14 台 | 通过 |
| 2 | 含错误行的导入 | 整份拒绝、逐行定位、不写任何主机 | 「第 8 行（第 2 台） · 字段 host：主机地址不能为空」等，最多 12 条；`case08`/`case21` 断言库不变 | 通过 |
| 3 | 重复主机 | 同 id/同端点同配置拒绝；同端点不同配置允许；重导同一文件判 identical | `case10`（id 重复拒绝）、`case11`（同端点不重复建）、`case03`（重导 0 新增）、`case12`（冲突 skip/overwrite 语义） | 通过 |
| 4 | 超大文件 | 超 16 MiB 明确拒绝；5000 台可完成 | 24 MB → 「导入文件过大（24.0 MB），单次上限 16 MB…」；5000 台 inspect 118 ms / apply 10.4 s，重导全判一致 | 通过（性能见 F-16） |
| 5 | 空文件 | 说明是空文件，不是"JSON 不合法" | 「文件是空的（0 字节），请重新导出或选择其它文件」 | 通过 |
| 6 | 错误格式文件（CSV/TSV/YAML/HTML/截断/非对象） | 中文 + 行列定位 | `case07` 9 种输入逐条断言；界面「文件不是合法 JSON：第 1 行第 2 列：expected ident」 | 通过 |
| 7 | 不同编码与分隔符 | BOM/UTF-16 可读；GBK 给出可执行提示；CSV 被当格式错误 | BOM/UTF-16 LE/BE 解码断言通过；GBK 中文提示；CSV/TSV 行列报错 | 通过 |
| 8 | 无权限用户 | 落盘失败说"未写入任何主机"，磁盘与内存都不变 | 只读目录：`Permission denied (os error 13)`，配置文件字节不变、内存主机数 1→1；界面结果态「本次没有写入任何主机」+「返回预览」 | 通过（F-05 本轮闭合后） |
| 9 | 导出当前筛选 / 选中 / 全部 | 三种范围可选且台数正确 | 全部 11 台；筛选 4 台（`mode=ids`, ids=4）；已选 2 台（+1 跳板 = 3 台） | 通过 |
| 10 | 导出后再导入的往返一致性 | 字段与凭据完全还原；三代往返稳定 | `case02` 全库→空库字段比对、`case03` 幂等、`case04` 三代往返、`case17` 子集+闭包可被空库吃下；界面侧导出结果态给出完整路径 | 通过 |
| 11 | 相邻功能回归（列表/分组/搜索/分页） | 不被破坏 | 列表 11 行、分组 3 段、搜索 4 命中、分组筛选 2 行、导入后 14 行且搜索新主机 3 行 | 通过（**分页不适用**：本应用主机库无分页组件，`grep 分页/pageSize` 无命中） |

补充用例（本卡额外覆盖）：

| # | 用例 | 实际 | 结论 |
|---|---|---|---|
| 12 | 导出失败（目录不可写） | 留在卡里、中文原因、按钮恢复、不显示成功态 | 通过 |
| 13 | 口令加密文件导入 | 先要口令 → 错口令给中文原因 → 对口令进预览 | 通过 |
| 14 | 口令二次输入 | 为空/过短/不一致均禁用并标红 | 通过（U-07 观察项见 §5） |
| 15 | 窄屏 640×720 / 420 宽 | 无横向溢出，卡片不超视口 | 通过 |
| 16 | 备份与封顶 | 导入前备份、不含明文口令、只留最近 20 份 | 通过（`case19`） |

---

## 4. 本轮验收中闭合的问题

验收过程本身发现并修掉 2 处（都是审计条目没真正闭环的部分），连同 F-07 的 diff 补字段一起
随本记录提交（`src/modules/transfer.js`、`src-tauri/src/config.rs`、`src-tauri/src/store_test.rs`、
`src-tauri/tests/import_export_acceptance.rs`），改动独立可复核：

| 项 | 改动 | 文件 | 验证 |
|---|---|---|---|
| F-02 残留 | 导入卡对「内置密钥」文件仍写「凭据用内置密钥保护,请按密码本对待」（审计 F-02 的原证据句），改成「凭据用内置密钥加密:同一版本的 App 都能解开,等同明文,请按密码本对待」 | `src/modules/transfer.js` | 界面断言由 FAIL 转 PASS（双引擎） |
| F-05 | 导入改为「先写盘成功再换内存」，写盘与换内存都留在锁内；`save()` 抽出 `write_data_at` | `src-tauri/src/config.rs` | `case18` 加严断言（内存 1→1）+ `concurrent_import_of_same_file_creates_no_duplicates` 通过 + `cargo test --lib` 218 通过 |
| F-07 | 覆盖 diff 补 认证方式 / 私钥路径 / 初始命令 / 标签 / 跳板机 | `src-tauri/src/config.rs` | 新增单测 `import_diff_covers_every_field_overwrite_would_change` |

> F-05 首次实现时把"写盘"放在锁外，`concurrent_import_of_same_file_creates_no_duplicates` 立刻转红
> （两线程基于同一旧快照规划，added 变 4）。改为"写盘与换内存都在锁内"后转绿——
> 这条留在这里，提醒后续动这段代码的人：锁的边界就是并发导入的正确性边界。

---

## 5. 遗留问题与跟进建议

| # | 项 | 级别 | 影响 | 为什么当时可以上线 | 跟进 |
|---|---|---|---|---|---|
| — | （无） | — | — | — | — |

> 原表 8 条已全部闭合：F-04 / F-09 由 `t_9e44ae71`（§8）；F-14 / F-15 / F-16 / U-10 / U-07 与「预览列表最后一行被切一半」由 `t_153b5212`（§9）。

---

## 6. 复跑方法与证据

```bash
cd code

# 1) 数据层:28 条用户可见验收用例(直驱真实 Store,不启 Tauri)
cd src-tauri && cargo test --test import_export_acceptance -- --test-threads=1 && cd ..

# 2) 单元/集成
cd src-tauri && cargo test --lib && cd ..
npm run test:unit

# 3) 界面层(独立验收脚本,先重编 dist)
node build.mjs
node reports/host-io-acceptance-2026-11-03/acceptance.mjs chromium
node reports/host-io-acceptance-2026-11-03/acceptance.mjs webkit
```

> `reports/` 在 `.gitignore` 里，脚本与截图只在本地留档（与前面几张卡一致）。
> WebKit：`t_153b5212` 里补装了 npx 那份 1.64.1 playwright 的 webkit（`webkit-2370`），
> 现在 `node …acceptance.mjs webkit` 直接可跑，不必再指定 `PW_PATH`。

证据文件（`reports/host-io-acceptance-2026-11-03/`）：

| 文件 | 内容 |
|---|---|
| `acceptance.mjs` | 独立验收脚本（**92** 条断言，双引擎；`t_153b5212` 后由 83 增至 92） |
| `result-chromium.json` / `result-webkit.json` | 逐条断言结果 + 观察项 + 控制台错误 |
| `A1-export-config.png` | 导出配置态：范围/附带/凭据开关/警示块 |
| `A2-export-filtered.png` | 「当前筛选」范围 |
| `A3-export-failed.png` | 导出失败留在卡里 |
| `B1-import-badrows.png` | 含错误行的导入（逐行定位） |
| `B2-import-gbk.png` | GBK 编码文件的提示 |
| `C1-import-step2.png` | 预览态（摘要/勾选/冲突段/差异） |
| `C2-import-result.png` | 结果报告（五桶 + 备份路径） |
| `C3-import-apply-failed.png` | 落盘失败态 |
| `C4-export-passphrase.png` | 口令二次输入 + 不一致标红 |
| `D1-library-after-import.png` | 导入后的主机库 |
| `D2-export-done.png` | 导出结果态 |
| `E1-narrow-640.png` | 640×720 窄屏 |
| `measure-list.mjs` | 预览列表裁切边界的定点量测（§8 第 8 条的 22/34px 证据） |
| `F1-import-key-warning.png` | 私钥写失败告警（行内标黄 + 副标题报数） |
| `F2-list-fade-640.png` | 640×720 预览列表静止态：底部渐隐 |
| `F3-list-fade-middle-640.png` | 滚动中途（过渡帧）：渐隐保持 |

---

## 7. 签署结论

- 清单 31 条**全部完成验证**，每条都有可复核证据。签署当时：P0 全闭合、P1 11/13（F-09 部分、F-04 未修）、P2 12/16；这两批缺口已在 §8（F-04/F-09）与 §9（P2 打包）闭合，现为 **31/31 全部修复**。
- 往返导入导出数据一致（全库/子集/三代往返/幂等重导），无新增回归；相邻功能（列表、分组筛选、搜索）实测未被破坏。
- **可上线**。

---

## 8. 后续闭环（2026-11-03，卡 `t_9e44ae71`）

§5 的跟进卡 ① 已完成，F-04 与 F-09 的剩余部分（结构化问题行 + 只导有效行）同时落地；
本节的结论替代 §7 中「F-04 未修复 / F-09 部分」的表述，§1–§7 保留为当时的验收记录。

| 项 | 原状态 | 现在 | 证据 |
|---|---|---|---|
| F-04 预检→落盘 TOCTOU | 未修复 | **已修复** | `inspect` 返回 `digest`（`sha256:` + sha256 前 16 字节）+ `bytes`；`apply` 必带 `digest`，先真读一次文件再核对，不符/缺失 → `E_FILE_CHANGED`，一个字节都不写。用例 `case23_file_changed_between_inspect_and_apply_is_rejected` |
| F-09 问题行不可勾选 | 部分修复 | **已修复** | `inspect` 有坏行时返回 `rejected + code + invalidRows[{index,line,name,field,code,reason}]`，并照常给出有效行 `rows`（坏行 `kind:"invalid"` 禁用勾选）；`apply` 支持 `allowPartial`，坏行记 `result:"invalid"`。默认仍整份拒绝。用例 `case24`/`case25`/`case26` |

- 契约细节写进设计 §10.2 / §10.3（含 `digest` 缺省视为不符、`rows[].result` 增加第六值 `invalid`）。
- 界面定点验证：`reports/host-io-f04-f09-2026-11-03/verify.mjs`，Chromium 27/27、WebKit 27/27
  （文件被改 → 退回步骤 1、路径保留、一键「重新校验」回到步骤 2；问题行不可勾选；勾选「只导有效行」后主按钮台数随勾选变化）。
- 回归：`cargo test --test import_export_acceptance` 27 通过、`cargo test --lib` 218 通过、
  `host_config_ux` 10 通过、`npm run test:unit` 520 通过、上一轮界面验收脚本 83/83 仍全绿。

---

## 9. 收尾批次 `t_153b5212`（已闭合）

P2 打包（§5 原表里的 F-14 / F-15 / F-16 / U-10 / U-07 + 预览列表收边）已在本批次清掉，`c1971f0` / `edbf210` / `71503fd` 落地（`71503fd` 只是文档收尾）：

| # | 项 | 现在的行为 | 证据 |
|---|---|---|---|
| 2 | **F-14** `hosts:importFile` 死通道 | 注册分支与其独有的 `file_has_credentials` 一并删除；导入只剩 `importInspect → importApply` 一条路（预检/备份/digest 语义不再有旁路） | `grep -r hosts:importFile src/` 零命中；`cargo test --lib` |
| 3 | **F-15** 私钥写失败静默 | 写盘失败进 `rows[].warnings[]`（`私钥写入失败：<原因>(<文件名>)`）；结果明细该行说明标黄、成功副标题追加「N 个私钥写入失败」、复制报告/下载明细同样带出；主机本身照常写入，`keyPath` 不会被改成没写成功的路径 | `case28_key_install_failure_is_reported`（把 `keys` 位置占成普通文件逼出写失败）；界面 `F1-import-key-warning.png` |
| 4 | **F-16** apply O(n²) | 匹配改成索引（`MatchIndex`：身份 token / 端点 / 云实例各建一次，新主机增量登记）。语义与全表扫描等价：端点仍只认「唯一未认领」，云身份多台命中仍报「身份不明确」 | 5000 台 debug：**apply 10.4 s → 0.44 s**，inspect 118 ms 不变，二次导入（全一致、最坏路径）0.56 s；`case16` 增加二次导入 <5 s 断言 |
| 6 | **U-10** 口令开关文案 | 开关改名「用口令加密（推荐）」；关闭态行内说明「用内置密钥：任何拿到本 App 的人都能解开，等同明文」，开启态同一行换成「文件口令不会写入文件…」（两态互斥，不靠下方警示块兜底） | 断言 `U-10`×3；`C4-export-passphrase.png` |
| 7 | **U-07** 口令为空无原因 | 空口令 → 底栏「请输入文件口令(至少 8 位)」；只输一遍 → 「请再次输入文件口令」；不足 8 位/两次不一致维持原有文案。原观察项已转为断言 | 断言 `U-07`×3（observation → check） |
| 8 | 预览列表最后一行被切一半 | 新增**全局**「可滚行列表底部渐隐」规则：容器加 `data-scroll-fade`，溢出时底部 18 px 渐隐、滚到底自动收回（`shared/scroll-fade.js` + `style.css`）。**没有**为这个列表单独调容器高/行高 | 量测不变（第 6 行仍 22/34 px），但静止时有"还能滚"的视觉提示；断言 `UI-1`×3（静止/过渡帧/到底）；`F2-list-fade-640.png`、`F3-list-fade-middle-640.png` |

F-16 的「真实百分比进度」按设计 §4.2 **不采纳**（不做后台任务队列），仍是不确定进度条 + 说明"在等什么"。

复跑（断言数 83 → **92**，Chromium/WebKit 各 92）：

```bash
node build.mjs
node reports/host-io-acceptance-2026-11-03/acceptance.mjs chromium
node reports/host-io-acceptance-2026-11-03/acceptance.mjs webkit
cd src-tauri && cargo test --lib && cargo test --test import_export_acceptance
```

新增证据：`F1-import-key-warning.png`（私钥写失败告警）、`F2-list-fade-640.png`（静止渐隐）、`F3-list-fade-middle-640.png`（滚动中过渡帧）。
