// keymap 单一事实源 + 平台提示防回归测试。
//
// 防回归背景:统一入口 data-accel/accel() 只覆盖 tooltip 和菜单,新组件若
// 绕过它直接写死 ⌘ 文案,Windows 上就会重现"提示显示 mac 键位"的旧 bug
// (sftp.js 工具栏提示/右键菜单曾两度如此)。这里两层防线:
// 1) keymap 的匹配与渲染在三个平台下行为正确;
// 2) 源代码静态扫描:除 core.js 的 mac 符号表/keymap.js 外,任何 UI 文案
//    (模板字符串、HTML)出现 ⌘ 即失败。

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// ---- 轻量 DOM/窗口桩(与 interaction-ux.test.mjs 同思路,只取需要的子集) ----

class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag; this.children = [];
    this._attrs = new Map();
    this.dataset = new Proxy({}, {
      get: (_, k) => this._attrs.get('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())),
      set: (_, k, v) => { this._attrs.set('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v); return true; },
    });
    this.style = {}; this.parentNode = null; this.isConnected = false;
    this.classList = { add: () => {}, remove: () => {}, contains: () => true, toggle: () => {} };
  }
  setAttribute(k, v) { this._attrs.set(k, v); if (k === 'id') this.id = v; }
  getAttribute(k) { return this._attrs.get(k); }
  appendChild(c) { c.parentNode = this; c.isConnected = this.isConnected || this === this.ownerDocument.body; this.children.push(c); this.ownerDocument.notifyMutation(c, 'childList', [c], []); return c; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (match(sel, c)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function match(sel, el) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return String(el.className || '').split(/\s+/).includes(sel.slice(1));
  if (sel.includes('[')) {
    const m = sel.match(/^([a-z]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (m) {
      const tag = m[1], attr = m[2], val = m[3];
      const has = val === undefined ? el._attrs.has(attr) || el.dataset[attr.replace(/([A-Z])/g, '-$1').toLowerCase()] !== undefined || el.dataset[attr] !== undefined : true;
      return (!tag || el.tagName === tag) && has;
    }
  }
  return el.tagName === sel;
}

class DocumentAdapter extends Element {
  constructor() { super(null, '#document'); this.ownerDocument = this; this.body = new Element(this, 'body'); this.body.isConnected = true; this.children = [this.body]; }
  createElement(tag) { return new Element(this, tag); }
  notifyMutation() {}
}

async function setup(platform, settings = {}) {
  const document = new DocumentAdapter();
  const window = { nebula: { platform }, innerWidth: 800, innerHeight: 600 };
  const context = vm.createContext({ console, document, window, navigator: { userAgent: '' } });
  const cache = new Map();
  const load = async (name) => {
    // '../shared/...' 相对 src/modules 解析;其余按 modules/ 内相对名
    const file = name.startsWith('../') ? name.replace('../', '../src/') : `../src/modules/${name}`;
    if (!cache.has(name)) cache.set(name, new vm.SourceTextModule(
      await readFile(new URL(file, import.meta.url), 'utf8'), { context, identifier: name },
    ));
    return cache.get(name);
  };
  const coreMod = await load('core.js');
  await coreMod.link((s) => load(s.startsWith('../') ? s : s.replace('./', '')));
  await coreMod.evaluate();
  const keymapMod = await load('keymap.js');
  await keymapMod.link((s) => load(s.startsWith('../') ? s : s.replace('./', '')));
  await keymapMod.evaluate();
  const core = coreMod.namespace;
  const keymap = keymapMod.namespace;
  core.state.settings = settings;
  return { core, keymap, document };
}

const evt = (key, init = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });

const APP_KEY = { darwin: { metaKey: true }, windows: { ctrlKey: true, shiftKey: true }, linux: { ctrlKey: true, shiftKey: true } };

test('应用快捷键:macOS 用 ⌘,Windows/Linux 用 Ctrl+Shift+同字母', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { keymap } = await setup(platform);
    const mods = APP_KEY[platform];
    for (const [action, key] of [['tab.new', 't'], ['workspace.close', 'w'], ['session.search', 'f'], ['pane.split', 'd']]) {
      assert.equal(keymap.matchAction(action, evt(key.toUpperCase(), { ...mods, code: 'Key' + key.toUpperCase() })), true, `${platform} ${action}`);
      assert.equal(keymap.appShortcutOf(evt(key, mods)), action, `${platform} appShortcutOf ${action}`);
    }
    // 无修饰键不命中
    assert.equal(keymap.matchAction('tab.new', evt('t')), false, platform);
  }
});

test('Ctrl+字母属于 shell:Windows/Linux 的 Ctrl+T/W/F/D 与 macOS 的任何 Ctrl 组合都不是应用快捷键', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { keymap } = await setup(platform);
    for (const key of ['t', 'w', 'f', 'd', 'c', 'v', 'a']) {
      assert.equal(keymap.appShortcutOf(evt(key, { ctrlKey: true })), '', `${platform} Ctrl+${key}`);
    }
  }
  const { keymap } = await setup('darwin');
  assert.equal(keymap.appShortcutOf(evt('t', { ctrlKey: true, metaKey: true })), '', 'mac ⌃⌘T 不是 ⌘T');
  assert.equal(keymap.matchAction('term.paste', evt('v', { ctrlKey: true })), false, 'mac Ctrl+V 交给 shell');
  assert.equal(keymap.matchAction('term.copy', evt('c', { ctrlKey: true })), false, 'mac Ctrl+C 一律 SIGINT');
});

test('修饰键精确匹配:多按 Shift/Alt 不命中', async () => {
  const { keymap } = await setup('darwin');
  assert.equal(keymap.matchAction('pane.zoom', evt('Enter', { metaKey: true, shiftKey: true })), true);
  assert.equal(keymap.matchAction('pane.zoom', evt('Enter', { metaKey: true })), false);
  assert.equal(keymap.matchAction('tab.new', evt('t', { metaKey: true, altKey: true })), false);
  const win = await setup('windows');
  assert.equal(win.keymap.matchAction('pane.zoom', evt('Enter', { ctrlKey: true, shiftKey: true })), true);
  assert.equal(win.keymap.appShortcutOf(evt('Enter', { ctrlKey: true, shiftKey: true })), 'pane.zoom');
  assert.equal(win.keymap.appShortcutOf(evt('t', { ctrlKey: true, shiftKey: true, altKey: true })), '');
});

test('切换标签:⌘1..9 / Ctrl+1..9,按物理键位取序号', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { keymap } = await setup(platform);
    const mod = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };
    for (let n = 1; n <= 9; n++) {
      const e = evt(String(n), { ...mod, code: 'Digit' + n });
      assert.equal(keymap.appShortcutOf(e), 'tab.switch', `${platform} ${n}`);
      assert.equal(keymap.digitOf(e), n);
    }
    assert.equal(keymap.appShortcutOf(evt('0', { ...mod, code: 'Digit0' })), '', platform);
  }
});

test('非拉丁布局:event.key 不是字母时按 event.code 命中', async () => {
  const { keymap } = await setup('windows');
  assert.equal(keymap.appShortcutOf(evt('Е', { ctrlKey: true, shiftKey: true, code: 'KeyT' })), 'tab.new');
});

test('复制/粘贴/全选按平台分流,且不算应用快捷键', async () => {
  const mac = await setup('darwin');
  assert.equal(mac.keymap.matchAction('term.copy', evt('c', { metaKey: true })), true);
  assert.equal(mac.keymap.matchAction('term.paste', evt('v', { metaKey: true })), true);
  assert.equal(mac.keymap.matchAction('term.selectAll', evt('a', { metaKey: true })), true);
  const win = await setup('windows');
  assert.equal(win.keymap.matchAction('term.paste', evt('v', { ctrlKey: true })), true);
  assert.equal(win.keymap.matchAction('term.paste', evt('V', { ctrlKey: true, shiftKey: true })), true);
  assert.equal(win.keymap.matchAction('term.copy', evt('c', { ctrlKey: true })), true);
  assert.equal(win.keymap.matchAction('term.copy', evt('C', { ctrlKey: true, shiftKey: true })), true);
  assert.equal(win.keymap.matchAction('term.selectAll', evt('a', { ctrlKey: true })), false, 'Ctrl+A 是行首');
  assert.equal(win.keymap.matchAction('term.selectAll', evt('A', { ctrlKey: true, shiftKey: true })), true);
  const linux = await setup('linux');
  assert.equal(linux.keymap.matchAction('term.paste', evt('v', { ctrlKey: true })), false, 'Linux Ctrl+V 交给 shell');
  assert.equal(linux.keymap.matchAction('term.paste', evt('V', { ctrlKey: true, shiftKey: true })), true);
  for (const { keymap } of [mac, win, linux]) {
    for (const action of ['term.copy', 'term.paste', 'term.selectAll', 'files.selectAll']) assert.ok(!keymap.APP_ACTIONS.includes(action));
  }
});

test('accelOf renders per platform', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { keymap } = await setup(platform);
    const mac = platform === 'darwin';
    assert.equal(keymap.accelOf('pane.zoom'), mac ? '⌘⇧↵' : 'Ctrl+Shift+Enter', platform);
    assert.equal(keymap.accelOf('tab.new'), mac ? '⌘T' : 'Ctrl+Shift+T', platform);
    assert.equal(keymap.accelOf('workspace.close'), mac ? '⌘W' : 'Ctrl+Shift+W', platform);
    assert.equal(keymap.accelOf('tab.switch'), mac ? '⌘1..9' : 'Ctrl+1..9', platform);
    assert.equal(keymap.accelOf('term.selectAll'), mac ? '⌘A' : 'Ctrl+Shift+A', platform);
    assert.equal(keymap.accelOf('no.such.action'), '', platform);
  }
  assert.equal((await setup('windows')).keymap.accelOf('term.paste'), 'Ctrl+V');
  assert.equal((await setup('linux')).keymap.accelOf('term.paste'), 'Ctrl+Shift+V');
  assert.equal((await setup('linux')).keymap.accelOf('term.copy'), 'Ctrl+Shift+C');
});

test('settings.keybindings overrides defaults; mod 仍可用; invalid entries fall back', async () => {
  const { keymap } = await setup('windows', { keybindings: { 'tab.new': 'mod+Q', 'pane.zoom': '   ', 'pane.split': ['ctrl+alt+D', 'ctrl+shift+E'], unknown: 'mod+Z' } });
  keymap.invalidateKeymapCache();
  assert.equal(keymap.specOf('tab.new'), 'mod+Q');
  assert.equal(keymap.accelOf('tab.new'), 'Ctrl+Q');
  assert.equal(keymap.matchAction('tab.new', evt('q', { ctrlKey: true })), true);
  assert.equal(keymap.matchAction('pane.split', evt('e', { ctrlKey: true, shiftKey: true })), true);
  assert.deepEqual(keymap.specsOf('pane.split'), ['ctrl+alt+D', 'ctrl+shift+E']);
  // 空/非法回落默认
  assert.equal(keymap.specOf('pane.zoom'), 'ctrl+shift+Enter');
  assert.equal(keymap.specOf('workspace.close'), 'ctrl+shift+W');
  const mac = await setup('darwin', { keybindings: { 'tab.new': 'mod+Q' } });
  mac.keymap.invalidateKeymapCache();
  assert.equal(mac.keymap.matchAction('tab.new', evt('q', { metaKey: true })), true);
});

test('applyAccelTitles resolves keymap action names via injected resolver', async () => {
  const { core, keymap, document } = await setup('windows');
  core.applyAccelTitles._accelSpec = keymap.accelSpec;
  const btn = document.createElement('button');
  btn.setAttribute('data-title', '多选(%1)');
  btn.setAttribute('data-accel', 'term.copy');
  document.body.appendChild(btn);
  core.applyAccelTitles(document);
  assert.equal(btn.title, '多选(Ctrl+C)');
});

test('防回归:UI 文案禁止写死 ⌘(core 符号表与 keymap 注释除外)', async () => {
  const files = [
    'src/index.html',
    'src/modules/entry.js', 'src/modules/terminal.js', 'src/modules/sftp.js',
    'src/modules/hosts.js', 'src/modules/settings.js', 'src/modules/keymap.js',
    'src/modules/commands.js', 'src/modules/menubar.js', 'src/modules/monitor.js',
    'src/modules/tools.js', 'src/modules/ai.js', 'src/modules/cloud.js',
    'src/modules/file-transfer.js', 'src/modules/interaction.js',
    'src/modules/palette.js', 'src/modules/native-menu.js', 'src/shared/palette-match.js',
    'src/modules/right-panel.js', 'src/modules/window-controls.js', 'src/shared/menu-spec.js',
  ];
  for (const f of files) {
    const src = (await readFile(new URL(`../${f}`, import.meta.url), 'utf8'))
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, '')) // HTML 注释整体清空(保留行号)
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')); // 块注释整体清空(保留行号)
    for (const [i, line] of src.split('\n').entries()) {
      if (!line.includes('⌘')) continue;
      const noComment = line.replace(/\/\/.*$/, '');
      if (!noComment.includes('⌘')) continue; // 行注释里提及可以
      // keymap.js 的 accelSpec 文档示例与 core.js 的符号表是唯二合法处
      assert.fail(`${f}:${i + 1} UI 文案写死了 ⌘(Windows/Linux 上提示错误),请改走 keymap 动作名/data-accel:${line.trim()}`);
    }
  }
});

test('阶段 1 新快捷键:命令面板 ⇧⌘P / Ctrl+Shift+P,设置 ⌘, / Ctrl+,,清屏只在 macOS 有 ⌘K', async () => {
  const mac = (await setup('darwin')).keymap;
  assert.equal(mac.appShortcutOf(evt('P', { metaKey: true, shiftKey: true, code: 'KeyP' })), 'palette.open');
  assert.equal(mac.appShortcutOf(evt(',', { metaKey: true, code: 'Comma' })), 'settings.open');
  assert.equal(mac.appShortcutOf(evt('k', { metaKey: true, code: 'KeyK' })), 'session.clear');
  assert.equal(mac.appShortcutOf(evt('k', { ctrlKey: true, code: 'KeyK' })), '', 'macOS 的 Ctrl+K 属于 shell(readline 删到行尾)');
  // 退出 / 关窗只由菜单栏加速键触发,页面不拦截
  assert.equal(mac.appShortcutOf(evt('q', { metaKey: true, code: 'KeyQ' })), '');
  assert.equal(mac.appShortcutOf(evt('W', { metaKey: true, shiftKey: true, code: 'KeyW' })), '');
  for (const platform of ['windows', 'linux']) {
    const km = (await setup(platform)).keymap;
    assert.equal(km.appShortcutOf(evt('P', { ctrlKey: true, shiftKey: true, code: 'KeyP' })), 'palette.open', platform);
    assert.equal(km.appShortcutOf(evt(',', { ctrlKey: true, code: 'Comma' })), 'settings.open', platform);
    assert.equal(km.appShortcutOf(evt('k', { ctrlKey: true, code: 'KeyK' })), '', `${platform} Ctrl+K 留给 shell`);
    assert.equal(km.specOf('session.clear'), '', `${platform} 没有清屏快捷键`);
    assert.equal(km.accelOf('palette.open'), 'Ctrl+Shift+P');
  }
  assert.equal(mac.accelOf('palette.open'), '⌘⇧P');
  assert.equal(mac.accelOf('settings.open'), '⌘,');
});

test('0.3.0 面板开关与全屏:⌘B / ⌥⌘B;Ctrl+Shift+B / Ctrl+Shift+Alt+B;F11 只在 Windows/Linux', async () => {
  const mac = (await setup('darwin')).keymap;
  assert.equal(mac.appShortcutOf(evt('b', { metaKey: true, code: 'KeyB' })), 'panel.sidebar');
  // ⌥ 组合在 macOS 上 event.key 是变音字符(∫),按物理键位命中
  assert.equal(mac.appShortcutOf(evt('∫', { metaKey: true, altKey: true, code: 'KeyB' })), 'panel.tools');
  assert.equal(mac.appShortcutOf(evt('b', { ctrlKey: true, code: 'KeyB' })), '', 'macOS 的 Ctrl+B 属于 shell');
  assert.equal(mac.appShortcutOf(evt('F11', { code: 'F11' })), '', 'macOS 用系统的进入全屏');
  assert.equal(mac.accelOf('panel.sidebar'), '⌘B');
  assert.equal(mac.accelOf('panel.tools'), '⌥⌘B');
  assert.equal(mac.toAccelerator(mac.specOf('panel.tools')), 'Alt+CmdOrCtrl+B');
  for (const platform of ['windows', 'linux']) {
    const km = (await setup(platform)).keymap;
    assert.equal(km.appShortcutOf(evt('B', { ctrlKey: true, shiftKey: true, code: 'KeyB' })), 'panel.sidebar', platform);
    assert.equal(km.appShortcutOf(evt('B', { ctrlKey: true, shiftKey: true, altKey: true, code: 'KeyB' })), 'panel.tools', platform);
    assert.equal(km.appShortcutOf(evt('b', { ctrlKey: true, code: 'KeyB' })), '', `${platform} 的 Ctrl+B 留给 shell(readline 后退一个字符)`);
    assert.equal(km.appShortcutOf(evt('F11', { code: 'F11' })), 'window.fullscreen', platform);
    assert.equal(km.accelOf('panel.sidebar'), 'Ctrl+Shift+B');
    assert.equal(km.accelOf('panel.tools'), 'Ctrl+Shift+Alt+B');
    assert.equal(km.accelOf('window.fullscreen'), 'F11');
  }
});

test('keymap spec 转 Tauri 菜单加速键', async () => {
  const { keymap } = await setup('darwin');
  assert.equal(keymap.toAccelerator('cmd+shift+P'), 'CmdOrCtrl+Shift+P');
  assert.equal(keymap.toAccelerator('cmd+,'), 'CmdOrCtrl+Comma');
  assert.equal(keymap.toAccelerator('cmd+shift+Enter'), 'CmdOrCtrl+Shift+Enter');
  assert.equal(keymap.toAccelerator('cmd+k'), 'CmdOrCtrl+K');
  assert.equal(keymap.toAccelerator('ctrl+alt+t'), 'Ctrl+Alt+T');
  assert.equal(keymap.toAccelerator('cmd+1..9'), '', '范围写法没有单一加速键');
  assert.equal(keymap.toAccelerator(''), '');
  assert.equal(keymap.toAccelerator('cmd+shift'), '', '只有修饰键不成立');
  for (const id of ['tab.new', 'workspace.close', 'session.search', 'pane.split', 'pane.zoom', 'palette.open', 'settings.open', 'session.clear', 'window.close', 'app.quit']) {
    assert.ok(keymap.toAccelerator(keymap.specOf(id)), `${id} 在 macOS 菜单栏有加速键`);
  }
  assert.equal(keymap.toAccelerator(keymap.specOf('app.quit')), 'CmdOrCtrl+Q');
  assert.equal(keymap.toAccelerator(keymap.specOf('window.close')), 'CmdOrCtrl+Shift+W');
});
