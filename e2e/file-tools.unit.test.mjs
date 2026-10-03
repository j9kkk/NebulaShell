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
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, new Element());
    return this.elements.get(selector);
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  async fire(name, event = { target: { classList: { contains: () => false } } }) {
    return this.listeners.get(name)?.(event);
  }
  after() {}
  focus() {}
  select() {}
  close() {}
  remove() {}
  showModal() {}
}

async function harness(moduleName, { invoke = async () => [], write = async () => true, confirm = async () => true } = {}) {
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const state = {
    sessions: new Map(), activeId: null, hosts: [], historyOpen: true,
    settings: { snippets: [] },
    file: { sessionId: null, cwd: null, entries: [], hist: [], histIdx: -1, histSid: null },
  };
  const calls = [];
  const api = async (channel, payload) => {
    calls.push({ channel, payload });
    return invoke(channel, payload);
  };
  const events = new Map();
  const document = { createElement: () => new Element(), body: new Element() };
  const context = vm.createContext({
    console, document, setTimeout, clearTimeout, Blob, URL,
    window: { nebula: { on: (name, fn) => { events.set(name, fn); return () => events.delete(name); } } },
  });
  const imports = {
    './core.js': { $, api, state, askConfirm: confirm, copyText: async () => true, toast: () => {},
      showCtxMenu: () => {}, makeDraggable: () => {}, openModal: () => {}, closeModal: () => {},
      setModalDismissHandler: (element, handler) => { element.dismiss = handler; },
      stripFpMark: (s) => String(s || '').replace(/\[NB-FP [^\]]+\]/, '').trim() },
    './hosts.js': { escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;') },
    './terminal.js': { writeSessionInput: write },
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
  const connect = (id, cwd = '/') => {
    const session = { sessionId: id, status: 'connected', host: { id, name: id, username: 'u', host: id, port: 22 } };
    state.sessions.set(id, session);
    state.activeId = id;
    Object.assign(state.file, { sessionId: id, cwd, entries: [], loading: false, hist: [cwd], histIdx: 0, histSid: id });
    return session;
  };
  return { module: module.namespace, state, $, calls, events, connect, document };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('directory switch clears identity/cwd until success; failed switch leaves no usable target', async () => {
  const list = deferred();
  const h = await harness('sftp', { invoke: (channel) => channel === 'sftp:list' ? list.promise : [] });
  h.connect('a', '/old-a');
  const b = h.connect('b', '/old-a');
  h.state.file.sessionId = 'a';
  const loading = h.module.loadFileDir('/new-b', { sessionId: b.sessionId });
  assert.equal(h.state.file.cwd, null);
  assert.equal(h.state.file.sessionId, null);
  assert.equal(h.module.filePanelSession(), null);
  list.reject(new Error('denied'));
  assert.equal(await loading, false);
  assert.equal(h.state.file.cwd, null);
  assert.equal(h.module.filePanelSession(), null);
});

test('out-of-order same-session listings and stale cwd probes cannot overwrite latest transaction', async () => {
  const requests = [];
  const h = await harness('sftp', { invoke: (channel) => {
    if (channel !== 'sftp:list') return [];
    const request = deferred(); requests.push(request); return request.promise;
  } });
  h.connect('a', '/');
  const first = h.module.loadFileDir('/first');
  const second = h.module.loadFileDir('/second');
  requests[1].resolve({ path: '/second', entries: [] });
  assert.equal(await second, true);
  requests[0].resolve({ path: '/first', entries: [] });
  assert.equal(await first, false);
  assert.equal(h.state.file.cwd, '/second');
  h.connect('b', '/');
  assert.equal(await h.module.loadFileDir('/a-probed', { sessionId: 'a' }), false);
  assert.equal(requests.length, 2);
});

test('failed history navigation rolls back the cursor and preserves committed directory', async () => {
  const h = await harness('sftp', { invoke: async (channel) => {
    if (channel === 'sftp:list') throw new Error('missing');
    return [];
  } });
  h.connect('a', '/two');
  h.state.file.hist = ['/one', '/two'];
  h.state.file.histIdx = 1;
  assert.equal(await h.module.fileNavBack(), false);
  assert.equal(h.state.file.histIdx, 1);
  assert.equal(h.state.file.cwd, '/two');
});

test('upload queue freezes paths, session and cwd across awaits and serializes queues', async () => {
  const gate = deferred();
  let uploads = 0;
  const h = await harness('sftp', { invoke: async (channel) => {
    if (channel === 'sftp:upload') { if (++uploads === 1) await gate.promise; return { remotePath: '/dest/result', skipped: false }; }
    return [];
  } });
  h.connect('a', '/dest-a');
  const paths = ['/local/one', '/local/two'];
  const first = h.module.uploadLocalPaths(paths);
  paths[1] = '/mutated';
  await Promise.resolve();
  h.connect('b', '/dest-b');
  const second = h.module.uploadLocalPaths(['/local/three']);
  gate.resolve();
  await first;
  await second;
  const sent = h.calls.filter((c) => c.channel === 'sftp:upload').map((c) => c.payload);
  assert.deepEqual(sent.map((p) => [p.sessionId, p.remoteDir, p.localPath, p.conflictPolicy]), [
    ['a', '/dest-a', '/local/one', 'error'], ['a', '/dest-a', '/local/two', 'error'], ['b', '/dest-b', '/local/three', 'error'],
  ]);
  const refreshed = h.calls.filter((c) => c.channel === 'sftp:list');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].payload.sessionId, 'b', 'never refresh the switched-away queue target');
  assert.equal(refreshed[0].payload.path, '/dest-b');
});

test('upload conflicts offer explicit overwrite/rename/skip and cancel the remaining snapshot queue', async () => {
  for (const policy of ['skip', 'overwrite', 'rename', 'cancel']) {
    const h = await harness('sftp', { invoke: async (channel, payload) => {
      if (channel !== 'sftp:upload') return [];
      if (payload.conflictPolicy === 'error') return { conflict: true, remotePath: '/dest/a' };
      return { skipped: payload.conflictPolicy === 'skip', remotePath: '/dest/a' };
    } });
    h.connect('a', '/dest');
    const upload = h.module.uploadLocalPaths(['/local/one', '/local/two']);
    for (let i = 0; i < 20 && !h.document.body.children.length; i++) await Promise.resolve();
    const sheet = h.document.body.children[0];
    assert.ok(sheet, `sheet created for ${policy}`);
    const buttons = sheet.querySelector('.modal-foot').children;
    assert.equal(buttons[0].dataset.policy, 'skip');
    sheet.querySelector('input').checked = true;
    // Switching tabs while choosing a conflict cannot change the queued destination.
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

test('upload file-picker and delete confirmation snapshot the original target', async () => {
  const picker = deferred();
  const confirmation = deferred();
  const h = await harness('sftp', { confirm: () => confirmation.promise, invoke: async (channel) => {
    if (channel === 'dialog:pickAnyFile') return picker.promise;
    return { skipped: false };
  } });
  h.connect('a', '/original');
  const upload = h.module.fileUpload();
  const remove = h.module.removeEntry({ name: 'delete.txt', dir: false });
  h.connect('b', '/unrelated');
  picker.resolve(['/local/upload.txt']);
  confirmation.resolve(true);
  await Promise.all([upload, remove]);
  const sent = h.calls.find((c) => c.channel === 'sftp:upload').payload;
  assert.equal(sent.sessionId, 'a');
  assert.equal(sent.remoteDir, '/original');
  const deleted = h.calls.find((c) => c.channel === 'sftp:remove').payload;
  assert.equal(deleted.sessionId, 'a');
  assert.equal(deleted.path, '/original/delete.txt');
});

test('rename integration rejects switched targets and traversal names', async () => {
  const h = await harness('sftp');
  h.connect('a', '/original');
  h.module.startRename({ name: 'source' });
  await assert.rejects(h.module.commitFileRename('../escape'), /名称/);
  h.connect('b', '/other');
  await assert.rejects(h.module.commitFileRename('new'), /目录已切换/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.module.validEntryName('a\\b'), false);
  assert.equal(h.module.validEntryName('a\0b'), false);
});

test('snippet menu stays open if terminal shared write helper declines readonly input', async () => {
  const writes = [];
  let allow = false;
  const h = await harness('monitor', { write: async (...args) => { writes.push(args); return allow; } });
  h.connect('a');
  h.state.settings.snippets = [{ name: 'snippet', cmd: 'echo safe' }];
  h.module.renderSnippets();
  const row = h.$('#snippet-list').children[0];
  await row.fire('click');
  assert.equal(h.$('#snippet-menu').classList.contains('hidden'), false);
  allow = true;
  await row.fire('click');
  assert.equal(h.$('#snippet-menu').classList.contains('hidden'), true);
  assert.deepEqual(writes, [['a', 'echo safe\r'], ['a', 'echo safe\r']]);
  assert.equal(h.calls.length, 0, 'no direct ssh:write bypass');
});

test('history stays open if shared write helper declines input and never adds Enter', async () => {
  let allow = false;
  const writes = [];
  const h = await harness('tools', { invoke: async () => [{ cmd: 'echo history', host: 'a' }], write: async (...args) => { writes.push(args); return allow; } });
  h.connect('a');
  await h.module.renderHistory('');
  const row = h.$('#hist-list').children[0];
  await row.fire('click');
  assert.equal(h.state.historyOpen, true);
  allow = true;
  await row.fire('click');
  assert.equal(h.state.historyOpen, false);
  assert.deepEqual(writes, [['a', 'echo history'], ['a', 'echo history']]);
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
