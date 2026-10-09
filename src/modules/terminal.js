// 终端会话:连接、标签与窗格、分屏、搜索、广播输入、只读、日志
import { $, activeTab, api, askConfirm, askPrompt, closeCtxMenu, copyText, hasOpenModal, parseFpError, showCtxMenu, state, stripFpMark, toast } from './core.js';
import { icon } from '../shared/icons.js';
import { accelOf, appShortcutOf, matchAction } from './keymap.js';
import { bindCommandButton, commandMenuItem, refreshCommandStates } from './commands.js';
import { DIVIDER_SIZE, layoutMinSize, paneCapacity, paneMinSize, planGrid } from './terminal-layout.js';
import { renderSplitTree, replaceLayoutContent } from './split-layout-renderer.js';
import { planWorkspace, renderWorkspaceTree, syncWorkspaceChrome, tabMinimum, workspaceSignature } from './terminal-workspace.js';
import { escapeHtml } from './hosts.js';
import { closeSnippetMenu, renderMonitorBar } from './monitor.js';
import { buildFilePane, initFilePane, createFilePaneState, syncFilePanesForSession } from './sftp.js';
import { confirmTransferInterrupt } from './file-transfer.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

export const v = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || f;

export const TERM_THEMES = {
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

export function termTheme() {
  const key = (state.settings && state.settings.terminal && state.settings.terminal.theme) || 'nebula';
  return (TERM_THEMES[key] || TERM_THEMES.nebula)();
}

// —— 标签页(E1):每个标签持有独立的布局树与窗格集合 ——
export function newTabId() { return 'tab-' + (++state.tabSeq); }

export function makeTab(tabId) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.tab = tabId;
  el.innerHTML = `<span class="tab-dot connecting"></span><span class="tab-title">新标签</span><button class="tab-close" title="关闭标签">${icon('x')}</button>`;
  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    activateTab(tabId);
  });
  el.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });
  // 中键直接关闭(浏览器标签惯例);右键弹标签菜单。
  // 标签是多会话终端里除主机外最高频的操作对象,此前它没有任何右键动作,
  // 只有悬停才看得到的 ✕ —— 与终端/文件行已有右键菜单形成不对称。
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(tabId); }
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation(); // 别让窗口级处理器(终端菜单)再插一手
    openTabCtxMenu(e.clientX, e.clientY, tabId);
  });
  $('#tabs').appendChild(el);
  return el;
}

export function createTab() {
  const id = newTabId();
  const tab = {
    id,
    el: makeTab(id),
    layout: null,
    panes: new Map(),
    zoomPaneId: null,
    activePaneId: null,
    sessionId: null, // 该标签当前挂载的会话(标签与窗格一一对应,分屏时取主窗格)
    customTitle: null, // 手动重命名的标签名;null = 跟随主会话主机名
  };
  state.tabs.set(id, tab);
  if (state.workspace?.mode === 'tiled') scheduleWorkspaceLayout();
  return tab;
}

/// 新建一个空标签并给出窗格选择器。标签栏 ＋ / ⌘T / 标签右键菜单共用同一入口,
/// 此前这三处的逻辑在 entry.js 里抄了两遍。
export function newTabWithPicker() {
  const tab = createTab();
  activateTab(tab.id);
  const paneId = newPaneId();
  tab.layout = leaf(paneId);
  tab.panes.set(paneId, { id: paneId, el: makePaneEl(paneId), sessionId: null });
  renderLayout();
  updateWelcome();
  return tab;
}

/// 标签右键菜单:关闭类动作 + 重命名 + 复制地址 + 文件管理 + 新建。
/// "关闭其他/右侧"按标签位置给出禁用态(已是唯一/最右时无意义),而不是藏起来 ——
/// 菜单项位置固定,才不会每次弹出都变一串。
export function openTabCtxMenu(x, y, tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  const ids = [...state.tabs.keys()];
  const idx = ids.indexOf(tabId);
  const firstSession = [...state.sessions.values()].find((s) => s.tabId === tabId);
  showCtxMenu(x, y, [
    { label: '关闭标签', key: accelOf('workspace.close'), danger: true, run: () => closeTab(tabId) },
    { label: '关闭其他标签', disabled: ids.length <= 1, run: () => { for (const id of ids) if (id !== tabId) closeTab(id); } },
    { label: '关闭右侧标签', disabled: idx >= ids.length - 1, run: () => { for (const id of ids.slice(idx + 1)) closeTab(id); } },
    '-',
    commandMenuItem('tab.rename', { tabId }, { label: '重命名…' }),
    {
      label: '复制主机地址', disabled: !firstSession, run: () => {
        const h = firstSession.host;
        copyText(`${h.username}@${h.host}:${h.port}`).then((ok) => toast(ok ? '已复制主机地址' : '复制失败', ok ? 'success' : 'error'));
      },
    },
    // 文件管理是标签内的分屏之一:与「新增分屏」对称的入口,可连续开多个
    commandMenuItem('tab.file.add', { tabId }),
    '-',
    commandMenuItem('tab.new'),
  ], { label: '标签菜单' });
}

/// 重命名标签:走应用内输入框(原生 prompt 在 WKWebView 下不返回)。
/// 留空 = 清除自定义名,恢复"跟随主会话主机名"的默认行为。
export async function renameTab(tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  const name = await askPrompt('输入新的标签名;留空则恢复默认(跟随主机名)。', {
    title: '重命名标签',
    password: false,
    okText: '重命名',
    placeholder: tab.customTitle || '新标签',
  });
  if (name === null) return;
  tab.customTitle = name.trim();
  syncTabChrome();
}

/// 仅切换"活动标签"的标识与高亮,不触碰 DOM。
/// 用于新建会话时先把标签设为活动,避免随后的 activateTab 触发
/// innerHTML 清空 —— 那会把 term.open() 刚挂好的终端摘掉再挂回,造成首屏输出丢失。
export function setActiveTabId(tabId) {
  // Even a chrome-only away-and-back invalidates an outstanding target snapshot.
  if (state.activeTabId !== tabId) focusRevision++;
  state.activeTabId = tabId;
  for (const [id, t] of state.tabs) t.el.classList.toggle('active', id === tabId);
}

/// 切换标签:只挂载目标标签的窗格,其余标签的终端保留在内存中不销毁
let focusRevision = 0;

export function activateTab(tabId, focus = true) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  const changed = state.activeTabId !== tabId;
  setActiveTabId(tabId);
  // Tiled focus changes are chrome-only; never reparent an xterm on a click.
  if (changed && state.workspace?.mode !== 'tiled') renderLayout();
  closeCtxMenu();
  const empty = tab.activePaneId && tab.panes.get(tab.activePaneId);
  if (empty && !empty.sessionId && empty.kind !== 'file') activatePane(tab.id, empty.id, false);
  else {
    const session = state.sessions.get(tab.sessionId)
      || [...state.sessions.values()].find((s) => s.tabId === tab.id && (!tab.zoomPaneId || s.paneId === tab.zoomPaneId));
    if (session) activateSession(session.sessionId, { focus });
    else activatePane(tab.id, firstLeafPaneId(tab.layout), false);
  }
  // Focus can scroll xterm's textarea to the bottom of an oversized tile. Reveal
  // its header afterward; nearest on the whole oversized card may do nothing.
  if (state.workspace?.mode === 'tiled' && !state.workspace.fits) {
    tab.workspaceTile?.querySelector('.workspace-tile-header')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  updateWelcome();
}

export function paneOwner(paneId, tabId) {
  if (tabId) return state.tabs.get(tabId)?.panes.has(paneId) ? state.tabs.get(tabId) : null;
  return [...state.tabs.values()].find((tab) => tab.panes.has(paneId)) || null;
}

export function activatePane(tabId, paneId, focus = false) {
  const tab = state.tabs.get(tabId);
  const pane = tab?.panes.get(paneId);
  // 文件分屏:只取"焦点窗格"身份(⌘A/上传/关闭作用于它),
  // 不抢终端焦点、不动 activeId —— 两条焦点线完全解耦(见设计 7-1)。
  if (pane?.kind === 'file') return activateFilePane(tabId, paneId);
  if (pane?.sessionId) return activateSession(pane.sessionId, { focus });
  if (!tab) return;
  const changed = state.activeTabId !== tabId;
  setActiveTabId(tabId);
  if (changed && state.workspace?.mode !== 'tiled') renderLayout();
  if (changed || state.activeId !== null || tab.activePaneId !== (paneId || null)) focusRevision++;
  tab.activePaneId = paneId || null;
  state.activeId = null;
  syncFocusedPane(tab.id, paneId);
  syncTabChrome();
  updateStatusbar(null);
  closeSnippetMenu();
  renderMonitorBar();
}

/// 文件分屏获得焦点:标记 .focused + 记为标签活动窗格,其余一概不动。
function activateFilePane(tabId, paneId) {
  const tab = state.tabs.get(tabId);
  if (!tab || !tab.panes.get(paneId)) return;
  const changed = state.activeTabId !== tabId;
  setActiveTabId(tabId);
  if (changed && state.workspace?.mode !== 'tiled') renderLayout();
  if (tab.activePaneId !== paneId) { focusRevision++; tab.activePaneId = paneId; }
  syncFocusedPane(tabId, paneId);
  notifyTerminalStateChange();
}

function syncFocusedPane(tabId, paneId) {
  for (const tab of state.tabs.values()) {
    for (const pane of tab.panes.values()) pane.el.classList.toggle('focused', tab.id === tabId && pane.id === paneId);
  }
}

/// 关闭标签:释放该标签下所有会话。
/// 有传输任务借用标签内连接时,先经确认底座(一次汇总,不逐会话打断)。
export async function closeTab(tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (tab.transferConfirming) return;
  const ids = [...state.sessions.values()].filter((s) => s.tabId === tabId).map((s) => s.sessionId);
  if (ids.length && !tab.transferConfirmed) {
    tab.transferConfirming = true;
    let ok = false;
    try { ok = await confirmTransferInterrupt(ids); } finally { tab.transferConfirming = false; }
    if (!ok) return;
    tab.transferConfirmed = true;
  }
  const wasActive = state.activeTabId === tabId;
  tab.closing = true;
  for (const sid of ids) closeSession(sid, { checkTransfers: false });
  tab.el.remove();
  tab.workspaceTile?.remove();
  state.tabs.delete(tabId);
  if (!state.tabs.size) {
    state.activeTabId = null;
    state.activeId = null;
    state.workspace = { mode: 'single', layout: null, fits: true };
    updateStatusbar(null);
    renderMonitorBar();
  } else if (wasActive) {
    state.activeId = null;
    setActiveTabId([...state.tabs.keys()][0]);
  }
  if (wasActive || !state.tabs.size || state.workspace?.mode === 'tiled') renderLayout();
  if (wasActive && state.activeTabId) activateTab(state.activeTabId);
  syncTabChrome();
  updateWelcome();
}

/// 同步标签标题/状态点(取该标签主会话;手动重命名的标签优先显示自定义名)
export function notifyTerminalStateChange() {
  // Command availability listens on document; events dispatched on window do not reach it.
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('nebula:state-change'));
}

export function syncTabChrome() {
  notifyTerminalStateChange();
  for (const [tabId, tab] of state.tabs) {
    const s = [...state.sessions.values()].find((x) => (x.tabId || null) === tabId);
    const title = tab.el.querySelector('.tab-title');
    const dot = tab.el.querySelector('.tab-dot');
    if (s) {
      title.textContent = tab.customTitle || s.host.name;
      dot.className = 'tab-dot ' + s.status;
    } else {
      title.textContent = tab.customTitle || '新标签';
      dot.className = 'tab-dot';
    }
  }
  syncWorkspaceChrome(state.tabs, state.activeTabId);
}

// —— 分屏布局(E3):二叉布局树,leaf 持有 paneId ——
export function newPaneId() { return 'pane-' + (++state.paneSeq); }

// 窗格工具条(右上角):[已放大·还原] [文件][端口转发][广播] / [重连] │ [✕][⤢]。
// ✕⤢ 常驻(关闭对空窗格同样有效 —— 没有会话的窗格此前关不掉);其余按钮在
// 悬停或键盘聚焦工具条时浮现,广播期间广播按钮一直显示本会话是否参与。
// 所有按钮带显式目标(data-cmd-pane/tab),名称与可用状态取自命令注册表,
// 不抢焦点、不切标签。✕⤢ 直接调用窗格级函数(direct),不依赖注册表也能用。
const PANE_TOOLS = [
  { cls: 'pane-tb-file', command: 'tab.file.add', icon: 'folderPlus' },
  { cls: 'pane-tb-forward', command: 'tools.forwards', icon: 'shuffle' },
  { cls: 'pane-tb-broadcast', command: 'tools.broadcast', icon: 'megaphone' },
  { cls: 'pane-tb-reconnect', command: 'session.reconnect', icon: 'rotate', text: '重连' },
];

function paneToolButton(cls, command, paneId, tabId, direct = null) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.dataset.command = command;
  btn.dataset.cmdPane = paneId;
  if (tabId) btn.dataset.cmdTab = tabId;
  btn.setAttribute('data-label-title', '');
  // mousedown 不冒泡到窗格:点工具条不等于激活该窗格
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  // 冒泡阶段拦截:捕获阶段在目标自身上 stopPropagation 会连同本按钮的
  // 普通监听一起跳过(DOM 规范的目标阶段分两轮调用),按钮就点不动了。
  btn.addEventListener('click', (e) => e.stopPropagation());
  if (direct) {
    btn.dataset.commandDirect = '1';
    btn.addEventListener('click', direct);
  } else bindCommandButton(btn);
  return btn;
}

export function appendPaneButtons(el, paneId, tabId = paneOwner(paneId)?.id) {
  const bar = document.createElement('div');
  bar.className = 'pane-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '窗格操作');
  const extra = document.createElement('span');
  extra.className = 'pane-tools-extra';
  for (const tool of PANE_TOOLS) {
    const btn = paneToolButton(`pane-tb-btn ${tool.cls}`, tool.command, paneId, tabId);
    btn.innerHTML = icon(tool.icon) + (tool.text ? `<span class="pane-tb-text">${tool.text}</span>` : '');
    extra.appendChild(btn);
  }
  const sep = document.createElement('span');
  sep.className = 'pane-tb-sep';
  const closeBtn = paneToolButton('pane-close-btn', 'workspace.close', paneId, tabId, () => closeActivePane(paneId, tabId));
  closeBtn.innerHTML = icon('x');
  closeBtn.title = '关闭该窗格';
  const zoomBtn = paneToolButton('pane-zoom-btn', 'pane.zoom', paneId, tabId, () => togglePaneZoom(paneId, tabId));
  zoomBtn.innerHTML = icon('zoom');
  zoomBtn.title = '放大该窗格';
  for (const child of [extra, sep, closeBtn, zoomBtn]) bar.appendChild(child);
  el.appendChild(bar);
}

/// 工具条的形态随窗格变化:data-kind = term / file / empty,data-conn =
/// connected / connecting / down;按钮状态和名称由注册表按显式目标刷新。
export function syncPaneButtons(tab = activeTab()) {
  if (!tab) return;
  for (const pane of tab.panes.values()) {
    const bar = pane.el.querySelector('.pane-toolbar');
    if (!bar) continue;
    const session = pane.sessionId ? state.sessions.get(pane.sessionId) : null;
    bar.dataset.kind = pane.kind === 'file' ? 'file' : session ? 'term' : 'empty';
    bar.dataset.conn = session ? (['connected', 'connecting'].includes(session.status) ? session.status : 'down') : '';
    const enlarged = tab.zoomPaneId === pane.id;
    const zoom = bar.querySelector('.pane-zoom-btn');
    if (zoom) {
      zoom.setAttribute('aria-pressed', String(enlarged));
      zoom.innerHTML = icon(enlarged ? 'zoomOff' : 'zoom');
    }
    let chip = bar.querySelector('.zoom-chip');
    if (enlarged && !chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'zoom-chip';
      chip.title = `还原分屏布局(${accelOf('pane.zoom')})`;
      chip.textContent = '已放大 · 还原';
      chip.addEventListener('mousedown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => { e.stopPropagation(); togglePaneZoom(pane.id, tab.id); });
      bar.appendChild(chip); // CSS order 把它排到最左
    } else if (!enlarged && chip) chip.remove();
    refreshCommandStates(bar);
  }
}

/// 会话状态、广播、模态变化都会改变工具条:跟随 nebula:state-change 同步
/// 所有已挂载窗格(平铺模式下不止活动标签)。
export function bindPaneToolbars() {
  const sync = () => { for (const tab of state.tabs.values()) syncPaneButtons(tab); };
  document.addEventListener('nebula:state-change', sync);
  document.addEventListener('nebula:modal-scope', sync);
}

export function makePaneEl(paneId, tabId = state.activeTabId, kind = 'term', paneObj = null) {
  const el = document.createElement('div');
  // 文件分屏复用 .term-pane 的焦点/激活/布局契约,叠加 .file-pane 做内容与最小尺寸
  el.className = kind === 'file' ? 'term-pane file-pane' : 'term-pane';
  el.dataset.pane = paneId;
  el.dataset.tab = tabId;
  const activate = (event) => {
    // Buttons are owner-scoped operations, not a request to steal focus.
    if (event.target.closest?.('.pane-toolbar, .pane-picker-close')) return;
    activatePane(tabId, paneId, false);
  };
  el.addEventListener('mousedown', activate);
  el.addEventListener('focusin', activate);
  // 文件分屏的内部 DOM 需要 pane.el 才能渲染:先把元素回填到窗格对象,
  // 否则 buildFilePane 读到 window.pane.el 为空直接返回,分屏永远空白。
  if (kind === 'file' && paneObj) { paneObj.el = el; buildFilePane(paneObj); }
  appendPaneButtons(el, paneId, tabId);
  return el;
}

// 布局树里的窗格(叶子)数量
export function leafCount(node) {
  if (!node) return 0;
  if (isLeaf(node)) return 1;
  return leafCount(node.a) + leafCount(node.b);
}

// 窗格放大/还原(竖向空间不足时的快速聚焦)
export function togglePaneZoom(paneId, tabId) {
  const tab = paneOwner(paneId, tabId);
  if (!tab) return;
  if (tab.zoomPaneId === paneId) tab.zoomPaneId = null;
  else {
    const pane = tab.panes.get(paneId);
    if (!pane?.sessionId && pane?.kind !== 'file') return toast('空窗格无需放大', 'error');
    if (leafCount(tab.layout) <= 1) return toast('当前只有一个窗格,无需放大', 'error');
    tab.zoomPaneId = paneId;
    // Remember a visible local target without changing the active workspace tile.
    tab.sessionId = pane.sessionId;
    tab.activePaneId = null;
  }
  if (tab.id === state.activeTabId || state.workspace?.mode === 'tiled') renderLayout();
  if (tab.id === state.activeTabId && tab.zoomPaneId) activateSession(tab.panes.get(tab.zoomPaneId).sessionId, { focus: false });
}

export function rebalanceRatios(node) {
  if (!node || isLeaf(node)) return node;
  node.ratio = 0.5; // 关闭窗格后重新均分,避免残留比例导致某侧过窄
  node.a = rebalanceRatios(node.a);
  node.b = rebalanceRatios(node.b);
  return node;
}

// 监控已固定显示在状态栏(不再是终端区上方的独立条),既不占终端高度也无需自动隐藏。
// 保留空实现:调用点较多,删掉反而让"为什么这里不管监控"更难理解。
export function updateMonitorAutoHide() { /* no-op:见上 */ }

export function leaf(paneId) { return { type: 'leaf', paneId }; }
export function isLeaf(n) { return !!n && n.type === 'leaf'; }

export function findLeafPath(node, paneId, path = []) {
  if (!node) return null;
  if (isLeaf(node)) return node.paneId === paneId ? path : null;
  const l = findLeafPath(node.a, paneId, [...path, 'a']);
  if (l) return l;
  return findLeafPath(node.b, paneId, [...path, 'b']);
}

export function nodeAt(node, path) {
  let cur = node;
  for (const k of path) cur = cur[k];
  return cur;
}

export function replaceAt(path, fn) {
  if (!path.length) { state.layout = fn(state.layout); return; }
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];
  const parent = nodeAt(state.layout, parentPath);
  parent[key] = fn(parent[key]);
}

// 空窗格判定必须看窗格对象上的 sessionId —— 布局叶节点不持有该字段
// (此前读 node.sessionId 恒为 undefined,导致"永远存在空窗格",
//  新会话复用首个窗格并把已有会话的终端 DOM 清掉)。
export function firstEmptyLeaf(node, tab = activeTab()) {
  if (!node || !tab) return null;
  if (isLeaf(node)) {
    const pane = tab.panes.get(node.paneId);
    // 文件分屏不是"空窗格":新会话绝不复用它的格子
    return pane && !pane.sessionId && pane.kind !== 'file' ? node.paneId : null;
  }
  return firstEmptyLeaf(node.a, tab) || firstEmptyLeaf(node.b, tab);
}

let workspaceLayoutFrame = null;
let lastWorkspaceSignature = null;

export function toggleTabTiling() {
  if (!state.tabs.size || (state.workspace?.mode !== 'tiled' && state.tabs.size < 2)) return false;
  state.workspace ||= { mode: 'single', layout: null, fits: true };
  state.workspace.mode = state.workspace.mode === 'tiled' ? 'single' : 'tiled';
  state.workspace.layout = null;
  lastWorkspaceSignature = null;
  renderLayout();
  syncTabChrome();
  return state.workspace.mode === 'tiled';
}

// ResizeObserver/window/panel changes can all converge here. Geometry is the
// only invalidation input: focusing a tile cannot cause a mount/observer loop.
export function scheduleWorkspaceLayout() {
  if (workspaceLayoutFrame !== null) return;
  // rAF + 定时器兜底:窗口被遮挡时 WKWebView 完全停摆 rAF,布局调度会
  // 永远挂起(表现:改了面板尺寸但 fits/溢出提示永不更新)。兜底帧让
  // 布局收敛不依赖前台状态;前台时 rAF 仍先到,行为不变。
  let fired = false;
  const run = () => {
    if (fired) return;
    fired = true;
    workspaceLayoutFrame = null;
    if (state.workspace?.mode === 'tiled') {
      const { width, height } = workspaceDimensions();
      const signature = workspaceSignature(state.tabs, width, height);
      if (signature !== lastWorkspaceSignature) renderLayout();
    }
    fitAllVisible();
    scheduleResizeSync();
  };
  workspaceLayoutFrame = requestAnimationFrame(run);
  setTimeout(run, 120);
}

function workspaceDimensions() {
  // Use the stable full parent box, not the root reduced by its overflow hint.
  const stack = $('#term-stack') || $('#layout-root');
  return { width: stack?.offsetWidth || stack?.clientWidth || 320, height: stack?.offsetHeight || stack?.clientHeight || 180 };
}

export function renderTabLayout(tab, root) {
  replaceLayoutContent(root, () => {
    if (tab.zoomPaneId && leafCount(tab.layout) <= 1) tab.zoomPaneId = null;
    if (tab.zoomPaneId && tab.panes.has(tab.zoomPaneId)) {
      const pane = tab.panes.get(tab.zoomPaneId);
      pane.el.style.flex = '1 1 0';
      root.appendChild(pane.el);
    } else if (tab.layout) {
      root.appendChild(renderSplitTree(tab.layout, {
        document,
        leaf: (node) => tab.panes.get(node.paneId)?.el || document.createElement('div'),
        minimum: (node) => paneMinSize(tab.panes.get(node.paneId)),
        divider: attachDivider,
      }));
    }
    renderPickers(tab);
    for (const pane of tab.panes.values()) {
      if (!pane.el.querySelector('.pane-toolbar')) appendPaneButtons(pane.el, pane.id, tab.id);
    }
    syncPaneButtons(tab);
  });
}

export function renderLayout() {
  const root = $('#layout-root');
  if (!root) return;
  const returnFocus = document.activeElement;
  const focusPane = returnFocus?.closest?.('.term-pane');
  state.workspace ||= { mode: 'single', layout: null, fits: true };
  const tiled = state.workspace.mode === 'tiled' && state.tabs.size > 0;
  root.classList.toggle('workspace-tiled', tiled);
  replaceLayoutContent(root, () => {
    if (tiled) {
      const { width, height } = workspaceDimensions();
      let plan = planWorkspace(state.tabs, width, height);
      const overflow = !plan.fits;
      root.style.top = overflow ? '28px' : '';
      if (overflow) plan = planWorkspace(state.tabs, width, Math.max(1, height - 28));
      state.workspace.layout = plan.layout;
      state.workspace.fits = !overflow && plan.fits;
      lastWorkspaceSignature = workspaceSignature(state.tabs, width, height);
      const tree = renderWorkspaceTree(plan.layout, state.tabs, {
        document, activate: activateTab, close: closeTab,
      });
      if (tree) root.appendChild(tree);
      for (const tab of state.tabs.values()) {
        const minimum = tabMinimum(tab);
        tab.workspaceTile.style.minWidth = `${minimum.width}px`;
        tab.workspaceTile.style.minHeight = `${minimum.height}px`;
        renderTabLayout(tab, tab.workspaceContent);
      }
    } else {
      root.style.top = '';
      state.workspace.layout = null;
      state.workspace.fits = true;
      lastWorkspaceSignature = null;
      // Single mode must detach inactive tiles, not leave live terminals hidden
      // inside an off-root but previously mounted workspace tree.
      for (const tab of state.tabs.values()) tab.workspaceContent?.replaceChildren();
      const tab = activeTab();
      if (tab) renderTabLayout(tab, root);
    }
  });
  root.classList.toggle('workspace-overflow', tiled && !state.workspace.fits);
  const hint = $('#workspace-layout-hint');
  if (hint) {
    hint.classList.toggle('hidden', !tiled || state.workspace.fits);
    hint.textContent = tiled && !state.workspace.fits ? '空间不足,可滚动查看所有标签;内部布局保持不变。' : '';
  }
  syncWorkspaceChrome(state.tabs, state.activeTabId);
  updateWelcome();
  notifyTerminalStateChange();
  // Reparenting can clear the browser's DOM focus. Preserve only the input that
  // was actually focused before this synchronous mount, never an inferred or
  // remembered terminal (and never a removed/hidden/background owner).
  const activePaneId = state.sessions.get(state.activeId)?.paneId || state.activePaneId;
  if (returnFocus?.isConnected && document.activeElement !== returnFocus && focusPane?.dataset.tab === state.activeTabId
    && focusPane.dataset.pane === activePaneId && !hasOpenModal()) {
    returnFocus.focus({ preventScroll: true });
  }
  // Deferred geometry never calls focus(): an intervening modal, background
  // connection or newly selected tile must keep the user's current focus.
  setTimeout(() => {
    for (const s of visibleSessions()) {
      try { s.term.refresh(0, s.term.rows - 1); } catch { /* ignore */ }
    }
    fitAllVisible();
    scheduleResizeSync();
  }, 30);
}

export function visibleSessions() {
  const tiled = state.workspace?.mode === 'tiled';
  return [...state.sessions.values()].filter((s) => {
    const tab = state.tabs.get(s.tabId);
    if (!tab || !s.pane?.isConnected || (!tiled && tab.id !== state.activeTabId)) return false;
    if (tab.zoomPaneId && tab.zoomPaneId !== s.paneId) return false;
    if (!findLeafPath(tab.layout, s.paneId)) return false;
    const rect = s.pane.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  });
}

export function attachDivider(div, node, aEl, bEl, wrap) {
  div.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let raf = 0;
    const move = (ev) => {
      const rect = wrap.getBoundingClientRect();
      const vertical = node.type === 'v';
      const span = Math.max(1, (vertical ? rect.height : rect.width) - DIVIDER_SIZE);
      const amin = layoutMinSize(node.a), bmin = layoutMinSize(node.b);
      const low = (vertical ? amin.height : amin.width) / span;
      const high = 1 - (vertical ? bmin.height : bmin.width) / span;
      if (low > high) return; // Window shrank below capacity: do not worsen overflow.
      const position = vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
      const ratio = Math.min(high, Math.max(low, (position - DIVIDER_SIZE / 2) / span));
      node.ratio = ratio;
      aEl.style.flex = `0 0 calc(${ratio * 100}% - ${ratio * DIVIDER_SIZE}px)`;
      bEl.style.flex = `0 0 calc(${(1 - ratio) * 100}% - ${(1 - ratio) * DIVIDER_SIZE}px)`;
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
export function renderPickers(tab = activeTab()) {
  if (!tab) return;
  const tabId = tab.id;
  for (const [paneId, pane] of tab.panes) {
    if (pane.sessionId || pane.kind === 'file' || pane.pickerRendered) continue;
    pane.pickerRendered = true;
    const picker = document.createElement('div');
    picker.className = 'pane-picker';
    // 空窗格给一个显式关闭按钮:没有会话的窗格此前只能靠菜单/⌘W 关闭,
    // 连开多个空窗格时毫无办法 —— 现在每格自己带 ✕,即点即关。
    const closeBtn = document.createElement('button');
    closeBtn.className = 'pane-picker-close';
    closeBtn.title = '关闭该窗格';
    closeBtn.innerHTML = icon('x');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeActivePane(paneId, tabId);
    });
    picker.appendChild(closeBtn);
    picker.insertAdjacentHTML('beforeend', '<div class="muted">选择要在该窗格连接的主机:</div>');
    for (const h of state.hosts) {
      const item = document.createElement('div');
      item.className = 'pp-item';
      item.textContent = `${h.name} · ${h.username}@${h.host}:${h.port}`;
      item.addEventListener('click', () => {
        pane.pickerRendered = false;
        picker.remove();
        activatePane(tab.id, paneId, false);
        connectHost(h.id, paneId, { force: true, tabId: tab.id });
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
      activatePane(tab.id, paneId, false);
      quickConnect(parsed, paneId, tab.id);
    });
    picker.appendChild(inp);
    pane.el.appendChild(picker);
  }
}

// 可见区域能容纳的最大窗格数:按"每个窗格至少 320×180(再小终端已不可用)"
// 折算 #layout-root 的可视面积。分屏不设硬编码上限,窗口越大可分越多;
// 超出容量继续分屏会因 .term-pane 的 min-width/min-height 溢出可视区,
// 出现横向滚动与错位(此前连开十几个空窗格即此症状)。
export function layoutDimensions(tab = activeTab()) {
  // Inner split capacity is constrained by this tile's actual content box.
  if (state.workspace?.mode === 'tiled' && tab?.workspaceContent?.isConnected) {
    const content = tab.workspaceContent;
    return { width: content.clientWidth || content.offsetWidth || 320, height: content.clientHeight || content.offsetHeight || 180 };
  }
  // Single root has no border/padding: use its full box before stale scrollbar
  // gutters (the shared WebKit overflow reset can remove those on replacement).
  const stack = $('#layout-root');
  return { width: stack?.offsetWidth || stack?.clientWidth || 320, height: stack?.offsetHeight || stack?.clientHeight || 180 };
}

export function maxPaneCapacity() {
  const { width, height } = layoutDimensions();
  return paneCapacity(width, height);
}

// Splitting clones the connected source descriptor (saved or temporary), never a picker.
export function splitActive(dir) {
  const tab = activeTab();
  const source = state.sessions.get(state.activeId);
  if (!tab || !source || source.tabId !== tab.id || source.status !== 'connected') {
    return toast('请先连接当前窗格再分屏', 'error');
  }
  const cap = maxPaneCapacity();
  if (tab.panes.size + 1 > cap) return toast(`当前窗口最多容纳 ${cap} 个分屏窗格`, 'error');
  const session = createSession({ ...source.host }, null, tab.id, dir);
  session.connection = { ...source.connection, host: source.connection?.host ? { ...source.connection.host } : undefined };
  return runSessionConnection(session);
}

/// 新增文件分屏:文件管理是标签内的分屏之一,与「新增分屏」(终端)完全对称。
/// 前置(标签内有已连接会话)、容量、布局(活动分屏右侧分割 + 自动整理)同规则;
/// 不创建会话 —— 传输通道在每次操作提交时解析(见 sftp.js paneSession)。
/// 能否在该标签新增文件分屏:可以返回 '',不能返回原因。⋯ 菜单、标签右键与
/// addFilePane 共用这一个判定,入口的可用状态与执行时的拦截不会各说各的。
export function filePaneBlocker(tabId) {
  const tab = tabId ? state.tabs.get(tabId) : activeTab();
  if (!tab) return '没有打开的标签';
  if (![...state.sessions.values()].some((s) => s.tabId === tab.id && s.status === 'connected')) return '先连接当前标签的主机';
  const cap = maxPaneCapacity();
  if (tab.panes.size + 1 > cap) return `当前窗口最多容纳 ${cap} 个分屏窗格`;
  return '';
}

/// anchorPaneId:窗格工具条传入的显式落点(在该窗格右侧切出);缺省按焦点推断。
export function addFilePane(tabId, anchorPaneId) {
  const blocker = filePaneBlocker(tabId);
  if (blocker) return toast(blocker, 'error');
  const tab = tabId ? state.tabs.get(tabId) : activeTab();
  const paneId = newPaneId();
  const pane = { id: paneId, kind: 'file', ...createFilePaneState() };
  pane.el = makePaneEl(paneId, tab.id, 'file', pane);
  tab.panes.set(paneId, pane);
  if (!tab.layout) {
    tab.layout = leaf(paneId);
  } else {
    // 落点:焦点窗格 > 标签主会话窗格 > 首个窗格;在锚点右侧一刀切出
    const anchor = (anchorPaneId && tab.panes.has(anchorPaneId)) ? anchorPaneId
      : (tab.activePaneId && tab.panes.get(tab.activePaneId)) ? tab.activePaneId
      : state.sessions.get(tab.sessionId)?.paneId
      || state.sessions.get(state.activeId)?.paneId
      || firstLeafPaneId(tab.layout);
    const path = findLeafPath(tab.layout, anchor) || [];
    const split = (node) => ({ type: 'h', ratio: 0.62, a: node, b: leaf(paneId) });
    if (!path.length) tab.layout = split(tab.layout);
    else {
      const parent = nodeAt(tab.layout, path.slice(0, -1));
      const key = path.at(-1);
      parent[key] = split(parent[key]);
    }
  }
  // 与终端分屏一致:新增后重排为均衡网格(内部已 renderLayout)
  if (tab.panes.size > 1) reflowIfSplitting(undefined, tab);
  else renderLayout();
  activateFilePane(tab.id, paneId);
  initFilePane(pane).catch(() => {});
  notifyTerminalStateChange();
  return pane;
}

export function reflowIfSplitting(dir, tab = activeTab()) {
  if (!tab || !tab.layout) return false;
  const ids = paneIdsInOrder(tab);
  const { width, height } = layoutDimensions(tab);
  // 按窗格类型取最小尺寸(终端 320×180 / 文件 300×220),混排时规划器据此分配
  tab.layout = planGrid(ids, width, height, dir, { minimum: (id) => paneMinSize(tab.panes.get(id)) }).layout;
  tab.zoomPaneId = null;
  if (tab.id === state.activeTabId || state.workspace?.mode === 'tiled') renderLayout();
  return ids.length > 1;
}

export function paneIdsInOrder(tab) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (isLeaf(n)) { if (tab.panes.has(n.paneId)) out.push(n.paneId); return; }
    walk(n.a); walk(n.b);
  })(tab.layout);
  return out;
}

export function buildGrid(paneIds, dir) {
  const { width, height } = layoutDimensions();
  return planGrid(paneIds, width, height, dir).layout;
}

export function activeLeafPaneId() {
  if (state.activePaneId) {
    const p = state.panes.get(state.activePaneId);
    // "空窗格复用"只认终端空窗格;文件分屏有自己的内容,绝不能被新会话顶掉
    if (p && !p.sessionId && p.kind !== 'file') return state.activePaneId;
  }
  const s = state.sessions.get(state.activeId);
  if (s && s.paneId) return s.paneId;
  const first = firstLeafPaneId(state.layout);
  return first;
}

/* ---------------- 关闭窗格 / 自动整理布局 ---------------- */

/// 解析"用户此刻看着的那个窗格"(关闭操作的靶子)。
/// 不能用 activeLeafPaneId():它为了"分屏时复用空窗格"而**优先返回空窗格**,
/// 用作关闭靶子就会把旁边的空窗格关掉、留下用户正用的那个 —— 与直觉相反。
/// 定序:DOM 焦点标记 > 活动会话 > 记下的空窗格 > 首个。
export function focusedPaneId() {
  const tab = activeTab();
  if (!tab || !tab.layout) return null;
  // 1) DOM 上有 focused 标记的窗格(点过/正在输入的)
  const el = document.querySelector('.term-pane.focused');
  if (el && el.dataset.pane && tab.panes.has(el.dataset.pane)) return el.dataset.pane;
  // 2) 活动会话所在窗格
  const s = state.sessions.get(state.activeId);
  if (s && s.paneId && s.tabId === tab.id && tab.panes.has(s.paneId)) return s.paneId;
  // 3) 记下的空窗格(用户刚点过的),最后退回首个
  if (tab.activePaneId && tab.panes.has(tab.activePaneId)) return tab.activePaneId;
  return firstLeafPaneId(tab.layout);
}

/// 「关闭当前窗格」/ ⌘W 关闭的就是焦点窗格,与命令名一致(同类终端都如此)。
/// 曾经优先关空窗格(当年分屏会先生成"选择主机"的空窗格),现在分屏直接复用
/// 当前主机,空窗格自己也有 ✕,不再需要特殊照顾。
export function pickPaneToClose(tab) {
  if (tab.id === state.activeTabId) return focusedPaneId();
  return tab.activePaneId && tab.panes.has(tab.activePaneId) ? tab.activePaneId : firstLeafPaneId(tab.layout);
}

/// 关闭当前活动窗格(窗格内会话一并关闭;空窗格直接摘除)。
/// targetPaneId:窗格右上角 ✕ 传入的显式目标 —— 点哪个格子就关哪个格子;
/// 菜单/⌘W 不传,关闭焦点窗格。
export function closeActivePane(targetPaneId, tabId) {
  const tab = targetPaneId ? paneOwner(targetPaneId, tabId) : (tabId ? state.tabs.get(tabId) : activeTab());
  if (!tab || !tab.layout) return toast('当前没有可分屏的窗格', 'error');
  // An invalid explicit owner/target must never fall back to the active tab.
  if (targetPaneId && !tab.panes.has(targetPaneId)) return;
  if (leafCount(tab.layout) <= 1) return closeTab(tab.id);
  const paneId = targetPaneId || pickPaneToClose(tab);
  const pane = paneId ? tab.panes.get(paneId) : null;
  if (!pane) return toast('找不到当前窗格', 'error');
  // 有会话的窗格走 closeSession:它会断开连接、释放终端并从布局树摘除
  if (pane.sessionId) { closeSession(pane.sessionId); return; }
  // 空窗格:直接从布局树与窗格表摘除
  removePaneFromTab(tab, paneId);
  tab.panes.delete(paneId);
  if (tab.zoomPaneId === paneId) tab.zoomPaneId = null;
  const wasFocused = tab.id === state.activeTabId && tab.activePaneId === paneId;
  if (tab.activePaneId === paneId) tab.activePaneId = null;
  reflowIfSplitting(undefined, tab);
  if (wasFocused) activatePane(tab.id, firstLeafPaneId(tab.layout), false);
  updateWelcome();
}

/// 自动整理布局:把当前标签的窗格重排成"接近正方形"的等分网格。
/// 手动分屏容易越分越歪(自定义比例 + 嵌套结构),窗格数一多就出现极窄条。
/// 这里按窗格数算出行列数,重建为行列均衡的二叉布局,比例全部回到等分。
/// 网格算法与"新增分屏后自动整理"共用 buildGrid,避免两处规则漂移。
export function autoLayoutTab() {
  const tab = activeTab();
  if (!tab || !tab.layout) return toast('当前没有窗格', 'error');
  const paneIds = paneIdsInOrder(tab);
  if (paneIds.length <= 1) return toast('只有一个窗格,无需整理', 'error');
  const { width, height } = layoutDimensions();
  const plan = planGrid(paneIds, width, height, undefined, { minimum: (id) => paneMinSize(tab.panes.get(id)) });
  tab.layout = plan.layout;
  tab.zoomPaneId = null;
  renderLayout();
  toast(`已整理为 ${plan.rows} × ${plan.cols} 布局`, 'success');
}

export function firstLeafPaneId(node) {
  if (!node) return null;
  if (isLeaf(node)) return node.paneId;
  return firstLeafPaneId(node.a) || firstLeafPaneId(node.b);
}

/// 从指定标签的布局树里摘除一个窗格(作用于 tab 对象,不受当前活动标签影响)
export function removePaneFromTab(tab, paneId) {
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

export function fitAllVisible() {
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

export let resizeSyncTimer = null;
export function scheduleResizeSync() {
  clearTimeout(resizeSyncTimer);
  resizeResizeSync();
}
export function resizeResizeSync() {
  resizeSyncTimer = setTimeout(() => {
    for (const s of visibleSessions()) {
      if (s.status !== 'connected') continue;
      api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  }, 150);
}

/* ---------------- 选中内容悬浮「解释」按钮 ---------------- */

/// 全局唯一悬浮按钮:任一会话出现选区时,定位到选区末字符后方。
/// 挂 body(fixed 定位),不随任何窗格 transform/滚动容器裁切。
let explainBubble = null;
let explainBubbleFor = null; // 当前按钮归属的 session(切会话/清选区时隐藏)

function explainBubbleEl() {
  if (explainBubble) return explainBubble;
  explainBubble = document.createElement('button');
  explainBubble.id = 'ai-explain-bubble';
  explainBubble.type = 'button';
  explainBubble.className = 'ai-explain-bubble';
  explainBubble.textContent = '🔍';
  // tips 与原「解释选中内容」按钮一致
  explainBubble.title = '解释选中内容';
  explainBubble.setAttribute('aria-label', '解释选中内容');
  // 点击即用当前归属会话的选区发起解释;mousedown 先行,避免点击时先清掉 xterm 选区
  explainBubble.addEventListener('mousedown', (e) => e.preventDefault());
  explainBubble.addEventListener('click', (e) => {
    e.stopPropagation();
    // 先取归属会话再隐藏:hideExplainBubble 会清空 explainBubbleFor
    const s = explainBubbleFor;
    hideExplainBubble();
    const sel = s ? s.term.getSelection() : '';
    if (!sel) return toast('请先在终端中选中要解释的内容', 'error');
    (bindSelectionExplain._aiSend || ((sel) => console.warn('aiSend 未注入')))(sel, 'explain');
  });
  document.body.appendChild(explainBubble);
  return explainBubble;
}

function hideExplainBubble() {
  if (explainBubble) explainBubble.classList.remove('show');
  explainBubbleFor = null;
}

export function bindSelectionExplain(session) {
  const compute = () => {
    const term = session.term;
    let sel = '';
    try { sel = term.getSelection(); } catch { /* ignore */ }
    if (!sel || session.paneId !== focusedPaneId() || !session.pane?.isConnected) {
      if (explainBubbleFor === session) hideExplainBubble();
      return;
    }
    // 选区末字符的视口坐标:走 xterm 内部选择服务的 selectionEnd([x, y],
    // y 为含 ybase 的绝对 buffer 行),换算到可视行列再乘 cell 尺寸
    let x = 0, y = 0, ok = false;
    try {
      const svc = term._core?._selectionService;
      const end = svc?.selectionEnd;
      if (end) {
        const [endX, endAbsY] = end;
        const buf = term.buffer.active;
        const viewY = endAbsY - buf.viewportY;
        // 只处理可视区内的选区末尾(滚出视口的选区不弹按钮)
        if (viewY >= 0 && viewY < term.rows) {
          const rowsEl = term.element.querySelector('.xterm-rows');
          const dim = rowsEl?.getBoundingClientRect();
          const cellW = dim ? (dim.width / term.cols) : 8;
          const cellH = dim ? (dim.height / term.rows) : 16;
          const paneRect = session.pane.getBoundingClientRect();
          x = paneRect.left + (endX + 1) * cellW;
          y = paneRect.top + (viewY + 1) * cellH;
          ok = true;
        }
      }
    } catch { /* 内部 API 不可用:不弹按钮 */ }
    if (!ok) { if (explainBubbleFor === session) hideExplainBubble(); return; }
    const bubble = explainBubbleEl();
    explainBubbleFor = session;
    bubble.classList.add('show');
    const bw = bubble.offsetWidth || 28, bh = bubble.offsetHeight || 28;
    bubble.style.left = Math.min(x + 6, window.innerWidth - bw - 8) + 'px';
    bubble.style.top = Math.max(8, y - bh - 4) + 'px';
  };
  try {
    session.term.onSelectionChange(compute);
  } catch { /* 老版本 xterm 无此事件:功能降级为无悬浮按钮 */ }
  // 选区随滚动/会话切换变化:滚轮与焦点切换时重算或隐藏
  session.term.onScroll?.(() => { if (explainBubbleFor === session) compute(); });
  session.pane?.addEventListener?.('scroll', () => { if (explainBubbleFor === session) compute(); }, true);
}

export function createSession(host, paneId, tabId, dir, options = {}) {
  // Resolve explicit pane ownership before any active-tab accessor or await.
  let tab = paneId ? paneOwner(paneId, tabId) : (tabId ? state.tabs.get(tabId) : activeTab());
  if ((paneId || tabId) && !tab) return null;
  if (!tab) tab = createTab();
  if (paneId && tab.panes.get(paneId)?.sessionId) return null;
  // 文件分屏绝不能被终端会话占用(它有自己的内容与状态)
  if (paneId && tab.panes.get(paneId)?.kind === 'file') return null;
  const sessionId = crypto.randomUUID();
  const shouldActivate = options.activate !== false;
  if (shouldActivate) setActiveTabId(tab.id);

  let targetPaneId = paneId || (tab.layout && firstEmptyLeaf(tab.layout, tab));
  let addedPane = false;
  if (!targetPaneId) {
    addedPane = true;
    if (!tab.layout) {
      targetPaneId = newPaneId();
      tab.layout = leaf(targetPaneId);
      tab.panes.set(targetPaneId, { id: targetPaneId, el: makePaneEl(targetPaneId, tab.id), sessionId: null });
    } else {
      const anchor = tab.activePaneId || state.sessions.get(tab.sessionId)?.paneId || firstLeafPaneId(tab.layout);
      const path = findLeafPath(tab.layout, anchor) || [];
      targetPaneId = newPaneId();
      const split = (node) => ({ type: 'h', ratio: 0.5, a: node, b: leaf(targetPaneId) });
      if (!path.length) tab.layout = split(tab.layout);
      else {
        const parent = nodeAt(tab.layout, path.slice(0, -1));
        const key = path.at(-1);
        parent[key] = split(parent[key]);
      }
      tab.panes.set(targetPaneId, { id: targetPaneId, el: makePaneEl(targetPaneId, tab.id), sessionId: null });
    }
  }
  tab.panes.get(targetPaneId).sessionId = sessionId;
  // 走到这里说明"该标签原本没有空窗格"(否则会在上面复用),即刚刚新增了一格。
  // 新格是在活动格旁一刀切出来的,布局随之偏斜;与 splitActive 一致地整理成
  // 等分网格。reflow 内部已调用 renderLayout,故不再重复渲染。
  if (addedPane && tab.panes.size > 1) reflowIfSplitting(dir, tab);
  else if (tab.id === state.activeTabId || state.workspace?.mode === 'tiled') renderLayout(); // Mount before opening visible terminals.

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
  const surface = document.createElement('div');
  surface.className = 'term-surface';
  pane.appendChild(surface);
  term.open(surface);
  if (pane.isConnected) { try { fit.fit(); } catch { /* background terminal has no geometry yet */ } }
  // WebGL 渲染器:DOM 渲染器逐字符建 span,大批量输出(构建日志/vim/htop)时
  // 主线程掉帧,是终端输出流畅度的主要瓶颈。上下文丢失(GPU 重置/驱动切换、
  // GL 上下文数超限)时 dispose 自己,xterm 自动退回 DOM 渲染器,可用性不受影响。
  try {
    // e2e 测试桥环境下禁用 WebGL:遮挡窗口的 WebGL 合成器暂停刷新,
    // canvas 尺寸不随 fit 更新,布局审计会得到成片的假"裁切"。
    // DOM 渲染器走主线程布局,无此问题;正常使用仍默认 WebGL。
    if (!window.__NB_E2E__) {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* ignore */ } });
      term.loadAddon(webgl);
    }
  } catch { /* WebGL 不可用:保持 DOM 渲染器 */ }
  // innerHTML 清空会抹掉窗格按钮,重新挂回
  appendPaneButtons(pane, targetPaneId, tab.id);

  // 输入:只读拦截(D9) / 广播分发(E5) / 命令历史采集(F2) / AI 诊断素材采集
  term.onData((d) => {
    const s = state.sessions.get(state.activeId);
    if (!s || s.sessionId !== sessionId) return;
    // 未连接时回车=就地重连(横幅提示的唯一交互),其余输入丢弃。自动重连只覆盖
    // 可重试的网络错误,认证失败/指纹变更仍走 reconnectSession 的原有确认路径。
    if (s.status !== 'connected') {
      if (d === '\r' && !hasOpenModal()) reconnectSession(sessionId);
      return;
    }
    if (s.readOnly || hasOpenModal()) return;
    consumeCommandKeys(s, d);
    const targets = state.broadcast && state.broadcast.has(sessionId)
      ? [...state.broadcast].map((id) => state.sessions.get(id)).filter((x) => x && x.status === 'connected' && !x.readOnly)
      : [s];
    for (const t of targets) {
      writeSessionInput(t.sessionId, d);
    }
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // 应用快捷键不进 xterm:否则 Ctrl+Shift+Enter 被当回车发给 shell、
    // Ctrl+3..7 被转成控制字符。返回 false 时 xterm 不处理也不取消事件,
    // 它照常冒泡到 entry.js 的全局分发。
    if (appShortcutOf(ev)) return false;
    // 复制按"是否存在选区"分流(Windows Terminal 同款规则):
    // 有选区 = 复制意图,绝不把 \x03 发给 shell —— 否则正在跑的命令立即被终止;
    // 无选区的纯 Ctrl+C = 中断意图,放行给 xterm 发 \x03(SIGINT)。
    // macOS 的复制只认 ⌘C,Ctrl+C 不进这里,一律是 SIGINT。
    // preventDefault 拦掉浏览器默认复制:终端选区是 xterm 内部状态(WebGL 渲染下
    // DOM 里没有选中文本),默认行为只会把别处 UI(AI 面板/主机列表)的 DOM 选区
    // 塞进剪贴板 —— 表现为"复制的不是选中的内容"。
    if (matchAction('term.copy', ev)) {
      ev.preventDefault();
      const sel = term.hasSelection() ? term.getSelection() : '';
      if (sel) {
        copyText(sel).then((ok) => { if (!ok) toast('复制失败：剪贴板不可用', 'error'); });
        return false;
      }
      return ev.ctrlKey && !ev.shiftKey && !ev.metaKey;
    }
    if (matchAction('term.paste', ev)) {
      // preventDefault 拦掉浏览器默认粘贴:否则 keydown 的默认动作会在 textarea
      // 上再触发一次原生 paste 事件,xterm 的粘贴监听器插入一次、下面的手动
      // readText 链路又插入一次 —— 粘贴内容出现两遍。
      ev.preventDefault();
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
      return false;
    }
    if (matchAction('term.selectAll', ev)) {
      ev.preventDefault();
      term.selectAll();
      return false;
    }
    return true;
  });

  // 标签元素由标签模型持有(不再每个会话建一个标签):
  // 一个标签可在其内部承载多个分屏窗格。
  const session = { sessionId, host, term, fit, search, paneId: targetPaneId, pane, tabId: tab.id, status: 'connecting', readOnly: false, histBuf: '', inAltScreen: false, reconnectAttempt: 0, connection: host.quick ? { kind: 'quick', host: { ...host } } : { kind: 'saved', hostId: host.id }, connectionEpoch: 0, remoteCwd: null, lastCmd: '', lastOutput: '', collectOutput: false };
  bindSelectionExplain(session);
  // OSC 7(shell 集成):部分 shell 配置后会在每个提示符前上报当前目录
  // (\x1b]7;file://host/path\x07)。顺路记录到 remoteCwd,文件面板首次打开时
  // 若 exec 探测不可用,可作为初始目录的兜底。格式不符一律忽略,不吃掉事件。
  try {
    term.parser.registerOscHandler(7, (data) => {
      let p = String(data || '');
      if (p.startsWith('file://')) {
        const i = p.indexOf('/', 'file://'.length);
        if (i < 0) return false;
        p = p.slice(i);
      }
      if (!p.startsWith('/')) return false;
      try { p = decodeURIComponent(p); } catch { /* 编码异常按原文处理 */ }
      session.remoteCwd = p;
      return false; // 不吞事件:其它观察者(如有)仍可见
    });
  } catch { /* 老版本 xterm 无 parser API:跳过 */ }
  // 备用屏幕(alt screen)跟踪:top/vim/less/htop 等全屏程序用 DEC 私有模式
  // ?1049(老程序 ?47/?1047)切换屏幕缓冲区,期间敲的是程序快捷键,见
  // consumeCommandKeys。返回 false 不吞事件,xterm 自身仍要执行切换。
  try {
    const altScreenEdge = (on) => (params) => {
      for (const p of params) {
        const mode = Array.isArray(p) ? p[0] : p;
        if (mode === 1049 || mode === 47 || mode === 1047) setAltScreen(session, on);
      }
      return false;
    };
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, altScreenEdge(true));
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, altScreenEdge(false));
  } catch { /* 老版本 xterm 无 parser API:跳过 */ }
  state.sessions.set(sessionId, session);
  // e2e 钩子:WebGL 渲染下终端文本不再出现在 .xterm-rows 的 DOM 里,
  // 测试统一从这里读(基于 buffer API,渲染无关)。
  if (window.__NB_E2E__) {
    window.__NB_TERM_TEXT__ = () => {
      const s = state.sessions.get(state.activeId);
      if (!s) return '';
      const buf = s.term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
      }
      return lines.join('\n');
    };
  }
  tab.sessionId = sessionId;
  syncTabChrome();
  // 走统一的激活路径:打上 .focused、刷新状态栏、fit 并聚焦。
  // (activateTab 在"已是当前标签"时提前返回,不会清空 DOM 把刚挂好的终端摘掉。)
  if (shouldActivate) activateSession(sessionId);
  updateWelcome();
  session.pendingFirstPaint = true;
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
export function firstPaint(session) {
  const { term, pane, fit } = session;
  if (!term || !pane || session._paintTimer) return;

  // 可见性判定读 buffer 而非 DOM:WebGL 渲染下文本画在 canvas 上,
  // .xterm-rows 恒为空,DOM 判定会让下面的有界轮询空转满 1.5 秒(反复 resize 抖动)。
  // buffer 是两种渲染器共用的数据源,"内容已到达"即可停轮询。
  const hasText = () => {
    const buf = term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).trim()) return true;
    }
    return false;
  };
  const repaint = () => {
    if (!visibleSessions().includes(session)) return;
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

  if (!hasText()) repaint();
  if (hasText()) return;

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
    if (!hasText()) repaint();
    if (hasText() || elapsed >= LIMIT) {
      clearInterval(session._paintTimer);
      session._paintTimer = null;
    }
  }, STEP);
}

export function activateSession(sessionId, { focus = true } = {}) {
  const s = state.sessions.get(sessionId);
  const tab = s && state.tabs.get(s.tabId);
  if (!s || !tab) return;
  const changed = state.activeTabId !== tab.id;
  const selectionChanged = changed || state.activeId !== sessionId;
  setActiveTabId(tab.id);
  if (tab.zoomPaneId && tab.zoomPaneId !== s.paneId) {
    tab.zoomPaneId = null;
    renderLayout();
  } else if (changed && state.workspace?.mode !== 'tiled') renderLayout();
  if (selectionChanged) focusRevision++;
  state.activeId = sessionId;
  tab.activePaneId = null;
  tab.sessionId = sessionId;
  syncFocusedPane(tab.id, s.paneId);
  if (visibleSessions().includes(s)) {
    try { s.fit.fit(); } catch { /* ignore */ }
    // focusin re-enters with focus:false. Neither that event nor deferred fits
    // may recursively focus or replace the workspace tree.
    if (focus && !hasOpenModal()) { try { s.term.focus(); } catch { /* ignore */ } }
  }
  syncTabChrome();
  updateStatusbar(s);
  if (selectionChanged) loadSessionLogState(s);
  closeSnippetMenu();
  renderMonitorBar();
}

/// 关闭会话。有传输任务借用该连接时,先经确认底座;closeTab 已做过
/// 汇总确认,传 checkTransfers:false 直接进入关闭流程。
export function closeSession(sessionId, opts = {}) {
  if (!state.sessions.has(sessionId)) return;
  if (opts.checkTransfers !== false) {
    confirmTransferInterrupt([sessionId]).then((ok) => { if (ok) closeSessionNow(sessionId); });
    return;
  }
  closeSessionNow(sessionId);
}

function closeSessionNow(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  disconnectSession(sessionId);
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
  if (tab?.closing) return;
  if (tab && tab.layout) reflowIfSplitting(undefined, tab);
  if (tab && tab.sessionId === sessionId) {
    // 该标签的主会话被关闭:改为挂载标签内其余会话,无则保留空标签
    const rest = [...state.sessions.values()].find((x) => x.tabId === tab.id);
    tab.sessionId = rest ? rest.sessionId : null;
  }
  const wasActive = state.activeId === sessionId;
  if (wasActive) state.activeId = null;
  if (tab && !tab.panes.size) { closeTab(tab.id); return; }
  syncTabChrome();
  if (tab?.id === state.activeTabId || state.workspace?.mode === 'tiled') renderLayout();
  if (wasActive && tab) {
    if (tab.sessionId) activateSession(tab.sessionId, { focus: false });
    else activatePane(tab.id, firstLeafPaneId(tab.layout), false);
  }
  refreshBroadcast();
  updateWelcome();
}

/// 会话状态变化后刷新标签外观(标题与状态点取自该标签的主会话)
export function updateTab(session) {
  syncTabChrome();
  syncPaneButtons(state.tabs.get(session?.tabId) || activeTab());
  syncPaneStatusBanner(session);
}

export function updateStatusbar(session, error = session?.lastError) {
  notifyTerminalStateChange();
  const dot = $('#status-dot');
  const text = $('#status-text');
  const btnRe = $('#btn-reconnect');
  const btnDis = $('#btn-disconnect');
  const btnRo = $('#btn-readonly');
  const btnClear = $('#btn-clear');
  const btnLog = $('#btn-log-toggle');
  const roBadge = $('#ro-badge');
  // 按钮一律常驻、用禁用态表达可用性,不再随状态显隐 —— 此前"断开↔重连"互换、
  // 三个会话按钮随状态出现/消失,都会让整排按钮左右跳动,热区不固定。
  // 禁用原因写进 title,而不是让用户点了才知道为什么没反应。
  // 处理函数里的状态防御保持不变(禁用按钮本就点不动)。
  const setBtn = (btn, enabled, why) => { btn.disabled = !enabled; if (why) btn.title = why; };
  if (!session) {
    dot.className = 'dot idle';
    text.textContent = '就绪 — 尚未建立连接';
    for (const b of [btnRe, btnDis, btnRo, btnClear, btnLog]) setBtn(b, false, '未建立连接');
    roBadge.classList.add('hidden');
    return;
  }
  const label = `${session.host.username}@${session.host.host}:${session.host.port}`;
  const connected = session.status === 'connected';
  const connecting = session.status === 'connecting';
  roBadge.classList.toggle('hidden', !session.readOnly);
  setBtn(btnRo, connected, connected ? (session.readOnly ? '关闭只读模式' : '只读模式,防止误触') : '连接后才可切换只读');
  setBtn(btnClear, connected, connected ? '清屏并清空回滚' : '连接后才可清屏');
  setBtn(btnLog, connected, connected ? (session.logActive ? `停止输出日志${session.logFile ? ' · ' + session.logFile : ''}` : '记录终端输出到文件（不记录输入）') : '连接后才可记录日志');
  // 录制中用红色呼吸点表达(此前靠文字"⏺ 记录中"切换,图标化后移到颜色与 title 上)
  btnLog.classList.toggle('recording', connected && !!session.logActive);
  if (connected) {
    dot.className = 'dot connected';
    text.textContent = `已连接 ${label}` + (state.broadcast && state.broadcast.has(session.sessionId) ? ' · 广播中' : '');
    setBtn(btnRe, false, '已连接');
    setBtn(btnDis, true, '断开连接');
  } else if (connecting) {
    dot.className = 'dot connecting';
    text.textContent = `正在连接 ${label}…`;
    setBtn(btnRe, false, '正在连接');
    setBtn(btnDis, true, '取消连接');
  } else {
    dot.className = 'dot ' + session.status;
    const seconds = Math.max(0, Math.ceil(((session.reconnectDueAt || 0) - Date.now()) / 1000));
    const retry = session.reconnectScheduled ? ` · 自动重连 ${session.reconnectAttempt}/3（${seconds} 秒后）` : '';
    // Strip only at the display boundary; lastError retains fingerprint metadata for trust/retry logic.
    const displayError = stripFpMark(error);
    text.textContent = `已断开 ${label}` + (displayError ? `（${displayError}）` : '') + retry;
    setBtn(btnRe, true, '重连');
    setBtn(btnDis, !!session.reconnectScheduled, session.reconnectScheduled ? '取消自动重连' : '连接已断开');
  }
}

// 窗格内的就地状态横幅:状态栏只反映活动会话,分屏里非活动窗格断开时终端画面
// 静止、毫无反馈,用户甚至不知道哪一格死了。每个窗格底部悬浮一条说明(原因 +
// 重连方式),connected 后移除。仅按 Enter 重连,见 createSession 的 onData 分流;
// 横幅可接收悬停(完整错误进 title)但不拦截任何语义:点击会冒泡到窗格照常激活。
export function syncPaneStatusBanner(session, error = session?.lastError) {
  const pane = session?.pane;
  if (!pane || typeof pane.querySelector !== 'function') return;
  let el = pane.querySelector('.pane-status-banner');
  if (session.status === 'connected') { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'pane-status-banner';
    pane.appendChild(el);
  }
  const label = `${session.host.username}@${session.host.host}:${session.host.port}`;
  const connecting = session.status === 'connecting';
  const seconds = Math.max(0, Math.ceil(((session.reconnectDueAt || 0) - Date.now()) / 1000));
  const retry = !connecting && session.reconnectScheduled ? ` · 自动重连 ${session.reconnectAttempt}/3（${seconds} 秒后）` : '';
  // 手动断开没有"原因"可言,lastError 可能还是上一次失败的残留,一并隐去。
  const displayError = !connecting && !session.manualDisconnect ? stripFpMark(error) : '';
  const text = connecting ? `正在连接 ${label}…` : `已断开 ${label}` + (displayError ? `（${displayError}）` : '') + retry;
  el.className = 'pane-status-banner' + (connecting ? ' connecting' : ' disconnected');
  // 长错误在横幅里会省略号截断,完整原因放 title 悬停可读。
  el.title = displayError || '';
  el.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'psb-dot';
  const body = document.createElement('span');
  body.className = 'psb-text';
  body.textContent = text;
  el.appendChild(dot);
  el.appendChild(body);
  if (!connecting) {
    const hint = document.createElement('span');
    hint.className = 'psb-hint';
    hint.textContent = session.reconnectScheduled ? '按 Enter 立即重连' : '按 Enter 重新连接';
    el.appendChild(hint);
  }
}

// 指纹变更:后端在连接错误里附加可机读标记 [NB-FP host:port|旧指纹|新指纹],
// 解析见 core.js 的 parseFpError。这里是"变更后如何恢复"的交互。
/// 指纹变更的一键恢复:确认后删除该记录并重连。
/// 关键在"确认"而非"自动":变更可能是重装,也可能是中间人。弹窗把当前/上次指纹
/// 都摆出来,且默认焦点落在"取消"(见 core.js 的 defaultFocus),
/// 逼用户做出明确判断 —— 这仍是安全提示,只是不再让用户自己去翻指纹列表。
export async function offerFpRetrust(session, info) {
  const ok = await askConfirm(
    `服务器「${info.key}」的 SSH 主机指纹与本地记录不一致。\n\n` +
    `本地记录：${info.stored}\n服务器出示：${info.current}\n\n` +
    '服务器重装系统、更换主机密钥会如此；被中间人冒充也会如此。\n' +
    '确认这是你的服务器后，可删除旧记录并重新信任（若无法确认，请先核实服务器状态）。',
    { title: '服务器指纹已变更', okText: '重新信任并重连', cancelText: '不信任（取消）', danger: true, defaultFocus: 'cancel' },
  );
  if (!ok) return;
  await api('fingerprints:delete', { id: info.key });
  // Reuse the same terminal, pane and tab; only transport is replaced.
  if (!session || state.sessions.get(session.sessionId) !== session) return;
  await reconnectSession(session.sessionId);
}

const MAX_RETRIES = 3;
export function isRetryableNetworkError(why) {
  const text = String(why || '');
  if (parseFpError(text) || /auth|password|credential|private.?key|fingerprint|unknown.?key|cancel|认证|密码|私钥|指纹|取消/i.test(text)) return false;
  return /network|socket|connection|timed? ?out|timeout|reset|broken pipe|eof|keepalive|disconnect|closed|连接|网络|超时|断开/i.test(text);
}

function cancelReconnect(s) {
  clearTimeout(s.reconnectTimer);
  clearInterval(s.reconnectCountdownTimer);
  s.reconnectCountdownTimer = null;
  s.reconnectDueAt = null;
  s.reconnectTimer = null;
  s.reconnectScheduled = false;
}

export async function disconnectSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (s) {
    cancelReconnect(s);
    s.connectionEpoch = (s.connectionEpoch || 0) + 1;
    s.manualDisconnect = true;
    s.status = 'disconnected';
    // 后端断连不发 ssh:status(事件只覆盖网络侧断开),这里直接同步文件分屏状态。
    syncFilePanesForSession(sessionId);
    updateTab(s);
    if (state.activeId === sessionId) updateStatusbar(s);
    refreshBroadcast();
  }
  try { await api('ssh:disconnect', { sessionId }); return true; } catch { return false; }
}

export async function writeSessionInput(sessionId, data) {
  const s = state.sessions.get(sessionId);
  if (!s || s.status !== 'connected' || s.readOnly || s.manualDisconnect || hasOpenModal()) return false;
  try { await api('ssh:write', { sessionId, data }); return true; } catch { return false; }
}

// A command block is one submission, not one submission per pasted newline.
// Share collection with manual input so entry.js's existing output listener works
// unchanged. Start before IPC: output may arrive before ssh:write resolves.
const commandCollections = new WeakMap();
function beginCommandCollection(session, cmd) {
  const revision = {};
  commandCollections.set(session, revision);
  session.lastCmd = cmd;
  session.lastOutput = '';
  session.collectOutput = true;
  return revision;
}

function addCommandHistory(session, cmd) {
  if (cmd) api('history:add', { hostId: session.host.id, host: `${session.host.username}@${session.host.host}`, cmd }).catch(() => {});
}

// 命令行采集:输入累积进 histBuf,遇回车切出一条命令并开启它的输出采集。
// 备用屏幕(alt screen)期间的按键是 top/vim/less 等全屏 TUI 的程序快捷键而非
// 命令行,不采集 —— 否则无回车的快捷键(M/q/方向键)滞留 histBuf,拼进下一条
// 真实命令(诊断素材把 "llll" 变成 "MDCCCqllll"),TUI 里的回车快捷键(:wq)
// 还会被误记成命令历史。边界由 openTerminal 的 CSI ?1049/?47/?1047 钩子驱动。
// 代价:tmux 客户端整体运行在备用屏幕里,其内层会话的命令采集会暂停(历史与
// lastCmd 不更新),lastOutput 仍在累积,诊断素材不至完全失效。
function consumeCommandKeys(s, d) {
  if (s.inAltScreen) return;
  s.histBuf += d;
  // 多字符 chunk(粘贴)也要逐字符识别回车;保留原有手动输入解析行为。
  let idx;
  while ((idx = s.histBuf.indexOf('\r')) >= 0) {
    const cmd = s.histBuf.slice(0, idx).replace(/[\x08\x7f]/g, '').trim(); // 清理退格控制符
    s.histBuf = s.histBuf.slice(idx + 1);
    beginCommandCollection(s, cmd);
    addCommandHistory(s, cmd);
  }
}

// 备用屏幕切换边界。进入时清一次 histBuf:切换序列被解析前的一瞬间敲下的按键
// 已不可能属于命令行,丢弃最干净。退出不需要清:TUI 期间的按键从未入库。
function setAltScreen(s, on) {
  if (s.inAltScreen === on) return;
  s.inAltScreen = on;
  if (on) s.histBuf = '';
}

// Keep owner identities privately: callers cannot retarget a confirmation by
// editing IDs, and replacing a tab/pane with the same ID cannot revive it.
const commandBlockTargets = new WeakMap();
function commandBlockTargetAvailability(target) {
  const owner = target && commandBlockTargets.get(target);
  if (!owner) return { ok: false, reason: '命令目标无效，请重新选择当前终端' };
  const s = target.session;
  if (state.sessions.get(target.sessionId) !== s || s.sessionId !== target.sessionId) return { ok: false, reason: '目标会话已关闭或被替换' };
  if (s.connectionEpoch !== target.connectionEpoch) return { ok: false, reason: '目标连接已变化，请重新确认' };
  if (target.activationRevision !== focusRevision || state.activeId !== target.sessionId || state.activeTabId !== target.tabId) return { ok: false, reason: '活动终端已变化，请重新确认' };
  if (s.tabId !== target.tabId || s.paneId !== target.paneId || state.tabs.get(target.tabId) !== owner.tab
    || owner.tab.closing || owner.tab.panes.get(target.paneId) !== owner.pane
    || owner.pane.sessionId !== target.sessionId || owner.pane.el !== s.pane) return { ok: false, reason: '目标标签或窗格已变化' };
  if (s.manualDisconnect) return { ok: false, reason: '目标会话已手动断开' };
  if (s.status !== 'connected') return { ok: false, reason: '目标会话未连接' };
  if (s.readOnly) return { ok: false, reason: '目标会话处于只读模式' };
  if (!s.term || !visibleSessions().includes(s)) return { ok: false, reason: '目标终端窗格不可见' };
  if (hasOpenModal()) return { ok: false, reason: '请先关闭确认对话框或其他模态窗口' };
  return { ok: true };
}

/** Capture only state.activeId at click time; never fall back to another session. */
export function getCommandBlockTarget() {
  const session = state.sessions.get(state.activeId);
  if (!session) return { ok: false, reason: '当前没有活动终端会话' };
  const tab = state.tabs.get(session.tabId);
  const pane = tab?.panes.get(session.paneId);
  if (!tab || !pane) return { ok: false, reason: '当前终端没有有效标签或窗格' };
  const host = session.host;
  const target = Object.freeze({
    session, sessionId: session.sessionId, connectionEpoch: session.connectionEpoch,
    tabId: session.tabId, paneId: session.paneId, activationRevision: focusRevision,
    label: `${tab.customTitle || host.name || host.host} · ${host.username}@${host.host}:${host.port} · 窗格 ${[...tab.panes.keys()].indexOf(session.paneId) + 1}`,
  });
  commandBlockTargets.set(target, { tab, pane });
  const status = commandBlockTargetAvailability(target);
  return status.ok ? { ok: true, target } : status;
}

/** Eligibility for both execute and fill-only; checking does not send input. */
export function commandBlockTargetStatus(target, text) {
  const status = commandBlockTargetAvailability(target);
  if (!status.ok) return status;
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: '命令文本为空或无效' };
  // TAB/LF/CRLF only. Reject bare CR, ESC (including paste terminators), all
  // other C0 controls, DEL and C1 controls before adding our own input framing.
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text.replace(/\r\n/g, '\n'))) return { ok: false, reason: '命令包含不允许的控制字符' };
  if (target.session.term.modes?.bracketedPasteMode !== true) {
    if (text.includes('\n')) return { ok: false, reason: '多行命令需要终端启用 bracketed paste 模式' };
    if (text.includes('\t')) return { ok: false, reason: '含 TAB 的命令需要终端启用 bracketed paste 模式' };
  }
  return { ok: true };
}

/** Success means sent to SSH, not that the remote command has completed. */
export async function submitCommandBlock(target, text, { execute = true } = {}) {
  const status = commandBlockTargetStatus(target, text);
  if (!status.ok) return status;
  const s = target.session;
  const normalized = text.replace(/\r\n|\n/g, '\r');
  const pasted = s.term.modes?.bracketedPasteMode === true ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  const previous = { histBuf: s.histBuf, lastCmd: s.lastCmd, lastOutput: s.lastOutput, collectOutput: s.collectOutput, collection: commandCollections.get(s) };
  // Store pasted newlines as LF in the history buffer, not Enter events. A later
  // manual Enter on fill-only records the block once, without protocol framing.
  const histBuf = execute ? '' : (s.histBuf || '') + text.replace(/\r\n/g, '\n');
  s.histBuf = histBuf;
  const collection = execute ? beginCommandCollection(s, text) : commandCollections.get(s);
  // No await between final eligibility and this one write; never term.paste(),
  // term.input(), broadcast, automatic Ctrl+C or automatic line clearing.
  const sent = await writeSessionInput(target.sessionId, pasted + (execute ? '\r' : ''));
  if (!sent) {
    // Do not roll back newer input/commands or a replacement connection.
    if (state.sessions.get(target.sessionId) === s && s.connectionEpoch === target.connectionEpoch
      && commandCollections.get(s) === collection && s.histBuf === histBuf) {
      s.histBuf = previous.histBuf;
      if (execute) {
        s.lastCmd = previous.lastCmd;
        s.lastOutput = previous.lastOutput;
        s.collectOutput = previous.collectOutput;
        if (previous.collection) commandCollections.set(s, previous.collection);
        else commandCollections.delete(s);
      }
    }
    return { ok: false, reason: '命令发送失败，未确认发送成功' };
  }
  if (execute) addCommandHistory(s, text);
  // A slow write may resolve after the user switches targets or opens a modal.
  // Never steal that focus, or reactivate the captured session after awaiting.
  if (commandBlockTargetAvailability(target).ok) { try { s.term.focus(); } catch { /* ignore */ } }
  return { ok: true };
}

async function runSessionConnection(s, automatic = false) {
  if (state.sessions.get(s.sessionId) !== s) return false;
  const epoch = s.connectionEpoch = (s.connectionEpoch || 0) + 1;
  s.manualDisconnect = false;
  s.status = 'connecting';
  updateTab(s);
  if (state.activeId === s.sessionId) updateStatusbar(s);
  refreshBroadcast();
  try {
    const descriptor = s.connection;
    const result = await api(descriptor.kind === 'quick' ? 'ssh:connectQuick' : 'ssh:connect', descriptor.kind === 'quick'
      ? { host: descriptor.host, sessionId: s.sessionId }
      : { hostId: descriptor.hostId, sessionId: s.sessionId });
    if (state.sessions.get(s.sessionId) !== s || s.connectionEpoch !== epoch || s.manualDisconnect) return false;
    if (result?.cancelled) {
      s.status = 'disconnected';
      updateTab(s);
      if (state.activeId === s.sessionId) updateStatusbar(s);
      refreshBroadcast();
      return false;
    }
    if (s.status === 'connecting') handleSessionStatus({ sessionId: s.sessionId, state: 'connected' });
    if (s.status !== 'connected') return false;
    if (s.readOnly) await api('ssh:setReadonly', { sessionId: s.sessionId, readOnly: true });
    // initcmd is lifecycle input, not modal-scoped user input. Epoch/status still gate it.
    if (s.host.initcmd && !s.initcmdExecuted && !s.readOnly && state.sessions.get(s.sessionId) === s && s.connectionEpoch === epoch && !s.manualDisconnect && s.status === 'connected') {
      await api('ssh:write', { sessionId: s.sessionId, data: s.host.initcmd + '\r' });
      s.initcmdExecuted = true;
    }
    return true;
  } catch (e) {
    if (state.sessions.get(s.sessionId) !== s || s.connectionEpoch !== epoch || s.manualDisconnect) return false;
    const why = e?.message || String(e);
    s.status = 'error';
    s.lastError = why;
    updateTab(s);
    if (state.activeId === s.sessionId) updateStatusbar(s, why);
    refreshBroadcast();
    const fp = parseFpError(why);
    if (fp) offerFpRetrust(s, fp);
    else if (automatic) scheduleReconnect(s.sessionId, why);
    else toast('连接失败：' + stripFpMark(why), 'error');
    return false;
  }
}

export async function reconnectSession(sessionId) {
  const s = state.sessions.get(sessionId);
  if (!s || s.reconnectStarting || s.status === 'connected' || s.status === 'connecting') return false;
  s.reconnectStarting = true;
  cancelReconnect(s);
  s.reconnectAttempt = 0;
  const disconnectEpoch = (s.connectionEpoch || 0) + 1;
  try {
    await disconnectSession(sessionId);
    if (state.sessions.get(sessionId) !== s || s.connectionEpoch !== disconnectEpoch) return false;
    return await runSessionConnection(s);
  } finally {
    s.reconnectStarting = false;
  }
}

// Retry only a previously established connection, never initial auth/setup failure.
export function scheduleReconnect(sessionId, why) {
  const s = state.sessions.get(sessionId);
  if (!s || !s.everConnected || s.manualDisconnect || s.reconnectTimer || s.reconnectAttempt >= MAX_RETRIES || !isRetryableNetworkError(why)) return false;
  s.reconnectAttempt += 1;
  s.reconnectScheduled = true;
  const delay = 1000 * 2 ** (s.reconnectAttempt - 1);
  s.reconnectDueAt = Date.now() + delay;
  s.reconnectCountdownTimer = setInterval(() => {
    if (state.activeId === sessionId) updateStatusbar(s, why);
    // 倒计时也要推进非活动窗格的横幅,否则后台分屏显示的秒数会冻结。
    syncPaneStatusBanner(s, why);
  }, 1000);
  s.reconnectTimer = setTimeout(() => {
    cancelReconnect(s);
    if (state.sessions.get(sessionId) !== s || s.manualDisconnect || s.status === 'connected' || s.status === 'connecting') return;
    runSessionConnection(s, true);
  }, delay);
  if (state.activeId === sessionId) updateStatusbar(s, why);
  syncPaneStatusBanner(s, why);
  return true;
}

export function handleSessionStatus({ sessionId, state: status, error, reason, code }) {
  const s = state.sessions.get(sessionId);
  if (!s || s.manualDisconnect) return false;
  s.status = status;
  s.lastError = error || '';
  if (status === 'connected') {
    cancelReconnect(s);
    s.everConnected = true;
    s.reconnectAttempt = 0;
    scheduleResizeSync();
  } else if (status === 'disconnected' || status === 'error' || status === 'exited') {
    stopLogIfActive(sessionId);
    const why = error || (reason === 'network' ? 'network connection closed' : '');
    if (why && code == null) scheduleReconnect(sessionId, why);
  }
  updateTab(s);
  if (state.activeId === sessionId) updateStatusbar(s, error);
  refreshBroadcast();
  renderMonitorBar();
  return true;
}

export async function connectHost(hostId, paneId, opts = {}) {
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host) return;
  if (!opts.force && !opts.newTab) {
    const existing = [...state.sessions.values()].find((s) => s.host.id === hostId && ['connected', 'connecting'].includes(s.status));
    if (existing) { activateSession(existing.sessionId); return existing; }
  }
  const owner = paneId ? paneOwner(paneId, opts.tabId) : null;
  if (paneId && (!owner || owner.panes.get(paneId).sessionId)) return null;
  const session = createSession(host, paneId, paneId ? owner.id : createTab().id);
  if (!session) return null;
  await runSessionConnection(session);
  return session;
}

// 快速连接(A2):不入库,凭据仅驻内存
export function parseQuickTarget(text) {
  const m = String(text || '').trim().match(/^(?:([\w.-]+)@)?([\w.-]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1] || 'root', host: m[2], port: Number(m[3]) || 22 };
}

export async function quickConnect(parsed, paneId, tabId) {
  const owner = paneId ? paneOwner(paneId, tabId) : null;
  if (paneId && (!owner || owner.panes.get(paneId).sessionId)) return null;
  const revision = focusRevision;
  const credentials = { ...parsed, authType: parsed.authType || 'password' };
  if (credentials.authType === 'password' && credentials.password == null) {
    const password = await askPrompt(`输入 ${parsed.username}@${parsed.host} 的密码`, { title: '快速连接', password: true, okText: '连接' });
    if (password === null) return null;
    credentials.password = password;
  }
  // A picker/password dialog can outlive its tab. Never resurrect a closed
  // target, overwrite an occupied pane, or activate a different tab after await.
  if (paneId && (paneOwner(paneId, owner.id) !== owner || owner.panes.get(paneId).sessionId)) return null;
  const host = { id: 'quick-' + crypto.randomUUID(), quick: true, name: `${parsed.host}:${parsed.port}`, ...credentials };
  const session = createSession(host, paneId, paneId ? owner.id : createTab().id, undefined, { activate: revision === focusRevision && (!owner || state.activeTabId === owner.id) });
  if (!session) return null;
  await runSessionConnection(session);
  return session;
}

export function fitActive() {
  const s = state.sessions.get(state.activeId);
  if (!s || !visibleSessions().includes(s)) return;
  try {
    s.fit.fit();
    if (s.status === 'connected') {
      api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  } catch { /* ignore */ }
}

export function updateWelcome() {
  $('#welcome').classList.toggle('hidden', state.workspace?.mode === 'tiled' ? state.tabs.size > 0 : !!state.layout);
}

/* ---------------- 云主机导入(多账号 + 全区域一键拉取) ---------------- */

export function activeSearch() {
  const s = state.sessions.get(state.activeId);
  return s ? s.search : null;
}

export function openTermSearch() {
  if (!state.sessions.size) return toast('请先连接主机', 'error');
  $('#term-search').classList.remove('hidden');
  $('#term-search-input').focus();
  $('#term-search-input').select();
}

export function closeTermSearch() {
  $('#term-search').classList.add('hidden');
  const s = state.sessions.get(state.activeId);
  if (s) { try { s.search.clearDecorations(); } catch { /* ignore */ } s.term.focus(); }
  $('#term-search-count').textContent = '';
}

export function doTermSearch(backwards) {
  const q = $('#term-search-input').value;
  const addon = activeSearch();
  if (!q || !addon) return;
  try {
    addon.findNext(q, { backwards: !!backwards, incremental: true });
    $('#term-search-count').textContent = '';
  } catch { /* ignore */ }
}

/* ---------------- 终端设置 ---------------- */

export function writableBroadcastSessions() {
  return [...(state.broadcast || [])].map((id) => state.sessions.get(id)).filter((s) => s && s.status === 'connected' && !s.readOnly && !s.manualDisconnect);
}

export function setBroadcast(sessionIds) {
  state.broadcast = sessionIds && sessionIds.size ? new Set(sessionIds) : null;
  refreshBroadcast();
}

export function refreshBroadcast() {
  document.body.classList.toggle('broadcasting', !!state.broadcast);
  notifyTerminalStateChange();
  let bar = $('#broadcast-bar');
  if (state.broadcast) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'broadcast-bar';
      $('#tabbar').insertAdjacentElement('afterend', bar);
    }
    bar.classList.remove('hidden');
    bar.innerHTML = `<b>${icon('megaphone')} 广播中 → ${writableBroadcastSessions().length} 个可写会话（已选 ${state.broadcast.size}）</b><span class="grow"></span><button id="btn-broadcast-stop" class="btn sm">停止广播</button>`;
    $('#btn-broadcast-stop').addEventListener('click', () => setBroadcast(null));
  } else if (bar) {
    bar.classList.add('hidden');
  }
  const s = state.sessions.get(state.activeId);
  if (s) updateStatusbar(s);
}

/// 广播期间从窗格工具条加入或退出某个会话;最后一个会话退出即停止广播。
export function toggleBroadcastMember(sessionId) {
  if (!state.broadcast) return;
  const next = new Set(state.broadcast);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  setBroadcast(next);
  if (!next.size) toast('广播已停止', 'success');
}

/// 广播范围预设:当前标签全部窗格 / 全部已连接会话 / 自定义(手动勾选即切到自定义)。
/// "当前"指 opts.sessionId(窗格工具条、右键菜单的显式目标),缺省为活动会话。
export const BROADCAST_SCOPES = [
  { value: 'tab', label: '当前标签全部窗格' },
  { value: 'all', label: '全部已连接会话' },
  { value: 'custom', label: '自定义' },
];

export function broadcastScopeIds(scope, sessions, anchor) {
  if (scope === 'tab') return sessions.filter((s) => anchor && s.tabId === anchor.tabId).map((s) => s.sessionId);
  if (scope === 'all') return sessions.map((s) => s.sessionId);
  return null;
}

export function openBroadcastPicker(opts = {}) {
  const connected = [...state.sessions.values()].filter((s) => s.status === 'connected' && !s.readOnly);
  if (state.broadcast) return setBroadcast(null); // 再点一次关闭
  if (connected.length < 1) return toast('没有已连接的会话', 'error');
  const currentId = opts.sessionId || state.activeId;
  const anchor = state.sessions.get(currentId) || null;
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.id = 'modal-broadcast';
  const scopes = BROADCAST_SCOPES.map((o) => `<label><input type="radio" name="bc-scope" value="${o.value}"${o.value === 'all' ? ' checked' : ''} /> ${o.label}</label>`).join('');
  overlay.innerHTML = `<div class="modal-card"><h3>广播输入</h3>
    <div class="bc-scope" role="radiogroup" aria-label="广播范围">${scopes}</div>
    <div class="batch-hosts" id="bc-list"></div>
    <div class="modal-actions"><button class="btn" id="bc-cancel">取消</button><button class="btn primary" id="bc-ok">开始广播</button></div></div>`;
  const list = overlay.querySelector('#bc-list');
  // 默认全部已连接会话(广播的典型意图是"下发到所有"),"当前"会话置顶
  const ordered = [...connected].sort((a, b) => (a.sessionId === currentId ? -1 : b.sessionId === currentId ? 1 : 0));
  for (const s of ordered) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${s.sessionId}" checked /> ${escapeHtml(s.host.name)} · ${escapeHtml(s.host.username)}@${escapeHtml(s.host.host)}${s.sessionId === currentId ? ' <span class="tag">当前</span>' : ''}`;
    list.appendChild(label);
  }
  const tabScope = overlay.querySelector('input[name="bc-scope"][value="tab"]');
  if (!anchor || !connected.some((s) => s.tabId === anchor.tabId)) tabScope.disabled = true;
  overlay.querySelector('.bc-scope').addEventListener('change', (event) => {
    const ids = broadcastScopeIds(event.target.value, ordered, anchor);
    if (!ids) return;
    for (const box of list.querySelectorAll('input[type="checkbox"]')) box.checked = ids.includes(box.value);
  });
  list.addEventListener('change', () => {
    const boxes = [...list.querySelectorAll('input[type="checkbox"]')];
    const picked = boxes.filter((b) => b.checked).map((b) => b.value);
    const match = ['tab', 'all'].find((scope) => {
      const ids = broadcastScopeIds(scope, ordered, anchor);
      return !(scope === 'tab' && tabScope.disabled) && ids.length === picked.length && ids.every((id) => picked.includes(id));
    }) || 'custom';
    overlay.querySelector(`input[name="bc-scope"][value="${match}"]`).checked = true;
  });
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

export async function toggleReadonly(sessionId = state.activeId) {
  const s = state.sessions.get(sessionId);
  if (!s || s.status !== 'connected') return;
  const previous = s.readOnly;
  s.readOnly = !previous;
  refreshBroadcast();
  try { await api('ssh:setReadonly', { sessionId: s.sessionId, readOnly: s.readOnly }); }
  catch { s.readOnly = previous; refreshBroadcast(); return toast('切换只读失败', 'error'); }
  if (state.activeId === s.sessionId) updateStatusbar(s);
  toast(s.readOnly ? '已开启只读模式' : '已关闭只读模式', 'success');
}

export function clearActiveTerm(sessionId = state.activeId) {
  const s = state.sessions.get(sessionId);
  if (!s) return;
  try { s.term.clear(); s.term.write('\x1b[2J\x1b[H'); } catch { /* ignore */ }
}

export async function toggleSessionLog(sessionId = state.activeId) {
  const s = state.sessions.get(sessionId);
  if (!s || s.status !== 'connected') return toast('请先连接主机', 'error');
  try {
    if (s.logActive) {
      try {
        const r = await api('log:stop', { sessionId: s.sessionId });
        toast('日志已保存到 ' + (r.file || ''), 'success');
      } finally { s.logActive = false; }
    } else {
      const r = await api('log:start', { sessionId: s.sessionId, hostLabel: `${s.host.name || s.host.host}`, timestamps: true, recordInput: false });
      s.logActive = true;
      s.logFile = r.file;
      toast('正在记录终端输出（不记录输入）:' + r.file, 'success');
    }
  } finally { if (state.activeId === s.sessionId) updateStatusbar(s); }
}

export function stopLogIfActive(sessionId) {
  const s = state.sessions.get(sessionId);
  if (s && s.logActive) { api('log:stop', { sessionId }).catch(() => {}); s.logActive = false; }
}

export function loadSessionLogState(s) {
  api('log:status', { sessionId: s.sessionId }).then((r) => {
    s.logActive = !!r.active;
    if (r.file) s.logFile = r.file;
    if (state.activeId === s.sessionId && state.sessions.get(s.sessionId) === s) updateStatusbar(s);
  }).catch(() => {});
}

/* ---------------- AI 模型切换(K6) + 诊断(K7) ---------------- */

