// scope 数据层单测：只测纯函数，不碰 DOM。
// 对应 REQUIREMENTS-v3.md 的 F1–F6 / F22 / F24 / F25。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_EMPTY_LABEL,
  allowsHost,
  defaultScopeForNewThread,
  folderOf,
  groupHostsByFolder,
  groupState,
  hostKeyOf,
  isInScope,
  mentionState,
  normalizeScope,
  resolveScopeTarget,
  scopeSummary,
  setGroup,
  snapshotRunScope,
  toggleHost,
  validateToolHost,
} from '../src/shared/ai-scope.js';

const HOSTS = [
  { id: 'h-web', name: 'web-prod-01', host: '10.0.1.11', username: 'root', group: '生产环境' },
  { id: 'h-db', name: 'db-prod-02', host: '10.0.1.25', username: 'root', group: '生产环境' },
  { id: 'h-cache', name: 'cache-redis-03', host: '10.0.1.30', username: 'root', group: '生产环境' },
  { id: 'h-mq', name: 'mq-worker-04', host: '10.0.1.41', username: 'root', group: '生产环境', aiAccess: 'deny' },
  { id: 'h-t1', name: 'staging-01', host: '10.0.2.11', username: 'deploy', group: '测试环境' },
  { id: 'h-nj', name: 'nanjing-host', host: '10.0.9.5', username: 'root', group: '客户机房-南京' },
];

test('hostKeyOf：有 id 用 id，快速连接用 user@host:port', () => {
  assert.equal(hostKeyOf(HOSTS[0]), 'h-web');
  assert.equal(hostKeyOf({ quick: true, username: 'root', host: '1.2.3.4', port: 2222 }), 'root@1.2.3.4:2222');
  assert.equal(hostKeyOf({ quick: true, username: 'root', host: '1.2.3.4' }), 'root@1.2.3.4:22');
  assert.equal(hostKeyOf(null), null);
});

test('normalizeScope：去重 + 丢弃已删除主机 + 按主机库顺序', () => {
  assert.deepEqual(normalizeScope(['h-db', 'h-web', 'h-db'], HOSTS), ['h-web', 'h-db']);
  assert.deepEqual(normalizeScope(['h-web', 'h-deleted'], HOSTS), ['h-web']);
  assert.deepEqual(normalizeScope(['h-deleted'], HOSTS), []);
  assert.deepEqual(normalizeScope(null, HOSTS), []);
});

test('toggleHost：返回新数组，不改入参', () => {
  const base = ['h-web'];
  const added = toggleHost(base, 'h-db');
  assert.deepEqual(added, ['h-web', 'h-db']);
  assert.deepEqual(base, ['h-web'], '入参不得被修改');
  assert.deepEqual(toggleHost(added, 'h-web'), ['h-db']);
  assert.deepEqual(toggleHost(base, null), ['h-web']);
});

test('setGroup：整组全选与全不选', () => {
  const keys = ['h-web', 'h-db'];
  assert.deepEqual(setGroup(['h-t1'], keys, true), ['h-t1', 'h-web', 'h-db']);
  assert.deepEqual(setGroup(['h-t1', 'h-web', 'h-db'], keys, false), ['h-t1']);
  assert.deepEqual(setGroup([], keys, false), []);
});

test('groupState：none / part / all，空组按 none', () => {
  const keys = ['h-web', 'h-db', 'h-cache'];
  assert.equal(groupState([], keys), 'none');
  assert.equal(groupState(['h-web'], keys), 'part');
  assert.equal(groupState(['h-web', 'h-t1'], keys), 'part');
  assert.equal(groupState(['h-web', 'h-db', 'h-cache'], keys), 'all');
  assert.equal(groupState(['h-web', 'h-db', 'h-cache', 'h-t1'], keys), 'all');
  assert.equal(groupState(['h-web'], []), 'none');
});

test('groupHostsByFolder：保持目录首次出现序与组内原序', () => {
  const groups = groupHostsByFolder(HOSTS);
  assert.deepEqual(groups.map((g) => g.name), ['生产环境', '测试环境', '客户机房-南京']);
  assert.deepEqual(groups[0].keys, ['h-web', 'h-db', 'h-cache', 'h-mq']);
  assert.equal(groups[0].hosts.length, 4);
});

test('folderOf：无分组回落默认目录', () => {
  assert.equal(folderOf({ name: 'x' }), '我的主机');
  assert.equal(folderOf({ name: 'x', group: '生产环境' }), '生产环境');
  assert.equal(folderOf(null), '我的主机');
});

test('scopeSummary：0 台 / 1 台 / 多台文案', () => {
  assert.equal(scopeSummary([], HOSTS).label, SCOPE_EMPTY_LABEL);
  assert.deepEqual(scopeSummary(['h-db'], HOSTS), { count: 1, label: 'db-prod-02', single: 'h-db' });
  assert.deepEqual(scopeSummary(['h-db', 'h-web'], HOSTS), { count: 2, label: '2 台可操作', single: null });
  // 主机库已没有这台时，退化显示键本身而不是空白
  assert.equal(scopeSummary(['h-gone'], HOSTS).label, 'h-gone');
});

test('defaultScopeForNewThread：快照当前终端那一台，没有活跃会话就是空', () => {
  assert.deepEqual(defaultScopeForNewThread({ activeHostKey: 'h-db' }), ['h-db']);
  assert.deepEqual(defaultScopeForNewThread({ activeHostKey: null }), []);
  assert.deepEqual(defaultScopeForNewThread(), []);
});

test('snapshotRunScope：回合快照与后续变更解耦（F22）', () => {
  const scope = ['h-web'];
  const run = snapshotRunScope(scope);
  scope.push('h-db');
  assert.deepEqual(run, ['h-web'], '回合内扩范围不得影响在跑的这一轮');
  assert.equal(allowsHost(run, 'h-db'), false);
  assert.equal(allowsHost(run, 'h-web'), true);
});

test('allowsHost：范围外一律拒绝（工具层唯一判定）', () => {
  assert.equal(allowsHost(['h-web'], 'h-db'), false);
  assert.equal(allowsHost([], 'h-web'), false);
  assert.equal(allowsHost(['h-web'], null), false);
});

test('mentionState：chip 失效是派生属性，不落库（F25）', () => {
  assert.equal(mentionState(['h-web'], 'h-web'), 'in');
  assert.equal(mentionState(['h-web'], 'h-db'), 'out');
  // 范围加回来就自动恢复"in"，说明没有把 out 写进数据
  assert.equal(mentionState(['h-web', 'h-db'], 'h-db'), 'in');
});

test('resolveScopeTarget：空范围 = 纯对话，且不显示档位控件', () => {
  const t = resolveScopeTarget({ thread: { scope: [] }, hosts: HOSTS, sessions: [] });
  assert.equal(t.kind, 'chat');
  assert.equal(t.count, 0);
  assert.equal(t.showModeControl, false);
  assert.equal(t.statusText, '纯对话 · 不操作主机');
});

test('resolveScopeTarget：单台已连接 / 未连接的文案', () => {
  const sessions = [{ status: 'connected', host: { id: 'h-db', name: 'db-prod-02' } }];
  const conn = resolveScopeTarget({ thread: { scope: ['h-db'] }, hosts: HOSTS, sessions });
  assert.equal(conn.kind, 'scoped');
  assert.equal(conn.reachable, 1);
  assert.equal(conn.statusText, '已连接');
  const off = resolveScopeTarget({ thread: { scope: ['h-web'] }, hosts: HOSTS, sessions });
  assert.equal(off.reachable, 0);
  assert.equal(off.statusText, '未连接');
});

test('resolveScopeTarget：多台部分连接要报未连通台数', () => {
  const sessions = [{ status: 'connected', host: { id: 'h-web', name: 'web-prod-01' } }];
  const t = resolveScopeTarget({ thread: { scope: ['h-web', 'h-db', 'h-cache'] }, hosts: HOSTS, sessions });
  assert.equal(t.count, 3);
  assert.equal(t.reachable, 1);
  assert.equal(t.statusText, '2 台未连接');
  assert.equal(t.showModeControl, true);
  assert.equal(t.summary.label, '3 台可操作');
});

test('resolveScopeTarget：已删除主机不参与范围（读时自愈）', () => {
  const t = resolveScopeTarget({ thread: { scope: ['h-web', 'h-gone'] }, hosts: HOSTS, sessions: [] });
  assert.deepEqual(t.scope, ['h-web']);
  assert.equal(t.count, 1);
});

test('resolveScopeTarget：统计禁止 AI 的主机（不删出范围，只报数）', () => {
  const t = resolveScopeTarget({ thread: { scope: ['h-web', 'h-mq'] }, hosts: HOSTS, sessions: [] });
  assert.equal(t.denied, 1);
  assert.equal(t.count, 2, '禁止 AI 的主机仍要在范围里，否则用户看不到它为什么没跑');
});

test('scope 挂在 thread 上：两个会话互不继承（F24）', () => {
  const a = { id: 't1', scope: ['h-web'] };
  const b = { id: 't2', scope: [] };
  assert.equal(isInScope(a.scope, 'h-web'), true);
  assert.equal(isInScope(b.scope, 'h-web'), false, '另一个会话不得继承别人的授权');
  a.scope = ['h-web', 'h-db'];
  assert.deepEqual(b.scope, [], '改一个会话的范围不得污染另一个');
});

test('toArray 兼容 Set（thread.scope 允许存 Set 的旧形态）', () => {
  assert.deepEqual(normalizeScope(new Set(['h-web', 'h-db']), HOSTS), ['h-web', 'h-db']);
  assert.equal(isInScope(new Set(['h-web']), 'h-web'), true);
});

test('validateToolHost：硬边界白名单校验（按 key / 主机名 / IP 匹配，越界与空范围均返回 out_of_scope）', () => {
  const runScope = ['h-web', 'h-db'];
  const byKey = validateToolHost({ runScope, requested: 'h-web', hosts: HOSTS });
  assert.equal(byKey.ok, true);
  assert.equal(byKey.hostKey, 'h-web');

  const byName = validateToolHost({ runScope, requested: '@db-prod-02', hosts: HOSTS });
  assert.equal(byName.ok, true);
  assert.equal(byName.hostKey, 'h-db');

  const byIp = validateToolHost({ runScope, requested: '10.0.1.25', hosts: HOSTS });
  assert.equal(byIp.ok, true);
  assert.equal(byIp.hostKey, 'h-db');

  const oob = validateToolHost({ runScope, requested: 'cache-prod-03', hosts: HOSTS });
  assert.equal(oob.ok, false);
  assert.equal(oob.code, 'out_of_scope');

  const empty = validateToolHost({ runScope: [], requested: 'h-web', hosts: HOSTS });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'out_of_scope');
});
