// NebulaShell 渲染层应用逻辑
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { AI_PRESETS, AI_SYSTEM_PROMPT } from './shared/ai-presets.js';

const $ = (s) => document.querySelector(s);

async function api(channel, payload) {
  const r = await window.nebula.invoke(channel, payload);
  if (!r || r.ok !== true) throw new Error((r && r.error) || channel + ' 调用失败');
  return r.data;
}

const state = {
  hosts: [],
  sessions: new Map(), // sessionId -> { sessionId, host, term, fit, pane, tab, status, search }
  activeId: null,
  settings: null,
  pickedKey: null, // { path, content }
  cloudAccounts: [],     // 云账号(多 API Key,见 cloud:accounts)
  cloudResults: [],
  aiHistory: [],
  aiReq: null,
  genMode: false,
  monitorVisible: true,
  metrics: new Map(), // sessionId -> 最近一次 ssh:metrics
  metricHistory: new Map(), // sessionId -> [cpuPct...] 迷你趋势
  // 文件面板:显示的是"哪个会话"的目录必须显式记录 —— 面板是全局单例,
  // 若只靠 activeId,切标签后会出现"显示 A 的目录、操作落到 B"的误删风险。
  file: { sessionId: null, cwd: null, entries: [], selected: null, chmodTarget: null, renameMode: null },
  // 标签页(E1)与窗格(E3):每个标签页持有独立的布局树与窗格集合,
  // 切换标签只渲染该标签的窗格;其余标签的终端对象保留在内存中(不销毁),
  // 切回时重新挂载并 refresh。state.layout/panes/zoomPaneId/activePaneId
  // 是"当前标签"的访问器(见下方 defineProperties),便于既有分屏代码原样复用。
  tabs: new Map(),     // tabId -> { id, el, layout, panes: Map, zoomPaneId, activePaneId, sessionId }
  activeTabId: null,
  tabSeq: 0,
  paneSeq: 0,
  broadcast: null,     // E5: Set(sessionId) 广播参与者
  historyOpen: false,
  aiModels: [],        // 已拉取的模型候选(K6)
};

/* ---------------- 标签/窗格访问器 ----------------
   把"当前标签的布局树/窗格集合/放大窗格/空窗格焦点"暴露成 state.layout 等属性,
   让既有分屏代码(renderLayout/splitActive/firstEmptyLeaf...)无需改动即可工作;
   同时这些 setter 会写回标签对象,保证切换标签后改动落在正确的标签上。 */
function activeTab() {
  return state.activeTabId ? state.tabs.get(state.activeTabId) : null;
}
Object.defineProperties(state, {
  layout: {
    get: () => { const t = activeTab(); return t ? t.layout : null; },
    set: (v) => { const t = activeTab(); if (t) t.layout = v; },
  },
  panes: {
    get: () => { const t = activeTab(); return t ? t.panes : new Map(); },
  },
  zoomPaneId: {
    get: () => { const t = activeTab(); return t ? t.zoomPaneId : null; },
    set: (v) => { const t = activeTab(); if (t) t.zoomPaneId = v; },
  },
  activePaneId: {
    get: () => { const t = activeTab(); return t ? t.activePaneId : null; },
    set: (v) => { const t = activeTab(); if (t) t.activePaneId = v; },
  },
});

const PROVIDER_LABEL = { tencent: '腾讯云', lighthouse: '腾讯云轻量', aliyun: '阿里云' };


/* ---------------- 通用 UI ---------------- */

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/// 应用内输入对话框:返回 Promise<string|null>(null = 取消)。
/// 与 askConfirm 同因 —— wry/WKWebView 未实现原生 prompt,直接调用拿不到输入。
function askPrompt(message, opts = {}) {
  const {
    title = '请输入',
    okText = '确定',
    hint = '',
    password = true,
    placeholder = '',
    validate = null,
  } = opts;
  return new Promise((resolve) => {
    const modal = $('#modal-prompt');
    const input = $('#prompt-input');
    const hintEl = $('#prompt-hint');
    const okBtn = $('#btn-prompt-ok');
    const cancelBtn = $('#btn-prompt-cancel');
    $('#prompt-title').textContent = title;
    $('#prompt-message').textContent = message;
    hintEl.textContent = hint || '';
    hintEl.style.display = hint ? 'block' : 'none';
    input.type = password ? 'password' : 'text';
    input.value = '';
    input.placeholder = placeholder;
    okBtn.textContent = okText;
    okBtn.disabled = false;

    const done = (val) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEsc);
      resolve(val);
    };
    const onOk = () => {
      const v = input.value;
      const err = validate ? validate(v) : null;
      if (err) { toast(err, 'error'); return; }
      done(v);
    };
    const onCancel = () => done(null);
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') onOk();
    };
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onEsc);
    modal.classList.remove('hidden');
    input.focus();
  });
}

// 应用内确认对话框:返回 Promise<boolean>
// 替代 window.confirm —— wry/WKWebView 未实现 runJavaScriptConfirmPanel,原生 confirm 会被
// WebKit 直接判为 false,导致删除等操作静默失效(Chromium 正常,两栈行为不一致)。
function askConfirm(message, { title = '确认操作', okText = '确定', danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = $('#modal-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#btn-confirm-ok');
    const cancelBtn = $('#btn-confirm-cancel');
    okBtn.textContent = okText;
    okBtn.className = 'btn ' + (danger ? 'danger' : 'primary');
    const done = (val) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    okBtn.focus();
  });
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

/* ---------------- 主机列表 ---------------- */

function groupOf(h) {
  return h.group || (h.cloud ? PROVIDER_LABEL[h.cloud.provider] || h.cloud.provider : '') || '我的主机';
}

async function refreshHosts() {
  state.hosts = await api('hosts:list');
  renderHosts();
}

function renderHosts() {
  const kw = ($('#host-search').value || '').trim().toLowerCase();
  const list = state.hosts.filter((h) => !kw || h.name.toLowerCase().includes(kw) || h.host.toLowerCase().includes(kw));
  const groups = new Map();
  for (const h of list) {
    const g = groupOf(h);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  const nav = $('#host-list');
  nav.innerHTML = '';
  if (!list.length) {
    nav.innerHTML = '<div class="host-empty">还没有主机<br />点击「新建主机」或「导入云主机」开始</div>';
    return;
  }
  for (const [g, hosts] of groups) {
    const title = document.createElement('div');
    title.className = 'host-group-title';
    title.textContent = `${g} · ${hosts.length}`;
    nav.appendChild(title);
    for (const h of hosts) {
      const item = document.createElement('div');
      item.className = 'host-item' + (isActiveHost(h.id) ? ' active' : '');
      item.dataset.id = h.id;
      const sub = `${h.username}@${h.host}:${h.port}` + (h.cloud && h.cloud.region ? `  ·  ☁ ${h.cloud.region}` : '');
      item.innerHTML = `
        <div class="host-main">
          <div class="host-name">${escapeHtml(h.name)}${!h.hasPassword && !h.hasKey ? '<span class="host-chip">待补全凭据</span>' : ''}</div>
          <div class="host-sub">${escapeHtml(sub)}</div>
        </div>
        <div class="host-actions">
          <button class="hi-clone" title="克隆">⧉</button>
          <button class="hi-edit" title="编辑">✎</button>
          <button class="hi-del" title="删除">🗑</button>
        </div>`;
      // 普通点击:已有会话则切过去,否则连接。
      // ⌘/Ctrl+点击 或 中键:强制新开一个标签(支持同主机多会话)。
      item.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey) connectHost(h.id, null, { newTab: true });
        else connectHost(h.id);
      });
      item.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); connectHost(h.id, null, { newTab: true }); }
      });
      item.querySelector('.hi-clone').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api('hosts:clone', { id: h.id });
          toast('已克隆主机', 'success');
          refreshHosts();
        } catch (err) {
          toast('克隆失败：' + err.message, 'error');
        }
      });
      item.querySelector('.hi-edit').addEventListener('click', (e) => { e.stopPropagation(); openHostModal(h); });
      item.querySelector('.hi-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await askConfirm(`确定删除主机「${h.name}」吗？此操作不可撤销。`, { title: '删除主机', okText: '删除' }))) return;
        await api('hosts:delete', { id: h.id });
        toast('已删除', 'success');
        refreshHosts();
      });
      nav.appendChild(item);
    }
  }
}

function isActiveHost(hostId) {
  for (const s of state.sessions.values()) {
    if (s.host.id === hostId && s.sessionId === state.activeId) return true;
  }
  return false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 主机编辑弹窗 ---------------- */

function openHostModal(host) {
  state.pickedKey = null;
  $('#host-modal-title').textContent = host ? '编辑主机' : '新建主机';
  $('#host-id').value = host ? host.id : '';
  $('#host-name').value = host ? host.name : '';
  $('#host-host').value = host ? host.host : '';
  $('#host-port').value = host ? host.port : 22;
  $('#host-username').value = host ? host.username : 'root';
  $('#host-auth').value = host ? host.authType : 'password';
  $('#host-password').value = '';
  $('#host-password').placeholder = host && host.hasPassword ? '已保存（留空保持不变）' : '密码';
  $('#host-passphrase').value = '';
  $('#host-passphrase').placeholder = host && host.hasKey ? '已保存（留空保持不变）' : '无则留空';
  $('#key-path').textContent = host && host.keyPath ? host.keyPath : '未选择';
  $('#host-group').value = host ? groupOf(host) : '';
  // 跳板机多选(I3):排除自身
  const jumpSel = $('#host-jump');
  jumpSel.innerHTML = '<option value="">(无)</option>';
  for (const h of state.hosts) {
    if (host && h.id === host.id) continue;
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `${h.name}(${h.host})`;
    jumpSel.appendChild(o);
  }
  if (host && Array.isArray(host.jumpIds)) {
    for (const id of host.jumpIds) {
      const o = [...jumpSel.options].find((x) => x.value === id);
      if (o) o.selected = true;
    }
  }
  $('#host-initcmd').value = host && host.initcmd ? host.initcmd : '';
  toggleAuthRows();
  openModal('#modal-host');
  $('#host-name').focus();
}

function toggleAuthRows() {
  const isKey = $('#host-auth').value === 'key';
  $('#row-password').classList.toggle('hidden', isKey);
  $('#row-key').classList.toggle('hidden', !isKey);
}

async function saveHostModal() {
  const id = $('#host-id').value;
  const jumpIds = [...$('#host-jump').selectedOptions].map((o) => o.value).filter(Boolean);
  const payload = {
    id: id || undefined,
    name: $('#host-name').value.trim(),
    host: $('#host-host').value.trim(),
    port: Number($('#host-port').value) || 22,
    username: $('#host-username').value.trim() || 'root',
    authType: $('#host-auth').value,
    group: $('#host-group').value.trim(),
    jumpIds,
    initcmd: $('#host-initcmd').value.trim(),
    password: $('#host-password').value || undefined,
    passphrase: $('#host-passphrase').value || undefined,
  };
  if (!payload.host) return toast('请填写主机地址', 'error');
  if (payload.authType === 'key') {
    if (state.pickedKey) {
      payload.privateKey = state.pickedKey.content;
      payload.keyPath = state.pickedKey.path;
    } else if (id) {
      // 编辑时不重选私钥文件 → 保持原私钥
    } else {
      return toast('请选择私钥文件', 'error');
    }
  }
  try {
    await api('hosts:save', payload);
    closeModal('#modal-host');
    toast('已保存主机', 'success');
    await refreshHosts();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/* ---------------- 终端会话 ---------------- */

const v = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || f;

const TERM_THEMES = {
  nebula: () => ({
    background: v('--bg', '#0d1117'),
    foreground: v('--text', '#e6edf3'),
    cursor: '#5b8cff',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(91,140,255,0.35)',
    black: '#0d1117', brightBlack: '#57606f',
    green: '#3ddc97', brightGreen: '#69f0ae',
    blue: '#5b8cff', brightBlue: '#79a2ff',
    red: '#ff6b6b', brightRed: '#ff8a8a',
    yellow: '#ffc24b', brightYellow: '#ffd37a',
    cyan: '#4dd0e1', magenta: '#c792ea', white: '#e6edf3',
  }),
  light: () => ({
    background: '#f6f8fa', foreground: '#1f2328', cursor: '#0969da', cursorAccent: '#f6f8fa',
    selectionBackground: 'rgba(9,105,218,0.25)',
    black: '#1f2328', brightBlack: '#6e7781',
    green: '#116329', brightGreen: '#1a7f37',
    blue: '#0969da', brightBlue: '#218bff',
    red: '#cf222e', brightRed: '#a40e26',
    yellow: '#9a6700', brightYellow: '#bf8700',
    cyan: '#1b7c83', magenta: '#8250df', white: '#f6f8fa',
  }),
  forest: () => ({
    background: '#0b1f16', foreground: '#d7e8dc', cursor: '#34d399', cursorAccent: '#0b1f16',
    selectionBackground: 'rgba(52,211,153,0.3)',
    black: '#0b1f16', brightBlack: '#5a7a68',
    green: '#34d399', brightGreen: '#6ee7b7',
    blue: '#60a5fa', brightBlue: '#93c5fd',
    red: '#f87171', brightRed: '#fca5a5',
    yellow: '#fbbf24', brightYellow: '#fcd34d',
    cyan: '#22d3ee', magenta: '#c084fc', white: '#d7e8dc',
  }),
};

function termTheme() {
  const key = (state.settings && state.settings.terminal && state.settings.terminal.theme) || 'nebula';
  return (TERM_THEMES[key] || TERM_THEMES.nebula)();
}

// —— 标签页(E1):每个标签持有独立的布局树与窗格集合 ——
function newTabId() { return 'tab-' + (++state.tabSeq); }

function makeTab(tabId) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.tab = tabId;
  el.innerHTML = '<span class="tab-dot connecting"></span><span class="tab-title">新标签</span><button class="tab-close" title="关闭标签">✕</button>';
  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    activateTab(tabId);
  });
  el.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });
  $('#tabs').appendChild(el);
  return el;
}

function createTab() {
  const id = newTabId();
  const tab = {
    id,
    el: makeTab(id),
    layout: null,
    panes: new Map(),
    zoomPaneId: null,
    activePaneId: null,
    sessionId: null, // 该标签当前挂载的会话(标签与窗格一一对应,分屏时取主窗格)
  };
  state.tabs.set(id, tab);
  return tab;
}

/// 仅切换"活动标签"的标识与高亮,不触碰 DOM。
/// 用于新建会话时先把标签设为活动,避免随后的 activateTab 触发
/// innerHTML 清空 —— 那会把 term.open() 刚挂好的终端摘掉再挂回,造成首屏输出丢失。
function setActiveTabId(tabId) {
  state.activeTabId = tabId;
  for (const [id, t] of state.tabs) t.el.classList.toggle('active', id === tabId);
}

/// 切换标签:只挂载目标标签的窗格,其余标签的终端保留在内存中不销毁
function activateTab(tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  // 已经是活动标签:窗格已在 DOM 上,只需重算几何与焦点,不要清空重挂
  if (state.activeTabId === tabId) {
    const cur = state.sessions.get(state.activeId);
    if (cur) {
      try { cur.fit.fit(); } catch { /* ignore */ }
      syncTabChrome();
      updateStatusbar(cur);
    }
    renderMonitorBar();
    return;
  }
  setActiveTabId(tabId);

  // 先把当前 DOM 里的窗格摘下来(不销毁终端),再挂载目标标签的窗格
  const stack = $('#layout-root');
  stack.innerHTML = '';
  closeCtxMenu();
  renderLayout();

  // 焦点落到该标签的会话上
  if (tab.sessionId && state.sessions.has(tab.sessionId)) {
    state.activeId = tab.sessionId;
  } else {
    const first = [...state.sessions.values()].find((s) => (s.tabId || null) === tabId);
    state.activeId = first ? first.sessionId : null;
  }
  syncTabChrome();
  const s = state.sessions.get(state.activeId);
  if (s) {
    try { s.fit.fit(); } catch { /* ignore */ }
    updateStatusbar(s);
    loadSessionLogState(s);
    // 切换标签后重新挂载,xterm 需要重绘并按新尺寸 fit
    setTimeout(() => {
      try { s.term.refresh(0, s.term.rows - 1); } catch { /* ignore */ }
      try { s.fit.fit(); } catch { /* ignore */ }
      try { s.term.focus(); } catch { /* ignore */ }
      scheduleResizeSync();
    }, 20);
  } else {
    updateStatusbar(null);
  }
  renderMonitorBar();
  updateWelcome();
  followFilePanel();
}

/// 文件面板跟随当前会话。
/// 面板是全局单例,若不跟随,切标签后会显示上一台服务器的目录,而操作却落到
/// 新会话上(看着 A 的目录删 B 的文件)。这里在切换后按"新会话"重新加载,
/// 并用该会话上次访问过的目录(没记录则回到根)。
function followFilePanel() {
  const panel = $('#file-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  const s = activeConnectedSession();
  if (!s) {
    state.file.sessionId = null;
    state.file.cwd = null;
    state.file.entries = [];
    $('#file-list').innerHTML = '<div class="file-empty">请先连接主机</div>';
    renderFileTarget();
    return;
  }
  if (state.file.sessionId === s.sessionId) { renderFileTarget(); return; }
  // 换目标:清掉上一个服务器的列表与选择,避免残留造成误操作
  state.file.selected = null;
  state.file.chmodTarget = null;
  state.file.renameMode = null;
  $('#file-chmod-row').classList.add('hidden');
  $('#file-mkdir-row').classList.add('hidden');
  $('#file-list').innerHTML = '<div class="file-empty">加载中…</div>';
  const remembered = s.lastFileDir || null;
  loadFileDir(remembered).catch(() => {});
}

/// 关闭标签:释放该标签下所有会话
function closeTab(tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  const ids = [...state.sessions.values()].filter((s) => (s.tabId || null) === tabId).map((s) => s.sessionId);
  for (const sid of ids) closeSession(sid);
  tab.el.remove();
  state.tabs.delete(tabId);
  if (state.activeTabId === tabId) {
    const next = [...state.tabs.keys()][0];
    if (next) activateTab(next);
    else {
      state.activeTabId = null;
      state.activeId = null;
      $('#layout-root').innerHTML = '';
      updateStatusbar(null);
      updateWelcome();
    }
  }
}

/// 同步标签标题/状态点(取该标签主会话)
function syncTabChrome() {
  for (const [tabId, tab] of state.tabs) {
    const s = [...state.sessions.values()].find((x) => (x.tabId || null) === tabId);
    const title = tab.el.querySelector('.tab-title');
    const dot = tab.el.querySelector('.tab-dot');
    if (s) {
      title.textContent = s.host.name;
      dot.className = 'tab-dot ' + s.status;
    } else {
      title.textContent = '新标签';
      dot.className = 'tab-dot';
    }
  }
}

// —— 分屏布局(E3):二叉布局树,leaf 持有 paneId ——
function newPaneId() { return 'pane-' + (++state.paneSeq); }

function makePaneEl(paneId) {
  const el = document.createElement('div');
  el.className = 'term-pane';
  el.dataset.pane = paneId;
  el.addEventListener('mousedown', () => {
    const pane = state.panes.get(paneId);
    if (pane && pane.sessionId) activateSession(pane.sessionId);
    else state.activePaneId = paneId;
  });
  const zoomBtn = document.createElement('button');
  zoomBtn.className = 'pane-zoom-btn';
  zoomBtn.title = '放大该窗格(⌘⇧↵ 还原)';
  zoomBtn.textContent = '⤢';
  zoomBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePaneZoom(paneId); });
  el.appendChild(zoomBtn);
  return el;
}

// 窗格放大/还原(竖向空间不足时的快速聚焦)
function togglePaneZoom(paneId) {
  if (state.zoomPaneId === paneId) {
    state.zoomPaneId = null;
  } else {
    const pane = state.panes.get(paneId);
    if (!pane || !pane.sessionId) return toast('空窗格无需放大', 'error');
    state.zoomPaneId = paneId;
  }
  renderLayout();
}

function rebalanceRatios(node) {
  if (isLeaf(node)) return node;
  node.ratio = 0.5; // 关闭窗格后重新均分,避免残留比例导致某侧过窄
  node.a = rebalanceRatios(node.a);
  node.b = rebalanceRatios(node.b);
  return node;
}

// 窗格过矮时自动隐藏监控条,还空间给终端
function updateMonitorAutoHide() {
  const bar = $('#monitor-bar');
  if (!bar) return;
  const heights = [...state.panes.values()].map((p) => p.el.getBoundingClientRect().height).filter(Boolean);
  const tooShort = state.panes.size > 1 && heights.length && Math.min(...heights) < 150;
  bar.classList.toggle('auto-hidden', tooShort);
}

function leaf(paneId) { return { type: 'leaf', paneId }; }
function isLeaf(n) { return !!n && n.type === 'leaf'; }

function findLeafPath(node, paneId, path = []) {
  if (isLeaf(node)) return node.paneId === paneId ? path : null;
  const l = findLeafPath(node.a, paneId, [...path, 'a']);
  if (l) return l;
  return findLeafPath(node.b, paneId, [...path, 'b']);
}

function nodeAt(node, path) {
  let cur = node;
  for (const k of path) cur = cur[k];
  return cur;
}

function replaceAt(path, fn) {
  if (!path.length) { state.layout = fn(state.layout); return; }
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];
  const parent = nodeAt(state.layout, parentPath);
  parent[key] = fn(parent[key]);
}

// 空窗格判定必须看窗格对象上的 sessionId —— 布局叶节点不持有该字段
// (此前读 node.sessionId 恒为 undefined,导致"永远存在空窗格",
//  新会话复用首个窗格并把已有会话的终端 DOM 清掉)。
function firstEmptyLeaf(node) {
  if (!node) return null;
  if (isLeaf(node)) {
    const pane = state.panes.get(node.paneId);
    return pane && !pane.sessionId ? node.paneId : null;
  }
  return firstEmptyLeaf(node.a) || firstEmptyLeaf(node.b);
}

function renderLayout() {
  const stack = $('#layout-root');
  const render = (node) => {
    void node;
    if (isLeaf(node)) {
      const pane = state.panes.get(node.paneId);
      if (!pane) return document.createElement('div');
      return pane.el;
    }
    const wrap = document.createElement('div');
    wrap.className = 'split-node ' + (node.type === 'v' ? 'v' : 'h');
    const a = render(node.a);
    const b = render(node.b);
    const div = document.createElement('div');
    div.className = 'split-divider';
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    wrap.appendChild(a); wrap.appendChild(div); wrap.appendChild(b);
    attachDivider(div, node, a, b, wrap);
    return wrap;
  };
  stack.innerHTML = '';
  if (state.zoomPaneId && state.panes.has(state.zoomPaneId)) {
    // 放大模式:仅渲染目标窗格,独占终端区
    const pane = state.panes.get(state.zoomPaneId);
    pane.el.style.flex = '1 1 0';
    stack.appendChild(pane.el);
    const chip = document.createElement('span');
    chip.className = 'zoom-chip';
    chip.title = '点击还原布局(⌘⇧↵)';
    chip.textContent = '⤢ 已放大';
    chip.addEventListener('click', () => togglePaneZoom(state.zoomPaneId));
    stack.appendChild(chip);
  } else if (state.layout) {
    stack.appendChild(render(state.layout));
  }
  renderPickers();
  for (const [, pane] of state.panes) {
    if (!pane.el.querySelector('.pane-zoom-btn')) {
      const zoomBtn = document.createElement('button');
      zoomBtn.className = 'pane-zoom-btn';
      zoomBtn.title = '放大该窗格(⌘⇧↵ 还原)';
      zoomBtn.textContent = '⤢';
      zoomBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePaneZoom(pane.id); });
      pane.el.appendChild(zoomBtn);
    }
  }
  updateWelcome();
  // reparent 后强制 xterm 重绘并恢复焦点,避免光标/选区残留。
  // 只处理"本标签、已挂载"的会话:隐藏标签的窗格不在 DOM 上,fit 会算出 0 尺寸。
  const focused = state.sessions.get(state.activeId);
  setTimeout(() => {
    for (const s of visibleSessions()) {
      try { s.term.refresh(0, s.term.rows - 1); } catch { /* ignore */ }
    }
    fitAllVisible();
    if (focused && state.sessions.has(focused.sessionId)) {
      try { focused.term.focus(); } catch { /* ignore */ }
    }
  }, 30);
}

/// 当前标签内、且窗格已挂载到 DOM 的会话。
/// 隐藏标签的窗格不在 DOM 上,对其 fit()/refresh() 会算出 0 尺寸并污染几何,
/// 因此所有"按可视尺寸重算"的操作都必须限定在这个集合内。
function visibleSessions() {
  const tab = activeTab();
  if (!tab) return [];
  return [...state.sessions.values()].filter((s) => s.tabId === tab.id && s.pane && s.pane.isConnected);
}

function attachDivider(div, node, aEl, bEl, wrap) {
  div.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let raf = 0;
    const move = (ev) => {
      const rect = wrap.getBoundingClientRect();
      const ratio = node.type === 'v'
        ? Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height))
        : Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
      node.ratio = ratio;
      aEl.style.flex = `${ratio} 1 0`;
      bEl.style.flex = `${1 - ratio} 1 0`;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitAllVisible(); }); // rAF 节流
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      scheduleResizeSync(); // 拖拽结束后统一同步 PTY
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// 空窗格渲染主机选择器(分屏新建时)
function renderPickers() {
  for (const [paneId, pane] of state.panes) {
    if (pane.sessionId || pane.pickerRendered) continue;
    pane.pickerRendered = true;
    const picker = document.createElement('div');
    picker.className = 'pane-picker';
    picker.innerHTML = '<div class="muted">选择要在该窗格连接的主机:</div>';
    for (const h of state.hosts) {
      const item = document.createElement('div');
      item.className = 'pp-item';
      item.textContent = `${h.name} · ${h.username}@${h.host}:${h.port}`;
      item.addEventListener('click', () => {
        pane.pickerRendered = false;
        picker.remove();
        connectHost(h.id, paneId, { force: true });
      });
      picker.appendChild(item);
    }
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.placeholder = 'user@host:port 快速连接…';
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const parsed = parseQuickTarget(inp.value);
      if (!parsed) return toast('格式:user@host:port', 'error');
      pane.pickerRendered = false;
      picker.remove();
      quickConnect(parsed, paneId);
    });
    picker.appendChild(inp);
    pane.el.appendChild(picker);
  }
}

// 在活动窗格旁分出新窗格(空,显示选择器)
function splitActive(dir) {
  if (!state.sessions.size && !state.layout) {
    state.layout = leaf(newPaneId());
    state.panes.set(state.layout.paneId, { id: state.layout.paneId, el: makePaneEl(state.layout.paneId), sessionId: null });
    renderLayout();
    return;
  }
  const activePaneId = activeLeafPaneId();
  const path = findLeafPath(state.layout, activePaneId) || [];
  replaceAt(path, (leafNode) => {
    const newId = newPaneId();
    state.panes.set(newId, { id: newId, el: makePaneEl(newId), sessionId: null });
    return { type: dir, ratio: 0.5, a: leafNode, b: leaf(newId) };
  });
  renderLayout();
}

function activeLeafPaneId() {
  if (state.activePaneId) {
    const p = state.panes.get(state.activePaneId);
    if (p && !p.sessionId) return state.activePaneId;
  }
  const s = state.sessions.get(state.activeId);
  if (s && s.paneId) return s.paneId;
  const first = firstLeafPaneId(state.layout);
  return first;
}

function firstLeafPaneId(node) {
  if (!node) return null;
  if (isLeaf(node)) return node.paneId;
  return firstLeafPaneId(node.a) || firstLeafPaneId(node.b);
}

/// 从指定标签的布局树里摘除一个窗格(作用于 tab 对象,不受当前活动标签影响)
function removePaneFromTab(tab, paneId) {
  if (!tab || !tab.layout) return;
  const path = findLeafPath(tab.layout, paneId);
  if (!path) return;
  const setAt = (node, p, val) => {
    if (!p.length) return val;
    const [k, ...rest] = p;
    node[k] = setAt(node[k], rest, val);
    return node;
  };
  tab.layout = setAt(tab.layout, path, null);
  const collapse = (node) => {
    if (node === null || isLeaf(node)) return node;
    const a = collapse(node.a); const b = collapse(node.b);
    if (a === null) return b;
    if (b === null) return a;
    node.a = a; node.b = b;
    return node;
  };
  tab.layout = collapse(tab.layout);
}

function fitAllVisible() {
  // 只 fit 当前标签内已挂载的会话:隐藏标签的窗格不在 DOM 上,
  // fit() 会得到 0 尺寸并把 PTY 尺寸推成 0。
  for (const s of visibleSessions()) {
    try {
      const before = { cols: s.term.cols, rows: s.term.rows };
      s.fit.fit();
      // 布局/窗口变化后同步 PTY 尺寸(E3 关键:远端列行数必须跟随,否则全屏应用错乱)
      if (s.status === 'connected' && (s.term.cols !== before.cols || s.term.rows !== before.rows)) {
        api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
      }
    } catch { /* ignore */ }
  }
  updateMonitorAutoHide();
}

let resizeSyncTimer = null;
function scheduleResizeSync() {
  clearTimeout(resizeSyncTimer);
  resizeResizeSync();
}
function resizeResizeSync() {
  resizeSyncTimer = setTimeout(() => {
    for (const s of visibleSessions()) {
      if (s.status !== 'connected') continue;
      api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  }, 150);
}

function createSession(host, paneId, tabId) {
  const sessionId = crypto.randomUUID();
  // 目标标签:显式指定(新标签) > 当前标签 > 新建一个
  let tab = tabId ? state.tabs.get(tabId) : activeTab();
  if (!tab) tab = createTab();
  // 先把标签设为活动(仅改标识与高亮,不动 DOM)。
  // 注意不能用 activateTab:它会清空 #layout-root,而本函数随后就要把新终端
  // 挂到该标签的窗格里 —— 若中途清空,term.open() 挂好的终端会被摘掉,
  // 首屏输出(如登录 banner)即丢失。
  const tabChanged = state.activeTabId !== tab.id;
  if (tabChanged) {
    setActiveTabId(tab.id);
    $('#layout-root').innerHTML = '';
  }

  // 在"该标签"内确定挂载窗格:指定 paneId(选择器) > 该标签的空窗格 > 该标签内新增分屏
  let targetPaneId = paneId || (tab.layout && firstEmptyLeaf(tab.layout));
  if (!targetPaneId) {
    if (!tab.layout) {
      targetPaneId = newPaneId();
      tab.layout = leaf(targetPaneId);
      tab.panes.set(targetPaneId, { id: targetPaneId, el: makePaneEl(targetPaneId), sessionId: null });
    } else {
      const anchor = activeLeafPaneId();
      const path = findLeafPath(tab.layout, anchor) || [];
      targetPaneId = newPaneId();
      replaceAt(path, (leafNode) => ({ type: 'h', ratio: 0.5, a: leafNode, b: leaf(targetPaneId) }));
      tab.panes.set(targetPaneId, { id: targetPaneId, el: makePaneEl(targetPaneId), sessionId: null });
    }
  }
  tab.panes.get(targetPaneId).sessionId = sessionId;
  renderLayout(); // 先挂载窗格 DOM,再初始化终端

  const pane = tab.panes.get(targetPaneId).el;
  pane.innerHTML = '';
  pane.dataset.session = sessionId;

  const ts = (state.settings && state.settings.terminal) || {};
  const term = new Terminal({
    fontSize: Number(ts.fontSize) || 13,
    fontFamily: ts.fontFamily || '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    scrollback: Number(ts.scrollback) || 2000,
    theme: termTheme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon()); // D7:链接识别,点击经主进程开系统浏览器
  term.open(pane);
  fit.fit();
  // innerHTML 清空会抹掉放大按钮,重新挂回
  const zb = document.createElement('button');
  zb.className = 'pane-zoom-btn';
  zb.title = '放大该窗格(⌘⇧↵ 还原)';
  zb.textContent = '⤢';
  zb.addEventListener('mousedown', (e) => e.stopPropagation());
  zb.addEventListener('click', (e) => { e.stopPropagation(); togglePaneZoom(targetPaneId); });
  pane.appendChild(zb);

  // 输入:只读拦截(D9) / 广播分发(E5) / 命令历史采集(F2)
  let histBuf = '';
  term.onData((d) => {
    const s = state.sessions.get(state.activeId);
    if (!s || s.sessionId !== sessionId || s.status !== 'connected') return;
    if (s.readOnly) return;
    histBuf += d;
    // 多字符 chunk(粘贴)也要逐字符识别回车
    let idx;
    while ((idx = histBuf.indexOf('\r')) >= 0) {
      const cmd = histBuf.slice(0, idx).replace(/[\x08\x7f]/g, '').trim(); // 清理退格控制符
      histBuf = histBuf.slice(idx + 1);
      if (cmd) api('history:add', { hostId: s.host.id, host: `${s.host.username}@${s.host.host}`, cmd }).catch(() => {});
    }
    const targets = state.broadcast && state.broadcast.has(sessionId)
      ? [...state.broadcast].map((id) => state.sessions.get(id)).filter((x) => x && x.status === 'connected' && !x.readOnly)
      : [s];
    for (const t of targets) {
      api('ssh:write', { sessionId: t.sessionId, data: d }).catch(() => {});
    }
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key === 'c' && (ev.shiftKey || (ev.metaKey && term.hasSelection()))) {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      return false;
    }
    if (mod && ev.key === 'v' && !ev.shiftKey) {
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
      return false;
    }
    if (mod && (ev.key === 'f' || ev.key === 'd')) return false; // 交给全局快捷键(搜索/分屏)
    return true;
  });

  // 标签元素由标签模型持有(不再每个会话建一个标签):
  // 一个标签可在其内部承载多个分屏窗格。
  const session = { sessionId, host, term, fit, search, paneId: targetPaneId, pane, tabId: tab.id, status: 'connecting', readOnly: false, histBuf: '', reconnectAttempt: 0 };
  state.sessions.set(sessionId, session);
  tab.sessionId = sessionId;
  syncTabChrome();
  // 走统一的激活路径:打上 .focused、刷新状态栏、fit 并聚焦。
  // (activateTab 在"已是当前标签"时提前返回,不会清空 DOM 把刚挂好的终端摘掉。)
  activateSession(sessionId);
  updateWelcome();
  session.pendingFirstPaint = true;
  void tabChanged;
  return session;
}

/// 首帧重算行几何(仅在会话首个数据绘制完成后调用一次)。
///
/// 背景:xterm 的 DOM 渲染器在 open() 时缓存一次行几何;新建会话时容器尚未
/// 首帧重算行几何(会话首个数据绘制完成后触发)。
///
/// 背景:xterm 的 DOM 渲染器在 open() 时缓存一次行几何;新建会话时容器尚未
/// 完成布局,缓存的行高不可用,表现为"缓冲区有数据、DOM 的行却是空的"。
/// refresh() 会复用该缓存(实测无效),只有 resize 才会重算;而布局完成时机
/// 与帧不对齐。这里做两件事:立即尝试一次,再用有界轮询兜底直到内容可见,
/// 既覆盖慢布局,也不长期占用定时器(可见即停,超时即弃)。
function firstPaint(session) {
  const { term, pane, fit } = session;
  if (!term || !pane || session._paintTimer) return;

  const domHasText = () => {
    const rows = pane.querySelector('.xterm-rows');
    if (!rows) return false;
    for (const d of rows.children) if ((d.textContent || '').trim()) return true;
    return false;
  };
  const repaint = () => {
    if (!pane.isConnected) return;
    try {
      fit.fit();
      const c = term.cols;
      const r = term.rows;
      term.resize(c, Math.max(1, r - 1));
      term.resize(c, r);
      term.refresh(0, Math.max(0, r - 1));
    } catch { /* ignore */ }
    scheduleResizeSync();
  };

  if (!domHasText()) repaint();
  if (domHasText()) return;

  let elapsed = 0;
  const STEP = 60;
  const LIMIT = 1500; // 覆盖慢首包与布局抖动;可见即停,超时即弃
  session._paintTimer = setInterval(() => {
    elapsed += STEP;
    if (!pane.isConnected || !state.sessions.has(session.sessionId)) {
      clearInterval(session._paintTimer);
      session._paintTimer = null;
      return;
    }
    if (!domHasText()) repaint();
    if (domHasText() || elapsed >= LIMIT) {
      clearInterval(session._paintTimer);
      session._paintTimer = null;
    }
  }, STEP);
}

function activateSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  // 会话属于某个标签:先切到该标签(会挂载它的窗格并处理 fit/refresh)
  if (s.tabId && state.activeTabId !== s.tabId) {
    activateTab(s.tabId);
  }
  state.activeId = sessionId;
  state.activePaneId = null;
  const tab = s.tabId ? state.tabs.get(s.tabId) : null;
  if (tab) tab.sessionId = sessionId;
  // 仅在当前标签内标记焦点窗格
  for (const [id, other] of state.sessions) {
    if (!tab || other.tabId !== tab.id) continue;
    const pane = tab.panes.get(other.paneId);
    if (pane) pane.el.classList.toggle('focused', id === sessionId);
  }
  try { s.fit.fit(); } catch { /* ignore */ }
  s.term.focus();
  syncTabChrome();
  updateStatusbar(s);
  loadSessionLogState(s);
  closeSnippetMenu();
  renderMonitorBar();
  // 会话切换(含新建后激活)时让文件面板跟随。
  // 注意不能只依赖 activateTab:新建会话时标签已是活动态,activateTab 会走
  // "已活动"的提前返回分支,不会执行到它的 followFilePanel()。
  followFilePanel();
}

function closeSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  api('ssh:disconnect', { sessionId }).catch(() => {});
  stopLogIfActive(sessionId);
  if (s._paintTimer) { clearInterval(s._paintTimer); s._paintTimer = null; }
  s.term.dispose();
  // 只在"所属标签"里摘除窗格(可能同时有多个标签各自的分屏)
  const tab = s.tabId ? state.tabs.get(s.tabId) : null;
  const pane = tab ? tab.panes.get(s.paneId) : null;
  if (tab && pane) {
    pane.sessionId = null;
    pane.el.innerHTML = '';
    pane.el.dataset.session = '';
    // 用该标签的布局树做摘除(闭包内操作 tab.layout,避免误动当前标签)
    removePaneFromTab(tab, s.paneId);
    tab.panes.delete(s.paneId);
  }
  state.broadcast && state.broadcast.delete(sessionId);
  if (!state.broadcast || !state.broadcast.size) setBroadcast(null);
  if (tab && tab.zoomPaneId === s.paneId) tab.zoomPaneId = null;
  state.metrics.delete(sessionId);
  state.sessions.delete(sessionId);
  if (tab && tab.layout) tab.layout = rebalanceRatios(tab.layout);
  if (tab && tab.sessionId === sessionId) {
    // 该标签的主会话被关闭:改为挂载标签内其余会话,无则保留空标签
    const rest = [...state.sessions.values()].find((x) => x.tabId === tab.id);
    tab.sessionId = rest ? rest.sessionId : null;
  }
  if (state.activeId === sessionId) {
    state.activeId = null;
    const next = tab && tab.sessionId ? tab.sessionId : [...state.sessions.keys()][0];
    if (next) activateSession(next);
    else updateStatusbar(null);
  }
  syncTabChrome();
  renderLayout();
  updateWelcome();
}

/// 会话状态变化后刷新标签外观(标题与状态点取自该标签的主会话)
function updateTab(session) {
  void session;
  syncTabChrome();
}

function updateStatusbar(session, error) {
  const dot = $('#status-dot');
  const text = $('#status-text');
  const btnRe = $('#btn-reconnect');
  const btnDis = $('#btn-disconnect');
  const btnRo = $('#btn-readonly');
  const btnClear = $('#btn-clear');
  const btnLog = $('#btn-log-toggle');
  const roBadge = $('#ro-badge');
  if (!session) {
    dot.className = 'dot idle';
    text.textContent = '就绪 — 尚未建立连接';
    for (const b of [btnRe, btnDis, btnRo, btnClear, btnLog]) b.classList.add('hidden');
    roBadge.classList.add('hidden');
    return;
  }
  const label = `${session.host.username}@${session.host.host}:${session.host.port}`;
  roBadge.classList.toggle('hidden', !session.readOnly);
  btnRo.classList.toggle('hidden', session.status !== 'connected');
  btnClear.classList.toggle('hidden', session.status !== 'connected');
  btnLog.classList.toggle('hidden', session.status !== 'connected');
  btnLog.textContent = session.logActive ? '⏺ 记录中' : '⏺ 日志';
  if (session.status === 'connected') {
    dot.className = 'dot connected';
    text.textContent = `已连接 ${label}` + (state.broadcast && state.broadcast.has(session.sessionId) ? ' · 📢广播中' : '');
    btnRe.classList.add('hidden');
    btnDis.classList.remove('hidden');
  } else if (session.status === 'connecting') {
    dot.className = 'dot connecting';
    text.textContent = `正在连接 ${label}…`;
    btnRe.classList.add('hidden');
    btnDis.classList.remove('hidden');
  } else {
    dot.className = 'dot ' + session.status;
    const retry = session.reconnectScheduled ? `(自动重连 ${session.reconnectAttempt}/3)` : '';
    text.textContent = `已断开 ${label}` + (error ? `（${error}）` : '') + retry;
    btnRe.classList.remove('hidden');
    btnDis.classList.add('hidden');
  }
}

// 自动重连(O2):最多 3 次,指数退避 1s/2s/4s
function scheduleReconnect(sessionId, why) {
  const s = state.sessions.get(sessionId);
  if (!s || s.reconnectAttempt >= 3 || s.host.quick) return;
  s.reconnectAttempt += 1;
  s.reconnectScheduled = true;
  const delay = 1000 * Math.pow(2, s.reconnectAttempt - 1);
  updateStatusbar(s, why);
  setTimeout(() => {
    if (!state.sessions.has(sessionId) || s.status === 'connected') return;
    s.status = 'connecting';
    updateTab(s);
    api('ssh:connect', { hostId: s.host.id, sessionId }).then(() => {
      s.reconnectAttempt = 0;
      s.reconnectScheduled = false;
    }).catch((e) => {
      s.status = 'error';
      updateTab(s);
      scheduleReconnect(sessionId, e.message);
    });
  }, delay);
}

async function connectHost(hostId, paneId, opts = {}) {
  const { force = false, newTab = false } = opts;
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host) return;
  // 已有会话则切过去 —— 但"新开标签"的意图要尊重:
  // 同主机可以再开一个独立会话(⌘/Ctrl+点击、中键,或标签栏的 ＋)。
  if (!force && !newTab) {
    for (const s of state.sessions.values()) {
      if (s.host.id === hostId && (s.status === 'connected' || s.status === 'connecting')) {
        activateSession(s.sessionId);
        return;
      }
    }
  }
  // 目标位置:指定窗格(分屏/窗格选择器)→ 放进该窗格;
  // 否则一律新开一个标签 —— 点主机就是"打开一个会话标签",分屏是显式动作(⛶ / ⌘D)。
  let tabId = null;
  if (!paneId) {
    tabId = createTab().id;
  }
  const session = createSession(host, paneId, tabId);
  try {
    await api('ssh:connect', { hostId, sessionId: session.sessionId });
    if (host.initcmd) api('ssh:write', { sessionId: session.sessionId, data: host.initcmd + '\r' }).catch(() => {});
  } catch (e) {
    session.status = 'error';
    syncTabChrome();
    if (state.activeId === session.sessionId) updateStatusbar(session, e.message);
    toast('连接失败：' + e.message, 'error');
    scheduleReconnect(session.sessionId, e.message);
  }
}

// 快速连接(A2):不入库,凭据仅驻内存
function parseQuickTarget(text) {
  const m = String(text || '').trim().match(/^(?:([\w.-]+)@)?([\w.-]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1] || 'root', host: m[2], port: Number(m[3]) || 22 };
}

async function quickConnect(parsed, paneId) {
  const host = { id: 'quick-' + crypto.randomUUID(), quick: true, name: `${parsed.host}:${parsed.port}`, ...parsed, authType: 'password' };
  // 与点主机一致:无指定窗格时新开标签
  const session = createSession(host, paneId, paneId ? null : createTab().id);
  try {
    await api('ssh:connectQuick', { host });
    toast('快速连接成功', 'success');
  } catch (e) {
    session.status = 'error';
    updateTab(session);
    updateStatusbar(session, e.message);
    toast('快速连接失败:' + e.message, 'error');
  }
}

function fitActive() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  try {
    s.fit.fit();
    if (s.status === 'connected') {
      api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  } catch { /* ignore */ }
}

function updateWelcome() {
  $('#welcome').classList.toggle('hidden', !!state.layout);
}

/* ---------------- 云主机导入(多账号 + 全区域一键拉取) ---------------- */

const VENDOR_LABEL = { tencent: '腾讯云', aliyun: '阿里云' };
const SERVICE_LABEL = { cvm: 'CVM', lighthouse: '轻量', aliyun: 'ECS', tencent: 'CVM' };

function providerLabel(p) { return PROVIDER_LABEL[p] || p; }

/// 账号列表(含已保存凭据的形态)。secret 不回传,编辑时留空 = 保持不变
async function refreshCloudAccounts() {
  const r = await api('cloud:accounts');
  state.cloudAccounts = r.accounts || [];
  renderCloudAccounts();
}

function renderCloudAccounts() {
  const box = $('#cloud-accounts');
  box.innerHTML = '';
  if (!state.cloudAccounts.length) {
    box.innerHTML = '<div class="muted small-note" style="padding:6px 2px;">尚未添加账号。添加后即可一键拉取该账号下所有地域的主机(腾讯云自动包含 CVM 与轻量)。</div>';
    return;
  }
  for (const a of state.cloudAccounts) {
    const row = document.createElement('div');
    row.className = 'cloud-account-row';
    row.innerHTML = `
      <span class="ca-vendor">${escapeHtml(VENDOR_LABEL[a.vendor] || a.vendor)}</span>
      <span class="ca-label">${escapeHtml(a.label || '(未命名)')}</span>
      <span class="ca-key mono">${escapeHtml(a.keyId || '')}</span>
      ${a.secretSet ? '<span class="ca-ok">已保存密钥</span>' : '<span class="ca-miss">缺密钥</span>'}
      <span class="spacer"></span>
      <button class="btn small ca-edit">编辑</button>
      <button class="btn small ca-del">删除</button>`;
    row.querySelector('.ca-edit').addEventListener('click', () => editCloudAccount(a));
    row.querySelector('.ca-del').addEventListener('click', async () => {
      if (!(await askConfirm(`删除云账号「${a.label || a.keyId}」?已导入的主机不受影响。`, { title: '删除云账号', okText: '删除' }))) return;
      await api('cloud:deleteAccount', { id: a.id });
      await refreshCloudAccounts();
    });
    box.appendChild(row);
  }
}

/// 添加/编辑账号:弹出输入对话框逐项填写(无需新开 modal)
async function editCloudAccount(existing) {
  const vendor = existing ? existing.vendor : ($('#cloud-new-vendor').value || 'tencent');
  const keyName = vendor === 'aliyun' ? 'AccessKeyId' : 'SecretId';
  const secretName = vendor === 'aliyun' ? 'AccessKeySecret' : 'SecretKey';
  const label = await askPrompt('账号备注名(例如「公司主账号」「测试账号」):', {
    title: existing ? '编辑云账号' : '添加云账号',
    okText: '下一步',
    password: false,
    placeholder: '我的账号',
    validate: (v) => (v.trim().length > 50 ? '备注名过长(≤50 字)' : null),
  });
  if (label === null) return;
  const initial = existing ? label.trim() || (existing.label || '') : label.trim();
  const keyId = await askPrompt(`${keyName}:`, {
    title: existing ? '编辑云账号' : '添加云账号',
    okText: '下一步',
    password: false,
    placeholder: vendor === 'aliyun' ? 'LTAI…' : 'AKID…',
  });
  if (keyId === null) return;
  const secret = await askPrompt(`${secretName}(密钥只保存在本机,加密存储):`, {
    title: existing ? '编辑云账号' : '添加云账号',
    okText: existing ? '保存' : '添加',
    placeholder: existing && existing.secretSet ? '已保存(留空保持不变)' : secretName,
    validate: (v) => {
      if (existing && existing.secretSet) return null; // 编辑可不重输
      return v.length > 0 ? null : '请填写 Secret';
    },
  });
  if (secret === null) return;
  try {
    await api('cloud:saveAccount', {
      id: existing ? existing.id : '',
      label: initial,
      vendor,
      keyId: keyId.trim(),
      secret: secret.trim(),
      endpoint: existing ? existing.endpoint || '' : '',
    });
    toast(existing ? '云账号已更新' : '云账号已添加', 'success');
    await refreshCloudAccounts();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/// 一键拉取:所有(或勾选的)账号 × 全部地域,腾讯云自动合并 CVM + 轻量
async function cloudFetchAll() {
  const ids = state.cloudAccounts.map((a) => a.id);
  if (!ids.length) return toast('请先添加云账号', 'error');
  $('#cloud-status').textContent = '正在探测所有地域并拉取实例…(首次约需数秒)';
  $('#btn-cloud-fetch').disabled = true;
  try {
    const r = await api('cloud:fetchAll', { accountIds: ids });
    state.cloudResults = (r.instances || []).filter((i) => i.host);
    // 错误去重后展示(单地域失败不阻断)
    const errs = [...new Set(r.errors || [])];
    const errBox = $('#cloud-errors');
    if (errs.length) {
      errBox.classList.remove('hidden');
      errBox.innerHTML = `<b>部分地域拉取失败(${errs.length})</b>` +
        errs.slice(0, 5).map((e) => `<div class="muted">${escapeHtml(e)}</div>`).join('') +
        (errs.length > 5 ? `<div class="muted">… 共 ${errs.length} 条</div>` : '');
    } else {
      errBox.classList.add('hidden');
    }
    if (!state.cloudResults.length) {
      $('#cloud-status').textContent = '所有地域均未发现可用实例(无公网 IP 的实例已过滤)';
      renderCloudRows();
      return;
    }
    $('#cloud-status').textContent = `获取到 ${state.cloudResults.length} 台实例(按地域分组)`;
    renderCloudRows();
  } catch (e) {
    $('#cloud-status').textContent = '获取失败';
    toast('获取失败：' + e.message, 'error');
  } finally {
    $('#btn-cloud-fetch').disabled = false;
  }
}

function renderCloudRows() {
  const tbody = $('#cloud-tbody');
  tbody.innerHTML = '';
  // 按地域分组展示(组内:厂商 + 实例)
  const groups = new Map();
  for (const it of state.cloudResults) {
    const g = `${it.cloud.region}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  let idx = 0;
  for (const [region, list] of groups) {
    const head = document.createElement('tr');
    head.className = 'cloud-group-row';
    head.innerHTML = `<td colspan="8">📍 ${escapeHtml(region)} · ${list.length} 台</td>`;
    tbody.appendChild(head);
    for (const it of list) {
      const i = idx++;
      const running = /running/i.test(it.state);
      const tr = document.createElement('tr');
      tr.className = 'cloud-row';
      tr.innerHTML = `
        <td><input type="checkbox" class="cloud-check" data-i="${i}" ${running ? 'checked' : ''} /></td>
        <td>${escapeHtml(it.name)}</td>
        <td class="mono">${escapeHtml(it.host || '（无公网 IP）')}</td>
        <td><span class="tag">${escapeHtml(SERVICE_LABEL[it.cloud.provider] || it.cloud.provider)}</span></td>
        <td class="muted">${escapeHtml(it.cloud.region)}</td>
        <td><span class="badge ${running ? 'running' : /stop/i.test(it.state) ? 'stopped' : 'other'}">${escapeHtml(it.state || '-')}</span></td>
        <td class="muted">${escapeHtml(it.cloud.os || '-')}</td>
        <td><button class="btn small cloud-connect" data-i="${i}">连接</button></td>`;
      tbody.appendChild(tr);
    }
  }
  tbody.querySelectorAll('.cloud-connect').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const it = state.cloudResults[Number(btn.dataset.i)];
      const saved = await importInstance(it);
      closeModal('#modal-cloud');
      await refreshHosts();
      connectHost(saved.id);
    });
  });
  $('#cloud-table').classList.remove('hidden');
  const checked = tbody.querySelectorAll('.cloud-check:checked').length;
  $('#cloud-count').textContent = `共 ${state.cloudResults.length} 台，已选 ${checked} 台`;
  $('#btn-cloud-import-selected').classList.toggle('hidden', state.cloudResults.length === 0);
}

function instancePayload(it, group) {
  return {
    name: it.name,
    host: it.host,
    port: it.port || 22,
    username: it.username || 'root',
    authType: 'password',
    group,
    tags: [providerLabel(it.cloud.provider), it.cloud.region],
    cloud: it.cloud,
  };
}

async function importInstance(it) {
  return api('hosts:save', instancePayload(it, providerLabel(it.cloud.provider)));
}

async function cloudImportSelected() {
  const checked = [...document.querySelectorAll('.cloud-check:checked')].map((c) => Number(c.dataset.i));
  if (!checked.length) return toast('请先勾选要导入的实例', 'error');
  try {
    for (const i of checked) await importInstance(state.cloudResults[i]);
    toast(`已导入 ${checked.length} 台主机，请编辑主机补全登录凭据`, 'success');
    closeModal('#modal-cloud');
    await refreshHosts();
  } catch (e) {
    toast('导入失败：' + e.message, 'error');
  }
}

/* ---------------- AI 助手 ---------------- */

// 对话上下文窗口:只保留最近 N 轮往返。
// 旧实现里 aiHistory 无上限,且每次请求都全量发给模型 —— 长会话会既吃内存
// 又持续抬高请求体(直到超出模型上下文而报错)。
const AI_HISTORY_LIMIT = 20;
// 消息区 DOM 上限:超出的旧气泡直接移除,避免长会话下无界增长。
const AI_DOM_LIMIT = 200;

function trimAiHistory() {
  if (state.aiHistory.length > AI_HISTORY_LIMIT) {
    state.aiHistory = state.aiHistory.slice(-AI_HISTORY_LIMIT);
  }
}

function renderAiMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.textContent = text;
  const box = $('#ai-messages');
  box.appendChild(el);
  while (box.children.length > AI_DOM_LIMIT) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  return el;
}

function setAiBusy(busy) {
  $('#ai-send').disabled = busy;
  $('#ai-send').textContent = busy ? '生成中…' : '发送';
}

function aiRequest(messages, bubble) {
  return new Promise((resolve) => {
    if (state.aiReq) {
      resolve({ error: '已有请求进行中，请稍候' });
      return;
    }
    const requestId = crypto.randomUUID();
    const holder = { id: requestId, acc: '', bubble, resolve, messages };
    state.aiReq = holder;
    setAiBusy(true);
    api('ai:chat', { requestId, messages }).catch((e) => {
      if (state.aiReq === holder) {
        state.aiReq = null;
        setAiBusy(false);
        resolve({ error: e.message });
      }
    });
  });
}

function aiFinishHolder() {
  const h = state.aiReq;
  if (!h) return;
  state.aiReq = null;
  setAiBusy(false);
  if (h.bubble) {
    if (!h.acc && !h.bubble.textContent) h.bubble.textContent = '（AI 未返回内容）';
  }
  if (h.acc) {
    state.aiHistory.push({ role: 'assistant', content: h.acc });
    trimAiHistory();
  }
  h.resolve({ ok: true, text: h.acc });
}

async function aiSend(rawText, mode) {
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
  if (r && r.error) {
    bubble.textContent = '⚠️ ' + r.error;
  }
}

async function aiTestConnection() {
  const r = await aiRequest([{ role: 'user', content: '请只回复两个字母：OK' }], null);
  if (r && r.error) toast('测试失败：' + r.error, 'error');
  else toast('连接成功，AI 已响应', 'success');
}

function updateGenChip() {
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
async function fetchAiModels() {
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

function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return n + 'B/s';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB/s';
  return (n / 1024 / 1024).toFixed(1) + 'MB/s';
}

function closeSnippetMenu() {
  const menu = $('#snippet-menu');
  if (menu) menu.classList.add('hidden');
}

function renderSnippets() {
  const list = $('#snippet-list');
  list.innerHTML = '';
  const items = (state.settings && state.settings.snippets) || [];
  if (!items.length) {
    list.innerHTML = '<div class="file-empty">还没有常用命令，在下方添加</div>';
    return;
  }
  for (const s of items) {
    const row = document.createElement('div');
    row.className = 'snippet-row';
    row.innerHTML = `<span class="s-name"></span><span class="s-cmd"></span><button class="s-del" title="删除">🗑</button>`;
    row.querySelector('.s-name').textContent = s.name;
    row.querySelector('.s-cmd').textContent = s.cmd;
    row.addEventListener('click', async (e) => {
      if (e.target.classList.contains('s-del')) return;
      const cur = state.sessions.get(state.activeId);
      if (!cur || cur.status !== 'connected') return toast('请先连接主机', 'error');
      await api('ssh:write', { sessionId: cur.sessionId, data: s.cmd + '\r' }).catch(() => {});
      closeSnippetMenu();
    });
    row.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      state.settings.snippets = items.filter((x) => x !== s);
      await saveSnippets();
    });
    list.appendChild(row);
  }
}

async function saveSnippets() {
  state.settings = await api('settings:save', { snippets: state.settings.snippets });
  renderSnippets();
}

async function addSnippet() {
  const name = $('#snippet-name').value.trim();
  const cmd = $('#snippet-cmd').value.trim();
  if (!name || !cmd) return toast('请填写名称和命令', 'error');
  const items = (state.settings && state.settings.snippets) || [];
  items.push({ name, cmd });
  state.settings.snippets = items;
  $('#snippet-name').value = '';
  $('#snippet-cmd').value = '';
  await saveSnippets();
}

/* ---------------- SFTP 文件面板 ---------------- */

function fileParent(p) {
  const trimmed = String(p || '/').replace(/\/+$/, '');
  if (!trimmed || trimmed === '') return '/';
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function activeConnectedSession() {
  const s = state.sessions.get(state.activeId);
  return s && s.status === 'connected' ? s : null;
}

function renderFileList() {
  const box = $('#file-list');
  box.innerHTML = '';
  const { cwd, entries } = state.file;
  $('#file-path').textContent = cwd || '';
  if (cwd && fileParent(cwd) !== cwd) {
    const up = document.createElement('div');
    up.className = 'file-row';
    up.innerHTML = `<span>📁</span><span class="f-name">..</span>`;
    up.addEventListener('click', () => loadFileDir(fileParent(cwd)));
    box.appendChild(up);
  }
  for (const en of entries) {
    const row = document.createElement('div');
    row.className = 'file-row' + (state.file.selected === en.name ? ' selected' : '');
    row.innerHTML = `<span>${en.dir ? '📁' : '📄'}</span><span class="f-name"></span><span class="f-size"></span>`;
    row.querySelector('.f-name').textContent = en.name;
    row.querySelector('.f-size').textContent = en.dir ? '' : fmtSize(en.size);
    row.addEventListener('click', () => {
      state.file.selected = en.name;
      renderFileList();
    });
    row.addEventListener('dblclick', () => { if (en.dir) loadFileDir((cwd === '/' ? '' : cwd) + '/' + en.name); });
    box.appendChild(row);
  }
  if (!entries.length) box.innerHTML = '<div class="file-empty">目录为空</div>';
}

/// 文件面板的目标会话。
/// 面板是全局的(一个 DOM),但 SFTP 操作必须落在"面板显示的那台服务器"上。
/// 这里以 fileSessionId 为准,而不是 activeConnectedSession() ——
/// 否则切标签后会出现"看着 A 的目录、操作落到 B"的误删风险。
function filePanelSession() {
  const s = state.file.sessionId ? state.sessions.get(state.file.sessionId) : null;
  return s && s.status === 'connected' ? s : null;
}

/// 渲染面板的服务器标识(标题下方),让用户明确当前操作对象
function renderFileTarget() {
  const el = $('#file-target');
  if (!el) return;
  const s = filePanelSession();
  if (!s) {
    const active = state.sessions.get(state.activeId);
    el.textContent = active && active.status === 'connected' ? '未选择目录(点刷新加载)' : '未连接';
    el.classList.toggle('warn', !active || active.status !== 'connected');
    return;
  }
  el.textContent = `${s.host.username}@${s.host.host}:${s.host.port}`;
  el.classList.remove('warn');
  el.title = `当前文件操作目标：${s.host.name}（${s.host.username}@${s.host.host}:${s.host.port}）`;
}

async function loadFileDir(dir) {
  const s = activeConnectedSession();
  if (!s) {
    state.file.sessionId = null;
    state.file.cwd = null;
    state.file.entries = [];
    $('#file-list').innerHTML = '<div class="file-empty">请先连接主机</div>';
    renderFileTarget();
    return;
  }
  // 记录本次列表属于哪个会话:操作时以此为准,避免切标签后张冠李戴
  state.file.sessionId = s.sessionId;
  renderFileTarget();
  $('#file-status').textContent = '加载中…';
  try {
    const r = await api('sftp:list', { sessionId: s.sessionId, path: dir });
    // 期间用户可能已切换会话:丢弃过期响应,避免把旧服务器的目录画到新目标上
    if (state.file.sessionId !== s.sessionId) return;
    state.file.cwd = r.path;
    state.file.entries = r.entries;
    state.file.selected = null;
    s.lastFileDir = r.path; // 记住各会话的最后目录,切回时恢复到原处
    renderFileList();
    renderFileTarget();
    $('#file-status').textContent = '';
  } catch (e) {
    if (state.file.sessionId !== s.sessionId) return;
    $('#file-status').textContent = '加载失败：' + e.message;
  }
}

async function fileUpload() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const paths = await api('dialog:pickAnyFile');
  if (!paths || !paths.length) return;
  for (const p of paths) {
    const name = p.split('/').pop();
    $('#file-status').textContent = `上传 ${name}…`;
    try {
      await api('sftp:upload', { sessionId: s.sessionId, localPath: p, remoteDir: state.file.cwd });
      $('#file-status').textContent = `已上传 ${name}`;
    } catch (e) {
      $('#file-status').textContent = '上传失败：' + e.message;
      toast('上传失败：' + e.message, 'error');
    }
  }
  loadFileDir(state.file.cwd);
}

async function fileDownload() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先在列表中选中文件', 'error');
  if (en.dir) return toast('目录不支持下载，请选择文件', 'error');
  const localPath = await api('dialog:saveFile', { defaultName: en.name });
  if (!localPath) return;
  $('#file-status').textContent = `下载 ${en.name}…`;
  try {
    await api('sftp:download', { sessionId: s.sessionId, remotePath: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name, localPath });
    $('#file-status').textContent = `已保存到 ${localPath}`;
    toast('下载完成', 'success');
  } catch (e) {
    $('#file-status').textContent = '下载失败：' + e.message;
    toast('下载失败：' + e.message, 'error');
  }
}

async function fileDelete() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先在列表中选中要删除的项', 'error');
  if (!(await askConfirm(`确定删除「${en.name}」吗？`, { title: '删除文件', okText: '删除' }))) return;
  try {
    await api('sftp:remove', { sessionId: s.sessionId, path: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name, isDir: en.dir });
    loadFileDir(state.file.cwd);
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

/* ---------------- 终端搜索 ---------------- */

function activeSearch() {
  const s = state.sessions.get(state.activeId);
  return s ? s.search : null;
}

function openTermSearch() {
  if (!state.sessions.size) return toast('请先连接主机', 'error');
  $('#term-search').classList.remove('hidden');
  $('#term-search-input').focus();
  $('#term-search-input').select();
}

function closeTermSearch() {
  $('#term-search').classList.add('hidden');
  const s = state.sessions.get(state.activeId);
  if (s) { try { s.search.clearDecorations(); } catch { /* ignore */ } s.term.focus(); }
  $('#term-search-count').textContent = '';
}

function doTermSearch(backwards) {
  const q = $('#term-search-input').value;
  const addon = activeSearch();
  if (!q || !addon) return;
  try {
    addon.findNext(q, { backwards: !!backwards, incremental: true });
    $('#term-search-count').textContent = '';
  } catch { /* ignore */ }
}

/* ---------------- 终端设置 ---------------- */

function openTermSettings() {
  const t = (state.settings && state.settings.terminal) || { fontSize: 13, theme: 'nebula', scrollback: 2000 };
  $('#term-fontsize').value = t.fontSize || 13;
  $('#term-theme').value = t.theme || 'nebula';
  $('#term-scrollback').value = t.scrollback || 2000;
  openModal('#modal-term');
}

async function saveTermSettings() {
  const patch = {
    terminal: {
      fontSize: Number($('#term-fontsize').value) || 13,
      theme: $('#term-theme').value,
      scrollback: Number($('#term-scrollback').value) || 2000,
    },
  };
  state.settings = await api('settings:save', patch);
  closeModal('#modal-term');
  // 全部即时应用:主题/字号直接改 options;回滚行数改 options 后 xterm 内部会
  // 触发一次 resize 并按新上限裁剪缓冲区(旧行随之释放),无需重建终端。
  const theme = termTheme();
  const ts = (state.settings && state.settings.terminal) || {};
  const fontSize = Number(ts.fontSize) || 13;
  const scrollback = Number(ts.scrollback) || 2000;
  for (const s of state.sessions.values()) {
    try {
      s.term.options.theme = theme;
      s.term.options.fontSize = fontSize;
      s.term.options.scrollback = scrollback;
    } catch { /* ignore */ }
  }
  // 字号变化会改变字符网格,需重算几何并同步远端 PTY(只对本标签已挂载的会话)
  for (const s of visibleSessions()) {
    try { s.fit.fit(); } catch { /* ignore */ }
  }
  scheduleResizeSync();
  fitAllVisible();
  toast('终端设置已应用', 'success');
}

/* ---------------- 广播输入(E5) ---------------- */

function setBroadcast(sessionIds) {
  state.broadcast = sessionIds && sessionIds.size ? new Set(sessionIds) : null;
  let bar = $('#broadcast-bar');
  if (state.broadcast) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'broadcast-bar';
      $('#tabbar').insertAdjacentElement('afterend', bar);
    }
    bar.classList.remove('hidden');
    bar.innerHTML = `<b>📢 广播中 → ${state.broadcast.size} 个会话</b><span class="grow"></span><button id="btn-broadcast-stop" class="btn sm">停止广播</button>`;
    $('#btn-broadcast-stop').addEventListener('click', () => setBroadcast(null));
  } else if (bar) {
    bar.classList.add('hidden');
  }
  $('#btn-broadcast').classList.toggle('active', !!state.broadcast);
  const s = state.sessions.get(state.activeId);
  if (s) updateStatusbar(s);
}

function openBroadcastPicker() {
  const connected = [...state.sessions.values()].filter((s) => s.status === 'connected');
  if (connected.length < 1) return toast('没有已连接的会话', 'error');
  if (state.broadcast) return setBroadcast(null); // 再点一次关闭
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'modal-broadcast';
  overlay.innerHTML = `<div class="modal-card"><h3>选择广播目标</h3><div class="batch-hosts" id="bc-list"></div>
    <div class="modal-actions"><button class="btn" id="bc-cancel">取消</button><button class="btn primary" id="bc-ok">开始广播</button></div></div>`;
  const list = overlay.querySelector('#bc-list');
  // 默认全选已连接会话(广播的典型意图是"下发到所有"),活动会话置顶
  const ordered = [...connected].sort((a, b) => (a.sessionId === state.activeId ? -1 : b.sessionId === state.activeId ? 1 : 0));
  for (const s of ordered) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${s.sessionId}" checked /> ${escapeHtml(s.host.name)} · ${escapeHtml(s.host.username)}@${escapeHtml(s.host.host)}${s.sessionId === state.activeId ? ' <span class="tag">当前</span>' : ''}`;
    list.appendChild(label);
  }
  overlay.querySelector('#bc-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bc-ok').addEventListener('click', () => {
    const ids = [...list.querySelectorAll('input:checked')].map((i) => i.value);
    overlay.remove();
    if (!ids.length) return toast('请至少选择一个会话', 'error');
    setBroadcast(new Set(ids));
    toast(`广播已开启:${ids.length} 个会话`, 'success');
  });
  document.body.appendChild(overlay);
}

/* ---------------- 批量执行(F6) ---------------- */

let batchChecked = new Set();

function renderBatchHosts(kw) {
  const box = $('#batch-hosts');
  box.innerHTML = '';
  for (const h of state.hosts) {
    const label = `${h.name} · ${h.username}@${h.host}`;
    if (kw && !label.toLowerCase().includes(String(kw).toLowerCase())) continue;
    const el = document.createElement('label');
    el.innerHTML = `<input type="checkbox" value="${h.id}" ${batchChecked.has(h.id) ? 'checked' : ''}/><span>${escapeHtml(label)}</span>`;
    el.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) batchChecked.add(h.id); else batchChecked.delete(h.id);
    });
    box.appendChild(el);
  }
}

function openBatchModal() {
  batchChecked = new Set();
  renderBatchHosts('');
  $('#batch-cmd').value = '';
  $('#batch-results').classList.add('hidden');
  $('#batch-tbody').innerHTML = '';
  $('#batch-status').textContent = '';
  openModal('#modal-batch');
}

async function runBatch() {
  const cmd = $('#batch-cmd').value.trim();
  if (!cmd) return toast('请输入命令', 'error');
  if (!batchChecked.size) return toast('请选择目标主机', 'error');
  const hostIds = [...batchChecked];
  const timeoutMs = (Number($('#batch-timeout').value) || 30) * 1000;
  $('#btn-batch-run').disabled = true;
  $('#batch-status').textContent = `执行中(0/${hostIds.length})…`;
  const done = [];
  const table = $('#batch-results');
  table.classList.remove('hidden');
  const tbody = $('#batch-tbody');
  tbody.innerHTML = '';
  const rowFor = (hostId) => {
    let tr = tbody.querySelector(`tr[data-h="${hostId}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.h = hostId;
      tbody.appendChild(tr);
    }
    return tr;
  };
  const off = window.nebula.on('batch:progress', (p) => {
    done.push(p);
    $('#batch-status').textContent = `执行中(${done.length}/${hostIds.length})…`;
    const tr = rowFor(p.hostId);
    tr.innerHTML = `<td>${escapeHtml(p.host)}</td><td>${p.ok ? '<span class="tag ok">成功</span>' : `<span class="tag p1">失败 ${p.code != null ? 'code ' + p.code : ''}</span>`}</td><td>${p.ms}ms</td><td class="out" title="${escapeHtml(p.output || p.error || '')}">${escapeHtml((p.output || p.error || '').slice(0, 120))}</td>`;
  });
  try {
    const results = await api('batch:exec', { hostIds, command: cmd, timeoutMs, maxParallel: Number($('#batch-parallel').value) || 5 });
    off();
    const okCount = results.filter((r) => r.ok).length;
    $('#batch-status').textContent = `完成:${okCount} 成功 / ${results.length - okCount} 失败`;
    toast(`批量执行完成(${okCount}/${results.length} 成功)`, okCount === results.length ? 'success' : 'error');
  } catch (e) {
    off();
    $('#batch-status').textContent = '执行失败:' + e.message;
  } finally {
    $('#btn-batch-run').disabled = false;
  }
}

/* ---------------- 指纹管理(B6) ---------------- */

async function openFingerprints() {
  try {
    const list = await api('fingerprints:list');
    const tbody = $('#fp-tbody');
    tbody.innerHTML = '';
    if (!list.length) {
      $('#fp-table').classList.add('hidden');
      tbody.innerHTML = '<tr><td colspan="3" class="muted">暂无记录</td></tr>';
      $('#fp-table').classList.remove('hidden');
    } else {
      for (const f of list) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="mono">${escapeHtml(f.id)}</td><td class="mono">${escapeHtml(String(f.fp).slice(0, 32))}…</td><td><button class="btn small fp-del">删除</button></td>`;
        tr.querySelector('.fp-del').addEventListener('click', async () => {
          if (!(await askConfirm(`删除主机 ${f.id} 的指纹?下次连接将重新信任。`, { title: '删除指纹', okText: '删除' }))) return;
          await api('fingerprints:delete', { id: f.id });
          openFingerprints();
        });
        tbody.appendChild(tr);
      }
      $('#fp-table').classList.remove('hidden');
    }
    openModal('#modal-fp');
  } catch (e) {
    toast('加载指纹失败:' + e.message, 'error');
  }
}

/* ---------------- 端口转发管理(I1/I2) ---------------- */

let fwRules = [];

async function refreshForwards() {
  fwRules = await api('forwards:list');
  const states = await api('forward:states', { ids: fwRules.map((r) => r.id) }).catch(() => ({}));
  const tbody = $('#fw-tbody');
  tbody.innerHTML = '';
  if (!fwRules.length) $('#fw-table').classList.add('hidden');
  else $('#fw-table').classList.remove('hidden');
  for (const r of fwRules) {
    const running = states[r.id];
    const typeLabel = { L: '本地', R: '远程', D: 'SOCKS' }[r.type] || r.type;
    const bind = r.type === 'R' ? `${r.bindHost}:${r.bindPort}(远端)` : `${r.bindHost}:${r.bindPort}`;
    const dest = r.type === 'D' ? '—' : `${r.destHost}:${r.destPort}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.name)}${r.autoStart ? ' <span class="tag">自动</span>' : ''}</td>
      <td><span class="tag">${typeLabel}</span></td><td class="mono">${escapeHtml(bind)}</td>
      <td class="mono">${escapeHtml(dest)}</td>
      <td>${running ? '<span class="badge-run">● 活跃</span>' : '<span class="badge-stop">■ 停止</span>'}</td>
      <td>${running ? '<button class="btn small fw-stop">停止</button>' : '<button class="btn small fw-start">启动</button>'} <button class="btn small fw-del">删除</button></td>`;
    const btn = running ? tr.querySelector('.fw-stop') : tr.querySelector('.fw-start');
    btn.addEventListener('click', async () => {
      try {
        if (running) { await api('forward:stop', { id: r.id }); toast('已停止', 'success'); }
        else { const res = await api('forward:start', r); toast(`已启动,监听 ${res.port}`, 'success'); }
        refreshForwards();
      } catch (e) { toast('转发失败:' + e.message, 'error'); }
    });
    tr.querySelector('.fw-del').addEventListener('click', async () => {
      if (!(await askConfirm(`删除规则「${r.name}」?`, { title: '删除转发规则', okText: '删除' }))) return;
      await api('forward:stop', { id: r.id }).catch(() => {});
      await api('forwards:delete', { id: r.id });
      refreshForwards();
    });
    tbody.appendChild(tr);
  }
  // 主机选择器
  const sel = $('#fw-host');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const h of state.hosts) {
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `${h.name}(${h.username}@${h.host})`;
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

async function openForwardModal() {
  await refreshForwards();
  openModal('#modal-forward');
}

async function saveForwardRule() {
  const bind = $('#fw-bind').value.trim().split(':');
  const bindHost = bind[0] || '127.0.0.1';
  const bindPort = Number(bind[1]) || 0;
  const type = $('#fw-type').value;
  const dest = $('#fw-dest').value.trim().split(':');
  const rule = {
    name: $('#fw-name').value.trim() || `转发${Date.now() % 1000}`,
    type,
    hostId: $('#fw-host').value,
    bindHost, bindPort,
    destHost: type === 'D' ? '' : (dest[0] || ''),
    destPort: type === 'D' ? 0 : (Number(dest[1]) || 0),
    autoStart: $('#fw-auto').checked,
  };
  try {
    await api('forwards:save', rule);
    toast('规则已保存', 'success');
    $('#fw-name').value = '';
    await refreshForwards();
  } catch (e) {
    toast('保存失败:' + e.message, 'error');
  }
}

/* ---------------- 命令历史(F2) ---------------- */

async function toggleHistory() {
  state.historyOpen = !state.historyOpen;
  let panel = $('#history-panel');
  if (!state.historyOpen) { if (panel) panel.classList.add('hidden'); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'history-panel';
    panel.innerHTML = `<div class="row" style="padding:0 4px 6px;"><input id="hist-search" class="inp" style="flex:1;" placeholder="过滤历史…"/><button id="hist-clear" class="btn sm">清空</button></div><div id="hist-list"></div>`;
    $('#term-stack').appendChild(panel);
    panel.querySelector('#hist-search').addEventListener('input', (e) => renderHistory(e.target.value));
    panel.querySelector('#hist-clear').addEventListener('click', async () => {
      if (!(await askConfirm('清空全部命令历史?', { title: '清空历史', okText: '清空' }))) return;
      await api('history:clear');
      renderHistory('');
    });
  }
  panel.classList.remove('hidden');
  renderHistory('');
}

async function renderHistory(kw) {
  const list = await api('history:list', { kw });
  const box = $('#hist-list');
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="file-empty">暂无历史</div>'; return; }
  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<span class="h-cmd"></span><span class="h-meta">${escapeHtml(h.host || '')}</span>`;
    row.querySelector('.h-cmd').textContent = h.cmd;
    row.addEventListener('click', () => {
      const s = state.sessions.get(state.activeId);
      if (!s || s.status !== 'connected') return toast('请先连接主机', 'error');
      api('ssh:write', { sessionId: s.sessionId, data: h.cmd }).catch(() => {});
      toggleHistory();
    });
    box.appendChild(row);
  }
}

/* ---------------- 只读(D9) / 清屏(D4) / 日志(J1) ---------------- */

function toggleReadonly() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  s.readOnly = !s.readOnly;
  updateStatusbar(s);
  toast(s.readOnly ? '已开启只读模式' : '已关闭只读模式', 'success');
}

function clearActiveTerm() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  try { s.term.clear(); s.term.write('\x1b[2J\x1b[H'); } catch { /* ignore */ }
}

async function toggleSessionLog() {
  const s = state.sessions.get(state.activeId);
  if (!s || s.status !== 'connected') return toast('请先连接主机', 'error');
  if (s.logActive) {
    const r = await api('log:stop', { sessionId: s.sessionId });
    s.logActive = false;
    toast('日志已保存到 ' + (r.file || ''), 'success');
  } else {
    const r = await api('log:start', { sessionId: s.sessionId, hostLabel: `${s.host.name || s.host.host}`, timestamps: true, recordInput: true });
    s.logActive = true;
    s.logFile = r.file;
    toast('日志记录中:' + r.file, 'success');
  }
  updateStatusbar(s);
}

function stopLogIfActive(sessionId) {
  const s = state.sessions.get(sessionId);
  if (s && s.logActive) { api('log:stop', { sessionId }).catch(() => {}); s.logActive = false; }
}

function loadSessionLogState(s) {
  api('log:status', { sessionId: s.sessionId }).then((r) => {
    s.logActive = !!r.active;
    updateStatusbar(s);
  }).catch(() => {});
}

/* ---------------- AI 模型切换(K6) + 诊断(K7) ---------------- */

function renderModelSwitch() {
  const sel = $('#ai-model-switch');
  const current = (state.settings && state.settings.ai && state.settings.ai.model) || '';
  const models = [...new Set([current, ...state.aiModels])].filter(Boolean);
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
    : '<option value="">未配置</option>';
  if (current) sel.value = current;
}

async function switchModel(model) {
  if (!model) return;
  state.settings = await api('settings:save', { ai: { model } });
  toast('模型已切换:' + model, 'success');
}

async function aiDiagnose() {
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

function spark(values) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (!values || !values.length) return '';
  return values.slice(-16).map((v) => blocks[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))]).join('');
}

function renderMonitorBar() {
  const bar = $('#monitor-bar');
  if (!state.monitorVisible || !state.activeId) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const m = state.metrics.get(state.activeId);
  const set = (id, txt) => { $(id).textContent = txt; };
  const w = (id, pct) => { $(id).style.width = (pct == null ? 0 : Math.min(100, pct)) + '%'; };
  let hist = state.metricHistory.get(state.activeId) || [];
  if (!m) {
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    set('#mon-note', ''); set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  if (m.supported === false) {
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    set('#mon-note', '该主机暂不支持资源监控(仅支持 Linux)');
    set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  hist = [...hist, m.cpuPct == null ? 0 : m.cpuPct].slice(-32);
  state.metricHistory.set(state.activeId, hist);
  set('#mon-cpu', m.cpuPct == null ? '…' : m.cpuPct + '%');
  set('#mon-mem', m.memPct == null ? '…' : `${m.memPct}%(${m.memUsedMB}/${m.memTotalMB}MB)`);
  set('#mon-disk', m.diskPct == null ? '–' : `${m.diskPct}%(${m.diskUsedGB}/${m.diskTotalGB}GB)`);
  set('#mon-rx', fmtBytes(m.rxBps));
  set('#mon-tx', fmtBytes(m.txBps));
  set('#mon-note', '');
  set('#mon-spark-cpu', spark(hist));
  w('#mon-cpu-bar', m.cpuPct);
  w('#mon-mem-bar', m.memPct);
}

/* ---------------- AI 设置弹窗 ---------------- */

function openAiSettings() {
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

function fillPreset(key) {
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

async function saveAiSettings() {
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
    toast('AI 设置已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/* ---------------- 事件绑定与启动 ---------------- */

/* ---------------- 右键菜单(替代 WebView 原生菜单) ----------------
   wry/WKWebView 的默认右键菜单是网页菜单(重新加载/检查元素等),对终端应用毫无用处,
   且会盖住界面。这里全局屏蔽,仅在终端区域给出终端常用操作。 */

function termFromEvent(e) {
  const paneEl = e.target && e.target.closest ? e.target.closest('.term-pane') : null;
  if (!paneEl) return null;
  const sid = paneEl.dataset.session;
  return sid ? state.sessions.get(sid) || null : null;
}

function closeCtxMenu() {
  const m = $('#ctx-menu');
  if (m) m.classList.add('hidden');
}

function showCtxMenu(x, y, items) {
  const menu = $('#ctx-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.key ? `<span class="ctx-key">${escapeHtml(it.key)}</span>` : ''}`;
    btn.disabled = !!it.disabled;
    btn.addEventListener('click', () => {
      closeCtxMenu();
      try { it.run(); } catch { /* ignore */ }
    });
    menu.appendChild(btn);
  }
  // 先显示以便量取尺寸,再按视口边缘回推,避免菜单溢出屏幕
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;
}

/// 终端右键菜单:复制/粘贴/全选 + 清屏/搜索/只读
function openTermCtxMenu(e, session) {
  const term = session.term;
  const hasSel = (() => { try { return term.hasSelection(); } catch { return false; } })();
  showCtxMenu(e.clientX, e.clientY, [
    { label: '复制', key: '⌘C', disabled: !hasSel, run: () => { try { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); } catch { /* ignore */ } } },
    { label: '粘贴', key: '⌘V', run: () => { navigator.clipboard.readText().then((t) => { if (t && !session.readOnly) term.paste(t); }).catch(() => {}); } },
    { label: '全选', key: '⌘A', run: () => { try { term.selectAll(); } catch { /* ignore */ } } },
    '-',
    { label: '搜索…', key: '⌘F', run: () => { activateSession(session.sessionId); openTermSearch(); } },
    { label: '清屏', run: () => { activateSession(session.sessionId); clearActiveTerm(); } },
    { label: session.readOnly ? '关闭只读' : '设为只读', run: () => { activateSession(session.sessionId); toggleReadonly(); } },
    '-',
    { label: '复制会话 ID', run: () => { navigator.clipboard.writeText(session.sessionId).catch(() => {}); toast('已复制会话 ID', 'success'); } },
  ]);
}

function bindContextMenu() {
  // 全局屏蔽原生菜单:oncontextmenu 返回 false 即阻止默认行为
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const session = termFromEvent(e);
    if (session) openTermCtxMenu(e, session);
    else closeCtxMenu();
    return false;
  });
  // 点击/滚动/失焦/缩放后收起
  window.addEventListener('mousedown', (e) => {
    const menu = $('#ctx-menu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) closeCtxMenu();
  }, true);
  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
  document.addEventListener('scroll', closeCtxMenu, true);
}

function bindEvents() {
  $('#btn-add-host').addEventListener('click', () => openHostModal(null));
  $('#btn-welcome-add').addEventListener('click', () => openHostModal(null));
  $('#btn-cloud-import').addEventListener('click', async () => {
    openModal('#modal-cloud');
    try {
      await refreshCloudAccounts();
    } catch (e) {
      toast('读取云账号失败：' + e.message, 'error');
    }
  });
  $('#btn-welcome-cloud').addEventListener('click', () => $('#btn-cloud-import').click());
  $('#btn-cloud-add-account').addEventListener('click', () => editCloudAccount(null));

  $('#host-search').addEventListener('input', renderHosts);
  $('#host-auth').addEventListener('change', toggleAuthRows);
  $('#btn-host-save').addEventListener('click', saveHostModal);
  $('#btn-host-cancel').addEventListener('click', () => closeModal('#modal-host'));
  $('#btn-pick-key').addEventListener('click', async () => {
    try {
      const r = await api('dialog:pickKey');
      if (r) {
        state.pickedKey = r;
        $('#key-path').textContent = r.path;
      }
    } catch (e) {
      toast('读取私钥失败：' + e.message, 'error');
    }
  });

  $('#btn-cloud-fetch').addEventListener('click', cloudFetchAll);
  $('#btn-cloud-import-selected').addEventListener('click', cloudImportSelected);
  $('#btn-cloud-close').addEventListener('click', () => closeModal('#modal-cloud'));

  $('#btn-ai-toggle').addEventListener('click', () => {
    $('#ai-panel').classList.toggle('hidden');
    fitActive();
  });
  $('#btn-ai-close').addEventListener('click', () => {
    $('#ai-panel').classList.add('hidden');
    fitActive();
  });
  $('#ai-settings-open').addEventListener('click', openAiSettings);
  $('#btn-ai-cancel').addEventListener('click', () => closeModal('#modal-ai'));
  $('#btn-ai-save').addEventListener('click', saveAiSettings);
  $('#btn-ai-test').addEventListener('click', aiTestConnection);
  $('#ai-provider').addEventListener('change', () => fillPreset($('#ai-provider').value));
  $('#btn-ai-fetch-models').addEventListener('click', fetchAiModels);
  $('#ai-model-switch').addEventListener('change', (e) => switchModel(e.target.value).then(renderModelSwitch).catch(() => {}));
  $('#btn-ai-diagnose').addEventListener('click', aiDiagnose);

  // ＋ 新建标签页:空标签,等待用户在窗格选择器里选主机
  $('#btn-newtab').addEventListener('click', () => {
    const tab = createTab();
    activateTab(tab.id);
    // 空标签给一个空窗格,渲染窗格选择器
    const paneId = newPaneId();
    tab.layout = leaf(paneId);
    tab.panes.set(paneId, { id: paneId, el: makePaneEl(paneId), sessionId: null });
    tab.el.querySelector('.tab-title').textContent = '新标签';
    renderLayout();
    updateWelcome();
  });

  // ⋯ 更多菜单
  const moreMenu = $('#more-menu');
  $('#btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.classList.toggle('hidden');
  });
  moreMenu.addEventListener('click', (e) => {
    if (e.target.closest('button')) moreMenu.classList.add('hidden'); // 选中即收起
  });
  document.addEventListener('mousedown', (e) => {
    if (!moreMenu.classList.contains('hidden') && !e.target.closest('#more-menu') && !e.target.closest('#btn-more')) {
      moreMenu.classList.add('hidden');
    }
  });

  // 分屏 / 广播 / 历史 / 转发 / 批量 / 指纹 / 快速连接
  $('#btn-split').addEventListener('click', () => splitActive('h'));
  $('#btn-broadcast').addEventListener('click', openBroadcastPicker);
  $('#btn-history').addEventListener('click', toggleHistory);
  $('#btn-forwards').addEventListener('click', openForwardModal);
  $('#btn-fw-save').addEventListener('click', saveForwardRule);
  $('#btn-fw-close').addEventListener('click', () => closeModal('#modal-forward'));
  $('#btn-batch').addEventListener('click', openBatchModal);
  $('#batch-search').addEventListener('input', (e) => renderBatchHosts(e.target.value));
  $('#btn-batch-run').addEventListener('click', runBatch);
  $('#btn-batch-close').addEventListener('click', () => closeModal('#modal-batch'));
  $('#btn-fingerprints').addEventListener('click', openFingerprints);
  $('#btn-fp-close').addEventListener('click', () => closeModal('#modal-fp'));
  $('#quick-connect').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const parsed = parseQuickTarget(e.target.value);
    if (!parsed) return toast('格式:user@host:port', 'error');
    e.target.value = '';
    quickConnect(parsed);
  });

  // 只读 / 清屏 / 会话日志
  $('#btn-readonly').addEventListener('click', toggleReadonly);
  $('#btn-clear').addEventListener('click', clearActiveTerm);
  $('#btn-log-toggle').addEventListener('click', toggleSessionLog);

  // 文件面板扩展:重命名 / 权限 / 书签 / 拖拽上传
  $('#btn-file-rename').addEventListener('click', () => {
    const en = state.file.entries.find((x) => x.name === state.file.selected);
    if (!en) return toast('请先选中文件或目录', 'error');
    state.file.renameMode = { from: en.name };
    $('#file-mkdir-row').classList.remove('hidden');
    $('#file-mkdir-name').value = en.name;
    $('#file-mkdir-name').focus();
  });
  $('#btn-file-chmod').addEventListener('click', () => {
    const en = state.file.entries.find((x) => x.name === state.file.selected);
    if (!en) return toast('请先选中文件或目录', 'error');
    state.file.chmodTarget = en;
    $('#file-chmod-row').classList.remove('hidden');
    $('#file-chmod-octal').value = en.dir ? '0755' : '0644';
  });
  $('#btn-file-chmod-ok').addEventListener('click', async () => {
    const s = filePanelSession();
    const en = state.file.chmodTarget;
    const mode = parseInt($('#file-chmod-octal').value, 8);
    if (!s || !en || Number.isNaN(mode)) return toast('权限格式错误(八进制,如 0644)', 'error');
    try {
      await api('sftp:chmod', { sessionId: s.sessionId, path: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name, mode });
      $('#file-chmod-row').classList.add('hidden');
      toast('权限已更新', 'success');
      loadFileDir(state.file.cwd);
    } catch (e) { toast('修改权限失败:' + e.message, 'error'); }
  });
  $('#btn-file-chmod-cancel').addEventListener('click', () => $('#file-chmod-row').classList.add('hidden'));
  $('#btn-file-bookmark').addEventListener('click', async () => {
    const s = filePanelSession();
    if (!s || !state.file.cwd) return toast('请先连接并打开目录', 'error');
    await api('bookmarks:add', { hostId: s.host.id, path: state.file.cwd });
    await renderFileBookmarks();
    toast('已收藏当前目录', 'success');
  });
  const filePanel = $('#file-panel');
  filePanel.addEventListener('dragover', (e) => { e.preventDefault(); $('#file-drop-hint').classList.remove('hidden'); });
  filePanel.addEventListener('dragleave', () => $('#file-drop-hint').classList.add('hidden'));
  filePanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    $('#file-drop-hint').classList.add('hidden');
    const files = [...(e.dataTransfer.files || [])].map((f) => f.path).filter(Boolean);
    if (!files.length) return;
    const s = filePanelSession();
    if (!s) return toast('请先连接主机', 'error');
    for (const p of files) {
      const name = p.split('/').pop();
      $('#file-status').textContent = `上传 ${name}…`;
      try { await api('sftp:upload', { sessionId: s.sessionId, localPath: p, remoteDir: state.file.cwd }); }
      catch (err) { toast('上传失败:' + err.message, 'error'); }
    }
    loadFileDir(state.file.cwd);
  });
  $('#btn-ai-explain').addEventListener('click', () => {
    const s = state.sessions.get(state.activeId);
    const sel = s && s.term.getSelection();
    if (!sel) return toast('请先在终端中选中要解释的内容', 'error');
    aiSend(sel, 'explain');
  });
  $('#btn-ai-gen').addEventListener('click', () => {
    state.genMode = !state.genMode;
    updateGenChip();
    $('#ai-input').focus();
  });
  $('#ai-send').addEventListener('click', () => aiSend());
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aiSend();
    }
  });

  $('#btn-reconnect').addEventListener('click', () => {
    const s = state.sessions.get(state.activeId);
    if (!s) return;
    closeSession(s.sessionId);
    connectHost(s.host.id);
  });
  $('#btn-disconnect').addEventListener('click', () => {
    const s = state.sessions.get(state.activeId);
    if (s) closeSession(s.sessionId);
  });

  // 主机导入/导出/克隆
  $('#btn-hosts-export').addEventListener('click', async () => {
    try {
      // 导出文件常被复制/同步/转发,明文密码落盘后很难收回,因此默认不含凭据。
      // 需连同凭据迁移时,在同一步里输入口令(留空 = 只导出主机信息)。
      const pass = await askPrompt(
        '输入口令以加密导出凭据;留空则只导出主机信息(不含密码/私钥),导入后需重新填写。',
        {
          title: '导出主机',
          okText: '导出',
          hint: '口令不会保存在任何地方,请自行记牢(至少 8 位)',
          validate: (v) => (v.length > 0 && v.length < 8 ? '口令至少 8 位(或留空以不含凭据导出)' : null),
        },
      );
      if (pass === null) return; // 取消 = 中止导出

      let passphrase = null;
      if (pass.length > 0) {
        const again = await askPrompt('请再次输入同一口令以确认。', {
          title: '确认口令', okText: '确定',
          validate: (v) => (v !== pass ? '两次输入的口令不一致' : null),
        });
        if (again === null) return;
        passphrase = pass;
      }

      const r = await api('hosts:exportFile', {
        includeCredentials: !!passphrase,
        passphrase: passphrase || undefined,
      });
      if (r) {
        toast(
          passphrase
            ? `已导出 ${r.count} 台主机（凭据已加密）到 ${r.path}`
            : `已导出 ${r.count} 台主机（不含凭据）到 ${r.path}`,
          'success',
        );
      }
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    }
  });
  $('#btn-hosts-import').addEventListener('click', async () => {
    try {
      // 首次不带口令:文件不含凭据时一次完成;含凭据则返回 needsPassphrase,
      // 此时弹出口令框并复用同一路径重试(不让用户重选文件)。
      let r = await api('hosts:importFile');
      if (r && r.needsPassphrase) {
        const pass = await askPrompt('该导出文件包含加密凭据,请输入导出时设置的口令。', {
          title: '输入解密口令', okText: '解密导入',
        });
        if (pass === null) return;
        r = await api('hosts:importFile', { passphrase: pass, path: r.path });
      }
      if (r) {
        const parts = [`新增 ${r.added} 台`, `跳过重复 ${r.skipped} 台`];
        if (r.withCredentials) parts.push(`恢复凭据 ${r.withCredentials} 台`);
        toast(`导入完成：${parts.join('，')}`, 'success');
        if (r.legacyPlaintext) {
          toast('该文件是旧版明文导出,已导入;建议删除该文件并改用加密导出', 'error');
        }
        refreshHosts();
      }
    } catch (e) {
      toast('导入失败：' + e.message, 'error');
    }
  });

  // 片段 / 监控 / 文件 / 终端设置
  $('#btn-snippets').addEventListener('click', () => {
    const menu = $('#snippet-menu');
    menu.classList.toggle('hidden');
    if (!menu.classList.contains('hidden')) renderSnippets();
  });
  $('#btn-snippet-add').addEventListener('click', addSnippet);
  $('#snippet-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSnippet(); });
  $('#btn-monitor').addEventListener('click', () => {
    state.monitorVisible = !state.monitorVisible;
    $('#btn-monitor').classList.toggle('active', state.monitorVisible);
    renderMonitorBar();
  });
  $('#btn-files').addEventListener('click', async () => {
    const panel = $('#file-panel');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); fitActive(); return; }
    panel.classList.remove('hidden');
    $('#file-list').innerHTML = '<div class="file-empty">加载中…</div>';
    renderFileTarget();
    fitActive();
    // 用"当前会话自己"记住的目录打开,而不是全局 cwd ——
    // 后者可能属于另一台服务器,拿它的路径去 list 会张冠李戴。
    const s = activeConnectedSession();
    await loadFileDir(s ? (s.lastFileDir || null) : null);
  });
  $('#btn-file-close').addEventListener('click', () => { $('#file-panel').classList.add('hidden'); fitActive(); });
  $('#btn-file-refresh').addEventListener('click', () => loadFileDir(state.file.cwd));
  $('#btn-file-mkdir').addEventListener('click', () => {
    $('#file-mkdir-row').classList.remove('hidden');
    $('#file-mkdir-name').focus();
  });
  $('#btn-file-mkdir-cancel').addEventListener('click', () => $('#file-mkdir-row').classList.add('hidden'));
  $('#btn-file-mkdir-ok').addEventListener('click', async () => {
    const s = filePanelSession();
    const name = $('#file-mkdir-name').value.trim();
    if (!s) return toast('请先连接主机', 'error');
    if (!name) return toast('请填写名称', 'error');
    try {
      if (state.file.renameMode) {
        await api('sftp:rename', { sessionId: s.sessionId, from: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + state.file.renameMode.from, to: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + name });
        state.file.renameMode = null;
        toast('已重命名', 'success');
      } else {
        await api('sftp:mkdir', { sessionId: s.sessionId, path: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + name });
        toast('目录已创建', 'success');
      }
      $('#file-mkdir-row').classList.add('hidden');
      $('#file-mkdir-name').value = '';
      loadFileDir(state.file.cwd);
    } catch (e) {
      toast('操作失败：' + e.message, 'error');
    }
  });
  $('#file-mkdir-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-file-mkdir-ok').click(); });
  $('#btn-file-upload').addEventListener('click', fileUpload);
  $('#btn-file-download').addEventListener('click', fileDownload);
  $('#btn-file-delete').addEventListener('click', fileDelete);
  $('#btn-term-settings').addEventListener('click', openTermSettings);
  $('#btn-term-cancel').addEventListener('click', () => closeModal('#modal-term'));
  $('#btn-term-save').addEventListener('click', saveTermSettings);

  // 终端搜索
  $('#term-search-next').addEventListener('click', () => doTermSearch(false));
  $('#term-search-prev').addEventListener('click', () => doTermSearch(true));
  $('#term-search-close').addEventListener('click', closeTermSearch);
  $('#term-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doTermSearch(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
  });

  // 全局快捷键：⌘F 搜索、⌘T 新标签、⌘W 关标签、⌘D 分屏、⌘1..9 切标签
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key === 'f') { e.preventDefault(); openTermSearch(); return; }
    if (mod && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      // 优先关"当前窗格";窗格只剩一个时关整个标签
      const s = state.sessions.get(state.activeId);
      const tab = activeTab();
      const paneCount = tab ? [...state.sessions.values()].filter((x) => x.tabId === tab.id).length : 0;
      if (s && paneCount > 1) closeSession(s.sessionId);
      else if (tab) closeTab(tab.id);
      return;
    }
    if (mod && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      const tab = createTab();
      activateTab(tab.id);
      const paneId = newPaneId();
      tab.layout = leaf(paneId);
      tab.panes.set(paneId, { id: paneId, el: makePaneEl(paneId), sessionId: null });
      renderLayout();
      updateWelcome();
      return;
    }
    if (mod && e.key === 'd') { e.preventDefault(); splitActive(e.shiftKey ? 'v' : 'h'); return; }
    if (mod && e.shiftKey && e.key === 'Enter') { e.preventDefault(); const pid = state.zoomPaneId || (state.sessions.get(state.activeId) || {}).paneId; if (pid) togglePaneZoom(pid); return; }
    // ⌘1..9 切标签(标签是会话的容器,切标签比切会话更符合直觉)
    if (mod && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const ids = [...state.tabs.keys()];
      const target = ids[Number(e.key) - 1];
      if (target) activateTab(target);
      return;
    }
    if (e.key === 'Escape' && !$('#term-search').classList.contains('hidden')) { closeTermSearch(); return; }
    if (e.key === 'Escape' && !$('#snippet-menu').classList.contains('hidden')) closeSnippetMenu();
    if (e.key === 'Escape' && state.historyOpen) toggleHistory();
    if (e.key === 'Escape' && !$('#more-menu').classList.contains('hidden')) $('#more-menu').classList.add('hidden');
  });

  document.querySelectorAll('.modal').forEach((m) => {
    if (m.id === 'modal-confirm') return; // 必须经按钮/keyboard resolve
    m.addEventListener('mousedown', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 确认对话框有专属按键处理(必须经 resolve 关闭,否则 Promise 悬挂)
    document.querySelectorAll('.modal:not(.hidden)').forEach((m) => {
      if (m.id === 'modal-confirm') return;
      m.classList.add('hidden');
    });
  });

  const ro = new ResizeObserver(() => { fitAllVisible(); scheduleResizeSync(); });
  ro.observe($('#term-stack'));

  // 主进程事件
  window.nebula.on('ssh:data', ({ sessionId, data }) => {
    const s = state.sessions.get(sessionId);
    if (!s) return;
    // term.write 是异步的:数据先入队、稍后解析绘制。首个数据块用回调在
    // "已解析并绘制"之后做一次尺寸重算,修正 open() 期间过早缓存的行几何。
    s.term.write(data);
    if (s.pendingFirstPaint) {
      s.pendingFirstPaint = false;
      firstPaint(s);
    }
  });
  window.nebula.on('ssh:status', ({ sessionId, state: st, error, label }) => {
    const s = state.sessions.get(sessionId);
    if (!s) return;
    if (st === 'connected') s.reconnectAttempt = 0;
    s.status = st === 'connected' ? 'connected' : st === 'error' ? 'error' : st;
    if (label) s.label = label;
    updateTab(s);
    if (state.activeId === sessionId) updateStatusbar(s, error);
    if (st === 'connected') {
      // 面板开着但还没有可用目标(例如刚切换过去时会话还在 connecting),
      // 等它连上后再补一次,否则面板会一直停在"未连接"。
      if (!$('#file-panel').classList.contains('hidden') && !filePanelSession()) {
        followFilePanel();
      }
    } else {
      state.metrics.delete(sessionId);
      if (state.activeId === sessionId) renderMonitorBar();
      // 断开的是"面板正在展示的那台"才需要重新加载(否则会拿错会话的路径)
      if (state.file.sessionId === sessionId) {
        state.file.sessionId = null;
        state.file.cwd = null;
        state.file.entries = [];
        if (!$('#file-panel').classList.contains('hidden')) followFilePanel();
      }
    }
  });
  window.nebula.on('ssh:metrics', (m) => {
    state.metrics.set(m.sessionId, m);
    if (m.sessionId === state.activeId) renderMonitorBar();
  });
  window.nebula.on('sftp:progress', ({ op, name, pct }) => {
    $('#file-status').textContent = `${op === 'upload' ? '上传' : '下载'} ${name} ${pct}%`;
  });
  window.nebula.on('ai:delta', ({ requestId, text }) => {
    const h = state.aiReq;
    if (!h || h.id !== requestId) return;
    h.acc += text;
    if (h.bubble) {
      h.bubble.textContent = h.acc;
      $('#ai-messages').scrollTop = $('#ai-messages').scrollHeight;
    }
  });
  window.nebula.on('ai:done', ({ requestId }) => {
    const h = state.aiReq;
    if (h && h.id === requestId) aiFinishHolder();
  });
  window.nebula.on('ai:error', ({ requestId, message }) => {
    const h = state.aiReq;
    if (h && h.id === requestId) {
      if (h.bubble) h.bubble.textContent = (h.acc ? h.acc + '\n' : '') + '⚠️ ' + message;
      h.acc = h.acc || '';
      aiFinishHolder();
    }
  });
}

async function boot() {
  bindEvents();
  bindContextMenu();
  try {
    const info = await api('app:info');
    $('#app-version').textContent = `v${info.version} · ${info.platform === 'darwin' ? 'macOS' : info.platform}`;
  } catch { /* ignore */ }
  state.settings = await api('settings:get');
  await refreshHosts();
  try { state.aiModels = await api('ai:models', { protocol: state.settings.ai.protocol, baseUrl: state.settings.ai.baseUrl }).catch(() => []); } catch { /* ignore */ }
  renderModelSwitch();
  renderAiMessage('assistant', '你好，我是 NebulaShell 内置 AI 助手 ✨\n可以直接提问，或使用上方快捷操作：\n· 解释选中内容：选中终端输出后点击\n· 生成命令：描述需求，AI 给出命令');
}

boot();

// 端到端测试钩子(仅 Tauri 测试桥环境注入):模拟键盘输入走完整广播/历史链路
if (window.__NB_E2E__ || window.nebula && window.nebula.testMode) {
  window.__nbTest = {
    confirmOpen: () => !$('#modal-confirm').classList.contains('hidden'),
    confirmClickOk: () => $('#btn-confirm-ok').click(),
    confirmClickCancel: () => $('#btn-confirm-cancel').click(),
    confirmText: () => $('#confirm-message').textContent,
    // 口令输入框(导出/导入用)
    promptOpen: () => !$('#modal-prompt').classList.contains('hidden'),
    promptTitle: () => $('#prompt-title').textContent,
    promptFill: (v) => { $('#prompt-input').value = v; },
    promptClickOk: () => $('#btn-prompt-ok').click(),
    promptClickCancel: () => $('#btn-prompt-cancel').click(),
    write: (d) => {
      const s = state.sessions.get(state.activeId);
      if (s && s.status === 'connected' && !s.readOnly) s.term.input(d);
    },
    paneCount: () => state.panes.size,
    // 标签/窗格状态:供 e2e 断言"同主机可多开标签且互不干扰"
    tabState: () => ({
      tabs: state.tabs.size,
      activeTab: state.activeTabId,
      panes: state.panes.size,
      // 每个会话的窗格是否仍挂载在 DOM 上(用于回归"新会话顶掉旧会话终端")
      sessions: [...state.sessions.values()].map((s) => ({
        id: s.sessionId,
        host: s.host.id,
        tabId: s.tabId,
        mounted: !!(s.pane && s.pane.isConnected),
        hasText: (() => { try { return s.term.buffer.active.length > 0; } catch { return false; } })(),
      })),
    }),
    broadcastCount: () => (state.broadcast ? state.broadcast.size : 0),
    // 文件面板状态:供 e2e 断言"面板标识的目标 = 当前会话",以及切换后是否跟随
    filePanel: () => {
      const s = state.file.sessionId ? state.sessions.get(state.file.sessionId) : null;
      const active = state.sessions.get(state.activeId);
      return {
        open: !$('#file-panel').classList.contains('hidden'),
        target: $('#file-target').textContent,
        targetName: s ? s.host.name : null,
        activeName: active ? active.host.name : null,
        // 用 id 比对(同一台主机可能有多个会话,按名字比不足以判别)
        targetId: s ? s.sessionId : null,
        activeId: active ? active.sessionId : null,
        cwd: state.file.cwd,
        rows: document.querySelectorAll('#file-list .file-row').length,
      };
    },
    // 终端缓冲状态:供 e2e 断言(回滚上限是否生效、内容是否送达)
    termBuffer: () => {
      const s = state.sessions.get(state.activeId);
      if (!s) return null;
      const b = s.term.buffer.active;
      return {
        scrollback: Number(s.term.options.scrollback),
        length: b.length,
        baseY: b.baseY,
      };
    },
  };
}
