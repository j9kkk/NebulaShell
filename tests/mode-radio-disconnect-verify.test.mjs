import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiTarget } from '../src/shared/ai-target-state.js';

test('跟随模式下:活动窗口断开后 AI 目标立即变为「未链接主机」且状态为 idle', () => {
  const activeSess = {
    sessionId: 'sess-1',
    status: 'connected',
    host: { id: 'host-1', name: 'prod-server' },
  };
  const sessions = new Map([['sess-1', activeSess]]);
  const thread = { linkMode: 'follow', hostId: 'host-1' };

  // 1. 窗口连接状态
  const target1 = resolveAiTarget({ thread, sessions, activeId: 'sess-1' });
  assert.equal(target1.kind, 'bound');
  assert.equal(target1.hostSummary, '已链接 prod-server');
  assert.equal(target1.tone, 'connected');

  // 2. 窗口断开后 (status 变为 disconnected)
  activeSess.status = 'disconnected';
  const target2 = resolveAiTarget({ thread, sessions, activeId: 'sess-1' });
  assert.equal(target2.kind, 'none');
  assert.equal(target2.hostSummary, '未链接主机');
  assert.equal(target2.tone, 'idle');
  assert.equal(target2.displayName, '未链接主机');

  // 3. 窗口关闭后 (activeId 为 null, sessions 清空)
  sessions.delete('sess-1');
  const target3 = resolveAiTarget({ thread, sessions, activeId: null });
  assert.equal(target3.kind, 'none');
  assert.equal(target3.hostSummary, '未链接主机');
  assert.equal(target3.tone, 'idle');
});

test('多主机模式下:未勾选任何主机时显示「未链接主机」', () => {
  const thread = { linkMode: 'multi' };
  const target = resolveAiTarget({ thread, sessions: new Map(), links: [] });
  assert.equal(target.kind, 'none');
  assert.equal(target.hostSummary, '未链接主机');
  assert.equal(target.tone, 'idle');
});
