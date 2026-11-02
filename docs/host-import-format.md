# 主机导入 / 导出格式与校验规则

本文是 `hosts:importInspect` / `hosts:importApply` / `hosts:exportFile` 的数据契约。
导入侧实现见 `src-tauri/src/host_io.rs`(解析与逐行校验)和 `src-tauri/src/config.rs`
(`parse_export` / `import_run`)。

## 1. 文件

- 格式:JSON。整体是 `{ "version": 4, "hosts": [...] }`,或旧版的裸主机数组 `[...]`。
- 兼容版本:v1(明文内联凭据)/ v2、v3(口令加密的 `credentials` 字符串)/ v4(内置密钥
  加密的 `credentials` 对象)。`version > 4` 直接拒绝,提示升级。
- 编码:UTF-8(可带 BOM)、UTF-16 LE / UTF-16 BE。其它编码给出「第 N 字节无法解码」并
  提示另存为 UTF-8。
- 上限:单文件 **16 MiB**、单次 **10000 台**。超限整份拒绝,不做半截导入。
- 空文件/`hosts: []`:拒绝,提示「文件里没有主机记录」。

## 2. 主机字段

导出字段与导入字段是同一份列表(单测 `export_fields_roundtrip_through_import` 断言集合
完全相等,防止以后只改一侧):

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | v3+ 必填 | 非空字符串;文件内不得重复 |
| `host` | 必填 | 非空、不含空格/控制字符、≤255 字符 |
| `port` | 否(默认 22) | 1–65535 的整数 |
| `username` | 否(默认 root) | 非空、不含空格/控制字符、≤64 字符 |
| `name` | 否 | 非空字符串、≤128 字符 |
| `authType` | 否 | `password` / `key` |
| `keyPath` | 否 | 字符串(私钥文件路径;文件内容是否打包见导出选项) |
| `group` | 否 | 字符串 |
| `tags` | 否 | 字符串数组,≤50 个,单个非空且 ≤64 字符 |
| `jumpIds` | 否 | 字符串数组;引用的 `id` 必须也在本文件中(v1/v2 无 id,不支持跳板引用) |
| `initcmd` | 否 | 字符串 |
| `sessionLog` | 否 | `default` / `always` / `never` |
| `aiAccess` | 否 | `default` / `manual` / `deny` |
| `cloud` | 否 | `null` 或对象;给了 `provider` 就必须给 `instanceId`,反之亦然 |

凭据(`password` / `privateKey` / `passphrase`)只能出现在 v1 的明文内联字段或加密的
`credentials` 块里;v4 的 `credentials` 是 `{alg, blob}`,不需要口令,v2/v3 是字符串,
没有口令会返回 `NEEDS_PASSPHRASE` 让前端补口令。

## 3. 重复与幂等

- 文件内重复:
  - 相同 `id` → 拒绝;
  - 相同 `cloud.provider + instanceId` → 拒绝;
  - 相同 `host:port:username` **且**名称/分组/认证/标签/跳板等可见配置完全一致
    → 拒绝(不同配置的同端点主机是合法的,例如同机跳板机与目标机)。
  报错会指出重复的两条分别在第几行/第几台。
- 与本地库重复:
  - 先按 `importSourceId` / `importSourceIds`(历次导入记下的源 ID)匹配;
  - 再按云身份匹配;
  - 最后按 `host:port:username`(本地唯一时才匹配)。
  匹配上且属性不同 = 冲突,默认保留本地,只在用户选择「覆盖」时写入。
- 幂等:同一份 v3/v4 文件导入两次,第二次新增为 0(源 ID 已记录);凭据补齐只在本地
  缺凭据时发生。并发重复导入由 `Store.data` 的互斥锁串行化,不会产生重复主机
  (单测 `concurrent_import_of_same_file_creates_no_duplicates`)。

## 4. 失败语义

导入是**整批原子**的:任何一行校验失败或写入过程出错,本次都不落盘,主机库与导入前
一致。失败信息一次列出所有问题行(最多 12 条,其余给计数):

```
导入文件校验失败（共 2 处问题），已全部回滚，未写入任何主机：
1. 第 8 行（第 2 台） · 字段 host：主机地址不能为空
2. 第 13 行（第 3 台） · 字段 port：端口必须在 1–65535 之间，当前为 70000
```

JSON 语法错误带行列:

```
文件不是合法 JSON：第 3 行第 18 列：expected value
```

行号指向该主机记录 `{` 所在行;压缩成一行的 JSON 无法区分时退化为「第 N 台」。

## 5. 导出

- `scope`: `{mode:"all"}` 或 `{mode:"ids", ids:[...]}`。ids 模式会自动带上被引用的
  跳板机(闭包),保证导出的图自洽;导出范围与界面当前筛选/选中一致由调用方传入 ids。
- 文件恒为 v4,凭据用内置密钥加密(`credentialsIncluded: true`);可选 `passphrase`
  走口令通道。
- `withKeys` 为真时把私钥文件内容一起打包(`credentials[].keyFile`),读不到的文件跳过,
  数量通过 `includedKeys` 返回;为假时只导出 `keyPath`。
- 重复导出不会覆盖已有文件:文件名冲突时自动追加 `-2`、`-3`。
- `includedJumps` / `includedKeys` 只用于给用户提示,导入端忽略。
