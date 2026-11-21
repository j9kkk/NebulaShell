// AI 线程与主机范围（scope）及执行档位（execMode）的状态内核（纯函数，无 DOM 依赖）。
//
// 两条正交的轴：
//   scope     本会话允许操作哪些主机（硬边界白名单，挂 thread.scope，由 ai-scope.js 管理）
//   execMode  命令怎么执行     —— manual(逐条确认) / auto(普通命令直接执行) / full(完全托管)
//
// 旧三模式（LINK_MODES: chat/follow/multi、rebindThread、crossTab 横条）已彻底移除；
// 会话与终端命令窗口完全解耦，切换终端标签不再修改 thread.scope。

import {
  SCOPE_CHAT_LABEL,
  SCOPE_EMPTY_LABEL,
  allowsHost,
  defaultScopeForNewThread,
  folderOf,
  groupHostsByFolder,
  groupState,
  hostKeyOf,
  hostLabelOf,
  isInScope,
  mentionState,
  normalizeScope,
  resolveScopeTarget,
  scopeSummary,
   setGroup,
  snapshotRunScope,
  toggleHost,
  validateToolHost,
} from './ai-scope.js';

export {
  SCOPE_CHAT_LABEL,
  SCOPE_EMPTY_LABEL,
  allowsHost,
  defaultScopeForNewThread,
  folderOf,
  groupHostsByFolder,
  groupState,
  hostKeyOf,
  hostLabelOf,
  isInScope,
  mentionState,
  normalizeScope,
  resolveScopeTarget,
  scopeSummary,
  setGroup,
  snapshotRunScope,
  toggleHost,
  validateToolHost,
};

export const EXEC_MODES = ['manual', 'auto', 'full'];
export const CHAT_SUMMARY = SCOPE_EMPTY_LABEL;

export function toolSupportKey(aiSettings) {
  const ai = aiSettings || {};
  return `${ai.baseUrl || ''}::${ai.model || ''}`;
}

export function isModelToolsCapable(aiSettings) {
  if (!aiSettings) return true;
  const key = toolSupportKey(aiSettings);
  return (aiSettings.toolSupport || {})[key] !== false;
}

export const modelToolsCapable = isModelToolsCapable;

/// 线程的执行模式：只可能是 manual / auto / full；未知值一律 fail-safe 回 manual。
export function threadExecMode(thread) {
  const m = thread && thread.execMode;
  return EXEC_MODES.includes(m) ? m : 'manual';
}

/// 完全托管档：任何命令都不再停下来确认，由 Rust 侧把 needs-confirm 一并放开。
export function isFullExecMode(mode) {
  return mode === 'full';
}

/// 撤销线程上的全部授权：自动模式确认、会话授权列表、下载污点。
export function clearTargetGrants(thread) {
  if (!thread) return thread;
  thread.autoAcked = false;
  thread.allowlist = [];
  thread.taint = [];
  thread.hostOs = null;
  return thread;
}

/// 读取线程的 scope 数组。
export function threadScope(thread, hosts = []) {
  if (!thread) return [];
  const raw = Array.isArray(thread.scope) ? thread.scope : [];
  return hosts && hosts.length
    ? normalizeScope(raw, hosts)
    : [...new Set(raw.filter((k) => typeof k === 'string' && k))];
}

/// 更新线程的 scope：当新范围与原范围不同（增删了主机或清空为纯对话）时，
/// 撤销已累积的会话授权与下载污点，执行档位回到 manual。返回是否发生变化。
export function setThreadScope(thread, nextScope, hosts = []) {
  if (!thread) return false;
  const prev = threadScope(thread, hosts);
  const next = hosts && hosts.length
    ? normalizeScope(nextScope, hosts)
    : [...new Set((Array.isArray(nextScope) ? nextScope : []).filter((k) => typeof k === 'string' && k))];
  const same = prev.length === next.length && prev.every((k, i) => k === next[i]);
  thread.scope = next;
  if (!same) {
    clearTargetGrants(thread);
    thread.sendBlocked = null;
    thread.execMode = 'manual';
  }
  return !same;
}

/// 输入框左下角主机钮 / 执行模式菜单头部的主机范围摘要文案（F1）。
export function hostSummaryOf({ scope = [], hosts = [] } = {}) {
  return scopeSummary(scope, hosts).label;
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v.values === 'function') return [...v.values()];
  return [];
}

/// 计算当前线程的操作范围视图（TargetView，基于 thread.scope，与当前活动终端窗口解耦）
export function resolveAiTarget({
  thread,
  sessions,
  hosts = [],
  settings,
  busy = false,
  links = [],
} = {}) {
  const hostList = toArray(hosts);
  const sessionList = toArray(sessions);
  const linkList = toArray(links).filter(Boolean);

  // 把已在终端连接、但不在主机库里的快速连接主机也并入可见列表，确保默认快照/范围解析不丢
  const knownKeys = new Set(hostList.map(hostKeyOf).filter(Boolean));
  const combinedHosts = [...hostList];
  for (const s of sessionList) {
    if (!s?.host) continue;
    const k = hostKeyOf(s.host);
    if (k && !knownKeys.has(k)) {
      knownKeys.add(k);
      combinedHosts.push(s.host);
    }
  }

  const base = resolveScopeTarget({
    thread,
    hosts: combinedHosts,
    sessions: sessionList,
  });

  // 合并无头链接池的在线状态：无头链接已 connected 也算 reachable
  const connectedKeys = new Set(
    sessionList.filter((s) => s && s.status === 'connected').map((s) => hostKeyOf(s.host)).filter(Boolean),
  );
  for (const l of linkList) {
    if (l.status === 'connected' && (l.hostKey || l.hostId)) {
      connectedKeys.add(l.hostKey || l.hostId);
    }
  }

  const scope = base.scope;
  const scopeHosts = base.hosts;
  const count = scope.length;
  const connectedHosts = scopeHosts.filter((h) => connectedKeys.has(hostKeyOf(h)));
  const reachable = connectedHosts.length;
  const execMode = threadExecMode(thread);
  const toolsCapable = isModelToolsCapable(settings?.ai);

  const kind = count === 0 ? 'chat' : (count === 1 ? 'single' : 'multi');

  let blocked = '';
  if (kind !== 'chat') {
    if (!toolsCapable) {
      blocked = 'tools';
    } else if (base.denied > 0 && base.denied === count) {
      blocked = 'deny';
    }
  }

  const isConnecting = kind !== 'chat' && (
    (thread?.pendingConnect && scope.includes(thread.pendingConnect))
    || sessionList.some((s) => s && s.status === 'connecting' && scope.includes(hostKeyOf(s.host)))
    || linkList.some((l) => l.status === 'connecting' && scope.includes(l.hostKey || l.hostId))
  );

  const summary = scopeSummary(scope, combinedHosts);
  const hostSummary = summary.label;
  const singleHost = count === 1 ? scopeHosts[0] || null : null;
  const hostKey = scope[0] || null;
  const hostLabel = count === 1 ? summary.label : null;
  const primarySession = sessionList.find((s) => s && s.status === 'connected' && scope.includes(hostKeyOf(s.host))) || null;

  let tone = 'idle';
  let statusText = '';
  if (kind === 'chat') {
    tone = 'idle';
    statusText = SCOPE_CHAT_LABEL;
  } else if (blocked === 'tools') {
    tone = 'warn';
    statusText = '模型不支持工具';
  } else if (blocked === 'deny') {
    tone = 'warn';
    statusText = count === 1 ? '主机禁止 AI' : '范围内主机禁止 AI';
  } else if (isConnecting) {
    tone = 'connecting';
    statusText = '连接中…';
  } else if (count === 1) {
    tone = reachable === 1 ? 'connected' : 'warn';
    statusText = reachable === 1 ? '已连接' : '未连接';
  } else {
    tone = reachable === count ? 'connected' : 'warn';
    statusText = reachable === count ? '全部就绪' : `${count - reachable} 台未连接`;
  }

  const empty = !thread || !thread.history || thread.history.length === 0;
  const isBusy = !!(busy || (thread && (thread.busy || thread.req)));

  return {
    kind,
    scope,
    hosts: scopeHosts,
    connectedHosts,
    count,
    linkedCount: count,
    reachable,
    denied: base.denied,
    execMode,
    hostKey,
    hostLabel,
    singleHost,
    session: primarySession,
    hostSummary,
    displayName: hostSummary,
    chatLabel: SCOPE_CHAT_LABEL,
    summary,
    showModeControl: kind !== 'chat',
    blocked,
    empty,
    busy: isBusy,
    tone,
    statusText,
    sendBlocked: thread?.sendBlocked || null,
    ariaLabel: `会话主机范围: ${hostSummary}${statusText ? ', ' + statusText : ''}`,
  };
}
