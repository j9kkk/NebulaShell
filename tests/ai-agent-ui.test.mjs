// ai-agent-ui.js 的最小 DOM 回归：步骤行上的「停止这条命令」按钮只能有一个。
// 一次 exec 会被重发（确认卡、sudo 密码卡各一轮），stepRun 每轮都会挂按钮，
// 旧实现只摘最后一个，重试几次就在行尾叠出几个红按钮；跑完也还会留一个。
// Run: node --experimental-vm-modules --test tests/ai-agent-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const MATCH = (node, sel) => sel.split(',').map((s) => s.trim()).filter(Boolean).some((one) => {
  if (one.startsWith('.')) return node.className.split(/\s+/).includes(one.slice(1));
  return node.tagName === one;
});

class El {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attrs = {};
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
  set innerHTML(v) { this.textContent = String(v).replace(/<[^>]+>/g, ''); }
  get innerHTML() { return this._text; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') { this._text += n; continue; }
      if (!n) continue;
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.push(n);
    }
  }
  prepend(...nodes) {
    const keep = this._text;
    this._text = '';
    const first = [];
    for (const n of nodes) {
      if (typeof n === 'string') { first.push(n); continue; }
      if (!n) continue;
      if (n.parentNode) n.remove();
      n.parentNode = this;
      first.push(n);
    }
    this.children.unshift(...first.filter((x) => typeof x !== 'string'));
    this._text = first.filter((x) => typeof x === 'string').join('') + keep;
  }
  after(node) {
    const p = this.parentNode;
    if (!p || !node) return;
    if (node.parentNode) node.remove();
    node.parentNode = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, node);
  }
  before(node) {
    const p = this.parentNode;
    if (!p || !node) return;
    if (node.parentNode) node.remove();
    node.parentNode = p;
    p.children.splice(p.children.indexOf(this), 0, node);
  }
  insertBefore(node, ref) {
    if (!node) return null;
    if (!ref || ref.parentNode !== this) {
      this.append(node);
      return node;
    }
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, node);
    return node;
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    const type = typeof ev === 'string' ? ev : ev?.type;
    const event = {
      type,
      target: this,
      currentTarget: this,
      stopPropagation() {},
      preventDefault() {},
      ...(typeof ev === 'object' ? ev : {}),
    };
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  focus() {}
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (MATCH(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

async function setup() {
  const container = new El('div');
  const doc = {
    activeElement: null,
    createElement: (tag) => new El(tag),
    querySelector: () => null,
  };
  const context = vm.createContext({
    console,
    document: doc,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const load = async (path) => new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
  const icons = await load('../src/shared/icons.js');
  await icons.link(() => { throw new Error('icons 不应有依赖'); });
  await icons.evaluate();
  const core = new vm.SyntheticModule(['$', 'api'], function () {
    this.setExport('$', () => null);
    this.setExport('api', async () => ({ ok: true }));
  }, { context });
  const hosts = new vm.SyntheticModule(['escapeHtml'], function () {
    this.setExport('escapeHtml', (s) => String(s));
  }, { context });
  const ai = new vm.SyntheticModule(['threadBusy'], function () {
    this.setExport('threadBusy', () => false);
  }, { context });
  const ui = await load('../src/modules/ai-agent-ui.js');
  await ui.link((specifier) => ({
    '../shared/icons.js': icons,
    './core.js': core,
    './hosts.js': hosts,
    './ai.js': ai,
  }[specifier] ?? (() => { throw new Error('unexpected import: ' + specifier); })()));
  await ui.evaluate();
  const adapter = ui.namespace.createAgentAdapter({ mount: (node) => container.append(node) });
  return { adapter, container };
}

const step = (id) => ({ id, tool: 'exec', args: { cmd: 'sudo apt-get install -y nginx' }, status: 'running' });
const stops = (container) => container.querySelectorAll('.ai-step-stop').length;

test('一轮 exec 被重发多次（确认卡 / sudo 密码卡）也只留一个停止按钮', async () => {
  const { adapter, container } = await setup();
  const s = step('s1');
  adapter.stepStart(s);
  adapter.stepRun(s, 'run-1');
  assert.equal(stops(container), 1);
  // 用户确认、密码验错重填都会让同一步再次开跑
  adapter.stepRun(s, 'run-2');
  adapter.stepRun(s, 'run-3');
  assert.equal(stops(container), 1, '同一行不能叠出多个红按钮');
  adapter.stepEnd(s, { status: 'done', exitCode: 0, durationMs: 12 });
  assert.equal(stops(container), 0, '执行结束后停止按钮必须摘掉');
});

test('失败 / 中止的步骤也不留停止按钮', async () => {
  const { adapter, container } = await setup();
  const bad = step('s2');
  adapter.stepStart(bad);
  adapter.stepRun(bad, 'run-4');
  adapter.stepEnd(bad, { status: 'error', message: '命令不存在' });
  assert.equal(stops(container), 0);

  const abort = step('s3');
  adapter.stepStart(abort);
  adapter.stepRun(abort, 'run-5');
  adapter.stepEnd(abort, { status: 'aborted' });
  assert.equal(stops(container), 0);
});

test('不再提供「已连续执行 N 步，是否继续」这张卡', async () => {
  const { adapter } = await setup();
  assert.equal(adapter.confirmContinue, undefined);
});

test('P6 步骤行渲染 @host 胶囊并在确认卡支持切换目标主机（B1/B3）', async () => {
  const { adapter, container } = await setup();
  const s = {
    id: 's-host',
    tool: 'exec',
    hostName: 'web-prod-01',
    hostKey: 'h-web-01',
    args: { cmd: 'systemctl reload nginx', host: 'web-prod-01' },
    status: 'running',
  };
  adapter.stepStart(s);
  const badge = container.querySelector('.ai-step-host');
  assert.ok(badge, '有 hostName 时步骤行头部应挂载 .ai-step-host 胶囊');
  assert.equal(badge.textContent, '@web-prod-01');

  const confirmPromise = adapter.requestConfirm({
    step: s,
    tier: 'normal',
    cmd: 'systemctl reload nginx',
    cwd: '/etc/nginx',
    reasons: ['重载服务'],
    hostName: 'web-prod-01',
    hostKey: 'h-web-01',
    scopeHosts: [
      { hostKey: 'h-web-01', name: 'web-prod-01', address: '10.0.1.11 · root' },
      { hostKey: 'h-db-02', name: 'db-prod-02', address: '10.0.1.12 · postgres' },
    ],
  });

  const hostBtn = container.querySelector('.ai-confirm-host-btn');
  assert.ok(hostBtn, '多台可达范围时确认卡头部应渲染目标主机切换按钮');
  assert.match(hostBtn.textContent, /@web-prod-01/);

  const opts = container.querySelectorAll('.ai-confirm-host-opt');
  assert.equal(opts.length, 2);
  opts[1].dispatchEvent({ type: 'click' });
  assert.equal(badge.textContent, '@db-prod-02', '切换确认卡目标主机后步骤行胶囊应同步更新');

  const runBtn = container.querySelector('.primary');
  runBtn.dispatchEvent({ type: 'click' });
  const decision = await confirmPromise;
  assert.equal(decision.decision, 'run');
  assert.equal(decision.host, 'db-prod-02');
  assert.equal(decision.hostKey, 'h-db-02');
});
