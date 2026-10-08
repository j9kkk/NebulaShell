// window-controls 最小单测:平台分支 + 按钮绑定 + 最大化图标同步。
// Run: node --experimental-vm-modules --test tests/window-controls.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function makeClassList() {
  const set = new Set();
  return {
    contains: (c) => set.has(c),
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)),
  };
}

function makeButton(id) {
  return {
    id, innerHTML: '', title: '', listeners: new Map(),
    classList: makeClassList(),
    addEventListener(type, cb) { this.listeners.set(type, cb); },
    click() { this.listeners.get('click')?.(); },
  };
}

function makeEnv({ macos = false, tauri = true, maximized = false } = {}) {
  const buttons = {
    'btn-win-min': makeButton('btn-win-min'),
    'btn-win-max': makeButton('btn-win-max'),
    'btn-win-close': makeButton('btn-win-close'),
  };
  const winBox = { id: 'win-controls', classList: makeClassList() };
  const body = { classList: makeClassList() };
  const winApi = {
    minimized: false, closed: false,
    isMaximized: async () => maximized,
    minimize: async () => { winApi.minimized = true; },
    toggleMaximize: async () => {},
    close: async () => { winApi.closed = true; },
    onResized: (cb) => { winApi.resizedCb = cb; },
  };
  const document = {
    body,
    getElementById: (id) => (id === 'win-controls' ? winBox : buttons[id] || null),
  };
  const context = vm.createContext({
    document,
    window: tauri && !macos ? { __TAURI__: { window: { getCurrentWindow: () => winApi } } } : {},
    navigator: { userAgent: '' },
  });
  return { context, buttons, winBox, body, winApi };
}

async function bind(env) {
  const mod = new vm.SourceTextModule(
    await readFile(new URL('../src/modules/window-controls.js', import.meta.url), 'utf8'),
    { context: env.context },
  );
  await mod.link(() => { throw new Error('no deps'); });
  await mod.evaluate();
  mod.namespace.bindWindowControls();
  return mod;
}

test('macOS 构建(platform-darwin):跳过绑定,隐藏交给 CSS', async () => {
  const env = makeEnv({ macos: true });
  env.context.document.body.classList.add('platform-darwin');
  await bind(env);
  assert.equal(env.buttons['btn-win-min'].innerHTML, '');
  assert.equal(env.buttons['btn-win-min'].listeners.size, 0);
});

test('Windows/Linux:注入图标并绑定最小化/关闭', async () => {
  const env = makeEnv();
  await bind(env);
  assert.equal(env.winBox.classList.contains('hidden'), false);
  assert.match(env.buttons['btn-win-min'].innerHTML, /<svg/);
  await env.buttons['btn-win-min'].click();
  assert.equal(env.winApi.minimized, true);
  await env.buttons['btn-win-close'].click();
  assert.equal(env.winApi.closed, true);
});

test('无 Tauri(浏览器调试):按钮组隐藏', async () => {
  const env = makeEnv({ tauri: false });
  await bind(env);
  assert.equal(env.winBox.classList.contains('hidden'), true);
});

test('最大化状态同步还原图标', async () => {
  const env = makeEnv({ maximized: true });
  await bind(env);
  await env.winApi.resizedCb?.() ?? Promise.resolve();
  await Promise.resolve();
  assert.equal(env.buttons['btn-win-max'].title, '还原');
});
