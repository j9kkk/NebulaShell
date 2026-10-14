// AI 主机工具 schema（计划 §3）：OpenAI function 形状 {name, description, parameters}。
// 全部工具都绑定线程当前会话（sessionId 由循环层注入），schema 绝不暴露 host 参数。
// read_terminal 是唯一由前端直接执行的工具（读 xterm buffer），不走 ai:tool-exec。

// 发给模型的主机工具（不含 read_terminal；read_terminal 经 AI_AGENT_TOOLS 一并发送）
export const AI_TOOLS_SCHEMA = [
  {
    name: 'host_info',
    description: '探测当前主机的基本信息：内核与架构、发行版、登录用户、是否 root、默认 Shell。首次调用后有缓存，可在执行命令前用它确认环境。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: '按字节范围读取主机上的文本文件片段（自动做路径规范化与敏感路径检查）。参数 path 必填；offset 为起始字节（默认 0）；length 为读取字节数（默认上限 65536）。二进制文件会被拒绝并建议用 zcat。逐段读取大文件时按返回的 nextOffset 续读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或 ~ 开头路径' },
        offset: { type: 'integer', description: '起始字节偏移，默认 0' },
        length: { type: 'integer', description: '读取字节数，上限 65536' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'tail_file',
    description: '读取主机文件末尾 N 行（.gz 自动用 zcat），适合查看日志最新内容。lines 上限 500，输出不超过 64KB。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，支持 .gz' },
        lines: { type: 'integer', description: '读取末尾行数，默认与上限 500' },
        gz: { type: 'boolean', description: '显式指定按 gzip 解压读取（通常按扩展名自动判断）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_file',
    description: '在主机单个文件内搜索（grep -n，.gz 自动用 zgrep），返回匹配行与上下文。默认最多 200 个匹配、每侧最多 5 行上下文；需要正则时设 regex 为 true，忽略大小写设 ignoreCase 为 true。输出不超过 64KB。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要搜索的文件路径' },
        pattern: { type: 'string', description: '搜索内容（regex=false 时按字面文本匹配）' },
        context: { type: 'integer', description: '每个匹配前后附带行数，0-5' },
        maxMatches: { type: 'integer', description: '最多返回匹配数，默认与上限 200' },
        regex: { type: 'boolean', description: 'true 时 pattern 按正则解释' },
        ignoreCase: { type: 'boolean', description: '忽略大小写' },
      },
      required: ['path', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: '列出主机目录一层内容（名称/类型/大小/修改时间），不递归，最多 500 项。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，~ 代表家目录' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'file_size',
    description: '查询主机上单个文件的大小（字节）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_journal',
    description: '读取 systemd 日志（journalctl --no-pager）。unit 指定服务名，since 传 --since 可接受的时间表达式（如 "10 min ago"），priority 按 syslog 级别过滤，grep 为日志内二次过滤，lines 上限 500。无 systemd 的主机会返回不支持，此时改用 tail_file 读日志文件。',
    parameters: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'systemd 单元名，如 nginx.service' },
        since: { type: 'string', description: '起始时间表达式，如 "10 min ago" 或 "2026-01-01"' },
        priority: { type: 'string', description: '最低优先级，如 err、warning' },
        lines: { type: 'integer', description: '最多返回行数，默认与上限 500' },
        grep: { type: 'string', description: '在结果中过滤关键词' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'exec',
    description: '在当前主机的会话里执行一条 Shell 命令并返回输出（已脱敏、头尾截断）。' +
      '重要限制：每次 exec 都是一个全新 Shell，cd / export 等不会延续到下一次调用，需要持久状态的命令要写成单条组合命令（如 cd /var/log && tail -n 50 app.log）。' +
      '需要用户 Shell 环境（nvm、conda、rbenv 等初始化脚本）或交互式输入的命令无法在此执行，应给出代码块让用户在自己的终端里运行。' +
      '手动模式下每条命令都会先请求用户确认，用户可能直接跳过或改写命令；高危与外联（上传/下载、curl/wget 管道执行等）命令无论何种模式都会停下来等待用户确认。' +
      '不要把多条无关命令用 ; 或 && 拼在一起，便于用户逐条判断。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '要执行的命令（单条，不带提示符）' },
        cwd: { type: 'string', description: '工作目录，默认为终端当前目录' },
        idleTimeout: { type: 'integer', description: '空闲（无输出）超时秒数，上限 600' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
];

// read_terminal：纯前端工具（读当前 xterm 缓冲，不经 ai:tool-exec）
export const AI_READ_TERMINAL_TOOL = {
  name: 'read_terminal',
  description: '读取当前终端屏幕上用户可见的最近内容（用户在终端里操作、粘贴了报错信息时可读取）。lines 最多 500 行。此工具由用户端直接读取终端缓冲，不在主机上执行。',
  parameters: {
    type: 'object',
    properties: {
      lines: { type: 'integer', description: '读取行数，默认与上限 500' },
    },
    required: [],
    additionalProperties: false,
  },
};

// 实际随 ai:chat 下发的完整工具集（§3 全部，含前端执行的 read_terminal）
export const AI_AGENT_TOOLS = [...AI_TOOLS_SCHEMA, AI_READ_TERMINAL_TOOL];

// exec 工具名（循环层据此区分确认流程与只读流程）
export const AI_EXEC_TOOL = 'exec';
// 前端执行（读终端缓冲）的工具名
export const AI_FRONTEND_TOOLS = ['read_terminal'];
