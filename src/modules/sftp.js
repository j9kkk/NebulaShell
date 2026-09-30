// SFTP 文件面板:列目录、上传下载、权限、书签
import { $, api, askConfirm, copyText, showCtxMenu, state, toast } from './core.js';

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
  back.disabled = f.histIdx <= 0;
  fwd.disabled = f.histIdx < 0 || f.histIdx >= f.hist.length - 1;
  up.disabled = !f.cwd || fileParent(f.cwd) === f.cwd;
  back.title = f.histIdx > 0 ? `后退到 ${f.hist[f.histIdx - 1]}` : '后退(没有更早的目录)';
  fwd.title = f.histIdx >= 0 && f.histIdx < f.hist.length - 1 ? `前进到 ${f.hist[f.histIdx + 1]}` : '前进(没有更晚的目录)';
  up.title = f.cwd ? `上一级:${fileParent(f.cwd)}` : '上一级';
}

/// 后退:只在历史数组里移动游标,不再入栈(record=false)。
export function fileNavBack() {
  const f = state.file;
  if (f.histIdx <= 0) return;
  f.histIdx -= 1;
  loadFileDir(f.hist[f.histIdx], { record: false });
}

export function fileNavForward() {
  const f = state.file;
  if (f.histIdx < 0 || f.histIdx >= f.hist.length - 1) return;
  f.histIdx += 1;
  loadFileDir(f.hist[f.histIdx], { record: false });
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
  const full = (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name;
  showCtxMenu(x, y, [
    // 首项 = 打开:目录进面板;文件下载临时副本后交系统默认程序(见 openRemoteEntry)
    en.dir
      ? { label: '打开目录', disabled: !connected, run: () => loadFileDir(full) }
      : { label: '打开(临时副本)', disabled: !connected, run: () => openRemoteEntry(en) },
    ...(en.dir ? [] : [{ label: '下载…', disabled: !connected, run: () => downloadEntry(en) }]),
    { label: '重命名…', disabled: !connected, run: () => startRename(en) },
    { label: '权限…', disabled: !connected, run: () => startChmod(en) },
    '-',
    { label: '复制名称', run: () => { copyText(en.name).then((ok) => toast(ok ? '已复制名称' : '复制失败', ok ? 'success' : 'error')); } },
    { label: '复制完整路径', run: () => { copyText(full).then((ok) => toast(ok ? '已复制路径' : '复制失败', ok ? 'success' : 'error')); } },
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

/// 右键「打开」:把远端文件下载到本机临时目录后交给系统默认程序打开。
/// 临时副本落在独立的 NebulaShell-open/<时间戳>/ 子目录里 —— 同名文件反复
/// 打开互不覆盖,旧副本被本地程序占用(如 Excel 锁定)也不影响再次打开。
export async function openRemoteEntry(en) {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  if (!en) en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先选择要打开的文件', 'error');
  if (en.dir) return toast('目录请双击进入,不支持直接打开', 'error');
  const full = (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name;
  $('#file-status').textContent = `打开 ${en.name}:下载临时副本…`;
  try {
    const r = await api('sftp:openRemote', { sessionId: s.sessionId, remotePath: full });
    state.file.lastOpen = r || null; // e2e 断言用:临时副本的实际落盘路径
    if (state.file.sessionId === s.sessionId) $('#file-status').textContent = `已用本地程序打开 ${en.name}`;
    toast(`已用本地程序打开 ${en.name}`, 'success');
  } catch (e) {
    $('#file-status').textContent = `打开失败：${e.message}`;
    toast('打开失败：' + e.message, 'error');
  }
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

export async function loadFileDir(dir, opts = {}) {
  const s = activeConnectedSession();
  if (!s) {
    state.file.sessionId = null;
    state.file.cwd = null;
    state.file.entries = [];
    $('#file-list').innerHTML = '<div class="file-empty">请先连接主机</div>';
    const pathEl = $('#file-path');
    pathEl.value = '';
    pathEl.disabled = true;
    renderFileTarget();
    renderFileNav();
    return;
  }
  // 记录本次列表属于哪个会话:操作时以此为准,避免切标签后张冠李戴
  state.file.sessionId = s.sessionId;
  // 换了目标会话:导航历史整体作废 —— 历史里是另一台机器的路径,
  // 后退过去只会张冠李戴。
  if (state.file.histSid !== s.sessionId) {
    state.file.histSid = s.sessionId;
    state.file.hist = [];
    state.file.histIdx = -1;
  }
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
    // 导航历史:只记成功列出的目录;record=false 表示本次是后退/前进在移动
    // 游标,不能截断"未来"。刷新/重复进入同一目录不产生新条目。
    if (opts.record !== false && state.file.hist[state.file.histIdx] !== r.path) {
      state.file.hist = state.file.hist.slice(0, state.file.histIdx + 1);
      state.file.hist.push(r.path);
      if (state.file.hist.length > 50) state.file.hist = state.file.hist.slice(-50);
      state.file.histIdx = state.file.hist.length - 1;
    }
    renderFileList();
    renderFileTarget();
    // 书签按主机过滤渲染:换主机后必须重画,否则会拿 A 的路径跳到 B
    renderFileBookmarks().catch(() => {});
    $('#file-status').textContent = '';
  } catch (e) {
    if (state.file.sessionId !== s.sessionId) return;
    $('#file-status').textContent = '加载失败：' + e.message;
    // 失败不入历史(游标没动),但按钮态要回到与当前目录一致
    renderFileNav();
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

