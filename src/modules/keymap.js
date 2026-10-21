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
  // Ctrl+K 是 readline 的"删到行尾",命令面板因此用 ⇧P(VS Code / Windows Terminal 惯例)
  'palette.open':    { mac: 'cmd+shift+P',     ...pc('ctrl+shift+P'),     label: '命令面板' },
  'settings.open':   { mac: 'cmd+,',           ...pc('ctrl+,'),           label: '设置' },
  // ⌘K 清屏是 macOS 终端惯例;Win/Linux 没有不与 shell 冲突的对应键,不设
  'session.clear':   { mac: 'cmd+K',                                      label: '清屏' },
  // 面板开关(标题栏左右两个按钮)。Win/Linux 不用 Ctrl+B:readline 的后退一个字符
  'panel.sidebar':   { mac: 'cmd+B',           ...pc('ctrl+shift+B'),     label: '主机侧栏' },
  'panel.tools':     { mac: 'alt+cmd+B',       ...pc('ctrl+shift+alt+B'), label: 'AI 助手' },
  // ⌘N 保留给 AI 对话(既有习惯),新建主机用 ⇧⌘N
  'ai.newThread':    { mac: 'cmd+N',           ...pc('ctrl+shift+N'),     label: '新建 AI 对话' },
  'ai.cycleEffort':  { mac: 'cmd+T',           ...pc('ctrl+T'),           label: '切换思考强度' },
  'session.history': { mac: 'cmd+shift+H',     ...pc('ctrl+shift+H'),     label: '命令历史' },
  'tools.snippets':  { mac: 'cmd+shift+S',     ...pc('ctrl+shift+S'),     label: '常用命令' },
  // F11 全屏(Windows Terminal 惯例);macOS 用系统的「进入全屏」(⌃⌘F)
  'window.fullscreen': { ...pc('F11'),                                    label: '全屏' },

  // —— 菜单项补齐的键位(全部进 APP_ACTIONS,否则会被终端吃掉)——
  // 终端里的 Ctrl+字母是 readline 键(^W 删词 / ^D EOF / ^F 前移 / ^R 历史搜索),
  // 所以 PC 侧继续沿用「Ctrl+Shift+字母」;同族布局命令用 Alt 作次级前缀,
  // 与 ⌥(macOS)保持一一对应。
  'host.new':        { mac: 'cmd+shift+N',     ...pc('ctrl+shift+alt+N'), label: '新建主机' },
  'tab.rename':      { mac: 'F2',              ...pc('F2'),               label: '重命名标签' },
  'tab.file.add':    { mac: 'cmd+shift+E',     ...pc('ctrl+shift+E'),     label: '新增文件分屏' },
  'tabs.list':       { mac: 'alt+cmd+L',       ...pc('ctrl+shift+alt+L'), label: '全部标签' },
  'workspace.tile':  { mac: 'alt+cmd+T',       ...pc('ctrl+shift+alt+T'), label: '标签平铺' },
  'pane.reflow':     { mac: 'alt+cmd+R',       ...pc('ctrl+shift+alt+R'), label: '整理当前标签分屏' },
  'session.reconnect': { mac: 'cmd+shift+R',   ...pc('ctrl+shift+R'),     label: '重连当前会话' },
  'session.readonly': { mac: 'cmd+shift+L',    ...pc('ctrl+shift+L'),     label: '只读模式' },
  'session.log':     { mac: 'cmd+shift+J',     ...pc('ctrl+shift+J'),     label: '记录会话日志' },
  'session.diagnose': { mac: 'alt+cmd+D',      ...pc('ctrl+shift+alt+D'), label: 'AI 诊断报错' },
  'tools.broadcast': { mac: 'cmd+shift+G',     ...pc('ctrl+shift+G'),     label: '广播输入' },
  'tools.forwards':  { mac: 'alt+cmd+F',       ...pc('ctrl+shift+alt+F'), label: '端口转发' },
  // 以下两项只由 macOS 菜单栏的加速键触发(页面不拦截,模态打开时也可用)
  'window.close':    { mac: 'cmd+shift+W',                                label: '关闭窗口' },
  'app.quit':        { mac: 'cmd+Q',                                      label: '退出' },
};

/// 应用级动作:无论焦点在哪(包括终端内)都归应用处理,由全局分发执行。
/// 由 DEFAULT_KEYMAP 派生,避免"加了键位却忘了加进 APP_ACTIONS"——
/// 那种漏法的表现是快捷键在终端里静默失效(按键被当成转义序列发给 shell)。
/// 两类例外:
///   - 组件内动作:复制/粘贴/全选由所在组件(terminal.js、文件分屏)自己处理,
///     判全集会让全局分发抢在组件前面,选区规则和 SIGINT 分流都会失效;
///   - 仅菜单栏动作:window.close / app.quit 只由 macOS 菜单加速键触发,
///     页面不拦截(⌘Q 必须落到原生菜单,否则弹窗里按 ⌘Q 关不掉应用);
///   - 面板内动作:ai.newThread 只在焦点位于 AI 面板时生效(见 entry.js 的
///     专用分支),菜单项也刻意不带加速键,不在全局分发里抢按键。
const COMPONENT_ACTIONS = ['term.copy', 'term.paste', 'term.selectAll', 'files.selectAll'];
const MENU_ONLY_ACTIONS = ['window.close', 'app.quit'];
const PANEL_SCOPED_ACTIONS = ['ai.newThread', 'ai.cycleEffort'];
export const APP_ACTIONS = Object.keys(DEFAULT_KEYMAP)
  .filter((id) => !COMPONENT_ACTIONS.includes(id) && !MENU_ONLY_ACTIONS.includes(id)
    && !PANEL_SCOPED_ACTIONS.includes(id));

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
/// 没有默认键位的命令同样可以自定义(设置页允许给任意命令配键)。
function resolveBindings(actionId) {
  const def = DEFAULT_KEYMAP[actionId];
  const custom = state.settings && state.settings.keybindings && state.settings.keybindings[actionId];
  const customList = (Array.isArray(custom) ? custom : [custom])
    .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  if (customList.length) return customList.map(parseSpec).filter(Boolean);
  return def ? defaultSpecs(def).map(parseSpec).filter(Boolean) : [];
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

/// 内置默认键位(忽略自定义)。设置页用它显示"默认是什么"、判断某项是否被改过。
export function defaultSpecsOf(actionId) {
  const def = DEFAULT_KEYMAP[actionId];
  return def ? defaultSpecs(def) : [];
}

/// 数字键 1-9 的序号;非数字键返回 0。优先认物理键位(event.code),
/// Shift 或非拉丁布局下 event.key 不再是数字。
export function digitOf(event) {
  const m = /^Digit([1-9])$/.exec(event.code || '') || /^([1-9])$/.exec(event.key || '');
  return m ? Number(m[1]) : 0;
}

function keyMatches(b, event) {
  if (b.key === '1..9') return digitOf(event) > 0;
  // 与录制器共用同一套"键是谁"的判定:优先物理键位(event.code),这样
  // Shift 组合、⌥ 变音字符与功能键/命名键(space、pageup…)都能对上。
  const key = physicalKey(event);
  if (key) return key === b.key;
  return String(event.key || '').toLowerCase() === b.key;
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

/// 某动作是否由全局分发处理(不是组件内动作、不是仅菜单栏动作)。
const isGlobalAction = (id) => !COMPONENT_ACTIONS.includes(id) && !MENU_ONLY_ACTIONS.includes(id)
  && !PANEL_SCOPED_ACTIONS.includes(id);

/// 命中的应用级动作名,未命中返回 ''。终端的自定义按键处理据此把按键
/// 让给全局分发;全局分发据此先 preventDefault 再判断能否执行。
/// 遍历范围比 APP_ACTIONS 略宽:用户给没有默认键位的命令配了键时,那条
/// 自定义键也应该由全局分发接管(否则按键会被终端吃掉)。
export function appShortcutOf(event) {
  if (!event || event.isComposing) return '';
  const custom = (state.settings && state.settings.keybindings) || null;
  const extra = custom
    ? Object.keys(custom).filter((id) => !DEFAULT_KEYMAP[id] && isGlobalAction(id))
    : [];
  return [...APP_ACTIONS, ...extra].find((id) => matchAction(id, event)) || '';
}

/// 按键/键位 spec 的归一化签名,供冲突检测使用。
/// 修饰键顺序无关('shift+cmd+t' 与 'cmd+shift+t' 同键),键名统一小写,
/// 非拉丁布局下键入的字符按 event.code 折算回物理键。
export function bindingSignature(specOrEvent) {
  if (specOrEvent && typeof specOrEvent === 'object') {
    const b = parseEvent(specOrEvent);
    return b ? signatureOf(b) : '';
  }
  const b = parseSpec(String(specOrEvent || ''));
  return b ? signatureOf(b) : '';
}

/// 由 KeyboardEvent 反推 spec 写法(录制用)。纯修饰键按下返回 ''。
export function specOfEvent(event) {
  const b = parseEvent(event);
  return b ? specFromParts(b) : '';
}

function parseEvent(event) {
  const key = physicalKey(event);
  if (!key) return null;
  return { meta: !!event.metaKey, ctrl: !!event.ctrlKey, alt: !!event.altKey, shift: !!event.shiftKey, key };
}

/// 键盘事件的"键是谁":优先物理键位(event.code),这样 Shift/Alt 组合与
/// 非拉丁布局下都稳定;功能键与命名键也从 code 取。
function physicalKey(event) {
  const code = String(event.code || '');
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  const d = /^Digit([0-9])$/.exec(code);
  if (d) return d[1];
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (f) return 'f' + f[1];
  const named = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Backquote: '`', Space: 'space',
    Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace',
    Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert' }[code];
  if (named) return named;
  // 没有 code(如合成事件)时退回 event.key,但纯修饰键不算
  const raw = String(event.key || '').toLowerCase();
  if (!raw || ['shift', 'control', 'meta', 'alt', 'altgraph', 'capslock'].includes(raw)) return '';
  return raw;
}

function signatureOf(b) {
  const mods = [b.meta && 'cmd', b.ctrl && 'ctrl', b.alt && 'alt', b.shift && 'shift'].filter(Boolean).sort();
  return [...mods, b.key].join('+');
}

function specFromParts(b) {
  const mods = [b.meta && 'cmd', b.ctrl && 'ctrl', b.alt && 'alt', b.shift && 'shift'].filter(Boolean);
  return [...mods, b.key].join('+');
}

/// 动作的平台化显示文案:'⌘⇧↵' / 'Ctrl+Shift+Enter'(多键位取第一个)。
/// 直接复用 core.accel,符号表只有 core.js 一份。
export function accelOf(actionId) {
  return accel(specOf(actionId));
}

const ACCEL_KEY = { ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '[': 'BracketLeft',
  ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace',
  delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right' };

/// keymap spec → Tauri(muda)菜单加速键:'cmd+shift+P' → 'CmdOrCtrl+Shift+P'。
/// 功能键(F2…F24)按原样透传,muda 用同名键名;范围写法(1..9)和无法
/// 表达的 spec 返回 ''(菜单项不带加速键)。
export function toAccelerator(spec) {
  const parts = String(spec || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  // 修饰键按 spec 里写的顺序输出(muda 解析不区分顺序,保持既有约定)。
  const mods = [];
  let key = '';
  for (const part of parts) {
    const k = part.toLowerCase();
    if (k === 'cmd' || k === 'meta' || k === 'mod') mods.push('CmdOrCtrl');
    else if (k === 'ctrl') mods.push('Ctrl');
    else if (k === 'alt') mods.push('Alt');
    else if (k === 'shift') mods.push('Shift');
    else key = part;
  }
  if (!key || key.includes('..')) return '';
  const named = ACCEL_KEY[key.toLowerCase()];
  if (named) key = named;
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else if (key.length === 1) key = key.toUpperCase();
  else return '';
  return [...mods, key].join('+');
}

/// 提示统一入口:参数是动作名则查 keymap(自定义键位生效),否则按裸 spec
/// 渲染。data-accel 的取值两者皆可,新增提示一律优先写动作名。
export function accelSpec(actionOrSpec) {
  const name = String(actionOrSpec || '').trim();
  if (DEFAULT_KEYMAP[name]) return accelOf(name);
  return accel(name);
}

// ===== 自定义键位的校验与补丁生成(纯函数,设置页与单测共用) =====

/// 某份覆盖表里每个动作"实际生效"的 spec:覆盖值非空则用覆盖值,否则用默认。
/// 空数组表示"恢复默认",跟没有覆盖项等价。
function effectiveSpecs(overrides, id) {
  const custom = overrides && overrides[id];
  const list = (Array.isArray(custom) ? custom : custom ? [custom] : [])
    .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  return list.length ? list : defaultSpecsOf(id);
}

/// 冲突检测:返回 [{ id, spec, conflictWith }],同一键位被两个动作占用时,
/// 后一个动作永远收不到按键(appShortcutOf 只取第一个命中),必须拦住。
/// 键位比较走 bindingSignature,修饰键顺序无关。
///
/// 按作用域分组比较:终端内的 ⌘A(全选终端)与文件分屏的 ⌘A(全选文件)
/// 只在自己获得焦点时生效,互不遮挡;面板内的动作同理。只有同一作用域内
/// 的重复键位才是真冲突。
export function findKeyConflicts(overrides) {
  // scope → 该作用域内 签名 → 动作
  const owners = new Map();
  const issues = [];
  const ids = new Set([...Object.keys(DEFAULT_KEYMAP), ...Object.keys(overrides || {})]);
  for (const id of ids) {
    const scope = bindingScope(id);
    if (!owners.has(scope)) owners.set(scope, new Map());
    const owner = owners.get(scope);
    for (const spec of effectiveSpecs(overrides, id)) {
      const sig = bindingSignature(spec);
      if (!sig) continue;
      if (owner.has(sig)) issues.push({ id, spec, conflictWith: owner.get(sig) });
      else owner.set(sig, id);
    }
  }
  return issues;
}

/// 键位的作用域。组件内动作各自独立(焦点决定谁生效),其余共用一个
/// 全局命名空间。
export function bindingScope(id) {
  if (COMPONENT_ACTIONS.includes(id)) {
    if (id.startsWith('term.')) return 'terminal';
    if (id.startsWith('files.')) return 'files';
    return 'component';
  }
  if (PANEL_SCOPED_ACTIONS.includes(id)) return 'panel';
  return 'global';
}

/// 两组键位是否等价(大小写、修饰键顺序都不影响:默认表写 'cmd+T',
/// 录制出来的是 'cmd+shift+t')。
function sameSpecs(a, b) {
  const norm = (list) => list.map((s) => bindingSignature(s)).sort().join('\u0000');
  return norm(a) === norm(b);
}

/// 由"已保存的覆盖表 + 本次编辑"生成保存补丁(按项合并语义):
/// 改成非默认值 → 写入键位数组;改回默认 → 写 null 删掉覆盖项。
/// 顺带清理"已保存但与默认相同"的历史项,保持存储干净。
export function keybindingsPatchOf(saved, edited) {
  const patch = {};
  for (const [id, value] of Object.entries(edited || {})) {
    const specs = effectiveSpecs({ [id]: value }, id);
    patch[id] = sameSpecs(specs, defaultSpecsOf(id)) ? null : specs;
  }
  for (const [id, specs] of Object.entries(saved || {})) {
    if (id in patch) continue;
    if (sameSpecs(effectiveSpecs({ [id]: specs }, id), defaultSpecsOf(id))) patch[id] = null;
  }
  return patch;
}

/// 覆盖表是否包含任何非默认项(设置页据此判断能否"恢复全部默认")。
export function hasCustomBindings(overrides) {
  return Object.entries(overrides || {}).some(([id, value]) => {
    const specs = effectiveSpecs({ [id]: value }, id);
    return specs.length > 0 && !sameSpecs(specs, defaultSpecsOf(id));
  });
}
