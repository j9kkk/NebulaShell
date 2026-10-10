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
import { refreshCommandStates } from './commands.js';
import { icon } from '../shared/icons.js';
import { fmtClock, fmtDuration, fmtSize, fmtSpeed, pushSample, rateOf, remainingMs } from '../shared/format.js';
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

/// 事件先于提交方建条时,合并只取提交方的静态信息,这些字段以事件为准。
const LIVE_FIELDS = ['stage', 'bytes', 'total', 'current', 'error', 'truncated', 'files', 'dirs', 'conflict', 'samples', 'createdAt', 'finishedAt'];

const VERB = { download: '下载', upload: '上传', copy: '复制' };

const tasks = [];
const pendingConflicts = [];
let conflictOpen = false;
let lastDragEnd = 0;
let dragActive = false;
/// 最近一次写出了内容的下载:{ path, isDir }。「打开最近下载位置」用,清除任务记录不影响它。
let lastDownload = null;

function sessionLabel(sessionId) {
  const s = state.sessions.get(sessionId);
  return s ? `${s.host.name}(${s.host.username}@${s.host.host}:${s.host.port})` : sessionId;
}

function newTask(fields) {
  return {
    stage: 'transferring',
    items: [],
    files: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    dirs: { done: 0, skipped: 0, failed: 0, cancelled: 0 },
    bytes: 0, total: 0, current: '', error: '', truncated: false,
    conflict: null, pct: -1, userCancelled: false,
    // 速度采样 [时刻, 累计字节];bytesBase/filesBase 是已结束的文件/批次部分
    samples: [], bytesBase: 0, filesBase: 0, filesDone: 0, curTotal: 0, lastFailure: '',
    createdAt: Date.now(), finishedAt: 0,
    ...fields,
  };
}

/// 同 taskId 合并并保持对象身份(句柄、冲突队列都持有任务对象):submit_copy 在返回
/// taskId 前就会 emit 首个任务事件,事件先建条、invoke 返回后再 addTask。
function addTask(t) {
  const existing = findTask(t.taskId);
  if (existing) {
    const live = existing.fromEvent ? Object.fromEntries(LIVE_FIELDS.map((k) => [k, existing[k]])) : {};
    Object.assign(existing, t, live, { fromEvent: false });
    renderTaskCenter();
    return existing;
  }
  tasks.unshift(t);
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

function settle(t, stage) {
  t.stage = stage;
  if (isTerminal(t) && !t.finishedAt) t.finishedAt = Date.now();
}

function activeCount() {
  return tasks.filter((t) => !isTerminal(t) || t.stage === 'waiting').length;
}

function noteDownload(path, isDir) {
  if (!path) return;
  lastDownload = { path, isDir };
  refreshCommandStates();
}

/* ---------------- 本机文件入口 ---------------- */

export async function revealLocalPath(path) {
  try {
    await api('local:reveal', { path });
    return true;
  } catch (e) {
    toast('无法在文件夹中显示:' + e.message, 'error');
    return false;
  }
}

export async function openLocalPath(path) {
  try {
    await api('local:open', { path });
    return true;
  } catch (e) {
    toast('无法打开:' + e.message, 'error');
    return false;
  }
}

export function lastDownloadLocation() {
  return lastDownload;
}

/// 单文件下载在文件夹中选中该文件;批量下载直接打开目标文件夹。
export function revealLastDownload() {
  if (!lastDownload) {
    toast('还没有完成的下载', 'error');
    return Promise.resolve(false);
  }
  return lastDownload.isDir ? openLocalPath(lastDownload.path) : revealLocalPath(lastDownload.path);
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
  addTask(newTask({
    taskId: r.taskId,
    batchId,
    kind: 'copy',
    stage: 'queued',
    label: `${srcEp.label} → ${dstEp.label}`,
    srcLabel: srcEp.label,
    dstLabel: dstEp.label,
    srcDir, dstDir,
    items: items.map((it) => ({ name: it.name, isDir: !!it.isDir, state: 'pending' })),
    retry: { srcSessionId, srcDir, srcPaneId, dstSessionId, dstDir, dstPaneId, items },
  }));
  toast('已创建复制任务:' + items.map((i) => i.name).join('、'), 'success');
  return r;
}

/* ---------------- 上传/下载任务句柄 ---------------- */

export function registerUploadTask({ paneId, sessionId, dstDir, names }) {
  const taskId = 'up-' + crypto.randomUUID();
  const t = addTask(newTask({
    taskId,
    kind: 'upload',
    label: `上传 → ${sessionLabel(sessionId)}`,
    dstSessionId: sessionId,
    dstDir,
    paneId,
    items: names.map((n) => ({ name: n, isDir: false, state: 'pending' })),
  }));
  return {
    taskId,
    isCancelled: () => t.userCancelled,
    cancelRest: () => { t.userCancelled = true; },
    /// bytes:sftp:upload 结果里的实传字节(进度事件与命令返回不保证先后,以结果为准)
    mark(name, st, err, bytes) {
      const item = t.items.find((i) => i.name === name && (i.state === 'active' || i.state === 'pending')) || t.items.find((i) => i.name === name);
      if (item) item.state = st;
      if (st === 'active') {
        t.current = name;
        t.curTotal = 0;
      } else if (st === 'done') {
        // 上传进度按文件上报:文件结束时把它的大小并入任务级字节
        t.bytesBase += typeof bytes === 'number' ? bytes : t.curTotal;
        t.bytes = t.bytesBase;
        t.files.done += 1;
      } else if (st === 'skipped') {
        t.files.skipped += 1;
      } else if (st === 'failed') {
        t.files.failed += 1;
        t.error = err || t.error;
      } else if (st === 'cancelled') {
        t.files.cancelled += 1;
      }
      renderTaskCenter();
    },
    finish(stage) { settle(t, stage); renderTaskCenter(); },
  };
}

/// 批量/目录下载任务:前端逐项调用 sftp:downloadTree,每项结束调 itemDone 累计。
export function registerTreeDownloadTask({ paneId, sessionId, names, localRoot }) {
  const taskId = 'dt-' + crypto.randomUUID();
  const t = addTask(newTask({
    taskId,
    kind: 'download',
    label: `下载 ${names.length} 项 ← ${sessionLabel(sessionId)}`,
    srcSessionId: sessionId,
    paneId,
    localRoot,
    items: names.map((n) => ({ name: n, isDir: true, state: 'active' })),
    current: names[0] || '',
  }));
  return {
    taskId,
    isCancelled: () => t.userCancelled,
    /// 一次 sftp:downloadTree 结束:进度事件的 taskBytes/filesDone 只在该次调用内累计
    itemDone(r) {
      t.bytesBase += r?.bytes || 0;
      t.filesBase += r?.done || 0;
      t.bytes = Math.max(t.bytes, t.bytesBase);
      t.filesDone = t.filesBase;
      scheduleRender();
    },
    finish(stage, { done = 0, skipped = 0, failed = 0 } = {}) {
      t.files.done = done;
      t.files.skipped = skipped;
      t.files.failed = failed;
      for (const it of t.items) it.state = 'done';
      if (done > 0) noteDownload(localRoot, true);
      settle(t, stage);
      renderTaskCenter();
    },
    failed(msg) { t.error = msg; t.files.failed += 1; settle(t, 'failed'); renderTaskCenter(); },
    cancelled() { t.files.cancelled += 1; settle(t, 'cancelled'); renderTaskCenter(); },
  };
}

export function registerDownloadTask({ paneId, sessionId, name, remotePath, localPath }) {
  const taskId = 'dl-' + crypto.randomUUID();
  const t = addTask(newTask({
    taskId,
    kind: 'download',
    label: `下载 ${name} ← ${sessionLabel(sessionId)}`,
    srcSessionId: sessionId,
    paneId,
    remotePath,
    localPath,
    items: [{ name, isDir: false, state: 'active' }],
    current: name,
  }));
  return {
    taskId,
    /// bytes:sftp:download 结果里的实收字节(进度事件可能晚于命令返回到达)
    done(bytes) {
      t.files.done += 1;
      t.items[0].state = 'done';
      if (typeof bytes === 'number') {
        t.bytes = bytes;
        if (!(t.total > 0)) t.total = bytes;
      } else if (t.total > 0) t.bytes = t.total;
      noteDownload(localPath, false);
      settle(t, 'done');
      renderTaskCenter();
    },
    failed(msg) { t.error = msg; t.files.failed += 1; t.items[0].state = 'failed'; settle(t, 'failed'); renderTaskCenter(); },
    cancelled() { t.files.cancelled += 1; t.items[0].state = 'cancelled'; settle(t, 'cancelled'); renderTaskCenter(); },
  };
}

/// sftp:progress 事件按 taskId 归属到任务;找到返回 true。
/// 单文件事件带 bytes/total;批量下载另带 taskBytes/filesDone(本次 downloadTree 内累计)。
export function taskProgressFromEvent(evt) {
  const t = evt.taskId ? findTask(evt.taskId) : null;
  if (!t) return false;
  if (t.stage !== 'transferring' && t.stage !== 'waiting') return true; // 迟到进度不影响终态
  if (typeof evt.pct === 'number') t.pct = evt.pct;
  if (evt.name) t.current = evt.name;
  if (evt.error) t.lastFailure = `${evt.name || ''}: ${evt.error}`;
  if (typeof evt.taskBytes === 'number') {
    t.bytes = t.bytesBase + evt.taskBytes;
    if (typeof evt.filesDone === 'number') t.filesDone = t.filesBase + evt.filesDone;
  } else if (typeof evt.bytes === 'number') {
    if (t.kind === 'upload') {
      t.curTotal = evt.total || 0;
      t.bytes = t.bytesBase + evt.bytes;
      if (t.items.length === 1) t.total = evt.total || 0;
    } else {
      t.bytes = evt.bytes;
      t.total = evt.total || 0;
    }
  }
  if (typeof evt.bytes === 'number' || typeof evt.taskBytes === 'number') {
    t.samples = pushSample(t.samples, Date.now(), t.bytes);
  }
  scheduleRender();
  return true;
}

/* ---------------- 事件接入 ---------------- */

function onTransferEvent(payload) {
  if (payload?.kind === 'conflict') return onConflictEvent(payload);
  if (payload?.kind !== 'task' || !payload.task) return;
  const v = payload.task;
  const t = findTask(v.taskId);
  if (!t) {
    // 事件先于 transfer:copy 的返回到达,或应用重启后收到的任务事件:补记一条
    // (fromEvent:随后的 addTask 只补静态信息,进度以事件为准)
    addTask(newTask({
      taskId: v.taskId, batchId: v.batchId, kind: 'copy', stage: v.stage,
      label: `${v.src?.label || '?'} → ${v.dst?.label || '?'}`,
      srcLabel: v.src?.label, dstLabel: v.dst?.label,
      srcDir: v.srcDir, dstDir: v.dstDir,
      items: (v.items || []).map((n) => ({ name: n, isDir: false, state: 'pending' })),
      files: v.files || { done: 0, skipped: 0, failed: 0, cancelled: 0 },
      dirs: v.dirs || { done: 0, skipped: 0, failed: 0, cancelled: 0 },
      bytes: v.bytes || 0, total: v.total || 0,
      current: v.current || '', error: v.error || '', truncated: !!v.truncated,
      fromEvent: true,
    }));
    return;
  }
  // 终态单向推进:迟到事件不能把终态改回传输中
  if (isTerminal(t)) return;
  t.bytes = v.bytes ?? t.bytes;
  t.total = v.total ?? t.total;
  t.current = v.current ?? t.current;
  t.truncated = !!v.truncated;
  if (v.files) t.files = v.files;
  if (v.dirs) t.dirs = v.dirs;
  t.error = v.error || '';
  t.samples = pushSample(t.samples, Date.now(), t.bytes);
  settle(t, v.stage);
  if (!isTerminal(t)) {
    scheduleRender();
    return;
  }
  // 复制任务进入终态:刷新仍在浏览目标目录的文件分屏(发布结果立即可见)
  if (t.kind === 'copy') refreshFilePanesFor(t.retry?.dstSessionId, t.dstDir);
  renderTaskCenter();
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
/// taskId → 行元素。行按任务复用、原地更新:进度每 0.5s 一次,整表重建会在
/// 按下与松开之间换掉按钮,点击丢失。
const rowEls = new Map();
let renderTimer = null;
let ticker = null;

/// 进度类更新合并到 150ms 一次;结构变化(建条、终态、清除)直接 renderTaskCenter。
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderTaskCenter();
  }, 150);
}

/// 浮层打开且有在途任务时每秒刷新:没有新数据时速度要能消失。
function syncTicker() {
  const want = taskPopoverOpen && tasks.some((t) => !isTerminal(t));
  if (want && !ticker) ticker = setInterval(renderTaskCenter, 1000);
  else if (!want && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

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

const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '') || String(p || '');

/// 多文件任务(批量下载、多文件上传、目录或多项复制)事先不知道总量:
/// 显示文件数与当前文件,不显示进度条和剩余时间。
function isMulti(t) {
  if (t.kind === 'download') return !t.localPath;
  return t.items.length > 1 || !!t.items[0]?.isDir;
}

/// 3 秒没有新数据就不显示速度:卡住的传输不能一直挂着旧速度。
function liveRate(t, now = Date.now()) {
  const last = t.samples[t.samples.length - 1];
  if (!last || now - last[0] > 3000) return 0;
  return rateOf(t.samples);
}

function barPercent(t) {
  if (isTerminal(t) || isMulti(t) || !(t.total > 0)) return null;
  return Math.min(100, Math.floor((t.bytes * 100) / t.total));
}

/// 下载落点:单文件 = 文件本身(在文件夹中选中),批量 = 目标根目录(直接打开)。
/// 只有确实写出了内容的下载才给入口。
function downloadLocation(t) {
  if (t.kind !== 'download') return null;
  if (t.localPath) return t.stage === 'done' ? { path: t.localPath, isDir: false } : null;
  if (t.localRoot && t.files.done > 0 && isTerminal(t)) return { path: t.localRoot, isDir: true };
  return null;
}

function progressText(t) {
  if (t.stage === 'waiting') return `「${t.conflict?.name || '同名项'}」有冲突,点击此行处理`;
  if (t.userCancelled || t.stage === 'cancelling') return '正在取消…';
  if (t.stage === 'queued') return '排队中';
  const rate = liveRate(t);
  const parts = [];
  if (isMulti(t)) {
    const done = t.kind === 'download' ? t.filesDone : t.files.done;
    const of = t.kind === 'upload' ? `/${t.items.length}` : '';
    parts.push(`已${VERB[t.kind] || '传输'} ${done}${of} 个文件`);
    if (t.bytes > 0) parts.push(fmtSize(t.bytes));
    if (rate) parts.push(fmtSpeed(rate));
    if (t.current) parts.push('当前 ' + t.current);
  } else {
    if (t.total > 0) parts.push(`${fmtSize(t.bytes)} / ${fmtSize(t.total)}`);
    else if (t.bytes > 0) parts.push(fmtSize(t.bytes));
    if (rate) parts.push(fmtSpeed(rate));
    const eta = remainingMs(t.bytes, t.total, rate);
    if (eta != null) parts.push('剩余 ' + fmtDuration(eta));
  }
  return parts.join(' · ') || '准备中…';
}

function placeText(t) {
  if (t.kind === 'download') {
    const dir = t.localPath ? dirOf(t.localPath) : t.localRoot;
    return dir ? '位于 ' + baseName(dir) : '';
  }
  return t.dstDir ? '→ ' + t.dstDir : '';
}

function summaryText(t) {
  if (t.stage === 'failed' || t.stage === 'interrupted') return t.error || t.lastFailure || STAGE_TEXT[t.stage];
  const parts = [];
  if (t.stage === 'cancelled') parts.push('已取消');
  if (isMulti(t)) {
    parts.push(`${t.files.done} 个文件`);
    if (t.files.skipped) parts.push(`跳过 ${t.files.skipped}`);
    if (t.files.failed) parts.push(`失败 ${t.files.failed}`);
  }
  if (t.bytes > 0) parts.push(fmtSize(t.bytes));
  if (t.stage !== 'cancelled' && t.finishedAt) {
    parts.push('用时 ' + fmtDuration(t.finishedAt - t.createdAt), fmtClock(t.finishedAt) + ' 完成');
  }
  const place = placeText(t);
  if (place && t.stage !== 'cancelled') parts.push(place);
  const why = t.error || t.lastFailure;
  if (why && t.stage !== 'done') parts.push(why);
  return parts.join(' · ');
}

/// 信息行的悬停提示:完整信息 + 完整本地/目标路径(信息行本身会被省略号截断)。
function infoTitle(t, text) {
  const lines = [text];
  if (t.kind === 'download' && (t.localPath || t.localRoot)) lines.push('本地:' + (t.localPath || t.localRoot));
  else if (t.dstDir) lines.push('目标:' + t.dstDir);
  return lines.join('\n');
}

function taskActions(t) {
  if (!isTerminal(t)) {
    const pending = t.userCancelled || t.stage === 'cancelling';
    return [{ action: 'cancel', glyph: 'stop', title: pending ? '正在取消…' : '取消此任务', disabled: pending }];
  }
  const actions = [];
  const loc = downloadLocation(t);
  if (loc?.isDir) actions.push({ action: 'reveal', glyph: 'folderOpen', title: '打开文件夹' });
  else if (loc) {
    actions.push({ action: 'reveal', glyph: 'folderOpen', title: '在文件夹中显示' });
    actions.push({ action: 'open', glyph: 'externalLink', title: '打开文件' });
  }
  actions.push({ action: 'clear', glyph: 'x', title: '清除此任务记录' });
  return actions;
}

async function runTaskAction(taskId, action) {
  const t = findTask(taskId);
  if (!t) return;
  if (action === 'clear') {
    const idx = tasks.indexOf(t);
    if (idx >= 0) tasks.splice(idx, 1);
    renderTaskCenter();
    return;
  }
  if (action === 'cancel') {
    if (t.userCancelled || isTerminal(t)) return;
    // 先置位:上传/批量下载在文件边界检查它,哪怕此刻没有在途请求可中止
    t.userCancelled = true;
    renderTaskCenter();
    try {
      if (t.kind === 'copy') await api('transfer:cancel', { taskId: t.taskId });
      else await api('sftp:cancel', { taskId: t.taskId });
    } catch (err) {
      toast('取消失败:' + err.message, 'error');
    }
    return;
  }
  const loc = downloadLocation(t);
  if (!loc) return;
  if (action === 'open' || loc.isDir) await openLocalPath(loc.path);
  else await revealLocalPath(loc.path);
}

function createTaskRow(taskId) {
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    node.className = cls;
    return node;
  };
  const row = el('div', 'fp-task');
  row.dataset.taskId = taskId;
  const head = el('div', 'fp-task-head');
  const dot = el('span', 'fp-task-dot');
  const label = el('span', 'fp-task-label');
  const actions = el('span', 'fp-task-actions');
  head.append(dot, label, actions);
  const bar = el('div', 'fp-task-bar hidden');
  const fill = el('i', '');
  bar.appendChild(fill);
  const info = el('div', 'fp-task-info muted');
  row.append(head, bar, info);
  // 整行点击只用于打开待处理的冲突;取消只走 ⏹
  row.addEventListener('click', () => {
    const t = findTask(taskId);
    const pending = t && pendingConflicts.find((c) => c.task === t);
    if (pending && !conflictOpen) openConflictDialog(pending.task, pending.conflict);
  });
  return { row, dot, label, actions, bar, fill, info, stage: null, actionKey: '' };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function updateTaskRow(r, t) {
  if (r.stage !== t.stage) {
    const si = STAGE_ICON[t.stage] || { glyph: 'circleDot', cls: 'muted' };
    r.dot.className = 'fp-task-dot ' + si.cls;
    r.dot.innerHTML = icon(si.glyph);
    r.dot.title = STAGE_TEXT[t.stage] || t.stage;
    r.stage = t.stage;
  }
  setText(r.label, t.label);
  r.label.title = t.label;
  const conflict = t.stage === 'waiting' && pendingConflicts.some((c) => c.task === t);
  r.row.classList.toggle('has-conflict', conflict);
  r.row.classList.toggle('active', !isTerminal(t));
  const pct = barPercent(t);
  r.bar.classList.toggle('hidden', pct == null);
  if (pct != null) r.fill.style.width = pct + '%';
  const text = isTerminal(t) ? summaryText(t) : progressText(t);
  setText(r.info, text);
  r.info.title = infoTitle(t, text);
  const actions = taskActions(t);
  const key = actions.map((a) => `${a.action}:${a.title}`).join('|');
  if (key === r.actionKey) return;
  r.actionKey = key;
  r.actions.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn icon fp-task-btn fp-task-${a.action}`;
    b.dataset.action = a.action;
    b.title = a.title;
    b.setAttribute('aria-label', a.title);
    b.disabled = !!a.disabled;
    b.innerHTML = icon(a.glyph);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      runTaskAction(t.taskId, a.action);
    });
    r.actions.appendChild(b);
  }
}

function renderTaskCenter() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
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
  // 右下角「清除所有任务」:有任务才出现(清除 = 移除全部任务记录,不影响在途传输本身)
  const clearAll = $('#btn-file-tasks-clear-all');
  if (clearAll) clearAll.classList.toggle('hidden', !tasks.length);
  syncTicker();
  const list = $('#file-task-list');
  if (!list) return;
  list.classList.toggle('hidden', !taskPopoverOpen);
  if (!tasks.length) {
    rowEls.clear();
    list.innerHTML = '<div class="fp-task-empty muted">暂无传输任务。跨主机复制、上传、下载都会出现在这里。</div>';
    return;
  }
  list.querySelector('.fp-task-empty')?.remove();
  const live = new Set(tasks.map((t) => t.taskId));
  for (const [id, r] of rowEls) {
    if (live.has(id)) continue;
    r.row.remove();
    rowEls.delete(id);
  }
  // 按任务顺序就位,已在正确位置的行不挪动
  let prev = null;
  for (const t of tasks) {
    let r = rowEls.get(t.taskId);
    if (!r) {
      r = createTaskRow(t.taskId);
      rowEls.set(t.taskId, r);
    }
    updateTaskRow(r, t);
    const slot = prev ? prev.nextSibling : list.firstChild;
    if (slot !== r.row) list.insertBefore(r.row, slot);
    prev = r.row;
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
  const clearAll = $('#btn-file-tasks-clear-all');
  if (clearAll) {
    clearAll.addEventListener('click', () => {
      // 只清任务记录:在途传输不因此中断(用户可继续看 toast 反馈),
      // 需要中断在途任务时逐条点 ⏹。
      tasks.length = 0;
      pendingConflicts.length = 0;
      renderTaskCenter();
    });
  }
  // 浮层外点击收起(状态栏按钮自身由上面的 toggle 处理)
  document.addEventListener('pointerdown', (e) => {
    if (!taskPopoverOpen) return;
    if (e.target.closest?.('#file-task-popover, #btn-file-tasks-status')) return;
    toggleTaskPopover(false);
  }, true);
  renderTaskCenter();
}
