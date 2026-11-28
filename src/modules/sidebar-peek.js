// 收起态主机按钮的停靠卡。
//
// v7 统一模型：窄条所有按钮 hover 只出 tooltip，click 才开/关浮层。
// 主机按钮 click 只开关 264 停靠卡，不再自动展开侧栏；展开走标题栏开关或 ⌘B。
// 卡片是 `.side-panel` 本体（与展开态同一份 DOM），用 #sidebar.peek-open 控制显隐，
// 不复制一份主机列表。

import { closeRailCard, refreshRailState } from './rail-cards.js';
import { closeAllOverlays, closeOverlay, openOverlay } from './overlay-manager.js';

let bound = false;

function sidebar() {
  return document.getElementById('sidebar');
}

function hostButton() {
  return document.getElementById('rail-hosts');
}

function hostDock() {
  return sidebar()?.querySelector('.side-panel');
}

export function isPeekOpen() {
  return !!sidebar()?.classList.contains('peek-open');
}

function syncHostButton(on) {
  const btn = hostButton();
  if (!btn) return;
  btn.classList.toggle('rail-on', on);
  btn.setAttribute('aria-expanded', String(on));
  refreshRailState();
}

export function closePeek({ focusBack = false } = {}) {
  const sb = sidebar();
  if (!sb || !sb.classList.contains('peek-open')) {
    closeOverlay('sidebar-peek');
    return;
  }
  const panel = hostDock();
  const ae = document.activeElement;
  const wasInside = !!(panel && ae && panel.contains(ae));
  sb.classList.remove('peek-open');
  closeOverlay('sidebar-peek');
  syncHostButton(false);
  // 卡片里还有焦点时不能让它悬空：Esc 回触发按钮；点外面交给点击目标。
  if (wasInside) {
    if (focusBack) hostButton()?.focus();
    else {
      const term = document.querySelector('.term-pane.focused .xterm-helper-textarea');
      if (term) term.focus();
      else ae?.blur();
    }
  }
}

function openPeek() {
  const sb = sidebar();
  if (!sb || sb.classList.contains('peek-open') || !sb.classList.contains('collapsed')) return;
  if (document.body.classList.contains('modal-open')) return;
  // 工具卡 / 窄屏右抽屉让位：同屏只允许一个抽屉浮层
  closeAllOverlays({ kinds: ['popover'], reason: 'peek' });
  document.dispatchEvent(new CustomEvent('nebula:peek-open'));
  sb.classList.add('peek-open');
  syncHostButton(true);
  openOverlay({
    id: 'sidebar-peek',
    kind: 'drawer-overlay',
    group: 'drawer-overlay',
    el: sb,
    triggers: () => [hostButton()].filter(Boolean),
    allowOutside: () => ['#ctx-menu', '#ctx-sub'],
    closeOnResize: false,
    close: ({ focusTrigger } = {}) => closePeek({ focusBack: !!focusTrigger }),
  });
}

export function togglePeek() {
  if (isPeekOpen()) closePeek({ focusBack: true });
  else openPeek();
}

/// 绑定一次即可（entry 启动时调用）。重复调用无害。
export function bindSidebarPeek() {
  if (bound) return;
  const sb = sidebar();
  const btn = hostButton();
  if (!sb || !btn) return;
  bound = true;

  btn.addEventListener('click', () => {
    const sbEl = sidebar();
    if (!sbEl) return;
    if (!sbEl.classList.contains('collapsed')) {
      // 常驻图标轨：展开态若工具浮层打开则先收回浮层回切主机；否则直接收起侧栏面板
      if (sbEl.classList.contains('rail-pop-open')) {
        closeRailCard();
        return;
      }
      document.getElementById('btn-sidebar-toggle')?.click();
      return;
    }
    togglePeek();
  });

  // 点/中键卡片里的主机：连接由 host-item 自己的处理器完成，这里只负责收回。
  const hostClose = (e) => {
    if (!isPeekOpen()) return;
    const item = e.target?.closest?.('#host-list .host-item');
    if (item && sb.contains(item)) closePeek();
  };
  document.addEventListener('click', hostClose);
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) hostClose(e);
  });
}

/// 侧栏展开/收起切换时清干净停靠态（否则展开态会带着 peek-open）。
export function resetPeekOnToggle() {
  closePeek();
}
