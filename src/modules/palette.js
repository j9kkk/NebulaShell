// 命令面板:全部注册命令 + 已打开的标签 + 主机 + 快速连接的键盘总入口。
//
// 结构是 combobox(输入框)+ listbox(结果),aria-activedescendant 指向当前项,
// 焦点始终留在输入框。执行时先关面板(焦点回到打开前的位置),再执行 ——
// 命令若打开弹窗,弹窗记下的归还目标就是原位置。
import { $, accel, closeCtxMenu, closeModal, IS_MAC, openModal, state, toast, topModal } from './core.js';
import { CATEGORY_LABEL, executeCommand, listCommands, PALETTE_MODAL_ID } from './commands.js';
import { accelOf } from './keymap.js';
import { closeMoreMenu } from './menu.js';
import { activateTab, connectHost, quickConnect } from './terminal.js';
import { quickTargetOf, rankItems } from '../shared/palette-match.js';

const RECENT_MAX = 5;
const HOST_MAX = 30;
const PAGE = 8;
const CATEGORY_ORDER = ['app', 'layout', 'panel', 'session', 'host'];

const recent = [];
let rows = [];
let active = -1;

const modal = () => document.getElementById(PALETTE_MODAL_ID);

export function isPaletteOpen() {
  const el = modal();
  return !!el && !el.classList.contains('hidden');
}

const newTabModifier = (event) => (IS_MAC ? event.metaKey : event.ctrlKey);

function commandRows() {
  return listCommands().map((command) => ({
    type: 'command', id: command.id, name: command.label,
    keywords: [...command.keywords, command.id],
    category: CATEGORY_LABEL[command.category] || '',
    categoryId: command.category,
    key: command.shortcut ? accelOf(command.shortcut) : '',
    disabled: !command.enabled, reason: command.reason, checked: command.checked,
  }));
}

function tabRows() {
  return [...state.tabs.values()].map((tab, index) => ({
    type: 'tab', id: tab.id,
    name: tab.el?.querySelector('.tab-title')?.textContent || tab.customTitle || '新标签',
    keywords: [`${index + 1}`],
    meta: tab.id === state.activeTabId ? '当前标签' : `第 ${index + 1} 个标签`,
  }));
}

function hostRows() {
  return (state.hosts || []).map((host) => ({
    type: 'host', id: host.id, name: host.name || host.host,
    keywords: [host.host, host.username, `${host.username}@${host.host}`, host.group].filter(Boolean),
    meta: `${host.username}@${host.host}:${host.port}`,
  }));
}

function buildRows(query) {
  const q = query.trim();
  const commands = commandRows();
  if (!q) {
    const groups = [];
    const used = recent.map((id) => commands.find((c) => c.id === id)).filter(Boolean);
    if (used.length) groups.push(['最近使用', used]);
    for (const category of CATEGORY_ORDER) {
      const list = commands.filter((c) => c.categoryId === category);
      if (list.length) groups.push([CATEGORY_LABEL[category], list]);
    }
    return groups;
  }
  const groups = [];
  const ranked = rankItems(q, commands);
  if (ranked.length) groups.push(['命令', ranked]);
  const tabs = rankItems(q, tabRows());
  if (tabs.length) groups.push(['标签', tabs]);
  const hosts = rankItems(q, hostRows()).slice(0, HOST_MAX);
  if (hosts.length) groups.push(['主机', hosts]);
  const target = quickTargetOf(q);
  if (target) {
    const text = `${target.username}@${target.host}:${target.port}`;
    groups.push(['快速连接', [{ type: 'quick', id: text, name: `快速连接 ${text}`, target, meta: '不保存到主机列表' }]]);
  }
  return groups;
}

function rowElement(row, index) {
  const el = document.createElement('div');
  el.className = 'pal-row';
  el.id = `pal-opt-${index}`;
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', 'false');
  el.dataset.index = String(index);
  if (row.disabled) {
    el.setAttribute('aria-disabled', 'true');
    if (row.reason) el.setAttribute('aria-description', row.reason);
  }
  if (row.checked !== undefined) el.setAttribute('aria-checked', String(row.checked));
  const check = document.createElement('span');
  check.className = 'pal-check';
  check.textContent = row.checked ? '✓' : '';
  const text = document.createElement('span');
  text.className = 'pal-text';
  const name = document.createElement('span');
  name.className = 'pal-name';
  name.textContent = row.name;
  text.appendChild(name);
  const sub = row.disabled ? row.reason : row.meta;
  if (sub) {
    const subEl = document.createElement('span');
    subEl.className = row.disabled ? 'pal-sub pal-reason' : 'pal-sub';
    subEl.textContent = sub;
    text.appendChild(subEl);
  }
  const category = document.createElement('span');
  category.className = 'pal-cat';
  category.textContent = row.type === 'command' ? row.category : '';
  const key = document.createElement('span');
  key.className = 'pal-key';
  key.textContent = row.type === 'command' ? row.key
    : row.type === 'host' ? `↵ 连接　${accel(IS_MAC ? 'cmd+Enter' : 'ctrl+Enter')} 新标签` : '';
  el.append(check, text, category, key);
  return el;
}

function render() {
  const list = $('#palette-list');
  const input = $('#palette-input');
  const groups = buildRows(input.value);
  rows = [];
  list.textContent = '';
  for (const [title, items] of groups) {
    const head = document.createElement('div');
    head.className = 'pal-group';
    head.setAttribute('role', 'presentation');
    head.textContent = title;
    list.appendChild(head);
    for (const row of items) {
      list.appendChild(rowElement(row, rows.length));
      rows.push(row);
    }
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'pal-empty';
    empty.setAttribute('role', 'presentation');
    empty.textContent = '没有匹配的命令、标签或主机';
    list.appendChild(empty);
  }
  const firstEnabled = rows.findIndex((row) => !row.disabled);
  setActive(firstEnabled >= 0 ? firstEnabled : rows.length ? 0 : -1);
}

function setActive(index) {
  active = index;
  const input = $('#palette-input');
  for (const el of $('#palette-list').querySelectorAll('.pal-row')) {
    const on = Number(el.dataset.index) === index;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) el.scrollIntoView?.({ block: 'nearest' });
  }
  if (index >= 0) input.setAttribute('aria-activedescendant', `pal-opt-${index}`);
  else input.removeAttribute('aria-activedescendant');
}

function move(delta, wrap = true) {
  if (!rows.length) return;
  let next = active + delta;
  if (wrap) next = (next + rows.length) % rows.length;
  else next = Math.max(0, Math.min(rows.length - 1, next));
  setActive(next);
}

function remember(id) {
  const at = recent.indexOf(id);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift(id);
  recent.length = Math.min(recent.length, RECENT_MAX);
}

async function activate(row, { newTab = false } = {}) {
  if (!row || row.disabled) return false;
  closePalette();
  try {
    if (row.type === 'command') { remember(row.id); return await executeCommand(row.id); }
    if (row.type === 'tab') { activateTab(row.id); return true; }
    if (row.type === 'host') { await connectHost(row.id, null, newTab ? { newTab: true } : {}); return true; }
    if (row.type === 'quick') { await quickConnect(row.target); return true; }
  } catch (error) {
    toast(error.message || '操作失败', 'error');
  }
  return false;
}

export function openPalette(query = '') {
  if (isPaletteOpen()) { $('#palette-input').focus(); return; }
  if (topModal()) return;
  // 先把焦点还给 ⋯ / 右键菜单打开前的位置,openModal 记下的归还目标才是它
  closeMoreMenu('opener');
  closeCtxMenu();
  const input = $('#palette-input');
  input.value = query;
  render();
  openModal(modal());
  input.focus();
}

export function closePalette() {
  if (isPaletteOpen()) closeModal(modal());
}

export function bindPalette() {
  const input = $('#palette-input');
  const list = $('#palette-list');
  if (!input || !list) return;
  $('#palette-foot').textContent = `↑↓ 选择 · ↵ 执行 · ${accel(IS_MAC ? 'cmd+Enter' : 'ctrl+Enter')} 在新标签连接 · Esc 关闭`;
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'PageDown') { event.preventDefault(); move(PAGE, false); }
    else if (event.key === 'PageUp') { event.preventDefault(); move(-PAGE, false); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      activate(rows[active], { newTab: newTabModifier(event) });
    }
  });
  // 点选项不挪焦点:焦点留在输入框,activedescendant 才有意义
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('mousemove', (event) => {
    const el = event.target.closest?.('.pal-row');
    if (el && Number(el.dataset.index) !== active) setActive(Number(el.dataset.index));
  });
  list.addEventListener('click', (event) => {
    const el = event.target.closest?.('.pal-row');
    if (el) activate(rows[Number(el.dataset.index)], { newTab: newTabModifier(event) });
  });
}

/// 测试观测:当前结果行(不暴露内部函数)。
export function paletteSnapshot() {
  return {
    open: isPaletteOpen(),
    query: $('#palette-input')?.value ?? '',
    active,
    activeDescendant: $('#palette-input')?.getAttribute('aria-activedescendant') || '',
    groups: [...($('#palette-list')?.querySelectorAll('.pal-group') || [])].map((el) => el.textContent),
    rows: rows.map((row, index) => ({
      type: row.type, id: row.id, name: row.name, meta: row.meta || '', disabled: !!row.disabled, reason: row.reason || '',
      checked: row.checked, key: row.key || '', active: index === active,
    })),
  };
}

/// 测试驱动:设置查询、移动、执行当前项。
export function paletteInput(query) {
  const input = $('#palette-input');
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
