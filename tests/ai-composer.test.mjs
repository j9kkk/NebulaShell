import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class FakeNode {
  constructor(tag = 'div', nodeType = 1) {
    this.nodeType = nodeType;
    this.tagName = nodeType === 1 ? tag.toUpperCase() : '';
    this.nodeValue = '';
    this.value = '';
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this._attrs = new Map();
    this._classes = new Set();
    this.listeners = new Map();
    this.classList = {
      add: (...xs) => xs.forEach((x) => this._classes.add(x)),
      remove: (...xs) => xs.forEach((x) => this._classes.delete(x)),
      contains: (x) => this._classes.has(x),
      toggle: (x, on) => {
        const add = on !== undefined ? !!on : !this._classes.has(x);
        if (add) this._classes.add(x); else this._classes.delete(x);
        return add;
      },
    };
  }
  get childNodes() { return this.children; }
  get className() { return [...this._classes].join(' '); }
  set className(val) {
    this._classes.clear();
    for (const c of String(val || '').split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(val) {
    if (this.nodeType === 3) {
      this.nodeValue = String(val ?? '');
    } else {
      this._text = String(val ?? '');
      this.children = [];
    }
  }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.get(k) ?? null; }
  removeAttribute(k) { this._attrs.delete(k); }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(newNode, refNode) {
    if (!newNode) return newNode;
    newNode.parentNode = this;
    const idx = this.children.indexOf(refNode);
    if (idx >= 0) this.children.splice(idx, 0, newNode);
    else this.children.push(newNode);
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
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.children.length ? this.parentNode.children[idx + 1] : null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx > 0 ? this.parentNode.children[idx - 1] : null;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    for (const n of nodes) this.appendChild(n);
  }
  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const ch of n.children || []) {
        if (sel === '.ai-chip' && ch.classList?.contains('ai-chip')) out.push(ch);
        if (sel === '.ai-chip[data-out="true"]' && ch.classList?.contains('ai-chip') && ch.dataset?.out === 'true') out.push(ch);
        if (sel === '.ai-mention-row' && ch.classList?.contains('ai-mention-row')) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
}

async function setupComposer() {
  const input = new FakeNode('div', 1);
  input.id = 'ai-input';
  const pop = new FakeNode('div', 1);
  pop.id = 'ai-mention-pop';
  pop.classList.add('hidden');
  const doc = {
    createElement: (tag) => {
      const n = new FakeNode(tag, 1);
      n.ownerDocument = doc;
      return n;
    },
    createTextNode: (txt) => {
      const n = new FakeNode('#text', 3);
      n.nodeValue = String(txt ?? '');
      n.ownerDocument = doc;
      return n;
    },
    querySelector: (sel) => {
      if (sel === '#ai-input') return input;
      if (sel === '#ai-mention-pop') return pop;
      return null;
    },
  };
  input.ownerDocument = doc;
  pop.ownerDocument = doc;

  const context = vm.createContext({
    document: doc,
    window: { document: doc },
  });
  const core = new vm.SyntheticModule(['$'], function () {
    this.setExport('$', (sel) => doc.querySelector(sel));
  }, { context });
  const overlayMgr = new vm.SyntheticModule(['openOverlay', 'closeOverlay'], function () {
    this.setExport('openOverlay', () => {});
    this.setExport('closeOverlay', () => false);
  }, { context });

  const code = await readFile(new URL('../src/modules/ai-composer.js', import.meta.url), 'utf8');
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link((spec) => ({ './core.js': core, './overlay-manager.js': overlayMgr }[spec]));
  await mod.evaluate();
  return { composer: mod.namespace, input, pop, doc };
}

test('ai-composer: 纯文本读写、清空、data-empty 与草稿往返 (P3)', async () => {
  const { composer, input } = await setupComposer();
  composer.bindComposerEvents(input);
  assert.equal(input.dataset.empty, '1');
  assert.equal(composer.getComposerText(input), '');

  composer.setComposerText('排查 nginx 502', input);
  assert.equal(input.dataset.empty, '0');
  assert.equal(composer.getComposerText(input), '排查 nginx 502');
  assert.deepEqual([...composer.getComposerMentions(input)], []);
  assert.equal(composer.getComposerDraft(input), '排查 nginx 502');

  composer.clearComposer(input);
  assert.equal(input.dataset.empty, '1');
  assert.equal(composer.getComposerText(input), '');
});

test('ai-composer: 含内联 chip 的分段序列化、mentions 提取与 scope 失效灰化 (F10/F11/F13/F21)', async () => {
  const { composer, input } = await setupComposer();
  composer.setComposerSegs([
    { type: 'text', text: '对比 ' },
    { type: 'chip', hostKey: 'h-web-01', label: 'web-prod-01' },
    { type: 'text', text: ' 和 @outside-host 的日志 ' },
    { type: 'chip', hostKey: 'h-db-02', label: 'db-prod-02' },
  ], input);

  assert.equal(composer.getComposerText(input), '对比 @web-prod-01 和 @outside-host 的日志 @db-prod-02');
  // 范围外手打的 @outside-host 是纯文本，不进 mentions
  assert.deepEqual([...composer.getComposerMentions(input)], ['h-web-01', 'h-db-02']);

  // 当 h-db-02 被移出 scope 时，对应 chip 标为 data-out="true"
  const res1 = composer.refreshComposerChipsScope(['h-web-01'], input);
  assert.equal(res1.outCount, 1);
  assert.deepEqual([...res1.outLabels], ['db-prod-02']);
  assert.deepEqual([...composer.getComposerMentions(input)], ['h-web-01'], '失效 chip 默认不计入有效 mentions');
  assert.deepEqual([...composer.getComposerMentions(input, { includeOut: true })], ['h-web-01', 'h-db-02']);

  // 重新勾回 h-db-02 后自动恢复正常态（F25）
  const res2 = composer.refreshComposerChipsScope(['h-web-01', 'h-db-02'], input);
  assert.equal(res2.outCount, 0);
  assert.deepEqual([...composer.getComposerMentions(input)], ['h-web-01', 'h-db-02']);
});

test('ai-composer: @ 触发检测、#ai-mention-pop 渲染与键盘选择插入 chip (P4 / F9)', async () => {
  const { composer, input, pop } = await setupComposer();
  const scopeHosts = [
    { hostKey: 'h-web-01', name: 'web-prod-01', address: '10.0.1.11 · root', connected: true },
    { hostKey: 'h-db-02', name: 'db-prod-02', address: '10.0.1.25 · root', connected: true },
  ];
  composer.bindComposerEvents(input, {
    getScopeHosts: () => scopeHosts,
  });

  // 1. 输入 user@host 邮箱/SSH 串不触发 @ 浮层
  composer.setComposerText('root@10.0.1.11', input);
  input.listeners.get('input')?.();
  assert.equal(composer.isMentionPopOpen(), false);

  // 2. 输入 "排查 @" 立刻触发 #ai-mention-pop，列出全部 2 台范围内主机
  composer.setComposerText('排查 @', input);
  input.listeners.get('input')?.();
  assert.equal(composer.isMentionPopOpen(), true);
  assert.equal(pop.classList.contains('hidden'), false);
  const rows = pop.querySelectorAll('.ai-mention-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].classList.contains('active'), true);

  // 3. 按 ArrowDown 切换到第 2 台（db-prod-02），按 Enter 插入 chip
  const downConsumed = composer.handleComposerKeydown({ key: 'ArrowDown', preventDefault() {} }, input);
  assert.equal(downConsumed, true);
  assert.equal(rows[1].classList.contains('active'), true);

  const enterConsumed = composer.handleComposerKeydown({ key: 'Enter', shiftKey: false, preventDefault() {} }, input);
  assert.equal(enterConsumed, true);
  assert.equal(composer.isMentionPopOpen(), false);
  assert.equal(composer.getComposerText(input), '排查 @db-prod-02 ');
  assert.deepEqual([...composer.getComposerMentions(input)], ['h-db-02']);
});
