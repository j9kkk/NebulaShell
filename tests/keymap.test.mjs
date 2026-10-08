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

test('matchAction honors platform modifier: mod=Cmd on darwin, Ctrl on windows/linux', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { core, keymap } = await setup(platform);
    const appKey = platform === 'darwin' ? 'metaKey' : 'ctrlKey';
    assert.equal(keymap.matchAction('tab.new', evt('t', { [appKey]: true }), true), true, platform);
    // 另一个平台的修饰键组合不算应用快捷键(对照 isAppModifier 会先挡掉)
    const other = platform === 'darwin' ? { ctrlKey: true } : { metaKey: true };
    assert.equal(keymap.matchAction('tab.new', evt('t', other), false), false, platform);
    // 无修饰键不命中
    assert.equal(keymap.matchAction('tab.new', evt('t'), false), false, platform);
    // 大小写不敏感(Shift 按下时 key 会变大写)
    assert.equal(keymap.matchAction('tab.new', evt('T', { [appKey]: true }), true), true, platform);
  }
});

test('matchAction requires exact shift/alt state and rejects mac Ctrl combos', async () => {
  const { core, keymap } = await setup('darwin');
  assert.equal(keymap.matchAction('pane.zoom', evt('Enter', { metaKey: true, shiftKey: true }), true), true);
  assert.equal(keymap.matchAction('pane.zoom', evt('Enter', { metaKey: true }), true), false);
  // mac 上 Ctrl 系列永远属于 shell
  assert.equal(keymap.matchAction('tab.new', evt('t', { ctrlKey: true }), false), false);
});

test('accelOf renders per platform: ⌘⇧↵ on darwin, Ctrl+Shift+Enter elsewhere', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { keymap } = await setup(platform);
    assert.equal(keymap.accelOf('pane.zoom'), platform === 'darwin' ? '⌘⇧↵' : 'Ctrl+Shift+Enter', platform);
    assert.equal(keymap.accelOf('tab.new'), platform === 'darwin' ? '⌘T' : 'Ctrl+T', platform);
    assert.equal(keymap.accelOf('tab.switch'), platform === 'darwin' ? '⌘1..9' : 'Ctrl+1..9', platform);
    assert.equal(keymap.accelOf('no.such.action'), '', platform);
  }
});

test('settings.keybindings overrides defaults; invalid entries fall back', async () => {
  const { core, keymap } = await setup('windows', { keybindings: { 'tab.new': 'mod+Q', 'pane.zoom': '   ', unknown: 'mod+Z' } });
  keymap.invalidateKeymapCache();
  assert.equal(keymap.specOf('tab.new'), 'mod+Q');
  assert.equal(keymap.accelOf('tab.new'), 'Ctrl+Q');
  assert.equal(keymap.matchAction('tab.new', evt('q', { ctrlKey: true }), true), true);
  // 空/非法回落默认
  assert.equal(keymap.specOf('pane.zoom'), 'mod+shift+Enter');
  assert.equal(keymap.specOf('workspace.close'), 'mod+W');
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
    'src/modules/commands.js', 'src/modules/menu.js', 'src/modules/monitor.js',
    'src/modules/tools.js', 'src/modules/ai.js', 'src/modules/cloud.js',
    'src/modules/file-transfer.js', 'src/modules/interaction.js',
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
