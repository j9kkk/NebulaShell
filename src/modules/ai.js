// AI 助手:流式对话、模型切换、设置弹窗、诊断
import { $, api, closeModal, openModal, state, toast } from './core.js';
import { escapeHtml } from './hosts.js';
import { AI_PRESETS, AI_SYSTEM_PROMPT } from '../shared/ai-presets.js';

export const AI_HISTORY_LIMIT = 20;
// 消息区 DOM 上限:超出的旧气泡直接移除,避免长会话下无界增长。
export const AI_DOM_LIMIT = 200;

export function trimAiHistory() {
  if (state.aiHistory.length > AI_HISTORY_LIMIT) {
    state.aiHistory = state.aiHistory.slice(-AI_HISTORY_LIMIT);
  }
}

export function renderAiMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.textContent = text;
  const box = $('#ai-messages');
  box.appendChild(el);
  while (box.children.length > AI_DOM_LIMIT) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  return el;
}

export function setAiBusy(busy) {
  $('#ai-send').disabled = busy;
  $('#ai-send').textContent = busy ? '生成中…' : '发送';
}

export function aiRequest(messages, bubble, override) {
  return new Promise((resolve) => {
    if (state.aiReq) {
      resolve({ error: '已有请求进行中，请稍候' });
      return;
    }
    const requestId = crypto.randomUUID();
    const holder = { id: requestId, acc: '', bubble, resolve, messages };
    state.aiReq = holder;
    setAiBusy(true);
    // override:弹窗"测试连接"携带表单当前值,后端以其为准 —— 不要求先保存
    const payload = override ? { requestId, messages, ai: override } : { requestId, messages };
    api('ai:chat', payload).catch((e) => {
      if (state.aiReq === holder) {
        state.aiReq = null;
        setAiBusy(false);
        resolve({ error: e.message });
      }
    });
  });
}

export function aiFinishHolder() {
  const h = state.aiReq;
  if (!h) return;
  state.aiReq = null;
  setAiBusy(false);
  if (h.bubble) {
    if (!h.acc && !h.failed && !h.bubble.textContent) h.bubble.textContent = '（AI 未返回内容）';
  }
  if (h.acc) {
    state.aiHistory.push({ role: 'assistant', content: h.acc });
    trimAiHistory();
  }
  // ai:error 置入的 h.failed 必须带回给调用方:否则"测试连接"会把失败当成功
  h.resolve(h.failed ? { error: h.failed, text: h.acc } : { ok: true, text: h.acc });
}

export async function aiSend(rawText, mode) {
  if (state.aiReq) return toast('AI 正在回复中，请稍候', 'error');
  let text = (rawText || '').trim();
  if (!text) text = $('#ai-input').value.trim();
  if (!text) return;
  $('#ai-input').value = '';
  const genMode = mode === 'gen' || state.genMode;
  state.genMode = false;
  updateGenChip();

  let content = text;
  if (genMode) {
    content = `请生成满足以下需求的命令（只输出命令本身和一行说明，放在代码块中）：\n${text}`;
  } else if (mode === 'explain') {
    content = `请解释以下终端输出，指出关键信息、潜在问题与建议：\n\`\`\`\n${text}\n\`\`\``;
  }

  const userMsg = { role: 'user', content };
  const messages = [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...state.aiHistory, userMsg];
  state.aiHistory.push(userMsg);
  trimAiHistory();
  renderAiMessage('user', text);
  const bubble = renderAiMessage('assistant', '');

  const r = await aiRequest(messages, bubble);
  // ai:error 已把(部分回复+错误)写进气泡,这里只在气泡还空着(同步失败)时补写
  if (r && r.error && !bubble.textContent) {
    bubble.textContent = '⚠️ ' + r.error;
  }
}

export async function aiTestConnection() {
  // 用弹窗表单当前值直连测试:填完即可测,不必先保存(密钥留空则沿用已保存密钥)
  const override = {
    protocol: $('#ai-protocol').value,
    baseUrl: $('#ai-baseurl').value.trim(),
    model: $('#ai-model').value.trim(),
    apiKey: $('#ai-apikey').value,
  };
  const r = await aiRequest([{ role: 'user', content: '请只回复两个字母：OK' }], null, override);
  if (r && r.error) toast('测试失败：' + r.error, 'error');
  else toast('连接成功，AI 已响应', 'success');
}

export function updateGenChip() {
  const input = $('#ai-input');
  let chip = $('#gen-chip');
  if (state.genMode) {
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'gen-chip';
      chip.className = 'gen-chip';
      chip.title = '点击取消命令生成模式';
      chip.addEventListener('click', () => { state.genMode = false; updateGenChip(); });
      $('.ai-quick').appendChild(chip);
    }
    chip.textContent = '⌨ 命令生成模式 ✕';
    input.placeholder = '描述你想要执行的命令，例如：查看磁盘占用最高的目录';
  } else {
    if (chip) chip.remove();
    input.placeholder = '向 AI 提问，例如：如何排查服务器 CPU 过高？';
  }
}

// dsh 式快速配置：按当前协议请求 /models，把可用模型填入候选列表
export async function fetchAiModels() {
  const btn = $('#btn-ai-fetch-models');
  const base = $('#ai-baseurl').value.trim();
  if (!base) return toast('请先填写 Base URL', 'error');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const ids = await api('ai:models', { protocol: $('#ai-protocol').value, baseUrl: base, apiKey: $('#ai-apikey').value.trim() });
    const dl = $('#ai-model-list');
    dl.innerHTML = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      dl.appendChild(o);
    }
    if (!$('#ai-model').value.trim()) $('#ai-model').value = ids[0];
    toast(`获取到 ${ids.length} 个模型，输入框已出现候选列表`, 'success');
  } catch (e) {
    toast('拉取模型失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型';
  }
}

/* ---------------- 资源监控 ---------------- */

export function renderModelSwitch() {
  const sel = $('#ai-model-switch');
  const current = (state.settings && state.settings.ai && state.settings.ai.model) || '';
  const models = [...new Set([current, ...state.aiModels])].filter(Boolean);
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
    : '<option value="">未配置</option>';
  if (current) sel.value = current;
}

export async function switchModel(model) {
  if (!model) return;
  state.settings = await api('settings:save', { ai: { model } });
  toast('模型已切换:' + model, 'success');
}

// 按已保存配置拉取可用模型并刷新"模型切换"下拉。boot 与保存设置后共用:
// 保存后不刷新的话,下拉会停在启动时的旧状态(空/未配置),直到重启才恢复。
export async function refreshAiModels() {
  const s = (state.settings && state.settings.ai) || {};
  try {
    state.aiModels = s.baseUrl
      ? await api('ai:models', { protocol: s.protocol, baseUrl: s.baseUrl })
      : [];
  } catch {
    state.aiModels = [];
  }
  renderModelSwitch();
}

export async function aiDiagnose() {
  const s = state.sessions.get(state.activeId);
  if (!s) return toast('请先连接主机', 'error');
  let recent = '';
  try {
    const buf = s.term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, buf.length - 60); i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    recent = lines.filter(Boolean).join('\n').slice(-3000);
  } catch { /* ignore */ }
  if (!recent.trim()) return toast('终端暂无输出可诊断', 'error');
  aiSend('请诊断以下最近的终端输出,指出关键报错与修复建议:\n```\n' + recent + '\n```');
  $('#ai-panel').classList.remove('hidden');
}

/* ---------------- 监控条增强(H1/H2):磁盘 + sparkline ---------------- */

export function openAiSettings() {
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
  if (s.model) $('#ai-model').value = s.model;
  $('#ai-protocol').value = s.protocol || 'openai';
  $('#ai-temp').value = s.temperature != null ? s.temperature : 0.3;
  $('#ai-apikey').value = '';
  $('#ai-apikey').placeholder = s.apiKeySet ? '已保存（留空保持不变）' : '密钥';
  openModal('#modal-ai');
}

export function fillPreset(key) {
  const p = AI_PRESETS[key] || AI_PRESETS.custom;
  if (key !== 'custom') {
    $('#ai-baseurl').value = p.baseUrl;
    $('#ai-model').value = p.model;
    $('#ai-protocol').value = p.protocol;
  } else {
    const cur = (state.settings && state.settings.ai) || {};
    $('#ai-baseurl').value = cur.baseUrl || '';
    $('#ai-model').value = cur.model || '';
    $('#ai-protocol').value = cur.protocol || 'openai';
  }
}

export async function saveAiSettings() {
  const payload = {
    ai: {
      provider: $('#ai-provider').value,
      protocol: $('#ai-protocol').value,
      baseUrl: $('#ai-baseurl').value.trim(),
      model: $('#ai-model').value.trim(),
      temperature: Number($('#ai-temp').value) || 0.3,
    },
  };
  const key = $('#ai-apikey').value;
  if (key) payload.ai.apiKey = key;
  try {
    state.settings = await api('settings:save', payload);
    closeModal('#modal-ai');
    refreshAiModels(); // 后台刷新,不阻塞保存提示;失败时下拉仍会显示已保存模型
    toast('AI 设置已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/* ---------------- 事件绑定与启动 ---------------- */

/* ---------------- 右键菜单(替代 WebView 原生菜单) ----------------
   wry/WKWebView 的默认右键菜单是网页菜单(重新加载/检查元素等),对终端应用毫无用处,
   且会盖住界面。这里全局屏蔽,仅在终端区域给出终端常用操作。 */

