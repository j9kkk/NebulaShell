// 应用入口:右键菜单、事件绑定、启动(被 app.js 引入)
import { $, activeTab, api, applyAccelTitles, askConfirm, askPrompt, bindCtxMenuDismiss, bindMenuButton, bindModalInteractions, closeCtxMenu, closeModal, copyText, hasOpenModal, openModal, PLATFORM, setModalDismissHandler, showCtxMenu, state, toast } from './core.js';
import { isDocumentSelectAll, isEditableTarget } from './interaction.js';
import { bindCommandButtons, commandMenuItem, commandState, executeCommand, listCommands, refreshCommandStates, registerCommand } from './commands.js';
import { activateSession, activateTab, addFilePane, applyTheme, autoLayoutTab, bindPaneToolbars, bindTabStrip, openTabList, filePaneBlocker, bindSelectionExplain, clearActiveTerm, closeActivePane, closeTab, closeTermSearch, disconnectSession, doTermSearch, firstPaint, fitAllVisible, focusedPaneId, handleSessionStatus, leafCount, maxPaneCapacity, newTabWithPicker, openBroadcastPicker, openLogFolder, openTermSearch, paneOwner, reconnectSession, renameTab, scheduleResizeSync, scheduleWorkspaceLayout, splitActive, togglePaneZoom, toggleBroadcastMember, toggleReadonly, toggleTabTiling, toggleSessionLog, updateStatusbar, updateTab } from './terminal.js';
import { addHostTag, clearHostPrivateKey, onHostSecretInput, openFingerprints, openHostModal, refreshHosts, removeHostTag, renderHosts, renderTagMenu, saveHostModal, setHostAuthMode, toggleAuthRows, toggleHostSecret, toggleJumpMenu, toggleTagMenu, updateSessionLogHint } from './hosts.js';
import { closeCloudForm, cloudFetchAll, cloudImportSelected, editCloudAccount, onCloudSecretInput, refreshCloudAccounts, saveCloudAccountFromForm, syncCloudFormLabels, toggleCloudSecretVisibility } from './cloud.js';
import { addManualAiModel, aiDiagnose, aiFinishHolder, aiSend, aiSealThinking, aiShowThinking, aiStickScroll, aiTestConnection, aiTouchRequest, bindAiCodeActions, bindAiScroll, clearBubbleState, closeAiDrawer, closeContextPopover, closeModelConfigModal, closeModelMenu, closeModelPicker, closeThreadMenu, confirmModelPicker, cycleAiReasoningEffort, delayCloseContextPopover, ensureDefaultAiThread, fetchAiModels, fillPreset, filterModelPicker, findRequestHolder, isAiDrawerOpen, markBubbleStreaming, movePickerSelection, newAiThread, onAiApiKeyInput, onAiEndpointChange, onThreadMenuKeydown, openContextPopover, openModelMenu, pickerSelectAll, reasoningLevelLabel, refreshAiModels, renderAiDrawer, renderAiMessage, renderModelReasoning, renderModelSwitch, requestClearAiThread, requestDeleteAiThread, resetModelConfigModal, savedAiModelId, saveAiSettings, saveModelConfigModal, addEditingReasoningLevel, setAiBody, setAiBusy, stopAiGeneration, switchAiThread, switchModel, syncReasoningThumb, threadBusy, activeAiThread, toggleAiApiKeyVisibility, toggleAiDrawer, toggleContextPopover, togglePickerFocus, toggleThreadMenu, updateAiContextIndicator, updateModelEffortBadge } from './ai.js';
import {
  clickFromMenu, closeModeMenu, closeTargetMenu, hideModeHelp, onModeMenuKeydown, onTargetMenuKeydown,
  revokeGrant, routeToolOutput, selectMode, showModeHelp, toggleModeMenu, toggleTargetMenu,
} from './ai-agent-ui.js';
import { getTargetMenuData, refreshAgentHostBar, targetMenuHandlers } from './ai-agent-run.js';
import { clearThreadLinks, handleLinkSessionStatus, setLinksChangeHandler } from './ai-links.js';
import { addSnippet, openSnippetsModal, renderMonitorBar, renderSnippets } from './monitor.js';
import {
  filePaneBookmarks, filePaneFromEl, focusedFilePane, paneSnapshot, routeProgress,
  selectAllEntries, syncFilePanesForSession, uploadLocalPaths,
} from './sftp.js';
import { bindTransferUi, confirmTransferInterrupt, lastDownloadLocation, revealLastDownload } from './file-transfer.js';
import { bindSettings, dismissSettings, openSettings, settingsOpen, settingsSection } from './settings.js';
import { bindRightPanel, rightPanelOpen, rightPanelTab, rightTabShown, setRightPanel, toggleRightPanel, toggleRightTab } from './right-panel.js';
import { bindBatchUi, bindHistoryPage, openBatchModal, openForwardModal, openHistoryModal, saveForwardRule } from './tools.js';
import { accelOf, accelSpec, appShortcutOf, digitOf, invalidateKeymapCache, matchAction } from './keymap.js';
import { bindPalette, isPaletteOpen, openPalette, paletteInput, paletteSnapshot } from './palette.js';
import { buildNativeMenu, nativeMenuSnapshot } from './native-menu.js';
import { bindWindowControls, toggleFullscreen } from './window-controls.js';
import { buildMenubar, menubarSnapshot } from './menubar.js';
import { hydrateIcons } from '../shared/icons.js';

export function termFromEvent(e) {
  const paneEl = e.target && e.target.closest ? e.target.closest('.term-pane') : null;
  if (!paneEl) return null;
  const sid = paneEl.dataset.session;
  return sid ? state.sessions.get(sid) || null : null;
}

/// 终端右键菜单:编辑 / 当前会话 / 窗格 / 会话连接 四组。除复制粘贴外都走
/// 命令注册表,带显式目标(右键所在的会话),快捷键提示按平台渲染。
export function openTermCtxMenu(e, session) {
  const term = session.term;
  // 选区文本在"菜单打开时"快照:若等点击菜单项时再读 getSelection,
  // 选区可能已被右键/焦点变化清掉,复制到的就是空串或别的内容
  // (用户视角的"复制无效/复制错内容")。
  const selText = (() => { try { return term.getSelection() || ''; } catch { return ''; } })();
  const ctx = { sessionId: session.sessionId, paneId: session.paneId, tabId: session.tabId };
  const item = (id, overrides) => commandMenuItem(id, ctx, overrides);
  const connected = ['connected', 'connecting'].includes(session.status);
  showCtxMenu(e.clientX, e.clientY, [
    { label: '复制', key: accelOf('term.copy'), disabled: !selText, reason: '没有选中的内容', run: () => {
      copyText(selText).then((ok) => toast(ok ? `已复制 ${selText.length} 个字符` : '复制失败：剪贴板不可用', ok ? 'success' : 'error'));
    } },
    { label: '粘贴', key: accelOf('term.paste'), run: () => { navigator.clipboard.readText().then((t) => { if (t && !session.readOnly) term.paste(t); }).catch(() => {}); } },
    { label: '全选', key: accelOf('term.selectAll'), run: () => { try { term.selectAll(); } catch { /* ignore */ } } },
    '-',
    item('session.search', { label: '搜索…' }),
    // tips 与原 AI 面板「诊断报错」按钮的 title 一致
    item('session.diagnose', { title: '只取最后一次输入的命令及其控制台输出,让 AI 诊断' }),
    item('session.clear'),
    item('session.readonly'),
    item('session.log'),
    '-',
    item('pane.split'),
    item('tab.file.add'),
    item('pane.zoom'),
    item('workspace.close', { danger: true }),
    '-',
    connected ? item('session.disconnect', { danger: true }) : item('session.reconnect', { label: '重新连接' }),
    item('tools.broadcast'),
    item('tools.forwards'),
    '-',
    { label: '复制会话 ID', run: () => { copyText(session.sessionId).then((ok) => toast(ok ? '已复制会话 ID' : '复制失败', ok ? 'success' : 'error')); } },
  ], { label: '终端菜单' });
}

/// 分屏按钮的下拉:⛶ 本体仍是分屏,▾ 打开布局类命令。
function splitMenuItems() {
  return [
    commandMenuItem('pane.split', undefined, { label: '终端分屏' }),
    commandMenuItem('tab.file.add'),
    '-',
    commandMenuItem('pane.reflow'),
    commandMenuItem('pane.zoom'),
    commandMenuItem('workspace.tile'),
  ];
}

/// 侧栏「管理」:主机库层面的低频操作。
function hostManageItems() {
  return [
    commandMenuItem('hosts.import'),
    commandMenuItem('hosts.export'),
    '-',
    commandMenuItem('settings.fingerprints'),
    commandMenuItem('tools.forwards', undefined, { label: '端口转发规则…' }),
  ];
}

export function bindContextMenu() {
  // 全局屏蔽原生菜单:oncontextmenu 返回 false 即阻止默认行为。
  // 文件列表行有自己的菜单(见 sftp.js openFileCtxMenu),那里 stopPropagation
  // 后不会再走到这支;这里只负责终端区与"点空白处收起"。
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const session = termFromEvent(e);
    if (session) openTermCtxMenu(e, session);
    else closeCtxMenu();
    return false;
  });
  bindCtxMenuDismiss();
}

/// 拖拽上传(Tauri 原生拖放)。
/// 为什么不用 HTML5 dragover/drop:Tauri 出于安全默认**禁用** webview 内的
/// HTML5 文件拖放,落到 drop 事件上的 dataTransfer.files 里拿不到本地路径
/// (f.path 为 undefined)—— 旧实现因此在真机上一律"拖了没反应"(浏览器里
/// 调试却正常)。这里改用 Tauri 的 onDragDropEvent,它给出的是绝对路径数组。
/// 仅在文件面板可见时接管:否则会把"拖到终端/其它面板"的意图也吞掉。
/// 多栏后按"命中的栏"落点:上传到那一栏的当前目录(与单栏时代一致,
/// 不因鼠标压在子目录行上而改投子目录)。
export function bindFileDrop() {
  const cur = window.__TAURI__ && window.__TAURI__.webviewWindow
    && window.__TAURI__.webviewWindow.getCurrentWebviewWindow
    && window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
  if (!cur || typeof cur.onDragDropEvent !== 'function') return;
  const dpr = window.devicePixelRatio || 1;
  /// 拖放 position 的坐标语义按 wry 源码(0.55.x)核对,与 Tauri 文档不符:
  /// macOS 的 draggingLocation、Linux GTK 的 widget 坐标都是逻辑点(= CSS 像素),
  /// 只有 Windows/WebView2 的 ScreenToClient 结果是物理像素;而 Tauri JS 端
  /// 统一包装成 PhysicalPosition。照文档在 Retina Mac(dpr=2)上除以 dpr 会把
  /// 坐标砍半,命中检测永远落空 —— 表现为"拖了没反应"(浏览器/e2e 自注入
  /// 事件时两侧用了同一种错误换算,自洽通过,掩盖了这个 bug)。
  const cssPoint = (v) => (PLATFORM === 'windows' ? v / dpr : v);
  /// 命中检测:落在哪个可见文件分屏上(每个分屏自己是上传目标,主机=分屏所在标签)
  const hitPane = (pos) => {
    if (!pos || typeof pos.x !== 'number') return null;
    const x = cssPoint(pos.x);
    const y = cssPoint(pos.y);
    for (const elp of document.querySelectorAll('.term-pane.file-pane')) {
      const r = elp.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const pane = filePaneFromEl(elp);
        const target = pane ? paneSnapshot(pane) : null;
        return pane && target && !pane.loading && !pane.stale ? { pane, target } : null;
      }
    }
    return null;
  };
  const hintOf = (pane) => pane?.el?.querySelector?.('.file-drop-hint') || null;
  const hideHints = () => { for (const h of document.querySelectorAll('.file-drop-hint')) h.classList.add('hidden'); };
  cur.onDragDropEvent(({ payload }) => {
    if (payload.type === 'enter' || payload.type === 'over') {
      const hit = hitPane(payload.position);
      hideHints();
      if (hit) hintOf(hit.pane)?.classList.remove('hidden');
      return;
    }
    if (payload.type === 'leave') { hideHints(); return; }
    if (payload.type === 'drop') {
      hideHints();
      const hit = hitPane(payload.position);
      if (!hit) return;
      const paths = (payload.paths || []).filter(Boolean);
      if (!paths.length) return;
      uploadLocalPaths(paths, hit.target).catch(() => {});
    }
  });
}

/// 关于弹窗:版本号的正式归宿(此前挤在侧边栏左下角,只能读不能看)
export async function openAbout() {
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  try {
    const info = await api('app:info');
    set('#about-version', 'v' + info.version);
    set('#about-platform', PLATFORM_LABEL[info.platform] || info.platform);
  } catch {
    set('#about-version', '未知');
    set('#about-platform', PLATFORM_LABEL[PLATFORM] || PLATFORM);
  }
  openModal('#modal-about');
}

/// 平台显示名。两个来源的平台串不一致,都要认:
/// 后端 app:info 用 std::env::consts::OS(→ "macos"/"windows"/"linux"),
/// shim 的 window.nebula.platform 由 UA 推导(→ "darwin")。
const PLATFORM_LABEL = { darwin: 'macOS', macos: 'macOS', windows: 'Windows', linux: 'Linux' };

/// 侧边栏收缩:面板 + 拖拽把手同步显隐。收起时侧栏塌缩为图标窄条;展开/收起
/// 开关在顶层标题栏(位置固定,收起后仍可点),命令 panel.sidebar、快捷键与
/// 把手双击共用这一个入口。
let expandedSidebarWidth = null;
function toggleSidebar() {
  const sb = $('#sidebar');
  const collapsed = !sb.classList.contains('collapsed');
  if (collapsed) {
    expandedSidebarWidth = sb.getBoundingClientRect().width;
    sb.style.width = '';
  } else if (expandedSidebarWidth) {
    sb.style.width = Math.min(Math.max(180, expandedSidebarWidth), window.innerWidth * 0.5) + 'px';
  }
  sb.classList.toggle('collapsed', collapsed);
  sb.classList.remove('hidden');
  $('#sidebar-resizer').classList.toggle('hidden', collapsed);
  syncSidebarToggle(collapsed);
  fitAllVisible();
  scheduleResizeSync();
  refreshCommandStates();
}

/// 标题栏开关的按下态(.active / aria-pressed)由命令注册表的 checked 驱动,
/// 这里只维护它与侧栏的展开关系。
function syncSidebarToggle(collapsed) {
  $('#btn-sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
}

function closeCurrent() {
  const tab = activeTab();
  if (!tab) return;
  if (leafCount(tab.layout) > 1) closeActivePane(focusedPaneId());
  else closeTab(tab.id);
}

/// 云导入:每次打开都回到账号列表视图
async function openCloudImport() {
  closeCloudForm();
  openModal('#modal-cloud');
  try {
    await refreshCloudAccounts();
  } catch (e) {
    toast('读取云账号失败：' + e.message, 'error');
  }
}

async function exportHosts() {
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
}

async function importHosts() {
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
      const parts = [`新增 ${r.added} 台`, `保留重复 ${r.skipped} 台`];
      if (r.updated) parts.push(`更新 ${r.updated} 台`);
      if (r.credentialsFilled) parts.push(`补全凭据 ${r.credentialsFilled} 台`);
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
}

/// 退出与关窗:与红灯、窗口 ✕、Alt+F4 一样走窗口 close(),由 Rust 的
/// CloseRequested 统一拦截(有会话或传输时 emit app:closeRequest 询问)。
/// 应用只有一个窗口,关掉它就是退出。
function requestWindowClose() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win) { toast('当前环境无法关闭窗口', 'error'); return; }
  return win.close();
}

let closePrompt = null;
/// 关闭确认:会话数优先用后端读到的值;后端读锁失败时(-1)用前端的已连接数。
async function confirmAppClose({ transfers = 0, sessions = -1 } = {}) {
  if (closePrompt) return closePrompt;
  const live = sessions >= 0 ? sessions
    : [...state.sessions.values()].filter((s) => ['connected', 'connecting'].includes(s.status)).length;
  const parts = [];
  if (live > 0) parts.push(`${live} 个已连接的会话`);
  if (transfers > 0) parts.push(`${transfers} 个未完成的传输任务`);
  const what = parts.length ? `当前有 ${parts.join('和')}。` : '可能还有进行中的会话。';
  const effect = transfers > 0 ? '退出将断开所有会话并中断传输(已完成的文件不受影响)。' : '退出将断开所有会话。';
  closePrompt = askConfirm(`${what}${effect}确定退出?`, {
    title: '退出 NebulaShell', okText: '退出', cancelText: '取消',
  }).then(async (ok) => {
    if (ok) await api('app:exit');
    return ok;
  }).finally(() => { closePrompt = null; });
  return closePrompt;
}

function setupWorkspaceCommands() {
  // 作用目标:ctx 缺省为当前焦点(活动标签、焦点窗格、活动会话);窗格工具条、
  // 右键菜单传入显式的 paneId / sessionId / tabId,只作用于该目标。
  const targetOf = (ctx) => {
    if (ctx?.paneId) {
      const tab = paneOwner(ctx.paneId, ctx.tabId || undefined);
      const pane = tab?.panes.get(ctx.paneId) || null;
      return { explicit: true, tab, pane, paneId: pane ? ctx.paneId : null, session: pane?.sessionId ? state.sessions.get(pane.sessionId) || null : null };
    }
    if (ctx?.sessionId) {
      const session = state.sessions.get(ctx.sessionId) || null;
      const tab = session ? state.tabs.get(session.tabId) || null : null;
      return { explicit: true, tab, pane: tab?.panes.get(session.paneId) || null, paneId: session?.paneId || null, session };
    }
    if (ctx?.tabId) {
      const tab = state.tabs.get(ctx.tabId) || null;
      const session = tab ? state.sessions.get(tab.sessionId) || [...state.sessions.values()].find((s) => s.tabId === tab.id) || null : null;
      return { explicit: true, tab, pane: null, paneId: null, session };
    }
    const tab = activeTab();
    const paneId = tab ? focusedPaneId() : null;
    return { explicit: false, tab, pane: paneId ? tab.panes.get(paneId) || null : null, paneId, session: state.sessions.get(state.activeId) || null };
  };
  const session = (ctx) => targetOf(ctx).session;
  const count = (ctx) => leafCount(targetOf(ctx).tab?.layout);
  // 右键菜单里的会话命令要先把该会话设为活动会话(搜索框、AI 诊断只认活动会话)
  const focusTarget = (ctx) => {
    const s = session(ctx);
    if (ctx && s && s.sessionId !== state.activeId) activateSession(s.sessionId);
    return s;
  };
  // 字段约定见 commands.js registerCommand。有 enabled 的命令都要给出 reason:
  // 菜单底部、命令面板副标题、按钮 title、读屏都显示它。
  const noSession = '没有活动会话';
  const noTab = '没有打开的标签';
  const sessionReason = (ctx) => (session(ctx) ? '会话未连接' : noSession);
  const live = (s) => !!s && ['connected', 'connecting'].includes(s.status);

  // 应用
  registerCommand('palette.open', { label: '命令面板', category: 'app', kind: 'dialog', keywords: ['command palette', 'commands', 'shortcuts', 'mlmb', 'mingling', 'kuaijiejian'], run: () => openPalette() });
  registerCommand('settings.open', { label: '设置', category: 'app', kind: 'dialog',
    keywords: ['settings', 'preferences', 'font', 'theme', 'ai settings', 'model', 'api key', 'llm', 'keyboard shortcuts', 'sz', 'shezhi', '终端设置', 'zdsz', 'AI 配置', 'aipz', 'peizhi', '快捷键', 'kjj'],
    run: () => openSettings('terminal') });
  registerCommand('app.about', { label: '关于 NebulaShell', category: 'app', keywords: ['about', 'version', 'gy', 'guanyu', 'banben'], run: openAbout });
  registerCommand('window.close', { label: '关闭窗口', category: 'app', allowInModal: true, keywords: ['close window', 'gbck', 'chuangkou'], run: requestWindowClose });
  registerCommand('app.quit', { label: '退出 NebulaShell', category: 'app', allowInModal: true, keywords: ['quit', 'exit', 'tc', 'tuichu'], run: requestWindowClose });
  // 全屏:Windows/Linux 的 F11 与菜单栏「视图 › 全屏」;macOS 菜单栏用系统的「进入全屏」
  registerCommand('window.fullscreen', { label: '全屏', category: 'app', keywords: ['fullscreen', 'full screen', 'quanping'], run: () => toggleFullscreen() });
  // 编辑:Windows/Linux 菜单栏的复制 / 粘贴(macOS 菜单栏用系统预定义的拷贝/粘贴),
  // 作用于活动终端,与终端右键菜单同一套行为
  const selectionOf = (s) => { try { return s?.term?.getSelection() || ''; } catch { return ''; } };
  registerCommand('term.copy', { label: '复制', category: 'session', keywords: ['copy', 'fz', 'fuzhi'],
    enabled: (ctx) => !!selectionOf(session(ctx)), reason: '终端里没有选中的内容',
    run: (ctx) => {
      const text = selectionOf(session(ctx));
      return copyText(text).then((ok) => toast(ok ? `已复制 ${text.length} 个字符` : '复制失败：剪贴板不可用', ok ? 'success' : 'error'));
    } });
  registerCommand('term.paste', { label: '粘贴', category: 'session', keywords: ['paste', 'zt', 'zhantie'],
    enabled: (ctx) => { const s = session(ctx); return !!s && s.status === 'connected' && !s.readOnly; },
    reason: (ctx) => (!session(ctx) ? noSession : session(ctx).readOnly ? '只读会话不能粘贴' : '会话未连接'),
    run: (ctx) => {
      const s = session(ctx);
      focusTarget(ctx);
      return navigator.clipboard.readText().then((text) => { if (text && !s.readOnly) s.term.paste(text); });
    } });

  // 标签与分屏
  registerCommand('tab.new', { label: '新建标签', category: 'layout', keywords: ['new tab', 'xjbq', 'biaoqian'], run: newTabWithPicker });
  registerCommand('tab.rename', { label: '重命名标签', category: 'layout', kind: 'dialog', keywords: ['rename tab', 'cmm', 'cmmbq', 'chongmingming'], enabled: (ctx) => !!targetOf(ctx).tab, reason: noTab, run: (ctx) => renameTab(targetOf(ctx).tab.id) });
  registerCommand('pane.split', { label: '分屏', category: 'layout', keywords: ['split', 'split pane', 'fenping', 'fp'], enabled: (ctx) => session(ctx)?.status === 'connected' && count(ctx) < maxPaneCapacity(),
    reason: (ctx) => (session(ctx)?.status !== 'connected' ? '先连接当前窗格的主机' : `当前窗口最多容纳 ${maxPaneCapacity()} 个分屏窗格`), run: (ctx) => { focusTarget(ctx); return splitActive(); } });
  // 文件分屏:与「分屏」对称的入口;显式目标时在该窗格右侧切出
  registerCommand('tab.file.add', { label: '新增文件分屏', category: 'layout', keywords: ['files', 'sftp', 'file manager', 'wenjian', 'wjfp', 'xzwjfp'],
    enabled: (ctx) => !filePaneBlocker(targetOf(ctx).tab?.id), reason: (ctx) => filePaneBlocker(targetOf(ctx).tab?.id),
    run: (ctx) => { const t = targetOf(ctx); addFilePane(t.tab?.id, t.explicit ? t.paneId : undefined); refreshCommandStates(); } });
  // 单文件下载:在文件夹中选中该文件;批量下载:打开目标文件夹
  registerCommand('files.revealLastDownload', { label: '打开最近下载位置', category: 'app',
    keywords: ['downloads', 'show in folder', 'reveal', 'open folder', 'xiazai', 'zjxz', 'dkzjxzwz', 'wenjianjia'],
    enabled: () => !!lastDownloadLocation(), reason: '还没有完成的下载', run: () => revealLastDownload() });
  // 显式目标(窗格工具条 ⤢、右键菜单)时名称随状态换成「还原分屏布局」,不打 ✓
  registerCommand('pane.zoom', { label: (ctx) => {
    const t = targetOf(ctx);
    if (!t.explicit) return '放大当前窗格';
    return t.tab?.zoomPaneId && t.tab.zoomPaneId === t.paneId ? '还原分屏布局' : '放大该窗格';
  }, category: 'layout', keywords: ['zoom', 'maximize pane', 'fd', 'fangda', 'fdck'],
  enabled: (ctx) => {
    const t = targetOf(ctx);
    if (t.explicit && t.tab?.zoomPaneId === t.paneId && t.paneId) return true;
    return count(ctx) > 1 && (!!t.pane?.sessionId || (t.explicit && t.pane?.kind === 'file'));
  },
  reason: (ctx) => (count(ctx) <= 1 ? '当前标签只有一个窗格' : targetOf(ctx).explicit ? '连接后可放大' : '焦点窗格不是终端会话'),
  checked: (ctx) => (targetOf(ctx).explicit ? undefined : !!state.zoomPaneId),
  run: (ctx) => {
    const t = targetOf(ctx);
    if (t.explicit) return togglePaneZoom(t.paneId, t.tab.id);
    return togglePaneZoom(state.zoomPaneId || focusedPaneId());
  } });
  registerCommand('pane.reflow', { label: '整理当前标签分屏', category: 'layout', keywords: ['reflow', 'arrange', 'layout', 'zl', 'zhengli', 'buju'], enabled: () => count() > 1, reason: '当前标签只有一个窗格', run: autoLayoutTab });
  registerCommand('tabs.list', { label: '全部标签', category: 'layout', kind: 'dialog', keywords: ['all tabs', 'tab list', 'switch tab', 'qbbq', 'biaoqian', 'liebiao'], enabled: () => state.tabs.size > 0, reason: '没有打开的标签', run: () => openTabList() });
  registerCommand('workspace.tile', { label: '标签平铺', category: 'layout', keywords: ['tile tabs', 'grid', 'bqpp', 'pingpu'], checked: () => state.workspace.mode === 'tiled', enabled: () => state.workspace.mode === 'tiled' || state.tabs.size >= 2, reason: '需要至少 2 个标签', run: toggleTabTiling });
  registerCommand('workspace.close', { label: (ctx) => {
    const t = targetOf(ctx);
    const many = count(ctx) > 1;
    if (t.explicit && t.paneId) return many ? '关闭该窗格' : '关闭标签';
    return many ? '关闭当前窗格' : '关闭当前标签';
  }, category: 'layout', keywords: ['close', 'close pane', 'close tab', 'gb', 'guanbi'], enabled: (ctx) => !!targetOf(ctx).tab, reason: noTab,
  run: (ctx) => {
    const t = targetOf(ctx);
    if (t.explicit && t.paneId) return closeActivePane(t.paneId, t.tab.id);
    return closeCurrent();
  } });

  // 面板
  registerCommand('panel.sidebar', { label: '主机侧栏', category: 'panel', keywords: ['sidebar', 'hosts', 'zjcl', 'cebianlan'], checked: () => !$('#sidebar').classList.contains('collapsed'), run: toggleSidebar });
  // AI 助手面板:panel.tools 开关面板
  registerCommand('panel.tools', { label: 'AI 助手', category: 'panel', keywords: ['ai', 'assistant', 'chat', 'tools', 'right panel', 'toolbar', 'ycgjl', 'gongjulan', 'youce', 'zhushou'], checked: () => rightPanelOpen(), run: toggleRightPanel });
  registerCommand('ai.newThread', { label: '新建 AI 对话', category: 'panel', keywords: ['new chat', 'ai', 'xjdh', 'xinjianduihua'], run: () => { setRightPanel(true, 'ai'); newAiThread({ focus: true }); } });
  registerCommand('ai.cycleEffort', { label: '切换思考强度', category: 'panel', keywords: ['reasoning', 'thinking', 'effort', 'qiehuan', 'sikaoqiangdu'], run: () => cycleAiReasoningEffort() });

  // 会话
  registerCommand('session.history', { label: '命令历史', category: 'session', kind: 'dialog', keywords: ['history', 'command history', 'mlls', 'lishi'], run: openHistoryModal });
  registerCommand('tools.snippets', { label: '常用命令', category: 'session', kind: 'dialog', keywords: ['snippets', '片段', 'cyml', 'changyong', 'cypd', 'pianduan'], run: openSnippetsModal });
  registerCommand('session.search', { label: '在终端中查找', category: 'session', kind: 'dialog', keywords: ['find', 'search', 'cz', 'chazhao', 'sousuo'], enabled: (ctx) => !!session(ctx), reason: noSession, run: (ctx) => { focusTarget(ctx); return openTermSearch(); } });
  registerCommand('session.clear', { label: '清屏', category: 'session', keywords: ['clear', 'cls', 'qp', 'qingping'], enabled: (ctx) => !!session(ctx), reason: noSession, run: (ctx) => clearActiveTerm(session(ctx).sessionId) });
  registerCommand('session.reconnect', { label: '重连当前会话', category: 'session', keywords: ['reconnect', 'cl', 'chonglian'], enabled: (ctx) => !!session(ctx) && !live(session(ctx)),
    reason: (ctx) => (!session(ctx) ? noSession : session(ctx).status === 'connecting' ? '会话正在连接' : '会话已连接'), run: (ctx) => reconnectSession(session(ctx).sessionId) });
  registerCommand('session.disconnect', { label: '断开连接', category: 'session', keywords: ['disconnect', 'dk', 'duankai'], enabled: (ctx) => live(session(ctx)) || !!session(ctx)?.reconnectScheduled,
    reason: sessionReason, run: async (ctx) => { const id = session(ctx).sessionId; if (await confirmTransferInterrupt([id])) disconnectSession(id); } });
  registerCommand('session.readonly', { label: '只读模式', category: 'session', keywords: ['read only', 'readonly', 'zd', 'zhidu'], enabled: (ctx) => session(ctx)?.status === 'connected', reason: sessionReason, checked: (ctx) => !!session(ctx)?.readOnly, run: (ctx) => toggleReadonly(session(ctx).sessionId) });
  registerCommand('session.log', { label: '记录会话日志', category: 'session', keywords: ['log', 'record', 'jlrz', 'rizhi'],
    enabled: (ctx) => { const s = session(ctx); return !!s && !s.logBusy && (s.status === 'connected' || !!s.logActive); },
    reason: (ctx) => { const s = session(ctx); if (!s) return noSession; if (s.logBusy) return '正在处理日志操作'; return '会话未连接'; },
    checked: (ctx) => !!session(ctx)?.logActive, run: (ctx) => toggleSessionLog(session(ctx).sessionId) });
  registerCommand('session.log.folder', { label: '打开日志文件夹', category: 'session', keywords: ['log folder', 'logs', 'rzwjj', 'rizhi'], run: () => openLogFolder() });
  registerCommand('session.diagnose', { label: 'AI 诊断报错', category: 'session', keywords: ['diagnose', 'error', 'ai', 'zdbc', 'zhenduan'], enabled: (ctx) => !!session(ctx), reason: noSession, run: async (ctx) => { focusTarget(ctx); if (await aiDiagnose()) setRightPanel(true, 'ai'); } });
  // 广播随状态换动词,不打 ✓。广播期间,显式目标(窗格工具条、右键菜单)是
  // 该会话的加入 / 退出开关,按下态表示参与。
  const broadcastMember = (ctx) => {
    const t = targetOf(ctx);
    return t.explicit && state.broadcast && t.session ? t.session : null;
  };
  registerCommand('tools.broadcast', { label: (ctx) => {
    const member = broadcastMember(ctx);
    if (member) return state.broadcast.has(member.sessionId) ? '退出广播' : '加入广播';
    return state.broadcast ? '停止广播' : '广播输入…';
  }, kind: 'action', category: 'session', keywords: ['broadcast', 'multi input', 'gbsr', 'guangbo'],
  enabled: (ctx) => {
    const member = broadcastMember(ctx);
    if (member) return member.status === 'connected' && (state.broadcast.has(member.sessionId) || !member.readOnly);
    return !!state.broadcast || [...state.sessions.values()].some((s) => s.status === 'connected' && !s.readOnly);
  },
  reason: (ctx) => {
    const member = broadcastMember(ctx);
    if (member) return member.status !== 'connected' ? '会话未连接' : '只读会话不参与广播';
    return '没有可写入的已连接会话（只读会话不参与广播）';
  },
  checked: (ctx) => {
    const t = targetOf(ctx);
    return t.explicit && t.session ? !!state.broadcast?.has(t.session.sessionId) : undefined;
  },
  run: (ctx) => {
    const member = broadcastMember(ctx);
    if (member) return toggleBroadcastMember(member.sessionId);
    return openBroadcastPicker({ sessionId: targetOf(ctx).explicit ? session(ctx)?.sessionId : undefined });
  } });
  registerCommand('tools.batch', { label: '批量执行', category: 'session', kind: 'dialog', keywords: ['batch', 'run on hosts', 'plzx', 'piliang'], run: openBatchModal });
  registerCommand('tools.forwards', { label: '端口转发', category: 'session', kind: 'dialog', keywords: ['port forward', 'tunnel', 'dkzf', 'zhuanfa'],
    run: (ctx) => openForwardModal({ hostId: targetOf(ctx).explicit ? session(ctx)?.host?.id : undefined }) });

  // 主机
  registerCommand('host.new', { label: '新建主机', category: 'host', kind: 'dialog', keywords: ['new host', 'add host', 'xjzj', 'zhuji'], run: () => openHostModal(null) });
  registerCommand('cloud.import', { label: '从云导入', category: 'host', kind: 'dialog', keywords: ['cloud', 'tencent', 'aliyun', 'cydr', 'yun'], run: openCloudImport });
  registerCommand('hosts.import', { label: '导入主机', category: 'host', kind: 'dialog', keywords: ['import hosts', 'drzj', 'daoru'], run: importHosts });
  registerCommand('hosts.export', { label: '导出主机', category: 'host', kind: 'dialog', keywords: ['export hosts', 'backup', 'dczj', 'daochu'], run: exportHosts });
  registerCommand('settings.fingerprints', { label: '主机指纹', category: 'host', kind: 'dialog', keywords: ['fingerprints', 'known hosts', 'zjzw', 'zhiwen'], run: openFingerprints });

  const buttons = {
    'btn-newtab': 'tab.new', 'btn-split': 'pane.split', 'btn-ai-toggle': 'panel.tools', 'btn-sidebar-toggle': 'panel.sidebar', 'btn-batch': 'tools.batch',
    'btn-readonly': 'session.readonly', 'btn-log-toggle': 'session.log', 'btn-clear': 'session.clear', 'btn-reconnect': 'session.reconnect', 'btn-disconnect': 'session.disconnect',
    'btn-add-host': 'host.new', 'btn-welcome-add': 'host.new', 'btn-cloud-import': 'cloud.import', 'btn-welcome-cloud': 'cloud.import',
  };
  for (const [id, command] of Object.entries(buttons)) document.getElementById(id).dataset.command = command;
  bindCommandButtons();
  bindMenuButton($('#btn-split-menu'), splitMenuItems, { label: '分屏与布局', alignRight: true });
  bindMenuButton($('#btn-host-manage'), hostManageItems, { label: '主机管理' });
  document.addEventListener('nebula:state-change', refreshCommandStates);
  document.addEventListener('nebula:modal-scope', refreshCommandStates);
}

// 兼容别名:老键位/旧脚本仍在用的入口名,指向迁移后的新命令。标记 internal
// —— 不进命令面板,也不要求出现在一级菜单里(否则"所有注册命令可达"的校验
// 会要求这些别名各自再上一遍菜单)。
registerCommand('panel.ai', { label: 'AI 助手', category: 'panel', internal: true, keywords: ['ai'], checked: () => rightPanelOpen(), run: toggleRightPanel });
registerCommand('panel.history', { label: '命令历史', category: 'panel', kind: 'dialog', internal: true, keywords: ['history'], run: openHistoryModal });
registerCommand('panel.snippets', { label: '常用命令', category: 'panel', kind: 'dialog', internal: true, keywords: ['snippets'], run: openSnippetsModal });

export function bindEvents() {
  $('#btn-cloud-add-account').addEventListener('click', () => editCloudAccount(null));
  $('#cloud-form-vendor').addEventListener('change', syncCloudFormLabels);
  $('#btn-cloud-form-save').addEventListener('click', saveCloudAccountFromForm);
  $('#btn-cloud-form-cancel').addEventListener('click', closeCloudForm);
  $('#btn-reveal-cloud-secret')?.addEventListener('click', toggleCloudSecretVisibility);
  $('#cloud-form-secret')?.addEventListener('input', onCloudSecretInput);
  // 密钥帮助里的跳转链接:仅白名单控制台域名(后端 regex_lite 二次校验)
  $('#cloud-form-help').addEventListener('click', (e) => {
    const link = e.target.closest('.help-link');
    if (!link) return;
    api('app:openExternal', { url: link.dataset.url }).catch((err) =>
      toast('无法打开链接：' + err.message, 'error'),
    );
  });
  // 表单内回车 = 保存(密钥输入框不再走 askPrompt 链路)
  $('#cloud-account-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      saveCloudAccountFromForm();
    }
  });

  $('#host-search').addEventListener('input', renderHosts);
  $('#host-auth').addEventListener('change', toggleAuthRows);

  // 认证方式滑块:点击分段项切换 + 键盘左右箭头支持
  $('#host-auth-slider')?.addEventListener('click', (e) => {
    const item = e.target.closest('.segmented-item');
    if (item && item.dataset.value) {
      setHostAuthMode(item.dataset.value);
    }
  });
  $('#host-auth-slider')?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHostAuthMode('password');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setHostAuthMode('key');
    }
  });

  // 标签交互:点击容器聚焦输入框并展开候选菜单
  $('#host-tags-container')?.addEventListener('click', (e) => {
    if (!e.target.closest('.tag-chip')) {
      $('#host-tag-input')?.focus();
      toggleTagMenu(true);
    }
  });
  $('#host-tag-input')?.addEventListener('input', () => {
    toggleTagMenu(true);
  });
  $('#host-tag-input')?.addEventListener('focus', () => {
    toggleTagMenu(true);
  });
  $('#host-tag-input')?.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && !e.isComposing) {
      e.preventDefault();
      const val = $('#host-tag-input').value.trim().replace(/^[，,]+|[，,]+$/g, '');
      if (val) {
        addHostTag(val);
        $('#host-tag-input').value = '';
        renderTagMenu('');
      }
    } else if (e.key === 'Backspace' && $('#host-tag-input').value === '') {
      const chips = $('#host-tags-list')?.querySelectorAll('.tag-chip');
      if (chips && chips.length > 0) {
        const lastTag = chips[chips.length - 1].dataset.tag;
        if (lastTag) removeHostTag(lastTag);
      }
    } else if (e.key === 'Escape') {
      toggleTagMenu(false);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#host-tags-box')) {
      toggleTagMenu(false);
    }
  });

  $('#btn-host-save').addEventListener('click', saveHostModal);
  $('#btn-host-cancel').addEventListener('click', () => closeModal('#modal-host'));
  $('#btn-reveal-host-password')?.addEventListener('click', () => toggleHostSecret('password'));
  $('#host-password')?.addEventListener('input', () => onHostSecretInput('password'));
  $('#btn-reveal-host-passphrase')?.addEventListener('click', () => toggleHostSecret('passphrase'));
  $('#host-passphrase')?.addEventListener('input', () => onHostSecretInput('passphrase'));
  $('#btn-clear-key')?.addEventListener('click', clearHostPrivateKey);

  $('#btn-host-add-jump')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleJumpMenu();
  });
  $('#host-jump-chips')?.addEventListener('click', (e) => {
    if (!e.target.closest('.jump-chip')) {
      e.stopPropagation();
      toggleJumpMenu();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#host-jump-box')) toggleJumpMenu(false);
  });

  $('#host-sessionlog')?.addEventListener('change', updateSessionLogHint);

  $('#btn-pick-key').addEventListener('click', async () => {
    try {
      const r = await api('dialog:pickKey');
      if (r) {
        state.pickedKey = r;
        $('#key-path').textContent = r.path;
        $('#btn-clear-key')?.classList.remove('hidden');
      }
    } catch (e) {
      toast('读取私钥失败：' + e.message, 'error');
    }
  });

  $('#btn-cloud-fetch').addEventListener('click', cloudFetchAll);
  $('#btn-cloud-import-selected').addEventListener('click', cloudImportSelected);
  $('#btn-cloud-close').addEventListener('click', () => closeModal('#modal-cloud'));
  const jumpToCloudSettings = () => {
    closeModal('#modal-cloud');
    openSettings('cloud');
  };
  $('#btn-cloud-manage-accounts')?.addEventListener('click', jumpToCloudSettings);
  $('#btn-cloud-guide-config')?.addEventListener('click', jumpToCloudSettings);

  bindRightPanel();
  bindHistoryPage();
  bindSettings();
  $('#btn-ai-cancel').addEventListener('click', dismissSettings);
  // 设置窗口任何方式关闭(Esc、遮罩、各分区的取消/保存)都走统一出口:回滚主题预览+丢弃 AI 分区草稿
  setModalDismissHandler('#modal-settings', dismissSettings);
  setModalDismissHandler('#modal-model-picker', closeModelPicker);
  $('#ai-baseurl').addEventListener('input', onAiEndpointChange);
  $('#ai-protocol').addEventListener('change', onAiEndpointChange);
  $('#ai-model-inline').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addManualAiModel(); } });
  // 点列表框空白处(chip 之间/空态提示)把焦点交给输入框,让整个框看起来可输入
  $('#ai-model-chips').addEventListener('click', (event) => {
    if (!event.target.closest('.model-chip, .model-chips-input')) $('#ai-model-inline').focus();
  });
  $('#btn-ai-save').addEventListener('click', saveAiSettings);
  $('#btn-reveal-ai-apikey')?.addEventListener('click', toggleAiApiKeyVisibility);
  $('#ai-apikey')?.addEventListener('input', onAiApiKeyInput);
  $('#btn-ai-test').addEventListener('click', aiTestConnection);
  $('#ai-provider').addEventListener('change', () => fillPreset($('#ai-provider').value));
  $('#btn-ai-fetch-models').addEventListener('click', fetchAiModels);
  $('#btn-model-picker-ok').addEventListener('click', confirmModelPicker);
  $('#btn-model-picker-cancel').addEventListener('click', closeModelPicker);
  $('#btn-model-picker-all').addEventListener('click', () => pickerSelectAll(true));
  $('#btn-model-picker-none').addEventListener('click', () => pickerSelectAll(false));
  $('#model-picker-search').addEventListener('input', (e) => filterModelPicker(e.target.value));
  $('#model-picker-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePickerSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePickerSelection(-1); }
    // 空格切换勾选:多选列表的常规操作,不能像单选那样回车即关闭
    else if (e.key === ' ') { e.preventDefault(); togglePickerFocus(); }
    else if (e.key === 'Enter') { e.preventDefault(); confirmModelPicker(); }
  });

  // 编辑模型能力配置弹窗
  $('#btn-model-config-cancel')?.addEventListener('click', closeModelConfigModal);
  $('#btn-model-config-save')?.addEventListener('click', saveModelConfigModal);
  $('#btn-model-config-reset')?.addEventListener('click', resetModelConfigModal);
  $('#btn-cfg-add-level')?.addEventListener('click', () => addEditingReasoningLevel());
  $('#cfg-reasoning-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addEditingReasoningLevel(); }
  });
  // 模型选择:触发钮开菜单,菜单项切换,「管理模型」进 AI 设置;
  // 面板外点击/Esc/窗口缩放 关闭。菜单定位 fixed,不随面板滚动。
  $('#ai-model-trigger').addEventListener('click', () => {
    // 0 模型:无可切换项,点击语义变为"去配置"——直达 AI 设置分区
    // (分支放这里:openSettings 在 settings.js,ai.js 反向导入会成环)
    if (!savedAiModelId() && $('#ai-model-menu').classList.contains('hidden')) {
      closeModeMenu();
      closeThreadMenu();
      openSettings('ai');
      return;
    }
    const menu = $('#ai-model-menu');
    if (menu.classList.contains('hidden')) {
      closeModeMenu();
      closeThreadMenu();
      openModelMenu();
    } else {
      closeModelMenu();
    }
  });
  $('#ai-model-menu-list').addEventListener('click', (e) => {
    const item = e.target.closest('.ai-model-menu-item');
    if (!item) return;
    closeModelMenu();
    switchModel(item.dataset.model).then(renderModelSwitch).catch(() => {});
  });
  $('#ai-reasoning-slider')?.addEventListener('input', (e) => {
    const current = savedAiModelId() || '';
    const models = state.aiSelected || [];
    const active = models.find((m) => m.id === current);
    const levels = active?.reasoning?.levels || [];
    const val = Number(e.target.value);
    if (levels[val]) {
      const th = activeAiThread();
      if (th) th.reasoningEffort = levels[val];
      const labelEl = $('#ai-reasoning-label');
      if (labelEl) labelEl.textContent = reasoningLevelLabel(levels[val]);
      e.target.setAttribute('aria-valuetext', reasoningLevelLabel(levels[val]));
    }
    // 可视 thumb 平滑跟随(点击轨道/键盘步进/拖拽;真拖拽时 .dragging 关过渡)
    syncReasoningThumb(val, { animate: true });
    // 底部模型名旁的档位标签同步
    updateModelEffortBadge();
  });
  // 只有"按下后确实移动了"才算拖拽:单击轨道/按下不动时保持过渡,值一步跨到
  // 目标档位是平滑滑过去的。pointerdown 就加 .dragging 会让单击也瞬移。
  const reasoningWrap = $('#ai-reasoning-slider-wrap');
  const reasoningSlider = $('#ai-reasoning-slider');
  let reasoningDown = null;
  reasoningSlider?.addEventListener('pointerdown', (e) => {
    reasoningDown = { x: e.clientX, y: e.clientY };
  });
  reasoningSlider?.addEventListener('pointermove', (e) => {
    if (!reasoningDown || reasoningWrap?.classList.contains('dragging')) return;
    if (Math.abs(e.clientX - reasoningDown.x) >= 3 || Math.abs(e.clientY - reasoningDown.y) >= 3) {
      reasoningWrap?.classList.add('dragging');
    }
  });
  const endReasoningDrag = () => { reasoningDown = null; reasoningWrap?.classList.remove('dragging'); };
  window.addEventListener('pointerup', endReasoningDrag);
  window.addEventListener('pointercancel', endReasoningDrag);
  $('#ai-model-reasoning')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  $('#ai-model-manage').addEventListener('click', () => { closeModelMenu(); openSettings('ai'); });
  document.addEventListener('click', (e) => {
    // 用 composedPath 判定"点击来自菜单内部":菜单内原地重绘会把被点中的行摘出文档,
    // 此时 e.target.closest() 已失效,会误判成点在外面而收起菜单。
    if (!clickFromMenu(e, ['ai-model-menu', 'ai-model-trigger'])) closeModelMenu();
    if (!clickFromMenu(e, ['ai-mode-menu', 'ai-mode-trigger', 'ai-mode-help-pop'])) closeModeMenu();
    if (!clickFromMenu(e, ['ai-target-menu', 'ai-target-trigger'])) closeTargetMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelMenu(); closeModeMenu(); closeTargetMenu(); }
  });
  window.addEventListener('resize', () => {
    closeModelMenu();
    closeModeMenu();
    closeThreadMenu();
    closeTargetMenu();
  });

  // 主机链接选择器: 触发钮开合菜单(三模式 + 多主机清单)
  $('#ai-target-trigger')?.addEventListener('click', () => {
    const menu = $('#ai-target-menu');
    if (menu?.classList.contains('hidden')) {
      closeModelMenu();
      closeThreadMenu();
      closeModeMenu();
    }
    const data = getTargetMenuData();
    toggleTargetMenu(data, targetMenuHandlers());
  });
  $('#ai-target-menu-list')?.addEventListener('keydown', onTargetMenuKeydown);
  // 菜单内的点击一律不冒泡到 document:菜单会原地重绘,被点中的行随后就被摘出文档,
  // 走到 document 时已经无法判断"这次点击来自菜单内"。在容器边界截断最稳。
  $('#ai-target-menu')?.addEventListener('click', (e) => e.stopPropagation());

  // 执行模式选择器:触发钮开菜单(绑定单点在这里,updateModePicker 不再设 onclick,
  // 否则双绑定一次点击开又关);菜单项切换模式,切 auto 的确认在 ai-agent-run.js;
  // 「?」悬停/聚焦立即展开帮助浮层(原生 title 要停约 1 秒),移进浮层保持展开;
  // 点击不外抛以免关掉菜单。
  $('#ai-mode-trigger').addEventListener('click', () => {
    // 打开前按当前绑定重算一次，头部「主机 · 名称」不依赖上一次状态事件是否到达。
    refreshAgentHostBar();
    const menu = $('#ai-mode-menu');
    if (menu?.classList.contains('hidden')) {
      closeModelMenu();
      closeThreadMenu();
    }
    toggleModeMenu();
  });
  $('#ai-mode-menu-list').addEventListener('click', (e) => {
    const item = e.target.closest('.ai-mode-menu-item');
    if (!item || item.disabled) return;
    closeModeMenu();
    selectMode(item.dataset.mode);
  });
  $('#ai-mode-menu-list').addEventListener('keydown', onModeMenuKeydown);
  const modeHelp = $('#ai-mode-help');
  modeHelp.addEventListener('click', (e) => { e.stopPropagation(); showModeHelp(); });
  modeHelp.addEventListener('mouseenter', showModeHelp);
  modeHelp.addEventListener('focus', showModeHelp);
  modeHelp.addEventListener('mouseleave', () => hideModeHelp({ delay: 150 }));
  modeHelp.addEventListener('blur', () => hideModeHelp());
  $('#ai-mode-help-pop').addEventListener('mouseenter', showModeHelp);
  $('#ai-mode-help-pop').addEventListener('mouseleave', () => hideModeHelp({ delay: 150 }));
  // 撤销会话授权：菜单保持打开，便于连续撤销多项（撤销会重绘列表，被点的按钮
  // 随即脱离文档，不拦冒泡的话 document 的「点外部关菜单」会误判为点在外面）。
  $('#ai-mode-grants').addEventListener('click', (e) => {
    e.stopPropagation();
    const revoke = e.target.closest('[data-revoke]');
    if (revoke) revokeGrant(Number(revoke.dataset.revoke));
  });
  // 「诊断报错」按钮已移除:入口迁移至终端右键菜单(openTermCtxMenu)。

  setupWorkspaceCommands();
  $('#btn-fw-save').addEventListener('click', saveForwardRule);
  $('#btn-fw-close').addEventListener('click', () => closeModal('#modal-forward'));
  bindBatchUi();

  // 文件分屏:窗格内交互(导航/路径/新建/重命名/权限/上传/右键菜单)
  // 全部在 sftp.js buildFilePane 里按窗格闭包绑定;这里只接拖拽上传与任务中心。
  bindFileDrop();

  // 任务中心:事件接入 + 内部拖拽 + 状态栏入口
  bindTransferUi();

  // 退出拦截:有已连接会话或未完成传输时,后端拦下关闭请求(⌘Q、⇧⌘W、红灯、
  // 窗口 ✕、Alt+F4 都汇到这里),由确认底座决定是否退出
  window.nebula.on('app:closeRequest', (payload) => {
    confirmAppClose({ transfers: payload?.transfers ?? payload?.count ?? 0, sessions: payload?.sessions ?? -1 });
  });

  // 「解释选中内容」按钮已移除:入口迁移为终端选区末尾的悬浮 🔍 按钮
  // (terminal.js bindSelectionExplain)。
  // AI 会话管理工具栏与下拉菜单
  $('#ai-thread-trigger').addEventListener('click', () => {
    const menu = $('#ai-thread-menu');
    if (menu?.classList.contains('hidden')) {
      closeModelMenu();
      closeModeMenu();
    }
    toggleThreadMenu();
  });
  $('#ai-thread-new').addEventListener('click', () => {
    closeThreadMenu();
    closeAiDrawer();
    newAiThread({ focus: true });
  });
  $('#ai-drawer-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAiDrawer();
  });
  $('#ai-drawer-new')?.addEventListener('click', () => {
    closeAiDrawer();
    newAiThread({ focus: true });
  });
  $('#ai-drawer-close')?.addEventListener('click', () => {
    closeAiDrawer({ focusToggle: true });
  });
  $('#ai-drawer-search')?.addEventListener('input', (e) => {
    renderAiDrawer(e.target.value);
  });
  $('#ai-drawer-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 我们已消费这次 Esc:标记 defaultPrevented,免得右侧栏/文档层再处理一遍。
      // (stopPropagation 让事件到不了那些监听器,但 prevented 语义要自己给全。)
      e.preventDefault();
      e.stopPropagation();
      closeAiDrawer({ focusToggle: true });
    }
  });
  $('#ai-thread-clear').addEventListener('click', async () => {
    closeThreadMenu();
    closeAiDrawer();
    await requestClearAiThread();
    $('#ai-input')?.focus();
  });
  $('#ai-thread-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const delBtn = e.target.closest?.('.ai-thread-del');
    if (delBtn) {
      const id = delBtn.dataset.delThread;
      if (id) requestDeleteAiThread(id);
      return;
    }
    const itemBtn = e.target.closest?.('.ai-thread-menu-item');
    const row = e.target.closest?.('.ai-thread-menu-row');
    const id = itemBtn?.dataset?.threadId || row?.dataset?.threadId;
    if (id) {
      switchAiThread(id);
      $('#ai-input')?.focus();
    }
  });
  $('#ai-thread-menu').addEventListener('keydown', onThreadMenuKeydown);
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#ai-thread-menu, #ai-thread-trigger')) closeThreadMenu();
    if (!e.target.closest?.('#ai-drawer, #ai-drawer-toggle')) closeAiDrawer();
    if (!e.target.closest?.('#ai-context-popover, #ai-context-trigger')) closeContextPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeThreadMenu();
      if (isAiDrawerOpen()) closeAiDrawer();
      closeContextPopover();
    }
  });

  // 上下文窗口指示器交互
  const ctxTrigger = $('#ai-context-trigger');
  const ctxPopover = $('#ai-context-popover');
  ctxTrigger?.addEventListener('mouseenter', () => openContextPopover());
  ctxTrigger?.addEventListener('mouseleave', () => delayCloseContextPopover(200));
  ctxTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleContextPopover();
  });
  ctxPopover?.addEventListener('mouseenter', () => openContextPopover());
  ctxPopover?.addEventListener('mouseleave', () => delayCloseContextPopover(200));

  // 发送/停止同钮:空闲时发送,流式期间点击中止当前生成。
  $('#ai-send').addEventListener('click', () => (state.aiReq || threadBusy(activeAiThread()) ? stopAiGeneration() : aiSend()));
  $('#ai-input').addEventListener('input', () => updateAiContextIndicator());
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aiSend();
    }
  });

  // 片段 / 指纹 / 关于
  $('#btn-snippet-add').addEventListener('click', addSnippet);
  $('#snippet-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSnippet(); });
  // 常用命令过滤:输入即过滤(名称/命令模糊匹配);✕ 一键清空过滤词并还焦点
  $('#snippet-search').addEventListener('input', renderSnippets);
  $('#snippet-clear').addEventListener('click', () => {
    const q = $('#snippet-search');
    q.value = '';
    renderSnippets();
    q.focus();
  });
  $('#btn-fp-close').addEventListener('click', () => closeModal('#modal-fp'));
  $('#btn-about-close').addEventListener('click', () => closeModal('#modal-about'));
  $('#btn-snippet-close')?.addEventListener('click', () => closeModal('#modal-snippets'));

  // 终端搜索
  $('#term-search-next').addEventListener('click', () => doTermSearch(false));
  $('#term-search-prev').addEventListener('click', () => doTermSearch(true));
  $('#term-search-close').addEventListener('click', closeTermSearch);
  $('#term-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doTermSearch(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
  });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // 键位从 keymap 匹配:绑定与提示共用同一张表,自定义键位对两者同时生效。
    // 命中应用快捷键先 preventDefault,再判断当前能否执行:macOS 上网页没消费的
    // ⌘ 键会落到原生菜单(默认菜单的 ⌘W 是"关闭窗口"),弹窗/菜单/输入框里
    // 按 ⌘W 曾因此直接关掉应用。
    const action = appShortcutOf(e);
    if (action) e.preventDefault();
    if (hasOpenModal()) return;
    // 命令面板是键盘总入口:焦点在终端、输入框里,或下拉 / 右键菜单打开时都能打开
    if (action === 'palette.open') { executeCommand(action); return; }
    if (!$('#ctx-menu').classList.contains('hidden')) return;
    // 在 AI 面板内按快捷键新建会话
    if (matchAction('ai.newThread', e) && rightTabShown('ai') && document.activeElement?.closest?.('#ai-panel, #ai-thread-menu, #ai-drawer, #rp-ai')) {
      e.preventDefault();
      closeThreadMenu();
      closeAiDrawer();
      newAiThread({ focus: true });
      return;
    }
    // 在 AI 面板内或模型菜单打开时按快捷键切换思考强度
    if (matchAction('ai.cycleEffort', e) && (rightTabShown('ai') && document.activeElement?.closest?.('#ai-panel, #ai-model-menu, #rp-ai') || !$('#ai-model-menu')?.classList.contains('hidden'))) {
      e.preventDefault();
      cycleAiReasoningEffort();
      return;
    }
    const terminalInput = !!e.target.closest?.('.term-pane');
    if (isEditableTarget(e.target) && !terminalInput) return;
    if (action === 'tab.switch') {
      const target = [...state.tabs.keys()][digitOf(e) - 1];
      if (target) activateTab(target);
      return;
    }
    if (action) { executeCommand(action); return; }
    // 文件分屏内的全选(焦点在路径栏等输入框时由上面的 isEditableTarget
    // 早退,是输入框原生全选,不抢)
    if (matchAction('files.selectAll', e) && !terminalInput && document.activeElement?.closest?.('.term-pane.file-pane')) {
      e.preventDefault();
      import('./sftp.js').then((m) => { const p = m.focusedFilePane(); if (p) m.selectAllEntries(p); });
      return;
    }
    if (e.key !== 'Escape') return;
    if (!$('#term-search').classList.contains('hidden')) closeTermSearch();
  });
  // 界面本身不做全选:输入框、终端、文件分屏的全选各自处理,落到 body 上的
  // 文档级全选只会把整个界面的文字和图标刷成选区
  document.addEventListener('selectstart', (e) => { if (isDocumentSelectAll(e)) e.preventDefault(); });

  // Workspace scheduling coalesces frames and ignores unchanged geometry; observing
  // the fixed outer stack (not its rendered children) avoids layout feedback loops.
  // 分屏容量按 #layout-root 的尺寸折算:尺寸变了,分屏 / 新增文件分屏的可用状态也要跟着变
  let commandRefresh = null;
  let effortBadgeTimer = null;
  const ro = new ResizeObserver(() => {
    scheduleWorkspaceLayout(); fitAllVisible(); scheduleResizeSync();
    clearTimeout(commandRefresh);
    commandRefresh = setTimeout(refreshCommandStates, 100);
  });
  ro.observe($('#term-stack'));
  ro.observe($('#layout-root'));

  // AI 面板宽度变化时重算"模型名是否被截断",它决定档位标签能否显示
  // (面板可被拖拽调宽,固定断点猜不准)
  const aiPanelRo = new ResizeObserver(() => {
    // 拖拽时每帧都触发,节流到停顿后判定,避免每帧强制同步布局
    clearTimeout(effortBadgeTimer);
    effortBadgeTimer = setTimeout(renderModelSwitch, 120);
  });
  aiPanelRo.observe($('#ai-panel'));

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
    // AI 诊断素材:只累积"最后一次命令提交之后"的输出,留尾部(报错通常在末尾)。
    // 采集窗口由 terminal.js 的 onData 在每次回车提交时重开。
    if (s.collectOutput) {
      s.lastOutput = ((s.lastOutput || '') + data).slice(-6000);
    }
  });
  window.nebula.on('ssh:status', (payload) => {
    const { sessionId, state: st, label } = payload;
    // 无头链接会话不在 state.sessions 里:A 先交给链接注册表跟踪状态,
    // 由它按 sessionId 前缀判定归属(见 ai-links.js)。
    if (handleLinkSessionStatus(payload)) return;
    const s = state.sessions.get(sessionId);
    if (!s || !handleSessionStatus(payload)) return;
    if (label) { s.label = label; updateTab(s); }
    if (st !== 'connected') {
      state.metrics.delete(sessionId);
      if (state.activeId === sessionId) renderMonitorBar();
    }
    // 文件分屏联动:标签内连接态变化 → 全断灰显 / 恢复连接自动刷新
    syncFilePanesForSession(sessionId);
  });
  window.nebula.on('ssh:metrics', (m) => {
    state.metrics.set(m.sessionId, m);
    if (m.sessionId === state.activeId) renderMonitorBar();
  });
  // 会话日志状态:后端是唯一事实源,这里只做镜像。started/stopped 由发起方
  // (toggleSessionLog / 关闭会话)弹提示,事件不再重复;error/dropped 由事件弹。
  window.nebula.on('log:state', (st) => {
    const session = state.sessions.get(st.sessionId);
    if (session && (!st.file || !session.logFile || session.logFile === st.file)) {
      session.logActive = !!st.active;
      if (st.file) session.logFile = st.file;
      if (st.bytes != null) session.logBytes = st.bytes;
      updateTab(session);
      if (state.activeId === st.sessionId) updateStatusbar(session);
    }
    if (st.reason === 'error') {
      toast(`会话日志写入失败，已停止记录：${st.message || '未知原因'}${st.name ? `（${st.name}）` : ''}`, 'error', { action: { label: '打开日志文件夹', run: openLogFolder } });
    } else if (st.reason === 'dropped') {
      toast(`磁盘写入跟不上，会话日志丢失部分输出，已在日志里标注${st.name ? `（${st.name}）` : ''}`, 'warn');
    }
  });
  // 会话日志按钮悬停:录制中时查一次后端,刷新已记录的大小(悬停提示)
  $('#btn-log-toggle').addEventListener('mouseenter', () => {
    const s = state.sessions.get(state.activeId);
    if (!s || !s.logActive || s.logBusy) return;
    api('log:status', { sessionId: s.sessionId }).then((r) => {
      if (s.logActive && r && r.bytes != null) {
        s.logBytes = r.bytes;
        if (state.activeId === s.sessionId) updateStatusbar(s);
      }
    }).catch(() => {});
  });
  // 进度按归属路由:任务中心(taskId)+ 会话/目录匹配的视图状态栏,
  // 不再把 A 主机的进度覆盖到 B 的面板上。
  window.nebula.on('sftp:progress', routeProgress);
  window.nebula.on('ai:progress', ({ requestId }) => {
    // 心跳:响应头到达、role/usage/keep-alive 等非内容帧都会触发。
    // 空闲超时的语义因此是"60 秒内后端一个活跃信号都没有",而不是
    // "60 秒没吐正文" —— 思考型模型纯推理期不再被误判超时。
    aiTouchRequest(requestId);
  });
  window.nebula.on('ai:thinking', ({ requestId, text }) => {
    const match = findRequestHolder(requestId);
    if (!match) return;
    const h = match.holder;
    aiTouchRequest(requestId);
    h.thinking = (h.thinking || '') + text;
    if (!h.bubble) return;
    markBubbleStreaming(h.bubble);
    aiShowThinking(h.bubble, h.thinking);
    // 思考块插入让气泡长高:delta 路径的 rAF 写入有贴底收口,
    // 纯思考阶段(推理型模型可长达数十秒)没有,视图会停在此前位置。
    // 只在活动线程跟随,后台线程气泡增长不打扰当前阅读。
    if (match.thread?.id == null || match.thread?.id === state.activeThreadId) {
      aiStickScroll();
    }
  });
  window.nebula.on('ai:delta', ({ requestId, text }) => {
    const match = findRequestHolder(requestId);
    if (!match) return;
    const { holder: h, thread } = match;
    aiTouchRequest(requestId);
    // 首个 token 到达时刻:生成速率的分母从这一刻算起。
    // 用全程耗时会掺进排队与网络等待,算出的速率没有参考意义。
    if (!h.firstTokenAt) h.firstTokenAt = Date.now();
    h.acc += text;
    if (!h.bubble) return;
    // 首个 token:撤掉"正在思考…"占位,转入流式态
    markBubbleStreaming(h.bubble);
    // 正文开始后思考已结束:头部从"思考中…"切换为收起态文案,点击仍可展开回看
    aiSealThinking(h.bubble);
    // 同一帧内的多个 delta 合并成一次 DOM 写入:逐 token 直接写会让长回复
    // 每帧重排几十次(气泡在滚动容器里,每次都要重算 scrollHeight),
    // 表现为卡顿。用 rAF 合帧后视觉上仍是逐字出现。
    h.bubble.dataset.text = h.acc;
    if (!h.raf) {
      h.raf = requestAnimationFrame(() => {
        h.raf = 0;
        if (h.cancelled || !h.bubble) return;
        // 必须经 setAiBody 写进 .ai-body:直接改 textContent 会把
        // 复制按钮和内容容器一起抹掉,气泡从此渲染成空壳。
        setAiBody(h.bubble, h.bubble.dataset.text || h.acc);
        if (state.activeThreadId === thread?.id || (!thread && !state.activeThreadId)) {
          aiStickScroll(); // 贴底才跟随;用户上滚阅读时不打扰
        }
      });
    }
  });
  window.nebula.on('ai:done', (done) => {
    const match = findRequestHolder(done.requestId);
    if (match) aiFinishHolder(done);
  });
  // 工具回合:命令输出流进对应步骤行;模型拼工具参数期间也算活跃(防空闲误判)。
  window.nebula.on('ai:tool-output', routeToolOutput);
  window.nebula.on('ai:tool-delta', ({ requestId }) => aiTouchRequest(requestId));
  // 主机条跟随当前会话与连接状态(作用于哪台主机、是否可用工具)。
  window.addEventListener('nb:active-session', refreshAgentHostBar);
  window.addEventListener('nb:session-status', refreshAgentHostBar);
  window.nebula.on('ssh:status', () => setTimeout(refreshAgentHostBar, 0));
  // 多主机链接注册表变化(建链/断链/掉线)→ 刷新主机钮与菜单。
  setLinksChangeHandler(() => refreshAgentHostBar());
  // 退出前断开全部 AI 无头链接(复用中的标签会话不受影响)。
  // 用 sendBeacon 式的同步尽力而为:这里是纯 IPC,失败也不阻塞退出。
  window.addEventListener('beforeunload', () => {
    for (const th of state.aiThreads?.values?.() || []) {
      if (th.linkedHostIds?.length) clearThreadLinks(th);
    }
  });
  window.nebula.on('ai:error', ({ requestId, message, code }) => {
    const match = findRequestHolder(requestId);
    if (match) {
      const h = match.holder;
      h.failedCode = code || null;
      // 先撤等待态再写错误文案:clearBubbleState 会清掉"正在思考…"占位,
      // 反过来的话首 token 前报错会把刚写好的错误提示一起抹掉。
      if (h.bubble) {
        clearBubbleState(h.bubble);
        setAiBody(h.bubble, (h.acc ? h.acc + '\n' : '') + '⚠️ ' + message);
      }
      h.failed = message;
      aiFinishHolder({ requestId });
    }
  });
}

/// 面板边界拖拽调宽:sidebar(左边界)、ai-panel(右边界)。
/// 拖动时直接写面板的 width,上下限交给面板自己的 min/max-width 兜底;
/// 结束后 fitAllVisible() 让 xterm 按新宽度重新排字。
function setupResizers() {
  const panels = {
    'sidebar-resizer': { el: () => $('#sidebar'), side: 'left' },
    'ai-resizer': { el: () => $('#ai-panel'), side: 'right' },
  };
  for (const [id, { el, side }] of Object.entries(panels)) {
    const grip = document.getElementById(id);
    if (!grip) continue;
    grip.addEventListener('pointerdown', (ev) => {
      const panel = el();
      if (!panel || panel.classList.contains('hidden') || panel.classList.contains('collapsed') || hasOpenModal()) return;
      closeModelMenu();
      closeModeMenu();
      closeThreadMenu();
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      grip.classList.add('dragging');
      document.body.classList.add('resizing');
      const startX = ev.clientX;
      const startW = panel.getBoundingClientRect().width;
      let lastFit = 0;
      const move = (e) => {
        const dx = e.clientX - startX;
        const style = getComputedStyle(panel);
        const minimum = parseFloat(style.minWidth) || 180;
        const otherWidth = [...document.querySelectorAll('#sidebar, #ai-panel')]
          .filter((element) => element !== panel && !element.classList.contains('hidden'))
          .reduce((sum, element) => sum + element.getBoundingClientRect().width, 0);
        const maximum = Math.max(minimum, Math.min(parseFloat(style.maxWidth) || Infinity, window.innerWidth - otherWidth - 340));
        const requested = side === 'left' ? startW + dx : startW - dx;
        panel.style.width = Math.round(Math.max(minimum, Math.min(maximum, requested))) + 'px';
        if (id === 'sidebar-resizer') expandedSidebarWidth = panel.getBoundingClientRect().width;
        // 拖动过程中节流重排终端,松手后再精排一次
        const now = performance.now();
        if (now - lastFit > 100) { lastFit = now; fitAllVisible(); }
      };
      const up = (e) => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        grip.removeEventListener('lostpointercapture', up);
        grip.classList.remove('dragging');
        document.body.classList.remove('resizing');
        if (e.type === 'pointerup') move(e);
        if (grip.hasPointerCapture(ev.pointerId)) grip.releasePointerCapture(ev.pointerId);
        fitAllVisible();
        scheduleResizeSync();
        refreshCommandStates();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
      grip.addEventListener('lostpointercapture', up);
    });
    // 双击把手:sidebar 收起(拖到最窄的直觉延伸);其余面板恢复默认宽度。
    // 收起走 toggleSidebar,让工具栏按钮的 active 态同步。
    grip.addEventListener('dblclick', () => {
      closeModelMenu();
      closeModeMenu();
      closeThreadMenu();
      if (id === 'sidebar-resizer') { toggleSidebar(); return; }
      el().style.width = '';
      fitAllVisible();
    });
  }
}

export async function boot() {
  // data-accel 里的动作名(如 'term.copy')在 core.applyAccelTitles 渲染时
  // 经此查 keymap(core 不反向依赖 keymap,由这里注入解析器)。
  applyAccelTitles._accelSpec = accelSpec;
  // 解 terminal→ai 循环依赖:选中「解释」按钮点击时经此回调 aiSend;
  // 回复在 AI 页签里,先把它切出来
  bindSelectionExplain._aiSend = (text, mode, opts) => {
    setRightPanel(true, 'ai');
    return aiSend(text, mode, opts);
  };
  // 快捷键提示必须在渲染前按平台重写:HTML 里不带写死的 ⌘,全靠这一步填入。
  // 先按内置默认填一遍(设置尚未到达),拿到 settings 后按自定义键位再填一遍。
  applyAccelTitles();
  // 静态 HTML 里的 data-icon 占位符统一注入 SVG(见 shared/icons.js)
  hydrateIcons(document);
  bindModalInteractions();
  bindAiCodeActions();
  bindAiScroll();
  bindEvents();
  buildMenubar();
  bindPalette();
  bindPaneToolbars();
  bindTabStrip();
  setupResizers();
  bindContextMenu();
  bindWindowControls();
  // 发送钮初始图标:HTML 里不放 SVG,统一由 setAiBusy 渲染(否则首帧按钮为空,
  // 要等第一次发送才有图标)
  setAiBusy(false);
  // 启动时同步一次收起按钮的状态(侧栏默认展开):此后由 toggleSidebar 维护
  syncSidebarToggle($('#sidebar').classList.contains('collapsed'));
  // 设置就位后才能确定生效键位:清掉 keymap 的解析缓存,重写全部 data-accel
  // 提示,再生成 macOS 菜单栏(加速键取自 specOf,带自定义覆盖)。
  state.settings = await api('settings:get');
  invalidateKeymapCache();
  applyAccelTitles();
  // macOS 菜单栏在命令注册之后生成;生成前仍是 Tauri 默认菜单(其 ⌘W 已由
  // 全局 keydown 的 preventDefault 挡住)
  buildNativeMenu();
  applyTheme(state.settings?.terminal?.theme || 'nebula');
  await refreshHosts();
  await refreshAiModels();
  ensureDefaultAiThread();
  renderAiMessage('assistant', '你好，我是 NebulaShell 内置 AI 助手 ✨');
  updateAiContextIndicator();
}

boot();

// 端到端测试钩子(仅 Tauri 测试桥环境注入):模拟键盘输入走完整广播/历史链路
if (window.__NB_E2E__ || window.nebula && window.nebula.testMode) {
  // Identity tokens are observation-only: never tag production objects or mutate
  // layout trees. Repeated snapshots can detect recreation even when IDs match.
  const identities = new WeakMap();
  let identitySeq = 0;
  const identity = (object) => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return null;
    if (!identities.has(object)) identities.set(object, ++identitySeq);
    return identities.get(object);
  };
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const layoutSnapshot = (layout) => layout ? JSON.parse(JSON.stringify(layout)) : null;
  const workspaceState = (details = false) => ({
    mode: state.workspace.mode,
    fits: state.workspace.fits,
    layout: layoutSnapshot(state.workspace.layout),
    activeTabId: state.activeTabId,
    activeId: state.activeId,
    focusedPaneId: focusedPaneId(),
    zoomPaneId: state.zoomPaneId,
    broadcast: [...(state.broadcast || [])],
    root: rect($('#layout-root')),
    focus: { tabId: document.activeElement?.closest('.workspace-tile')?.dataset.tab || null, paneId: document.activeElement?.closest('.term-pane')?.dataset.pane || null },
    tabs: [...state.tabs.values()].map((tab) => {
      const tile = [...document.querySelectorAll('.workspace-tile')].find((el) => el.dataset.tab === tab.id);
      return {
        id: tab.id, activePaneId: tab.activePaneId, zoomPaneId: tab.zoomPaneId,
        layout: layoutSnapshot(tab.layout),
        ...(details ? { identity: identity(tab), layoutIdentity: identity(tab.layout), tile: rect(tile), header: rect(tile?.querySelector('.workspace-tile-header')), content: rect(tile?.querySelector('.workspace-tile-content')) } : {}),
        panes: [...tab.panes.values()].map((pane) => ({
          id: pane.id, sessionId: pane.sessionId, mounted: pane.el.isConnected, rect: rect(pane.el),
          ...(details ? { identity: identity(pane), elementIdentity: identity(pane.el) } : {}),
        })),
      };
    }),
    sessions: [...state.sessions.values()].map((session) => {
      const r = session.pane?.getBoundingClientRect();
      const visible = !!(session.pane?.isConnected && session.pane.getClientRects().length && r?.width > 0 && r?.height > 0);
      let buffer = '';
      if (details) {
        try {
          const b = session.term.buffer.active;
          buffer = Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) || '').join('\n');
        } catch { /* disposed terminals are reported through identity/status */ }
      }
      let proposed = null;
      if (details && visible) { try { proposed = session.fit.proposeDimensions(); } catch { /* unavailable before first paint */ } }
      return {
        id: session.sessionId, host: session.host.id, tabId: session.tabId, paneId: session.paneId,
        status: session.status, readOnly: !!session.readOnly, mounted: !!session.pane?.isConnected, visible,
        cols: session.term.cols, rows: session.term.rows,
        // 会话日志状态(断线续录的 e2e 断言用):logFile 是完整路径,日志只读字段
        logActive: !!session.logActive, logFile: session.logFile || null,
        ...(details ? { identity: identity(session), termIdentity: identity(session.term), fitIdentity: identity(session.fit), paneIdentity: identity(session.pane), surface: rect(session.pane?.querySelector('.term-surface')), proposed, buffer } : {}),
      };
    }),
  });
  window.__nbTest = {
    workspaceState,
    askPrompt,
    askConfirm,
    confirmOpen: () => !$('#modal-confirm').classList.contains('hidden'),
    confirmClickOk: () => $('#btn-confirm-ok').click(),
    confirmClickCancel: () => $('#btn-confirm-cancel').click(),
    confirmText: () => $('#confirm-message').textContent,
    confirmTitle: () => $('#confirm-title').textContent,
    // 默认焦点落在哪个键 —— 用于断言安全决策(指纹变更)不会默认选中"信任"
    confirmFocus: () => (document.activeElement === $('#btn-confirm-ok') ? 'ok' : document.activeElement === $('#btn-confirm-cancel') ? 'cancel' : 'other'),
    // 口令输入框(导出/导入用)
    promptOpen: () => !$('#modal-prompt').classList.contains('hidden'),
    promptTitle: () => $('#prompt-title').textContent,
    promptValue: () => $('#prompt-input').value,
    promptFill: (v) => { $('#prompt-input').value = v; },
    promptClickOk: () => $('#btn-prompt-ok').click(),
    promptClickCancel: () => $('#btn-prompt-cancel').click(),
    // 模型选择弹框:候选列表来自真实拉取结果,断言用
    modelPickerOpen: () => !$('#modal-model-picker').classList.contains('hidden'),
    // 候选项文本(名称 + 属性分行渲染,这里合并成一行便于断言)
    modelPickerItems: () => [...document.querySelectorAll('#model-picker-list .picker-item')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
    modelPickerIds: () => [...document.querySelectorAll('#model-picker-list .picker-item')].map((b) => b.dataset.model),
    // 已勾选的模型 id —— "只有勾中的才能用"这条契约的观测点
    modelPickerChecked: () => [...document.querySelectorAll('#model-picker-list .picker-item.active')].map((b) => b.dataset.model),
    modelPickerToggle: (id) => {
      const el = document.querySelector(`#model-picker-list .picker-item[data-model="${CSS.escape(id)}"]`);
      if (!el) return false;
      el.click();
      return true;
    },
    modelPickerSelectAll: () => $('#btn-model-picker-all').click(),
    modelPickerSelectNone: () => $('#btn-model-picker-none').click(),
    modelPickerCount: () => $('#model-picker-count').textContent,
    modelPickerFilter: (kw) => { $('#model-picker-search').value = kw; $('#model-picker-search').dispatchEvent(new Event('input', { bubbles: true })); },
    modelPickerKey: (key) => $('#model-picker-search').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    modelPickerValue: () => $('#ai-model').value,
    // "模型"一栏展示的 chip(选中的模型必须都在这里);读模型名 span,
    // 不能读整 chip 的 textContent —— 里面还有 ✕ 移除按钮的文字
    modelChips: () => [...document.querySelectorAll('#ai-model-chips .model-chip')].map((b) => (b.querySelector('.model-chip-name') || b).textContent),
    modelChipActive: () => ($('#ai-model-chips .model-chip.active .model-chip-name') || {}).textContent || '',
    modelChipDefaultBadge: () => ($('#ai-model-chips .model-chip.active .model-chip-default') || {}).textContent || '',
    modelSwitchOptions: () => [...document.querySelectorAll('#ai-model-menu-list .ai-model-menu-item')].map((b) => b.dataset.model),
    modelSwitchValue: () => savedAiModelId(),
    // 对话气泡的状态类与文本:等待态/流式态渲染的观测点
    aiBubbles: () => [...((document.querySelector('#ai-messages .ai-thread-view.active') || document.querySelector('#ai-messages') || document).querySelectorAll('.ai-msg'))].map((b) => ({
      role: b.className.replace(/ai-msg\s*/, '').trim(),
      text: b.textContent,
      pending: b.classList.contains('pending'),
      streaming: b.classList.contains('streaming'),
      hasSpinner: !!b.querySelector('.ai-spinner'),
    })),
    // 设置窗口的 AI 分区是否还开着(验证 Esc 只关最上层)
    aiSettingsOpen: () => settingsOpen() && settingsSection() === 'ai',
    settingsOpen: () => settingsOpen(),
    settingsSection: () => settingsSection(),
    openSettings: (sec) => openSettings(sec),
    dismissSettings: () => dismissSettings(),
    // 已保存的自定义键位(动作名 → 键位数组);空对象 = 全部默认
    keybindings: () => ({ ...((state.settings && state.settings.keybindings) || {}) }),
    // 右侧工具栏:是否打开、当前页签、焦点是否在面板内
    rightPanel: () => ({ open: rightPanelOpen(), tab: rightPanelTab(), focusInside: $('#ai-panel').contains(document.activeElement) }),
    // 温度设置是否已移除
    hasTempField: () => !!$('#ai-temp'),
    // AI 输入行:发送按钮与输入框是否等高
    aiInputHeights: () => {
      const i = $('#ai-input');
      const b = $('#ai-send').getBoundingClientRect();
      return {
        input: Math.round(i.getBoundingClientRect().height),
        inputScroll: i.scrollHeight, inputClient: i.clientHeight,
        send: Math.round(b.height), sendW: Math.round(b.width),
      };
    },
    // 生成命令是否已移除(按钮 + 快捷按钮行内都不该再有)
    genButtonGone: () => !$('#btn-ai-gen') && !String(document.querySelector('#ai-messages')?.textContent || '').includes('生成命令'),
    // 助手消息的渲染形态:Markdown 结构 / 复制按钮 / 诊断素材
    aiMsgDetail: () => [...((document.querySelector('#ai-messages .ai-thread-view.active') || document.querySelector('#ai-messages') || document).querySelectorAll('.ai-msg'))].map((b) => ({
      role: b.dataset.role,
      text: b.querySelector('.ai-body')?.textContent || '',
      hasCopy: !!b.querySelector('.ai-copy'),
      hasCode: !!b.querySelector('.ai-body pre code'),
      mdBlocks: b.querySelectorAll('.ai-body > p, .ai-body > pre, .ai-body > ul, .ai-body > ol, .ai-body > h3').length,
    })),
    aiCopyClick: (idx) => {
      const c = document.querySelector('#ai-messages .ai-thread-view.active') || document.querySelector('#ai-messages') || document;
      const b = c.querySelectorAll('.ai-msg')[idx];
      if (!b) return false;
      b.querySelector('.ai-copy')?.click();
      return true;
    },
    aiThreads: () => [...(state.aiThreads?.values() || [])].map((t) => ({
      id: t.id,
      title: t.title,
      hostId: t.hostId,
      hostName: t.hostName,
      historyLength: t.history?.length || 0,
      active: t.id === state.activeThreadId,
      busy: !!t.req,
      unread: !!t.unread,
      draft: t.draft || '',
      execMode: t.execMode || 'manual',
      linkMode: t.linkMode || (t.execMode === 'chat' ? 'chat' : 'follow'),
      linkedHostIds: [...(t.linkedHostIds || [])],
      allowlistLength: t.allowlist?.length || 0,
      sendBlocked: !!t.sendBlocked,
    })),
    aiActiveText: () => {
      const activeView = document.querySelector('#ai-messages .ai-thread-view.active');
      return (activeView || document.querySelector('#ai-messages'))?.textContent || '';
    },
    // 诊断素材:最后一次命令 + 输出采集(直接断言采集层,不经过 AI 请求)
    diagSource: () => {
      const s = state.sessions.get(state.activeId);
      return s ? { cmd: s.lastCmd || '', output: (s.lastOutput || '').slice(0, 300), collecting: !!s.collectOutput } : null;
    },
    /// 选中悬浮「解释」按钮(T9z):全选当前会话(制造可视选区)返回按钮状态;
    /// hide=true 时清除选区并断言按钮隐藏。
    explainBubble: async (opts) => {
      const o = opts || {};
      const s = state.sessions.get(state.activeId);
      if (!s) return { hasBubble: !!document.querySelector('#ai-explain-bubble'), shown: false };
      if (o.clear) s.term.clearSelection();
      else s.term.selectAll();
      await new Promise((r) => setTimeout(r, 120)); // onSelectionChange 异步定位
      const b = document.querySelector('#ai-explain-bubble');
      const rect = b?.getBoundingClientRect();
      return { hasBubble: !!b, shown: !!b && !b.classList.contains('hidden') && b.classList.contains('show') && b.getClientRects().length > 0,
        top: rect ? Math.round(rect.top) : 0, left: rect ? Math.round(rect.left) : 0 };
    },
    /// 选区整体滚出视口(T9z3/T9z4):在 nb-lines 输出上建多行选区,先滚到可见处记下浮层块数
    /// 与 🔍 状态(对照,应可见),再滚到让它整体落在视口上方/下方,记下仍有面积的浮层块数
    /// (应为 0)与 🔍 是否还显示(应隐藏)。
    selectionOverlayOffscreen: async () => {
      const s = state.sessions.get(state.activeId);
      if (!s) return null;
      const t = s.term;
      const buf = t.buffer.active;
      // 选区重绘挂在 rAF 上;窗口被遮挡时 rAF 暂停,超时兜底免得钩子挂死
      const settle = () => Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((r) => setTimeout(r, 400)),
      ]);
      const blocks = () => [...s.pane.querySelectorAll('.xterm-selection > div')]
        .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
      const rowOf = (prefix) => {
        for (let i = 0; i < buf.length; i++) if (buf.getLine(i)?.translateToString(true).startsWith(prefix)) return i;
        return -1;
      };
      const bubbleShown = () => !!document.querySelector('#ai-explain-bubble')?.classList.contains('show');
      const probe = async (prefix, scrollAway) => {
        const row = rowOf(prefix);
        if (row < 0) return { row };
        t.scrollToLine(Math.max(0, row - 2));
        t.select(7, row, t.cols * 2 + 8); // 跨 3 行、起止列不同:缺陷下首行色带宽 8 列
        await settle();
        const visible = blocks();
        const bubbleBefore = bubbleShown();
        scrollAway();
        await settle();
        return { row, visible, offscreen: blocks(), bubbleBefore, bubbleAfter: bubbleShown(), selected: t.getSelection().length };
      };
      // 与滚轮/拖滚动条同一条路径:改 viewport 的 scrollTop,由 xterm 的 scroll 处理换算成行
      const vp = s.pane.querySelector('.xterm-viewport');
      const above = await probe('nb-line-005', () => { vp.scrollTop = vp.scrollHeight; });
      const below = await probe('nb-line-145', () => { vp.scrollTop = 0; });
      t.clearSelection();
      t.scrollToBottom();
      return { rows: t.rows, above, below };
    },
    write: (d) => {
      const s = state.sessions.get(state.activeId);
      if (s && s.status === 'connected' && !s.readOnly) s.term.input(d);
    },
    // 断开横幅回车探针(T85):未连接会话无法走 write(有状态门槛),
    // 这里按窗格直达 term.input('\r') —— 与真实键盘一致地经 onData 交付,
    // 聚焦"未连接回车 = 就地重连"这条分支本身。
    sendEnter: (paneId) => {
      const s = [...state.sessions.values()].find((x) => x.paneId === paneId);
      if (!s) return false;
      s.term.input('\r');
      return true;
    },
    /// 向指定窗格的会话输入任意文本(会话日志 e2e 用:产生回显进入日志)
    sendText: (paneId, text) => {
      const s = [...state.sessions.values()].find((x) => x.paneId === paneId);
      if (!s) return false;
      s.term.input(String(text));
      return true;
    },
    /// 终端按键路由探针:在活动会话的 xterm textarea 上派发 keydown(完整走
    /// attachCustomKeyEventHandler → xterm → 冒泡到全局分发),用临时
    /// term.onData 记录 shell 实际收到的数据。回报:是否 preventDefault、
    /// shell 收到什么、执行了哪个命令、活动标签是否变化。
    /// 修饰键取 { ctrl, meta, shift, alt };keyCode 缺省按键名推导 —— new
    /// KeyboardEvent 的 keyCode 恒为 0,而 xterm 按 keyCode 求值(ctrl+c → \x03
    /// 依赖 67),不补就会出现"放行后 xterm 什么都不发"的假象。
    /// select=true 时先写一行标记并选中,false 时清掉选区,缺省不动选区。
    termKeyProbe: async (opts) => {
      const o = opts || {};
      const s = state.sessions.get(state.activeId);
      if (!s) return { ok: false, why: 'no-session' };
      const term = s.term;
      if (o.select === true) {
        await new Promise((r) => term.write('\r\nPROBE-COPY-MARK-9137\r\n', r));
        const buf = term.buffer.active;
        let row = -1;
        for (let i = buf.length - 1; i >= 0; i--) {
          const l = buf.getLine(i);
          if (l && l.translateToString(true).includes('PROBE-COPY-MARK-9137')) { row = i; break; }
        }
        if (row < 0) return { ok: false, why: 'mark-not-found' };
        term.select(0, row, 'PROBE-COPY-MARK-9137'.length);
      } else if (o.select === false) { try { term.clearSelection(); } catch { /* ignore */ } }
      const key = o.key || 'c';
      const letter = /^[a-z]$/i.test(key);
      const digit = /^[0-9]$/.test(key);
      const code = o.code || (letter ? 'Key' + key.toUpperCase() : digit ? 'Digit' + key : key);
      const keyCode = o.keyCode || (letter ? key.toUpperCase().charCodeAt(0) : digit ? key.charCodeAt(0) : key === 'Enter' ? 13 : 0);
      const emitted = [];
      const commands = [];
      const onCommand = (e) => commands.push(e.detail.id);
      document.addEventListener('nebula:command', onCommand);
      const disp = term.onData((d) => emitted.push(d));
      const tabBefore = state.activeTabId;
      // 只观测、不投递:派发期间置只读,onData 不会把 \x04 之类真的写进会话
      // (Ctrl+D 会让远端 shell 登出,影响后续用例)。派发是同步的,随即恢复。
      const prevRo = s.readOnly;
      s.readOnly = true;
      let err = '';
      let kbd = null;
      try {
        kbd = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code,
          ctrlKey: !!o.ctrl, metaKey: !!o.meta, shiftKey: !!o.shift, altKey: !!o.alt });
        Object.defineProperty(kbd, 'keyCode', { get: () => keyCode });
        term.textarea.dispatchEvent(kbd);
      } catch (e) { err = e.message; }
      s.readOnly = prevRo;
      disp.dispose();
      document.removeEventListener('nebula:command', onCommand);
      const all = emitted.join('');
      return { ok: !err, err, prevented: !!(kbd && kbd.defaultPrevented), hadSelection: !!term.hasSelection(), selection: term.getSelection(),
        sigintSent: all.includes('\x03'), emitted: all, commands, tabChanged: state.activeTabId !== tabBefore };
    },
    /// 终端复制链路探针(T61):有选区/无选区下按复制键(缺省为平台应用修饰键
    /// +C),回报是否把 \x03(SIGINT)发给了 shell。观测点选在 onData 而非
    /// ssh:write:后者要求会话已连接,而契约就是"有选区 = 不向 shell 发任何数据"。
    termCopyProbe: (opts) => {
      const o = opts || {};
      return window.__nbTest.termKeyProbe({ select: o.select !== false, key: o.key || 'c', keyCode: 67,
        ctrl: o.ctrl ?? PLATFORM !== 'darwin', meta: o.meta ?? PLATFORM === 'darwin', shift: !!o.shift });
    },
    /// 终端粘贴探针(T62):派发真实粘贴键 keydown(缺省 ⌘V / Ctrl+V),统计"插入次数"(stub
    /// term.paste)与"原生 paste 事件数" —— 修复前手动 readText 链路 + 浏览器
    /// 默认粘贴(→ xterm 的 paste 监听器)各插一次,粘贴内容翻倍。
    /// stub 不真正粘贴,避免把测试机剪贴板内容打进会话;readOnly 期间 onData
    /// 也不落盘,双保险。
    termPasteProbe: async (opts) => {
      const o = opts || {};
      const s = state.sessions.get(state.activeId);
      if (!s) return { ok: false, why: 'no-session' };
      const term = s.term;
      const origPaste = term.paste;
      let pasteCalls = 0;
      term.paste = () => { pasteCalls++; };
      let pasteEvents = 0;
      const onPaste = () => { pasteEvents++; };
      term.textarea.addEventListener('paste', onPaste);
      const prevRo = s.readOnly;
      s.readOnly = true;
      let kbd = null;
      let err = '';
      try {
        kbd = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: o.shift ? 'V' : 'v', code: 'KeyV',
          ctrlKey: o.ctrl ?? PLATFORM !== 'darwin', metaKey: o.meta ?? PLATFORM === 'darwin', shiftKey: !!o.shift });
        Object.defineProperty(kbd, 'keyCode', { get: () => 86 });
        term.textarea.dispatchEvent(kbd);
      } catch (e) { err = e.message; }
      await new Promise((r) => setTimeout(r, 150)); // 手动 readText 与原生 paste 事件都在此窗口内到达
      s.readOnly = prevRo;
      term.textarea.removeEventListener('paste', onPaste);
      term.paste = origPaste;
      return { ok: !err, err, prevented: !!(kbd && kbd.defaultPrevented), pasteEvents, pasteCalls };
    },
    /// 命令面板(T90 系列):打开、查询、执行当前项、快照
    palette: () => paletteSnapshot(),
    paletteOpen: () => isPaletteOpen(),
    paletteQuery: (q) => { paletteInput(q); return paletteSnapshot(); },
    paletteKey: (key, mods = {}) => {
      const input = $('#palette-input');
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift });
      input.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    /// 命令注册表:全部命令及当前状态
    commands: () => listCommands(),
    commandState: (id) => commandState(id),
    runCommand: (id) => executeCommand(id),
    /// macOS 菜单栏:规格覆盖的命令 + 最近一次写入原生菜单的状态
    nativeMenu: () => nativeMenuSnapshot(),
    menubar: () => menubarSnapshot(),
    /// 关闭拦截:与红灯/✕ 同一条路(窗口 close() → Rust CloseRequested)
    requestWindowClose: () => requestWindowClose(),
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
    // 云账号凭据表单:供 e2e 驱动"一次性填写 + 测试连接"链路
    cloudForm: () => ({
      open: !$('#cloud-account-form').classList.contains('hidden'),
      inline: $('#cloud-account-form').classList.contains('inline'),
      hostRow: $('#cloud-account-form').parentElement?.classList?.contains('cloud-account-row') || false,
      editingId: state.cloudEditing ? state.cloudEditing.id : null,
      keyIdLabel: $('#cloud-form-keyid-label').textContent,
      secretLabel: $('#cloud-form-secret').placeholder,
      secretValue: $('#cloud-form-secret').value,
      eyeHidden: $('#btn-reveal-cloud-secret').classList.contains('hidden'),
      focused: document.activeElement?.id || null,
      hasFormTestBtn: !!document.querySelector('#btn-cloud-test'),
      accountCount: state.cloudAccounts.length,
      helpHtml: $('#cloud-form-help').innerHTML,
    }),
    cloudFormFill: (o) => {
      // 派发真实 input/change 事件,与用户敲键盘走完全相同的路径
      // (否则"改动后清空校验结论"这类绑定在测试里不会被触发)
      const setVal = (sel, v, evt) => {
        const el = $(sel);
        el.value = v;
        el.dispatchEvent(new Event(evt, { bubbles: true }));
      };
      if (o.vendor !== undefined) setVal('#cloud-form-vendor', o.vendor, 'change');
      if (o.label !== undefined) setVal('#cloud-form-label', o.label, 'input');
      if (o.keyId !== undefined) setVal('#cloud-form-keyid', o.keyId, 'input');
      if (o.secret !== undefined) setVal('#cloud-form-secret', o.secret, 'input');
      if (o.endpoint !== undefined) setVal('#cloud-form-endpoint', o.endpoint, 'input');
    },
    cloudFormSave: () => $('#btn-cloud-form-save').click(),
    // 文件面板状态:供 e2e 断言"面板标识的目标 = 当前会话",以及切换后是否跟随
    sidebar: () => ({
      open: !$('#sidebar').classList.contains('collapsed'),
      resizerOpen: !$('#sidebar-resizer').classList.contains('hidden'),
      btnActive: $('#btn-sidebar-toggle').classList.contains('active'),
      mainW: Math.round($('#main').getBoundingClientRect().width),
    }),
    /// 文件分屏探针:index 选择可见文件分屏(0 = 第一个),返回该屏内容状态。
    filePanel: (index = 0) => {
      const elp = [...document.querySelectorAll('.term-pane.file-pane')][index];
      if (!elp) return null;
      const pane = filePaneFromEl(elp);
      const g = (sel) => elp.querySelector(sel);
      return {
        paneId: elp.dataset.pane,
        mounted: elp.isConnected,
        focused: elp.classList.contains('focused'),
        cwd: pane?.cwd ?? null,
        loading: !!pane?.loading,
        stale: !!pane?.stale,
        // 最近一次操作使用的传输通道(同主机内可能随提交切换)
        sessionId: pane?.lastSessionId ?? null,
        histLen: pane?.hist?.length ?? 0,
        histIdx: pane?.histIdx ?? -1,
        selections: pane?.selectedNames ?? [],
        // 路径栏是输入框:textContent 恒空,断言读 value;nav 是导航三连的可用态
        pathValue: g('.file-path')?.value ?? '',
        nav: {
          back: !g('.fp-back')?.disabled,
          forward: !g('.fp-forward')?.disabled,
          up: !g('.fp-up')?.disabled,
        },
        // 底部状态栏已移除:状态文案读窗格数据(statusText),不再读 DOM
        status: pane?.statusText ?? '',
        lastOpen: pane?.lastOpen ?? null,
        rows: elp.querySelectorAll('.file-list .file-row').length,
        names: [...elp.querySelectorAll('.file-list .file-row .f-name')].map((e) => e.textContent),
        toolbar: [...elp.querySelectorAll('.file-toolbar .btn')].map((b) => ({
          cls: b.className, text: b.textContent.trim(), title: b.title,
        })),
        // 书签读缓存(下拉与管理对话框的数据源);bookmarked = 当前目录的 ★ 是否实心
        bookmarks: filePaneBookmarks(pane).paths,
        bookmarked: filePaneBookmarks(pane).marked,
        // 状态:加载中的输入行可见性(重命名/新建共用)
        mkdirRowOpen: !g('.fp-mkdir-row')?.classList.contains('hidden'),
        chmodRowOpen: !g('.fp-chmod-row')?.classList.contains('hidden'),
      };
    },
    /// 文件分屏结构探针:所有标签的文件分屏状态(多屏回归用)
    filePanes: () => ({
      focusedPaneId: focusedFilePane()?.id ?? null,
      panes: [...state.tabs.values()].flatMap((tab) => [...tab.panes.values()]
        .filter((p) => p.kind === 'file')
        .map((p) => ({
          paneId: p.id, tabId: tab.id, mounted: p.el.isConnected,
          cwd: p.cwd, loading: !!p.loading, stale: !!p.stale,
          histLen: p.hist?.length ?? 0, histIdx: p.histIdx ?? -1,
          selections: p.selectedNames ?? [],
        }))),
    }),
    /// 任务中心探针(DOM 渲染结果,不暴露内部存储)
    fileTasks: () => ({
      badge: $('#file-task-badge')?.textContent ?? null,
      badgeVisible: !$('#file-task-badge')?.classList.contains('hidden'),
      popoverOpen: !$('#file-task-popover')?.classList.contains('hidden'),
      statusBarBtn: !$('#btn-file-tasks-status')?.classList.contains('hidden'),
      tasks: [...document.querySelectorAll('#file-task-list .fp-task')].map((row) => ({
        label: row.querySelector('.fp-task-label')?.textContent ?? '',
        // 状态文字在行首图标的 title;sub = 信息行(进度/速度/剩余,完成后大小/用时/位置)
        stage: row.querySelector('.fp-task-dot')?.title ?? '',
        dot: row.querySelector('.fp-task-dot')?.className.replace('fp-task-dot', '').trim() ?? '',
        sub: row.querySelector('.fp-task-info')?.textContent ?? '',
        subTitle: row.querySelector('.fp-task-info')?.title ?? '',
        bar: row.querySelector('.fp-task-bar:not(.hidden) > i')?.style.width || null,
        actions: [...row.querySelectorAll('.fp-task-actions button')].map((b) => b.dataset.action + (b.disabled ? ':disabled' : '')),
      })),
    }),
    /// 任务中心操作:按标签(精确,其次包含)找任务行。'行' = 点整行;
    /// 取消/显示/打开/清除 = 点行尾对应按钮
    fileTaskClick: (label, action) => {
      const rows = [...document.querySelectorAll('#file-task-list .fp-task')];
      const text = (r) => r.querySelector('.fp-task-label')?.textContent ?? '';
      const row = rows.find((r) => text(r) === label) || rows.find((r) => text(r).includes(label));
      if (!row) return false;
      if (action === '行') { row.click(); return true; }
      const cls = { 取消: 'cancel', 显示: 'reveal', 打开: 'open', 清除: 'clear' }[action];
      const btn = cls && row.querySelector('.fp-task-' + cls);
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    },
    /// 内部拖拽(应用内复制):从 fromName 行按下,移动到 toName 目录行或
    /// 'pane:<index>'(第 N 个可见文件分屏空白处),松开 —— 完整走 pointer 事件链。
    fileDragTo: (fromName, toSpec) => {
      const paneRows = '.term-pane.file-pane .file-row';
      const fromRow = [...document.querySelectorAll(paneRows)]
        .find((r) => r.querySelector('.f-name')?.textContent === fromName);
      if (!fromRow) return { ok: false, why: 'no-source' };
      let target, tRect;
      if (typeof toSpec === 'string' && toSpec.startsWith('pane:')) {
        target = [...document.querySelectorAll('.term-pane.file-pane')][Number(toSpec.slice(5))];
      } else {
        target = [...document.querySelectorAll(paneRows)]
          .find((r) => r.querySelector('.f-name')?.textContent === toSpec);
      }
      if (!target) return { ok: false, why: 'no-target' };
      tRect = target.getBoundingClientRect();
      const r = fromRow.getBoundingClientRect();
      const sx = r.left + 20, sy = r.top + 6;
      const tx = tRect.left + Math.min(40, tRect.width / 2), ty = tRect.top + Math.min(12, tRect.height / 2);
      const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', isPrimary: true, buttons: 1 });
      fromRow.dispatchEvent(pe('pointerdown', sx, sy));
      document.dispatchEvent(pe('pointermove', sx + 4, sy + 4));
      document.dispatchEvent(pe('pointermove', (sx + tx) / 2, (sy + ty) / 2));
      document.dispatchEvent(pe('pointermove', tx, ty));
      const ghostOk = !document.querySelector('.file-drag-ghost.deny');
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: tx, clientY: ty, pointerId: 7, pointerType: 'mouse', isPrimary: true }));
      return { ok: true, ghostOk };
    },
    /// 多选语义探针:直接驱动 selectEntries(与行 click 同一函数),
    /// 渲染结果经 .selected 类名断言 —— DOM dispatch 在长链路实例上偶发挂起,
    /// 语义测试不必依赖事件派发路径。index 省略 = 焦点分屏,否则第 N 个可见分屏。
    fileSelect: (idx, mods, paneIndex = null) => {
      import('./sftp.js').then((m) => {
        const elp = paneIndex == null
          ? document.querySelector('.term-pane.file-pane.focused') || document.querySelector('.term-pane.file-pane')
          : [...document.querySelectorAll('.term-pane.file-pane')][paneIndex];
        const pane = elp ? m.filePaneFromEl(elp) : null;
        const en = pane && pane.entries[idx];
        if (!pane || !en) return;
        m.selectEntries(pane, en, idx, mods || {});
      });
      return true;
    },
    /// 文件行右键菜单:按名字在列表里找行并派发真实 contextmenu 事件
    fileCtxMenu: (name) => {
      const rows = [...document.querySelectorAll('.term-pane.file-pane .file-row')];
      const row = rows.find((r) => r.querySelector('.f-name').textContent === name);
      if (!row) return null;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 6 }));
      return [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => ({ label: b.querySelector('.ctx-label').textContent, disabled: b.disabled }));
    },
    ctxItemClick: (label) => {
      const btn = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.querySelector('.ctx-label').textContent === label);
      if (!btn) return false;
      btn.click();
      return true;
    },
    ctxMenuOpen: () => !$('#ctx-menu').classList.contains('hidden'),
    /// 注入 Tauri 拖放事件(与真机走同一条 onDragDropEvent 通道)。
    /// 用 event.emit 触发 webview 已注册的监听器 —— 测试因此覆盖的是真实链路,
    /// 而不是"手工调用上传函数"这种绕开事件绑定的假通过。
    fireDragDrop: (type, paths, pos) => {
      const payload = { position: pos || null };
      if (paths) payload.paths = paths;
      return window.__TAURI__.event.emit('tauri://drag-' + type, payload);
    },
    /// 拖拽上传提示条是否可见(拖到文件分屏上方时应出现)
    dropHintVisible: () => !!document.querySelector('.file-drop-hint:not(.hidden)'),
    // 关于弹窗:版本号的新家
    about: () => ({
      open: !$('#modal-about').classList.contains('hidden'),
      version: $('#about-version').textContent,
      platform: $('#about-platform').textContent,
    }),
    // 快捷键提示:断言按平台渲染(mac ⌘ / win·linux Ctrl)
    accelTitles: () => ({
      platform: window.nebula.platform,
      newtab: $('#btn-newtab').title,
      split: $('#btn-split').title,
      // 关闭窗格的快捷键提示改在终端右键等菜单里显示,取同一份渲染结果
      closePane: commandMenuItem('workspace.close').key,
      hasDirectionMenus: !!$('#btn-split-left-right') || !!$('#btn-split-top-bottom'),
      zoom: (document.querySelector('.pane-zoom-btn') || {}).title || '',
    }),
    // 侧边栏底部:版本号与导入/导出均已移除(分别移入关于弹窗与侧栏「管理」菜单)
    footer: () => ({
      version: $('#app-version') ? $('#app-version').textContent : null,
      hasVersion: !!$('#app-version'),
      hasFingerprintBtn: !!$('#btn-fingerprints') && $('#btn-fingerprints').closest('.side-footer') !== null,
      // .side-footer 元素已整体移除:底部只剩快捷连接框
      text: document.querySelector('.side-footer') ? document.querySelector('.side-footer').textContent.trim() : '',
    }),
    // 顶层标题栏:各控件矩形、带拖拽属性的元素(须全在标题栏子树)、与二级区是否重叠
    titlebar: () => {
      const box = (el) => {
        if (!el || !el.getClientRects().length) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
      };
      const bar = $('#titlebar');
      const hit = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const self = box(bar);
      const secondary = { tabbar: box($('#tabbar')), sidebar: box($('#sidebar')), aiHeader: box($('.ai-header')), statusbar: box($('#statusbar')) };
      return {
        bar: self,
        sidebarToggle: box($('#btn-sidebar-toggle')), toolsToggle: box($('#btn-ai-toggle')),
        brand: box(bar.querySelector('.tb-brand')), traffic: box(bar.querySelector('.tb-traffic')),
        menubar: box($('#menubar')), winControls: box($('#win-controls')),
        dragRegions: [...document.querySelectorAll('[data-tauri-drag-region]')].map((el) => ({
          sel: el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0], value: el.getAttribute('data-tauri-drag-region'), inTitlebar: bar.contains(el) })),
        overlaps: Object.entries(secondary).filter(([, r]) => hit(self, r)).map(([name]) => name),
        fullscreen: document.body.classList.contains('is-fullscreen'),
      };
    },
    // 窗格几何网格:用于断言"新增分屏后自动整理为均衡网格"
    paneGrid: () => {
      const panes = [...document.querySelectorAll('.term-pane')].map((p) => {
        const r = p.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      });
      const tops = [...new Set(panes.map((p) => p[1]))].sort((a, b) => a - b);
      const rows = tops.map((t) => panes.filter((p) => p[1] === t).length);
      const widths = panes.map((p) => p[2]);
      const heights = panes.map((p) => p[3]);
      // 逐行明细:同一行内的窗格应等宽、各行应等高(等分网格的判据)。
      // 注意"最后一行只放 1 个窗格"时它会占满整行 —— 宽度自然与上一行不同,
      // 这是 tmux 式 2+1 的常态,不是缺陷。
      const rowDetail = tops.map((t) => {
        const inRow = panes.filter((p) => p[1] === t);
        const ws = inRow.map((p) => p[2]);
        return { count: inRow.length, minW: Math.min(...ws), maxW: Math.max(...ws), h: inRow[0][3] };
      });
      return {
        count: panes.length,
        rows,
        cols: rows.length ? Math.max(...rows) : 0,
        rowDetail,
        // 行内等宽 / 行间等高;以及"最窄窗格"是否仍可用
        withinRowWidthSpread: rowDetail.length ? Math.max(...rowDetail.map((r) => r.maxW - r.minW)) : 0,
        acrossRowHeightSpread: rowDetail.length ? Math.max(...rowDetail.map((r) => r.h)) - Math.min(...rowDetail.map((r) => r.h)) : 0,
        minW: widths.length ? Math.min(...widths) : 0,
        minH: heights.length ? Math.min(...heights) : 0,
        widthSpread: widths.length ? Math.max(...widths) - Math.min(...widths) : 0,
        heightSpread: heights.length ? Math.max(...heights) - Math.min(...heights) : 0,
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
    // 资源监控条:用给定采样值驱动**真实**渲染路径,并回报各元素几何。
    // 用于回归"数据不定长导致布局抖动" —— 断言不同取值下每个元素的 left/width 恒定。
    // 同时回报渲染文本:测试据此确认"值确实变了",否则几何不变可能只是没渲染出来的假通过。
    monitorProbe: (samples) => {
      const s = state.sessions.get(state.activeId);
      if (!s) return null;
      const ids = ['#mon-lat', '#mon-cpu', '#mon-mem-det', '#mon-disk-det', '#mon-rx', '#mon-tx', '#mon-spark-cpu', '#mon-note', '#mon-cpu-bar', '#mon-mem-bar'];
      const prev = state.metrics.get(state.activeId);
      const history = state.metricHistory.get(state.activeId);
      const out = [];
      for (const sample of samples) {
        state.metrics.set(state.activeId, { supported: true, sessionId: state.activeId, ...sample });
        // 固定历史:sparkline 方格数随采样增长会独立改变自身宽度,先隔离这一变量
        state.metricHistory.set(state.activeId, new Array(16).fill(sample.cpuPct == null ? 0 : sample.cpuPct));
        renderMonitorBar();
        const geo = {};
        for (const id of ids) {
          const el = document.querySelector(id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          geo[id] = [Math.round(r.left * 10) / 10, Math.round(r.width * 10) / 10];
        }
        // 状态栏(监控块的容器)几何:高度变化说明整行折了;行尾按钮的位置
        // 更能说明"监控是否把按钮挤走"——监控数据变化绝不该推动按钮。
        const bar = document.querySelector('#monitor-bar');
        const br = bar.getBoundingClientRect();
        const sb = document.querySelector('#statusbar');
        const btns = ['#btn-log-toggle', '#btn-clear', '#btn-readonly', '#btn-disconnect', '#btn-reconnect']
          .map((id) => document.querySelector(id))
          .filter((e) => e && !e.classList.contains('hidden'))
          .map((e) => Math.round(e.getBoundingClientRect().right * 10) / 10);
        geo.__bar = [
          Math.round(sb.getBoundingClientRect().height * 10) / 10,
          sb.scrollWidth - sb.clientWidth,
          Math.round(br.width * 10) / 10,
          btns,
        ];
        // 渲染文本:证明这次采样真的反映到了界面上
        geo.__text = { cpu: $('#mon-cpu').textContent, mem: $('#mon-mem-det').textContent, disk: $('#mon-disk-det').textContent, rx: $('#mon-rx').textContent, tx: $('#mon-tx').textContent, lat: $('#mon-lat').textContent, note: $('#mon-note').textContent };
        out.push(geo);
      }
      if (prev === undefined) state.metrics.delete(state.activeId); else state.metrics.set(state.activeId, prev);
      if (history === undefined) state.metricHistory.delete(state.activeId); else state.metricHistory.set(state.activeId, history);
      return out;
    },
  };
}

