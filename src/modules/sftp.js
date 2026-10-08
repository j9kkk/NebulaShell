// 文件分屏:文件管理是主机标签内的分屏之一,与终端分屏同级、同布局规则。
//
// 模型:
// - 每个文件分屏有独立的浏览状态(cwd/历史/选择/草稿),直接长在窗格对象上
//   (tab.panes 中 kind:'file' 的窗格)—— 像终端分屏各有各的 shell cwd。
// - 分屏只服务所在标签的主机:传输通道在操作提交时解析为标签内的已连接会话
//   (优先活动会话;同主机任意会话等价)。标签内单个分屏断开无感知;
//   全部断开则灰显,任一会话恢复后自动刷新。
// - 没有全局面板、没有 view 注册表、没有跟随/固定模式。主机身份由标签标题承载,
//   窗格内零重复标识。
// - 所有远端操作以提交时的快照(paneId+sessionId+cwd)为准,确认框期间
//   切换目录不改投目标;后端再做 epoch 校验。

import { $, api, applyAccelTitles, askConfirm, askPrompt, copyText, setModalDismissHandler, showCtxMenu, state, toast } from './core.js';
import { icon } from '../shared/icons.js';
import { accelOf } from './keymap.js';
import { escapeHtml } from './hosts.js';
import { registerUploadTask, registerDownloadTask, registerTreeDownloadTask, taskProgressFromEvent, wasRecentDrag, submitCopyTask } from './file-transfer.js';

export function fileParent(p) {
  const trimmed = String(p || '/').replace(/\/+$/, '');
  if (!trimmed || trimmed === '') return '/';
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

export function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

export function validEntryName(name) {
  return typeof name === 'string' && !!name.trim() && name !== '.' && name !== '..'
    && !/[\/\\\0]/.test(name);
}

export function remoteEntryPath(cwd, name) {
  return (cwd === '/' ? '' : cwd.replace(/\/+$/, '')) + '/' + name;
}

/* ---------------- 窗格查找 ---------------- */

/// 窗格状态:浏览数据全在窗格对象上,窗格关闭即丢弃(不落全局)。
export function createFilePaneState() {
  return {
    cwd: null,
    hist: [],
    histIdx: -1,
    entries: [],
    // 目录列表缓存:path → { entries, at }。stale-while-revalidate 用:
    // 导航命中先渲染,TTL 内不再发请求,过期后台重取。与 entries 同生命周期,
    // 随窗格对象跨切标签/reparent 存活,窗格关闭即丢弃。
    dirCache: new Map(),
    selectedNames: [],
    anchorIdx: null,
    loading: false,
    stale: false,
    statusText: '',
    lastSessionId: null,
    reqGen: 0,
    renameMode: null,
    chmodTarget: null,
    mkdirTarget: null,
    lastOpen: null,
  };
}

function ownerOf(pane) {
  if (!pane) return null;
  for (const tab of state.tabs.values()) {
    if (tab.panes.get(pane.id) === pane) return tab;
  }
  return null;
}

export function filePanesIn(tab) {
  return tab ? [...tab.panes.values()].filter((p) => p.kind === 'file') : [];
}

function allFilePanes() {
  const out = [];
  for (const tab of state.tabs.values()) {
    for (const pane of tab.panes.values()) if (pane.kind === 'file') out.push(pane);
  }
  return out;
}

export function findFilePane(paneId) {
  if (!paneId) return null;
  for (const tab of state.tabs.values()) {
    const pane = tab.panes.get(paneId);
    if (pane && pane.kind === 'file') return pane;
  }
  return null;
}

/// 从 DOM 元素反查窗格(拖拽落点/OS 拖放入口)
export function filePaneFromEl(el) {
  const elp = el?.closest?.('.file-pane');
  return elp ? findFilePane(elp.dataset.pane) : null;
}

/// 焦点所在的文件分屏(⌘A/上传/「关闭当前窗格」的作用对象)。
/// 焦点判定读 DOM(.focused 由 syncFocusedPane 维护),不改变任何绑定。
export function focusedFilePane() {
  const elp = document.querySelector?.('.term-pane.file-pane.focused');
  return elp ? findFilePane(elp.dataset.pane) : null;
}

/* ---------------- 传输通道解析 ---------------- */

/// 文件分屏的传输会话:优先活动会话(属于本标签且已连接),
/// 否则本标签任一已连接会话 —— 同主机任意会话等价,单个分屏断开无感知。
export function paneSession(pane) {
  const tab = ownerOf(pane);
  if (!tab) return null;
  const act = state.sessions.get(state.activeId);
  if (act && act.tabId === tab.id && act.status === 'connected') return act;
  return [...state.sessions.values()].find((s) => s.tabId === tab.id && s.status === 'connected') || null;
}

/* ---------------- 快照语义 ---------------- */

export function paneSnapshot(pane) {
  if (!pane || !pane.cwd) return null;
  const s = paneSession(pane);
  if (!s) return null;
  return Object.freeze({ paneId: pane.id, sessionId: s.sessionId, cwd: pane.cwd });
}

export function snapshotFileTarget() {
  return paneSnapshot(focusedFilePane());
}

export function isFilePaneCurrent(target) {
  if (!target) return false;
  const pane = findFilePane(target.paneId);
  const s = pane ? state.sessions.get(target.sessionId) : null;
  return !!pane && !!s && s.status === 'connected' && !pane.loading && pane.cwd === target.cwd;
}

function setFilePaneStatus(target, text) {
  const pane = findFilePane(target?.paneId);
  if (!pane || !isFilePaneCurrent(target)) return;
  pane.statusText = text;
  renderFileStatus(pane);
}

/* ---------------- 窗格 DOM ---------------- */

/// 构建文件分屏内部 DOM(由 terminal.js 的 makePaneEl 在创建 file 窗格时调用)。
/// 无身份行/无模式标识;处理器闭包绑定 pane,幂等(el 只建一次)。
export function buildFilePane(pane) {
  const elp = pane.el;
  if (!elp || elp.dataset.fpBuilt) return;
  elp.dataset.fpBuilt = '1';
  elp.innerHTML = `
    <div class="file-toolbar">
      <button class="btn icon fp-back" title="后退">${icon('arrowLeft')}</button>
      <button class="btn icon fp-forward" title="前进">${icon('arrowRight')}</button>
      <button class="btn icon fp-up" title="上一级">${icon('arrowUp')}</button>
      <button class="btn icon fp-refresh" title="刷新当前目录">${icon('refresh')}</button>
      <button class="btn icon fp-bookmark" title="收藏当前目录" aria-label="收藏当前目录">${icon('star')}</button>
      <button class="btn icon fp-mkdir" title="新建文件夹">${icon('folderPlus')}</button>
      <button class="btn icon fp-selectall" title="全选/全不选(已全选时点击清空;右键=反选)" aria-label="全选或反选">${icon('listChecks')}</button>
      <button class="btn icon fp-upload" title="上传文件(也可直接把文件拖进本分屏)" aria-label="上传文件">${icon('upload')}</button>
      <span class="spacer"></span>
      <span class="file-toolbar-hint muted" data-title="可多选:%1点选/Shift 区间,右键批量下载 / 复制 / 删除" data-accel="term.copy"></span>
    </div>
    <div class="fp-input-row fp-mkdir-row hidden">
      <input class="fp-mkdir-name" type="text" placeholder="名称(新建文件夹 / 重命名)" />
      <button class="btn small primary fp-mkdir-ok">确定</button>
      <button class="btn small fp-mkdir-cancel">取消</button>
    </div>
    <div class="fp-input-row fp-chmod-row hidden">
      <span class="muted">权限(owner/group/other × rwx):</span>
      <input class="fp-chmod-octal" type="text" maxlength="4" placeholder="0644" style="width:70px;" />
      <button class="btn small primary fp-chmod-ok">应用</button>
      <button class="btn small fp-chmod-cancel">取消</button>
    </div>
    <!-- 路径栏是输入框:回车跳转、Esc/失焦还原;右键可收藏当前目录 -->
    <input class="file-path" type="text" spellcheck="false" autocomplete="off" />
    <div class="file-bookmarks"></div>
    <div class="file-list"></div>
    <div class="file-status muted"></div>
    <div class="file-drop-hint hidden">松开即上传到当前目录</div>
  `;
  // 提示里的快捷键按平台渲染(动作名查 keymap):buildFilePane 是动态创建,
  // boot 的 applyAccelTitles 扫不到,必须在模板写入后补一次。
  applyAccelTitles(elp);
  const q = (sel) => elp.querySelector(sel);
  q('.fp-back').addEventListener('click', () => fileNavBack(pane));
  q('.fp-forward').addEventListener('click', () => fileNavForward(pane));
  q('.fp-up').addEventListener('click', () => fileNavUp(pane));
  q('.fp-refresh').addEventListener('click', () => fileRefresh(pane));
  q('.fp-bookmark').addEventListener('click', () => addBookmark(pane));
  // 全选/反选一体:单击 ☑ = 智能切换(全选 ↔ 全不选),右键 = 反选。
  // 选中数与条目数相同即视为"已全选",再点一次清空 —— 与资源管理器惯例一致。
  const selectAllBtn = q('.fp-selectall');
  selectAllBtn.addEventListener('click', () => {
    const total = pane.entries.length;
    const picked = (pane.selectedNames || []).length;
    if (total > 0 && picked === total) {
      pane.selectedNames = [];
      pane.anchorIdx = null;
      renderFileList(pane);
    } else {
      selectAllEntries(pane);
    }
  });
  selectAllBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    invertSelection(pane);
  });
  q('.fp-mkdir').addEventListener('click', () => {
    const target = paneSnapshot(pane);
    if (!target) return toast('请先连接并打开目录', 'error');
    pane.renameMode = null;
    pane.mkdirTarget = target;
    q('.fp-mkdir-row').classList.remove('hidden');
    const input = q('.fp-mkdir-name');
    input.value = '';
    input.placeholder = '新建文件夹名称';
    input.focus();
  });
  q('.fp-upload').addEventListener('click', async () => {
    const target = paneSnapshot(pane);
    if (!target) return toast('请先连接并打开目录', 'error');
    const paths = await api('dialog:pickAnyFile');
    if (!paths || !paths.length) return;
    uploadLocalPaths(paths, target);
  });
  const pathEl = q('.file-path');
  pathEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '收藏当前目录', disabled: !pane.cwd, run: () => addBookmark(pane) },
      { label: '复制当前路径', disabled: !pane.cwd, run: () => { copyText(pane.cwd).then((ok) => toast(ok ? '已复制路径' : '复制失败', ok ? 'success' : 'error')); } },
    ]);
  });
  pathEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      pathEl.value = pane.cwd || '';
      pathEl.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitFilePath(pane);
    }
  });
  pathEl.addEventListener('blur', () => { pathEl.value = pane.cwd || ''; });
  const mkdirName = q('.fp-mkdir-name');
  mkdirName.addEventListener('keydown', (e) => { if (e.key === 'Enter') q('.fp-mkdir-ok')?.click(); });
  q('.fp-mkdir-ok').addEventListener('click', async () => {
    const okBtn = q('.fp-mkdir-ok');
    const name = q('.fp-mkdir-name').value.trim();
    if (!validEntryName(name)) return toast('名称不能为空、包含路径分隔符或为 . / ..', 'error');
    okBtn.disabled = true;
    try {
      if (pane.renameMode) {
        await commitFileRename(name, pane);
        toast('已重命名', 'success');
        return;
      }
      const target = pane.mkdirTarget;
      if (!isFilePaneCurrent(target)) return toast('目录已切换,请重新新建', 'error');
      await api('sftp:mkdir', { sessionId: target.sessionId, path: remoteEntryPath(target.cwd, name) });
      toast('目录已创建', 'success');
      if (isFilePaneCurrent(target)) {
        q('.fp-mkdir-row').classList.add('hidden');
        q('.fp-mkdir-name').value = '';
        await loadFileDir(pane, target.cwd, { force: true });
      }
    } catch (e) {
      toast('操作失败:' + e.message, 'error');
    } finally { okBtn.disabled = false; }
  });
  q('.fp-mkdir-cancel').addEventListener('click', () => {
    pane.renameMode = null;
    q('.fp-mkdir-row').classList.add('hidden');
  });
  q('.fp-chmod-ok').addEventListener('click', async () => {
    const okBtn = q('.fp-chmod-ok');
    const target = pane.chmodTarget;
    const value = q('.fp-chmod-octal').value.trim();
    if (!/^[0-7]{3,4}$/.test(value)) return toast('权限格式错误(八进制,如 0644)', 'error');
    if (!isFilePaneCurrent(target)) return toast('目录已切换,请重新选择目标', 'error');
    okBtn.disabled = true;
    try {
      await api('sftp:chmod', { sessionId: target.sessionId, path: remoteEntryPath(target.cwd, target.name), mode: parseInt(value, 8) });
      toast('权限已更新', 'success');
      if (isFilePaneCurrent(target)) {
        q('.fp-chmod-row').classList.add('hidden');
        await loadFileDir(pane, target.cwd, { force: true });
      }
    } catch (e) { toast('修改权限失败:' + e.message, 'error'); }
    finally { okBtn.disabled = false; }
  });
  q('.fp-chmod-cancel').addEventListener('click', () => q('.fp-chmod-row').classList.add('hidden'));
}

/// 新窗格初始加载:会话记忆目录优先,无则探测 cwd(见设计 7-3)。
export async function initFilePane(pane) {
  const s = paneSession(pane);
  if (!s) { pane.stale = true; renderFilePane(pane); return; }
  const remembered = s.lastFileDir || await initialFileDir(s);
  if (!paneSession(pane)) return;
  await loadFileDir(pane, remembered).catch(() => {});
}

export async function initialFileDir(s) {
  try {
    const r = await api('ssh:probeCwd', { sessionId: s.sessionId });
    if (r && r.cwd) return r.cwd;
  } catch { /* 探测失败不阻断打开 */ }
  return s.remoteCwd || null;
}

/* ---------------- 渲染 ---------------- */

function q(pane, sel) { return pane.el?.querySelector(sel) || null; }

export function renderFileStatus(pane) {
  const st = q(pane, '.file-status');
  if (st) st.textContent = pane.statusText || '';
}

/// 全量渲染一个窗格(列表/路径/导航/状态/书签)。未挂载的窗格(后台标签)
/// 写在 detached el 上,重新挂载时自然可见。
export function renderFilePane(pane) {
  if (!pane || !pane.el) return;
  pane.el.classList.toggle('stale', !!pane.stale);
  renderFileList(pane);
  renderFileNav(pane);
  renderFileStatus(pane);
  renderFileBookmarks(pane).catch(() => {});
}

function renderFileNav(pane) {
  const back = q(pane, '.fp-back');
  const fwd = q(pane, '.fp-forward');
  const up = q(pane, '.fp-up');
  if (!back || !fwd || !up) return;
  back.disabled = pane.loading || pane.histIdx <= 0;
  fwd.disabled = pane.loading || pane.histIdx < 0 || pane.histIdx >= pane.hist.length - 1;
  up.disabled = pane.loading || !pane.cwd || fileParent(pane.cwd) === pane.cwd;
  back.title = pane.histIdx > 0 ? `后退到 ${pane.hist[pane.histIdx - 1]}` : '后退(没有更早的目录)';
  fwd.title = pane.histIdx >= 0 && pane.histIdx < pane.hist.length - 1 ? `前进到 ${pane.hist[pane.histIdx + 1]}` : '前进(没有更晚的目录)';
  up.title = pane.cwd ? `上一级:${fileParent(pane.cwd)}` : '上一级';
}

/// 多选:单击=单选;⌘/Ctrl=切换;Shift=区间(锚点为上次非修饰选择)。
export function selectEntries(pane, en, idx, e) {
  const names = pane.selectedNames || [];
  const meta = !!(e && (e.metaKey || e.ctrlKey));
  const shift = !!(e && e.shiftKey);
  if (shift && pane.anchorIdx != null) {
    const [a, b] = [Math.min(pane.anchorIdx, idx), Math.max(pane.anchorIdx, idx)];
    const range = pane.entries.slice(a, b + 1).map((x) => x.name);
    pane.selectedNames = meta
      ? [...new Set([...names, ...range])]
      : range;
  } else if (meta) {
    pane.selectedNames = names.includes(en.name)
      ? names.filter((n) => n !== en.name)
      : [...names, en.name];
    pane.anchorIdx = idx;
  } else {
    pane.selectedNames = [en.name];
    pane.anchorIdx = idx;
  }
  renderFileList(pane);
}

export function selectAllEntries(pane) {
  if (!pane) return;
  pane.selectedNames = pane.entries.map((x) => x.name);
  pane.anchorIdx = null;
  renderFileList(pane);
}

/// 反选:选中集与当前目录条目互换(`..` 行本就不在 selectedNames 语义内)
export function invertSelection(pane) {
  if (!pane) return;
  const set = new Set(pane.selectedNames || []);
  pane.selectedNames = pane.entries.map((x) => x.name).filter((n) => !set.has(n));
  pane.anchorIdx = null;
  renderFileList(pane);
}

/// 当前选中的条目对象(按窗格当前 entries 解析,`..` 行不参与)
export function selectedEntryObjects(pane) {
  const set = new Set(pane.selectedNames || []);
  return pane.entries.filter((x) => set.has(x.name));
}

function renderFileList(pane) {
  const box = q(pane, '.file-list');
  if (!box) return;
  box.innerHTML = '';
  const { cwd, entries } = pane;
  const pathEl = q(pane, '.file-path');
  if (pathEl) {
    pathEl.value = cwd || '';
    pathEl.disabled = !cwd;
    pathEl.title = cwd ? `${cwd}\n可直接改路径后回车跳转;右键:收藏此目录 / 复制路径` : '';
  }
  renderFileNav(pane);
  if (pane.loading && !cwd) {
    box.innerHTML = '<div class="file-empty">加载中…</div>';
    return;
  }
  if (cwd && fileParent(cwd) !== cwd) {
    const upRow = document.createElement('div');
    upRow.className = 'file-row';
    upRow.innerHTML = `<span class="f-ic">${icon('folder')}</span><span class="f-name">..</span>`;
    upRow.addEventListener('click', () => loadFileDir(pane, fileParent(cwd)));
    box.appendChild(upRow);
  }
  for (const [idx, en] of entries.entries()) {
    const row = document.createElement('div');
    row.className = 'file-row' + ((pane.selectedNames || []).includes(en.name) ? ' selected' : '');
    row.dataset.name = en.name;
    row.dataset.dir = en.dir ? '1' : '0';
    row.dataset.idx = String(idx);
    row.innerHTML = `<span class="f-ic">${icon(en.dir ? 'folder' : 'file')}</span><span class="f-name"></span><span class="f-size"></span>`;
    row.querySelector('.f-name').textContent = en.name;
    row.querySelector('.f-size').textContent = en.dir ? '' : fmtSize(en.size);
    row.title = en.dir ? `${en.name}/` : `${en.name}  ${fmtSize(en.size)}`;
    row.addEventListener('click', (e) => {
      if (wasRecentDrag()) return;
      selectEntries(pane, en, idx, e);
    });
    row.addEventListener('dblclick', () => {
      if (wasRecentDrag()) return;
      if (en.dir) loadFileDir(pane, (cwd === '/' ? '' : cwd) + '/' + en.name);
      else openRemoteEntry(en, pane);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 右键未选中项 = 重置为单选该项;已选中项保持多选集,菜单作用于整组
      if (!(pane.selectedNames || []).includes(en.name)) selectEntries(pane, en, idx, { metaKey: false, shiftKey: false, ctrlKey: false });
      openFileCtxMenu(e.clientX, e.clientY, en, pane);
    });
    box.appendChild(row);
  }
  if (!entries.length && cwd && !pane.loading) box.innerHTML = '<div class="file-empty">目录为空</div>';
}

/* ---------------- 导航 ---------------- */

export function fileNavBack(pane) {
  if (!pane || pane.loading || pane.histIdx <= 0) return;
  return loadFileDir(pane, pane.hist[pane.histIdx - 1], { record: false, historyIndex: pane.histIdx - 1 });
}

export function fileNavForward(pane) {
  if (!pane || pane.loading || pane.histIdx < 0 || pane.histIdx >= pane.hist.length - 1) return;
  return loadFileDir(pane, pane.hist[pane.histIdx + 1], { record: false, historyIndex: pane.histIdx + 1 });
}

export function fileNavUp(pane) {
  if (!pane || !pane.cwd) return toast('请先打开一个远程目录', 'error');
  const up = fileParent(pane.cwd);
  if (up === pane.cwd) return;
  loadFileDir(pane, up);
}

export function fileRefresh(pane) {
  if (!pane || !pane.cwd) return;
  loadFileDir(pane, pane.cwd, { force: true });
}

/* ---------------- 目录加载 ---------------- */

const DIR_CACHE_TTL = 20000;
const DIR_CACHE_MAX = 50;

/// 回包/缓存写回缓存表:重插到 Map 尾部做 LRU,超量淘汰最老条目。
function cacheListing(pane, path, entries) {
  const cache = pane.dirCache;
  cache.delete(path);
  cache.set(path, { entries, at: Date.now() });
  while (cache.size > DIR_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

/// 应用一次目录结果到窗格(网络回包与缓存命中共用):cwd/entries/按名保留
/// 的选中集/历史定位/lastFileDir,然后整格渲染。
function applyListing(pane, path, entries, { record, historyIndex }, session) {
  Object.assign(pane, {
    cwd: path,
    entries,
    selectedNames: (pane.selectedNames || []).filter((n) => entries.some((e) => e.name === n)),
    anchorIdx: null,
    loading: false,
    stale: false,
    statusText: '',
    renameMode: null,
    chmodTarget: null,
    mkdirTarget: null,
  });
  if (session) session.lastFileDir = path;
  if (record === false && Number.isInteger(historyIndex)) {
    pane.histIdx = historyIndex;
  } else if (record !== false && pane.hist[pane.histIdx] !== path) {
    pane.hist = pane.hist.slice(0, pane.histIdx + 1);
    pane.hist.push(path);
    if (pane.hist.length > 50) pane.hist = pane.hist.slice(-50);
    pane.histIdx = pane.hist.length - 1;
  }
  renderFilePane(pane);
}

/// stale-while-revalidate 的后台重取:不置 loading(导航键不禁用、
/// 任务终态刷新不被跳过),沿用 reqGen 防乱序;失败保留缓存内容。
async function refreshCachedDir(pane, s, dir, gen) {
  try {
    const r = await api('sftp:list', { sessionId: s.sessionId, path: dir });
    if (gen !== pane.reqGen) return;
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/') || !Array.isArray(r.entries)) {
      throw new Error('目录响应无效');
    }
    cacheListing(pane, dir, r.entries);
    if (pane.cwd !== dir) return;
    applyListing(pane, r.path, r.entries, { record: false, historyIndex: pane.histIdx }, s);
  } catch (e) {
    if (gen !== pane.reqGen || pane.cwd !== dir) return;
    pane.statusText = '后台刷新失败:' + e.message;
    renderFileStatus(pane);
  }
}

/// 传输通道在提交时解析:快照冻结(paneId+sessionId+cwd),后端 epoch 校验兜底。
/// 导航类调用(opts.force 未设)命中缓存先渲染:TTL 内零请求,过期后台重取;
/// 刷新按钮/写操作后/任务终态/重连恢复必须传 opts.force 走网络并回写缓存。
export async function loadFileDir(pane, dir, opts = {}) {
  if (!pane) return false;
  const s = paneSession(pane);
  if (!s) { toast('当前主机没有已连接的会话', 'error'); return false; }
  const gen = ++pane.reqGen;
  if (!opts.force) {
    const hit = pane.dirCache.get(dir);
    if (hit) {
      pane.dirCache.delete(dir);
      pane.dirCache.set(dir, hit);
      pane.lastSessionId = s.sessionId;
      for (const sel of ['.fp-mkdir-row', '.fp-chmod-row']) q(pane, sel)?.classList.add('hidden');
      applyListing(pane, dir, hit.entries, opts, s);
      if (Date.now() - hit.at <= DIR_CACHE_TTL) return true;
      refreshCachedDir(pane, s, dir, gen);
      return true;
    }
  }
  pane.loading = true;
  pane.lastSessionId = s.sessionId;
  const list = q(pane, '.file-list');
  // 加载提示只留列表区居中的一份,状态栏不再重复显示同样的「加载中…」
  if (list) list.innerHTML = '<div class="file-empty">加载中…</div>';
  pane.statusText = '';
  renderFileStatus(pane);
  for (const sel of ['.fp-mkdir-row', '.fp-chmod-row']) q(pane, sel)?.classList.add('hidden');
  try {
    const r = await api('sftp:list', { sessionId: s.sessionId, path: dir });
    if (gen !== pane.reqGen) return false;
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/') || !Array.isArray(r.entries)) throw new Error('目录响应无效');
    cacheListing(pane, dir, r.entries);
    applyListing(pane, r.path, r.entries, opts, s);
    return true;
  } catch (e) {
    if (gen !== pane.reqGen) return false;
    pane.loading = false;
    pane.statusText = '加载失败:' + e.message;
    renderFilePane(pane);
    return false;
  }
}

async function commitFilePath(pane) {
  const pathEl = q(pane, '.file-path');
  if (!pathEl) return;
  const p = pathEl.value.trim();
  if (!p || p === pane.cwd) {
    pathEl.value = pane.cwd || '';
    return;
  }
  await loadFileDir(pane, p);
  pathEl.value = pane.cwd || '';
}

/* ---------------- 右键菜单 ---------------- */

let lastCtxPos = { x: 100, y: 100 };
export function noteCtxPos(x, y) { lastCtxPos = { x, y }; }

export function openFileCtxMenu(x, y, en, pane) {
  if (!pane) return;
  const connected = !!paneSession(pane) && !pane.loading && !!pane.cwd;
  const target = paneSnapshot(pane);
  const full = pane.cwd ? remoteEntryPath(pane.cwd, en.name) : en.name;
  noteCtxPos(x, y);
  const guarded = (run) => () => {
    if (!isFilePaneCurrent(target)) return toast('目录已切换,请重新选择目标', 'error');
    return run(pane);
  };
  // 右键已选中项时菜单作用于整个选中组(含右键这项);单选退化为旧行为
  const group = (pane.selectedNames || []).length > 1 && (pane.selectedNames || []).includes(en.name)
    ? selectedEntryObjects(pane)
    : null;
  const batchLabel = group ? `(${group.length} 项)` : '';
  showCtxMenu(x, y, [
    // 文件「打开(临时副本)」已移除:打开统一走双击
    ...(en.dir ? [{ label: '打开目录', disabled: !connected, run: guarded((p) => loadFileDir(p, full)) }] : []),
    { label: group ? `下载${batchLabel}…` : '下载…', disabled: !connected, run: guarded((p) => downloadEntry(en, p, group)) },
    '-',
    { label: group ? `复制到…${batchLabel}` : '复制到…', disabled: !connected, run: guarded((p) => copyEntriesToHost(group || [en], p)) },
    ...(group || en.dir ? [] : [{ label: '创建副本', disabled: !connected, run: guarded((p) => duplicateEntry(en, p)) }]),
    '-',
    { label: '重命名…', disabled: !connected || !!group, run: guarded((p) => startRename(en, p)) },
    { label: '权限…', disabled: !connected || !!group, run: guarded((p) => startChmod(en, p)) },
    ...(group ? [{ label: `全选(${accelOf('files.selectAll')} 范围内)`, run: () => selectAllEntries(pane) }] : []),
    { label: '反选', run: () => invertSelection(pane) },
    '-',
    { label: '复制名称', run: () => { const names = group ? group.map((g) => g.name) : [en.name]; copyText(names.join('\n')).then((ok) => toast(ok ? `已复制 ${names.length} 个名称` : '复制失败', ok ? 'success' : 'error')); } },
    { label: '复制完整路径', run: () => { const paths = group ? group.map((g) => remoteEntryPath(pane.cwd, g.name)) : [full]; copyText(paths.join('\n')).then((ok) => toast(ok ? `已复制 ${paths.length} 个路径` : '复制失败', ok ? 'success' : 'error')); } },
    '-',
    { label: group ? `删除${batchLabel}` : (en.dir ? '删除目录' : '删除文件'), danger: true, disabled: !connected, run: guarded((p) => removeEntry(en, p)) },
  ]);
}

/* ---------------- 复制到…/创建副本 ---------------- */

/// 「复制到…」:目标按"已连接会话 + 目录"选择,跨主机/同主机换目录都可走。
export async function copyEntriesToHost(items, pane) {
  const sessions = [...state.sessions.values()].filter((s) => s.status === 'connected');
  if (!sessions.length) return toast('没有已连接会话', 'error');
  const pick = await new Promise((resolve) => {
    const menu = sessions.map((s) => ({
      label: `${s.host.name} · ${s.host.username}@${s.host.host}:${s.host.port}`,
      checked: paneSession(pane)?.sessionId === s.sessionId,
      run: () => resolve(s),
    }));
    menu.push('-');
    menu.push({ label: '取消', run: () => resolve(null) });
    showCtxMenu(lastCtxPos.x, lastCtxPos.y, menu);
  });
  if (!pick) return;
  const srcSession = paneSession(pane);
  const sameSession = srcSession && pick.sessionId === srcSession.sessionId;
  const dstDir = await askPrompt(`复制 ${items.length} 项到 ${pick.host.name} 的哪个目录?`, {
    title: '复制到 ' + pick.host.name,
    okText: '复制',
    password: false,
    placeholder: pane.cwd || '/',
    validate: (v) => (v.trim().startsWith('/') ? null : '必须是绝对路径'),
  });
  if (!dstDir) return;
  if (sameSession && dstDir.trim() === pane.cwd) {
    return toast('源与目标目录相同;需要副本请用「创建副本」', 'error');
  }
  return submitCopyTask({
    srcSessionId: srcSession.sessionId,
    srcDir: pane.cwd,
    srcPaneId: pane.id,
    dstSessionId: pick.sessionId,
    dstDir: dstDir.trim(),
    dstPaneId: null,
    items: items.map((x) => ({ name: x.name, isDir: !!x.dir })),
  });
}

export async function duplicateEntry(en, pane) {
  // 同目录副本 = 复制任务,目标为同会话同目录,冲突策略自动重命名
  const s = paneSession(pane);
  if (!s) return toast('当前主机没有已连接的会话', 'error');
  return submitCopyTask({
    srcSessionId: s.sessionId,
    srcDir: pane.cwd,
    srcPaneId: pane.id,
    dstSessionId: s.sessionId,
    dstDir: pane.cwd,
    dstPaneId: pane.id,
    items: [{ name: en.name, isDir: !!en.dir }],
    autoRename: true,
  });
}

/* ---------------- 文件操作(快照语义) ---------------- */

/// 下载条目(单选/多选/目录统一入口):
/// - 单文件 → 原有另存对话框(sftp:download);
/// - 多选或含目录 → 选目标文件夹,走 sftp:downloadTree 递归批量下载。
export async function downloadEntry(en, paneArg, groupOverride = null) {
  const pane = paneArg || focusedFilePane();
  if (!pane) return toast('请先连接主机', 'error');
  // 组下载优先:右键多选组时菜单 run 显式带组,避免依赖全局选中集时序
  const sel = groupOverride || (en ? [en] : selectedEntryObjects(pane));
  if (!sel.length) return toast('请先选择要下载的文件', 'error');
  const target = paneSnapshot(pane);
  if (!target) return toast('请先连接并打开目录', 'error');
  const single = sel.length === 1 && !sel[0].dir ? sel[0] : null;
  if (single) {
    const remotePath = remoteEntryPath(target.cwd, single.name);
    const localPath = await api('dialog:saveFile', { defaultName: single.name });
    if (!localPath) return;
    setFilePaneStatus(target, `下载 ${single.name}…`);
    const task = registerDownloadTask({ paneId: target.paneId, sessionId: target.sessionId, name: single.name, remotePath, localPath });
    try {
      const r = await api('sftp:download', { sessionId: target.sessionId, remotePath, localPath, taskId: task.taskId });
      if (r?.cancelled) {
        task.cancelled();
        setFilePaneStatus(target, `已取消下载 ${single.name}`);
        return;
      }
      task.done();
      setFilePaneStatus(target, `已保存到 ${localPath}`);
      toast('下载完成', 'success');
    } catch (e) {
      task.failed(e.message);
      setFilePaneStatus(target, '下载失败:' + e.message);
      toast('下载失败:' + e.message, 'error');
    }
    return;
  }
  await downloadSelectionToFolder(sel, target);
}

/// 批量/目录下载:选目标根目录 → 后端 downloadTree 逐项递归,
/// 本地同名文件自动加 (n) 后缀,不静默覆盖。
export async function downloadSelectionToFolder(sel, target) {
  const localRoot = await api('dialog:pickDirectory');
  if (!localRoot) return;
  const names = sel.map((x) => x.name);
  const task = registerTreeDownloadTask({ paneId: target.paneId, sessionId: target.sessionId, names, localRoot });
  setFilePaneStatus(target, `下载 ${names.length} 项…`);
  try {
    // 逐项提交:同一根目录下按"选中名"分别递归;后端逐文件上报进度
    let done = 0, skipped = 0, failed = 0, cancelled = false;
    for (const name of names) {
      if (task.isCancelled()) { cancelled = true; break; }
      const r = await api('sftp:downloadTree', { sessionId: target.sessionId, remotePath: remoteEntryPath(target.cwd, name), localPath: localRoot, taskId: task.taskId });
      done += r.done || 0;
      skipped += r.skipped || 0;
      failed += r.failed || 0;
      if (r.cancelled) { cancelled = true; break; }
    }
    if (cancelled) {
      task.finish('cancelled', { done, skipped, failed });
      setFilePaneStatus(target, `已取消下载(${done} 完成 / ${failed} 失败)`);
      toast('下载已取消', 'error');
      return;
    }
    task.finish(failed ? 'partial' : 'done', { done, skipped, failed });
    const summary = `下载完成:${done} 成功 / ${skipped} 跳过 / ${failed} 失败`;
    setFilePaneStatus(target, summary);
    toast(summary, failed ? 'error' : 'success');
  } catch (e) {
    task.failed(e.message);
    setFilePaneStatus(target, '下载失败:' + e.message);
    toast('下载失败:' + e.message, 'error');
  }
}

export async function openRemoteEntry(en, pane) {
  if (!pane) return toast('请先连接主机', 'error');
  if (!en) en = pane.entries.find((x) => x.name === pane.selected);
  if (!en) return toast('请先选择要打开的文件', 'error');
  if (en.dir) return toast('目录请双击进入,不支持直接打开', 'error');
  const target = paneSnapshot(pane);
  if (!target) return toast('请先连接并打开目录', 'error');
  const full = remoteEntryPath(target.cwd, en.name);
  setFilePaneStatus(target, `打开 ${en.name}:下载临时副本…`);
  try {
    const r = await api('sftp:openRemote', { sessionId: target.sessionId, remotePath: full });
    const cur = findFilePane(target.paneId);
    if (cur && isFilePaneCurrent(target)) cur.lastOpen = r || null;
    setFilePaneStatus(target, `已用本地程序打开 ${en.name}`);
    toast(`已用本地程序打开 ${en.name}`, 'success');
  } catch (e) {
    setFilePaneStatus(target, `打开失败:${e.message}`);
    toast('打开失败:' + e.message, 'error');
  }
}

export function startRename(en, pane) {
  if (!pane) return;
  if (!en) return toast('请先选中文件或目录', 'error');
  const target = paneSnapshot(pane);
  if (!target) return toast('请先连接并打开目录', 'error');
  pane.renameMode = { from: en.name, ...target };
  q(pane, '.fp-mkdir-row').classList.remove('hidden');
  const input = q(pane, '.fp-mkdir-name');
  input.placeholder = `重命名为(原名 ${en.name})`;
  input.value = en.name;
  input.focus();
  input.select();
}

export async function commitFileRename(name, pane) {
  const target = pane && pane.renameMode;
  if (!target || !isFilePaneCurrent(target)) throw new Error('目录已切换,请重新选择重命名目标');
  if (!validEntryName(name)) throw new Error('名称不能为空、包含路径分隔符或为 . / ..');
  await api('sftp:rename', {
    sessionId: target.sessionId,
    from: remoteEntryPath(target.cwd, target.from),
    to: remoteEntryPath(target.cwd, name),
  });
  const cur = findFilePane(target.paneId);
  if (cur && cur.renameMode === target) {
    cur.renameMode = null;
    q(cur, '.fp-mkdir-row').classList.add('hidden');
    q(cur, '.fp-mkdir-name').value = '';
  }
  if (isFilePaneCurrent(target)) await loadFileDir(findFilePane(target.paneId), target.cwd, { force: true });
  return true;
}

export function startChmod(en, pane) {
  if (!pane) return;
  if (!en) return toast('请先选中文件或目录', 'error');
  const target = paneSnapshot(pane);
  if (!target) return toast('请先连接并打开目录', 'error');
  pane.chmodTarget = { ...en, ...target };
  q(pane, '.fp-chmod-row').classList.remove('hidden');
  q(pane, '.fp-chmod-octal').value = en.dir ? '0755' : '0644';
}

export async function removeEntry(en, paneArg) {
  const pane = paneArg || focusedFilePane();
  if (!pane) return toast('请先连接主机', 'error');
  const items = en ? [en] : selectedEntryObjects(pane);
  if (!items.length) return toast('请先选择要删除的项', 'error');
  const target = paneSnapshot(pane);
  if (!target) return toast('请先连接并打开目录', 'error');
  const label = items.length === 1
    ? `「${items[0].name}」${items[0].dir ? '(目录必须为空才能删除)' : ''}`
    : `${items.length} 项(${items.filter((x) => x.dir).length} 个目录,目录必须为空才能删除)`;
  if (!(await askConfirm(`确定删除 ${label} 吗?`, { title: items.length === 1 ? (items[0].dir ? '删除目录' : '删除文件') : '批量删除', okText: '删除' }))) return;
  let ok = 0;
  const errors = [];
  for (const item of items) {
    try {
      await api('sftp:remove', { sessionId: target.sessionId, path: remoteEntryPath(target.cwd, item.name), isDir: item.dir });
      ok += 1;
    } catch (e) {
      errors.push(`${item.name}: ${e.message}`);
    }
  }
  if (errors.length) toast(`删除失败(${errors.length}):${errors.slice(0, 3).join(';')}${errors.length > 3 ? '…' : ''}`, 'error');
  else toast(`已删除 ${ok} 项`, 'success');
  if (isFilePaneCurrent(target)) await loadFileDir(findFilePane(target.paneId), target.cwd, { force: true });
}

/* ---------------- 书签(按 hostId 共享) ---------------- */

export async function renderFileBookmarks(pane) {
  const box = q(pane, '.file-bookmarks');
  if (!box) return;
  const s = paneSession(pane);
  box.innerHTML = '';
  if (!s || pane.stale) return;
  let list = [];
  try { list = await api('bookmarks:list'); } catch { return; }
  // 异步返回期间窗格可能已换主机/换通道:宿主不一致就放弃本次渲染
  const cur = paneSession(pane);
  if (!cur || cur.sessionId !== s.sessionId) return;
  const mine = (list || []).filter((b) => b.hostId === s.host.id);
  if (!mine.length) return;
  for (const b of mine) {
    const chip = document.createElement('span');
    chip.className = 'bm-chip';
    chip.innerHTML = icon('star') + ' ' + escapeHtml(b.path);
    chip.title = `跳转到 ${b.path}(右键移除书签)`;
    chip.addEventListener('click', () => loadFileDir(pane, b.path));
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '移除此书签', danger: true, run: async () => {
          await api('bookmarks:remove', { hostId: s.host.id, path: b.path });
          renderFileBookmarks(pane);
        } },
      ]);
    });
    box.appendChild(chip);
  }
}

export async function addBookmark(pane) {
  if (!pane || !pane.cwd) return toast('请先连接并打开目录', 'error');
  const s = paneSession(pane);
  if (!s) return toast('请先连接并打开目录', 'error');
  await api('bookmarks:add', { hostId: s.host.id, path: pane.cwd });
  await renderFileBookmarks(pane);
  toast('已收藏当前目录', 'success');
}

/* ---------------- 上传(队列快照 + 任务中心) ---------------- */

let uploadQueue = Promise.resolve();

export function chooseUploadConflict(name, target) {
  return new Promise((resolve) => {
    const sheet = document.createElement('dialog');
    sheet.id = 'upload-conflict-dialog';
    sheet.className = 'upload-conflict';
    sheet.innerHTML = '<h3>上传同名文件</h3><p></p><label><input type="checkbox" id="upload-conflict-all"> 对此队列的后续冲突使用相同策略</label><div class="modal-foot"></div>';
    const session = state.sessions.get(target.sessionId);
    const host = session?.host;
    const label = host ? `${host.username}@${host.host}:${host.port}` : target.sessionId;
    sheet.querySelector('p').textContent = `目标 ${label} 的 ${target.cwd} 中已存在「${name}」。默认不覆盖。`;
    let finished = false;
    const finish = (policy) => {
      if (finished) return;
      finished = true;
      const applyToAll = sheet.querySelector('input').checked;
      sheet.close();
      sheet.remove();
      resolve({ policy, applyToAll });
    };
    for (const [policy, label] of [['skip', '跳过(默认)'], ['overwrite', '覆盖'], ['rename', '自动重命名'], ['cancel', '取消剩余队列']]) {
      const button = document.createElement('button');
      button.className = 'btn' + (policy === 'overwrite' ? ' danger' : '');
      button.textContent = label;
      button.dataset.policy = policy;
      button.addEventListener('click', () => finish(policy));
      sheet.querySelector('.modal-foot').appendChild(button);
    }
    sheet.addEventListener('cancel', (e) => { e.preventDefault(); finish('cancel'); });
    sheet.addEventListener('close', () => finish('cancel'));
    setModalDismissHandler(sheet, () => finish('cancel'));
    document.body.appendChild(sheet);
    sheet.showModal();
    sheet.querySelector('button').focus();
  });
}

export function uploadLocalPaths(paths, target = snapshotFileTarget()) {
  const list = [...(paths || [])].filter(Boolean);
  if (!list.length) return Promise.resolve([]);
  if (!target) { toast('请先连接并打开远程目录', 'error'); return Promise.resolve([]); }
  const snapshot = Object.freeze({ paneId: target.paneId, sessionId: target.sessionId, cwd: target.cwd });
  const task = uploadQueue.then(() => runUploadQueue(list, snapshot));
  uploadQueue = task.catch(() => {});
  return task;
}

async function runUploadQueue(paths, target) {
  const results = [];
  let allPolicy = null;
  let cancelled = false;
  const names = paths.map((p) => p.split(/[\/\\]/).pop());
  const handle = registerUploadTask({ paneId: target.paneId, sessionId: target.sessionId, dstDir: target.cwd, names });
  for (const localPath of paths) {
    const name = localPath.split(/[\/\\]/).pop();
    if (cancelled || handle.isCancelled()) {
      cancelled = true;
      results.push({ localPath, cancelled: true });
      handle.mark(name, 'cancelled');
      continue;
    }
    setFilePaneStatus(target, `上传 ${name}…`);
    handle.mark(name, 'active');
    try {
      let conflictPolicy = allPolicy || 'error';
      let result = await api('sftp:upload', { sessionId: target.sessionId, localPath, remoteDir: target.cwd, conflictPolicy, taskId: handle.taskId });
      if (result?.conflict) {
        const choice = await chooseUploadConflict(name, target);
        if (choice.policy === 'cancel') {
          handle.cancelRest();
          cancelled = true;
          results.push({ localPath, cancelled: true });
          handle.mark(name, 'cancelled');
          continue;
        }
        conflictPolicy = choice.policy;
        if (choice.applyToAll) allPolicy = conflictPolicy;
        result = await api('sftp:upload', { sessionId: target.sessionId, localPath, remoteDir: target.cwd, conflictPolicy, taskId: handle.taskId });
      }
      if (result?.conflict) throw new Error('目标仍有同名文件,未上传');
      if (result?.cancelled) {
        cancelled = true;
        results.push({ localPath, cancelled: true });
        handle.mark(name, 'cancelled');
        continue;
      }
      results.push({ localPath, ...result, ok: !result?.skipped });
      handle.mark(name, result?.skipped ? 'skipped' : 'done');
      setFilePaneStatus(target, result?.skipped ? `已跳过 ${name}` : `已上传 ${result?.remotePath || name}`);
    } catch (e) {
      results.push({ localPath, error: e.message, ok: false });
      handle.mark(name, 'failed', e.message);
      setFilePaneStatus(target, `上传失败(${name}):${e.message}`);
      toast(`上传失败(${name}):${e.message}`, 'error');
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.error).length;
  const cancelledCount = results.filter((r) => r.cancelled).length;
  const summary = `上传完成:${okCount} 成功 / ${skipped} 跳过 / ${failed} 失败 / ${cancelledCount} 取消`;
  handle.finish(failed ? 'partial' : cancelledCount ? 'cancelled' : 'done');
  if (isFilePaneCurrent(target)) await loadFileDir(findFilePane(target.paneId), target.cwd, { force: true });
  setFilePaneStatus(target, summary);
  toast(summary, failed ? 'error' : 'success');
  return results;
}

/* ---------------- 进度事件按归属路由 ---------------- */

/// 任务终态后刷新仍在浏览同一目录的文件分屏(复制/上传发布结果立即可见)。
/// 目录是归属主键:会话可能已切换(同主机等价),按 cwd 匹配。
export function refreshFilePanesFor(sessionId, dir) {
  if (!dir) return;
  for (const pane of allFilePanes()) {
    if (pane.cwd !== dir || pane.loading) continue;
    if (!paneSession(pane)) continue;
    loadFileDir(pane, dir, { force: true }).catch(() => {});
  }
}

/// sftp:progress 事件按归属路由:任务中心(有 taskId 时)与匹配的分屏状态行
/// 都更新。目录粒度:upload 事件带 remoteDir;download 事件由后端补 remoteDir
/// (源目录);lastSessionId 是该分屏最近一次操作的通道。
export function routeProgress(evt) {
  if (!evt) return;
  if (evt.taskId) taskProgressFromEvent(evt);
  for (const pane of allFilePanes()) {
    if (evt.sessionId && pane.lastSessionId && pane.lastSessionId !== evt.sessionId) continue;
    if (evt.remoteDir && pane.cwd !== evt.remoteDir) continue;
    // 阶段事件(skip/mkdir-failed/readdir-failed/file-failed)不带 pct,
    // 只报名称;带 pct 才显示百分比,避免 "undefined%"
    const op = evt.op === 'upload' ? '上传' : '下载';
    pane.statusText = evt.stage
      ? `${op} ${evt.name}:${evt.stage}${evt.error ? ' ' + evt.error : ''}`
      : typeof evt.pct === 'number' ? `${op} ${evt.name} ${evt.pct}%` : `${op} ${evt.name}…`;
    renderFileStatus(pane);
  }
}

/* ---------------- 连接状态联动 ---------------- */

/// 本标签连接态变化(ssh:status → entry.js):全部断开 → 灰显;
/// 恢复连接 → 清灰显并刷新/补加载。
export function syncFilePanesForTab(tab) {
  const panes = filePanesIn(tab);
  if (!panes.length) return;
  const s = paneTransportSessionOf(tab);
  for (const pane of panes) {
    if (s) {
      if (pane.stale || !pane.cwd) {
        pane.stale = false;
        const dir = pane.cwd || s.lastFileDir || null;
        // 重连恢复强制走网络:断线期间远端可能已变,不吃缓存
        if (dir) loadFileDir(pane, dir, { force: true }).catch(() => {});
        else { pane.statusText = ''; renderFilePane(pane); }
      }
    } else if (!pane.stale) {
      pane.stale = true;
      pane.statusText = '已断开 — 重连后自动恢复';
      renderFilePane(pane);
    }
  }
}

/// 已知 tab 的传输会话解析(避免 ownerOf 反查;语义同 paneSession)
export function paneTransportSessionOf(tab) {
  const act = state.sessions.get(state.activeId);
  if (act && act.tabId === tab.id && act.status === 'connected') return act;
  return [...state.sessions.values()].find((s) => s.tabId === tab.id && s.status === 'connected') || null;
}

export function syncFilePanesForSession(sessionId) {
  const s = state.sessions.get(sessionId);
  const tab = s?.tabId ? state.tabs.get(s.tabId) : null;
  if (tab) syncFilePanesForTab(tab);
}
