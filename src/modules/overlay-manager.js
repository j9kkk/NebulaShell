/// 全局弹层协调器（单一真源）：统一管理全站所有非模态浮层、模态内子浮层与窄屏抽屉。
///
/// 职责：
/// 1) 声明式互斥组（group）：打开同组任一浮层自动关闭其余兄弟，消除各模块散落手写关闭链；
/// 2) 父子级联（parentId）：子浮层（如模式帮助卡）打开时不关闭父层，关闭父层自动级联关闭子层；
/// 3) 单一 Esc 栈：始终只关闭栈顶项；模态框打开时由 core.js 先问 modal-sub 子浮层，Esc 绝不穿透关外层弹窗；
/// 4) 单一 pointerdown 点外关闭：使用 composedPath() 防重绘摘除节点误判，自动豁免自身、触发器及子层；
/// 5) 单一 resize 响应：未声明 onResize 的浮层自动收起，声明了 onResize 的自动重新定位；
/// 6) 监听 `nebula:close-menus`（macOS 原生菜单触发），自动收起所有浮层与窄屏抽屉。

const stack = []; // 按打开先后递增，末尾为栈顶
const closingIds = new Set();
let bound = false;

function resolveElements(listOrFn) {
  const raw = typeof listOrFn === 'function' ? listOrFn() : listOrFn;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of arr) {
    if (!item) continue;
    if (typeof item === 'string') {
      const el = typeof document !== 'undefined' ? document.querySelector(item) : null;
      if (el) out.push(el);
    } else {
      out.push(item);
    }
  }
  return out;
}

function isDescendantEntry(childId, ancestorId) {
  let cur = stack.find((e) => e.id === childId);
  let guard = 0;
  while (cur && cur.parentId && guard++ < 16) {
    if (cur.parentId === ancestorId) return true;
    cur = stack.find((e) => e.id === cur.parentId);
  }
  return false;
}

function eventInsideElement(event, el) {
  if (!el) return false;
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : null;
  if (Array.isArray(path) && path.length) {
    if (path.includes(el)) return true;
    if (el.id && path.some((node) => node && node.id === el.id)) return true;
  }
  const target = event?.target;
  if (!target) return false;
  if (target === el) return true;
  if (typeof el.contains === 'function' && el.contains(target)) return true;
  if (el.id && typeof target.closest === 'function' && target.closest(`#${el.id}`)) return true;
  return false;
}

function eventInsideEntryTree(event, entry) {
  const roots = [
    ...resolveElements(entry.el),
    ...resolveElements(entry.triggers),
    ...resolveElements(entry.allowOutside),
  ];
  if (roots.some((el) => eventInsideElement(event, el))) return true;
  // 点击落在子浮层（或子浮层的触发器）里时，不得关闭父浮层
  for (const other of stack) {
    if (other.id !== entry.id && isDescendantEntry(other.id, entry.id)) {
      if (eventInsideEntryTree(event, other)) return true;
    }
  }
  return false;
}

function removeEntry(id) {
  const idx = stack.findIndex((e) => e.id === id);
  if (idx >= 0) return stack.splice(idx, 1)[0];
  return null;
}

export function isOverlayOpen(id) {
  return stack.some((e) => e.id === id);
}

export function topOverlay({ kinds = null } = {}) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i];
    if (!kinds || kinds.includes(e.kind)) return e;
  }
  return null;
}

export function listOverlays() {
  return stack.map((e) => e.id);
}

/// 关闭指定浮层（幂等、防重入，并级联关闭所有挂载在它之下的子浮层）。
export function closeOverlay(id, opts = {}) {
  if (!id || closingIds.has(id)) return false;
  // 先关闭依赖本层的子浮层（从栈顶向下）
  const children = stack.filter((e) => e.parentId === id).map((e) => e.id).reverse();
  for (const cid of children) closeOverlay(cid, { ...opts, focusTrigger: false });

  const entry = removeEntry(id);
  if (!entry) return false;
  closingIds.add(id);
  try {
    entry.close?.(opts);
  } finally {
    closingIds.delete(id);
  }
  return true;
}

/// 注册/激活浮层：若指定了 group，先关闭同组中与自己无祖先关系的兄弟浮层。
export function openOverlay(entry) {
  if (!entry || !entry.id) return null;
  const normalized = {
    kind: 'popover',
    group: null,
    parentId: null,
    closeOnOutside: true,
    closeOnEsc: true,
    closeOnResize: true,
    ...entry,
  };
  if (normalized.group) {
    const peers = stack
      .filter((e) => e.id !== normalized.id && e.group === normalized.group)
      .filter((e) => !isDescendantEntry(normalized.id, e.id) && e.id !== normalized.parentId)
      .map((e) => e.id)
      .reverse();
    for (const pid of peers) closeOverlay(pid, { reason: 'mutual-exclusion', focusTrigger: false });
  }
  removeEntry(normalized.id);
  stack.push(normalized);
  return normalized;
}

export function closeOverlayGroup(group, { exceptId = null, exceptIds = null, reason = 'group' } = {}) {
  const skip = new Set(exceptIds || []);
  if (exceptId) skip.add(exceptId);
  const targets = stack
    .filter((e) => e.group === group && !skip.has(e.id))
    .map((e) => e.id)
    .reverse();
  for (const id of targets) closeOverlay(id, { reason, focusTrigger: false });
}

export function closeAllOverlays({ kinds = null, exceptIds = null, reason = 'all' } = {}) {
  const skip = new Set(exceptIds || []);
  const targets = stack
    .filter((e) => (!kinds || kinds.includes(e.kind)) && !skip.has(e.id))
    .map((e) => e.id)
    .reverse();
  for (const id of targets) closeOverlay(id, { reason, focusTrigger: false });
}

/// 统一 Esc 分层处理：
/// - modalOpen=true 时仅关闭位于弹窗内部/之上的子浮层（kind='modal-sub' | 'menu'），消费事件不关外层弹窗；
/// - modalOpen=false 时关闭栈顶允许 Esc 关闭的浮层。
export function handleOverlayEscape(event, { modalOpen = false } = {}) {
  if (!event || event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return false;
  const eligibleKinds = modalOpen ? ['modal-sub', 'menu'] : null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry.closeOnEsc === false) continue;
    if (eligibleKinds && !eligibleKinds.includes(entry.kind)) continue;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    closeOverlay(entry.id, { reason: 'escape', focusTrigger: true });
    return true;
  }
  return false;
}

export function bindOverlayManager() {
  if (bound || typeof document === 'undefined') return;
  bound = true;

  document.addEventListener('pointerdown', (event) => {
    if (!stack.length) return;
    // 快照从栈顶向下判定，避免关闭过程中索引漂移
    const snapshot = [...stack].reverse();
    for (const entry of snapshot) {
      if (!isOverlayOpen(entry.id)) continue;
      if (entry.closeOnOutside === false) continue;
      if (eventInsideEntryTree(event, entry)) continue;
      closeOverlay(entry.id, { reason: 'outside', focusTrigger: false });
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    const modalOpen = !!document.body?.classList?.contains('modal-open');
    if (modalOpen) return; // 模态态由 core.js 捕获层按「先 modal-sub、再 modalEscape、后关闭弹窗」顺序调用
    handleOverlayEscape(event, { modalOpen: false });
  }, true);

  document.addEventListener('nebula:close-menus', () => {
    closeAllOverlays({ kinds: ['popover', 'drawer-overlay'], reason: 'close-menus' });
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      const snapshot = [...stack].reverse();
      for (const entry of snapshot) {
        if (!isOverlayOpen(entry.id)) continue;
        if (typeof entry.onResize === 'function') entry.onResize();
        else if (entry.closeOnResize !== false) closeOverlay(entry.id, { reason: 'resize', focusTrigger: false });
      }
    });
  }
}

export function resetOverlayManager() {
  stack.length = 0;
  closingIds.clear();
  bound = false;
}
