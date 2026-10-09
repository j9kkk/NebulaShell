// 共享底座:DOM 查询、IPC 封装、全局状态、通用弹窗/toast、标签与窗格访问器

import { isAppModifier as matchAppModifier } from './interaction.js';
import { icon } from '../shared/icons.js';

export const $ = (s) => document.querySelector(s);

export async function api(channel, payload) {
  if (channel === 'ssh:write') {
    const session = state.sessions.get(payload?.sessionId);
    if (session?.readOnly) throw new Error('会话处于只读模式');
  }
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
  // 标签页(E1)与窗格(E3):每个标签页持有独立的布局树与窗格集合,
  // 切换标签只渲染该标签的窗格;其余标签的终端对象保留在内存中(不销毁),
  // 切回时重新挂载并 refresh。state.layout/panes/zoomPaneId/activePaneId
  // 是"当前标签"的访问器(见下方 defineProperties),便于既有分屏代码原样复用。
  tabs: new Map(),     // tabId -> { id, el, layout, panes: Map, zoomPaneId, activePaneId, sessionId }
  activeTabId: null,
  // Runtime-only outer tab layout. Each tab keeps its independent inner tree.
  workspace: { mode: 'single', layout: null, fits: true },
  tabSeq: 0,
  paneSeq: 0,
  broadcast: null,     // E5: Set(sessionId) 广播参与者
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
export const isAppModifier = (event) => matchAppModifier(event, PLATFORM);

const MAC_KEY = { mod: '⌘', cmd: '⌘', meta: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', enter: '↵', tab: '⇥', space: 'Space', esc: 'Esc' };
const PC_KEY = { mod: 'Ctrl', cmd: 'Win', meta: 'Win', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', enter: 'Enter', tab: 'Tab', space: 'Space', esc: 'Esc' };

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
/// (顺序与占位符一一对应)。data-accel 的取值优先写 keymap 动作名(如
/// 'term.copy',自定义键位生效),也兼容裸 spec(如 'mod+T');动作名解析
/// 由 keymap.accelSpec 提供,这里延迟取用避免 core↔keymap 循环依赖。
/// 用属性而不是在 JS 里写死,是为了让"文案和快捷键"就留在标记旁边 ——
/// 加一个按钮时不必再来改这里。
export function applyAccelTitles(root = document) {
  // 惰性 import 不可用(同步函数),用模块注册:entry.js boot 时注入。
  const resolve = applyAccelTitles._accelSpec || ((s) => accel(s));
  for (const el of root.querySelectorAll('[data-accel]')) {
    const specs = String(el.dataset.accel).split('|').map((s) => resolve(s.trim()));
    let title = el.dataset.title || '';
    specs.forEach((k, i) => { title = title.split('%' + (i + 1)).join(k); });
    el.title = title;
  }
}


/* ---------------- 通用 UI ---------------- */

/// 通知图标按类型区分;长消息(如具体失败原因)自动换行完整展示。
const TOAST_ICONS = { success: 'checkCircle', error: 'xCircle', warn: 'alert', info: 'info' };

export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.innerHTML = icon(TOAST_ICONS[type] || 'info');
  const body = document.createElement('span');
  body.className = 'toast-body';
  body.textContent = msg;
  el.appendChild(iconEl); el.appendChild(body);
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
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

const dialogQueues = new Map();
const modalReturns = new WeakMap();
const modalOwners = new WeakMap();
const modalDismiss = new WeakMap();
const activeModals = new Set();
let modalOrder = 0;
let scopedModal = null;

function queueDialog(id, run) {
  const next = (dialogQueues.get(id) || Promise.resolve()).then(run);
  dialogQueues.set(id, next.catch(() => {}));
  return next;
}

export function topModal() {
  return [...document.querySelectorAll('.modal:not(.hidden), dialog[open]')]
    .sort((a, b) => (Number(a.dataset.modalOrder) || 0) - (Number(b.dataset.modalOrder) || 0)).at(-1) || null;
}

export function hasOpenModal() { return !!topModal(); }

function syncModalScope() {
  const top = topModal();
  const app = $('#app');
  if (app) app.inert = !!top;
  for (const modal of document.querySelectorAll('.modal, dialog')) {
    modal.inert = modal !== top;
    if (!modal.classList.contains('hidden')) modal.style.zIndex = String(200 + Number(modal.dataset.modalOrder || 0));
  }
  if (document.body.classList.contains('modal-open') !== !!top) document.body.classList.toggle('modal-open', !!top);
  if (scopedModal !== top) {
    scopedModal = top;
    document.dispatchEvent(new Event('nebula:modal-scope'));
  }
}

export function setModalDismissHandler(id, handler) {
  const modal = typeof id === 'string' ? $(id) : id;
  if (modal) modalDismiss.set(modal, handler);
}

export function openModal(id) {
  const modal = typeof id === 'string' ? $(id) : id;
  if (!modal) return;
  closeCtxMenu();
  document.dispatchEvent(new Event('nebula:close-menus'));
  if (!activeModals.has(modal)) {
    modalReturns.set(modal, document.activeElement);
    modalOwners.set(modal, [state.activeTabId, state.activeId, state.activePaneId]);
  }
  activeModals.add(modal);
  modal.dataset.modalOrder = String(++modalOrder);
  modal.classList.remove('hidden');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1;
  const heading = modal.querySelector('h3');
  if (heading) {
    if (!heading.id) heading.id = modal.id + '-title';
    modal.setAttribute('aria-labelledby', heading.id);
  }
  syncModalScope();
  const control = [...modal.querySelectorAll('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')]
    .find((element) => element.getClientRects().length && !element.closest('.hidden'));
  (control || modal).focus();
}

export function closeModal(id) {
  const modal = typeof id === 'string' ? $(id) : id;
  if (!modal || modal._closing || (modal.classList.contains('hidden') && !activeModals.has(modal))) return;
  modal._closing = true;
  try { modalDismiss.get(modal)?.(); } finally { modal._closing = false; }
  activeModals.delete(modal);
  modal.classList.add('hidden');
  if (modal.tagName === 'DIALOG' && modal.open) modal.close();
  modal.style.zIndex = '';
  syncModalScope();
  const target = modalReturns.get(modal);
  const top = topModal();
  const owner = modalOwners.get(modal);
  const sameOwner = !owner || owner.every((value, index) => value === [state.activeTabId, state.activeId, state.activePaneId][index]);
  // An awaited picker/operation may finish after the user selected a different
  // tile. Restoring its old terminal would activate that tile and steal focus.
  if (target?.isConnected && (!top || top.contains(target)) && (top || sameOwner)) target.focus();
  else if (top) top.focus();
}

export function bindModalInteractions() {
  if (bindModalInteractions._bound) return;
  bindModalInteractions._bound = true;
  for (const label of document.querySelectorAll('.form-grid label')) {
    if (label.htmlFor) continue;
    const next = label.nextElementSibling;
    const input = next?.matches('input, select, textarea') ? next : next?.querySelector('input:not([type="hidden"]), select, textarea');
    if (input?.id) label.htmlFor = input.id;
  }
  document.addEventListener('mousedown', (event) => {
    const top = topModal();
    if (top && event.target === top) closeModal(top);
  });
  document.addEventListener('keydown', (event) => {
    const top = topModal();
    if (!top) return;
    const context = $('#ctx-menu');
    if (context && !context.classList.contains('hidden') && context.contains(event.target)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeModal(top);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...top.querySelectorAll('button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      .filter((el) => el.getClientRects().length && !el.closest('.hidden'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) { event.preventDefault(); top.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }, true);
  document.addEventListener('focusin', (event) => {
    const top = topModal();
    if (top && !top.contains(event.target) && !event.target.closest?.('#ctx-menu')) top.focus();
  });
  new MutationObserver((records) => {
    const relevant = records.some((record) => record.type === 'attributes'
      ? record.target.matches?.('.modal, dialog')
      : [...record.addedNodes, ...record.removedNodes].some((node) => node.matches?.('.modal, dialog') || node.querySelector?.('.modal, dialog')));
    if (!relevant) return;
    for (const modal of [...activeModals]) {
      if (!modal.isConnected || modal.classList.contains('hidden') || (modal.tagName === 'DIALOG' && !modal.open)) closeModal(modal);
    }
    for (const modal of document.querySelectorAll('.modal:not(.hidden), dialog[open]')) {
      if (!activeModals.has(modal)) openModal(modal);
    }
    syncModalScope();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open'] });
}

/// 应用内输入对话框:返回 Promise<string|null>(null = 取消)。
/// 与 askConfirm 同因 —— wry/WKWebView 未实现原生 prompt,直接调用拿不到输入。
export function askPrompt(message, opts = {}) {
  return queueDialog('prompt', () => runPrompt(message, opts));
}

function runPrompt(message, opts) {
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

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      modalDismiss.delete(modal);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      closeModal(modal);
      input.value = '';
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
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    setModalDismissHandler(modal, onCancel);
    openModal(modal);
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
export function askConfirm(message, opts = {}) {
  return queueDialog('confirm', () => runConfirm(message, opts));
}

function runConfirm(message, { title = '确认操作', okText = '确定', cancelText = '取消', danger = true, defaultFocus = danger ? 'cancel' : 'ok' } = {}) {
  return new Promise((resolve) => {
    const modal = $('#modal-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#btn-confirm-ok');
    const cancelBtn = $('#btn-confirm-cancel');
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    okBtn.className = 'btn ' + (danger ? 'danger' : 'primary');
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      modalDismiss.delete(modal);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('keydown', onKey);
      closeModal(modal);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === okBtn) onOk();
      else onCancel();
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('keydown', onKey);
    setModalDismissHandler(modal, onCancel);
    openModal(modal);
    (defaultFocus === 'cancel' ? cancelBtn : okBtn).focus();
  });
}

/* ---------------- 右键菜单(通用浮层) ----------------
   放在 core 而不是 entry:文件面板也要用它(下载/重命名/删除挪进右键菜单),
   而 entry 已经依赖 sftp —— 若把菜单留在 entry,文件面板就得反向依赖它,
   绕成一个环。 */

/// 菜单项是否不可用:菜单里用 aria-disabled(保持可聚焦),也兼容原生 disabled。
export const isMenuItemDisabled = (item) => !!item && (item.disabled || item.getAttribute('aria-disabled') === 'true');

/// 菜单底部的禁用原因:焦点或鼠标停在禁用项上时显示。原因取自
/// aria-description(命令注册表与右键菜单都写在这里),读屏已从菜单项本身
/// 读到,所以这一行对读屏隐藏。右键菜单每次重建内容,这里按需重新创建。
export function showMenuReason(menu, item) {
  const text = isMenuItemDisabled(item) ? item.getAttribute('aria-description') || '' : '';
  let footer = menu.querySelector('.menu-reason');
  if (!footer) {
    if (!text) return;
    footer = document.createElement('div');
    footer.className = 'menu-reason hidden';
    footer.setAttribute('aria-hidden', 'true');
    menu.appendChild(footer);
  }
  footer.textContent = text;
  footer.classList.toggle('hidden', !text);
}

/// 菜单键盘:由 document 捕获阶段接管,而不是挂在菜单元素上 —— 焦点掉到
/// body 时(点了组标题等),挂在菜单上的监听就收不到按键,Esc 和方向键全失效。
/// 只在菜单可见、且焦点在菜单内或无处可落(body)时生效。
export function bindMenuKeyboard(menu, close, back = null) {
  menu.setAttribute('role', 'menu');
  document.addEventListener('keydown', (event) => {
    if (menu.classList.contains('hidden') || !menu.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && !menu.contains(active)) return;
    const items = [...menu.querySelectorAll('button:not(:disabled)')].filter((el) => el.getClientRects().length && !el.closest('.hidden'));
    const index = items.indexOf(active);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    if (event.key === 'ArrowUp') next = items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length];
    if (event.key === 'Home') next = items[0];
    if (event.key === 'End') next = items.at(-1);
    if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'ArrowLeft' && back) { event.preventDefault(); event.stopPropagation(); back(); }
  }, true);
  // 点组标题、分隔线、空白处不挪焦点(否则焦点掉到 body)
  menu.addEventListener('mousedown', (event) => { if (!event.target.closest?.('button')) event.preventDefault(); });
  menu.addEventListener('focusin', (event) => showMenuReason(menu, event.target.closest?.('button')));
  menu.addEventListener('mouseover', (event) => {
    const item = event.target.closest?.('button');
    if (item) showMenuReason(menu, item);
  });
  menu.addEventListener('mouseleave', () => showMenuReason(menu, menu.contains(document.activeElement) ? document.activeElement : null));
}

export function closeCtxMenu(restore = true) {
  const m = $('#ctx-menu');
  if (!m || m.classList.contains('hidden')) return;
  const focused = m.contains(document.activeElement);
  m.classList.add('hidden');
  const trigger = m._trigger;
  m._trigger = null;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    m._closedTrigger = trigger;
    m._closedAt = performance.now();
  }
  if (restore && focused && m._returnFocus?.isConnected) m._returnFocus.focus();
}

/// 在 (x, y) 弹出右键菜单。items 元素形如
/// { label, key?, disabled?, reason?, danger?, checked?, command?, run() } 或字符串 '-' 表示分隔线。
/// reason 是禁用原因,显示在菜单底部;command 写进 data-command,供可达性测试读取;
/// checked 非 undefined 时是开关项,显示 ✓。
/// opts.trigger:由按钮打开的下拉菜单(分屏下拉、主机管理),同步 aria-expanded;
/// opts.returnFocus:关闭后焦点的去处(缺省为打开前的焦点)。
export function showCtxMenu(x, y, items, opts = {}) {
  const menu = $('#ctx-menu');
  if (!menu) return;
  const modal = topModal();
  if (modal && !modal.contains(document.activeElement)) return;
  document.dispatchEvent(new Event('nebula:close-menus'));
  closeCtxMenu(false);
  menu._returnFocus = opts.returnFocus || opts.trigger || document.activeElement;
  menu._trigger = opts.trigger || null;
  menu.setAttribute('aria-label', opts.label || '上下文菜单');
  if (opts.trigger) opts.trigger.setAttribute('aria-expanded', 'true');
  menu.style.zIndex = modal ? String(Number(modal.style.zIndex) + 1) : '100';
  if (!menu._keyboardBound) { bindMenuKeyboard(menu, closeCtxMenu); menu._keyboardBound = true; }
  menu.innerHTML = '';
  const hasChecks = items.some((it) => it && it !== '-' && it.checked !== undefined);
  // 分隔线只出现在两组之间:开头、连续、结尾的都省掉(右键菜单按状态取舍分组)
  let pendingSep = false;
  let rows = 0;
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { pendingSep = rows > 0; continue; }
    if (pendingSep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      pendingSep = false;
    }
    rows++;
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
    const part = (className, text) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      btn.appendChild(span);
      return span;
    };
    if (hasChecks) part('ctx-check', it.checked ? '✓' : '').setAttribute('aria-hidden', 'true');
    part('ctx-label', it.label);
    if (it.key) part('ctx-key', it.key);
    if (it.command) btn.dataset.command = it.command;
    // 可选 tips:与普通按钮 title 同语义(悬停展示说明)
    if (it.title) btn.title = it.title;
    if (it.disabled) {
      btn.setAttribute('aria-disabled', 'true');
      if (it.reason) btn.setAttribute('aria-description', it.reason);
    }
    btn.setAttribute('role', it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
    if (it.checked !== undefined) btn.setAttribute('aria-checked', String(!!it.checked));
    btn.addEventListener('click', () => {
      if (it.disabled) return;
      closeCtxMenu();
      Promise.resolve().then(() => it.run()).catch((error) => toast(error.message || '操作失败', 'error'));
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
  menu.querySelector('button:not([aria-disabled="true"])')?.focus();
}

/// 按钮触发的下拉菜单:点击 / Enter / Space / ↓ 打开,挂在按钮下方(右边缘对齐
/// 时向左回推);再点一次关闭。items 每次打开时重新求值,状态总是最新的。
/// 焦点归还与 ⋯ 一致:用鼠标打开时还给打开前的位置(通常是终端,接着打字
/// 不丢),用键盘打开时还给按钮。
export function bindMenuButton(button, items, opts = {}) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  let opener = null;
  button.addEventListener('mousedown', () => { opener = document.activeElement; });
  const returnTarget = () => {
    const prior = opener;
    opener = null;
    if (prior === null) return button;
    if (prior && prior !== button && prior !== document.body && prior.isConnected) return prior;
    return document.querySelector('.term-pane.focused .xterm-helper-textarea') || button;
  };
  const open = () => {
    const back = returnTarget();
    const menu = $('#ctx-menu');
    // 刚被同一个按钮的 mousedown 关掉:这次点击是"收起",不再打开
    if (menu?._closedTrigger === button && performance.now() - (menu._closedAt || 0) < 300) return;
    if (menu && !menu.classList.contains('hidden') && menu._trigger === button) { closeCtxMenu(); return; }
    const r = button.getBoundingClientRect();
    showCtxMenu(opts.alignRight ? r.right : r.left, r.bottom + 4, items(), { trigger: button, label: opts.label, returnFocus: back });
    if (opts.alignRight && menu) {
      const width = menu.getBoundingClientRect().width;
      menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
    }
  };
  button.addEventListener('click', open);
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    open();
  });
}

/// 全局右键菜单的收起逻辑:点击别处/滚动/失焦/缩放都收起。
/// 只绑定一次(entry 启动时调用)。
export function bindCtxMenuDismiss() {
  if (bindCtxMenuDismiss._bound) return;
  bindCtxMenuDismiss._bound = true;
  window.addEventListener('mousedown', (e) => {
    const menu = $('#ctx-menu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) closeCtxMenu(false);
  }, true);
  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
  document.addEventListener('scroll', (event) => { if (!event.target.closest?.('#ctx-menu')) closeCtxMenu(); }, true);
}

/* ---------------- 主机列表 ---------------- */

