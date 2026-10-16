// 右侧工具栏:专职 AI 助手(容器沿用 #ai-panel)。
// 命令历史与常用命令已迁移至主菜单与独立弹窗。
import { $, state } from './core.js';
import { refreshCommandStates } from './commands.js';
import { aiStickScroll, closeAiDrawer } from './ai.js';
import { openSnippetsModal, renderSnippets } from './monitor.js';
import { fitAllVisible, scheduleResizeSync } from './terminal.js';
import { openHistoryModal, renderHistory } from './tools.js';

export const RIGHT_TABS = ['ai', 'history', 'snippets'];

const panel = () => $('#ai-panel');
export const rightPanelOpen = () => !panel().classList.contains('hidden');
export const rightPanelTab = () => (RIGHT_TABS.includes(panel().dataset.tab) ? panel().dataset.tab : 'ai');
export const rightTabShown = (tab) => rightPanelOpen() && rightPanelTab() === tab;

/// 页签变为可见时刷新它的内容。历史每次都重新拉取(期间可能执行过新命令),
/// 但保持阅读位置;AI 页补一次贴底(隐藏期间收到的回复)。
function onShown(tab) {
  if (tab === 'ai') aiStickScroll();
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
}

function focusTerminal() {
  const session = state.sessions.get(state.activeId);
  if (session?.term) { try { session.term.focus(); return; } catch { /* ignore */ } }
  if (panel().contains(document.activeElement)) document.activeElement.blur();
}

/// 打开或收起面板;tab 给出时切到该页签。收起时焦点若在面板里,还给终端。
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
  const target = 'ai';
  if (open) selectTab(target);
  if (!open && wasOpen && panel().contains(document.activeElement)) focusTerminal();
  if (!open) {
    $('#ai-model-menu')?.classList.add('hidden');
    $('#ai-mode-menu')?.classList.add('hidden');
    $('#ai-thread-menu')?.classList.add('hidden');
  }
  panel().classList.toggle('hidden', !open);
  $('#ai-resizer').classList.toggle('hidden', !open);
  if (open && (!wasOpen || target !== before)) onShown(target);
  if (open !== wasOpen) { fitAllVisible(); scheduleResizeSync(); }
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
  // Esc:焦点在右侧栏里时把焦点还给终端,面板保持打开(收起由开关负责)。
  // 会话菜单、模型菜单、代码块菜单打开时 Esc 先关它们(各自的 document 监听处理)。
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (!$('#ai-thread-menu')?.classList.contains('hidden')) return;
    if (!$('#ai-model-menu')?.classList.contains('hidden')) return;
    if (!$('#ai-mode-menu')?.classList.contains('hidden')) return;
    if (event.target.closest?.('.ai-code-menu[open]')) return;
    if (!$('#ai-drawer')?.classList.contains('hidden')) {
      closeAiDrawer({ focusToggle: true });
      event.preventDefault();
      return;
    }
    event.preventDefault();
    focusTerminal();
  });
}
