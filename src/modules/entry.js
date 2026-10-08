// 应用入口:右键菜单、事件绑定、启动(被 app.js 引入)
import { $, activeTab, api, applyAccelTitles, askConfirm, askPrompt, bindCtxMenuDismiss, bindModalInteractions, closeCtxMenu, closeModal, copyText, hasOpenModal, isAppModifier, openModal, PLATFORM, setModalDismissHandler, showCtxMenu, state, toast } from './core.js';
import { isEditableTarget } from './interaction.js';
import { bindCommandButtons, executeCommand, refreshCommandStates, registerCommand } from './commands.js';
import { bindMoreMenu, closeMoreMenu } from './menu.js';
import { activateSession, activateTab, addFilePane, autoLayoutTab, bindSelectionExplain, clearActiveTerm, closeActivePane, closeTab, closeTermSearch, disconnectSession, doTermSearch, firstPaint, fitAllVisible, focusedPaneId, handleSessionStatus, leafCount, maxPaneCapacity, newTabWithPicker, openBroadcastPicker, openTermSearch, reconnectSession, scheduleResizeSync, scheduleWorkspaceLayout, splitActive, togglePaneZoom, toggleReadonly, toggleTabTiling, toggleSessionLog, updateStatusbar, updateTab } from './terminal.js';
import { openFingerprints, openHostModal, refreshHosts, renderHosts, saveHostModal, toggleAuthRows } from './hosts.js';
import { clearCloudTestStatus, closeCloudForm, cloudFetchAll, cloudImportSelected, editCloudAccount, refreshCloudAccounts, saveCloudAccountFromForm, syncCloudFormLabels, testCloudAccount } from './cloud.js';
import { addManualAiModel, aiDiagnose, aiFinishHolder, aiSend, aiStickScroll, aiTestConnection, aiTouchRequest, bindAiCodeActions, bindAiScroll, clearBubbleState, closeAiSettings, closeModelMenu, closeModelPicker, confirmModelPicker, fetchAiModels, fillPreset, filterModelPicker, markBubbleStreaming, movePickerSelection, onAiEndpointChange, openAiSettings, openModelMenu, pickerSelectAll, refreshAiModels, renderAiMessage, renderModelSwitch, savedAiModelId, saveAiSettings, setAiBody, stopAiGeneration, switchModel, togglePickerFocus } from './ai.js';
import { addSnippet, closeSnippetMenu, renderMonitorBar, toggleSnippetMenu } from './monitor.js';
import {
  filePaneFromEl, focusedFilePane, paneSnapshot, routeProgress,
  selectAllEntries, syncFilePanesForSession, uploadLocalPaths,
} from './sftp.js';
import { bindTransferUi, confirmTransferInterrupt } from './file-transfer.js';
import { openTermSettings, saveTermSettings } from './settings.js';
import { bindBatchUi, openBatchModal, openForwardModal, saveForwardRule, toggleHistory } from './tools.js';
import { matchAction, accelOf, accelSpec } from './keymap.js';
import { bindWindowControls } from './window-controls.js';
import { hydrateIcons } from '../shared/icons.js';

export function termFromEvent(e) {
  const paneEl = e.target && e.target.closest ? e.target.closest('.term-pane') : null;
  if (!paneEl) return null;
  const sid = paneEl.dataset.session;
  return sid ? state.sessions.get(sid) || null : null;
}

/// 终端右键菜单:复制/粘贴/全选 + 清屏/搜索/只读。快捷键提示按平台渲染。
export function openTermCtxMenu(e, session) {
  const term = session.term;
  // 选区文本在"菜单打开时"快照:若等点击菜单项时再读 getSelection,
  // 选区可能已被右键/焦点变化清掉,复制到的就是空串或别的内容
  // (用户视角的"复制无效/复制错内容")。
  const selText = (() => { try { return term.getSelection() || ''; } catch { return ''; } })();
  showCtxMenu(e.clientX, e.clientY, [
    { label: '复制', key: accelOf('term.copy'), disabled: !selText, run: () => {
      copyText(selText).then((ok) => toast(ok ? `已复制 ${selText.length} 个字符` : '复制失败：剪贴板不可用', ok ? 'success' : 'error'));
    } },
    { label: '粘贴', key: accelOf('term.paste'), run: () => { navigator.clipboard.readText().then((t) => { if (t && !session.readOnly) term.paste(t); }).catch(() => {}); } },
    { label: '全选', key: accelOf('term.selectAll'), run: () => { try { term.selectAll(); } catch { /* ignore */ } } },
    '-',
    { label: '搜索…', key: accelOf('session.search'), run: () => { activateSession(session.sessionId); openTermSearch(); } },
    // 「诊断报错」入口从 AI 面板快捷按钮迁移至此;tips 与原按钮 title 一致。
    { label: '🩺 诊断报错', title: '只取最后一次输入的命令及其控制台输出,让 AI 诊断', run: () => { activateSession(session.sessionId); aiDiagnose(); } },
    { label: '清屏', run: () => { activateSession(session.sessionId); clearActiveTerm(); } },
    { label: session.readOnly ? '关闭只读' : '设为只读', run: () => { activateSession(session.sessionId); toggleReadonly(); } },
    '-',
    { label: '复制会话 ID', run: () => { copyText(session.sessionId).then((ok) => toast(ok ? '已复制会话 ID' : '复制失败', ok ? 'success' : 'error')); } },
  ]);
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

/// 侧边栏收缩:面板 + 拖拽把手同步显隐。收起时侧栏塌缩为一个窄条,
/// 底部的收起/展开按钮仍留在条上(收起后必须有入口展开,按钮不能随面板消失)。
/// 展开态用按钮文字+图标反映;工具栏按钮(已移除)、功能菜单、
/// 把手双击三处共用这一个入口。
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

/// 收起/展开按钮的状态呈现:图标(☰/»)+ 文案(收起侧边栏/展开侧边栏)。
function syncSidebarToggle(collapsed) {
  const btn = $('#btn-sidebar-toggle');
  btn.classList.toggle('active', !collapsed);
  $('#sidebar-toggle-icon').textContent = collapsed ? '»' : '«';
  const label = collapsed ? '展开主机侧栏' : '收起主机侧栏';
  $('#sidebar-toggle-text').textContent = label;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!collapsed));
}

function toggleAiPanel(force = null) {
  const panel = $('#ai-panel');
  const open = force === null ? panel.classList.contains('hidden') : force;
  panel.classList.toggle('hidden', !open);
  $('#ai-resizer').classList.toggle('hidden', !open);
  if (open) aiStickScroll(); // 隐藏期间收到的回复把内容顶出了视口,重开回到底部
  fitAllVisible();
  scheduleResizeSync();
  refreshCommandStates();
}

function closeCurrent() {
  const tab = activeTab();
  if (!tab) return;
  if (leafCount(tab.layout) > 1) closeActivePane(focusedPaneId());
  else closeTab(tab.id);
}

function setupWorkspaceCommands() {
  const session = () => state.sessions.get(state.activeId);
  const count = () => leafCount(activeTab()?.layout);
  registerCommand('tab.new', { label: '新建标签', run: newTabWithPicker });
  registerCommand('pane.split', { label: '新增分屏', enabled: () => session()?.status === 'connected' && count() < maxPaneCapacity(), run: () => splitActive() });
  registerCommand('workspace.tile', { label: '标签平铺', checked: () => state.workspace.mode === 'tiled', enabled: () => state.workspace.mode === 'tiled' || state.tabs.size >= 2, run: toggleTabTiling });
  registerCommand('pane.reflow', { label: '整理当前标签分屏', enabled: () => count() > 1, run: autoLayoutTab });
  registerCommand('pane.zoom', { label: () => state.zoomPaneId ? '还原窗格' : '放大当前窗格', enabled: () => count() > 1 && !!state.panes.get(focusedPaneId())?.sessionId, checked: () => !!state.zoomPaneId, run: () => togglePaneZoom(state.zoomPaneId || focusedPaneId()) });
  registerCommand('workspace.close', { label: () => count() > 1 ? '关闭当前窗格' : '关闭当前标签', enabled: () => !!activeTab(), run: closeCurrent });
  registerCommand('panel.sidebar', { label: '主机侧栏', checked: () => !$('#sidebar').classList.contains('collapsed'), run: toggleSidebar });
  registerCommand('panel.ai', { label: 'AI 助手', checked: () => !$('#ai-panel').classList.contains('hidden'), run: () => toggleAiPanel() });
  // 文件分屏:与「新增分屏」对称的入口,作用于当前标签
  registerCommand('tab.file.add', { label: '新增文件分屏', run: () => { addFilePane(); refreshCommandStates(); } });
  registerCommand('panel.history', { label: '命令历史', checked: () => state.historyOpen, run: toggleHistory });
  registerCommand('panel.snippets', { label: '常用片段', checked: () => !$('#snippet-menu').classList.contains('hidden'), run: toggleSnippetMenu });
  registerCommand('session.reconnect', { label: '重连当前会话', enabled: () => !!session() && !['connected', 'connecting'].includes(session().status), run: () => reconnectSession(state.activeId) });
  registerCommand('session.disconnect', { enabled: () => !!session() && (['connected', 'connecting'].includes(session().status) || session().reconnectScheduled), run: async () => { if (await confirmTransferInterrupt([state.activeId])) disconnectSession(state.activeId); } });
  registerCommand('session.readonly', { label: '只读模式', enabled: () => session()?.status === 'connected', checked: () => !!session()?.readOnly, run: toggleReadonly });
  registerCommand('session.log', { label: () => session()?.logActive ? '停止记录日志' : '记录会话日志（仅输出）', enabled: () => session()?.status === 'connected', checked: () => !!session()?.logActive, run: toggleSessionLog });
  registerCommand('session.clear', { enabled: () => !!session(), run: clearActiveTerm });
  registerCommand('session.search', { enabled: () => !!session(), run: openTermSearch });
  registerCommand('tools.broadcast', { label: '广播输入', enabled: () => !!state.broadcast || [...state.sessions.values()].some((s) => s.status === 'connected' && !s.readOnly), checked: () => !!state.broadcast, run: openBroadcastPicker });
  registerCommand('tools.batch', { label: '批量执行', run: openBatchModal });
  registerCommand('tools.forwards', { label: '端口转发', run: openForwardModal });
  registerCommand('settings.terminal', { label: '终端设置', run: openTermSettings });
  registerCommand('settings.ai', { label: 'AI 配置', run: openAiSettings });
  registerCommand('settings.fingerprints', { label: '主机指纹', run: openFingerprints });
  registerCommand('app.about', { label: '关于', run: openAbout });
  const buttons = { 'btn-newtab': 'tab.new', 'btn-split': 'pane.split', 'btn-ai-toggle': 'panel.ai', 'btn-sidebar-toggle': 'panel.sidebar', 'btn-batch': 'tools.batch', 'btn-readonly': 'session.readonly', 'btn-log-toggle': 'session.log', 'btn-clear': 'session.clear', 'btn-reconnect': 'session.reconnect', 'btn-disconnect': 'session.disconnect' };
  for (const [id, command] of Object.entries(buttons)) document.getElementById(id).dataset.command = command;
  bindCommandButtons();
  document.addEventListener('nebula:state-change', refreshCommandStates);
  document.addEventListener('nebula:modal-scope', refreshCommandStates);
}

export function bindEvents() {
  $('#btn-add-host').addEventListener('click', () => openHostModal(null));
  $('#btn-welcome-add').addEventListener('click', () => openHostModal(null));
  $('#btn-cloud-import').addEventListener('click', async () => {
    closeCloudForm(); // 每次打开都回到账号列表视图
    openModal('#modal-cloud');
    try {
      await refreshCloudAccounts();
    } catch (e) {
      toast('读取云账号失败：' + e.message, 'error');
    }
  });
  $('#btn-welcome-cloud').addEventListener('click', () => $('#btn-cloud-import').click());
  $('#btn-cloud-add-account').addEventListener('click', () => editCloudAccount(null));
  $('#cloud-form-vendor').addEventListener('change', () => {
    syncCloudFormLabels();
    clearCloudTestStatus();
  });
  $('#btn-cloud-test').addEventListener('click', testCloudAccount);
  $('#btn-cloud-form-save').addEventListener('click', saveCloudAccountFromForm);
  $('#btn-cloud-form-cancel').addEventListener('click', closeCloudForm);
  // 密钥帮助里的跳转链接:仅白名单控制台域名(后端 regex_lite 二次校验)
  $('#cloud-form-help').addEventListener('click', (e) => {
    const link = e.target.closest('.help-link');
    if (!link) return;
    api('app:openExternal', { url: link.dataset.url }).catch((err) =>
      toast('无法打开链接：' + err.message, 'error'),
    );
  });
  // 改动任一凭据字段即清掉上次校验结论:否则"✓ 校验通过"会停留在
  // 尚未校验过的新值上,反而误导用户以为改完还是对的。
  for (const sel of ['#cloud-form-keyid', '#cloud-form-secret', '#cloud-form-endpoint']) {
    $(sel).addEventListener('input', clearCloudTestStatus);
  }
  // 表单内回车 = 保存(密钥输入框不再走 askPrompt 链路)
  $('#cloud-account-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      saveCloudAccountFromForm();
    }
  });

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

  $('#btn-ai-close').addEventListener('click', () => toggleAiPanel(false));
  $('#ai-settings-open').addEventListener('click', openAiSettings);
  $('#btn-ai-cancel').addEventListener('click', closeAiSettings);
  setModalDismissHandler('#modal-ai', closeAiSettings);
  setModalDismissHandler('#modal-model-picker', closeModelPicker);
  $('#ai-baseurl').addEventListener('input', onAiEndpointChange);
  $('#ai-protocol').addEventListener('change', onAiEndpointChange);
  $('#ai-model-inline').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addManualAiModel(); } });
  // 点列表框空白处(chip 之间/空态提示)把焦点交给输入框,让整个框看起来可输入
  $('#ai-model-chips').addEventListener('click', (event) => {
    if (!event.target.closest('.model-chip, .model-chips-input')) $('#ai-model-inline').focus();
  });
  $('#btn-ai-save').addEventListener('click', saveAiSettings);
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
  // 模型选择:触发钮开菜单,菜单项切换,「管理模型」进 AI 设置;
  // 面板外点击/Esc 关闭。菜单定位 fixed,不随面板滚动。
  $('#ai-model-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#ai-model-menu');
    if (menu.classList.contains('hidden')) openModelMenu(); else closeModelMenu();
  });
  $('#ai-model-menu-list').addEventListener('click', (e) => {
    const item = e.target.closest('.ai-model-menu-item');
    if (!item) return;
    closeModelMenu();
    switchModel(item.dataset.model).then(renderModelSwitch).catch(() => {});
  });
  $('#ai-model-manage').addEventListener('click', () => { closeModelMenu(); openAiSettings(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ai-model-menu, #ai-model-trigger')) closeModelMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModelMenu();
  });
  // 「诊断报错」按钮已移除:入口迁移至终端右键菜单(openTermCtxMenu)。

  setupWorkspaceCommands();
  bindMoreMenu();
  $('#btn-fw-save').addEventListener('click', saveForwardRule);
  $('#btn-fw-close').addEventListener('click', () => closeModal('#modal-forward'));
  bindBatchUi();

  // 文件分屏:窗格内交互(导航/路径/新建/重命名/权限/上传/右键菜单)
  // 全部在 sftp.js buildFilePane 里按窗格闭包绑定;这里只接拖拽上传与任务中心。
  bindFileDrop();

  // 任务中心:事件接入 + 内部拖拽 + 状态栏入口
  bindTransferUi();

  // 退出拦截:有未完成传输任务时后端拦下关闭请求,由确认底座决定
  window.nebula.on('app:closeRequest', async ({ count }) => {
    const ok = await askConfirm(
      `有 ${count} 个传输任务未完成,退出将中断它们(已完成文件不受影响)。确定退出?`,
      { title: '传输进行中', okText: '中断任务并退出' },
    );
    if (ok) await api('app:exit');
  });

  // 「解释选中内容」按钮已移除:入口迁移为终端选区末尾的悬浮 🔍 按钮
  // (terminal.js bindSelectionExplain)。
  // 发送/停止同钮:空闲时发送,流式期间点击中止当前生成。
  $('#ai-send').addEventListener('click', () => (state.aiReq ? stopAiGeneration() : aiSend()));
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aiSend();
    }
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
  });

  // 片段 / 文件 / 终端设置
  $('#btn-snippet-close').addEventListener('click', closeSnippetMenu);
  $('#btn-snippet-add').addEventListener('click', addSnippet);
  $('#snippet-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSnippet(); });
  $('#btn-term-cancel').addEventListener('click', () => closeModal('#modal-term'));
  $('#btn-term-save').addEventListener('click', saveTermSettings);
  $('#btn-fp-close').addEventListener('click', () => closeModal('#modal-fp'));
  $('#btn-about-close').addEventListener('click', () => closeModal('#modal-about'));

  // 终端搜索
  $('#term-search-next').addEventListener('click', () => doTermSearch(false));
  $('#term-search-prev').addEventListener('click', () => doTermSearch(true));
  $('#term-search-close').addEventListener('click', closeTermSearch);
  $('#term-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doTermSearch(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
  });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || hasOpenModal()) return;
    if (!$('#more-menu').classList.contains('hidden') || !$('#ctx-menu').classList.contains('hidden')) return;
    const terminalInput = !!e.target.closest?.('.term-pane');
    if (isEditableTarget(e.target) && !terminalInput) return;
    if (isAppModifier(e)) {
      // 键位从 keymap 匹配:绑定与提示共用同一张表(action → spec),
      // 自定义键位(settings.keybindings)对两者同时生效。
      const appMod = isAppModifier(e);
      if (e.shiftKey && matchAction('pane.zoom', e, appMod)) { e.preventDefault(); executeCommand('pane.zoom'); return; }
      if (!e.shiftKey) {
        if (matchAction('session.search', e, appMod)) { e.preventDefault(); executeCommand('session.search'); return; }
        if (matchAction('workspace.close', e, appMod)) { e.preventDefault(); executeCommand('workspace.close'); return; }
        if (matchAction('tab.new', e, appMod)) { e.preventDefault(); executeCommand('tab.new'); return; }
        if (matchAction('pane.split', e, appMod)) { e.preventDefault(); executeCommand('pane.split'); return; }
        // 文件分屏内的全选(焦点在路径栏等输入框时由上面的 isEditableTarget
        // 早退,是输入框原生全选,不抢)
        if (matchAction('files.selectAll', e, appMod) && !terminalInput && document.activeElement?.closest?.('.term-pane.file-pane')) {
          e.preventDefault();
          import('./sftp.js').then((m) => { const p = m.focusedFilePane(); if (p) m.selectAllEntries(p); });
          return;
        }
        // mod+1..9 切换标签(spec 是范围写法,逐键判断)
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          const target = [...state.tabs.keys()][Number(e.key) - 1];
          if (target) activateTab(target);
          return;
        }
      }
    }
    if (e.key !== 'Escape') return;
    if (!$('#term-search').classList.contains('hidden')) { closeTermSearch(); return; }
    if (!$('#snippet-menu').classList.contains('hidden')) { closeSnippetMenu(); refreshCommandStates(); return; }
    if (state.historyOpen) { toggleHistory(); refreshCommandStates(); }
  });

  // Workspace scheduling coalesces frames and ignores unchanged geometry; observing
  // the fixed outer stack (not its rendered children) avoids layout feedback loops.
  const ro = new ResizeObserver(() => { scheduleWorkspaceLayout(); fitAllVisible(); scheduleResizeSync(); });
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
    // AI 诊断素材:只累积"最后一次命令提交之后"的输出,留尾部(报错通常在末尾)。
    // 采集窗口由 terminal.js 的 onData 在每次回车提交时重开。
    if (s.collectOutput) {
      s.lastOutput = ((s.lastOutput || '') + data).slice(-6000);
    }
  });
  window.nebula.on('ssh:status', (payload) => {
    const { sessionId, state: st, label } = payload;
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
  window.nebula.on('log:error', ({ sessionId, file, message }) => {
    const session = state.sessions.get(sessionId);
    if (session && (!file || !session.logFile || session.logFile === file)) {
      session.logActive = false;
      if (state.activeId === sessionId) updateStatusbar(session);
    }
    toast('日志记录失败：' + message, 'error');
  });
  // 进度按归属路由:任务中心(taskId)+ 会话/目录匹配的视图状态栏,
  // 不再把 A 主机的进度覆盖到 B 的面板上。
  window.nebula.on('sftp:progress', routeProgress);
  window.nebula.on('ai:delta', ({ requestId, text }) => {
    const h = state.aiReq;
    if (!h || h.id !== requestId) return;
    aiTouchRequest(requestId);
    h.acc += text;
    if (!h.bubble) return;
    // 首个 token:撤掉"正在思考…"占位,转入流式态
    markBubbleStreaming(h.bubble);
    // 同一帧内的多个 delta 合并成一次 DOM 写入:逐 token 直接写会让长回复
    // 每帧重排几十次(气泡在滚动容器里,每次都要重算 scrollHeight),
    // 表现为卡顿。用 rAF 合帧后视觉上仍是逐字出现。
    h.bubble.dataset.text = h.acc;
    if (!h.raf) {
      h.raf = requestAnimationFrame(() => {
        h.raf = 0;
        const cur = state.aiReq;
        if (!cur || cur !== h || !h.bubble) return;
        // 必须经 setAiBody 写进 .ai-body:直接改 textContent 会把
        // 复制按钮和内容容器一起抹掉,气泡从此渲染成空壳。
        setAiBody(h.bubble, h.bubble.dataset.text || h.acc);
        aiStickScroll(); // 贴底才跟随;用户上滚阅读时不打扰
      });
    }
  });
  window.nebula.on('ai:done', (done) => {
    const h = state.aiReq;
    if (h && h.id === done.requestId) aiFinishHolder(done);
  });
  window.nebula.on('ai:error', ({ requestId, message }) => {
    const h = state.aiReq;
    if (h && h.id === requestId) {
      // 先撤等待态再写错误文案:clearBubbleState 会清掉"正在思考…"占位,
      // 反过来的话首 token 前报错会把刚写好的错误提示一起抹掉。
      if (h.bubble) {
        clearBubbleState(h.bubble);
        setAiBody(h.bubble, (h.acc ? h.acc + '\n' : '') + '⚠️ ' + message);
      }
      h.failed = message;
      aiFinishHolder();
    }
  });
}

/// 功能菜单的快捷键列:HTML 只声明 data-accel,这里按运行平台渲染成 ⌘D / Ctrl+D。
/// 与 tooltip(applyAccelTitles)同一份数据源 —— 加菜单项时两处一起生效,
/// 菜单因此成为快捷键的"教育层"(此前更多菜单不带任何快捷键提示)。
function fillMenuKeys() {
  for (const btn of document.querySelectorAll('#more-menu [data-accel]')) {
    const keyEl = btn.querySelector('.mm-key');
    if (keyEl) keyEl.textContent = accelSpec(String(btn.dataset.accel).split('|')[0].trim());
  }
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
  // 解 terminal→ai 循环依赖:选中「解释」按钮点击时经此回调 aiSend
  bindSelectionExplain._aiSend = aiSend;
  // 快捷键提示必须在渲染前按平台重写:HTML 里不带写死的 ⌘,全靠这一步填入。
  applyAccelTitles();
  // 静态 HTML 里的 data-icon 占位符统一注入 SVG(见 shared/icons.js)
  hydrateIcons(document);
  fillMenuKeys();
  bindModalInteractions();
  bindAiCodeActions();
  bindAiScroll();
  bindEvents();
  setupResizers();
  bindContextMenu();
  bindWindowControls();
  // 启动时同步一次收起按钮的状态(侧栏默认展开):此后由 toggleSidebar 维护
  syncSidebarToggle($('#sidebar').classList.contains('collapsed'));
  state.settings = await api('settings:get');
  await refreshHosts();
  await refreshAiModels();
  renderAiMessage('assistant', '你好，我是 NebulaShell 内置 AI 助手 ✨\n可以直接提问，或使用上方快捷操作：\n· **解释选中内容**：选中终端输出后点击\n· **诊断报错**：把最后一次输入的命令及其控制台输出发给 AI 分析\n\n回复支持 Markdown 展示，代码块可单独复制；明确的 Shell 命令可由你点击执行到当前终端。');
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
    modelSwitchOptions: () => [...document.querySelectorAll('#ai-model-menu-list .ai-model-menu-item')].map((b) => b.dataset.model),
    modelSwitchValue: () => savedAiModelId(),
    // AI 头部两个按钮的间距(第 6 条)
    aiHeaderGap: () => {
      const a = $('#ai-settings-open').getBoundingClientRect();
      const b = $('#btn-ai-close').getBoundingClientRect();
      return Math.round(b.left - a.right);
    },
    // 头部按钮高度对比(第 7 条;模型选择已移入 composer,不再参与对比)
    aiHeaderHeights: () => {
      const g = $('#ai-settings-open').getBoundingClientRect();
      const x = $('#btn-ai-close').getBoundingClientRect();
      return { settings: Math.round(g.height), close: Math.round(x.height) };
    },
    // 对话气泡的状态类与文本:等待态/流式态渲染的观测点
    aiBubbles: () => [...document.querySelectorAll('#ai-messages .ai-msg')].map((b) => ({
      role: b.className.replace(/ai-msg\s*/, '').trim(),
      text: b.textContent,
      pending: b.classList.contains('pending'),
      streaming: b.classList.contains('streaming'),
      hasSpinner: !!b.querySelector('.ai-spinner'),
    })),
    // AI 设置弹窗是否还开着(验证 Esc 只关最上层)
    aiSettingsOpen: () => !$('#modal-ai').classList.contains('hidden'),
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
    aiMsgDetail: () => [...document.querySelectorAll('#ai-messages .ai-msg')].map((b) => ({
      role: b.dataset.role,
      text: b.querySelector('.ai-body')?.textContent || '',
      hasCopy: !!b.querySelector('.ai-copy'),
      hasCode: !!b.querySelector('.ai-body pre code'),
      mdBlocks: b.querySelectorAll('.ai-body > p, .ai-body > pre, .ai-body > ul, .ai-body > ol, .ai-body > h3').length,
    })),
    aiCopyClick: (idx) => {
      const b = document.querySelectorAll('#ai-messages .ai-msg')[idx];
      if (!b) return false;
      b.querySelector('.ai-copy')?.click();
      return true;
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
    /// 终端复制链路探针(T61):向活动会话缓冲写一行标记并选中,再派发真实的
    /// Ctrl+C / Ctrl+Shift+C keydown(完整走 attachCustomKeyEventHandler 判定),
    /// 用临时 term.onData 监听捕获 xterm 实际发出的数据 —— 回报是否把
    /// \x03(SIGINT)发给了 shell。观测点选在 onData 而非 ssh:write:后者要求
    /// 会话已连接(受其它测试的连接状态影响),而本修复的契约就是
    /// "有选区 = 不向 shell 发任何数据,无选区 = 放行 \x03"。
    /// select=false 时先清掉选区(无选区探针)。
    termCopyProbe: async (opts) => {
      const o = opts || {};
      const s = state.sessions.get(state.activeId);
      if (!s) return { ok: false, why: 'no-session' };
      const term = s.term;
      await new Promise((r) => term.write('\r\nPROBE-COPY-MARK-9137\r\n', r));
      const buf = term.buffer.active;
      let row = -1;
      for (let i = buf.length - 1; i >= 0; i--) {
        const l = buf.getLine(i);
        if (l && l.translateToString(true).includes('PROBE-COPY-MARK-9137')) { row = i; break; }
      }
      if (row < 0) return { ok: false, why: 'mark-not-found' };
      if (o.select === false) { try { term.clearSelection(); } catch { /* ignore */ } }
      else term.select(0, row, 'PROBE-COPY-MARK-9137'.length);
      const emitted = [];
      const disp = term.onData((d) => emitted.push(d));
      let err = '';
      let kbd = null;
      try {
        kbd = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: o.key || 'c', ctrlKey: true, shiftKey: !!o.shift });
        // new KeyboardEvent 的 keyCode 恒为 0,而 xterm 的 evaluateKeyboardEvent
        // 按 keyCode 求值(ctrl+c → \x03 依赖 keyCode 67),必须补上真实键值,
        // 否则无选区分支"放行后 xterm 什么都不发"是合成事件的假象。
        Object.defineProperty(kbd, 'keyCode', { get: () => 67 });
        term.textarea.dispatchEvent(kbd);
      } catch (e) { err = e.message; }
      disp.dispose();
      const all = emitted.join('');
      // prevented = 自定义处理器介入(分流/prefentDefault)的证据:
      // 旧实现从不 preventDefault,可据此区分新旧行为。
      return { ok: !err, err, prevented: !!(kbd && kbd.defaultPrevented), hadSelection: !!term.hasSelection(), selection: term.getSelection(), sigintSent: all.includes('\x03'), emitted: all };
    },
    /// 终端粘贴探针(T62):派发真实 Ctrl+V keydown,统计"插入次数"(stub
    /// term.paste)与"原生 paste 事件数" —— 修复前手动 readText 链路 + 浏览器
    /// 默认粘贴(→ xterm 的 paste 监听器)各插一次,粘贴内容翻倍。
    /// stub 不真正粘贴,避免把测试机剪贴板内容打进会话;readOnly 期间 onData
    /// 也不落盘,双保险。
    termPasteProbe: async () => {
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
        kbd = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'v', ctrlKey: true });
        Object.defineProperty(kbd, 'keyCode', { get: () => 86 });
        term.textarea.dispatchEvent(kbd);
      } catch (e) { err = e.message; }
      await new Promise((r) => setTimeout(r, 150)); // 手动 readText 与原生 paste 事件都在此窗口内到达
      s.readOnly = prevRo;
      term.textarea.removeEventListener('paste', onPaste);
      term.paste = origPaste;
      return { ok: !err, err, prevented: !!(kbd && kbd.defaultPrevented), pasteEvents, pasteCalls };
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
    // 云账号凭据表单:供 e2e 驱动"一次性填写 + 测试连接"链路
    cloudForm: () => ({
      open: !$('#cloud-account-form').classList.contains('hidden'),
      editingId: state.cloudEditing ? state.cloudEditing.id : null,
      keyIdLabel: $('#cloud-form-keyid-label').textContent,
      secretLabel: $('#cloud-form-secret').placeholder,
      testStatus: $('#cloud-test-status').textContent,
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
    cloudFormTest: () => $('#btn-cloud-test').click(),
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
        status: g('.file-status')?.textContent ?? '',
        lastOpen: pane?.lastOpen ?? null,
        rows: elp.querySelectorAll('.file-list .file-row').length,
        names: [...elp.querySelectorAll('.file-list .file-row .f-name')].map((e) => e.textContent),
        toolbar: [...elp.querySelectorAll('.file-toolbar .btn')].map((b) => ({
          cls: b.className, text: b.textContent.trim(), title: b.title,
        })),
        bookmarks: [...elp.querySelectorAll('.file-bookmarks .bm-chip')].map((c) => c.textContent),
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
        stage: row.querySelector('.fp-task-stage')?.textContent ?? '',
        dot: row.querySelector('.fp-task-dot')?.className.replace('fp-task-dot', '').trim() ?? '',
        sub: row.querySelector('.fp-task-sub')?.textContent ?? '',
        actions: [...row.querySelectorAll('.fp-task-actions .btn')].map((b) => b.textContent.trim()),
      })),
    }),
    /// 任务中心操作:按标签找任务行并点击指定按钮(取消/重试/清除/处理冲突)
    fileTaskClick: (label, action) => {
      const rows = [...document.querySelectorAll('#file-task-list .fp-task')];
      const row = rows.find((r) => r.querySelector('.fp-task-label')?.textContent === label);
      if (!row) return false;
      const btn = [...row.querySelectorAll('.fp-task-actions .btn')].find((b) => b.textContent.trim() === action);
      if (!btn) return false;
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
      closePane: $('#btn-close-pane').title,
      hasDirectionMenus: !!$('#btn-split-left-right') || !!$('#btn-split-top-bottom'),
      zoom: (document.querySelector('.pane-zoom-btn') || {}).title || '',
    }),
    // 侧边栏底部:版本号与导入/导出均已移除(分别移入关于弹窗与功能菜单「配置」组)
    footer: () => ({
      version: $('#app-version') ? $('#app-version').textContent : null,
      hasVersion: !!$('#app-version'),
      hasFingerprintBtn: !!$('#btn-fingerprints') && $('#btn-fingerprints').closest('.side-footer') !== null,
      // .side-footer 元素已整体移除:底部只剩快捷连接框
      text: document.querySelector('.side-footer') ? document.querySelector('.side-footer').textContent.trim() : '',
    }),
    // 功能菜单项(含指纹/关于是否已并入)
    moreMenuItems: () => [...document.querySelectorAll('#more-menu .btn')].map((b) => b.textContent.trim()),
    // 更多菜单几何:用于断言"菜单不遮挡主内容区"
    moreMenuGeom: () => {
      const mm = $('#more-menu');
      const wasHidden = mm.classList.contains('hidden');
      if (wasHidden) $('#btn-more').click();
      const mr = mm.getBoundingClientRect();
      const pr = $('#term-stack').getBoundingClientRect();
      const overlap = mr.right > pr.left && mr.left < pr.right && mr.bottom > pr.top && mr.top < pr.bottom;
      if (wasHidden) closeMoreMenu();
      return {
        menu: [Math.round(mr.left), Math.round(mr.top), Math.round(mr.right), Math.round(mr.bottom)],
        panel: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.right), Math.round(pr.bottom)],
        overlap,
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

