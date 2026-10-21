// AI 工具循环的接线：线程与主机会话绑定、模型工具能力、每轮请求与界面适配。
import { $, api, askConfirm, state, toast } from './core.js';
import { buildHostSystemPrompt, runAgentTurn } from './ai-agent.js';
import {
  createAgentAdapter, renderTargetMenu, updateModePicker, updateTargetBar, updateContextBanner,
} from './ai-agent-ui.js';
import { AI_AGENT_TOOLS, AI_AGENT_TOOLS_MULTI } from '../shared/ai-tools-schema.js';
import {
  clearTargetGrants, hostKeyOf, hostLabelOf, isModelToolsCapable, rebindThread, resolveAiTarget,
  setLinkMode, threadExecMode, threadLinkMode, toolSupportKey,
} from '../shared/ai-target-state.js';
import { connectHost, reconnectSession, readTerminalLines } from './terminal.js';
import {
  clearThreadLinks, linkCountFor, linkedSessionIds, linkHost, linkHosts, linksForThread,
  setLinksChangeHandler, unlinkHost,
} from './ai-links.js';
import {
  activeAiThread, aiRequest, aiSend, aiStickScroll, appendToThreadView, beginAiTurn, clearBubbleState,
  endAiTurn, ensureThreadForSession, markBubblePending, refreshThreadUi, renderAiMessage, setAiBusy,
  threadBusy, trimAiHistory,
} from './ai.js';

// sessionId → sudo 密码（用户勾选「本会话记住」时才写入，只在内存）。
const sudoCache = new Map();

const connected = (s) => !!s && s.status === 'connected';

function currentToolSupportKey() {
  return toolSupportKey(state.settings?.ai);
}

export function modelToolsCapable() {
  return isModelToolsCapable(state.settings?.ai);
}

async function markToolsUnsupported() {
  const ai = state.settings?.ai;
  if (!ai) return;
  ai.toolSupport = { ...(ai.toolSupport || {}), [currentToolSupportKey()]: false };
  try { await api('settings:save', { ai: { toolSupport: ai.toolSupport } }); } catch { /* 下次请求会再探测一次 */ }
  refreshAgentHostBar();
}

/// 本对话当前可执行的会话集合(多主机时是全部已链接主机)。
/// 后续还要经后端 linkedSessions 白名单二次校验:模型换不出别的会话。
export function linkedSessionsFor(thread) {
  if (!thread || threadLinkMode(thread) !== 'multi') return null;
  return linkedSessionIds(thread);
}

/// 主执行会话(工具循环用):多主机取首台已连接;单主机取绑定/跟随的会话。
/// 直接复用 agentBinding,保证「默认主机」与发送时选中的主机是同一条判定。
function primarySessionFor(thread) {
  if (!thread) return null;
  return agentBinding(thread).session;
}

/// 后端允许执行的全部会话 id:多主机 = 该对话已链接的会话;单主机 = 该会话本身。
/// 一律显式传,后端据此拒绝"参数里编出来的 sessionId"。
/// 注意:链接注册表是应用级的(可能属于别的对话),只有当前对话处于多主机模式时才纳入。
export function allowedSessionIds(thread, session) {
  const ids = new Set();
  if (session?.sessionId) ids.add(session.sessionId);
  if (threadLinkMode(thread) === 'multi') {
    for (const id of linkedSessionIds(thread)) ids.add(id);
  }
  return [...ids];
}

/// 线程绑定的主机会话：优先原会话，断开则找同一主机的其他已连接会话；
/// 未绑定的空闲线程在发送时绑定当前标签的主机（bindNow）。
export function agentBinding(thread) {
  if (!thread) return { session: null };
  const sessions = state.sessions;
  const mode = threadLinkMode(thread);
  const active = sessions?.get?.(state.activeId);
  if (mode === 'follow') {
    // 跟随命令窗口:目标恒为当前窗口,窗口没连上就不发(不静默降级为普通对话)。
    if (connected(active)) return { session: active, bindNow: true };
    return { session: null, reason: active ? '当前窗口的主机未连接' : '' };
  }
  if (mode === 'multi') {
    // 多主机:主会话只用于「默认主机」(exec 省略 host 时落在这里)。
    // 绝不能用 thread.hostId/sessionId:那是此前 follow 模式下绑定的单个主机,
    // 与当前链接集合无关 —— 用它会让默认主机悄悄落到一台并非首选的主机上。
    // bindNow 必须为 false:多主机不该把 hostId 改写成「当前标签的主机」。
    const link = linksForThread(thread).find((l) => l.status === 'connected' && l.sessionId);
    if (!link) return { session: null, reason: '已链接的主机都未连接' };
    const live = sessions?.get?.(link.sessionId);
    if (connected(live)) return { session: live };
    return {
      session: {
        sessionId: link.sessionId,
        status: 'connected',
        host: { id: link.hostKey, name: link.hostName },
      },
    };
  }
  if (!thread.hostId) {
    return connected(active) ? { session: active, bindNow: true } : { session: null, reason: '' };
  }
  const own = thread.sessionId && sessions?.get?.(thread.sessionId);
  if (connected(own)) return { session: own };
  const same = [...(sessions?.values?.() || [])].find((s) => connected(s) && hostKeyOf(s.host) === thread.hostId);
  return same ? { session: same } : { session: null, reason: '绑定的主机未连接' };
}

export function bindThreadToSession(thread, session) {
  if (!thread || !session) return;
  rebindThread(thread, {
    hostKey: hostKeyOf(session.host),
    hostLabel: hostLabelOf(session.host),
    sessionId: session.sessionId,
  });
}

/// 撤销线程上的全部授权：自动模式确认、会话授权列表、下载污点。
export function resetThreadGrants(thread) {
  clearTargetGrants(thread);
}

const TAINT_LIMIT = 200;

function addTaint(thread, paths) {
  const merged = [...new Set([...(thread.taint || []), ...paths])];
  thread.taint = merged.slice(-TAINT_LIMIT);
}

/// 授权条目来自后端 allowable（数组：一条命令可能同时要授权下载与修改文件）。
function addGrant(thread, allowable) {
  const list = thread.allowlist || (thread.allowlist = []);
  for (const a of Array.isArray(allowable) ? allowable : [allowable]) {
    for (const key of a?.keys || []) {
      if (!list.some((g) => g.rule === a.rule && g.key === key)) {
        list.push({ rule: a.rule, key, label: a.label });
      }
    }
  }
}

/// 能否让本次发送走工具循环。对话模式不派工具;多主机要求至少一台已链接。
export function agentAvailable(thread) {
  if (threadLinkMode(thread) === 'chat') return false;
  if (!modelToolsCapable()) return false;
  if (threadLinkMode(thread) === 'multi') {
    return linksForThread(thread).some((l) => l.status === 'connected' && l.sessionId);
  }
  const b = agentBinding(thread);
  return !!(b.session && b.session.host?.aiAccess !== 'deny');
}

/// 切换执行模式:chat↔manual 无确认;切 auto 首次弹一次性确认(每线程一次)。
async function setExecMode(thread, mode) {
  if (!thread || threadExecMode(thread) === mode) return;
  if (mode === 'auto' && !thread.autoAcked) {
    const ok = await askConfirm(
      '切到自动后，AI 会直接在该主机执行普通命令；高危、外联、覆盖已有文件的命令仍会停下来等你确认。随时可以切回手动。',
      { title: '切换到自动执行', okText: '切到自动', danger: false },
    );
    if (!ok) return;
    thread.autoAcked = true;
  }
  thread.execMode = mode;
  refreshAgentHostBar();
}

/// 切换主机链接模式。离开多主机即断开本对话的无头链接;进入对话模式清空授权。
async function setLinkModeAndRefresh(thread, mode) {
  if (!thread) return;
  const prev = threadLinkMode(thread);
  if (prev === mode) return;
  if (prev === 'multi' && mode !== 'multi') await clearThreadLinks(thread);
  setLinkMode(thread, mode);
  // 进入多主机但还没链接任何主机:不自动连,由用户在清单里逐台打开(避免意外建链)。
  refreshThreadUi();
  refreshAgentHostBar();
}

/// 多主机清单里切换一台主机的链接。授权随目标集合变化一并清空。
/// 过程分三段在界面上可见:开关立即进入「连接中… / 断开中…」→ 结果(已链接 / 失败原因)。
async function toggleLinkedHost(thread, hostId, on) {
  if (!thread) return;
  if (threadBusy(thread)) { toast('AI 执行中，结束后才能调整主机', 'warn'); refreshAgentHostBar(); return; }
  const before = linkCountFor(thread);
  hostPending.set(hostId, on ? 'connecting' : 'disconnecting');
  refreshAgentHostBar();
  redrawTargetMenu();
  try {
    if (on) {
      const r = await linkHost(thread, hostId);
      if (!r.ok) {
        // 失败:开关回退到关闭 + 弹一次提示(沿用原设计)。
        // 失败原因同时写回池条目,行内保留「链接失败的原因」直到下次操作。
        const link = linksForThread(thread).find((x) => x.hostId === hostId);
        if (link) link.error = r.error || '连接失败';
        toast(`链接失败：${r.error || '未知原因'}`, 'error');
      }
    } else {
      await unlinkHost(thread, hostId);
    }
  } finally {
    hostPending.delete(hostId);
    if (linkCountFor(thread) !== before) {
      // 目标集合变了:授权、污点、hostOs 全部作废,执行档回手动。
      clearTargetGrants(thread);
      thread.execMode = 'manual';
    }
    refreshAgentHostBar();
    redrawTargetMenu({ focusHostId: hostId });
  }
}

/// 「全部开启 / 全部关闭」。
async function toggleAllHosts(thread, on) {
  if (!thread) return;
  if (threadBusy(thread)) { toast('AI 执行中，结束后才能调整主机', 'warn'); refreshAgentHostBar(); return; }
  const hosts = state.hosts || [];
  if (!on) {
    await clearThreadLinks(thread);
  } else {
    const linked = new Set(linksForThread(thread).map((l) => l.hostId));
    const ids = hosts.filter((h) => !linked.has(h.id)).map((h) => h.id);
    if (!ids.length) return;
    const results = await linkHosts(thread, ids);
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) toast(`链接失败：${failed[0].error || '未知原因'}`, 'error');
    else if (failed.length) toast(`${failed.length} 台主机链接失败`, 'error');
  }
  clearTargetGrants(thread);
  thread.execMode = 'manual';
  refreshAgentHostBar();
}

export async function handleTargetAction(view) {
  if (!view) return false;
  if (view.connectable === 'reconnect') {
    const s = [...(state.sessions?.values?.() || [])].find((item) => item && hostKeyOf(item.host) === view.hostKey);
    if (s) {
      toast(`正在重连 ${view.hostLabel || ''}…`, 'info');
      const ok = await reconnectSession(s.sessionId);
      if (!ok) toast(`重连 ${view.hostLabel || ''} 失败`, 'error');
      return ok;
    }
  } else if (view.connectable === 'connect') {
    const h = (state.hosts || []).find((item) => item && (item.id === view.hostKey || hostKeyOf(item) === view.hostKey));
    if (h) {
      const thread = activeAiThread();
      if (thread) thread.pendingConnect = h.id;
      try {
        const session = await connectHost(h.id, null, { reuseExisting: true });
        return !!session && session.status === 'connected';
      } finally {
        if (thread) thread.pendingConnect = null;
        refreshAgentHostBar();
      }
    }
  }
  return false;
}

export function refreshAgentHostBar() {
  const thread = activeAiThread();
  if (!thread) {
    updateModePicker(null);
    updateTargetBar(null);
    updateContextBanner(null);
    return;
  }

  const view = resolveAiTarget({
    thread,
    sessions: state.sessions,
    activeId: state.activeId,
    hosts: state.hosts,
    settings: state.settings,
    busy: threadBusy(thread),
    links: thread ? linksForThread(thread) : [],
  });

  updateTargetBar(view, {
    onAction: () => handleTargetAction(view),
  });

  updateContextBanner(view, thread, {
    onConnect: async () => {
      const ok = await handleTargetAction(view);
      if (ok) {
        thread.sendBlocked = null;
        refreshAgentHostBar();
        $('#ai-input')?.focus();
        toast(`已链接 ${view.hostLabel}，可以发送了`, 'info');
      }
    },
    onSendOnActive: () => {
      const text = ($('#ai-input')?.value || thread.sendBlocked?.text || thread.draft || '').trim();
      thread.sendBlocked = null;
      thread.draft = '';
      const input = $('#ai-input');
      if (input) input.value = '';
      if (view.active?.session) {
        setLinkMode(thread, 'follow');
        ensureThreadForSession(view.active.session);
        const nextThread = activeAiThread();
        if (nextThread && threadLinkMode(nextThread) === 'chat') setLinkMode(nextThread, 'follow');
        aiSend(text);
      }
    },
    onSendAsChat: () => {
      const text = ($('#ai-input')?.value || thread?.sendBlocked?.text || thread?.draft || '').trim();
      setLinkMode(thread, 'chat');
      thread.sendBlocked = null;
      refreshAgentHostBar();
      aiSend(text);
    },
    onDismissBlocked: () => {
      thread.sendBlocked = null;
      refreshAgentHostBar();
    },
  });

  const primary = primarySessionFor(thread);
  const host = primary?.host || {};
  const modeLocked = host.aiAccess === 'manual';
  const mode = modeLocked ? 'manual' : threadExecMode(thread);

  updateModePicker({
    mode,
    modeLocked,
    disabled: !!view.blocked,
    hostSummary: view.hostSummary,
    isRoot: host.username === 'root',
    warn: view.blocked === 'tools'
      ? '当前模型不支持工具调用'
      : (view.blocked === 'deny' ? '该主机设置为禁止 AI 访问' : ''),
    statusText: view.statusText,
    grants: thread.allowlist || [],
  }, {
    onSelectMode: (m) => setExecMode(thread, m),
    onRevoke: (i) => {
      thread.allowlist?.splice(i, 1);
      refreshAgentHostBar();
    },
  });
}

/// 构建顶栏主机菜单数据结构(三种模式 + 多主机清单)。
export function getTargetMenuData() {
  const thread = activeAiThread();
  const isBusy = threadBusy(thread);

  const view = resolveAiTarget({
    thread,
    sessions: state.sessions,
    activeId: state.activeId,
    hosts: state.hosts,
    settings: state.settings,
    busy: isBusy,
    links: thread ? linksForThread(thread) : [],
  });

  const linkMode = view.linkMode;
  const activeSess = state.sessions?.get?.(state.activeId);
  const followHost = connected(activeSess) ? hostLabelOf(activeSess.host) : null;
  const links = linksForThread(thread);
  const linkedByHostId = new Map(links.map((l) => [l.hostId, l]));

  let notice = '';
  if (isBusy) notice = 'AI 执行中，结束后才能切换主机';

  const query = getTargetMenuQuery();
  const allHosts = state.hosts || [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? allHosts.filter((h) => `${h.name || ''} ${h.host || h.ip || ''}`.toLowerCase().includes(q))
    : allHosts;
  const hosts = filtered.map((h) => {
    const link = linkedByHostId.get(h.id);
    const pending = hostPendingOf(h.id);
    return {
      hostId: h.id,
      name: h.name || h.host || h.id,
      address: `${h.username || 'root'}@${h.host || h.ip || ''}`,
      linked: !!link,
      // 中间态优先:链接成功前 linked 仍为 false,断开成功后条目已消失。
      status: pending || link?.status || 'idle',
      error: link?.error || null,
      busy: isBusy || !!pending,
    };
  });

  return {
    notice,
    disabled: isBusy,
    linkMode,
    linkCount: view.linkedCount,
    query,
    hosts,
    chat: { checked: linkMode === 'chat' },
    follow: {
      checked: linkMode === 'follow',
      hostLabel: followHost,
    },
    multi: {
      checked: linkMode === 'multi',
      showHosts: linkMode === 'multi',
    },
  };
}

/// 正在链接/断开的 hostId → 'connecting' | 'disconnecting'。
/// 链接成功前条目还没进 thread.linkedHostIds,断开成功后条目已被摘掉 ——
/// 中间态只能由这里承载,否则界面开关会在等待期间闪回原始状态。
const hostPending = new Map();

export function hostPendingOf(hostId) {
  return hostPending.get(hostId) || '';
}

let targetMenuQuery = '';
export function getTargetMenuQuery() { return targetMenuQuery; }
export function setTargetMenuQuery(q) { targetMenuQuery = String(q || ''); }

/// 菜单原地重绘(不收起):模式切换/主机开关后立刻反映到 switch、计数与清单。
/// focus 用来把焦点放回刚操作的那一项,连续操作不丢位置。
export function redrawTargetMenu({ focusMode, focusHostId } = {}) {
  const menu = $('#ai-target-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  renderTargetMenu(getTargetMenuData(), targetMenuHandlers(), { focusMode, focusHostId });
}

/// 顶栏主机菜单的动作集合。模式切换走 setLinkModeAndRefresh;开关主机走 toggleLinkedHost。
/// 所有动作都不收起菜单 —— 连续点几个开关是常态,每次都要重开菜单不合理。
export function targetMenuHandlers() {
  const thread = () => activeAiThread();
  let searchTimer = null;
  return {
    onSelectMode: (mode) => {
      setTargetMenuQuery('');
      setLinkModeAndRefresh(thread(), mode).then(() => redrawTargetMenu({ focusMode: mode }));
    },
    onToggleHost: (hostId, on) => {
      toggleLinkedHost(thread(), hostId, on).then(() => redrawTargetMenu({ focusHostId: hostId }));
    },
    onToggleAll: (on) => {
      toggleAllHosts(thread(), on).then(() => redrawTargetMenu());
    },
    onClearHosts: async () => {
      const t = thread();
      if (!t) return;
      if (threadBusy(t)) { toast('AI 执行中，结束后才能调整主机', 'warn'); return; }
      await clearThreadLinks(t);
      clearTargetGrants(t);
      t.execMode = 'manual';
      refreshAgentHostBar();
      redrawTargetMenu();
    },
    onSearch: (q) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        setTargetMenuQuery(q);
        // 只重绘清单,不重建整个菜单(否则输入框会失焦)。
        const data = getTargetMenuData();
        renderTargetMenu(data, targetMenuHandlers());
        const input = $('#ai-target-menu-list .ai-target-hosts-search .inp');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      }, 120);
    },
  };
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
  const isMulti = threadLinkMode(thread) === 'multi';
  // 多主机不写 thread.hostId/sessionId:那是「单个绑定主机」的字段,多主机下写了会给
  // 后续 follow/auto 判定留下污染(表现为下次发送仍按旧主机处理)。
  if (!isMulti) {
    if (binding.bindNow) bindThreadToSession(thread, session);
    else if (session) thread.sessionId = session.sessionId;
  }

  // 多主机:把「主机名 → 已链接会话」的解析表固定在本轮入口处(目标集合本轮不再变)。
  const links = linksForThread(thread);
  const hostIndex = new Map();
  for (const l of links) {
    if (l.hostName) hostIndex.set(String(l.hostName).toLowerCase(), l);
  }
  const isMultiTurn = isMulti && links.length > 0;
  // 后端白名单:多主机 = 全部已链接会话;单主机 = 该会话本身。
  const allowedIds = allowedSessionIds(thread, session);

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
    // 授权按钮只在自动模式出现：手动模式的语义就是每条命令都要看到。
    // 多主机模式下不提供「本会话总是允许」:授权按单主机维度,主机集合一变即失效,给了会误导。
    canAllow: () => !isMultiTurn && thread.execMode === 'auto' && session?.host?.aiAccess !== 'manual',
    onAllowAlways: (allowable) => { addGrant(thread, allowable); refreshAgentHostBar(); },
    audit: (e) => api('ai:tool-audit', {
      ...e,
      sessionId: e.sessionId || session?.sessionId,
      host: e.host || hostLabelOf(session?.host),
    }).catch(() => {}),
    canUseSaved: () => !!(session?.host?.hasPassword || session?.host?.password),
  });
  const host = session?.host || {};

  // 多主机时模型按名字指名主机;名字解析不到就回错误给模型,绝不静默回落到默认主机。
  const resolveExecSession = (req) => {
    if (!isMultiTurn) return { sessionId: req.sessionId };
    const wanted = String(req.args?.host || '').trim();
    if (wanted) {
      const link = hostIndex.get(wanted.toLowerCase());
      if (!link || link.status !== 'connected') {
        return { error: `未知或未链接的主机「${wanted}」。可用的主机：${links.filter((l) => l.status === 'connected').map((l) => l.hostName).join('、') || '（无）'}` };
      }
      return { sessionId: link.sessionId };
    }
    return { sessionId: session?.sessionId || links.find((l) => l.status === 'connected')?.sessionId };
  };

  // 回合起点：本轮挂进消息区的节点都打上这个 token，收口据此只认本轮的节点。
  // 放在 try 之前、runAgentTurn 之前——第一次挂载前就必须有 token。
  const turnToken = beginAiTurn(thread);

  try {
    // 请求失败由流式气泡自己展示（⚠️ 错误），这里不重复提示。
    await runAgentTurn({
      thread,
      userMessage: content,
      systemPrompt: buildHostSystemPrompt({
        hostName: hostLabelOf(host), user: host.username, isRoot: host.username === 'root',
        os: thread.hostOs, cwd: session?.remoteCwd, execMode: threadExecMode(thread),
        linkedHosts: isMultiTurn
          ? links.filter((l) => l.status === 'connected').map((l) => l.hostName)
          : null,
      }),
      // 多主机:exec 带 host 参数、不下发 read_terminal(无头主机没有终端语义)。
      tools: isMultiTurn ? AI_AGENT_TOOLS_MULTI : AI_AGENT_TOOLS,
      sessionId: session?.sessionId,
      getMode: () => (host.aiAccess === 'manual' ? 'manual' : threadExecMode(thread)),
      chat: (req) => agentChat(thread, req),
      execTool: async (req) => {
        const target = resolveExecSession(req);
        if (target.error) return { status: 'error', code: 'unknown_host', message: target.error };
        // 授权列表与污点只随 exec 带给后端；命中与否由后端在全部补判之后判定。
        // 多主机不携带授权(上面已禁用「总是允许」)。
        const policy = req.tool === 'exec'
          ? {
            allow: !isMultiTurn && req.mode === 'auto'
              ? (thread.allowlist || []).map(({ rule, key }) => ({ rule, key }))
              : [],
            tainted: isMultiTurn ? [] : (thread.taint || []),
          }
          : {};
        const res = await api('ai:tool-exec', {
          ...req,
          ...policy,
          sessionId: target.sessionId,
          linkedSessions: allowedIds,
        });
        if (req.tool === 'host_info' && res?.meta?.os && !isMultiTurn) thread.hostOs = res.meta.os;
        if (!isMultiTurn && Array.isArray(res?.downloads) && res.downloads.length) addTaint(thread, res.downloads);
        return res;
      },
      cancelTool: (toolRunId) => api('ai:tool-cancel', { toolRunId }),
      readTerminal: (lines) => readTerminalLines(state.sessions?.get?.(session?.sessionId) || session, lines),
      adapter: {
        ...adapter,
        onToolsUnsupported: () => toast('当前模型不支持工具调用，本次改为普通对话', 'info'),
      },
      signal: ctrl.signal,
      sudoCache,
      uuid: () => crypto.randomUUID(),
    });
  } finally {
    // 先收口再清忙碌态：折叠改变了节点层级与高度，贴底一次性完成。
    endAiTurn(thread, turnToken);
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
