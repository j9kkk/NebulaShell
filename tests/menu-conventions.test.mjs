// 菜单命名 / 省略号 / 快捷键展示的回归测试(守 docs/menu-conventions.md)。
//
// 防回归对象(审计 P0/P1 的复发路径):
//   - 名称第二份拷贝:菜单 spec 的 text、commandMenuItem 的 label 覆盖、HTML title
//   - 省略号:标签里手写「…」、dialog 动作漏「…」、canonical 泄漏到命令面板/设置页
//   - 快捷键:显示键位与实际绑定脱节、两个动作占同一键位、原生菜单加速键被静默丢弃
//
// 断言对象是**真实注册的命令**(在 vm 里执行 entry.js 的 setupWorkspaceCommands),
// 不是源码文本快照。改文案/改键位必须先改规范表,否则这里失败。

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------- DOM 桩

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.className = [...set].join(' '); }
  contains(name) { return this._set().has(name); }
  add(...names) { const s = this._set(); names.forEach((n) => s.add(n)); this._write(s); }
  remove(...names) { const s = this._set(); names.forEach((n) => s.delete(n)); this._write(s); }
  toggle(name, force) { const on = force ?? !this.contains(name); if (on) this.add(name); else this.remove(name); return on; }
}

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.dataset = {};
    this.attributes = new Map(); this.style = {}; this.className = ''; this._text = '';
    this.addEventListener = () => {}; this.removeEventListener = () => {};
    this.classList = new ClassList(this);
  }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    else this.attributes.set(name, String(value));
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  contains() { return false; }
  focus() {}
  get isConnected() { return false; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text; }
}

class DocumentStub {
  constructor() {
    this.body = new Element('body'); this.activeElement = this.body;
    this.listeners = new Map();
  }
  createElement(tag) { return new Element(tag); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getElementById() { return null; }
  addEventListener(type) { if (!this.listeners.has(type)) this.listeners.set(type, []); }
  dispatchEvent(event) { (this.listeners.get(event?.type) || []).forEach((fn) => fn(event)); return true; }
}

// ---------------------------------------------------------------- 规范表

// 规范表的可执行副本与渲染验收脚本共用(tests/menu-conventions.data.mjs)。
import { CONVENTIONS, DYNAMIC, INTERNAL, ACCEL } from './menu-conventions.data.mjs';

// ---------------------------------------------------------------- 装载真实模块

const PLATFORM_ARG = { mac: 'darwin', win: 'windows', linux: 'linux' };
const PLATFORM_INDEX = { mac: 0, win: 1, linux: 2 };

async function loadModules(platform = 'darwin') {
  const document = new DocumentStub();
  const window = { nebula: { platform }, innerWidth: 1200, innerHeight: 800 };
  const EventStub = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  const context = vm.createContext({
    console, document, window, navigator: { userAgent: '' }, performance,
    Event: EventStub, CustomEvent: EventStub, KeyboardEvent: EventStub, MouseEvent: EventStub,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  });
  const cache = new Map();
  const load = async (name) => {
    const file = name.startsWith('../') ? name.replace('../', '../src/') : `../src/modules/${name}`;
    if (!cache.has(name)) cache.set(name, new vm.SourceTextModule(
      await readFile(new URL(file, import.meta.url), 'utf8'), { context, identifier: name },
    ));
    return cache.get(name);
  };
  const linker = (specifier) => load(specifier.startsWith('../') ? specifier : specifier.replace('./', ''));
  for (const name of ['core.js', 'commands.js', 'keymap.js']) {
    const mod = await load(name);
    // commands.js 已经带起 keymap.js:同一模块不能再 link 一次
    if (mod.status !== 'unlinked') continue;
    await mod.link(linker);
    await mod.evaluate();
  }
  const menuSpec = await import('../src/shared/menu-spec.js');
  return {
    document,
    window,
    context,
    core: cache.get('core.js').namespace,
    commands: cache.get('commands.js').namespace,
    keymap: cache.get('keymap.js').namespace,
    menuSpec,
  };
}

// 在 vm 里执行 entry.js 的 setupWorkspaceCommands():注册表是真实代码注册的,
// 不是从源码里抠字符串。其余 import 绑定给惰性桩(enabled/run 不会被调用)。
async function loadRegistry(platform = 'darwin') {
  const env = await loadModules(platform);
  const { context, core, commands, document } = env;
  const entrySource = await readFile(new URL('../src/modules/entry.js', import.meta.url), 'utf8');
  const wiring = entrySource.match(/^function setupWorkspaceCommands\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(wiring, 'entry.js 里找不到 setupWorkspaceCommands()');

  const stub = () => undefined;
  const imported = new Set();
  for (const line of entrySource.matchAll(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]/gm)) {
    if (line[1]) {
      for (const part of line[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) imported.add(name);
      }
    } else if (line[2]) imported.add(line[2]);
  }
  const adapters = {
    registerCommand: commands.registerCommand,
    state: core.state,
    activeTab: () => null,
    focusedPaneId: () => null,
    leafCount: stub,
    paneOwner: () => null,
    uiPrefs: () => ({ hostDensity: 'comfortable', favoriteHostIds: [], collapsedGroups: [] }),
    $: () => new Element('div'),
    document,
    refreshCommandStates: commands.refreshCommandStates,
    bindCommandButtons: commands.bindCommandButtons,
  };
  for (const [name, value] of Object.entries(adapters)) context[name] = value;
  for (const name of imported) if (!(name in adapters)) context[name] = stub;
  // entry.js 自己的顶层函数(如 openAbout)也按名字解析:注册表里 `run: openAbout`
  // 是立即求值的,缺了就会 ReferenceError;实现体不在本次断言范围内。
  const locals = new Set([
    ...[...entrySource.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)].map((m) => m[1]),
    ...[...entrySource.matchAll(/^(?:export )?const (\w+) =/gm)].map((m) => m[1]),
  ]);
  for (const name of locals) if (!(name in context) && !(name in adapters)) context[name] = stub;

  // 3 条 internal 别名注册在 setupWorkspaceCommands 之外(模块顶层),一并执行
  const aliases = entrySource.match(/^registerCommand\('panel\.[^\n]*$/gm) || [];
  assert.equal(aliases.length, 3, 'entry.js 顶层的 internal 别名应有 3 条');
  vm.runInContext(`${wiring}\n${aliases.join('\n')}\nsetupWorkspaceCommands();`, context);
  return env;
}

const ids = (obj) => Object.keys(obj).sort();

// 键位 spec → 合成事件(用真实 event.code,匹配逻辑优先物理键位)
function eventOf(spec) {
  const parts = String(spec).split('+').map((s) => s.trim()).filter(Boolean);
  const event = { key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };
  const named = { enter: ['Enter', 'Enter'], esc: ['Escape', 'Escape'], tab: ['Tab', 'Tab'], space: [' ', 'Space'],
    up: ['ArrowUp', 'ArrowUp'], down: ['ArrowDown', 'ArrowDown'], left: ['ArrowLeft', 'ArrowLeft'], right: ['ArrowRight', 'ArrowRight'] };
  for (const part of parts) {
    const k = part.toLowerCase();
    if (k === 'cmd' || k === 'meta') event.metaKey = true;
    else if (k === 'ctrl') event.ctrlKey = true;
    else if (k === 'alt') event.altKey = true;
    else if (k === 'shift') event.shiftKey = true;
    else if (k === '1..9') { event.key = '3'; event.code = 'Digit3'; }
    else if (named[k]) [event.key, event.code] = named[k];
    else if (/^f\d+$/.test(k)) { event.key = k.toUpperCase(); event.code = k.toUpperCase(); }
    else if (k.length === 1) { event.key = k; event.code = /[0-9]/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`; }
    else { event.key = k; event.code = k; }
  }
  return event;
}

// ---------------------------------------------------------------- 1. 改名表

test('canonical 文案与规范 §6.1 改名表逐字一致,且 46 条命令全部注册', async () => {
  const { commands } = await loadRegistry();
  const listed = commands.listCommands();
  const actual = [...listed].map((c) => c.id).sort();
  assert.deepEqual(actual, ids(CONVENTIONS).filter((id) => !INTERNAL.includes(id)),
    '注册命令集合与规范表不一致(新增/删除命令必须同步规范)');
  for (const [id, [label]] of Object.entries(CONVENTIONS)) {
    assert.equal(commands.commandState(id).label, label, `${id} 的 canonical 文案偏离 §6.1`);
  }
  // 动态文案只允许白名单里的变体,且无 ctx 时必须回落 canonical
  for (const [id, variants] of Object.entries(DYNAMIC)) {
    const label = commands.commandState(id).label;
    assert.ok(variants.includes(label), `${id} 的动态文案「${label}」不在 N5 白名单`);
  }
});

test('keymap 的 label 与注册表逐字相同(N4:同一动作只有一个名字)', async () => {
  const { commands, keymap } = await loadRegistry();
  let compared = 0;
  for (const [action, def] of Object.entries(keymap.DEFAULT_KEYMAP)) {
    if (!CONVENTIONS[action]) continue; // tab.switch / files.selectAll 只作键位,不是命令
    const expected = DYNAMIC[action] ? null : CONVENTIONS[action][0];
    if (expected === null) {
      assert.ok(DYNAMIC[action].includes(def.label), `${action} 的 keymap label 不在 N5 白名单`);
    } else {
      assert.equal(def.label, expected, `${action} 的 keymap label 与注册表/规范不一致`);
    }
    assert.equal(def.label, commands.commandState(action).label, `${action} 的 keymap label 必须等于 canonical`);
    compared++;
  }
  assert.ok(compared >= 30, `只比对了 ${compared} 个动作,疑似装配失败`);
});

// ---------------------------------------------------------------- 2. 省略号

test('标签源码里没有省略号:canonical 不含「…」也不含「...」(E1/I3)', async () => {
  const { commands } = await loadRegistry();
  for (const command of commands.listCommands()) {
    assert.equal(command.label.includes('…'), false, `${command.id} 的 canonical 文案手写了「…」`);
    assert.equal(command.label.includes('...'), false, `${command.id} 的 canonical 文案用了三个点`);
    assert.equal(/\s$/.test(command.label), false, `${command.id} 的 canonical 文案以空格结尾`);
  }
});

test('菜单文案:要用户输入/选择的动作带且只带一个「…」,其余没有(E2/E4/E7)', async () => {
  const { commands } = await loadRegistry();
  for (const command of commands.listCommands()) {
    const menu = commands.menuLabelOf(command.id);
    const bare = commands.commandState(command.id).label;
    const asks = CONVENTIONS[command.id][1];
    if (asks) {
      assert.equal(menu, `${bare}…`, `${command.id} 打开对话框/要输入,菜单文案必须以单个 U+2026 结尾`);
    } else {
      assert.equal(menu, bare, `${command.id} 不是对话类动作,菜单文案不得带「…」`);
    }
    assert.ok((menu.match(/…/g) || []).length <= 1, `${command.id} 出现多个省略号`);
    assert.equal(menu.includes('...'), false, `${command.id} 的菜单文案出现三个点`);
    // 「…」只能来自渲染层:命令面板/设置页取裸文案(P0-5)
    assert.equal(bare.includes('…'), false, `${command.id} 的 canonical 泄漏了「…」到命令面板/设置页`);
  }
});

test('kind 与实际行为一致:dialog 全部带「…」,唯一随状态变的是广播(P0-2/E4)', async () => {
  const { commands } = await loadRegistry();
  const listed = commands.listCommands();
  const dialogs = [...listed].filter((c) => c.kind === 'dialog').map((c) => c.id).sort();
  const expected = ids(CONVENTIONS).filter((id) => CONVENTIONS[id][1] && !INTERNAL.includes(id) && id !== 'tools.broadcast');
  assert.deepEqual(dialogs, expected, 'kind: dialog 的集合与规范 E7「带 … 」集合不一致');
  // asks 随上下文变化的只有 tools.broadcast(广播中变「停止广播」且不带 …)
  for (const command of listed) {
    if (command.kind !== 'dialog' && CONVENTIONS[command.id][1]) {
      assert.equal(command.id, 'tools.broadcast', `${command.id} 不是 dialog 却要输入,必须显式声明并写进规范`);
    }
  }
});

// ---------------------------------------------------------------- 3. 快捷键

test('每个平台的快捷键显示与规范 §7.1 逐字一致(S2/S9/S3)', async () => {
  for (const [platform, index] of Object.entries({ mac: 0, win: 1, linux: 2 })) {
    const { keymap } = await loadModules(PLATFORM_ARG[platform]);
    for (const [action, expected] of Object.entries(ACCEL)) {
      assert.equal(keymap.accelOf(action), expected[index], `${platform} 平台 ${action} 的键位显示偏离 §7.1`);
    }
  }
});

test('显示了就必须真绑得上:每个主键位的事件都能命中该动作(S6)', async () => {
  for (const [platform, index] of Object.entries({ mac: 0, win: 1, linux: 2 })) {
    const { keymap } = await loadModules(PLATFORM_ARG[platform]);
    for (const [action, expected] of Object.entries(ACCEL)) {
      if (!expected[index]) continue; // 平台无此键(S7)
      const spec = keymap.specOf(action);
      assert.ok(spec, `${platform} ${action} 显示了键位却没有绑定`);
      assert.equal(keymap.matchAction(action, eventOf(spec)), true, `${platform} ${action} 显示的键位触发不了自己`);
      // 第二键位也必须能触发(只有一个时就是主键位)
      for (const extra of keymap.specsOf(action)) {
        assert.equal(keymap.matchAction(action, eventOf(extra)), true, `${platform} ${action} 的键位 ${extra} 绑不上`);
      }
    }
  }
});

test('同一平台不得有两个命令占同一快捷键(仅 ⌘A 的终端/文件作用域豁免)(S5)', async () => {
  for (const [platform, index] of Object.entries({ mac: 0, win: 1, linux: 2 })) {
    const { keymap } = await loadModules(PLATFORM_ARG[platform]);
    const owners = new Map();
    for (const [action, expected] of Object.entries(ACCEL)) {
      const shown = keymap.accelOf(action);
      assert.equal(shown, expected[index]);
      if (!shown) continue;
      if (!owners.has(shown)) owners.set(shown, []);
      owners.get(shown).push(action);
    }
    const dupes = [...owners.entries()].filter(([, list]) => list.length > 1);
    const allowed = new Set(['⌘A', 'Ctrl+A']);
    for (const [key, list] of dupes) {
      assert.ok(allowed.has(key), `${platform} ${key} 被多个动作占用:${list.join(' / ')}`);
      assert.deepEqual([...list].sort(), ['files.selectAll', 'term.selectAll'], `${platform} ${key} 的豁免只给终端/文件全选`);
    }
    // ⌘T / Ctrl+Shift+T 只属于 tab.new(P1-4 不允许复发)
    assert.deepEqual(owners.get(platform === 'mac' ? '⌘T' : 'Ctrl+Shift+T'), ['tab.new'], `${platform} ⌘T 必须只属于新建标签`);
  }
});

test('原生菜单加速键:菜单里显示的每个键位都能转成 Tauri accelerator(S7/P1-5)', async () => {
  const { keymap, menuSpec, commands } = await loadRegistry('darwin');
  for (const id of menuSpec.menuCommandIds(menuSpec.specFor('mac'))) {
    const shown = keymap.accelOf(id);
    if (!shown) continue; // 平台无键或未绑键:菜单不显示键位
    const accelerator = keymap.toAccelerator(keymap.specOf(id));
    if (id === 'tab.switch') {
      assert.equal(accelerator, '', '范围键位不进原生菜单加速键(S9),按键由页面分发');
    } else {
      assert.ok(accelerator, `${id} 在菜单里显示 ${shown},但转不成 accelerator(原生菜单会静默丢掉键位)`);
    }
    assert.ok(keymap.specOf(id), `${id} 显示了键位但没有绑定`);
    assert.ok(commands.commandState(id), `${id} 在菜单里但没有注册`);
  }
});

// ---------------------------------------------------------------- 4. 菜单结构

test('菜单栏不存第二份文案:cmd 项无 text/accelerator:false,标签取自注册表(I2/S7)', async () => {
  const { menuSpec, commands } = await loadRegistry();
  for (const platform of ['mac', 'pc']) {
    for (const menu of menuSpec.specFor(platform)) {
      for (const item of menu.items) {
        if (item === menuSpec.SEP) continue;
        if (item.predefined) {
          assert.equal(typeof item.text, 'string', `${platform} 系统预定义项需要显示文本`);
          continue;
        }
        assert.equal('text' in item, false, `${platform} ${menu.submenu} 的 ${item.cmd} 带了第二份文案 text`);
        assert.notEqual(item.accelerator, false, `${platform} ${menu.submenu} 的 ${item.cmd} 用 accelerator:false 隐藏已绑定的键位`);
        assert.ok(commands.commandState(item.cmd), `${platform} ${menu.submenu} 引用了未注册的命令 ${item.cmd}`);
        assert.ok(commands.menuLabelOf(item.cmd), `${item.cmd} 渲染成空文案`);
      }
      // 同一菜单内不得重复出现同一命令(G6 只允许视图/帮助各一次 palette.open)
      const cmds = menu.items.filter((it) => it !== menuSpec.SEP && it.cmd).map((it) => it.cmd);
      const dupes = cmds.filter((id, i) => cmds.indexOf(id) !== i);
      assert.deepEqual(dupes, [], `${platform} ${menu.submenu} 内重复出现:${dupes.join(', ')}`);
    }
  }
  // palette.open 允许两处,文案与键位必须一致(平台惯例)
  const mac = menuSpec.specFor('mac');
  const open = mac.flatMap((m) => m.items.filter((it) => it !== menuSpec.SEP && it.cmd === 'palette.open'));
  assert.equal(open.length, 2, 'macOS 的 palette.open 应在视图与帮助各一次');
  assert.equal(open[0].alias, undefined);
  assert.equal(open[1].alias, 'help');
});

test('index.html 的 data-title / aria-label 等于注册表文案(I6/P2-2)', async () => {
  const { commands } = await loadRegistry();
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  for (const tag of html.match(/<[^>]*data-accel="[^"]*"[^>]*>/g) || []) {
    const accel = tag.match(/data-accel="([^"]+)"/)[1].split('|').map((s) => s.trim());
    const title = tag.match(/data-title="([^"]+)"/)?.[1];
    const aria = tag.match(/aria-label="([^"]+)"/)?.[1];
    // 只校验「一个槽位对应一个动作名」的按钮;多槽位(如复制/粘贴并列)不在此列
    if (accel.length !== 1 || !CONVENTIONS[accel[0]]) continue;
    const canonical = commands.commandState(accel[0]).label;
    if (title) {
      assert.equal(title.replace(/\s*\(%1\)$/, ''), canonical, `${accel[0]} 的 data-title 与 canonical 不一致`);
      assert.equal((title.match(/\(%1\)/g) || []).length, 1, `${accel[0]} 的 data-title 只能有一个键位占位符(N2 双括号)`);
    }
    if (aria) assert.equal(aria, canonical, `${accel[0]} 的 aria-label 与 canonical 不一致`);
  }
});

// ---------------------------------------------------------------- 5. 右键 / 下拉 / AI 面板的静态项

// 这些静态项不在命令注册表里(它们不是命令),省略号只能手写在标签上,
// 所以单独扫一遍源码:三个点一律禁止,「…」只允许单个且在结尾。
const STATIC_DIALOGS = ['新建文件夹', '重命名', '权限', '管理书签', '下载', '复制到', '重命名分组', '新建分组并移入', '编辑主机', '全部书签('];
const STATIC_PLAIN = ['全选文件', '反选', '复制名称', '复制完整路径', '删除文件', '删除目录', '全不选', '前进', '打开目录'];

test('静态菜单项:没有三个点,「…」只在结尾且只有一个(E1/N6)', async () => {
  const files = (await import('node:fs/promises')).readdir;
  const dir = new URL('../src/modules/', import.meta.url);
  const labels = [];
  const seen = new Set();
  // 直接写法 `label: 'x'` / `label: `x``,以及三元里的 `label: cond ? `x…` : 'y…'`
  const PATTERNS = [/label:\s*'([^']*)'/g, /label:\s*`([^`]*)`/g, /label:[^,\n]*?'([^']*)'/g, /label:[^,\n]*?`([^`]*)`/g];
  for (const name of await files(dir)) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(new URL(name, dir), 'utf8');
    for (const pattern of PATTERNS) {
      for (const m of source.matchAll(pattern)) {
        if (seen.has(`${name}\u0000${m[1]}`)) continue;
        seen.add(`${name}\u0000${m[1]}`);
        labels.push([name, m[1]]);
      }
    }
  }
  assert.ok(labels.length > 40, `只找到 ${labels.length} 个静态 label,扫描规则可能失效`);
  // 模板字符串里的 ${...} 是代码(可能含展开运算符),只看字面文案
  const literalOf = (label) => label.replace(/\$\{[^}]*\}/g, '');
  for (const [file, label] of labels) {
    const literal = literalOf(label);
    assert.equal(literal.includes('...'), false, `${file} 的静态项「${label}」用了三个点`);
    const marks = (literal.match(/…/g) || []).length;
    assert.ok(marks <= 1, `${file} 的静态项「${label}」出现多个省略号`);
    if (marks === 1) assert.ok(literal.endsWith('…'), `${file} 的静态项「${label}」的省略号必须在结尾(N6)`);
  }
  const text = labels.map(([, label]) => literalOf(label)).join('\n');
  for (const name of STATIC_DIALOGS) {
    assert.match(text, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*…`),
      `「${name}」要用户输入/选择,静态菜单项必须以「…」结尾(E2)`);
  }
  for (const name of STATIC_PLAIN) {
    const hit = labels.find(([, label]) => label.startsWith(name));
    if (hit) assert.equal(hit[1].includes('…'), false, `「${hit[1]}」立即执行,不带「…」(E3)`);
  }
});

test('HTML 里的菜单项与分组标题:文案无三个点,分组标题不带「…」(E6/I6)', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  for (const m of html.matchAll(/<[^>]*role="menuitem[^"]*"[^>]*>([^<]*)</g)) {
    assert.equal(m[1].includes('...'), false, `菜单项「${m[1]}」用了三个点`);
    assert.ok((m[1].match(/…/g) || []).length <= 1, `菜单项「${m[1]}」出现多个省略号`);
  }
  for (const m of html.matchAll(/<[^>]*role="menu"[^>]*aria-label="([^"]+)"/g)) {
    assert.equal(m[1].includes('…'), false, `分组标题「${m[1]}」不带省略号(E6)`);
  }
  assert.match(html, /id="ai-model-manage"[^>]*>管理模型…</, '「管理模型」点开进设置改配置,必须带「…」(E2-c)');
});
