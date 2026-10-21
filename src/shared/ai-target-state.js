// AI 线程与主机目标关系的状态内核（纯函数，无 DOM 依赖，可在单测与不同环境复用）。
//
// 两条正交的轴:
//   linkMode  这个对话作用于谁 —— chat(不操作主机) / follow(跟随当前命令窗口) / multi(多主机)
//   execMode  命令怎么执行     —— manual(逐条确认) / auto(普通命令直接执行)
//                                / full(完全托管:后端不产生任何确认)
// 路由判定、授权清空、文案生成都收在这里,界面层只消费 TargetView。

export const LINK_MODES = ['chat', 'follow', 'multi'];
export const EXEC_MODES = ['manual', 'auto', 'full'];
export const CHAT_SUMMARY = '未链接主机';

export function hostKeyOf(host) {
  if (!host) return null;
  if (host.id && !host.quick) return host.id;
  const username = host.username || host.user || '';
  const hostname = host.host || host.ip || '';
  const port = host.port || 22;
  return `${username}@${hostname}:${port}`;
}

export function hostLabelOf(host) {
  if (!host) return null;
  return host.name || host.host || host.ip || null;
}

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

/// 线程的主机链接模式。老线程只有 execMode:'chat'(chat 当时是执行档),
/// 按「读取即迁移」解释,不需要落盘迁移。
export function threadLinkMode(thread) {
  if (!thread) return 'follow';
  const m = thread.linkMode;
  if (LINK_MODES.includes(m)) return m;
  return thread.execMode === 'chat' ? 'chat' : 'follow';
}

/// 线程的执行模式。chat 升格为链接模式后,这里只可能是 manual / auto / full;
/// 未知值一律落回 manual(fail-safe:读不懂的档位不给更大权限)。
export function threadExecMode(thread) {
  const m = thread && thread.execMode;
  return EXEC_MODES.includes(m) ? m : 'manual';
}

/// 完全托管档:任何命令都不再停下来确认,由 Rust 侧把 needs-confirm 一并放开。
export function isFullExecMode(mode) {
  return mode === 'full';
}

/// 撤销线程上的全部授权:自动模式确认、会话授权列表、下载污点。
/// 换主机/换链接模式后执行档本就会降回手动,托管档不另设「已确认」标记 ——
/// 它每次切入都要重新确认,不给跨目标静默继承的机会。
export function clearTargetGrants(thread) {
  if (!thread) return thread;
  thread.autoAcked = false;
  thread.allowlist = [];
  thread.taint = [];
  thread.hostOs = null;
  return thread;
}

/// 链接模式唯一写入口。进入对话模式即解除主机绑定并清空授权
/// (授权是「对某台主机某范围」的,目标一变就必须重来)。
export function setLinkMode(thread, mode) {
  if (!thread) return null;
  const next = LINK_MODES.includes(mode) ? mode : 'follow';
  if (threadLinkMode(thread) === next) return thread;
  const isChatIn = thread.execMode === 'chat';
  const isChatOut = next === 'chat';
  thread.linkMode = next;
  if (isChatOut) {
    thread.execMode = 'manual';
    clearTargetGrants(thread);
    thread.sendBlocked = null;
  } else if (isChatIn) {
    // 从对话模式切回来:execMode 已经从 chat 语义脱钩,恢复手动。
    thread.execMode = 'manual';
  }
  return thread;
}

/// 唯一改绑入口：切换主机时降级为 manual 并撤销全部授权与污点；同主机仅更新会话标识
export function rebindThread(thread, target = {}) {
  if (!thread) return null;
  const nextKey = target.hostKey ?? target.hostId ?? null;
  const nextLabel = target.hostLabel ?? target.hostName ?? null;
  const nextSessionId = target.sessionId ?? null;

  const isSameHost = thread.hostId === nextKey;
  // 首次绑定(此前没有目标)不算换主机:新对话第一条消息在发送时才绑到当前标签,
  // 若按「换目标」处理,用户刚选的自动/托管档会在发出前一刻被静默撤掉。
  const firstBind = !thread.hostId && !!nextKey;
  if (!isSameHost && !firstBind) {
    if (thread.execMode !== 'chat') {
      thread.execMode = 'manual';
    }
    clearTargetGrants(thread);
    thread.sendBlocked = null;
  }

  thread.hostId = nextKey;
  thread.hostName = nextLabel;
  thread.sessionId = nextSessionId;
  return thread;
}

const isSessionConnected = (s) => !!s && s.status === 'connected';

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v.values === 'function') return [...v.values()];
  return [];
}

/// 多主机链接注册表条目 → 视图条目。
function linkView(link) {
  if (!link) return null;
  return {
    hostId: link.hostId || null,
    hostKey: link.hostKey || link.hostId || null,
    hostName: link.hostName || link.hostId || null,
    sessionId: link.sessionId || null,
    status: link.status || 'idle',
    connected: link.status === 'connected',
    error: link.error || null,
    headless: !!link.headless,
  };
}

/// 触发钮 / 模式菜单第一行的主机摘要文案(需求 §3)。
export function hostSummaryOf({ linkMode, hostLabel, linkedCount } = {}) {
  if (linkMode === 'chat') return CHAT_SUMMARY;
  if (linkMode === 'multi') {
    return linkedCount > 0 ? `已链接 ${linkedCount} 台主机` : CHAT_SUMMARY;
  }
  return hostLabel ? `已链接 ${hostLabel}` : CHAT_SUMMARY;
}

/// 计算当前线程的操作目标视图（TargetView）
export function resolveAiTarget({
  thread,
  sessions,
  activeId,
  hosts = [],
  settings,
  busy = false,
  links = [],
} = {}) {
  const sessionList = toArray(sessions);
  const linkList = toArray(links).map(linkView).filter(Boolean);

  const activeSession = typeof sessions?.get === 'function'
    ? (activeId ? sessions.get(activeId) : null)
    : sessionList.find((s) => s && s.sessionId === activeId);

  const activeConnected = isSessionConnected(activeSession);
  const active = activeConnected
    ? {
      hostKey: hostKeyOf(activeSession.host),
      hostLabel: hostLabelOf(activeSession.host),
      session: activeSession,
    }
    : null;

  const linkMode = threadLinkMode(thread);
  const execMode = threadExecMode(thread);
  const toolsCapable = isModelToolsCapable(settings?.ai);

  const linkedHosts = linkList;
  const linkedCount = linkedHosts.length;
  const linkedConnected = linkedHosts.filter((l) => l.connected);
  const linkedOffline = linkedHosts.filter((l) => !l.connected);

  // ---- 解析目标主机与主执行会话 ----
  let kind = 'none';
  let hostKey = null;
  let hostLabel = null;
  let usableSession = null;
  let connectable = null;

  if (linkMode === 'chat') {
    kind = 'chat';
  } else if (linkMode === 'multi') {
    hostKey = linkedConnected[0]?.hostKey || linkedOffline[0]?.hostKey || null;
    hostLabel = linkedConnected[0]?.hostName || linkedOffline[0]?.hostName || null;
    if (!linkedCount) {
      kind = 'none';
    } else {
      usableSession = linkedConnected[0]?.session
        || (linkedConnected[0]?.sessionId
          ? sessionList.find((s) => isSessionConnected(s) && s.sessionId === linkedConnected[0].sessionId)
          : null)
        || null;
      if (!usableSession && linkedConnected[0]?.hostKey) {
        usableSession = sessionList.find((s) => isSessionConnected(s) && hostKeyOf(s.host) === linkedConnected[0].hostKey) || null;
      }
      // 链接了主机却一台都没连上:显式阻断发送(用户是主动链接的,静默降级为普通对话
      // 会让命令悄悄没落到任何主机上)。部分连接时按 'multi' 正常走。
      const anyConnected = linkedConnected.length > 0 || !!usableSession;
      kind = anyConnected ? 'multi' : 'offline';
    }
  } else {
    // follow:目标跟随当前命令窗口。窗口有活动连接就是目标;没有连接说明"暂时没有
    // 可操作的主机"→ 按普通对话回答(顶栏文案「未链接主机」),不拦截发送也不降级为
    // 别的静默行为 —— 打开应用随手问一句不该被挡住。重连入口在终端自身的横幅里。
    if (activeConnected) {
      kind = 'bound';
      hostKey = active.hostKey;
      hostLabel = active.hostLabel;
      usableSession = active.session;
    } else {
      kind = 'none';
    }
  }

  // crossTab:目标主机与当前窗口主机不同的已绑定态(仅跟随模式可能产生)
  const crossTab = kind === 'bound' && !!active && active.hostKey !== hostKey;

  // ---- 阻断判定(仅针对会执行工具的模式) ----
  let blocked = '';
  const subjectSession = usableSession || (kind === 'offline' ? activeSession : null);
  if (kind !== 'chat' && kind !== 'none') {
    if (!toolsCapable) {
      blocked = 'tools';
    } else if (subjectSession?.host?.aiAccess === 'deny') {
      blocked = 'deny';
    }
  }

  // ---- 连接中 ----
  const isConnecting = kind !== 'chat' && (
    (thread?.pendingConnect && thread.pendingConnect === hostKey)
    || (hostKey && sessionList.some((s) => s && hostKeyOf(s.host) === hostKey && s.status === 'connecting'))
    || linkedHosts.some((l) => l.status === 'connecting')
  );

  // ---- 文案 ----
  const hostSummary = hostSummaryOf({ linkMode, hostLabel, linkedCount });
  let displayName = hostSummary;
  let tone = 'idle';
  let statusText = '';
  let actionText = null;

  if (kind === 'chat') {
    displayName = CHAT_SUMMARY;
    tone = 'idle';
    statusText = '纯对话 · 不操作主机';
  } else if (kind === 'none') {
    displayName = CHAT_SUMMARY;
    tone = 'idle';
    statusText = linkMode === 'multi' ? '未选择主机' : '当前窗口无主机';
  } else if (kind === 'multi') {
    tone = blocked ? 'warn' : 'connected';
    if (blocked === 'tools') statusText = '模型不支持工具';
    else if (blocked === 'deny') statusText = '部分主机禁止 AI';
    else if (isConnecting) { tone = 'connecting'; statusText = '连接中…'; }
    else if (linkedOffline.length) { tone = 'warn'; statusText = `${linkedOffline.length} 台未连接`; }
    else statusText = '全部就绪';
  } else if (isConnecting) {
    tone = 'connecting';
    statusText = '连接中…';
  } else if (kind === 'bound') {
    if (blocked === 'tools') {
      tone = 'warn';
      statusText = '模型不支持工具';
    } else if (blocked === 'deny') {
      tone = 'warn';
      statusText = '主机禁止 AI';
    } else if (crossTab) {
      tone = 'connected';
      statusText = '不在当前标签';
    } else {
      tone = 'connected';
      statusText = '';
    }
  } else if (kind === 'offline') {
    tone = 'warn';
    statusText = linkMode === 'multi' ? '全部主机未连接' : '未连接';
    if (connectable) actionText = connectable === 'connect' ? '连接' : '重连';
  }

  const empty = !thread || !thread.history || thread.history.length === 0;
  const isBusy = !!(busy || (thread && (thread.busy || thread.req)));

  return {
    kind,
    linkMode,
    execMode,
    hostKey,
    hostLabel,
    hostSummary,
    linkedCount,
    linkedHosts,
    displayName,
    session: usableSession,
    active,
    crossTab,
    blocked,
    empty,
    busy: isBusy,
    connectable,
    tone,
    statusText,
    actionText,
    sendBlocked: thread?.sendBlocked || null,
    ariaLabel: `AI 操作目标: ${displayName}${statusText ? ', ' + statusText : ''}`,
  };
}
