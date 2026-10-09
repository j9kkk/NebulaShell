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
    this._text = ''; this._html = ''; this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (...items) => items.forEach((x) => classes.add(x)),
      remove: (...items) => items.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x, on) => (on ?? !classes.has(x)) ? classes.add(x) : classes.delete(x),
    };
  }
  set textContent(value) { this._text = String(value); this._html = ''; }
  get textContent() { return this._text; }
  set innerHTML(value) { this._html = String(value); this._text = this._html.replace(/<[^>]+>/g, ''); this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  setAttribute() {}
  querySelector(selector) { return this.parts?.[selector] || null; }
  querySelectorAll() { return []; }
  focus() {}
  remove() { this.removed = true; }
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
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const calls = [], toasts = [], timers = new Map(), cancelledFrames = [];
  const copies = [], confirmations = [], submissions = [];
  let timerId = 0;
  const state = {
    settings: { ai: { provider: 'custom', protocol: 'openai', baseUrl: 'https://saved.example/v1', model: 'm1', models: ['m1', 'm2'], apiKeySet: true } },
    aiSelected: [], aiModels: [], aiReq: null, aiHistory: [], sessions: new Map(),
  };
  const context = vm.createContext({
    console, crypto: webcrypto, performance, Date,
    document: { querySelector: $, createElement: () => new Element() },
    CSS: { escape: (x) => x },
    setTimeout: (cb, ms) => { const id = ++timerId; timers.set(id, { cb, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    cancelAnimationFrame: (id) => cancelledFrames.push(id),
  });
  const core = new vm.SyntheticModule(['$', 'state', 'api', 'toast', 'openModal', 'closeModal', 'copyText', 'askConfirm'], function () {
    this.setExport('$', $); this.setExport('state', state);
    this.setExport('toast', (message, type) => toasts.push({ message, type }));
    this.setExport('copyText', async (text) => { copies.push(text); return true; });
    this.setExport('askConfirm', async (message, opts) => { confirmations.push({ message, opts }); return confirm(message, opts, state); });
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
  const interaction = new vm.SyntheticModule(['popupPosition'], function () {
    this.setExport('popupPosition', (anchor, w, h, placement) => ({ left: 0, top: 0, placement: placement || 'bottom' }));
  }, { context });
  const module = await load('../src/modules/ai.js');
  await module.link((specifier) => ({ './core.js': core, './hosts.js': hosts, './terminal.js': terminal, './interaction.js': interaction, '../shared/icons.js': icons, '../shared/markdown.js': markdown, '../shared/ai-command-blocks.js': classification, '../shared/ai-presets.js': presets, '../shared/term-text.js': termText }[specifier]));
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
  assert.equal($('#ai-model-switch').disabled, false);
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
  assert.equal(ai.formatTokenCount(999999), '1000K');
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
