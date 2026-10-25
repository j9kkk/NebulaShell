import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferModelDefaults,
  normModel,
  modelKindOf,
  estimateMessageTokens,
  formatCompactNumber,
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

test('inferModelDefaults knows current DeepSeek models are 1M in / 384K out', () => {
  for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
    const m = inferModelDefaults(id, null, false);
    assert.equal(m.contextWindow, 1000000, id);
    assert.equal(m.maxOutput, 384000, id);
    assert.deepEqual(m.reasoning.levels, ['disabled', 'low', 'medium', 'high']);
    assert.deepEqual(m.reasoning.mapping.high, { reasoning_effort: 'high' });
  }
  // r1 / reasoner 仍走旧的思考映射分支,不被 deepseek 泛化分支吞掉
  const r1 = inferModelDefaults('deepseek-reasoner', null, false);
  assert.deepEqual(r1.reasoning.levels, ['disabled', 'high']);
});

test('upstream /models capability values win over ID-inferred defaults', () => {
  // DeepSeek 新版 /models 会直给 context_window / max_output_tokens / effort
  const m = normModel({
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    context: 1000000,
    maxOutput: 384000,
    effortLevels: ['low', 'medium', 'high'],
    effortDefault: 'medium',
    vision: false,
  });
  assert.equal(m.contextWindow, 1000000);
  assert.equal(m.maxOutput, 384000);
  assert.deepEqual(m.reasoning.levels, ['low', 'medium', 'high']);
  assert.equal(m.reasoning.default, 'medium');
  assert.equal(m.capabilitySource, 'upstream');
  // 上游档位名配上本地按 ID 推的请求参数映射
  assert.deepEqual(m.reasoning.mapping.high, { reasoning_effort: 'high' });
});

test('normModel falls back to inferred defaults when upstream omits capabilities', () => {
  const bare = normModel({ id: 'deepseek-flash', name: 'deepseek-flash' });
  assert.equal(bare.contextWindow, 1000000);
  assert.equal(bare.maxOutput, 384000);
  assert.equal(bare.capabilitySource, 'inferred');
  // 完全没有上游信息的手填模型 ID 也走同一套推荐值
  const manual = normModel('deepseek-flash');
  assert.equal(manual.contextWindow, 1000000);
  assert.equal(manual.capabilitySource, 'inferred');
});

test('normModel is idempotent so repeated selection does not drop upstream capabilities', () => {
  const upstream = {
    id: 'deepseek-flash', name: 'deepseek-flash',
    context: 1000000, maxOutput: 384000,
    effortLevels: ['low', 'medium', 'high'], effortDefault: 'medium',
  };
  const once = normModel(upstream);
  const twice = normModel(once);
  const thrice = normModel(twice);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, thrice);
  assert.equal(twice.capabilitySource, 'upstream');
  assert.equal(twice.reasoning.source, 'upstream');
});

test('upstream effort levels keep an unknown default level out rather than inventing one', () => {
  const m = normModel({
    id: 'x-model', context: 32000, maxOutput: 4096,
    effortLevels: ['low', 'high'], effortDefault: 'medium',
  });
  // medium 不在上游档位里:落到第一个有效档位,而不是凭空造一个 medium
  assert.equal(m.reasoning.default, 'low');
  assert.deepEqual(m.reasoning.levels, ['low', 'high']);
});

test('capabilitySource distinguishes upstream, inferred, manual and legacy saved configs', () => {
  // 上游原始条目(后端刚拉回来):有 context、还没有前端补的 contextWindow
  const fresh = normModel({ id: 'deepseek-flash', context: 1000000, maxOutput: 384000 });
  assert.equal(fresh.capabilitySource, 'upstream');

  // 同一个模型二次规范化(勾选/保存会走一遍):来源标记必须保持
  assert.equal(normModel(fresh).capabilitySource, 'upstream');

  // 上游只给了 id,没有能力字段 → 本地推荐
  const bare = normModel({ id: 'deepseek-flash', name: 'deepseek-flash' });
  assert.equal(bare.capabilitySource, 'inferred');

  // 旧版保存的配置:没有 context,只有当初推导出来的 contextWindow → 仍算本地推荐
  const legacy = normModel({ id: 'deepseek-flash', context: null, contextWindow: 128000, maxOutput: 8192 });
  assert.equal(legacy.capabilitySource, 'inferred');

  // 用户手动改过:来源锁定为 manual,后续规范化不被洗回 upstream
  const manual = normModel({ ...fresh, contextWindow: 200000, capabilitySource: 'manual' });
  assert.equal(manual.capabilitySource, 'manual');
  assert.equal(normModel(manual).capabilitySource, 'manual');
  assert.equal(manual.contextWindow, 200000);
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

test('formatTokenCount promotes units by the rounded result, never showing 1000K', () => {
  // 1000K 这类"满一千个下级单位"的写法没有意义,必须进位到 M
  assert.equal(formatTokenCount(999499), '999K');
  assert.equal(formatTokenCount(999500), '1M');
  assert.equal(formatTokenCount(999999), '1M');
  assert.equal(formatTokenCount(1048576), '1M');
  // 小数边界:999 原样显示,不提前进位成 1K
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1K');
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

test('GLM family picks window by version: 5.2/5.3 are 1M, 5/5.1 and 4.x are 200K', () => {
  for (const id of ['glm-5.3-flash', 'glm-5.2', 'glm-5.3', 'glm-5.3-flashx']) {
    const m = inferModelDefaults(id, null, false);
    assert.equal(m.contextWindow, 1000000, id);
    assert.equal(m.maxOutput, 128000, id);
  }
  for (const id of ['glm-5', 'glm-5.1', 'glm-5-turbo', 'glm-4.6']) {
    const m = inferModelDefaults(id, null, false);
    assert.equal(m.contextWindow, 200000, id);
    assert.equal(m.maxOutput, 128000, id);
  }
});

test('Claude 5 family is recognised as a thinking model with 200K/64K', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
    const m = inferModelDefaults(id, null, false);
    assert.equal(m.contextWindow, 200000, id);
    assert.equal(m.maxOutput, 64000, id);
    assert.deepEqual(m.reasoning.levels, ['disabled', 'low', 'medium', 'high'], id);
    assert.deepEqual(m.reasoning.mapping.medium, { thinking: { type: 'enabled', budget_tokens: 8192 } }, id);
  }
});

test('gpt-6 uses the same 200K/100K reasoning defaults as the gpt-5 family', () => {
  const m = inferModelDefaults('gpt-6-luna', null, false);
  assert.equal(m.contextWindow, 200000);
  assert.equal(m.maxOutput, 100000);
  assert.deepEqual(m.reasoning.mapping.high, { reasoning_effort: 'high' });
});

test('unknown vendor families stay conservative rather than borrowing another model spec', () => {
  // minimax / step / hy4 / space-bunny 没有可查的权威规格:保持保守默认
  for (const id of ['minimax-m3', 'minimax-m3.1-flash', 'step-5-preview', 'hy4-preview', 'space-bunny', 'codex-auto-review']) {
    const m = inferModelDefaults(id, null, false);
    assert.equal(m.contextWindow, 128000, id);
    assert.equal(m.maxOutput, 8192, id);
  }
  // gemini 目前没有专门分支,不应被 gpt/claude 的规则误伤
  const gem = inferModelDefaults('gemini-3.8-flash-high', null, false);
  assert.equal(gem.contextWindow, 128000);
});

test('modelKindOf separates image generation models from chat models', () => {
  for (const id of ['gpt-image-2.5', 'gpt-image-2.5-flare', 'dall-e-3', 'flux-pro', 'seedream-3']) {
    assert.equal(modelKindOf(id), 'image', id);
  }
  for (const id of ['deepseek-flash', 'gpt-6-luna', 'glm-5.3-flash', 'claude-opus-5-5']) {
    assert.equal(modelKindOf(id), 'chat', id);
  }
  // 名字里含 image 但不是图像生成模型的不该被误判
  assert.equal(modelKindOf('imagemagick-assistant'), 'chat');
});

test('normModel carries the model kind so the picker can label image models', () => {
  assert.equal(normModel('gpt-image-2.5').kind, 'image');
  assert.equal(normModel({ id: 'gpt-image-2.5' }).kind, 'image');
  assert.equal(normModel({ id: 'deepseek-flash' }).kind, 'chat');
  // 已标注过的 kind 在二次规范化后保持不变
  assert.equal(normModel({ id: 'x', kind: 'image' }).kind, 'image');
});

test('a relay returning only id/owned_by/created leaves every model on inferred defaults', () => {
  // 实测中转站响应:只有这四个字段,没有任何能力信息
  const relayModels = [
    { id: 'glm-5.3-flash', object: 'model', owned_by: 'WorkBuddy', created: 1792647538 },
    { id: 'deepseek-flash', object: 'model', owned_by: 'WorkBuddy', created: 1792647538 },
    { id: 'claude-opus-5-5', object: 'model', owned_by: 'anthropic', created: 1790035200 },
  ];
  for (const raw of relayModels) {
    const m = normModel(raw);
    assert.equal(m.capabilitySource, 'inferred', raw.id);
    assert.equal(m.context, null, raw.id);
    // 但能力值仍然可用(来自本地表),不是 0/空
    assert.ok(m.contextWindow > 0, raw.id);
    assert.ok(m.maxOutput > 0, raw.id);
  }
  assert.equal(normModel(relayModels[0]).contextWindow, 1000000);
  assert.equal(normModel(relayModels[1]).contextWindow, 1000000);
});

test('formatCompactNumber uses 万/亿 with one decimal and drops trailing .0', () => {
  // 小于 1 万:千分位原数,不写成「0.9万」
  assert.equal(formatCompactNumber(0), '0');
  assert.equal(formatCompactNumber(853), '853');
  assert.equal(formatCompactNumber(8532), '8,532');
  assert.equal(formatCompactNumber(9999), '9,999');
  // 1 万起用「万」,保留 1 位小数
  assert.equal(formatCompactNumber(10000), '1万');
  assert.equal(formatCompactNumber(441000), '44.1万');
  assert.equal(formatCompactNumber(1000000), '100万');
  // 整数不显示 .0(100万 而不是 100.0万)
  assert.equal(formatCompactNumber(2000000), '200万');
  assert.equal(formatCompactNumber(128000), '12.8万');
  // 1 亿起改用「亿」
  assert.equal(formatCompactNumber(100000000), '1亿');
  assert.equal(formatCompactNumber(120000000), '1.2亿');
  // 异常输入不抛错
  assert.equal(formatCompactNumber(null), '0');
  assert.equal(formatCompactNumber(NaN), '0');
  assert.equal(formatCompactNumber(-441000), '-44.1万');
});
