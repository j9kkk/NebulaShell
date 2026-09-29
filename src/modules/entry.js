// 应用入口:右键菜单、事件绑定、启动(被 app.js 引入)
import { $, activeTab, api, askPrompt, closeModal, openModal, state, toast } from './core.js';
import { activateSession, activateTab, clearActiveTerm, closeSession, closeTab, closeTermSearch, connectHost, createTab, doTermSearch, firstPaint, fitActive, fitAllVisible, followFilePanel, leaf, makePaneEl, newPaneId, openBroadcastPicker, openTermSearch, parseQuickTarget, quickConnect, renderLayout, scheduleResizeSync, splitActive, togglePaneZoom, toggleReadonly, toggleSessionLog, updateStatusbar, updateTab, updateWelcome } from './terminal.js';
import { escapeHtml, openFingerprints, openHostModal, refreshHosts, renderHosts, saveHostModal, toggleAuthRows } from './hosts.js';
import { clearCloudTestStatus, closeCloudForm, cloudFetchAll, cloudImportSelected, editCloudAccount, refreshCloudAccounts, saveCloudAccountFromForm, syncCloudFormLabels, testCloudAccount } from './cloud.js';
import { aiDiagnose, aiFinishHolder, aiSend, aiTestConnection, fetchAiModels, fillPreset, openAiSettings, renderAiMessage, renderModelSwitch, saveAiSettings, switchModel, updateGenChip } from './ai.js';
import { addSnippet, closeSnippetMenu, renderMonitorBar, renderSnippets } from './monitor.js';
import { activeConnectedSession, fileDelete, fileDownload, filePanelSession, fileUpload, loadFileDir, renderFileTarget } from './sftp.js';
import { openTermSettings, saveTermSettings } from './settings.js';
import { openBatchModal, openForwardModal, renderBatchHosts, runBatch, saveForwardRule, toggleHistory } from './tools.js';

export function termFromEvent(e) {
  const paneEl = e.target && e.target.closest ? e.target.closest('.term-pane') : null;
  if (!paneEl) return null;
  const sid = paneEl.dataset.session;
  return sid ? state.sessions.get(sid) || null : null;
}

export function closeCtxMenu() {
  const m = $('#ctx-menu');
  if (m) m.classList.add('hidden');
}

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
    btn.className = 'ctx-item';
    btn.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.key ? `<span class="ctx-key">${escapeHtml(it.key)}</span>` : ''}`;
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

/// 终端右键菜单:复制/粘贴/全选 + 清屏/搜索/只读
export function openTermCtxMenu(e, session) {
  const term = session.term;
  const hasSel = (() => { try { return term.hasSelection(); } catch { return false; } })();
  showCtxMenu(e.clientX, e.clientY, [
    { label: '复制', key: '⌘C', disabled: !hasSel, run: () => { try { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); } catch { /* ignore */ } } },
    { label: '粘贴', key: '⌘V', run: () => { navigator.clipboard.readText().then((t) => { if (t && !session.readOnly) term.paste(t); }).catch(() => {}); } },
    { label: '全选', key: '⌘A', run: () => { try { term.selectAll(); } catch { /* ignore */ } } },
    '-',
    { label: '搜索…', key: '⌘F', run: () => { activateSession(session.sessionId); openTermSearch(); } },
    { label: '清屏', run: () => { activateSession(session.sessionId); clearActiveTerm(); } },
    { label: session.readOnly ? '关闭只读' : '设为只读', run: () => { activateSession(session.sessionId); toggleReadonly(); } },
    '-',
    { label: '复制会话 ID', run: () => { navigator.clipboard.writeText(session.sessionId).catch(() => {}); toast('已复制会话 ID', 'success'); } },
  ]);
}

export function bindContextMenu() {
  // 全局屏蔽原生菜单:oncontextmenu 返回 false 即阻止默认行为
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const session = termFromEvent(e);
    if (session) openTermCtxMenu(e, session);
    else closeCtxMenu();
    return false;
  });
  // 点击/滚动/失焦/缩放后收起
  window.addEventListener('mousedown', (e) => {
    const menu = $('#ctx-menu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) closeCtxMenu();
  }, true);
  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
  document.addEventListener('scroll', closeCtxMenu, true);
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

  // ＋ 新建标签页:空标签,等待用户在窗格选择器里选主机
  $('#btn-newtab').addEventListener('click', () => {
    const tab = createTab();
    activateTab(tab.id);
    // 空标签给一个空窗格,渲染窗格选择器
    const paneId = newPaneId();
    tab.layout = leaf(paneId);
    tab.panes.set(paneId, { id: paneId, el: makePaneEl(paneId), sessionId: null });
    tab.el.querySelector('.tab-title').textContent = '新标签';
    renderLayout();
    updateWelcome();
  });

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
  $('#btn-file-bookmark').addEventListener('click', async () => {
    const s = filePanelSession();
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
    const s = filePanelSession();
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
    renderFileTarget();
    fitActive();
    // 用"当前会话自己"记住的目录打开,而不是全局 cwd ——
    // 后者可能属于另一台服务器,拿它的路径去 list 会张冠李戴。
    const s = activeConnectedSession();
    await loadFileDir(s ? (s.lastFileDir || null) : null);
  });
  $('#btn-file-close').addEventListener('click', () => { $('#file-panel').classList.add('hidden'); fitActive(); });
  $('#btn-file-refresh').addEventListener('click', () => loadFileDir(state.file.cwd));
  $('#btn-file-mkdir').addEventListener('click', () => {
    $('#file-mkdir-row').classList.remove('hidden');
    $('#file-mkdir-name').focus();
  });
  $('#btn-file-mkdir-cancel').addEventListener('click', () => $('#file-mkdir-row').classList.add('hidden'));
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

  // 全局快捷键：⌘F 搜索、⌘T 新标签、⌘W 关标签、⌘D 分屏、⌘1..9 切标签
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key === 'f') { e.preventDefault(); openTermSearch(); return; }
    if (mod && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      // 优先关"当前窗格";窗格只剩一个时关整个标签
      const s = state.sessions.get(state.activeId);
      const tab = activeTab();
      const paneCount = tab ? [...state.sessions.values()].filter((x) => x.tabId === tab.id).length : 0;
      if (s && paneCount > 1) closeSession(s.sessionId);
      else if (tab) closeTab(tab.id);
      return;
    }
    if (mod && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      const tab = createTab();
      activateTab(tab.id);
      const paneId = newPaneId();
      tab.layout = leaf(paneId);
      tab.panes.set(paneId, { id: paneId, el: makePaneEl(paneId), sessionId: null });
      renderLayout();
      updateWelcome();
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
    if (!s) return;
    // term.write 是异步的:数据先入队、稍后解析绘制。首个数据块用回调在
    // "已解析并绘制"之后做一次尺寸重算,修正 open() 期间过早缓存的行几何。
    s.term.write(data);
    if (s.pendingFirstPaint) {
      s.pendingFirstPaint = false;
      firstPaint(s);
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

export async function boot() {
  bindEvents();
  bindContextMenu();
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
    // 口令输入框(导出/导入用)
    promptOpen: () => !$('#modal-prompt').classList.contains('hidden'),
    promptTitle: () => $('#prompt-title').textContent,
    promptFill: (v) => { $('#prompt-input').value = v; },
    promptClickOk: () => $('#btn-prompt-ok').click(),
    promptClickCancel: () => $('#btn-prompt-cancel').click(),
    write: (d) => {
      const s = state.sessions.get(state.activeId);
      if (s && s.status === 'connected' && !s.readOnly) s.term.input(d);
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
        rows: document.querySelectorAll('#file-list .file-row').length,
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
  };
}

