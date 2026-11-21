// 会话主机范围（scope）——唯一有强制力的约束。
//
// 三层状态正交：
//   scope  本会话允许操作哪些主机（本文件，纯函数，挂 thread.scope）
//   target 模型在 scope 内自行判断本次作用于哪台（软判断，UI 不预判）
//   mode   manual / auto / full（策略，不改变范围）
//
// 设计约束（来自 REQUIREMENTS-v3.md F1–F6 / F24 / F25）：
//   - scope 是会话级的，存 thread.scope；不得放全局，否则切会话会继承别人的授权。
//   - 范围外的主机永不被静默加进来：手打 @foo 不在范围内就只是文本。
//   - chip 的「失效」是派生属性（按当前 scope 现算），不落库，否则会与 scope 脱节。
//   - 回合开始要快照 runScope，回合内改范围不影响在跑的那一轮。

export const SCOPE_EMPTY_LABEL = '未选主机';
export const SCOPE_CHAT_LABEL = '纯对话';

/// 主机唯一键：主机库里带 id 的用 id，快速连接用 user@host:port。
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

/// 主机所在目录名（与主机库的 groupOf 同语义，但这里不依赖 UI 层）。
export function folderOf(host, fallback = '我的主机') {
  if (!host) return fallback;
  return host.group || fallback;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value.values === 'function') return [...value.values()];
  return [];
}

/// 归一化：去重、丢弃已不存在的主机、按主机列表顺序排。
/// 主机被删除后 scope 不该残留死键 —— 归一化是读时修复，不需要落盘迁移。
export function normalizeScope(scope, hosts = []) {
  const wanted = new Set(toArray(scope).filter((k) => typeof k === 'string' && k));
  if (!wanted.size) return [];
  const out = [];
  for (const h of toArray(hosts)) {
    const key = hostKeyOf(h);
    if (key && wanted.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

export function isInScope(scope, key) {
  return !!key && toArray(scope).includes(key);
}

/// 单台勾选/取消，返回新数组（不改入参，便于直接赋给 thread 并做快照比较）。
export function toggleHost(scope, key) {
  if (!key) return toArray(scope).slice();
  const list = toArray(scope);
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/// 整组全选/全不选。keys 只含该组现存主机。
export function setGroup(scope, keys, on) {
  const list = toArray(scope);
  const set = new Set(keys);
  if (on) {
    const out = list.slice();
    for (const k of set) if (!out.includes(k)) out.push(k);
    return out;
  }
  return list.filter((k) => !set.has(k));
}

/// 目录行的三态：全选 / 部分 / 未选。空目录按 none。
export function groupState(scope, keys) {
  const list = toArray(scope);
  const valid = toArray(keys).filter(Boolean);
  if (!valid.length) return 'none';
  const hit = valid.filter((k) => list.includes(k)).length;
  if (hit === 0) return 'none';
  return hit === valid.length ? 'all' : 'part';
}

/// 主机列表 → 目录分组（保持目录首次出现次序，组内保持主机原序）。
export function groupHostsByFolder(hosts = [], fallback = '我的主机') {
  const groups = new Map();
  for (const h of toArray(hosts)) {
    const name = folderOf(h, fallback);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(h);
  }
  return [...groups.entries()].map(([name, list]) => ({
    name,
    hosts: list,
    keys: list.map(hostKeyOf).filter(Boolean),
  }));
}

/// 回合快照：执行期间范围变更不影响在跑的这一轮（F22）。
export function snapshotRunScope(scope) {
  return toArray(scope).slice();
}

/// 范围是否允许对这台主机发起工具调用。工具层与前端共用同一条判定。
export function allowsHost(runScope, hostKey) {
  return isInScope(runScope, hostKey);
}

/// 工具层硬边界校验（F20）：校验 requested（可为 hostKey / 主机名 / IP）是否落在 runScope 内。
export function validateToolHost({ runScope = [], requested = '', hosts = [] } = {}) {
  const scope = toArray(runScope).filter(Boolean);
  const raw = String(requested || '').replace(/^@/, '').trim();
  if (!scope.length) {
    return {
      ok: false,
      code: 'out_of_scope',
      reason: '当前会话未勾选任何可操作主机（纯对话模式）',
    };
  }
  if (!raw) {
    return { ok: true, hostKey: scope[0], host: null };
  }
  const lower = raw.toLowerCase();
  const directKey = scope.find((k) => String(k).toLowerCase() === lower);
  if (directKey) {
    const h = toArray(hosts).find((item) => hostKeyOf(item) === directKey) || null;
    return { ok: true, hostKey: directKey, host: h };
  }
  const scopeSet = new Set(scope.map((k) => String(k).toLowerCase()));
  for (const h of toArray(hosts)) {
    const key = hostKeyOf(h);
    if (!key || !scopeSet.has(String(key).toLowerCase())) continue;
    const label = (hostLabelOf(h) || '').toLowerCase();
    const addr = String(h?.host || h?.ip || '').toLowerCase();
    if ((label && label === lower) || (addr && addr === lower)) {
      return { ok: true, hostKey: key, host: h };
    }
  }
  return {
    ok: false,
    code: 'out_of_scope',
    reason: `主机「${raw}」不在本轮允许的主机范围（${scope.join(', ')}）内`,
  };
}

/// 输入区主机钮的文案：0 台 → 未选主机；1 台 → 主机名；N 台 → N 台可操作。
export function scopeSummary(scope, hosts = []) {
  const list = toArray(scope);
  const count = list.length;
  if (!count) return { count, label: SCOPE_EMPTY_LABEL, single: null };
  const byKey = new Map(toArray(hosts).map((h) => [hostKeyOf(h), h]));
  if (count === 1) {
    const h = byKey.get(list[0]);
    const name = hostLabelOf(h) || list[0];
    return { count, label: name, single: list[0] };
  }
  return { count, label: `${count} 台可操作`, single: null };
}

/// 新建会话的默认范围：快照当前终端那一台（一次性默认值，之后切标签不再变化）。
/// 主机库之外的直连会话（快速连接）同样可以成为默认范围，所以不校验 hosts。
export function defaultScopeForNewThread({ activeHostKey } = {}) {
  return activeHostKey ? [activeHostKey] : [];
}

/// chip 的失效判定是派生的：范围缩小时旧 chip 不变灰就落库，会与 scope 脱节（F25）。
export function mentionState(scope, key) {
  return isInScope(scope, key) ? 'in' : 'out';
}

/// 目标解析（纯函数）：只回答「这个会话现在能操作谁」，
/// 不猜模型会挑哪台 —— 那是模型的软判断，前端提前算出来的只是假承诺。
export function resolveScopeTarget({ thread, hosts = [], sessions = [] } = {}) {
  const list = toArray(hosts);
  const scope = normalizeScope(thread?.scope, list);
  const scopeHosts = list.filter((h) => scope.includes(hostKeyOf(h)));
  const count = scopeHosts.length;
  const connected = new Set(
    toArray(sessions).filter((s) => s && s.status === 'connected').map((s) => hostKeyOf(s.host)).filter(Boolean),
  );
  const reachable = scopeHosts.filter((h) => connected.has(hostKeyOf(h))).length;
  const kind = count === 0 ? 'chat' : 'scoped';
  const denied = scopeHosts.filter((h) => h.aiAccess === 'deny').length;
  let statusText = '';
  if (kind === 'chat') statusText = '纯对话 · 不操作主机';
  else if (count === 1) statusText = reachable ? '已连接' : '未连接';
  else statusText = reachable === count ? '全部就绪' : `${count - reachable} 台未连接`;
  return {
    kind,
    scope,
    hosts: scopeHosts,
    count,
    reachable,
    denied,
    statusText,
    summary: scopeSummary(scope, list),
    // 范围为空时档位控件隐藏：没连主机却能选"完全托管"是无效控件
    showModeControl: kind !== 'chat',
  };
}
