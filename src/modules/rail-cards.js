// 左轨 44px 交互收口（M3 统一直达模型）：
//   主机           → sidebar-peek.js（展开态切侧栏，收起态停靠卡）
//   常用命令/批量/历史/转发 → index.html data-command 直达对应全功能 Modal（消除双套实现）
//   活动会话       → 本模块仅保留轻量 Popover（#rail-pop，点击切换已连接会话）
// 同时维护左轨激活态滑块指示器（.side-rail::before）。
import { state, toast } from './core.js';
import { closeOverlay, closeOverlayGroup, openOverlay } from './overlay-manager.js';
import { escapeHtml } from './hosts.js';
import { icon } from '../shared/icons.js';
import { activateSession } from './terminal.js';

let sessionOpen = false;
let bound = false;

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

/// E1 常驻图标轨滑块指示器：追踪当前激活的 .rail-on 模块按钮，
/// 用 --rail-pill-y / --rail-pill-h 驱动 .side-rail::before 纵向平滑滑动。
export function syncRailPill() {
  const rail = sidebar()?.querySelector('.side-rail');
  if (!rail || typeof rail.style?.setProperty !== 'function') return;
  const active = rail.querySelector('.rail-on');
  if (!active || active.hidden) {
    rail.style.setProperty('--rail-pill-o', '0');
    delete rail.dataset.pill;
    return;
  }
  const railRect = rail.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  if (!(btnRect.height > 0)) return;
  const h = Math.max(14, Math.round(btnRect.height - 12));
  const y = Math.round(btnRect.top - railRect.top + (btnRect.height - h) / 2);
  const wasReady = rail.dataset.pill === 'ready';
  rail.style.setProperty('--rail-pill-y', y + 'px');
  rail.style.setProperty('--rail-pill-h', h + 'px');
  rail.style.setProperty('--rail-pill-o', '1');
  if (!wasReady && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (rail.querySelector('.rail-on')) rail.dataset.pill = 'ready';
    });
  }
}

function setRailActive(onSession) {
  const sessBtn = document.getElementById('rail-session-status');
  if (sessBtn) {
    sessBtn.classList.toggle('rail-on', onSession);
    sessBtn.setAttribute('aria-expanded', String(onSession));
  }
  const hostsBtn = document.getElementById('rail-hosts');
  if (hostsBtn) {
    const sb = sidebar();
    const hostsOn = !onSession && (!isCollapsed() || !!sb?.classList.contains('peek-open'));
    hostsBtn.classList.toggle('rail-on', hostsOn);
    hostsBtn.setAttribute('aria-expanded', String(hostsOn));
  }
  syncRailPill();
}

function closeSessionPop({ focusBack = false } = {}) {
  if (!sessionOpen) {
    closeOverlay('rail-pop');
    return;
  }
  const el = pop();
  const hadFocus = !!(el && el.contains(document.activeElement));
  sessionOpen = false;
  sidebar()?.classList.remove('rail-pop-open');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
    el.removeAttribute('data-kind');
    el.style.top = '';
    el.removeAttribute('aria-label');
  }
  closeOverlay('rail-pop');
  setRailActive(false);
  if (focusBack && hadFocus) {
    document.getElementById('rail-session-status')?.focus();
  }
}

function positionSessionCard() {
  const el = pop();
  const sb = sidebar();
  const cap = document.getElementById('rail-session-status');
  if (!el || !sb || !cap) return;
  const top = Math.round(cap.getBoundingClientRect().top - sb.getBoundingClientRect().top);
  el.style.top = Math.max(8, top) + 'px';
  requestAnimationFrame(() => {
    if (!sessionOpen || !el || el.hidden) return;
    const max = sb.clientHeight - el.offsetHeight - 8;
    if (max > 0 && top > max) el.style.top = Math.max(8, max) + 'px';
  });
}

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
  el.querySelector('[data-rp-close]')?.addEventListener('click', () => closeSessionPop({ focusBack: true }));
  el.querySelectorAll('[data-rp-session]').forEach((b) => b.addEventListener('click', () => {
    const sid = b.dataset.rpSession;
    closeSessionPop();
    activateSession(sid);
  }));
}

function toggleSessionPop() {
  if (sessionOpen) { closeSessionPop({ focusBack: true }); return; }
  const el = pop();
  if (!el) return;
  closeOverlayGroup('drawer-overlay', { reason: 'rail-card' });
  document.dispatchEvent(new CustomEvent('nebula:rail-card-open'));
  if (!connectedHostIds().size) { toast('当前没有已连接的主机', 'warn'); return; }
  sessionOpen = true;
  sidebar()?.classList.add('rail-pop-open');
  el.hidden = false;
  el.dataset.kind = 'session';
  el.style.top = '';
  el.setAttribute('aria-label', '活动会话');
  el.innerHTML = sessionHTML();
  setRailActive(true);
  openOverlay({
    id: 'rail-pop',
    kind: 'popover',
    group: 'floating',
    el,
    triggers: () => [document.getElementById('rail-session-status')].filter(Boolean),
    closeOnResize: false,
    onResize: () => { if (sessionOpen) positionSessionCard(); },
    close: ({ focusTrigger } = {}) => closeSessionPop({ focusBack: !!focusTrigger }),
  });
  bindSession();
  positionSessionCard();
}

export function bindRailCards() {
  if (bound) return;
  const sb = sidebar();
  if (!sb) return;
  bound = true;
  document.getElementById('rail-session-status')?.addEventListener('click', toggleSessionPop);

  document.addEventListener('nebula:peek-open', () => {
    if (sessionOpen) closeSessionPop();
    const hb = document.getElementById('rail-hosts');
    hb?.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('nebula:state-change', () => {
    if (sessionOpen) {
      if (!connectedHostIds().size) { closeSessionPop(); return; }
      pop().innerHTML = sessionHTML();
      bindSession();
      positionSessionCard();
    }
  });
  window.addEventListener('resize', () => {
    syncRailPill();
  });
  refreshRailState();
}

export function closeRailCard() {
  closeSessionPop();
}

export function refreshRailState() {
  setRailActive(sessionOpen);
}
