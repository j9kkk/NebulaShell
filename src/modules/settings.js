// 设置窗口(#modal-settings):终端 / AI / 快捷键 三个分区。
// 终端与 AI 两个分区各自保存、各自取消,保存后关闭窗口;快捷键分区只读。
// 终端分区含文件双击打开的临时缓存目录。
import { $, accel, api, closeModal, state, toast } from './core.js';
import { closeAiSettings, openAiSettings } from './ai.js';
import { DEFAULT_KEYMAP, invalidateKeymapCache, specsOf } from './keymap.js';
import { fitAllVisible, scheduleResizeSync, termTheme, visibleSessions } from './terminal.js';

export const SETTINGS_SECTIONS = ['terminal', 'ai', 'keys'];

export const settingsOpen = () => !$('#modal-settings').classList.contains('hidden');
export const settingsSection = () => document.querySelector('#modal-settings .settings-tab[aria-selected="true"]')?.dataset.section || '';

function fillTermSettings() {
  const t = (state.settings && state.settings.terminal) || { fontSize: 13, theme: 'nebula', scrollback: 2000 };
  $('#term-fontsize').value = t.fontSize || 13;
  $('#term-theme').value = t.theme || 'nebula';
  $('#term-scrollback').value = t.scrollback || 2000;
  $('#term-open-tempdir').value = (state.settings && state.settings.openTempDir) || '';
}

/// 快捷键一览:当前平台生效的键位(自定义优先),没有键位的动作不列。
export function renderKeymapTable() {
  const body = $('#settings-keys-tbody');
  body.innerHTML = '';
  for (const [id, def] of Object.entries(DEFAULT_KEYMAP)) {
    const specs = specsOf(id);
    if (!specs.length) continue;
    const row = document.createElement('tr');
    row.dataset.action = id;
    const name = document.createElement('td');
    name.textContent = id.startsWith('term.') ? `终端内${def.label}` : def.label || id;
    const keys = document.createElement('td');
    keys.className = 'keys-accel';
    keys.textContent = specs.map((spec) => accel(spec).replace('1..9', '1–9')).join(' / ');
    row.append(name, keys);
    body.appendChild(row);
  }
}

function showSection(section, { focus = false } = {}) {
  const target = SETTINGS_SECTIONS.includes(section) ? section : 'terminal';
  for (const tab of document.querySelectorAll('#modal-settings .settings-tab')) {
    const on = tab.dataset.section === target;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const sec of document.querySelectorAll('#modal-settings .settings-sec')) sec.classList.toggle('hidden', sec.dataset.section !== target);
  if (target === 'keys') renderKeymapTable();
}

/// 打开设置窗口并切到指定分区;已打开时只切分区(表单里未保存的内容保留)。
export function openSettings(section = 'terminal') {
  if (!settingsOpen()) {
    fillTermSettings();
    openAiSettings(); // 填 AI 表单并打开窗口
  }
  showSection(section, { focus: true });
}

export function bindSettings() {
  const tabs = [...document.querySelectorAll('#modal-settings .settings-tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => showSection(tab.dataset.section));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      showSection(tabs[(next + tabs.length) % tabs.length].dataset.section, { focus: true });
    });
  }
  $('#btn-term-cancel').addEventListener('click', closeAiSettings);
  $('#btn-term-save').addEventListener('click', saveTermSettings);
  $('#btn-keys-close').addEventListener('click', () => closeModal('#modal-settings'));
}

export async function saveTermSettings() {
  const patch = {
    terminal: {
      fontSize: Number($('#term-fontsize').value) || 13,
      theme: $('#term-theme').value,
      scrollback: Number($('#term-scrollback').value) || 2000,
    },
    openTempDir: $('#term-open-tempdir').value.trim(),
  };
  state.settings = await api('settings:save', patch);
  // 自定义键位可能随 settings 更新:清缓存让下一次匹配/提示重新解析。
  invalidateKeymapCache();
  closeAiSettings(); // 关窗口,同时丢弃 AI 分区未保存的草稿
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
