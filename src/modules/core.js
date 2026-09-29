// 共享底座:DOM 查询、IPC 封装、全局状态、通用弹窗/toast、标签与窗格访问器

export const $ = (s) => document.querySelector(s);

export async function api(channel, payload) {
  const r = await window.nebula.invoke(channel, payload);
  if (!r || r.ok !== true) throw new Error((r && r.error) || channel + ' 调用失败');
  return r.data;
}

export const state = {
  hosts: [],
  sessions: new Map(), // sessionId -> { sessionId, host, term, fit, pane, tab, status, search }
  activeId: null,
  settings: null,
  pickedKey: null, // { path, content }
  cloudAccounts: [],     // 云账号(多 API Key,见 cloud:accounts)
  cloudEditing: null,    // 正在编辑的云账号(null = 新增);见 #cloud-account-form
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
export function activeTab() {
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

export const PROVIDER_LABEL = { tencent: '腾讯云', lighthouse: '腾讯云轻量', aliyun: '阿里云' };


/* ---------------- 通用 UI ---------------- */

export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/// 应用内输入对话框:返回 Promise<string|null>(null = 取消)。
/// 与 askConfirm 同因 —— wry/WKWebView 未实现原生 prompt,直接调用拿不到输入。
export function askPrompt(message, opts = {}) {
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
export function askConfirm(message, { title = '确认操作', okText = '确定', danger = true } = {}) {
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

export function openModal(id) { $(id).classList.remove('hidden'); }
export function closeModal(id) { $(id).classList.add('hidden'); }

/* ---------------- 主机列表 ---------------- */

