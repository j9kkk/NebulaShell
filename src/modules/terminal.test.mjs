// Focused controller tests execute the actual module with platform/DOM/xterm adapters.
// No browser, npm test runner or SSH host is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as layout from './terminal-layout.js';
import { parseFpError, stripFpMark } from './core.js';

const moduleSource = (await readFile(new URL('./terminal.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const source = moduleSource.replace(/\bexport /g, '');

function harness({ renderStatusbar = false } = {}) {
  const calls = [], timers = new Map(), notices = [], closedTabs = [], confirmations = [], elements = new Map();
  let timerSeq = 0, modal = false, password = 'quick-secret', confirm = false, implementation = async () => ({});
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, { textContent: '', className: '', disabled: false, title: '',
        classList: { add: (name) => classes.add(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } });
    }
    return elements.get(selector);
  };
  const state = { sessions: new Map(), tabs: new Map(), hosts: [], activeId: null, activeTabId: 'tab-a', broadcast: null, metrics: new Map(), paneSeq: 0, tabSeq: 0 };
  const tab = { id: 'tab-a', el: element('tab-a'), panes: new Map(), layout: null };
  state.tabs.set(tab.id, tab);
  const paneElement = () => {
    const children = [];
    const el = { children, isConnected: true, dataset: {}, innerHTML: '', title: '', className: '', textContent: '', _parent: null,
      classList: { toggle() {} }, addEventListener() {},
      appendChild(c) { children.push(c); if (c && typeof c === 'object') c._parent = el; return c; },
      append(...cs) { for (const c of cs) el.appendChild(c); },
      replaceChildren(...cs) { children.length = 0; children.push(...cs); for (const c of cs) if (c && typeof c === 'object') c._parent = el; },
      remove() {
        el.isConnected = false;
        const p = el._parent;
        if (p && Array.isArray(p.children)) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
        el._parent = null;
      },
      // 断开横幅按 className 复用既有元素;其余选择器(窗格按钮等)落空即可。
      querySelector(sel) {
        const cls = String(sel).slice(1);
        return children.find((c) => String(c.className || '').split(' ').includes(cls)) || null;
      },
      getBoundingClientRect: () => ({ width: 640, height: 360 }) };
    return el;
  };
  class Terminal {
    constructor() {
      this.modes = { bracketedPasteMode: false }; this.focusCount = 0;
      this.parser = { csi: [], registerOscHandler() {}, registerCsiHandler(id, fn) { this.csi.push([id, fn]); } };
    }
    loadAddon() {} open() {} onData(fn) { this.data = fn; } attachCustomKeyEventHandler() {}
    focus() { this.focusCount++; } dispose() {}
    paste() { throw new Error('command blocks must not use paste'); }
    input() { throw new Error('command blocks must not use input'); }
  }
  class Addon { fit() {} onContextLoss() {} }
  const context = vm.createContext({
    ...layout, state, crypto: webcrypto, console, Terminal,
    FitAddon: Addon, SearchAddon: Addon, WebLinksAddon: Addon, WebglAddon: Addon,
    window: {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    api: async (name, payload) => { calls.push({ name, payload }); return implementation(name, payload); },
    hasOpenModal: () => modal, isAppModifier: (event) => !!event.metaKey,
    activeTab: () => state.tabs.get(state.activeTabId),
    $: (selector) => selector === '#layout-root' ? { clientWidth: 1300, clientHeight: 555 } : element(selector),
    document: { dispatchEvent() {}, documentElement: {}, createElement: paneElement }, CustomEvent: class { constructor(type) { this.type = type; } },
    renderStatusbar,
    askPrompt: async () => password,
    askConfirm: async (message, options) => { confirmations.push({ message, options }); return confirm; },
    parseFpError, stripFpMark,
    toast: (...args) => notices.push(args),
    renderMonitorBar() {},
    setTimeout: (fn, delay) => { const id = ++timerSeq; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++timerSeq, clearInterval() {},
  });
  vm.runInContext(source + `
    updateTab = () => {};
    updateStatusbar = renderStatusbar ? updateStatusbar : () => {};
    refreshBroadcast = () => {};
    scheduleResizeSync = () => {};
    stopLogIfActive = () => {};
    closeTab = (id) => closedTabs.push(id);
    createTab = () => state.tabs.get('tab-a');
    const createInputSession = createSession;
    createSession = (host) => addSession(host);
    renderLayout = () => {};
    syncTabChrome = () => {};
    updateWelcome = () => {};
    closeCtxMenu = () => {};
    closeSnippetMenu = () => {};
    followFilePanel = () => {};
    dropSessionView = () => {};
    syncActiveSessionView = () => {};
    syncFilePanesForSession = () => {};
    const realMakePaneEl = makePaneEl;
    globalThis.__buildFilePaneCalls = [];
    buildFilePane = (paneObj) => { globalThis.__buildFilePaneCalls.push(!!(paneObj && paneObj.el)); };
    initFilePane = async () => {};
    createFilePaneState = () => ({});
    confirmTransferInterrupt = async () => true;
    loadSessionLogState = () => {};
    makePaneEl = paneElement;
    appendPaneButtons = () => {};
    globalThis.subject = {writeSessionInput, disconnectSession, reconnectSession, runSessionConnection, makePaneEl: realMakePaneEl,
      scheduleReconnect, handleSessionStatus, writableBroadcastSessions, quickConnect, splitActive,
      isRetryableNetworkError, closeActivePane, syncPaneButtons, visibleSessions, fitActive, updateStatusbar,
      syncPaneStatusBanner,
      getCommandBlockTarget, commandBlockTargetStatus, submitCommandBlock,
      activateSession, activatePane, setActiveTabId, closeSession, createInputSession,
      consumeCommandKeys, setAltScreen};
  `, Object.assign(context, { closedTabs, addSession, paneElement }));
  function addSession(host = { id: 'host-a', host: 'example.invalid', username: 'root', port: 22 }) {
    const s = {
      sessionId: `session-${state.sessions.size}`, host, term: new Terminal(), pane: paneElement(),
      histBuf: '', lastCmd: '', lastOutput: '', collectOutput: false,
      fit: { fit() { throw new Error('unexpected fit'); } }, paneId: `mock-pane-${state.sessions.size}`,
      tabId: 'tab-a', status: 'disconnected', readOnly: false, reconnectAttempt: 0, connectionEpoch: 0,
      connection: host.quick ? { kind: 'quick', host: { ...host } } : { kind: 'saved', hostId: host.id },
    };
    state.sessions.set(s.sessionId, s); state.activeId = s.sessionId;
    tab.panes.set(s.paneId, { id: s.paneId, sessionId: s.sessionId, el: s.pane });
    const leaf = { type: 'leaf', paneId: s.paneId };
    tab.layout = tab.layout ? { type: 'h', a: tab.layout, b: leaf } : leaf;
    return s;
  }
  return { ...context.subject, state, tab, calls, timers, notices, closedTabs, confirmations, elements, addSession,
    __buildFilePaneCalls: context.__buildFilePaneCalls,
    setModal: (value) => modal = value, setPassword: (value) => password = value,
    setConfirm: (value) => confirm = value,
    setAPI: (fn) => implementation = fn,
    tick: async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await new Promise(setImmediate); },
  };
}

test('write helper returns boolean and blocks readonly, connecting, modal and removed sessions', async () => {
  const h = harness(), s = h.addSession();
  for (const status of ['connecting', 'disconnected', 'error', 'exited']) {
    s.status = status; assert.equal(await h.writeSessionInput(s.sessionId, 'x'), false);
  }
  s.status = 'connected'; s.readOnly = true;
  assert.equal(await h.writeSessionInput(s.sessionId, 'x'), false);
  s.readOnly = false; h.setModal(true);
  assert.equal(await h.writeSessionInput(s.sessionId, 'x'), false);
  h.setModal(false);
  assert.equal(await h.writeSessionInput(s.sessionId, 'hello\r'), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.data, 'hello\r');
  h.setAPI(async () => { throw new Error('socket closed'); });
  assert.equal(await h.writeSessionInput(s.sessionId, 'x'), false);
  h.state.sessions.delete(s.sessionId);
  assert.equal(await h.writeSessionInput(s.sessionId, 'x'), false);
});

test('in-place reconnect keeps session, terminal, pane and tab identity', async () => {
  const h = harness(), s = h.addSession();
  const term = s.term, pane = s.pane, tab = h.tab;
  assert.equal(await h.reconnectSession(s.sessionId), true);
  assert.equal(h.state.sessions.get(s.sessionId), s);
  assert.equal(s.term, term); assert.equal(s.pane, pane); assert.equal(h.tab, tab);
  assert.equal(s.status, 'connected');
  assert.deepEqual(h.calls.map((c) => c.name), ['ssh:disconnect', 'ssh:connect']);
  assert.equal(h.calls[1].payload.sessionId, s.sessionId);
});

test('late connect completion after cancellation never runs initcmd or revives the session', async () => {
  const h = harness(), s = h.addSession();
  s.host.initcmd = 'danger-command';
  let resolve;
  h.setAPI((name) => name === 'ssh:connect' ? new Promise((r) => resolve = r) : Promise.resolve({}));
  const pending = h.runSessionConnection(s);
  assert.equal(s.status, 'connecting');
  await h.disconnectSession(s.sessionId);
  assert.equal(h.handleSessionStatus({ sessionId: s.sessionId, state: 'connected' }), false);
  resolve({});
  assert.equal(await pending, false);
  assert.equal(s.status, 'disconnected');
  assert.equal(h.calls.some((c) => c.name === 'ssh:write'), false);
});

test('removed session ignores late success and late failures', async () => {
  for (const fail of [false, true]) {
    const h = harness(), s = h.addSession();
    let settle;
    h.setAPI(() => new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('network')) : resolve({}); }));
    const promise = h.runSessionConnection(s);
    h.state.sessions.delete(s.sessionId); settle();
    assert.equal(await promise, false);
    assert.equal(h.notices.length, 0);
  }
});

test('quick credentials are prompted before session creation and payload has frontend sessionId', async () => {
  const h = harness();
  const s = await h.quickConnect({ username: 'tester', host: 'example.invalid', port: 2222 });
  const call = h.calls.find((c) => c.name === 'ssh:connectQuick');
  assert.equal(call.payload.host.password, 'quick-secret');
  assert.equal(call.payload.host.username, 'tester');
  assert.equal(call.payload.sessionId, s.sessionId);
  s.status = 'disconnected';
  await h.reconnectSession(s.sessionId);
  assert.equal(h.calls.filter((c) => c.name === 'ssh:connectQuick')[1].payload.host.password, 'quick-secret');
});

test('quick password cancellation leaves no pane/session/connection', async () => {
  const h = harness(); h.setPassword(null);
  assert.equal(await h.quickConnect({ host: 'example.invalid', username: 'root', port: 22 }), null);
  assert.equal(h.state.sessions.size, 0); assert.equal(h.calls.length, 0);
});

test('initial failure, credentials and fingerprints never auto-retry', async () => {
  const h = harness(), s = h.addSession();
  assert.equal(h.scheduleReconnect(s.sessionId, 'network connection reset'), false);
  s.everConnected = true;
  for (const why of ['All configured authentication methods failed', '私钥解析失败', '未配置密码', 'unknown key', '[NB-FP key|old|new]', 'cancelled']) {
    assert.equal(h.scheduleReconnect(s.sessionId, why), false, why);
  }
  assert.equal(h.timers.size, 0);
});

test('status events and redraws hide fingerprint markers without altering trust metadata', () => {
  const h = harness({ renderStatusbar: true }), s = h.addSession();
  const raw = '跳板 bastion 失败: SSH 主机指纹不一致 [NB-FP example.invalid:22|SHA256:old|SHA256:new]';
  s.everConnected = true;
  for (const status of ['error', 'disconnected', 'exited']) {
    const event = { sessionId: s.sessionId, state: status, error: raw };
    assert.equal(h.handleSessionStatus(event), true);
    assert.equal(s.lastError, raw);
    assert.equal(event.error, raw);
    assert.equal(h.elements.get('#status-text').textContent, '已断开 root@example.invalid:22（跳板 bastion 失败: SSH 主机指纹不一致）');
    h.updateStatusbar(s); // Tab/broadcast redraw reads the raw lastError again.
    assert.ok(!h.elements.get('#status-text').textContent.includes('NB-FP'));
    assert.deepEqual(parseFpError(s.lastError), {
      key: 'example.invalid:22', stored: 'SHA256:old', current: 'SHA256:new', clean: '跳板 bastion 失败: SSH 主机指纹不一致',
    });
    assert.equal(h.scheduleReconnect(s.sessionId, s.lastError), false);
  }
  h.updateStatusbar(s, '[NB-FP example.invalid:22|SHA256:old|SHA256:new]');
  assert.equal(h.elements.get('#status-text').textContent, '已断开 root@example.invalid:22');
  assert.equal(s.lastError, raw);
  assert.equal(h.timers.size, 0);
  assert.equal(h.notices.length, 0);
});

test('fingerprint connection failure has clean status/dialog/toasts and retains explicit retrust metadata', async () => {
  for (const approve of [false, true]) {
    const h = harness({ renderStatusbar: true }), s = h.addSession();
    const raw = '跳板 bastion 失败: SSH 主机指纹不一致 [NB-FP example.invalid:22|SHA256:old|SHA256:new]';
    const term = s.term, pane = s.pane;
    h.setConfirm(approve);
    h.setAPI(async (name) => {
      if (name === 'ssh:connect' && h.calls.filter((c) => c.name === name).length === 1) throw new Error(raw);
      return {};
    });
    assert.equal(await h.runSessionConnection(s), false);
    assert.equal(s.lastError, raw);
    assert.ok(!h.elements.get('#status-text').textContent.includes('NB-FP'));
    const dialog = h.confirmations[0];
    assert.ok(dialog.message.includes('服务器「example.invalid:22」'));
    assert.ok(dialog.message.includes('本地记录：SHA256:old'));
    assert.ok(dialog.message.includes('服务器出示：SHA256:new'));
    assert.ok(!dialog.message.includes('NB-FP'));
    assert.equal(dialog.options.defaultFocus, 'cancel');
    assert.equal(h.notices.length, 0, 'Fingerprint failures use the trust dialog, not a raw error toast');
    await new Promise(setImmediate); // offerFpRetrust is asynchronous.
    const deletions = h.calls.filter((c) => c.name === 'fingerprints:delete');
    assert.equal(deletions.length, approve ? 1 : 0);
    if (approve) {
      assert.equal(deletions[0].payload.id, 'example.invalid:22');
      assert.equal(s.status, 'connected');
      assert.equal(h.calls.filter((c) => c.name === 'ssh:connect').length, 2);
    } else {
      assert.equal(s.status, 'error');
      assert.equal(h.calls.filter((c) => c.name === 'ssh:connect').length, 1);
    }
    assert.equal(h.state.sessions.get(s.sessionId), s);
    assert.equal(s.term, term); assert.equal(s.pane, pane);
    assert.equal(h.timers.size, 0);
  }
});

test('ordinary connection failures keep human-readable status and toast prefixes', async () => {
  const h = harness({ renderStatusbar: true }), s = h.addSession();
  h.setAPI(async () => { throw new Error('跳板 bastion 失败: socket closed'); });
  assert.equal(await h.runSessionConnection(s), false);
  assert.equal(h.elements.get('#status-text').textContent, '已断开 root@example.invalid:22（跳板 bastion 失败: socket closed）');
  assert.deepEqual(h.notices, [['连接失败：跳板 bastion 失败: socket closed', 'error']]);
  assert.equal(h.confirmations.length, 0);
});

test('established network drop retries only 3 times at 1s, 2s, 4s', async () => {
  const h = harness(), s = h.addSession(); s.everConnected = true;
  h.setAPI(async () => { throw new Error('network connection reset'); });
  h.handleSessionStatus({ sessionId: s.sessionId, state: 'disconnected', reason: 'network' });
  for (const delay of [1000, 2000, 4000]) {
    assert.equal([...h.timers.values()][0].delay, delay);
    assert.equal(h.scheduleReconnect(s.sessionId, 'network reset'), false); // dedupe
    await h.tick();
  }
  assert.equal(s.reconnectAttempt, 3); assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter((c) => c.name === 'ssh:connect').length, 3);
});

test('manual disconnect cancels backoff and explicit remote shell exit does not retry', async () => {
  const h = harness(), s = h.addSession(); s.everConnected = true;
  h.handleSessionStatus({ sessionId: s.sessionId, state: 'exited', code: 0 });
  assert.equal(h.timers.size, 0);
  h.scheduleReconnect(s.sessionId, 'socket reset');
  assert.equal(h.timers.size, 1);
  await h.disconnectSession(s.sessionId);
  assert.equal(h.timers.size, 0);
});

// ---- 窗格断开横幅与回车就地重连 ----

test('pane banner explains disconnect with reason and Enter hint, and clears when connected', () => {
  const h = harness(), s = h.addSession();
  const banner = () => s.pane.querySelector('.pane-status-banner');
  s.lastError = 'socket reset [NB-FP host:22|aa|bb]';
  h.syncPaneStatusBanner(s, s.lastError);
  assert.match(banner().className, /disconnected/);
  assert.match(banner().children.find((c) => c.className === 'psb-text').textContent, /已断开 root@example.invalid:22（socket reset）/);
  assert.equal(banner().children.find((c) => c.className === 'psb-hint').textContent, '按 Enter 重新连接');
  assert.equal(banner().title, 'socket reset', '完整原因进 title(指纹标记在展示层剥离),横幅内可截断');
  // 自动重连排期:横幅展示倒计时,提示语改为"立即重连"
  s.everConnected = true; s.reconnectAttempt = 0;
  h.scheduleReconnect(s.sessionId, 'socket reset');
  h.syncPaneStatusBanner(s, s.lastError);
  assert.match(banner().children.find((c) => c.className === 'psb-text').textContent, /自动重连 1\/3/);
  assert.equal(banner().children.find((c) => c.className === 'psb-hint').textContent, '按 Enter 立即重连');
  // 手动断开不显示残留原因
  s.manualDisconnect = true; s.reconnectScheduled = false;
  h.syncPaneStatusBanner(s, s.lastError);
  assert.match(banner().children.find((c) => c.className === 'psb-text').textContent, /已断开 root@example.invalid:22$/);
  // 连接中与已连接形态
  s.manualDisconnect = false; s.status = 'connecting';
  h.syncPaneStatusBanner(s);
  assert.match(banner().className, /connecting/);
  assert.match(banner().children.find((c) => c.className === 'psb-text').textContent, /正在连接/);
  assert.equal(banner().children.some((c) => c.className === 'psb-hint'), false, '连接中不显示回车提示');
  s.status = 'connected';
  h.syncPaneStatusBanner(s);
  assert.equal(banner(), null);
});

test('Enter on a disconnected pane reconnects in place; other input is dropped and connecting swallows Enter', async () => {
  const h = harness();
  const s = h.createInputSession({ id: 'host-a', host: 'example.invalid', username: 'root', port: 22 });
  h.state.activeId = s.sessionId;
  s.status = 'disconnected'; s.lastError = 'connection reset';
  s.term.data('ls');
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, [], '断开后的普通输入原样丢弃,不发也不重连');
  s.term.data('\r');
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.map((c) => c.name), ['ssh:disconnect', 'ssh:connect'], '回车走完整重连');
  assert.equal(h.state.sessions.get(s.sessionId), s);
  assert.equal(s.status, 'connected');
  // connecting 期间的回车不得叠加第二次连接
  h.calls.length = 0;
  s.status = 'disconnected';
  let resolveConnect;
  h.setAPI((name) => name === 'ssh:connect' ? new Promise((r) => resolveConnect = r) : Promise.resolve({}));
  s.term.data('\r');
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.map((c) => c.name), ['ssh:disconnect', 'ssh:connect']);
  s.term.data('\r');
  await new Promise(setImmediate);
  assert.equal(h.calls.filter((c) => c.name === 'ssh:connect').length, 1, 'connecting 中重复回车被状态防御忽略');
  resolveConnect({});
  await new Promise(setImmediate);
});

test('Enter reconnect is blocked by open modals', async () => {
  const h = harness();
  const s = h.createInputSession({ id: 'host-a', host: 'example.invalid', username: 'root', port: 22 });
  h.state.activeId = s.sessionId;
  s.status = 'disconnected';
  h.setModal(true);
  s.term.data('\r');
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, []);
});

test('writable broadcast count excludes missing, disconnected and readonly selected targets', () => {
  const h = harness(), writable = h.addSession(), ro = h.addSession(), connecting = h.addSession();
  writable.status = 'connected'; ro.status = 'connected'; ro.readOnly = true; connecting.status = 'connecting';
  h.state.broadcast = new Set([writable.sessionId, ro.sessionId, connecting.sessionId, 'deleted']);
  assert.equal(h.writableBroadcastSessions().length, 1);
  ro.readOnly = false; assert.equal(h.writableBroadcastSessions().length, 2);
  writable.status = 'disconnected'; assert.equal(h.writableBroadcastSessions().length, 1);
});

test('split rejects connecting/disconnected source and clones temporary descriptor without picker', async () => {
  const h = harness(), s = h.addSession({ id: 'temp', quick: true, host: 'example.invalid', password: 'memory-only', port: 22 });
  s.status = 'connecting'; h.splitActive('h');
  assert.equal(h.state.sessions.size, 1);
  s.status = 'connected';
  await h.splitActive('v');
  assert.equal(h.state.sessions.size, 2);
  const call = h.calls.find((c) => c.name === 'ssh:connectQuick');
  assert.equal(call.payload.host.password, 'memory-only');
  assert.notEqual(call.payload.sessionId, s.sessionId);
});

test('last pane close closes tab, and hidden panes are excluded from fit', () => {
  const h = harness(), s = h.addSession();
  h.closeActivePane(s.paneId);
  assert.deepEqual(h.closedTabs, ['tab-a']);
  s.pane.isConnected = false;
  assert.equal(h.visibleSessions().length, 0);
  assert.doesNotThrow(() => h.fitActive());
});

test('pre-reconnect disconnect is cancellable and duplicate reconnect is suppressed', async () => {
  const h = harness(), s = h.addSession();
  let resolve, disconnectCalls = 0;
  h.setAPI((name) => {
    if (name === 'ssh:disconnect' && ++disconnectCalls === 1) return new Promise((r) => resolve = r);
    return Promise.resolve({});
  });
  const reconnect = h.reconnectSession(s.sessionId);
  assert.equal(await h.reconnectSession(s.sessionId), false);
  await h.disconnectSession(s.sessionId);
  resolve({});
  assert.equal(await reconnect, false);
  assert.equal(h.calls.some((c) => c.name === 'ssh:connect'), false);
  assert.equal(s.manualDisconnect, true);
});

test('initcmd runs once across reconnect and stays output-only lifecycle input despite modal', async () => {
  const h = harness(), s = h.addSession();
  s.host.initcmd = 'setup-once'; h.setModal(true);
  assert.equal(await h.runSessionConnection(s), true);
  assert.equal(s.initcmdExecuted, true);
  s.status = 'disconnected';
  assert.equal(await h.reconnectSession(s.sessionId), true);
  assert.equal(h.calls.filter((c) => c.name === 'ssh:write').length, 1);
});

const writes = (h) => h.calls.filter((call) => call.name === 'ssh:write');
const histories = (h) => h.calls.filter((call) => call.name === 'history:add');
function connectedTarget(h) {
  const s = h.addSession(); s.status = 'connected';
  const result = h.getCommandBlockTarget();
  assert.equal(result.ok, true);
  return { s, target: result.target };
}
function rejected(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

test('command block API has the exact named ESM exports', async () => {
  const module = new vm.SourceTextModule(moduleSource, { context: vm.createContext({}) });
  await module.link(() => { throw new Error('imports were already adapted'); });
  await module.evaluate();
  for (const name of ['getCommandBlockTarget', 'commandBlockTargetStatus', 'submitCommandBlock']) {
    assert.equal(typeof module.namespace[name], 'function', name);
  }
});

test('target captures active session identity and owner fields without any fallback', () => {
  const h = harness(), { s, target } = connectedTarget(h);
  assert.equal(target.session, s);
  assert.equal(target.sessionId, s.sessionId);
  assert.equal(target.connectionEpoch, s.connectionEpoch);
  assert.equal(target.tabId, s.tabId); assert.equal(target.paneId, s.paneId);
  assert.equal(typeof target.activationRevision, 'number');
  assert.equal(target.label, 'example.invalid · root@example.invalid:22 · 窗格 1');
  assert.ok(Object.isFrozen(target));
  const alternative = h.addSession(); alternative.status = 'connected';
  for (const activeId of [null, 'missing', s.sessionId]) {
    h.state.activeId = activeId; s.status = 'disconnected';
    rejected(h.getCommandBlockTarget());
  }
  s.status = 'connected'; s.readOnly = true;
  rejected(h.getCommandBlockTarget());
  assert.equal(h.calls.length, 0);
});

test('target labels distinguish same-host splits by tab.panes insertion order, including empty panes', () => {
  const h = harness(), { s: first } = connectedTarget(h);
  h.tab.customTitle = '同主机分屏';
  h.tab.panes.set('empty-pane', { id: 'empty-pane', sessionId: null, el: first.pane });
  const second = h.addSession(first.host); second.status = 'connected';
  const secondTarget = h.getCommandBlockTarget().target;
  assert.equal(secondTarget.label, '同主机分屏 · root@example.invalid:22 · 窗格 3');
  h.activateSession(first.sessionId, { focus: false });
  const firstLabel = h.getCommandBlockTarget().target.label;
  assert.equal(firstLabel, '同主机分屏 · root@example.invalid:22 · 窗格 1');
  assert.notEqual(firstLabel, secondTarget.label);
  h.tab.panes.delete('empty-pane');
  h.activateSession(second.sessionId, { focus: false });
  assert.equal(h.getCommandBlockTarget().target.label, '同主机分屏 · root@example.invalid:22 · 窗格 2');
  assert.equal(h.calls.length, 0);
});

test('get and submit reject disconnected, readonly, manual disconnect, modal and invalid/hidden owners', async () => {
  const mutations = [
    (h, s) => { s.status = 'connecting'; },
    (h, s) => { s.status = 'disconnected'; },
    (h, s) => { s.status = 'error'; },
    (h, s) => { s.status = 'exited'; },
    (h, s) => { s.readOnly = true; },
    (h, s) => { s.manualDisconnect = true; },
    (h) => h.setModal(true),
    (h, s) => { s.pane.isConnected = false; },
    (h, s) => { s.pane.getBoundingClientRect = () => ({ width: 0, height: 360 }); },
    (h, s) => { s.pane.getBoundingClientRect = () => ({ width: 640, height: 0 }); },
    (h) => { h.tab.zoomPaneId = 'other-pane'; },
    (h) => { h.tab.layout = { type: 'leaf', paneId: 'other-pane' }; },
    (h) => { h.tab.closing = true; },
    (h, s) => h.tab.panes.delete(s.paneId),
    (h) => h.state.tabs.delete(h.tab.id),
    (h, s) => { h.tab.panes.get(s.paneId).sessionId = 'different'; },
    (h, s) => { h.tab.panes.get(s.paneId).el = {}; },
    (h, s) => { s.tabId = 'other-tab'; },
    (h, s) => { s.paneId = 'other-pane'; },
    (h) => { h.state.activeTabId = 'other-tab'; },
  ];
  for (const mutate of mutations) {
    const h = harness(), { s, target } = connectedTarget(h);
    mutate(h, s);
    rejected(h.getCommandBlockTarget());
    for (const execute of [true, false]) {
      rejected(h.commandBlockTargetStatus(target, 'echo safe'));
      rejected(await h.submitCommandBlock(target, 'echo safe', { execute }));
    }
    assert.equal(h.calls.length, 0);
    assert.equal(s.collectOutput, false);
  }
});

test('confirmation requires closed modal, and same-target focus alone does not invalidate it', async () => {
  const h = harness(), { s, target } = connectedTarget(h);
  h.setModal(true);
  rejected(await h.submitCommandBlock(target, 'echo safe'));
  assert.equal(writes(h).length, 0);
  h.activateSession(s.sessionId, { focus: false });
  h.setModal(false);
  assert.equal(h.commandBlockTargetStatus(target, 'echo safe').ok, true);
  assert.equal((await h.submitCommandBlock(target, 'echo safe')).ok, true);
  assert.equal(writes(h).length, 1);
  assert.equal(h.state.activeId, s.sessionId);
});

test('switching away and back via sessions, empty panes or chrome-only tab activation invalidates confirmation', async () => {
  for (const switchTarget of ['session', 'empty-pane', 'tab']) {
    const h = harness(), { s, target } = connectedTarget(h);
    h.setModal(true);
    if (switchTarget === 'session') {
      const other = h.addSession(); other.status = 'connected';
      h.activateSession(other.sessionId, { focus: false });
    } else if (switchTarget === 'empty-pane') {
      h.tab.panes.set('empty', { id: 'empty', sessionId: null, el: s.pane });
      h.activatePane(h.tab.id, 'empty');
    } else {
      h.state.tabs.set('tab-b', { id: 'tab-b', el: h.tab.el, panes: new Map() });
      h.setActiveTabId('tab-b'); h.setActiveTabId(h.tab.id);
    }
    h.activateSession(s.sessionId, { focus: false });
    h.setModal(false);
    rejected(await h.submitCommandBlock(target, 'echo safe'));
    assert.equal(writes(h).length, 0);
    const refreshed = h.getCommandBlockTarget();
    assert.equal(refreshed.ok, true);
    assert.ok(refreshed.target.activationRevision > target.activationRevision);
  }
});

test('closed/replaced sessions, owners and reconnected transports cannot reuse a target', async () => {
  for (const mutation of ['close', 'replace-session', 'replace-tab', 'replace-pane', 'reconnect', 'epoch']) {
    const h = harness(), { s, target } = connectedTarget(h);
    if (mutation === 'close') { h.closeSession(s.sessionId); await Promise.resolve(); await Promise.resolve(); }
    if (mutation === 'replace-session') h.state.sessions.set(s.sessionId, { ...s });
    if (mutation === 'replace-tab') h.state.tabs.set(h.tab.id, { ...h.tab });
    if (mutation === 'replace-pane') h.tab.panes.set(s.paneId, { ...h.tab.panes.get(s.paneId) });
    if (mutation === 'epoch') s.connectionEpoch++;
    if (mutation === 'reconnect') {
      await h.disconnectSession(s.sessionId);
      assert.equal(await h.reconnectSession(s.sessionId), true);
      assert.equal(h.state.sessions.get(s.sessionId), s);
    }
    rejected(await h.submitCommandBlock(target, 'echo safe'));
    assert.equal(writes(h).length, 0);
  }
  const h = harness(), { target } = connectedTarget(h);
  for (const invalid of [null, undefined, {}, { ...target }, 'invalid']) {
    rejected(await h.submitCommandBlock(invalid, 'echo safe'));
  }
  assert.equal(writes(h).length, 0);
});

test('single-line sends exactly once to captured target, preserves whitespace and never broadcasts', async () => {
  for (const execute of [true, false]) {
    const h = harness(), { s, target } = connectedTarget(h);
    const other = h.addSession(); other.status = 'connected';
    h.state.activeId = s.sessionId;
    h.state.broadcast = new Set([s.sessionId, other.sessionId]);
    const text = '  printf "你好"   ';
    assert.equal(h.commandBlockTargetStatus(target, text).ok, true);
    assert.equal(h.calls.length, 0, 'eligibility does not send anything');
    const result = await h.submitCommandBlock(target, text, { execute });
    assert.equal(result.ok, true);
    assert.equal(writes(h).length, 1);
    assert.equal(writes(h)[0].payload.sessionId, s.sessionId);
    assert.equal(writes(h)[0].payload.data, text + (execute ? '\r' : ''));
    assert.equal(s.term.focusCount, 1); assert.equal(other.term.focusCount, 0);
    assert.equal(h.state.activeId, s.sessionId);
    assert.equal(h.state.broadcast.size, 2);
    assert.equal(histories(h).length, execute ? 1 : 0);
    assert.equal(s.lastCmd, execute ? text : '');
    assert.equal(s.collectOutput, execute);
  }
});

test('bracketed mode wraps single and multiline text once, normalizes LF/CRLF and appends Enter only for execute', async () => {
  for (const text of ['  echo one  ', 'echo one\necho two', '  echo one\r\n\t echo two  ', 'echo one\n\r\n', 'echo one\n', 'echo literal \\n stays single-line']) {
    for (const execute of [true, false]) {
      const h = harness(), { s, target } = connectedTarget(h);
      s.term.modes.bracketedPasteMode = true;
      s.lastCmd = 'previous'; s.lastOutput = 'old output'; s.collectOutput = true;
      assert.equal((await h.submitCommandBlock(target, text, { execute })).ok, true);
      assert.equal(writes(h).length, 1);
      assert.equal(writes(h)[0].payload.data, '\x1b[200~' + text.replace(/\r\n|\n/g, '\r') + '\x1b[201~' + (execute ? '\r' : ''));
      assert.equal(histories(h).length, execute ? 1 : 0);
      if (execute) {
        assert.equal(histories(h)[0].payload.cmd, text);
        assert.equal(histories(h)[0].payload.hostId, s.host.id);
        assert.equal(histories(h)[0].payload.host, 'root@example.invalid');
        assert.equal(s.lastCmd, text); assert.equal(s.lastOutput, '');
      } else {
        assert.equal(s.lastCmd, 'previous'); assert.equal(s.lastOutput, 'old output');
      }
      assert.equal(s.collectOutput, true);
    }
  }
});

test('literal TAB requires bracketed mode for execute and fill-only and is preserved without completion', async () => {
  for (const execute of [true, false]) {
    const h = harness(), { s, target } = connectedTarget(h);
    const text = "printf '<%s>\\n' 'left\tright'";
    const status = h.commandBlockTargetStatus(target, text);
    rejected(status); assert.match(status.reason, /TAB.*bracketed paste/);
    rejected(await h.submitCommandBlock(target, text, { execute }));
    assert.equal(h.calls.length, 0); assert.equal(s.histBuf, '');
    s.term.modes.bracketedPasteMode = true;
    assert.equal(h.commandBlockTargetStatus(target, text).ok, true);
    s.term.modes.bracketedPasteMode = false;
    rejected(await h.submitCommandBlock(target, text, { execute }));
    assert.equal(h.calls.length, 0);
    s.term.modes.bracketedPasteMode = true;
    assert.equal((await h.submitCommandBlock(target, text, { execute })).ok, true);
    assert.equal(writes(h).length, 1);
    assert.equal(writes(h)[0].payload.data, '\x1b[200~' + text + '\x1b[201~' + (execute ? '\r' : ''));
    if (execute) assert.equal(histories(h)[0].payload.cmd, text);
    else assert.equal(s.histBuf, text);
  }
});

test('actual newlines require bracketed mode for both execute and fill-only, including trailing newline', async () => {
  for (const execute of [true, false]) {
    for (const text of ['echo a\necho b', 'echo a\r\necho b', 'echo a\n', 'echo a\r\n']) {
      const h = harness(), { s, target } = connectedTarget(h);
      rejected(h.commandBlockTargetStatus(target, text));
      rejected(await h.submitCommandBlock(target, text, { execute }));
      assert.equal(h.calls.length, 0); assert.equal(s.collectOutput, false);
      s.term.modes.bracketedPasteMode = true;
      assert.equal(h.commandBlockTargetStatus(target, text).ok, true);
      s.term.modes.bracketedPasteMode = false;
      rejected(await h.submitCommandBlock(target, text, { execute }));
      assert.equal(h.calls.length, 0);
    }
  }
  const h = harness(), { s, target } = connectedTarget(h);
  s.term.modes = undefined;
  rejected(await h.submitCommandBlock(target, 'echo a\necho b'));
  assert.equal((await h.submitCommandBlock(target, 'echo literal \\n')).ok, true);
});

test('control injection and empty/nonstring commands are rejected without collection or writes', async () => {
  const controls = Array.from({ length: 0xa0 }, (_, code) => code)
    .filter((code) => (code < 0x20 && code !== 9 && code !== 10) || code >= 0x7f)
    .map((code) => `echo ${String.fromCharCode(code)}bad`);
  const invalidTexts = [...controls, 'echo\rnot-crlf', 'echo\r\r\n', 'echo\x1b[201~\rmalicious', '', '  \t\r\n', null, undefined, 42, {}];
  for (const execute of [true, false]) {
    const h = harness(), { s, target } = connectedTarget(h);
    s.term.modes.bracketedPasteMode = true;
    for (const text of invalidTexts) {
      rejected(h.commandBlockTargetStatus(target, text));
      rejected(await h.submitCommandBlock(target, text, { execute }));
    }
    assert.equal(h.calls.length, 0); assert.equal(s.lastCmd, ''); assert.equal(s.histBuf, '');
    assert.equal(s.collectOutput, false);
  }
});

test('execution collection starts before IPC output arrives and only claims sent, not command completion', async () => {
  const h = harness(), { s, target } = connectedTarget(h);
  s.lastOutput = 'old'; s.lastCmd = 'old command';
  let resolve;
  h.setAPI((name) => {
    if (name !== 'ssh:write') return Promise.resolve({});
    assert.equal(s.lastCmd, 'sleep 100'); assert.equal(s.lastOutput, ''); assert.equal(s.collectOutput, true);
    s.lastOutput += 'early output';
    return new Promise((r) => { resolve = r; });
  });
  const sending = h.submitCommandBlock(target, 'sleep 100');
  assert.equal(histories(h).length, 0);
  resolve({});
  assert.equal((await sending).ok, true);
  assert.equal(s.lastOutput, 'early output'); assert.equal(s.collectOutput, true);
  assert.equal(histories(h).length, 1);
});

test('write failure reports failure, never records history, and restores old collection/buffer', async () => {
  for (const execute of [true, false]) {
    const h = harness(), { s, target } = connectedTarget(h);
    s.lastCmd = 'old command'; s.lastOutput = 'old output'; s.collectOutput = true; s.histBuf = 'typed prefix';
    h.setAPI(async () => { throw new Error('write failed'); });
    rejected(await h.submitCommandBlock(target, 'echo safe', { execute }));
    assert.equal(writes(h).length, 1); assert.equal(histories(h).length, 0);
    assert.equal(s.lastCmd, 'old command'); assert.equal(s.lastOutput, 'old output');
    assert.equal(s.collectOutput, true); assert.equal(s.histBuf, 'typed prefix');
    assert.equal(s.term.focusCount, 0);
  }
});

test('late write completion never changes activeId or steals focus after switch/modal/reconnect', async () => {
  for (const change of ['switch', 'modal', 'reconnect']) {
    const h = harness(), { s, target } = connectedTarget(h);
    const other = h.addSession(); other.status = 'connected'; h.state.activeId = s.sessionId;
    let resolve;
    h.setAPI((name) => name === 'ssh:write' ? new Promise((r) => { resolve = r; }) : Promise.resolve({}));
    const sending = h.submitCommandBlock(target, 'echo safe');
    if (change === 'switch') h.activateSession(other.sessionId, { focus: false });
    if (change === 'modal') h.setModal(true);
    if (change === 'reconnect') { await h.disconnectSession(s.sessionId); await h.reconnectSession(s.sessionId); }
    const activeId = h.state.activeId;
    resolve({});
    assert.equal((await sending).ok, true, 'an acknowledged write still means sent');
    assert.equal(h.state.activeId, activeId); assert.equal(s.term.focusCount, 0);
    assert.equal(writes(h).length, 1); assert.equal(histories(h).length, 1);
  }
});

test('fill-only integrates with manual Enter without paste framing or per-line history', async () => {
  const h = harness();
  const s = h.createInputSession({ id: 'host-a', host: 'example.invalid', username: 'root', port: 22 });
  s.status = 'connected'; s.term.modes.bracketedPasteMode = true;
  const target = h.getCommandBlockTarget().target;
  const text = 'echo one\r\n  echo two';
  assert.equal((await h.submitCommandBlock(target, text, { execute: false })).ok, true);
  assert.equal(histories(h).length, 0); assert.equal(s.collectOutput, false);
  s.term.data('\r');
  assert.equal(histories(h).length, 1);
  assert.equal(histories(h)[0].payload.cmd, 'echo one\n  echo two');
  assert.equal(s.lastCmd, 'echo one\n  echo two'); assert.equal(s.collectOutput, true);
  assert.equal(s.histBuf, '');
  assert.equal(writes(h).length, 2); assert.equal(writes(h)[1].payload.data, '\r');
});

test('manual onData preserves trimming, chunked history, collection, modal/readonly gating and broadcast', async () => {
  const h = harness();
  const s = h.createInputSession({ id: 'host-a', host: 'example.invalid', username: 'root', port: 22 });
  const other = h.addSession(); other.status = 'connected';
  h.state.activeId = s.sessionId; s.status = 'connected';
  h.state.broadcast = new Set([s.sessionId, other.sessionId]);
  s.term.data('  echo '); s.term.data('one\r echo two\r');
  assert.deepEqual(histories(h).map((c) => c.payload.cmd), ['echo one', 'echo two']);
  assert.equal(s.lastCmd, 'echo two'); assert.equal(s.collectOutput, true); assert.equal(s.lastOutput, '');
  assert.equal(writes(h).length, 4);
  assert.deepEqual(writes(h).map((c) => c.payload.sessionId), [s.sessionId, other.sessionId, s.sessionId, other.sessionId]);
  s.readOnly = true; s.term.data('blocked\r');
  s.readOnly = false; h.setModal(true); s.term.data('blocked\r');
  assert.equal(writes(h).length, 4); assert.equal(histories(h).length, 2);
  assert.equal(s.histBuf, '');
  h.setModal(false);
  const target = h.getCommandBlockTarget().target;
  assert.equal((await h.submitCommandBlock(target, 'echo block')).ok, true);
  s.term.data('echo after\r');
  assert.deepEqual(histories(h).map((c) => c.payload.cmd), ['echo one', 'echo two', 'echo block', 'echo after']);
  assert.equal(writes(h).length, 7, 'block writes once, subsequent manual input still broadcasts');
});

// ---- 备用屏幕(alt screen)与命令采集 ----

// openTerminal 注册的 DEC 私有模式 CSI 钩子(?1049/?47/?1047 的 set/reset)。
const csiHandlers = (s, final) => s.term.parser.csi
  .filter(([id]) => id.prefix === '?' && id.final === final)
  .map(([, fn]) => fn);

test('TUI 备用屏幕期间的按键不进命令采集,快捷键不再拼进下一条命令', () => {
  const h = harness();
  const s = h.createInputSession({ id: 'host-a', host: 'example.invalid', username: 'root', port: 22 });
  s.status = 'connected'; h.state.activeId = s.sessionId;
  s.term.data('top\r');
  assert.equal(s.lastCmd, 'top');
  for (const fn of csiHandlers(s, 'h')) assert.equal(fn([1049]), false, '不吞事件,xterm 仍要切换'); // top 切入备用屏幕
  assert.equal(s.inAltScreen, true);
  assert.equal(s.histBuf, '');
  s.term.data('MDCCC');      // top 交互快捷键,无回车
  s.term.data('q');          // 退出键
  s.term.data(':wq\r');      // 即便出现回车(vim 的 :wq)也不是命令
  assert.equal(s.lastCmd, 'top');
  assert.deepEqual(histories(h).map((c) => c.payload.cmd), ['top']);
  for (const fn of csiHandlers(s, 'l')) fn([1049]); // top 退出,还屏
  assert.equal(s.inAltScreen, false);
  s.term.data('llll\r');     // 真正的错误命令
  assert.equal(s.lastCmd, 'llll');
  assert.equal(s.collectOutput, true);
  assert.deepEqual(histories(h).map((c) => c.payload.cmd), ['top', 'llll']);
});

test('altScreen 钩子识别 47/1047 老模式与多参数组合,无关模式不触发', () => {
  const h = harness();
  const s = h.createInputSession({ id: 'host-a', host: 'example.invalid', username: 'root', port: 22 });
  s.status = 'connected'; h.state.activeId = s.sessionId;
  const enter = csiHandlers(s, 'h'), leave = csiHandlers(s, 'l');
  assert.equal(enter.length, 1); assert.equal(leave.length, 1);
  enter[0]([2004]);
  assert.equal(s.inAltScreen, false, 'bracketed paste 等其它私有模式不触发');
  enter[0]([47]);            // 老式 smcup
  assert.equal(s.inAltScreen, true);
  leave[0]([47]);
  assert.equal(s.inAltScreen, false);
  enter[0]([1049, 2004]);    // 多模式合在一条 CSI
  assert.equal(s.inAltScreen, true);
  assert.equal(s.histBuf, '');
});

test('setAltScreen 幂等,仅进入备用屏幕时清 histBuf', () => {
  const h = harness(), s = h.addSession();
  s.histBuf = 'partial';
  h.setAltScreen(s, true);
  assert.equal(s.inAltScreen, true);
  assert.equal(s.histBuf, '');
  s.histBuf = 'stuck';
  h.setAltScreen(s, true);   // 重复进入不清
  assert.equal(s.histBuf, 'stuck');
  h.setAltScreen(s, false);  // 退出不动 histBuf(TUI 期间按键从未入库)
  assert.equal(s.inAltScreen, false);
  assert.equal(s.histBuf, 'stuck');
});

// 回归:创建文件分屏时 makePaneEl 必须先回填 pane.el 再调 buildFilePane。
// 曾经 pane.el = makePaneEl(...) 在返回后才赋值,buildFilePane 读到空 el 直接
// 返回 —— 文件分屏只剩 ✕/⤢ 两个按钮,内容永远空白(用户截图症状)。
test('makePaneEl 构建文件分屏前已回填 pane.el', () => {
  const h = harness();
  const pane = { id: 'pane-file', kind: 'file' };
  h.makePaneEl('pane-file', 'tab-a', 'file', pane);
  assert.equal(h.__buildFilePaneCalls.length, 1);
  assert.equal(h.__buildFilePaneCalls[0], true, 'buildFilePane 调用时 pane.el 必须已就绪');
  assert.ok(pane.el, 'pane 对象应持有创建出的元素引用');
  assert.equal(pane.el.dataset.pane, 'pane-file');
});
