// 应用入口:右键菜单、事件绑定、启动(被 app.js 引入)
import { $, activeTab, accel, api, applyAccelTitles, askPrompt, bindCtxMenuDismiss, closeCtxMenu, closeModal, copyText, openModal, PLATFORM, showCtxMenu, state, toast } from './core.js';
import { activateSession, activateTab, autoLayoutTab, clearActiveTerm, closeActivePane, closeSession, closeTab, closeTermSearch, connectHost, doTermSearch, firstPaint, fitActive, fitAllVisible, followFilePanel, leafCount, newTabWithPicker, openBroadcastPicker, openTermSearch, parseQuickTarget, quickConnect, renderLayout, scheduleResizeSync, splitActive, togglePaneZoom, toggleReadonly, toggleSessionLog, updateStatusbar, updateTab, updateWelcome } from './terminal.js';
import { openFingerprints, openHostModal, refreshHosts, renderHosts, saveHostModal, toggleAuthRows } from './hosts.js';
import { clearCloudTestStatus, closeCloudForm, cloudFetchAll, cloudImportSelected, editCloudAccount, refreshCloudAccounts, saveCloudAccountFromForm, syncCloudFormLabels, testCloudAccount } from './cloud.js';
import { aiDiagnose, aiFinishHolder, aiSend, aiTestConnection, clearBubbleState, closeModelPicker, confirmModelPicker, fetchAiModels, fillPreset, filterModelPicker, markBubbleStreaming, movePickerSelection, openAiSettings, pickerSelectAll, refreshAiModels, renderAiMessage, renderModelSwitch, saveAiSettings, setAiBody, switchModel, togglePickerFocus } from './ai.js';
import { addSnippet, closeSnippetMenu, renderMonitorBar, toggleSnippetMenu } from './monitor.js';
import { activeConnectedSession, addBookmark, fileNavBack, fileNavForward, fileNavUp, filePanelSession, fileUpload, initialFileDir, loadFileDir, renderFileTarget, uploadLocalPaths } from './sftp.js';
import { openTermSettings, saveTermSettings } from './settings.js';
import { openBatchModal, openForwardModal, renderBatchHosts, runBatch, saveForwardRule, toggleHistory } from './tools.js';

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
    { label: '复制', key: accel('mod+C'), disabled: !selText, run: () => {
      copyText(selText).then((ok) => toast(ok ? `已复制 ${selText.length} 个字符` : '复制失败：剪贴板不可用', ok ? 'success' : 'error'));
    } },
    { label: '粘贴', key: accel('mod+V'), run: () => { navigator.clipboard.readText().then((t) => { if (t && !session.readOnly) term.paste(t); }).catch(() => {}); } },
    { label: '全选', key: accel('mod+A'), run: () => { try { term.selectAll(); } catch { /* ignore */ } } },
    '-',
    { label: '搜索…', key: accel('mod+F'), run: () => { activateSession(session.sessionId); openTermSearch(); } },
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
export function bindFileDrop() {
  const cur = window.__TAURI__ && window.__TAURI__.webviewWindow
    && window.__TAURI__.webviewWindow.getCurrentWebviewWindow
    && window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
  if (!cur || typeof cur.onDragDropEvent !== 'function') return;
  const panel = $('#file-panel');
  const hint = $('#file-drop-hint');
  // 拖放位置是物理像素,要换算成 CSS 像素再与元素矩形比较(高 DPI 屏差一倍)
  const dpr = window.devicePixelRatio || 1;
  const inPanel = (pos) => {
    if (panel.classList.contains('hidden')) return false;
    if (!pos || typeof pos.x !== 'number') return true; // 无坐标信息时按"在整个窗口内"处理
    const r = panel.getBoundingClientRect();
    const x = pos.x / dpr;
    const y = pos.y / dpr;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const hideHint = () => hint.classList.add('hidden');
  cur.onDragDropEvent(({ payload }) => {
    if (payload.type === 'enter' || payload.type === 'over') {
      if (inPanel(payload.position)) hint.classList.remove('hidden');
      else hideHint();
      return;
    }
    if (payload.type === 'leave') { hideHint(); return; }
    if (payload.type === 'drop') {
      hideHint();
      if (!inPanel(payload.position)) return;
      const paths = (payload.paths || []).filter(Boolean);
      if (!paths.length) return;
      uploadLocalPaths(paths).catch(() => {});
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

/// 路径栏回车:跳到输入的绝对路径。加载失败时 loadFileDir 不改 cwd,
/// 输入框随之回落显示当前目录(用户立刻知道"没跳过去");
/// ~ 与相对路径不做展开(保持简单,失败在状态栏可见)。
async function commitFilePath() {
  const p = $('#file-path').value.trim();
  if (!p || p === state.file.cwd) {
    $('#file-path').value = state.file.cwd || '';
    return;
  }
  await loadFileDir(p);
  $('#file-path').value = state.file.cwd || '';
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

  $('#btn-ai-toggle').addEventListener('click', () => {
    $('#ai-panel').classList.toggle('hidden');
    $('#ai-resizer').classList.toggle('hidden', $('#ai-panel').classList.contains('hidden'));
    fitActive();
  });
  $('#btn-ai-close').addEventListener('click', () => {
    $('#ai-panel').classList.add('hidden');
    $('#ai-resizer').classList.add('hidden');
    fitActive();
  });
  $('#ai-settings-open').addEventListener('click', openAiSettings);
  $('#btn-ai-cancel').addEventListener('click', () => closeModal('#modal-ai'));
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
  $('#ai-model-switch').addEventListener('change', (e) => switchModel(e.target.value).then(renderModelSwitch).catch(() => {}));
  $('#btn-ai-diagnose').addEventListener('click', aiDiagnose);

  // ＋ 新建标签页:空标签,等待用户在窗格选择器里选主机(⌘T / 标签右键同源)
  $('#btn-newtab').addEventListener('click', () => newTabWithPicker());

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

  // 分屏:⛶ 点击弹出方向选择(左右/上下),与按钮 title 声明一致 ——
  // 此前点击只会左右分屏,tooltip 却写着两个方向,想上下只能去菜单或记快捷键。
  $('#btn-split').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showCtxMenu(r.left, r.bottom + 6, [
      { label: '左右分屏', key: accel('mod+D'), run: () => splitActive('h') },
      { label: '上下分屏', key: accel('mod+shift+D'), run: () => splitActive('v') },
    ]);
  });
  $('#btn-broadcast').addEventListener('click', openBroadcastPicker);
  $('#btn-history').addEventListener('click', toggleHistory);
  $('#btn-forwards').addEventListener('click', openForwardModal);
  $('#btn-fw-save').addEventListener('click', saveForwardRule);
  $('#btn-fw-close').addEventListener('click', () => closeModal('#modal-forward'));
  $('#btn-batch').addEventListener('click', openBatchModal);
  $('#batch-search').addEventListener('input', (e) => renderBatchHosts(e.target.value));
  $('#btn-batch-run').addEventListener('click', runBatch);
  $('#btn-batch-close').addEventListener('click', () => closeModal('#modal-batch'));
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

  // 文件面板扩展:导航 / 重命名 / 权限 / 书签 / 拖拽上传。
  // 工具栏是"导航三连(后退/前进/上一级)+ 新建文件夹 / 上传 / 刷新";
  // 针对具体文件的打开·下载·重命名·权限·删除一律走该行的右键菜单
  // (见 sftp.js openFileCtxMenu)。
  $('#btn-file-back').addEventListener('click', fileNavBack);
  $('#btn-file-forward').addEventListener('click', fileNavForward);
  $('#btn-file-up').addEventListener('click', fileNavUp);
  $('#btn-file-refresh').addEventListener('click', () => loadFileDir(state.file.cwd));
  $('#btn-file-mkdir').addEventListener('click', () => {
    state.file.renameMode = null; // 从"新建"进入,别把上次的重命名态带过来
    $('#file-mkdir-row').classList.remove('hidden');
    $('#file-mkdir-name').value = '';
    $('#file-mkdir-name').placeholder = '新建文件夹名称';
    $('#file-mkdir-name').focus();
  });
  $('#btn-file-upload').addEventListener('click', fileUpload);
  $('#btn-file-mkdir-cancel').addEventListener('click', () => {
    state.file.renameMode = null;
    $('#file-mkdir-row').classList.add('hidden');
  });
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
  // 路径栏右键 = 收藏当前目录(原工具栏的「★ 书签」按钮已移除)
  $('#file-path').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '收藏当前目录', disabled: !state.file.cwd, run: () => addBookmark() },
      { label: '复制当前路径', disabled: !state.file.cwd, run: () => { copyText(state.file.cwd).then((ok) => toast(ok ? '已复制路径' : '复制失败', ok ? 'success' : 'error')); } },
    ]);
  });
  // 路径栏可直接编辑:回车跳转,Esc/失焦还原为当前目录。
  // stopPropagation 别让全局按键(如 Esc 收菜单)在编辑路径时插一手。
  $('#file-path').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      $('#file-path').value = state.file.cwd || '';
      $('#file-path').blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitFilePath();
    }
  });
  $('#file-path').addEventListener('blur', () => {
    $('#file-path').value = state.file.cwd || '';
  });

  // 拖拽上传。Tauri 会**关闭** webview 的 HTML5 拖放(dataTransfer 里拿不到
  // 本地路径),必须用 Tauri 的拖放事件:enter/over/leave/drop 各带 paths。
  // 仅在面板可见时接管,避免把"拖文件到终端"这种别处用法也吃掉。
  bindFileDrop();

  $('#btn-ai-explain').addEventListener('click', () => {
    const s = state.sessions.get(state.activeId);
    const sel = s && s.term.getSelection();
    if (!sel) return toast('请先在终端中选中要解释的内容', 'error');
    aiSend(sel, 'explain');
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

  // 片段 / 文件 / 终端设置
  $('#btn-snippets').addEventListener('click', toggleSnippetMenu);
  $('#btn-snippet-close').addEventListener('click', closeSnippetMenu);
  $('#btn-snippet-add').addEventListener('click', addSnippet);
  $('#snippet-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addSnippet(); });
  // 分屏:左右 / 上下(原先只有左右,且入口只在标签栏的图标按钮上)
  $('#btn-split-left-right').addEventListener('click', () => splitActive('h'));
  $('#btn-split-top-bottom').addEventListener('click', () => splitActive('v'));
  $('#btn-auto-layout').addEventListener('click', () => autoLayoutTab());
  $('#btn-close-pane').addEventListener('click', closeActivePane);
  // 功能菜单新增入口:放大当前窗格 / AI 助手 / 会话日志 ——
  // 此前放大只有窗格悬停按钮与 ⌘⇧↵,AI 只有标签栏 ✨,日志只有状态栏小按钮,
  // 菜单里找不到它们(每个功能都该在菜单里有稳定的"家")。
  $('#btn-zoom-pane').addEventListener('click', () => {
    const pid = state.zoomPaneId || (state.sessions.get(state.activeId) || {}).paneId;
    if (pid) togglePaneZoom(pid);
  });
  $('#btn-ai-menu').addEventListener('click', () => {
    $('#ai-panel').classList.toggle('hidden');
    $('#ai-resizer').classList.toggle('hidden', $('#ai-panel').classList.contains('hidden'));
    fitActive();
  });
  $('#btn-log-menu').addEventListener('click', toggleSessionLog);
  $('#btn-files').addEventListener('click', async () => {
    const panel = $('#file-panel');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); $('#file-resizer').classList.add('hidden'); fitActive(); return; }
    panel.classList.remove('hidden');
    $('#file-resizer').classList.remove('hidden');
    $('#file-list').innerHTML = '<div class="file-empty">加载中…</div>';
    renderFileTarget();
    fitActive();
    // 用"当前会话自己"记住的目录打开,而不是全局 cwd ——
    // 后者可能属于另一台服务器,拿它的路径去 list 会张冠李戴。
    // 该会话还没浏览过目录(首次打开)时,默认落到 shell 当前执行路径。
    const s = activeConnectedSession();
    if (!s) await loadFileDir(null);
    else if (s.lastFileDir) await loadFileDir(s.lastFileDir);
    else await loadFileDir(await initialFileDir(s));
  });
  $('#btn-file-close').addEventListener('click', () => { $('#file-panel').classList.add('hidden'); $('#file-resizer').classList.add('hidden'); fitActive(); });
  $('#btn-term-settings').addEventListener('click', openTermSettings);
  $('#btn-term-cancel').addEventListener('click', () => closeModal('#modal-term'));
  $('#btn-term-save').addEventListener('click', saveTermSettings);
  $('#btn-fingerprints').addEventListener('click', openFingerprints);
  $('#btn-fp-close').addEventListener('click', () => closeModal('#modal-fp'));
  $('#btn-about').addEventListener('click', openAbout);
  $('#btn-about-close').addEventListener('click', () => closeModal('#modal-about'));

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
      // ⌘W 与菜单里的"关闭当前窗格"必须是同一套规则:都走 closeActivePane
      // (它优先关空窗格)。此前这里按"标签内会话数>1"判断,连开多个空窗格时
      // 会话数仍是 1 → 直接关掉整个标签,与用户"退掉一个分屏"的意图不符。
      const tab = activeTab();
      if (!tab) return;
      if (leafCount(tab.layout) > 1) closeActivePane();
      else closeTab(tab.id);
      return;
    }
    if (mod && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      newTabWithPicker();
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
    if (e.key === 'Escape' && !$('#ctx-menu').classList.contains('hidden')) { closeCtxMenu(); return; }
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
    // 只关最上层那一个:模型选择弹框叠在 AI 设置之上,一次 Esc 若把两层都关掉,
    // 用户回不到还在编辑的表单。z-index 高者在上,同值时 DOM 靠后者在上。
    const open = [...document.querySelectorAll('.modal:not(.hidden)')].filter((m) => m.id !== 'modal-confirm');
    if (!open.length) return;
    let top = open[0];
    for (const m of open.slice(1)) {
      const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
      if (z(m) >= z(top)) top = m;
    }
    top.classList.add('hidden');
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
    // AI 诊断素材:只累积"最后一次命令提交之后"的输出,留尾部(报错通常在末尾)。
    // 采集窗口由 terminal.js 的 onData 在每次回车提交时重开。
    if (s.collectOutput) {
      s.lastOutput = ((s.lastOutput || '') + data).slice(-6000);
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
        const box = $('#ai-messages');
        box.scrollTop = box.scrollHeight;
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
    if (keyEl) keyEl.textContent = accel(String(btn.dataset.accel).split('|')[0]);
  }
}

/// 面板边界拖拽调宽:sidebar(左边界)、ai-panel / file-panel(右边界各一条)。
/// 拖动时直接写面板的 width,上下限交给面板自己的 min/max-width 兜底;
/// 结束后 fitActive() 让 xterm 按新宽度重新排字。
function setupResizers() {
  const panels = {
    'sidebar-resizer': { el: () => $('#sidebar'), side: 'left' },
    'ai-resizer': { el: () => $('#ai-panel'), side: 'right' },
    'file-resizer': { el: () => $('#file-panel'), side: 'right' },
  };
  for (const [id, { el, side }] of Object.entries(panels)) {
    const grip = document.getElementById(id);
    if (!grip) continue;
    grip.addEventListener('pointerdown', (ev) => {
      const panel = el();
      if (!panel || panel.classList.contains('hidden')) return;
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      grip.classList.add('dragging');
      document.body.classList.add('resizing');
      const startX = ev.clientX;
      const startW = panel.getBoundingClientRect().width;
      let lastFit = 0;
      const move = (e) => {
        const dx = e.clientX - startX;
        panel.style.width = Math.round(side === 'left' ? startW + dx : startW - dx) + 'px';
        // 拖动过程中节流重排终端,松手后再精排一次
        const now = performance.now();
        if (now - lastFit > 100) { lastFit = now; fitActive(); }
      };
      const up = (e) => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.classList.remove('dragging');
        document.body.classList.remove('resizing');
        move(e);
        fitActive();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    // 双击把手恢复默认宽度
    grip.addEventListener('dblclick', () => { el().style.width = ''; fitActive(); });
  }
}

export async function boot() {
  // 快捷键提示必须在渲染前按平台重写:HTML 里不带写死的 ⌘,全靠这一步填入。
  applyAccelTitles();
  fillMenuKeys();
  bindEvents();
  setupResizers();
  bindContextMenu();
  state.settings = await api('settings:get');
  await refreshHosts();
  await refreshAiModels();
  renderAiMessage('assistant', '你好，我是 NebulaShell 内置 AI 助手 ✨\n可以直接提问，或使用上方快捷操作：\n· **解释选中内容**：选中终端输出后点击\n· **诊断报错**：把最后一次输入的命令及其控制台输出发给 AI 分析\n\n回复支持 Markdown 展示，每条消息可一键复制。');
}

boot();

// 端到端测试钩子(仅 Tauri 测试桥环境注入):模拟键盘输入走完整广播/历史链路
if (window.__NB_E2E__ || window.nebula && window.nebula.testMode) {
  window.__nbTest = {
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
    // "模型"一栏展示的 chip(选中的模型必须都在这里)
    modelChips: () => [...document.querySelectorAll('#ai-model-chips .model-chip')].map((b) => b.textContent),
    modelChipActive: () => (($('#ai-model-chips .model-chip.active') || {}).textContent) || '',
    modelSwitchOptions: () => [...document.querySelectorAll('#ai-model-switch option')].map((o) => o.value),
    // 设置弹窗里"拉取模型"按钮与模型栏的高度(第 4 条:两者必须等高)
    aiRowHeights: () => {
      const b = $('#btn-ai-fetch-models').getBoundingClientRect();
      const c = $('#ai-model-chips').getBoundingClientRect();
      return { btn: Math.round(b.height), chips: Math.round(c.height) };
    },
    // AI 头部两个按钮的间距(第 6 条)
    aiHeaderGap: () => {
      const a = $('#ai-settings-open').getBoundingClientRect();
      const b = $('#btn-ai-close').getBoundingClientRect();
      return Math.round(b.left - a.right);
    },
    // 头部控件与发送按钮的高度对比(第 7 条)
    aiHeaderHeights: () => {
      const s = $('#ai-model-switch').getBoundingClientRect();
      const g = $('#ai-settings-open').getBoundingClientRect();
      const x = $('#btn-ai-close').getBoundingClientRect();
      return { select: Math.round(s.height), settings: Math.round(g.height), close: Math.round(x.height) };
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
      const i = $('#ai-input').getBoundingClientRect();
      const b = $('#ai-send').getBoundingClientRect();
      return { input: Math.round(i.height), send: Math.round(b.height) };
    },
    // 生成命令是否已移除(按钮 + 快捷按钮行内都不该再有)
    genButtonGone: () => !$('#btn-ai-gen') && !String(document.querySelector('.ai-quick')?.textContent || '').includes('生成命令'),
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
    write: (d) => {
      const s = state.sessions.get(state.activeId);
      if (s && s.status === 'connected' && !s.readOnly) s.term.input(d);
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
        // 路径栏是输入框:textContent 恒空,断言读 value;nav 是导航三连的可用态
        pathValue: $('#file-path').value,
        nav: {
          back: !$('#btn-file-back').disabled,
          forward: !$('#btn-file-forward').disabled,
          up: !$('#btn-file-up').disabled,
        },
        status: $('#file-status').textContent,
        lastOpen: state.file.lastOpen,
        rows: document.querySelectorAll('#file-list .file-row').length,
        names: [...document.querySelectorAll('#file-list .file-row .f-name')].map((e) => e.textContent),
        // 工具栏只剩图标按钮(不再有"新建文件夹/上传/下载/重命名/权限/删除/书签"文字按钮)
        toolbar: [...document.querySelectorAll('.file-toolbar .btn')].map((b) => ({
          id: b.id, text: b.textContent.trim(), title: b.title,
        })),
        bookmarks: [...document.querySelectorAll('#file-bookmarks .bm-chip')].map((c) => c.textContent),
        // 状态:加载中的输入行可见性(重命名/新建共用)
        mkdirRowOpen: !$('#file-mkdir-row').classList.contains('hidden'),
        chmodRowOpen: !$('#file-chmod-row').classList.contains('hidden'),
      };
    },
    /// 文件行右键菜单:按名字在列表里找行并派发真实 contextmenu 事件
    fileCtxMenu: (name) => {
      const rows = [...document.querySelectorAll('#file-list .file-row')];
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
    /// 拖拽上传提示条是否可见(拖到面板上方时应出现)
    dropHintVisible: () => !$('#file-drop-hint').classList.contains('hidden'),
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
      splitLR: $('#btn-split-left-right').title,
      splitTB: $('#btn-split-top-bottom').title,
      zoom: (document.querySelector('.pane-zoom-btn') || {}).title || '',
    }),
    // 侧边栏底部:版本号已移除(移入关于弹窗)
    footer: () => ({
      version: $('#app-version') ? $('#app-version').textContent : null,
      hasVersion: !!$('#app-version'),
      hasFingerprintBtn: !!$('#btn-fingerprints') && $('#btn-fingerprints').closest('.side-footer') !== null,
      text: document.querySelector('.side-footer').textContent.trim(),
    }),
    // 功能菜单项(含指纹/关于是否已并入)
    moreMenuItems: () => [...document.querySelectorAll('#more-menu .btn')].map((b) => b.textContent.trim()),
    // 更多菜单几何:用于断言"文件面板打开时菜单不遮挡面板展示区"
    moreMenuGeom: () => {
      const mm = $('#more-menu');
      const wasHidden = mm.classList.contains('hidden');
      if (wasHidden) mm.classList.remove('hidden');
      const mr = mm.getBoundingClientRect();
      const pr = $('#file-panel').getBoundingClientRect();
      const overlap = mr.right > pr.left && mr.left < pr.right && mr.bottom > pr.top && mr.top < pr.bottom;
      if (wasHidden) mm.classList.add('hidden');
      return {
        menu: [Math.round(mr.left), Math.round(mr.top), Math.round(mr.right), Math.round(mr.bottom)],
        panel: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.right), Math.round(pr.bottom)],
        overlap,
        panelOpen: !$('#file-panel').classList.contains('hidden'),
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

