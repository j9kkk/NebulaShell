import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferModelDefaults,
  normModel,
  estimateMessageTokens,
  formatTokenCount,
  calculateThreadContextTokens,
  trimMessagesForContext,
  resolveReasoningParams,
  reasoningLevelLabel,
} from '../src/shared/ai-context-reasoning.js';

test('inferModelDefaults generates appropriate defaults for reasoning and general models', () => {
  const o1 = inferModelDefaults('o1-mini', null, false);
  assert.equal(o1.contextWindow, 200000);
  assert.equal(o1.maxOutput, 100000);
  assert.deepEqual(o1.reasoning.levels, ['disabled', 'low', 'medium', 'high']);
  assert.equal(o1.reasoning.default, 'medium');
  assert.deepEqual(o1.reasoning.mapping.high, { reasoning_effort: 'high' });

  const r1 = inferModelDefaults('deepseek-r1-distill', null, false);
  assert.equal(r1.contextWindow, 64000);
  assert.deepEqual(r1.reasoning.levels, ['disabled', 'high']);
  assert.equal(r1.reasoning.default, 'high');

  const claude = inferModelDefaults('claude-3-7-sonnet', null, false);
  assert.deepEqual(claude.reasoning.mapping.medium, { thinking: { type: 'enabled', budget_tokens: 8192 } });

  const generic = inferModelDefaults('gpt-4o-mini', 128000, true);
  assert.equal(generic.contextWindow, 128000);
  assert.deepEqual(generic.reasoning.levels, ['disabled']);
});

test('normModel standardizes model capabilities and retains existing overrides', () => {
  const stringModel = normModel('deepseek-r1');
  assert.equal(stringModel.id, 'deepseek-r1');
  assert.equal(stringModel.reasoning.default, 'high');
  assert.equal(stringModel.autoConfig, true);

  const customModel = normModel({
    id: 'my-custom',
    name: '我的大模型',
    contextWindow: 65536,
    maxOutput: 4096,
    reasoning: {
      levels: ['disabled', 'fast', 'smart'],
      default: 'smart',
      mapping: { smart: { extra: true } },
    },
    autoConfig: false,
  });
  assert.equal(customModel.contextWindow, 65536);
  assert.equal(customModel.maxOutput, 4096);
  assert.deepEqual(customModel.reasoning.levels, ['disabled', 'fast', 'smart']);
  assert.equal(customModel.reasoning.default, 'smart');
  assert.equal(customModel.autoConfig, false);
});

test('estimateMessageTokens estimates correctly for text, reasoning and tool calls', () => {
  assert.equal(estimateMessageTokens(null), 0);
  const plainMsg = { role: 'user', content: 'hello world' }; // 11 chars -> ceil(11/3.5)+4 = 4+4 = 8
  assert.equal(estimateMessageTokens(plainMsg), 8);

  const toolMsg = {
    role: 'assistant',
    content: 'call tool',
    reasoning: 'thinking...',
    toolCalls: [{ name: 'run_cmd', arguments: '{"cmd":"ls"}' }],
  };
  const tokenCount = estimateMessageTokens(toolMsg);
  assert.ok(tokenCount > 15);
});

test('trimMessagesForContext preserves system prompt and latest user prompt, trimming older history when exceeding budget', () => {
  const systemMsg = { role: 'system', content: 'You are an AI assistant.' };
  const oldUser1 = { role: 'user', content: 'First message '.repeat(50) };
  const oldAssistant1 = { role: 'assistant', content: 'First reply '.repeat(50) };
  const oldUser2 = { role: 'user', content: 'Second message '.repeat(50) };
  const oldAssistant2 = { role: 'assistant', content: 'Second reply '.repeat(50) };
  const latestUser = { role: 'user', content: 'Latest question' };

  const fullHistory = [systemMsg, oldUser1, oldAssistant1, oldUser2, oldAssistant2, latestUser];

  // 1. 预算很大时，不裁剪
  const resUnlimited = trimMessagesForContext(fullHistory, 1000000);
  assert.equal(resUnlimited.trimmedCount, 0);
  assert.equal(resUnlimited.messages.length, 6);

  // 2. 预算受限时，优先保留较新的消息，裁剪最旧的消息
  const resLimited = trimMessagesForContext(fullHistory, 300);
  assert.ok(resLimited.trimmedCount > 0);
  assert.equal(resLimited.messages[0].role, 'system');
  assert.equal(resLimited.messages[resLimited.messages.length - 1], latestUser);
  assert.ok(resLimited.messages.length < fullHistory.length);

  // 3. 预算极小（无法容纳任何历史）时，至少保留系统消息与最新消息
  const resExtreme = trimMessagesForContext(fullHistory, 10);
  assert.equal(resExtreme.trimmedCount, 4);
  assert.deepEqual(resExtreme.messages, [systemMsg, latestUser]);
});

test('resolveReasoningParams resolves parameters per level mapping and returns null for disabled', () => {
  const model = {
    reasoning: {
      mapping: {
        low: { reasoning_effort: 'low' },
        high: { reasoning_effort: 'high' },
      },
    },
  };
  assert.equal(resolveReasoningParams(model, 'disabled'), null);
  assert.equal(resolveReasoningParams(model, 'unknown'), null);
  assert.deepEqual(resolveReasoningParams(model, 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(resolveReasoningParams(model, 'high'), { reasoning_effort: 'high' });
});

test('reasoningLevelLabel maps level keys to user-friendly Chinese labels', () => {
  assert.equal(reasoningLevelLabel('disabled'), '关闭');
  assert.equal(reasoningLevelLabel('low'), '低');
  assert.equal(reasoningLevelLabel('medium'), '中');
  assert.equal(reasoningLevelLabel('high'), '高');
  assert.equal(reasoningLevelLabel('max'), '最高');
  assert.equal(reasoningLevelLabel('custom-tag'), 'custom-tag');
});

test('formatTokenCount formats small, kilo and mega token numbers accurately', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(520), '520');
  assert.equal(formatTokenCount(1200), '1K');
  assert.equal(formatTokenCount(128000), '128K');
  assert.equal(formatTokenCount(1000000), '1M');
  assert.equal(formatTokenCount(2000000), '2M');
});

test('calculateThreadContextTokens breaks down tokens and reflects load status', () => {
  const thread = {
    history: [
      { role: 'user', content: 'What is the server load?' },
      { role: 'assistant', content: 'CPU load is around 12%.' },
    ],
    trimmedCount: 2,
  };
  const result = calculateThreadContextTokens({
    thread,
    systemPrompt: 'System instructions',
    inputDraft: 'Show me top processes',
    contextLimit: 1000,
  });

  assert.ok(result.systemTokens > 0);
  assert.ok(result.historyTokens > 0);
  assert.ok(result.draftTokens > 0);
  assert.equal(result.totalTokens, result.systemTokens + result.historyTokens + result.draftTokens);
  assert.equal(result.contextLimit, 1000);
  assert.equal(result.status, 'normal');
  assert.equal(result.trimmedCount, 2);
  assert.equal(result.historyCount, 2);

  // High usage triggers warn / danger
  const highResult = calculateThreadContextTokens({
    thread,
    systemPrompt: 'System instructions',
    inputDraft: 'x'.repeat(3000), // ~860 tokens
    contextLimit: 1000,
  });
  assert.equal(highResult.status, 'warn');

  const overflowResult = calculateThreadContextTokens({
    thread,
    systemPrompt: 'System instructions',
    inputDraft: 'x'.repeat(4000), // ~1145 tokens
    contextLimit: 1000,
  });
  assert.equal(overflowResult.status, 'danger');
});
