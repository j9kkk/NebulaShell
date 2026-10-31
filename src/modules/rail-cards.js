// 收起态窄条的三个浮层（v6 设计稿）：
//   host      → 仍由 sidebar-peek.js 渲染「整块 side-panel」停靠卡；本模块不碰
//   commands  → 常用命令卡 300px
//   batch     → 批量执行卡 340px（卡内直接跑，结果注入完整面板查看）
//   session   → 活动会话卡 240px，只列已连接主机
// 三张卡共用 #rail-pop 一个壳：同屏一张、点外/Esc 关闭、展开侧栏即清。
import { api, hasOpenModal, state, toast } from './core.js';
import { escapeHtml, regionLabel, uiPrefs } from './hosts.js';
import { icon } from '../shared/icons.js';
import { activateSession, feedTrusted } from './terminal.js';
import { openSnippetsModal } from './monitor.js';
import { batchChecked, openBatchModal, showBatchSnapshot } from './tools.js';

const KIND_LABEL = { commands: '常用命令', batch: '批量执行', session: '活动会话' };
const WIDTH = { commands: 300, batch: 340, session: 240 };

let openKind = '';
let bound = false;
let batchCard = null;   // {seg, sel:Set, cmd, running, hostIds, results:Map, requestId, parallel, timeout}
let batchOff = null;
let sessionTimer = 0;

const $ = (sel, root = document) => root.querySelector(sel);
const sidebar = () => document.getElementById('sidebar');
const pop = () => document.getElementById('rail-pop');
const isCollapsed = () => !!sidebar()?.classList.contains('collapsed');

function activeSessions() {
  return [...state.sessions.values()].filter((s) => s.status === 'connected' && s.host);
}

function connectedHostIds() {
  const ids = new Set();
  for (const s of activeSessions()) ids.add(s.host.id);
  return ids;
}

function favoriteHostIds() {
  return new Set(uiPrefs().favoriteHostIds || []);
}

function hostRegion(h) {
  return h.region ? regionLabel(h.region) : '';
}

function setRailActive(kind) {
  const map = { commands: 'rail-commands', batch: 'rail-batch', session: 'rail-session-status' };
  for (const [key, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const on = key === kind;
    el.classList.toggle('rail-on', on);
    el.setAttribute('aria-expanded', String(on));
  }
  const hostsBtn = document.getElementById('rail-hosts');
  if (hostsBtn) hostsBtn.setAttribute('aria-expanded', String(!!sidebar()?.classList.contains('peek-open')));
}

function closeCard({ focusBack = false } = {}) {
  if (!openKind) return;
  const el = pop();
  const hadFocus = !!(el && el.contains(document.activeElement));
  const kind = openKind;
  openKind = '';
  clearTimeout(sessionTimer);
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
    el.removeAttribute('data-kind');
    el.style.top = '';
    el.removeAttribute('aria-label');
  }
  setRailActive('');
  if (focusBack && hadFocus) {
    const id = kind === 'session' ? 'rail-session-status' : `rail-${kind}`;
    document.getElementById(id)?.focus();
  }
}

function openCard(kind) {
  if (!isCollapsed()) return;
  if (openKind === kind) { closeCard({ focusBack: true }); return; }
  const el = pop();
  if (!el) return;
  // 停靠卡片 / 另一张工具卡同时只能存在一个
  document.dispatchEvent(new CustomEvent('nebula:rail-card-open'));
  if (kind === 'session') {
    const connected = connectedHostIds();
    if (!connected.size) { toast('当前没有已连接的主机', 'warn'); return; }
  }
  if (kind === 'batch' && !batchCard?.running) initBatchCard();
  openKind = kind;
  el.hidden = false;
  el.dataset.kind = kind;
  el.style.top = '';
  el.setAttribute('aria-label', KIND_LABEL[kind]);
  el.innerHTML = kind === 'commands' ? commandsHTML() : kind === 'batch' ? batchHTML() : sessionHTML();
  setRailActive(kind);
  if (kind === 'commands') bindCommands();
  else if (kind === 'batch') bindBatch();
  else { bindSession(); positionSessionCard(); }
}

function positionSessionCard() {
  const el = pop();
  const sb = sidebar();
  const cap = document.getElementById('rail-session-status');
  if (!el || !sb || !cap) return;
  const top = Math.round(cap.getBoundingClientRect().top - sb.getBoundingClientRect().top);
  el.style.top = Math.max(8, top) + 'px';
  requestAnimationFrame(() => {
    if (!openKind || !el || el.hidden) return;
    const max = sb.clientHeight - el.offsetHeight - 8;
    if (max > 0 && top > max) el.style.top = Math.max(8, max) + 'px';
  });
}

/* ---------------- 常用命令 ---------------- */
function snippets() {
  return Array.isArray(state.settings?.snippets) ? state.settings.snippets : [];
}

function commandsHTML() {
  const all = snippets();
  const rows = all.map((s, i) => `
    <div class="rp-snip" data-rp-snip="${i}" title="点击插入终端">
      <div class="rp-snip-main">
        <span class="rp-snip-name">${escapeHtml(s.name || s.cmd || '未命名')}</span>
        <span class="rp-snip-cmd">${escapeHtml(s.cmd || '')}</span>
      </div>
      <button class="rp-play" type="button" data-rp-play="${i}" aria-label="执行 ${escapeHtml(s.name || s.cmd || '')}" title="直接执行">${icon('play', { size: 11 })}</button>
    </div>`).join('');
  return `
    <div class="rp-head">
      <span class="rp-ic">${icon('command', { size: 14 })}</span>
      <span class="rp-title">常用命令</span><span class="rp-count">${all.length}</span>
      <span class="rp-sp"></span>
      <button class="btn icon ghost" type="button" data-rp-manage aria-label="管理常用命令" title="管理全部">${icon('dots', { size: 13 })}</button>
      <button class="btn icon ghost" type="button" data-rp-close aria-label="关闭" title="关闭">${icon('x', { size: 13 })}</button>
    </div>
    <div class="rp-body">
      <div class="rp-search">${icon('search', { size: 13 })}<input type="text" placeholder="搜索名称 / 命令…" aria-label="搜索常用命令" autocomplete="off" spellcheck="false" /></div>
      <div class="rp-snip-list">${rows || '<div class="rp-empty">还没有常用命令<br/>在「管理全部」里添加</div>'}</div>
      <div class="rp-empty" data-rp-noresult hidden>没有匹配的命令</div>
    </div>
    <div class="rp-foot"><span>点击行插入 · ▶ 执行</span><span class="rp-sp"></span><button class="rp-link" type="button" data-rp-manage>管理全部 →</button></div>`;
}

function bindCommands() {
  const el = pop();
  const all = snippets();
  el.querySelector('[data-rp-close]')?.addEventListener('click', () => closeCard({ focusBack: true }));
  el.querySelectorAll('[data-rp-manage]').forEach((b) => b.addEventListener('click', () => {
    closeCard();
    openSnippetsModal();
  }));
  const input = $('.rp-search input', el);
  const rows = [...el.querySelectorAll('.rp-snip')];
  const noResult = el.querySelector('[data-rp-noresult]');
  const applyFilter = () => {
    const q = (input?.value || '').trim().toLowerCase();
    let visible = 0;
    for (const row of rows) {
      const show = !q || row.textContent.toLowerCase().includes(q);
      row.style.display = show ? '' : 'none';
      if (show) visible += 1;
    }
    if (noResult) noResult.hidden = visible > 0 || !q;
  };
  input?.addEventListener('input', applyFilter);
  const run = async (i, execute) => {
    const s = all[i];
    if (!s) return;
    const r = await feedTrusted(s.cmd || '', { execute });
    if (!r?.ok) { toast(r?.reason || '无法写入当前终端', 'error'); return; }
    closeCard({ focusBack: true });
  };
  rows.forEach((row) => {
    const i = Number(row.dataset.rpSnip);
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-rp-play]')) return;
      run(i, false);
    });
    $('[data-rp-play]', row)?.addEventListener('click', (e) => {
      e.stopPropagation();
      run(i, true);
    });
  });
  // 点击卡片空白处不冒泡到文档的「点外关闭」
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/* ---------------- 活动会话 ---------------- */
function sessionRows() {
  const map = new Map();
  for (const s of activeSessions()) {
    const h = s.host;
    const active = s.sessionId === state.activeId;
    const existing = map.get(h.id);
    if (!existing) map.set(h.id, { host: h, session: s, active });
    else if (active) { existing.session = s; existing.active = true; }
  }
  return [...map.values()];
}

function sessionHTML() {
  const rows = sessionRows();
  const list = rows.map(({ host, session, active }) => `
    <button class="rp-sess ${active ? 'on' : ''}" type="button" data-rp-session="${escapeHtml(session.sessionId)}">
      <i class="rp-dot"></i><span class="rp-nm">${escapeHtml(host.name || host.host)}</span>
    </button>`).join('');
  return `
    <div class="rp-head">
      <i class="rp-dot"></i><span class="rp-title">活动会话</span><span class="rp-count">${rows.length} 台</span>
      <span class="rp-sp"></span>
      <button class="btn icon ghost" type="button" data-rp-close aria-label="关闭" title="关闭">${icon('x', { size: 13 })}</button>
    </div>
    <div class="rp-body rp-body-session">${list || '<div class="rp-empty">暂无已连接的主机</div>'}</div>`;
}

function bindSession() {
  const el = pop();
  el.querySelector('[data-rp-close]')?.addEventListener('click', () => closeCard({ focusBack: true }));
  el.querySelectorAll('[data-rp-session]').forEach((b) => b.addEventListener('click', () => {
    const sid = b.dataset.rpSession;
    closeCard();
    activateSession(sid);
  }));
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/* ---------------- 批量执行 ---------------- */
function batchParams() {
  const pRaw = Number(document.getElementById('batch-parallel')?.value);
  const tRaw = Number(document.getElementById('batch-timeout')?.value);
  const parallel = Number.isInteger(pRaw) && pRaw >= 1 && pRaw <= 10 ? pRaw : 5;
  const timeout = Number.isInteger(tRaw) && tRaw >= 1 && tRaw <= 600 ? tRaw : 30;
  return { parallel, timeout };
}

function initBatchCard() {
  const known = new Set(state.hosts.map((h) => h.id));
  const connected = new Set([...connectedHostIds()].filter((id) => known.has(id)));
  const seg = connected.size ? 'connected' : 'all';
  const sel = new Set(seg === 'connected' ? connected : known);
  const { parallel, timeout } = batchParams();
  batchCard = { seg, sel, cmd: '', running: false, hostIds: [], results: new Map(), requestId: '', parallel, timeout };
}

function filteredBatchHosts() {
  const b = batchCard;
  const fav = favoriteHostIds();
  if (b.seg === 'connected') {
    const connected = connectedHostIds();
    return state.hosts.filter((h) => connected.has(h.id));
  }
  if (b.seg === 'favorites') return state.hosts.filter((h) => fav.has(h.id));
  return state.hosts;
}

function batchStatusText() {
  const b = batchCard;
  if (!b) return '未执行';
  if (b.running) return `执行中 (${b.results.size}/${b.hostIds.length || b.sel.size})…`;
  if (!b.results.size) return '未执行';
  const all = [...b.results.values()];
  const ok = all.filter((r) => r.ok && !r.cancelled).length;
  const cancelled = all.filter((r) => r.cancelled).length;
  const fail = all.length - ok - cancelled;
  const ms = Math.max(0, ...all.map((r) => Number(r.ms) || 0));
  let text = `${ok}/${all.length} 完成`;
  if (fail) text += ` · ${fail} 失败`;
  if (cancelled) text += ` · ${cancelled} 取消`;
  if (ms) text += ms < 1000 ? ` · ${ms}ms` : ` · ${(ms / 1000).toFixed(1)}s`;
  return text;
}

function batchHostRow(h) {
  const b = batchCard;
  const r = b.results.get(h.id);
  const running = b.running && b.sel.has(h.id);
  const stat = r
    ? `<span class="rp-bst ${r.cancelled ? '' : r.ok ? 'ok' : 'err'}">${r.cancelled ? '取消' : r.ok ? `${Math.max(1, Math.round(Number(r.ms) || 0))}ms` : '失败'}</span>`
    : running ? '<span class="rp-bst">…</span>' : '';
  const region = hostRegion(h);
  return `<div class="rp-host ${b.sel.has(h.id) ? 'on' : ''}" data-rp-host="${escapeHtml(h.id)}" role="checkbox" tabindex="0" aria-checked="${b.sel.has(h.id)}">
    <i class="rp-cb"></i><span class="rp-nm">${escapeHtml(h.name || h.host)}</span>${region ? `<span class="rp-rg">${escapeHtml(region)}</span>` : ''}${stat}
  </div>`;
}

function batchHTML() {
  const b = batchCard;
  const conn = connectedHostIds();
  const connCount = state.hosts.filter((h) => conn.has(h.id)).length;
  const fav = favoriteHostIds();
  const favCount = state.hosts.filter((h) => fav.has(h.id)).length;
  const hosts = filteredBatchHosts();
  const rows = hosts.map(batchHostRow).join('');
  const status = batchStatusText();
  const canRun = !b.running && b.cmd.trim() && b.sel.size;
  const foot = b.running
    ? `<span class="rp-status">${escapeHtml(status)}</span><span class="rp-sp"></span><span class="rp-count">${b.parallel} 并行 · ${b.timeout}s</span>`
    : b.results.size
      ? `<span class="rp-status">${escapeHtml(status)}</span><span class="rp-sp"></span><button class="rp-link" type="button" data-rp-view>查看结果 →</button><button class="btn small" type="button" data-rp-run>重新执行</button>`
      : `<span class="rp-status">${escapeHtml(status)}</span><span class="rp-sp"></span><button class="rp-link" type="button" data-rp-full>完整面板</button><button class="btn small primary" type="button" data-rp-run ${canRun ? '' : 'disabled'}>▶ 执行</button>`;
  return `
    <div class="rp-head">
      <span class="rp-ic">${icon('zap', { size: 14 })}</span>
      <span class="rp-title">批量执行</span><span class="rp-count">${state.hosts.length} 台主机</span>
      <span class="rp-sp"></span>
      <button class="btn icon ghost" type="button" data-rp-full aria-label="完整面板" title="完整面板">${icon('dots', { size: 13 })}</button>
      <button class="btn icon ghost" type="button" data-rp-close aria-label="关闭" title="关闭">${icon('x', { size: 13 })}</button>
    </div>
    <div class="rp-body">
      <div class="rp-seg" role="tablist" aria-label="目标范围">
        <button type="button" data-rp-seg="all" class="${b.seg === 'all' ? 'on' : ''}">全部 <b>${state.hosts.length}</b></button>
        <button type="button" data-rp-seg="connected" class="${b.seg === 'connected' ? 'on' : ''}">已连接 <b>${connCount}</b></button>
        <button type="button" data-rp-seg="favorites" class="${b.seg === 'favorites' ? 'on' : ''}">收藏 <b>${favCount}</b></button>
      </div>
      <div class="rp-hosts">${rows || '<div class="rp-empty">这个范围下没有主机</div>'}</div>
      <textarea class="rp-cmd" data-rp-cmd placeholder="例如：df -h && free -m" spellcheck="false" aria-label="批量执行的命令"${b.running ? ' disabled' : ''}>${escapeHtml(b.cmd)}</textarea>
      <div class="rp-meta"><span>并行 ${b.parallel} · 超时 ${b.timeout}s</span><span class="rp-sp"></span><button class="rp-link" type="button" data-rp-full>参数…</button></div>
    </div>
    <div class="rp-foot">${foot}</div>`;
}

function updateBatchRunState() {
  const el = pop();
  if (!el || openKind !== 'batch' || !batchCard) return;
  const btn = el.querySelector('[data-rp-run]');
  if (btn && !batchCard.running && !batchCard.results.size) {
    btn.disabled = !(batchCard.cmd.trim() && batchCard.sel.size);
  }
  const st = el.querySelector('.rp-status');
  if (st) st.textContent = batchStatusText();
}

function updateBatchRow(result) {
  if (openKind !== 'batch') return;
  const el = pop();
  if (!el) return;
  const row = [...el.querySelectorAll('.rp-host')].find((r) => r.dataset.rpHost === result.hostId);
  if (!row) return;
  let st = row.querySelector('.rp-bst');
  if (!st) {
    st = document.createElement('span');
    st.className = 'rp-bst';
    row.appendChild(st);
  }
  st.className = 'rp-bst' + (result.cancelled ? '' : result.ok ? ' ok' : ' err');
  st.textContent = result.cancelled ? '取消' : result.ok ? `${Math.max(1, Math.round(Number(result.ms) || 0))}ms` : '失败';
}

function showBatchCard() {
  if (openKind !== 'batch' || !pop()) return;
  pop().innerHTML = batchHTML();
  bindBatch();
}

function syncBatchToModal() {
  if (!batchCard) return;
  batchChecked.clear();
  for (const id of batchCard.sel) batchChecked.add(id);
  const cmd = document.getElementById('batch-cmd');
  if (cmd) cmd.value = batchCard.cmd;
}

function openFullBatch() {
  syncBatchToModal();
  closeCard();
  openBatchModal();
}

function viewBatchResults() {
  if (!batchCard?.results.size) return;
  const results = [...batchCard.results.values()];
  showBatchSnapshot({
    command: batchCard.cmd,
    hostIds: batchCard.hostIds,
    results,
    parallel: batchCard.parallel,
    timeout: batchCard.timeout,
    statusText: batchStatusText(),
  });
  closeCard();
}

async function runBatchCard() {
  const b = batchCard;
  if (!b || b.running) return;
  const cmd = b.cmd.trim();
  const hostIds = [...b.sel];
  if (!cmd) { toast('请输入命令', 'error'); $('[data-rp-cmd]', pop())?.focus(); return; }
  if (!hostIds.length) { toast('请选择目标主机', 'error'); return; }
  const params = batchParams();
  b.parallel = params.parallel;
  b.timeout = params.timeout;
  b.running = true;
  b.hostIds = hostIds;
  b.results = new Map();
  b.requestId = `rail-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requestId = b.requestId;
  showBatchCard();
  const off = typeof window !== 'undefined' && window.nebula?.on
    ? window.nebula.on('batch:progress', (result) => {
      if (!result || (result.requestId && result.requestId !== requestId)) return;
      if (batchCard !== b || !b.hostIds.includes(result.hostId)) return;
      b.results.set(result.hostId, { ...result });
      updateBatchRow(result);
      updateBatchRunState();
    })
    : () => {};
  batchOff = off;
  try {
    const results = await api('batch:exec', {
      requestId,
      hostIds,
      command: cmd,
      timeoutMs: b.timeout * 1000,
      maxParallel: b.parallel,
    });
    for (const result of Array.isArray(results) ? results : []) {
      if (!result || !b.hostIds.includes(result.hostId)) continue;
      b.results.set(result.hostId, { ...result });
    }
    for (const id of hostIds) {
      if (!b.results.has(id)) b.results.set(id, { hostId: id, ok: false, error: '后端未返回此主机的执行结果' });
    }
    b.running = false;
    const all = [...b.results.values()];
    const ok = all.filter((r) => r.ok && !r.cancelled).length;
    const fail = all.length - ok - all.filter((r) => r.cancelled).length;
    if (fail) toast(`批量执行完成（${ok}/${all.length} 成功）`, 'error');
    else toast(`批量执行完成（${ok}/${all.length} 成功）`, 'success');
  } catch (e) {
    for (const id of hostIds) {
      if (!b.results.has(id)) b.results.set(id, { hostId: id, ok: false, error: '执行请求失败：' + e.message });
    }
    b.running = false;
    toast('批量执行失败：' + e.message, 'error');
  } finally {
    try { off(); } catch { /* ignore */ }
    if (batchOff === off) batchOff = null;
    if (openKind === 'batch' && batchCard === b) showBatchCard();
  }
}

function bindBatch() {
  const el = pop();
  el.querySelector('[data-rp-close]')?.addEventListener('click', () => closeCard({ focusBack: true }));
  el.querySelectorAll('[data-rp-full]').forEach((b) => b.addEventListener('click', openFullBatch));
  el.querySelector('[data-rp-view]')?.addEventListener('click', viewBatchResults);
  el.querySelector('[data-rp-run]')?.addEventListener('click', () => {
    if (batchCard?.results.size && !batchCard.running) {
      // 重新执行：清空上一批，保留目标与命令
      batchCard.results = new Map();
      batchCard.hostIds = [];
    }
    runBatchCard();
  });
  el.querySelectorAll('[data-rp-seg]').forEach((b) => b.addEventListener('click', () => {
    if (!batchCard || batchCard.running) return;
    batchCard.seg = b.dataset.rpSeg;
    const visible = filteredBatchHosts().map((h) => h.id);
    batchCard.sel = new Set(visible);
    showBatchCard();
  }));
  el.querySelectorAll('[data-rp-host]').forEach((row) => {
    const toggle = () => {
      if (!batchCard || batchCard.running) return;
      const id = row.dataset.rpHost;
      if (batchCard.sel.has(id)) batchCard.sel.delete(id); else batchCard.sel.add(id);
      row.classList.toggle('on', batchCard.sel.has(id));
      row.setAttribute('aria-checked', String(batchCard.sel.has(id)));
      updateBatchRunState();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  const cmd = el.querySelector('[data-rp-cmd]');
  cmd?.addEventListener('input', () => {
    if (!batchCard) return;
    batchCard.cmd = cmd.value;
    updateBatchRunState();
  });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}

/* ---------------- 窄条接线 ---------------- */
export function bindRailCards() {
  if (bound) return;
  const sb = sidebar();
  if (!sb) return;
  bound = true;
  // 主机按钮的 click 由 sidebar-peek 负责开/关停靠卡。
  // 窄条不再有「点击展开」：空白处点按不做事，展开走标题栏开关 / ⌘B。
  document.getElementById('rail-commands')?.addEventListener('click', () => openCard('commands'));
  document.getElementById('rail-batch')?.addEventListener('click', () => openCard('batch'));
  document.getElementById('rail-session-status')?.addEventListener('click', () => openCard('session'));

  document.addEventListener('pointerdown', (e) => {
    if (!openKind) return;
    if (e.target.closest('#rail-pop')) return;
    if (e.target.closest('.side-rail')) return;
    closeCard();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!openKind || e.key !== 'Escape' || hasOpenModal()) return;
    e.stopPropagation();
    closeCard({ focusBack: true });
  });
  document.addEventListener('nebula:modal-scope', () => {
    if (openKind && document.body.classList.contains('modal-open')) closeCard();
  });
  document.addEventListener('nebula:peek-open', () => {
    if (openKind) closeCard();
    const hb = document.getElementById('rail-hosts');
    hb?.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('nebula:state-change', () => {
    if (openKind === 'session') {
      if (!connectedHostIds().size) { closeCard(); return; }
      pop().innerHTML = sessionHTML();
      bindSession();
      positionSessionCard();
    }
  });
  window.addEventListener('resize', () => {
    if (openKind === 'session') positionSessionCard();
  });
}

export function closeRailCard() {
  closeCard();
}
