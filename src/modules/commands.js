import { applyAccelTitles, toast, topModal } from './core.js';
import { accelOf } from './keymap.js';

const commands = new Map();

/// 命令分类:命令面板按此分组,也是检索词之一。
export const CATEGORY_LABEL = { app: '应用', layout: '标签与分屏', panel: '面板', session: '会话', host: '主机' };

/// 命令面板自身也是模态,但不应让面板里的命令全部显示为禁用。
export const PALETTE_MODAL_ID = 'modal-palette';

/// definition 字段:
///   label     名称,字符串或 (ctx) => 字符串
///   category  app / layout / panel / session / host
///   keywords  英文别名 + 拼音首字母,供命令面板检索
///   shortcut  keymap 动作名(缺省同 id),提示和菜单栏加速键都从 keymap 读
///   kind      action / toggle / dialog;dialog 的名称自动加"…"
///   enabled / reason / checked / run  均可接收 ctx = { tabId, paneId, sessionId },
///             缺省为当前焦点;窗格工具条和右键菜单传入显式目标。
///             checked 返回 undefined 表示该目标下不是开关(不打 ✓)
///   allowInModal  模态打开时仍可执行(退出、关闭窗口)
export function registerCommand(id, definition) { commands.set(id, definition); }

const evaluate = (value, ctx) => (typeof value === 'function' ? value(ctx) : value);

function labelOf(command, ctx) {
  const label = evaluate(command.label, ctx) || '';
  return command.kind === 'dialog' && label && !label.endsWith('…') ? label + '…' : label;
}

function blockedByModal(command) {
  if (command.allowInModal) return false;
  const top = topModal();
  return !!top && top.id !== PALETTE_MODAL_ID;
}

export function commandState(id, ctx) {
  const command = commands.get(id);
  if (!command) return null;
  const modal = blockedByModal(command);
  const enabled = !modal && (command.enabled ? !!command.enabled(ctx) : true);
  let reason = '';
  if (!enabled) reason = modal ? '请先关闭对话框' : evaluate(command.reason, ctx) || '当前状态不可执行';
  const checked = command.checked ? command.checked(ctx) : undefined;
  return {
    label: labelOf(command, ctx),
    enabled,
    checked: checked === undefined ? undefined : !!checked,
    reason,
  };
}

/// 全部注册命令的静态描述 + 当前状态,供命令面板、菜单栏和可达性测试使用。
export function listCommands(ctx) {
  return [...commands.entries()].map(([id, command]) => ({
    id,
    category: command.category || 'app',
    keywords: command.keywords || [],
    shortcut: command.shortcut === undefined ? id : command.shortcut,
    kind: command.kind || (command.checked ? 'toggle' : 'action'),
    ...commandState(id, ctx),
  }));
}

export async function executeCommand(id, ctx) {
  const command = commands.get(id);
  const info = commandState(id, ctx);
  if (!command || !info?.enabled) return false;
  document.dispatchEvent(Object.assign(new Event('nebula:command'), { detail: { id } }));
  try { await command.run(ctx); return true; }
  catch (error) { toast(error.message || '操作失败', 'error'); return false; }
  finally { refreshCommandStates(); }
}

/// 右键菜单 / 下拉菜单项:名称、快捷键、禁用原因、勾选态都取自注册表,
/// 执行走 executeCommand(id, ctx)。overrides 只用于就近语境下更顺口的名称
/// (如分屏下拉里的「终端分屏」)和 danger 样式。
export function commandMenuItem(id, ctx, overrides = {}) {
  const command = commands.get(id);
  const info = commandState(id, ctx);
  if (!command || !info) return null;
  const shortcut = command.shortcut === undefined ? id : command.shortcut;
  return {
    command: id,
    label: info.label,
    key: shortcut ? accelOf(shortcut) : '',
    disabled: !info.enabled,
    reason: info.reason,
    checked: info.checked,
    run: () => executeCommand(id, ctx),
    ...overrides,
  };
}

/// 元素上的显式目标:data-cmd-tab / data-cmd-pane / data-cmd-session。
/// 没有这些属性的按钮作用于当前焦点(ctx 为 undefined)。
export function commandCtxOf(element) {
  const { cmdTab, cmdPane, cmdSession } = element?.dataset || {};
  if (!cmdTab && !cmdPane && !cmdSession) return undefined;
  return { tabId: cmdTab || null, paneId: cmdPane || null, sessionId: cmdSession || null };
}

/// 右键菜单的项每次打开都按 ctx 重建,不参与全局刷新与绑定(否则会被
/// 无 ctx 的全局状态覆盖,或被重复绑定成执行两次)。
const isTransient = (button) => !!button.closest?.('#ctx-menu');

/// 菜单项用 aria-disabled 而不是 disabled:禁用的按钮会丢焦点(焦点项被
/// 状态变化禁用后,方向键和 Esc 全部失效),aria-disabled 保持可聚焦,
/// 方向键照常经过,原因由菜单底部显示。独立按钮仍用 disabled,原因并进 title。
function applyEnabled(button, info) {
  const inMenu = !!button.closest('[role="menu"]');
  if (inMenu) {
    button.disabled = false;
    if (info.enabled) button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', 'true');
  } else if (button.hasAttribute('data-label-title')) {
    // 名称随目标变化的按钮(窗格工具条):title / aria-label 每次按注册表重写
    button.disabled = !info.enabled;
    button.title = info.enabled ? info.label : `${info.label}（${info.reason}）`;
    button.setAttribute('aria-label', info.label);
  } else {
    const wasDisabled = button.disabled;
    button.disabled = !info.enabled;
    // data-accel 按钮的 title 随时可由 applyAccelTitles 重建;其余按钮记下原 title
    const restoreTitle = () => {
      if (button.dataset.accel) applyAccelTitles(button.parentElement || button);
      else if (button.dataset.titleBase !== undefined) button.title = button.dataset.titleBase;
    };
    if (!info.enabled) {
      if (button.dataset.accel) restoreTitle();
      else if (button.dataset.titleBase === undefined) button.dataset.titleBase = button.title || '';
      const base = button.dataset.accel ? button.title : button.dataset.titleBase;
      button.title = base ? `${base}（${info.reason}）` : info.reason;
    } else if (wasDisabled) {
      restoreTitle();
      delete button.dataset.titleBase;
    }
  }
  if (!info.enabled) button.setAttribute('aria-description', info.reason);
  else button.removeAttribute('aria-description');
}

function refreshButton(button) {
  const info = commandState(button.dataset.command, commandCtxOf(button));
  if (!info) return;
  applyEnabled(button, info);
  const label = button.querySelector('.mm-label');
  if (label && info.label) label.textContent = info.label;
  if (info.checked !== undefined) {
    button.classList.toggle('active', info.checked);
    const state = button.querySelector('.mm-state');
    if (state) state.textContent = info.checked ? '✓' : '';
    if (button.closest('[role="menu"]')) {
      button.setAttribute('role', 'menuitemcheckbox');
      button.setAttribute('aria-checked', String(info.checked));
    } else button.setAttribute('aria-pressed', String(info.checked));
  } else if (button.hasAttribute('aria-pressed')) {
    // 该目标下不再是开关(如广播结束后窗格工具条的广播按钮)
    button.classList.remove('active');
    button.removeAttribute('aria-pressed');
  }
}

/// root 缺省为整个文档;窗格工具条在挂载时只刷新自己的子树。直接作为事件
/// 监听器注册时收到的是 Event,同样按整个文档处理。
export function refreshCommandStates(scope) {
  const root = typeof scope?.querySelectorAll === 'function' ? scope : document;
  for (const button of root.querySelectorAll('[data-command]')) {
    if (!isTransient(button)) refreshButton(button);
  }
  if (root === document) document.dispatchEvent(new Event('nebula:commands-refreshed'));
}

/// data-command-direct 的按钮自己处理点击(窗格 ✕⤢),这里只刷新状态。
export function bindCommandButton(button) {
  if (button._commandBound || isTransient(button) || button.dataset.commandDirect) return;
  button._commandBound = true;
  if (button.closest('[role="menu"]')) button.setAttribute('role', 'menuitem');
  button.addEventListener('click', () => executeCommand(button.dataset.command, commandCtxOf(button)));
}

export function bindCommandButtons(scope) {
  const root = typeof scope?.querySelectorAll === 'function' ? scope : document;
  for (const button of root.querySelectorAll('[data-command]')) bindCommandButton(button);
  refreshCommandStates(root);
}
