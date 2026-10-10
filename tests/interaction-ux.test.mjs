// Focused frontend module tests: DOM/event/observer adapters, no browser or IPC service.
// Run: node --experimental-vm-modules --test tests/interaction-ux.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class DomEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type, bubbles: false, cancelable: true, defaultPrevented: false }, init);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.immediate = true; this.stopped = true; }
}

class EventTargetAdapter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback, options = false) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    const entries = this.listeners.get(type) || [];
    if (!entries.some((entry) => entry.callback === callback && entry.capture === capture)) {
      entries.push({ callback, capture });
    }
    this.listeners.set(type, entries);
  }
  removeEventListener(type, callback, options = false) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.callback !== callback || entry.capture !== capture));
  }
  dispatchEvent(event) {
    event.target ||= this;
    const path = [];
    for (let node = this.parentNode; node; node = node.parentNode) path.push(node);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get(event.type) || [])]) {
        if (entry.capture === capture) entry.callback.call(node, event);
        if (event.immediate) break;
      }
    };
    for (const node of [...path].reverse()) {
      invoke(node, true);
      if (event.stopped) return !event.defaultPrevented;
    }
    invoke(this, true);
    if (!event.immediate) invoke(this, false);
    if (event.bubbles && !event.stopped) {
      for (const node of path) {
        invoke(node, false);
        if (event.stopped) break;
      }
    }
    return !event.defaultPrevented;
  }
}

// Only the CSS subset used by these four modules is needed (including :not and descendants).
function matchesCompound(element, selector) {
  let valid = true;
  selector = selector.replace(/:not\(([^)]+)\)/g, (_, inner) => {
    if (matchesCompound(element, inner)) valid = false;
    return '';
  });
  selector = selector.replace(/:disabled/g, () => { valid &&= element.disabled; return ''; });
  selector = selector.replace(/\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]/g, (_, name, value) => {
    valid &&= element.hasAttribute(name) && (value === undefined || element.getAttribute(name) === value);
    return '';
  });
  selector = selector.replace(/#([\w-]+)/g, (_, id) => { valid &&= element.id === id; return ''; });
  selector = selector.replace(/\.([\w-]+)/g, (_, name) => { valid &&= element.classList.contains(name); return ''; });
  return valid && (!selector || selector === '*' || element.tagName === selector.toUpperCase());
}

class Element extends EventTargetAdapter {
  constructor(document, tag = 'div') {
    super();
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = [];
    this.dataset = {}; this.attributes = new Map(); this.style = {}; this.disabled = false;
    this.inert = false; this.value = ''; this.scrollTop = 0; this._text = ''; this._className = '';
    this.rect = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 };
    const updateClass = (names) => { this.className = [...names].join(' '); };
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => classes().has(name),
      add: (...names) => { const next = classes(); names.forEach((name) => next.add(name)); updateClass(next); },
      remove: (...names) => { const next = classes(); names.forEach((name) => next.delete(name)); updateClass(next); },
      toggle: (name, force) => {
        const next = classes(); const on = force ?? !next.has(name);
        if (on) next.add(name); else next.delete(name);
        updateClass(next); return on;
      },
    };
  }
  get className() { return this._className; }
  set className(value) {
    if (this._className === String(value)) return;
    this._className = String(value); this.ownerDocument?.notifyMutation(this);
  }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', value); }
  get isConnected() { return !!this.parentNode && (this.parentNode === this.ownerDocument || this.parentNode.isConnected); }
  get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  set textContent(value) { this._text = String(value); this.children.forEach((child) => { child.parentNode = null; }); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    this.textContent = '';
    // Context menu markup consists of simple spans; no general HTML parser is needed.
    for (const match of String(value).matchAll(/<span class="([^"]+)"><\/span>/g)) {
      const span = this.ownerDocument.createElement('span'); span.className = match[1]; this.appendChild(span);
    }
  }
  setAttribute(name, value) {
    if (name === 'class') { this.className = value; return; }
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
    else this.attributes.set(name, String(value));
    if (name === 'open') this.ownerDocument.notifyMutation(this, 'attributes', [], [], name);
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] ?? null;
    if (name === 'class') return this.className;
    if (name === 'type') return this.type ?? this.attributes.get(name) ?? null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    const changed = this.attributes.delete(name);
    if (changed && name === 'open') this.ownerDocument.notifyMutation(this, 'attributes', [], [], name);
  }
  get open() { return this.hasAttribute('open'); }
  set open(value) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  showModal() {
    assert.equal(this.tagName, 'DIALOG'); this.open = true;
    (this.querySelector('button:not(:disabled), input:not(:disabled)') || this).focus();
  }
  close() {
    assert.equal(this.tagName, 'DIALOG');
    if (!this.open) return;
    this.open = false;
    queueMicrotask(() => this.dispatchEvent(new DomEvent('close')));
  }
  appendChild(child) {
    child.remove(); child.parentNode = this; this.children.push(child);
    this.ownerDocument.notifyMutation(this, 'childList', [child]);
    return child;
  }
  // toast(core.js)用 el.append(icon, body):与 appendChild 等价的桩。
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  remove() {
    const parent = this.parentNode;
    if (parent) parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
    if (parent) this.ownerDocument.notifyMutation(parent, 'childList', [], [this]);
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    return selector.split(',').some((part) => {
      const tokens = part.trim().split(/\s+(?![^\[]*\])/);
      if (!matchesCompound(this, tokens.pop())) return false;
      let ancestor = this.parentNode;
      while (tokens.length) {
        const token = tokens.pop();
        while (ancestor instanceof Element && !matchesCompound(ancestor, token)) ancestor = ancestor.parentNode;
        if (!(ancestor instanceof Element)) return false;
        ancestor = ancestor.parentNode;
      }
      return true;
    });
  }
  closest(selector) {
    for (let node = this; node instanceof Element; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get offsetWidth() { return Math.round(this.rect.width); }
  get offsetHeight() { return Math.round(this.rect.height); }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.isConnected && !this.closest('.hidden') ? [this.rect] : []; }
  focus() {
    for (let node = this; node instanceof Element; node = node.parentNode) if (node.inert) return;
    if (!this.isConnected || this.disabled || this.closest('.hidden')) return;
    if (this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new DomEvent('focusin', { bubbles: true }));
  }
  click() { if (!this.disabled) this.dispatchEvent(new DomEvent('click', { bubbles: true })); }
  scrollIntoView(options) { this.lastScroll = options; }
}

class DocumentAdapter extends EventTargetAdapter {
  constructor() {
    super(); this.children = []; this.observers = []; this.pendingMutation = false; this.mutationRecords = []; this.observerDeliveries = 0;
    this.body = new Element(this, 'body'); this.body.parentNode = this; this.children.push(this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { return new Element(this, tag); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  querySelector(selector) { return this.body.querySelector(selector); }
  getElementById(id) { return this.querySelector(`#${id}`); }
  notifyMutation(target, type = 'attributes', addedNodes = [], removedNodes = [], attributeName = 'class') {
    if (!target.isConnected || !this.observers.length) return;
    this.mutationRecords.push({ type, target, attributeName: type === 'attributes' ? attributeName : null, addedNodes, removedNodes });
    if (this.pendingMutation) return;
    this.pendingMutation = true;
    queueMicrotask(() => {
      this.pendingMutation = false; this.observerDeliveries++;
      const records = this.mutationRecords.splice(0);
      for (const callback of this.observers) callback(records);
    });
  }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const key = (target, name, init = {}) => {
  const event = new DomEvent('keydown', { key: name, bubbles: true, ...init }); target.dispatchEvent(event); return event;
};
const backdrop = (target) => target.dispatchEvent(new DomEvent('mousedown', { bubbles: true }));
const plain = (value) => JSON.parse(JSON.stringify(value));

async function setup({ platform = 'darwin', width = 800, height = 600 } = {}) {
  const document = new DocumentAdapter();
  const window = new EventTargetAdapter();
  Object.assign(window, { innerWidth: width, innerHeight: height, nebula: { platform } });
  const timers = new Map(); let timerId = 0;
  const context = vm.createContext({
    console, document, window, navigator: { userAgent: '' }, Event: DomEvent, performance,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { document.observers.push(this.callback); }
    },
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const cache = new Map();
  async function load(name) {
    // '../shared/...' 从 modules/ 出发解析;其余仍按 modules/ 内相对名
    const file = name.startsWith('../')
      ? name.replace('../', '../src/')   // '../shared/x.js' → '../src/shared/x.js'
      : `../src/modules/${name}`;
    if (!cache.has(name)) cache.set(name, new vm.SourceTextModule(
      await readFile(new URL(file, import.meta.url), 'utf8'), { context, identifier: name },
    ));
    return cache.get(name);
  }
  const entryModule = await load('menubar.js');
  await entryModule.link((specifier) => load(specifier.startsWith('../') ? specifier : specifier.replace('./', '')));
  await entryModule.evaluate();
  const core = cache.get('core.js').namespace;
  const interaction = cache.get('interaction.js').namespace;
  const commands = cache.get('commands.js').namespace;
  const menubar = entryModule.namespace;
  const add = (parent, tag, id = '', classes = '') => {
    const element = document.createElement(tag); element.id = id; element.className = classes; parent.appendChild(element); return element;
  };
  const app = add(document.body, 'main', 'app');
  const trigger = add(app, 'button', 'dialog-trigger');
  const ctx = add(document.body, 'div', 'ctx-menu', 'hidden');
  add(document.body, 'div', 'toasts');
  const confirm = add(document.body, 'div', 'modal-confirm', 'modal hidden');
  add(confirm, 'h3', 'confirm-title'); add(confirm, 'p', 'confirm-message');
  const cancelConfirm = add(confirm, 'button', 'btn-confirm-cancel');
  const okConfirm = add(confirm, 'button', 'btn-confirm-ok');
  const prompt = add(document.body, 'div', 'modal-prompt', 'modal hidden');
  add(prompt, 'h3', 'prompt-title'); add(prompt, 'p', 'prompt-message');
  const input = add(prompt, 'input', 'prompt-input');
  add(prompt, 'label', 'prompt-hint');
  const cancelPrompt = add(prompt, 'button', 'btn-prompt-cancel');
  const okPrompt = add(prompt, 'button', 'btn-prompt-ok');
  // 常驻菜单容器(role=menu):里面的命令项走菜单语义(aria-disabled 保持可聚焦、menuitemcheckbox)
  const menuBox = add(app, 'div', 'test-menu');
  menuBox.setAttribute('role', 'menu');
  const root = add(menuBox, 'div');
  core.bindModalInteractions(); trigger.focus();
  return {
    core, interaction, commands, menubar, document, window, add, timers, app, trigger, ctx,
    confirm, cancelConfirm, okConfirm, prompt, input, cancelPrompt, okPrompt, root,
  };
}

test('platform modifier preserves macOS shell Ctrl and rejects mixed/Alt application modifiers', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const { interaction, core } = await setup({ platform });
    const event = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    const appKey = platform === 'darwin' ? 'metaKey' : 'ctrlKey';
    assert.equal(interaction.isAppModifier({ ...event, [appKey]: true }, platform), true);
    assert.equal(core.isAppModifier({ ...event, [appKey]: true, shiftKey: true }), true);
    assert.equal(core.isAppModifier({ ...event, ctrlKey: true, metaKey: true }), false);
    assert.equal(core.isAppModifier({ ...event, [appKey]: true, altKey: true }), false);
    assert.equal(core.isAppModifier(event), false);
    if (platform === 'darwin') {
      for (const shellKey of ['c', 'd', 'z', 'b', 'f', 'l']) {
        assert.equal(core.isAppModifier({ ...event, ctrlKey: true, key: shellKey }), false, `Ctrl+${shellKey} belongs to the shell`);
      }
      assert.equal(core.accel('mod+shift+d'), '⌘⇧D');
    } else {
      assert.equal(core.isAppModifier({ ...event, metaKey: true }), false);
      assert.equal(core.accel('mod+shift+d'), 'Ctrl+Shift+D');
    }
  }
});

test('editable target detection includes nested contenteditable but not ordinary buttons', async () => {
  const { interaction, add, app, trigger, input } = await setup();
  const editor = add(app, 'div'); editor.setAttribute('contenteditable', 'true');
  const child = add(editor, 'span');
  assert.equal(interaction.isEditableTarget(input), true);
  assert.equal(interaction.isEditableTarget(child), true);
  assert.equal(interaction.isEditableTarget(trigger), false);
  assert.equal(interaction.isEditableTarget(null), false);
});

test('popup positioning aligns below, flips above, and clamps oversized popups and offscreen anchors', async () => {
  const { interaction } = await setup();
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(plain(interaction.popupPosition({ right: 780, top: 40, bottom: 70 }, { width: 200, height: 100 }, viewport)),
    { left: 580, top: 70, width: 200, height: 100 });
  assert.deepEqual(plain(interaction.popupPosition({ right: 900, top: 550, bottom: 580 }, { width: 200, height: 150 }, viewport)),
    { left: 592, top: 400, width: 200, height: 150 });
  assert.deepEqual(plain(interaction.popupPosition({ right: -10, top: -20, bottom: -10 }, { width: 1200, height: 900 }, viewport)),
    { left: 8, top: 8, width: 784, height: 584 });
  assert.deepEqual(plain(interaction.popupPosition({ right: 0, top: 0, bottom: 0 }, { width: 20, height: 20 }, { width: 4, height: 4 })),
    { left: 8, top: 8, width: 0, height: 0 });
});

test('confirm Enter activates the CURRENT focused button after moving from initial cancel to OK', async () => {
  const { core, document, confirm, okConfirm, cancelConfirm, trigger } = await setup();
  const result = core.askConfirm('Trust a changed fingerprint?'); await flush();
  assert.equal(document.activeElement, cancelConfirm, 'danger defaults to cancel');
  okConfirm.focus(); const event = key(okConfirm, 'Enter');
  assert.equal(event.defaultPrevented, true);
  assert.equal(await result, true);
  assert.equal(confirm.classList.contains('hidden'), true);
  assert.equal(document.activeElement, trigger);
});

test('confirm Enter cancels after moving from initial OK to cancel, including explicit safe focus', async () => {
  const { core, document, okConfirm, cancelConfirm } = await setup();
  const result = core.askConfirm('Proceed?', { danger: false }); await flush();
  assert.equal(document.activeElement, okConfirm);
  cancelConfirm.focus(); key(cancelConfirm, 'Enter');
  assert.equal(await result, false);
  const safe = core.askConfirm('Trust?', { danger: false, defaultFocus: 'cancel' }); await flush();
  assert.equal(document.activeElement, cancelConfirm);
  key(cancelConfirm, 'Enter'); assert.equal(await safe, false);
});

test('confirm ignores IME Enter, then Escape settles and releases the next queued confirm', async () => {
  const { core, document, confirm, cancelConfirm, okConfirm } = await setup();
  const first = core.askConfirm('First'); const second = core.askConfirm('Second', { danger: false });
  await flush();
  assert.equal(document.querySelector('#confirm-message').textContent, 'First');
  const composed = key(cancelConfirm, 'Enter', { isComposing: true });
  assert.equal(composed.defaultPrevented, false);
  assert.equal(confirm.classList.contains('hidden'), false);
  key(cancelConfirm, 'Escape'); assert.equal(await first, false); await flush();
  assert.equal(document.querySelector('#confirm-message').textContent, 'Second');
  okConfirm.click(); assert.equal(await second, true);
  assert.equal((confirm.listeners.get('keydown') || []).length, 0);
});

test('prompt Escape cancels sensitive input and the queued prompt accepts a fresh value', async () => {
  const { core, document, input, prompt, okPrompt } = await setup();
  const first = core.askPrompt('Password'); const second = core.askPrompt('Name', { password: false, placeholder: 'name' });
  await flush(); input.value = 'secret';
  key(input, 'Escape'); assert.equal(await first, null); await flush();
  assert.equal(document.querySelector('#prompt-message').textContent, 'Name');
  assert.equal(input.value, ''); assert.equal(input.type, 'text'); assert.equal(input.placeholder, 'name');
  input.value = 'new name'; okPrompt.click(); assert.equal(await second, 'new name');
  assert.equal(input.value, ''); assert.equal(prompt.classList.contains('hidden'), true);
  assert.equal((input.listeners.get('keydown') || []).length, 0);
  assert.equal((okPrompt.listeners.get('click') || []).length, 0);
});

test('prompt backdrop dismissal settles its promise, ignores inside clicks, and does not stall its queue', async () => {
  const { core, input, prompt, cancelPrompt, okPrompt } = await setup();
  const first = core.askPrompt('First'); const second = core.askPrompt('Second'); await flush();
  backdrop(input); assert.equal(prompt.classList.contains('hidden'), false);
  backdrop(prompt); assert.equal(await first, null); await flush();
  input.value = 'second'; key(input, 'Enter'); assert.equal(await second, 'second');
  cancelPrompt.click(); okPrompt.click(); assert.equal(core.hasOpenModal(), false, 'stale handlers cannot reopen or resettle dialogs');
});

test('prompt validation keeps the modal open and composing Enter cannot submit', async () => {
  const { core, document, input, prompt } = await setup();
  const result = core.askPrompt('Required', { validate: (value) => value.trim() ? null : 'Value is required' }); await flush();
  key(input, 'Enter'); assert.equal(prompt.classList.contains('hidden'), false);
  assert.equal(document.querySelector('#toasts').children[0].querySelector('.toast-body').textContent, 'Value is required');
  input.value = 'valid'; key(input, 'Enter', { isComposing: true });
  assert.equal(prompt.classList.contains('hidden'), false);
  key(input, 'Enter'); assert.equal(await result, 'valid');
});

test('nested modals inert the app and lower modal, then restore each previous focus in order', async () => {
  const { core, document, app, trigger, confirm, prompt, cancelConfirm, input } = await setup();
  core.openModal(confirm);
  assert.equal(app.inert, true); assert.equal(confirm.inert, false); assert.equal(prompt.inert, true);
  assert.equal(document.body.classList.contains('modal-open'), true);
  assert.equal(confirm.getAttribute('role'), 'dialog');
  assert.equal(confirm.getAttribute('aria-modal'), 'true');
  assert.equal(confirm.getAttribute('aria-labelledby'), 'confirm-title');
  cancelConfirm.focus(); core.openModal(prompt);
  assert.equal(core.topModal(), prompt); assert.equal(confirm.inert, true); assert.equal(prompt.inert, false);
  assert.ok(Number(prompt.style.zIndex) > Number(confirm.style.zIndex));
  trigger.focus(); assert.equal(document.activeElement, input, 'inert app cannot steal modal focus');
  core.closeModal(prompt);
  assert.equal(document.activeElement, cancelConfirm); assert.equal(confirm.inert, false); assert.equal(app.inert, true);
  core.closeModal(confirm);
  assert.equal(app.inert, false); assert.equal(document.activeElement, trigger);
  assert.equal(document.body.classList.contains('modal-open'), false);
});

test('modal Tab wraps in both directions and closing a lower modal cannot steal focus from the top', async () => {
  const { core, document, confirm, prompt, cancelConfirm, okConfirm, input, okPrompt } = await setup();
  core.openModal(confirm);
  okConfirm.focus(); assert.equal(key(okConfirm, 'Tab').defaultPrevented, true); assert.equal(document.activeElement, cancelConfirm);
  key(cancelConfirm, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, okConfirm);
  core.openModal(prompt); core.closeModal(confirm);
  assert.equal(core.topModal(), prompt); assert.equal(prompt.contains(document.activeElement), true);
  okPrompt.focus(); key(okPrompt, 'Tab'); assert.equal(document.activeElement, input);
  core.closeModal(prompt); assert.equal(core.hasOpenModal(), false);
});

test('class-revealed legacy modal gets dialog scope through the observer without repeated reopen', async () => {
  const { core, document, add, app, trigger } = await setup();
  const legacy = add(document.body, 'div', 'legacy-modal', 'modal hidden');
  const heading = add(legacy, 'h3'); add(legacy, 'button');
  legacy.classList.remove('hidden'); await flush();
  assert.equal(core.topModal(), legacy); assert.equal(app.inert, true);
  assert.equal(legacy.getAttribute('aria-labelledby'), heading.id); assert.equal(heading.id, 'legacy-modal-title');
  const order = legacy.dataset.modalOrder; const deliveries = document.observerDeliveries;
  await flush(); assert.equal(legacy.dataset.modalOrder, order); assert.equal(document.observerDeliveries, deliveries);
  core.closeModal(legacy); await flush(); assert.equal(document.activeElement, trigger); assert.equal(app.inert, false);
});

test('directly hiding a prompt settles cancellation, restores focus, and releases the queued prompt', async () => {
  const { core, document, prompt, input, trigger } = await setup();
  const first = core.askPrompt('Legacy hide'); const second = core.askPrompt('Next'); await flush();
  prompt.classList.add('hidden'); await flush(); assert.equal(await first, null);
  assert.equal(document.querySelector('#prompt-message').textContent, 'Next');
  assert.equal(document.activeElement, input);
  input.value = 'after hide'; key(input, 'Enter'); assert.equal(await second, 'after hide');
  assert.equal(document.activeElement, trigger);
});

test('observer tracks appended and removed modals and removal settles an active dialog', async () => {
  const { core, document, add, app, trigger, prompt } = await setup();
  const dynamic = document.createElement('div'); dynamic.id = 'dynamic-modal'; dynamic.className = 'modal';
  const visible = add(dynamic, 'button');
  document.body.appendChild(dynamic); await flush();
  assert.equal(core.topModal(), dynamic); assert.equal(document.activeElement, visible); assert.equal(app.inert, true);
  dynamic.remove(); await flush();
  assert.equal(core.hasOpenModal(), false); assert.equal(app.inert, false); assert.equal(document.activeElement, trigger);
  const result = core.askPrompt('Removed dialog'); await flush();
  prompt.remove(); await flush(); assert.equal(await result, null);
  assert.equal(app.inert, false); assert.equal(document.activeElement, trigger);
});

test('native dialog[open] becomes top modal and Escape cancels once before restoring underlying scope', async () => {
  const { core, document, add, app, confirm, cancelConfirm, trigger } = await setup();
  core.openModal(confirm); cancelConfirm.focus(); await flush();
  const sheet = document.createElement('dialog'); sheet.id = 'upload-conflict-dialog';
  sheet.className = 'upload-conflict';
  add(sheet, 'h3').textContent = 'Upload conflict';
  const skip = add(sheet, 'button'); skip.textContent = 'Skip (default)';
  add(sheet, 'button').textContent = 'Cancel remaining queue';
  let dismissals = 0; let settlements = 0; let closeEvents = 0; let finished = false; let resolve;
  const cancellation = new Promise((done) => { resolve = done; });
  // Match the collision sheet's idempotent finish + native close + removal lifecycle.
  const finish = (policy) => {
    if (finished) return;
    finished = true; settlements++;
    sheet.close(); sheet.remove(); resolve(policy);
  };
  sheet.addEventListener('close', () => { closeEvents++; finish('cancel'); });
  core.setModalDismissHandler(sheet, () => { dismissals++; finish('cancel'); });
  document.body.appendChild(sheet); sheet.showModal(); skip.focus(); await flush();
  assert.equal(sheet.open, true); assert.equal(sheet.matches('dialog[open]'), true);
  assert.equal(core.topModal(), sheet); assert.equal(confirm.inert, true); assert.equal(sheet.inert, false);
  assert.equal(app.inert, true); assert.equal(sheet.contains(document.activeElement), true);
  assert.equal(document.activeElement, skip, 'default collision action stays focused within native scope');
  const escape = key(document.activeElement, 'Escape');
  assert.equal(escape.defaultPrevented, true); assert.equal(await cancellation, 'cancel'); await flush();
  assert.equal(dismissals, 1); assert.equal(settlements, 1); assert.equal(closeEvents, 1);
  assert.equal(sheet.open, false); assert.equal(sheet.isConnected, false);
  assert.equal(core.topModal(), confirm); assert.equal(confirm.inert, false); assert.equal(app.inert, true);
  assert.equal(confirm.contains(document.activeElement), true, 'native close/removal returns focus to underlying modal');
  core.closeModal(sheet); await flush();
  assert.equal(dismissals, 1, 'close event and observer removal must not invoke cancellation again');
  assert.equal(settlements, 1);
  core.closeModal(confirm); await flush();
  assert.equal(app.inert, false); assert.equal(document.activeElement, trigger);
});

test('unrelated DOM churn cannot reopen a modal, move its focus, or emit modal-scope changes', async () => {
  const { core, document, add, app, confirm, okConfirm } = await setup();
  core.openModal(confirm); await flush(); okConfirm.focus();
  const order = confirm.dataset.modalOrder; let scopeEvents = 0;
  document.addEventListener('nebula:modal-scope', () => { scopeEvents++; });
  const terminal = add(app, 'div'); terminal.className = 'terminal';
  add(terminal, 'span').textContent = 'new terminal output'; terminal.classList.add('rendered');
  await flush();
  assert.equal(confirm.dataset.modalOrder, order); assert.equal(document.activeElement, okConfirm); assert.equal(scopeEvents, 0);
  core.closeModal(confirm); await flush();
});

test('command availability rejects unknown, disconnected/disabled, and modal-blocked actions without executing', async () => {
  const { core, commands, add, app, confirm } = await setup();
  let connected = false; let runs = 0;
  const split = add(app, 'button', 'btn-split'); split.dataset.command = 'split';
  commands.registerCommand('split', { label: 'Split', enabled: () => connected, reason: 'Connect first', run: () => { runs++; } });
  commands.bindCommandButtons();
  assert.equal(commands.commandState('missing'), null); assert.equal(await commands.executeCommand('missing'), false);
  assert.equal(split.disabled, true); assert.equal(split.getAttribute('aria-description'), 'Connect first');
  assert.equal(split.title, 'Connect first', 'standalone buttons surface the reason in their title');
  assert.equal(await commands.executeCommand('split'), false); assert.equal(runs, 0);
  connected = true; commands.refreshCommandStates(); assert.equal(split.disabled, false); assert.equal(split.hasAttribute('aria-description'), false);
  core.openModal(confirm); commands.refreshCommandStates();
  assert.equal(split.disabled, true); assert.equal(split.getAttribute('aria-description'), '请先关闭对话框');
  assert.equal(await commands.executeCommand('split'), false); assert.equal(runs, 0);
  core.closeModal(confirm); commands.refreshCommandStates();
  assert.equal(await commands.executeCommand('split'), true); assert.equal(runs, 1);
});

test('terminal state notifications refresh the real workspace split button after async connection', async () => {
  const { core, commands, document, window, add, app, confirm, root } = await setup();
  const tile = add(root, 'button', 'btn-tile-tabs'); tile.dataset.command = 'workspace.tile';
  add(tile, 'span', '', 'mm-label'); add(tile, 'span', '', 'mm-state');
  for (const id of ['btn-newtab', 'btn-split', 'btn-ai-toggle', 'btn-sidebar-toggle', 'btn-batch', 'btn-readonly', 'btn-log-toggle', 'btn-clear', 'btn-reconnect', 'btn-disconnect',
    'btn-add-host', 'btn-welcome-add', 'btn-cloud-import', 'btn-welcome-cloud', 'btn-split-menu', 'btn-host-manage']) add(app, 'button', id);
  add(app, 'aside', 'sidebar'); add(app, 'aside', 'ai-panel', 'hidden');
  const split = document.querySelector('#btn-split');
  const session = { status: 'connecting' };
  const state = { sessions: new Map([['session', session]]), activeId: 'session', panes: new Map(), tabs: new Map([['tab', {}]]), workspace: { mode: 'single' } };
  let capacity = 2, runs = 0;
  const context = vm.createContext({
    ...core, ...commands, document, window, state, CustomEvent: DomEvent,
    activeTab: () => ({ layout: {} }), leafCount: () => 1, maxPaneCapacity: () => capacity,
    splitActive: () => { runs++; },
    toggleTabTiling: () => { state.workspace.mode = state.workspace.mode === 'single' ? 'tiled' : 'single'; },
  });
  for (const name of ['newTabWithPicker', 'autoLayoutTab', 'closeCurrent', 'toggleFilePanel', 'reconnectSession', 'toggleReadonly', 'toggleSessionLog', 'clearActiveTerm', 'openTermSearch', 'openBroadcastPicker', 'openBatchModal', 'openForwardModal', 'openSettings', 'openFingerprints', 'openAbout', 'toggleSidebar',
    'openPalette', 'requestWindowClose', 'renameTab', 'aiDiagnose', 'openHostModal', 'openCloudImport', 'importHosts', 'exportHosts',
    'focusedPaneId', 'paneOwner', 'activateSession', 'toggleBroadcastMember', 'splitMenuItems', 'hostManageItems', 'openTabList',
    'rightPanelOpen', 'rightTabShown', 'toggleRightPanel', 'toggleRightTab', 'setRightPanel']) context[name] = () => {};
  // Execute production wiring and notifier, with adapters only for unrelated actions.
  const entrySource = await readFile(new URL('../src/modules/entry.js', import.meta.url), 'utf8');
  const terminalSource = await readFile(new URL('../src/modules/terminal.js', import.meta.url), 'utf8');
  const wiring = entrySource.match(/^function setupWorkspaceCommands\(\) \{[\s\S]*?^\}/m)?.[0];
  const notifier = terminalSource.match(/^export function notifyTerminalStateChange\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(wiring); assert.ok(notifier);
  vm.runInContext(`${wiring}\n${notifier.replace(/^export /, '')}\nsetupWorkspaceCommands();`, context);
  assert.equal(split.disabled, true);
  const tileOff = () => tile.getAttribute('aria-disabled') === 'true';
  assert.equal(tileOff(), true, 'one untiled tab cannot enable tiling');
  assert.equal(tile.disabled, false, 'menu items stay focusable while unavailable');
  assert.equal(tile.getAttribute('aria-description'), '需要至少 2 个标签');
  assert.equal(tile.getAttribute('aria-checked'), 'false');
  assert.equal(tile.querySelector('.mm-label').textContent, '标签平铺');
  assert.equal(commands.commandState('pane.reflow').label, '整理当前标签分屏');
  assert.equal(await commands.executeCommand('workspace.tile'), false);
  state.tabs.set('second', {}); vm.runInContext('notifyTerminalStateChange()', context);
  assert.equal(tileOff(), false);
  tile.click(); await flush(); assert.equal(state.workspace.mode, 'tiled');
  assert.equal(tile.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(tile.getAttribute('aria-checked'), 'true');
  assert.equal(tile.querySelector('.mm-state').textContent, '✓');
  state.tabs.delete('second'); vm.runInContext('notifyTerminalStateChange()', context);
  assert.equal(tileOff(), false, 'tiling can always be turned off, even after closing to one tab');
  core.openModal(confirm); assert.equal(tileOff(), true);
  assert.equal(await commands.executeCommand('workspace.tile'), false);
  core.closeModal(confirm); assert.equal(tileOff(), false);
  tile.click(); await flush(); assert.equal(state.workspace.mode, 'single'); assert.equal(tileOff(), true);
  split.click(); await flush(); assert.equal(runs, 0);
  session.status = 'connected';
  vm.runInContext('notifyTerminalStateChange()', context);
  assert.equal(split.disabled, false, 'connected notification must reach the command refresh listener');
  split.click(); await flush(); assert.equal(runs, 1);
  capacity = 1; vm.runInContext('notifyTerminalStateChange()', context);
  assert.equal(split.disabled, true, 'capacity still gates splitting');
  capacity = 2; vm.runInContext('notifyTerminalStateChange()', context);
  assert.equal(split.disabled, false);
  core.openModal(confirm); assert.equal(split.disabled, true);
  core.closeModal(confirm); assert.equal(split.disabled, false);
  session.status = 'disconnected'; vm.runInContext('notifyTerminalStateChange()', context);
  assert.equal(split.disabled, true, 'disconnect notification disables splitting again');
  split.click(); await flush(); assert.equal(runs, 1);
});

test('command execution synchronizes checked state and dynamic labels across toolbar and menu controls', async () => {
  const { commands, add, app, root } = await setup();
  let enabled = false; let runs = 0;
  const toolbar = add(app, 'button'); toolbar.dataset.command = 'toggle';
  const item = add(root, 'button'); item.dataset.command = 'toggle';
  const label = add(item, 'span', '', 'mm-label'); const check = add(item, 'span', '', 'mm-state');
  commands.registerCommand('toggle', {
    label: () => enabled ? 'Disable broadcast' : 'Enable broadcast', checked: () => enabled,
    run: () => { enabled = !enabled; runs++; },
  });
  commands.bindCommandButtons(); commands.bindCommandButtons();
  assert.equal(toolbar.getAttribute('aria-pressed'), 'false'); assert.equal(item.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(item.getAttribute('aria-checked'), 'false'); assert.equal(check.textContent, '');
  toolbar.click(); await flush();
  assert.equal(runs, 1, 'binding is idempotent'); assert.equal(toolbar.classList.contains('active'), true);
  assert.equal(toolbar.getAttribute('aria-pressed'), 'true'); assert.equal(item.getAttribute('aria-checked'), 'true');
  assert.equal(check.textContent, '✓'); assert.equal(label.textContent, 'Disable broadcast');
  assert.equal(await commands.executeCommand('toggle'), true);
  assert.equal(item.getAttribute('aria-checked'), 'false'); assert.equal(check.textContent, ''); assert.equal(label.textContent, 'Enable broadcast');
});

test('failed command surfaces an error and refreshes post-failure state rather than leaking a rejection', async () => {
  const { commands, document, add, app } = await setup();
  let available = true;
  const button = add(app, 'button'); button.dataset.command = 'fail';
  commands.registerCommand('fail', { enabled: () => available, run: async () => { available = false; throw new Error('SSH connection lost'); } });
  commands.bindCommandButtons(); assert.equal(await commands.executeCommand('fail'), false);
  assert.equal(button.disabled, true); assert.equal(document.querySelector('#toasts').children[0].querySelector('.toast-body').textContent, 'SSH connection lost');
  assert.equal(document.querySelector('#toasts').children[0].classList.contains('error'), true);
});

test('context popup clamps edges, skips disabled entries, and restores the invoking control on Escape', async () => {
  const { core, document, ctx, trigger } = await setup({ width: 400, height: 300 });
  core.showCtxMenu(999, 999, [{ label: 'Unavailable', disabled: true, run() {} }, '-', { label: 'Copy', key: '⌘C', checked: true, run() {} }]);
  assert.equal(ctx.style.left, '192px'); assert.equal(ctx.style.top, '192px');
  const copy = ctx.querySelectorAll('button')[1]; assert.equal(document.activeElement, copy);
  assert.equal(copy.getAttribute('role'), 'menuitemcheckbox'); assert.equal(copy.getAttribute('aria-checked'), 'true');
  key(copy, 'Escape'); assert.equal(ctx.classList.contains('hidden'), true); assert.equal(document.activeElement, trigger);
  core.showCtxMenu(-100, -100, [{ label: 'Copy', run() {} }]);
  assert.equal(ctx.style.left, '8px'); assert.equal(ctx.style.top, '8px'); core.closeCtxMenu();
});

test('context menu disabled entries carry aria-disabled + reason and ignore activation', async () => {
  const { core, ctx } = await setup();
  let runs = 0;
  core.showCtxMenu(10, 10, [{ label: 'Paste', disabled: true, reason: 'Read-only session', run() { runs++; } }, { label: 'Copy', run() {} }]);
  const [paste] = ctx.querySelectorAll('button');
  assert.equal(paste.getAttribute('aria-disabled'), 'true'); assert.equal(paste.getAttribute('aria-description'), 'Read-only session');
  paste.click(); await flush(); assert.equal(runs, 0); assert.equal(ctx.classList.contains('hidden'), false);
  core.closeCtxMenu();
});

test('every registered command with an availability condition also declares a disabled reason', async () => {
  const entry = await readFile(new URL('../src/modules/entry.js', import.meta.url), 'utf8');
  const wiring = entry.match(/^function setupWorkspaceCommands\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(wiring);
  const chunks = wiring.split('registerCommand(').slice(1);
  assert.ok(chunks.length > 10);
  for (const chunk of chunks) {
    const id = chunk.match(/^'([^']+)'/)?.[1];
    if (/\benabled:/.test(chunk)) assert.match(chunk, /\breason:/, `${id} has enabled() but no reason`);
  }
});

test('command palette modal does not block commands; other modals do, except allowInModal commands', async () => {
  const { core, commands, document, add } = await setup();
  const palette = add(document.body, 'div', 'modal-palette', 'modal hidden');
  add(palette, 'input', 'palette-input');
  const other = add(document.body, 'div', 'modal-other', 'modal hidden');
  add(other, 'button', 'other-ok');
  let runs = 0;
  commands.registerCommand('plain', { label: 'Plain', run: () => { runs++; } });
  commands.registerCommand('dlg', { label: 'Settings', kind: 'dialog', run: () => {} });
  commands.registerCommand('quit', { label: 'Quit', allowInModal: true, run: () => { runs++; } });
  assert.equal(commands.commandState('dlg').label, 'Settings…', 'dialog commands get an ellipsis');
  core.openModal(palette);
  assert.equal(commands.commandState('plain').enabled, true, 'the palette itself never disables commands');
  core.closeModal(palette);
  core.openModal(other);
  assert.equal(commands.commandState('plain').enabled, false);
  assert.equal(commands.commandState('plain').reason, '请先关闭对话框');
  assert.equal(await commands.executeCommand('plain'), false);
  assert.equal(await commands.executeCommand('quit'), true, 'quit/close-window work while a dialog is open');
  core.closeModal(other);
  assert.equal(runs, 1);
  const listed = commands.listCommands();
  const plain = listed.find((c) => c.id === 'plain');
  assert.deepEqual([plain.category, plain.kind, plain.shortcut, plain.enabled], ['app', 'action', 'plain', true]);
  assert.equal(listed.find((c) => c.id === 'dlg').kind, 'dialog');
});

test('every registered command has a category and keywords and is reachable from a menu bar (macOS or Windows/Linux)', async () => {
  const entry = await readFile(new URL('../src/modules/entry.js', import.meta.url), 'utf8');
  const { SEP, specFor, menuCommandIds } = await import('../src/shared/menu-spec.js');
  const wiring = entry.match(/^function setupWorkspaceCommands\(\) \{[\s\S]*?^\}/m)?.[0];
  const ids = [...wiring.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]);
  const mac = new Set(menuCommandIds(specFor('mac')));
  const pc = new Set(menuCommandIds(specFor('pc')));
  assert.ok(ids.length >= 30, `expected the full command list, got ${ids.length}`);
  for (const chunk of wiring.split('registerCommand(').slice(1)) {
    const id = chunk.match(/^'([^']+)'/)?.[1];
    assert.match(chunk, /\bcategory: '(app|layout|panel|session|host)'/, `${id} needs a category`);
    assert.match(chunk, /\bkeywords: \[/, `${id} needs search keywords`);
    assert.ok(mac.has(id) || pc.has(id), `${id} is missing from both menu bars`);
  }
  for (const id of new Set([...mac, ...pc])) assert.ok(ids.includes(id), `menu bar references unregistered command ${id}`);
  // 平台专属:系统预定义项只在 macOS;Windows/Linux 的复制/粘贴/全屏是窗口内菜单才有的命令
  assert.equal(JSON.stringify(specFor('pc')).includes('predefined'), false);
  for (const id of ['term.copy', 'term.paste', 'window.fullscreen']) {
    assert.equal(pc.has(id), true, `${id} in the Windows/Linux menu bar`);
    assert.equal(mac.has(id), false, `${id} not in the macOS menu bar`);
  }
  assert.deepEqual(specFor('mac').map((m) => m.submenu), ['NebulaShell', '文件', '编辑', '视图', '主机', '会话', '窗口', '帮助']);
  assert.deepEqual(specFor('pc').map((m) => m.submenu), ['文件', '编辑', '视图', '主机', '会话', '帮助']);
  // 过滤后不留首尾、连续的分隔线
  for (const platform of ['mac', 'pc']) {
    for (const menu of specFor(platform)) {
      const items = menu.items;
      assert.notEqual(items[0], SEP, `${platform} ${menu.submenu} starts with a separator`);
      assert.notEqual(items.at(-1), SEP, `${platform} ${menu.submenu} ends with a separator`);
      assert.equal(items.some((it, i) => it === SEP && items[i + 1] === SEP), false, `${platform} ${menu.submenu} has doubled separators`);
    }
  }
});
test('explicit command targets: element ctx drives state, labels and execution; menu items carry the command id', async () => {
  const { commands, add, app } = await setup();
  const seen = [];
  commands.registerCommand('pane.cmd', {
    label: (ctx) => (ctx?.paneId ? `Pane ${ctx.paneId}` : 'Focused pane'),
    enabled: (ctx) => ctx?.paneId !== 'p2', reason: (ctx) => `busy ${ctx?.paneId}`,
    checked: (ctx) => (ctx?.paneId ? ctx.paneId === 'p1' : undefined),
    run: (ctx) => { seen.push(ctx?.paneId || 'focused'); },
  });
  const make = (pane) => { const b = add(app, 'button'); b.dataset.command = 'pane.cmd'; b.dataset.cmdPane = pane; b.setAttribute('data-label-title', ''); return b; };
  const one = make('p1'); const two = make('p2');
  const direct = add(app, 'button'); direct.dataset.command = 'pane.cmd'; direct.dataset.commandDirect = '1';
  commands.bindCommandButtons();
  assert.equal(one.title, 'Pane p1'); assert.equal(one.getAttribute('aria-pressed'), 'true');
  assert.equal(two.disabled, true); assert.equal(two.title, 'Pane p2（busy p2）'); assert.equal(two.getAttribute('aria-pressed'), 'false');
  one.click(); await flush();
  direct.click(); await flush();
  assert.deepEqual(seen, ['p1'], 'element ctx reaches run(); direct buttons are not double-bound');
  assert.equal(commands.commandState('pane.cmd').checked, undefined, 'no target means not a toggle');
  const item = commands.commandMenuItem('pane.cmd', { paneId: 'p2' }, { danger: true });
  assert.deepEqual([item.command, item.label, item.disabled, item.reason, item.danger], ['pane.cmd', 'Pane p2', true, 'busy p2', true]);
  await commands.commandMenuItem('pane.cmd', { paneId: 'p3' }).run();
  assert.deepEqual(seen, ['p1', 'p3']);
  assert.equal(commands.commandMenuItem('missing'), null);
});

test('context menu items expose data-command and a check column only when a toggle is present', async () => {
  const { core, ctx } = await setup();
  core.showCtxMenu(10, 10, [{ label: 'A', command: 'cmd.a', run() {} }, '-', '-', { label: 'B', checked: false, run() {} }, '-']);
  const buttons = ctx.querySelectorAll('button');
  assert.equal(buttons[0].dataset.command, 'cmd.a');
  assert.equal(ctx.querySelectorAll('.ctx-sep').length, 1, 'duplicate and trailing separators collapse');
  assert.equal(buttons[1].getAttribute('role'), 'menuitemcheckbox');
  assert.ok(buttons[0].querySelector('.ctx-check'), 'rows align when any row is a toggle');
  core.closeCtxMenu();
  core.showCtxMenu(10, 10, [{ label: 'Only', run() {} }]);
  assert.equal(ctx.querySelector('.ctx-check'), null);
  core.closeCtxMenu();
});

// ---- Windows/Linux 菜单栏(menubar.js):标题栏一级菜单,下拉复用 #ctx-menu ----

async function menubarSetup() {
  const h = await setup({ platform: 'windows', width: 1000, height: 700 });
  h.document.body.classList.add('platform-nonmacos');
  const bar = h.add(h.document.body, 'nav', 'menubar');
  const terminal = h.add(h.app, 'textarea', 'term-input');
  let checked = true; let blockedRuns = 0; const runs = [];
  h.commands.registerCommand('tab.new', { label: '新建标签', run: () => { runs.push('tab.new'); } });
  h.commands.registerCommand('panel.sidebar', { label: '主机侧栏', checked: () => checked, run: () => { checked = !checked; runs.push('panel.sidebar'); } });
  h.commands.registerCommand('session.search', { label: '在终端中查找', enabled: () => false, reason: '没有活动会话', run: () => { blockedRuns++; } });
  h.commands.registerCommand('palette.open', { label: '命令面板', kind: 'dialog', run: () => { runs.push('palette.open'); } });
  h.commands.registerCommand('app.about', { label: '关于 NebulaShell', run: () => { runs.push('app.about'); } });
  assert.equal(h.menubar.buildMenubar(), true);
  const titles = () => bar.querySelectorAll('.menubar-item');
  const title = (text) => titles().find((t) => t.textContent === text);
  const items = () => h.ctx.querySelectorAll('.ctx-item').map((b) => ({ label: b.querySelector('.ctx-label').textContent,
    checked: b.getAttribute('aria-checked'), disabled: b.getAttribute('aria-disabled') === 'true', command: b.dataset.command || '' }));
  const isOpen = () => !h.ctx.classList.contains('hidden');
  return { ...h, bar, terminal, title, titles, items, isOpen, runs, blockedRuns: () => blockedRuns };
}

test('menu bar renders the Windows/Linux titles only, and each menu lists registered commands with state', async () => {
  const h = await menubarSetup();
  assert.deepEqual(h.titles().map((t) => t.textContent), ['文件', '编辑', '视图', '主机', '会话', '帮助']);
  assert.equal(h.menubar.buildMenubar(), false, 'building twice is a no-op');
  h.title('视图').click();
  assert.equal(h.isOpen(), true);
  assert.equal(h.title('视图').getAttribute('aria-expanded'), 'true');
  const view = h.items();
  // 未注册的命令(本测试只注册了少数几个)不出现;勾选态来自注册表
  assert.deepEqual(view.map((i) => i.command), ['palette.open', 'panel.sidebar']);
  assert.equal(view.find((i) => i.command === 'panel.sidebar').checked, 'true');
  h.title('编辑').click();
  assert.deepEqual(h.items().map((i) => [i.label, i.disabled]), [['在终端中查找', true]], 'disabled items stay listed with their reason');
  h.ctx.querySelector('.ctx-item').click();
  assert.equal(h.blockedRuns(), 0, 'an unavailable item cannot run');
  // 帮助菜单:命令面板显示为「命令与快捷键…」,并带「关于」
  h.title('帮助').click();
  assert.deepEqual(h.items().map((i) => i.label), ['命令与快捷键…', '关于 NebulaShell']);
  assert.deepEqual(plain(h.menubar.menubarSnapshot().titles.map((t) => t.text)), ['文件', '编辑', '视图', '主机', '会话', '帮助']);
});

test('menu bar: ←/→ and hover switch menus, Esc closes and returns focus to where the user was', async () => {
  const h = await menubarSetup();
  h.terminal.focus();
  h.title('文件').dispatchEvent(new DomEvent('mousedown', { bubbles: true }));
  h.title('文件').click();
  assert.equal(h.isOpen(), true);
  assert.equal(h.ctx._trigger, h.title('文件'));
  key(h.document.activeElement, 'ArrowRight');
  assert.equal(h.ctx._trigger, h.title('编辑'), 'ArrowRight moves to the next menu');
  key(h.document.activeElement, 'ArrowLeft'); key(h.document.activeElement, 'ArrowLeft');
  assert.equal(h.ctx._trigger, h.title('帮助'), 'ArrowLeft wraps around');
  h.title('视图').dispatchEvent(new DomEvent('mouseenter'));
  assert.equal(h.ctx._trigger, h.title('视图'), 'hovering another title while open switches');
  key(h.document.activeElement, 'Escape');
  assert.equal(h.isOpen(), false);
  assert.equal(h.document.activeElement, h.terminal, 'focus goes back to the terminal, not to the title');
  assert.equal(h.title('视图').getAttribute('aria-expanded'), 'false');
  // 未打开时悬停不弹出
  h.title('主机').dispatchEvent(new DomEvent('mouseenter'));
  assert.equal(h.isOpen(), false);
});

test('menu bar: clicking the open title closes it; an item restores focus before running; dialogs disable the titles', async () => {
  const h = await menubarSetup();
  let focusAtRun = null;
  h.commands.registerCommand('panel.tools', { label: '右侧工具栏', run: () => { focusAtRun = h.document.activeElement; } });
  h.terminal.focus();
  h.title('视图').click();
  assert.equal(h.isOpen(), true);
  h.title('视图').click();
  assert.equal(h.isOpen(), false, 'second click on the open title closes the menu (keyboard activation path)');
  assert.equal(h.document.activeElement, h.terminal);
  h.title('视图').click();
  assert.equal(h.isOpen(), true, 'a keyboard re-activation right after closing reopens');
  // 真实点击:全局 mousedown 先收起菜单,紧接着落在同一标题上的 click 不能把它再打开(300ms 窗口)
  h.core.bindCtxMenuDismiss();
  const press = (el) => {
    h.window.dispatchEvent(new DomEvent('mousedown', { bubbles: true, target: el }));
    el.dispatchEvent(new DomEvent('mousedown', { bubbles: true }));
    el.click();
  };
  press(h.title('视图'));
  assert.equal(h.isOpen(), false, 'pressing the open title closes it');
  press(h.title('视图'));
  assert.equal(h.isOpen(), false, 'a click right after the closing press does not reopen');
  await new Promise((resolve) => setTimeout(resolve, 320));
  h.title('视图').click();
  h.ctx.querySelectorAll('.ctx-item').find((b) => b.dataset.command === 'panel.tools').click();
  await flush();
  assert.equal(focusAtRun, h.terminal, 'focus returns to the terminal before the command runs');
  h.core.openModal(h.confirm);
  assert.equal(h.titles().every((t) => t.disabled), true, 'titles are disabled while a dialog is open');
  h.core.closeModal(h.confirm);
  assert.equal(h.titles().some((t) => t.disabled), false);
});

test('toast action button runs once and closes its toast; plain toasts have no button', async () => {
  const { core, document } = await setup();
  let runs = 0;
  core.toast('已下载 a.txt', 'success', { action: { label: '在文件夹中显示', run: () => { runs++; } } });
  core.toast('普通提示', 'error');
  const box = document.querySelector('#toasts');
  assert.equal(box.children.length, 2);
  const button = box.children[0].querySelector('.toast-action');
  assert.equal(button.textContent, '在文件夹中显示');
  assert.equal(box.children[1].querySelector('.toast-action'), null);
  button.click();
  await flush();
  assert.equal(runs, 1);
  assert.deepEqual(box.children.map((t) => t.querySelector('.toast-body').textContent), ['普通提示'], 'the clicked toast closes');
});

test('dropdown: Esc then ↓ reopens at once; Esc after focus fell to body returns focus to the button; a background button cannot open a menu over a dialog', async () => {
  const { core, document, add, app, ctx, confirm } = await setup();
  core.bindCtxMenuDismiss();
  const button = add(app, 'button', 'dd-button');
  core.bindMenuButton(button, () => [{ label: 'One', run() {} }, '-', { label: 'Two', run() {} }]);
  button.focus();
  key(button, 'ArrowDown');
  assert.equal(ctx.classList.contains('hidden'), false);
  key(document.activeElement, 'Escape');
  assert.equal(ctx.classList.contains('hidden'), true);
  assert.equal(document.activeElement, button);
  key(button, 'ArrowDown');
  assert.equal(ctx.classList.contains('hidden'), false, 'closing with Esc does not swallow an immediate reopen');
  // 点分隔线后焦点掉到 body:↓ 与 Esc 仍归菜单,Esc 把焦点还给按钮
  document.activeElement = document.body;
  key(document.body, 'ArrowDown');
  assert.equal(ctx.contains(document.activeElement), true);
  document.activeElement = document.body;
  key(document.body, 'Escape');
  assert.equal(ctx.classList.contains('hidden'), true);
  assert.equal(document.activeElement, button, 'focus returns to the button, not left on body');
  core.openModal(confirm);
  button.click();
  assert.equal(ctx.classList.contains('hidden'), true, 'a button behind the dialog cannot open its menu even when clicked programmatically');
  core.closeModal(confirm);
});
