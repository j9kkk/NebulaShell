// SFTP 文件面板:列目录、上传下载、权限、书签
import { $, api, askConfirm, copyText, setModalDismissHandler, showCtxMenu, state, toast } from './core.js';

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

export function activeConnectedSession() {
  const s = state.sessions.get(state.activeId);
  return s && s.status === 'connected' ? s : null;
}

export function renderFileList() {
  const box = $('#file-list');
  box.innerHTML = '';
  const { cwd, entries } = state.file;
  // 路径栏是输入框(#file-path):回车跳转、Esc/失焦还原(绑定见 entry.js)。
  // 右键仍可收藏当前目录(原工具栏的「书签」按钮已移除),title 里点出这些入口。
  const pathEl = $('#file-path');
  pathEl.value = cwd || '';
  pathEl.disabled = !cwd;
  pathEl.title = cwd ? `${cwd}\n可直接改路径后回车跳转;右键:收藏此目录 / 复制路径` : '';
  renderFileNav();
  if (cwd && fileParent(cwd) !== cwd) {
    const up = document.createElement('div');
    up.className = 'file-row';
    up.innerHTML = `<span>📁</span><span class="f-name">..</span>`;
    up.addEventListener('click', () => loadFileDir(fileParent(cwd)));
    box.appendChild(up);
  }
  for (const en of entries) {
    const row = document.createElement('div');
    row.className = 'file-row' + (state.file.selected === en.name ? ' selected' : '');
    row.innerHTML = `<span>${en.dir ? '📁' : '📄'}</span><span class="f-name"></span><span class="f-size"></span>`;
    row.querySelector('.f-name').textContent = en.name;
    row.querySelector('.f-size').textContent = en.dir ? '' : fmtSize(en.size);
    row.title = en.dir ? `${en.name}/` : `${en.name}  ${fmtSize(en.size)}`;
    row.addEventListener('click', () => {
      state.file.selected = en.name;
      renderFileList();
    });
    row.addEventListener('dblclick', () => { if (en.dir) loadFileDir((cwd === '/' ? '' : cwd) + '/' + en.name); });
    // 下载 / 重命名 / 权限 / 删除:此前是工具栏里的一排按钮,得先"选中"再点按钮,
    // 且按钮作用对象不明显。改为右键该行直接弹出,作用的文件名就写在菜单里。
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 别让窗口级处理器(终端菜单)再插一手
      state.file.selected = en.name;
      renderFileList();
      openFileCtxMenu(e.clientX, e.clientY, en);
    });
    box.appendChild(row);
  }
  if (!entries.length) box.innerHTML = '<div class="file-empty">目录为空</div>';
}

/* ---------------- 目录导航:后退 / 前进 / 上一级 ----------------
   浏览器式单数组历史:state.file.hist + histIdx 游标。成功列目录才入栈
   (失败的路径没"去过"),入栈时截断游标之后的"未来"(与浏览器一致);
   后退/前进只是移动游标。上限 50 条防内存无界增长。 */

/// 后退/前进/上一级按钮的可用态与悬停提示。提示里写明"会去哪",
/// 与资源管理器一致;上一级在根目录禁用。
function renderFileNav() {
  const f = state.file;
  const back = $('#btn-file-back');
  const fwd = $('#btn-file-forward');
  const up = $('#btn-file-up');
  if (!back || !fwd || !up) return;
  back.disabled = f.loading || f.histIdx <= 0;
  fwd.disabled = f.loading || f.histIdx < 0 || f.histIdx >= f.hist.length - 1;
  up.disabled = f.loading || !f.cwd || fileParent(f.cwd) === f.cwd;
  back.title = f.histIdx > 0 ? `后退到 ${f.hist[f.histIdx - 1]}` : '后退(没有更早的目录)';
  fwd.title = f.histIdx >= 0 && f.histIdx < f.hist.length - 1 ? `前进到 ${f.hist[f.histIdx + 1]}` : '前进(没有更晚的目录)';
  up.title = f.cwd ? `上一级:${fileParent(f.cwd)}` : '上一级';
}

/// 后退:只在历史数组里移动游标,不再入栈(record=false)。
export function fileNavBack() {
  const f = state.file;
  if (f.loading || f.histIdx <= 0) return;
  return loadFileDir(f.hist[f.histIdx - 1], { record: false, historyIndex: f.histIdx - 1 });
}

export function fileNavForward() {
  const f = state.file;
  if (f.loading || f.histIdx < 0 || f.histIdx >= f.hist.length - 1) return;
  return loadFileDir(f.hist[f.histIdx + 1], { record: false, historyIndex: f.histIdx + 1 });
}

/// 上一级:与列表里的「..」行同源(fileParent);已在根目录时无事发生。
export function fileNavUp() {
  const f = state.file;
  if (!f.cwd) return toast('请先打开一个远程目录', 'error');
  const up = fileParent(f.cwd);
  if (up === f.cwd) return;
  loadFileDir(up);
}

/// 文件/目录行的右键菜单。命令里的目标一律是"这一行",不再依赖全局选中态
/// (工具栏的按钮已移除,选中态不再有"先选再点"的用途)。
export function openFileCtxMenu(x, y, en) {
  const s = filePanelSession();
  const connected = !!s;
  const target = snapshotFileTarget();
  const full = state.file.cwd ? remoteEntryPath(state.file.cwd, en.name) : en.name;
  const guarded = (run) => () => {
    if (!isFileTargetCurrent(target)) return toast('目录已切换,请重新选择目标', 'error');
    return run();
  };
  showCtxMenu(x, y, [
    // 首项 = 打开:目录进面板;文件下载临时副本后交系统默认程序(见 openRemoteEntry)
    en.dir
      ? { label: '打开目录', disabled: !connected, run: guarded(() => loadFileDir(full, { sessionId: target.sessionId })) }
      : { label: '打开(临时副本)', disabled: !connected, run: guarded(() => openRemoteEntry(en)) },
    ...(en.dir ? [] : [{ label: '下载…', disabled: !connected, run: guarded(() => downloadEntry(en)) }]),
    { label: '重命名…', disabled: !connected, run: guarded(() => startRename(en)) },
    { label: '权限…', disabled: !connected, run: guarded(() => startChmod(en)) },
    '-',
    { label: '复制名称', run: () => { copyText(en.name).then((ok) => toast(ok ? '已复制名称' : '复制失败', ok ? 'success' : 'error')); } },
    { label: '复制完整路径', run: () => { copyText(full).then((ok) => toast(ok ? '已复制路径' : '复制失败', ok ? 'success' : 'error')); } },
    '-',
    { label: en.dir ? '删除目录' : '删除文件', danger: true, disabled: !connected, run: guarded(() => removeEntry(en)) },
  ]);
}

/* ---------------- 文件操作(工具栏与右键菜单共用) ---------------- */

/// 下载指定的文件项。菜单传入的是具体项,故不必再依赖"当前选中"。
export async function downloadEntry(en) {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  if (!en) en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先选择要下载的文件', 'error');
  if (en.dir) return toast('目录不支持直接下载,请进入目录后再选择文件', 'error');
  const target = snapshotFileTarget();
  const remotePath = remoteEntryPath(target.cwd, en.name);
  const localPath = await api('dialog:saveFile', { defaultName: en.name });
  if (!localPath) return;
  setFileStatus(target, `下载 ${en.name}…`);
  try {
    await api('sftp:download', { sessionId: target.sessionId, remotePath, localPath });
    setFileStatus(target, `已保存到 ${localPath}`);
    toast('下载完成', 'success');
  } catch (e) {
    setFileStatus(target, '下载失败：' + e.message);
    toast('下载失败：' + e.message, 'error');
  }
}

export async function fileDownload() {
  return downloadEntry(null);
}

/// 右键「打开」:把远端文件下载到本机临时目录后交给系统默认程序打开。
/// 临时副本落在独立的 NebulaShell-open/<时间戳>/ 子目录里 —— 同名文件反复
/// 打开互不覆盖,旧副本被本地程序占用(如 Excel 锁定)也不影响再次打开。
export async function openRemoteEntry(en) {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  if (!en) en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先选择要打开的文件', 'error');
  if (en.dir) return toast('目录请双击进入,不支持直接打开', 'error');
  const target = snapshotFileTarget();
  const full = remoteEntryPath(target.cwd, en.name);
  setFileStatus(target, `打开 ${en.name}:下载临时副本…`);
  try {
    const r = await api('sftp:openRemote', { sessionId: s.sessionId, remotePath: full });
    if (isFileTargetCurrent(target)) state.file.lastOpen = r || null;
    setFileStatus(target, `已用本地程序打开 ${en.name}`);
    toast(`已用本地程序打开 ${en.name}`, 'success');
  } catch (e) {
    setFileStatus(target, `打开失败：${e.message}`);
    toast('打开失败：' + e.message, 'error');
  }
}

/// 进入"重命名"态:复用新建文件夹那一行的输入框,由 renameMode 区分语义
export function startRename(en) {
  if (!en) return toast('请先选中文件或目录', 'error');
  const target = snapshotFileTarget();
  if (!target) return toast('请先连接并打开目录', 'error');
  state.file.renameMode = { from: en.name, ...target };
  $('#file-mkdir-row').classList.remove('hidden');
  $('#file-mkdir-name').placeholder = `重命名为(原名 ${en.name})`;
  $('#file-mkdir-name').value = en.name;
  $('#file-mkdir-name').focus();
  $('#file-mkdir-name').select();
}

/// Entry's shared mkdir/rename submit handler calls this only in rename mode.
/// The original target is immutable even if navigation happens while awaiting IPC.
export async function commitFileRename(name) {
  const target = state.file.renameMode;
  if (!target || !isFileTargetCurrent(target)) throw new Error('目录已切换,请重新选择重命名目标');
  if (!validEntryName(name)) throw new Error('名称不能为空、包含路径分隔符或为 . / ..');
  await api('sftp:rename', {
    sessionId: target.sessionId,
    from: remoteEntryPath(target.cwd, target.from),
    to: remoteEntryPath(target.cwd, name),
  });
  if (state.file.renameMode === target) {
    state.file.renameMode = null;
    $('#file-mkdir-row').classList.add('hidden');
    $('#file-mkdir-name').value = '';
  }
  await refreshFileTarget(target);
  return true;
}

export function validEntryName(name) {
  return typeof name === 'string' && !!name.trim() && name !== '.' && name !== '..'
    && !/[\/\\\0]/.test(name);
}

/// 进入"改权限"态
export function startChmod(en) {
  if (!en) return toast('请先选中文件或目录', 'error');
  const target = snapshotFileTarget();
  if (!target) return toast('请先连接并打开目录', 'error');
  state.file.chmodTarget = { ...en, ...target };
  $('#file-chmod-row').classList.remove('hidden');
  $('#file-chmod-octal').value = en.dir ? '0755' : '0644';
}

/// 删除指定的文件项(右键菜单入口;工具栏已不再有删除按钮)
export async function removeEntry(en) {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  if (!en) en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先选择要删除的项', 'error');
  const target = snapshotFileTarget();
  const path = remoteEntryPath(target.cwd, en.name);
  if (!(await askConfirm(`确定删除「${en.name}」吗？${en.dir ? '目录必须为空才能删除。' : ''}`, { title: en.dir ? '删除目录' : '删除文件', okText: '删除' }))) return;
  try {
    await api('sftp:remove', { sessionId: target.sessionId, path, isDir: en.dir });
    toast('已删除', 'success');
    await refreshFileTarget(target);
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

export async function fileDelete() {
  return removeEntry(null);
}

/* ---------------- 书签 ---------------- */

/// 渲染当前主机的目录书签。书签是"这台主机的这些目录",切换主机必须重渲染
/// —— 否则会拿 A 的路径去 B 上跳转。
export async function renderFileBookmarks() {
  const box = $('#file-bookmarks');
  if (!box) return;
  const s = filePanelSession();
  box.innerHTML = '';
  if (!s) return;
  let list = [];
  try { list = await api('bookmarks:list'); } catch { return; }
  if (filePanelSession()?.sessionId !== s.sessionId) return;
  const mine = (list || []).filter((b) => b.hostId === s.host.id);
  if (!mine.length) return;
  for (const b of mine) {
    const chip = document.createElement('span');
    chip.className = 'bm-chip';
    chip.textContent = '★ ' + b.path;
    chip.title = `跳转到 ${b.path}(右键移除书签)`;
    chip.addEventListener('click', () => loadFileDir(b.path));
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '移除此书签', danger: true, run: async () => {
          await api('bookmarks:remove', { hostId: s.host.id, path: b.path });
          renderFileBookmarks();
        } },
      ]);
    });
    box.appendChild(chip);
  }
}

/// 收藏当前主机目录。
export async function addBookmark() {
  const s = filePanelSession();
  if (!s || !state.file.cwd) return toast('请先连接并打开目录', 'error');
  await api('bookmarks:add', { hostId: s.host.id, path: state.file.cwd });
  await renderFileBookmarks();
  toast('已收藏当前目录', 'success');
}

/* ---------------- 拖拽上传 ---------------- */

/// 把一组本地绝对路径上传到当前目录(拖拽与文件选择共用)。
/// remoteDir 用面板当前目录:拖到面板 = 传到"我正在看的目录"。
let uploadQueue = Promise.resolve();

/// A DOM-created conflict sheet needs no shared HTML changes. Closing = cancel.
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
  // Snapshot before queuing or opening dialogs, never read cwd inside the loop.
  const snapshot = Object.freeze({ sessionId: target.sessionId, cwd: target.cwd });
  const task = uploadQueue.then(() => runUploadQueue(list, snapshot));
  uploadQueue = task.catch(() => {});
  return task;
}

async function runUploadQueue(paths, target) {
  const results = [];
  let allPolicy = null;
  let cancelled = false;
  for (const localPath of paths) {
    const name = localPath.split(/[\/\\]/).pop();
    if (cancelled) { results.push({ localPath, cancelled: true }); continue; }
    setFileStatus(target, `上传 ${name}…`);
    try {
      let conflictPolicy = allPolicy || 'error';
      let result = await api('sftp:upload', { sessionId: target.sessionId, localPath, remoteDir: target.cwd, conflictPolicy });
      if (result?.conflict) {
        const choice = await chooseUploadConflict(name, target);
        if (choice.policy === 'cancel') {
          cancelled = true;
          results.push({ localPath, cancelled: true });
          continue;
        }
        conflictPolicy = choice.policy;
        if (choice.applyToAll) allPolicy = conflictPolicy;
        result = await api('sftp:upload', { sessionId: target.sessionId, localPath, remoteDir: target.cwd, conflictPolicy });
      }
      // Older backends may still return conflict after a policy request; never call it success.
      if (result?.conflict) throw new Error('目标仍有同名文件,未上传');
      results.push({ localPath, ...result, ok: !result?.skipped });
      setFileStatus(target, result?.skipped ? `已跳过 ${name}` : `已上传 ${result?.remotePath || name}`);
    } catch (e) {
      results.push({ localPath, error: e.message, ok: false });
      setFileStatus(target, `上传失败(${name})：${e.message}`);
      toast(`上传失败(${name})：${e.message}`, 'error');
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.error).length;
  const cancelledCount = results.filter((r) => r.cancelled).length;
  const summary = `上传完成:${okCount} 成功 / ${skipped} 跳过 / ${failed} 失败 / ${cancelledCount} 取消`;
  await refreshFileTarget(target);
  setFileStatus(target, summary);
  toast(summary, failed ? 'error' : 'success');
  return results;
}

export async function fileUpload() {
  const target = snapshotFileTarget();
  if (!target) return toast('请先连接并打开目录', 'error');
  const paths = await api('dialog:pickAnyFile');
  if (!paths || !paths.length) return;
  return uploadLocalPaths(paths, target);
}

/// 文件面板的目标会话。
/// 面板是全局的(一个 DOM),但 SFTP 操作必须落在"面板显示的那台服务器"上。
/// 这里以 fileSessionId 为准,而不是 activeConnectedSession() ——
/// 否则切标签后会出现"看着 A 的目录、操作落到 B"的误删风险。
export function filePanelSession() {
  const s = state.file.sessionId ? state.sessions.get(state.file.sessionId) : null;
  return s && s.status === 'connected' && s.sessionId === state.activeId
    && !state.file.loading && state.file.cwd ? s : null;
}

export function remoteEntryPath(cwd, name) {
  return (cwd === '/' ? '' : cwd.replace(/\/+$/, '')) + '/' + name;
}

export function snapshotFileTarget() {
  const s = filePanelSession();
  return s ? Object.freeze({ sessionId: s.sessionId, cwd: state.file.cwd }) : null;
}

export function isFileTargetCurrent(target) {
  return !!target && filePanelSession()?.sessionId === target.sessionId && state.file.cwd === target.cwd;
}

function setFileStatus(target, text) {
  if (isFileTargetCurrent(target)) $('#file-status').textContent = text;
}

async function refreshFileTarget(target) {
  if (isFileTargetCurrent(target)) await loadFileDir(target.cwd, { sessionId: target.sessionId });
}

let fileLoadGeneration = 0;

/// Call synchronously when following a new session, BEFORE awaiting initialFileDir.
/// No new session identifier is ever paired with the previous session's cwd.
export function beginFilePanelSession(s) {
  fileLoadGeneration += 1;
  Object.assign(state.file, {
    sessionId: null, cwd: null, entries: [], selected: null, renameMode: null,
    chmodTarget: null, hist: [], histIdx: -1, histSid: null,
    pendingSessionId: s?.sessionId || null, loading: !!s,
  });
  for (const id of ['#file-mkdir-row', '#file-chmod-row']) $(id)?.classList.add('hidden');
  $('#file-bookmarks')?.replaceChildren();
  renderFileList();
  $('#file-list').innerHTML = `<div class="file-empty">${s ? '加载中…' : '请先连接主机'}</div>`;
  $('#file-status').textContent = s ? '加载中…' : '';
  renderFileTarget();
  return fileLoadGeneration;
}

/// 渲染面板的服务器标识(标题下方),让用户明确当前操作对象
export function renderFileTarget() {
  const el = $('#file-target');
  if (!el) return;
  const pending = state.file.pendingSessionId ? state.sessions.get(state.file.pendingSessionId) : null;
  const s = filePanelSession();
  if (state.file.loading && pending && pending.sessionId === state.activeId) {
    el.textContent = `${pending.host.username}@${pending.host.host}:${pending.host.port} · 加载中(操作禁用)`;
    el.classList.remove('warn');
    return;
  }
  if (!s) {
    const active = state.sessions.get(state.activeId);
    el.textContent = active && active.status === 'connected' ? '未选择目录(点刷新加载)' : '未连接';
    el.classList.toggle('warn', !active || active.status !== 'connected');
    return;
  }
  el.textContent = `${s.host.username}@${s.host.host}:${s.host.port}`;
  el.classList.remove('warn');
  el.title = `当前文件操作目标：${s.host.name}（${s.host.username}@${s.host.host}:${s.host.port}）`;
}

export async function loadFileDir(dir, opts = {}) {
  const s = activeConnectedSession();
  // Async cwd probes must pass their originating session, never fall onto a new tab.
  if (opts.sessionId && opts.sessionId !== s?.sessionId) return false;
  if (!s) { beginFilePanelSession(null); return false; }
  if (state.file.sessionId !== s.sessionId) beginFilePanelSession(s);
  const generation = ++fileLoadGeneration;
  state.file.loading = true;
  state.file.pendingSessionId = s.sessionId;
  $('#file-path').disabled = true;
  renderFileTarget();
  renderFileNav();
  $('#file-status').textContent = '加载中…';
  const isCurrent = () => generation === fileLoadGeneration && state.activeId === s.sessionId && s.status === 'connected';
  try {
    const r = await api('sftp:list', { sessionId: s.sessionId, path: dir });
    if (!isCurrent()) return false;
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/') || !Array.isArray(r.entries)) throw new Error('目录响应无效');
    // Commit identity, cwd, entries and history in one synchronous transaction.
    if (state.file.histSid !== s.sessionId) {
      state.file.hist = [];
      state.file.histIdx = -1;
      state.file.histSid = s.sessionId;
    }
    Object.assign(state.file, {
      sessionId: s.sessionId, cwd: r.path, entries: r.entries, selected: null,
      loading: false, pendingSessionId: null, renameMode: null, chmodTarget: null,
    });
    for (const id of ['#file-mkdir-row', '#file-chmod-row']) $(id)?.classList.add('hidden');
    s.lastFileDir = r.path;
    if (opts.record === false && Number.isInteger(opts.historyIndex)) {
      state.file.histIdx = opts.historyIndex;
    } else if (opts.record !== false && state.file.hist[state.file.histIdx] !== r.path) {
      state.file.hist = state.file.hist.slice(0, state.file.histIdx + 1);
      state.file.hist.push(r.path);
      if (state.file.hist.length > 50) state.file.hist = state.file.hist.slice(-50);
      state.file.histIdx = state.file.hist.length - 1;
    }
    renderFileList();
    renderFileTarget();
    renderFileBookmarks().catch(() => {});
    $('#file-status').textContent = '';
    return true;
  } catch (e) {
    if (!isCurrent()) return false;
    state.file.loading = false;
    state.file.pendingSessionId = null;
    // Same-session failure keeps the previous committed cwd/history. New-session
    // failure has no committed target and cannot enable destructive operations.
    renderFileList();
    if (!state.file.cwd) $('#file-list').innerHTML = '<div class="file-empty">目录加载失败,请刷新重试</div>';
    renderFileTarget();
    $('#file-status').textContent = '加载失败：' + e.message;
    return false;
  }
}

/// 面板目标会话的初始目录:「首次打开默认为当前主机命令执行路径」。
/// 优先探测交互 shell 的实时 cwd(ssh:probeCwd —— exec 与 shell 通道同为
/// sshd 会话进程的子进程,可经 tty/ppid 关联);探测失败退回 OSC7 记录
/// (部分 shell 每次提示符前上报);都拿不到返回 null,由 sftp:list 回落
/// 家目录。探测只是一次 exec 往返,任何失败都不阻断面板打开。
export async function initialFileDir(s) {
  try {
    const r = await api('ssh:probeCwd', { sessionId: s.sessionId });
    if (r && r.cwd) return r.cwd;
  } catch { /* 探测失败不阻断打开 */ }
  return s.remoteCwd || null;
}

/* ---------------- 终端搜索 ---------------- */

