import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostKeyOf,
  hostLabelOf,
  toolSupportKey,
  isModelToolsCapable,
  modelToolsCapable,
  rebindThread,
  resolveAiTarget,
  threadLinkMode,
  threadExecMode,
  hostSummaryOf,
  setLinkMode,
  clearTargetGrants,
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

test('threadLinkMode: reads linkMode, migrates legacy execMode=chat, defaults to follow', () => {
  assert.equal(threadLinkMode(null), 'follow');
  assert.equal(threadLinkMode({}), 'follow');
  assert.equal(threadLinkMode({ linkMode: 'multi' }), 'multi');
  assert.equal(threadLinkMode({ linkMode: 'chat' }), 'chat');
  // v1 遗留:chat 曾执行档位
  assert.equal(threadLinkMode({ execMode: 'chat' }), 'chat');
  assert.equal(threadLinkMode({ execMode: 'auto' }), 'follow');
  // linkMode 优先于遗留 execMode
  assert.equal(threadLinkMode({ linkMode: 'follow', execMode: 'chat' }), 'follow');
});

test('threadExecMode: only manual/auto, chat collapses to manual', () => {
  assert.equal(threadExecMode({ execMode: 'auto' }), 'auto');
  assert.equal(threadExecMode({ execMode: 'manual' }), 'manual');
  assert.equal(threadExecMode({ execMode: 'chat' }), 'manual');
  assert.equal(threadExecMode(null), 'manual');
});

test('hostSummaryOf produces the three required copy variants', () => {
  assert.equal(hostSummaryOf({ linkMode: 'chat' }), '未链接主机');
  assert.equal(hostSummaryOf({ linkMode: 'follow', hostLabel: 'web-01' }), '已链接 web-01');
  assert.equal(hostSummaryOf({ linkMode: 'follow', hostLabel: null }), '未链接主机');
  assert.equal(hostSummaryOf({ linkMode: 'multi', linkedCount: 3 }), '已链接 3 台主机');
  assert.equal(hostSummaryOf({ linkMode: 'multi', linkedCount: 0 }), '未链接主机');
});

test('setLinkMode: entering chat clears grants and drops execMode descoping', () => {
  const thread = {
    linkMode: 'follow',
    execMode: 'auto',
    autoAcked: true,
    allowlist: [{ rule: 'exec', key: 'ls' }],
    taint: ['/tmp/x'],
    hostOs: 'linux',
    sendBlocked: { text: 'hi' },
  };
  setLinkMode(thread, 'chat');
  assert.equal(thread.linkMode, 'chat');
  assert.equal(thread.execMode, 'manual', 'chat 不是执行档位,执行语义回手动');
  assert.equal(thread.autoAcked, false);
  assert.deepEqual(thread.allowlist, []);
  assert.deepEqual(thread.taint, []);
  assert.equal(thread.hostOs, null);
  assert.equal(thread.sendBlocked, null);
});

test('setLinkMode: leaving chat restores manual and is a no-op when unchanged', () => {
  const thread = { linkMode: 'chat', execMode: 'manual', allowlist: [], taint: [] };
  setLinkMode(thread, 'multi');
  assert.equal(thread.linkMode, 'multi');
  assert.equal(thread.execMode, 'manual');

  const same = { linkMode: 'multi', execMode: 'auto', allowlist: [{ rule: 'a', key: 'b' }] };
  setLinkMode(same, 'multi');
  assert.equal(same.execMode, 'auto', '同模式不变更授权');
  assert.equal(same.allowlist.length, 1);
});

test('rebindThread revokes grants and downgrades auto mode when switching hosts', () => {
  const thread = {
    hostId: 'host-a',
    hostName: 'Host A',
    sessionId: 'sess-a',
    execMode: 'auto',
    autoAcked: true,
    allowlist: [{ rule: 'exec', key: 'ls' }],
    taint: ['/tmp/secret'],
    hostOs: 'linux',
    sendBlocked: { text: 'hello' },
  };

  rebindThread(thread, { hostKey: 'host-b', hostLabel: 'Host B', sessionId: 'sess-b' });

  assert.equal(thread.hostId, 'host-b');
  assert.equal(thread.hostName, 'Host B');
  assert.equal(thread.sessionId, 'sess-b');
  assert.equal(thread.execMode, 'manual', '换主机时 auto 必须降为 manual');
  assert.equal(thread.autoAcked, false);
  assert.deepEqual(thread.allowlist, []);
  assert.deepEqual(thread.taint, []);
  assert.equal(thread.hostOs, null);
  assert.equal(thread.sendBlocked, null);
});

test('rebindThread preserves grants and mode when updating on the same host', () => {
  const thread = {
    hostId: 'host-a',
    hostName: 'Host A',
    sessionId: 'sess-old',
    execMode: 'auto',
    autoAcked: true,
    allowlist: [{ rule: 'exec', key: 'pwd' }],
    taint: ['/var/log'],
    hostOs: 'linux',
  };

  rebindThread(thread, { hostKey: 'host-a', hostLabel: 'Host A New Label', sessionId: 'sess-new' });

  assert.equal(thread.hostId, 'host-a');
  assert.equal(thread.hostName, 'Host A New Label');
  assert.equal(thread.sessionId, 'sess-new');
  assert.equal(thread.execMode, 'auto', '同一主机不降级');
  assert.equal(thread.autoAcked, true);
  assert.equal(thread.allowlist.length, 1);
  assert.equal(thread.taint.length, 1);
  assert.equal(thread.hostOs, 'linux');
});

test('resolveAiTarget: linkMode chat does not operate any host', () => {
  const thread = { linkMode: 'chat', hostId: 'host-1', hostName: 'Host 1' };
  const target = resolveAiTarget({ thread });
  assert.equal(target.kind, 'chat');
  assert.equal(target.linkMode, 'chat');
  assert.equal(target.displayName, '未链接主机');
  assert.equal(target.hostSummary, '未链接主机');
  assert.equal(target.tone, 'idle');
  assert.equal(target.statusText, '纯对话 · 不操作主机');
});

test('resolveAiTarget: legacy execMode=chat is treated as chat link mode', () => {
  const target = resolveAiTarget({ thread: { execMode: 'chat' } });
  assert.equal(target.kind, 'chat');
  assert.equal(target.linkMode, 'chat');
});

test('resolveAiTarget: follow with no active connection is none', () => {
  const thread = { linkMode: 'follow' };
  const target = resolveAiTarget({ thread, sessions: new Map(), activeId: null });
  assert.equal(target.kind, 'none');
  assert.equal(target.hostSummary, '未链接主机');
  assert.equal(target.displayName, '未链接主机');
  assert.equal(target.tone, 'idle');
  assert.equal(target.statusText, '当前窗口无主机');
});

test('resolveAiTarget: follow binds to the active command window', () => {
  const activeSess = {
    sessionId: 'sess-1',
    status: 'connected',
    host: { id: 'host-active', name: 'Active Web' },
  };
  const sessions = new Map([['sess-1', activeSess]]);
  const target = resolveAiTarget({ thread: { linkMode: 'follow' }, sessions, activeId: 'sess-1' });

  assert.equal(target.kind, 'bound');
  assert.equal(target.hostSummary, '已链接 Active Web');
  assert.equal(target.hostLabel, 'Active Web');
  assert.equal(target.tone, 'connected');
  assert.equal(target.active?.hostKey, 'host-active');
});

test('resolveAiTarget: follow with a disconnected window falls back to plain chat (none)', () => {
  const sess = {
    sessionId: 'sess-1',
    status: 'disconnected',
    host: { id: 'host-a', name: 'Host A' },
  };
  const sessions = new Map([['sess-1', sess]]);
  const target = resolveAiTarget({ thread: { linkMode: 'follow' }, sessions, activeId: 'sess-1' });
  // 没有可操作主机 → 普通对话(未链接主机),不拦截发送、不进入离线警示态。
  assert.equal(target.kind, 'none');
  assert.equal(target.hostSummary, '未链接主机');
  assert.equal(target.tone, 'idle');
});

test('resolveAiTarget: multi summarizes linked count and health', () => {
  const links = [
    { hostId: 'h1', hostKey: 'h1', hostName: 'web-01', sessionId: 's1', status: 'connected' },
    { hostId: 'h2', hostKey: 'h2', hostName: 'db-02', sessionId: 's2', status: 'connected' },
    { hostId: 'h3', hostKey: 'h3', hostName: 'cache-03', sessionId: 's3', status: 'error', error: 'auth failed' },
  ];
  const sessions = new Map([
    ['s1', { sessionId: 's1', status: 'connected', host: { id: 'h1', name: 'web-01' } }],
    ['s2', { sessionId: 's2', status: 'connected', host: { id: 'h2', name: 'db-02' } }],
  ]);
  const target = resolveAiTarget({ thread: { linkMode: 'multi' }, sessions, links, activeId: 's1' });

  assert.equal(target.kind, 'multi');
  assert.equal(target.linkMode, 'multi');
  assert.equal(target.linkedCount, 3);
  assert.equal(target.hostSummary, '已链接 3 台主机');
  assert.equal(target.tone, 'warn', '有离线主机时整体警示');
  assert.equal(target.statusText, '1 台未连接');
  assert.equal(target.session?.sessionId, 's1', '主执行会话取首台已连接');
});

test('resolveAiTarget: multi with all connected is healthy', () => {
  const links = [
    { hostId: 'h1', hostKey: 'h1', hostName: 'web-01', sessionId: 's1', status: 'connected' },
    { hostId: 'h2', hostKey: 'h2', hostName: 'db-02', sessionId: 's2', status: 'connected' },
  ];
  const sessions = new Map([
    ['s1', { sessionId: 's1', status: 'connected', host: { id: 'h1', name: 'web-01' } }],
    ['s2', { sessionId: 's2', status: 'connected', host: { id: 'h2', name: 'db-02' } }],
  ]);
  const target = resolveAiTarget({ thread: { linkMode: 'multi' }, sessions, links, activeId: 's1' });
  assert.equal(target.kind, 'multi');
  assert.equal(target.tone, 'connected');
  assert.equal(target.statusText, '全部就绪');
  assert.equal(target.linkedHosts.length, 2);
});

test('resolveAiTarget: multi with zero links is none', () => {
  const target = resolveAiTarget({ thread: { linkMode: 'multi' }, links: [] });
  assert.equal(target.kind, 'none');
  assert.equal(target.hostSummary, '未链接主机');
  assert.equal(target.linkedCount, 0);
});

test('resolveAiTarget: multi with all links down is offline and blocks sends', () => {
  const links = [
    { hostId: 'h1', hostKey: 'h1', hostName: 'web-01', sessionId: 's1', status: 'error', error: 'auth failed' },
    { hostId: 'h2', hostKey: 'h2', hostName: 'db-02', sessionId: 's2', status: 'error' },
  ];
  const target = resolveAiTarget({ thread: { linkMode: 'multi' }, links });
  assert.equal(target.kind, 'offline');
  assert.equal(target.tone, 'warn');
  assert.equal(target.statusText, '全部主机未连接');
});

test('resolveAiTarget: blocked tools and denied host', () => {
  const sess = { sessionId: 'sess-1', status: 'connected', host: { id: 'host-1', name: 'Host 1' } };
  const sessions = new Map([['sess-1', sess]]);
  const thread = { linkMode: 'follow' };

  const settingsNoTools = {
    ai: { baseUrl: 'http://loc:11434', model: 'tiny', toolSupport: { 'http://loc:11434::tiny': false } },
  };
  const noTools = resolveAiTarget({ thread, sessions, activeId: 'sess-1', settings: settingsNoTools });
  assert.equal(noTools.blocked, 'tools');
  assert.equal(noTools.tone, 'warn');
  assert.equal(noTools.statusText, '模型不支持工具');

  const sessDeny = { sessionId: 'sess-2', status: 'connected', host: { id: 'host-2', name: 'Host 2', aiAccess: 'deny' } };
  const deny = resolveAiTarget({ thread, sessions: new Map([['sess-2', sessDeny]]), activeId: 'sess-2' });
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
