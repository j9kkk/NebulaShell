// Windows/Linux 的收拢式应用主菜单(E4):按 shared/menu-spec.js 的 pc 规格收进顶栏
// Logo 点击下拉(#btn-app-menu);六个分类(文件/编辑/视图/主机/会话/帮助)作为级联子菜单
// 复用 #ctx-menu + #ctx-sub(完整保留快捷键、勾选态、禁用原因与键盘导航),并在底部提供
// 命令面板 / 设置 / 退出快捷直达项。macOS 仍走原生系统菜单栏(native-menu.js),不受影响。
//
// 不绑定 Alt 助记键与 F10:终端里 Alt+F 是 readline 按词前移、F10 是 htop/mc 的
// 退出键;键盘用户用命令面板或直接聚焦 Logo 下拉按钮。
import { $, closeCtxMenu, showCtxMenu, topModal } from './core.js';
import { commandMenuItem } from './commands.js';
import { icon } from '../shared/icons.js';
import { SEP, specFor } from '../shared/menu-spec.js';

const MENUS = specFor('pc');
let opener = null;

const ctxMenu = () => $('#ctx-menu');
const triggerBtn = () => $('#menubar .menubar-trigger');
const isMenuOpen = () => {
  const menu = ctxMenu();
  const btn = triggerBtn();
  return !!menu && !menu.classList.contains('hidden') && !!btn && menu._trigger === btn;
};
/// 刚被同一次点击的 mousedown 收起(全局 mousedown 先于触发按钮的 click 关闭菜单)
const justClosed = (btn) => {
  const menu = ctxMenu();
  return !!menu && menu._closedTrigger === btn && performance.now() - (menu._closedAt || 0) < 300;
};

function captureOpener() {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && !active.closest?.('#menubar, #ctx-menu, #ctx-sub')) return active;
  return document.querySelector('.term-pane.focused .xterm-helper-textarea');
}

/// 单个子菜单的条目:命令项取注册表的名称、快捷键、勾选与禁用原因;未注册的命令不显示。
/// 名称只有注册表一处来源(菜单面按 asks 追加「…」),菜单表不再存 text 覆盖;
/// accelerator: false 仅用于平台缺键(S7),只清空键位槽不改名称。
export function menuItems(menu) {
  return menu.items.map((entry) => {
    if (entry === SEP) return '-';
    const overrides = {};
    if (entry.accelerator === false) overrides.key = '';
    return commandMenuItem(entry.cmd, undefined, overrides);
  });
}

/// Logo 下拉顶层菜单项:六个分类级联子菜单 + 常用全局直达项(命令面板/设置/退出)。
export function rootMenuItems() {
  const categories = MENUS.map((menu) => {
    const sub = menuItems(menu).filter(Boolean);
    return { label: menu.submenu, submenu: sub };
  });
  const quick = [
    commandMenuItem('palette.open'),
    commandMenuItem('settings.open'),
  ].filter(Boolean);
  const quit = commandMenuItem('app.quit');
  const items = [...categories];
  if (quick.length) items.push('-', ...quick);
  if (quit) items.push('-', quit);
  return items;
}

function open(btn) {
  const r = btn.getBoundingClientRect();
  showCtxMenu(r.left, r.bottom + 4, rootMenuItems(), {
    trigger: btn,
    label: 'NebulaShell 主菜单',
    returnFocus: opener || btn,
  });
}

function syncDisabled() {
  const btn = triggerBtn();
  if (btn) btn.disabled = !!topModal();
}

export function buildMenubar() {
  const bar = $('#menubar');
  if (!bar || !document.body.classList.contains('platform-nonmacos') || bar.querySelector('.menubar-trigger')) return false;
  const btn = document.createElement('button');
  btn.id = 'btn-app-menu';
  btn.type = 'button';
  btn.className = 'tb-brand-btn menubar-trigger';
  btn.setAttribute('role', 'menuitem');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', '主菜单');
  btn.title = '主菜单';
  const logo = document.createElement('span');
  logo.className = 'logo';
  logo.textContent = '✦ ';
  const logoText = document.createElement('span');
  logoText.className = 'logo-text';
  logoText.textContent = 'NebulaShell';
  logo.appendChild(logoText);
  const caret = document.createElement('span');
  caret.className = 'tb-menu-caret mi';
  caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = icon('chevronDown');
  btn.appendChild(logo);
  btn.appendChild(caret);

  btn.addEventListener('mousedown', () => {
    if (!isMenuOpen() && !justClosed(btn)) opener = captureOpener();
  });
  btn.addEventListener('click', () => {
    if (justClosed(btn)) { opener?.focus?.(); return; }
    if (isMenuOpen()) { closeCtxMenu(); return; }
    if (!opener || !opener.isConnected) opener = captureOpener();
    open(btn);
  });
  // Enter / 空格由按钮原生激活走 click;↓ 也打开(与分屏 ▾ 等下拉一致)
  btn.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (!isMenuOpen()) opener = captureOpener();
    open(btn);
  });
  bar.appendChild(btn);
  document.addEventListener('nebula:modal-scope', syncDisabled);
  syncDisabled();
  return true;
}

/// 测试观测:收拢式 Logo 菜单状态、分类列表与各分类当前命令项(名称、快捷键、勾选、禁用)。
export function menubarSnapshot() {
  const btn = triggerBtn();
  const built = !!btn;
  const expanded = btn ? btn.getAttribute('aria-expanded') : 'false';
  const disabled = btn ? btn.disabled : false;
  return {
    built,
    mode: 'logo-dropdown',
    trigger: btn ? { id: btn.id, text: 'NebulaShell', expanded, disabled } : null,
    titles: built ? MENUS.map((m) => ({ text: m.submenu, expanded, disabled })) : [],
    menus: MENUS.map((menu) => ({
      title: menu.submenu,
      items: menuItems(menu).map((it) => (it === '-' ? '-' : it && { command: it.command, label: it.label, key: it.key, checked: it.checked, disabled: it.disabled })),
    })),
  };
}
