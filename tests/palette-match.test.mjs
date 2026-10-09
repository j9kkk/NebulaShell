// 命令面板检索与排序(纯函数)。命令数据取自 entry.js 的真实注册,
// 改名或删关键词导致常见查询搜不到时,这里会失败。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fuzzyScore, matchScore, quickTargetOf, rankItems } from '../src/shared/palette-match.js';

async function registeredCommands() {
  const entry = await readFile(new URL('../src/modules/entry.js', import.meta.url), 'utf8');
  const wiring = entry.match(/^function setupWorkspaceCommands\(\) \{[\s\S]*?^\}/m)[0];
  return wiring.split('registerCommand(').slice(1).map((chunk) => {
    const id = chunk.match(/^'([^']+)'/)[1];
    const label = chunk.match(/label: '([^']+)'/)?.[1] || chunk.match(/label: \(\) => [^']*'([^']+)'/)?.[1] || id;
    const keywords = JSON.parse((chunk.match(/keywords: (\[[^\]]*\])/)?.[1] || '[]').replace(/'/g, '"'));
    return { id, name: label, keywords: [...keywords, id] };
  });
}

const top = (query, items) => rankItems(query, items)[0]?.id;

test('常见查询:拼音首字母、英文别名、中文名都能找到分屏', async () => {
  const items = await registeredCommands();
  for (const q of ['fp', 'split', '分屏', 'FenPing']) assert.equal(top(q, items), 'pane.split', q);
});

test('更多常见查询命中预期命令', async () => {
  const items = await registeredCommands();
  const cases = {
    清屏: 'session.clear', clear: 'session.clear', qp: 'session.clear',
    重连: 'session.reconnect', reconnect: 'session.reconnect',
    广播: 'tools.broadcast', broadcast: 'tools.broadcast',
    端口: 'tools.forwards', tunnel: 'tools.forwards',
    导出: 'hosts.export', export: 'hosts.export',
    quit: 'app.quit', 退出: 'app.quit',
    设置: 'settings.terminal', preferences: 'settings.terminal',
    sftp: 'tab.file.add', 文件: 'tab.file.add',
    平铺: 'workspace.tile', 'new tab': 'tab.new', 指纹: 'settings.fingerprints',
  };
  for (const [q, id] of Object.entries(cases)) assert.equal(top(q, items), id, q);
});

test('排序:名称前缀 > 名称包含 > 关键词 > 模糊;同分保持原顺序', () => {
  const items = [
    { id: 'fuzzy', name: 'Spaced Long Item', keywords: [] },
    { id: 'keyword', name: 'Other', keywords: ['sli'] },
    { id: 'contains', name: 'Has sli inside', keywords: [] },
    { id: 'prefix', name: 'Slice', keywords: [] },
  ];
  assert.deepEqual(rankItems('sli', items).map((i) => i.id), ['prefix', 'contains', 'keyword', 'fuzzy']);
  assert.deepEqual(rankItems('', items).map((i) => i.id), items.map((i) => i.id), '空查询原样返回');
  assert.equal(matchScore('zzz', items[0]), 0);
});

test('多个词必须全部命中;不区分大小写', () => {
  const item = { name: '关闭当前窗格', keywords: ['close pane'] };
  assert.ok(matchScore('CLOSE pane', item) > 0);
  assert.equal(matchScore('close tab', item), 0);
});

test('模糊匹配:越紧凑得分越高', () => {
  assert.ok(fuzzyScore('abc', 'abc') > fuzzyScore('abc', 'a-b-c'));
  assert.equal(fuzzyScore('abd', 'abc'), 0);
  assert.equal(fuzzyScore('', 'abc'), 0);
});

test('快速连接目标必须带 user@,端口合法', () => {
  assert.deepEqual(quickTargetOf('root@10.0.0.8:2222'), { username: 'root', host: '10.0.0.8', port: 2222 });
  assert.deepEqual(quickTargetOf(' deploy@example.com '), { username: 'deploy', host: 'example.com', port: 22 });
  assert.equal(quickTargetOf('example.com'), null, '不带 user@ 不出现快速连接(否则每个检索词都会冒出来)');
  assert.equal(quickTargetOf('root@host:70000'), null);
  assert.equal(quickTargetOf('分屏'), null);
});
