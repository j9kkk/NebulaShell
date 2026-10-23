import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_THRESHOLD,
  COMPACT_KEEP_TURNS,
  SUMMARY_PREFIX,
  groupTurns,
  shouldCompact,
  planCompaction,
  flattenForSummary,
  chunkForSummary,
  buildSummaryMessages,
  applyCompaction,
} from '../src/shared/ai-compact.js';

test('groupTurns splits on user messages and keeps tool pairs inside a turn', () => {
  const history = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'exec', arguments: '{}' }] },
    { role: 'tool', content: 'out1' },
    { role: 'assistant', content: 'done1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'done2' },
  ];
  const turns = groupTurns(history);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].length, 4);
  assert.equal(turns[1].length, 2);
  // 工具调用与结果同属第一回合,不会被切开
  assert.equal(turns[0][1].toolCalls[0].id, 'c1');
  assert.equal(turns[0][2].role, 'tool');
});

test('shouldCompact triggers at the threshold of the usable window and never without a limit', () => {
  // 窗口 10000,输出预留 2000 → 可用 8000;96% = 7680
  assert.equal(shouldCompact({ historyTokens: 7679, contextLimit: 10000, reserveTokens: 2000 }), false);
  assert.equal(shouldCompact({ historyTokens: 7680, contextLimit: 10000, reserveTokens: 2000 }), true);
  // 输出预留吃掉全部可用窗口时不触发(无从判断)
  assert.equal(shouldCompact({ historyTokens: 9999, contextLimit: 10000, reserveTokens: 10000 }), false);
  // 没有配置窗口不触发
  assert.equal(shouldCompact({ historyTokens: 999999, contextLimit: 0 }), false);
  // 阈值可覆盖
  assert.equal(shouldCompact({ historyTokens: 8000, contextLimit: 10000, threshold: 0.8 }), true);
  assert.equal(COMPACT_THRESHOLD, 0.96);
});

test('planCompaction drops old turns, keeps recent ones whole and reports token split', () => {
  const history = [];
  for (let i = 1; i <= 5; i++) {
    history.push({ role: 'user', content: `u${i}` });
    history.push({ role: 'assistant', content: `a${i}` });
  }
  const plan = planCompaction(history);
  assert.ok(plan);
  assert.equal(plan.droppedTurns, 5 - COMPACT_KEEP_TURNS);
  assert.equal(plan.keptMessages.length, COMPACT_KEEP_TURNS * 2);
  assert.equal(plan.keptMessages.at(-1).content, 'a5');
  assert.ok(plan.droppedTokens > 0 && plan.keptTokens > 0);
});

test('planCompaction returns null when there is nothing old enough to compress', () => {
  assert.equal(planCompaction([]), null);
  assert.equal(planCompaction([{ role: 'user', content: 'only' }]), null);
  const twoTurns = [
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
  ];
  assert.equal(planCompaction(twoTurns), null);
});

test('flattenForSummary labels roles, inlines tool calls and truncates oversized output', () => {
  const text = flattenForSummary([
    { role: 'user', content: '检查磁盘' },
    { role: 'assistant', content: '', toolCalls: [{ name: 'exec', arguments: '{"cmd":"df -h"}' }] },
    { role: 'tool', name: 'exec', content: 'x'.repeat(10000) },
  ], { maxCharsPerMessage: 1000 });
  assert.match(text, /用户: 检查磁盘/);
  assert.match(text, /\[调用工具\] exec/);
  assert.match(text, /中间省略/);
  assert.ok(text.length < 10000);
});

test('chunkForSummary splits oversized history into multiple chunks', () => {
  const messages = [];
  for (let i = 0; i < 10; i++) messages.push({ role: 'user', content: 'x'.repeat(4000) });
  const chunks = chunkForSummary(messages, { maxChars: 8000 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length > 0);
});

test('buildSummaryMessages carries the previous summary forward on rolling compaction', () => {
  const first = buildSummaryMessages('对话记录 A');
  assert.equal(first[0].role, 'system');
  assert.match(first[1].content, /对话记录 A/);
  assert.doesNotMatch(first[1].content, /已有摘要/);

  const second = buildSummaryMessages('对话记录 B', '旧摘要内容');
  assert.match(second[1].content, /已有摘要[\s\S]*旧摘要内容/);
  assert.match(second[1].content, /对话记录 B/);
});

test('applyCompaction puts summary first as a user message and keeps recent turns', () => {
  const plan = planCompaction([
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' },
  ]);
  const next = applyCompaction(plan, '  摘要正文  ');
  assert.equal(next[0].role, 'user');
  assert.ok(next[0].content.startsWith(SUMMARY_PREFIX));
  assert.match(next[0].content, /摘要正文/);
  // 保留的最近轮次原样跟在后面
  assert.deepEqual(next.slice(1).map((m) => m.content), ['u2', 'a2', 'u3', 'a3']);
  // 空摘要不产生破坏性结果
  assert.equal(applyCompaction(plan, '   '), null);
  assert.equal(applyCompaction(null, '摘要'), null);
});

test('applyCompaction copies kept messages rather than aliasing the live history', () => {
  const history = [
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' },
  ];
  const plan = planCompaction(history);
  const next = applyCompaction(plan, '摘要');
  next[1].content = 'mutated';
  assert.equal(history.at(-4).content, 'u2');
});
