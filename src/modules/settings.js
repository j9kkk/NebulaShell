// 设置窗口(#modal-settings):终端 / AI / 会话日志 / 快捷键 四个分区。
// 四个分区各自保存、各自取消(保存后关闭窗口);快捷键分区支持录制与自定义。
// 终端分区含文件双击打开的临时缓存目录;会话日志分区含目录/格式/时间戳/自动记录。
import { $, accel, api, applyAccelTitles, closeModal, state, toast } from './core.js';
import { closeAiSettings, openAiSettings } from './ai.js';
import { listCommands } from './commands.js';
import { DEFAULT_KEYMAP, bindingSignature, defaultSpecsOf, findKeyConflicts, invalidateKeymapCache, keybindingsPatchOf, specOfEvent, specsOf } from './keymap.js';
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

// 设置窗口关闭的统一出口:先回滚未保存的主题预览,再关窗口(同时丢弃 AI 分区未保存草稿)。
// 任何关闭入口(各分区取消/保存、#btn-ai-cancel、Esc、遮罩)都必须走这里,禁止自行拼装步骤——
// 顺序有依赖:先还原主题再关窗,closeAiSettings 才能按已保存主题收尾。
export function dismissSettings() {
  revertUnsavedTheme();
  closeAiSettings();
}

function fillTermSettings() {
  const t = (state.settings && state.settings.terminal) || { fontSize: 13, theme: 'nebula', scrollback: 2000 };
  $('#term-fontsize').value = t.fontSize || 13;
  $('#term-theme').value = t.theme || 'nebula';
  $('#term-scrollback').value = t.scrollback || 2000;
  const tempdir = $('#term-open-tempdir');
  // 真实可选可改可复制的路径直接显示;未配置时初始展示默认路径
  const def = state.settings && state.settings.openTempDirDefaultDir;
  tempdir.value = (state.settings && state.settings.openTempDir) || def || '';
  tempdir.placeholder = '';
}

function fillLogSettings() {
  const sl = (state.settings && state.settings.sessionLog) || {};
  $('#setlog-auto').checked = !!sl.auto;
  const dir = $('#setlog-dir');
  // 同缓存目录:真实可选可改可复制的路径直接显示;未配置时初始展示默认路径
  const def = state.settings && state.settings.sessionLogDefaultDir;
  dir.value = sl.dir || def || '';
  dir.placeholder = '';
  const format = sl.format === 'raw' ? 'raw' : 'text';
  document.querySelector(`input[name="setlog-format"][value="${format}"]`).checked = true;
  $('#setlog-timestamps').checked = sl.timestamps !== false;
  $('#setlog-screen').checked = sl.includeScreen !== false;
}

/// 快捷键一览:列出全部可配键位的动作 —— 有内置键位的,以及所有注册命令
/// (没有默认键位的显示「未设置」,同样可以录一个)。已自定义但未注册的动作
/// 也保留,避免孤儿覆盖项无处清除。
/// 每行:操作名 / 当前键位(点击录制) / 单行恢复默认按钮。
export function renderKeymapTable() {
  const body = $('#settings-keys-tbody');
  body.innerHTML = '';
  const custom = (state.settings && state.settings.keybindings) || {};
  const labels = new Map(listCommands().map((c) => [c.id, c.label]));
  // 先按 DEFAULT_KEYMAP 的顺序,再补注册命令,最后补只在自定义里出现的孤儿动作
  const ids = [...Object.keys(DEFAULT_KEYMAP), ...labels.keys(), ...Object.keys(custom)];
  for (const id of [...new Set(ids)]) {
    const specs = specsOf(id);
    const defaults = defaultSpecsOf(id);
    const label = labels.get(id) || DEFAULT_KEYMAP[id]?.label || id;
    const overridden = !!custom[id] && !sameBindingSet(
      Array.isArray(custom[id]) && custom[id].length ? custom[id] : specs, defaults);
    const row = document.createElement('tr');
    row.dataset.action = id;
    if (overridden) row.classList.add('keys-custom');

    const name = document.createElement('td');
    name.className = 'keys-name';
    name.textContent = id.startsWith('term.') ? `终端内${label}` : label;

    const keys = document.createElement('td');
    keys.className = 'keys-accel';
    keys.dataset.action = id;
    // 按钮语义:可聚焦、可点击进入录制
    keys.setAttribute('role', 'button');
    keys.tabIndex = 0;
    keys.setAttribute('aria-label', `${label}的快捷键，${specs.length ? accel(specs[0]) : '未设置'}，回车开始录制`);
    renderAccelCell(keys, id);

    const reset = document.createElement('td');
    reset.className = 'keys-col-reset';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'keys-row-reset';
    resetBtn.dataset.resetAction = id;
    resetBtn.title = '恢复默认';
    resetBtn.setAttribute('aria-label', `恢复「${label}」的默认快捷键`);
    resetBtn.disabled = !defaults.length && !specs.length;
    resetBtn.textContent = '↺';
    reset.append(resetBtn);

    row.append(name, keys, reset);
    body.appendChild(row);
  }
  updateKeysDirty();
}

/// 键位单元格内容:当前生效键位 + (被改过时)灰色的默认键位提示。
function renderAccelCell(cell, id) {
  cell.classList.remove('keys-recording', 'keys-conflict-cell');
  const specs = specsOf(id);
  const defaults = defaultSpecsOf(id);
  const show = specs.length ? specs : defaults;
  cell.textContent = show.length
    ? show.map((spec) => accel(spec).replace('1..9', '1–9')).join(' / ')
    : '未设置';
  if (!specs.length) cell.classList.add('keys-accel-empty');
  const custom = (state.settings && state.settings.keybindings) || {};
  const changed = custom[id] || (defaults.length && !specs.length);
  if (changed && defaults.length && !sameBindingSet(specs, defaults)) {
    const hint = document.createElement('span');
    hint.className = 'keys-default';
    hint.textContent = `默认 ${defaults.map((s) => accel(s).replace('1..9', '1–9')).join(' / ')}`;
    cell.appendChild(hint);
  }
}

/// 两组键位是否等价(忽略大小写与修饰键顺序),用于判断"是否被改过"。
function sameBindingSet(a, b) {
  const norm = (list) => list.map((s) => bindingSignature(s)).sort().join('\u0000');
  return norm(a) === norm(b);
}

// —— 快捷键录制 ——
// 录制态由模块内的 pending 描述,渲染只用 settings.keybindings 作为事实源,
// 这样"录制中改的键位"和"已保存的键位"不会互相污染。
let pending = null;      // { id, value } value 为 spec 数组
let recordingId = '';
const conflictState = { message: '' };

/// 打开快捷键分区时调用:草稿归零(下次进入按已保存值重新编辑)。
function resetKeyDraft() {
  pending = null;
  recordingId = '';
  conflictState.message = '';
  const search = $('#keys-search');
  if (search) search.value = '';
  const hint = $('#keys-conflict');
  if (hint) hint.textContent = '';
}

/// 正在编辑的完整覆盖表:已保存的 keybindings 叠加本次录制结果。
function draftKeybindings() {
  return { ...((state.settings && state.settings.keybindings) || {}), ...(pending || {}) };
}

/// 把草稿应用成"当前生效键位",让表格能读到录制结果(不写 settings)。
function withDraft(fn) {
  const saved = state.settings && state.settings.keybindings;
  if (state.settings) state.settings.keybindings = draftKeybindings();
  invalidateKeymapCache();
  try { return fn(); }
  finally {
    if (state.settings) state.settings.keybindings = saved;
    invalidateKeymapCache();
  }
}

/// 校验草稿:同一键位绑两个动作时,appShortcutOf 只认第一个命中的,
/// 后者永远不触发 —— 必须拦住。草稿里空数组表示"恢复默认",按默认键位
/// 参与校验(不能当成"没有键")。校验逻辑在 keymap.js,与单测共用。
function findConflicts(draft) {
  return findKeyConflicts(draft);
}

/// 重新校验并更新"冲突 / 未保存"两处状态。
function updateKeysDirty() {
  const draft = draftKeybindings();
  withDraft(() => renderAllAccels());
  const issues = findConflicts(draft);
  const labels = new Map(listCommands().map((c) => [c.id, c.label]));
  const labelOf = (id) => labels.get(id) || DEFAULT_KEYMAP[id]?.label || id;
  conflictState.message = issues.length
    ? `${issues.map((i) => `${accel(i.spec)} 已被「${labelOf(i.conflictWith)}」占用`)[0]}${issues.length > 1 ? ` 等 ${issues.length} 处冲突` : ''}`
    : '';
  const hint = $('#keys-conflict');
  if (hint) hint.textContent = conflictState.message;
  // 冲突单元格标红
  const conflictIds = new Set(issues.map((i) => i.id));
  for (const cell of document.querySelectorAll('#settings-keys-tbody td.keys-accel')) {
    cell.classList.toggle('keys-conflict-cell', conflictIds.has(cell.dataset.action));
  }
  const dirty = Object.keys(pending || {}).length > 0;
  const save = $('#btn-keys-save');
  if (save) save.disabled = !dirty || issues.length > 0;
  return { issues, dirty };
}

/// 只重画键位单元格(不重建行,保留滚动位置与焦点)。
function renderAllAccels() {
  for (const cell of document.querySelectorAll('#settings-keys-tbody td.keys-accel')) {
    if (cell.dataset.action === recordingId) continue; // 录制中的单元格保持提示文字
    renderAccelCell(cell, cell.dataset.action);
  }
}

function startRecording(cell) {
  const id = cell.dataset.action;
  if (recordingId && recordingId !== id) stopRecording();
  recordingId = id;
  cell.classList.add('keys-recording');
  cell.textContent = '按下新的快捷键…（Esc 取消）';
}

function stopRecording(redraw = true) {
  const id = recordingId;
  recordingId = '';
  if (!redraw || !id) return;
  const cell = document.querySelector(`#settings-keys-tbody td.keys-accel[data-action="${CSS.escape(id)}"]`);
  if (cell) { cell.classList.remove('keys-recording'); renderAccelCell(cell, id); }
}

/// 录制器:在捕获阶段吞掉所有按键,避免 ⌘W / F11 / Ctrl+Shift+T 等
/// 真的触发应用行为或原生菜单。Esc 取消、Backspace 恢复该项默认。
function onRecordKeydown(event) {
  if (!recordingId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const id = recordingId;
  const raw = String(event.key || '');
  if (raw === 'Escape') { stopRecording(); return; }
  if (raw === 'Backspace' || raw === 'Delete') {
    pending = { ...(pending || {}), [id]: [] };
    stopRecording(false);
    updateKeysDirty();
    return;
  }
  const spec = specOfEvent(event);
  if (!spec) return; // 只按了修饰键:继续等主键
  pending = { ...(pending || {}), [id]: [spec] };
  stopRecording(false);
  updateKeysDirty();
  // 重画后补上读屏提示(视觉文字已由 updateKeysDirty 更新)
  const cell = document.querySelector(`#settings-keys-tbody td.keys-accel[data-action="${CSS.escape(id)}"]`);
  if (cell) cell.setAttribute('aria-label', `已录制 ${accel(spec)}，回车重新录制`);
}

/// 把草稿转成保存用的补丁:有改动的项写键位数组,恢复默认的项写 null
/// (后端按项合并,null 表示删掉覆盖项)。
function keybindingsPatch() {
  return keybindingsPatchOf((state.settings && state.settings.keybindings) || {}, pending || {});
}

export async function saveKeybindings() {
  const { issues } = updateKeysDirty();
  if (issues.length) { toast(conflictState.message || '快捷键冲突，无法保存', 'error'); return false; }
  const patch = keybindingsPatch();
  if (!Object.keys(patch).length) { dismissKeysSection(); return true; }
  try {
    state.settings = await api('settings:save', { keybindings: patch });
  } catch (e) {
    toast(e?.message || '保存失败', 'error');
    return false;
  }
  // 生效链:解析缓存 → 全部弹窗/按钮提示 → 菜单与命令面板 → macOS 原生菜单
  // 加速键(后者监听 commands-refreshed 后按新的 specOf 重设加速键)
  invalidateKeymapCache();
  applyAccelTitles();
  resetKeyDraft();
  renderKeymapTable();
  document.dispatchEvent(new Event('nebula:commands-refreshed'));
  dismissKeysSection();
  toast('快捷键已保存', 'success');
  return true;
}

/// 关闭/取消:未保存的录制草稿直接丢弃,不影响已保存键位。
function dismissKeysSection() {
  resetKeyDraft();
  dismissSettings();
  closeModal('#modal-settings');
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
  if (target === 'keys') {
    // 每次进入按已保存值重建(丢弃上次未保存的录制草稿)
    resetKeyDraft();
    renderKeymapTable();
  }
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
  $('#btn-term-cancel').addEventListener('click', dismissSettings);
  $('#btn-term-save').addEventListener('click', saveTermSettings);
  $('#btn-log-cancel').addEventListener('click', dismissSettings);
  $('#btn-log-save').addEventListener('click', saveLogSettings);
  $('#setlog-pick').addEventListener('click', async () => {
    try {
      const current = $('#setlog-dir').value.trim();
      const picked = await api('dialog:pickDirectory', { defaultPath: current });
      if (picked) $('#setlog-dir').value = picked;
    } catch { /* 取消选择不提示 */ }
  });
  // 缓存目录:框内文件夹图标 = 选择目录并覆盖输入值,默认定位到当前路径
  $('#btn-term-tempdir-pick').addEventListener('click', async () => {
    try {
      const current = $('#term-open-tempdir').value.trim();
      const picked = await api('dialog:pickDirectory', { defaultPath: current });
      if (picked) $('#term-open-tempdir').value = picked;
    } catch { /* 取消选择不提示 */ }
  });
  $('#btn-keys-close').addEventListener('click', dismissKeysSection);
  $('#btn-keys-save').addEventListener('click', () => { saveKeybindings(); });
  $('#btn-keys-reset-all').addEventListener('click', () => {
    const ids = new Set([...Object.keys(DEFAULT_KEYMAP), ...Object.keys(state.settings?.keybindings || {})]);
    pending = {};
    for (const id of ids) if (defaultSpecsOf(id).length) pending[id] = [];
    updateKeysDirty();
  });
  // 录制:捕获阶段吞键,避免真的触发应用快捷键或原生菜单
  document.addEventListener('keydown', onRecordKeydown, true);
  // 点键位单元格 / 回车进入录制
  const tbody = $('#settings-keys-tbody');
  tbody.addEventListener('click', (event) => {
    const resetBtn = event.target.closest('[data-reset-action]');
    if (resetBtn) {
      const id = resetBtn.dataset.resetAction;
      pending = { ...(pending || {}), [id]: [] };
      updateKeysDirty();
      return;
    }
    const cell = event.target.closest('td.keys-accel');
    if (cell) startRecording(cell);
  });
  tbody.addEventListener('keydown', (event) => {
    const cell = event.target.closest?.('td.keys-accel');
    if (!cell) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startRecording(cell);
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      pending = { ...(pending || {}), [cell.dataset.action]: [] };
      updateKeysDirty();
    }
  });
  // 搜索过滤:按操作名与动作 id 匹配
  $('#keys-search').addEventListener('input', filterKeyRows);
  // 离开快捷键分区或关闭窗口:丢弃未保存的草稿(与其它分区取消语义一致)
  document.addEventListener('nebula:modal-scope', () => {
    if (!settingsOpen()) resetKeyDraft();
  });
}

/// 过滤快捷键表:隐藏不匹配的行(不重建,保留录制态)。
function filterKeyRows() {
  const q = ($('#keys-search').value || '').trim().toLowerCase();
  for (const row of document.querySelectorAll('#settings-keys-tbody tr')) {
    if (!q) { row.classList.remove('keys-hidden'); continue; }
    const name = (row.querySelector('.keys-name')?.textContent || '').toLowerCase();
    const id = (row.dataset.action || '').toLowerCase();
    row.classList.toggle('keys-hidden', !(name.includes(q) || id.includes(q)));
  }
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
  dismissSettings(); // 关窗口,同时回滚主题预览并丢弃 AI 分区未保存的草稿
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
    dismissSettings(); // 关窗口,同时回滚主题预览并丢弃其它分区未保存的草稿
    toast('会话日志设置已保存（对之后开始的日志生效）', 'success');
  } catch (e) {
    toast(e?.message || '保存失败', 'error');
  }
}
