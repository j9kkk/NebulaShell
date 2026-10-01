// 终端会话:连接、标签与窗格、分屏、搜索、广播输入、只读、日志
import { $, accel, activeTab, api, askConfirm, askPrompt, closeCtxMenu, copyText, parseFpError, showCtxMenu, state, toast } from './core.js';
import { escapeHtml } from './hosts.js';
import { closeSnippetMenu, renderMonitorBar } from './monitor.js';
import { activeConnectedSession, initialFileDir, loadFileDir, renderFileTarget } from './sftp.js';
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
  el.innerHTML = '<span class="tab-dot connecting"></span><span class="tab-title">新标签</span><button class="tab-close" title="关闭标签">✕</button>';
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

/// 标签右键菜单:关闭类动作 + 重命名 + 复制地址 + 新建。
/// "关闭其他/右侧"按标签位置给出禁用态(已是唯一/最右时无意义),而不是藏起来 ——
/// 菜单项位置固定,才不会每次弹出都变一串。
export function openTabCtxMenu(x, y, tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  const ids = [...state.tabs.keys()];
  const idx = ids.indexOf(tabId);
  const firstSession = [...state.sessions.values()].find((s) => s.tabId === tabId);
  showCtxMenu(x, y, [
    { label: '关闭标签', key: accel('mod+W'), run: () => closeTab(tabId) },
    { label: '关闭其他标签', disabled: ids.length <= 1, run: () => { for (const id of ids) if (id !== tabId) closeTab(id); } },
    { label: '关闭右侧标签', disabled: idx >= ids.length - 1, run: () => { for (const id of ids.slice(idx + 1)) closeTab(id); } },
    '-',
    { label: '重命名…', run: () => renameTab(tabId) },
    {
      label: '复制主机地址', disabled: !firstSession, run: () => {
        const h = firstSession.host;
        copyText(`${h.username}@${h.host}:${h.port}`).then((ok) => toast(ok ? '已复制主机地址' : '复制失败', ok ? 'success' : 'error'));
      },
    },
    '-',
    { label: '新建标签', run: () => newTabWithPicker() },
  ]);
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
  state.activeTabId = tabId;
  for (const [id, t] of state.tabs) t.el.classList.toggle('active', id === tabId);
}

/// 切换标签:只挂载目标标签的窗格,其余标签的终端保留在内存中不销毁
export function activateTab(tabId) {
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
export function followFilePanel() {
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
  const remembered = s.lastFileDir;
  if (remembered) {
    loadFileDir(remembered).catch(() => {});
    return;
  }
  // 首次浏览该会话:默认落到「当前主机命令执行路径」(shell 实时 cwd,
  // 见 sftp.js initialFileDir),而不是家目录/根目录。
  initialFileDir(s).then((dir) => loadFileDir(dir).catch(() => {}));
}

/// 关闭标签:释放该标签下所有会话
export function closeTab(tabId) {
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

/// 同步标签标题/状态点(取该标签主会话;手动重命名的标签优先显示自定义名)
export function syncTabChrome() {
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
}

// —— 分屏布局(E3):二叉布局树,leaf 持有 paneId ——
export function newPaneId() { return 'pane-' + (++state.paneSeq); }

export function makePaneEl(paneId) {
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
  zoomBtn.title = `放大该窗格(${accel('mod+shift+Enter')} 还原)`;
  zoomBtn.textContent = '⤢';
  zoomBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePaneZoom(paneId); });
  el.appendChild(zoomBtn);
  return el;
}

// 布局树里的窗格(叶子)数量
export function leafCount(node) {
  if (!node) return 0;
  if (isLeaf(node)) return 1;
  return leafCount(node.a) + leafCount(node.b);
}

// 窗格放大/还原(竖向空间不足时的快速聚焦)
export function togglePaneZoom(paneId) {
  if (state.zoomPaneId === paneId) {
    state.zoomPaneId = null;
  } else {
    const pane = state.panes.get(paneId);
    if (!pane || !pane.sessionId) return toast('空窗格无需放大', 'error');
    // 只有一个窗格时"放大"没有任何视觉效果(本来就是全幅),
    // 若进入放大态只会留下"已放大"角标,让用户以为按钮坏了。
    if (leafCount(state.layout) <= 1) {
      return toast('当前只有一个窗格,无需放大', 'error');
    }
    state.zoomPaneId = paneId;
  }
  renderLayout();
}

export function rebalanceRatios(node) {
  if (isLeaf(node)) return node;
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
export function firstEmptyLeaf(node) {
  if (!node) return null;
  if (isLeaf(node)) {
    const pane = state.panes.get(node.paneId);
    return pane && !pane.sessionId ? node.paneId : null;
  }
  return firstEmptyLeaf(node.a) || firstEmptyLeaf(node.b);
}

export function renderLayout() {
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
  // 放大态但布局已塌缩成单窗格(如放大后关掉了另一窗格):
  // 视觉上与"未放大"完全一样,残留的"已放大"角标只会让用户以为按钮失效,故自动退出。
  if (state.zoomPaneId && leafCount(state.layout) <= 1) {
    state.zoomPaneId = null;
  }
  if (state.zoomPaneId && state.panes.has(state.zoomPaneId)) {
    // 放大模式:仅渲染目标窗格,独占终端区
    const pane = state.panes.get(state.zoomPaneId);
    pane.el.style.flex = '1 1 0';
    stack.appendChild(pane.el);
    const chip = document.createElement('span');
    chip.className = 'zoom-chip';
    chip.title = `点击还原布局(${accel('mod+shift+Enter')})`;
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
      zoomBtn.title = `放大该窗格(${accel('mod+shift+Enter')} 还原)`;
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
export function visibleSessions() {
  const tab = activeTab();
  if (!tab) return [];
  return [...state.sessions.values()].filter((s) => s.tabId === tab.id && s.pane && s.pane.isConnected);
}

export function attachDivider(div, node, aEl, bEl, wrap) {
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
export function renderPickers() {
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
export function splitActive(dir) {
  // 无活动标签时(欢迎页,还没连接过任何主机)先建标签再返回:
  // state.layout 是"当前标签"的访问器,没有标签时赋值会被静默丢弃,
  // 表现为"点了 ⛶ / 按 ⌘D 毫无反应"。新标签自带首个空窗格与选择器,
  // 对空应用而言"分屏"的正确结果就是开出第一块终端。
  if (!activeTab()) {
    newTabWithPicker();
    return;
  }
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
  // 新增分屏后自动整理为最优布局:手动分屏是"围绕当前窗格一刀切",连开几个
  // 之后长宽比严重失衡(比例还会被拖得五花八门)。用户新增分屏想要的是
  // "多一块可用区域",不是继承被反复切分的历史形状,故每次新增后重排成等分网格。
  reflowIfSplitting(dir);
}

/// 分屏数 ≥ 2 时把布局重排成等分网格。窗格对象与其中的会话都保留
/// (renderLayout 会重组 DOM,但终端实例不销毁),所有比例回到等分。
/// tab 默认当前标签 —— 但 createSession 可能操作"非活动标签",故允许显式传入。
/// dir 是"刚新增那一刀"的方向(h=左右并排 / v=上下堆叠),用于决定网格朝向。
export function reflowIfSplitting(dir, tab = activeTab()) {
  if (!tab || !tab.layout) return false;
  const ids = paneIdsInOrder(tab);
  if (ids.length <= 1) { renderLayout(); return false; }
  tab.layout = buildGrid(ids, dir);
  tab.zoomPaneId = null; // 整理后退出放大态,否则看不到整理结果
  renderLayout();
  return true;
}

/// 布局树里的窗格 id,按"视觉顺序"(先上后下、先左后右)展开。
/// 自动整理会改变窗格的相对位置;若按任意顺序重排,同一块终端会在每次
/// 新增分屏后跳到别的格子。按视觉顺序重排 = 原地整理。
export function paneIdsInOrder(tab) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (isLeaf(n)) { if (tab.panes.has(n.paneId)) out.push(n.paneId); return; }
    walk(n.a); walk(n.b);
  })(tab.layout);
  return out;
}

/// 把一组窗格 id 编成"接近正方形"的等分网格二叉布局。
/// 列数取 ceil(sqrt(n))(6 个 → 3 列 2 行);每行窗格数按 ceil(剩余/剩余行数)
/// 均摊,避免 7 个时排成 3+3+1 那样最后一行只剩一个。
/// dir 只在"朝向有歧义"时起作用:2 个窗格横竖都算正方,此时听用户的
/// (点了上下分屏就该得到上下两格);n ≥ 3 时若朝向与用户那一刀相反,
/// 交换行列即可 —— 仍是同一套均衡网格,只是整体转 90°。
export function buildGrid(paneIds, dir) {
  let cols = Math.ceil(Math.sqrt(paneIds.length));
  let rows = Math.ceil(paneIds.length / cols);
  if (dir === 'v' && cols > rows) { const t = cols; cols = rows; rows = t; }
  else if (dir === 'h' && rows > cols) { const t = cols; cols = rows; rows = t; }
  const perRow = [];
  let rest = paneIds.length;
  for (let r = 0; r < rows; r++) {
    const take = Math.ceil(rest / (rows - r));
    perRow.push(take);
    rest -= take;
  }
  // 横向把一段窗格均分:每次包一层,让"前 i 个"占 i/(i+1)
  const buildRow = (ids) => {
    let node = leaf(ids[0]);
    for (let i = 1; i < ids.length; i++) {
      node = { type: 'h', ratio: i / (i + 1), a: node, b: leaf(ids[i]) };
    }
    return node;
  };
  const rowNodes = [];
  let cursor = 0;
  for (const take of perRow) {
    const ids = paneIds.slice(cursor, cursor + take);
    cursor += take;
    if (ids.length) rowNodes.push(buildRow(ids));
  }
  // 纵向把各行均分(同 buildRow 的算法)
  let root = rowNodes[0];
  for (let i = 1; i < rowNodes.length; i++) {
    root = { type: 'v', ratio: i / (i + 1), a: root, b: rowNodes[i] };
  }
  return root;
}

export function activeLeafPaneId() {
  if (state.activePaneId) {
    const p = state.panes.get(state.activePaneId);
    if (p && !p.sessionId) return state.activePaneId;
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

/// 关闭标签内"最该关"的那个窗格:**优先空窗格**,其次才是当前焦点窗格。
/// 为什么不是"直接关焦点窗格":分屏后焦点一直留在会话窗格上(新建的空窗格
/// 不会抢走 .focused 标记),用户连开几个空窗格再点"关闭当前窗格",若按焦点
/// 就会先把正在用的连接关掉、把空窗格全留着 —— 与"撤销分屏"的意图正好相反。
/// 空窗格用后进先出:连续点关闭就是逐个撤销刚才的分屏。
export function pickPaneToClose(tab) {
  const empties = [...tab.panes.values()].filter((p) => !p.sessionId);
  if (empties.length) return empties[empties.length - 1].id;
  return focusedPaneId();
}

/// 关闭当前活动窗格(窗格内会话一并关闭;空窗格直接摘除)。
/// 这是"分屏开得进去、退不出来"的入口:此前只有 ⌘W 且必须先聚焦窗格,
/// 而空窗格(尚未选主机)连 ⌘W 都关不掉 —— 没有会话可关。
export function closeActivePane() {
  const tab = activeTab();
  if (!tab || !tab.layout) return toast('当前没有可分屏的窗格', 'error');
  if (leafCount(tab.layout) <= 1) return toast('只有一个窗格,无需关闭', 'error');
  const paneId = pickPaneToClose(tab);
  const pane = paneId ? tab.panes.get(paneId) : null;
  if (!pane) return toast('找不到当前窗格', 'error');
  // 有会话的窗格走 closeSession:它会断开连接、释放终端并从布局树摘除
  if (pane.sessionId) { closeSession(pane.sessionId); return; }
  // 空窗格:直接从布局树与窗格表摘除
  removePaneFromTab(tab, paneId);
  tab.panes.delete(paneId);
  if (tab.zoomPaneId === paneId) tab.zoomPaneId = null;
  if (tab.activePaneId === paneId) tab.activePaneId = null;
  tab.layout = rebalanceRatios(tab.layout);
  renderLayout();
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
  const cols = Math.ceil(Math.sqrt(paneIds.length));
  const rows = Math.ceil(paneIds.length / cols);
  tab.layout = buildGrid(paneIds);
  tab.zoomPaneId = null; // 整理后退出放大态,否则看不到整理结果
  renderLayout();
  toast(`已整理为 ${rows} × ${cols} 布局`, 'success');
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

export function createSession(host, paneId, tabId) {
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
  // 走到这里说明"该标签原本没有空窗格"(否则会在上面复用),即刚刚新增了一格。
  // 新格是在活动格旁一刀切出来的,布局随之偏斜;与 splitActive 一致地整理成
  // 等分网格。reflow 内部已调用 renderLayout,故不再重复渲染。
  if (tab.panes.size > 1) reflowIfSplitting('h', tab);
  else renderLayout(); // 先挂载窗格 DOM,再初始化终端

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
  // WebGL 渲染器:DOM 渲染器逐字符建 span,大批量输出(构建日志/vim/htop)时
  // 主线程掉帧,是终端输出流畅度的主要瓶颈。上下文丢失(GPU 重置/驱动切换、
  // GL 上下文数超限)时 dispose 自己,xterm 自动退回 DOM 渲染器,可用性不受影响。
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* ignore */ } });
    term.loadAddon(webgl);
  } catch { /* WebGL 不可用:保持 DOM 渲染器 */ }
  // innerHTML 清空会抹掉放大按钮,重新挂回
  const zb = document.createElement('button');
  zb.className = 'pane-zoom-btn';
  zb.title = `放大该窗格(${accel('mod+shift+Enter')} 还原)`;
  zb.textContent = '⤢';
  zb.addEventListener('mousedown', (e) => e.stopPropagation());
  zb.addEventListener('click', (e) => { e.stopPropagation(); togglePaneZoom(targetPaneId); });
  pane.appendChild(zb);

  // 输入:只读拦截(D9) / 广播分发(E5) / 命令历史采集(F2) / AI 诊断素材采集
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
      // AI 诊断素材:记住"最后一次提交的命令",并把输出采集窗口重开 ——
      // 下一条命令提交前收到的输出都归这条命令所有。
      s.lastCmd = cmd;
      s.lastOutput = '';
      s.collectOutput = true;
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
    // Ctrl/Cmd+C 按"是否存在选区"分流(Windows Terminal 同款规则):
    // 有选区 = 复制意图,绝不把 \x03 发给 shell —— 否则正在跑的命令立即被终止;
    // 无选区 = 中断意图,放行给 xterm 发 \x03(SIGINT),维持标准终端行为。
    // Shift/CapsLock 会把 ev.key 变成 'C',两种都要认,否则 Ctrl+Shift+C 是死键。
    // preventDefault 拦掉浏览器默认复制:终端选区是 xterm 内部状态(WebGL 渲染下
    // DOM 里没有选中文本),默认行为只会把别处 UI(AI 面板/主机列表)的 DOM 选区
    // 塞进剪贴板 —— 表现为"复制的不是选中的内容"。
    if (mod && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
      ev.preventDefault();
      if (ev.shiftKey || term.hasSelection()) {
        const sel = term.getSelection();
        if (sel) copyText(sel).then((ok) => { if (!ok) toast('复制失败：剪贴板不可用', 'error'); });
        return false;
      }
      return true;
    }
    if (mod && ev.key === 'v' && !ev.shiftKey) {
      // preventDefault 拦掉浏览器默认粘贴:否则 keydown 的默认动作会在 textarea
      // 上再触发一次原生 paste 事件,xterm 的粘贴监听器插入一次、下面的手动
      // readText 链路又插入一次 —— 粘贴内容出现两遍。
      ev.preventDefault();
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
      return false;
    }
    if (mod && (ev.key === 'f' || ev.key === 'd')) return false; // 交给全局快捷键(搜索/分屏)
    return true;
  });

  // 标签元素由标签模型持有(不再每个会话建一个标签):
  // 一个标签可在其内部承载多个分屏窗格。
  const session = { sessionId, host, term, fit, search, paneId: targetPaneId, pane, tabId: tab.id, status: 'connecting', readOnly: false, histBuf: '', reconnectAttempt: 0, remoteCwd: null, lastCmd: '', lastOutput: '', collectOutput: false };
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

export function activateSession(sessionId) {
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

export function closeSession(sessionId) {
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
export function updateTab(session) {
  void session;
  syncTabChrome();
}

export function updateStatusbar(session, error) {
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
  setBtn(btnLog, connected, connected ? (session.logActive ? '停止记录会话日志' : '记录会话日志到文件') : '连接后才可记录日志');
  // 录制中用红色呼吸点表达(此前靠文字"⏺ 记录中"切换,图标化后移到颜色与 title 上)
  btnLog.classList.toggle('recording', connected && !!session.logActive);
  if (connected) {
    dot.className = 'dot connected';
    text.textContent = `已连接 ${label}` + (state.broadcast && state.broadcast.has(session.sessionId) ? ' · 📢广播中' : '');
    setBtn(btnRe, false, '已连接');
    setBtn(btnDis, true, '断开连接');
  } else if (connecting) {
    dot.className = 'dot connecting';
    text.textContent = `正在连接 ${label}…`;
    setBtn(btnRe, false, '正在连接');
    setBtn(btnDis, true, '取消连接');
  } else {
    dot.className = 'dot ' + session.status;
    const retry = session.reconnectScheduled ? `(自动重连 ${session.reconnectAttempt}/3)` : '';
    text.textContent = `已断开 ${label}` + (error ? `（${error}）` : '') + retry;
    setBtn(btnRe, true, '重连');
    setBtn(btnDis, false, '连接已断开');
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
  // 重连走与「↻ 重连」按钮同一套路:先关掉失败会话再重连。
  // 注意 closeSession 会把窗格从布局里摘掉,因此不能再传旧 paneId(已失效),
  // 让 connectHost/quickConnect 自行新建窗格或标签。
  const quick = session && session.host && session.host.quick;
  const target = session && session.host;
  if (session) closeSession(session.sessionId);
  if (quick && target) {
    await quickConnect({ username: target.username, host: target.host, port: target.port });
  } else if (target) {
    await connectHost(target.id);
  }
}

// 自动重连(O2):最多 3 次,指数退避 1s/2s/4s
export function scheduleReconnect(sessionId, why) {
  const s = state.sessions.get(sessionId);
  // 指纹变更不会因重试而自愈(服务器不会自己换回去),继续退避重连只会反复失败;
  // 交给 offerFpRetrust 的显式路径处置。
  if (!s || s.reconnectAttempt >= 3 || s.host.quick || parseFpError(why)) return;
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

export async function connectHost(hostId, paneId, opts = {}) {
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
    const fp = parseFpError(e.message);
    const shown = fp ? fp.clean : e.message;
    if (state.activeId === session.sessionId) updateStatusbar(session, shown);
    toast('连接失败：' + shown, 'error');
    if (fp) offerFpRetrust(session, fp);
    else scheduleReconnect(session.sessionId, e.message);
  }
}

// 快速连接(A2):不入库,凭据仅驻内存
export function parseQuickTarget(text) {
  const m = String(text || '').trim().match(/^(?:([\w.-]+)@)?([\w.-]+)(?::(\d+))?$/);
  if (!m) return null;
  return { username: m[1] || 'root', host: m[2], port: Number(m[3]) || 22 };
}

export async function quickConnect(parsed, paneId) {
  const host = { id: 'quick-' + crypto.randomUUID(), quick: true, name: `${parsed.host}:${parsed.port}`, ...parsed, authType: 'password' };
  // 与点主机一致:无指定窗格时新开标签
  const session = createSession(host, paneId, paneId ? null : createTab().id);
  try {
    await api('ssh:connectQuick', { host });
    toast('快速连接成功', 'success');
  } catch (e) {
    session.status = 'error';
    updateTab(session);
    const fp = parseFpError(e.message);
    const shown = fp ? fp.clean : e.message;
    updateStatusbar(session, shown);
    toast('快速连接失败:' + shown, 'error');
    if (fp) offerFpRetrust(session, fp);
  }
}

export function fitActive() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  try {
    s.fit.fit();
    if (s.status === 'connected') {
      api('ssh:resize', { sessionId: s.sessionId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
    }
  } catch { /* ignore */ }
}

export function updateWelcome() {
  $('#welcome').classList.toggle('hidden', !!state.layout);
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

export function setBroadcast(sessionIds) {
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

export function openBroadcastPicker() {
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

export function toggleReadonly() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  s.readOnly = !s.readOnly;
  updateStatusbar(s);
  toast(s.readOnly ? '已开启只读模式' : '已关闭只读模式', 'success');
}

export function clearActiveTerm() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  try { s.term.clear(); s.term.write('\x1b[2J\x1b[H'); } catch { /* ignore */ }
}

export async function toggleSessionLog() {
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

export function stopLogIfActive(sessionId) {
  const s = state.sessions.get(sessionId);
  if (s && s.logActive) { api('log:stop', { sessionId }).catch(() => {}); s.logActive = false; }
}

export function loadSessionLogState(s) {
  api('log:status', { sessionId: s.sessionId }).then((r) => {
    s.logActive = !!r.active;
    updateStatusbar(s);
  }).catch(() => {});
}

/* ---------------- AI 模型切换(K6) + 诊断(K7) ---------------- */

