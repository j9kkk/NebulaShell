// AI 上下文窗口与思考强度能力推导、规范化与裁剪逻辑
// 共享模块：无 DOM 依赖，渲染层与 Node 单元测试共用

export function inferModelDefaults(modelId, rawContext, isVision) {
  const mid = String(modelId || '').toLowerCase();
  let contextWindow = rawContext ? Number(rawContext) : 128000;
  let maxOutput = 8192;
  let levels = ['disabled'];
  let defaultLevel = 'disabled';
  let mapping = {};

  if (mid.includes('o1') || mid.includes('o3') || mid.includes('o4') || mid.includes('gpt-5')) {
    contextWindow = rawContext ? Number(rawContext) : 200000;
    maxOutput = 100000;
    levels = ['disabled', 'low', 'medium', 'high'];
    defaultLevel = 'medium';
    mapping = {
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
    };
  } else if (mid.includes('r1') || mid.includes('reasoner') || mid.includes('deepseek-r1')) {
    contextWindow = rawContext ? Number(rawContext) : 64000;
    maxOutput = 8000;
    levels = ['disabled', 'high'];
    defaultLevel = 'high';
    mapping = {
      high: { extra_body: { thinking: true } },
    };
  } else if (mid.includes('claude-3-7') || mid.includes('claude-sonnet-4') || mid.includes('claude-opus-4')) {
    contextWindow = rawContext ? Number(rawContext) : 200000;
    maxOutput = 64000;
    levels = ['disabled', 'low', 'medium', 'high'];
    defaultLevel = 'medium';
    mapping = {
      low: { thinking: { type: 'enabled', budget_tokens: 2048 } },
      medium: { thinking: { type: 'enabled', budget_tokens: 8192 } },
      high: { thinking: { type: 'enabled', budget_tokens: 16384 } },
    };
  } else if (mid.includes('qwen') && (mid.includes('plus') || mid.includes('max') || mid.includes('turbo'))) {
    contextWindow = rawContext ? Number(rawContext) : 131072;
    maxOutput = 8192;
    levels = ['disabled', 'low', 'high'];
    defaultLevel = 'disabled';
    mapping = {
      low: { enable_thinking: false },
      high: { enable_thinking: true },
    };
  } else if (mid.includes('kimi') || mid.includes('moonshot')) {
    contextWindow = rawContext ? Number(rawContext) : 128000;
    maxOutput = 8192;
  }

  return {
    contextWindow,
    maxOutput,
    reasoning: {
      levels,
      default: defaultLevel,
      mapping,
    },
    autoConfig: true,
  };
}

/// 后端已归一化,但历史配置里可能残留纯字符串形式(旧版只存 id),统一收敛成对象
export function normModel(m) {
  if (typeof m === 'string') {
    const inferred = inferModelDefaults(m, null, false);
    return {
      id: m,
      name: m,
      ownedBy: '',
      created: null,
      context: null,
      vision: false,
      ...inferred,
    };
  }
  const id = String(m.id || m.name || '');
  const rawContext = m.context == null ? null : Number(m.context) || null;
  const isVision = !!m.vision;
  const inferred = inferModelDefaults(id, rawContext, isVision);

  let reasoning = m.reasoning;
  if (!reasoning || typeof reasoning !== 'object') {
    reasoning = inferred.reasoning;
  } else {
    reasoning = {
      levels: Array.isArray(reasoning.levels) && reasoning.levels.length ? reasoning.levels : inferred.reasoning.levels,
      default: reasoning.default || inferred.reasoning.default || 'disabled',
      mapping: reasoning.mapping && typeof reasoning.mapping === 'object' ? reasoning.mapping : inferred.reasoning.mapping,
    };
  }

  return {
    id,
    name: String(m.name || m.id || ''),
    ownedBy: String(m.ownedBy || ''),
    created: m.created == null ? null : m.created,
    context: rawContext,
    vision: isVision,
    contextWindow: m.contextWindow != null ? Number(m.contextWindow) : (rawContext || inferred.contextWindow),
    maxOutput: m.maxOutput != null ? Number(m.maxOutput) : inferred.maxOutput,
    reasoning,
    autoConfig: m.autoConfig !== false,
  };
}

export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  let chars = String(msg.content || '').length;
  if (msg.reasoning) chars += String(msg.reasoning).length;
  if (Array.isArray(msg.toolCalls)) {
    for (const c of msg.toolCalls) {
      chars += String(c.name || '').length + String(c.arguments || '').length;
    }
  }
  return Math.ceil(chars / 3.5) + 4;
}

export function trimMessagesForContext(messages, windowLimit) {
  if (!windowLimit || windowLimit <= 0 || !Array.isArray(messages) || messages.length <= 2) {
    return { messages, trimmedCount: 0 };
  }
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  if (nonSystem.length <= 1) {
    return { messages, trimmedCount: 0 };
  }

  const systemCost = systemMsgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
  const lastUserMsg = nonSystem[nonSystem.length - 1];
  const lastUserCost = estimateMessageTokens(lastUserMsg);

  let budget = windowLimit - systemCost - lastUserCost;
  if (budget <= 0) {
    const trimmedCount = nonSystem.length - 1;
    return { messages: [...systemMsgs, lastUserMsg], trimmedCount };
  }

  const history = nonSystem.slice(0, -1);
  const keptHistory = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const cost = estimateMessageTokens(m);
    if (cost > budget) {
      break;
    }
    keptHistory.unshift(m);
    budget -= cost;
  }

  const trimmedCount = history.length - keptHistory.length;
  return {
    messages: [...systemMsgs, ...keptHistory, lastUserMsg],
    trimmedCount,
  };
}

export function resolveReasoningParams(model, effort) {
  if (!model || !effort || effort === 'disabled') return null;
  const mapping = model.reasoning?.mapping;
  if (!mapping || typeof mapping !== 'object') return null;
  const params = mapping[effort];
  if (!params || typeof params !== 'object') return null;
  return params;
}

export function reasoningLevelLabel(level) {
  const map = {
    disabled: '关闭',
    off: '关闭',
    none: '关闭',
    low: '低',
    medium: '中',
    high: '高',
    max: '最高',
  };
  return map[level] || level;
}
