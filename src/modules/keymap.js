// 快捷键单一事实源:动作(action)→ 按键 spec 的映射 + 按键事件匹配器。
//
// spec 写法:'cmd+shift+Enter'、'ctrl+shift+T'。修饰键 cmd(= metaKey)、
// ctrl、alt、shift 按"精确匹配"处理:spec 没写的修饰键必须没按下。默认表
// 按平台分写(mac / win / linux),同一动作可有多个键位(数组,第一个用于
// 提示展示)。兼容旧写法 mod:macOS 解析为 cmd,Windows/Linux 解析为 ctrl ——
// 只留给 settings.keybindings 的自定义数据,默认表一律写显式修饰键,避免
// 同一个 spec 在两个平台上意思不同。
//
// 平台约定:Windows/Linux 的应用快捷键一律 Ctrl+Shift+字母,Ctrl+字母留给
// shell(^W 删词、^D EOF、^F 前移…);macOS 用 ⌘,Ctrl 组合全部留给 shell。
//
// 绑定层和提示层都只读这张表:绑定用 matchAction / appShortcutOf,提示用
// accelOf(内部走 core.accel)。新增/修改快捷键只动 DEFAULT_KEYMAP 一处。
//
// 注意:终端内复制/粘贴/全选由 terminal.js 的自定义按键处理承担(它们是
// 组件内动作,不经全局分发),但键位同样从本表读取。

import { accel, PLATFORM, state } from './core.js';

const pc = (spec) => ({ win: spec, linux: spec });

/// 内置默认键位。'1..9' 是 tab.switch 的范围写法:匹配任一数字键 1-9,
/// 具体序号由 digitOf(event) 取。
export const DEFAULT_KEYMAP = {
  'tab.new':         { mac: 'cmd+T',           ...pc('ctrl+shift+T'),     label: '新建标签页' },
  'workspace.close': { mac: 'cmd+W',           ...pc('ctrl+shift+W'),     label: '关闭当前窗格或标签' },
  'session.search':  { mac: 'cmd+F',           ...pc('ctrl+shift+F'),     label: '在终端中搜索' },
  'pane.split':      { mac: 'cmd+D',           ...pc('ctrl+shift+D'),     label: '分屏(自动最优布局)' },
  'pane.zoom':       { mac: 'cmd+shift+Enter', ...pc('ctrl+shift+Enter'), label: '放大/还原当前窗格' },
  'tab.switch':      { mac: 'cmd+1..9',        ...pc('ctrl+1..9'),        label: '切换到第 N 个标签' },
  'files.selectAll': { mac: 'cmd+A',           ...pc('ctrl+A'),           label: '全选(焦点文件分屏内)' },
  // 有选区时 Ctrl+C 复制、无选区发 SIGINT(Windows Terminal 规则),仅 Win/Linux;
  // macOS 的 Ctrl+C 一律是 SIGINT。
  'term.copy':       { mac: 'cmd+C', win: ['ctrl+C', 'ctrl+shift+C'], linux: ['ctrl+shift+C', 'ctrl+C'], label: '复制' },
  // Linux 的 Ctrl+V 留给 shell(readline 原样插入 / vim 列选择)。
  'term.paste':      { mac: 'cmd+V', win: ['ctrl+V', 'ctrl+shift+V'], linux: 'ctrl+shift+V', label: '粘贴' },
  'term.selectAll':  { mac: 'cmd+A',           ...pc('ctrl+shift+A'),     label: '全选' },
};

/// 应用级动作:无论焦点在哪(包括终端内)都归应用处理,由全局分发执行。
/// 复制/粘贴/全选属于所在组件,不在此列。
export const APP_ACTIONS = ['pane.zoom', 'session.search', 'workspace.close', 'tab.new', 'pane.split', 'tab.switch'];

const platformKey = () => (PLATFORM === 'darwin' ? 'mac' : PLATFORM === 'windows' ? 'win' : 'linux');

function defaultSpecs(def) {
  const raw = def[platformKey()] ?? def.spec ?? '';
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
}

function parseSpec(spec) {
  const b = { spec, meta: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const p of spec.split('+')) {
    const k = p.trim().toLowerCase();
    if (k === 'mod') { if (PLATFORM === 'darwin') b.meta = true; else b.ctrl = true; }
    else if (k === 'cmd' || k === 'meta') b.meta = true;
    else if (k === 'ctrl') b.ctrl = true;
    else if (k === 'alt') b.alt = true;
    else if (k === 'shift') b.shift = true;
    else if (k) b.key = k;
  }
  return b.key ? b : null;
}

/// 解析动作的全部键位。settings.keybindings 里的非法/未知条目一律忽略,
/// 回落内置默认 —— 自定义数据损坏时不至于废掉快捷键。
function resolveBindings(actionId) {
  const def = DEFAULT_KEYMAP[actionId];
  if (!def) return [];
  let specs = defaultSpecs(def);
  const custom = state.settings && state.settings.keybindings && state.settings.keybindings[actionId];
  const customList = (Array.isArray(custom) ? custom : [custom])
    .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  if (customList.length) specs = customList;
  return specs.map(parseSpec).filter(Boolean);
}

const bindingCache = new Map();
function bindingsOf(actionId) {
  if (!bindingCache.has(actionId)) bindingCache.set(actionId, resolveBindings(actionId));
  return bindingCache.get(actionId);
}

/// settings.keybindings 变化后调用:使下一次匹配重新解析自定义 spec。
export function invalidateKeymapCache() {
  bindingCache.clear();
}

/// 当前生效的首选 spec(自定义优先,否则默认)。未知动作返回 ''。
export function specOf(actionId) {
  return bindingsOf(actionId)[0]?.spec || '';
}

/// 当前生效的全部 spec。
export function specsOf(actionId) {
  return bindingsOf(actionId).map((b) => b.spec);
}

/// 数字键 1-9 的序号;非数字键返回 0。优先认物理键位(event.code),
/// Shift 或非拉丁布局下 event.key 不再是数字。
export function digitOf(event) {
  const m = /^Digit([1-9])$/.exec(event.code || '') || /^([1-9])$/.exec(event.key || '');
  return m ? Number(m[1]) : 0;
}

function keyMatches(b, event) {
  if (b.key === '1..9') return digitOf(event) > 0;
  const key = String(event.key || '').toLowerCase();
  if (key === b.key) return true;
  // 字母键再认物理键位:Shift 组合、非拉丁布局(如俄文)下 event.key 不是该字母
  if (/^[a-z]$/.test(b.key)) return event.code === 'Key' + b.key.toUpperCase();
  if (/^[0-9]$/.test(b.key)) return event.code === 'Digit' + b.key;
  return false;
}

function bindingMatches(b, event) {
  return b.meta === !!event.metaKey && b.ctrl === !!event.ctrlKey
    && b.alt === !!event.altKey && b.shift === !!event.shiftKey && keyMatches(b, event);
}

/// 按键事件是否触发该动作(任一键位命中即可)。第三个参数是旧签名的
/// appMod,已不再使用:修饰键由 spec 精确描述。
export function matchAction(actionId, event) {
  return bindingsOf(actionId).some((b) => bindingMatches(b, event));
}

/// 命中的应用级动作名,未命中返回 ''。终端的自定义按键处理据此把按键
/// 让给全局分发;全局分发据此先 preventDefault 再判断能否执行。
export function appShortcutOf(event) {
  if (!event || event.isComposing) return '';
  return APP_ACTIONS.find((id) => matchAction(id, event)) || '';
}

/// 动作的平台化显示文案:'⌘⇧↵' / 'Ctrl+Shift+Enter'(多键位取第一个)。
/// 直接复用 core.accel,符号表只有 core.js 一份。
export function accelOf(actionId) {
  return accel(specOf(actionId));
}

/// 提示统一入口:参数是动作名则查 keymap(自定义键位生效),否则按裸 spec
/// 渲染。data-accel 的取值两者皆可,新增提示一律优先写动作名。
export function accelSpec(actionOrSpec) {
  const name = String(actionOrSpec || '').trim();
  if (DEFAULT_KEYMAP[name]) return accelOf(name);
  return accel(name);
}
