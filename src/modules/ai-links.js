// AI 多主机链接:一个对话同时作用于多台主机时,每台主机对应一条后端 SSH 会话。
//
// 两层结构,分别解决两个问题:
//   1. 连接池 state.aiLinks(Map<hostId, link>) —— 应用级。同一台主机只连一次,
//      跨对话/标签共享真实连接,避免为每个对话重复建链。
//   2. 对话的目标集合 thread.linkedHostIds —— 对话级。一个对话"链接了哪几台主机"
//      是它自己的状态;切换对话不会继承别人的目标集合,退出也不会误断别人在用的连接。
//      池条目带 refs(被几个对话引用),归零才真正断开无头会话。
//
// 与终端标签的关系:
//   - 该主机已在某个标签里连着 → 复用那条会话(id 不变、标签不受影响),关链接不断开;
//   - 否则建"无头会话"(ailink- 前缀):没有标签、没有 xterm,只是一条 AI 执行通道。
//   后端对 ailink- 前缀按内部会话处理(不录日志/不采指标/不起转发),见 commands.rs。
import { api, state } from './core.js';
import { hostKeyOf, hostLabelOf } from '../shared/ai-target-state.js';

const MAX_PARALLEL = 5;
export const HEADLESS_PREFIX = 'ailink-';

let onChange = () => {};
/// 由 entry 在接线时注入,用于链接状态变化后刷新目标栏/菜单。
export function setLinksChangeHandler(fn) {
  onChange = typeof fn === 'function' ? fn : () => {};
}

function pool() {
  if (!state.aiLinks) state.aiLinks = new Map();
  return state.aiLinks;
}

function threadIds(thread) {
  if (!thread) return [];
  if (!Array.isArray(thread.linkedHostIds)) thread.linkedHostIds = [];
  return thread.linkedHostIds;
}

function emit() {
  try { onChange(); } catch { /* 界面刷新失败不应影响链接本身 */ }
}

/// 某个对话当前链接的主机条目(顺序跟 thread.linkedHostIds)。
export function linksForThread(thread) {
  const p = pool();
  return threadIds(thread).map((id) => p.get(id)).filter(Boolean);
}

export function linkCountFor(thread) {
  return linksForThread(thread).length;
}

/// 本对话当前可执行的全部会话 id(用于 ai:tool-exec 的 linkedSessions 白名单)。
export function linkedSessionIds(thread) {
  const ids = new Set();
  for (const link of linksForThread(thread)) {
    if (link.status === 'connected' && link.sessionId) ids.add(link.sessionId);
  }
  return [...ids];
}

function liveSessionForHost(host) {
  const key = hostKeyOf(host);
  if (!key || !state.sessions) return null;
  return [...state.sessions.values()].find(
    (s) => s && ['connected', 'connecting'].includes(s.status) && hostKeyOf(s.host) === key,
  ) || null;
}

/// 确保某主机在池里有一条可用链接(必要时建链)。返回池条目,失败返回 null。
async function ensurePoolEntry(host) {
  const p = pool();
  const existing = p.get(host.id);
  if (existing) {
    // 池里已有:可能被别的对话引着。掉线的复用型条目重连一次,无头失败条目重建。
    if (existing.status === 'connected' || existing.status === 'connecting') return existing;
  }

  const live = liveSessionForHost(host);
  if (live) {
    // 复用标签会话:关链接只解除引用,绝不 disconnect。
    const entry = existing || {};
    Object.assign(entry, {
      hostId: host.id,
      hostKey: hostKeyOf(host),
      hostName: hostLabelOf(host) || host.host || host.id,
      sessionId: live.sessionId,
      status: 'connected',
      headless: false,
      error: null,
      refs: entry.refs || 0,
    });
    p.set(host.id, entry);
    return entry;
  }

  const sessionId = HEADLESS_PREFIX + crypto.randomUUID();
  const entry = existing || {};
  Object.assign(entry, {
    hostId: host.id,
    hostKey: hostKeyOf(host),
    hostName: hostLabelOf(host) || host.host || host.id,
    sessionId,
    status: 'connecting',
    headless: true,
    error: null,
    refs: entry.refs || 0,
  });
  p.set(host.id, entry);
  try {
    const res = await api('ssh:connect', { hostId: host.id, sessionId });
    const cur = p.get(host.id);
    if (cur !== entry || entry.sessionId !== sessionId) return null;
    if (res?.cancelled) {
      if (!entry.refs) p.delete(host.id);
      entry.status = 'error';
      entry.error = '连接已取消';
      return null;
    }
    entry.status = 'connected';
    entry.error = null;
    return entry;
  } catch (e) {
    const cur = p.get(host.id);
    if (cur === entry && entry.sessionId === sessionId) {
      api('ssh:disconnect', { sessionId }).catch(() => {});
      if (!entry.refs) p.delete(host.id);
      entry.status = 'error';
      entry.error = e?.message || '连接失败';
    }
    return null;
  }
}

/// 对话链接一台主机。失败时不会写进 thread.linkedHostIds(界面 switch 回退到关闭)。
export async function linkHost(thread, hostId) {
  const host = (state.hosts || []).find((h) => h && h.id === hostId);
  if (!host) return { ok: false, error: '主机不存在' };
  const ids = threadIds(thread);
  if (ids.includes(hostId)) return { ok: true, reused: true };

  const entry = await ensurePoolEntry(host);
  if (!entry || entry.status !== 'connected') {
    emit();
    return { ok: false, error: entry?.error || '连接失败' };
  }
  entry.refs = (entry.refs || 0) + 1;
  ids.push(hostId);
  emit();
  return { ok: true, reused: entry.headless === false };
}

/// 解除一台主机的链接。引用归零且是无头会话才真正断开;复用中的标签会话只解除引用。
/// 断开是无头会话的网络操作,可能耗时数秒:先标 disconnecting 让界面显示「断开中…」,
/// 真正结束再摘条目(失败也只回退到未链接,不留在半断开态)。
export async function unlinkHost(thread, hostId) {
  const ids = threadIds(thread);
  const idx = ids.indexOf(hostId);
  if (idx < 0) return;
  const entry = pool().get(hostId);
  // 先从本对话的目标集合里摘掉:断开期间这个对话不该再往它上面发命令。
  ids.splice(idx, 1);
  if (entry) {
    entry.refs = Math.max(0, (entry.refs || 0) - 1);
    if (!entry.refs) {
      entry.status = 'disconnecting';
      emit();
      if (entry.headless && entry.sessionId) {
        try { await api('ssh:disconnect', { sessionId: entry.sessionId }); } catch { /* 已断开 */ }
      }
      pool().delete(hostId);
    }
  }
  emit();
}

/// 清空某个对话的全部链接(退出多主机模式 / 关闭对话 / 应用退出)。
export async function clearThreadLinks(thread) {
  if (!thread) return 0;
  const ids = [...threadIds(thread)];
  thread.linkedHostIds = [];
  let closed = 0;
  const p = pool();
  await Promise.all(ids.map(async (id) => {
    const entry = p.get(id);
    if (!entry) return;
    entry.refs = Math.max(0, (entry.refs || 0) - 1);
    if (entry.refs) return;
    p.delete(id);
    if (entry.headless && entry.sessionId) {
      closed++;
      await api('ssh:disconnect', { sessionId: entry.sessionId }).catch(() => {});
    }
  }));
  emit();
  return closed;
}

/// 后端会话掉线时同步链接状态(无头会话没有 state.sessions 条目,靠自己跟踪)。
export function handleLinkSessionStatus({ sessionId, state: status }) {
  if (!sessionId || !String(sessionId).startsWith(HEADLESS_PREFIX)) return false;
  let hit = false;
  for (const link of pool().values()) {
    if (link.sessionId !== sessionId) continue;
    hit = true;
    if (status === 'connected') {
      link.status = 'connected';
      link.error = null;
    } else if (status === 'connecting') {
      link.status = 'connecting';
    } else {
      link.status = 'error';
      link.error = link.error || '连接已断开';
    }
  }
  if (hit) emit();
  return hit;
}

/// 批量链接(多主机模式「全部开启」用),并发上限 MAX_PARALLEL。
/// 逐台各自成败,失败的主机在结果里带 error,调用方负责提示。
export async function linkHosts(thread, hostIds = []) {
  const ids = [...new Set(hostIds.filter(Boolean))];
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      results.push({ hostId: id, ...(await linkHost(thread, id)) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, ids.length) }, worker));
  return results;
}
