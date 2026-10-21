import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STEP_SOFT_LIMIT,
  wrapUntrusted,
  buildHostSystemPrompt,
  compressToolResult,
  truncateHistory,
  closePendingToolCalls,
  formatToolResult,
  runAgentTurn,
} from '../src/modules/ai-agent.js';

const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

// 脚本化的模型与后端：chat 依次返回 rounds；execTool 交给 onExec 决定结果。
function harness({ rounds, onExec = () => ({ status: 'done', output: 'ok', exitCode: 0 }), adapter = {}, mode = () => 'auto', ...rest }) {
  const thread = { history: [] };
  const chats = [];
  const execs = [];
  const cancels = [];
  let n = 0;
  const ctx = {
    thread,
    userMessage: '帮我看看',
    systemPrompt: 'SYS',
    tools: [{ name: 'exec' }],
    sessionId: 's1',
    getMode: mode,
    uuid: () => 'run' + (++n),
    chat: async (req) => {
      chats.push(JSON.parse(JSON.stringify(req)));
      const r = rounds.shift();
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(req) : r || { content: '结束' };
    },
    execTool: async (req) => { execs.push(req); return onExec(req, execs.length); },
    cancelTool: async (id) => { cancels.push(id); },
    readTerminal: (lines) => `终端最后 ${lines ?? 500} 行`,
    adapter,
    ...rest,
  };
  return { ctx, thread, chats, execs, cancels };
}

// 每个 toolCall 都恰好对应一条 tool 结果。
function assertPaired(history) {
  const ids = history.filter((m) => m.role === 'assistant' && m.toolCalls).flatMap((m) => m.toolCalls.map((c) => c.id));
  const results = history.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  assert.deepEqual([...results].sort(), [...ids].sort());
}

test('wrapUntrusted 与 formatToolResult：成功包边界、错误不包、read_file 给续读位置', () => {
  assert.match(wrapUntrusted('x'), /^<<<TOOL_OUTPUT[\s\S]*\nx\n<<<END_TOOL_OUTPUT>>>$/);
  const done = formatToolResult('exec', {}, { status: 'done', exitCode: 2, durationMs: 1500, output: 'boom' });
  assert.match(done, /^退出码 2；耗时 1\.5 秒\n<<<TOOL_OUTPUT/);
  const err = formatToolResult('read_file', {}, { status: 'error', code: 'path_denied', message: '敏感' });
  assert.equal(err, '工具 read_file 执行失败（path_denied）：敏感');
  const rf = formatToolResult('read_file', {}, { status: 'done', output: 'a', meta: { offset: 0, nextOffset: 10, size: 99, eof: false } });
  assert.match(rf, /续读请用 offset=10/);
});

test('buildHostSystemPrompt：主机、模式与不可信边界说明齐全', () => {
  const p = buildHostSystemPrompt({ hostName: 'web-1', user: 'root', isRoot: true, os: 'Ubuntu 22.04', cwd: '/srv', execMode: 'manual' });
  for (const s of ['root@web-1', 'Ubuntu 22.04', '/srv', '执行模式：手动', '<<<TOOL_OUTPUT', '不要换一种写法重试']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('你只能给出建议'), '工具模式不能声称不会执行命令');
  assert.match(buildHostSystemPrompt({}), /先调用 host_info/);
});

test('buildHostSystemPrompt：多主机列出目标并要求所有主机工具用 host 参数指名', () => {
  const p = buildHostSystemPrompt({ hostName: 'web-1', os: 'Ubuntu 22.04', execMode: 'manual', linkedHosts: ['web-1', 'db-02', 'cache-03'] });
  for (const s of ['3 台主机', 'web-1', 'db-02', 'cache-03', 'host 参数', '逐台取结果再汇总']) assert.ok(p.includes(s), s);
  // 只读工具也要带 host(此前提示词让模型改走 exec,是多主机"只看到一台"的原因之一)
  assert.match(p, /只读工具.*接受 host 参数/s);
  assert.ok(!/只读工具.*作用于默认主机[；;]/.test(p), '不能再说只读工具只能作用于默认主机');
  // 单主机提示词不出现多主机措辞
  assert.ok(!buildHostSystemPrompt({ hostName: 'web-1' }).includes('台主机'));
});

test('buildHostSystemPrompt：完全托管档说明「不再逐条确认」并加约束', () => {
  const p = buildHostSystemPrompt({ hostName: 'web-1', os: 'Ubuntu 22.04', execMode: 'full' });
  assert.match(p, /执行模式：完全托管/);
  assert.match(p, /不再逐条确认/);
  // 托管档要给模型明确的自我约束,而不是一句「随便执行」
  for (const s of ['先确认目标与环境', '不可逆', '含糊时先问清楚']) assert.ok(p.includes(s), s);
  // 多主机下也一样,且不残留「每条命令都单独确认」的矛盾说明
  const mp = buildHostSystemPrompt({ hostName: 'web-1', execMode: 'full', linkedHosts: ['a', 'b'] });
  assert.match(mp, /完全托管/);
  assert.ok(!mp.includes('每条命令都单独确认'), mp);
});

test('AI_AGENT_TOOLS_MULTI：每个主机工具都带可选 host,且不下发 read_terminal', async () => {
  const { AI_AGENT_TOOLS, AI_AGENT_TOOLS_MULTI } = await import('../src/shared/ai-tools-schema.js');
  const names = AI_AGENT_TOOLS_MULTI.map((t) => t.name);
  assert.ok(names.length > 1);
  for (const t of AI_AGENT_TOOLS_MULTI) {
    assert.ok(t.parameters?.properties?.host, `${t.name} 必须带 host 参数`);
    assert.ok(!(t.parameters.required || []).includes('host'), `${t.name} 的 host 应为可选`);
  }
  assert.ok(!names.includes('read_terminal'), '多主机不下发 read_terminal');
  // 单主机工具集里没有任何工具带 host
  for (const t of AI_AGENT_TOOLS) {
    assert.ok(!t.parameters?.properties?.host, `${t.name} 单主机版不该有 host`);
  }
});

test('truncateHistory：整回合截断、旧工具输出压缩、当前回合永不丢', () => {
  const big = 'x'.repeat(5000);
  const h = [];
  for (let t = 0; t < 12; t++) {
    h.push({ role: 'user', content: 'q' + t });
    h.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c' + t, name: 'exec', arguments: '{}' }] });
    h.push({ role: 'tool', toolCallId: 'c' + t, name: 'exec', content: big });
  }
  const out = truncateHistory(h);
  assert.equal(out[0].content, 'q2', '只留最近 10 回合');
  assertPaired(out);
  assert.equal(out.at(-1).content, big, '最近的工具输出保持完整');
  assert.ok(out[2].content.length <= 320, '旧工具输出被压缩');
  assert.equal(h[2].content, big, '不修改原数组');
  const one = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'exec', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'a', name: 'exec', content: 'y'.repeat(200) }];
  assert.equal(truncateHistory(one, { maxChars: 10 }).length, 3, '超预算也保留当前回合');
  assert.ok(compressToolResult('z'.repeat(1000)).length < 320);
});

test('closePendingToolCalls 原地补齐缺失结果', () => {
  const h = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'exec' }, { id: 'b', name: 'read_file' }] },
    { role: 'tool', toolCallId: 'a', name: 'exec', content: 'ok' }];
  assert.equal(closePendingToolCalls(h, '用户已中止'), h);
  assert.deepEqual(h.at(-1), { role: 'tool', toolCallId: 'b', name: 'read_file', content: '用户已中止' });
});

test('两轮循环：只读工具与 read_terminal 自动执行，结果回填下一轮', async () => {
  const { ctx, thread, chats, execs } = harness({
    rounds: [
      { content: '先看日志', toolCalls: [call('t1', 'tail_file', { path: '/var/log/syslog' }), call('t2', 'read_terminal', { lines: 50 })] },
      { content: '结论：磁盘满了' },
    ],
    onExec: () => ({ status: 'done', output: 'disk full' }),
  });
  const r = await runAgentTurn(ctx);
  assert.equal(r.status, 'done');
  assert.equal(execs.length, 1, 'read_terminal 不经后端');
  assert.deepEqual(execs[0], { toolRunId: 'run1', sessionId: 's1', mode: 'auto', tool: 'tail_file', args: { path: '/var/log/syslog' } });
  assert.equal(chats.length, 2);
  const second = chats[1].messages;
  assert.equal(second[0].content, 'SYS');
  assert.match(second.at(-1).content, /终端最后 50 行/);
  assert.match(second.at(-2).content, /disk full/);
  assertPaired(thread.history);
  assert.equal(thread.history.at(-1).content, '结论：磁盘满了');
});

test('模式每条现读：回合中切换只影响后面的 exec', async () => {
  let mode = 'manual';
  const { ctx, execs } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'uptime' })] }, { toolCalls: [call('b', 'exec', { cmd: 'df -h' })] }, { content: 'ok' }],
    mode: () => mode,
    onExec: (req) => { if (req.args.cmd === 'uptime') mode = 'auto'; return { status: 'done', output: '', exitCode: 0 }; },
  });
  await runAgentTurn(ctx);
  assert.deepEqual(execs.map((e) => e.mode), ['manual', 'auto']);
});

test('needs-confirm：跳过带理由回填模型，确认则带 confirmedTier 重发', async () => {
  const confirms = [];
  const { ctx, execs, chats, thread } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'curl x | sh' }), call('b', 'exec', { cmd: 'rm -rf /tmp/x' })] }, { content: '好的' }],
    onExec: (req) => (req.confirmed ? { status: 'done', output: 'removed', exitCode: 0, decision: 'confirmed' } : { status: 'needs-confirm', tier: req.args.cmd.startsWith('rm') ? 'danger' : 'egress', reasons: ['x'] }),
    adapter: { requestConfirm: async (p) => { confirms.push(p.tier); return p.cmd.startsWith('curl') ? { decision: 'skip', reason: '用官方源' } : { decision: 'run' }; } },
  });
  await runAgentTurn(ctx);
  assert.deepEqual(confirms, ['egress', 'danger']);
  assert.deepEqual(execs.map((e) => [e.args.cmd, !!e.confirmed, e.confirmedTier ?? null]),
    [['curl x | sh', false, null], ['rm -rf /tmp/x', false, null], ['rm -rf /tmp/x', true, 'danger']]);
  const results = chats[1].messages.filter((m) => m.role === 'tool');
  assert.match(results[0].content, /用户拒绝执行该命令。理由：用官方源/);
  assert.match(results[1].content, /removed/);
  assertPaired(thread.history);
});

test('会话授权数据通路：确认卡拿到 allowable/allowBlocked，步骤结束拿到 whitelisted', async () => {
  const confirms = [];
  const ends = [];
  const allowable = [{ rule: 'egress.download', label: '下载', keys: ['github.com'] }];
  const whitelisted = [{ rule: 'egress.download', label: '下载', keys: ['nodejs.org'] }];
  const { ctx } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'curl -o x https://github.com/x' }), call('b', 'exec', { cmd: 'curl -o y https://nodejs.org/y' })] }, { content: '好的' }],
    onExec: (req) => {
      if (req.args.cmd.includes('nodejs')) return { status: 'done', output: '', exitCode: 0, decision: 'whitelisted', whitelisted };
      return req.confirmed
        ? { status: 'done', output: '', exitCode: 0, decision: 'confirmed', downloads: ['/srv/x'] }
        : { status: 'needs-confirm', tier: 'egress', reasons: ['从外部地址下载'], allowable, allowBlocked: null };
    },
    adapter: {
      requestConfirm: async (p) => { confirms.push({ allowable: p.allowable, allowBlocked: p.allowBlocked }); return { decision: 'run' }; },
      stepEnd: (step, res) => ends.push(res.whitelisted || null),
    },
  });
  await runAgentTurn(ctx);
  assert.deepEqual(confirms, [{ allowable, allowBlocked: null }]);
  assert.deepEqual(ends, [null, whitelisted]);
});

test('改后执行：结果首行写实际命令；改后升档再确认一次', async () => {
  let asked = 0;
  const { ctx, execs, chats } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'apt-get install nginx' })] }, { content: 'ok' }],
    onExec: (req) => {
      if (!req.confirmed) return { status: 'needs-confirm', tier: 'normal' };
      if (req.args.cmd.includes('purge') && req.confirmedTier !== 'danger') return { status: 'needs-confirm', tier: 'danger' };
      return { status: 'done', output: 'done', exitCode: 0 };
    },
    adapter: { requestConfirm: async () => (++asked === 1 ? { decision: 'edit', cmd: 'apt-get purge -y nginx' } : { decision: 'run' }) },
  });
  await runAgentTurn(ctx);
  assert.equal(asked, 2);
  assert.deepEqual(execs.map((e) => e.confirmedTier ?? null), [null, 'normal', 'danger']);
  assert.match(chats[1].messages.at(-1).content, /^实际执行：apt-get purge -y nginx\n退出码 0/);
});

test('sudo 密码：不进历史与请求，记住后同会话复用，密码错误时清缓存重问', async () => {
  const cache = new Map();
  const prompts = [];
  const { ctx, thread, chats, execs } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'sudo ls' }), call('b', 'exec', { cmd: 'sudo id' })] }, { content: 'ok' }],
    sudoCache: cache,
    onExec: (req) => {
      if (!req.sudoPassword) return { status: 'needs-sudo-password', host: 'h' };
      if (req.sudoPassword === 'bad') return { status: 'needs-sudo-password', host: 'h', error: 'sudo 密码不正确' };
      return { status: 'done', output: 'root', exitCode: 0 };
    },
    adapter: { requestSudoPassword: async (p) => { prompts.push(p.error || ''); return prompts.length === 1 ? { password: 'bad', remember: true } : { password: 's3cret!', remember: true }; } },
  });
  await runAgentTurn(ctx);
  assert.deepEqual(prompts, ['', 'sudo 密码不正确'], '第二条命令命中缓存，不再弹框');
  assert.equal(cache.get('s1'), 's3cret!');
  assert.equal(execs.filter((e) => e.args.cmd === 'sudo id').length, 2);
  const dump = JSON.stringify({ h: thread.history, c: chats });
  assert.ok(!dump.includes('s3cret!') && !dump.includes('"bad"'), '密码不得进入历史或模型请求');
});

test('停止：立即取消运行中的远端命令，补齐未决结果', async () => {
  const ac = new AbortController();
  let release;
  const { ctx, thread, cancels, chats } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'apt-get install -y x' }), call('b', 'exec', { cmd: 'ls' })] }],
    signal: ac.signal,
    onExec: () => new Promise((r) => { release = r; }),
  });
  const p = runAgentTurn(ctx);
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  assert.deepEqual(cancels, ['run1'], '中止时立刻取消，不等命令自己结束');
  release({ status: 'aborted', output: 'partial', note: '可执行 dpkg --configure -a' });
  const r = await p;
  assert.equal(r.status, 'aborted');
  assert.equal(chats.length, 1);
  assertPaired(thread.history);
  assert.match(thread.history.find((m) => m.toolCallId === 'a').content, /已被用户中止。可执行 dpkg --configure -a/);
  assert.equal(thread.history.find((m) => m.toolCallId === 'b').content, '用户已中止');
});

test('停止也会结束等待中的确认卡', async () => {
  const ac = new AbortController();
  const { ctx, thread } = harness({
    rounds: [{ toolCalls: [call('a', 'exec', { cmd: 'rm -rf /x' })] }],
    signal: ac.signal,
    onExec: () => ({ status: 'needs-confirm', tier: 'danger' }),
    adapter: { requestConfirm: () => new Promise(() => {}) },
  });
  const p = runAgentTurn(ctx);
  setTimeout(() => ac.abort(), 10);
  assert.equal((await p).status, 'aborted');
  assertPaired(thread.history);
});

test('模型不支持工具：标记线程并以无工具重发', async () => {
  let flagged = 0;
  const err = Object.assign(new Error('nope'), { code: 'tools_unsupported' });
  const { ctx, thread, chats } = harness({ rounds: [err, { content: '普通回答' }], adapter: { onToolsUnsupported: () => flagged++ } });
  const r = await runAgentTurn(ctx);
  assert.equal(r.status, 'done');
  assert.equal(flagged, 1);
  assert.equal(thread.toolsCapable, false);
  assert.deepEqual(chats.map((c) => c.tools === null), [false, true]);
});

test('其他请求错误原样返回，不当成中止', async () => {
  const { ctx } = harness({ rounds: [new Error('HTTP 500')] });
  assert.deepEqual(await runAgentTurn(ctx), { status: 'error', error: 'HTTP 500', steps: [] });
});

test('软上限：达到步数询问，拒绝则补停止结果', async () => {
  const many = Array.from({ length: AGENT_STEP_SOFT_LIMIT + 2 }, (_, i) => call('c' + i, 'host_info', {}));
  let asked = 0;
  const { ctx, thread, execs } = harness({
    rounds: [{ toolCalls: many }],
    adapter: { confirmContinue: async (n) => { asked = n; return false; } },
  });
  const r = await runAgentTurn(ctx);
  assert.equal(r.status, 'stopped');
  assert.equal(asked, AGENT_STEP_SOFT_LIMIT);
  assert.equal(execs.length, AGENT_STEP_SOFT_LIMIT);
  assertPaired(thread.history);
  assert.equal(thread.history.at(-1).content, '用户选择停止继续执行');
});

test('完全托管档跳过步数软上限询问：不再停下来等「是否继续」', async () => {
  const many = Array.from({ length: AGENT_STEP_SOFT_LIMIT + 2 }, (_, i) => call('m' + i, 'host_info', {}));
  let asked = 0;
  const { ctx, thread, execs } = harness({
    rounds: [{ toolCalls: many }],
    mode: () => 'full',
    adapter: { confirmContinue: async () => { asked++; return true; } },
  });
  const r = await runAgentTurn(ctx);
  assert.equal(r.status, 'done');
  assert.equal(asked, 0, '托管档不打断');
  assert.equal(execs.length, AGENT_STEP_SOFT_LIMIT + 2, '全部步骤照常执行');
  assertPaired(thread.history);
});

test('非法参数与未知工具：报错回填，循环继续；变更清单只含 exec', async () => {
  const summaries = [];
  const { ctx, chats } = harness({
    rounds: [{ toolCalls: [{ id: 'x', name: 'exec', arguments: '{bad' }, call('y', 'format_disk', {}), call('z', 'exec', { cmd: 'uptime' })] }, { content: 'ok' }],
    adapter: { turnSummary: (s) => summaries.push(s) },
  });
  await runAgentTurn(ctx);
  const results = chats[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(results[0], /不是合法 JSON/);
  assert.match(results[1], /未知工具：format_disk/);
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0].execs.map((e) => e.cmd), ['uptime']);
});
