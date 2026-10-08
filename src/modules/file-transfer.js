// 传输任务中心 + 跨主机复制 + 内部拖拽 + 冲突决策。
//
// - 前端任务存储只做展示与操作入口;字节/阶段/计数以 transfer:event 为准,
//   终态不被迟到事件改写(按 stage 单向推进)。
// - 冲突:后端挂起等待决策,事件带 taskId/conflictId;共用冲突框按
//   文件/目录/类型错位给出各自决策集,「应用到同类」只作用于本任务同类冲突。
// - 内部拖拽用受信令牌(pointer + 应用内状态),不信网页拖放数据;
//   源/目标在拖动开始与放下时分别快照,提交后由后端再校验代次。
// - 上传/下载以 taskId 注册进任务中心:进度按任务归属,可取消在途传输。

import { $, api, askConfirm, hasOpenModal, state, toast } from './core.js';
import { icon } from '../shared/icons.js';
import { escapeHtml } from './hosts.js';
import { findFilePane, filePaneFromEl, paneSession, refreshFilePanesFor } from './sftp.js';
import { popupPosition } from './interaction.js';

const STAGE_TEXT = {
  queued: '排队中',
  transferring: '传输中',
  waiting: '待处理冲突',
  cancelling: '正在取消',
  done: '已完成',
  'done-partial': '完成(有跳过)',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/// 终态/运行态用图标直观区分;title 仍保留文字说明。
const STAGE_ICON = {
  queued: { glyph: 'dots', cls: 'muted' },
  transferring: { glyph: 'transfer', cls: 'run' },
  waiting: { glyph: 'question', cls: 'warn' },
  cancelling: { glyph: 'transfer', cls: 'run' },
  done: { glyph: 'checkCircle', cls: 'ok' },
  'done-partial': { glyph: 'alert', cls: 'warn' },
  partial: { glyph: 'alert', cls: 'warn' },
  failed: { glyph: 'xCircle', cls: 'bad' },
  cancelled: { glyph: 'x', cls: 'muted' },
  interrupted: { glyph: 'zap', cls: 'bad' },
};

const TERMINAL_STAGES = ['done', 'done-partial', 'partial', 'failed', 'cancelled', 'interrupted'];

const tasks = [];
const pendingConflicts = [];
let conflictOpen = false;
let lastDragEnd = 0;
let dragActive = false;

function fmtBytes(n) {
  if (!n || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function sessionLabel(sessionId) {
  const s = state.sessions.get(sessionId);
  return s ? `${s.host.name}(${s.host.username}@${s.host.host}:${s.host.port})` : sessionId;
}

function addTask(t) {
  // 去重:submit_copy 在返回 taskId 前就会 emit 首个任务事件,
  // 事件先建条、invoke 返回后再 addTask —— 同 taskId 必须合并,不能双条
  const idx = tasks.findIndex((x) => x.taskId === t.taskId);
  if (idx >= 0) {
    tasks[idx] = { ...tasks[idx], ...t };
  } else {
    tasks.unshift(t);
  }
  if (tasks.length > 100) tasks.length = 100;
  renderTaskCenter();
  return t;
}

function findTask(taskId) {
  return tasks.find((t) => t.taskId === taskId) || null;
}

function isTerminal(t) {
  return TERMINAL_STAGES.includes(t.stage);
}

function activeCount() {
  return tasks.filter((t) => !isTerminal(t) || t.stage === 'waiting').length;
}

/* ---------------- 复制任务提交 ---------------- */

/// 统一提交入口:抓取两端连接代次(拖放/菜单时看到的那条连接),
/// 后端再校验一次 —— 重连/换绑后的静默改投被两层拦截。
export async function submitCopyTask({ srcSessionId, srcDir, srcPaneId, dstSessionId, dstDir, dstPaneId, items, autoRename }) {
  if (!items || !items.length) return toast('没有可复制的条目', 'error');
  const [srcEp, dstEp] = await Promise.all([
    api('session:endpoint', { sessionId: srcSessionId }),
    api('session:endpoint', { sessionId: dstSessionId }),
  ]);
  if (!srcEp) return toast('源连接不可用', 'error');
  if (!dstEp) return toast('目标连接不可用', 'error');
  const batchId = 'b-' + crypto.randomUUID().slice(0, 8);
  let r;
  try {
    r = await api('transfer:copy', {
      srcSessionId, srcDir, srcEpoch: srcEp.epoch,
      dstSessionId, dstDir, dstEpoch: dstEp.epoch,
      items: items.map((it) => it.name),
      autoRename: !!autoRename,
      batchId,
    });
  } catch (e) {
    return toast('复制失败:' + e.message, 'error');
  }
  addTask({
    taskId: r.taskId,
    batchId,
    kind: 'copy',
    stage: 'queued',
    label: `${srcEp.label} → ${dstEp.label}`,
    srcLabel: srcEp.label,
    dstLabel: dstEp.label,
    srcDir, dstDir,
    items: items.map((it) => ({ name: it.name, isDir: !!it.isDir, state: 'pending' })),
    files: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    dirs: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    bytes: 0, total: 0, current: '', error: '', truncated: false,
    conflict: null,
    retry: { srcSessionId, srcDir, srcPaneId, dstSessionId, dstDir, dstPaneId, items },
    createdAt: Date.now(),
  });
  toast('已创建复制任务:' + items.map((i) => i.name).join('、'), 'success');
  return r;
}

/* ---------------- 上传/下载任务句柄 ---------------- */

export function registerUploadTask({ paneId, sessionId, dstDir, names }) {
  const taskId = 'up-' + crypto.randomUUID();
  const t = addTask({
    taskId,
    kind: 'upload',
    stage: 'transferring',
    label: `上传 → ${sessionLabel(sessionId)}`,
    dstSessionId: sessionId,
    dstDir,
    paneId,
    items: names.map((n) => ({ name: n, isDir: false, state: 'pending' })),
    files: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    dirs: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    bytes: 0, total: 0, current: '', error: '', truncated: false,
    conflict: null, pct: -1,
    userCancelled: false,
    createdAt: Date.now(),
  });
  return {
    taskId,
    isCancelled: () => t.userCancelled,
    cancelRest: () => { t.userCancelled = true; },
    mark(name, st, err) {
      const item = t.items.find((i) => i.name === name && i.state === 'active' || i.name === name && i.state === 'pending') || t.items.find((i) => i.name === name);
      if (item) item.state = st;
      if (st === 'active') t.current = name;
      if (st === 'failed') t.error = err || t.error;
      renderTaskCenter();
    },
    finish(stage) { t.stage = stage; renderTaskCenter(); },
  };
}

/// 批量/目录下载任务:items 状态由 finish 汇总落定
export function registerTreeDownloadTask({ paneId, sessionId, names, localRoot }) {
  const taskId = 'dt-' + crypto.randomUUID();
  const t = addTask({
    taskId,
    kind: 'download',
    stage: 'transferring',
    label: `下载 ${names.length} 项 ← ${sessionLabel(sessionId)}`,
    srcSessionId: sessionId,
    paneId,
    items: names.map((n) => ({ name: n, isDir: true, state: 'active' })),
    files: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    dirs: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    bytes: 0, total: 0, current: names[0] || '', error: '', truncated: false,
    conflict: null, pct: -1,
    createdAt: Date.now(),
  });
  t.localRoot = localRoot;
  return {
    taskId,
    isCancelled: () => t.userCancelled,
    finish(stage, { done = 0, skipped = 0, failed = 0 } = {}) {
      t.stage = stage;
      t.files.done = done;
      t.files.skipped = skipped;
      t.files.failed = failed;
      for (const it of t.items) it.state = 'done';
      renderTaskCenter();
    },
    failed(msg) { t.stage = 'failed'; t.error = msg; t.files.failed += 1; renderTaskCenter(); },
    cancelled() { t.stage = 'cancelled'; t.files.cancelled += 1; renderTaskCenter(); },
  };
}

export function registerDownloadTask({ paneId, sessionId, name, remotePath, localPath }) {
  const taskId = 'dl-' + crypto.randomUUID();
  const t = addTask({
    taskId,
    kind: 'download',
    stage: 'transferring',
    label: `下载 ${name} ← ${sessionLabel(sessionId)}`,
    srcSessionId: sessionId,
    paneId,
    items: [{ name, isDir: false, state: 'active' }],
    files: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    dirs: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    bytes: 0, total: 0, current: name, error: '', truncated: false,
    conflict: null, pct: -1,
    createdAt: Date.now(),
  });
  return {
    taskId,
    done() { t.stage = 'done'; t.files.done += 1; t.items[0].state = 'done'; renderTaskCenter(); },
    failed(msg) { t.stage = 'failed'; t.error = msg; t.files.failed += 1; t.items[0].state = 'failed'; renderTaskCenter(); },
    cancelled() { t.stage = 'cancelled'; t.files.cancelled += 1; t.items[0].state = 'cancelled'; renderTaskCenter(); },
  };
}

/// sftp:progress 事件按 taskId 归属到任务;找到返回 true。
export function taskProgressFromEvent(evt) {
  const t = evt.taskId ? findTask(evt.taskId) : null;
  if (!t) return false;
  if (t.stage !== 'transferring' && t.stage !== 'waiting') return true; // 迟到进度不影响终态
  if (typeof evt.pct === 'number') t.pct = evt.pct;
  if (evt.name) t.current = evt.name;
  renderTaskCenter();
  return true;
}

/* ---------------- 事件接入 ---------------- */

function onTransferEvent(payload) {
  if (payload?.kind === 'conflict') return onConflictEvent(payload);
  if (payload?.kind !== 'task' || !payload.task) return;
  const v = payload.task;
  const t = findTask(v.taskId);
  if (!t) {
    // 应用重启后收到的任务事件:补记一条(不恢复控制,仅可见)
    addTask({
      taskId: v.taskId, batchId: v.batchId, kind: 'copy', stage: v.stage,
      label: `${v.src?.label || '?'} → ${v.dst?.label || '?'}`,
      srcLabel: v.src?.label, dstLabel: v.dst?.label,
      srcDir: v.srcDir, dstDir: v.dstDir,
      items: (v.items || []).map((n) => ({ name: n, isDir: false, state: 'pending' })),
      files: v.files || { done: 0, skipped: 0, failed: 0, cancelled: 0 },
      dirs: v.dirs || { done: 0, skipped: 0, failed: 0, cancelled: 0 },
      bytes: v.bytes || 0, total: v.total || 0,
      current: v.current || '', error: v.error || '', truncated: !!v.truncated,
      conflict: null, createdAt: Date.now(),
    });
    return;
  }
  // 终态单向推进:迟到事件不能把终态改回传输中
  if (!isTerminal(t)) {
    t.stage = v.stage;
    t.bytes = v.bytes ?? t.bytes;
    t.total = v.total ?? t.total;
    t.current = v.current ?? t.current;
    t.truncated = !!v.truncated;
    if (v.files) t.files = v.files;
    if (v.dirs) t.dirs = v.dirs;
    t.error = v.error || '';
    // 复制任务进入终态:刷新仍在浏览目标目录的文件分屏(发布结果立即可见)
    if (isTerminal(t) && t.kind === 'copy') {
      refreshFilePanesFor(t.retry?.dstSessionId, t.dstDir);
    }
  }
  renderTaskCenter();
  if (t.stage === 'waiting' && !t.conflict) {
    // 冲突事件先到、task 事件后到的时序:等 conflict 事件补挂
  }
}

function onConflictEvent(evt) {
  const t = findTask(evt.taskId);
  if (!t) return;
  const conflict = { ...evt };
  t.conflict = conflict;
  t.stage = 'waiting';
  pendingConflicts.push({ task: t, conflict });
  renderTaskCenter();
  showNextConflict();
}

/// 冲突框:空闲即弹(与上传冲突一致的即时处理体验);已有 modal 时挂起,
/// 避免后台任务打断正在进行的操作 —— 挂起项在任务中心可手动打开。
function showNextConflict() {
  if (conflictOpen || hasOpenModal()) return;
  const next = pendingConflicts[0];
  if (!next) return;
  openConflictDialog(next.task, next.conflict);
}

function openConflictDialog(task, conflict) {
  conflictOpen = true;
  const kindScope = conflict.kindScope || (conflict.srcKind === 'dir' ? 'dirs' : 'files');
  const mismatch = conflict.srcKind !== conflict.dstKind;
  const sheet = document.createElement('dialog');
  sheet.className = 'upload-conflict';
  sheet.innerHTML = '<h3>复制冲突</h3><p></p><label><input type="checkbox" checked> 对此任务的后续同类冲突使用相同策略</label><div class="modal-foot"></div>';
  sheet.querySelector('p').textContent =
    `目标 ${conflict.dstLabel || task.dstLabel} 的 ${task.dstDir} 中已存在「${conflict.name}」` +
    (mismatch ? `(类型不一致:源${conflict.srcKind === 'dir' ? '目录' : '文件'}/目标${conflict.dstKind === 'dir' ? '目录' : '文件'})` : '') +
    '。';
  let settled = false;
  const finish = (policy) => {
    if (settled) return;
    settled = true;
    const applyToAll = sheet.querySelector('input').checked;
    sheet.close();
    sheet.remove();
    conflictOpen = false;
    task.conflict = null;
    const idx = pendingConflicts.findIndex((c) => c.conflict.conflictId === conflict.conflictId);
    if (idx >= 0) pendingConflicts.splice(idx, 1);
    api('transfer:resolve', { taskId: task.taskId, conflictId: conflict.conflictId, decision: { policy, applyToAll } })
      .catch((e) => toast('冲突决策失败:' + e.message, 'error'));
    renderTaskCenter();
    setTimeout(showNextConflict, 0);
  };
  const buttons = mismatch
    ? [['skip', '跳过(默认)'], ['rename', '重命名'], ['cancelRest', '取消剩余']]
    : kindScope === 'dirs'
      ? [['merge', '合并'], ['skip', '跳过整个目录'], ['rename', '整体重命名'], ['cancelRest', '取消剩余']]
      : [['skip', '跳过(默认)'], ['overwrite', '覆盖'], ['rename', '自动重命名'], ['cancelRest', '取消剩余队列']];
  for (const [policy, label] of buttons) {
    const button = document.createElement('button');
    button.className = 'btn' + (policy === 'overwrite' ? ' danger' : '');
    button.textContent = label;
    button.addEventListener('click', () => finish(policy));
    sheet.querySelector('.modal-foot').appendChild(button);
  }
  sheet.addEventListener('cancel', (e) => { e.preventDefault(); finish('cancelRest'); });
  sheet.addEventListener('close', () => finish('cancelRest'));
  document.body.appendChild(sheet);
  sheet.showModal();
  sheet.querySelector('button').focus();
}

/* ---------------- 任务中心 UI ---------------- */

let taskPopoverOpen = false;

/// 浮层挂 body + fixed 定位:以状态栏 ⇅ 为锚,空间不足时 popupPosition 自动翻到上方。
function positionTaskPopover() {
  const pop = $('#file-task-popover');
  const sbBtn = $('#btn-file-tasks-status');
  if (!pop || !sbBtn || pop.classList.contains('hidden')) return;
  const anchor = sbBtn.getBoundingClientRect();
  const size = { width: pop.offsetWidth, height: pop.offsetHeight };
  const position = popupPosition(anchor, size, { width: window.innerWidth, height: window.innerHeight });
  pop.style.left = `${position.left}px`;
  pop.style.top = `${position.top}px`;
}

function renderTaskCenter() {
  const badge = $('#file-task-badge');
  const sbBtn = $('#btn-file-tasks-status');
  const active = activeCount();
  const failed = tasks.filter((t) => ['failed', 'partial', 'interrupted'].includes(t.stage)).length;
  const total = active + failed;
  // 状态栏 ⇅ 是任务中心唯一入口:无任务隐藏,有任务显示计数,有失败加提醒色
  if (sbBtn) {
    sbBtn.classList.toggle('hidden', !tasks.length);
    sbBtn.classList.toggle('attention', !!failed);
    sbBtn.title = failed ? `传输任务:${active} 进行中,${failed} 需要注意` : `传输任务:${active} 进行中`;
  }
  if (badge) {
    badge.textContent = String(total);
    badge.classList.toggle('hidden', !total);
  }
  const pop = $('#file-task-popover');
  if (pop) pop.classList.toggle('hidden', !taskPopoverOpen || !tasks.length);
  const list = $('#file-task-list');
  if (!list) return;
  list.classList.toggle('hidden', !taskPopoverOpen);
  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<div class="fp-task-empty muted">暂无传输任务。跨主机复制、上传、下载都会出现在这里。</div>';
    return;
  }
  for (const t of tasks) {
    const row = document.createElement('div');
    row.className = 'fp-task';
    const head = document.createElement('div');
    head.className = 'fp-task-head';
    // 状态图标替代圆点:图形即状态,title 保留文字说明
    const si = STAGE_ICON[t.stage] || { glyph: 'circleDot', cls: 'muted' };
    const dot = document.createElement('span');
    dot.className = 'fp-task-dot ' + si.cls;
    dot.innerHTML = icon(si.glyph);
    dot.title = STAGE_TEXT[t.stage] || t.stage;
    const name = document.createElement('span');
    name.className = 'fp-task-label';
    name.textContent = t.label;
    name.title = t.label;
    const stage = document.createElement('span');
    stage.className = 'fp-task-stage muted';
    stage.textContent = STAGE_TEXT[t.stage] || t.stage;
    head.append(dot, name, stage);
    row.appendChild(head);
    // 进度/计数行
    const counts = t.files.done + t.files.skipped + t.files.failed + t.files.cancelled + t.dirs.done;
    const sub = document.createElement('div');
    sub.className = 'fp-task-sub muted';
    const bits = [];
    if (t.stage === 'transferring' || t.stage === 'waiting' || t.stage === 'cancelling') {
      if (t.total > 0) bits.push(`${fmtBytes(t.bytes)} / ${fmtBytes(t.total)}`);
      if (t.current) bits.push(t.current);
    } else if (isTerminal(t)) {
      bits.push(`✔ ${t.files.done} · ⃠ ${t.files.skipped} · ✖ ${t.files.failed} · 🗑 ${t.files.cancelled}`);
      if (t.dirs.done) bits.push(`目录 ${t.dirs.done}`);
    } else if (t.kind === 'upload' || t.kind === 'download') {
      const total = t.items.length;
      const done = t.items.filter((i) => ['done', 'skipped', 'failed', 'cancelled'].includes(i.state)).length;
      bits.push(`${done}/${total}`);
      if (t.current) bits.push(t.current);
      if (counts && t.kind !== 'upload' && t.kind !== 'download') bits.push(`${counts} 项`);
    }
    sub.textContent = bits.filter(Boolean).join(' · ');
    row.appendChild(sub);
    // 具体失败原因独立成行:醒目、完整展示,不与计数挤在一行被截断
    if (t.error) {
      const err = document.createElement('div');
      err.className = 'fp-task-error';
      err.textContent = '✖ ' + t.error;
      row.appendChild(err);
    }
    if (t.truncated) {
      const tn = document.createElement('div');
      tn.className = 'fp-task-error warn-text';
      tn.textContent = '⚠ 已达递归上限,部分内容未执行';
      row.appendChild(tn);
    }
    if ((t.stage === 'transferring' || t.stage === 'waiting') && t.pct != null && t.pct >= 0 && (t.kind === 'upload' || t.kind === 'download')) {
      const track = document.createElement('div');
      track.className = 'fp-task-track';
      const fill = document.createElement('span');
      fill.style.width = t.pct + '%';
      track.appendChild(fill);
      row.appendChild(track);
    }
    // 操作行
    const actions = document.createElement('div');
    actions.className = 'fp-task-actions';
    if (t.conflict) {
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.textContent = '处理冲突';
      btn.addEventListener('click', () => {
        const pending = pendingConflicts.find((c) => c.task === t);
        if (pending) openConflictDialog(pending.task, pending.conflict);
      });
      actions.appendChild(btn);
    }
    if (t.stage === 'waiting' && !t.conflict && pendingConflicts.some((c) => c.task === t)) {
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.textContent = '处理冲突';
      btn.addEventListener('click', () => {
        const pending = pendingConflicts.find((c) => c.task === t);
        if (pending) openConflictDialog(pending.task, pending.conflict);
      });
      actions.appendChild(btn);
    }
    if (!isTerminal(t)) {
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = '取消';
      btn.addEventListener('click', async () => {
        try {
          if (t.kind === 'copy') await api('transfer:cancel', { taskId: t.taskId });
          else await api('sftp:cancel', { taskId: t.taskId });
          t.userCancelled = true;
          renderTaskCenter();
        } catch (e) { toast('取消失败:' + e.message, 'error'); }
      });
      actions.appendChild(btn);
    } else {
      if (['failed', 'partial', 'interrupted'].includes(t.stage) && t.retry) {
        const btn = document.createElement('button');
        btn.className = 'btn small';
        btn.textContent = '重试';
        btn.addEventListener('click', () => submitCopyTask({ ...t.retry }));
        actions.appendChild(btn);
      }
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = '清除';
      btn.addEventListener('click', () => {
        const idx = tasks.indexOf(t);
        if (idx >= 0) tasks.splice(idx, 1);
        renderTaskCenter();
      });
      actions.appendChild(btn);
    }
    if (actions.children.length) row.appendChild(actions);
    list.appendChild(row);
  }
  // 任务事件会随时重渲染,浮层每次都重新贴住锚点(高度随内容变化)
  positionTaskPopover();
}

export function toggleTaskPopover(force) {
  taskPopoverOpen = force === undefined ? !taskPopoverOpen : !!force;
  renderTaskCenter();
}

/* ---------------- 关闭连接前的确认 ---------------- */

/// 关闭会话/标签/断开前调用:相关传输任务需要用户确认中断。
/// 返回 true = 可以继续关闭。
export async function confirmTransferInterrupt(sessionIds) {
  const ids = (sessionIds || []).filter(Boolean);
  if (!ids.length) return true;
  let list = [];
  try { list = await api('transfer:activeFor', { sessionIds: ids }); } catch { return true; }
  if (!list.length) return true;
  const detail = list.map((t) => `${t.src?.label || '?'} → ${t.dst?.label || '?'}`).join('、');
  return askConfirm(
    `有 ${list.length} 个传输任务正在进行,关闭连接会中断它们:\n${detail}\n确定继续?`,
    { title: '传输进行中', okText: '中断任务并继续' },
  );
}

/* ---------------- 内部拖拽(应用内令牌) ---------------- */

export function wasRecentDrag() {
  return Date.now() - lastDragEnd < 350 || dragActive;
}

function markDragEnd() {
  lastDragEnd = Date.now();
  dragActive = false;
}

function bindInternalDrag() {
  let press = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest?.('.file-pane .file-row');
    if (!row || row.dataset.name === '..') return;
    const pane = filePaneFromEl(row);
    if (!pane || !pane.cwd || pane.loading || pane.stale || !paneSession(pane)) return;
    press = {
      x: e.clientX, y: e.clientY, row,
      pane,
      name: row.dataset.name,
      isDir: row.dataset.dir === '1',
      ghost: null, targets: null, hit: null,
      pointerId: e.pointerId,
    };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!dragActive) {
      if (dx * dx + dy * dy < 36) return;
      startDrag(press);
    }
    moveDrag(press, e.clientX, e.clientY);
    e.preventDefault();
  }, true);
  const end = (e) => {
    if (!press) return;
    const p = press;
    press = null;
    if (dragActive) {
      dropDrag(p);
      e.preventDefault();
    }
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('keydown', (e) => {
    if (dragActive && e.key === 'Escape') {
      if (press) { cleanupDragVisuals(press); press = null; }
      markDragEnd();
      e.preventDefault();
    }
  }, true);
}

function startDrag(press) {
  dragActive = true;
  const ghost = document.createElement('div');
  ghost.className = 'file-drag-ghost';
  ghost.innerHTML = `${icon(press.isDir ? 'folder' : 'file')} ${escapeHtml(press.name)}`;
  document.body.appendChild(ghost);
  press.ghost = ghost;
  // 收集合法落点:所有可见文件分屏的空白(=该屏 cwd)+ 目录行(=进入该目录)。
  // 同标签并排(同主机复制)与跨平铺标签(跨主机复制)统一处理。
  const targets = [];
  for (const paneEl of document.querySelectorAll('.term-pane.file-pane')) {
    const pane = filePaneFromEl(paneEl);
    if (!pane || !pane.cwd || pane.loading || pane.stale || !paneSession(pane)) continue;
    targets.push({ type: 'cwd', pane, path: pane.cwd, rect: paneEl.getBoundingClientRect(), el: paneEl });
    for (const row of paneEl.querySelectorAll('.file-row')) {
      if (row.dataset.dir !== '1' || row.dataset.name === '..') continue;
      targets.push({
        type: 'dir', pane,
        path: (pane.cwd === '/' ? '' : pane.cwd) + '/' + row.dataset.name,
        rect: row.getBoundingClientRect(), el: row,
      });
    }
  }
  press.targets = targets;
  document.body.classList.add('file-dragging');
}

function moveDrag(press, x, y) {
  if (press.ghost) {
    press.ghost.style.left = x + 10 + 'px';
    press.ghost.style.top = y + 8 + 'px';
  }
  let hit = null;
  for (const t of press.targets) {
    const r = t.rect;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (!isValidDrop(press, t)) continue;
      hit = t;
      break;
    }
  }
  if (press.hit && press.hit.el.classList.contains('drop-ok')) press.hit.el.classList.remove('drop-ok');
  if (press.hit && press.hit.el.classList.contains('drop-ok-pane')) press.hit.el.classList.remove('drop-ok-pane');
  press.hit = hit;
  if (hit) hit.el.classList.add(hit.type === 'dir' ? 'drop-ok' : 'drop-ok-pane');
  if (press.ghost) press.ghost.classList.toggle('deny', !hit);
}

function isValidDrop(press, t) {
  // 同窗格同目录 = 自复制,拒绝;目录拖进自身子树,拒绝
  if (t.pane === press.pane && t.path === press.pane.cwd) return false;
  if (press.isDir) {
    const srcRoot = (press.pane.cwd === '/' ? '' : press.pane.cwd) + '/' + press.name;
    if (t.path === srcRoot || t.path.startsWith(srcRoot + '/')) return false;
  }
  return true;
}

function dropDrag(press) {
  const hit = press.hit;
  cleanupDragVisuals(press);
  markDragEnd();
  if (!hit) return;
  // 源/目标会话在松手时快照:通道是"提交时解析"的(重连/切换无感知)
  const srcSession = paneSession(press.pane);
  const dstSession = paneSession(hit.pane);
  if (!srcSession || !dstSession) return toast('连接不可用,复制未执行', 'error');
  submitCopyTask({
    srcSessionId: srcSession.sessionId,
    srcDir: press.pane.cwd,
    srcPaneId: press.pane.id,
    dstSessionId: dstSession.sessionId,
    dstDir: hit.path,
    dstPaneId: hit.pane.id,
    items: [{ name: press.name, isDir: press.isDir }],
  }).catch(() => {});
}

function cleanupDragVisuals(press) {
  document.body.classList.remove('file-dragging');
  press.ghost?.remove();
  for (const t of press.targets || []) {
    t.el.classList.remove('drop-ok', 'drop-ok-pane');
  }
}

/* ---------------- 启动绑定 ---------------- */

export function bindTransferUi() {
  window.nebula.on('transfer:event', onTransferEvent);
  bindInternalDrag();
  const pop = $('#file-task-popover');
  // fixed 定位的浮层必须挂在 body:留在 #statusbar 里会被它的 overflow-y:hidden 裁掉
  if (pop && pop.parentElement !== document.body) document.body.appendChild(pop);
  window.addEventListener('resize', positionTaskPopover);
  const sbBtn = $('#btn-file-tasks-status');
  if (sbBtn) sbBtn.addEventListener('click', () => toggleTaskPopover());
  // 浮层外点击收起(状态栏按钮自身由上面的 toggle 处理)
  document.addEventListener('pointerdown', (e) => {
    if (!taskPopoverOpen) return;
    if (e.target.closest?.('#file-task-popover, #btn-file-tasks-status')) return;
    toggleTaskPopover(false);
  }, true);
  renderTaskCenter();
}
