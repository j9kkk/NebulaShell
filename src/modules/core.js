// 共享底座:DOM 查询、IPC 封装、全局状态、通用弹窗/toast、标签与窗格访问器

export const $ = (s) => document.querySelector(s);

export async function api(channel, payload) {
  const r = await window.nebula.invoke(channel, payload);
  if (!r || r.ok !== true) throw new Error((r && r.error) || channel + ' 调用失败');
  return r.data;
}

// 指纹变更:后端在连接错误里附加可机读标记 [NB-FP host:port|旧指纹|新指纹]。
// 错误通道是纯字符串(见 commands.rs err_msg;跳板链还会套"跳板 X 失败:"前缀),
// 故按标记检索。放在 core 是因为不只连接流程要看它 —— 批量执行的错误列也会
// 原样展示后端错误串,不清理就会把标记漏给用户。
export const FP_MARK = /\[NB-FP ([^|\]]+)\|([^|\]]+)\|([^|\]]+)\]/;

/// 解析指纹变更标记;非指纹错误返回 null(调用方按普通错误处理)。
export function parseFpError(msg) {
  const m = FP_MARK.exec(String(msg || ''));
  if (!m) return null;
  return { key: m[1], stored: m[2], current: m[3], clean: String(msg).replace(FP_MARK, '').trim() };
}

/// 展示用:剥掉可机读标记,只留人话(无标记时原样返回)。
export function stripFpMark(msg) {
  return String(msg || '').replace(FP_MARK, '').trim();
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
  metrics: new Map(), // sessionId -> 最近一次 ssh:metrics
  metricHistory: new Map(), // sessionId -> [cpuPct...] 迷你趋势
  // 文件面板:显示的是"哪个会话"的目录必须显式记录 —— 面板是全局单例,
  // 若只靠 activeId,切标签后会出现"显示 A 的目录、操作落到 B"的误删风险。
  // hist/histIdx 是浏览器式导航历史(后退/前进),histSid 标记历史属于哪个
  // 会话 —— 换目标会话时历史必须作废,否则会后退到另一台机器的路径上。
  file: { sessionId: null, cwd: null, entries: [], selected: null, chmodTarget: null, renameMode: null, hist: [], histIdx: -1, histSid: null, lastOpen: null },
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
  aiModels: [],        // 已拉取的模型候选(含 name/ownedBy/created)
  aiSelected: [],      // 已勾选启用、可用于对话的模型(只读自 settings.ai.models)
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

/* ---------------- 平台与快捷键提示 ----------------
   界面上的快捷键提示必须按运行平台显示:macOS 用 ⌘/⇧/⌥,Windows 与 Linux
   用 Ctrl/Shift/Alt。此前标题里写死 ⌘,在 Windows/Linux 上与实际可用按键
   (Ctrl)不符 —— 功能本身没问题(见 entry.js 的 mod = metaKey||ctrlKey),
   错的是"提示"。
   平台取自 preload/shim 注入的 window.nebula.platform(userAgent 推导),
   取不到时退回 UA 嗅探,保证在浏览器里调试也不显示错。 */
export const PLATFORM = (() => {
  const p = (typeof window !== 'undefined' && window.nebula && window.nebula.platform) || '';
  if (p) return p;
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Mac|iPhone|iPad/i.test(ua)) return 'darwin';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
})();

export const IS_MAC = PLATFORM === 'darwin';

const MAC_KEY = { mod: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', enter: '↵', tab: '⇥', space: 'Space', esc: 'Esc' };
const PC_KEY = { mod: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', tab: 'Tab', space: 'Space', esc: 'Esc' };

/// 把规范化的快捷键写法('mod+shift+D')渲染成当前平台的显示形式。
/// macOS 惯例是不加连接符(⌘⇧D),Windows/Linux 用 +(Ctrl+Shift+D)。
export function accel(spec) {
  const parts = String(spec || '').split('+').map((s) => s.trim()).filter(Boolean);
  const out = parts.map((p) => {
    const k = p.toLowerCase();
    const named = (IS_MAC ? MAC_KEY : PC_KEY)[k];
    if (named) return named;
    return p.length === 1 ? p.toUpperCase() : p;
  });
  return IS_MAC ? out.join('') : out.join('+');
}

/// 按平台重写带快捷键的元素标题。
/// 约定:data-title 是文案模板(%1/%2 是占位符),data-accel 用 | 分隔多个快捷键
/// (顺序与占位符一一对应)。用属性而不是在 JS 里写死,是为了让"文案和快捷键"
/// 就留在标记旁边 —— 加一个按钮时不必再来改这里。
export function applyAccelTitles(root = document) {
  for (const el of root.querySelectorAll('[data-accel]')) {
    const specs = String(el.dataset.accel).split('|').map((s) => accel(s.trim()));
    let title = el.dataset.title || '';
    specs.forEach((k, i) => { title = title.split('%' + (i + 1)).join(k); });
    el.title = title;
  }
}


/* ---------------- 通用 UI ---------------- */

export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/// 复制文本到剪贴板:优先 async Clipboard API,被拒时退回 execCommand('copy')。
/// WebView2 下 writeText 会因 webview 失焦/激活态丢失抛 NotAllowedError ——
/// 此前各调用点 .catch(() => {}) 把失败静默吞掉,剪贴板残留旧内容,
/// 用户视角就是"复制无效/复制出来的不是选中的内容"。execCommand 虽已废弃,
/// 却是 WebView2 里不依赖 document.focus() 的唯一兜底通道。返回是否成功,
/// 失败必须由调用方可见(toast),不再静默。
export async function copyText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch { /* 失焦/权限拒绝:走 execCommand 兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
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
//
// defaultFocus:'ok' 时焦点与 Enter 落在确认键(默认);涉及安全决策(如指纹变更后
// 重新信任)必须传 'cancel' —— 弹窗一弹出就高亮"信任"会让用户顺手回车放行,
// 而这正是中间人攻击最希望发生的动作。
export function askConfirm(message, { title = '确认操作', okText = '确定', cancelText = '取消', danger = true, defaultFocus = 'ok' } = {}) {
  return new Promise((resolve) => {
    const modal = $('#modal-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#btn-confirm-ok');
    const cancelBtn = $('#btn-confirm-cancel');
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
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
    // 默认落在"取消"时,Enter 也必须走取消 —— 否则键盘用户仍会误放行。
    const enterIsCancel = defaultFocus === 'cancel';
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); enterIsCancel ? done(false) : done(true); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    (enterIsCancel ? cancelBtn : okBtn).focus();
  });
}

export function openModal(id) { $(id).classList.remove('hidden'); }
export function closeModal(id) { $(id).classList.add('hidden'); }

/// 让浮动面板可拖动(片段/历史这类常驻面板会遮住左侧操作区,须能挪开)。
/// handle 是拖拽把手(通常标题栏)。定位统一用相对 offsetParent 的 left/top ——
/// 元素原先若用 right/bottom 定位(如贴右侧的状态栏浮层),必须清掉那一侧:
/// left 与 right 同时存在时二者互相牵制,拖不到目标位置。
export function makeDraggable(el, handle) {
  if (!el || !handle || el._draggable) return;
  el._draggable = true;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea')) return; // 把手上的控件照常可用
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startLeft = el.offsetLeft;
    const startTop = el.offsetTop;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const move = (ev) => {
      const host = el.offsetParent;
      const hostW = host ? host.clientWidth : window.innerWidth;
      const hostH = host ? host.clientHeight : window.innerHeight;
      // 限制在容器内:拖出可视区就再也点不到了
      const left = Math.min(Math.max(0, hostW - rect.width), Math.max(0, startLeft + (ev.clientX - startClientX)));
      const top = Math.min(Math.max(0, hostH - rect.height), Math.max(0, startTop + (ev.clientY - startClientY)));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
    };
    document.body.classList.add('dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/* ---------------- 右键菜单(通用浮层) ----------------
   放在 core 而不是 entry:文件面板也要用它(下载/重命名/删除挪进右键菜单),
   而 entry 已经依赖 sftp —— 若把菜单留在 entry,文件面板就得反向依赖它,
   绕成一个环。 */

export function closeCtxMenu() {
  const m = $('#ctx-menu');
  if (m) m.classList.add('hidden');
}

/// 在 (x, y) 弹出右键菜单。items 元素形如
/// { label, key?, disabled?, danger?, run() } 或字符串 '-' 表示分隔线。
export function showCtxMenu(x, y, items) {
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
    btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
    btn.innerHTML = `<span class="ctx-label"></span>${it.key ? '<span class="ctx-key"></span>' : ''}`;
    btn.querySelector('.ctx-label').textContent = it.label;
    if (it.key) btn.querySelector('.ctx-key').textContent = it.key;
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

/// 全局右键菜单的收起逻辑:点击别处/滚动/失焦/缩放都收起。
/// 只绑定一次(entry 启动时调用)。
export function bindCtxMenuDismiss() {
  if (bindCtxMenuDismiss._bound) return;
  bindCtxMenuDismiss._bound = true;
  window.addEventListener('mousedown', (e) => {
    const menu = $('#ctx-menu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) closeCtxMenu();
  }, true);
  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
  document.addEventListener('scroll', closeCtxMenu, true);
}

/* ---------------- 主机列表 ---------------- */

