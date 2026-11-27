// 右侧上下文抽屉(E3):统一承接 AI 助手与主机监控/故障诊断两页签(容器沿用 #ai-panel)。
// 980px 窄宽档(<= 1100px)自动切换为浮动覆盖抽屉(body.rp-overlay),避免挤压终端可视宽度。
// 命令历史与常用命令仍路由到独立弹窗以兼容既有入口。
import { $, state } from './core.js';
import { refreshCommandStates } from './commands.js';
import { aiStickScroll, closeAiDrawer } from './ai.js';
import { openSnippetsModal, renderMonitorDrawer, renderSnippets } from './monitor.js';
import { fitAllVisible, scheduleResizeSync } from './terminal.js';
import { openHistoryModal, renderHistory } from './tools.js';

export const RIGHT_TABS = ['ai', 'monitor', 'history', 'snippets'];
const DRAWER_TABS = ['ai', 'monitor'];
const OVERLAY_MQ = '(max-width: 1100px)';

const panel = () => $('#ai-panel');
export const rightPanelOpen = () => !panel().classList.contains('hidden');
export const rightPanelTab = () => (DRAWER_TABS.includes(panel().dataset.tab) ? panel().dataset.tab : 'ai');
export const rightTabShown = (tab) => rightPanelOpen() && rightPanelTab() === tab;
export const isRightPanelOverlay = () => document.body?.classList?.contains('rp-overlay') ?? false;

/// 页签变为可见时刷新它的内容。
function onShown(tab) {
  if (tab === 'ai') aiStickScroll();
  else if (tab === 'monitor') renderMonitorDrawer();
  else if (tab === 'history') renderHistory($('#hist-search')?.value, { keepScroll: true });
  else if (tab === 'snippets') renderSnippets();
}

function selectTab(tab) {
  const root = panel();
  root.dataset.tab = tab;
  for (const button of root.querySelectorAll('.rp-tab')) {
    const on = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
  }
  for (const page of root.querySelectorAll('.rp-page')) page.classList.toggle('active', page.dataset.page === tab);
  for (const acts of root.querySelectorAll('.rp-head-acts')) acts.classList.toggle('hidden', acts.dataset.for !== tab);
}

function focusTerminal() {
  const session = state.sessions.get(state.activeId);
  if (session?.term) { try { session.term.focus(); return; } catch { /* ignore */ } }
  if (panel().contains(document.activeElement)) document.activeElement.blur();
}

function syncOverlayMode() {
  if (typeof window === 'undefined' || !window.matchMedia || !document.body) return;
  const overlay = window.matchMedia(OVERLAY_MQ).matches;
  const changed = document.body.classList.contains('rp-overlay') !== overlay;
  document.body.classList.toggle('rp-overlay', overlay);
  // 浮层与停靠切换时刷新终端尺寸(从停靠切到浮层会释放右侧 360px 给主终端)
  if (changed && rightPanelOpen()) { fitAllVisible(); scheduleResizeSync(); }
}

/// 打开或收起面板;tab 给出时切到该页签(ai / monitor)。收起时焦点若在面板里,还给终端。
export function setRightPanel(open, tab = null) {
  if (tab === 'history') {
    if (open) openHistoryModal();
    return;
  }
  if (tab === 'snippets') {
    if (open) openSnippetsModal();
    return;
  }
  const wasOpen = rightPanelOpen();
  const before = rightPanelTab();
  const target = DRAWER_TABS.includes(tab) ? tab : before;
  if (open) selectTab(target);
  if (!open && wasOpen && panel().contains(document.activeElement)) focusTerminal();
  if (!open || target !== 'ai') {
    $('#ai-model-menu')?.classList.add('hidden');
    $('#ai-mode-menu')?.classList.add('hidden');
    $('#ai-thread-menu')?.classList.add('hidden');
    $('#ai-scope-menu')?.classList.add('hidden');
  }
  panel().classList.toggle('hidden', !open);
  $('#ai-resizer')?.classList.toggle('hidden', !open);
  document.body?.classList?.toggle('rp-monitor-open', open && target === 'monitor');
  if (open && (!wasOpen || target !== before)) onShown(target);
  // 窄宽覆盖模式下不占用文档流,打开/关闭不触发终端重排
  if (open !== wasOpen && !isRightPanelOverlay()) { fitAllVisible(); scheduleResizeSync(); }
  refreshCommandStates();
}

export const toggleRightPanel = () => setRightPanel(!rightPanelOpen());

export function toggleRightTab(tab) {
  if (tab === 'history') { openHistoryModal(); return; }
  if (tab === 'snippets') { openSnippetsModal(); return; }
  if (rightTabShown(tab)) setRightPanel(false);
  else setRightPanel(true, tab);
}

export function bindRightPanel() {
  const root = panel();
  syncOverlayMode();
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia(OVERLAY_MQ);
    mql.addEventListener?.('change', syncOverlayMode);
  }
  selectTab(rightPanelTab());
  document.body?.classList?.toggle('rp-monitor-open', rightTabShown('monitor'));
  const tabs = [...root.querySelectorAll('.rp-tab')];
  for (const button of tabs) {
    button.addEventListener('click', () => setRightPanel(true, button.dataset.tab));
    // WAI-ARIA 页签:方向键在页签间移动并立即切换
    button.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(button);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const to = tabs[(next + tabs.length) % tabs.length];
      setRightPanel(true, to.dataset.tab);
      to.focus();
    });
  }
  $('#rp-close')?.addEventListener('click', () => setRightPanel(false));
  // 窄宽覆盖模式:点击抽屉外部非触发区域自动收起
  document.addEventListener('pointerdown', (event) => {
    if (!isRightPanelOverlay() || !rightPanelOpen()) return;
    const t = event.target;
    if (!t || root.contains(t)) return;
    if (t.closest?.('#btn-ai-toggle, #rail-ai, #monitor-bar, #ctx-menu, .modal, .ai-menu, #ai-model-menu, #ai-thread-menu, #ai-mode-menu, #ai-scope-menu, #ai-context-popover, #mon-cpu-popover')) return;
    setRightPanel(false);
  });
  // Esc:浮层模式下直接收起抽屉;停靠模式下把焦点还给终端。
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (!$('#ai-thread-menu')?.classList.contains('hidden')) return;
    if (!$('#ai-model-menu')?.classList.contains('hidden')) return;
    if (!$('#ai-mode-menu')?.classList.contains('hidden')) return;
    if (!$('#ai-scope-menu')?.classList.contains('hidden')) return;
    if (event.target.closest?.('.ai-code-menu[open]')) return;
    if (!$('#ai-drawer')?.classList.contains('hidden')) {
      closeAiDrawer({ focusToggle: true });
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (isRightPanelOverlay()) setRightPanel(false);
    else focusTerminal();
  });
}
