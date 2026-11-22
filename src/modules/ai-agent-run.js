// AI 工具循环的接线：线程与主机范围（scope）、模型工具能力、每轮请求与界面适配。
import { $, api, askConfirm, state, toast } from './core.js';
import { buildHostSystemPrompt, runAgentTurn } from './ai-agent.js';
import {
  clearTargetGrants, groupHostsByFolder, groupState, hostKeyOf, hostLabelOf,
  isModelToolsCapable, resolveAiTarget, setGroup, setThreadScope, snapshotRunScope,
  threadExecMode, threadScope, toggleHost, toolSupportKey, validateToolHost,
} from '../shared/ai-target-state.js';
import {
  closeTargetMenu, createAgentAdapter, createAiNoticeElement, renderTargetMenu,
  updateModePicker, updateTargetBar,
} from './ai-agent-ui.js';
import { AI_AGENT_TOOLS, AI_AGENT_TOOLS_MULTI } from '../shared/ai-tools-schema.js';
import {
  getComposerChips, refreshComposerChipsScope, removeOutChips,
} from './ai-composer.js';
import { readTerminalLines } from './terminal.js';
import {
  clearThreadLinks, linkHost, linkedSessionIds, linksForThread, reviveLink, unlinkHost,
} from './ai-links.js';
import {
  activeAiThread, aiRequest, aiSend, aiStickScroll, appendToThreadView, beginAiTurn,
  clearBubbleState, endAiTurn, markBubblePending, refreshThreadScopeChips,
  refreshThreadUi, renderAiMessage, setAiBusy, threadBusy, trimAiHistory,
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

function hostForKey(hostKey) {
  if (!hostKey) return null;
  const fromHosts = (state.hosts || []).find((h) => hostKeyOf(h) === hostKey);
  if (fromHosts) return fromHosts;
  for (const s of state.sessions?.values?.() || []) {
    if (s?.host && hostKeyOf(s.host) === hostKey) return s.host;
  }
  return null;
}

function hostUnreachableReason(host, hostKey) {
  if (host && (host.unreachable || host.statusError)) {
    return typeof host.statusError === 'string' && host.statusError ? host.statusError : '连接超时';
  }
  for (const s of state.sessions?.values?.() || []) {
    if (s?.host && hostKeyOf(s.host) === hostKey && (s.status === 'error' || s.status === 'timeout' || s.lastError)) {
      return s.lastError || '连接超时';
    }
  }
  return '';
}

/// 根据 hostKey 查找当前已连接的终端会话或无头链接会话；
/// 若尚未建终端标签且主机在 state.hosts 中可达（非 unreachable），则提供无头通道会话（D.1 解耦）。
function connectedSessionForKey(hostKey) {
  if (!hostKey) return null;
  const sessions = state.sessions;
  if (sessions?.values) {
    for (const s of sessions.values()) {
      if (connected(s) && hostKeyOf(s.host) === hostKey) return s;
    }
  }
  const link = state.aiLinks?.get?.(hostKey);
  if (link && link.status === 'connected' && link.sessionId) {
    const live = sessions?.get?.(link.sessionId);
    if (connected(live)) return live;
    return {
      sessionId: link.sessionId,
      status: 'connected',
      host: hostForKey(hostKey) || { id: link.hostKey || hostKey, name: link.hostName || hostKey },
    };
  }
  // 没有任何活着的会话就是「未连接」。这里绝不能凭 hostKey 拼一个 sessionId 出来：
  // 拼出来的 id 后端表里并不存在，工具调用只会回 session_gone「会话已断开」，
  // 用户看到的是一串失败步骤，而不是「这台主机未连接、请重连」。
  return null;
}

/// 本对话当前可执行的会话集合（多台 scope 时返回所有已连接会话 ID）。
export function linkedSessionsFor(thread) {
  const sc = threadScope(thread, state.hosts);
  if (sc.length <= 1) return null;
  return allowedSessionIds(thread, null);
}

/// 主执行会话（工具循环用）：在 thread.scope 内取第一台已连接的会话（不再读取当前活动终端窗口）。
function primarySessionFor(thread) {
  if (!thread) return null;
  return agentBinding(thread).session;
}

/// 后端允许执行的全部会话 id：严格限制在 thread.scope 范围内已连接的会话。
export function allowedSessionIds(thread, session) {
  const ids = new Set();
  if (session?.sessionId) ids.add(session.sessionId);
  const sc = threadScope(thread, state.hosts);
  for (const key of sc) {
    const s = connectedSessionForKey(key);
    if (s?.sessionId) ids.add(s.sessionId);
  }
  for (const id of linkedSessionIds(thread)) ids.add(id);
  return [...ids];
}

/// 线程在当前 scope 内的主机会话绑定（与当前活动标签页 state.activeId 彻底解耦）：
/// - scope 为空 → 纯对话（session: null）
/// - scope 非空 → 按 scope 顺序找第一台已连接的会话作为默认通道
export function agentBinding(thread) {
  if (!thread) return { session: null };
  const sc = threadScope(thread, state.hosts);
  if (!sc.length) {
    return { session: null, reason: '' };
  }
  for (const key of sc) {
    const s = connectedSessionForKey(key);
    if (s) return { session: s };
  }
  return {
    session: null,
    unreachableOnly: true,
    reason: sc.length === 1 ? '所选主机未连接' : '所选范围内的主机均未连接',
  };
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

/// 能否让本次发送走工具循环：scope 非空、模型支持工具、且范围内至少有一台未禁止 AI 访问。
/// 若范围内仅包含不可达主机（如 mq-worker-04），也进入 runAgentSend 以便触发发送前不可达黄条预检（L19）。
export function agentAvailable(thread) {
  const sc = threadScope(thread, state.hosts);
  if (!sc.length) return false;
  if (!modelToolsCapable()) return false;
  const b = agentBinding(thread);
  if (b.session) return b.session.host?.aiAccess !== 'deny';
  return sc.some((k) => {
    const h = hostForKey(k);
    return !h || h.aiAccess !== 'deny';
  });
}

/// 切换执行模式：切回 manual 无确认，manual→auto 首次弹一次性确认（每线程一次），
/// 切 full 每次都要确认 —— 托管档不再有任何确认卡兜底。
/// 注意（F18）：范围 ≥ 2 台时绝不禁用完全托管。
async function setExecMode(thread, mode) {
  if (!thread || threadExecMode(thread) === mode) return;
  if (mode === 'auto' && !thread.autoAcked) {
    const ok = await askConfirm(
      '切到自动后，AI 会直接在所选主机范围内执行普通命令；高危、外联、覆盖已有文件的命令仍会停下来等你确认。随时可以切回手动。',
      { title: '切换到自动执行', okText: '切到自动', danger: false },
    );
    if (!ok) return;
    thread.autoAcked = true;
  }
  if (mode === 'full') {
    const ok = await askConfirm(
      '完全托管后，AI 会连续在所选主机范围内执行命令，任何命令都不再逐条确认：删除数据、格式化、改配置、上传文件都会直接生效，出错无法撤销。\n'
      + '仅在你能承受范围内主机被修改、并且随时盯着执行过程时使用。调整主机范围后会自动退回手动确认。',
      { title: '切换到完全托管', okText: '我了解风险，切到托管', danger: true },
    );
    if (!ok) return;
  }
  thread.execMode = mode;
  refreshAgentHostBar();
}

/// 同步输入框内已插入的 `.ai-chip` 与当前会话 `scope` 的一致性（F13 / A4）：
/// 如有被移出范围的 chip，将其置为 `data-out="true"`，展示 `#ai-chip-warn` 阻塞提示条并禁用发送按钮。
export function syncComposerScopeCheck() {
  const thread = activeAiThread();
  const sc = thread ? threadScope(thread, state.hosts) : [];
  const { outCount, outLabels } = refreshComposerChipsScope(sc);
  const warnEl = $('#ai-chip-warn');
  const warnText = $('#ai-chip-warn-text');
  const sendBtn = $('#ai-send');

  if (warnEl) {
    const show = outCount > 0;
    warnEl.classList.toggle('hidden', !show);
    if (show) warnEl.removeAttribute('hidden');
    else warnEl.setAttribute('hidden', '');
    if (warnText && show) {
      const names = [...new Set(outLabels)].map((n) => `@${n}`).join('、');
      warnText.textContent = `${names} 已不在允许范围`;
    }
  }
  if (sendBtn && !state.aiReq && !threadBusy(thread)) {
    sendBtn.disabled = outCount > 0;
  }
  return outCount;
}

/// 获取当前会话 `scope` 内的主机列表（供 `@` 候选浮层 `#ai-mention-pop` 使用，F9）。
export function getScopeMentionHosts() {
  const thread = activeAiThread();
  if (!thread) return [];
  const sc = threadScope(thread, state.hosts);
  const connectedKeys = new Set(
    [...(state.sessions?.values?.() || [])]
      .filter((s) => connected(s))
      .map((s) => hostKeyOf(s.host))
      .filter(Boolean),
  );
  const allHosts = state.hosts || [];
  const byKey = new Map();
  for (const h of allHosts) {
    const k = hostKeyOf(h);
    if (k) byKey.set(k, h);
  }
  return sc.map((key) => {
    const h = byKey.get(key) || { id: key, name: key };
    const name = h.name || h.host || key;
    const hostAddr = h.host || h.ip || '';
    const user = h.username || 'root';
    return {
      hostKey: key,
      hostId: key,
      name,
      label: name,
      group: h.group || '我的主机',
      address: hostAddr ? `${hostAddr} · ${user}` : user,
      connected: connectedKeys.has(key),
    };
  });
}

/// 将输入框内所有 `data-out="true"` 的失效 chip 重新加回当前会话 `thread.scope`（A4「加回范围」按钮）。
export function restoreOutChipsToScope() {
  const thread = activeAiThread();
  if (!thread) return;
  const chips = getComposerChips();
  const outKeys = chips.filter((c) => c.out && c.hostKey).map((c) => c.hostKey);
  if (!outKeys.length) return;
  const cur = threadScope(thread, state.hosts);
  const next = [...new Set([...cur, ...outKeys])];
  setThreadScope(thread, next, state.hosts);
  thread.hostId = thread.scope[0] || null;
  const firstHost = (state.hosts || []).find((h) => hostKeyOf(h) === thread.hostId);
  thread.hostName = firstHost ? hostLabelOf(firstHost) : null;
  refreshThreadUi();
  refreshAgentHostBar();
  redrawTargetMenu();
}

/// 一键移除输入框内所有 `data-out="true"` 的失效 chip（A4「移除引用」按钮）。
export function removeOutChipsFromComposer() {
  removeOutChips();
  syncComposerScopeCheck();
}

export function refreshAgentHostBar() {
  const thread = activeAiThread();
  if (!thread) {
    updateModePicker(null);
    updateTargetBar(null);
    return;
  }

  const view = resolveAiTarget({
    thread,
    sessions: state.sessions,
    hosts: state.hosts,
    settings: state.settings,
    busy: threadBusy(thread),
    links: thread ? linksForThread(thread) : [],
  });

  updateTargetBar(view);
  syncComposerScopeCheck();

  const primary = primarySessionFor(thread);
  const host = primary?.host || view.singleHost || {};
  const modeLocked = view.hosts?.some((h) => h?.aiAccess === 'manual') || host.aiAccess === 'manual';
  const mode = modeLocked ? 'manual' : threadExecMode(thread);

  updateModePicker({
    mode,
    modeLocked,
    showModeControl: view.showModeControl,
    disabled: !!view.blocked,
    hostSummary: view.hostSummary,
    isRoot: host.username === 'root',
    warn: view.blocked === 'tools'
      ? '当前模型不支持工具调用'
      : (view.blocked === 'deny' ? '所选主机设置为禁止 AI 访问' : ''),
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

/// 构建输入框左下角「主机范围选择器」的数据结构（P5：按目录分组 + 三态方框 + 搜索扁平化，A6 / D1–D4）。
const expandedFoldersByThread = new Map();
let lastDefaultedThreadId = null;

function getExpandedFolderSet(thread, groups, scopeSet) {
  const tid = thread?.id || '__default__';
  if (!expandedFoldersByThread.has(tid) || lastDefaultedThreadId !== tid) {
    lastDefaultedThreadId = tid;
    const initial = new Set();
    for (const g of groups) {
      if (g.keys.some((k) => scopeSet.has(k))) initial.add(g.name);
    }
    expandedFoldersByThread.set(tid, initial);
  }
  return expandedFoldersByThread.get(tid);
}

export function resetExpandedFoldersForMenu() {
  lastDefaultedThreadId = null;
}

export function getTargetMenuData() {
  const thread = activeAiThread();
  const isBusy = threadBusy(thread);

  const view = resolveAiTarget({
    thread,
    sessions: state.sessions,
    hosts: state.hosts,
    settings: state.settings,
    busy: isBusy,
    links: thread ? linksForThread(thread) : [],
  });

  const scopeSet = new Set(view.scope);
  const connectedKeys = new Set();
  const errorKeys = new Map();
  for (const s of state.sessions?.values?.() || []) {
    const k = hostKeyOf(s?.host);
    if (!k) continue;
    if (connected(s)) connectedKeys.add(k);
    else if (s?.status === 'error' || s?.status === 'timeout' || s?.lastError) {
      errorKeys.set(k, s.lastError || '连接超时');
    }
  }

  let notice = '';
  if (isBusy) notice = 'AI 执行中，调整范围仅对下一条消息生效';

  const query = getTargetMenuQuery();
  const allHosts = state.hosts || [];
  const q = query.trim().toLowerCase();

  const toHostItem = (h) => {
    const key = hostKeyOf(h);
    const isConn = connectedKeys.has(key);
    const errText = h.unreachable || h.statusError || errorKeys.get(key)
      ? (typeof h.statusError === 'string' && h.statusError ? h.statusError : (errorKeys.get(key) || '连接超时'))
      : '';
    const hostAddr = h.host || h.ip || '';
    const user = h.username || 'root';
    return {
      hostId: key,
      name: h.name || h.host || key,
      group: h.group || '我的主机',
      address: hostAddr ? `${hostAddr} · ${user}` : user,
      checked: scopeSet.has(key),
      connected: isConn,
      connectState: h.connectState === 'connecting' ? 'connecting' : '',
      unreachable: !!errText,
      errorText: errText,
      status: errText ? 'error' : (isConn ? 'connected' : 'idle'),
    };
  };

  const allHostItems = allHosts.map(toHostItem);
  const rawGroups = groupHostsByFolder(allHosts, '我的主机');
  const expandedSet = getExpandedFolderSet(thread, rawGroups, scopeSet);

  const groups = rawGroups.map((g) => {
    const gHosts = g.hosts.map(toHostItem);
    const selectedCount = g.keys.filter((k) => scopeSet.has(k)).length;
    return {
      name: g.name,
      keys: g.keys,
      hosts: gHosts,
      totalCount: gHosts.length,
      selectedCount,
      state: groupState(view.scope, g.keys), // 'all' | 'part' | 'none'
      expanded: expandedSet.has(g.name),
    };
  });

  const filteredHosts = q
    ? allHostItems.filter((h) => `${h.name || ''} ${h.address || ''} ${h.group || ''}`.toLowerCase().includes(q))
    : allHostItems;

  // 已选主机名称预览（用于顶部常驻汇总条：web-prod-01、db-prod-02 +1）
  const byKey = new Map(allHostItems.map((h) => [h.hostId, h.name]));
  const selectedNames = view.scope.map((k) => byKey.get(k) || k);

  return {
    notice,
    disabled: false,
    scope: view.scope,
    scopeCount: view.count,
    selectedNames,
    summaryLabel: view.hostSummary,
    query,
    hosts: filteredHosts,
    groups,
    groupCount: groups.length,
    totalCount: allHosts.length,
  };
}

let targetMenuQuery = '';
export function getTargetMenuQuery() { return targetMenuQuery; }
export function setTargetMenuQuery(q) { targetMenuQuery = String(q || ''); }

/// 掉线即出范围：链接池里已变成 error 的主机，从所有对话的 scope 里摘掉。
/// 「断开」不是一种开关外观（用户拍板：一律按 off 渲染），所以范围与可执行性必须一致 ——
/// 连接没了就不该继续留在范围里发命令。
export async function pruneDroppedScope() {
  const threads = [...(state.aiThreads?.values?.() || [])];
  let changed = false;
  for (const t of threads) {
    if (!t || !Array.isArray(t.scope) || !t.scope.length) continue;
    const dead = linksForThread(t)
      .filter((l) => l && l.status === 'error')
      .map((l) => l.hostId)
      .filter(Boolean);
    const droppedNames = [];
    for (const key of dead) {
      const host = (state.hosts || []).find((h) => hostKeyOf(h) === key);
      droppedNames.push(host ? hostLabelOf(host) : key);
      // 走 unlinkHost 而不是直接改 scope：引用计数要跟着降，无头会话才好真正断开
      await unlinkHost(t, key).catch(() => {});
      changed = true;
    }
    if (droppedNames.length) {
      // 只提示一次「为什么开关自己关掉了」；不弹循环、不留持久条
      toast(`${droppedNames.join('、')} 已断开，已移出本会话范围`, 'warn');
    }
  }
  if (changed) {
    refreshThreadUi();
    refreshAgentHostBar();
    redrawTargetMenu();
  }
  return changed;
}

/// 菜单原地重绘（不收起）：勾选/取消主机后立即刷新。
export function redrawTargetMenu({ focusHostId } = {}) {
  const menu = $('#ai-scope-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  renderTargetMenu(getTargetMenuData(), targetMenuHandlers(), { focusHostId });
}

/// 主机范围选择器的交互处理器（F2 / F3：范围随时可改，只影响后续消息；B.1–B.4 全部目录与搜索分支）。
export function targetMenuHandlers() {
  const thread = () => activeAiThread();
  let searchTimer = null;
  const syncAfterScopeChange = (t, focusOpts) => {
    t.hostId = t.scope[0] || null;
    const firstHost = (state.hosts || []).find((h) => hostKeyOf(h) === t.hostId);
    t.hostName = firstHost ? hostLabelOf(firstHost) : null;
    if (!t.scope.length) clearThreadLinks(t);
    if (threadBusy(t) && t.agentRun) {
      const view = resolveAiTarget({
        thread: t,
        sessions: state.sessions,
        hosts: state.hosts,
        settings: state.settings,
        busy: true,
        links: linksForThread(t),
      });
      const text = `已调整主机范围为「${view.hostSummary}」，将从下一轮消息起生效（当前轮继续按原范围执行）`;
      if (t.agentRun.scopeChangeNoticeEl && t.agentRun.scopeChangeNoticeEl.__label) {
        t.agentRun.scopeChangeNoticeEl.__label.textContent = text;
      } else {
        const noticeEl = createAiNoticeElement({
          kind: 'scope-next-turn',
          level: 'info',
          iconName: 'info',
          text,
        });
        t.agentRun.scopeChangeNoticeEl = noticeEl;
        appendToThreadView(t, noticeEl);
      }
    }
    refreshThreadScopeChips(t);
    refreshThreadUi();
    refreshAgentHostBar();
    redrawTargetMenu(focusOpts);
  };
  return {
    // 开关即连接：开 = 先转 connecting，连上才进范围；连不上回退 off 并在行里留原因。
    // 关 = 解除本对话对它的引用（无头会话引用归零才真断，复用中的标签会话不动）。
    onToggleHost: async (hostKey) => {
      const t = thread();
      if (!t || !hostKey) return;
      const cur = threadScope(t, state.hosts);
      const host = (state.hosts || []).find((h) => hostKeyOf(h) === hostKey);
      if (host && host.connectState === 'connecting') return; // 正在连，忽略重复点

      if (cur.includes(hostKey)) {
        await unlinkHost(t, hostKey);
        if (host) { host.unreachable = false; host.statusError = ''; }
        syncAfterScopeChange(t, { focusHostId: hostKey });
        return;
      }

      if (host) { host.connectState = 'connecting'; host.statusError = ''; }
      redrawTargetMenu({ focusHostId: hostKey });

      const res = await linkHost(t, hostKey).catch((e) => ({ ok: false, error: String(e?.message || '连接失败') }));
      if (host) host.connectState = '';
      const name = host ? hostLabelOf(host) : hostKey;

      if (res?.ok) {
        if (host) {
          host.unreachable = false;
          host.statusError = '';
          if (host.status === 'error') host.status = 'connected';
        }
        syncAfterScopeChange(t, { focusHostId: hostKey });
        return;
      }

      // 连不上：开关回退到 off，行内留失败原因（悬停可看全文）
      const reason = String(res?.error || '连接失败').trim() || '连接失败';
      if (host) {
        host.unreachable = true;
        host.statusError = reason;
        host.status = 'error';
      }
      redrawTargetMenu({ focusHostId: hostKey });
      toast(`${name} 连接失败：${reason}`, 'error');
    },
    onToggleFolderExpand: (folderName) => {
      const t = thread();
      if (!folderName) return;
      const rawGroups = groupHostsByFolder(state.hosts || [], '我的主机');
      const scopeSet = new Set(threadScope(t, state.hosts));
      const expandedSet = getExpandedFolderSet(t, rawGroups, scopeSet);
      if (expandedSet.has(folderName)) expandedSet.delete(folderName);
      else expandedSet.add(folderName);
      redrawTargetMenu();
    },
    onToggleGroup: (folderName, keys) => {
      const t = thread();
      if (!t || !Array.isArray(keys) || !keys.length) return;
      const cur = threadScope(t, state.hosts);
      const st = groupState(cur, keys);
      // B.1 #2/#3/#4：未选(none) 或 部分(part) 点方框 → 整目录全选；全选(all) 点方框 → 整目录全不选
      const turnOn = st !== 'all';
      const next = setGroup(cur, keys, turnOn);
      setThreadScope(t, next, state.hosts);
      syncAfterScopeChange(t);
    },
    onSelectSearchResults: (keys) => {
      const t = thread();
      if (!t || !Array.isArray(keys) || !keys.length) return;
      // B.3 #12 / L15：点「全选结果」追加当前搜索结果集（>10 条时最多取前 10 条），不清空原有选择
      const toAdd = keys.length > 10 ? keys.slice(0, 10) : keys;
      const cur = threadScope(t, state.hosts);
      const next = setGroup(cur, toAdd, true);
      setThreadScope(t, next, state.hosts);
      syncAfterScopeChange(t);
    },
    onToggleAll: (on) => {
      const t = thread();
      if (!t) return;
      const allKeys = (state.hosts || []).map(hostKeyOf).filter(Boolean);
      setThreadScope(t, on ? allKeys : [], state.hosts);
      syncAfterScopeChange(t);
    },
    onClearHosts: () => {
      const t = thread();
      if (!t) return;
      setThreadScope(t, [], state.hosts);
      syncAfterScopeChange(t);
    },
    onClearSearch: () => {
      clearTimeout(searchTimer);
      setTargetMenuQuery('');
      renderTargetMenu(getTargetMenuData(), targetMenuHandlers());
      const input = $('#ai-scope-menu-list .ai-target-hosts-search .inp');
      if (input) input.focus();
    },
    onDone: () => {
      closeTargetMenu({ focusTrigger: true });
    },
    onSearch: (q) => {
      clearTimeout(searchTimer);
      setTargetMenuQuery(q);
      const data = getTargetMenuData();
      renderTargetMenu(data, targetMenuHandlers());
      const input = $('#ai-scope-menu-list .ai-target-hosts-search .inp');
      if (input) { input.focus(); input.setSelectionRange?.(input.value.length, input.value.length); }
    },
  };
}

const EXEC_MODE_LABELS = {
  manual: '手动确认',
  auto: '自动执行',
  full: '完全托管',
};

function appendClarifyHostPicks(bubble, thread, scopeHosts, replyText) {
  if (!bubble || !Array.isArray(scopeHosts) || scopeHosts.length < 2) return;
  const text = String(replyText || '');
  const isQuestion = /(哪一台|哪台|请选择|请确认|要在哪|指定.*主机|[?？])/i.test(text);
  if (!isQuestion) return;
  const body = bubble.querySelector?.('.ai-body');
  if (!body || body.querySelector?.('.ai-ask-picks')) return;

  const picksWrap = document.createElement('div');
  picksWrap.className = 'ai-ask-picks';
  for (const h of scopeHosts) {
    if (!h || h.unreachable) continue;
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'ai-ask-pick';
    pickBtn.dataset.hostKey = h.hostKey || h.hostId || '';
    pickBtn.dataset.hostName = h.name || '';
    const dot = document.createElement('span');
    dot.className = 'ai-ask-dot';
    const lbl = document.createElement('span');
    lbl.className = 'ai-ask-name';
    lbl.textContent = '@' + String(h.name || h.hostKey).replace(/^@/, '');
    pickBtn.append(dot, lbl);
    pickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (threadBusy(thread)) return;
      const hostName = h.name || h.hostKey;
      const hostKey = h.hostKey || h.hostId || hostName;
      aiSend(`@${hostName}`, '', {
        mentions: [{ hostKey, label: hostName }],
      });
    });
    picksWrap.appendChild(pickBtn);
  }
  if (!picksWrap.children.length) return;
  const hint = document.createElement('div');
  hint.className = 'ai-ask-hint';
  hint.textContent = '也可以直接说“南京那台”，或打 @ 指定';
  body.append(picksWrap, hint);
}

/// 一轮模型请求：沿用现有流式气泡；只有工具调用、没有正文的轮次不留空气泡。
async function agentChat(thread, { messages, tools, scopeHosts, isMultiTurn }) {
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
  const hasCalls = Array.isArray(r?.toolCalls) && r.toolCalls.some((c) => c && c.name);
  if (isMultiTurn && !hasCalls && r?.text) {
    appendClarifyHostPicks(bubble, thread, scopeHosts, r.text);
  }
  return { content: r.text || '', toolCalls: r.toolCalls, reasoning: r.reasoning, thinkingBlocks: r.thinkingBlocks, aborted: !!r.aborted };
}

export async function runAgentSend(thread, binding, { content, display, md, mentions = [] }) {
  // F22：回合开始时拍下 runScope 快照，回合进行中用户在选择器里改范围不影响当前回合的白名单判定
  const runScope = snapshotRunScope(threadScope(thread, state.hosts));
  const runExecMode = threadExecMode(thread);

  const scopeEntries = [];
  const reachableEntries = [];
  const unreachableEntries = [];
  const hostIndex = new Map();
  const connectedScopeNames = [];

  // 预检补连：范围里「开关是开的」但池里的会话已经没了（合盖睡眠、网络切换后 keepalive 到期），
  // 发回合前先就地重连一次 —— 用户打开过的主机就应该能用，而不是回一句「会话已断开」。
  // 只有一台会话都没有的主机才走这条路，正常回合零额外延迟；整轮最多等 6s，超时按未连接处理。
  const needsRevive = runScope.filter((key) => {
    const h = hostForKey(key);
    if (!h || hostUnreachableReason(h, key)) return false;
    return !connectedSessionForKey(key);
  });
  if (needsRevive.length) {
    await Promise.race([
      Promise.allSettled(needsRevive.map((key) => reviveLink(thread, key))),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
  }

  for (const key of runScope) {
    const h = hostForKey(key) || { id: key, name: key };
    const name = hostLabelOf(h) || h.name || key;
    const errReason = hostUnreachableReason(h, key);
    const s = errReason ? null : connectedSessionForKey(key);
    const hostAddr = h.host || h.ip || '';
    const user = h.username || 'root';
    const entry = {
      hostKey: key,
      hostId: key,
      name,
      group: h.group || '我的主机',
      address: hostAddr ? `${hostAddr} · ${user}` : user,
      unreachable: !!errReason || !s,
      errorText: errReason || (!s ? '未连接' : ''),
      session: s,
      host: h,
    };
    scopeEntries.push(entry);
    if (!entry.unreachable && s) {
      reachableEntries.push(entry);
      connectedScopeNames.push(name);
      const record = {
        hostKey: key,
        sessionId: s.sessionId,
        hostName: name,
        host: h,
        status: 'connected',
      };
      hostIndex.set(String(key).toLowerCase(), record);
      hostIndex.set(String(name).toLowerCase(), record);
      if (hostAddr) hostIndex.set(String(hostAddr).toLowerCase(), record);
    } else {
      unreachableEntries.push(entry);
    }
  }

  renderAiMessage('user', display, { md, thread, mentions });

  // L19：发送前/回合启动不可达主机预检黄条
  const normalizedMentions = (Array.isArray(mentions) ? mentions : []).map((m) => ({
    hostKey: String(m?.hostKey || m?.key || '').trim(),
    label: String(m?.label || m?.name || m?.hostKey || '').trim(),
  })).filter((m) => m.hostKey || m.label);

  if (unreachableEntries.length > 0) {
    const mentionedKeys = new Set(normalizedMentions.map((m) => m.hostKey.toLowerCase()));
    const mentionedLabels = new Set(normalizedMentions.map((m) => m.label.toLowerCase()));
    const hasOnlyOtherReachableMentions = normalizedMentions.length > 0
      && !unreachableEntries.some((u) => mentionedKeys.has(u.hostKey.toLowerCase()) || mentionedLabels.has(u.name.toLowerCase()))
      && reachableEntries.length > 0;

    if (!hasOnlyOtherReachableMentions) {
      for (const u of unreachableEntries) {
        const suffix = reachableEntries.length > 0
          ? '，本轮仅在其余可达主机上执行'
          : '，无法执行主机命令';
        const warnNotice = createAiNoticeElement({
          kind: 'unreachable-host',
          level: 'warn',
          iconName: 'alert',
          text: `${u.name} 当前不可达（${u.errorText || '连接超时'}）${suffix}`,
          actions: [
            {
              label: '重连',
              action: 'reconnect',
              hostKey: u.hostKey,
              onClick: async (_e, row) => {
                const targetHost = hostForKey(u.hostKey);
                const res = await reviveLink(thread, u.hostKey).catch(() => null);
                if (targetHost && res?.ok) {
                  targetHost.unreachable = false;
                  targetHost.statusError = '';
                }
                if (row.__label) row.__label.textContent = `已重连 ${u.name}`;
                row.dataset.level = 'info';
                row.className = 'ai-notice';
                row.querySelector('.ai-notice-actions')?.remove();
                refreshThreadUi();
                refreshAgentHostBar();
                redrawTargetMenu();
              },
            },
            {
              label: '从范围移除',
              action: 'remove-scope',
              hostKey: u.hostKey,
              onClick: (_e, row) => {
                const next = threadScope(thread, state.hosts).filter((k) => k !== u.hostKey);
                setThreadScope(thread, next, state.hosts);
                thread.hostId = thread.scope[0] || null;
                const firstH = hostForKey(thread.hostId);
                thread.hostName = firstH ? hostLabelOf(firstH) : null;
                if (row.__label) row.__label.textContent = `已将 ${u.name} 从本会话允许范围移除`;
                row.querySelector('.ai-notice-actions')?.remove();
                refreshThreadScopeChips(thread);
                refreshThreadUi();
                refreshAgentHostBar();
                redrawTargetMenu();
              },
            },
          ],
        });
        appendToThreadView(thread, warnNotice);
      }
    }
  }

  // 若本轮范围内无任何可达主机，插入黄条后直接收束，不发注定失败的工具请求
  if (reachableEntries.length === 0) {
    thread.history.push({ role: 'user', content });
    thread.updatedAt = Date.now();
    trimAiHistory(thread);
    refreshThreadUi();
    return;
  }

  const primaryEntry = (() => {
    if (normalizedMentions.length === 1) {
      const m = normalizedMentions[0];
      const hit = reachableEntries.find(
        (e) => e.hostKey.toLowerCase() === m.hostKey.toLowerCase() || e.name.toLowerCase() === m.label.toLowerCase(),
      );
      if (hit) return hit;
    }
    return reachableEntries[0];
  })();
  const session = primaryEntry?.session || binding?.session;
  const isMultiTurn = runScope.length > 1;
  const allowedIds = [...new Set(reachableEntries.map((e) => e.session?.sessionId).filter(Boolean))];

  const ctrl = new AbortController();
  thread.agentRun = {
    ctrl,
    runScope,
    runExecMode,
    touchedHosts: new Set(),
    targetNoticeEl: null,
    scopeChangeNoticeEl: null,
    firstStepEl: null,
  };
  if (thread.id === state.activeThreadId) setAiBusy(true);
  refreshThreadUi();
  const isActive = () => thread.id === state.activeThreadId;
  const host = session?.host || primaryEntry?.host || {};
  const getTurnMode = () => (host.aiAccess === 'manual' ? 'manual' : (thread.agentRun?.runExecMode || threadExecMode(thread)));

  const recordTouchedHost = (hostName) => {
    if (!hostName || !thread.agentRun) return;
    thread.agentRun.touchedHosts.add(hostName);
    const names = [...thread.agentRun.touchedHosts];
    const modeLabel = EXEC_MODE_LABELS[getTurnMode()] || '手动确认';
    const text = `作用域 ${names.join(' → ')} · ${modeLabel}`;
    if (!thread.agentRun.targetNoticeEl) {
      const noticeEl = createAiNoticeElement({
        kind: 'target-scope',
        level: 'info',
        iconName: 'zap',
        text,
      });
      thread.agentRun.targetNoticeEl = noticeEl;
      const firstStep = thread.agentRun.firstStepEl;
      if (firstStep && firstStep.parentNode) {
        firstStep.before(noticeEl);
      } else {
        appendToThreadView(thread, noticeEl);
      }
    } else if (thread.agentRun.targetNoticeEl.__label) {
      thread.agentRun.targetNoticeEl.__label.textContent = text;
    }
  };

  // 回合执行中会话断掉（最典型：合盖睡眠后 keepalive 到期）时把这台主机请出本轮：
  // 从 runScope / 白名单 / 名称表一起摘掉，后续工具调用直接判越界，
  // 不会再刷出第二、三张一模一样的「会话已断开」失败卡；开关回落到关，等用户重连。
  const demoteHost = (hostKey, reason) => {
    const key = String(hostKey || '').trim();
    if (!key) return;
    const rec = hostIndex.get(key.toLowerCase());
    const name = rec?.hostName || hostLabelOf(hostForKey(key)) || key;
    const idx = reachableEntries.findIndex((e) => String(e.hostKey).toLowerCase() === key.toLowerCase());
    const entry = idx >= 0 ? reachableEntries.splice(idx, 1)[0] : null;
    if (entry) {
      entry.unreachable = true;
      entry.errorText = reason || '会话已断开';
      unreachableEntries.push(entry);
      const nIdx = connectedScopeNames.indexOf(entry.name);
      if (nIdx >= 0) connectedScopeNames.splice(nIdx, 1);
      const sIdx = runScope.indexOf(entry.hostKey);
      if (sIdx >= 0) runScope.splice(sIdx, 1);
      const sid = entry.session?.sessionId;
      const aIdx = sid ? allowedIds.indexOf(sid) : -1;
      if (aIdx >= 0) allowedIds.splice(aIdx, 1);
    }
    for (const k of [...hostIndex.keys()]) {
      if (hostIndex.get(k)?.hostName === name) hostIndex.delete(k);
    }
    unlinkHost(thread, key).catch(() => {});
    appendToThreadView(thread, createAiNoticeElement({
      kind: 'session-gone',
      level: 'warn',
      iconName: 'alert',
      text: `${name} 的会话已断开，已移出本会话主机范围；重连后重新打开开关即可继续`,
    }));
    if (isActive()) aiStickScroll();
    refreshThreadScopeChips(thread);
    refreshThreadUi();
    refreshAgentHostBar();
    redrawTargetMenu();
  };

  const baseAdapter = createAgentAdapter({
    mount: (node) => {
      if (thread.agentRun && !thread.agentRun.firstStepEl && node?.classList?.contains?.('ai-step')) {
        thread.agentRun.firstStepEl = node;
      }
      appendToThreadView(thread, node);
    },
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
    onRunAndAuto: () => {
      thread.execMode = 'auto';
      thread.autoAcked = true;
      if (thread.agentRun) thread.agentRun.runExecMode = 'auto';
      refreshAgentHostBar();
    },
    canAllow: () => !isMultiTurn && getTurnMode() === 'auto' && session?.host?.aiAccess !== 'manual',
    onAllowAlways: (allowable) => { addGrant(thread, allowable); refreshAgentHostBar(); },
    audit: (e) => api('ai:tool-audit', {
      ...e,
      sessionId: e.sessionId || session?.sessionId,
      host: e.host || primaryEntry?.name || hostLabelOf(session?.host),
    }).catch(() => {}),
    canUseSaved: () => !!(session?.host?.hasPassword || session?.host?.password),
    // 步骤卡错误行上的「重连」：走与无头托管同一条连接路径，成功后清掉不可达标记。
    onReconnectHost: async (hostKey) => {
      const key = String(hostKey || '').trim();
      if (!key) return false;
      // 走池里的建链路径（而不是直接 ssh:connect 一个临时 sessionId）：
      // 会话必须登记进 state.aiLinks，否则重连后下一轮又会被判成「未连接」。
      const revived = await reviveLink(thread, key).catch(() => null);
      const ok = !!revived?.ok;
      const targetHost = (state.hosts || []).find((h) => hostKeyOf(h) === key || hostLabelOf(h) === key);
      if (ok && targetHost) {
        targetHost.unreachable = false;
        targetHost.statusError = '';
        if (targetHost.status === 'error') targetHost.status = 'connected';
      }
      refreshThreadUi();
      refreshAgentHostBar();
      redrawTargetMenu();
      return ok;
    },
  });

  const resolveExecSession = (req) => {
    const wanted = String(req.args?.host || '').trim();
    if (wanted) {
      const cleanWanted = wanted.replace(/^@/, '').trim();
      const check = validateToolHost({
        runScope,
        requested: cleanWanted,
        hosts: state.hosts,
      });
      const link = hostIndex.get(cleanWanted.toLowerCase())
        || (check.ok && check.hostKey ? hostIndex.get(String(check.hostKey).toLowerCase()) : null);
      if (!check.ok && !link) {
        return {
          code: 'out_of_scope',
          error: `越界拒绝：主机「${cleanWanted}」不在本会话允许范围（${connectedScopeNames.join('、') || '无'}）内，已拒绝连接与执行。`,
        };
      }
      if (!link || link.status !== 'connected') {
        const unreach = unreachableEntries.find(
          (u) => u.hostKey.toLowerCase() === cleanWanted.toLowerCase() || u.name.toLowerCase() === cleanWanted.toLowerCase(),
        );
        if (unreach) {
          return {
            code: 'host_unreachable',
            error: `主机「${unreach.name}」当前不可达（${unreach.errorText || '连接超时'}）。当前可用主机：${connectedScopeNames.join('、') || '（无）'}`,
          };
        }
        return {
          code: 'out_of_scope',
          error: `越界拒绝：主机「${cleanWanted}」不在本会话允许范围（${connectedScopeNames.join('、') || '无'}）内，已拒绝连接与执行。`,
        };
      }
      return {
        sessionId: link.sessionId,
        hostKey: link.hostKey,
        hostName: link.hostName,
      };
    }
    return {
      sessionId: primaryEntry?.session?.sessionId || req.sessionId,
      hostKey: primaryEntry?.hostKey || '',
      hostName: primaryEntry?.name || hostLabelOf(host) || '',
    };
  };

  const turnToken = beginAiTurn(thread);

  try {
    await runAgentTurn({
      thread,
      userMessage: content,
      systemPrompt: buildHostSystemPrompt({
        hostName: primaryEntry?.name || hostLabelOf(host),
        user: host.username,
        isRoot: host.username === 'root',
        os: thread.hostOs,
        cwd: session?.remoteCwd,
        execMode: getTurnMode(),
        linkedHosts: isMultiTurn ? connectedScopeNames : null,
        scopeHosts: scopeEntries,
        mentions: normalizedMentions,
      }),
      tools: isMultiTurn ? AI_AGENT_TOOLS_MULTI : AI_AGENT_TOOLS,
      sessionId: session?.sessionId,
      scopeHosts: reachableEntries,
      getMode: getTurnMode,
      chat: (req) => agentChat(thread, { ...req, scopeHosts: reachableEntries, isMultiTurn }),
      execTool: async (req) => {
        const target = resolveExecSession(req);
        if (target.error) {
          return {
            status: 'error',
            code: target.code || 'out_of_scope',
            message: target.error,
          };
        }
        // F18 / L2：首个有效 hostKey 工具调用发生时，由 UI 强制插入目标声明条
        recordTouchedHost(target.hostName);
        const policy = req.tool === 'exec'
          ? {
            allow: !isMultiTurn && req.mode !== 'manual'
              ? (thread.allowlist || []).map(({ rule, key }) => ({ rule, key }))
              : [],
            tainted: isMultiTurn ? [] : (thread.taint || []),
          }
          : {};
        const send = (sessionId) => api('ai:tool-exec', {
          ...req,
          ...policy,
          sessionId,
          hostKey: target.hostKey,
          runScope,
          linkedSessions: allowedIds,
        });
        const GONE = new Set(['session_gone', 'host_not_linked']);
        let res = await send(target.sessionId);
        if (res && GONE.has(res.code)) {
          // 回合开始时还是活的，执行到这一步会话已经没了：先静默重连一次再重放这条命令，
          // 重连也接不上才把这台主机请出本轮（不然模型会拿到同一句错误反复重试）。
          const revived = await reviveLink(thread, target.hostKey, { force: true }).catch(() => null);
          if (revived?.ok && revived.sessionId && revived.sessionId !== target.sessionId) {
            target.sessionId = revived.sessionId;
            if (!allowedIds.includes(revived.sessionId)) allowedIds.push(revived.sessionId);
            res = await send(revived.sessionId);
          }
          if (res && GONE.has(res.code)) demoteHost(target.hostKey, res.message);
        }
        if (res && typeof res === 'object') {
          if (!res.host && target.hostName) res.host = target.hostName;
          if (!res.hostKey && target.hostKey) res.hostKey = target.hostKey;
        }
        if (req.tool === 'host_info' && res?.meta?.os && !isMultiTurn) thread.hostOs = res.meta.os;
        if (!isMultiTurn && Array.isArray(res?.downloads) && res.downloads.length) addTaint(thread, res.downloads);
        return res;
      },
      cancelTool: (toolRunId) => api('ai:tool-cancel', { toolRunId }),
      readTerminal: (lines) => readTerminalLines(state.sessions?.get?.(session?.sessionId) || session, lines),
      adapter: {
        ...baseAdapter,
        stepStart: (step) => {
          if (step && !step.hostName && !step.args?.host && primaryEntry?.name) {
            step.hostName = primaryEntry.name;
            step.hostKey = primaryEntry.hostKey;
          }
          baseAdapter.stepStart(step);
        },
        onOutOfScope: ({ args, count, max }) => {
          const wantedHost = String(args?.host || '').replace(/^@/, '').trim() || '未知主机';
          if (count >= max) {
            const abortNotice = createAiNoticeElement({
              kind: 'oob-abort',
              level: 'danger',
              iconName: 'alert',
              text: `模型连续 ${count} 次尝试操作范围外主机（@${wantedHost}），已自动中止本轮执行`,
            });
            appendToThreadView(thread, abortNotice);
          } else {
            const warnNotice = createAiNoticeElement({
              kind: 'oob-warn',
              level: 'warn',
              iconName: 'alert',
              text: `已拦截范围外主机请求 @${wantedHost}（不在本轮允许范围：${connectedScopeNames.join('、') || '无'}）`,
            });
            appendToThreadView(thread, warnNotice);
          }
          if (isActive()) aiStickScroll();
        },
        onToolsUnsupported: () => toast('当前模型不支持工具调用，本次改为普通对话', 'info'),
      },
      signal: ctrl.signal,
      sudoCache,
      uuid: () => crypto.randomUUID(),
    });
  } finally {
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
