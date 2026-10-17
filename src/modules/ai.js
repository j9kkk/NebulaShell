// AI 助手:流式对话、模型切换、设置弹窗、诊断
import { $, api, askConfirm, askPrompt, closeModal, copyText, openModal, state, toast } from './core.js';
import { icon } from '../shared/icons.js';
import { escapeHtml } from './hosts.js';

export const MASKED_SECRET = '••••••••';
export function secretMask(len = 8) {
  return '•'.repeat(Math.max(1, len || 8));
}
let aiKeySecretState = {
  has: false,
  len: 0,
  mask: '',
  plain: null,
  revealed: false,
  endpoint: '',
};
import { popupPosition } from './interaction.js';
import { commandBlockTargetStatus, getCommandBlockTarget, submitCommandBlock } from './terminal.js';
import { renderMarkdown } from '../shared/markdown.js';
import { stripTerminalNoise } from '../shared/term-text.js';
import { classifyCommandBlock } from '../shared/ai-command-blocks.js';
import { AI_PRESETS, AI_SYSTEM_PROMPT } from '../shared/ai-presets.js';
import { hostKeyOf, hostLabelOf, rebindThread, resolveAiTarget, threadLinkMode } from '../shared/ai-target-state.js';
import { agentAvailable, agentBinding, refreshAgentHostBar, runAgentSend } from './ai-agent-run.js';
import { clearThreadLinks, linksForThread } from './ai-links.js';

export { hostKeyOf, hostLabelOf };

export const AI_HISTORY_LIMIT = 20;
export const AI_THREAD_LIMIT = 20;
// 消息区 DOM 上限:超出的旧气泡直接移除,避免长会话下无界增长。
export const AI_DOM_LIMIT = 200;
export const AI_IDLE_TIMEOUT_MS = 60_000;

// 设置表单是草稿,对话只读已保存配置。候选列表也只属于当前端点的草稿。
let aiDraft = null;
let modelsFetchSeq = 0;

export function aiEndpointIdentity(ai = {}) {
  return `${ai.protocol || 'openai'}\n${String(ai.baseUrl || '').trim().replace(/\/+$/, '')}`;
}

function savedAi() { return (state.settings && state.settings.ai) || {}; }
/// 当前生效模型 id:供 __nbTest 钩子等外部观测(原 #ai-model-switch.value 语义)
export function savedAiModelId() { return savedAi().model || ''; }

function savedModels() {
  const s = savedAi();
  const models = Array.isArray(s.models) ? s.models.map(normModel).filter((m) => m.id) : [];
  if (s.model && !models.some((m) => m.id === s.model)) models.push(normModel(s.model));
  return models;
}

function draftEndpoint() {
  return { protocol: $('#ai-protocol').value, baseUrl: $('#ai-baseurl').value.trim() };
}

const FETCH_BTN_TITLE = '拉取模型列表';
const FETCH_BTN_TITLE_BUSY = '正在拉取模型列表…';

function resetModelFetchButton() {
  const btn = $('#btn-ai-fetch-models');
  if (btn) { btn.__aiFetchSeq = 0; btn.disabled = false; btn.title = FETCH_BTN_TITLE; }
}

export function onAiEndpointChange() {
  const endpoint = aiEndpointIdentity(draftEndpoint());
  if (!aiDraft) aiDraft = { endpoint };
  if (aiDraft.endpoint !== endpoint) {
    // 即使用户已输入新密钥,换端点后也不能悄悄把它发送给另一家。
    $('#ai-apikey').value = '';
    aiDraft.endpoint = endpoint;
    state.aiModels = [];
    modelsFetchSeq++;
    resetModelFetchButton();
    closeModelPicker();
  }
  const same = endpoint === aiEndpointIdentity(savedAi());
  const usableSavedKey = same && savedAi().apiKeySet;
  const keyInput = $('#ai-apikey');
  const revealBtn = $('#btn-reveal-ai-apikey');
  if (usableSavedKey) {
    const len = savedAi().apiKeyLen || 8;
    const mask = secretMask(len);
    aiKeySecretState = {
      has: true,
      len,
      mask,
      plain: aiKeySecretState.endpoint === endpoint ? aiKeySecretState.plain : null,
      revealed: false,
      endpoint,
    };
    if (!keyInput.value || keyInput.value === MASKED_SECRET || keyInput.value === mask) {
      keyInput.value = mask;
      keyInput.type = 'password';
    }
    keyInput.placeholder = '密钥';
    if (revealBtn) {
      revealBtn.classList.remove('hidden');
      revealBtn.title = '显示密钥';
      revealBtn.innerHTML = icon('eyeOff');
    }
  } else {
    if (keyInput.value === MASKED_SECRET || keyInput.value === aiKeySecretState.mask) {
      keyInput.value = '';
      keyInput.type = 'password';
    }
    aiKeySecretState = { has: false, len: 0, mask: '', plain: null, revealed: false, endpoint };
    keyInput.placeholder = '新端点需填写密钥（本地服务可留空）';
    if (revealBtn) revealBtn.classList.toggle('hidden', !keyInput.value);
  }
  const status = $('#ai-key-status');
  if (status) status.textContent = '';
}

export async function toggleAiApiKeyVisibility() {
  const input = $('#ai-apikey');
  const btn = $('#btn-reveal-ai-apikey');
  if (!input || !btn) return;
  if (!aiKeySecretState.revealed) {
    if (aiKeySecretState.has && aiKeySecretState.plain === null && (input.value === aiKeySecretState.mask || input.value === MASKED_SECRET)) {
      try {
        const res = await api('ai:revealApiKey');
        aiKeySecretState.plain = res?.apiKey || '';
        aiKeySecretState.len = aiKeySecretState.plain.length;
        aiKeySecretState.mask = secretMask(aiKeySecretState.len);
        input.value = aiKeySecretState.plain;
      } catch (e) {
        toast('获取 API Key 明文失败：' + e.message, 'error');
        return;
      }
    }
    input.type = 'text';
    aiKeySecretState.revealed = true;
    btn.title = '隐藏密钥';
    btn.innerHTML = icon('eye');
  } else {
    input.type = 'password';
    aiKeySecretState.revealed = false;
    btn.title = '显示密钥';
    btn.innerHTML = icon('eyeOff');
  }
}

export function onAiApiKeyInput() {
  const input = $('#ai-apikey');
  const btn = $('#btn-reveal-ai-apikey');
  if (!input || !btn) return;
  const val = input.value;
  btn.classList.toggle('hidden', val.length === 0);
  if (val.length === 0 && input.type === 'text') {
    input.type = 'password';
    btn.title = '显示密钥';
    btn.innerHTML = icon('eyeOff');
  }
}

export function readAiDraft() {
  // 除入口事件外再校验一次,避免脚本或预设更改绕过 input/change 事件。
  onAiEndpointChange();
  const rawKey = $('#ai-apikey').value.trim();
  const same = aiDraft.endpoint === aiEndpointIdentity(savedAi());
  const hadSavedKey = same && savedAi().apiKeySet;
  let clearApiKey = false;
  let apiKey = '';
  let useSavedApiKey = false;

  const isMask = rawKey === aiKeySecretState.mask || rawKey === MASKED_SECRET;
  const isPlain = aiKeySecretState.plain !== null && rawKey === aiKeySecretState.plain;

  if (hadSavedKey && rawKey === '') {
    clearApiKey = true;
  } else if (rawKey !== '' && !isMask && !isPlain) {
    apiKey = rawKey;
  } else if ((isMask || isPlain) && hadSavedKey) {
    useSavedApiKey = true;
  }

  return {
    ...draftEndpoint(), model: $('#ai-model').value.trim(),
    apiKey,
    useSavedApiKey,
    clearApiKey,
  };
}

export function addManualAiModel(id = $('#ai-model-inline')?.value) {
  const model = String(id || '').trim();
  if (!model) return toast('请填写模型 ID', 'error');
  if (!state.aiSelected.some((m) => m.id === model)) state.aiSelected.push(normModel(model));
  if (!state.aiModels.some((m) => m.id === model)) state.aiModels.push(normModel(model));
  $('#ai-model').value = model;
  const input = $('#ai-model-inline');
  if (input) input.value = '';
  renderModelChips();
}

export function closeAiSettings() {
  aiDraft = null;
  modelsFetchSeq++;
  resetModelFetchButton();
  state.aiModels = savedModels();
  $('#ai-apikey').value = '';
  closeModelPicker();
  closeModal('#modal-settings');
  syncSelectedModelsFromSettings();
}

let threadSeq = 0;

export function activeAiThread() {
  if (!state.aiThreads) return null;
  return state.activeThreadId ? state.aiThreads.get(state.activeThreadId) : null;
}

/// 线程忙：有流式请求，或工具回合进行中（执行命令、等确认时没有流式请求）。
export function threadBusy(th) {
  return !!(th && (th.req || th.agentRun));
}

export function trimAiHistory(targetThread) {
  const th = targetThread || activeAiThread();
  if (!th || !th.history) return;
  const agentic = th.history.some((m) => m.role === 'tool' || m.toolCalls);
  if (!agentic) {
    if (th.history.length > AI_HISTORY_LIMIT) th.history = th.history.slice(-AI_HISTORY_LIMIT);
    return;
  }
  // 含工具往返的历史按回合裁：从用户消息处切，工具调用与结果不能拆开；
  // 当前回合再长也整段保留（发请求时另有按体积的压缩）。
  const limit = AI_HISTORY_LIMIT * 3;
  if (th.history.length <= limit) return;
  let start = th.history.length - limit;
  while (start < th.history.length && th.history[start].role !== 'user') start++;
  if (start >= th.history.length) start = th.history.findLastIndex((m) => m.role === 'user');
  if (start > 0) th.history = th.history.slice(start);
}

/// 工具步骤、确认卡等非气泡元素挂到指定线程的消息列表（后台线程也挂到自己那里）。
export function appendToThreadView(thread, el) {
  const container = ensureThreadContainer(thread) || $('#ai-messages');
  container.appendChild(el);
  while (container.children.length > AI_DOM_LIMIT) container.removeChild(container.firstChild);
  if (thread?.id === state.activeThreadId) aiStickScroll();
}

function ensureThreadContainer(thread) {
  const box = $('#ai-messages');
  if (!box || !thread) return box;
  if (!thread.containerEl) {
    const c = document.createElement('div');
    c.className = 'ai-thread-view';
    c.dataset.threadId = thread.id;
    thread.containerEl = c;
  }
  if (thread.containerEl.parentNode !== box) {
    box.appendChild(thread.containerEl);
  }
  if (state.activeThreadId === thread.id && !thread.containerEl.classList.contains('active')) {
    thread.containerEl.classList.add('active');
  }
  return thread.containerEl;
}

export function deriveThreadTitle(text) {
  const clean = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/^[#\s*`>-]+/, '').trim();
  if (!clean) return '新对话';
  const chars = Array.from(clean);
  return chars.length > 18 ? chars.slice(0, 18).join('') + '…' : clean;
}

const detachedRequests = new Map();

function discardHolder(h) {
  if (!h) return;
  h.cancelled = true;
  h.discarded = true;
  clearTimeout(h.idleTimer);
  if (h.raf) { cancelAnimationFrame(h.raf); h.raf = 0; }
  api('ai:abort', { requestId: h.id }).catch(() => {});
  h.resolve({ ok: true, aborted: true, text: h.acc });
}

export function ensureDefaultAiThread() {
  if (!state.aiThreads) state.aiThreads = new Map();
  if (state.aiThreads.size === 0) {
    createAiThread({ title: '新对话' });
  } else if (!state.activeThreadId || !state.aiThreads.has(state.activeThreadId)) {
    const firstId = state.aiThreads.keys().next().value;
    switchAiThread(firstId);
  }
  const active = activeAiThread();
  if (active) ensureThreadContainer(active);
  return active;
}

export function createAiThread({ hostId = null, hostName = null, sessionId = null, title = '新对话' } = {}) {
  if (!state.aiThreads) state.aiThreads = new Map();

  // AI_THREAD_LIMIT = 20: 淘汰非活动、非忙碌会话,空会话优先、最旧其次
  if (state.aiThreads.size >= AI_THREAD_LIMIT) {
    const candidates = [...state.aiThreads.values()]
      .filter((th) => th.id !== state.activeThreadId && !threadBusy(th));
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const aEmpty = a.history.length === 0 ? 0 : 1;
        const bEmpty = b.history.length === 0 ? 0 : 1;
        if (aEmpty !== bEmpty) return aEmpty - bEmpty;
        return (a.updatedAt || 0) - (b.updatedAt || 0);
      });
      const victim = candidates[0];
      if (victim.history.length > 0) {
        toast(`对话已达上限，已移除较早的「${victim.title || '对话'}」`, 'info');
      }
      if (victim.containerEl) victim.containerEl.remove();
      state.aiThreads.delete(victim.id);
    }
  }

  const id = 'th-' + Date.now().toString(36) + '-' + (++threadSeq);
  const container = document.createElement('div');
  container.className = 'ai-thread-view';
  container.dataset.threadId = id;

  const box = $('#ai-messages');
  if (box) {
    if (state.aiThreads.size === 0 && box.children) {
      const stray = [...box.children].filter((ch) => !ch.classList.contains('ai-thread-view'));
      for (const node of stray) container.appendChild(node);
    }
    box.appendChild(container);
  }

  const now = Date.now();
  const thread = {
    id,
    title: title || '新对话',
    autoTitle: !title || title === '新对话',
    hostId,
    hostName,
    sessionId,
    history: [],
    containerEl: container,
    req: null,
    // 默认「手动确认」:AI 可走工具循环,但每条命令先确认;要全自动再切自动档。
    execMode: 'manual',
    // 默认「跟随命令窗口」:对话作用于当前命令窗口的主机(与旧 bindNow 行为一致)。
    linkMode: 'follow',
    linkedHostIds: [],
    scroll: { top: 0, pinned: true },
    draft: '',
    unread: false,
    createdAt: now,
    updatedAt: now,
  };

  state.aiThreads.set(id, thread);
  switchAiThread(id);
  return thread;
}

export function newAiThread({ focus = false } = {}) {
  ensureDefaultAiThread();
  const cur = activeAiThread();

  if (cur && cur.history.length === 0 && !threadBusy(cur)) {
    if (focus) $('#ai-input')?.focus();
    return cur;
  }

  const otherEmpty = [...state.aiThreads.values()]
    .filter((th) => th.id !== cur?.id && th.history.length === 0 && !threadBusy(th) && !th.hostId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];

  if (otherEmpty) {
    switchAiThread(otherEmpty.id);
    if (focus) $('#ai-input')?.focus();
    return otherEmpty;
  }

  const created = createAiThread({ title: '新对话' });
  if (focus) $('#ai-input')?.focus();
  return created;
}

let pendingScrollRestore = null;

export function restoreThreadScroll(target) {
  const box = $('#ai-messages');
  if (!box || !target) return;
  const s = target.scroll || { top: 0, pinned: true };
  aiPinned = !!s.pinned;
  if (box.clientHeight > 0) {
    pendingScrollRestore = null;
    if (aiPinned) {
      box.scrollTop = box.scrollHeight;
    } else {
      box.scrollTop = s.top || 0;
    }
    aiSyncScrollButton(box);
  } else {
    pendingScrollRestore = target.id;
  }
}

export function switchAiThread(threadId) {
  if (!state.aiThreads) return;
  const target = state.aiThreads.get(threadId);
  if (!target) return;

  const prev = activeAiThread();
  const box = $('#ai-messages');
  const input = $('#ai-input');

  if (prev) {
    if (box && box.clientHeight > 0) {
      prev.scroll = { top: box.scrollTop, pinned: aiPinned };
    }
    if (input) {
      prev.draft = input.value;
    }
  }

  state.activeThreadId = threadId;
  target.unread = false;
  ensureThreadContainer(target);

  if (box && box.children) {
    for (const child of box.children) {
      if (child.classList?.contains('ai-thread-view')) {
        child.classList.toggle('active', child.dataset.threadId === threadId);
      }
    }
  }

  restoreThreadScroll(target);

  if (input) {
    input.value = target.draft || '';
  }

  setAiBusy(threadBusy(target));
  renderAiThreadBar();
  closeThreadMenu();
  refreshThreadUi();
  refreshAiCodeActions();
}

export function clearCurrentAiThread() {
  const thread = ensureDefaultAiThread();
  if (!thread) return;
  if (thread.req) {
    discardHolder(thread.req);
    thread.req = null;
    setAiBusy(false);
  }
  thread.agentRun?.ctrl.abort();
  // 清空即开始新任务:断开本对话的无头链接(继续保留旧内容属于另一台主机的语义已不成立)。
  clearThreadLinks(thread);
  thread.history = [];
  if (thread.containerEl) {
    thread.containerEl.innerHTML = '';
  }
  thread.title = '新对话';
  thread.autoTitle = true;
  thread.unread = false;
  // 清空即开始新任务：撤销自动执行与会话授权、下载污点，执行模式回到默认「手动确认」。
  thread.execMode = 'manual';
  thread.autoAcked = false;
  thread.allowlist = [];
  thread.taint = [];
  thread.scroll = { top: 0, pinned: true };
  restoreThreadScroll(thread);
  thread.updatedAt = Date.now();
  renderAiThreadBar();
  refreshThreadUi();
}

export function deleteAiThread(threadId) {
  const thread = state.aiThreads.get(threadId);
  if (!thread) return;
  if (state.aiThreads.size <= 1) {
    clearCurrentAiThread();
    closeThreadMenu();
    return;
  }
  if (thread.req) {
    discardHolder(thread.req);
    thread.req = null;
  }
  thread.agentRun?.ctrl.abort();
  // 删除对话要连带断开它自己的无头链接;别人引着的池条目由引用计数保留。
  clearThreadLinks(thread);
  if (thread.containerEl) {
    thread.containerEl.remove();
  }
  state.aiThreads.delete(threadId);
  if (state.activeThreadId === threadId) {
    const latest = [...state.aiThreads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (latest) switchAiThread(latest.id);
  } else {
    refreshThreadUi();
  }
}

export async function requestDeleteAiThread(threadId) {
  const id = threadId || state.activeThreadId;
  const thread = state.aiThreads?.get(id);
  if (!thread) return;

  if (state.aiThreads.size <= 1) {
    return requestClearAiThread();
  }

  const hasContent = thread.history?.length > 0;
  const isBusy = !!thread.req;

  if (hasContent || isBusy) {
    const menu = $('#ai-thread-menu');
    if (menu && !menu.classList.contains('hidden')) {
      closeThreadMenu({ focusTrigger: true });
    } else {
      closeThreadMenu();
    }
    const title = thread.title || '此对话';
    let msg = `确定要删除对话「${title}」吗？此操作不可撤销。`;
    if (isBusy) {
      msg += '\n\n当前对话正在生成回复，删除将中止生成。';
    }
    const ok = await askConfirm(msg, {
      title: '删除对话',
      okText: '删除',
      danger: true,
      defaultFocus: 'cancel',
    });
    if (!ok) return;
  }
  deleteAiThread(id);
}

export async function requestClearAiThread() {
  const thread = activeAiThread();
  if (!thread) return;

  const hasContent = thread.history?.length > 0;
  const isBusy = !!thread.req;

  if (hasContent || isBusy) {
    const menu = $('#ai-thread-menu');
    if (menu && !menu.classList.contains('hidden')) {
      closeThreadMenu({ focusTrigger: true });
    } else {
      closeThreadMenu();
    }
    let msg = '确定要清空当前对话的消息记录吗？此操作不可撤销。';
    if (isBusy) {
      msg += '\n\n当前对话正在生成回复，清空将中止生成。';
    }
    const ok = await askConfirm(msg, {
      title: '清空对话',
      okText: '清空',
      danger: true,
      defaultFocus: 'cancel',
    });
    if (!ok) return;
  }
  clearCurrentAiThread();
}

export function renderAiThreadBar() {
  const thread = activeAiThread();
  const titleEl = $('#ai-thread-title');
  const trigger = $('#ai-thread-trigger');
  if (!titleEl || !trigger) return;
  if (!thread) {
    titleEl.textContent = '新对话';
    trigger.title = '切换对话';
    trigger.classList.remove('has-busy', 'has-unread');
    trigger.setAttribute('aria-expanded', 'false');
    const countBadge = $('#ai-thread-count-badge');
    if (countBadge) countBadge.classList.remove('visible');
    return;
  }
  const baseTitle = thread.title || '新对话';
  titleEl.textContent = baseTitle;

  const nonActiveBusy = [...state.aiThreads.values()].some((th) => th.id !== state.activeThreadId && !!threadBusy(th));
  const nonActiveUnread = [...state.aiThreads.values()].some((th) => th.id !== state.activeThreadId && !!th.unread);
  trigger.classList.toggle('has-busy', nonActiveBusy);
  trigger.classList.toggle('has-unread', nonActiveUnread);

  const busyCount = [...state.aiThreads.values()].filter((th) => th.id !== state.activeThreadId && !!threadBusy(th)).length;
  const unreadCount = [...state.aiThreads.values()].filter((th) => th.id !== state.activeThreadId && !!th.unread).length;
  let tip = `当前对话：${baseTitle}（点击切换或管理历史会话）`;
  const extras = [];
  if (busyCount > 0) extras.push(`另有 ${busyCount} 个对话正在生成`);
  if (unreadCount > 0) extras.push(`另有 ${unreadCount} 个对话有新回复`);
  if (extras.length) tip += `\n（${extras.join('，')}）`;
  trigger.title = tip;

  const countBadge = $('#ai-thread-count-badge');
  if (countBadge) {
    const totalCount = state.aiThreads.size;
    countBadge.textContent = totalCount > 1 ? String(totalCount) : '';
    countBadge.classList.toggle('visible', totalCount > 1);
  }

  const menu = $('#ai-thread-menu');
  const isOpen = menu && !menu.classList.contains('hidden');
  trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

export function refreshThreadUi() {
  renderAiThreadBar();
  const menu = $('#ai-thread-menu');
  if (menu && !menu.classList.contains('hidden')) {
    renderThreadMenu();
  }
  if (isAiDrawerOpen()) {
    renderAiDrawer($('#ai-drawer-search')?.value || '');
  }
  refreshAgentHostBar();
}

function formatThreadTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (isToday) return timeStr;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
}

export async function renameAiThread(id, newTitle) {
  const th = state.aiThreads.get(id);
  if (!th) return;
  const trimmed = (newTitle || '').trim();
  if (trimmed) {
    th.title = trimmed;
    th.autoTitle = false;
    refreshThreadUi();
  }
}

export function isAiDrawerOpen() {
  const drawer = $('#ai-drawer');
  return !!drawer && !drawer.classList.contains('hidden');
}

export function openAiDrawer() {
  closeThreadMenu();
  const drawer = $('#ai-drawer');
  const toggleBtn = $('#ai-drawer-toggle');
  if (!drawer) return;
  drawer.classList.remove('hidden');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.classList.add('active');
  }
  const searchInp = $('#ai-drawer-search');
  renderAiDrawer(searchInp ? searchInp.value : '');
  if (searchInp) {
    searchInp.focus();
    searchInp.select?.();
  }
}

export function closeAiDrawer({ focusToggle = false } = {}) {
  const drawer = $('#ai-drawer');
  const toggleBtn = $('#ai-drawer-toggle');
  if (drawer) drawer.classList.add('hidden');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.classList.remove('active');
    if (focusToggle && typeof toggleBtn.focus === 'function') toggleBtn.focus();
  }
}

export function toggleAiDrawer() {
  if (isAiDrawerOpen()) closeAiDrawer();
  else openAiDrawer();
}

export function renderAiDrawer(kw = '') {
  const list = $('#ai-drawer-list');
  if (!list) return;
  ensureDefaultAiThread();
  const query = (kw || '').trim().toLowerCase();
  const allThreads = [...state.aiThreads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const filtered = query
    ? allThreads.filter((th) => `${th.title || ''} ${th.hostName || ''}`.toLowerCase().includes(query))
    : allThreads;

  list.innerHTML = '';
  if (!allThreads.length) {
    list.innerHTML = '<div class="ai-drawer-empty">暂无对话记录</div>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="ai-drawer-empty">未找到匹配的对话</div>';
    return;
  }

  const activeId = state.activeThreadId;
  for (const th of filtered) {
    const isActive = th.id === activeId;
    const isBusy = !!threadBusy(th);
    const isUnread = !!th.unread;
    const safeTitle = escapeHtml(th.title || '新对话');
    const msgCount = (th.history && th.history.length) || 0;
    const timeStr = formatThreadTime(th.updatedAt);

    const card = document.createElement('div');
    card.className = 'ai-drawer-card' + (isActive ? ' active' : '') + (isBusy ? ' busy' : '') + (isUnread ? ' unread' : '');
    card.dataset.threadId = th.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = `${th.title || '新对话'}\n点击切换到此对话`;

    let badges = [];
    const linkMode = threadLinkMode(th);
    if (linkMode === 'chat') {
      badges.push('<span class="ai-drawer-badge chat" title="对话模式：不操作主机">对话模式</span>');
    } else if (linkMode === 'multi') {
      const n = (th.linkedHostIds || []).length;
      if (n) badges.push(`<span class="ai-drawer-badge host" title="多主机模式"><span class="dot connected"></span><span class="t">${n} 台主机</span></span>`);
    } else if (th.hostName) {
      const isHostConnected = [...(state.sessions?.values?.() || [])].some((s) => s?.status === 'connected' && hostKeyOf(s.host) === th.hostId);
      const dotClass = isHostConnected ? 'connected' : 'idle';
      badges.push(`<span class="ai-drawer-badge host" title="主机: ${escapeHtml(th.hostName)}"><span class="dot ${dotClass}"></span><span class="t">${escapeHtml(th.hostName)}</span></span>`);
    }
    if (isBusy) {
      badges.push('<span class="ai-drawer-badge busy">生成中…</span>');
    } else if (isUnread) {
      badges.push('<span class="ai-drawer-badge unread">新回复</span>');
    }
    const badgeHtml = badges.join('');

    card.innerHTML = `
      <div class="ai-drawer-card-top">
        <span class="ai-drawer-card-title">${safeTitle}</span>
        <span class="ai-drawer-badges">${badgeHtml}</span>
      </div>
      <div class="ai-drawer-card-meta">
        <span class="ai-drawer-card-info">${msgCount} 条对话 · ${timeStr}</span>
        <div class="ai-drawer-card-actions">
          <button type="button" class="ai-drawer-btn-rename" data-rename-thread="${escapeHtml(th.id)}" title="重命名" aria-label="重命名对话">${icon('pencil', { size: 13 })}</button>
          <button type="button" class="ai-drawer-btn-del" data-del-thread="${escapeHtml(th.id)}" title="删除对话" aria-label="删除对话">${icon('trash', { size: 13 })}</button>
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest?.('.ai-drawer-btn-rename, .ai-drawer-btn-del')) return;
      switchAiThread(th.id);
      closeAiDrawer();
      $('#ai-input')?.focus();
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        switchAiThread(th.id);
        closeAiDrawer();
        $('#ai-input')?.focus();
      }
    });

    const renameBtn = card.querySelector('.ai-drawer-btn-rename');
    renameBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = await askPrompt('重命名对话', {
        title: '重命名对话',
        defaultValue: th.title || '新对话',
        placeholder: '输入新的对话标题'
      });
      if (newName != null && newName.trim()) {
        renameAiThread(th.id, newName.trim());
      }
    });

    const delBtn = card.querySelector('.ai-drawer-btn-del');
    delBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await requestDeleteAiThread(th.id);
    });

    list.appendChild(card);
  }
}

export function renderThreadMenu() {
  const menu = $('#ai-thread-menu');
  if (!menu) return;
  const list = $('#ai-thread-menu-list') || menu;
  ensureDefaultAiThread();
  const threads = [...state.aiThreads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const activeId = state.activeThreadId;

  let focusedIndex = -1;
  let hadFocusInMenu = false;
  if (document.activeElement && menu.contains(document.activeElement)) {
    hadFocusInMenu = true;
    const oldRows = Array.from(list.querySelectorAll('.ai-thread-menu-row'));
    const oldRow = document.activeElement.closest?.('.ai-thread-menu-row');
    focusedIndex = oldRow ? oldRows.indexOf(oldRow) : -1;
  }
  const focusedId = hadFocusInMenu
    ? (document.activeElement.dataset?.threadId || document.activeElement.closest?.('[data-thread-id]')?.dataset?.threadId)
    : null;

  list.innerHTML = threads.map((th) => {
    const isActive = th.id === activeId;
    const isBusy = !!threadBusy(th);
    const isUnread = !!th.unread;
    const safeTitle = escapeHtml(th.title || '新对话');
    const fullTitle = th.hostName ? `${th.title || '新对话'} · ${th.hostName}` : (th.title || '新对话');

    let badgeHtml = '';
    if (isBusy) {
      badgeHtml = '<span class="ai-thread-menu-badge">生成中…</span>';
    } else if (isUnread) {
      badgeHtml = '<span class="ai-thread-menu-badge">新回复</span>';
    } else if (th.hostName) {
      badgeHtml = `<span class="ai-thread-menu-badge">${escapeHtml(th.hostName)}</span>`;
    }

    const rowClasses = ['ai-thread-menu-row'];
    if (isActive) rowClasses.push('active');
    if (isBusy) rowClasses.push('busy');
    if (isUnread) rowClasses.push('unread');

    return `<div class="${rowClasses.join(' ')}" role="none" data-thread-id="${escapeHtml(th.id)}">` +
      `<button type="button" class="ai-thread-menu-item" role="menuitemradio" aria-checked="${isActive ? 'true' : 'false'}" data-thread-id="${escapeHtml(th.id)}" title="${escapeHtml(fullTitle)}">` +
        `<span class="ai-thread-menu-check" aria-hidden="true">✓</span>` +
        `<span class="ai-thread-menu-name">${safeTitle}</span>` +
        badgeHtml +
      `</button>` +
      `<button type="button" class="ai-thread-del" data-del-thread="${escapeHtml(th.id)}" tabindex="-1" aria-label="删除对话「${safeTitle}」" title="删除此对话">${icon('x', { size: 12 })}</button>` +
    `</div>`;
  }).join('');

  if (hadFocusInMenu) {
    const newItems = Array.from(list.querySelectorAll('.ai-thread-menu-item'));
    if (newItems.length > 0) {
      let toFocus = focusedId ? list.querySelector(`.ai-thread-menu-item[data-thread-id="${focusedId}"]`) : null;
      if (!toFocus) {
        const idx = Math.min(Math.max(0, focusedIndex), newItems.length - 1);
        toFocus = newItems[idx];
      }
      if (toFocus && typeof toFocus.focus === 'function') toFocus.focus();
    }
  }
}

export function onThreadMenuKeydown(e) {
  if (!e) return;
  const menu = $('#ai-thread-menu');
  if (!menu || menu.classList.contains('hidden')) return;

  const key = e.key;
  if (key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeThreadMenu({ focusTrigger: true });
    return;
  }
  if (key === 'Tab') {
    closeThreadMenu();
    return;
  }

  const items = Array.from(menu.querySelectorAll('.ai-thread-menu-item'));
  if (!items.length) return;

  const activeEl = document.activeElement;
  const currentIndex = items.indexOf(activeEl);

  if (key === 'ArrowDown' || key === 'Down') {
    e.preventDefault();
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
    return;
  }
  if (key === 'ArrowUp' || key === 'Up') {
    e.preventDefault();
    const prevIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    items[prevIndex]?.focus();
    return;
  }
  if (key === 'Home') {
    e.preventDefault();
    items[0]?.focus();
    return;
  }
  if (key === 'End') {
    e.preventDefault();
    items[items.length - 1]?.focus();
    return;
  }
  if (key === 'Delete' || key === 'Backspace') {
    e.preventDefault();
    const targetItem = activeEl?.closest?.('.ai-thread-menu-row');
    const threadId = targetItem?.dataset?.threadId;
    if (threadId) {
      requestDeleteAiThread(threadId);
    }
    return;
  }
}

export function openThreadMenu() {
  const menu = $('#ai-thread-menu');
  const trigger = $('#ai-thread-trigger');
  if (!menu || !trigger) return;
  $('#ai-model-menu')?.classList.add('hidden');
  $('#ai-mode-menu')?.classList.add('hidden');
  renderThreadMenu();
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  const tr = trigger.getBoundingClientRect();
  const size = { width: menu.offsetWidth || 240, height: menu.offsetHeight || 200 };
  const left = Math.max(8, Math.min(tr.left, window.innerWidth - size.width - 8));
  menu.style.left = left + 'px';
  menu.style.top = Math.min(window.innerHeight - size.height - 8, Math.max(8, tr.bottom + 4)) + 'px';

  const activeId = state.activeThreadId;
  const targetBtn = menu.querySelector(`.ai-thread-menu-item[data-thread-id="${activeId}"]`) || menu.querySelector('.ai-thread-menu-item');
  if (targetBtn && typeof targetBtn.focus === 'function') {
    targetBtn.focus();
  }
}

export function closeThreadMenu({ focusTrigger = false } = {}) {
  const menu = $('#ai-thread-menu');
  const trigger = $('#ai-thread-trigger');
  if (menu) menu.classList.add('hidden');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger && typeof trigger.focus === 'function') trigger.focus();
  }
}

export function toggleThreadMenu() {
  const menu = $('#ai-thread-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openThreadMenu();
  else closeThreadMenu();
}

/// 终端触发 AI 操作(如选区解释、右键报错诊断)时,智能匹配或分流到对应主机的会话,
/// 避免把主机 B 的报错塞进主机 A 的正在进行的排障上下文中。
export function ensureThreadForSession(session) {
  ensureDefaultAiThread();
  if (!session) return activeAiThread();
  const hostId = hostKeyOf(session.host);
  const hostName = hostLabelOf(session.host);
  const sessionId = session.sessionId || null;
  const cur = activeAiThread();

  // 1. 当前会话为空且空闲 → (重新)绑定到该主机并复用
  if (cur && cur.history.length === 0 && !threadBusy(cur)) {
    rebindThread(cur, { hostKey: hostId, hostLabel: hostName, sessionId });
    renderAiThreadBar();
    return cur;
  }

  // 2. 当前会话属于该主机且空闲 → 复用(更新 sessionId)
  if (cur && cur.hostId === hostId && !threadBusy(cur)) {
    cur.sessionId = sessionId;
    return cur;
  }

  // 3. 该主机最近更新的空闲会话 → 切过去
  const sameHost = [...state.aiThreads.values()]
    .filter((th) => th.hostId === hostId && !threadBusy(th))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (sameHost) {
    sameHost.sessionId = sessionId;
    switchAiThread(sameHost.id);
    return sameHost;
  }

  // 4. 任一空且空闲的未绑定会话 → 绑定并切过去
  const unbindEmpty = [...state.aiThreads.values()]
    .filter((th) => th.history.length === 0 && !threadBusy(th) && !th.hostId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (unbindEmpty) {
    rebindThread(unbindEmpty, { hostKey: hostId, hostLabel: hostName, sessionId });
    switchAiThread(unbindEmpty.id);
    return unbindEmpty;
  }

  // 5. 新建绑定该主机的会话
  return createAiThread({
    hostId,
    hostName,
    sessionId,
    title: '新对话',
  });
}

/// 气泡内部结构固定为:<div.ai-msg><div.ai-meta><span.ai-avatar/><span.ai-meta-text>时间</span></div>
/// <div.ai-row><div.ai-col><div.ai-body>内容</div><button.ai-copy/></div></div></div>。
/// 头像("我"/应用图标)与时间同行,在气泡外、气泡正上方 —— 用户侧头像在行尾
/// (row-reverse)。复制按钮锚定在气泡本体(.ai-col)右上角。内容一律走 .ai-body
/// —— 助手侧渲染 Markdown,用户侧纯文本(用户输入不当 Markdown 解析,原样展示)。
/// 裸文本进 textContent 的旧写法会连复制按钮一起被覆盖,所以所有写入都必须经过这里。
function aiBodyOf(bubble) {
  return bubble ? bubble.querySelector('.ai-body') : null;
}

export function setAiBody(bubble, text, { md = false } = {}) {
  const body = aiBodyOf(bubble);
  if (!body) return;
  bubble.__raw = String(text ?? '');
  // 默认只有助手侧渲染 Markdown;用户输入不当 Markdown 解析,原样展示。
  // 程序构造的 prompt(诊断/解释)本身含围栏代码块,走 md 分支。
  if (bubble.dataset.role === 'assistant' || md) {
    const rendered = renderMarkdown(text, { renderCodeBlock: (block) => renderAiCodeBlock(bubble, block) });
    bubble.__codeBlocks = rendered.codeBlocks;
    body.innerHTML = rendered.html;
  } else {
    bubble.__codeBlocks = [];
    body.textContent = text;
  }
}

const CODE_BLOCK_REASONS = {
  unclosed: '代码块尚未闭合', empty: '代码块为空',
  'control-character': '命令包含不允许的控制字符',
  'shell-prompt': '此块包含终端提示符，请复制并手动处理',
};
const RESPONSE_REASONS = {
  pending: '等待 AI 回复完成', streaming: '生成中，完成后才能执行',
  aborted: '回复已中止，仅支持复制', failed: '回复失败，仅支持复制',
  incomplete: '响应未正常结束，仅支持复制',
};

function aiCodeAvailability(bubble, block, captured = getCommandBlockTarget()) {
  const classification = classifyCommandBlock(block);
  if (bubble.dataset.role !== 'assistant') return { ok: false, reason: '用户消息仅支持复制' };
  if (classification.blockedReasons.length) return { ok: false, reason: CODE_BLOCK_REASONS[classification.blockedReasons[0]] || '此代码块不是明确的 Shell 命令' };
  if (bubble.dataset.responseState !== 'completed') return { ok: false, reason: RESPONSE_REASONS[bubble.dataset.responseState] || '等待 AI 回复正常结束' };
  if (bubble.__codeActionPending) return { ok: false, reason: '正在处理命令，请勿重复提交' };
  return captured.ok ? { ...commandBlockTargetStatus(captured.target, block.text), target: captured.target } : captured;
}

function aiCodeWarningText(classification) {
  return classification.warnings.map((warning) => `疑似示例参数「${warning.token}」：${warning.message}`).join('\n');
}

function aiCodeActionTitle(status, classification, action) {
  if (!status.ok) return status.reason;
  const warning = aiCodeWarningText(classification);
  return `${action === 'insert' ? '填入' : '执行'}到：${status.target.label}。请确保终端位于 Shell 提示符且没有未提交输入。` +
    (warning ? `\n${warning}\n执行前需确认，也可仅填入终端修改。` : '');
}

function renderAiCodeBlock(bubble, block) {
  const classification = classifyCommandBlock(block);
  const executable = bubble.dataset.role === 'assistant' && classification.shell;
  const status = executable ? aiCodeAvailability(bubble, block) : null;
  const title = executable ? aiCodeActionTitle(status, classification, 'execute') : '';
  const insertTitle = executable ? aiCodeActionTitle(status, classification, 'insert') : '';
  const warning = executable ? aiCodeWarningText(classification) : '';
  const notice = warning ? `<div class="ai-code-warning" role="note" aria-label="命令内容提醒">${escapeHtml(warning)}\n执行前需确认，也可仅填入终端修改。</div>` : '';
  const disabled = status?.ok ? '' : ' disabled';
  const actions = executable
    ? `<button type="button" class="ai-code-execute" data-ai-code-action="execute" title="${escapeHtml(title)}"${disabled}>执行</button>` +
      `<details class="ai-code-menu"><summary title="更多命令操作" aria-label="更多命令操作">▾</summary>` +
      `<div class="ai-code-menu-items"><button type="button" data-ai-code-action="insert" title="${escapeHtml(insertTitle)}"${disabled}>仅填入终端</button></div></details>`
    : '';
  return `<div class="ai-code-block" data-code-index="${block.index}">` +
    `<div class="ai-code-toolbar"><span class="ai-code-language">${escapeHtml(block.language || '代码')}</span>` +
    `<div class="ai-code-actions"><button type="button" data-ai-code-action="copy" title="复制此代码块">复制</button>${actions}</div></div>` +
    `${notice}<pre><code>${escapeHtml(block.text)}</code></pre></div>`;
}

export function refreshAiCodeActions(bubble) {
  let bubbles = [];
  if (bubble) {
    bubbles = [bubble];
  } else {
    const curTh = activeAiThread();
    if (curTh?.containerEl) {
      bubbles = typeof curTh.containerEl.querySelectorAll === 'function'
        ? curTh.containerEl.querySelectorAll('.ai-msg')
        : [];
    } else if (typeof document?.querySelectorAll === 'function') {
      bubbles = document.querySelectorAll('#ai-messages .ai-msg');
    }
  }
  const captured = getCommandBlockTarget();
  for (const message of bubbles) {
    for (const button of (typeof message?.querySelectorAll === 'function' ? message.querySelectorAll('[data-ai-code-action="execute"], [data-ai-code-action="insert"]') : [])) {
      const index = Number(button.closest('.ai-code-block').dataset.codeIndex);
      const block = message.__codeBlocks?.[index];
      const status = aiCodeAvailability(message, block, captured);
      button.disabled = !status.ok;
      button.title = aiCodeActionTitle(status, classifyCommandBlock(block), button.dataset.aiCodeAction);
    }
  }
}

export async function handleAiCodeAction(bubble, index, action) {
  const block = bubble.__codeBlocks?.[index];
  if (!block || !['copy', 'execute', 'insert'].includes(action)) return;
  const text = block.text;
  if (action === 'copy') {
    const ok = await copyText(text);
    toast(ok ? '已复制代码块' : '复制失败：剪贴板不可用', ok ? 'success' : 'error');
    return;
  }
  const status = aiCodeAvailability(bubble, block);
  if (!status.ok) return toast(status.reason, 'error');
  const target = status.target;
  const classification = classifyCommandBlock(block);

  bubble.__codeActionPending = true;
  refreshAiCodeActions(bubble);
  try {
    // 跨主机安全守卫:若此代码块在主机 A 上下文中生成,而用户当前焦点终端在主机 B,执行前强提示
    const targetHostKey = hostKeyOf(target.session?.host);
    if (bubble.__originHostId && targetHostKey && bubble.__originHostId !== targetHostKey) {
      const originHost = bubble.__originHostName || '其他主机';
      const currentHost = hostLabelOf(target.session?.host) || '当前主机';
      const allow = await askConfirm(
        `此代码块是在【${originHost}】上下文中生成的，而当前目标终端属于【${currentHost}】。\n\n是否确认在该终端上${action === 'execute' ? '发送并执行' : '填入'}？`,
        { title: '跨主机操作提醒', okText: action === 'execute' ? '确认执行' : '确认填入', danger: true, defaultFocus: 'cancel' },
      );
      if (!allow) return;
    }
    if (action === 'execute' && (classification.multiline || classification.risk || classification.warnings.length)) {
      const contentWarning = aiCodeWarningText(classification);
      const warning = [
        contentWarning ? `内容提醒：\n${contentWarning}\n请确认这些片段是有效参数，而非未填写的示例；也可取消后仅填入终端修改。` : '',
        classification.risk ? `风险提示：${classification.risk}（不涵盖所有风险）。` : '',
      ].filter(Boolean).join('\n');
      const confirmed = await askConfirm(
        `目标：${target.label}\n将整体发送以下 ${classification.lineCount} 行内容并提交回车：${warning ? '\n' + warning : ''}\n\n${text}\n\n请确认终端位于 Shell 提示符且没有未提交输入；内容可能改变远端系统。`,
        { title: '确认执行 AI 命令', okText: '发送并执行', danger: true, defaultFocus: 'cancel' },
      );
      if (!confirmed) return;
    }
    // A confirmation can outlive its reply; never submit a replaced block.
    if (bubble.dataset.responseState !== 'completed' || bubble.__codeBlocks?.[index] !== block || bubble.isConnected === false) {
      return toast('回复内容已变化，请重新选择命令', 'error');
    }
    const result = await submitCommandBlock(target, text, { execute: action === 'execute' });
    toast(result.ok ? `${action === 'execute' ? '已发送到' : '已填入（未提交回车）：'} ${target.label}` : result.reason, result.ok ? 'success' : 'error');
  } catch (e) {
    toast('命令发送失败：' + (e?.message || String(e)), 'error');
  } finally {
    bubble.__codeActionPending = false;
    refreshAiCodeActions(bubble);
  }
}

export function bindAiCodeActions() {
  if (bindAiCodeActions._bound) return;
  bindAiCodeActions._bound = true;
  document.addEventListener('nebula:state-change', () => refreshAiCodeActions());
  document.addEventListener('nebula:modal-scope', () => refreshAiCodeActions());
  document.addEventListener('pointerover', (event) => {
    const block = event.target.closest?.('.ai-code-block');
    if (block && !block.contains(event.relatedTarget)) refreshAiCodeActions(block.closest('.ai-msg'));
  });
  document.addEventListener('focusin', (event) => {
    const bubble = event.target.closest?.('.ai-msg');
    if (bubble) refreshAiCodeActions(bubble);
  });
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('.ai-code-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menu = event.target.closest?.('.ai-code-menu[open]');
    if (menu) { event.preventDefault(); menu.open = false; menu.querySelector('summary').focus(); }
  });
}

/* ---------------- 对话区滚动:贴底跟随 + "回到底部"按钮 ----------------
   滚动模型:只有阅读位置在底部(贴底)时,内容增长才自动跟随;用户上滚
   即停止打扰,靠浮动按钮一键回底。此前"每帧无条件 scrollTop=scrollHeight"
   有三个实测问题:流式期间无法上滚阅读;回复收尾的全量 DOM 重写会触发
   WebKit 滚动锚定把视图拽离底部(实测上跳上千 px);面板隐藏期间收到的
   回复在重开面板后停在旧位置(display:none 下滚动全是空操作)。 */

// 距底部多少像素内算"贴底":容纳小数高度与 macOS 橡皮筋回弹。
const AI_STICK_THRESHOLD = 24;

let aiPinned = true;
// 平滑滚动进行中,途中位置不在底部属预期,scroll 事件不参与贴底判定;
// 用户滚轮/按下/按键会清零该窗口,把滚动意图交还给用户。
let aiSmoothUntil = 0;

function aiAtBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= AI_STICK_THRESHOLD;
}

function aiSyncScrollButton(box = $('#ai-messages')) {
  const btn = $('#ai-scroll-bottom');
  if (!btn) return;
  // display:none 面板里三个高度都是 0:视为贴底,按钮保持隐藏
  btn.classList.toggle('show', box.clientHeight > 0 && !aiAtBottom(box));
}

/// 内容写入后的统一收口:贴底才跟随,不打扰上滚阅读的用户。
/// 面板隐藏(clientHeight 0)时滚动无意义,跳过;重开面板时由
/// right-panel.js 的 onShown 再调一次补齐。
export function aiStickScroll() {
  const box = $('#ai-messages');
  if (!box || box.clientHeight === 0) return;
  if (pendingScrollRestore) {
    const target = state.aiThreads?.get(pendingScrollRestore);
    if (target) {
      restoreThreadScroll(target);
      return;
    }
    pendingScrollRestore = null;
  }
  if (aiPinned && box.scrollHeight > box.scrollTop + box.clientHeight) {
    // 即时跳转:平滑动画会被下一帧流式写入反复打断,反而卡顿
    box.scrollTop = box.scrollHeight;
  }
  aiSyncScrollButton(box);
}

/// 用户明确想看最新(发送消息/点"回到底部")时的强制回底。
export function aiForceStickScroll({ smooth = false } = {}) {
  const box = $('#ai-messages');
  if (!box) return;
  aiPinned = true;
  if (box.clientHeight === 0) return; // 隐藏面板:重开时 aiStickScroll 补齐
  if (smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    aiSmoothUntil = performance.now() + 450;
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    // 动画末次的 scroll 事件仍落在抑制窗内(会被跳过):定时收尾补一次
    // 贴底/按钮同步,否则按钮停在"显示"态。用户中途打断则由打断后的
    // scroll 事件先行判定,这里按当时状态收敛即可。
    setTimeout(aiStickScroll, 470);
  } else {
    aiSmoothUntil = 0;
    box.scrollTop = box.scrollHeight;
  }
  aiSyncScrollButton(box);
}

export function bindAiScroll() {
  if (bindAiScroll._bound) return;
  bindAiScroll._bound = true;
  const box = $('#ai-messages');
  const btn = $('#ai-scroll-bottom');
  if (!box || !btn) return;
  box.addEventListener('scroll', () => {
    if (performance.now() < aiSmoothUntil) return;
    aiPinned = aiAtBottom(box);
    const th = activeAiThread();
    if (th) {
      th.scroll = { top: box.scrollTop, pinned: aiPinned };
    }
    aiSyncScrollButton(box);
  }, { passive: true });
  for (const type of ['wheel', 'pointerdown', 'keydown']) {
    box.addEventListener(type, () => { aiSmoothUntil = 0; }, { passive: true, capture: true });
  }
  btn.addEventListener('click', () => aiForceStickScroll({ smooth: !activeAiThread()?.req }));
  // 面板拖宽、窗口缩放、侧栏收起都改变可视高度:贴底时重新贴住
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => aiStickScroll()).observe(box);
  }
}

// 头像与发送时间:头像标来源(用户"我" / 助手应用图标),时间用 HH:MM。
// meta 行用 .ai-meta,低对比度、不随气泡 padding 走,见 style.css。
export function renderAiMessage(role, text, opts) {
  ensureDefaultAiThread();
  // 工具回合可能在后台线程里继续出气泡：必须挂到发起它的线程，而不是当前显示的线程。
  const thread = opts?.thread || activeAiThread();
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.dataset.role = role;
  el.dataset.responseState = 'completed';
  const activeSess = state.sessions?.get?.(state.activeId);
  const originHostId = thread?.hostId || hostKeyOf(activeSess?.host) || null;
  const originHostName = thread?.hostName || hostLabelOf(activeSess?.host) || null;
  if (originHostId) {
    el.__originHostId = originHostId;
    el.__originHostName = originHostName;
  }
  el.addEventListener('click', (event) => {
    const retry = event.target.closest?.('[data-ai-retry]');
    if (retry && el.contains(retry)) {
      event.stopPropagation();
      retryFailedMessage(el);
      return;
    }
    const button = event.target.closest?.('[data-ai-code-action]');
    if (!button || !el.contains(button) || button.disabled) return;
    event.stopPropagation();
    const menu = button.closest('.ai-code-menu');
    if (menu) menu.open = false;
    const index = Number(button.closest('.ai-code-block').dataset.codeIndex);
    handleAiCodeAction(el, index, button.dataset.aiCodeAction);
  });
  // 头像上移到元信息行(气泡外、气泡正上方)标来源:助手应用图标
  // (dist/icon.svg,build.mjs 从 src-tauri/icons/icon.svg 复制)在行首,
  // 用户"我"由 CSS row-reverse 渲染到行尾。图标 24px(16px 太小,logo 细节
  // 糊在一起);时间文字从头像旁起到气泡边缘,24px 头像 + 8px 间距正好落在
  // 气泡对齐缘(见 style.css .ai-meta / .ai-row 的 32px 缩进)。
  const avatar = document.createElement('span');
  avatar.className = 'ai-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  if (role === 'assistant') {
    avatar.innerHTML = '<img src="./icon.svg" alt="" width="24" height="24">';
  } else {
    avatar.textContent = '我';
  }
  const col = document.createElement('div');
  col.className = 'ai-col';
  const time = new Date();
  const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  // 时间戳单独放 .ai-meta-text:setAiMeta 只改这个节点的文字,
  // 不能整体重写 .ai-meta 的 textContent,否则头像节点会被抹掉。
  const meta = document.createElement('div');
  meta.className = 'ai-meta';
  const metaText = document.createElement('span');
  metaText.className = 'ai-meta-text';
  metaText.textContent = stamp;
  meta.appendChild(avatar);
  meta.appendChild(metaText);
  el.appendChild(meta);
  const body = document.createElement('div');
  body.className = 'ai-body';
  col.appendChild(body);
  const row = document.createElement('div');
  row.className = 'ai-row';
  row.appendChild(col);
  el.appendChild(row);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ai-copy';
  copy.title = '复制这条内容';
  copy.setAttribute('aria-label', '复制这条内容');
  copy.innerHTML = icon('copy');
  copy.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const ok = await copyText(el.__raw ?? '');
    toast(ok ? '已复制' : '复制失败：剪贴板不可用', ok ? 'success' : 'error');
  });
  // 复制按钮锚定气泡本体(.ai-col):悬停时贴气泡右上角,不随气泡外的元信息走
  col.appendChild(copy);
  // 失败重发按钮:仅 data-response-state="failed" 时随 hover 显现(CSS 控制),
  // 点一下把这条失败回合从历史截断并重发原用户消息。同样锚定 .ai-col,
  // 免疫 setAiBody 对正文的整体重写。
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ai-retry';
  retry.title = '重发这条消息';
  retry.setAttribute('aria-label', '重发这条消息');
  retry.dataset.aiRetry = '1';
  retry.innerHTML = icon('rotate') + '<span>重发</span>';
  // 点击交给气泡根上的事件委托(el 的 click 监听识别 [data-ai-retry] 并重发),
  // 这里不能再 stopPropagation —— 否则委托收不到,按钮就是个摆设。
  col.appendChild(retry);
  setAiBody(el, text, opts);
  const container = ensureThreadContainer(thread) || $('#ai-messages');
  container.appendChild(el);
  const box = $('#ai-messages');
  // DOM 上限:裁掉最旧的气泡。用户在上方阅读(未贴底)时,裁剪会让内容整体
  // 上移,按被裁高度补偿 scrollTop 保住阅读位置;贴底时反正要回底,无需补偿。
  let trimmedHeight = 0;
  if (container.children && container.children.length > AI_DOM_LIMIT) {
    const gap = (typeof getComputedStyle !== 'undefined' ? parseFloat(getComputedStyle(container).rowGap) : 0) || 0;
    while (container.children.length > AI_DOM_LIMIT) {
      const first = container.firstChild;
      trimmedHeight += (first.getBoundingClientRect ? first.getBoundingClientRect().height : 0) + gap;
      container.removeChild(first);
    }
  }
  if (thread && thread.id !== state.activeThreadId) return el;
  if (role === 'user') {
    // 发送/提问本身就是"看最新"的明确意图:无条件回底
    aiForceStickScroll();
  } else {
    if (trimmedHeight > 0 && !aiPinned && box) box.scrollTop += trimmedHeight;
    aiStickScroll();
  }
  return el;
}

/// token 数量单位换算:>=1M 显示 M,>=1000 显示 K,四舍五入保留 0 位小数。
export function formatTokenCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

/// AI 响应结束后的元信息行:模型、输入/输出 token、耗时。
/// 传入 null 值的项跳过;整行更新到 .ai-meta-text(时间戳扩展成完整元信息)。
/// 只改文字节点:.ai-meta 里还有头像,整体重写 textContent 会把它抹掉。
export function setAiMeta(bubble, { model, usage, elapsedMs } = {}) {
  if (!bubble) return;
  const meta = bubble.querySelector('.ai-meta-text');
  if (!meta) return;
  const parts = [];
  const t = meta.textContent;
  if (t) parts.push(t);
  if (model) parts.push(model);
  if (usage) {
    const tok = [];
    if (usage.promptTokens != null) tok.push(`${formatTokenCount(usage.promptTokens)}入`);
    if (usage.completionTokens != null) tok.push(`${formatTokenCount(usage.completionTokens)}出`);
    if (tok.length) parts.push('tokens ' + tok.join('/'));
  }
  if (elapsedMs != null) parts.push((elapsedMs / 1000).toFixed(1) + 's');
  meta.textContent = parts.join(' · ');
}

/// 等待首个 token 期间的气泡形态:转圈 + "正在思考…"。
/// 光是一个空气泡看不出"到底在没在跑",用户会以为卡死而重复发送。
/// 占位文案写进 .ai-body,结束时必须经 clearBubbleState 清掉,
/// 否则"未返回内容"的兜底文案会被这个占位挡住。
export function markBubblePending(bubble) {
  const body = aiBodyOf(bubble);
  if (!body || body.textContent) return;
  bubble.classList.add('pending');
  bubble.dataset.responseState = 'pending';
  bubble.dataset.pending = '1';
  const sp = document.createElement('span');
  sp.className = 'ai-spinner';
  sp.setAttribute('aria-hidden', 'true');
  // spinner 挂在 .ai-row 里、正文列之前:转圈和"正在思考…"同行,
  // 插进 .ai-col 会落到时间戳上方,成了一颗无意义的空心椭圆。
  const row = body.closest('.ai-row');
  const col = body.parentElement;
  if (row) row.insertBefore(sp, col);
  else col.appendChild(sp);
  body.textContent = '正在思考…';
  // 占位写入让气泡长高约一行:与 renderAiMessage 里的首次贴底相隔同帧,
  // 不收口就会从第一条回复起差出一点。调用方保证只对活动线程的气泡调用。
  aiStickScroll();
}

/// 首个 token 到达:撤掉等待态、清空占位,转入流式态(光标闪烁由 CSS 画)
export function markBubbleStreaming(bubble) {
  if (!bubble) return;
  bubble.dataset.responseState = 'streaming';
  if (bubble.dataset.pending) {
    delete bubble.dataset.pending;
    const sp = bubble.querySelector('.ai-spinner');
    if (sp) sp.remove();
    aiBodyOf(bubble).textContent = '';
  }
  bubble.classList.remove('pending');
  bubble.classList.add('streaming');
}

/// 思考内容展示:首帧时在 .ai-body 之前插入折叠块,之后只追加文本。
/// 默认收起只留"思考中…/已深度思考"一行;点头部展开可读。结构独立于
/// .ai-body,正文 delta 的 setAiBody 全量重写 .ai-body 不会碰它。
/// 收尾时由 aiFinishHolder 统一撤块:历史气泡不留中间态。
export function aiShowThinking(bubble, text) {
  let box = bubble.querySelector('.ai-thinking');
  if (!box) {
    const body = aiBodyOf(bubble);
    if (!body) return;
    box = document.createElement('div');
    box.className = 'ai-thinking streaming';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ai-thinking-head';
    head.setAttribute('aria-expanded', 'false');
    head.textContent = '思考中';
    head.addEventListener('click', () => {
      const open = box.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
    });
    const pre = document.createElement('div');
    pre.className = 'ai-thinking-text';
    box.append(head, pre);
    body.parentElement.insertBefore(box, body);
  }
  box.querySelector('.ai-thinking-text').textContent = text;
}

function removeThinking(bubble) {
  if (!bubble) return;
  const box = bubble.querySelector('.ai-thinking');
  if (box) box.remove();
}

/// 正文首 delta 到达:思考阶段结束,头部文案从"思考中"换成完成态,
/// 并撤掉流式动效。保持收起,展开阅读由用户点击决定。
export function aiSealThinking(bubble) {
  const box = bubble && bubble.querySelector('.ai-thinking');
  if (!box) return;
  box.classList.remove('streaming');
  const head = box.querySelector('.ai-thinking-head');
  if (head) head.textContent = '已深度思考';
}

export function clearBubbleState(bubble) {
  if (!bubble) return;
  bubble.classList.remove('pending', 'streaming');
  const sp = bubble.querySelector('.ai-spinner');
  if (sp) sp.remove();
  if (bubble.dataset.pending) {
    delete bubble.dataset.pending;
    aiBodyOf(bubble).textContent = ''; // 清掉占位,让"未返回内容"兜底生效
  }
}

export function setAiBusy(busy) {
  // 单按钮双状态:空闲=↑ 发送,流式=■ 停止(危险色,可点击中止)。
  // 忙时保持可点 —— 此时按钮的职责已从发送切换为停止。
  const send = $('#ai-send');
  send.classList.toggle('stop', busy);
  send.innerHTML = icon(busy ? 'stop' : 'arrowUpSend', { size: 16 });
  send.title = busy ? '停止生成' : '发送';
  renderModelSwitch();
}

export function findRequestHolder(requestId) {
  if (!requestId) return null;
  const cur = activeAiThread();
  if (cur?.req && cur.req.id === requestId) return { holder: cur.req, thread: cur };
  if (state.aiThreads) {
    for (const th of state.aiThreads.values()) {
      if (th.req && th.req.id === requestId) return { holder: th.req, thread: th };
    }
  }
  if (detachedRequests.has(requestId)) {
    return { holder: detachedRequests.get(requestId), thread: null };
  }
  return null;
}

function failAiRequest(holder, message) {
  if (!holder) return;
  holder.failed = message;
  if (holder.bubble) {
    clearBubbleState(holder.bubble);
    setAiBody(holder.bubble, (holder.acc ? holder.acc + '\n' : '') + '⚠️ ' + message);
  }
  aiFinishHolder({ requestId: holder.id });
}

// 入口收到匹配 requestId 的 delta 时调用。过期事件不得重启计时器。
export function aiTouchRequest(requestId) {
  const match = findRequestHolder(requestId);
  if (!match) return false;
  const h = match.holder;
  clearTimeout(h.idleTimer);
  h.idleTimer = setTimeout(() => {
    if (h.cancelled) return;
    h.cancelled = true;
    failAiRequest(h, 'AI 响应超时（60 秒未收到内容），请重试');
    api('ai:abort', { requestId: h.id }).catch(() => {});
  }, AI_IDLE_TIMEOUT_MS);
  return true;
}

export function stopAiGeneration() {
  const cur = activeAiThread();
  // 工具回合:中止整个回合(正在跑的远端命令、等待中的确认卡一并结束)。
  const run = cur?.agentRun;
  if (run) run.ctrl.abort();
  const h = cur?.req;
  if (!h) return !!run;
  h.cancelled = true;
  // 先结束本地 holder 并保留已返回文本;晚到的 delta/done/error 不再匹配。
  aiFinishHolder({ requestId: h.id, finishReason: 'aborted', elapsedMs: Date.now() - h.started });
  api('ai:abort', { requestId: h.id }).catch((e) => toast('停止请求失败：' + e.message, 'error'));
  return true;
}

// record=false:工具回合的历史由 ai-agent 按中立格式自己写;tools 随请求下发。
export function aiRequest(messages, bubble, override, { thread = null, detached = false, record = true, tools = null } = {}) {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const s = savedAi();
    // 显式快照,保存/切模型/编辑草稿都不能改变已经提交的请求。
    const config = override ? { ...override } : {
      protocol: s.protocol || 'openai', baseUrl: s.baseUrl || '', model: s.model || '',
      apiKey: '', useSavedApiKey: true,
    };
    const snapshot = messages.map((m) => ({ ...m }));

    if (detached) {
      const holder = {
        id: requestId, acc: '', bubble: null, resolve, messages: snapshot,
        model: config.model || '', started: Date.now(), recordHistory: false,
        threadId: null, detached: true,
      };
      detachedRequests.set(requestId, holder);
      aiTouchRequest(requestId);
      api('ai:chat', { requestId, messages: snapshot, ai: config }).then(() => {
        if (holder.cancelled) api('ai:abort', { requestId }).catch(() => {});
      }).catch((e) => failAiRequest(holder, e.message));
      return;
    }

    ensureDefaultAiThread();
    const targetThread = thread || activeAiThread();
    if (targetThread?.req) {
      resolve({ error: '已有请求进行中，请稍候' });
      return;
    }
    const holder = {
      id: requestId, acc: '', bubble, resolve, messages: snapshot,
      model: config.model || '', started: Date.now(), recordHistory: !!bubble && record,
      threadId: targetThread?.id || null, detached: false,
    };
    if (targetThread) targetThread.req = holder;

    if (bubble) {
      bubble.dataset.responseState = 'pending';
      refreshAiCodeActions(bubble);
    }
    if (targetThread?.id === state.activeThreadId) {
      setAiBusy(true);
    }
    refreshThreadUi();
    aiTouchRequest(requestId);
    api('ai:chat', { requestId, messages: snapshot, ai: config, ...(tools ? { tools } : {}) }).then(() => {
      // 若停止早于后端登记 abort flag,登记完成后再补一次取消。
      if (holder.cancelled) api('ai:abort', { requestId }).catch(() => {});
    }).catch((e) => failAiRequest(holder, e.message));
  });
}

export function aiFinishHolder(done) {
  const match = done?.requestId ? findRequestHolder(done.requestId) : null;
  if (!match) return;
  const { holder: h, thread } = match;
  clearTimeout(h.idleTimer);

  if (h.detached) {
    detachedRequests.delete(h.id);
    h.resolve(h.failed
      ? { error: h.failed, text: h.acc }
      : { ok: true, text: h.acc, aborted: done?.finishReason === 'aborted', usage: done && done.usage, elapsedMs: done && done.elapsedMs });
    return;
  }

  if (thread && thread.req === h) {
    thread.req = null;
  }

  if (state.activeThreadId === thread?.id || (!thread && !state.activeThreadId)) {
    setAiBusy(false);
  } else if (thread) {
    thread.unread = true;
  }
  refreshThreadUi();

  if (h.bubble) {
    // 顺序要紧:先撤等待态(会把"正在思考…"占位清空),再把最终累积文本落盘。
    // 取消未落地的合帧写入时**必须补写一次 h.acc** —— 最后一个 delta 可能已经
    // 累加进 h.acc 但还没被 rAF 画上去,直接 cancel 会把结尾整段吞掉。
    // 失败时不能补写:ai:error 已经往气泡里写了「正文 + ⚠️ 错误」,补写会盖掉它。
    clearBubbleState(h.bubble);
    h.bubble.dataset.responseState = h.failed ? 'failed'
      : h.cancelled || done?.finishReason === 'aborted' ? 'aborted'
        : done?.finishReason === 'stop' ? 'completed' : 'incomplete';
    if (h.raf) { cancelAnimationFrame(h.raf); h.raf = 0; }
    // 思考块只在流式期间存在;收尾撤掉 —— 历史气泡与重渲染都不留中间态,
    // 思考内容也不进历史(前端只保存正文 h.acc)。
    removeThinking(h.bubble);
    if (!h.failed && h.acc) setAiBody(h.bubble, h.acc);
    refreshAiCodeActions(h.bubble);
    if (!h.acc && !h.failed && done?.toolCalls?.length) {
      // 只调用工具、没有正文的一轮:步骤行就是它的内容,不留空气泡。
      h.bubble.remove();
    } else if (!h.acc && !h.failed && !aiBodyOf(h.bubble).textContent) {
      aiBodyOf(h.bubble).textContent = done?.finishReason === 'aborted' ? '（已停止生成）' : '（AI 未返回内容）';
    }
    // 响应元信息(模型/token/耗时):有内容才挂,没有就不占视觉
    if (!h.failed && (done && (done.usage || done.elapsedMs != null))) {
      setAiMeta(h.bubble, { model: h.model, usage: done.usage, elapsedMs: done.elapsedMs });
    }
    // 收尾做了全量 DOM 重写(清等待态 + 最终正文),WebKit 滚动锚定可能把
    // 视图拽离底部:补一次贴底判定,这是"回复完成瞬间上跳"的修复点。
    if (state.activeThreadId === thread?.id) {
      aiStickScroll();
    }
  }
  if (h.acc && h.recordHistory) {
    if (thread) {
      thread.history.push({ role: 'assistant', content: h.acc });
      trimAiHistory(thread);
      thread.updatedAt = Date.now();
    }
  }
  // ai:error 置入的 h.failed 必须带回给调用方:否则"测试连接"会把失败当成功
  h.resolve(h.failed
    ? { error: h.failed, code: h.failedCode || null, text: h.acc }
    : {
      ok: true, text: h.acc, aborted: h.cancelled || done?.finishReason === 'aborted', usage: done && done.usage,
      elapsedMs: done && done.elapsedMs, finishReason: done?.finishReason,
      toolCalls: done?.toolCalls, reasoning: done?.reasoning, thinkingBlocks: done?.thinkingBlocks,
    });
}

export async function aiSend(rawText, mode, opts) {
  // 未配置模型时不必发注定失败的请求:提示后直达 AI 设置
  if (!savedModels().length) {
    toast('请先配置 AI 模型', 'error');
    openAiSettings();
    return;
  }

  if (opts?.session) {
    ensureThreadForSession(opts.session);
  }
  ensureDefaultAiThread();
  const thread = activeAiThread();
  if (threadBusy(thread)) return toast('AI 正在处理中，请稍候或先停止', 'error');

  const isFromInput = !String(rawText ?? '').trim();
  let text = (rawText || '').trim();
  if (!text) text = ($('#ai-input')?.value || '').trim();
  if (!text) return;

  const targetView = resolveAiTarget({
    thread,
    sessions: state.sessions,
    activeId: state.activeId,
    hosts: state.hosts,
    settings: state.settings,
    busy: threadBusy(thread),
    links: linksForThread(thread),
  });

  if (!opts?.session && !opts?.noTools && targetView.kind === 'offline' && !targetView.blocked) {
    if (!isFromInput) {
      const input = $('#ai-input');
      if (input) input.value = text;
    }
    if (thread) {
      thread.draft = text;
      thread.sendBlocked = { text, at: Date.now() };
    }
    refreshAgentHostBar();
    return;
  }
  if (thread) thread.sendBlocked = null;

  if (isFromInput) {
    const input = $('#ai-input');
    if (input) input.value = '';
    if (thread) thread.draft = '';
  }

  let content = text;
  let userMd = !!(opts && opts.md); // 程序构造的 prompt 含围栏代码块,气泡按 Markdown 渲染
  if (mode === 'explain') {
    content = `请解释以下终端输出，指出关键信息、潜在问题与建议：\n\`\`\`\n${text}\n\`\`\``;
    userMd = true;
  }

  // 首条消息自动提炼为会话标题
  if (thread && (thread.autoTitle || thread.title === '新对话' || !thread.title)) {
    if (opts?.title) {
      thread.title = deriveThreadTitle(opts.title);
      thread.autoTitle = false;
    } else if (mode === 'explain') {
      thread.title = deriveThreadTitle('解释：' + text);
      thread.autoTitle = false;
    } else if (mode === 'diagnose') {
      thread.title = deriveThreadTitle('诊断：' + text);
      thread.autoTitle = false;
    } else {
      thread.title = deriveThreadTitle(text);
      thread.autoTitle = false;
    }
    renderAiThreadBar();
    refreshThreadUi();
  }
  if (thread) thread.updatedAt = Date.now();

  // 绑定了已连接主机、模型支持工具、执行模式非「对话模式」：走工具回合
  // (AI 可直接读日志、执行命令)。对话模式走下面的旧路径,代码块带执行按钮。
  if (thread && !opts?.noTools && agentAvailable(thread)) {
    return runAgentSend(thread, agentBinding(thread), { content, display: text, md: userMd });
  }

  const userMsg = { role: 'user', content };
  const historyList = thread ? thread.history : [];
  const messages = [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...historyList, userMsg];
  historyList.push(userMsg);
  trimAiHistory(thread);
  const userBubble = renderAiMessage('user', text, { md: userMd });
  // 记录发起参数:失败重发(retryFailedMessage)按原样重建这次发送
  userBubble.dataset.aiMode = mode || '';
  userBubble.dataset.aiMd = userMd ? '1' : '0';
  if (opts?.title) userBubble.dataset.aiTitle = opts.title;
  // 占位在创建气泡的同一帧挂上(spinner + "正在思考…"):
  // 若先 append 空气泡再补等待态,失败路径会把一颗空壳气泡留在对话里。
  const bubble = renderAiMessage('assistant', '');
  markBubblePending(bubble);

  const r = await aiRequest(messages, bubble, undefined, { thread });
  // ai:error 已把(部分回复+错误)写进气泡,这里只在气泡还空着(同步失败)时补写
  clearBubbleState(bubble);
  const body = aiBodyOf(bubble);
  if (r && r.error && body && !body.textContent) {
    body.textContent = '⚠️ ' + r.error;
  }
  // 彻底无内容的气泡(请求被拒/空响应)直接移除:留着就是一颗空心扁气泡
  if (body && !body.textContent && !body.querySelector('img,pre,table')) {
    bubble.remove();
  }
}

/// 失败气泡上的「重发」:把这条失败回合从会话历史里截掉,再按原文本重新
/// 走一次 aiSend —— 对所有失败来源(超时/HTTP/流错误)通用,也覆盖 diagnose/
/// explain 等 mode(记录在用户气泡的 dataset 上)。
/// 截断而不是追加,是因为失败时用户消息已经 push 进 history(aiSend 发请求前
/// 落库),直接再发会产生两条相同的 user 消息。
function retryFailedMessage(bubble) {
  const thread = activeAiThread();
  if (!thread || threadBusy(thread)) return toast('AI 正在处理中，请稍候或先停止', 'error');
  // 找到失败 assistant 气泡前面最近的用户气泡作为重发源
  let userBubble = null;
  let node = bubble.previousElementSibling;
  while (node) {
    if (node.dataset?.role === 'user') { userBubble = node; break; }
    node = node.previousElementSibling;
  }
  if (!userBubble) return;
  const raw = String(userBubble.__raw ?? '').trim();
  if (!raw) return;
  // 截断历史:去掉失败回合的 user 消息,以及失败时可能落进来的部分 assistant 正文
  const idx = thread.history.map((m) => m.role).lastIndexOf('user');
  if (idx >= 0 && thread.history[idx]?.content != null) thread.history.length = idx;
  bubble.remove();
  userBubble.remove();
  aiSend(raw, userBubble.dataset.aiMode || '', {
    md: userBubble.dataset.aiMd === '1',
    title: userBubble.dataset.aiTitle || undefined,
  });
}

export async function aiTestConnection() {
  // 仅相同端点可沿用已保存密钥。测试不写对话历史。
  const override = readAiDraft();
  if (!override.model) return toast('请先选择模型', 'error');
  const btn = $('#btn-ai-test');
  const t0 = performance.now();
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    const r = await aiRequest([{ role: 'user', content: '请只回复两个字母：OK' }], null, override, { detached: true });
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    if (r && r.error) {
      toast(`测试失败（${sec}s）：${r.error}`, 'error');
    } else if (r?.aborted) {
      toast('测试已停止');
    } else {
      const u = r && r.usage;
      const tok = u && (u.promptTokens != null || u.completionTokens != null)
        ? `，tokens ${u.promptTokens != null ? formatTokenCount(u.promptTokens) : '?'}入/${u.completionTokens != null ? formatTokenCount(u.completionTokens) : '?'}出` : '';
      toast(`连接成功：${override.model}，延迟 ${sec}s${tok}`, 'success');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

// dsh 式快速配置:按当前协议请求 /models,结果填入弹框供勾选
export async function fetchAiModels() {
  const btn = $('#btn-ai-fetch-models');
  const config = readAiDraft();
  if (!config.baseUrl) return toast('请先填写 Base URL', 'error');
  if (!config.apiKey && !config.useSavedApiKey) return toast('请先填写 API Key，再拉取模型列表', 'error');
  const draft = aiDraft;
  const endpoint = aiEndpointIdentity(config);
  const seq = ++modelsFetchSeq;
  const isCurrent = () => aiDraft === draft && seq === modelsFetchSeq && endpoint === aiEndpointIdentity(draftEndpoint());
  btn.__aiFetchSeq = seq;
  btn.disabled = true;
  btn.title = FETCH_BTN_TITLE_BUSY;
  try {
    const list = await api('ai:models', config);
    if (!isCurrent()) return;
    if (!list || !list.length) {
      toast('供应商未返回任何模型，可手动填写模型 ID', 'error');
      return;
    }
    state.aiModels = list.map(normModel).filter((m) => m.id);
    // 把已启用但本次没拉到的模型并进候选:否则用户勾过的模型会从弹框里
    // 凭空消失,看起来像"被自动取消了"。
    for (const cur of state.aiSelected) {
      if (!state.aiModels.some((m) => m.id === cur.id)) state.aiModels.push(cur);
    }
    openModelPicker();
    toast(`获取到 ${list.length} 个模型，请勾选要启用的`, 'success');
  } catch (e) {
    if (isCurrent()) toast('拉取模型失败：' + e.message + '；可手动填写模型 ID', 'error');
  } finally {
    // 新端点的 fetch 不得被旧 fetch 的 finally 提前解锁。
    if (btn.__aiFetchSeq === seq) {
      btn.disabled = false;
      btn.title = FETCH_BTN_TITLE;
    }
  }
}

/* ---------------- 模型选择弹框(多选) ---------------- */

/// 后端已归一化,但历史配置里可能残留纯字符串形式(旧版只存 id),统一收敛成对象
function normModel(m) {
  if (typeof m === 'string') return { id: m, name: m, ownedBy: '', created: null, context: null, vision: false };
  return {
    id: String(m.id || m.name || ''),
    name: String(m.name || m.id || ''),
    ownedBy: String(m.ownedBy || ''),
    created: m.created == null ? null : m.created,
    context: m.context == null ? null : Number(m.context) || null,
    vision: !!m.vision,
  };
}

function modelLabel(m) {
  return m.name && m.name !== m.id ? `${m.name}  ·  ${m.id}` : m.id;
}

/// created 可能是 unix 秒(OpenAI)或 RFC3339 串(Anthropic);解析不出来就不展示
function modelCreated(m) {
  const c = m.created;
  if (c == null || c === '') return '';
  let d = null;
  if (typeof c === 'number' || /^\d+$/.test(String(c))) {
    // 10 位是秒,13 位是毫秒
    const n = Number(c);
    d = new Date(String(c).length > 10 ? n : n * 1000);
  } else {
    d = new Date(String(c));
  }
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function modelMeta(m) {
  const parts = [];
  if (m.ownedBy) parts.push(m.ownedBy);
  const c = modelCreated(m);
  if (c) parts.push(c);
  // 上下文窗口/视觉能力是供应商可选字段,拿不到就不展示
  if (m.context) parts.push(`上下文 ${m.context >= 1000 ? Math.round(m.context / 1000) + 'K' : m.context} tokens`);
  if (m.vision) parts.push('支持图片');
  return parts.join(' · ');
}

// 弹框内的临时勾选态(点"确定"前不影响已保存设置)
let pickerChecked = new Set();
let pickerFocus = '';
let pickerFilter = '';

function pickerMatches() {
  const kw = pickerFilter.trim().toLowerCase();
  if (!kw) return state.aiModels;
  return state.aiModels.filter((m) => (m.id + ' ' + m.name + ' ' + m.ownedBy).toLowerCase().includes(kw));
}

function renderModelPickerList() {
  const box = $('#model-picker-list');
  const list = pickerMatches();
  box.innerHTML = '';
  if (!list.length) {
    const em = document.createElement('div');
    em.className = 'picker-empty';
    em.textContent = state.aiModels.length ? '没有匹配的模型' : '暂无模型,请先点击"拉取模型"';
    box.appendChild(em);
  } else {
    for (const m of list) {
      const on = pickerChecked.has(m.id);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'picker-item' + (on ? ' active' : '');
      el.dataset.model = m.id;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      // 建模为 checkbox:勾选=启用。整行可点,避免只点中小方块才生效。
      el.innerHTML = '<span class="picker-box" aria-hidden="true">✓</span>' +
        '<span class="picker-text"><span class="picker-name"></span><span class="picker-meta"></span></span>';
      el.querySelector('.picker-name').textContent = modelLabel(m);
      const meta = modelMeta(m);
      el.querySelector('.picker-meta').textContent = meta;
      el.querySelector('.picker-meta').classList.toggle('hidden', !meta);
      el.addEventListener('click', () => {
        if (pickerChecked.has(m.id)) pickerChecked.delete(m.id);
        else pickerChecked.add(m.id);
        pickerFocus = m.id;
        renderModelPickerList();
        updateModelPickerCount();
      });
      box.appendChild(el);
    }
  }
  const act = box.querySelector(`.picker-item[data-model="${CSS.escape(pickerFocus)}"]`);
  if (act) {
    act.classList.add('focus');
    act.scrollIntoView({ block: 'nearest' });
  }
  updateModelPickerCount();
}

function updateModelPickerCount() {
  const shown = pickerMatches().length;
  const total = state.aiModels.length;
  $('#model-picker-count').textContent = pickerFilter.trim()
    ? `已选 ${pickerChecked.size} 个 · 显示 ${shown}/${total}`
    : `已选 ${pickerChecked.size} 个 / 共 ${total} 个`;
}

/// 上下键移动焦点 + 空格/回车切换勾选,与多选列表的常规手感一致
export function movePickerSelection(delta) {
  const list = pickerMatches();
  if (!list.length) return;
  const i = list.findIndex((m) => m.id === pickerFocus);
  const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta));
  pickerFocus = list[next].id;
  renderModelPickerList();
}

/// 空格/回车:切换当前焦点的勾选态(不关闭弹框 —— 多选场景要能连续勾)
export function togglePickerFocus() {
  if (!pickerFocus) return;
  if (pickerChecked.has(pickerFocus)) pickerChecked.delete(pickerFocus);
  else pickerChecked.add(pickerFocus);
  renderModelPickerList();
}

export function pickerSelectAll(on) {
  // 只作用于"当前搜索结果",这样"搜索后全选"能当作批量勾选的快捷方式
  for (const m of pickerMatches()) {
    if (on) pickerChecked.add(m.id);
    else pickerChecked.delete(m.id);
  }
  renderModelPickerList();
}

export function openModelPicker() {
  pickerChecked = new Set(state.aiSelected.map((m) => m.id));
  pickerFocus = state.aiSelected[0] ? state.aiSelected[0].id : (state.aiModels[0] || {}).id || '';
  pickerFilter = '';
  $('#model-picker-search').value = '';
  renderModelPickerList();
  openModal('#modal-model-picker');
  $('#model-picker-search').focus();
}

export function closeModelPicker() {
  closeModal('#modal-model-picker');
}

/// 确定:勾选结果写回设置表单并立即反映到"模型"一栏(仍需点"保存"落盘)。
/// 默认模型由 applySelectedModels 维护:此前为空时第一个勾选自动成为默认。
export function confirmModelPicker() {
  applySelectedModels(state.aiModels.filter((m) => pickerChecked.has(m.id)));
  closeModelPicker();
}

export function filterModelPicker(kw) {
  pickerFilter = kw || '';
  renderModelPickerList();
}

/// 用勾选结果更新"已启用模型"集合与默认模型。
/// 默认模型若被取消勾选/移除,自动落到剩下的第一个 —— 否则保存后会留下
/// 一个列表上已看不见、却仍作为默认被请求使用的模型(不变量:列表非空则
/// 默认必存在)。
export function applySelectedModels(list) {
  state.aiSelected = list.map(normModel).filter((m) => m.id);
  const ids = state.aiSelected.map((m) => m.id);
  if (!ids.includes($('#ai-model').value)) {
    $('#ai-model').value = ids[0] || '';
  }
  renderModelChips();
}

/// "模型"一栏:chip 列表 + 框内输入。点 chip = 设为默认模型(新会话/后续
/// 请求的默认值,会话内仍可在 AI 边栏随时切换);chip 右侧 ✕ = 从启用列表
/// 移除(默认模型被移除时自动落到剩下的第一个);框尾输入模型 ID 回车即
/// 添加(addManualAiModel)。chip 只渲染进 #ai-model-chips-list —— 输入框
/// 是 #ai-model-chips 的常驻兄弟节点,不能被 innerHTML 重置一起清掉。
export function renderModelChips() {
  const list = $('#ai-model-chips-list') || $('#ai-model-chips');
  list.innerHTML = '';
  if (!state.aiSelected.length) return;
  const active = $('#ai-model').value;
  for (const m of state.aiSelected) {
    const chip = document.createElement('span');
    chip.className = 'model-chip' + (m.id === active ? ' active' : '');
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.title = m.id === active ? `默认模型 · ${m.id}` : `设为默认模型：${m.id}`;
    const name = document.createElement('span');
    name.className = 'model-chip-name';
    name.textContent = m.name || m.id;
    chip.appendChild(name);
    if (m.id === active) {
      const badge = document.createElement('span');
      badge.className = 'model-chip-default';
      badge.textContent = '默认';
      chip.appendChild(badge);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'model-chip-del';
    del.title = `移除 ${m.id}（不再启用）`;
    del.setAttribute('aria-label', `移除模型 ${m.id}`);
    del.innerHTML = icon('x');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      applySelectedModels(state.aiSelected.filter((x) => x.id !== m.id));
    });
    chip.appendChild(del);
    const setDefault = () => {
      $('#ai-model').value = m.id;
      renderModelChips();
      renderModelSwitch();
    };
    chip.addEventListener('click', setDefault);
    chip.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.isComposing) { e.preventDefault(); setDefault(); }
    });
    list.appendChild(chip);
  }
}

/* ---------------- 资源监控 ---------------- */

/// 对话页的模型选择:无边框触发钮(圆圈 + 模型名 + chevronDown)+ 自定义浮层菜单。
/// 只列"已勾选启用"的模型 —— 未勾选的模型不应能被选用;菜单尾部带"管理模型"入口。
/// 0 模型时触发钮保持可点:点击直达 AI 设置(首次使用不必去全局设置里找入口)。
export function renderModelSwitch() {
  const current = savedAi().model || '';
  const models = savedModels();
  const active = models.find((m) => m.id === current);
  const nameEl = $('#ai-model-name');
  const trigger = $('#ai-model-trigger');
  if (!active) {
    nameEl.textContent = '未启用模型，点击配置';
    trigger.title = '配置 AI 模型';
    trigger.classList.add('ai-model-unset');
  } else {
    nameEl.textContent = active.name || active.id;
    trigger.title = '切换模型';
    trigger.classList.remove('ai-model-unset');
  }
  // 0 模型不禁用:点击语义是"去配置"(见 openModelMenu);流式中/切换中仍禁用
  trigger.disabled = !!activeAiThread()?.req || modelSwitchPending;
  // 菜单若开着,同步刷新条目(切换完成/禁用态变化时)
  renderModelMenu();
  if ($('#ai-model-menu').classList.contains('hidden')) return;
  if (models.length === 0 || !!activeAiThread()?.req || modelSwitchPending) closeModelMenu();
}

function renderModelMenu() {
  const list = $('#ai-model-menu-list');
  if (!list) return;
  const current = savedAi().model || '';
  const models = savedModels();
  list.innerHTML = models.map((m) => `
    <button class="ai-model-menu-item${m.id === current ? ' active' : ''}" type="button" role="menuitem" data-model="${escapeHtml(m.id)}">
      <span>${escapeHtml(m.name || m.id)}</span>
      <span class="check" aria-hidden="true">✓</span>
    </button>`).join('');
}

export function openModelMenu() {
  const menu = $('#ai-model-menu');
  const trigger = $('#ai-model-trigger');
  if (trigger.disabled) return;
  $('#ai-mode-menu')?.classList.add('hidden');
  $('#ai-thread-menu')?.classList.add('hidden');
  renderModelMenu();
  menu.classList.remove('hidden');
  // 菜单展开在触发钮上方(输入区在面板底部,向下没有空间),右缘对齐触发钮
  const tr = trigger.getBoundingClientRect();
  const size = { width: menu.offsetWidth || 220, height: menu.offsetHeight || 200 };
  const pos = popupPosition(
    { top: tr.top, bottom: tr.top, left: tr.left, right: tr.right },
    size, { width: window.innerWidth, height: window.innerHeight },
  );
  menu.style.left = pos.left + 'px';
  menu.style.top = Math.max(8, tr.top - size.height - 6) + 'px';
}

export function closeModelMenu() {
  $('#ai-model-menu').classList.add('hidden');
}

let modelSwitchPending = false;
export async function switchModel(model) {
  if (!model || modelSwitchPending) return;
  if (threadBusy(activeAiThread())) { renderModelSwitch(); return toast('生成结束后再切换模型', 'error'); }
  if (!savedModels().some((m) => m.id === model)) { renderModelSwitch(); return; }
  modelSwitchPending = true;
  renderModelSwitch();
  try {
    const settings = await api('settings:save', { ai: { model } });
    state.settings = settings;
    syncSelectedModelsFromSettings();
    toast('模型已切换:' + model, 'success');
  } catch (e) {
    toast('模型切换失败：' + e.message, 'error');
    throw e;
  } finally {
    modelSwitchPending = false;
    renderModelSwitch();
  }
}

/// 把 settings 里的已启用模型读进内存。boot 与保存设置后共用。
///
/// 这里刻意不做网络拉取:启用清单是用户勾选的结果,存在本地;
/// 若在启动时拉 /models 来"重建"它,网络一抖动就会把用户的勾选清空。
/// 拉取只发生在用户显式点击"拉取模型"时。
export function syncSelectedModelsFromSettings() {
  if (!aiDraft) {
    state.aiSelected = savedModels();
    $('#ai-model').value = savedAi().model || (state.aiSelected[0] || {}).id || '';
    renderModelChips();
  }
  renderModelSwitch();
}

// 兼容旧调用点(boot / 保存后);语义已从"联网刷新候选"变为"同步本地启用清单"
export async function refreshAiModels() {
  syncSelectedModelsFromSettings();
}

// 终端原始字节流里的 ANSI/OSC 控制序列(括号粘贴 \x1b[?2004h、OSC 标题
// \x1b]0;...\x07、光标/颜色等)对 AI 是纯噪声,拼进诊断 prompt 会显示为乱码。
// 实现与命令历史共用(shared/term-text.js),这里再导出保持原调用点。
export { stripTerminalNoise };

/// 返回是否已发出诊断请求;调用方据此切到右侧工具栏的 AI 页签。
export async function aiDiagnose() {
  const s = state.sessions.get(state.activeId);
  if (!s) { toast('请先连接主机', 'error'); return false; }
  // 只取最后一次输入的命令 + 它提交之后的控制台输出(terminal.js 在 onData/
  // ssh:data 里跟踪),不再扫整屏 —— 全屏里早前的无关输出会稀释诊断焦点。
  const cmd = stripTerminalNoise(String(s.lastCmd || '')).trim();
  const output = stripTerminalNoise(String(s.lastOutput || '')).trim();
  if (!cmd && !output) { toast('还没有执行过命令,无诊断依据', 'error'); return false; }
  const recent = `最后一次输入的命令：\n${cmd || '(未捕获)'}\n\n该命令的控制台输出：\n${output || '(无输出)'}`.slice(-3000);
  const firstCmdLine = cmd ? cmd.split('\n').map((l) => l.trim()).find(Boolean) : '';
  const title = firstCmdLine ? `诊断：${firstCmdLine}` : '诊断报错';
  aiSend(
    '请诊断以下最后一次命令及其控制台输出,指出关键报错与修复建议:\n```\n' + recent + '\n```',
    'diagnose',
    { md: true, session: s, title },
  );
  return true;
}

/* ---------------- 监控条增强(H1/H2):磁盘 + sparkline ---------------- */

export function openAiSettings() {
  aiDraft = null;
  modelsFetchSeq++;
  resetModelFetchButton();
  state.aiModels = [];
  $('#ai-apikey').value = '';
  const inline = $('#ai-model-inline');
  if (inline) inline.value = '';
  const sel = $('#ai-provider');
  sel.innerHTML = '';
  for (const [key, p] of Object.entries(AI_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  const s = (state.settings && state.settings.ai) || {};
  const providerKey = Object.keys(AI_PRESETS).find((k) =>
    AI_PRESETS[k].baseUrl === s.baseUrl && k !== 'custom') || (s.baseUrl ? 'custom' : 'openai');
  sel.value = s.provider && s.provider !== 'custom' ? s.provider : providerKey;
  fillPreset(sel.value);
  if (s.baseUrl) $('#ai-baseurl').value = s.baseUrl;
  // 已启用模型从内存集合重建 chip(含老配置的单 model 迁移)
  state.aiSelected = savedModels();
  $('#ai-model').value = s.model || (state.aiSelected[0] || {}).id || '';
  // 候选池:启动时是空的(不再联网拉取),先把已启用的并进来,
  // 这样用户不点"拉取模型"也能重开弹框调整勾选。
  for (const m of state.aiSelected) {
    if (!state.aiModels.some((x) => x.id === m.id)) state.aiModels.push(m);
  }
  renderModelChips();
  renderModelSwitch();
  $('#ai-protocol').value = s.protocol || 'openai';
  $('#ai-apikey').value = '';
  aiDraft = { endpoint: aiEndpointIdentity(draftEndpoint()) };
  onAiEndpointChange();
  openModal('#modal-settings');
}

export function fillPreset(key) {
  const p = AI_PRESETS[key] || AI_PRESETS.custom;
  if (key !== 'custom') {
    $('#ai-baseurl').value = p.baseUrl;
    $('#ai-protocol').value = p.protocol;
    // 预置厂商的默认模型直接作为"已启用"清单:否则切到 OpenAI 后
    // 模型栏是空的,用户还得先拉一次列表才能用。
    state.aiSelected = p.model ? [normModel(p.model)] : [];
    $('#ai-model').value = p.model || '';
  } else {
    const cur = (state.settings && state.settings.ai) || {};
    $('#ai-baseurl').value = cur.baseUrl || '';
    $('#ai-protocol').value = cur.protocol || 'openai';
    state.aiSelected = Array.isArray(cur.models) ? cur.models.map(normModel).filter((m) => m.id) : [];
    if (!state.aiSelected.length && cur.model) state.aiSelected = [normModel(cur.model)];
    $('#ai-model').value = cur.model || (state.aiSelected[0] || {}).id || '';
  }
  onAiEndpointChange();
  state.aiModels = state.aiSelected.map((m) => ({ ...m }));
  renderModelChips();
}

export async function saveAiSettings() {
  const draft = readAiDraft();
  // 不变量:启用列表非空则默认模型必存在。草稿漏选(如只勾选未点选)时
  // 自动落第一个并提示,保证保存出去的配置永远可直接发起请求。
  let model = draft.model;
  if (state.aiSelected.length && !state.aiSelected.some((m) => m.id === model)) {
    model = state.aiSelected[0].id;
    $('#ai-model').value = model;
    renderModelChips();
    toast(`已设 ${model} 为默认模型`, 'success');
  }
  const payload = {
    ai: {
      provider: $('#ai-provider').value,
      protocol: draft.protocol, baseUrl: draft.baseUrl, model,
      models: state.aiSelected.map((m) => ({ ...m })),
    },
  };
  if (draft.apiKey) payload.ai.apiKey = draft.apiKey;
  // 换端点且未填新密钥,或主动清空已有密钥时通知后端清除密钥。
  else if (draft.clearApiKey || !draft.useSavedApiKey) payload.ai.clearApiKey = true;
  try {
    state.settings = await api('settings:save', payload);
    closeAiSettings();
    toast('AI 设置已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/* ---------------- 事件绑定与启动 ---------------- */

/* ---------------- 右键菜单(替代 WebView 原生菜单) ----------------
   wry/WKWebView 的默认右键菜单是网页菜单(重新加载/检查元素等),对终端应用毫无用处,
   且会盖住界面。这里全局屏蔽,仅在终端区域给出终端常用操作。 */

