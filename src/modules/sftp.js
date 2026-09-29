// SFTP 文件面板:列目录、上传下载、权限、书签
import { $, api, askConfirm, state, toast } from './core.js';

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
    row.addEventListener('click', () => {
      state.file.selected = en.name;
      renderFileList();
    });
    row.addEventListener('dblclick', () => { if (en.dir) loadFileDir((cwd === '/' ? '' : cwd) + '/' + en.name); });
    box.appendChild(row);
  }
  if (!entries.length) box.innerHTML = '<div class="file-empty">目录为空</div>';
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
    $('#file-status').textContent = '';
  } catch (e) {
    if (state.file.sessionId !== s.sessionId) return;
    $('#file-status').textContent = '加载失败：' + e.message;
  }
}

export async function fileUpload() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const paths = await api('dialog:pickAnyFile');
  if (!paths || !paths.length) return;
  for (const p of paths) {
    const name = p.split('/').pop();
    $('#file-status').textContent = `上传 ${name}…`;
    try {
      await api('sftp:upload', { sessionId: s.sessionId, localPath: p, remoteDir: state.file.cwd });
      $('#file-status').textContent = `已上传 ${name}`;
    } catch (e) {
      $('#file-status').textContent = '上传失败：' + e.message;
      toast('上传失败：' + e.message, 'error');
    }
  }
  loadFileDir(state.file.cwd);
}

export async function fileDownload() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先在列表中选中文件', 'error');
  if (en.dir) return toast('目录不支持下载，请选择文件', 'error');
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

export async function fileDelete() {
  const s = filePanelSession();
  if (!s) return toast('请先连接主机', 'error');
  const en = state.file.entries.find((x) => x.name === state.file.selected);
  if (!en) return toast('请先在列表中选中要删除的项', 'error');
  if (!(await askConfirm(`确定删除「${en.name}」吗？`, { title: '删除文件', okText: '删除' }))) return;
  try {
    await api('sftp:remove', { sessionId: s.sessionId, path: (state.file.cwd === '/' ? '' : state.file.cwd) + '/' + en.name, isDir: en.dir });
    loadFileDir(state.file.cwd);
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

/* ---------------- 终端搜索 ---------------- */

