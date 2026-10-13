// 设置窗口(#modal-settings):终端 / AI / 会话日志 / 快捷键 四个分区。
// 终端、AI、会话日志三个分区各自保存、各自取消,保存后关闭窗口;快捷键分区只读。
// 终端分区含文件双击打开的临时缓存目录;会话日志分区含目录/格式/时间戳/自动记录。
import { $, accel, api, closeModal, state, toast } from './core.js';
import { closeAiSettings, openAiSettings } from './ai.js';
import { openLogFolder } from './terminal.js';
import { DEFAULT_KEYMAP, invalidateKeymapCache, specsOf } from './keymap.js';
import { applyTheme, fitAllVisible, scheduleResizeSync, visibleSessions } from './terminal.js';

export const SETTINGS_SECTIONS = ['terminal', 'ai', 'log', 'keys'];

export const settingsOpen = () => !$('#modal-settings').classList.contains('hidden');
export const settingsSection = () => document.querySelector('#modal-settings .settings-tab[aria-selected="true"]')?.dataset.section || '';

export function revertUnsavedTheme() {
  const saved = (state.settings && state.settings.terminal && state.settings.terminal.theme) || 'nebula';
  applyTheme(saved);
  const el = $('#term-theme');
  if (el) el.value = saved;
}

function fillTermSettings() {
  const t = (state.settings && state.settings.terminal) || { fontSize: 13, theme: 'nebula', scrollback: 2000 };
  $('#term-fontsize').value = t.fontSize || 13;
  $('#term-theme').value = t.theme || 'nebula';
  $('#term-scrollback').value = t.scrollback || 2000;
  $('#term-open-tempdir').value = (state.settings && state.settings.openTempDir) || '';
}

function fillLogSettings() {
  const sl = (state.settings && state.settings.sessionLog) || {};
  $('#setlog-auto').checked = !!sl.auto;
  $('#setlog-dir').value = sl.dir || '';
  const format = sl.format === 'raw' ? 'raw' : 'text';
  document.querySelector(`input[name="setlog-format"][value="${format}"]`).checked = true;
  $('#setlog-timestamps').checked = sl.timestamps !== false;
  $('#setlog-screen').checked = sl.includeScreen !== false;
  // 默认目录提示由后端解析(Windows 上不是 ~ 形态),拿不到时退回通用文案
  const hint = $('#setlog-dir-hint');
  const def = state.settings && state.settings.sessionLogDefaultDir;
  hint.textContent = def ? `留空 = ${def}（默认）` : '留空 = 默认目录';
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
    fillLogSettings();
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
  $('#term-theme').addEventListener('change', () => {
    applyTheme($('#term-theme').value);
  });
  $('#btn-term-cancel').addEventListener('click', () => {
    revertUnsavedTheme();
    closeAiSettings();
  });
  $('#btn-term-save').addEventListener('click', saveTermSettings);
  $('#btn-log-cancel').addEventListener('click', () => {
    revertUnsavedTheme();
    closeAiSettings();
  });
  $('#btn-log-save').addEventListener('click', saveLogSettings);
  $('#setlog-pick').addEventListener('click', async () => {
    try {
      const picked = await api('dialog:pickDirectory', {});
      if (picked) $('#setlog-dir').value = picked;
    } catch { /* 取消选择不提示 */ }
  });
  $('#setlog-open').addEventListener('click', openLogFolder);
  $('#btn-keys-close').addEventListener('click', () => {
    revertUnsavedTheme();
    closeModal('#modal-settings');
  });
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
  // 全部即时应用:applyTheme 同步顶层 HTML data-theme 与所有终端实例配色;
  // 回滚行数改 options 后 xterm 内部会触发一次 resize 并按新上限裁剪缓冲区(旧行随之释放),无需重建终端。
  const ts = (state.settings && state.settings.terminal) || {};
  applyTheme(ts.theme || 'nebula');
  const fontSize = Number(ts.fontSize) || 13;
  const scrollback = Number(ts.scrollback) || 2000;
  for (const s of state.sessions.values()) {
    try {
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

async function saveLogSettings() {
  const patch = {
    sessionLog: {
      auto: $('#setlog-auto').checked,
      dir: $('#setlog-dir').value.trim(),
      format: document.querySelector('input[name="setlog-format"]:checked')?.value || 'text',
      timestamps: $('#setlog-timestamps').checked,
      includeScreen: $('#setlog-screen').checked,
    },
  };
  try {
    state.settings = await api('settings:save', patch);
    closeAiSettings(); // 关窗口,同时丢弃其它分区未保存的草稿
    toast('会话日志设置已保存（对之后开始的日志生效）', 'success');
  } catch (e) {
    toast(e?.message || '保存失败', 'error');
  }
}
