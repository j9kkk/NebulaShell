// AI 上下文窗口与思考强度能力推导、规范化与裁剪逻辑
// 共享模块：无 DOM 依赖，渲染层与 Node 单元测试共用
//
// 这里的默认值只是**没有上游数据时**的兜底:拉取模型列表时供应商若返回了
// context_length / max_output_tokens / effort 档位,一律以上游为准(见 normModel)。
//
// 很多 OpenAI 兼容中转站的 /v1/models 只回 id/object/owned_by/created,
// 一个能力字段都没有(实测 WorkBuddy 这类中转即如此)。此时全靠本表兜底,
// 所以按**厂商族 + 版本号**匹配,而不是简单 includes —— 否则同族不同代的
// 模型会挤到同一个数上。查不到权威规格的族宁可保守,也不编造。

/// 图像生成模型:没有对话上下文的概念,不该以「上下文窗口」示人。
/// 只用于展示区分,不影响请求。
const IMAGE_MODEL_PATTERNS = [
  /gpt-image/, /dall-e/, /imagen/, /stable-diffusion/, /(^|[/-])sd3/, /(^|[/-])flux/,
  /seedream/, /wanx/, /midjourney/, /(^|[/-])kolors/,
];

export function modelKindOf(modelId) {
  const mid = String(modelId || '').toLowerCase();
  return IMAGE_MODEL_PATTERNS.some((re) => re.test(mid)) ? 'image' : 'chat';
}

/// 智谱 GLM:官方型号表里 5.2 / 5.3 系列是 1M 上下文,5 / 5.1 / Turbo 与 4.x
/// 是 200K;输出统一 128K。用版本号判断而不是字符串前缀,避免 5.3 被 5 抢先命中。
function glmSpec(mid) {
  const m = mid.match(/glm-(\d+)(?:[.\-](\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] == null ? 0 : Number(m[2]);
  const bigWindow = major > 5 || (major === 5 && minor >= 2);
  return { context: bigWindow ? 1000000 : 200000, output: 128000 };
}

/// Anthropic Claude:3.7 起支持 thinking,4/5 系列全是 200K 上下文。
/// claude-fable-5-x 属 5 系列,同样按 200K/64K 处理。
function claudeSpec(mid) {
  const thinking = /claude-(3-7|3\.7|sonnet-4|opus-4|haiku-4|sonnet-5|opus-5|haiku-5|fable-5|4-|5-)/.test(mid)
    || /claude-(sonnet|opus|haiku|fable)-[45]/.test(mid);
  return { context: 200000, output: thinking ? 64000 : 8192, thinking };
}

const EFFORT_4 = {
  low: { reasoning_effort: 'low' },
  medium: { reasoning_effort: 'medium' },
  high: { reasoning_effort: 'high' },
};

const THINKING_BUDGETS = {
  low: { thinking: { type: 'enabled', budget_tokens: 2048 } },
  medium: { thinking: { type: 'enabled', budget_tokens: 8192 } },
  high: { thinking: { type: 'enabled', budget_tokens: 16384 } },
};

export function inferModelDefaults(modelId, rawContext, isVision) {
  const mid = String(modelId || '').toLowerCase();
  let contextWindow = rawContext ? Number(rawContext) : 128000;
  let maxOutput = 8192;
  let levels = ['disabled'];
  let defaultLevel = 'disabled';
  let mapping = {};

  const glm = glmSpec(mid);
  const claude = mid.includes('claude') ? claudeSpec(mid) : null;

  if (mid.includes('r1') || mid.includes('reasoner')) {
    // DeepSeek-R1 一代仍是 64K / 8K,走独立的思考开关参数
    contextWindow = rawContext ? Number(rawContext) : 64000;
    maxOutput = 8000;
    levels = ['disabled', 'high'];
    defaultLevel = 'high';
    mapping = { high: { extra_body: { thinking: true } } };
  } else if (mid.includes('deepseek')) {
    // DeepSeek 现行模型(deepseek-flash / deepseek-v4-pro 及其别名)都是
    // 1M 输入、384K 输出,推理档位走标准 reasoning_effort。
    contextWindow = rawContext ? Number(rawContext) : 1000000;
    maxOutput = 384000;
    levels = ['disabled', 'low', 'medium', 'high'];
    defaultLevel = 'medium';
    mapping = EFFORT_4;
  } else if (glm) {
    contextWindow = rawContext ? Number(rawContext) : glm.context;
    maxOutput = glm.output;
    levels = ['disabled', 'low', 'medium', 'high'];
    defaultLevel = 'disabled';
    mapping = EFFORT_4;
  } else if (claude) {
    contextWindow = rawContext ? Number(rawContext) : claude.context;
    maxOutput = claude.output;
    if (claude.thinking) {
      levels = ['disabled', 'low', 'medium', 'high'];
      defaultLevel = 'medium';
      mapping = THINKING_BUDGETS;
    }
  } else if (mid.includes('o1') || mid.includes('o3') || mid.includes('o4') || mid.includes('gpt-5') || mid.includes('gpt-6')) {
    contextWindow = rawContext ? Number(rawContext) : 200000;
    maxOutput = 100000;
    levels = ['disabled', 'low', 'medium', 'high'];
    defaultLevel = 'medium';
    mapping = EFFORT_4;
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
  // 其余(minimax / step / gemini / 自研模型等):查不到权威规格就保持保守默认,
  // 界面上会标「本地推荐」,让用户知道这个数不是供应商给的。

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

/// 后端已归一化,但历史配置里可能残留纯字符串形式(旧版只存 id),统一收敛成对象。
///
/// 取值优先级:**上游 /models 返回的能力 > 按模型 ID 推导的默认值**。
/// 上游是供应商自己声明的权威值(DeepSeek 直接给 context_window 1M、
/// max_output_tokens 384K、effort 档位),按 ID 猜的那套只是没有上游数据时的兜底。
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
      kind: modelKindOf(m),
      ...inferred,
      capabilitySource: 'inferred',
    };
  }
  const id = String(m.id || m.name || '');
  const rawContext = m.context == null ? null : Number(m.context) || null;
  const isVision = !!m.vision;
  const inferred = inferModelDefaults(id, rawContext, isVision);
  // 上游直给的最大输出(DeepSeek: max_output_tokens)。
  const rawMaxOutput = m.maxOutput == null ? null : Number(m.maxOutput) || null;
  // 上游直给的推理档位(DeepSeek: effort.supported_levels / default_level)。
  const upstreamLevels = Array.isArray(m.effortLevels)
    ? m.effortLevels.map((x) => String(x)).filter(Boolean)
    : [];
  const upstreamDefault = m.effortDefault ? String(m.effortDefault) : '';

  let reasoning = m.reasoning;
  if (!reasoning || typeof reasoning !== 'object') {
    // 没有用户自定义:上游有档位就用上游的,否则用按 ID 推导的。
    if (upstreamLevels.length) {
      reasoning = {
        levels: upstreamLevels.slice(),
        default: upstreamDefault && upstreamLevels.includes(upstreamDefault)
          ? upstreamDefault
          : upstreamLevels[0],
        // 档位名由上游给,但"哪个档位对应什么请求参数"仍按 ID 规律映射;
        // 映射里没有的档位不发额外参数(等同于模型自身默认行为)。
        mapping: inferred.reasoning.mapping,
        source: 'upstream',
      };
    } else {
      reasoning = inferred.reasoning;
    }
  } else {
    reasoning = {
      levels: Array.isArray(reasoning.levels) && reasoning.levels.length ? reasoning.levels : inferred.reasoning.levels,
      default: reasoning.default || inferred.reasoning.default || 'disabled',
      mapping: reasoning.mapping && typeof reasoning.mapping === 'object' ? reasoning.mapping : inferred.reasoning.mapping,
    };
  }
  // 幂等:已标过「上游权威值」的配置,二次规范化后不能把来源标记洗掉
  if (m.reasoning && typeof m.reasoning === 'object' && m.reasoning.source === 'upstream') {
    reasoning.source = 'upstream';
  }

  // 记录能力值的来源,供设置界面标注「来自供应商」/「本地推荐」/「手动」。
  //
  // 判定要能区分三种情况,不能只看"有没有 context 值":
  // - 后端刚拉回来的原始条目:有 context、没有 contextWindow(那是前端规范化时补的)
  // - 已规范化过并被保存的条目:context 与 contextWindow 都有,靠 capabilitySource 记住
  // - 旧版保存的配置:两者都没有 context,只有推导出来的 contextWindow —— 不能算上游
  const explicitSource = m.capabilitySource;
  let capabilitySource;
  if (explicitSource === 'manual' || explicitSource === 'upstream' || explicitSource === 'inferred') {
    capabilitySource = explicitSource;
  } else if (upstreamLevels.length) {
    capabilitySource = 'upstream';
  } else if (rawContext && m.contextWindow == null) {
    capabilitySource = 'upstream';
  } else {
    capabilitySource = 'inferred';
  }

  return {
    id,
    name: String(m.name || m.id || ''),
    ownedBy: String(m.ownedBy || ''),
    created: m.created == null ? null : m.created,
    context: rawContext,
    vision: isVision,
    // image / chat:图像生成模型没有对话上下文的概念,列表里要单独标注
    kind: m.kind === 'image' || m.kind === 'chat' ? m.kind : modelKindOf(id),
    contextWindow: m.contextWindow != null ? Number(m.contextWindow) : (rawContext || inferred.contextWindow),
    maxOutput: rawMaxOutput || inferred.maxOutput,
    reasoning,
    autoConfig: m.autoConfig !== false,
    capabilitySource,
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

/// token 数量单位换算:>=1M 显示 M,>=1000 显示 K,四舍五入保留 0 位小数。
///
/// 进位要按**四舍五入后的结果**判断,而不是原始值:999999 保留 0 位小数是
/// 1000K,读起来像"一千千",应进位成 1M。同理 999 显示 999 而不是 1K。
export function formatTokenCount(n) {
  if (n == null || Number.isNaN(Number(n))) return '0';
  const num = Number(n);
  if (num >= 1e6 - 500) return `${(num / 1e6).toFixed(0)}M`;
  if (num >= 1e3 - 0.5) return `${(num / 1e3).toFixed(0)}K`;
  return String(Math.round(num));
}

/// 中文紧凑数字:上下文弹窗标题行用(`44.1万 / 100万`)。
///
/// 与 formatTokenCount 的分工:这个面向中文阅读习惯用「万/亿」,只在读数行用;
/// token 明细行仍用 formatTokenCount 的精确写法(明细的用途是核对,不该被缩写)。
///
/// 规则:
/// - < 1 万:千分位原数(8,532),不写成「0.9万」
/// - >= 1 万:保留 1 位小数,整数时省略 `.0`(100万 而不是 100.0万)
/// - >= 1 亿:改用「亿」,同样 1 位小数
export function formatCompactNumber(n) {
  if (n == null || Number.isNaN(Number(n))) return '0';
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  const neg = num < 0;
  const abs = Math.abs(num);
  let text;
  if (abs >= 1e8) {
    text = trimZeroDecimal(abs / 1e8) + '亿';
  } else if (abs >= 1e4) {
    text = trimZeroDecimal(abs / 1e4) + '万';
  } else {
    // 千分位:8532 -> 8,532
    text = Math.round(abs).toLocaleString('en-US');
  }
  return (neg ? '-' : '') + text;
}

/// 保留 1 位小数,整数时去掉 `.0`
function trimZeroDecimal(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/// 计算会话上下文窗口的 Token 占用拆解（系统提示词、历史消息、输入框草稿）与比例
export function calculateThreadContextTokens({
  thread = null,
  systemPrompt = '',
  inputDraft = '',
  contextLimit = 128000,
} = {}) {
  const limit = Math.max(1, Number(contextLimit) || 128000);
  const sysTokens = systemPrompt ? estimateMessageTokens({ role: 'system', content: systemPrompt }) : 0;

  let historyTokens = 0;
  const historyList = thread?.history || [];
  for (const m of historyList) {
    historyTokens += estimateMessageTokens(m);
  }

  const draftTokens = inputDraft && String(inputDraft).trim()
    ? estimateMessageTokens({ role: 'user', content: String(inputDraft).trim() })
    : 0;

  const totalTokens = sysTokens + historyTokens + draftTokens;
  const ratio = Math.max(0, totalTokens / limit);
  const percent = Math.round(ratio * 100);

  let status = 'normal';
  if (ratio >= 0.9) {
    status = 'danger';
  } else if (ratio >= 0.7) {
    status = 'warn';
  }

  return {
    systemTokens: sysTokens,
    historyTokens,
    draftTokens,
    totalTokens,
    contextLimit: limit,
    ratio,
    percent,
    status,
    historyCount: historyList.length,
    trimmedCount: thread?.trimmedCount || 0,
  };
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
