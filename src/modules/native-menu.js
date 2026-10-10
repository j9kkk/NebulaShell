// macOS 菜单栏:从命令注册表生成,菜单项执行同一个 executeCommand。
//
// 只在 macOS 构建(body.platform-darwin)且有 Tauri 菜单 API 时生成;Windows/Linux
// 用自绘标题栏,不生成。生成失败时保留 Tauri 的默认菜单。
//
// 加速键与页面快捷键的关系:wry 只把网页没有 preventDefault 的按键转给菜单,
// 页面执行了的快捷键不会再触发菜单项,所以同一个键不会执行两次。
// 编辑菜单保留预定义的撤销/重做/剪切/拷贝/粘贴/全选:WKWebView 里输入框的
// 这些快捷键依赖它们。
import { state } from './core.js';
import { commandState, executeCommand } from './commands.js';
import { specOf, toAccelerator } from './keymap.js';
import { closePalette, isPaletteOpen } from './palette.js';
import { menuCommandIds, SEP, specFor } from '../shared/menu-spec.js';

// 菜单表与 Windows/Linux 菜单栏共用(shared/menu-spec.js),这里取 macOS 的那份
const MAC_SPEC = specFor('mac');
const sep = SEP;

/// 生成后的菜单项:{ entry, item, applied: { enabled, checked, text } }。
const tracked = [];
let built = false;
let syncQueued = false;

export const nativeMenuAvailable = () => typeof document !== 'undefined'
  && document.body.classList.contains('platform-darwin') && !!window.__TAURI__?.menu?.Menu;

function runFromMenu(id, record) {
  // 菜单可能在命令面板打开时被点:先关面板,命令弹出的对话框不叠在面板上
  if (isPaletteOpen()) closePalette();
  document.dispatchEvent(new Event('nebula:close-menus'));
  // 勾选项被点击时 AppKit 会自己翻转勾选;命令没执行(或执行后状态未变)时
  // 要按命令状态重设,所以作废记录,让下一次同步无条件写入
  record.applied.checked = undefined;
  executeCommand(id).finally(scheduleSync);
}

function textOf(entry, info) {
  return entry.text || info.label || entry.cmd;
}

async function makeItem(api, entry) {
  if (entry === sep) return api.PredefinedMenuItem.new({ item: 'Separator' });
  if (entry.predefined) return api.PredefinedMenuItem.new({ item: entry.predefined, text: entry.text });
  if (entry.submenu) {
    const items = [];
    for (const child of entry.items) items.push(await makeItem(api, child));
    const submenu = await api.Submenu.new({ text: entry.submenu, items });
    if (entry.role === 'window') await submenu.setAsWindowsMenuForNSApp();
    if (entry.role === 'help') await submenu.setAsHelpMenuForNSApp();
    return submenu;
  }
  const info = commandState(entry.cmd) || { label: entry.cmd, enabled: false };
  const accelerator = entry.accelerator === false ? '' : toAccelerator(specOf(entry.cmd));
  const record = { entry, item: null, applied: { enabled: info.enabled, checked: info.checked, text: textOf(entry, info) } };
  const options = {
    id: `cmd:${entry.cmd}${entry.alias ? ':' + entry.alias : ''}`,
    text: record.applied.text,
    enabled: info.enabled,
    action: () => runFromMenu(entry.cmd, record),
  };
  if (accelerator) options.accelerator = accelerator;
  record.item = info.checked !== undefined
    ? await api.CheckMenuItem.new({ ...options, checked: info.checked })
    : await api.MenuItem.new(options);
  tracked.push(record);
  return record.item;
}

// 窗口隐藏时 requestAnimationFrame 不触发,而菜单栏仍然可见
const nextFrame = (fn) => (document.hidden ? setTimeout(fn, 0) : requestAnimationFrame(fn));

/// 只对变化的项调用 setEnabled / setChecked / setText,合并到下一帧。
export function scheduleSync() {
  if (!built || syncQueued) return;
  syncQueued = true;
  nextFrame(() => {
    syncQueued = false;
    for (const record of tracked) {
      const info = commandState(record.entry.cmd);
      if (!info) continue;
      const text = textOf(record.entry, info);
      const { applied, item } = record;
      if (applied.enabled !== info.enabled) { applied.enabled = info.enabled; item.setEnabled(info.enabled).catch(() => {}); }
      if (info.checked !== undefined && applied.checked !== info.checked && item.setChecked) {
        applied.checked = info.checked;
        item.setChecked(info.checked).catch(() => {});
      }
      if (applied.text !== text) { applied.text = text; item.setText(text).catch(() => {}); }
    }
  });
}

export async function buildNativeMenu() {
  if (built || !nativeMenuAvailable()) return false;
  const api = window.__TAURI__.menu;
  try {
    const items = [];
    for (const entry of MAC_SPEC) items.push(await makeItem(api, entry));
    const menu = await api.Menu.new({ items });
    await menu.setAsAppMenu();
    built = true;
    state.nativeMenu = true;
    document.addEventListener('nebula:commands-refreshed', scheduleSync);
    scheduleSync();
    return true;
  } catch (error) {
    tracked.length = 0;
    console.warn('[native-menu] 生成菜单栏失败,保留默认菜单:', error);
    return false;
  }
}

/// 测试观测:规格与最近一次写入原生菜单的状态。
export function nativeMenuSnapshot() {
  return {
    built,
    commandIds: menuCommandIds(MAC_SPEC),
    submenus: MAC_SPEC.map((entry) => entry.submenu),
    items: tracked.map(({ entry, applied }) => ({ cmd: entry.cmd, alias: entry.alias || '', ...applied,
      accelerator: entry.accelerator === false ? '' : toAccelerator(specOf(entry.cmd)) })),
  };
}
