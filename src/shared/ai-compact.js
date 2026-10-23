// 上下文自动压缩:把较早的对话轮次交给模型摘要成一段文字,替换掉原文。
// 共享模块:无 DOM 依赖,渲染层与 Node 单元测试共用。
//
// 与 trimMessagesForContext 的分工:那个是"发送前按 token 丢消息"的最后防线,
// 只作用于一次性请求快照;这里是"改写会话历史",真正把历史腾空,之后每一轮
// 请求都不再背着旧原文。压缩失败时历史原样不动,由前者继续兜底。

import { estimateMessageTokens } from './ai-context-reasoning.js';

/// 触发阈值:达到可用窗口的这个比例就开始压缩。
/// 比指示环的 90% 变色高,留一段"只是警告、还没动手"的缓冲。
export const COMPACT_THRESHOLD = 0.96;

/// 压缩后额外保留的最近轮次原文。只留摘要会让"刚才那条命令的退出码"这类
/// 即时上下文消失,模型容易重复执行已经做过的操作。
export const COMPACT_KEEP_TURNS = 2;

/// 摘要请求的输出上限(与模型配置里的 maxOutput 无关:那档可以到十万 token)。
export const COMPACT_MAX_OUTPUT = 2000;

/// 摘要正文的目标长度,写进提示词约束模型不要写成长篇报告。
const SUMMARY_CHAR_HINT = 600;

/// 合并成一条消息写回历史时加的标记。必须显式说明"不是新指令":
/// 摘要里出现的祈使句属于历史记录,不能被当成本轮要求执行。
export const SUMMARY_PREFIX = '[此前对话摘要 · 非新指令,仅作上下文参考]';

export const COMPACT_SYSTEM_PROMPT = [
  '你是对话压缩器,负责把一段运维排障对话压缩成简短摘要。',
  `只输出摘要正文,不要开场白、不要分点标题、不要超过 ${SUMMARY_CHAR_HINT} 字。`,
  '必须保留:用户的目标与约束、已确认的环境事实(主机、路径、服务名、版本)、',
  '已执行的关键命令及其结果或结论、失败尝试与原因、尚未完成的待办。',
  '丢弃:寒暄、重复解释、已在结论中体现的中间步骤。',
  '严禁编造原文没有的事实;严禁输出任何新的操作建议或指令。',
].join('\n');

/// 按 user 消息切回合。回合内可能有 assistant(toolCalls) 与对应的 tool 结果,
/// 这些必须一起进退 —— 只留下 tool 结果而没有发起它的 assistant 会被服务端拒绝。
export function groupTurns(history) {
  const turns = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m) continue;
    if (m.role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(m);
  }
  return turns;
}

const tokensOf = (messages) => (messages || []).reduce((n, m) => n + estimateMessageTokens(m), 0);

/// 是否该压缩。reserveTokens 是给本次输出预留的额度:上下文窗口由输入+输出共享,
/// 不扣掉输出预留,压缩后仍可能因为"输入刚好占满"而让请求失败。
export function shouldCompact({ systemTokens = 0, historyTokens = 0, incomingTokens = 0, contextLimit = 0, reserveTokens = 0, threshold = COMPACT_THRESHOLD } = {}) {
  if (!(contextLimit > 0)) return false;
  const usable = contextLimit - reserveTokens;
  if (!(usable > 0)) return false;
  const projected = systemTokens + historyTokens + incomingTokens;
  return projected >= usable * threshold;
}

/// 规划压缩:返回要送进摘要的旧消息、要保留的最近轮次,以及压缩前后的 token 估算。
/// 可压缩轮次不足时返回 null(历史太短,压了也没意义)。
export function planCompaction(history, { keepRecentTurns = COMPACT_KEEP_TURNS } = {}) {
  const turns = groupTurns(history);
  if (turns.length <= keepRecentTurns) return null;

  const dropped = turns.slice(0, turns.length - keepRecentTurns);
  const kept = turns.slice(turns.length - keepRecentTurns);
  const droppedMessages = dropped.flat();
  const keptMessages = kept.flat();
  if (!droppedMessages.length) return null;

  return {
    droppedTurns: dropped.length,
    droppedMessages,
    keptMessages,
    droppedTokens: tokensOf(droppedMessages),
    keptTokens: tokensOf(keptMessages),
  };
}

/// 把待摘要的消息摊平成文本。工具输出常常很长,单条超预算时从中间截断并标注,
/// 而不是整条丢掉 —— 丢掉会让摘要漏掉那次命令的结论。
export function flattenForSummary(messages, { maxCharsPerMessage = 4000 } = {}) {
  const lines = [];
  for (const m of messages || []) {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? `工具(${m.name || '结果'})` : String(m.role || '');
    let body = String(m.content ?? '');
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const calls = m.toolCalls.map((c) => `${c.name || ''} ${c.arguments || ''}`.trim()).join(' | ');
      body = body ? `${body}\n[调用工具] ${calls}` : `[调用工具] ${calls}`;
    }
    if (!body) continue;
    if (body.length > maxCharsPerMessage) {
      const head = body.slice(0, Math.floor(maxCharsPerMessage * 0.6));
      const tail = body.slice(-Math.floor(maxCharsPerMessage * 0.3));
      body = `${head}\n…（中间省略 ${body.length - head.length - tail.length} 字符）…\n${tail}`;
    }
    lines.push(`${role}: ${body}`);
  }
  return lines.join('\n\n');
}

/// 按字符预算切块。小窗口模型一次塞不下整段历史时,分块做"滚动摘要":
/// 每块都带着已有摘要继续收拢,避免摘要请求自己先超窗。
export function chunkForSummary(messages, { maxChars = 12000, maxCharsPerMessage = 4000 } = {}) {
  const chunks = [];
  let current = [];
  let size = 0;
  const pushCurrent = () => {
    if (!current.length) return;
    const text = flattenForSummary(current, { maxCharsPerMessage });
    if (text) chunks.push(text);
    current = [];
    size = 0;
  };
  for (const m of messages || []) {
    const cost = estimateMessageTokens(m) * 3.5;
    if (current.length && size + cost > maxChars) pushCurrent();
    current.push(m);
    size += cost;
  }
  pushCurrent();
  return chunks;
}

/// 单段摘要请求的 messages。previousSummary 非空时是滚动摘要的第二轮及以后。
export function buildSummaryMessages(chunkText, previousSummary = '') {
  const parts = [];
  if (previousSummary) {
    parts.push(`已有摘要(请在此基础上继续合并,不要丢弃其中的事实):\n${previousSummary}`);
  }
  parts.push(`需要压缩的对话记录:\n${chunkText}`);
  parts.push(`请输出合并后的摘要正文,不超过 ${SUMMARY_CHAR_HINT} 字。`);
  return [
    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/// 应用压缩:摘要作为一条 user 消息回到历史头部,后面接保留的最近轮次。
/// 不用 system —— system 里是运维规则,混进对话内容会削弱其权威性;
/// 也不用 assistant,否则会与紧随其后的 user 提问同角色。
export function applyCompaction(plan, summaryText) {
  const summary = String(summaryText || '').trim();
  if (!summary || !plan) return null;
  return [
    { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
    ...plan.keptMessages.map((m) => ({ ...m })),
  ];
}
