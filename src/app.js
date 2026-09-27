// NebulaShell 渲染层应用逻辑
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { AI_PRESETS, AI_SYSTEM_PROMPT } from './shared/ai-presets.js';
import { TENCENT_REGIONS, ALIYUN_REGIONS } from './shared/regions.js';

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
  cloudProvider: 'tencent',
  cloudResults: [],
  aiHistory: [],
  aiReq: null,
  genMode: false,
  monitorVisible: true,
  metrics: new Map(), // sessionId -> 最近一次 ssh:metrics
  metricHistory: new Map(), // sessionId -> [cpuPct...] 迷你趋势
  file: { cwd: null, entries: [], selected: null, chmodTarget: null, renameMode: null },
  layout: null,        // 分屏树(E3): {type:'leaf',paneId,sessionId} | {type:'h'|'v',ratio,a,b}
  zoomPaneId: null,    // 放大的窗格(占满终端区)
  panes: new Map(),    // paneId -> { id, el, sessionId }
  paneSeq: 0,
  broadcast: null,     // E5: Set(sessionId) 广播参与者
  historyOpen: false,
  aiModels: [],        // 已拉取的模型候选(K6)
};

const PROVIDER_LABEL = { tencent: '腾讯云', lighthouse: '腾讯云轻量', aliyun: '阿里云' };
const REGION_LIST = { tencent: TENCENT_REGIONS, lighthouse: TENCENT_REGIONS, aliyun: ALIYUN_REGIONS };

// 云导入密钥获取帮助：不同厂商的入口、控制台地址与最小权限建议
const CLOUD_KEY_HELP = {
  tencent: `
    <b>腾讯云 SecretId / SecretKey</b> 获取方式：登录腾讯云控制台 → <span class="help-link" data-url="https://console.cloud.tencent.com/cam/capi">访问管理 CAM · API 密钥管理</span> → 「新建密钥」。
    建议使用子用户密钥并仅授予只读策略 <b>QcloudCVMReadOnlyAccess</b>，避免直接使用主账号密钥。`,
  lighthouse: `
    <b>腾讯云轻量与 CVM 共用同一套 API 密钥</b>：在 <span class="help-link" data-url="https://console.cloud.tencent.com/cam/capi">访问管理 CAM · API 密钥管理</span> 创建 SecretId / SecretKey。
    轻量服务器建议授予只读策略 <b>QcloudLighthouseReadOnlyAccess</b>；若同时需要 CVM 与轻量，可同时勾选两个只读策略。`,
  aliyun: `
    <b>阿里云 AccessKeyId / AccessKeySecret</b> 获取方式：登录阿里云控制台 → <span class="help-link" data-url="https://ram.console.aliyun.com/manage/ak">RAM 访问控制 · AccessKey 管理</span> → 「创建 AccessKey」。
    注意 <b>AccessKeySecret 仅在创建时显示一次</b>，请立即保存；建议创建 RAM 子用户并仅授予只读权限 <b>AliyunECSReadOnlyAccess</b>。`,
};
const CLOUD_KEY_HELP_FOOT = '密钥仅加密保存在本机，不会上传到任何第三方服务器。';

/* ---------------- 通用 UI ---------------- */

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
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
      item.addEventListener('click', () => connectHost(h.id));
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

function leafSessions(node, out = []) {
  if (isLeaf(node)) { out.push(node.sessionId); return out; }
  leafSessions(node.a, out); leafSessions(node.b, out);
  return out;
}

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

function firstEmptyLeaf(node) {
  if (isLeaf(node)) return node.sessionId ? null : node.paneId;
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
  // reparent 后强制 xterm 重绘并恢复焦点,避免光标/选区残留
  const focused = state.sessions.get(state.activeId);
  setTimeout(() => {
    for (const s of state.sessions.values()) {
      try { s.term.refresh(0, s.term.rows - 1); } catch { /* ignore */ }
    }
    fitAllVisible();
    if (focused && state.sessions.has(focused.sessionId)) {
      try { focused.term.focus(); } catch { /* ignore */ }
    }
  }, 30);
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
        connectHost(h.id, paneId, true);
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

function removeFromLayout(paneId) {
  if (!state.layout) return;
  const path = findLeafPath(state.layout, paneId);
  if (!path) return;
  replaceAt(path, () => null);
  // 折叠:null 与兄弟合并
  const collapse = (node) => {
    if (node === null || isLeaf(node)) return node;
    const a = collapse(node.a); const b = collapse(node.b);
    if (a === null) return b;
    if (b === null) return a;
    node.a = a; node.b = b;
    return node;
  };
  state.layout = collapse(state.layout);
}

function fitAllVisible() {
  for (const s of state.sessions.values()) {
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
    for (const s of state.sessions.values()) {
      if (s.status !== 'connected') continue;
      api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  }, 150);
}

function createSession(host, paneId) {
  const sessionId = crypto.randomUUID();
  // 确定挂载窗格:指定 paneId(选择器) > 活动空窗格 > 与活动会话分屏 > 首个窗格
  let targetPaneId = paneId || (state.layout && firstEmptyLeaf(state.layout));
  if (!targetPaneId) {
    if (!state.layout) {
      targetPaneId = newPaneId();
      state.layout = leaf(targetPaneId);
      state.panes.set(targetPaneId, { id: targetPaneId, el: makePaneEl(targetPaneId), sessionId: null });
    } else {
      const anchor = activeLeafPaneId();
      const path = findLeafPath(state.layout, anchor) || [];
      targetPaneId = newPaneId();
      replaceAt(path, (leafNode) => ({ type: 'h', ratio: 0.5, a: leafNode, b: leaf(targetPaneId) }));
      state.panes.set(targetPaneId, { id: targetPaneId, el: makePaneEl(targetPaneId), sessionId: null });
    }
  }
  state.panes.get(targetPaneId).sessionId = sessionId;
  renderLayout(); // 先挂载窗格 DOM,再初始化终端

  const pane = state.panes.get(targetPaneId).el;
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

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = sessionId;
  tab.innerHTML = `<span class="tab-dot connecting"></span><span class="tab-title">${escapeHtml(host.name)}</span><button class="tab-close" title="关闭">✕</button>`;
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    activateSession(sessionId);
  });
  tab.querySelector('.tab-close').addEventListener('click', () => closeSession(sessionId));
  $('#tabs').appendChild(tab);

  const session = { sessionId, host, term, fit, search, paneId: targetPaneId, pane, tab, status: 'connecting', readOnly: false, histBuf: '', reconnectAttempt: 0 };
  state.sessions.set(sessionId, session);
  activateSession(sessionId);
  updateWelcome();
  return session;
}

function activateSession(sessionId) {
  state.activeId = sessionId;
  state.activePaneId = null;
  for (const [id, s] of state.sessions) {
    s.tab.classList.toggle('active', id === sessionId);
    const pane = state.panes.get(s.paneId);
    if (pane) pane.el.classList.toggle('focused', id === sessionId);
  }
  const s = state.sessions.get(sessionId);
  if (s) {
    try { s.fit.fit(); } catch { /* ignore */ }
    s.term.focus();
    s.tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    updateStatusbar(s);
    loadSessionLogState(s);
  }
  closeSnippetMenu();
  renderMonitorBar();
}

function closeSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  api('ssh:disconnect', { sessionId }).catch(() => {});
  stopLogIfActive(sessionId);
  s.term.dispose();
  s.tab.remove();
  const pane = state.panes.get(s.paneId);
  if (pane) {
    pane.sessionId = null;
    pane.el.innerHTML = '';
    pane.el.dataset.session = '';
    removeFromLayout(s.paneId);
    state.panes.delete(s.paneId);
  }
  state.broadcast && state.broadcast.delete(sessionId);
  if (!state.broadcast || !state.broadcast.size) setBroadcast(null);
  if (state.zoomPaneId === s.paneId) state.zoomPaneId = null;
  state.metrics.delete(sessionId);
  state.sessions.delete(sessionId);
  if (state.layout) rebalanceRatios(state.layout);
  if (state.activeId === sessionId) {
    state.activeId = null;
    const next = [...state.sessions.keys()][0];
    if (next) activateSession(next);
    else updateStatusbar(null);
  }
  renderLayout();
  updateWelcome();
}

function updateTab(session) {
  const dot = session.tab.querySelector('.tab-dot');
  dot.className = 'tab-dot ' + session.status;
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

async function connectHost(hostId, paneId, force = false) {
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host) return;
  // 已有活动会话则直接切过去(分屏强制新建时跳过)
  if (!force) {
    for (const s of state.sessions.values()) {
      if (s.host.id === hostId && (s.status === 'connected' || s.status === 'connecting')) {
        activateSession(s.sessionId);
        return;
      }
    }
  }
  const session = createSession(host, paneId);
  try {
    await api('ssh:connect', { hostId, sessionId: session.sessionId });
    if (host.initcmd) api('ssh:write', { sessionId: session.sessionId, data: host.initcmd + '\r' }).catch(() => {});
  } catch (e) {
    session.status = 'error';
    updateTab(session);
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
  const session = createSession(host, paneId);
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

/* ---------------- 云主机导入 ---------------- */

function setCloudProvider(p) {
  state.cloudProvider = p;
  document.querySelectorAll('.cloud-tab').forEach((t) => t.classList.toggle('active', t.dataset.provider === p));
  $('#cloud-key-help').innerHTML = (CLOUD_KEY_HELP[p] || '') + '<br />' + CLOUD_KEY_HELP_FOOT;
  const isAli = p === 'aliyun';
  $('#cloud-key-label').textContent = isAli ? 'AccessKeyId' : 'SecretId';
  $('#cloud-secret-label').textContent = isAli ? 'AccessKeySecret' : 'SecretKey';
  $('#cloud-key').placeholder = isAli ? 'AccessKeyId（LTAI…）' : 'SecretId（AKID…）';
  $('#cloud-secret').placeholder = isAli ? 'AccessKeySecret' : 'SecretKey';
  const regionSel = $('#cloud-region');
  regionSel.innerHTML = '';
  for (const [v, label] of REGION_LIST[p]) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = `${label}（${v}）`;
    regionSel.appendChild(opt);
  }
  // 预填已保存的密钥
  const credsKey = p === 'aliyun' ? 'aliyun' : 'tencent';
  const saved = state.settings && state.settings.clouds && state.settings.clouds[credsKey];
  $('#cloud-key').value = (saved && saved.key) || '';
  $('#cloud-secret').value = '';
  $('#cloud-secret').placeholder = (saved && saved.secretSet) ? '已保存（留空保持不变）' : $('#cloud-secret').placeholder;
  $('#cloud-endpoint').value = (saved && saved.endpoint) || '';
  $('#cloud-table').classList.add('hidden');
  $('#cloud-tbody').innerHTML = '';
  $('#cloud-count').textContent = '';
  $('#btn-cloud-import-selected').classList.add('hidden');
  $('#cloud-status').textContent = '填写密钥后点击获取';
}

function providerLabel(p) { return PROVIDER_LABEL[p] || p; }

function renderCloudRows() {
  const tbody = $('#cloud-tbody');
  tbody.innerHTML = '';
  for (let i = 0; i < state.cloudResults.length; i++) {
    const it = state.cloudResults[i];
    const running = /running/i.test(it.state);
    const tr = document.createElement('tr');
    tr.className = 'cloud-row';
    tr.innerHTML = `
      <td><input type="checkbox" class="cloud-check" data-i="${i}" ${running ? 'checked' : ''} /></td>
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.host || '（无公网 IP）')}</td>
      <td><span class="badge ${running ? 'running' : /stop/i.test(it.state) ? 'stopped' : 'other'}">${escapeHtml(it.state || '-')}</span></td>
      <td class="muted">${escapeHtml(it.cloud.os || '-')}</td>
      <td><button class="btn small cloud-connect" data-i="${i}">连接</button></td>`;
    tbody.appendChild(tr);
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

async function cloudFetch() {
  const key = $('#cloud-key').value.trim();
  const secret = $('#cloud-secret').value;
  const region = $('#cloud-region').value;
  const endpoint = $('#cloud-endpoint').value.trim();
  if (!key || !secret) return toast('请填写 API 密钥', 'error');
  $('#cloud-status').textContent = '获取中…';
  try {
    const instances = await api('cloud:fetch', { provider: state.cloudProvider, region, key, secret, endpoint });
    state.cloudResults = instances.filter((i) => i.host);
    if (!state.cloudResults.length) {
      $('#cloud-status').textContent = '没有获取到可用实例（无 IP 的实例已过滤）';
      return;
    }
    $('#cloud-status').textContent = `获取到 ${state.cloudResults.length} 台实例`;
    renderCloudRows();
  } catch (e) {
    $('#cloud-status').textContent = '获取失败';
    toast('获取失败：' + e.message, 'error');
  }
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

async function loadFileDir(dir) {
  const s = activeConnectedSession();
  if (!s) { $('#file-list').innerHTML = '<div class="file-empty">请先连接主机</div>'; return; }
  $('#file-status').textContent = '加载中…';
  try {
    const r = await api('sftp:list', { sessionId: s.sessionId, path: dir });
    state.file.cwd = r.path;
    state.file.entries = r.entries;
    state.file.selected = null;
    renderFileList();
    $('#file-status').textContent = '';
  } catch (e) {
    $('#file-status').textContent = '加载失败：' + e.message;
  }
}

async function fileUpload() {
  const s = activeConnectedSession();
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
  const s = activeConnectedSession();
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
  const s = activeConnectedSession();
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
  // 字号变化会改变字符网格,需重算几何并同步远端 PTY
  for (const s of state.sessions.values()) {
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

function bindEvents() {
  $('#btn-add-host').addEventListener('click', () => openHostModal(null));
  $('#btn-welcome-add').addEventListener('click', () => openHostModal(null));
  $('#btn-cloud-import').addEventListener('click', async () => {
    state.settings = await api('settings:get');
    setCloudProvider('tencent');
    openModal('#modal-cloud');
  });
  $('#btn-welcome-cloud').addEventListener('click', () => $('#btn-cloud-import').click());

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

  document.querySelectorAll('.cloud-tab').forEach((t) => {
    t.addEventListener('click', () => setCloudProvider(t.dataset.provider));
  });
  $('#cloud-key-help').addEventListener('click', (e) => {
    const link = e.target.closest('.help-link');
    if (!link) return;
    api('app:openExternal', { url: link.dataset.url }).catch((err) => toast('无法打开链接：' + err.message, 'error'));
  });
  $('#btn-cloud-fetch').addEventListener('click', cloudFetch);
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
    const s = activeConnectedSession();
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
    const s = activeConnectedSession();
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
    const s = activeConnectedSession();
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
      const r = await api('hosts:exportFile');
      if (r) toast(`已导出 ${r.count} 台主机到 ${r.path}（含凭据，请妥善保管）`, 'success');
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    }
  });
  $('#btn-hosts-import').addEventListener('click', async () => {
    try {
      const r = await api('hosts:importFile');
      if (r) {
        toast(`导入完成：新增 ${r.added} 台，跳过重复 ${r.skipped} 台`, 'success');
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
    fitActive();
    await loadFileDir(null);
  });
  $('#btn-file-close').addEventListener('click', () => { $('#file-panel').classList.add('hidden'); fitActive(); });
  $('#btn-file-refresh').addEventListener('click', () => loadFileDir(state.file.cwd));
  $('#btn-file-mkdir').addEventListener('click', () => {
    $('#file-mkdir-row').classList.remove('hidden');
    $('#file-mkdir-name').focus();
  });
  $('#btn-file-mkdir-cancel').addEventListener('click', () => $('#file-mkdir-row').classList.add('hidden'));
  $('#btn-file-mkdir-ok').addEventListener('click', async () => {
    const s = activeConnectedSession();
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

  // 全局快捷键：Cmd/Ctrl+F 搜索、Cmd/Ctrl+W 关闭标签、Cmd/Ctrl+1..9 切换标签
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key === 'f') { e.preventDefault(); openTermSearch(); return; }
    if (mod && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      const s = state.sessions.get(state.activeId);
      if (s) closeSession(s.sessionId);
      return;
    }
    if (mod && e.key === 'd') { e.preventDefault(); splitActive(e.shiftKey ? 'v' : 'h'); return; }
    if (mod && e.shiftKey && e.key === 'Enter') { e.preventDefault(); const pid = state.zoomPaneId || (state.sessions.get(state.activeId) || {}).paneId; if (pid) togglePaneZoom(pid); return; }
    if (mod && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      const ids = [...state.sessions.keys()];
      const target = ids[Number(e.key) - 1];
      if (target) activateSession(target);
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
    if (s) s.term.write(data);
  });
  window.nebula.on('ssh:status', ({ sessionId, state: st, error, label }) => {
    const s = state.sessions.get(sessionId);
    if (!s) return;
    if (st === 'connected') s.reconnectAttempt = 0;
    s.status = st === 'connected' ? 'connected' : st === 'error' ? 'error' : st;
    if (label) s.label = label;
    updateTab(s);
    if (state.activeId === sessionId) updateStatusbar(s, error);
    if (st !== 'connected') {
      state.metrics.delete(sessionId);
      if (state.activeId === sessionId) renderMonitorBar();
      if (!$('#file-panel').classList.contains('hidden')) loadFileDir(state.file.cwd).catch(() => {});
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
    write: (d) => {
      const s = state.sessions.get(state.activeId);
      if (s && s.status === 'connected' && !s.readOnly) s.term.input(d);
    },
    paneCount: () => state.panes.size,
    broadcastCount: () => (state.broadcast ? state.broadcast.size : 0),
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
