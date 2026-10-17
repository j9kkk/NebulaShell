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
  click() { this.listeners.get('click')?.({ stopPropagation: () => {} }); }
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

test('TargetMenu 顶层模式为 Radio 单选卡片交互，且就地更新保留节点身份', async () => {
  const root = new MockElement('div');
  root.id = 'ai-target-menu';
  const list = new MockElement('div');
  list.id = 'ai-target-menu-list';
  root.appendChild(list);

  const doc = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => (id === 'ai-target-menu' ? root : id === 'ai-target-menu-list' ? list : null),
    querySelector: (sel) => (sel === '#ai-target-menu' ? root : sel === '#ai-target-menu-list' ? list : root.querySelector(sel)),
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
    this.setExport('popupPosition', () => ({ left: 0, top: 0, placement: 'bottom' }));
  }, { context });

  const core = new vm.SyntheticModule(['$', 'api'], function () {
    this.setExport('$', (sel) => doc.querySelector(sel));
    this.setExport('api', async () => ({}));
  }, { context });

  const hosts = new vm.SyntheticModule(['escapeHtml'], function () {
    this.setExport('escapeHtml', (s) => s);
  }, { context });

  const ai = new vm.SyntheticModule(['threadBusy'], function () {
    this.setExport('threadBusy', () => false);
  }, { context });

  const uiMod = await load('../src/modules/ai-agent-ui.js');
  await uiMod.link((specifier) => {
    if (specifier === '../shared/icons.js') return icons;
    if (specifier === './interaction.js') return interaction;
    if (specifier === './core.js') return core;
    if (specifier === './hosts.js') return hosts;
    if (specifier === './ai.js') return ai;
    throw new Error('Unknown import: ' + specifier);
  });
  await uiMod.evaluate();
  const ui = uiMod.namespace;

  let selectedMode = null;
  const handlers = {
    onSelectMode: (m) => { selectedMode = m; },
  };

  // 1. 初次渲染: follow 模式选中
  const data1 = {
    linkMode: 'follow',
    chat: { checked: false },
    follow: { checked: true, hostLabel: 'server-01' },
    multi: { checked: false, showHosts: false },
  };
  ui.renderTargetMenu(data1, handlers);

  const modeRows = root.querySelectorAll('.ai-target-mode');
  assert.equal(modeRows.length, 3, '应渲染 3 个互斥模式行');

  const followRow = modeRows.find((r) => r.dataset.mode === 'follow');
  const chatRow = modeRows.find((r) => r.dataset.mode === 'chat');
  const multiRow = modeRows.find((r) => r.dataset.mode === 'multi');

  // 检查 Radio 结构
  assert.ok(followRow.querySelector('.ai-target-mode-radio'), '应包含 Radio 单选指示器');
  assert.equal(followRow.getAttribute('role'), 'menuitemradio');
  assert.equal(followRow.getAttribute('aria-checked'), 'true');
  assert.ok(followRow.classList.contains('is-on'));

  assert.equal(chatRow.getAttribute('aria-checked'), 'false');
  assert.ok(!chatRow.classList.contains('is-on'));

  // 记录节点引用，用于测试就地 patch 保留节点身份
  const followNodeBefore = followRow;

  // 2. 点击已选中的 follow 行: 单选特性保持选中，不触发反选
  selectedMode = null;
  followRow.click();
  assert.equal(selectedMode, null, '点击已选中的模式行保持选中，不反选');

  // 3. 点击未选中的 chat 行: 触发切换到 chat
  chatRow.click();
  assert.equal(selectedMode, 'chat', '点击未选中的模式行触发单选切换');

  // 4. 就地更新为 multi 模式并展示主机列表
  const data2 = {
    linkMode: 'multi',
    linkCount: 1,
    chat: { checked: false },
    follow: { checked: false },
    multi: { checked: true, showHosts: true },
    hosts: [
      { hostId: 'h1', name: 'host-1', linked: true, status: 'connected' },
      { hostId: 'h2', name: 'host-2', linked: false, status: 'idle' },
    ],
  };
  ui.renderTargetMenu(data2, handlers);

  // 断言节点未被重建（同一个 DOM 节点）
  const followRowAfter = root.querySelector('.ai-target-mode[data-mode="follow"]');
  assert.equal(followRowAfter, followNodeBefore, '就地 patch 必须保留原有 DOM 节点，确保弹性过渡');

  // 检查 multi 行激活
  const multiRowAfter = root.querySelector('.ai-target-mode[data-mode="multi"]');
  assert.equal(multiRowAfter.getAttribute('aria-checked'), 'true');
  assert.ok(multiRowAfter.classList.contains('is-on'));

  // 检查主机列表使用 Switch
  const hostRows = root.querySelectorAll('.ai-target-host');
  assert.equal(hostRows.length, 2, '多主机列表展开 2 台主机');
  assert.ok(hostRows[0].querySelector('.switch'), '主机项必须使用 Switch 开关');
});
