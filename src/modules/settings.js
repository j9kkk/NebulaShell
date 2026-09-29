// 终端设置(字号 / 回滚 / 配色)
import { $, api, closeModal, openModal, state, toast } from './core.js';
import { fitAllVisible, scheduleResizeSync, termTheme, visibleSessions } from './terminal.js';

export function openTermSettings() {
  const t = (state.settings && state.settings.terminal) || { fontSize: 13, theme: 'nebula', scrollback: 2000 };
  $('#term-fontsize').value = t.fontSize || 13;
  $('#term-theme').value = t.theme || 'nebula';
  $('#term-scrollback').value = t.scrollback || 2000;
  openModal('#modal-term');
}

export async function saveTermSettings() {
  const patch = {
    terminal: {
      fontSize: Number($('#term-fontsize').value) || 13,
      theme: $('#term-theme').value,
      scrollback: Number($('#term-scrollback').value) || 2000,
    },
  };
  state.settings = await api('settings:save', patch);
  closeModal('#modal-term');
  // 全部即时应用:主题/字号直接改 options;回滚行数改 options 后 xterm 内部会
  // 触发一次 resize 并按新上限裁剪缓冲区(旧行随之释放),无需重建终端。
  const theme = termTheme();
  const ts = (state.settings && state.settings.terminal) || {};
  const fontSize = Number(ts.fontSize) || 13;
  const scrollback = Number(ts.scrollback) || 2000;
  for (const s of state.sessions.values()) {
    try {
      s.term.options.theme = theme;
      s.term.options.fontSize = fontSize;
      s.term.options.scrollback = scrollback;
    } catch { /* ignore */ }
  }
  // 字号变化会改变字符网格,需重算几何并同步远端 PTY(只对本标签已挂载的会话)
  for (const s of visibleSessions()) {
    try { s.fit.fit(); } catch { /* ignore */ }
  }
  scheduleResizeSync();
  fitAllVisible();
  toast('终端设置已应用', 'success');
}

/* ---------------- 广播输入(E5) ---------------- */

