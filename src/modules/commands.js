import { applyAccelTitles, hasOpenModal, toast } from './core.js';

const commands = new Map();

export function registerCommand(id, definition) { commands.set(id, definition); }

export function commandState(id) {
  const command = commands.get(id);
  if (!command) return null;
  const modal = hasOpenModal();
  const enabled = !modal && (command.enabled ? !!command.enabled() : true);
  let reason = '';
  if (!enabled) {
    reason = modal ? '请先关闭对话框'
      : (typeof command.reason === 'function' ? command.reason() : command.reason) || '当前状态不可执行';
  }
  return {
    label: typeof command.label === 'function' ? command.label() : command.label,
    enabled,
    checked: command.checked ? !!command.checked() : undefined,
    reason,
  };
}

export async function executeCommand(id) {
  const command = commands.get(id);
  const info = commandState(id);
  if (!command || !info?.enabled) return false;
  document.dispatchEvent(Object.assign(new Event('nebula:command'), { detail: { id } }));
  try { await command.run(); return true; }
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
