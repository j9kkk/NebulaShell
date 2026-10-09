import { $, bindMenuKeyboard, closeCtxMenu, hasOpenModal, isMenuItemDisabled } from './core.js';
import { refreshCommandStates } from './commands.js';
import { popupPosition } from './interaction.js';

let page = 'root';
let returnItem = null;
let savedScroll = 0;
let opener = null;

/// 打开菜单前的焦点位置。用鼠标打开时 mousedown 阶段记录(Chromium 随后会把
/// 焦点移到 ⋯ 按钮上,WebKit 不会);记录到的是 ⋯ 按钮自身或 body 时,
/// 退回到焦点窗格的终端。
function focusOpener() {
  const target = opener;
  opener = null;
  const usable = target?.isConnected && target !== $('#btn-more') && target !== document.body
    && !$('#more-menu').contains(target) && target.getClientRects().length;
  const fallback = document.querySelector('.term-pane.focused .xterm-helper-textarea') || document.querySelector('.term-pane.focused[tabindex]');
  (usable ? target : fallback)?.focus();
}

/// restore:true = 焦点在菜单内时还给 ⋯ 按钮(Esc/Tab 关闭);'opener' = 还给
/// 打开前的位置(执行菜单项后);false = 不动焦点(点别处关闭)。
export function closeMoreMenu(restore = true) {
  const menu = $('#more-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  const focused = menu.contains(document.activeElement) || document.activeElement === document.body;
  menu.classList.add('hidden');
  $('#btn-more').setAttribute('aria-expanded', 'false');
  if (restore === 'opener') { focusOpener(); return; }
  opener = null;
  if (restore && focused) $('#btn-more').focus();
}

function positionMenu() {
  const menu = $('#more-menu');
  const anchor = $('#btn-more').getBoundingClientRect();
  menu.style.left = '8px';
  menu.style.top = '8px';
  menu.style.maxHeight = `${Math.max(32, window.innerHeight - 16)}px`;
  // Position from the layout box, never a transient animated/transformed rect.
  const size = { width: menu.offsetWidth, height: menu.offsetHeight };
  const position = popupPosition(anchor, size, { width: window.innerWidth, height: window.innerHeight });
  menu.style.left = `${position.left}px`;
  menu.style.top = `${position.top}px`;
  if (window.innerWidth < 360) {
    menu.style.left = '8px';
    menu.style.top = `${Math.max(8, (window.innerHeight - size.height) / 2)}px`;
  }
}

function showPage(next, trigger = null) {
  const menu = $('#more-menu');
  if (next !== 'root') { returnItem = trigger; savedScroll = menu.scrollTop; }
  page = next;
  for (const element of menu.querySelectorAll('.mm-page')) element.classList.toggle('hidden', element.dataset.page !== page);
  positionMenu();
  menu.scrollTop = next === 'root' ? savedScroll : 0;
  if (next === 'root' && returnItem?.isConnected) returnItem.focus();
  else menu.querySelector(`.mm-page[data-page="${page}"] button:not(:disabled):not([aria-disabled="true"])`)?.focus();
}

export function bindMoreMenu() {
  const menu = $('#more-menu');
  const button = $('#btn-more');
  // Keep fixed-position menus outside the toolbar stacking context.
  document.body.appendChild(menu);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-controls', 'more-menu');
  button.setAttribute('aria-expanded', 'false');
  bindMenuKeyboard(menu, closeMoreMenu, () => { if (page !== 'root') showPage('root'); });
  for (const item of menu.querySelectorAll('button')) item.setAttribute('role', 'menuitem');
  button.addEventListener('mousedown', () => { if (menu.classList.contains('hidden')) opener = document.activeElement; });
  button.addEventListener('click', () => {
    if (hasOpenModal()) { opener = null; return; }
    if (!menu.classList.contains('hidden')) { closeMoreMenu(); return; }
    if (!opener || opener === button) opener = document.activeElement;
    closeCtxMenu();
    refreshCommandStates();
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    returnItem = null;
    savedScroll = 0;
    showPage('root');
  });
  // 捕获阶段:先关菜单、把焦点还给打开前的位置,再让菜单项自己的监听执行
  // 命令 —— 命令若打开弹窗,弹窗记下的归还目标就是原位置而不是隐藏的菜单项。
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item) return;
    if (isMenuItemDisabled(item)) { event.preventDefault(); event.stopPropagation(); return; }
    if (item.dataset.menuPage || item.hasAttribute('data-menu-back')) return;
    closeMoreMenu('opener');
  }, true);
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item) return;
    if (item.dataset.menuPage) { showPage(item.dataset.menuPage, item); return; }
    if (item.hasAttribute('data-menu-back')) showPage('root');
  });
  document.addEventListener('mousedown', (event) => {
    if (!event.target.closest('#more-menu, #btn-more')) closeMoreMenu(false);
  });
  document.addEventListener('nebula:close-menus', () => closeMoreMenu());
  window.addEventListener('blur', () => closeMoreMenu());
  window.addEventListener('resize', () => { if (!menu.classList.contains('hidden')) positionMenu(); });
}
