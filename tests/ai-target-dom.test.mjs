import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.value = ''; this.children = []; this.dataset = {}; this.disabled = false;
    this.parentNode = null; this.style = {};
    this._text = ''; this._html = ''; this.listeners = new Map();
    this._classes = new Set();
    this.classList = {
      add: (...items) => items.forEach((x) => this._classes.add(x)),
      remove: (...items) => items.forEach((x) => this._classes.delete(x)),
      contains: (x) => this._classes.has(x),
      toggle: (x, on) => {
        const add = on !== undefined ? Boolean(on) : !this._classes.has(x);
        if (add) this._classes.add(x); else this._classes.delete(x);
        return add;
      },
    };
  }
  get className() { return Array.from(this._classes).join(' '); }
  set className(value) {
    this._classes.clear();
    for (const c of String(value || '').split(/\s+/).filter(Boolean)) {
      this._classes.add(c);
    }
  }
  set textContent(value) { this._text = String(value); this._html = ''; }
  get textContent() { return this._text; }
  set innerHTML(value) {
    this._html = String(value);
    this._text = this._html.replace(/<[^>]+>/g, '');
    this.children = [];
  }
  get innerHTML() { return this._html; }
  appendChild(child) {
    if (child) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child);
        if (idx >= 0) child.parentNode.children.splice(idx, 1);
      }
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const span = new MockElement('span');
        span.textContent = n;
        this.appendChild(span);
      } else if (n) {
        this.appendChild(n);
      }
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(newNode, refNode) {
    if (!newNode) return newNode;
    if (newNode.parentNode) {
      const idx = newNode.parentNode.children.indexOf(newNode);
      if (idx >= 0) newNode.parentNode.children.splice(idx, 1);
    }
    newNode.parentNode = this;
    const refIdx = this.children.indexOf(refNode);
    if (refIdx >= 0) {
      this.children.splice(refIdx, 0, newNode);
    } else {
      this.children.push(newNode);
    }
    return newNode;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { this.listeners.get('click')?.({ stopPropagation: () => {}, preventDefault: () => {} }); }
  setAttribute(k, v) {
    if (!this._attrs) this._attrs = new Map();
    this._attrs.set(k, String(v));
  }
  getAttribute(k) { return this._attrs?.get(k) || null; }
  matches(selector) {
    if (!selector) return false;
    let sel = selector;
    if (sel.startsWith('.')) {
      const dotIdx = sel.indexOf('[');
      if (dotIdx === -1) return this.classList.contains(sel.slice(1));
      const cls = sel.slice(1, dotIdx);
      if (!this.classList.contains(cls)) return false;
      sel = sel.slice(dotIdx);
    }
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const m = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
    if (m) {
      const [, attr, val] = m;
      if (attr.startsWith('data-')) {
        const prop = attr.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
        const cur = this.dataset[prop];
        return val !== undefined ? cur === val : cur !== undefined;
      }
      const cur = this.getAttribute(attr);
      return val !== undefined ? cur === val : cur !== null;
    }
    return false;
  }
  querySelector(selector) {
    for (const ch of this.children) {
      if (ch.matches && ch.matches(selector)) return ch;
      const found = ch.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector) {
    const res = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.matches && ch.matches(selector)) res.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return res;
  }
}

test('renderTargetMenu 渲染会话主机范围勾选列表、支持整行点击勾选与清空 (F1/F2)', async () => {
  const root = new MockElement('div');
  root.id = 'ai-scope-menu';
  const list = new MockElement('div');
  list.id = 'ai-scope-menu-list';
  root.appendChild(list);

  const trigger = new MockElement('button');
  trigger.id = 'ai-scope-trigger';
  const triggerName = new MockElement('span');
  triggerName.id = 'ai-scope-name';
  trigger.appendChild(triggerName);

  const doc = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => (
      id === 'ai-scope-menu' ? root
        : id === 'ai-scope-menu-list' ? list
          : id === 'ai-scope-trigger' ? trigger
            : id === 'ai-scope-name' ? triggerName : null
    ),
    querySelector: (sel) => (
      sel === '#ai-scope-menu' ? root
        : sel === '#ai-scope-menu-list' ? list
          : sel === '#ai-scope-trigger' ? trigger
            : sel === '#ai-scope-name' ? triggerName
              : root.querySelector(sel)
    ),
  };

  const win = {
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const context = vm.createContext({
    window: win,
    document: doc,
    HTMLElement: MockElement,
    Element: MockElement,
    CSS: { escape: (s) => s },
  });

  const load = async (rel) => {
    const code = await readFile(new URL(rel, import.meta.url), 'utf8');
    return new vm.SourceTextModule(code, { context });
  };

  const icons = await load('../src/shared/icons.js');
  await icons.link(() => {});
  await icons.evaluate();

  const interaction = new vm.SyntheticModule(['popupPosition'], function () {
    this.setExport('popupPosition', () => ({ left: 0, top: 0, placement: 'top' }));
  }, { context });

  const core = new vm.SyntheticModule(['$', 'api'], function () {
    this.setExport('$', (sel) => doc.querySelector(sel));
    this.setExport('api', async () => ({}));
  }, { context });

  const uiMod = await load('../src/modules/ai-agent-ui.js');
  await uiMod.link((specifier) => {
    if (specifier === '../shared/icons.js') return icons;
    if (specifier === './interaction.js') return interaction;
    if (specifier === './core.js') return core;
    throw new Error('Unknown import: ' + specifier);
  });
  await uiMod.evaluate();
  const ui = uiMod.namespace;

  // 1. updateTargetBar 更新左下角主机范围按钮
  ui.updateTargetBar({
    kind: 'single',
    count: 1,
    tone: 'connected',
    displayName: 'web-prod-01',
    title: '会话可操作主机：web-prod-01',
    buttonDisabled: false,
  });
  assert.equal(triggerName.textContent, 'web-prod-01');
  assert.equal(trigger.dataset.empty, 'false');
  assert.equal(trigger.dataset.count, '1');

  // 2. renderTargetMenu 渲染主机范围勾选清单
  let toggledHost = null;
  let cleared = false;
  const handlers = {
    onToggleHost: (id) => { toggledHost = id; },
    onClearHosts: () => { cleared = true; },
  };

  ui.renderTargetMenu({
    scope: ['h1'],
    scopeCount: 1,
    totalCount: 2,
    query: '',
    hosts: [
      { hostId: 'h1', name: 'web-prod-01', address: 'root@10.0.1.11', checked: true, status: 'connected' },
      { hostId: 'h2', name: 'db-prod-02', address: 'postgres@10.0.1.12', checked: false, status: 'idle' },
    ],
  }, handlers);

  const hostRows = root.querySelectorAll('.ai-target-host');
  assert.equal(hostRows.length, 2, '渲染 2 台主机行');
  assert.equal(hostRows[0].getAttribute('role'), 'switch', '主机行是开关，不再是勾选框');
  assert.equal(hostRows[0].getAttribute('aria-checked'), 'true');
  assert.ok(hostRows[0].classList.contains('is-on'));
  assert.equal(hostRows[1].getAttribute('aria-checked'), 'false');
  // 开关外观只有 off / on / connecting / half 四种；勾选行 = on，未勾选 = off
  assert.equal(hostRows[0].querySelector('.ai-pick-sw')?.dataset.state, 'on');
  assert.equal(hostRows[1].querySelector('.ai-pick-sw')?.dataset.state, 'off');
  assert.equal(hostRows[1].querySelector('.ai-pick-sw').getAttribute('aria-hidden'), 'true', '轨道是装饰，语义在行上');

  // 3. 点击第 2 台主机行触发 onToggleHost('h2')
  hostRows[1].click();
  assert.equal(toggledHost, 'h2');

  // 4. 点击清空按钮触发 onClearHosts
  const clearBtn = root.querySelector('.ai-target-hosts-clear');
  assert.ok(clearBtn, '存在清空按钮');
  clearBtn.click();
  assert.equal(cleared, true);

  // 5. P5 / A6 重做：按目录分组 + 三态方框 + 搜索扁平化（D1–D4）
  let toggledFolder = null;
  let toggledGroup = null;
  let selectedSearchKeys = null;
  let clearedSearch = false;
  let doneClicked = false;
  const p5Handlers = {
    onToggleHost: (id) => { toggledHost = id; },
    onToggleFolderExpand: (f) => { toggledFolder = f; },
    onToggleGroup: (f, keys) => { toggledGroup = { f, keys }; },
    onSelectSearchResults: (keys) => { selectedSearchKeys = keys; },
    onClearSearch: () => { clearedSearch = true; },
    onDone: () => { doneClicked = true; },
  };

  ui.renderTargetMenu({
    scope: ['h1', 'h2', 'h5'],
    scopeCount: 3,
    selectedNames: ['web-prod-01', 'db-prod-02', 'staging-01'],
    totalCount: 6,
    groupCount: 2,
    query: '',
    hosts: [
      { hostId: 'h1', name: 'web-prod-01', group: '生产环境', address: '10.0.1.11 · root', checked: true },
      { hostId: 'h2', name: 'db-prod-02', group: '生产环境', address: '10.0.1.25 · root', checked: true },
      { hostId: 'h3', name: 'cache-redis-03', group: '生产环境', address: '10.0.1.30 · root', checked: false },
      { hostId: 'h4', name: 'mq-worker-04', group: '生产环境', address: '10.0.1.41 · root', checked: false, unreachable: true, errorText: '连接超时' },
      { hostId: 'h5', name: 'staging-01', group: '测试环境', address: '10.0.2.11 · deploy', checked: true },
      { hostId: 'h6', name: 'staging-02', group: '测试环境', address: '10.0.2.12 · deploy', checked: false },
    ],
    groups: [
      {
        name: '生产环境',
        keys: ['h1', 'h2', 'h3', 'h4'],
        hosts: [
          { hostId: 'h1', name: 'web-prod-01', group: '生产环境', address: '10.0.1.11 · root', checked: true },
          { hostId: 'h2', name: 'db-prod-02', group: '生产环境', address: '10.0.1.25 · root', checked: true },
          { hostId: 'h3', name: 'cache-redis-03', group: '生产环境', address: '10.0.1.30 · root', checked: false },
          { hostId: 'h4', name: 'mq-worker-04', group: '生产环境', address: '10.0.1.41 · root', checked: false, unreachable: true, errorText: '连接超时' },
        ],
        totalCount: 4,
        selectedCount: 2,
        state: 'part',
        expanded: true,
      },
      {
        name: '测试环境',
        keys: ['h5', 'h6'],
        hosts: [
          { hostId: 'h5', name: 'staging-01', group: '测试环境', address: '10.0.2.11 · deploy', checked: true },
          { hostId: 'h6', name: 'staging-02', group: '测试环境', address: '10.0.2.12 · deploy', checked: false },
        ],
        totalCount: 2,
        selectedCount: 1,
        state: 'part',
        expanded: false,
      },
    ],
  }, p5Handlers);

  // 常驻汇总条显示「已选 3 台」及「web-prod-01、db-prod-02 +1」
  const sumNames = root.querySelector('.ai-pick-sum-names');
  assert.equal(sumNames.textContent, 'web-prod-01、db-prod-02 +1');

  // 渲染 2 个目录行，第一个展开显示 4 台主机，第二个折叠不渲染子主机
  const dirRows = root.querySelectorAll('.ai-pick-dir');
  assert.equal(dirRows.length, 2);
  assert.equal(root.querySelectorAll('.ai-pick-host').length, 4);

  // 点击目录行触发 onToggleFolderExpand，点击三态方框触发 onToggleGroup
  dirRows[1].click();
  assert.equal(toggledFolder, '测试环境');
  // P2：目录行三态方框 → 开关（half 外观 + checkbox 的 mixed 语义）
  const dirBoxes = root.querySelectorAll('.ai-pick-dir-sw');
  assert.equal(dirBoxes[0].dataset.state, 'half');
  assert.equal(dirBoxes[0].getAttribute('role'), 'checkbox');
  assert.equal(dirBoxes[0].getAttribute('aria-checked'), 'mixed');
  dirBoxes[0].click();
  assert.equal(toggledGroup.f, '生产环境');
  assert.deepEqual([...toggledGroup.keys], ['h1', 'h2', 'h3', 'h4']);

  // P2：主机行开关只有 off / on / connecting / half 四种外观；
  // error / dropped 一律按 off 渲染，不再有专属类名与专属配色。
  const swOf = (id) => root.querySelector(`.ai-pick-host[data-host-id="${id}"]`)?.querySelector('.ai-pick-sw');
  assert.equal(swOf('h1').dataset.state, 'on', '已勾选 → on');
  assert.equal(swOf('h3').dataset.state, 'off', '未勾选 → off');
  assert.equal(swOf('h4').dataset.state, 'off', '不可达主机也按 off 渲染');
  assert.ok(!/[\s"]error[\s"]/.test(swOf('h4').className), '不得给失败行开关加 error 类');
  assert.ok(!/[\s"]dropped[\s"]/.test(swOf('h4').className), '不得给断线行开关加 dropped 类');
  assert.equal(root.querySelectorAll('.ai-pick-box').length, 0, '旧勾选框节点已移除');

  // 点击底栏「完成」按钮触发 onDone
  root.querySelector('.ai-pick-done').click();
  assert.equal(doneClicked, true);

  // 搜索态（D2）：扁平展示 + 面包屑 + 全选结果
  ui.renderTargetMenu({
    scope: ['h1'],
    scopeCount: 1,
    totalCount: 6,
    groupCount: 2,
    query: 'prod',
    hosts: [
      { hostId: 'h1', name: 'web-prod-01', group: '生产环境', address: '10.0.1.11 · root', checked: true },
      { hostId: 'h2', name: 'db-prod-02', group: '生产环境', address: '10.0.1.25 · root', checked: false },
    ],
  }, p5Handlers);
  assert.equal(root.querySelectorAll('.ai-pick-dir').length, 0, '搜索态不显示目录行');
  assert.equal(root.querySelectorAll('.ai-pick-host').length, 2, '搜索态扁平显示匹配主机');
  assert.equal(root.querySelector('.ai-pick-crumb').textContent, '生产环境 ›');
  root.querySelector('.ai-pick-select-results').click();
  assert.deepEqual([...selectedSearchKeys], ['h1', 'h2']);
  root.querySelector('.ai-pick-qx').click();
  assert.equal(clearedSearch, true);
});
