// AI 助手:流式对话、模型切换、设置弹窗、诊断
import { $, api, closeModal, copyText, openModal, state, toast } from './core.js';
import { escapeHtml } from './hosts.js';
import { mdToHtml } from '../shared/markdown.js';
import { AI_PRESETS, AI_SYSTEM_PROMPT } from '../shared/ai-presets.js';

export const AI_HISTORY_LIMIT = 20;
// 消息区 DOM 上限:超出的旧气泡直接移除,避免长会话下无界增长。
export const AI_DOM_LIMIT = 200;

export function trimAiHistory() {
  if (state.aiHistory.length > AI_HISTORY_LIMIT) {
    state.aiHistory = state.aiHistory.slice(-AI_HISTORY_LIMIT);
  }
}

/// 气泡内部结构固定为:<div.ai-msg><div.ai-body>内容</div><button.ai-copy/></div>。
/// 内容一律走 .ai-body —— 助手侧渲染 Markdown,用户侧纯文本(用户输入不当
/// Markdown 解析,原样展示)。裸文本进 textContent 的旧写法会连复制按钮一起
/// 被覆盖,所以所有写入都必须经过这里。
function aiBodyOf(bubble) {
  return bubble ? bubble.querySelector('.ai-body') : null;
}

export function setAiBody(bubble, text) {
  const body = aiBodyOf(bubble);
  if (!body) return;
  bubble.__raw = String(text ?? '');
  if (bubble.dataset.role === 'assistant') body.innerHTML = mdToHtml(text);
  else body.textContent = text;
}

export function renderAiMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.dataset.role = role;
  const body = document.createElement('div');
  body.className = 'ai-body';
  el.appendChild(body);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ai-copy';
  copy.title = '复制这条内容';
  copy.setAttribute('aria-label', '复制这条内容');
  copy.textContent = '⧉';
  copy.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const ok = await copyText(el.__raw ?? '');
    toast(ok ? '已复制' : '复制失败：剪贴板不可用', ok ? 'success' : 'error');
  });
  el.appendChild(copy);
  setAiBody(el, text);
  const box = $('#ai-messages');
  box.appendChild(el);
  while (box.children.length > AI_DOM_LIMIT) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  return el;
}

/// 等待首个 token 期间的气泡形态:转圈 + "正在思考…"。
/// 光是一个空气泡看不出"到底在没在跑",用户会以为卡死而重复发送。
/// 占位文案写进 .ai-body,结束时必须经 clearBubbleState 清掉,
/// 否则"未返回内容"的兜底文案会被这个占位挡住。
export function markBubblePending(bubble) {
  const body = aiBodyOf(bubble);
  if (!body || body.textContent) return;
  bubble.classList.add('pending');
  bubble.dataset.pending = '1';
  const sp = document.createElement('span');
  sp.className = 'ai-spinner';
  sp.setAttribute('aria-hidden', 'true');
  bubble.insertBefore(sp, body);
  body.textContent = '正在思考…';
}

/// 首个 token 到达:撤掉等待态、清空占位,转入流式态(光标闪烁由 CSS 画)
export function markBubbleStreaming(bubble) {
  if (!bubble) return;
  if (bubble.dataset.pending) {
    delete bubble.dataset.pending;
    const sp = bubble.querySelector('.ai-spinner');
    if (sp) sp.remove();
    aiBodyOf(bubble).textContent = '';
  }
  bubble.classList.remove('pending');
  bubble.classList.add('streaming');
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
    // 顺序要紧:先撤等待态(会把"正在思考…"占位清空),再把最终累积文本落盘。
    // 取消未落地的合帧写入时**必须补写一次 h.acc** —— 最后一个 delta 可能已经
    // 累加进 h.acc 但还没被 rAF 画上去,直接 cancel 会把结尾整段吞掉。
    // 失败时不能补写:ai:error 已经往气泡里写了「正文 + ⚠️ 错误」,补写会盖掉它。
    clearBubbleState(h.bubble);
    if (h.raf) { cancelAnimationFrame(h.raf); h.raf = 0; }
    if (!h.failed && h.acc) setAiBody(h.bubble, h.acc);
    if (!h.acc && !h.failed && !aiBodyOf(h.bubble).textContent) {
      aiBodyOf(h.bubble).textContent = '（AI 未返回内容）';
    }
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

  let content = text;
  if (mode === 'explain') {
    content = `请解释以下终端输出，指出关键信息、潜在问题与建议：\n\`\`\`\n${text}\n\`\`\``;
  }

  const userMsg = { role: 'user', content };
  const messages = [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...state.aiHistory, userMsg];
  state.aiHistory.push(userMsg);
  trimAiHistory();
  renderAiMessage('user', text);
  const bubble = renderAiMessage('assistant', '');
  markBubblePending(bubble);

  const r = await aiRequest(messages, bubble);
  // ai:error 已把(部分回复+错误)写进气泡,这里只在气泡还空着(同步失败)时补写
  clearBubbleState(bubble);
  const body = aiBodyOf(bubble);
  if (r && r.error && body && !body.textContent) {
    body.textContent = '⚠️ ' + r.error;
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
  if (!override.model) return toast('请先选择模型', 'error');
  const r = await aiRequest([{ role: 'user', content: '请只回复两个字母：OK' }], null, override);
  if (r && r.error) toast('测试失败：' + r.error, 'error');
  else toast('连接成功，AI 已响应', 'success');
}

// dsh 式快速配置:按当前协议请求 /models,结果填入弹框供勾选
export async function fetchAiModels() {
  const btn = $('#btn-ai-fetch-models');
  const base = $('#ai-baseurl').value.trim();
  if (!base) return toast('请先填写 Base URL', 'error');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const list = await api('ai:models', { protocol: $('#ai-protocol').value, baseUrl: base, apiKey: $('#ai-apikey').value.trim() });
    if (!list || !list.length) {
      toast('供应商未返回任何模型', 'error');
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
    toast('拉取模型失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型';
  }
}

/* ---------------- 模型选择弹框(多选) ---------------- */

/// 后端已归一化,但历史配置里可能残留纯字符串形式(旧版只存 id),统一收敛成对象
function normModel(m) {
  if (typeof m === 'string') return { id: m, name: m, ownedBy: '', created: null };
  return {
    id: String(m.id || m.name || ''),
    name: String(m.name || m.id || ''),
    ownedBy: String(m.ownedBy || ''),
    created: m.created == null ? null : m.created,
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

/// 确定:勾选结果写回设置表单并立即反映到"模型"一栏(仍需点"保存"落盘)
export function confirmModelPicker() {
  applySelectedModels(state.aiModels.filter((m) => pickerChecked.has(m.id)));
  closeModelPicker();
}

export function filterModelPicker(kw) {
  pickerFilter = kw || '';
  renderModelPickerList();
}

/// 用勾选结果更新"已启用模型"集合与当前生效模型。
/// 生效模型若被取消勾选,自动落到剩下的第一个 —— 否则设置里会留下一个
/// 列表上已看不见、却仍在被请求使用的模型。
export function applySelectedModels(list) {
  state.aiSelected = list.slice();
  const ids = state.aiSelected.map((m) => m.id);
  if (!ids.includes($('#ai-model').value)) {
    $('#ai-model').value = ids[0] || '';
  }
  renderModelChips();
  renderModelSwitch();
}

/// "模型"一栏:chip 列表取代纯文本输入框。点 chip = 设为当前生效模型。
export function renderModelChips() {
  const box = $('#ai-model-chips');
  box.innerHTML = '';
  if (!state.aiSelected.length) {
    const em = document.createElement('span');
    em.className = 'model-chips-empty';
    em.textContent = '未选择模型，请点右侧"拉取模型"勾选';
    box.appendChild(em);
    return;
  }
  const active = $('#ai-model').value;
  for (const m of state.aiSelected) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'model-chip' + (m.id === active ? ' active' : '');
    chip.title = m.id === active ? `${m.id}(当前使用)` : `点击切换为 ${m.id}`;
    chip.textContent = m.name || m.id;
    chip.addEventListener('click', () => {
      $('#ai-model').value = m.id;
      renderModelChips();
      renderModelSwitch();
    });
    box.appendChild(chip);
  }
}

/* ---------------- 资源监控 ---------------- */

/// 对话页的模型下拉:只列"已勾选启用"的模型 —— 未勾选的模型不应能被选用。
export function renderModelSwitch() {
  const sel = $('#ai-model-switch');
  const current = $('#ai-model').value || (state.settings && state.settings.ai && state.settings.ai.model) || '';
  const models = state.aiSelected.slice();
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('')
    : '<option value="">未启用模型</option>';
  if (current && models.some((m) => m.id === current)) sel.value = current;
  sel.disabled = models.length === 0;
}

export async function switchModel(model) {
  if (!model) return;
  state.settings = await api('settings:save', { ai: { model } });
  toast('模型已切换:' + model, 'success');
}

/// 把 settings 里的已启用模型读进内存。boot 与保存设置后共用。
///
/// 这里刻意不做网络拉取:启用清单是用户勾选的结果,存在本地;
/// 若在启动时拉 /models 来"重建"它,网络一抖动就会把用户的勾选清空。
/// 拉取只发生在用户显式点击"拉取模型"时。
export function syncSelectedModelsFromSettings() {
  const s = (state.settings && state.settings.ai) || {};
  let saved = Array.isArray(s.models) ? s.models.map(normModel).filter((m) => m.id) : [];
  // 老配置迁移:只有单个 model、没有 models 列表时,把它当作唯一已启用模型,
  // 否则升级后下拉会变成"未启用模型",用户的配置看起来丢了。
  if (!saved.length && s.model) saved = [normModel(s.model)];
  state.aiSelected = saved;
  if (!$('#ai-model').value && s.model) $('#ai-model').value = s.model;
  renderModelChips();
  renderModelSwitch();
}

// 兼容旧调用点(boot / 保存后);语义已从"联网刷新候选"变为"同步本地启用清单"
export async function refreshAiModels() {
  syncSelectedModelsFromSettings();
}

export async function aiDiagnose() {
  const s = state.sessions.get(state.activeId);
  if (!s) return toast('请先连接主机', 'error');
  // 只取最后一次输入的命令 + 它提交之后的控制台输出(terminal.js 在 onData/
  // ssh:data 里跟踪),不再扫整屏 —— 全屏里早前的无关输出会稀释诊断焦点。
  const cmd = String(s.lastCmd || '').trim();
  const output = String(s.lastOutput || '').trim();
  if (!cmd && !output) return toast('还没有执行过命令,无诊断依据', 'error');
  const recent = `最后一次输入的命令：\n${cmd || '(未捕获)'}\n\n该命令的控制台输出：\n${output || '(无输出)'}`.slice(-3000);
  aiSend('请诊断以下最后一次命令及其控制台输出,指出关键报错与修复建议:\n```\n' + recent + '\n```');
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
  // 已启用模型从内存集合重建 chip(含老配置的单 model 迁移)
  state.aiSelected = (Array.isArray(s.models) ? s.models.map(normModel).filter((m) => m.id) : []);
  if (!state.aiSelected.length && s.model) state.aiSelected = [normModel(s.model)];
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
  $('#ai-apikey').placeholder = s.apiKeySet ? '已保存（留空保持不变）' : '密钥';
  openModal('#modal-ai');
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
  renderModelChips();
  renderModelSwitch();
}

export async function saveAiSettings() {
  const payload = {
    ai: {
      provider: $('#ai-provider').value,
      protocol: $('#ai-protocol').value,
      baseUrl: $('#ai-baseurl').value.trim(),
      model: $('#ai-model').value.trim(),
      models: state.aiSelected,
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

