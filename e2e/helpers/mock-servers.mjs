// 测试用 mock 服务器：腾讯云/阿里云 API（带基础签名校验）与 AI（OpenAI + Anthropic SSE）
import http from 'node:http';

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AI 主机工具场景:无状态,按请求里的对话进度决定这一轮返回什么(轮次 = 最后一条
// 用户消息之后的 assistant 条数)。工具调用与结果不配对时像真实服务端一样返回 400,
// 用来验证中止/清理后历史依然合法。
function toolScenario(name, body, vars = {}) {
  const msgs = body.messages || [];
  const ids = msgs.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  const results = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  if (ids.length !== results.length || ids.some((id) => !results.includes(id))) {
    return { status: 400, body: { error: { message: 'tool_call pairing broken' } } };
  }
  const after = msgs.slice(msgs.map((m) => m.role).lastIndexOf('user') + 1);
  const round = after.filter((m) => m.role === 'assistant').length;
  const lastTool = String([...after].reverse().find((m) => m.role === 'tool')?.content || '');
  const anyTool = (s) => msgs.some((m) => m.role === 'tool' && String(m.content).includes(s));
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const call = (id, name, args) => ({ id, name, args });
  switch (name) {
    case 'story':
      if (!hasTools) return { text: 'NO-TOOLS' };
      if (round === 0) {
        return { text: '先看看主机和日志。', calls: [
          call('c_info', 'host_info', {}),
          call('c_tail', 'tail_file', { path: '/home/user/data/app.log', lines: 20 }),
          call('c_term', 'read_terminal', { lines: 30 }),
        ] };
      }
      if (round === 1) return { calls: [call('c_exec', 'exec', { cmd: 'echo NB-EXEC-OK && pwd' })] };
      return { text: `STORY-DONE ${lastTool.includes('NB-EXEC-OK') ? 'EXEC-SEEN' : 'EXEC-MISSING'} ${anyTool('upstream timed out') ? 'LOG-SEEN' : 'LOG-MISSING'} ${lastTool.includes('/data') ? 'CWD-SEEN' : 'CWD-MISSING'}` };
    case 'danger':
      if (round === 0) return { calls: [call('d1', 'exec', { cmd: 'rm -rf /home/user/data/victim' })] };
      return { text: 'DANGER-DONE ' + lastTool.split('\n')[0] };
    case 'stop':
      if (round === 0) return { calls: [call('s1', 'exec', { cmd: 'sleep 31.5 && touch /home/user/data/late-marker' })] };
      return { text: 'STOP-CONTINUED' };
    case 'echo':
      return { text: 'PAIRING-OK' };
    case 'unsupported':
      if (hasTools) return { status: 400, body: { error: { message: 'model mock-x does not support tools' } } };
      return { text: 'PLAIN-OK' };
    case 'sensitive':
      if (round === 0) return { calls: [call('k1', 'read_file', { path: '~/.ssh/id_rsa' })] };
      return { text: lastTool.includes('path_denied') ? 'DENIED-SEEN' : 'DENIED-MISSING' };
    // 会话授权（.invalid 域名不会真的连上，只验证判定与界面）：
    // 下载 → 授权后同站下载免确认 → 执行下载产物（污点）→ 上传（永不可授权）。
    case 'allow':
      if (round === 0) return { calls: [call('w1', 'exec', { cmd: 'curl -sS -m 3 -o dl-a.txt https://dl.nebula-e2e.invalid/a.txt' })] };
      if (round === 1) return { calls: [call('w2', 'exec', { cmd: 'curl -sS -m 3 -o dl-b.txt https://dl.nebula-e2e.invalid/b.txt' })] };
      if (round === 2) return { calls: [call('w3', 'exec', { cmd: 'bash dl-b.txt' })] };
      if (round === 3) return { calls: [call('w4', 'exec', { cmd: 'curl -sS -m 3 -d x=1 https://dl.nebula-e2e.invalid/up' })] };
      return { text: 'ALLOW-DONE' };
    case 'allow-manual':
      if (round === 0) return { calls: [call('m1', 'exec', { cmd: 'curl -sS -m 3 -o dl-c.txt https://dl.nebula-e2e.invalid/c.txt' })] };
      return { text: 'MANUAL-DONE' };
    // 高危授权（真实本地 shell，/home/user 映射临时目录）：原地修改 → 授权目录 → 同目录
    // 第二条免确认；写穿符号链接、删除（另一类授权）、敏感位置仍逐条确认。
    // sed 用 -i.bak 形式：GNU 与 BSD(macOS) 都认。
    case 'allow-file':
      if (round === 0) return { calls: [call('f1', 'exec', { cmd: "sed -i.bak 's/port=80/port=8080/' /home/user/data/app/conf.txt" })] };
      if (round === 1) return { calls: [call('f2', 'exec', { cmd: "sed -i.bak 's/a=1/a=2/' /home/user/data/app/other.txt" })] };
      if (round === 2) return { calls: [call('f3', 'exec', { cmd: 'echo hacked > /home/user/data/app/link.txt' })] };
      if (round === 3) return { calls: [call('f4', 'exec', { cmd: 'rm /home/user/data/app/other.txt.bak' })] };
      if (round === 4) return { calls: [call('f5', 'exec', { cmd: "sed -i.bak 's/x/y/' /etc/sudoers" })] };
      return { text: 'FILE-DONE' };
    // 结束进程按进程名授权（PID 是测试自己启动的专用进程）；PID 1 与卸载（本机没有
    // apt-get，模拟失败）仍逐条确认。
    case 'allow-kill':
      if (round === 0) return { calls: [call('k1', 'exec', { cmd: `kill ${vars.pidA}` })] };
      if (round === 1) return { calls: [call('k2', 'exec', { cmd: `kill ${vars.pidB}` })] };
      if (round === 2) return { calls: [call('k3', 'exec', { cmd: 'kill 1' })] };
      if (round === 3) return { calls: [call('k4', 'exec', { cmd: 'apt-get remove -y nbmockpkg' })] };
      return { text: 'KILL-DONE' };
    default:
      return { text: 'UNKNOWN-SCENARIO' };
  }
}

export const TENCENT_MOCK_INSTANCES = [
  {
    InstanceId: 'ins-e2e-1', InstanceName: 'e2e-cvm-1', InstanceState: 'RUNNING',
    PublicIpAddresses: ['203.0.113.10'], PrivateIpAddresses: ['10.0.0.10'], OsName: 'Ubuntu Server 22.04 LTS',
  },
  {
    InstanceId: 'ins-e2e-2', InstanceName: 'e2e-cvm-2', InstanceState: 'STOPPED',
    PrivateIpAddresses: ['10.0.0.11'], OsName: 'Windows Server 2019',
  },
];

export const LIGHTHOUSE_MOCK_INSTANCES = [
  {
    InstanceId: 'lhins-e2e-1', InstanceName: 'e2e-lh-1', InstanceState: 'RUNNING',
    PublicAddresses: ['203.0.113.30'], PrivateAddresses: ['10.0.0.30'], OsName: 'OpenCloudOS 9',
  },
];

export const ALIYUN_MOCK_INSTANCES = [
  {
    InstanceId: 'i-e2e-1', InstanceName: 'e2e-ecs-1', Status: 'Running', OSName: 'Alibaba Cloud Linux',
    PublicIpAddress: { IpAddress: ['198.51.100.20'] },
    VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.16.0.20'] } },
  },
  {
    InstanceId: 'i-e2e-2', InstanceName: 'e2e-ecs-2', Status: 'Stopped', OSName: 'CentOS 7.9',
    VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.16.0.21'] } },
  },
];

export async function startMockCloudServer() {
  const calls = { tencent: 0, aliyun: 0, tencentAuthOk: 0, aliyunAuthOk: 0, rejected: 0 };
  // 故意用错密钥时校验必须失败 —— 真实厂商按签名/密钥判有效性,
  // mock 通过约定"密钥里含 BAD"来模拟(否则任何字符串都能通过,负例无从测起)。
  const tencentKeyId = (req) => {
    const m = /Credential=([^/]+)\//.exec(String(req.headers['authorization'] || ''));
    return m ? m[1] : '';
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    // 根路径:腾讯云统一入口(真实 API 为 cvm/lighthouse.tencentcloudapi.com,
    // 测试里两个 service 都打到同一 host,故按 body 里的字段无法区分 ——
    // 这里用自定义头 X-Mock-Service 区分(仅测试客户端可见),否则返回合并数据。
    if (url.pathname === '/' || url.pathname === '') {
      const action = req.headers['x-tc-action'];
      const svc = req.headers['x-mock-service'] || '';
      if (!String(req.headers['authorization'] || '').startsWith('TC3-HMAC-SHA256 Credential=')) {
        res.writeHead(401).end(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '缺少 TC3 签名' }, RequestId: 'mock' } }));
        return;
      }
      if (tencentKeyId(req).includes('BAD')) {
        calls.rejected++;
        res.end(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'The SecretId is not found' }, RequestId: 'mock' } }));
        return;
      }
      calls.tencent++; calls.tencentAuthOk++;
      if (action === 'DescribeRegions') {
        // 回归:CVM 与轻量的地域表不保证一致 —— 轻量只覆盖广州。
        // 校验/拉取必须按"两表并集"扫描:沿用单表会漏地域或扫错服务。
        const regions = svc === 'lighthouse'
          ? [{ Region: 'ap-guangzhou', RegionName: '广州', RegionState: 'AVAILABLE' }]
          : [
              { Region: 'ap-guangzhou', RegionName: '广州', RegionState: 'AVAILABLE' },
              { Region: 'ap-shanghai', RegionName: '上海', RegionState: 'AVAILABLE' },
            ];
        res.end(JSON.stringify({ Response: { RequestId: 'mock-tc', RegionSet: regions } }));
        return;
      }
      if (action === 'DescribeInstances') {
        const set = svc === 'lighthouse' ? LIGHTHOUSE_MOCK_INSTANCES : TENCENT_MOCK_INSTANCES;
        res.end(JSON.stringify({ Response: { RequestId: 'mock-tc', TotalCount: set.length, InstanceSet: set } }));
        return;
      }
      res.end(JSON.stringify({ Response: { Error: { Code: 'InvalidAction', Message: 'unknown action ' + action }, RequestId: 'mock' } }));
      return;
    }
    if (url.pathname.startsWith('/tencent')) {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const auth = req.headers['authorization'] || '';
      const action = req.headers['x-tc-action'];
      if (!auth.startsWith('TC3-HMAC-SHA256 Credential=')) {
        res.writeHead(401).end(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '缺少 TC3 签名' }, RequestId: 'mock' } }));
        return;
      }
      if (tencentKeyId(req).includes('BAD')) {
        calls.rejected++;
        res.end(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'The SecretId is not found' }, RequestId: 'mock' } }));
        return;
      }
      calls.tencent++; calls.tencentAuthOk++;
      if (action === 'DescribeInstances') {
        res.end(JSON.stringify({ Response: { RequestId: 'mock-tc', TotalCount: TENCENT_MOCK_INSTANCES.length, InstanceSet: TENCENT_MOCK_INSTANCES } }));
        return;
      }
      if (action === 'DescribeRegions') {
        res.end(JSON.stringify({ Response: { RequestId: 'mock-tc', RegionSet: [
          { Region: 'ap-guangzhou', RegionName: '广州', RegionState: 'AVAILABLE' },
          { Region: 'ap-shanghai', RegionName: '上海', RegionState: 'AVAILABLE' },
        ] } }));
        return;
      }
      res.end(JSON.stringify({ Response: { Error: { Code: 'InvalidAction', Message: 'unknown action ' + action }, RequestId: 'mock' } }));
      return;
    }
    if (url.pathname.startsWith('/lighthouse')) {
      const auth = req.headers['authorization'] || '';
      const action = req.headers['x-tc-action'];
      if (!auth.startsWith('TC3-HMAC-SHA256 Credential=')) {
        res.writeHead(401).end(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '缺少 TC3 签名' }, RequestId: 'mock' } }));
        return;
      }
      calls.tencent++; calls.tencentAuthOk++;
      // 轻量:字段名与 CVM 不同(PublicAddresses/PrivateAddresses),
      // 用于回归"轻量 IP 读成空、被过滤"的缺陷。
      if (action === 'DescribeInstances') {
        res.end(JSON.stringify({ Response: { RequestId: 'mock-lh', TotalCount: 1, InstanceSet: [
          {
            InstanceId: 'lhins-e2e-1', InstanceName: 'e2e-lh-1', InstanceState: 'RUNNING',
            PublicAddresses: ['203.0.113.30'], PrivateAddresses: ['10.0.0.30'], OsName: 'OpenCloudOS 9',
          },
        ] } }));
        return;
      }
      if (action === 'DescribeRegions') {
        res.end(JSON.stringify({ Response: { RequestId: 'mock-lh', RegionSet: [
          { Region: 'ap-guangzhou', RegionName: '广州', RegionState: 'AVAILABLE' },
        ] } }));
        return;
      }
      res.end(JSON.stringify({ Response: { Error: { Code: 'InvalidAction', Message: 'unknown action ' + action }, RequestId: 'mock' } }));
      return;
    }
    if (url.pathname.startsWith('/aliyun')) {
      const q = url.searchParams;
      if (!q.get('Signature') || !q.get('SignatureMethod')) {
        res.writeHead(401).end(JSON.stringify({ Code: 'MissingSignature', Message: '缺少签名参数' }));
        return;
      }
      if (String(q.get('AccessKeyId') || '').includes('BAD')) {
        calls.rejected++;
        res.end(JSON.stringify({ Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified Access Key ID not found.' }));
        return;
      }
      calls.aliyun++; calls.aliyunAuthOk++;
      if (q.get('Action') === 'DescribeInstances') {
        res.end(JSON.stringify({ RequestId: 'mock-aliyun', TotalCount: ALIYUN_MOCK_INSTANCES.length, Instances: { Instance: ALIYUN_MOCK_INSTANCES } }));
        return;
      }
      if (q.get('Action') === 'DescribeRegions') {
        res.end(JSON.stringify({ RequestId: 'mock-aliyun', Regions: { Region: [
          { RegionId: 'cn-hangzhou', LocalName: '华东 1 (杭州)' },
          { RegionId: 'cn-shanghai', LocalName: '华东 2 (上海)' },
        ] } }));
        return;
      }
      res.end(JSON.stringify({ Code: 'InvalidAction', Message: 'unknown action' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, calls, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// Closed blocks arrive before DONE, so E2E can inspect the actual streaming UI.
// Expectations are fixture data, not imports of the production classifier.
export const AI_COMMAND_BLOCKS = [
  { language: 'bash', text: 'nebula-probe', shell: true, eligible: true },
  { language: 'sh', text: 'whoami\nnebula-probe', shell: true, eligible: true },
  { language: 'python', text: 'print("nebula-probe")', shell: false, eligible: false },
  { language: '', text: 'nebula-probe', shell: false, eligible: false },
  { language: 'console', text: '$ nebula-probe', shell: false, eligible: false },
  { language: 'bash', text: 'ssh <HOST>', shell: true, eligible: true, warning: { token: '<HOST>', reason: '需要用户填写的示例参数' } },
  { language: 'shell', text: '$ nebula-probe', shell: true, eligible: false, reason: '提示符' },
  { language: 'zsh', text: 'rm -rf /tmp/nebula-ai-e2e-only', shell: true, eligible: true },
  { language: 'bash', text: '', shell: true, eligible: false, reason: '为空' },
  { language: 'bash', text: "printf '<%s>\\n' 'left\tright'", shell: true, eligible: true },
  // User's original command: backslash-t is literal shell/template text, not a TAB key.
  { language: 'bash', text: "docker ps --format 'table {{.Names}}\\t{{.ID}}\\t{{.Ports}}'", shell: true, eligible: true },
  { language: 'shell', text: 'nebula-probe', shell: true, eligible: false, reason: '尚未闭合', closed: false },
];

export async function startMockAiServer() {
  const calls = { openai: 0, anthropic: 0, models: 0 };
  // 场景参数由测试写入（如测试自己启动的进程 PID），工具场景按它生成命令。
  const vars = {};
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 模型列表端点（dsh 式快速配置）：OpenAI 兼容用 Bearer，Anthropic 用 x-api-key
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      const hasKey = !!(req.headers['authorization'] || req.headers['x-api-key']);
      if (!hasKey) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing api key' } }));
        return;
      }
      calls.models++;
      res.writeHead(200, { 'content-type': 'application/json' });
      // 带属性:前端要展示"名称 + 属性(归属方/日期)",给齐以便断言
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'mock-model-1', owned_by: 'mock-provider', created: 1767312000 },
        { id: 'mock-model-2', owned_by: 'mock-provider', created: 1767312000 },
        { id: 'mock-model-3', owned_by: 'mock-provider', created: 1767312000 },
      ] }));
      return;
    }
    // 挂起端点:收了请求就只发响应头、永不吐数据,把"等待首个 token"固定住
    if (req.method === 'POST' && url.pathname.includes('/hold')) {
      calls.openai++;
      await readBody(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      return;
    }
    // AI 主机工具:/tools/<场景>/... 按对话进度返回真实 SSE 工具调用(参数分两片下发)。
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions') && url.pathname.startsWith('/tools')) {
      calls.openai++;
      const body = JSON.parse((await readBody(req)) || '{}');
      calls.toolRequests = calls.toolRequests || [];
      calls.toolRequests.push(body);
      const reply = toolScenario(url.pathname.split('/')[2], body, vars);
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const write = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (reply.text) write({ choices: [{ delta: { role: 'assistant', content: reply.text } }] });
      (reply.calls || []).forEach((c, index) => {
        const args = JSON.stringify(c.args);
        const cut = Math.floor(args.length / 2);
        write({ choices: [{ delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: args.slice(0, cut) } }] } }] });
        write({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(cut) } }] } }] });
      });
      write({ choices: [{ delta: {}, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // Command fixtures use real SSE/IPC, never inject assistant DOM or ai:done.
    // /commands/incomplete closes HTTP without DONE to exercise the completion gate.
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions') && url.pathname.startsWith('/commands')) {
      calls.openai++;
      await readBody(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const delta = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      delta('AI-COMMANDS-BEGIN\n\n```bash\nnebula-probe\n```\n');
      // Hold a fully closed, otherwise eligible shell block in streaming state.
      await sleep(1800);
      if (res.destroyed) return;
      delta('\n' + AI_COMMAND_BLOCKS.slice(1).map((block) =>
        '```' + block.language + '\n' + block.text + (block.closed === false ? '' : '\n```'),
      ).join('\n\n'));
      await sleep(450);
      if (res.destroyed) return;
      if (!url.pathname.includes('/incomplete')) {
        const finishReason = url.pathname.includes('/length') ? 'length' : 'stop';
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }
    // 慢速端点:先压 1.5s 再吐首个 token,此后按 300ms 间隔分段吐完
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions') && url.pathname.startsWith('/slow')) {
      calls.openai++;
      await readBody(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      await sleep(1500);
      for (const p of ['SLOW-REPLY:', ' 首段', ' 次段']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        await sleep(300);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 长回复端点:120 段按 60ms 逐段流式(约 7 秒),把消息区撑出滚动条,
    // 供"贴底跟随 / 回到底部按钮"用例断言。客户端断开时停止推流。
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions') && url.pathname.startsWith('/long')) {
      calls.openai++;
      await readBody(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const paras = Array.from({ length: 120 }, (_, i) => `长回复第${i + 1}段：用于撑高消息区域的流式内容。`);
      let i = 0;
      const timer = setInterval(() => {
        if (i >= paras.length) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: paras[i] + '\n\n' } }] })}\n\n`);
        i += 1;
      }, 60);
      res.on('close', () => clearInterval(timer));
      return;
    }
    // 逐字节发送含中文的 SSE 回复:强制多字节字符跨 chunk 边界,
    // 回归"from_utf8_lossy 逐 chunk 转换把汉字切坏"(表现为回答里出现 �)
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions') && url.pathname.startsWith('/utf8split')) {
      calls.openai++;
      await readBody(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '中文测试-要知' } }] })}\n\n`;
      const bytes = Buffer.from(sse, 'utf8');
      let bi = 0;
      const step = () => {
        if (bi >= bytes.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
        res.write(bytes.subarray(bi, bi + 1));
        bi += 1;
        setTimeout(step, 5);
      };
      step();
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions') && !url.pathname.startsWith('/err')) {
      calls.openai++;
      const body = JSON.parse(await readBody(req));
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const parts = ['MOCK-REPLY:', '收到「', String(lastUser ? lastUser.content : '').slice(0, 60), '」', '（openai-mock）'];
      for (const p of parts) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        await sleep(20);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
      calls.anthropic++;
      const body = JSON.parse(await readBody(req));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const first = (body.messages && body.messages[0] && body.messages[0].content) || '';
      const events = [
        ['message_start', { type: 'message_start' }],
        ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ANTHROPIC-MOCK-REPLY:' } }],
        ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: ' first=' + String(first).slice(0, 30) } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      for (const [name, data] of events) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        await sleep(15);
      }
      res.end();
      return;
    }
    // 错误路径：用于验证 HTTP 错误透出
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'auth_error' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, calls, vars, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
