// 全局弹层底座单元测试：overlay-position / overlay-manager / popover / core.askConflict + modalOrder 归零。
// Run: node --experimental-vm-modules --test tests/overlay-system.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { computeAnchorPosition } from '../src/shared/overlay-position.js';

// ---------------------------------------------------------------- 1. 纯定位算法

test('computeAnchorPosition: 默认向下对齐、空间不足自动翻面、交叉轴防溢出钳制', () => {
  const vp = { width: 1000, height: 700 };
  // 底部空间充足 -> bottom
  const b = computeAnchorPosition({ left: 100, right: 180, top: 80, bottom: 110 }, { width: 200, height: 150 }, vp, { placement: 'bottom', align: 'start', gap: 6 });
  assert.equal(b.placement, 'bottom');
  assert.equal(b.left, 100);
  assert.equal(b.top, 116);

  // 贴近底边 -> 自动翻转到 top
  const flipped = computeAnchorPosition({ left: 900, right: 980, top: 650, bottom: 680 }, { width: 220, height: 160 }, vp, { placement: 'bottom', align: 'end', gap: 6 });
  assert.equal(flipped.placement, 'top');
  assert.equal(flipped.top, 650 - 160 - 6);
  assert.equal(flipped.left, 980 - 220);

  // 左侧优先贴近左缘 -> 自动翻转到 right
  const sideFlip = computeAnchorPosition({ left: 20, right: 120, top: 200, bottom: 400 }, { width: 260, height: 200 }, vp, { placement: 'left', gap: 8 });
  assert.equal(sideFlip.placement, 'right');
  assert.equal(sideFlip.left, 128);
  assert.equal(sideFlip.top, 200);

  // 超宽弹层被钳在视口 margin 内
  const clamped = computeAnchorPosition({ left: -50, right: -10, top: -20, bottom: 0 }, { width: 1500, height: 900 }, vp, { margin: 8 });
  assert.equal(clamped.left, 8);
  assert.equal(clamped.top, 8);
  assert.equal(clamped.width, 984);
  assert.equal(clamped.height, 684);
});

// ---------------------------------------------------------------- 2. overlay-manager / popover / core 联动

class EventTargetStub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((x) => x.fn !== fn));
  }
  dispatch(type, ev) {
    for (const item of [...(this.listeners.get(type) || [])]) {
      if (ev._stoppedImmediate) break;
      item.fn(ev);
    }
  }
}

class ClassListStub {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...xs) { xs.forEach((x) => this.set.add(x)); }
  remove(...xs) { xs.forEach((x) => this.set.delete(x)); }
  contains(x) { return this.set.has(x); }
  toggle(x, on) { const v = on ?? !this.set.has(x); v ? this.set.add(x) : this.set.delete(x); return v; }
}

class ElementStub extends EventTargetStub {
  constructor(doc, tag = 'div', id = '') {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassListStub(this);
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.disabled = false;
    this.checked = false;
    this.offsetWidth = 220;
    this.offsetHeight = 160;
    this._rect = { left: 400, right: 480, top: 500, bottom: 530, width: 80, height: 30 };
  }
  set className(v) {
    this.classList.set = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  get className() { return [...this.classList.set].join(' '); }
  get isConnected() {
    let cur = this;
    while (cur) { if (cur === this.ownerDocument.body) return true; cur = cur.parentElement; }
    return false;
  }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
    this.parentNode = null;
  }
  contains(node) {
    for (let cur = node; cur; cur = cur.parentElement) if (cur === this) return true;
    return false;
  }
  matches(sel) {
    return sel.split(',').some((s) => {
      const t = s.trim();
      if (t.startsWith('#')) return this.id === t.slice(1);
      if (t.startsWith('.')) return this.classList.contains(t.slice(1));
      if (t === '.modal:not(.hidden)') return this.classList.contains('modal') && !this.classList.contains('hidden');
      return this.tagName.toLowerCase() === t.toLowerCase();
    });
  }
  closest(sel) {
    for (let cur = this; cur; cur = cur.parentElement) if (cur.matches?.(sel)) return cur;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (sel.split(',').some((part) => matchSimple(c, part.trim()))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  getBoundingClientRect() { return this._rect; }
  getClientRects() { return this.isConnected && !this.closest('.hidden') ? [this._rect] : []; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatch('click', makeEvent('click', this)); }
}

function matchSimple(el, sel) {
  if (sel === '.modal:not(.hidden)') return el.classList.contains('modal') && !el.classList.contains('hidden');
  if (sel === 'dialog[open]') return false;
  if (sel.includes(':not(.hidden)')) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.includes(':not(')) {
    const base = sel.split(':')[0];
    if (base && el.tagName.toLowerCase() !== base) return false;
    return !el.disabled;
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function makeEvent(type, target, extra = {}) {
  const path = [];
  for (let cur = target; cur; cur = cur.parentElement) path.push(cur);
  return {
    type, target, defaultPrevented: false, _stoppedImmediate: false, isComposing: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() { this._stoppedImmediate = true; },
    composedPath: () => path,
    ...extra,
  };
}

async function createEnv() {
  const document = new EventTargetStub();
  document.body = new ElementStub(document, 'body', 'body');
  document.activeElement = document.body;
  document.createElement = (tag) => new ElementStub(document, tag);
  document.querySelector = (sel) => document.body.querySelector(sel);
  document.querySelectorAll = (sel) => document.body.querySelectorAll(sel);
  document.getElementById = (id) => document.body.querySelector(`#${id}`);
  document.dispatchEvent = (ev) => { document.dispatch(ev.type, ev); return true; };

  const window = new EventTargetStub();
  Object.assign(window, { innerWidth: 1200, innerHeight: 800, nebula: { platform: 'linux' } });

  const context = vm.createContext({
    console, document, window, navigator: { userAgent: '' }, performance,
    Event: class { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout,
  });

  const cache = new Map();
  const load = async (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const mod = new vm.SourceTextModule(await readFile(new URL(rel, import.meta.url), 'utf8'), { context, identifier: rel });
    cache.set(rel, mod);
    return mod;
  };
  const linker = async (spec, referrer) => {
    const base = new URL(referrer.identifier, import.meta.url);
    const resolved = new URL(spec, base);
    const rel = resolved.pathname.includes('/src/shared/')
      ? `../src/shared/${resolved.pathname.split('/src/shared/')[1]}`
      : `../src/modules/${resolved.pathname.split('/src/modules/')[1]}`;
    return load(rel);
  };

  for (const rel of ['../src/modules/overlay-manager.js', '../src/modules/popover.js', '../src/modules/core.js']) {
    const m = await load(rel);
    if (m.status === 'unlinked') {
      await m.link(linker);
      await m.evaluate();
    }
  }
  return {
    document,
    window,
    overlay: cache.get('../src/modules/overlay-manager.js').namespace,
    popover: cache.get('../src/modules/popover.js').namespace,
    core: cache.get('../src/modules/core.js').namespace,
  };
}

test('overlay-manager: 同组严格互斥、父子级联关闭、点外/Esc/nebula:close-menus 统一收敛', async () => {
  const { document, overlay, popover } = await createEnv();
  overlay.bindOverlayManager();

  const container = document.createElement('div');
  document.body.appendChild(container);
  const tA = document.createElement('button'); tA.id = 't-a'; container.appendChild(tA);
  const pA = document.createElement('div'); pA.id = 'p-a'; pA.classList.add('hidden'); container.appendChild(pA);
  const tB = document.createElement('button'); tB.id = 't-b'; container.appendChild(tB);
  const pB = document.createElement('div'); pB.id = 'p-b'; pB.classList.add('hidden'); container.appendChild(pB);
  const pChild = document.createElement('div'); pChild.id = 'p-child'; pChild.classList.add('hidden'); container.appendChild(pChild);

  // 打开 A：自动挂 body，设置 aria-expanded
  popover.openAnchoredPopover({ id: 'p-a', el: pA, trigger: tA, placement: 'top', align: 'end' });
  assert.equal(pA.parentElement, document.body, 'popover 自动 reparent 到 body 防裁切');
  assert.equal(pA.classList.contains('hidden'), false);
  assert.equal(tA.getAttribute('aria-expanded'), 'true');

  // 打开子浮层 p-child（parentId = p-a）：不应关闭父层 p-a
  popover.openAnchoredPopover({ id: 'p-child', el: pChild, trigger: pA, group: null, parentId: 'p-a', placement: 'left' });
  assert.equal(pA.classList.contains('hidden'), false);
  assert.equal(pChild.classList.contains('hidden'), false);

  // 打开同组兄弟 B：自动关闭 A 并级联关闭 p-child
  popover.openAnchoredPopover({ id: 'p-b', el: pB, trigger: tB, placement: 'top' });
  assert.equal(pA.classList.contains('hidden'), true, '同组互斥关闭 A');
  assert.equal(pChild.classList.contains('hidden'), true, '父层关闭自动级联关闭子浮层');
  assert.equal(pB.classList.contains('hidden'), false);

  // Esc 关闭栈顶 B 并把焦点还给触发钮 tB
  const esc = makeEvent('keydown', document.body, { key: 'Escape' });
  document.dispatch('keydown', esc);
  assert.equal(pB.classList.contains('hidden'), true);
  assert.equal(tB.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, tB, 'Esc 归还焦点给触发钮');

  // nebula:close-menus 统一关闭所有 popover
  popover.openAnchoredPopover({ id: 'p-a', el: pA, trigger: tA });
  assert.equal(pA.classList.contains('hidden'), false);
  document.dispatchEvent({ type: 'nebula:close-menus' });
  assert.equal(pA.classList.contains('hidden'), true, 'nebula:close-menus 收起所有浮层');
});

test('modal-sub 子浮层按 Esc 仅关闭子浮层，不关闭外层模态弹窗；模态关清后 modalOrder 归零且永不超 480', async () => {
  const { document, overlay, core } = await createEnv();
  overlay.bindOverlayManager();
  core.bindModalInteractions();

  const modal = document.createElement('div');
  modal.id = 'modal-host';
  modal.className = 'modal hidden';
  const card = document.createElement('div');
  card.className = 'modal-card';
  const sub = document.createElement('div');
  sub.id = 'host-tags-menu';
  sub.className = 'tag-menu hidden';
  const inp = document.createElement('input');
  inp.id = 'host-tag-input';
  card.appendChild(inp);
  card.appendChild(sub);
  modal.appendChild(card);
  document.body.appendChild(modal);

  core.openModal(modal);
  assert.equal(modal.classList.contains('hidden'), false);
  assert.equal(modal.style.zIndex, '402');

  // 打开模态内标签下拉（注册为 modal-sub）
  sub.classList.remove('hidden');
  overlay.openOverlay({
    id: 'host-tags-menu',
    kind: 'modal-sub',
    group: 'modal-sub',
    el: sub,
    close: ({ focusTrigger } = {}) => {
      sub.classList.add('hidden');
      if (focusTrigger) inp.focus();
    },
  });

  // 第 1 次 Esc：只关子下拉，外层弹窗保持打开
  document.dispatch('keydown', makeEvent('keydown', inp, { key: 'Escape' }));
  assert.equal(sub.classList.contains('hidden'), true, '第 1 次 Esc 关闭子下拉');
  assert.equal(modal.classList.contains('hidden'), false, '外层模态弹窗必须保持打开');

  // 第 2 次 Esc：关闭外层弹窗，modalOrder 归零
  document.dispatch('keydown', makeEvent('keydown', inp, { key: 'Escape' }));
  assert.equal(modal.classList.contains('hidden'), true, '第 2 次 Esc 关闭外层模态');

  // 再次打开时 z-index 从 402 重新开始（不会无限累加压过 500 的顶栏）
  core.openModal(modal);
  assert.equal(modal.style.zIndex, '402', '全模态清空后 modalOrder 必须归零');
  core.closeModal(modal);
});

test('core.askConflict: 走标准 .modal（非原生 dialog），支持策略选择、勾选同步、Esc 取消与零 DOM 泄漏', async () => {
  const { document, overlay, core } = await createEnv();
  overlay.bindOverlayManager();
  core.bindModalInteractions();

  // 场景 1：点击按钮返回策略与 applyToAll
  const p1 = core.askConflict({
    id: 'test-conflict',
    title: '上传同名文件',
    message: '已存在 a.txt',
    checkboxLabel: '后续使用相同策略',
    checkboxChecked: false,
    cancelPolicy: 'cancel',
    buttons: [
      { policy: 'skip', label: '跳过(默认)' },
      { policy: 'overwrite', label: '覆盖', danger: true },
    ],
  });
  await Promise.resolve();
  const modal1 = document.getElementById('test-conflict');
  assert.ok(modal1, '应挂载标准 .modal 元素');
  assert.equal(modal1.tagName, 'DIV', '不得再使用原生 <dialog> Top Layer');
  assert.equal(Number(modal1.style.zIndex) < 500, true, 'z-index 低于顶栏(500)与 Toast(900)');
  modal1.querySelector('input').checked = true;
  modal1.querySelectorAll('button').find((b) => b.dataset.policy === 'overwrite').click();
  const res1 = await p1;
  assert.deepEqual({ ...res1 }, { policy: 'overwrite', applyToAll: true });
  assert.equal(document.getElementById('test-conflict'), null, '关闭后 DOM 自动清理无残留');

  // 场景 2：按 Esc 走 cancelPolicy 并自动移除 DOM
  const p2 = core.askConflict({
    id: 'test-conflict',
    title: '复制冲突',
    message: '已存在 b.txt',
    checkboxChecked: true,
    cancelPolicy: 'cancelRest',
    buttons: [{ policy: 'skip', label: '跳过' }],
  });
  await Promise.resolve();
  assert.ok(document.getElementById('test-conflict'));
  document.dispatch('keydown', makeEvent('keydown', document.body, { key: 'Escape' }));
  const res2 = await p2;
  assert.deepEqual({ ...res2 }, { policy: 'cancelRest', applyToAll: true });
  assert.equal(document.getElementById('test-conflict'), null, 'Esc 取消后 DOM 零残留');
});

test('静态模态规范防回归: 每个非命令面板模态均有头部关闭按钮、主动作按钮在右侧、无误标 primary 关闭钮', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const modalIds = [...html.matchAll(/<div\s+id="(modal-[^"]+)"\s+class="modal\b/g)].map((m) => m[1]);
  assert.ok(modalIds.length >= 14, `应扫描到全部静态模态框，实际 ${modalIds.length}`);

  const sliceModal = (id) => {
    const start = html.indexOf(`id="${id}"`);
    const next = html.indexOf('<div id="modal-', start + 1);
    const tail = html.indexOf('<div id="toasts"', start + 1);
    const end = next > 0 && (tail < 0 || next < tail) ? next : (tail > 0 ? tail : html.length);
    return html.slice(start, end);
  };

  for (const id of modalIds) {
    if (id === 'modal-palette') continue;
    const block = sliceModal(id);
    assert.ok(
      /class="(?:modal-head|io-head)/.test(block),
      `${id} 必须使用统一头部外壳 .modal-head 或 .io-head`,
    );
    assert.ok(
      /data-modal-close|aria-label="关闭"/.test(block),
      `${id} 必须在头部提供右上角关闭按钮 ✕`,
    );
  }

  // 主动作必须在右侧（取消/关闭按钮在主按钮之前）
  const checkOrder = (id, leftId, rightId) => {
    const block = sliceModal(id);
    const l = block.indexOf(`id="${leftId}"`);
    const r = block.indexOf(`id="${rightId}"`);
    assert.ok(l > 0 && r > 0 && l < r, `${id}: ${leftId} 应在 ${rightId} 左侧`);
  };
  checkOrder('modal-host', 'btn-host-cancel', 'btn-host-save');
  checkOrder('modal-cloud', 'btn-cloud-close', 'btn-cloud-import-selected');
  checkOrder('modal-batch', 'btn-batch-close', 'btn-batch-run');
  checkOrder('modal-forward', 'btn-fw-close', 'btn-fw-save');
  checkOrder('modal-settings', 'btn-keys-close', 'btn-keys-save');
  checkOrder('modal-confirm', 'btn-confirm-cancel', 'btn-confirm-ok');
  checkOrder('modal-prompt', 'btn-prompt-cancel', 'btn-prompt-ok');

  // 关于弹窗「关闭」钮不得标 primary
  const aboutBlock = sliceModal('modal-about');
  assert.equal(/id="btn-about-close"[^>]*primary/.test(aboutBlock), false, '#modal-about 关闭按钮不得误标 primary');
});
