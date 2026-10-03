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
  return { port, calls, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
