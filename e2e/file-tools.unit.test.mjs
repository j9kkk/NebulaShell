// Focused in-memory module tests. No SSH, network, downloads or real file operations.
// Run: node --experimental-vm-modules --test e2e/file-tools.unit.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() {
    this.children = [];
    this.elements = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.style = {};
    this.offsetWidth = 420;
    this.offsetHeight = 100;
    this.getBoundingClientRect = () => ({ top: 1200, bottom: 1226, left: 1600, right: 1626 });
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      contains: (n) => this.classes.has(n),
      toggle: (n, force) => {
        const add = force ?? !this.classes.has(n);
        add ? this.classes.add(n) : this.classes.delete(n);
        return add;
      },
    };
  }
  set innerHTML(value) { this.html = value; this.children = []; this.elements.clear(); }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...kids) { kids.forEach((k) => this.appendChild(k)); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, new Element());
    return this.elements.get(selector);
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute() {}
  async fire(name, event = { target: { classList: { contains: () => false }, closest: () => null } }) {
    return this.listeners.get(name)?.(event);
  }
  after() {}
  focus() {}
  select() {}
  close() {}
  remove() {}
  showModal() {}
}

async function harness(moduleName, { invoke = async () => [], write = async () => true, confirm = async () => true, trusted = async () => ({ ok: true }) } = {}) {
  const toasts = [];
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const state = {
    sessions: new Map(), activeId: null, hosts: [],
    settings: { snippets: [] },
    tabs: new Map(), activeTabId: 'tab-1', tabSeq: 0, paneSeq: 0,
  };
  const calls = [];
  const api = async (channel, payload) => {
    calls.push({ channel, payload });
    return invoke(channel, payload);
  };
  const events = new Map();
  const document = { createElement: () => new Element(), body: new Element(), getElementById: () => null, addEventListener: () => {}, dispatchEvent: () => {} };
  const context = vm.createContext({
    console, document, setTimeout, clearTimeout, Blob, URL,
    crypto: { randomUUID: () => 'test-uuid-' + Math.random() },
    Event: class { constructor(type) { this.type = type; } },
    window: {
      nebula: { on: (name, fn) => { events.set(name, fn); return () => events.delete(name); } },
      innerWidth: 1700, innerHeight: 1300,
      addEventListener: () => {},
    },
  });
  const imports = {
    './core.js': { $, api, state, askConfirm: confirm, askPrompt: async () => null, copyText: async () => true, toast: (...args) => toasts.push(args),
      showCtxMenu: () => {}, makeDraggable: () => {}, openModal: () => {}, closeModal: () => {},
      setModalDismissHandler: (element, handler) => { element.dismiss = handler; },
      hasOpenModal: () => false, stripFpMark: (s) => String(s || '').replace(/\[NB-FP [^\]]+\]/, '').trim(),
      applyAccelTitles: () => {} },
    './hosts.js': { escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;') },
    // SVG 图标注册表:vm 桩给最小实现(占位 svg 串),测试只断言结构不断言图形
    '../shared/icons.js': { icon: (name) => `<svg data-icon="${name}"></svg>`, ICON_NAMES: ['stub'] },
    // 历史填入 / 常用命令执行走 feedTrusted(可信输入,与 AI 命令块同一条发送路径)
    './terminal.js': { writeSessionInput: write, feedTrusted: trusted },
    // file-transfer.js 由 e2e 覆盖真实链路;单测里用记录型桩,断言任务注册发生过
    './file-transfer.js': {
      registerUploadTask: ({ names }) => {
        calls.push({ channel: 'task:registerUpload', payload: { names } });
        return { taskId: 'up-stub', isCancelled: () => false, cancelRest: () => {}, mark: () => {}, finish: () => {} };
      },
      registerDownloadTask: ({ name }) => {
        calls.push({ channel: 'task:registerDownload', payload: { name } });
        return { taskId: 'dl-stub', done: () => {}, failed: () => {}, cancelled: () => {} };
      },
      registerTreeDownloadTask: ({ names, localRoot }) => {
        calls.push({ channel: 'task:registerTreeDownload', payload: { names, localRoot } });
        return { taskId: 'dt-stub', isCancelled: () => false, finish: () => {}, failed: () => {}, cancelled: () => {} };
      },
      taskProgressFromEvent: () => false,
      wasRecentDrag: () => false,
      submitCopyTask: async (params) => { calls.push({ channel: 'task:submitCopy', payload: params }); return {}; },
    },
    './interaction.js': { popupPosition: () => ({ left: 100, top: 200 }) },
    // SVG 图标注册表:sftp.js/file-transfer.js 动态拼图标,单测只要 svg 串存在
    '../shared/icons.js': { icon: (name) => `<svg data-icon="${name}"></svg>` },
    // sftp.js 右键菜单标签用 accelOf 渲染快捷键提示;单测断言不涉及具体键位
    './keymap.js': { accelOf: () => '⌘A', matchAction: () => false, accelSpec: (s) => s },
    // file-transfer.js 引 sftp.js 的窗格查找;任务中心单测用不到,给空实现
    './sftp.js': {
      findFilePane: () => null, filePaneFromEl: () => null,
      paneSession: () => null, refreshFilePanesFor: () => {},
    },
  };
  const module = new vm.SourceTextModule(await readFile(new URL(`../src/modules/${moduleName}.js`, import.meta.url), 'utf8'), { context });
  await module.link(async (specifier) => {
    const values = imports[specifier];
    assert.ok(values, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const ElementClass = Element;
  const connect = (id, cwd = '/') => {
    const session = { sessionId: id, status: 'connected', host: { id, name: id, username: 'u', host: id, port: 22 }, lastFileDir: cwd, tabId: 'tab-' + id };
    state.sessions.set(id, session);
    state.activeId = id;
    // 每个会话一个标签(与真实模型一致:一个标签 = 一台主机;分屏同属一个标签)
    if (!state.tabs.has(session.tabId)) {
      state.tabs.set(session.tabId, { id: session.tabId, el: new Element(), panes: new Map(), layout: null, activePaneId: null, zoomPaneId: null, sessionId: id });
    }
    return session;
  };
  /// 建一个文件分屏(浏览状态直接长在窗格对象上;el 为桩 Element,
  /// querySelector 按选择器自动建子元素,渲染断言读这些桩)
  const mkPane = (sessionId, { cwd = null, entries = [], hist = cwd ? [cwd] : [], loading = false, stale = false } = {}) => {
    const tab = state.tabs.get('tab-' + sessionId)
      || state.tabs.get([...state.tabs.keys()][0]);
    assert.ok(tab, `tab for session ${sessionId}`);
    const pane = {
      id: 'fp-' + (++state.paneSeq),
      kind: 'file',
      el: new Element(),
      tabId: tab.id,
      ...module.namespace.createFilePaneState(),
    };
    Object.assign(pane, { cwd, entries, hist, histIdx: hist.length - 1, loading, stale, lastSessionId: sessionId });
    tab.panes.set(pane.id, pane);
    tab.activePaneId = pane.id;
    return pane;
  };
  return { module: module.namespace, state, $, calls, events, connect, mkPane, document, toasts, Element: ElementClass };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('directory switch keeps committed cwd until success; loading pane rejects destructive ops', async () => {
  const list = deferred();
  const h = await harness('sftp', { invoke: (channel) => channel === 'sftp:list' ? list.promise : [] });
  h.connect('a', '/old-a');
  const pane = h.mkPane('a', { cwd: '/old-a' });
  const target = h.module.paneSnapshot(pane);
  assert.equal(target.sessionId, 'a');
  // 目录切换成功提交前,浏览状态不被半途清空,破坏性操作禁用
  const loading = h.module.loadFileDir(pane, '/new-a');
  await Promise.resolve();
  assert.equal(pane.cwd, '/old-a', '旧目录保留到新目录提交');
  assert.equal(h.module.isFilePaneCurrent(target), false, '加载中禁用破坏性操作');
  list.reject(new Error('denied'));
  assert.equal(await loading, false);
  assert.equal(pane.cwd, '/old-a', '失败后保留原目录');
  assert.equal(h.module.isFilePaneCurrent(h.module.paneSnapshot(pane)), true, '失败回退后原目录仍可用');
});

test('out-of-order listings commit to the latest transaction only (per pane)', async () => {
  const requests = [];
  const h = await harness('sftp', { invoke: (channel) => {
    if (channel !== 'sftp:list') return [];
    const request = deferred(); requests.push(request); return request.promise;
  } });
  h.connect('a', '/');
  const pane = h.mkPane('a', { cwd: '/' });
  const first = h.module.loadFileDir(pane, '/first');
  const second = h.module.loadFileDir(pane, '/second');
  requests[1].resolve({ path: '/second', entries: [] });
  assert.equal(await second, true);
  requests[0].resolve({ path: '/first', entries: [] });
  assert.equal(await first, false);
  assert.equal(pane.cwd, '/second');
});

test('failed history navigation rolls back the cursor and preserves committed directory', async () => {
  const h = await harness('sftp', { invoke: async (channel) => {
    if (channel === 'sftp:list') throw new Error('missing');
    return [];
  } });
  h.connect('a', '/two');
  const pane = h.mkPane('a', { cwd: '/two', hist: ['/one', '/two'] });
  assert.equal(await h.module.fileNavBack(pane), false);
  assert.equal(pane.histIdx, 1);
  assert.equal(pane.cwd, '/two');
});

test('upload queue freezes paths, session and cwd across awaits and serializes queues', async () => {
  const gate = deferred();
  let uploads = 0;
  const h = await harness('sftp', { invoke: async (channel) => {
    if (channel === 'sftp:upload') { if (++uploads === 1) await gate.promise; return { remotePath: '/dest/result', skipped: false }; }
    return [];
  } });
  h.connect('a', '/dest-a');
  h.connect('b', '/dest-b');
  const paneA = h.mkPane('a', { cwd: '/dest-a' });
  const paths = ['/local/one', '/local/two'];
  const targetA = h.module.paneSnapshot(paneA);
  assert.equal(targetA.sessionId, 'a');
  const first = h.module.uploadLocalPaths(paths, targetA);
  paths[1] = '/mutated';
  await Promise.resolve();
  // 第二个队列固定到另一台主机的分屏:队列互不串目标(分屏各属各标签)
  const paneB = h.mkPane('b', { cwd: '/dest-b' });
  const second = h.module.uploadLocalPaths(['/local/three'], h.module.paneSnapshot(paneB));
  gate.resolve();
  await first;
  await second;
  const sent = h.calls.filter((c) => c.channel === 'sftp:upload').map((c) => c.payload);
  assert.deepEqual(sent.map((p) => [p.sessionId, p.remoteDir, p.localPath, p.conflictPolicy]), [
    ['a', '/dest-a', '/local/one', 'error'], ['a', '/dest-a', '/local/two', 'error'], ['b', '/dest-b', '/local/three', 'error'],
  ]);
  // 两个目标分屏都仍然有效:各刷新一次,且刷新只落在自己的目标上
  const refreshed = h.calls.filter((c) => c.channel === 'sftp:list');
  assert.deepEqual(refreshed.map((c) => [c.payload.sessionId, c.payload.path]), [['a', '/dest-a'], ['b', '/dest-b']]);
  // 每个队列都注册了任务中心条目
  assert.equal(h.calls.filter((c) => c.channel === 'task:registerUpload').length, 2);
});

test('upload conflicts offer explicit overwrite/rename/skip and cancel the remaining snapshot queue', async () => {
  for (const policy of ['skip', 'overwrite', 'rename', 'cancel']) {
    const h = await harness('sftp', { invoke: async (channel, payload) => {
      if (channel !== 'sftp:upload') return [];
      if (payload.conflictPolicy === 'error') return { conflict: true, remotePath: '/dest/a' };
      return { skipped: payload.conflictPolicy === 'skip', remotePath: '/dest/a' };
    } });
    h.connect('a', '/dest');
    const pane = h.mkPane('a', { cwd: '/dest' });
    const upload = h.module.uploadLocalPaths(['/local/one', '/local/two'], h.module.paneSnapshot(pane));
    for (let i = 0; i < 20 && !h.document.body.children.length; i++) await Promise.resolve();
    const sheet = h.document.body.children[0];
    assert.ok(sheet, `sheet created for ${policy}`);
    const buttons = sheet.querySelector('.modal-foot').children;
    assert.equal(buttons[0].dataset.policy, 'skip');
    sheet.querySelector('input').checked = true;
    // 决策期间连接其它主机不能改投目标(快照固定 sessionId/cwd)
    h.connect('b', '/other');
    await buttons.find((b) => b.dataset.policy === policy).fire('click');
    const results = await upload;
    const calls = h.calls.filter((c) => c.channel === 'sftp:upload');
    assert.ok(calls.every((c) => c.payload.sessionId === 'a' && c.payload.remoteDir === '/dest'));
    if (policy === 'cancel') {
      assert.equal(calls.length, 1);
      assert.ok(results.every((r) => r.cancelled));
    } else {
      assert.deepEqual(calls.map((c) => c.payload.conflictPolicy), ['error', policy, policy]);
      assert.equal(results.length, 2);
      assert.equal(results[0].skipped, policy === 'skip');
    }
  }
});

test('delete confirmation resolves transport from the pane, not from global focus', async () => {
  const confirmation = deferred();
  const h = await harness('sftp', { confirm: () => confirmation.promise, invoke: async () => ({ skipped: false }) });
  h.connect('a', '/original');
  h.connect('b', '/unrelated');
  const pane = h.mkPane('a', { cwd: '/original' });
  // 活动会话是 b,但分屏在 a 的标签里:通道解析必须落回 a(同标签回退)
  const remove = h.module.removeEntry({ name: 'delete.txt', dir: false }, pane);
  confirmation.resolve(true);
  await remove;
  const deleted = h.calls.find((c) => c.channel === 'sftp:remove').payload;
  assert.equal(deleted.sessionId, 'a');
  assert.equal(deleted.path, '/original/delete.txt');
});

test('rename integration rejects switched targets and traversal names', async () => {
  const h = await harness('sftp');
  h.connect('a', '/original');
  const pane = h.mkPane('a', { cwd: '/original' });
  h.module.startRename({ name: 'source' }, pane);
  await assert.rejects(h.module.commitFileRename('../escape', pane), /名称/);
  // 分屏切换目录后,针对旧目录的重命名必须拒绝(目标快照失效)
  pane.cwd = '/other';
  await assert.rejects(h.module.commitFileRename('new', pane), /目录已切换/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.module.validEntryName('a\\b'), false);
  assert.equal(h.module.validEntryName('a\0b'), false);
});

test('panes of the same session are isolated viewports: concurrent listings commit to their own pane only', async () => {
  const requests = [];
  const h = await harness('sftp', { invoke: (channel) => {
    if (channel !== 'sftp:list') return [];
    const request = deferred(); requests.push(request); return request.promise;
  } });
  h.connect('a', '/a-dir');
  const pa = h.mkPane('a', { cwd: '/a-dir' });
  const pb = h.mkPane('a', { cwd: '/a-dir' });
  // 同标签内两个文件分屏并发列目录,响应乱序:各自提交到自己的窗格
  const la = h.module.loadFileDir(pa, '/x');
  const lb = h.module.loadFileDir(pb, '/y');
  assert.equal(requests.length, 2);
  requests[1].resolve({ path: '/y', entries: [{ name: 'b-file', dir: false, size: 1 }] });
  requests[0].resolve({ path: '/x', entries: [{ name: 'a-file', dir: false, size: 2 }] });
  assert.equal(await la, true);
  assert.equal(await lb, true);
  assert.deepEqual(pa.entries.map((e) => e.name), ['a-file']);
  assert.deepEqual(pb.entries.map((e) => e.name), ['b-file']);
  assert.equal(pa.cwd, '/x');
  assert.equal(pb.cwd, '/y');
});

test('browse state lives on the pane: navigating one pane never touches another; lastFileDir tracks the session', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const h = await harness('sftp', { invoke: async (channel, payload) => {
    if (channel === 'sftp:list') return { path: payload.path, entries: [] };
    return [];
  } });
  const s = h.connect('a', '/a-dir');
  const pa = h.mkPane('a', { cwd: '/a-dir', hist: ['/', '/a-dir'] });
  const pb = h.mkPane('a', { cwd: '/a-dir' });
  // 在 pa 上导航:pb 的浏览状态不受影响(状态长在窗格上)
  await h.module.loadFileDir(pa, '/a-dir/child');
  await tick();
  assert.equal(pa.cwd, '/a-dir/child');
  assert.equal(pb.cwd, '/a-dir');
  assert.deepEqual(pb.hist, ['/a-dir']);
  // 会话记忆目录由提交写入(新开分屏的初始目录来源)
  assert.equal(s.lastFileDir, '/a-dir/child');
});

test('progress events route to the matching pane and never leak across panes', async () => {
  const h = await harness('sftp', { invoke: async () => ({ path: '/', entries: [] }) });
  h.connect('a', '/da');
  h.connect('b', '/db');
  const pa = h.mkPane('a', { cwd: '/da' });
  const pb = h.mkPane('b', { cwd: '/db' });
  h.module.routeProgress({ sessionId: 'a', op: 'upload', name: 'f.bin', remoteDir: '/da', pct: 42 });
  // 底部状态栏已移除:进度写入窗格数据 statusText,不再渲染 DOM
  const statusOf = (pane) => pane.statusText;
  assert.equal(statusOf(pa), '上传 f.bin 42%');
  assert.equal(statusOf(pb), '');
  // 目录不匹配(pb 正看着 /db)的进度不写入
  h.module.routeProgress({ sessionId: 'b', op: 'upload', name: 'x', remoteDir: '/elsewhere', pct: 10 });
  assert.equal(statusOf(pb), '');
});

test('all sessions of a tab down -> pane grays out; any session back -> auto refresh', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const h = await harness('sftp', { invoke: async (channel, payload) => {
    if (channel === 'sftp:list') return { path: payload.path, entries: [{ name: 'rebuilt', dir: false, size: 1 }] };
    return [];
  } });
  const s = h.connect('a', '/dir');
  const pane = h.mkPane('a', { cwd: '/dir' });
  const tab = h.state.tabs.get('tab-a');
  // 标签内会话断开(手动断开路径也走 syncFilePanesForSession)
  s.status = 'disconnected';
  h.module.syncFilePanesForSession('a');
  assert.equal(pane.stale, true);
  assert.match(pane.statusText, /已断开/);
  // 重连:清灰显并按原目录自动刷新
  s.status = 'connected';
  h.module.syncFilePanesForSession('a');
  await tick();
  assert.equal(pane.stale, false);
  assert.equal(pane.cwd, '/dir');
  assert.deepEqual(pane.entries.map((e) => e.name), ['rebuilt']);
});

test('task terminal state refreshes only panes still browsing the target dir', async () => {
  const requests = [];
  const h = await harness('sftp', { invoke: (channel, payload) => {
    if (channel !== 'sftp:list') return [];
    const request = deferred(); requests.push(request); return request.promise;
  } });
  h.connect('a', '/same');
  const pSame = h.mkPane('a', { cwd: '/same' });
  const pOther = h.mkPane('a', { cwd: '/other' });
  h.module.refreshFilePanesFor('a', '/same');
  // 只有仍在浏览目标目录的分屏被刷新
  assert.equal(requests.length, 1);
  assert.equal(h.calls.find((c) => c.channel === 'sftp:list').payload.path, '/same');
});

// 发送、可用性判定与焦点归还都在 terminal.js 的 submitCommandBlock(见 terminal.test.mjs);
// 这里只断言页面走可信路径、参数正确,失败时把原因告诉用户。
test('snippet page executes through the trusted command path and reports why it was declined', async () => {
  const sent = [];
  let result = { ok: false, reason: '目标会话处于只读模式' };
  const h = await harness('monitor', { trusted: async (...args) => { sent.push(args); return result; } });
  h.connect('a');
  h.state.settings.snippets = [{ name: 'snippet', cmd: 'echo safe' }];
  h.module.renderSnippets();
  const row = h.$('#snippet-list').children[0];
  await row.fire('click');
  assert.deepEqual(h.toasts, [['目标会话处于只读模式', 'error']], 'declined input surfaces the reason');
  result = { ok: true };
  await row.fire('click');
  assert.equal(h.toasts.length, 1);
  // 选项对象建在 vm 上下文里(另一套原型),按 JSON 比较
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['echo safe', { execute: true }], ['echo safe', { execute: true }]]);
  assert.equal(h.calls.length, 0, 'no direct ssh:write bypass');
});

test('history page fills the terminal through the trusted path without Enter and reports failures', async () => {
  const sent = [];
  let result = { ok: false, reason: '目标会话未连接' };
  const h = await harness('tools', { invoke: async () => [{ cmd: 'echo history', host: 'a' }], trusted: async (...args) => { sent.push(args); return result; } });
  h.connect('a');
  await h.module.renderHistory('');
  const row = h.$('#hist-list').children[0];
  await row.fire('click');
  assert.deepEqual(h.toasts, [['目标会话未连接', 'error']]);
  result = { ok: true };
  await row.fire('click');
  assert.equal(h.toasts.length, 1);
  assert.deepEqual(sent, [['echo history'], ['echo history']], 'fill only: no execute option, no Enter');
  assert.equal(h.calls.some((c) => c.channel === 'ssh:write'), false);
});

test('batch detail and exported results retain output and explicitly flag backend truncation', async () => {
  const h = await harness('tools');
  const output = '<unsafe>\n' + 'x'.repeat(5000) + '\n';
  const result = { hostId: 'a', output, error: 'oops [NB-FP key|old|new]', truncated: true, originalChars: 9999, code: 2 };
  const detail = h.module.batchResultText(result);
  assert.ok(detail.includes(output));
  assert.match(detail, /已截断/);
  assert.match(detail, /9999/);
  assert.ok(!detail.includes('[NB-FP'));
  const exported = JSON.parse(h.module.serializeBatchResults([result]));
  assert.equal(exported[0].output, output);
  assert.equal(exported[0].code, 2);
  assert.equal(exported[0].truncated, true);
  const bytes = h.module.batchResultText({ ...result, originalBytes: 12345, retainedBytes: 5009, originalChars: 5009 });
  assert.match(bytes, /原始 12345 字节/);
  assert.ok(!bytes.includes('原始 5009 字符'), 'retained char count is not claimed as original');
});

test('batch snapshots form values, filters unrelated progress, deduplicates and reconciles final results', async () => {
  const response = deferred();
  const h = await harness('tools', { invoke: (channel) => channel === 'batch:exec' ? response.promise : [] });
  h.state.hosts.push(
    { id: 'a', name: 'alpha', username: 'root', host: '10.0.0.1', port: 22 },
    { id: 'b', name: 'beta', username: 'root', host: '10.0.0.2', port: 22 },
  );
  h.module.batchChecked.add('a');
  h.module.batchChecked.add('b');
  h.$('#batch-cmd').value = 'snapshot command';
  h.$('#batch-timeout').value = '12';
  h.$('#batch-parallel').value = '2';
  const running = h.module.runBatch();
  h.$('#batch-cmd').value = 'changed';
  h.module.batchChecked.clear();
  const payload = h.calls.find((c) => c.channel === 'batch:exec').payload;
  assert.equal(payload.command, 'snapshot command');
  assert.equal(payload.timeoutMs, 12000);
  assert.deepEqual([...payload.hostIds], ['a', 'b']);
  const event = h.events.get('batch:progress');
  event({ requestId: 'other', hostId: 'a', ok: true });
  event({ requestId: payload.requestId, hostId: 'unrelated', ok: true });
  assert.equal(h.module.batchResults.size, 0);
  event({ requestId: payload.requestId, hostId: 'a', ok: true, output: 'progress' });
  event({ requestId: payload.requestId, hostId: 'a', ok: true, output: 'duplicate' });
  assert.equal(h.module.batchResults.size, 1);
  response.resolve([{ requestId: payload.requestId, hostId: 'a', ok: true, output: 'authoritative' }, { requestId: payload.requestId, hostId: 'b', ok: false, cancelled: true }]);
  await running;
  assert.equal(h.module.batchResults.size, 2);
  assert.equal(h.module.batchResults.get('a').output, 'authoritative');
  assert.match(h.$('#batch-status').textContent, /1 成功 \/ 0 失败 \/ 1 取消/);
  assert.equal(h.events.has('batch:progress'), false);
});

test('forward runtime state shows actual ephemeral address, treats stopped objects as stopped', async () => {
  const h = await harness('tools');
  const rule = { bindHost: 'localhost', bindPort: 0, type: 'D' };
  const actual = h.module.forwardRuntimeView(rule, { running: true, bindHost: '::1', port: 45678 });
  assert.equal(actual.address, '[::1]:45678');
  assert.equal(actual.running, true);
  assert.equal(h.module.forwardRuntimeView(rule, { running: false }).running, false);
  assert.match(h.module.forwardRuntimeView(rule, true).address, /实际端口未知/);
});

test('multi-select: click/cmd/shift semantics and selection survives refresh intersection', async () => {
  const h = await harness('sftp', { invoke: async (channel, payload) => {
    if (channel === 'sftp:list') return { path: payload.path, entries: payload.path === '/d' ? [{ name: 'a.txt', dir: false, size: 1 }, { name: 'b.txt', dir: false, size: 2 }, { name: 'c', dir: true, size: 0 }] : [{ name: 'a.txt', dir: false, size: 1 }, { name: 'c', dir: true, size: 0 }] };
    return [];
  } });
  h.connect('a', '/d');
  const pane = h.mkPane('a', { cwd: '/d', hist: ['/d'], entries: [{ name: 'a.txt', dir: false, size: 1 }, { name: 'b.txt', dir: false, size: 2 }, { name: 'c', dir: true, size: 0 }] });
  // 单击 = 单选,锚点更新
  h.module.selectEntries(pane, pane.entries[0], 0, {});
  assert.equal(JSON.stringify(pane.selectedNames), JSON.stringify(['a.txt']));
  // ⌘ 点第三项 = 追加
  h.module.selectEntries(pane, pane.entries[2], 2, { metaKey: true });
  assert.equal(JSON.stringify(pane.selectedNames), JSON.stringify(['a.txt', 'c']));
  // Shift 从锚点(⌘ 点选后为 2)到 1 = 区间 [b.txt, c]
  h.module.selectEntries(pane, pane.entries[1], 1, { shiftKey: true });
  assert.equal(JSON.stringify(pane.selectedNames), JSON.stringify(['b.txt', 'c']));
  // 无修饰单击重置单选并把锚点移到该项;再 Shift 即从新锚点取区间
  h.module.selectEntries(pane, pane.entries[0], 0, {});
  h.module.selectEntries(pane, pane.entries[1], 1, { shiftKey: true });
  assert.equal(JSON.stringify(pane.selectedNames), JSON.stringify(['a.txt', 'b.txt']));
  // 全选 + 刷新交集:目录响应里没有 b.txt,选中集收缩
  h.module.selectAllEntries(pane);
  assert.equal(pane.selectedNames.length, 3);
  await h.module.loadFileDir(pane, '/other');
  assert.equal(JSON.stringify(pane.selectedNames), JSON.stringify(['a.txt', 'c']));
});

test('invertSelection swaps selection against current entries', async () => {
  const h = await harness('sftp', { invoke: async () => [] });
  h.connect('a', '/d');
  const pane = h.mkPane('a', { cwd: '/d' });
  pane.entries = [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c' }];
  // 部分选中 → 反选 = 补集(保持 entries 顺序)
  h.module.selectEntries(pane, pane.entries[0], 0, {});
  h.module.invertSelection(pane);
  assert.equal(JSON.stringify(pane.selectedNames), JSON.stringify(['b.txt', 'c']));
  // 全选 → 反选 = 清空
  h.module.selectAllEntries(pane);
  h.module.invertSelection(pane);
  assert.equal(pane.selectedNames.length, 0);
  // 空选 → 反选 = 全选
  h.module.invertSelection(pane);
  assert.equal(pane.selectedNames.length, 3);
});

test('multi-download routes single files to save dialog and batches to folder picker', async () => {
  const pickDir = deferred();
  const h = await harness('sftp', { invoke: async (channel, payload) => {
    if (channel === 'dialog:saveFile') return '/tmp/saved-single.bin';
    if (channel === 'dialog:pickDirectory') return pickDir.promise;
    if (channel === 'sftp:download') return { localPath: payload.localPath };
    if (channel === 'sftp:downloadTree') return { done: 2, skipped: 1, failed: 0, cancelled: false };
    return [];
  } });
  h.connect('a', '/d');
  const pane = h.mkPane('a', { cwd: '/d' });
  // 单文件 → 旧链路(sftp:download),不弹目录选择
  await h.module.downloadEntry({ name: 'a.txt', dir: false }, pane);
  assert.ok(h.calls.some((c) => c.channel === 'sftp:download' && c.payload.remotePath === '/d/a.txt'));
  assert.ok(!h.calls.some((c) => c.channel === 'sftp:downloadTree'));
  // 多选(含目录) → 目录选择 + downloadTree 逐项;任务中心注册了批量条目
  Object.assign(pane, { selectedNames: ['a.txt', 'c'], entries: [{ name: 'a.txt', dir: false, size: 1 }, { name: 'c', dir: true, size: 0 }] });
  const batch = h.module.downloadEntry(null, pane);
  pickDir.resolve('/tmp/dl-root');
  await batch;
  const trees = h.calls.filter((c) => c.channel === 'sftp:downloadTree');
  assert.deepEqual(trees.map((c) => c.payload.remotePath), ['/d/a.txt', '/d/c']);
  assert.ok(trees.every((c) => c.payload.localPath === '/tmp/dl-root'));
  assert.ok(h.calls.some((c) => c.channel === 'task:registerTreeDownload' && c.payload.names.join() === 'a.txt,c'));
  // 删除也支持多选
  pane.selectedNames = ['a.txt', 'c'];
  const removed = h.module.removeEntry(null, pane);
  await removed;
  const removes = h.calls.filter((c) => c.channel === 'sftp:remove');
  assert.equal(JSON.stringify(removes.map((c) => [c.payload.path, c.payload.isDir])), JSON.stringify([['/d/a.txt', false], ['/d/c', true]]));
});

// 回归:任务中心浮层必须挂在 body 上(fixed 定位),不能留在 #statusbar 里 ——
// #statusbar 有 overflow-y:hidden 且是定位锚,浮层弹到状态栏上方会被整体裁掉,
// 表现为"点击 ⇅ 无反应"。⇅ 按钮宽度也要能容纳"图标+徽标"。
test('task popover re-parents to body, positions on open, toggles with tasks', async () => {
  const h = await harness('file-transfer');
  h.module.bindTransferUi();
  const pop = h.$('#file-task-popover');
  assert.equal(pop.parentElement, h.document.body, '浮层必须移出状态栏挂到 body');
  assert.ok(h.$('#btn-file-tasks-status').classes.has('hidden'), '无任务时入口按钮隐藏');
  h.module.registerUploadTask({ paneId: 'p1', sessionId: 'host-a', dstDir: '/', names: ['f.txt'] });
  assert.ok(!h.$('#btn-file-tasks-status').classes.has('hidden'), '有任务时入口按钮显示');
  assert.equal(h.$('#file-task-badge').textContent, '1');
  h.module.toggleTaskPopover(true);
  assert.ok(!pop.classes.has('hidden'), '有任务时浮层可打开');
  assert.equal(pop.style.left, '100px', '打开时按锚点定位');
  assert.equal(pop.style.top, '200px');
  h.module.toggleTaskPopover();
  assert.ok(pop.classes.has('hidden'), '再次点击收起');
  // 再加一个任务徽标计数 +1;完成后不再计入(徽标=进行中+需注意)
  h.module.toggleTaskPopover(true);
  assert.ok(!pop.classes.has('hidden'));
  const t2 = h.module.registerUploadTask({ paneId: 'p1', sessionId: 'host-a', dstDir: '/', names: ['g.txt'] });
  assert.equal(h.$('#file-task-badge').textContent, '2');
  t2.finish('done');
  assert.equal(h.$('#file-task-badge').textContent, '1');
});
