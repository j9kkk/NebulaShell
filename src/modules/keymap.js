// 快捷键单一事实源:动作(action)→ 按键 spec 的映射 + 按键事件匹配器。
//
// spec 是平台无关的规范化写法:'mod+shift+Enter'。mod 在 macOS 解析为
// metaKey(Cmd)、Windows/Linux 解析为 ctrlKey(与 core.js 的 isAppModifier
// 同一套规则)。绑定层和提示层都只读这张表:绑定用 matchAction,提示用
// accelOf(内部走 core.accel),新增/修改快捷键只动 DEFAULT_KEYMAP 一处。
// 后期开放自定义快捷键时,用 settings.keybindings 覆盖默认 spec(数据层
// 已就绪,录制 UI 另行实现)。
//
// 注意:这里只管"应用级"快捷键。终端内复制/粘贴的分流规则(macOS 保留
// shell 的 Ctrl 语义、有选区的 Ctrl/Cmd+C 是复制)由 terminal.js 的自定义
// 按键处理承担,但动作名与 spec 仍从本表读取,提示与行为不会各改各的。

import { accel, IS_MAC, state } from './core.js';

/// 内置默认键位。value 为 spec 字符串;'mod+1..9' 是 tab.switch 的范围写法,
/// 仅用于提示展示,实际匹配在 entry.js 里对 1-9 逐键判断。
export const DEFAULT_KEYMAP = {
  'tab.new':         { spec: 'mod+T',           label: '新建标签页' },
  'workspace.close': { spec: 'mod+W',           label: '关闭当前窗格或标签' },
  'session.search':  { spec: 'mod+F',           label: '在终端中搜索' },
  'pane.split':      { spec: 'mod+D',           label: '分屏(自动最优布局)' },
  'pane.zoom':       { spec: 'mod+shift+Enter', label: '放大/还原当前窗格' },
  'tab.switch':      { spec: 'mod+1..9',        label: '切换到第 N 个标签' },
  'files.selectAll': { spec: 'mod+A',           label: '全选(焦点文件分屏内)' },
  'term.copy':       { spec: 'mod+C',           label: '复制' },
  'term.paste':      { spec: 'mod+V',           label: '粘贴' },
  'term.selectAll':  { spec: 'mod+A',           label: '全选' },
};

/// 解析 spec 为匹配用结构。settings.keybindings 里的非法/未知条目一律忽略,
/// 回落内置默认 —— 自定义数据损坏时不至于废掉快捷键。
function resolveBinding(actionId) {
  const def = DEFAULT_KEYMAP[actionId];
  if (!def) return null;
  let spec = def.spec;
  const custom = state.settings && state.settings.keybindings;
  if (custom && typeof custom[actionId] === 'string' && custom[actionId].trim()) {
    spec = custom[actionId].trim();
  }
  const binding = { spec, mod: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const p of spec.split('+')) {
    const k = p.trim().toLowerCase();
    if (k === 'mod') binding.mod = true;
    else if (k === 'ctrl') binding.ctrl = true;
    else if (k === 'alt') binding.alt = true;
    else if (k === 'shift') binding.shift = true;
    else if (k) binding.key = k;
  }
  return binding;
}

const bindingCache = new Map();
function bindingOf(actionId) {
  if (!bindingCache.has(actionId)) bindingCache.set(actionId, resolveBinding(actionId));
  return bindingCache.get(actionId);
}

/// settings.keybindings 变化后调用:使下一次匹配重新解析自定义 spec。
export function invalidateKeymapCache() {
  bindingCache.clear();
}

/// 当前生效的 spec(自定义优先,否则默认)。未知动作返回 ''。
export function specOf(actionId) {
  return DEFAULT_KEYMAP[actionId] ? bindingOf(actionId).spec : '';
}

/// 按键事件是否触发该动作。appMod = isAppModifier(event) 的结果,由调用方
/// 传入(全局入口已判过一次,不必重算)。键名带 '..'(范围写法)不可匹配。
/// 平台细则:mod 匹配平台应用修饰键;显式 ctrl 只在非 mac 参与(mac 的
/// Ctrl 保留给 shell);mac 上任何 Ctrl 组合都不命中应用快捷键。
export function matchAction(actionId, event, appMod) {
  const b = bindingOf(actionId);
  if (!b || !b.key || b.spec.includes('..')) return false;
  if (b.mod) {
    if (!appMod) return false;
  } else if (appMod) {
    return false;
  }
  if (b.shift !== !!event.shiftKey) return false;
  if (b.alt !== !!event.altKey) return false;
  if (b.ctrl) {
    if (IS_MAC || !event.ctrlKey) return false;
  } else if (IS_MAC && event.ctrlKey) {
    return false;
  }
  return String(event.key || '').toLowerCase() === b.key;
}

/// 动作的平台化显示文案:'⌘⇧↵' / 'Ctrl+Shift+Enter'。直接复用 core.accel,
/// 符号表只有 core.js 一份。
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
