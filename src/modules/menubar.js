// Windows/Linux 的收拢式应用主菜单(E4):按 shared/menu-spec.js 的 pc 规格收进顶栏
// Logo 点击下拉(#btn-app-menu);六个分类(文件/编辑/视图/主机/会话/帮助)作为级联子菜单
// 复用 #ctx-menu + #ctx-sub + core.bindMenuButton(完整保留快捷键、勾选态、禁用原因与键盘导航),
// 底部仅保留「退出」操作(命令面板与设置已在对应子菜单中，不再重复列出)。
// macOS 仍走原生系统菜单栏(native-menu.js),不受影响。
//
// 不绑定 Alt 助记键与 F10:终端里 Alt+F 是 readline 按词前移、F10 是 htop/mc 的
// 退出键;键盘用户用命令面板或直接聚焦 Logo 下拉按钮。
import { $, bindMenuButton, topModal } from './core.js';
import { commandMenuItem } from './commands.js';
import { icon } from '../shared/icons.js';
import { SEP, specFor } from '../shared/menu-spec.js';

const MENUS = specFor('pc');
const triggerBtn = () => $('#menubar .menubar-trigger');

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

/// Logo 下拉顶层菜单项:六个分类级联子菜单 + 底部退出。
/// 命令面板与设置已分别在「视图/帮助」与「文件」子菜单中，不再在根层重复列出。
export function rootMenuItems() {
  const categories = MENUS.map((menu) => {
    const sub = menuItems(menu).filter(Boolean);
    return { label: menu.submenu, submenu: sub };
  });
  const quit = commandMenuItem('app.quit');
  const items = [...categories];
  if (quit) items.push('-', quit);
  return items;
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

  bindMenuButton(btn, rootMenuItems, {
    label: 'NebulaShell 主菜单',
    ignoreFocusClosest: '#menubar, #ctx-menu, #ctx-sub',
    preferTerminalFocus: true,
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
