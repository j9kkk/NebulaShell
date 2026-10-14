// AI 工具循环的接线：线程与主机会话绑定、模型工具能力、每轮请求与界面适配。
import { api, askConfirm, state, toast } from './core.js';
import { buildHostSystemPrompt, runAgentTurn } from './ai-agent.js';
import { createAgentAdapter, updateHostBar } from './ai-agent-ui.js';
import { AI_AGENT_TOOLS } from '../shared/ai-tools-schema.js';
import { readTerminalLines } from './terminal.js';
import {
  activeAiThread, aiRequest, aiStickScroll, appendToThreadView, clearBubbleState, hostKeyOf, hostLabelOf,
  markBubblePending, refreshThreadUi, renderAiMessage, setAiBusy, trimAiHistory,
} from './ai.js';

// sessionId → sudo 密码（用户勾选「本会话记住」时才写入，只在内存）。
const sudoCache = new Map();

const connected = (s) => !!s && s.status === 'connected';

function toolSupportKey() {
  const ai = state.settings?.ai || {};
  return `${ai.baseUrl || ''}::${ai.model || ''}`;
}

export function modelToolsCapable() {
  return (state.settings?.ai?.toolSupport || {})[toolSupportKey()] !== false;
}

async function markToolsUnsupported() {
  const ai = state.settings?.ai;
  if (!ai) return;
  ai.toolSupport = { ...(ai.toolSupport || {}), [toolSupportKey()]: false };
  try { await api('settings:save', { ai: { toolSupport: ai.toolSupport } }); } catch { /* 下次请求会再探测一次 */ }
  refreshAgentHostBar();
}

/// 线程绑定的主机会话：优先原会话，断开则找同一主机的其他已连接会话；
/// 未绑定的空闲线程在发送时绑定当前标签的主机（bindNow）。
export function agentBinding(thread) {
  if (!thread) return { session: null };
  const sessions = state.sessions;
  const active = sessions?.get?.(state.activeId);
  if (!thread.hostId) {
    return connected(active) ? { session: active, bindNow: true } : { session: null, reason: '' };
  }
  const own = thread.sessionId && sessions?.get?.(thread.sessionId);
  if (connected(own)) return { session: own };
  const same = [...(sessions?.values?.() || [])].find((s) => connected(s) && hostKeyOf(s.host) === thread.hostId);
  return same ? { session: same } : { session: null, reason: '绑定的主机未连接' };
}

export function bindThreadToSession(thread, session) {
  const key = hostKeyOf(session.host);
  if (thread.hostId !== key) thread.execMode = 'manual';
  thread.hostId = key;
  thread.hostName = hostLabelOf(session.host);
  thread.sessionId = session.sessionId;
}

/// 能否让本次发送走工具循环。
export function agentAvailable(thread) {
  const b = agentBinding(thread);
  return !!(b.session && modelToolsCapable() && b.session.host?.aiAccess !== 'deny');
}

async function toggleMode(thread) {
  if (!thread) return;
  if (thread.execMode === 'auto') {
    thread.execMode = 'manual';
  } else {
    if (!thread.autoAcked) {
      const ok = await askConfirm(
        '切到自动后，AI 会直接在该主机执行普通命令；高危、外联、覆盖已有文件的命令仍会停下来等你确认。随时可以切回手动。',
        { title: '切换到自动执行', okText: '切到自动', danger: false },
      );
      if (!ok) return;
      thread.autoAcked = true;
    }
    thread.execMode = 'auto';
  }
  refreshAgentHostBar();
}

export function refreshAgentHostBar() {
  const thread = activeAiThread();
  if (!thread) return updateHostBar(null);
  const b = agentBinding(thread);
  const s = b.session;
  const active = state.sessions?.get?.(state.activeId);
  let warn = '';
  if (!modelToolsCapable()) warn = '当前模型不支持工具调用，只能普通对话';
  else if (s?.host?.aiAccess === 'deny') warn = '该主机设置为禁止 AI 访问';
  else if (!s && thread.hostId) warn = b.reason || '';
  else if (s && !b.bindNow && connected(active) && hostKeyOf(active.host) !== thread.hostId) warn = `当前标签是 ${hostLabelOf(active.host)}，本会话作用于 ${thread.hostName}`;
  const host = s?.host || {};
  updateHostBar({
    visible: !!(s || thread.hostId),
    label: (b.bindNow ? '将作用于 ' : '作用于 ') + (s ? hostLabelOf(host) + (host.username ? ' · ' + host.username : '') : thread.hostName || ''),
    isRoot: host.username === 'root',
    mode: host.aiAccess === 'manual' ? 'manual' : thread.execMode || 'manual',
    modeLocked: host.aiAccess === 'manual',
    disabled: !s || !modelToolsCapable(),
    warn,
  }, { onToggleMode: () => toggleMode(thread) });
}

/// 一轮模型请求：沿用现有流式气泡；只有工具调用、没有正文的轮次不留空气泡。
async function agentChat(thread, { messages, tools }) {
  const bubble = renderAiMessage('assistant', '', { thread });
  markBubblePending(bubble);
  const r = await aiRequest(messages, bubble, undefined, { thread, record: false, tools });
  clearBubbleState(bubble);
  if (r?.error) {
    if (r.code === 'tools_unsupported') {
      bubble.remove();
      markToolsUnsupported();
      throw Object.assign(new Error(r.error), { code: 'tools_unsupported' });
    }
    throw new Error(r.error);
  }
  return { content: r.text || '', toolCalls: r.toolCalls, reasoning: r.reasoning, thinkingBlocks: r.thinkingBlocks, aborted: !!r.aborted };
}

export async function runAgentSend(thread, binding, { content, display, md }) {
  const session = binding.session;
  if (binding.bindNow) bindThreadToSession(thread, session);
  else thread.sessionId = session.sessionId;
  renderAiMessage('user', display, { md, thread });
  const ctrl = new AbortController();
  thread.agentRun = { ctrl };
  if (thread.id === state.activeThreadId) setAiBusy(true);
  refreshThreadUi();
  const isActive = () => thread.id === state.activeThreadId;
  const adapter = createAgentAdapter({
    mount: (el) => appendToThreadView(thread, el),
    onGrow: () => { if (isActive()) aiStickScroll(); },
    isActive,
    setPending: (on, background) => {
      thread.pendingConfirm = !!on;
      if (on && background) {
        thread.unread = true;
        toast(`后台会话「${thread.title || '新对话'}」有命令等待确认`, 'info');
      }
      refreshThreadUi();
    },
    onRunAndAuto: () => { thread.execMode = 'auto'; thread.autoAcked = true; refreshAgentHostBar(); },
    audit: (e) => api('ai:tool-audit', { ...e, sessionId: session.sessionId, host: hostLabelOf(session.host) }).catch(() => {}),
    canUseSaved: () => !!(session.host?.hasPassword || session.host?.password),
  });
  const host = session.host || {};
  try {
    // 请求失败由流式气泡自己展示（⚠️ 错误），这里不重复提示。
    await runAgentTurn({
      thread,
      userMessage: content,
      systemPrompt: buildHostSystemPrompt({
        hostName: hostLabelOf(host), user: host.username, isRoot: host.username === 'root',
        os: thread.hostOs, cwd: session.remoteCwd, execMode: thread.execMode,
      }),
      tools: AI_AGENT_TOOLS,
      sessionId: session.sessionId,
      getMode: () => (host.aiAccess === 'manual' ? 'manual' : thread.execMode || 'manual'),
      chat: (req) => agentChat(thread, req),
      execTool: async (req) => {
        const res = await api('ai:tool-exec', req);
        if (req.tool === 'host_info' && res?.meta?.os) thread.hostOs = res.meta.os;
        return res;
      },
      cancelTool: (toolRunId) => api('ai:tool-cancel', { toolRunId }),
      readTerminal: (lines) => readTerminalLines(state.sessions?.get?.(session.sessionId) || session, lines),
      adapter: {
        ...adapter,
        onToolsUnsupported: () => toast('当前模型不支持工具调用，本次改为普通对话', 'info'),
      },
      signal: ctrl.signal,
      sudoCache,
      uuid: () => crypto.randomUUID(),
    });
  } finally {
    thread.agentRun = null;
    thread.pendingConfirm = false;
    thread.updatedAt = Date.now();
    trimAiHistory(thread);
    if (thread.id === state.activeThreadId) setAiBusy(false);
    else thread.unread = true;
    refreshThreadUi();
  }
}

/// 会话断开时清掉该会话记住的 sudo 密码。
export function forgetSudoPassword(sessionId) {
  sudoCache.delete(sessionId);
}
