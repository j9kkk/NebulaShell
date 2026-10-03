// Actual ESM controllers + shared renderer/geometry; only DOM, IPC and xterm are
// adapters. Run: node --experimental-vm-modules --test terminal-workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tabMinimum, planWorkspace, workspaceSignature } from './terminal-workspace.js';

function matches(element, selector) {
  return selector.split(',').some((part) => {
    part = part.trim();
    if (part.includes(' ')) return false;
    let excluded = false;
    part = part.replace(/:not\(([^)]+)\)/g, (_, negative) => { excluded ||= matches(element, negative); return ''; });
    if (excluded) return false;
    if (part.includes(':disabled') && !element.disabled) return false;
    part = part.replace(/:disabled/g, '');
    for (const [, name, value] of part.matchAll(/\[([\w-]+)(?:="([^"]+)")?\]/g)) {
      const actual = element[name] ?? element.attributes[name];
      if (actual == null || (value !== undefined && String(actual) !== value)) return false;
    }
    part = part.replace(/\[[^\]]+\]/g, '');
    const id = part.match(/#([\w-]+)/)?.[1];
    if (id && element.id !== id) return false;
    const tag = part.match(/^[\w-]+/)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    return [...part.matchAll(/\.([\w-]+)/g)].every((match) => element.classList.contains(match[1]));
  });
}

async function fixture() {
  const timers = new Map(), frames = new Map(), calls = [], fileTargets = [], focusCalls = [];
  let sequence = 0, ipc = async () => ({});
  const document = { activeElement: null, events: [], listeners: new Map(),
    dispatchEvent(event) { this.events.push(event.type); for (const fn of this.listeners.get(event.type) || []) fn(event); },
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); },
    removeEventListener() {},
  };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
      this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = '';
      this.textContent = ''; this.disabled = false; this.value = ''; this.replacements = 0;
      this.style = { getPropertyPriority: () => '', getPropertyValue: () => '', setProperty(name, value) { this[name] = value; } };
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); },
        toggle: (name, enabled = !this.classList.contains(name)) => { if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; },
      };
    }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = value; }
    getAttribute(name) { return this.attributes[name]; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
    remove() {
      if (this.isConnected && document.activeElement && this.contains(document.activeElement)) document.activeElement = document.body;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    replaceChildren(...children) { this.replacements++; for (const child of [...this.children]) child.remove(); for (const child of children) this.appendChild(child); }
    set innerHTML(html) {
      this.replaceChildren();
      // Only small, static chrome templates are parsed, not terminal content.
      for (const match of html.matchAll(/<(span|button|div)([^>]*)>([^<]*)<\/(?:span|button|div)>/g)) {
        const child = new Element(match[1]); child.className = match[2].match(/class="([^"]*)"/)?.[1] || '';
        child.textContent = match[3]; this.appendChild(child);
      }
    }
    insertAdjacentHTML(_position, html) {
      const child = new Element('div'); child.className = html.match(/class="([^"]*)"/)?.[1] || '';
      this.appendChild(child);
    }
    querySelectorAll(selector) {
      const result = [];
      const visit = (node) => { for (const child of node.children) { if (matches(child, selector)) result.push(child); visit(child); } };
      visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let current = this; current; current = current.parentElement) if (matches(current, selector)) return current; return null; }
    contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((listener) => listener !== fn)); }
    dispatchEvent(event) {
      event.target ||= this; event.preventDefault ||= () => {}; event.stopPropagation ||= () => { event.stopped = true; };
      for (let current = this; current; current = event.stopped ? null : current.parentElement) {
        for (const fn of current.listeners.get(event.type) || []) fn(event);
      }
      return true;
    }
    focus() { document.activeElement = this; this.dispatchEvent({ type: 'focusin' }); }
    select() {} scrollIntoView(options) { this.scrollOptions = options; }
    getClientRects() { return this.isConnected && !this.closest('.hidden') ? [this.getBoundingClientRect()] : []; }
    dimension(axis) {
      if (!this.isConnected || this.closest('.hidden')) return 0;
      if (this._zero) return 0;
      const explicit = axis === 'width' ? this._width : this._height;
      if (explicit !== undefined) return explicit;
      const parent = this.parentElement;
      let value = parent ? parent.dimension(axis) : (axis === 'width' ? 1400 : 800);
      if (this.id === 'layout-root' && axis === 'height') value -= parseFloat(this.style.top) || 0;
      if (this.classList.contains('workspace-tile-header') && axis === 'height') value = 28;
      if (this.classList.contains('workspace-tile-content')) value -= axis === 'width' ? 2 : 30;
      const fractional = this.style.flex?.match(/^0 0 calc\(([\d.]+)% - ([\d.]+)px\)$/);
      const splitAxis = parent?.style.flexDirection === 'column' ? 'height' : 'width';
      if (fractional && axis === splitAxis) value = value * Number(fractional[1]) / 100 - Number(fractional[2]);
      return Math.max(value, parseFloat(this.style[axis === 'width' ? 'minWidth' : 'minHeight']) || 0);
    }
    get clientWidth() { return this.dimension('width'); } get clientHeight() { return this.dimension('height'); }
    get offsetWidth() { return this.clientWidth; } get offsetHeight() { return this.clientHeight; }
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0 }; }
  }
  document.createElement = (tag) => new Element(tag);
  document.body = new Element('body'); document.documentElement = document.body;
  document.querySelector = (selector) => document.body.querySelector(selector);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  const add = (id, parent = document.body, tag = 'div', className = '') => {
    const el = new Element(tag); el.id = id; el.className = className; parent.appendChild(el); return el;
  };
  const stack = add('term-stack'); stack._width = 1400; stack._height = 800;
  const root = add('layout-root', stack), hint = add('workspace-layout-hint', stack, 'div', 'hidden');
  add('welcome', stack); add('tabs'); add('app'); add('toasts'); add('ctx-menu', document.body, 'div', 'hidden');
  add('file-panel');
  for (const id of ['status-dot', 'status-text', 'btn-reconnect', 'btn-disconnect', 'btn-readonly', 'btn-clear', 'btn-log-toggle', 'ro-badge', 'btn-broadcast']) add(id);
  const modal = add('modal-prompt', document.body, 'div', 'modal hidden');
  for (const id of ['prompt-title', 'prompt-message', 'prompt-hint']) add(id, modal, id === 'prompt-title' ? 'h3' : 'div');
  const input = add('prompt-input', modal, 'input');
  add('btn-prompt-ok', modal, 'button'); add('btn-prompt-cancel', modal, 'button');

  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.text = ''; this.fitCount = 0; this.refreshCount = 0; this.parser = { registerOscHandler() {} }; }
    loadAddon(addon) { addon.term = this; }
    open(surface) { this.element = surface; this.input = new Element('textarea'); surface.appendChild(this.input); }
    focus() { focusCalls.push(this); this.input.focus(); }
    onData(fn) { this.data = fn; } attachCustomKeyEventHandler(fn) { this.key = fn; }
    refresh() { this.refreshCount++; } resize(cols, rows) { this.cols = cols; this.rows = rows; }
    write(text) { this.text += text; } dispose() { this.disposed = true; }
    hasSelection() { return false; } getSelection() { return ''; }
  }
  class FitAddon { fit() { this.term.fitCount++; const pane = this.term.element.parentElement; this.term.cols = Math.max(1, Math.floor(pane.clientWidth / 8)); this.term.rows = Math.max(1, Math.floor(pane.clientHeight / 16)); } }
  class Addon { onContextLoss() {} }
  const context = vm.createContext({ console, crypto: webcrypto, document,
    navigator: { userAgent: 'Mac', clipboard: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    window: { nebula: { platform: 'darwin', invoke: async (name, payload) => { calls.push({ name, payload }); return { ok: true, data: await ipc(name, payload) }; } } },
    Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++sequence, clearInterval() {},
    requestAnimationFrame: (fn) => { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: (id) => frames.delete(id),
  });
  const adapters = {
    './hosts.js': { escapeHtml: String },
    './monitor.js': { closeSnippetMenu() {}, renderMonitorBar() {} },
    './sftp.js': {
      activeConnectedSession: () => { const s = state.sessions.get(state.activeId); return s?.status === 'connected' ? s : null; },
      beginFilePanelSession: (session) => { fileTargets.push(session?.sessionId || null); state.file.sessionId = session?.sessionId || null; },
      initialFileDir: async () => '/', loadFileDir: async () => {}, renderFileTarget() {},
    },
    '@xterm/xterm': { Terminal }, '@xterm/addon-fit': { FitAddon },
    '@xterm/addon-search': { SearchAddon: Addon }, '@xterm/addon-web-links': { WebLinksAddon: Addon }, '@xterm/addon-webgl': { WebglAddon: Addon },
  };
  const cache = new Map(), pending = new Map();
  function load(id) {
    if (pending.has(id)) return pending.get(id);
    const promise = (async () => {
      let module;
      if (adapters[id]) {
        const exports = adapters[id];
        module = new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context, identifier: id });
      } else {
        module = new vm.SourceTextModule(await readFile(new URL(id, import.meta.url), 'utf8'), { context, identifier: id });
      }
      cache.set(id, module);
      await module.link((specifier) => load(specifier));
      return module;
    })();
    pending.set(id, promise);
    return promise;
  }
  const module = await load('./terminal.js'); await module.evaluate();
  const state = cache.get('./core.js').namespace.state;
  state.settings = { terminal: {} };
  const subject = module.namespace;
  const host = (id = 'host') => ({ id, name: id, username: 'root', host: `${id}.invalid`, port: 22 });
  const session = (tab = subject.createTab()) => subject.createSession(host(tab.id), null, tab.id);
  const empty = (tab) => { const id = subject.newPaneId(); tab.panes.set(id, { id, el: subject.makePaneEl(id, tab.id), sessionId: null }); tab.layout = tab.layout ? { type: 'h', ratio: .6, a: tab.layout, b: subject.leaf(id) } : subject.leaf(id); return id; };
  const tick = async (delay) => {
    for (const [id, timer] of [...timers]) if (delay === undefined || timer.delay === delay) { timers.delete(id); timer.fn(); }
    await new Promise(setImmediate);
  };
  const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  return { subject, state, root, stack, hint, calls, timers, frames, focusCalls, document, fileTargets, input,
    session, empty, host, tick, frame, setIPC: (fn) => { ipc = fn; },
  };
}

const leaves = (node) => !node ? [] : node.type === 'leaf' ? [node.tabId] : [...leaves(node.a), ...leaves(node.b)];

test('outer minima/signature include underlying splits and header even under local zoom', () => {
  const tab = { id: 'tab-a', layout: { type: 'v', ratio: .37, a: { type: 'leaf', paneId: 'a' }, b: { type: 'leaf', paneId: 'b' } }, zoomPaneId: 'a' };
  const tabs = new Map([[tab.id, tab]]);
  assert.deepEqual(tabMinimum(tab), { width: 322, height: 395 });
  const signature = workspaceSignature(tabs, 1000, 800);
  tab.zoomPaneId = null; tab.activePaneId = 'b';
  assert.equal(workspaceSignature(tabs, 1000, 800), signature);
  assert.equal(planWorkspace(tabs, 322, 395).fits, true);
  assert.equal(planWorkspace(tabs, 322, 394).fits, false);
});

test('real controller mode toggles preserve trees, ratios, terminal/history/surface identity', async () => {
  const h = await fixture(), a = h.session(), b = h.session();
  const tab = h.state.tabs.get(a.tabId), extra = h.empty(tab);
  tab.layout.ratio = .41; h.subject.renderLayout();
  const trees = [...h.state.tabs.values()].map((tab) => tab.layout);
  const surfaces = [a.term.element, b.term.element]; a.term.write('persistent output'); a.lastCmd = 'persistent command'; a.remoteCwd = '/srv';
  assert.equal(h.state.workspace.mode, 'single'); assert.deepEqual([...h.subject.visibleSessions()], [b]);
  assert.equal(h.subject.toggleTabTiling(), true);
  assert.deepEqual(leaves(h.state.workspace.layout), [...h.state.tabs.keys()]);
  assert.deepEqual([...h.subject.visibleSessions()], [a, b]);
  assert.equal(h.root.querySelectorAll('.workspace-tile').length, 2);
  assert.ok(h.root.querySelector('.workspace-divider'));
  for (let i = 0; i < 4; i++) { h.subject.toggleTabTiling(); h.subject.toggleTabTiling(); }
  [...h.state.tabs.values()].forEach((tab, index) => assert.equal(tab.layout, trees[index]));
  assert.equal(tab.layout.ratio, .41); assert.ok(tab.panes.has(extra));
  assert.equal(a.term.element, surfaces[0]); assert.equal(b.term.element, surfaces[1]);
  assert.equal(a.term.text, 'persistent output'); assert.equal(a.lastCmd, 'persistent command'); assert.equal(a.remoteCwd, '/srv');
  h.subject.toggleTabTiling();
  assert.deepEqual([...h.subject.visibleSessions()], [b]); assert.equal(a.pane.isConnected, false);
});

test('inactive tiled terminal, header, tabbar and empty focus activate without root replacement', async () => {
  const h = await fixture(), a = h.session(), b = h.session();
  a.status = b.status = 'connected';
  const tab = h.state.tabs.get(a.tabId), emptyId = h.empty(tab);
  h.subject.toggleTabTiling();
  const replacements = h.root.replacements, outer = h.state.workspace.layout;
  a.term.input.focus(); assert.equal(h.state.activeId, a.sessionId);
  h.state.tabs.get(b.tabId).workspaceTile.querySelector('.workspace-tile-header').focus();
  assert.equal(h.state.activeId, b.sessionId);
  tab.el.dispatchEvent({ type: 'click', target: tab.el }); assert.equal(h.state.activeId, a.sessionId);
  tab.panes.get(emptyId).el.querySelector('input').focus();
  assert.equal(h.state.activeId, null); assert.equal(h.state.activeTabId, a.tabId);
  assert.equal(h.state.activePaneId, emptyId); assert.equal(h.subject.focusedPaneId(), emptyId);
  assert.equal(h.fileTargets.at(-1), null);
  assert.equal(h.document.querySelector('#btn-disconnect').disabled, true);
  assert.equal(h.root.replacements, replacements); assert.equal(h.state.workspace.layout, outer);
  assert.equal(h.root.querySelectorAll('.term-pane.focused').length, 1);
});

test('inactive owner close/zoom controls never target or steal focus from active tile', async () => {
  const h = await fixture(), a = h.session(), b = h.session();
  a.status = b.status = 'connected';
  const tab = h.state.tabs.get(a.tabId), second = h.subject.createSession(h.host('extra'), null, tab.id);
  h.subject.activateSession(b.sessionId); h.subject.toggleTabTiling();
  const underlying = tab.layout, minimum = tabMinimum(tab);
  second.pane.querySelector('.pane-zoom-btn').dispatchEvent({ type: 'click' });
  assert.equal(tab.zoomPaneId, second.paneId); assert.equal(h.state.activeId, b.sessionId);
  assert.equal(tab.layout, underlying); assert.deepEqual(tabMinimum(tab), minimum);
  assert.deepEqual([...h.subject.visibleSessions()], [b, second]);
  second.pane.querySelector('.pane-close-btn').dispatchEvent({ type: 'click' });
  assert.equal(h.state.sessions.has(second.sessionId), false); assert.equal(h.state.sessions.has(b.sessionId), true);
  assert.equal(h.state.activeId, b.sessionId);
  tab.workspaceTile.querySelector('.workspace-tile-close').dispatchEvent({ type: 'click' });
  assert.equal(h.state.tabs.has(a.tabId), false); assert.equal(h.state.activeId, b.sessionId);
  assert.equal(h.document.activeElement, b.term.input, 'synchronous remount preserves only the actually focused active input');
  assert.equal(h.state.workspace.mode, 'tiled'); assert.deepEqual(leaves(h.state.workspace.layout), [b.tabId]);
  assert.equal(h.state.tabs.get(b.tabId).workspaceTile.style.flex, '');
  h.subject.closeTab(b.tabId);
  assert.equal(h.state.workspace.mode, 'single'); assert.equal(h.state.workspace.layout, null);
  assert.equal(h.state.activeId, null); assert.equal(h.root.children.length, 0);
  assert.equal(h.document.querySelector('#welcome').classList.contains('hidden'), false);
});

test('owner-specific picker connection and awaited credentials survive focus changes but not target closure', async () => {
  const h = await fixture(), a = h.session(), b = h.session();
  const tab = h.state.tabs.get(a.tabId), paneId = h.empty(tab);
  h.state.hosts.push(h.host('picked')); h.subject.toggleTabTiling();
  tab.panes.get(paneId).el.querySelector('.pp-item').dispatchEvent({ type: 'click' });
  await new Promise(setImmediate);
  assert.equal(h.state.sessions.get(tab.panes.get(paneId).sessionId).host.id, 'picked');
  assert.equal(h.state.sessions.get(tab.panes.get(paneId).sessionId).tabId, tab.id);
  assert.equal(h.state.tabs.get(b.tabId).panes.size, 1);
  for (const close of [false, true]) {
    const target = h.empty(tab); h.subject.renderLayout(); h.subject.activatePane(tab.id, target);
    const pending = h.subject.quickConnect({ username: 'test', host: 'quick.invalid', port: 22 }, target, tab.id);
    await new Promise(setImmediate);
    h.subject.activateSession(b.sessionId, { focus: false });
    if (close) h.subject.closeActivePane(target, tab.id);
    h.input.value = 'secret'; h.document.querySelector('#btn-prompt-ok').dispatchEvent({ type: 'click' });
    const connected = await pending;
    if (close) assert.equal(connected, null);
    else { assert.equal(connected.tabId, tab.id); assert.equal(connected.paneId, target); }
    assert.equal(h.state.activeId, b.sessionId);
  }
});

test('resize coalesces by stable parent signature, overflow reserve never loops, timers never focus', async () => {
  const h = await fixture(), a = h.session(), b = h.session();
  h.subject.toggleTabTiling(); h.frame();
  const old = h.state.workspace.layout, replacements = h.root.replacements;
  for (let i = 0; i < 10; i++) h.subject.scheduleWorkspaceLayout();
  assert.equal(h.frames.size, 1); h.frame();
  assert.equal(h.root.replacements, replacements); assert.equal(h.state.workspace.layout, old);
  h.stack._width = 500; h.stack._height = 200;
  h.subject.scheduleWorkspaceLayout(); h.frame();
  assert.equal(h.state.workspace.fits, false); assert.equal(h.root.style.top, '28px');
  assert.equal(h.hint.classList.contains('hidden'), false); assert.equal(h.root.classList.contains('workspace-overflow'), true);
  assert.deepEqual(leaves(h.state.workspace.layout), [a.tabId, b.tabId]);
  const overflowLayout = h.state.workspace.layout;
  h.subject.activateTab(a.tabId, false);
  assert.deepEqual({ ...h.state.tabs.get(a.tabId).workspaceTile.querySelector('.workspace-tile-header').scrollOptions }, { block: 'nearest', inline: 'nearest' });
  assert.equal(h.state.tabs.get(a.tabId).workspaceTile.scrollOptions, undefined);
  assert.equal(h.state.workspace.layout, overflowLayout);
  h.subject.scheduleWorkspaceLayout(); h.frame(); assert.equal(h.state.workspace.layout, overflowLayout);
  h.stack._width = 1400; h.stack._height = 800; h.subject.scheduleWorkspaceLayout(); h.frame();
  assert.equal(h.state.workspace.fits, true); assert.equal(h.root.style.top, '');
  const input = h.document.createElement('input'); h.document.body.appendChild(input); input.focus();
  const before = h.focusCalls.length; await h.tick(30);
  assert.equal(h.focusCalls.length, before); assert.equal(h.document.activeElement, input);
});

test('tiling requires two tabs initially, new tabs reflow and status/header chrome stays accessible', async () => {
  const h = await fixture(), a = h.session();
  assert.equal(h.subject.toggleTabTiling(), false); assert.equal(h.state.workspace.mode, 'single');
  const b = h.session(); h.subject.toggleTabTiling();
  const tree = h.state.tabs.get(a.tabId).layout;
  h.subject.handleSessionStatus({ sessionId: a.sessionId, state: 'connected' });
  const tile = h.state.tabs.get(a.tabId).workspaceTile;
  assert.ok(tile.querySelector('.workspace-tile-dot').classList.contains('connected'));
  assert.equal(tile.querySelector('.workspace-tile-dot').getAttribute('aria-label'), '已连接');
  assert.ok(tile.querySelector('.workspace-tile-header').getAttribute('aria-label').includes('已连接'));
  const emptyTab = h.subject.newTabWithPicker(); h.frame();
  assert.deepEqual(leaves(h.state.workspace.layout), [a.tabId, b.tabId, emptyTab.id]);
  assert.equal(h.state.tabs.get(a.tabId).layout, tree);
  assert.equal(h.root.querySelectorAll('.workspace-tile').length, 3);
  h.subject.closeTab(a.tabId); h.subject.closeTab(b.tabId);
  assert.equal(h.state.workspace.mode, 'tiled'); assert.equal(h.subject.toggleTabTiling(), false);
  assert.equal(h.state.workspace.mode, 'single'); assert.equal(h.subject.toggleTabTiling(), false);
});

test('awaited quick picker keeps unchanged focus and background single-tab completion never remounts active terminal', async () => {
  const h = await fixture(), a = h.session();
  const tab = h.state.tabs.get(a.tabId), target = h.empty(tab);
  h.subject.renderLayout(); h.subject.activatePane(tab.id, target);
  tab.panes.get(target).el.querySelector('input').focus();
  let pending = h.subject.quickConnect({ username: 'root', host: 'same.invalid', port: 22 }, target, tab.id);
  await new Promise(setImmediate); h.input.value = 'secret';
  h.document.querySelector('#btn-prompt-ok').dispatchEvent({ type: 'click' });
  const connected = await pending;
  assert.equal(h.state.activeId, connected.sessionId);
  const background = h.empty(tab); h.subject.renderLayout(); h.subject.activatePane(tab.id, background);
  pending = h.subject.quickConnect({ username: 'root', host: 'background.invalid', port: 22 }, background, tab.id);
  await new Promise(setImmediate);
  const b = h.session();
  const replacements = h.root.replacements;
  h.input.value = 'secret'; h.document.querySelector('#btn-prompt-ok').dispatchEvent({ type: 'click' });
  const result = await pending;
  assert.equal(result.tabId, tab.id); assert.equal(result.paneId, background);
  assert.equal(h.state.activeId, b.sessionId); assert.equal(h.root.replacements, replacements);
  assert.equal(h.subject.visibleSessions().includes(result), false);
});

test('visible fit/resize includes every nonzero mounted tile but excludes zoomed peers and hidden tabs', async () => {
  const h = await fixture(), a = h.session(), b = h.session();
  const tab = h.state.tabs.get(a.tabId), second = h.subject.createSession(h.host('peer'), null, tab.id);
  for (const s of [a, b, second]) s.status = 'connected';
  h.subject.toggleTabTiling(); h.subject.togglePaneZoom(second.paneId, tab.id);
  const before = [a, b, second].map((s) => s.term.fitCount);
  h.subject.fitAllVisible(); await h.tick(30); await h.tick(150);
  assert.equal(a.term.fitCount, before[0]); assert.ok(b.term.fitCount > before[1]); assert.ok(second.term.fitCount > before[2]);
  const resized = h.calls.filter((call) => call.name === 'ssh:resize').map((call) => call.payload.sessionId);
  assert.ok(resized.includes(b.sessionId)); assert.ok(resized.includes(second.sessionId)); assert.ok(!resized.includes(a.sessionId));
  b.pane._zero = true; assert.ok(!h.subject.visibleSessions().includes(b));
  delete b.pane._zero; h.subject.toggleTabTiling();
  assert.deepEqual([...h.subject.visibleSessions()], [second]);
  const box = tab.workspaceContent; h.subject.toggleTabTiling();
  box._width = 640; box._height = 180;
  assert.deepEqual({ ...h.subject.layoutDimensions() }, { width: 640, height: 180 });
  assert.equal(h.subject.maxPaneCapacity(), 1);
});
