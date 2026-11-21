import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiTarget } from '../src/shared/ai-target-state.js';

test('会话主机范围（scope）：与活动窗口解耦，单主机在终端断开后保留在 scope 内且状态变为 warn', () => {
  const hosts = [{ id: 'host-1', name: 'prod-server', host: '10.0.0.1' }];
  const activeSess = {
    sessionId: 'sess-1',
    status: 'connected',
    host: hosts[0],
  };
  const sessions = new Map([['sess-1', activeSess]]);
  const thread = { scope: ['host-1'] };

  // 1. 终端已连接
  const target1 = resolveAiTarget({ thread, sessions, hosts });
  assert.equal(target1.kind, 'single');
  assert.equal(target1.hostSummary, 'prod-server');
  assert.equal(target1.tone, 'connected');
  assert.equal(target1.showModeControl, true);

  // 2. 终端断开后：scope 保持不变（不自动清空），状态变为 warn
  activeSess.status = 'disconnected';
  const target2 = resolveAiTarget({ thread, sessions, hosts });
  assert.equal(target2.kind, 'single');
  assert.equal(target2.hostSummary, 'prod-server');
  assert.equal(target2.tone, 'warn');
  assert.equal(target2.statusText, '未连接');
});

test('未勾选任何主机（scope 为空）时显示「未选主机」并隐藏档位控制（纯对话）', () => {
  const thread = { scope: [] };
  const target = resolveAiTarget({ thread, sessions: new Map(), hosts: [] });
  assert.equal(target.kind, 'chat');
  assert.equal(target.hostSummary, '未选主机');
  assert.equal(target.chatLabel, '纯对话');
  assert.equal(target.showModeControl, false);
  assert.equal(target.tone, 'idle');
});
