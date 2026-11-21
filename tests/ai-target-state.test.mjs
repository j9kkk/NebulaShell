import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostKeyOf,
  hostLabelOf,
  toolSupportKey,
  isModelToolsCapable,
  modelToolsCapable,
  resolveAiTarget,
  threadScope,
  threadExecMode,
  hostSummaryOf,
  setThreadScope,
  clearTargetGrants,
  isFullExecMode,
} from '../src/shared/ai-target-state.js';

test('hostKeyOf and hostLabelOf correctly identify hosts', () => {
  assert.equal(hostKeyOf(null), null);
  assert.equal(hostLabelOf(null), null);

  const savedHost = { id: 'host-123', name: 'Web Prod', host: '10.0.0.1', port: 22 };
  assert.equal(hostKeyOf(savedHost), 'host-123');
  assert.equal(hostLabelOf(savedHost), 'Web Prod');

  const quickHost = { quick: true, username: 'root', host: '192.168.1.10', port: 2222 };
  assert.equal(hostKeyOf(quickHost), 'root@192.168.1.10:2222');
  assert.equal(hostLabelOf(quickHost), '192.168.1.10');

  const fallbackHost = { quick: true, ip: '10.1.1.1' };
  assert.equal(hostKeyOf(fallbackHost), '@10.1.1.1:22');
  assert.equal(hostLabelOf(fallbackHost), '10.1.1.1');
});

test('modelToolsCapable evaluates baseUrl::model toolSupport correctly', () => {
  const settings = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    toolSupport: {
      'https://api.openai.com/v1::gpt-4o': true,
      'https://api.openai.com/v1::legacy-chat': false,
    },
  };

  assert.equal(toolSupportKey(settings), 'https://api.openai.com/v1::gpt-4o');
  assert.equal(isModelToolsCapable(settings), true);

  const disabled = {
    baseUrl: 'https://api.openai.com/v1',
    model: 'legacy-chat',
    toolSupport: settings.toolSupport,
  };
  assert.equal(isModelToolsCapable(disabled), false);
  assert.equal(modelToolsCapable(disabled), false);

  assert.equal(isModelToolsCapable({}), true);
  assert.equal(isModelToolsCapable(null), true);
});

test('threadScope: normalizes and deduplicates thread.scope', () => {
  assert.deepEqual(threadScope(null), []);
  assert.deepEqual(threadScope({}), []);
  assert.deepEqual(threadScope({ scope: ['h1', 'h2', 'h1'] }), ['h1', 'h2']);
});

test('threadExecMode: reads manual/auto/full, chat and unknown collapse to manual', () => {
  assert.equal(threadExecMode({ execMode: 'auto' }), 'auto');
  assert.equal(threadExecMode({ execMode: 'manual' }), 'manual');
  assert.equal(threadExecMode({ execMode: 'full' }), 'full');
  assert.equal(threadExecMode({ execMode: 'chat' }), 'manual');
  assert.equal(threadExecMode({ execMode: 'whatever' }), 'manual', '未知档位必须 fail-safe 到手动');
  assert.equal(threadExecMode(null), 'manual');
});

test('isFullExecMode: only the full tier reports managed execution', () => {
  assert.equal(isFullExecMode('full'), true);
  assert.equal(isFullExecMode('auto'), false);
  assert.equal(isFullExecMode('manual'), false);
  assert.equal(isFullExecMode(undefined), false);
});

test('hostSummaryOf produces the three required scope copy variants (F1 / F6 / F7 / F8)', () => {
  const hosts = [
    { id: 'h1', name: 'web-01' },
    { id: 'h2', name: 'db-02' },
    { id: 'h3', name: 'cache-03' },
  ];
  assert.equal(hostSummaryOf({ scope: [], hosts }), '未选主机');
  assert.equal(hostSummaryOf({ scope: ['h1'], hosts }), 'web-01');
  assert.equal(hostSummaryOf({ scope: ['h1', 'h2', 'h3'], hosts }), '3 台可操作');
});

test('setThreadScope: changing scope clears grants and resets execMode to manual', () => {
  const thread = {
    scope: ['host-a'],
    execMode: 'auto',
    autoAcked: true,
    allowlist: [{ rule: 'exec', key: 'ls' }],
    taint: ['/tmp/x'],
    hostOs: 'linux',
    sendBlocked: { text: 'hi' },
  };
  const changed = setThreadScope(thread, ['host-a', 'host-b']);
  assert.equal(changed, true);
  assert.deepEqual(thread.scope, ['host-a', 'host-b']);
  assert.equal(thread.execMode, 'manual');
  assert.equal(thread.autoAcked, false);
  assert.deepEqual(thread.allowlist, []);
  assert.deepEqual(thread.taint, []);
  assert.equal(thread.hostOs, null);
  assert.equal(thread.sendBlocked, null);

  // Same scope is a no-op and preserves grants
  thread.execMode = 'full';
  thread.allowlist = [{ rule: 'exec', key: 'pwd' }];
  const same = setThreadScope(thread, ['host-a', 'host-b']);
  assert.equal(same, false);
  assert.equal(thread.execMode, 'full');
  assert.equal(thread.allowlist.length, 1);
});

test('resolveAiTarget: empty scope enters plain chat mode and hides mode control (F6)', () => {
  const thread = { scope: [] };
  const target = resolveAiTarget({ thread });
  assert.equal(target.kind, 'chat');
  assert.equal(target.count, 0);
  assert.equal(target.displayName, '未选主机');
  assert.equal(target.hostSummary, '未选主机');
  assert.equal(target.chatLabel, '纯对话');
  assert.equal(target.showModeControl, false);
  assert.equal(target.tone, 'idle');
  assert.equal(target.statusText, '纯对话');
});

test('resolveAiTarget: 1 host in scope shows host name and enables mode control (F7)', () => {
  const hosts = [{ id: 'host-1', name: 'web-prod-01', host: '10.0.1.11' }];
  const sess = {
    sessionId: 'sess-1',
    status: 'connected',
    host: hosts[0],
  };
  const sessions = new Map([['sess-1', sess]]);
  const target = resolveAiTarget({ thread: { scope: ['host-1'] }, sessions, hosts });

  assert.equal(target.kind, 'single');
  assert.equal(target.count, 1);
  assert.equal(target.hostSummary, 'web-prod-01');
  assert.equal(target.hostLabel, 'web-prod-01');
  assert.equal(target.showModeControl, true);
  assert.equal(target.tone, 'connected');
  assert.equal(target.session?.sessionId, 'sess-1');
});

test('resolveAiTarget: multi-host scope summarizes count and health (F8)', () => {
  const hosts = [
    { id: 'h1', name: 'web-01' },
    { id: 'h2', name: 'db-02' },
    { id: 'h3', name: 'cache-03' },
  ];
  const sessions = new Map([
    ['s1', { sessionId: 's1', status: 'connected', host: { id: 'h1', name: 'web-01' } }],
    ['s2', { sessionId: 's2', status: 'connected', host: { id: 'h2', name: 'db-02' } }],
  ]);
  const target = resolveAiTarget({ thread: { scope: ['h1', 'h2', 'h3'] }, sessions, hosts });

  assert.equal(target.kind, 'multi');
  assert.equal(target.count, 3);
  assert.equal(target.linkedCount, 3);
  assert.equal(target.hostSummary, '3 台可操作');
  assert.equal(target.showModeControl, true);
  assert.equal(target.tone, 'warn', '有未连接主机时提示部分连接');
  assert.equal(target.statusText, '1 台未连接');
  assert.equal(target.session?.sessionId, 's1', '主执行会话取首台已连接');
});

test('resolveAiTarget: multi-host scope with all connected is healthy', () => {
  const hosts = [
    { id: 'h1', name: 'web-01' },
    { id: 'h2', name: 'db-02' },
  ];
  const sessions = new Map([
    ['s1', { sessionId: 's1', status: 'connected', host: { id: 'h1', name: 'web-01' } }],
    ['s2', { sessionId: 's2', status: 'connected', host: { id: 'h2', name: 'db-02' } }],
  ]);
  const target = resolveAiTarget({ thread: { scope: ['h1', 'h2'] }, sessions, hosts });
  assert.equal(target.kind, 'multi');
  assert.equal(target.tone, 'connected');
  assert.equal(target.statusText, '全部就绪');
  assert.equal(target.connectedHosts.length, 2);
});

test('resolveAiTarget: blocked tools and denied host', () => {
  const hosts = [{ id: 'host-1', name: 'Host 1' }];
  const sess = { sessionId: 'sess-1', status: 'connected', host: hosts[0] };
  const sessions = new Map([['sess-1', sess]]);
  const thread = { scope: ['host-1'] };

  const settingsNoTools = {
    ai: { baseUrl: 'http://loc:11434', model: 'tiny', toolSupport: { 'http://loc:11434::tiny': false } },
  };
  const noTools = resolveAiTarget({ thread, sessions, hosts, settings: settingsNoTools });
  assert.equal(noTools.blocked, 'tools');
  assert.equal(noTools.tone, 'warn');
  assert.equal(noTools.statusText, '模型不支持工具');

  const hostsDeny = [{ id: 'host-2', name: 'Host 2', aiAccess: 'deny' }];
  const sessDeny = { sessionId: 'sess-2', status: 'connected', host: hostsDeny[0] };
  const deny = resolveAiTarget({ thread: { scope: ['host-2'] }, sessions: new Map([['sess-2', sessDeny]]), hosts: hostsDeny });
  assert.equal(deny.blocked, 'deny');
  assert.equal(deny.statusText, '主机禁止 AI');
});

test('clearTargetGrants resets every grant channel', () => {
  const thread = { autoAcked: true, allowlist: [{ rule: 'x', key: 'y' }], taint: ['/a'], hostOs: 'linux' };
  clearTargetGrants(thread);
  assert.equal(thread.autoAcked, false);
  assert.deepEqual(thread.allowlist, []);
  assert.deepEqual(thread.taint, []);
  assert.equal(thread.hostOs, null);
});
