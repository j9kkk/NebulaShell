import { $, bindMenuKeyboard, closeCtxMenu, hasOpenModal } from './core.js';
import { refreshCommandStates } from './commands.js';
import { popupPosition } from './interaction.js';

let page = 'root';
let returnItem = null;
let savedScroll = 0;

export function closeMoreMenu(restore = true) {
  const menu = $('#more-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  const focused = menu.contains(document.activeElement);
  menu.classList.add('hidden');
  $('#btn-more').setAttribute('aria-expanded', 'false');
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
  else menu.querySelector(`.mm-page[data-page="${page}"] button:not(:disabled)`)?.focus();
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
  button.addEventListener('click', () => {
    if (hasOpenModal()) return;
    if (!menu.classList.contains('hidden')) { closeMoreMenu(); return; }
    closeCtxMenu();
    refreshCommandStates();
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    returnItem = null;
    savedScroll = 0;
    showPage('root');
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item || item.disabled) return;
    if (item.dataset.menuPage) { showPage(item.dataset.menuPage, item); return; }
    if (item.hasAttribute('data-menu-back')) { showPage('root'); return; }
    closeMoreMenu();
  });
  document.addEventListener('mousedown', (event) => {
    if (!event.target.closest('#more-menu, #btn-more')) closeMoreMenu(false);
  });
  document.addEventListener('nebula:close-menus', () => closeMoreMenu());
  window.addEventListener('blur', () => closeMoreMenu());
  window.addEventListener('resize', () => { if (!menu.classList.contains('hidden')) positionMenu(); });
}
