// Windows/Linux 的一级菜单栏:按 shared/menu-spec.js 的 pc 规格渲染到顶层标题栏
// 的 #menubar;下拉复用 #ctx-menu(showCtxMenu 已支持快捷键文字、勾选、禁用原因)。
// macOS 用系统菜单栏(native-menu.js),这里不渲染。
//
// 交互:点击标题开合;打开后鼠标移到相邻标题即切换;←/→ 在菜单间切换;
// Esc 关闭并把焦点还给打开菜单前的位置(切换菜单时沿用最初的那个位置)。
// 不绑定 Alt 助记键与 F10:终端里 Alt+F 是 readline 按词前移、F10 是 htop/mc 的
// 退出键;键盘用户用命令面板。
import { $, closeCtxMenu, showCtxMenu, topModal } from './core.js';
import { commandMenuItem } from './commands.js';
import { SEP, specFor } from '../shared/menu-spec.js';

const MENUS = specFor('pc');
let opener = null;

const ctxMenu = () => $('#ctx-menu');
const titles = () => [...document.querySelectorAll('#menubar .menubar-item')];
const openTitle = () => {
  const menu = ctxMenu();
  return menu && !menu.classList.contains('hidden') && menu._trigger?.closest?.('#menubar') ? menu._trigger : null;
};
/// 刚被同一次点击的 mousedown 收起(全局 mousedown 先于标题的 click 关闭菜单)
const justClosed = (title) => {
  const menu = ctxMenu();
  return !!menu && menu._closedTrigger === title && performance.now() - (menu._closedAt || 0) < 300;
};
const recentlyFromMenubar = () => {
  const menu = ctxMenu();
  return !!menu?._closedTrigger?.closest?.('#menubar') && performance.now() - (menu._closedAt || 0) < 300;
};

function captureOpener() {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && !active.closest?.('#menubar, #ctx-menu')) return active;
  return document.querySelector('.term-pane.focused .xterm-helper-textarea');
}

/// 菜单项:命令项取注册表的名称、快捷键、勾选与禁用原因;未注册的命令不显示。
export function menuItems(menu) {
  return menu.items.map((entry) => {
    if (entry === SEP) return '-';
    const overrides = {};
    if (entry.text) overrides.label = entry.text;
    if (entry.accelerator === false) overrides.key = '';
    return commandMenuItem(entry.cmd, undefined, overrides);
  });
}

function open(title) {
  const index = titles().indexOf(title);
  if (index < 0) return;
  const r = title.getBoundingClientRect();
  showCtxMenu(r.left, r.bottom + 2, menuItems(MENUS[index]), { trigger: title, label: MENUS[index].submenu, returnFocus: opener || title });
}

function step(delta) {
  const current = openTitle();
  if (!current) return;
  const list = titles();
  open(list[(list.indexOf(current) + delta + list.length) % list.length]);
}

function syncDisabled() {
  const blocked = !!topModal();
  for (const title of titles()) title.disabled = blocked;
}

export function buildMenubar() {
  const bar = $('#menubar');
  if (!bar || !document.body.classList.contains('platform-nonmacos') || bar.querySelector('.menubar-item')) return false;
  for (const menu of MENUS) {
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'menubar-item';
    title.textContent = menu.submenu;
    title.setAttribute('role', 'menuitem');
    title.setAttribute('aria-haspopup', 'menu');
    title.setAttribute('aria-expanded', 'false');
    title.addEventListener('mousedown', () => {
      if (!openTitle() && !recentlyFromMenubar()) opener = captureOpener();
    });
    title.addEventListener('click', () => {
      if (justClosed(title)) { opener?.focus?.(); return; }
      if (openTitle() === title) { closeCtxMenu(); return; }
      if (!openTitle() && !recentlyFromMenubar()) opener = captureOpener();
      open(title);
    });
    title.addEventListener('mouseenter', () => {
      const current = openTitle();
      if (current && current !== title) open(title);
    });
    // Enter / 空格由按钮原生激活走 click;↓ 也打开(与分屏 ▾ 等下拉一致)
    title.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (!openTitle()) opener = captureOpener();
      open(title);
    });
    bar.appendChild(title);
  }
  // ←/→ 在菜单间切换(下拉自身的键盘处理只管 ↑↓ Home End Esc)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const active = document.activeElement;
    if (!openTitle() || (active && active !== document.body && !ctxMenu().contains(active) && !active.closest?.('#menubar'))) return;
    event.preventDefault();
    event.stopPropagation();
    step(event.key === 'ArrowRight' ? 1 : -1);
  }, true);
  document.addEventListener('nebula:modal-scope', syncDisabled);
  syncDisabled();
  return true;
}

/// 测试观测:标题与各菜单当前的项(名称、快捷键、勾选、禁用)。
export function menubarSnapshot() {
  return {
    built: titles().length > 0,
    titles: titles().map((t) => ({ text: t.textContent, expanded: t.getAttribute('aria-expanded'), disabled: t.disabled })),
    menus: MENUS.map((menu) => ({
      title: menu.submenu,
      items: menuItems(menu).map((it) => (it === '-' ? '-' : it && { command: it.command, label: it.label, key: it.key, checked: it.checked, disabled: it.disabled })),
    })),
  };
}
