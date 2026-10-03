// Focused native-export adapter tests; no browser, downloads, or filesystem writes.
// Run: node --experimental-vm-modules --test tests/batch-export.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function setup(invoke) {
  const elements = new Map();
  class Element {
    constructor() {
      this.listeners = new Map(); this.disabled = false; this.children = [];
      this.value = ''; this.textContent = '';
      this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
    }
    set id(value) { elements.set(value, this); }
    set innerHTML(value) {
      for (const [, id] of String(value).matchAll(/id="([^"]+)"/g)) new Element().id = id;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    after() {}
    appendChild(child) { this.children.push(child); }
    click() { return this.listeners.get('click')?.(); }
  }
  const $ = (selector) => elements.get(selector.slice(1)) || null;
  // openBatchModal/updateBatchUi 会触达批量弹窗的全部控件,逐一注册避免 null 解引用。
  for (const id of [
    'batch-status', 'batch-hosts', 'batch-cmd', 'batch-results', 'batch-tbody',
    'batch-search', 'batch-parallel', 'batch-timeout', 'batch-parallel-err', 'batch-timeout-err',
    'batch-sel-summary', 'batch-summary', 'batch-empty', 'batch-result-detail',
    'batch-detail-title', 'batch-detail-note', 'batch-detail-output',
    'btn-batch-run', 'btn-batch-cancel', 'btn-batch-copy', 'btn-batch-export', 'btn-batch-close',
    'btn-batch-select-matched', 'btn-batch-clear-sel', 'btn-batch-detail-copy', 'btn-batch-detail-close',
  ]) new Element().id = id;
  const document = { body: new Element(), createElement: () => new Element() };
  const calls = [], toasts = [];
  const imports = {
    './core.js': {
      $, state: { hosts: [] }, api: async (channel, payload) => {
        calls.push({ channel, payload }); return invoke(channel, payload);
      },
      toast: (...args) => toasts.push(args),
      stripFpMark: (value) => String(value || '').replace(/\[NB-FP [^\]]+\]/, '').trim(),
      askConfirm() {}, closeModal() {}, copyText() {}, makeDraggable() {}, openModal() {},
    },
    './hosts.js': { escapeHtml: String },
    './terminal.js': { writeSessionInput() {} },
  };
  // Blob/URL deliberately absent: this export must go through native IPC only.
  const context = vm.createContext({ document });
  const module = new vm.SourceTextModule(await readFile(new URL('../src/modules/tools.js', import.meta.url), 'utf8'), { context });
  await module.link((specifier) => {
    const values = imports[specifier];
    assert.ok(values, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  module.namespace.openBatchModal();
  // 按钮监听集中在 bindBatchUi(生产环境由 entry boot 调用),桩里同样显式绑定。
  module.namespace.bindBatchUi();
  return { tools: module.namespace, button: $('#btn-batch-export'), calls, toasts };
}

test('export button freezes full retained JSON before native dialog and awaits success path', async () => {
  let finish;
  const dialog = new Promise((resolve) => { finish = resolve; });
  const h = await setup(() => dialog);
  const output = '中🙂\n' + 'x'.repeat(5000);
  h.tools.batchResults.set('a', {
    hostId: 'a', output, truncated: true, originalBytes: 2_000_000,
    retainedChars: 5003, outputLimitBytes: 1_048_576, code: 2,
    error: 'failed [NB-FP key|old|new]',
  });
  h.tools.batchResults.set('b', { hostId: 'b', cancelled: true, ok: false, output: '', error: '已取消' });
  const saving = h.button.click();
  assert.equal(h.button.disabled, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].channel, 'batch:exportResults');
  assert.deepEqual(Object.keys(h.calls[0].payload), ['json'], 'no user-controlled path or filename in IPC');
  const snapshot = h.calls[0].payload.json;
  h.tools.batchResults.get('a').output = 'later progress';
  h.tools.batchResults.set('c', { hostId: 'c', output: 'new result' });
  await h.button.click();
  assert.equal(h.calls.length, 1, 'duplicate dialogs are suppressed');
  assert.equal(h.toasts.length, 0, 'no premature success toast');
  const rows = JSON.parse(snapshot);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].output, output, 'not the 120-character table preview');
  assert.equal(rows[0].originalBytes, 2_000_000);
  assert.equal(rows[0].code, 2);
  assert.equal(rows[0].error, 'failed');
  assert.match(rows[0].detail, /输出已截断/);
  assert.ok(rows[0].detail.includes(output));
  assert.equal(rows[1].cancelled, true);
  finish({ path: '/temporary-test-adapter/NebulaShell-batch.json', count: 2 });
  await saving;
  assert.equal(h.button.disabled, false);
  assert.deepEqual(h.toasts, [['已导出批量结果:/temporary-test-adapter/NebulaShell-batch.json', 'success']]);
});

test('native cancellation stays quiet, re-enables button, and supports another export', async () => {
  const h = await setup(async () => null);
  // 空结果时导出按钮在 UI 上禁用;此处验证的是"有结果时"的取消与重试语义。
  h.tools.batchResults.set('a', { hostId: 'a', output: 'ok' });
  await h.button.click();
  assert.equal(h.toasts.length, 0);
  assert.equal(h.button.disabled, false);
  await h.button.click();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].payload.json, /"output": "ok"/);
});

test('native file or IPC failure toasts an error and leaves export retryable', async () => {
  for (const message of ['写入批量结果失败: permission denied', 'native invoke unavailable']) {
    const h = await setup(async () => { throw new Error(message); });
    h.tools.batchResults.set('a', { hostId: 'a', output: 'ok' });
    await h.button.click();
    assert.equal(h.button.disabled, false);
    assert.deepEqual(h.toasts, [[`导出失败:${message}`, 'error']]);
    await h.button.click();
    assert.equal(h.calls.length, 2);
  }
});
