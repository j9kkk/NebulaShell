// Focused module tests: fake DOM/IPC/clock, no browser or AI service required.
// Run: node --experimental-vm-modules --test tests/ai-ux.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

class Element {
  constructor() {
    this.value = ''; this.children = []; this.dataset = {}; this.disabled = false;
    this.parentNode = null; this.style = {}; this.offsetWidth = 200; this.offsetHeight = 150;
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
  get parentElement() { return this.parentNode; }
  getBoundingClientRect() {
    return { top: 100, bottom: 120, left: 200, right: 300, width: 100, height: 20 };
  }
  get previousElementSibling() {
    const siblings = this.parentNode?.children;
    if (!siblings) return null;
    const i = siblings.indexOf(this);
    return i > 0 ? siblings[i - 1] : null;
  }
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
        const span = new Element();
        span.textContent = n;
        this.appendChild(span);
      } else if (n) {
        this.appendChild(n);
      }
    }
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
    this.removed = true;
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  setAttribute(k, v) {
    if (!this._attrs) this._attrs = new Map();
    this._attrs.set(k, String(v));
  }
  getAttribute(k) { return this._attrs?.get(k) || null; }
  matches(selector) {
    if (!selector) return false;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const m = selector.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
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
    if (this.parts?.[selector]) return this.parts[selector];
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
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
}

function makeBubble() {
  const bubble = new Element();
  bubble.dataset.role = 'assistant';
  bubble.dataset.responseState = 'completed';
  bubble.parts = { '.ai-body': new Element(), '.ai-meta': new Element(), '.ai-copy': new Element() };
  bubble.parts['.ai-meta'].textContent = '12:00';
  return bubble;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(handler, { confirm = async () => true, submit = null } = {}) {
  const doc = {
    querySelector: null,
    querySelectorAll: null,
    createElement: null,
    activeElement: null,
  };
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) {
      const el = new Element();
      el.ownerDocument = doc;
      if (selector.startsWith('#')) el.id = selector.slice(1);
      else if (selector.startsWith('.')) el.className = selector.slice(1);
      elements.set(selector, el);
    }
    return elements.get(selector);
  };
  doc.querySelector = $;
  doc.querySelectorAll = (sel) => {
    const el = $(sel);
    return el ? [el] : [];
  };
  doc.createElement = () => {
    const el = new Element();
    el.ownerDocument = doc;
    return el;
  };
  const calls = [], toasts = [], timers = new Map(), cancelledFrames = [];
  const copies = [], confirmations = [], submissions = [];
  let timerId = 0;
  const state = {
    settings: { ai: { provider: 'custom', protocol: 'openai', baseUrl: 'https://saved.example/v1', model: 'm1', models: ['m1', 'm2'], apiKeySet: true } },
    aiSelected: [], aiModels: [], sessions: new Map(),
  };
  const context = vm.createContext({
    console, crypto: webcrypto, performance, Date,
    document: doc,
    window: { innerWidth: 1024, innerHeight: 768 },
    CSS: { escape: (x) => x },
    setTimeout: (cb, ms) => { const id = ++timerId; timers.set(id, { cb, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    cancelAnimationFrame: (id) => cancelledFrames.push(id),
  });
  const core = new vm.SyntheticModule(['$', 'state', 'api', 'toast', 'openModal', 'closeModal', 'copyText', 'askConfirm', 'askPrompt'], function () {
    this.setExport('$', $); this.setExport('state', state);
    this.setExport('toast', (message, type) => toasts.push({ message, type }));
    this.setExport('copyText', async (text) => { copies.push(text); return true; });
    this.setExport('askConfirm', async (message, opts) => { confirmations.push({ message, opts }); return confirm(message, opts, state); });
    this.setExport('askPrompt', async (title, defaultValue = '') => defaultValue);
    this.setExport('openModal', (id) => $(id).classList.remove('hidden'));
    this.setExport('closeModal', (id) => $(id).classList.add('hidden'));
    this.setExport('api', async (channel, payload) => {
      calls.push({ channel, payload });
      if (handler) return handler(channel, payload, state);
      if (channel === 'settings:save') {
        const next = structuredClone(state.settings);
        Object.assign(next.ai, payload.ai);
        if (payload.ai.clearApiKey) next.ai.apiKeySet = false;
        if (payload.ai.apiKey) next.ai.apiKeySet = true;
        delete next.ai.apiKey; delete next.ai.clearApiKey;
        return next;
      }
      return { requestId: payload.requestId };
    });
  }, { context });
  const hosts = new vm.SyntheticModule(['escapeHtml'], function () {
    this.setExport('escapeHtml', (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  }, { context });
  const load = async (path) => new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
  const aiThreadStateMod = await load('../src/shared/ai-thread-state.js');
  await aiThreadStateMod.link(() => {});
  await aiThreadStateMod.evaluate();
  aiThreadStateMod.namespace.installAiThreadState(state);
  const markdown = await load('../src/shared/markdown.js');
  const classification = await load('../src/shared/ai-command-blocks.js');
  const presets = await load('../src/shared/ai-presets.js');
  const terminal = new vm.SyntheticModule(['getCommandBlockTarget', 'commandBlockTargetStatus', 'submitCommandBlock'], function () {
    const status = (target, text) => {
      const s = target.session;
      if (state.activeId !== target.sessionId || state.sessions.get(target.sessionId) !== s) return { ok: false, reason: '活动终端已变化' };
      if (s.status !== 'connected' || s.readOnly) return { ok: false, reason: '目标不可写' };
      if (/[\n\t]/.test(text) && !s.bracketed) return { ok: false, reason: '多行或含 TAB 的命令需要 bracketed paste' };
      return { ok: true };
    };
    this.setExport('getCommandBlockTarget', () => {
      const session = state.sessions.get(state.activeId);
      return session ? { ok: true, target: { session, sessionId: state.activeId, label: session.label } } : { ok: false, reason: '当前没有活动终端会话' };
    });
    this.setExport('commandBlockTargetStatus', status);
    this.setExport('submitCommandBlock', async (target, text, opts) => {
      const result = status(target, text);
      if (!result.ok) return result;
      submissions.push({ target, text, opts });
      return submit ? submit(target, text, opts) : { ok: true };
    });
  }, { context });
  const icons = await load('../src/shared/icons.js');
  const termText = await load('../src/shared/term-text.js');
  const targetState = await load('../src/shared/ai-target-state.js');
  const contextReasoning = await load('../src/shared/ai-context-reasoning.js');
  // 上下文压缩是新加的共享模块,ai.js 现在会导入它;测试里只做透传,行为由
  // tests/ai-compact.test.mjs 覆盖。它自身只依赖 ai-context-reasoning,
  // 先按同一份实例链接好,避免作为依赖模块参与链接时报 Symbol(kWrap)。
  const compact = await load('../src/shared/ai-compact.js');
  await compact.link((specifier) => ({ './ai-context-reasoning.js': contextReasoning }[specifier] ?? (() => { throw new Error('unexpected import: ' + specifier); })()));
  await compact.evaluate();
  const interaction = new vm.SyntheticModule(['popupPosition'], function () {
    this.setExport('popupPosition', (anchor, w, h, placement) => ({ left: 0, top: 0, placement: placement || 'bottom' }));
  }, { context });
  // 工具回合另有 tests/ai-agent.test.mjs 覆盖;这里桩成「不可用」,本文件只测普通对话路径。
  const agentRun = new vm.SyntheticModule(['agentAvailable', 'agentBinding', 'refreshAgentHostBar', 'runAgentSend'], function () {
    this.setExport('agentAvailable', () => false);
    this.setExport('agentBinding', () => ({ session: null }));
    this.setExport('refreshAgentHostBar', () => {});
    this.setExport('runAgentSend', async () => {});
  }, { context });
  const aiLinks = new vm.SyntheticModule(['clearThreadLinks', 'linksForThread'], function () {
    // 桩:与真实模块同语义地读 state.aiLinks(测试直接往 state.aiLinks 里塞条目)。
    this.setExport('clearThreadLinks', (thread) => {
      if (thread) thread.linkedHostIds = [];
      return 0;
    });
    this.setExport('linksForThread', (thread) => {
      const pool = state.aiLinks;
      if (!pool || !thread?.linkedHostIds) return [];
      return thread.linkedHostIds.map((id) => pool.get(id)).filter(Boolean);
    });
  }, { context });
  const module = await load('../src/modules/ai.js');
  await module.link((specifier) => ({ './core.js': core, './hosts.js': hosts, './terminal.js': terminal, './interaction.js': interaction, './ai-agent-run.js': agentRun, './ai-links.js': aiLinks, '../shared/icons.js': icons, '../shared/markdown.js': markdown, '../shared/ai-command-blocks.js': classification, '../shared/ai-presets.js': presets, '../shared/term-text.js': termText, '../shared/ai-target-state.js': targetState, '../shared/ai-context-reasoning.js': contextReasoning, '../shared/ai-compact.js': compact }[specifier]));
  await module.evaluate();
  const ai = module.namespace;
  ai.syncSelectedModelsFromSettings();
  return { ai, state, $, calls, timers, toasts, cancelledFrames, copies, confirmations, submissions };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('draft endpoint switches discard typed keys and never reuse another endpoint credential', async () => {
  const { ai, $, state } = await setup();
  ai.openAiSettings();
  assert.equal(ai.readAiDraft().useSavedApiKey, true);
  $('#ai-apikey').value = 'typed-for-saved';
  ai.fillPreset('deepseek');
  assert.equal($('#ai-apikey').value, '');
  assert.equal(ai.readAiDraft().useSavedApiKey, false);
  assert.equal(state.settings.ai.baseUrl, 'https://saved.example/v1');
  $('#ai-apikey').value = 'typed-for-deepseek';
  $('#ai-baseurl').value = 'https://another.example/v1';
  assert.equal(ai.readAiDraft().apiKey, ''); // submit-time check also protects programmatic changes
  $('#ai-protocol').value = 'anthropic';
  ai.onAiEndpointChange();
  assert.equal(ai.readAiDraft().useSavedApiKey, false);
  $('#ai-protocol').value = 'openai';
  $('#ai-baseurl').value = ' https://saved.example/v1/// ';
  ai.onAiEndpointChange();
  assert.equal(ai.readAiDraft().useSavedApiKey, true);
});

test('chat snapshots saved settings rather than unsaved draft or mutable message arrays', async () => {
  const { ai, $, state, calls } = await setup();
  ai.openAiSettings();
  ai.fillPreset('deepseek');
  const messages = [{ role: 'user', content: 'original' }];
  const request = ai.aiRequest(messages, null);
  const h = state.aiReq;
  const sent = calls.find((c) => c.channel === 'ai:chat').payload;
  assert.equal(sent.ai.baseUrl, 'https://saved.example/v1');
  assert.equal(sent.ai.model, 'm1');
  assert.equal(h.model, 'm1');
  assert.equal(ai.savedAiModelId(), 'm1');
  assert.equal($('#ai-model-trigger').disabled, true);
  state.settings.ai.model = 'm2';
  messages[0].content = 'mutated';
  assert.equal(sent.messages[0].content, 'original');
  assert.equal(h.model, 'm1');
  ai.aiFinishHolder({ requestId: h.id });
  await request;
});

test('model switch syncs saved controls and following request while leaving active draft alone', async () => {
  const { ai, $, state, calls } = await setup();
  await ai.switchModel('m2');
  assert.equal(state.settings.ai.model, 'm2');
  assert.equal($('#ai-model').value, 'm2');
  assert.equal(ai.savedAiModelId(), 'm2');
  ai.openAiSettings();
  ai.fillPreset('deepseek');
  await ai.switchModel('m1');
  assert.equal($('#ai-model').value, 'deepseek-chat');
  assert.equal(ai.savedAiModelId(), 'm1');
  const request = ai.aiRequest([], null);
  const h = state.aiReq;
  await ai.switchModel('m2');
  assert.equal(state.settings.ai.model, 'm1');
  assert.equal(calls.filter((c) => c.channel === 'settings:save').length, 2);
  ai.aiFinishHolder({ requestId: h.id });
  await request;
  ai.closeAiSettings();
  assert.equal($('#ai-model').value, 'm1');
});

test('failed model switch rolls dropdown back and leaves saved settings unchanged', async () => {
  const { ai, $, state } = await setup(() => { throw new Error('disk failure'); });
  // 新模型菜单不再由测试直接赋值;switchModel 以参数传入,失败回滚经 savedAiModelId 断言
  await assert.rejects(ai.switchModel('m2'), /disk failure/);
  assert.equal(state.settings.ai.model, 'm1');
  assert.equal(ai.savedAiModelId(), 'm1');
  // 回滚后触发钮必须恢复可用(switchModel 的 finally 里 modelSwitchPending=false
  // → renderModelSwitch 重置 disabled;#ai-model-switch 元素已删,旧断言恒真)
  assert.equal($('#ai-model-trigger').disabled, false);
});

test('manual model fallback stays draft-only until save; cancellation restores saved controls', async () => {
  const { ai, $, state, calls } = await setup();
  ai.openAiSettings();
  ai.addManualAiModel(' vendor/manual-model ');
  assert.equal($('#ai-model').value, 'vendor/manual-model');
  assert.equal(ai.savedAiModelId(), 'm1');
  assert.ok(!state.settings.ai.models?.some((m) => m.id === 'vendor/manual-model')); // 未保存前不落 settings
  ai.closeAiSettings();
  assert.equal($('#ai-model').value, 'm1');
  ai.openAiSettings();
  ai.addManualAiModel('vendor/manual-model');
  await ai.saveAiSettings();
  assert.equal(state.settings.ai.model, 'vendor/manual-model');
  assert.equal(ai.savedAiModelId(), 'vendor/manual-model');
  assert.ok(calls.at(-1).payload.ai.models.some((m) => m.id === 'vendor/manual-model'));
});

test('removing an enabled model falls back active to first remaining; empty list allowed', async () => {
  const { ai, state, $ } = await setup();
  ai.openAiSettings();
  ai.addManualAiModel('m-a');
  assert.equal($('#ai-model').value, 'm-a'); // 新添加的模型即生效
  // chip ✕ 的删除路径:applySelectedModels 过滤掉目标后生效模型自动回退
  ai.applySelectedModels(state.aiSelected.filter((m) => m.id !== 'm-a'));
  assert.equal($('#ai-model').value, 'm1'); // 落到剩余第一个,不留"列表外仍被使用"的模型
  ai.applySelectedModels([]);
  assert.equal($('#ai-model').value, ''); // 全部移除等同勾选弹框全取消,由空态提示引导重建
});

test('empty model list keeps trigger clickable with config CTA; send is blocked and opens AI settings', async () => {
  const { ai, state, $, toasts, calls } = await setup();
  ai.syncSelectedModelsFromSettings();
  ai.applySelectedModels([]); // 清到 0 模型(空列表是合法态)
  await ai.saveAiSettings();
  const trigger = $('#ai-model-trigger');
  assert.equal(trigger.disabled, false, '0 模型不禁用:点击语义是去配置');
  assert.equal($('#ai-model-name').textContent, '未启用模型，点击配置');
  assert.equal(trigger.title, '配置 AI 模型');
  assert.equal(trigger.classList.contains('ai-model-unset'), true);

  // aiSend 前置守卫:不发请求、提示后打开 AI 设置弹窗
  const n = calls.filter((c) => c.channel === 'ai:chat').length;
  await ai.aiSend('你好');
  assert.equal(calls.filter((c) => c.channel === 'ai:chat').length, n);
  assert.equal(toasts.some((t) => /请先配置/.test(t.message)), true);
  assert.equal($('#modal-settings').classList.contains('hidden'), false);
});

test('configured model restores trigger title and clears unset state', async () => {
  const { ai, state, $ } = await setup();
  ai.syncSelectedModelsFromSettings();
  const trigger = $('#ai-model-trigger');
  assert.equal(trigger.classList.contains('ai-model-unset'), false);
  assert.equal(trigger.title, '切换模型');
  assert.equal($('#ai-model-name').textContent, 'm1');
  assert.equal(trigger.disabled, false);
});

test('openModelMenu and openThreadMenu enforce mutual exclusivity by hiding peer menus', async () => {
  const { ai, $ } = await setup();
  ai.syncSelectedModelsFromSettings();

  const modelMenu = $('#ai-model-menu');
  const modeMenu = $('#ai-mode-menu');
  const threadMenu = $('#ai-thread-menu');

  modelMenu.classList.add('hidden');
  modeMenu.classList.add('hidden');
  threadMenu.classList.add('hidden');

  // Mode menu is open, then openModelMenu is called
  modeMenu.classList.remove('hidden');
  assert.equal(modeMenu.classList.contains('hidden'), false);

  ai.openModelMenu();
  assert.equal(modelMenu.classList.contains('hidden'), false, 'model menu opened');
  assert.equal(modeMenu.classList.contains('hidden'), true, 'mode menu hidden when model menu opens');
  assert.equal(threadMenu.classList.contains('hidden'), true);

  // Now thread menu is opened
  ai.openThreadMenu();
  assert.equal(threadMenu.classList.contains('hidden'), false, 'thread menu opened');
  assert.equal(modelMenu.classList.contains('hidden'), true, 'model menu hidden when thread menu opens');
  assert.equal(modeMenu.classList.contains('hidden'), true);
});

test('endpoint change save without new key emits clearApiKey; freshly typed key replaces it', async () => {
  const { ai, $, calls } = await setup();
  ai.openAiSettings(); ai.fillPreset('deepseek');
  await ai.saveAiSettings();
  assert.equal(calls.at(-1).payload.ai.clearApiKey, true);
  ai.openAiSettings();
  $('#ai-apikey').value = 'replacement';
  await ai.saveAiSettings();
  assert.equal(calls.at(-1).payload.ai.apiKey, 'replacement');
  assert.equal(calls.at(-1).payload.ai.clearApiKey, undefined);
});

test('stop preserves last unpainted Markdown delta, cancels timer/RAF, and ignores late completion', async () => {
  const { ai, state, calls, timers, cancelledFrames } = await setup();
  const bubble = makeBubble();
  bubble.dataset.pending = '1'; bubble.parts['.ai-body'].textContent = '正在思考…';
  const copy = bubble.parts['.ai-copy'];
  const request = ai.aiRequest([], bubble);
  const old = state.aiReq;
  old.acc = '**partial**'; old.raf = 77;
  assert.equal(ai.stopAiGeneration(), true);
  assert.equal(state.aiReq, null);
  assert.equal(timers.size, 0);
  assert.deepEqual(cancelledFrames, [77]);
  assert.equal(bubble.__raw, '**partial**');
  assert.match(bubble.parts['.ai-body'].innerHTML, /<strong>partial<\/strong>/);
  assert.equal(bubble.parts['.ai-copy'], copy);
  assert.equal(state.aiHistory.length, 1);
  assert.equal((await request).aborted, true);
  assert.ok(calls.some((c) => c.channel === 'ai:abort' && c.payload.requestId === old.id));
  const nextRequest = ai.aiRequest([], null);
  const next = state.aiReq;
  assert.equal(ai.aiTouchRequest(old.id), false);
  ai.aiFinishHolder({ requestId: old.id });
  assert.equal(state.aiReq, next);
  ai.aiFinishHolder({ requestId: next.id });
  await nextRequest;
});

test('stop before first token removes pending placeholder and shows an explicit stopped state', async () => {
  const { ai, state, $ } = await setup();
  const bubble = makeBubble();
  bubble.dataset.pending = '1'; bubble.parts['.ai-body'].textContent = '正在思考…';
  const request = ai.aiRequest([], bubble);
  ai.stopAiGeneration();
  assert.equal((await request).aborted, true);
  assert.equal(bubble.parts['.ai-body'].textContent, '（已停止生成）');
  assert.equal(bubble.dataset.pending, undefined);
  assert.equal(state.aiHistory.length, 0);
  assert.equal($('#ai-send').disabled, false);
  assert.equal($('#ai-send').classList.contains('stop'), false); // 单按钮双状态:停止后回到发送态
});

test('stop before IPC registration retries abort after chat acknowledgment', async () => {
  const acknowledgment = deferred();
  const { ai, state, calls } = await setup((channel) => channel === 'ai:chat' ? acknowledgment.promise : null);
  const request = ai.aiRequest([], null);
  const id = state.aiReq.id;
  ai.stopAiGeneration(); await request;
  assert.equal(calls.filter((c) => c.channel === 'ai:abort').length, 1);
  acknowledgment.resolve({ requestId: id });
  await flush();
  assert.equal(calls.filter((c) => c.channel === 'ai:abort' && c.payload.requestId === id).length, 2);
});

test('idle watchdog resets for active request and times out with partial content intact', async () => {
  const { ai, state, calls, timers } = await setup();
  const bubble = makeBubble();
  const request = ai.aiRequest([], bubble);
  const h = state.aiReq;
  const initial = h.idleTimer;
  h.acc = 'partial';
  assert.equal(ai.aiTouchRequest(h.id), true);
  assert.equal(timers.has(initial), false);
  assert.equal(timers.get(h.idleTimer).ms, 60_000);
  timers.get(h.idleTimer).cb();
  const result = await request;
  assert.match(result.error, /超时/);
  assert.match(bubble.__raw, /partial/);
  assert.match(bubble.__raw, /超时/);
  assert.equal(state.aiReq, null);
  assert.equal(timers.size, 0);
  assert.ok(calls.some((c) => c.channel === 'ai:abort' && c.payload.requestId === h.id));
});

test('test response does not contaminate assistant conversation history and usage stays available', async () => {
  const { ai, state } = await setup();
  ai.openAiSettings();
  const request = ai.aiRequest([{ role: 'user', content: 'test' }], null, ai.readAiDraft());
  const h = state.aiReq; h.acc = 'OK';
  const usage = { promptTokens: 5, completionTokens: 1 };
  ai.aiFinishHolder({ requestId: h.id, usage, elapsedMs: 25 });
  const result = await request;
  assert.equal(state.aiHistory.length, 0);
  assert.equal(result.usage, usage);
  assert.equal(result.elapsedMs, 25);
});

test('IPC failure releases pending state and surfaces error using the existing body chain', async () => {
  const { ai, state, timers } = await setup(() => { throw new Error('not configured'); });
  const bubble = makeBubble();
  bubble.dataset.pending = '1'; bubble.parts['.ai-body'].textContent = '正在思考…';
  const result = await ai.aiRequest([], bubble);
  assert.equal(result.error, 'not configured');
  assert.equal(state.aiReq, null);
  assert.equal(timers.size, 0);
  assert.match(bubble.__raw, /not configured/);
  assert.equal(bubble.dataset.pending, undefined);
});

test('model discovery response from a previous endpoint cannot overwrite new draft or unlock its fetch', async () => {
  const old = deferred(), fresh = deferred();
  let fetchCount = 0;
  const { ai, $, state } = await setup((channel) => channel === 'ai:models' ? (++fetchCount === 1 ? old.promise : fresh.promise) : null);
  ai.openAiSettings();
  const first = ai.fetchAiModels();
  $('#ai-baseurl').value = 'https://other.example/v1';
  ai.onAiEndpointChange();
  $('#ai-apikey').value = 'fresh-key';
  assert.equal($('#btn-ai-fetch-models').disabled, false);
  const second = ai.fetchAiModels();
  old.resolve([{ id: 'stale-model' }]); await first;
  assert.ok(!state.aiModels.some((m) => m.id === 'stale-model'));
  assert.equal($('#btn-ai-fetch-models').disabled, true);
  ai.closeAiSettings();
  fresh.resolve([{ id: 'closed-model' }]); await second;
  assert.ok(!state.aiModels.some((m) => m.id === 'closed-model'));
});

test('terminal noise and untrusted Markdown rendering remain unchanged', async () => {
  const { ai } = await setup();
  assert.equal(ai.stripTerminalNoise('\x1b[31merror\x1b[0m\x1b]0;title\x07\nnext'), 'error\nnext');
  const bubble = makeBubble();
  ai.setAiBody(bubble, '**bold** <script>alert(1)</script>');
  assert.match(bubble.parts['.ai-body'].innerHTML, /<strong>bold<\/strong>/);
  assert.match(bubble.parts['.ai-body'].innerHTML, /&lt;script&gt;/);
  assert.equal(bubble.__raw, '**bold** <script>alert(1)</script>');
});

function connectedTarget(state, id = 's1') {
  const session = { label: `测试主机 ${id}`, status: 'connected', bracketed: true };
  state.sessions.set(id, session);
  state.activeId = id;
  return session;
}

test('each code block has isolated copy data and only explicit shell blocks have execution controls', async () => {
  const { ai, state, copies } = await setup();
  connectedTarget(state);
  const bubble = makeBubble();
  ai.setAiBody(bubble, '```bash\nprintf "<script>"\n```\n```python\nprint(1)\n```\n```\nwhoami\n```');
  const html = bubble.parts['.ai-body'].innerHTML;
  assert.equal((html.match(/data-ai-code-action="copy"/g) || []).length, 3);
  assert.equal((html.match(/data-ai-code-action="execute"/g) || []).length, 1);
  assert.match(html, /&lt;script&gt;/);
  await ai.handleAiCodeAction(bubble, 1, 'copy');
  await ai.handleAiCodeAction(bubble, 0, 'copy');
  assert.deepEqual(copies, ['print(1)', 'printf "<script>"']);
});

test('programmatic user prompts can copy blocks but cannot execute them', async () => {
  const { ai, state, submissions, copies } = await setup();
  connectedTarget(state);
  const bubble = makeBubble(); bubble.dataset.role = 'user';
  ai.setAiBody(bubble, '```bash\nwhoami\n```', { md: true });
  assert.doesNotMatch(bubble.parts['.ai-body'].innerHTML, /data-ai-code-action="execute"/);
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  await ai.handleAiCodeAction(bubble, 0, 'copy');
  assert.equal(submissions.length, 0);
  assert.deepEqual(copies, ['whoami']);
});

test('ordinary single line commands execute without confirmation on the target active at click', async () => {
  const { ai, state, confirmations, submissions, toasts } = await setup();
  connectedTarget(state, 's1');
  const bubble = makeBubble(); ai.setAiBody(bubble, '```sh\npwd\n```');
  connectedTarget(state, 's2');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 0);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].target.sessionId, 's2');
  assert.equal(submissions[0].text, 'pwd');
  assert.equal(submissions[0].opts.execute, true);
  assert.match(toasts.at(-1).message, /已发送到.*s2/);
  assert.doesNotMatch(toasts.at(-1).message, /执行成功/);
});

test('Docker Go templates and Shell variables copy, execute and fill verbatim without placeholder confirmation', async () => {
  const { ai, state, confirmations, submissions, copies } = await setup();
  connectedTarget(state);
  for (const text of [
    String.raw`docker ps --format 'table {{.Names}}\t{{.ID}}\t{{.Ports}}'`,
    `docker inspect --format '{{json .Config}}' container`,
    `kubectl get pods -o go-template='{{range .items}}{{.metadata.name}}{{end}}'`,
    'ssh "$YOUR_HOST"', 'echo "${YOUR_HOST:-localhost}"',
  ]) {
    const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\n' + text + '\n```');
    const html = bubble.parts['.ai-body'].innerHTML;
    assert.doesNotMatch(html, /class="ai-code-warning"/);
    assert.doesNotMatch(html, /data-ai-code-action="execute"[^>]* disabled/);
    await ai.handleAiCodeAction(bubble, 0, 'copy');
    await ai.handleAiCodeAction(bubble, 0, 'execute');
    await ai.handleAiCodeAction(bubble, 0, 'insert');
    assert.equal(copies.at(-1), text);
    assert.equal(submissions.at(-2).text, text); assert.equal(submissions.at(-2).opts.execute, true);
    assert.equal(submissions.at(-1).text, text); assert.equal(submissions.at(-1).opts.execute, false);
  }
  assert.equal(confirmations.length, 0);
});

test('suspected parameters stay enabled with an escaped explanation, and cancellation sends nothing', async () => {
  const { ai, state, confirmations, submissions } = await setup(null, { confirm: async () => false });
  connectedTarget(state);
  const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\nssh <HOST>\n```');
  const html = bubble.parts['.ai-body'].innerHTML;
  assert.match(html, /class="ai-code-warning"/);
  assert.match(html, /疑似示例参数「&lt;HOST&gt;」/);
  assert.match(html, /需要用户填写的示例参数/);
  assert.match(html, /仅填入终端修改/);
  assert.doesNotMatch(html, /data-ai-code-action="(?:execute|insert)"[^>]* disabled/);
  assert.doesNotMatch(html, /<HOST>/);
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /疑似示例参数「<HOST>」/);
  assert.match(confirmations[0].message, /目标：测试主机 s1/);
  assert.ok(confirmations[0].message.includes('ssh <HOST>'));
  assert.equal(confirmations[0].opts.defaultFocus, 'cancel');
  assert.equal(submissions.length, 0); assert.equal(bubble.__codeActionPending, false);
});

test('accepting a suspected-parameter warning sends the unchanged block once', async () => {
  const { ai, state, confirmations, submissions } = await setup();
  connectedTarget(state);
  const bubble = makeBubble(); const text = 'ssh YOUR_HOST';
  ai.setAiBody(bubble, '```bash\n' + text + '\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /疑似示例参数「YOUR_HOST」/);
  assert.equal(submissions.length, 1); assert.equal(submissions[0].text, text);
  assert.equal(submissions[0].opts.execute, true);
});

test('suspected parameters can be copied or filled for editing without confirmation or automatic replacement', async () => {
  const { ai, state, confirmations, submissions, copies } = await setup(null, { confirm: async () => false });
  connectedTarget(state);
  const bubble = makeBubble(); const text = 'ssh {{YOUR_HOST}}';
  ai.setAiBody(bubble, '```bash\n' + text + '\n```');
  await ai.handleAiCodeAction(bubble, 0, 'copy');
  await ai.handleAiCodeAction(bubble, 0, 'insert');
  assert.equal(confirmations.length, 0); assert.deepEqual(copies, [text]);
  assert.equal(submissions.length, 1); assert.equal(submissions[0].text, text);
  assert.equal(submissions[0].opts.execute, false);
});

test('multiline, risk and parameter warnings share one confirmation', async () => {
  const { ai, state, confirmations, submissions } = await setup();
  connectedTarget(state);
  const text = 'rm -rf <YOUR_PATH>\nprintf "%s" YOUR_HOST';
  const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\n' + text + '\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /2 行/);
  assert.match(confirmations[0].message, /递归删除/);
  assert.match(confirmations[0].message, /疑似示例参数「<YOUR_PATH>」/);
  assert.match(confirmations[0].message, /疑似示例参数「YOUR_HOST」/);
  assert.ok(confirmations[0].message.includes(text));
  assert.equal(submissions.length, 1); assert.equal(submissions[0].text, text);
});

test('content warnings never bypass reply, structural or terminal protections', async () => {
  const { ai, state, confirmations, submissions } = await setup();
  const session = connectedTarget(state); const bubble = makeBubble();
  for (const responseState of ['pending', 'streaming', 'aborted', 'failed', 'incomplete']) {
    bubble.dataset.responseState = responseState;
    ai.setAiBody(bubble, '```bash\nssh YOUR_HOST\n```');
    await ai.handleAiCodeAction(bubble, 0, 'execute'); await ai.handleAiCodeAction(bubble, 0, 'insert');
  }
  bubble.dataset.responseState = 'completed';
  for (const markdown of ['```bash\nssh YOUR_HOST', '```bash\n$ ssh YOUR_HOST\n```', '```bash\nssh YOUR_HOST\x1b[31m\n```', '```python\nprint("YOUR_HOST")\n```']) {
    ai.setAiBody(bubble, markdown);
    await ai.handleAiCodeAction(bubble, 0, 'execute'); await ai.handleAiCodeAction(bubble, 0, 'insert');
  }
  ai.setAiBody(bubble, '```bash\nssh YOUR_HOST\n```'); session.readOnly = true;
  await ai.handleAiCodeAction(bubble, 0, 'execute'); await ai.handleAiCodeAction(bubble, 0, 'insert');
  session.readOnly = false; session.bracketed = false;
  ai.setAiBody(bubble, '```bash\nssh YOUR_HOST\npwd\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute'); await ai.handleAiCodeAction(bubble, 0, 'insert');
  assert.equal(confirmations.length, 0); assert.equal(submissions.length, 0);
});

test('parameter warning confirmations retain target identity and prevent duplicate clicks', async () => {
  const decision = deferred();
  const { ai, state, submissions, confirmations } = await setup(null, { confirm: () => decision.promise });
  connectedTarget(state, 's1'); const bubble = makeBubble();
  ai.setAiBody(bubble, '```bash\nssh YOUR_HOST\n```');
  const action = ai.handleAiCodeAction(bubble, 0, 'execute');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  await ai.handleAiCodeAction(bubble, 0, 'insert');
  assert.equal(confirmations.length, 1);
  connectedTarget(state, 's2'); decision.resolve(true); await action;
  assert.equal(submissions.length, 0); assert.equal(bubble.__codeActionPending, false);
});

test('refresh preserves warning tooltips but gives terminal blocking reasons precedence', async () => {
  const { ai, state } = await setup(); const session = connectedTarget(state);
  const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\nssh <HOST>\n```');
  const blockElement = { dataset: { codeIndex: '0' } };
  const buttons = ['execute', 'insert'].map(action => ({ dataset: { aiCodeAction: action }, closest: () => blockElement }));
  bubble.querySelectorAll = () => buttons;
  ai.refreshAiCodeActions(bubble);
  for (const button of buttons) { assert.equal(button.disabled, false); assert.match(button.title, /疑似示例参数「<HOST>」/); }
  assert.match(buttons[0].title, /^执行到：/); assert.match(buttons[1].title, /^填入到：/);
  session.readOnly = true; ai.refreshAiCodeActions(bubble);
  for (const button of buttons) { assert.equal(button.disabled, true); assert.equal(button.title, '目标不可写'); }
});

test('multiline confirmation previews exact content, defaults to cancel and cancellation sends nothing', async () => {
  const { ai, state, confirmations, submissions } = await setup(null, { confirm: async () => false });
  connectedTarget(state);
  const bubble = makeBubble();
  const text = "cat > config.json <<'EOF'\n{\n  \"enabled\": true\n}\nEOF";
  ai.setAiBody(bubble, `\`\`\`bash\n${text}\n\`\`\``);
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  assert.ok(confirmations[0].message.includes(text));
  assert.match(confirmations[0].message, /5 行/);
  assert.equal(confirmations[0].opts.defaultFocus, 'cancel');
  assert.equal(submissions.length, 0);
  assert.equal(bubble.__codeActionPending, false);
});

test('multiline acceptance submits the original CRLF block in one operation', async () => {
  const { ai, state, submissions } = await setup();
  connectedTarget(state);
  const bubble = makeBubble();
  ai.setAiBody(bubble, '```bash\r\n  cd /tmp &&\r\n  pwd\r\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].text, '  cd /tmp &&\r\n  pwd');
});

test('dangerous single line commands require risk confirmation, while insert never appends Enter', async () => {
  const { ai, state, confirmations, submissions } = await setup();
  connectedTarget(state);
  const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\nrm -rf /tmp/test-only\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.match(confirmations[0].message, /递归删除/);
  await ai.handleAiCodeAction(bubble, 0, 'insert');
  assert.equal(confirmations.length, 1);
  assert.equal(submissions[1].opts.execute, false);
});

test('streaming, partial, failed and interrupted replies remain copy-only', async () => {
  const { ai, state, copies, submissions } = await setup();
  connectedTarget(state);
  for (const result of ['pending', 'streaming', 'aborted', 'failed', 'incomplete']) {
    const bubble = makeBubble(); bubble.dataset.responseState = result;
    ai.setAiBody(bubble, '```bash\npwd\n```');
    assert.match(bubble.parts['.ai-body'].innerHTML, /data-ai-code-action="execute"[^>]* disabled/);
    await ai.handleAiCodeAction(bubble, 0, 'execute');
    await ai.handleAiCodeAction(bubble, 0, 'copy');
  }
  assert.equal(submissions.length, 0);
  assert.equal(copies.length, 5);
});

test('finish states distinguish stop, EOF, abort and errors independently of streaming CSS', async () => {
  const { ai, state } = await setup(); connectedTarget(state);
  for (const [finishReason, failed, expected] of [['stop', '', 'completed'], ['end', '', 'incomplete'], ['length', '', 'incomplete'], ['content_filter', '', 'incomplete'], ['max_tokens', '', 'incomplete'], ['stop_sequence', '', 'incomplete'], ['aborted', '', 'aborted'], ['stop', 'network error', 'failed']]) {
    const bubble = makeBubble();
    const request = ai.aiRequest([], bubble);
    const h = state.aiReq; h.acc = '```bash\npwd\n```'; h.failed = failed;
    if (failed) ai.setAiBody(bubble, h.acc + '\n⚠️ ' + failed);
    ai.aiFinishHolder({ requestId: h.id, finishReason });
    await request;
    assert.equal(bubble.dataset.responseState, expected);
    assert.equal(bubble.classList.contains('streaming'), false);
    const html = bubble.parts['.ai-body'].innerHTML;
    assert.equal(/data-ai-code-action="execute"[^>]* disabled/.test(html), expected !== 'completed');
  }
});

test('ineligible blocks, no target, readonly and multiline without paste mode never submit', async () => {
  const { ai, state, submissions } = await setup();
  const bubble = makeBubble();
  for (const markdown of ['```bash\npwd', '```bash\n$ pwd\n```', '```python\nprint(1)\n```']) {
    connectedTarget(state);
    ai.setAiBody(bubble, markdown);
    await ai.handleAiCodeAction(bubble, 0, 'execute');
  }
  state.activeId = null;
  ai.setAiBody(bubble, '```bash\npwd\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  const session = connectedTarget(state); session.readOnly = true;
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  session.readOnly = false; session.bracketed = false;
  for (const text of ['pwd\nwhoami', "printf '<%s>\\n' 'left\tright'"]) {
    ai.setAiBody(bubble, '```bash\n' + text + '\n```');
    await ai.handleAiCodeAction(bubble, 0, 'execute');
    await ai.handleAiCodeAction(bubble, 0, 'insert');
  }
  assert.equal(submissions.length, 0);
});

test('confirmation prevents duplicate submissions and never retargets after focus changes', async () => {
  const decision = deferred();
  const { ai, state, submissions, confirmations } = await setup(null, { confirm: () => decision.promise });
  connectedTarget(state);
  const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\npwd\nwhoami\n```');
  const action = ai.handleAiCodeAction(bubble, 0, 'execute');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  connectedTarget(state, 's2');
  decision.resolve(true); await action;
  assert.equal(submissions.length, 0);
  assert.equal(bubble.__codeActionPending, false);
});

test('replaced reply or removed bubble during confirmation cannot send stale commands', async () => {
  for (const mutation of ['replace', 'remove']) {
    const decision = deferred();
    const { ai, state, submissions } = await setup(null, { confirm: () => decision.promise });
    connectedTarget(state);
    const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\npwd\nwhoami\n```');
    const action = ai.handleAiCodeAction(bubble, 0, 'execute');
    if (mutation === 'replace') ai.setAiBody(bubble, '```bash\necho changed\n```');
    else bubble.isConnected = false;
    decision.resolve(true); await action;
    assert.equal(submissions.length, 0);
  }
});

test('submission errors restore controls and do not claim success', async () => {
  const { ai, state, toasts } = await setup(null, { submit: async () => { throw new Error('IPC unavailable'); } });
  connectedTarget(state);
  const bubble = makeBubble(); ai.setAiBody(bubble, '```bash\npwd\n```');
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(bubble.__codeActionPending, false);
  assert.equal(toasts.at(-1).type, 'error');
  assert.match(toasts.at(-1).message, /IPC unavailable/);
});

test('token counts format with K/M units below rounding', async () => {
  const { ai } = await setup();
  assert.equal(ai.formatTokenCount(318), '318');
  assert.equal(ai.formatTokenCount(999), '999');
  assert.equal(ai.formatTokenCount(1000), '1K');
  assert.equal(ai.formatTokenCount(8653), '9K');
  // 999999 四舍五入后是 1000K,应进位成 1M(不显示"一千千")
  assert.equal(ai.formatTokenCount(999999), '1M');
  assert.equal(ai.formatTokenCount(1000000), '1M');
  assert.equal(ai.formatTokenCount(2500000), '3M');
});

test('setAiMeta renders converted token units', async () => {
  const { ai } = await setup();
  const bubble = makeBubble();
  bubble.parts['.ai-meta-text'] = new Element();
  bubble.parts['.ai-meta-text'].textContent = '12:00';
  ai.setAiMeta(bubble, { model: 'gpt-6-luna', usage: { promptTokens: 12500, completionTokens: 865 }, elapsedMs: 14600 });
  assert.equal(bubble.parts['.ai-meta-text'].textContent, '12:00 · gpt-6-luna · tokens 13K入/865出 · 14.6s');
});

test('multi-thread lifecycle: create, derive title, switch, clear and delete', async () => {
  const { ai, state, $ } = await setup();
  const t1 = ai.ensureDefaultAiThread();
  assert.ok(t1.id);
  assert.equal(state.activeThreadId, t1.id);
  assert.equal(ai.deriveThreadTitle('   # 排查 Nginx 502 Bad Gateway 报错原因以及解决方案\n详情'), '排查 Nginx 502 Bad G…');

  t1.history.push({ role: 'user', content: 'first question' });
  t1.title = '排查 Nginx';
  ai.renderAiThreadBar();
  assert.equal($('#ai-thread-title').textContent, '排查 Nginx');

  const t2 = ai.createAiThread({ title: 'MySQL 慢查询', hostId: 'h2', hostName: 'db-prod' });
  assert.equal(state.activeThreadId, t2.id);
  assert.equal($('#ai-thread-title').textContent, 'MySQL 慢查询');
  assert.equal(t2.history.length, 0);

  ai.switchAiThread(t1.id);
  assert.equal(state.activeThreadId, t1.id);
  assert.equal(t1.containerEl.classList.contains('active'), true);
  assert.equal(t2.containerEl.classList.contains('active'), false);

  ai.clearCurrentAiThread();
  assert.equal(t1.history.length, 0);
  assert.equal(t1.title, '新对话');

  ai.deleteAiThread(t1.id);
  assert.equal(state.aiThreads.has(t1.id), false);
  assert.equal(state.activeThreadId, t2.id);
});

test('smart host auto-routing via ensureThreadForSession isolates hosts without cross-talk', async () => {
  const { ai, state } = await setup();
  const sessA = { sessionId: 's-a', host: { id: 'host-a', name: 'web-01' } };
  const sessB = { sessionId: 's-b', host: { id: 'host-b', name: 'db-01' } };

  // 初始空会话直接绑定到主机 A
  const thA = ai.ensureThreadForSession(sessA);
  assert.equal(thA.hostId, 'host-a');
  assert.equal(thA.hostName, 'web-01');
  thA.history.push({ role: 'user', content: 'check nginx' });

  // 主机 A 再次触发继续复用同一会话
  assert.equal(ai.ensureThreadForSession(sessA).id, thA.id);

  // 主机 B 触发时自动新建独立会话,不污染主机 A 的上下文
  const thB = ai.ensureThreadForSession(sessB);
  assert.notEqual(thB.id, thA.id);
  assert.equal(thB.hostId, 'host-b');
  assert.equal(thB.history.length, 0);
  assert.equal(thA.history.length, 1);
  thB.history.push({ role: 'user', content: 'check db' });

  // 切回主机 A 触发时自动找回主机 A 的会话
  const thA2 = ai.ensureThreadForSession(sessA);
  assert.equal(thA2.id, thA.id);
  assert.equal(state.activeThreadId, thA.id);
});

test('background streaming multiplexing updates background thread without polluting active thread', async () => {
  const { ai, state } = await setup();
  const th1 = ai.ensureDefaultAiThread();
  const b1 = makeBubble();
  const p1 = ai.aiRequest([{ role: 'user', content: 'q1' }], b1);
  const req1 = th1.req;
  assert.ok(req1);

  // 流式进行中切换到新会话 th2
  const th2 = ai.createAiThread({ title: '新话题' });
  assert.equal(state.activeThreadId, th2.id);
  assert.equal(th2.req, null);

  // 后台收到 req1 的流式内容与完成事件
  const resolved = ai.findRequestHolder(req1.id);
  assert.equal(resolved.holder, req1);
  assert.equal(resolved.thread, th1);
  req1.acc = '后台生成的完整回复';
  ai.setAiBody(b1, req1.acc);
  ai.aiFinishHolder({ requestId: req1.id, finishReason: 'stop' });
  await p1;

  assert.equal(th1.req, null);
  assert.equal(th1.history.length, 1);
  assert.equal(th1.history[0].content, '后台生成的完整回复');
  assert.equal(th2.history.length, 0);
});

test('cross-host command execution guard warns when active terminal switched to another host', async () => {
  let allowConfirm = false;
  const { ai, state, submissions, confirmations } = await setup(null, { confirm: async () => allowConfirm });
  const s1 = connectedTarget(state, 's1');
  s1.host = { id: 'host-alpha', name: 'Prod-Alpha' };
  ai.ensureThreadForSession(s1);

  const rendered = ai.renderAiMessage('assistant', '```bash\nuptime\n```');
  assert.equal(rendered.__originHostId, 'host-alpha');
  assert.equal(rendered.__originHostName, 'Prod-Alpha');

  const bubble = makeBubble();
  bubble.__originHostId = rendered.__originHostId;
  bubble.__originHostName = rendered.__originHostName;
  ai.setAiBody(bubble, '```bash\nuptime\n```');

  // 终端切到了另一台主机 Beta
  const s2 = connectedTarget(state, 's2');
  s2.host = { id: 'host-beta', name: 'Staging-Beta' };

  // 取消跨主机确认 -> 不执行
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /Prod-Alpha/);
  assert.match(confirmations[0].message, /Staging-Beta/);
  assert.equal(submissions.length, 0);

  // 确认跨主机执行 -> 正常发送
  allowConfirm = true;
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 2);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].text, 'uptime');
});

test('concurrent requests: A finishes while B is active, B.req retained, state.aiReq sees B, B records history', async () => {
  const { ai, state } = await setup();
  const thA = ai.ensureDefaultAiThread();
  thA.history.push({ role: 'user', content: 'qA' });
  const bA = makeBubble();
  const pA = ai.aiRequest([{ role: 'user', content: 'qA' }], bA);
  const reqA = thA.req;
  assert.ok(reqA);

  const thB = ai.createAiThread({ title: 'Thread B' });
  assert.equal(state.activeThreadId, thB.id);
  thB.history.push({ role: 'user', content: 'qB' });
  const bB = makeBubble();
  const pB = ai.aiRequest([{ role: 'user', content: 'qB' }], bB);
  const reqB = thB.req;
  assert.ok(reqB);
  assert.equal(state.aiReq, reqB);

  // A finishes in background while B is active
  reqA.acc = 'A done';
  ai.setAiBody(bA, reqA.acc);
  ai.aiFinishHolder({ requestId: reqA.id, finishReason: 'stop' });
  await pA;

  // B's req must still be present and state.aiReq must still be B's holder
  assert.equal(thA.req, null);
  assert.equal(thB.req, reqB);
  assert.equal(state.aiReq, reqB);

  // B finishes
  reqB.acc = 'B done';
  ai.setAiBody(bB, reqB.acc);
  ai.aiFinishHolder({ requestId: reqB.id, finishReason: 'stop' });
  await pB;

  assert.equal(thB.req, null);
  assert.equal(state.aiReq, null);
  assert.equal(thB.history.length, 2);
  assert.equal(thA.history.length, 2);
});

test('state.aiReq and state.aiHistory are read-only getters and throw TypeError on assignment', async () => {
  const { state } = await setup();
  assert.throws(() => { state.aiReq = { id: 'x' }; }, TypeError);
  assert.throws(() => { state.aiHistory = []; }, TypeError);
});

test('aiTestConnection runs detached: no thread.req, state.aiReq is null, found by findRequestHolder, no history', async () => {
  let resolveChat;
  const chatDeferred = new Promise((r) => { resolveChat = r; });
  const { ai, state, calls } = await setup(async (channel, payload) => {
    if (channel === 'ai:chat') {
      await chatDeferred;
      return { requestId: payload.requestId };
    }
    return { ok: true };
  });
  const th = ai.ensureDefaultAiThread();
  assert.equal(th.req, null);
  assert.equal(state.aiReq, null);

  const testPromise = ai.aiTestConnection();
  await new Promise((r) => setTimeout(r, 0));

  // In flight: no thread req, state.aiReq remains null
  assert.equal(th.req, null);
  assert.equal(state.aiReq, null);

  const call = calls.find((c) => c.channel === 'ai:chat');
  assert.ok(call);
  const reqId = call.payload.requestId;
  const found = ai.findRequestHolder(reqId);
  assert.ok(found.holder);
  assert.equal(found.thread, null);

  // Finish detached request
  found.holder.acc = 'Pong';
  ai.aiFinishHolder({ requestId: reqId, finishReason: 'stop' });
  resolveChat();
  await testPromise;

  assert.equal(th.history.length, 0);
  assert.equal(state.aiReq, null);
  assert.equal(ai.findRequestHolder(reqId), null);
});

test('deleting busy background thread resolves promise as aborted, emits ai:abort, and clears idleTimer', async () => {
  const { ai, state, calls, timers } = await setup();
  const th1 = ai.ensureDefaultAiThread();
  const b1 = makeBubble();
  const reqPromise = ai.aiRequest([{ role: 'user', content: 'q1' }], b1);
  const req1 = th1.req;
  assert.ok(req1);
  const idleTimerId = req1.idleTimer;
  assert.ok(idleTimerId);

  const th2 = ai.createAiThread({ title: 'Active Thread' });
  assert.equal(state.activeThreadId, th2.id);

  ai.deleteAiThread(th1.id);
  assert.equal(state.aiThreads.has(th1.id), false);

  const res = await reqPromise;
  assert.equal(res.ok, true);
  assert.equal(res.aborted, true);
  assert.equal(timers.has(idleTimerId), false);

  const abortCall = calls.find((c) => c.channel === 'ai:abort' && c.payload?.requestId === req1.id);
  assert.ok(abortCall);
});

test('updateAiContextIndicator updates trigger title, gauge offset and popover details', async () => {
  const { ai, state, $ } = await setup();
  const th = ai.ensureDefaultAiThread();
  th.history.push({ role: 'user', content: 'hello' });
  th.history.push({ role: 'assistant', content: 'world' });

  const ctx = ai.updateAiContextIndicator();
  assert.ok(ctx);
  assert.ok(ctx.totalTokens > 0);
  assert.equal(ctx.contextLimit, 128000);

  const trigger = $('#ai-context-trigger');
  assert.match(trigger.title, /当前会话上下文/);

  // open and close popover
  ai.openContextPopover();
  assert.equal($('#ai-context-popover').classList.contains('hidden'), false);
  assert.equal($('#ai-context-trigger').getAttribute('aria-expanded'), 'true');

  ai.closeContextPopover();
  assert.equal($('#ai-context-popover').classList.contains('hidden'), true);
  assert.equal($('#ai-context-trigger').getAttribute('aria-expanded'), 'false');
});

/// 把会话历史填到超过某模型窗口的压缩阈值。
function fillHistory(ai, th, { turns = 6, chars = 800 } = {}) {
  for (let i = 0; i < turns; i++) {
    th.history.push({ role: 'user', content: `u${i} ` + 'x'.repeat(chars) });
    th.history.push({ role: 'assistant', content: `a${i} ` + 'y'.repeat(chars) });
  }
}

test('compactThread replaces old turns with an AI summary and keeps recent turns', async () => {
  const { ai, state } = await setup();
  const th = ai.ensureDefaultAiThread();
  fillHistory(ai, th, { turns: 6 });
  const before = th.history.length;

  const pending = ai.compactThread(th);
  // 压缩请求占住会话:用户此时的 Enter 会被挡住,不会并发改 history
  assert.ok(th.req, '压缩期间 thread.req 被占用');
  const h = state.aiReq;
  h.acc = '用户排查了磁盘,发现 /var 占用 90%,已清理日志。';
  ai.aiFinishHolder({ requestId: h.id, finishReason: 'stop' });
  assert.equal(await pending, true);

  // 摘要排在最前,保留最近轮次原文(默认 2 轮 = 4 条)
  assert.ok(th.history.length < before);
  assert.equal(th.history[0].role, 'user');
  assert.match(th.history[0].content, /此前对话摘要/);
  assert.match(th.history[0].content, /\/var 占用 90%/);
  assert.equal(th.history.length, 1 + 4);
  assert.match(th.history.at(-1).content, /a5/, '最近一轮原文保留');
  assert.equal(th.compactedAt != null, true);
});

test('compactThread leaves history untouched when the summary request fails', async () => {
  const { ai, state, toasts } = await setup();
  const th = ai.ensureDefaultAiThread();
  fillHistory(ai, th, { turns: 6 });
  const snapshot = th.history.map((m) => ({ ...m }));

  const pending = ai.compactThread(th);
  ai.aiFinishHolder({ requestId: state.aiReq.id, finishReason: 'error' });
  // 用 ai:error 的路径置失败再收口
  assert.equal(await pending, false);
  assert.deepEqual(th.history, snapshot, '失败时历史原样不动');
  assert.ok(toasts.some((t) => /自动压缩失败/.test(t.message)));
});

test('compactThread refuses when busy, without a window, or with too few turns', async () => {
  const { ai, state } = await setup();
  const th = ai.ensureDefaultAiThread();

  // 历史太短(不足保留轮次 + 1)
  th.history.push({ role: 'user', content: 'only one' });
  assert.equal(await ai.compactThread(th), false);

  // 忙:已有请求进行中
  fillHistory(ai, th, { turns: 5 });
  const blocker = ai.aiRequest([{ role: 'user', content: '占位' }], makeBubble());
  assert.equal(await ai.compactThread(th), false);
  ai.aiFinishHolder({ requestId: state.aiReq.id });
  await blocker;
});

test('aiSend compacts automatically once history approaches the context window', async () => {
  const { ai, state, calls } = await setup();
  // 把模型窗口压到很小,让几轮历史就越过 96% 阈值
  state.settings.ai.models = [{ id: 'm1', contextWindow: 6000, maxOutput: 1000 }];
  ai.syncSelectedModelsFromSettings();
  const th = ai.ensureDefaultAiThread();
  fillHistory(ai, th, { turns: 5, chars: 2000 });
  const before = th.history.length;

  const sent = ai.aiSend('再看看内存');
  const tick = () => new Promise((r) => setImmediate(r));
  const isSummary = (req) => /对话压缩器/.test(req.messages?.[0]?.content || '');

  // 历史较大时摘要会分块跑多轮:逐个收口摘要请求,直到出现本轮真实提问
  let summaryReqs = 0;
  let realReq = null;
  for (let guard = 0; guard < 20; guard++) {
    await tick();
    const req = th.req;
    if (!req) continue;
    if (isSummary(req)) {
      summaryReqs++;
      req.acc = `第 ${summaryReqs} 段摘要`;
      ai.aiFinishHolder({ requestId: req.id, finishReason: 'stop' });
      continue;
    }
    realReq = req;
    break;
  }
  assert.ok(summaryReqs > 0, '发送前先跑了摘要请求');
  assert.ok(realReq, '压缩完成后继续发送本轮提问');
  realReq.acc = '内存正常';
  ai.aiFinishHolder({ requestId: realReq.id, finishReason: 'stop' });
  await sent;

  const allChats = calls.filter((c) => c.channel === 'ai:chat');
  assert.equal(allChats.filter((c) => /对话压缩器/.test(c.payload.messages[0].content)).length, summaryReqs);
  assert.ok(th.history.length < before, '历史被压缩');
  assert.match(th.history[0].content, /此前对话摘要/);
  assert.equal(th.history.at(-1).role, 'assistant');
  assert.equal(th.history.at(-1).content, '内存正常');
});


test('draft management: aiSend with text preserves input, switchAiThread restores draft, input send clears draft', async () => {
  const { ai, state, $ } = await setup();
  const th1 = ai.ensureDefaultAiThread();
  $('#ai-input').value = 'typed in th1';

  // 1. aiSend with explicit text preserves input and draft
  const p1 = ai.aiSend('explain this error', 'explain');
  assert.equal($('#ai-input').value, 'typed in th1');
  ai.aiFinishHolder({ requestId: th1.req.id, finishReason: 'stop' });
  await p1;
  assert.equal($('#ai-input').value, 'typed in th1');

  // 2. Switch to th2: th1 draft saved, th2 draft initialized
  const th2 = ai.createAiThread({ title: 'Thread 2' });
  assert.equal(state.activeThreadId, th2.id);
  assert.equal($('#ai-input').value, '');
  $('#ai-input').value = 'typed in th2';

  // Switch back to th1: restores th1 draft
  ai.switchAiThread(th1.id);
  assert.equal($('#ai-input').value, 'typed in th1');
  assert.equal(th2.draft, 'typed in th2');

  // Switch back to th2: restores th2 draft
  ai.switchAiThread(th2.id);
  assert.equal($('#ai-input').value, 'typed in th2');

  // 3. Sending from input clears input and thread draft
  const p2 = ai.aiSend();
  assert.equal($('#ai-input').value, '');
  assert.equal(th2.draft, '');
  ai.aiFinishHolder({ requestId: th2.req.id, finishReason: 'stop' });
  await p2;
  assert.equal($('#ai-input').value, '');
  assert.equal(th2.draft, '');

  // 4. Sending whitespace rawText is treated as from input
  $('#ai-input').value = 'typed in input';
  th2.draft = 'typed in input';
  const p3 = ai.aiSend('   ');
  assert.equal($('#ai-input').value, '');
  assert.equal(th2.draft, '');
  ai.aiFinishHolder({ requestId: th2.req.id, finishReason: 'stop' });
  await p3;
});

test('title generation: explain prefix, diagnose opts.title, explicit title retention, clear resets autoTitle, emoji code points', async () => {
  const { ai, state } = await setup();

  // Explain mode generates 解释：...
  const th1 = ai.ensureDefaultAiThread();
  const p1 = ai.aiSend('npm test failed with exit code 1', 'explain');
  assert.equal(th1.title, '解释：npm test failed…');
  ai.aiFinishHolder({ requestId: th1.req.id, finishReason: 'stop' });
  await p1;

  // Diagnose passes opts.title, and opts.title is truncated with deriveThreadTitle
  const th2 = ai.createAiThread({ title: '新对话' });
  const p2 = ai.aiSend('error details', null, { title: '诊断：这是一个非常长的自定义标题超过十八个字符', md: true });
  assert.equal(th2.title, '诊断：这是一个非常长的自定义标题超过…');
  ai.aiFinishHolder({ requestId: th2.req.id, finishReason: 'stop' });
  await p2;

  // aiDiagnose with multiline command uses first non-empty line
  const sessDiag = { sessionId: 'diag1', host: { id: 'h-diag' }, lastCmd: '\n  nginx -t -c /etc/nginx.conf  \nexit 1', lastOutput: 'failed' };
  state.sessions.set('diag1', sessDiag);
  state.activeId = 'diag1';
  const thDiag = ai.createAiThread({ title: '新对话' });
  await ai.aiDiagnose();
  assert.equal(thDiag.title, '诊断：nginx -t -c /et…');
  ai.aiFinishHolder({ requestId: thDiag.req.id, finishReason: 'stop' });

  // aiDiagnose without command uses 诊断报错
  const sessDiag2 = { sessionId: 'diag2', host: { id: 'h-diag2' }, lastCmd: '', lastOutput: 'some error' };
  state.sessions.set('diag2', sessDiag2);
  state.activeId = 'diag2';
  const thDiag2 = ai.createAiThread({ title: '新对话' });
  await ai.aiDiagnose();
  assert.equal(thDiag2.title, '诊断报错');
  ai.aiFinishHolder({ requestId: thDiag2.req.id, finishReason: 'stop' });

  // Explicit title is never overwritten
  const th3 = ai.createAiThread({ title: '固定标题' });
  assert.equal(th3.autoTitle, false);
  const p3 = ai.aiSend('new message');
  assert.equal(th3.title, '固定标题');
  ai.aiFinishHolder({ requestId: th3.req.id, finishReason: 'stop' });
  await p3;

  // Host-bound thread clears and re-generates title on next message
  state.sessions.set('s4', { sessionId: 's4', status: 'connected', host: { id: 'h4', name: 'web' } });
  const th4 = ai.createAiThread({ title: '主机对话', hostId: 'h4', hostName: 'web' });
  th4.history.push({ role: 'user', content: 'previous' });
  ai.switchAiThread(th4.id);
  ai.clearCurrentAiThread();
  assert.equal(th4.title, '新对话');
  assert.equal(th4.autoTitle, true);
  const p4 = ai.aiSend('df -h');
  assert.equal(th4.title, 'df -h');
  ai.aiFinishHolder({ requestId: th4.req.id, finishReason: 'stop' });
  await p4;

  // Emoji truncation by code point (surrogate pair not split)
  const textWithEmoji = 'A'.repeat(17) + '🚀' + 'B';
  const derived = ai.deriveThreadTitle(textWithEmoji);
  assert.equal(derived, 'A'.repeat(17) + '🚀…');
});

test('newAiThread and ensureThreadForSession reuse rules and quick-connect endpoint normalization', async () => {
  const { ai, state } = await setup();

  // 1. newAiThread reuses current thread if empty and idle
  const th1 = ai.ensureDefaultAiThread();
  assert.equal(th1.history.length, 0);
  const res1 = ai.newAiThread();
  assert.equal(res1.id, th1.id);

  // Non-empty current thread -> newAiThread creates new thread
  th1.history.push({ role: 'user', content: 'hello' });
  const th2 = ai.newAiThread();
  assert.notEqual(th2.id, th1.id);
  assert.equal(state.activeThreadId, th2.id);

  // 2. ensureThreadForSession Rule 1: current thread is empty & idle -> rebinds to host
  const sess1 = { sessionId: 's1', host: { quick: true, id: 'quick-uuid-1', user: 'root', host: '192.168.1.10', port: 22 } };
  const bound = ai.ensureThreadForSession(sess1);
  assert.equal(bound.id, th2.id);
  assert.equal(bound.hostId, 'root@192.168.1.10:22');

  // Rule 1 also rebinds if current thread is empty & idle even if already bound to another host
  const sessOther = { sessionId: 's-other', host: { id: 'host-other', name: 'other-box' } };
  const rebound = ai.ensureThreadForSession(sessOther);
  assert.equal(rebound.id, th2.id);
  assert.equal(rebound.hostId, 'host-other');

  // Rule 4: If current is busy or non-empty, but an unbound empty idle thread exists, rebinds that
  rebound.history.push({ role: 'user', content: 'work' });
  const unbound = ai.createAiThread({ title: '新对话' });
  const sess2 = { sessionId: 's2', host: { id: 'host-standalone', name: 'db-box' } };
  const bound2 = ai.ensureThreadForSession(sess2);
  assert.equal(bound2.id, unbound.id);
  assert.equal(bound2.hostId, 'host-standalone');
  bound2.history.push({ role: 'user', content: 'query' });

  // Quick connect same endpoint with different UUID reuses the same thread
  rebound.hostId = 'root@192.168.1.10:22'; // restore sess1 hostId for reconnect test
  const sess1Reconnect = { sessionId: 's1-new', host: { quick: true, id: 'quick-uuid-2', user: 'root', host: '192.168.1.10', port: 22 } };
  const reused = ai.ensureThreadForSession(sess1Reconnect);
  assert.equal(reused.id, rebound.id);
});

test('cross-host guard allows execution between quick-connect sessions of same endpoint without warning', async () => {
  let allowConfirm = false;
  const { ai, state, submissions, confirmations } = await setup(null, { confirm: async () => allowConfirm });

  // Terminal active on s1 (quick connect root@10.0.0.1:22)
  const s1 = connectedTarget(state, 's1');
  s1.host = { quick: true, id: 'quick-1', user: 'root', host: '10.0.0.1', port: 22 };
  ai.ensureThreadForSession(s1);

  const bubble = makeBubble();
  const rendered = ai.renderAiMessage('assistant', '```bash\nwhoami\n```');
  bubble.__originHostId = rendered.__originHostId;
  bubble.__originHostName = rendered.__originHostName;
  ai.setAiBody(bubble, '```bash\nwhoami\n```');

  // Terminal switches to s2: different UUID, but SAME quick-connect endpoint
  const s2 = connectedTarget(state, 's2');
  s2.host = { quick: true, id: 'quick-2', user: 'root', host: '10.0.0.1', port: 22 };

  // Executes WITHOUT cross-host confirmation
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 0);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].text, 'whoami');

  // Terminal switches to s3: DIFFERENT endpoint
  const s3 = connectedTarget(state, 's3');
  s3.host = { quick: true, id: 'quick-3', user: 'root', host: '10.0.0.2', port: 22 };

  // Should trigger cross-host confirmation
  await ai.handleAiCodeAction(bubble, 0, 'execute');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /10\.0\.0\.1/);
  assert.match(confirmations[0].message, /10\.0\.0\.2/);
});

test('AI_THREAD_LIMIT evicts oldest idle thread, preferring empty threads and protecting active/busy threads', async () => {
  const { ai, state, toasts } = await setup();
  assert.equal(ai.AI_THREAD_LIMIT, 20);

  // Fill up to 20 threads
  const threads = [];
  for (let i = 0; i < 20; i++) {
    const t = ai.createAiThread({ title: `Thread ${i}` });
    t.updatedAt = 1000 + i;
    threads.push(t);
  }
  assert.equal(state.aiThreads.size, 20);

  // Thread 0 is oldest empty idle
  // Thread 1 is non-empty idle
  threads[1].history.push({ role: 'user', content: 'msg' });
  // Thread 2 is busy
  threads[2].req = { id: 'busy-holder' };
  // Thread 19 is active

  // Creating 21st thread should evict Thread 0 (oldest empty idle)
  const t21 = ai.createAiThread({ title: 'Thread 20' });
  assert.equal(state.aiThreads.size, 20);
  assert.equal(state.aiThreads.has(threads[0].id), false);
  assert.equal(state.aiThreads.has(threads[1].id), true);
  assert.equal(state.aiThreads.has(threads[2].id), true);

  // Mark all remaining threads non-empty
  for (const t of state.aiThreads.values()) {
    if (t.history.length === 0) t.history.push({ role: 'user', content: 'fill' });
  }

  // Creating another thread will evict oldest non-empty idle (Thread 1) and toast
  const t22 = ai.createAiThread({ title: 'Thread 21' });
  assert.equal(state.aiThreads.size, 20);
  assert.equal(state.aiThreads.has(threads[1].id), false);
  assert.ok(toasts.some((t) => t.message.includes('Thread 1')));
});

test('unread status: background completion sets unread, switching back clears unread, trigger classes update', async () => {
  const { ai, state, $ } = await setup();
  const thA = ai.ensureDefaultAiThread();
  const bA = makeBubble();
  const pA = ai.aiRequest([{ role: 'user', content: 'qA' }], bA);
  const reqA = thA.req;

  // Switch to Thread B
  const thB = ai.createAiThread({ title: 'Thread B' });
  assert.equal(state.activeThreadId, thB.id);

  // Trigger should have .has-busy while A is running in background
  ai.refreshThreadUi();
  assert.equal($('#ai-thread-trigger').classList.contains('has-busy'), true);

  // Thread A finishes in background
  reqA.acc = 'A done';
  ai.setAiBody(bA, reqA.acc);
  ai.aiFinishHolder({ requestId: reqA.id, finishReason: 'stop' });
  await pA;

  // thA should be marked unread, trigger should have .has-unread and lose .has-busy
  assert.equal(thA.unread, true);
  assert.equal($('#ai-thread-trigger').classList.contains('has-unread'), true);
  assert.equal($('#ai-thread-trigger').classList.contains('has-busy'), false);

  // Switching back to thA clears unread
  ai.switchAiThread(thA.id);
  assert.equal(thA.unread, false);
  assert.equal($('#ai-thread-trigger').classList.contains('has-unread'), false);
});

test('requestDeleteAiThread and requestClearAiThread prompt confirmation only for non-empty threads', async () => {
  let userChoice = false;
  const { ai, state, confirmations } = await setup(null, { confirm: async () => userChoice });

  // 1. Empty thread: delete and clear do not confirm
  const th1 = ai.ensureDefaultAiThread();
  const th2 = ai.createAiThread({ title: 'Empty 2' });
  assert.equal(th2.history.length, 0);

  await ai.requestDeleteAiThread(th2.id);
  assert.equal(confirmations.length, 0);
  assert.equal(state.aiThreads.has(th2.id), false);

  await ai.requestClearAiThread();
  assert.equal(confirmations.length, 0);

  // 2. Non-empty thread: delete confirms
  const th3 = ai.createAiThread({ title: 'Has History' });
  th3.history.push({ role: 'user', content: 'msg' });

  // User cancels delete -> thread stays
  userChoice = false;
  await ai.requestDeleteAiThread(th3.id);
  assert.equal(confirmations.length, 1);
  assert.equal(state.aiThreads.has(th3.id), true);

  // User confirms delete -> thread deleted
  userChoice = true;
  await ai.requestDeleteAiThread(th3.id);
  assert.equal(confirmations.length, 2);
  assert.equal(state.aiThreads.has(th3.id), false);

  // 3. Non-empty active thread: clear confirms
  th1.history.push({ role: 'user', content: 'important' });
  userChoice = false;
  await ai.requestClearAiThread();
  assert.equal(confirmations.length, 3);
  assert.equal(th1.history.length, 1);

  userChoice = true;
  await ai.requestClearAiThread();
  assert.equal(confirmations.length, 4);
  assert.equal(th1.history.length, 0);
});

test('renderThreadMenu retains focus or falls back to same position when focused thread was deleted', async () => {
  const { ai, state, $ } = await setup();
  const menu = $('#ai-thread-menu');
  const list = $('#ai-thread-menu-list');
  menu.appendChild(list);

  // Setup DOM generation for list.innerHTML in this test
  Object.defineProperty(list, 'innerHTML', {
    set(html) {
      this._html = html;
      const ths = [...state.aiThreads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this.children = ths.map((th) => {
        const row = new Element();
        row.ownerDocument = menu.ownerDocument;
        row.parentNode = this;
        row.className = 'ai-thread-menu-row';
        row.dataset.threadId = th.id;
        const btn = new Element();
        btn.ownerDocument = menu.ownerDocument;
        btn.parentNode = row;
        btn.className = 'ai-thread-menu-item';
        btn.dataset.threadId = th.id;
        row.appendChild(btn);
        return row;
      });
    },
    get() { return this._html; }
  });

  const t1 = ai.createAiThread({ title: 'T1' });
  const t2 = ai.createAiThread({ title: 'T2' });
  const t3 = ai.createAiThread({ title: 'T3' });

  // 1. Initial render: 3 threads (t1, t2, t3)
  ai.renderThreadMenu();
  assert.equal(list.children.length, 3);

  // 2. Focus on index 1 row's button
  const targetBtn = list.children[1].children[0];
  targetBtn.focus();
  assert.equal(menu.ownerDocument.activeElement, targetBtn);

  // 3. Delete that thread and re-render -> focus should stay on index 1 (new item at same position)
  ai.deleteAiThread(targetBtn.dataset.threadId);
  ai.renderThreadMenu();
  assert.equal(menu.ownerDocument.activeElement, list.children[1].children[0]);
});

test('requestDeleteAiThread focuses trigger before askConfirm when menu is open', async () => {
  let focusedBeforeConfirm = null;
  const focusCalls = [];
  const { ai, state, $ } = await setup(null, {
    confirm: async () => {
      focusedBeforeConfirm = $('#ai-thread-trigger').ownerDocument.activeElement;
      return true;
    },
  });

  const menu = $('#ai-thread-menu');
  const trigger = $('#ai-thread-trigger');
  const origTriggerFocus = trigger.focus.bind(trigger);
  trigger.focus = () => {
    focusCalls.push('trigger');
    origTriggerFocus();
  };

  const th1 = ai.ensureDefaultAiThread();
  const th2 = ai.createAiThread({ title: 'Non-empty' });
  th2.history.push({ role: 'user', content: 'test message' });

  // 1. Menu is open: deleting non-empty thread should focus trigger before confirm
  menu.classList.remove('hidden');
  const otherEl = new Element();
  otherEl.ownerDocument = trigger.ownerDocument;
  otherEl.focus();
  assert.equal(trigger.ownerDocument.activeElement, otherEl);

  await ai.requestDeleteAiThread(th2.id);

  assert.equal(focusedBeforeConfirm, trigger);
  assert.equal(focusCalls.includes('trigger'), true);
  assert.equal(menu.classList.contains('hidden'), true);

  // 2. Menu is closed: deleting another non-empty thread should not move focus to trigger
  const th3 = ai.createAiThread({ title: 'Another non-empty' });
  th3.history.push({ role: 'user', content: 'msg' });
  menu.classList.add('hidden');
  focusCalls.length = 0;
  focusedBeforeConfirm = null;
  otherEl.focus();

  await ai.requestDeleteAiThread(th3.id);

  assert.equal(focusedBeforeConfirm, otherEl);
  assert.equal(focusCalls.length, 0);
});

test('ai drawer: open, close, toggle, keyword search, count badge and rename', async () => {
  const { ai, state, $ } = await setup();
  const drawer = $('#ai-drawer');
  drawer.classList.add('hidden');
  const toggleBtn = $('#ai-drawer-toggle');
  const countBadge = $('#ai-thread-count-badge');
  const searchInp = $('#ai-drawer-search');
  const list = $('#ai-drawer-list');

  // 1. Initial state: default thread
  const th1 = ai.ensureDefaultAiThread();
  assert.equal(ai.isAiDrawerOpen(), false);

  // 2. Open drawer
  ai.openAiDrawer();
  assert.equal(ai.isAiDrawerOpen(), true);
  assert.equal(drawer.classList.contains('hidden'), false);
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(toggleBtn.classList.contains('active'), true);

  // 3. Toggle drawer -> closes
  ai.toggleAiDrawer();
  assert.equal(ai.isAiDrawerOpen(), false);
  assert.equal(drawer.classList.contains('hidden'), true);
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(toggleBtn.classList.contains('active'), false);

  // 4. Create multiple threads and check badge count
  const th2 = ai.createAiThread({ title: 'Nginx config' });
  const th3 = ai.createAiThread({ title: 'Docker container' });
  ai.renderAiThreadBar();
  assert.equal(countBadge.textContent, '3');
  assert.equal(countBadge.classList.contains('visible'), true);

  // 5. Render drawer with filter
  ai.openAiDrawer();
  assert.equal(list.children.length, 3);

  // Filter keyword 'nginx'
  ai.renderAiDrawer('nginx');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].dataset.threadId, th2.id);

  // Filter keyword 'docker'
  ai.renderAiDrawer('docker');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].dataset.threadId, th3.id);

  // Clear filter
  ai.renderAiDrawer('');
  assert.equal(list.children.length, 3);

  // 6. Rename thread
  await ai.renameAiThread(th2.id, 'Nginx Reverse Proxy');
  assert.equal(th2.title, 'Nginx Reverse Proxy');
  assert.equal(th2.autoTitle, false);

  // Active thread rename updates trigger title
  ai.switchAiThread(th2.id);
  assert.equal($('#ai-thread-title').textContent, 'Nginx Reverse Proxy');
  await ai.renameAiThread(th2.id, 'Production Nginx');
  assert.equal($('#ai-thread-title').textContent, 'Production Nginx');

  // Close drawer
  ai.closeAiDrawer();
  assert.equal(ai.isAiDrawerOpen(), false);
});




test('clicking a chip sets it as default model with badge shown', async () => {
  const { ai, $ } = await chipSetup();
  const list = () => $('#ai-model-chips-list');
  assert.equal(list().children.length, 2);
  // 点第二个 chip → 设为默认(草稿),徽标与 title 跟随(点击后重渲染,须重新取节点)
  list().children[1].listeners.get('click')();
  const chips = list().children;
  assert.equal($('#ai-model').value, 'm2');
  assert.equal(chips[1].classList.contains('active'), true);
  assert.match(chips[1].title, /默认模型/);
  assert.ok(chips[1].children.some((c) => c.classList.contains('model-chip-default') && c.textContent === '默认'), '默认徽标');
  assert.equal(chips[0].classList.contains('active'), false);
  assert.match(chips[0].title, /设为默认模型/);
  // ✕ 删除走 applySelectedModels,不触发设默认
  chips[1].querySelector('.model-chip-del').listeners.get('click')({ stopPropagation() {} });
  assert.equal($('#ai-model').value, 'm1', '默认被移除时回落到剩余第一个');
});

test('saveAiSettings enforces default-model invariant and toasts the fallback', async () => {
  const { ai, $, state, toasts } = await chipSetup();
  // 草稿默认与启用集合不一致(漏选) → 保存时自动落第一个
  $('#ai-model').value = '';
  await ai.saveAiSettings();
  assert.equal(state.settings.ai.model, 'm1');
  assert.equal(ai.savedAiModelId(), 'm1');
  assert.ok(toasts.some((t) => /已设 m1 为默认模型/.test(t.message)));
});

/// chips 用例专用:打开设置弹窗让 aiSelected 就位(mock settings 已有 m1/m2)
async function chipSetup() {
  const ctx = await setup();
  ctx.ai.openAiSettings();
  return ctx;
}

test('failed reply gains retry: history truncated and original message resent', async () => {
  let failNext = true;
  const { ai, state, calls } = await setup(async (channel, payload) => {
    if (channel === 'ai:chat' && failNext) throw new Error('boom: connection reset');
    return { requestId: payload.requestId };
  });
  const th = ai.ensureDefaultAiThread();
  const sent = () => calls.filter((c) => c.channel === 'ai:chat');
  const n0 = sent().length;

  // 第一次发送:后端拒绝 → 气泡 failed,用户消息已落历史
  await ai.aiSend('查一下磁盘', '', { noTools: true });
  assert.equal(sent().length, n0 + 1);
  assert.equal(th.history.length, 1, '失败的 user 消息已落历史');
  const failedBubble = th.containerEl.children.at(-1);
  assert.equal(failedBubble.dataset.responseState, 'failed');

  // 重发:历史截断到失败回合之前,再发一次(这次放行)
  failNext = false;
  const userBubble = failedBubble.previousElementSibling;
  assert.equal(userBubble.dataset.role, 'user');
  assert.equal(userBubble.__raw, '查一下磁盘');
  assert.equal(userBubble.dataset.aiMode, '');
  const retryBtn = failedBubble.querySelector('[data-ai-retry]');
  assert.ok(retryBtn, '失败气泡带重发按钮');
  failedBubble.listeners.get('click')({ target: retryBtn, stopPropagation() {} });
  // 截断+重发同步发生:重发的 user 消息立即落回历史(旧的已截掉)
  assert.equal(th.history.length, 1, '失败回合已截断,重发消息已落历史');
  assert.equal(failedBubble.removed, true, '失败气泡已移除');
  assert.equal(userBubble.removed, true, '旧用户气泡一并移除,避免视觉重复');
  assert.equal(sent().length, n0 + 2, '重发请求已发出');
  const lastSent = sent().at(-1).payload.messages.at(-1);
  assert.equal(lastSent.role, 'user');
  assert.equal(lastSent.content, '查一下磁盘');

  // 完成后历史重新落回一条 user + 一条 assistant
  const h = state.aiReq;
  h.acc = '磁盘使用正常';
  ai.aiFinishHolder({ requestId: h.id, finishReason: 'stop' });
  assert.equal(th.history.length, 2);
});

test('retry is rejected while thread is busy', async () => {
  const { ai, state, calls, toasts } = await setup();
  const th = ai.ensureDefaultAiThread();
  const user = ai.renderAiMessage('user', '你好吗');
  user.__raw = '你好吗';
  const failed = ai.renderAiMessage('assistant', '⚠️ 超时');
  failed.dataset.responseState = 'failed';
  th.history.push({ role: 'user', content: '你好吗' });

  // 占住线程
  const blocker = makeBubble();
  const req = ai.aiRequest([{ role: 'user', content: '占位' }], blocker);

  const n = calls.filter((c) => c.channel === 'ai:chat').length;
  const retryBtn = failed.querySelector('[data-ai-retry]');
  failed.listeners.get('click')({ target: retryBtn, stopPropagation() {} });
  assert.equal(calls.filter((c) => c.channel === 'ai:chat').length, n, '忙时不发重发请求');
  assert.ok(toasts.some((t) => /正在处理中/.test(t.message)));
  ai.aiFinishHolder({ requestId: state.aiReq.id });
  await req;
});

test('apiKey mask length reflects actual key length and reveal/hide preserves it', async () => {
  const { ai, $, state } = await setup(async (channel) => {
    if (channel === 'ai:revealApiKey') return { apiKey: 'sk-proj-12345678901234567890' }; // 28 chars
    return { ok: true };
  });
  state.settings.ai.apiKeySet = true;
  state.settings.ai.apiKeyLen = 28;
  ai.openAiSettings();
  const input = $('#ai-apikey');
  assert.equal(input.value, '•'.repeat(28), '初始掩码应与真实 API Key 长度 28 一致');
  assert.equal(input.type, 'password');

  // 查看明文
  await ai.toggleAiApiKeyVisibility();
  assert.equal(input.value, 'sk-proj-12345678901234567890');
  assert.equal(input.type, 'text');

  // 隐藏明文
  await ai.toggleAiApiKeyVisibility();
  assert.equal(input.type, 'password');
  assert.equal(input.value.length, 28, '隐藏后长度依然为 28 字符');
});

test('multi mode with all links down intercepts aiSend: no ai:chat request, input preserved', async () => {
  const { ai, $, state, calls } = await setup();
  const th = ai.createAiThread({ title: '多主机离线', hostId: 'h-down', hostName: 'my-server' });
  th.linkMode = 'multi';
  th.linkedHostIds = ['h-down'];
  state.aiLinks = new Map([['h-down', {
    hostId: 'h-down', hostKey: 'h-down', hostName: 'my-server',
    sessionId: 'ailink-x', status: 'error', headless: true, error: 'auth failed', refs: 1,
  }]]);
  ai.switchAiThread(th.id);

  $('#ai-input').value = 'systemctl status nginx';
  const n0 = calls.filter((c) => c.channel === 'ai:chat').length;

  await ai.aiSend();

  assert.equal(calls.filter((c) => c.channel === 'ai:chat').length, n0, '全部主机未连接时不发 ai:chat 请求');
  assert.equal($('#ai-input').value, 'systemctl status nginx', '输入框文字必须保留');
  assert.ok(th.sendBlocked, 'thread.sendBlocked 必须置位');
  assert.equal(th.sendBlocked.text, 'systemctl status nginx');

  // 程序发起的发送（如重发）也会被写回输入框与草稿
  $('#ai-input').value = '';
  await ai.aiSend('free -m');
  assert.equal($('#ai-input').value, 'free -m', '程序发起的文本也写回输入框');
  assert.equal(th.sendBlocked.text, 'free -m');
  assert.equal(th.draft, 'free -m');
});

test('follow mode without a connected window sends as plain chat without tools', async () => {
  const { ai, $, state, calls } = await setup();
  const th = ai.createAiThread({ title: '未链接对话' });
  ai.switchAiThread(th.id);
  assert.equal(th.linkMode, 'follow');
  assert.equal(state.sessions.size, 0);

  const n0 = calls.filter((c) => c.channel === 'ai:chat').length;
  $('#ai-input').value = '写个排序算法';
  const p = ai.aiSend();

  assert.equal(calls.filter((c) => c.channel === 'ai:chat').length, n0 + 1, '窗口无主机时走普通对话');
  assert.equal($('#ai-input').value, '', '已成功发出的输入框已清空');
  assert.equal(th.sendBlocked, null);
  ai.aiFinishHolder({ requestId: th.req.id, finishReason: 'stop' });
  await p;
});

test('ai drawer badges: follow thread hides host badge; chat shows dialog mode; multi shows count', async () => {
  const { ai, $, state } = await setup();

  // 1. 未链接的跟随对话 -> 不显示任何主机徽标
  const thFollow = ai.createAiThread({ title: '跟随' });

  // 2. chat 对话 -> 显示「对话模式」
  const thChat = ai.createAiThread({ title: '对话模式会话' });
  thChat.linkMode = 'chat';

  // 3. 多主机对话 + 生成中 -> 「N 台主机」与 busy 并列
  const thMulti = ai.createAiThread({ title: '多主机', hostId: 'h-busy', hostName: 'prod-api' });
  thMulti.linkMode = 'multi';
  thMulti.linkedHostIds = ['h1', 'h2', 'h3'];
  thMulti.req = { id: 'req-busy' };

  ai.openAiDrawer();
  const list = $('#ai-drawer-list');

  const cardFollow = list.children.find((c) => c.dataset?.threadId === thFollow.id);
  assert.ok(cardFollow);
  assert.doesNotMatch(cardFollow.innerHTML, /ai-drawer-badge host/, '跟随对话未链接主机时不显示主机徽标');
  assert.doesNotMatch(cardFollow.innerHTML, /ai-drawer-badge chat/, '跟随模式不显示对话模式徽标');

  const cardChat = list.children.find((c) => c.dataset?.threadId === thChat.id);
  assert.ok(cardChat);
  assert.match(cardChat.innerHTML, /ai-drawer-badge chat/, 'chat 对话显示对话模式徽标');
  assert.match(cardChat.innerHTML, /对话模式/);

  const cardMulti = list.children.find((c) => c.dataset?.threadId === thMulti.id);
  assert.ok(cardMulti);
  assert.match(cardMulti.innerHTML, /ai-drawer-badge host/, '多主机对话显示主机徽标');
  assert.match(cardMulti.innerHTML, /ai-drawer-badge busy/, 'busy 对话显示生成中徽标');
  assert.match(cardMulti.innerHTML, /3 台主机/);
  assert.match(cardMulti.innerHTML, /生成中/);
});

test('工具回合收口:中间步骤与本轮命令清单收进默认收起的折叠块,最终结论留在信息流', async () => {
  const { ai, state } = await setup();
  const th = ai.createAiThread({ title: '折叠' });
  state.activeThreadId = th.id;

  const token = ai.beginAiTurn(th);
  const doc = ai.renderAiMessage('user', '网站 502 了，帮我查下').ownerDocument;
  const step = () => {
    const node = doc.createElement('div');
    node.className = 'ai-step';
    node.dataset.tool = 'exec';
    ai.appendToThreadView(th, node);
    return node;
  };
  const skeleton = doc.createElement('div');
  skeleton.className = 'ai-turn-card ai-turn-summary';
  ai.appendToThreadView(th, skeleton);
  step();
  step();
  // 中间轮次只调用工具：气泡没有正文
  ai.renderAiMessage('assistant', '', { thread: th });
  const conclusion = ai.renderAiMessage('assistant', '根因：容器内 Caddy 的站点地址填的是服务器 IP', { thread: th });

  ai.endAiTurn(th, token);

  const folds = th.containerEl.children.filter((c) => c.className === 'ai-turn-fold');
  assert.equal(folds.length, 1, '一轮只生成一个折叠块');
  const fold = folds[0];
  assert.equal(fold.querySelector('.ai-turn-fold-head').getAttribute('aria-expanded'), 'false');
  assert.equal(fold.querySelector('.ai-turn-fold-body').hidden, true, '默认收起');
  assert.equal(fold.querySelectorAll('.ai-step').length, 2, '步骤行收进折叠块');
  assert.ok(fold.querySelector('.ai-turn-summary'), '执行记录命令清单收进折叠块');
  assert.ok(!fold.contains(conclusion), '最终结论留在信息流');
  assert.ok(th.containerEl.children.includes(conclusion), '结论仍是消息列表的直接子节点');
  assert.equal(th.containerEl.children.filter((c) => c.className === 'ai-step').length, 0, '步骤行不再散落在信息流里');
  // 折叠块在结论之前（过程在上、结论在下）
  assert.ok(th.containerEl.children.indexOf(fold) < th.containerEl.children.indexOf(conclusion));
});

test('工具回合收口:模型直接作答（无步骤行）与失败轮都不折叠', async () => {
  const { ai, state } = await setup();
  const th = ai.createAiThread({ title: '不折叠' });
  state.activeThreadId = th.id;

  // 1) 一轮只有一条回复：没有可折叠的过程
  const plain = ai.beginAiTurn(th);
  ai.renderAiMessage('assistant', '直接给结论', { thread: th });
  ai.endAiTurn(th, plain);
  assert.equal(th.containerEl.children.filter((c) => c.className === 'ai-turn-fold').length, 0);

  // 2) 失败轮：错误气泡的「重发」靠相邻用户气泡定位，收进折叠会找不到来源
  const failedTurn = ai.beginAiTurn(th);
  const doc = ai.renderAiMessage('user', '再试一次').ownerDocument;
  const step = doc.createElement('div');
  step.className = 'ai-step';
  ai.appendToThreadView(th, step);
  const failed = ai.renderAiMessage('assistant', '⚠️ 连接超时', { thread: th });
  failed.dataset.responseState = 'failed';
  ai.endAiTurn(th, failedTurn);
  assert.equal(th.containerEl.children.filter((c) => c.className === 'ai-turn-fold').length, 0);
  assert.ok(th.containerEl.children.includes(failed));
  assert.ok(th.containerEl.children.includes(step));
});

test('tokenRateOf only reports a rate when generation time is measurable', async () => {
  const { ai } = await setup();
  assert.equal(ai.tokenRateOf(null), null);
  // 没有输出 / 没有计时 / 时长过短都视为不可用
  assert.equal(ai.tokenRateOf({ completionTokens: 0, genMs: 5000 }), null);
  assert.equal(ai.tokenRateOf({ completionTokens: 100, genMs: null }), null);
  assert.equal(ai.tokenRateOf({ completionTokens: 100, genMs: 150 }), null); // <200ms 是噪声
  // 正常:100 token / 2s = 50 tok/s
  assert.equal(ai.tokenRateOf({ completionTokens: 100, genMs: 2000 }), 50);
  // 边界:刚好 200ms 可用
  assert.equal(ai.tokenRateOf({ completionTokens: 20, genMs: 200 }), 100);
});

test('cacheHitRateOf handles the three protocol shapes and hides when unsupported', async () => {
  const { ai } = await setup();
  // 供应商完全不报缓存:返回 null(界面隐藏该行),不是 0
  assert.equal(ai.cacheHitRateOf({ promptTokens: 1000 }), null);
  assert.equal(ai.cacheHitRateOf(null), null);

  // OpenAI:promptTokens 已含 cached
  assert.equal(ai.cacheHitRateOf({ promptTokens: 1000, cacheReadTokens: 800 }, 'openai'), 0.8);
  // OpenAI 命中为 0:如实返回 0(真没命中),不是 null
  assert.equal(ai.cacheHitRateOf({ promptTokens: 1000, cacheReadTokens: 0 }, 'openai'), 0);

  // DeepSeek:命中与未命中分别是两个字段
  assert.equal(ai.cacheHitRateOf({ cacheReadTokens: 750, cacheWriteTokens: 250 }, 'openai'), 0.75);

  // Anthropic:input 不含缓存部分,分母要加回 read+write
  assert.equal(
    ai.cacheHitRateOf({ promptTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }, 'anthropic'),
    800 / 1000,
  );

  // 异常口径:命中率 >100% 时封顶
  assert.equal(ai.cacheHitRateOf({ promptTokens: 100, cacheReadTokens: 900 }, 'openai'), 1);
  // 分母为 0 时不可计算
  assert.equal(ai.cacheHitRateOf({ promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
});
