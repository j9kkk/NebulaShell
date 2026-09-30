// SFTP 文件面板:列目录、上传下载、权限、书签
import { $, api, askConfirm, showCtxMenu, state, toast } from './core.js';

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
  $('#file-path').textContent = cwd || '';
  // 路径栏右键可收藏当前目录(原工具栏的「书签」按钮已移除);title 里点出这个入口
  $('#file-path').title = cwd ? `${cwd}\n右键:收藏此目录 / 复制路径` : '';
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

/// 文件/目录行的右键菜单。命令里的目标一律是"这一行",不再依赖全局选中态
/// (工具栏的按钮已移除,选中态不再有"先选再点"的用途)。
export function openFileCtxMenu(x, y, en) {
  const s = filePanelSession();
  const connected = !!s;
  const full = (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name;
  showCtxMenu(x, y, [
    en.dir
      ? { label: '打开目录', disabled: !connected, run: () => loadFileDir(full) }
      : { label: '下载…', disabled: !connected, run: () => downloadEntry(en) },
    { label: '重命名…', disabled: !connected, run: () => startRename(en) },
    { label: '权限…', disabled: !connected, run: () => startChmod(en) },
    '-',
    { label: '复制名称', run: () => { navigator.clipboard.writeText(en.name).catch(() => {}); toast('已复制名称', 'success'); } },
    { label: '复制完整路径', run: () => { navigator.clipboard.writeText(full).catch(() => {}); toast('已复制路径', 'success'); } },
    '-',
    { label: en.dir ? '删除目录' : '删除文件', danger: true, disabled: !connected, run: () => removeEntry(en) },
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
  const localPath = await api('dialog:saveFile', { defaultName: en.name });
  if (!localPath) return;
  $('#file-status').textContent = `下载 ${en.name}…`;
  try {
    await api('sftp:download', { sessionId: s.sessionId, remotePath: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name, localPath });
    $('#file-status').textContent = `已保存到 ${localPath}`;
    toast('下载完成', 'success');
  } catch (e) {
    $('#file-status').textContent = '下载失败：' + e.message;
    toast('下载失败：' + e.message, 'error');
  }
}

export async function fileDownload() {
  return downloadEntry(null);
}

/// 进入"重命名"态:复用新建文件夹那一行的输入框,由 renameMode 区分语义
export function startRename(en) {
  if (!en) return toast('请先选中文件或目录', 'error');
  state.file.renameMode = { from: en.name };
  $('#file-mkdir-row').classList.remove('hidden');
  $('#file-mkdir-name').placeholder = `重命名为(原名 ${en.name})`;
  $('#file-mkdir-name').value = en.name;
  $('#file-mkdir-name').focus();
  $('#file-mkdir-name').select();
}

/// 进入"改权限"态
export function startChmod(en) {
  if (!en) return toast('请先选中文件或目录', 'error');
  state.file.chmodTarget = en;
  $('#file-chmod-row').classList.remove('hidden');
  $('#file-chmod-octal').value = en.dir ? '0755' : '0644';
}

/// 删除指定的文件项(右键菜单入口;工具栏已不再有删除按钮)
export async function removeEntry(en) {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  if (!en) en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先选择要删除的项', 'error');
  if (!(await askConfirm(`确定删除「${en.name}」吗？${en.dir ? '目录必须为空才能删除。' : ''}`, { title: en.dir ? '删除目录' : '删除文件', okText: '删除' }))) return;
  try {
    await api('sftp:remove', { sessionId: s.sessionId, path: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name, isDir: en.dir });
    toast('已删除', 'success');
    loadFileDir(state.file.cwd);
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

/// 收藏当前目录(工具栏的 ★ 已移除,改由路径栏右键触发)
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
export async function uploadLocalPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  if (!state.file.cwd) return toast('请先打开一个远程目录', 'error');
  let okCount = 0;
  for (const p of list) {
    const name = p.split('/').pop();
    $('#file-status').textContent = `上传 ${name}…`;
    try {
      await api('sftp:upload', { sessionId: s.sessionId, localPath: p, remoteDir: state.file.cwd });
      okCount += 1;
      $('#file-status').textContent = `已上传 ${name}`;
    } catch (e) {
      $('#file-status').textContent = `上传失败(${name})：${e.message}`;
      toast(`上传失败(${name})：${e.message}`, 'error');
    }
  }
  if (okCount) toast(`已上传 ${okCount} 个文件`, 'success');
  loadFileDir(state.file.cwd);
}

export async function fileUpload() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const paths = await api('dialog:pickAnyFile');
  if (!paths || !paths.length) return;
  await uploadLocalPaths(paths);
}

/// 文件面板的目标会话。
/// 面板是全局的(一个 DOM),但 SFTP 操作必须落在"面板显示的那台服务器"上。
/// 这里以 fileSessionId 为准,而不是 activeConnectedSession() ——
/// 否则切标签后会出现"看着 A 的目录、操作落到 B"的误删风险。
export function filePanelSession() {
  const s = state.file.sessionId ? state.sessions.get(state.file.sessionId) : null;
  return s && s.status === 'connected' ? s : null;
}

/// 渲染面板的服务器标识(标题下方),让用户明确当前操作对象
export function renderFileTarget() {
  const el = $('#file-target');
  if (!el) return;
  const s = filePanelSession();
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

export async function loadFileDir(dir) {
  const s = activeConnectedSession();
  if (!s) {
    state.file.sessionId = null;
    state.file.cwd = null;
    state.file.entries = [];
    $('#file-list').innerHTML = '<div class="file-empty">请先连接主机</div>';
    renderFileTarget();
    return;
  }
  // 记录本次列表属于哪个会话:操作时以此为准,避免切标签后张冠李戴
  state.file.sessionId = s.sessionId;
  renderFileTarget();
  $('#file-status').textContent = '加载中…';
  try {
    const r = await api('sftp:list', { sessionId: s.sessionId, path: dir });
    // 期间用户可能已切换会话:丢弃过期响应,避免把旧服务器的目录画到新目标上
    if (state.file.sessionId !== s.sessionId) return;
    state.file.cwd = r.path;
    state.file.entries = r.entries;
    state.file.selected = null;
    s.lastFileDir = r.path; // 记住各会话的最后目录,切回时恢复到原处
    renderFileList();
    renderFileTarget();
    // 书签按主机过滤渲染:换主机后必须重画,否则会拿 A 的路径跳到 B
    renderFileBookmarks().catch(() => {});
    $('#file-status').textContent = '';
  } catch (e) {
    if (state.file.sessionId !== s.sessionId) return;
    $('#file-status').textContent = '加载失败：' + e.message;
  }
}

/* ---------------- 终端搜索 ---------------- */

