import { $, applyAccelTitles, hasOpenModal, toast } from './core.js';

const commands = new Map();

export function registerCommand(id, definition) { commands.set(id, definition); }

export function commandState(id) {
  const command = commands.get(id);
  if (!command) return null;
  return {
    label: typeof command.label === 'function' ? command.label() : command.label,
    enabled: !hasOpenModal() && (command.enabled ? command.enabled() : true),
    checked: command.checked ? !!command.checked() : undefined,
    reason: command.reason || '当前状态不可执行',
  };
}

export async function executeCommand(id) {
  const command = commands.get(id);
  const info = commandState(id);
  if (!command || !info?.enabled) return false;
  try { await command.run(); return true; }
  catch (error) { toast(error.message || '操作失败', 'error'); return false; }
  finally { refreshCommandStates(); }
}

export function refreshCommandStates() {
  for (const button of document.querySelectorAll('[data-command]')) {
    const info = commandState(button.dataset.command);
    if (!info) continue;
    button.disabled = !info.enabled;
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
    if (!info.enabled) button.setAttribute('aria-description', info.reason);
    else button.removeAttribute('aria-description');
  }
  const split = $('#btn-split');
  if (split?.disabled) split.title = hasOpenModal() ? '请先关闭对话框' : '先连接当前窗格的主机，且需要足够空间才能分屏';
  else if (split) applyAccelTitles(split.parentElement);
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
