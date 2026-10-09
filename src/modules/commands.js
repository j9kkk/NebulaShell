import { applyAccelTitles, toast, topModal } from './core.js';

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
///   enabled / reason / checked / run  均可接收 ctx(缺省为当前焦点)
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
  return {
    label: labelOf(command, ctx),
    enabled,
    checked: command.checked ? !!command.checked(ctx) : undefined,
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

/// 菜单项用 aria-disabled 而不是 disabled:禁用的按钮会丢焦点(焦点项被
/// 状态变化禁用后,方向键和 Esc 全部失效),aria-disabled 保持可聚焦,
/// 方向键照常经过,原因由菜单底部显示。独立按钮仍用 disabled,原因并进 title。
function applyEnabled(button, info) {
  const inMenu = !!button.closest('[role="menu"], #more-menu');
  if (inMenu) {
    button.disabled = false;
    if (info.enabled) button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', 'true');
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

export function refreshCommandStates() {
  for (const button of document.querySelectorAll('[data-command]')) {
    const info = commandState(button.dataset.command);
    if (!info) continue;
    applyEnabled(button, info);
    const label = button.querySelector('.mm-label');
    if (label && info.label) label.textContent = info.label;
    if (info.checked !== undefined) {
      button.classList.toggle('active', info.checked);
      const state = button.querySelector('.mm-state');
      if (state) state.textContent = info.checked ? '✓' : '';
      if (button.closest('#more-menu')) {
        button.setAttribute('role', 'menuitemcheckbox');
        button.setAttribute('aria-checked', String(info.checked));
      } else button.setAttribute('aria-pressed', String(info.checked));
    }
  }
  document.dispatchEvent(new Event('nebula:commands-refreshed'));
}

export function bindCommandButtons() {
  for (const button of document.querySelectorAll('[data-command]')) {
    if (button._commandBound) continue;
    button._commandBound = true;
    if (button.closest('#more-menu')) button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => executeCommand(button.dataset.command));
  }
  refreshCommandStates();
}
