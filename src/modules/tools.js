// 批量执行、命令历史、端口转发
import { $, api, askConfirm, closeModal, copyText, makeDraggable, openModal, state, stripFpMark, toast } from './core.js';
import { icon } from '../shared/icons.js';
import { escapeHtml } from './hosts.js';
import { writeSessionInput } from './terminal.js';

export let batchChecked = new Set();
export let batchResults = new Map();
let activeBatch = null;
// 本批目标的冻结身份(名称 + 用户名@地址[:端口]):后端结果只回 username@host,
// 同地址同用户名不同端口的目标会无法区分,展示一律优先用这份快照。
let batchIdentity = new Map();
let batchDetailHostId = null;
let batchExporting = false;
// 当前渲染出的复选框引用:执行中要锁定勾选,又不允许 querySelectorAll 式全局检索。
let batchHostInputs = [];
let batchShownIds = new Set();

function batchHostConn(h) {
  const addr = String(h.host || '').includes(':') ? `[${h.host}]` : `${h.host}`;
  const port = Number(h.port) > 0 && Number(h.port) !== 22 ? `:${h.port}` : '';
  return `${h.username || 'root'}@${addr}${port}`;
}

function batchHostLabel(h) {
  return `${h.name || h.host}(${batchHostConn(h)})`;
}

function batchMatches() {
  const kw = ($('#batch-search').value || '').trim().toLowerCase();
  if (!kw) return state.hosts;
  return state.hosts.filter((h) => `${h.name || ''} ${batchHostConn(h)}`.toLowerCase().includes(kw));
}

export function renderBatchHosts() {
  const box = $('#batch-hosts');
  const matched = batchMatches();
  batchHostInputs = [];
  batchShownIds = new Set(matched.map((h) => h.id));
  box.innerHTML = '';
  for (const h of matched) {
    const el = document.createElement('label');
    el.innerHTML = '<input type="checkbox"/><span class="bh-main"></span><span class="bh-sub"></span>';
    const input = el.querySelector('input');
    input.value = h.id;
    input.checked = batchChecked.has(h.id);
    input.disabled = !!activeBatch;
    batchHostInputs.push(input);
    el.querySelector('.bh-main').textContent = h.name || h.host;
    el.querySelector('.bh-sub').textContent = batchHostConn(h);
    input.addEventListener('change', (e) => {
      if (e.target.checked) batchChecked.add(h.id); else batchChecked.delete(h.id);
      updateBatchSelSummary();
      updateBatchUi();
    });
    box.appendChild(el);
  }
  if (!state.hosts.length) box.innerHTML = '<div class="batch-hosts-empty">暂无主机,请先新建或从云端导入。</div>';
  else if (!matched.length) box.innerHTML = '<div class="batch-hosts-empty">没有匹配的主机,换个关键词试试。</div>';
  updateBatchSelSummary();
}

function updateBatchSelSummary() {
  // 隐藏的已选目标仍会执行(筛选不改变选择),必须显式展示数量,避免"看到的=执行的"错觉。
  const hidden = [...batchChecked].filter((id) => !batchShownIds.has(id)).length;
  const kw = ($('#batch-search').value || '').trim();
  $('#batch-sel-summary').textContent = !kw
    ? `已选 ${batchChecked.size} / 共 ${state.hosts.length} 台`
    : `已选 ${batchChecked.size} 台 · 匹配 ${batchShownIds.size}/${state.hosts.length}` + (hidden ? ` · 隐藏已选 ${hidden} 台` : '');
}

function parseBatchParams() {
  const errors = {};
  const parallelRaw = String($('#batch-parallel').value ?? '').trim();
  const timeoutRaw = String($('#batch-timeout').value ?? '').trim();
  const parallel = Number(parallelRaw);
  const timeout = Number(timeoutRaw);
  if (!parallelRaw || !Number.isInteger(parallel) || parallel < 1 || parallel > 10) errors.parallel = '并行数需为 1-10 的整数';
  if (!timeoutRaw || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) errors.timeout = '超时需为 1-600 的整数';
  return { errors, parallel, timeout };
}

function applyParamErrors(errors) {
  $('#batch-parallel-err').textContent = errors.parallel || '';
  $('#batch-timeout-err').textContent = errors.timeout || '';
}

function updateBatchUi() {
  const batch = activeBatch;
  const running = !!batch;
  const { errors } = parseBatchParams();
  const cmd = $('#batch-cmd').value.trim();
  $('#btn-batch-run').disabled = running || !cmd || !batchChecked.size || Object.keys(errors).length > 0;
  $('#btn-batch-cancel').disabled = !running || batch.cancelling;
  const hasResults = batchResults.size > 0;
  const partial = running && hasResults && batchResults.size < batch.hostIds.size;
  $('#btn-batch-copy').disabled = !hasResults;
  $('#btn-batch-copy').textContent = partial ? `复制当前结果(${batchResults.size}/${batch.hostIds.size})` : '复制全部结果';
  $('#btn-batch-export').disabled = !hasResults || batchExporting;
  $('#btn-batch-export').textContent = partial ? '导出当前快照' : '导出 JSON';
  // 执行中锁定任务意图相关控件;搜索保持可用(只影响显示,不影响本次快照)。
  $('#batch-cmd').disabled = running;
  $('#batch-parallel').disabled = running;
  $('#batch-timeout').disabled = running;
  for (const input of batchHostInputs) input.disabled = running;
  $('#btn-batch-select-matched').disabled = running || batchShownIds.size === 0;
  $('#btn-batch-clear-sel').disabled = running || batchChecked.size === 0;
  $('#batch-hosts').classList.toggle('locked', running);
}

function batchRow(hostId) {
  return [...$('#batch-tbody').children].find((row) => row.dataset.h === hostId) || null;
}

function batchStatusText(result) {
  return result.cancelled ? '已取消' : result.ok ? '成功' : `失败${result.code != null ? ' code ' + result.code : ''}`;
}

function buildPendingRows(batch, order) {
  // 目标行按冻结顺序一次性建好:未返回的主机显示"等待结果",进度只更新对应行,
  // 行序稳定、不因渐进结果跳动;按钮节点常驻,避免更新行时丢失焦点。
  const tbody = $('#batch-tbody');
  tbody.innerHTML = '';
  for (const hostId of order) {
    const tr = document.createElement('tr');
    tr.dataset.h = hostId;
    tr.innerHTML = '<td class="bh"></td><td class="st"><span class="tag wait">等待结果</span></td><td class="ms">—</td><td class="out"><span></span></td><td class="op"><button class="btn small" disabled>查看详情</button></td>';
    tr.querySelector('.bh').textContent = batchIdentity.get(hostId) || hostId;
    tr.querySelector('.op button').addEventListener('click', () => showBatchDetail(hostId));
    tbody.appendChild(tr);
  }
}

function updateResultRow(result) {
  const tr = batchRow(result.hostId);
  if (!tr) return;
  tr.querySelector('.st').innerHTML = `<span class="tag ${result.ok ? 'ok' : 'p1'}">${escapeHtml(batchStatusText(result))}</span>` + (result.truncated ? '<span class="tag p1">输出已截断</span>' : '');
  tr.querySelector('.ms').textContent = `${Number(result.ms) || 0}ms`;
  const text = batchResultText(result);
  tr.querySelector('.out span').textContent = text.slice(0, 120) + (text.length > 120 ? '…(预览截断)' : '');
  tr.querySelector('.op button').disabled = false;
}

export function batchResultText(result) {
  const output = String(result.output ?? '');
  const error = stripFpMark(result.error || '');
  const extent = result.originalBytes != null
    ? ` / 原始 ${result.originalBytes} 字节${result.retainedBytes != null ? `,保留 ${result.retainedBytes} 字节` : ''}`
    : result.originalChars != null ? ` / 原始 ${result.originalChars} 字符` : '';
  const notice = result.truncated
    ? `[输出已截断:保留 ${[...output].length} 字符${extent}${result.outputLimitBytes ? `,上限 ${result.outputLimitBytes} 字节` : ''}]\n`
    : '';
  return notice + output + (error ? `${output ? '\n' : ''}[错误] ${error}` : '');
}

export function serializeBatchResults(results = [...batchResults.values()]) {
  return JSON.stringify(results.map((r) => ({ ...r, error: stripFpMark(r.error || ''), detail: batchResultText(r) })), null, 2);
}

async function exportBatchResults() {
  if (batchExporting || !batchResults.size) return;
  batchExporting = true;
  updateBatchUi();
  try {
    // Freeze retained results before the native dialog; progress may keep arriving.
    const json = serializeBatchResults();
    const saved = await api('batch:exportResults', { json });
    if (saved) toast(`已导出批量结果:${saved.path}`, 'success');
  } catch (e) {
    toast('导出失败:' + e.message, 'error');
  } finally {
    batchExporting = false;
    updateBatchUi();
  }
}

function renderBatchDetail(force = false) {
  const result = batchDetailHostId != null ? batchResults.get(batchDetailHostId) : null;
  const detail = $('#batch-result-detail');
  if (!result) {
    batchDetailHostId = null;
    detail.classList.add('hidden');
    return;
  }
  const text = batchResultText(result);
  const ta = $('#batch-detail-output');
  // 内容没变就不重写:避免最终结果覆盖进度时重置滚动位置与文本选区。
  if (!force && ta.value === text) return;
  $('#batch-detail-title').textContent = `${batchIdentity.get(result.hostId) || result.host || result.hostId} · ${batchStatusText(result)}`;
  $('#batch-detail-note').textContent = result.truncated
    ? '后端输出达到上限,以下是保留部分(复制/导出同样包含截断标记)。'
    : '完整后端保留结果;表格仅显示前 120 字符。';
  ta.value = text;
  // 先显形再量高:display:none 期间 scrollHeight 恒为 0,会得到 0 高的输出框。
  detail.classList.remove('hidden');
  // 短输出按内容收缩,长输出封顶在 40vh 内部滚动。height:auto 会回落到 rows
  // 属性的高度(WKWebView/Chromium 皆然),必须先压到 0 再读 scrollHeight。
  if ('style' in ta) {
    ta.style.height = '0px';
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round((window.innerHeight || 800) * 0.4))}px`;
  }
}

function showBatchDetail(hostId) {
  if (!batchResults.has(hostId)) return;
  batchDetailHostId = hostId;
  renderBatchDetail(true);
  const detail = $('#batch-result-detail');
  detail.scrollIntoView?.({ block: 'nearest' });
  $('#btn-batch-detail-close').focus();
}

function closeBatchDetail() {
  const hostId = batchDetailHostId;
  batchDetailHostId = null;
  $('#batch-result-detail').classList.add('hidden');
  if (hostId != null) batchRow(hostId)?.querySelector('.op button')?.focus();
}

function pruneChecked() {
  const valid = new Set(state.hosts.map((h) => h.id));
  let removed = 0;
  for (const id of [...batchChecked]) {
    if (!valid.has(id)) { batchChecked.delete(id); removed++; }
  }
  return removed;
}

export function openBatchModal() {
  // 会话内保留草稿、搜索、选择与最近一批结果:关闭只隐藏,重开可继续查看;
  // 只有真正发起新批次时才替换上一批结果。仅清掉已删除主机的残留选择。
  pruneChecked();
  renderBatchHosts();
  updateBatchUi();
  openModal('#modal-batch');
}

export function bindBatchUi() {
  $('#batch-search').addEventListener('input', () => renderBatchHosts());
  $('#batch-cmd').addEventListener('input', updateBatchUi);
  $('#batch-parallel').addEventListener('input', () => { applyParamErrors(parseBatchParams().errors); updateBatchUi(); });
  $('#batch-timeout').addEventListener('input', () => { applyParamErrors(parseBatchParams().errors); updateBatchUi(); });
  $('#btn-batch-run').addEventListener('click', runBatch);
  $('#btn-batch-cancel').addEventListener('click', cancelBatch);
  $('#btn-batch-close').addEventListener('click', () => closeModal('#modal-batch'));
  $('#btn-batch-copy').addEventListener('click', async () => {
    const ok = await copyText(serializeBatchResults());
    toast(ok ? '已复制结果' : '复制失败', ok ? 'success' : 'error');
  });
  $('#btn-batch-export').addEventListener('click', exportBatchResults);
  $('#btn-batch-select-matched').addEventListener('click', () => {
    if (activeBatch) return;
    for (const h of batchMatches()) batchChecked.add(h.id);
    renderBatchHosts();
    updateBatchUi();
  });
  $('#btn-batch-clear-sel').addEventListener('click', () => {
    if (activeBatch) return;
    batchChecked.clear();
    renderBatchHosts();
    updateBatchUi();
  });
  $('#btn-batch-detail-copy').addEventListener('click', async () => {
    const ok = await copyText($('#batch-detail-output').value);
    toast(ok ? '已复制结果' : '复制失败', ok ? 'success' : 'error');
  });
  $('#btn-batch-detail-close').addEventListener('click', closeBatchDetail);
}

async function cancelBatch() {
  const batch = activeBatch;
  if (!batch || batch.cancelling) return;
  batch.cancelling = true;
  updateBatchUi();
  $('#batch-status').textContent = '正在取消,等待各主机结果…';
  try { await api('batch:cancel', { requestId: batch.requestId }); }
  catch (e) {
    if (activeBatch === batch) {
      batch.cancelling = false;
      updateBatchUi();
      $('#batch-status').textContent = '取消失败:' + e.message;
    }
  }
}

export async function runBatch() {
  if (activeBatch) return;
  const pruned = pruneChecked();
  if (pruned) {
    renderBatchHosts();
    toast(`已忽略 ${pruned} 台已删除的主机`, 'error');
  }
  const cmd = $('#batch-cmd').value.trim();
  if (!cmd) { $('#batch-cmd').focus(); return toast('请输入命令', 'error'); }
  if (!batchChecked.size) { $('#batch-search').focus(); return toast('请选择目标主机', 'error'); }
  const { errors, parallel, timeout } = parseBatchParams();
  if (Object.keys(errors).length) {
    // 参数不合法就停在表单:不静默换默认值,也不把越界值丢给后端裁剪。
    applyParamErrors(errors);
    $(errors.parallel ? '#batch-parallel' : '#batch-timeout').focus();
    return toast('请先修正标红的参数', 'error');
  }
  // Freeze every mutable form value before starting async work.
  const hostIds = [...batchChecked];
  batchIdentity = new Map(state.hosts.map((h) => [h.id, batchHostLabel(h)]));
  const requestId = `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const batch = { requestId, hostIds: new Set(hostIds), cancelling: false };
  activeBatch = batch;
  batchResults = new Map();
  batchDetailHostId = null;
  $('#batch-summary').textContent = `命令:${cmd} · ${hostIds.length} 台 · 并行 ${parallel} · 超时 ${timeout}s`;
  $('#batch-result-detail').classList.add('hidden');
  $('#batch-empty').classList.add('hidden');
  $('#batch-results').classList.remove('hidden');
  buildPendingRows(batch, hostIds);
  $('#batch-status').textContent = `执行中(0/${hostIds.length})…`;
  updateBatchUi();
  const accept = (result) => {
    if (activeBatch !== batch || !batch.hostIds.has(result.hostId) || (result.requestId && result.requestId !== requestId)) return;
    batchResults.set(result.hostId, { ...result });
    updateResultRow(result);
    if (batchDetailHostId === result.hostId) renderBatchDetail();
    $('#batch-status').textContent = `${batch.cancelling ? '正在取消' : '执行中'}(${batchResults.size}/${hostIds.length})…`;
    updateBatchUi();
  };
  const off = window.nebula.on('batch:progress', accept);
  try {
    const results = await api('batch:exec', { requestId, hostIds, command: cmd, timeoutMs: timeout * 1000, maxParallel: parallel });
    // The final response is authoritative; do not depend on delivery of progress.
    for (const result of results) accept(result);
    for (const hostId of hostIds) {
      if (!batchResults.has(hostId)) accept({ hostId, ok: false, error: '后端未返回此主机的执行结果' });
    }
    const all = [...batchResults.values()];
    const okCount = all.filter((r) => r.ok).length;
    const cancelledCount = all.filter((r) => r.cancelled).length;
    const failCount = all.length - okCount - cancelledCount;
    $('#batch-status').textContent = `完成:${okCount} 成功 / ${failCount} 失败 / ${cancelledCount} 取消`;
    // 主动取消不是执行失败:失败才用错误提示,纯取消用中性文案。
    if (failCount > 0) toast(`批量执行完成(${okCount}/${hostIds.length} 成功)`, 'error');
    else if (cancelledCount > 0) toast('批量执行已结束(含主动取消)', '');
    else toast(`批量执行完成(${okCount}/${hostIds.length} 成功)`, 'success');
  } catch (e) {
    for (const hostId of hostIds) {
      if (!batchResults.has(hostId)) accept({ hostId, ok: false, error: '执行请求失败:' + e.message });
    }
    $('#batch-status').textContent = '执行失败:' + e.message;
  } finally {
    off();
    if (activeBatch === batch) activeBatch = null;
    for (const input of batchHostInputs) input.disabled = false;
    updateBatchUi();
  }
}

/* ---------------- 指纹管理(B6) ---------------- */

export let fwRules = [];

export function forwardRuntimeView(rule, value) {
  // Boolean fallback supports an older backend, but never labels configured :0 active.
  const running = typeof value === 'object' && value !== null ? value.running === true : value === true;
  const port = typeof value === 'object' && value !== null ? value.port : null;
  const host = typeof value === 'object' && value !== null ? (value.bindHost || rule.bindHost) : rule.bindHost;
  const formatHost = (h) => String(h).includes(':') ? `[${h}]` : h;
  const address = running
    ? `${formatHost(host)}:${port > 0 ? port : rule.bindPort > 0 ? rule.bindPort : '实际端口未知'}`
    : `${formatHost(rule.bindHost)}:${rule.bindPort}`;
  return { running, address: address + (rule.type === 'R' ? '(远端)' : ''), port };
}

export async function refreshForwards() {
  fwRules = await api('forwards:list');
  const states = await api('forward:states', { ids: fwRules.map((r) => r.id) }).catch(() => ({}));
  const tbody = $('#fw-tbody');
  tbody.innerHTML = '';
  if (!fwRules.length) $('#fw-table').classList.add('hidden');
  else $('#fw-table').classList.remove('hidden');
  for (const r of fwRules) {
    const runtime = forwardRuntimeView(r, states[r.id]);
    const running = runtime.running;
    const typeLabel = { L: '本地', R: '远程', D: 'SOCKS' }[r.type] || r.type;
    const bind = runtime.address;
    const dest = r.type === 'D' ? '—' : `${r.destHost}:${r.destPort}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.name)}${r.autoStart ? ' <span class="tag">自动</span>' : ''}</td>
      <td><span class="tag">${typeLabel}</span></td><td class="mono">${escapeHtml(bind)}</td>
      <td class="mono">${escapeHtml(dest)}</td>
      <td>${running ? '<span class="badge-run">● 活跃</span>' : '<span class="badge-stop">■ 停止</span>'}</td>
      <td>${running ? '<button class="btn small fw-stop">停止</button>' : '<button class="btn small fw-start">启动</button>'} <button class="btn small fw-del">删除</button></td>`;
    const btn = running ? tr.querySelector('.fw-stop') : tr.querySelector('.fw-start');
    btn.addEventListener('click', async () => {
      try {
        if (running) { await api('forward:stop', { id: r.id }); toast('已停止', 'success'); }
        else {
          const res = await api('forward:start', r);
          const started = forwardRuntimeView(r, { ...res, running: true });
          toast(`已启动,监听 ${started.address}`, 'success');
        }
        refreshForwards();
      } catch (e) { toast('转发失败:' + e.message, 'error'); }
    });
    tr.querySelector('.fw-del').addEventListener('click', async () => {
      if (!(await askConfirm(`删除规则「${r.name}」?`, { title: '删除转发规则', okText: '删除' }))) return;
      await api('forward:stop', { id: r.id }).catch(() => {});
      await api('forwards:delete', { id: r.id });
      refreshForwards();
    });
    tbody.appendChild(tr);
  }
  // 主机选择器
  const sel = $('#fw-host');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const h of state.hosts) {
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `${h.name}(${h.username}@${h.host})`;
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

export async function openForwardModal() {
  await refreshForwards();
  openModal('#modal-forward');
}

export async function saveForwardRule() {
  const bind = $('#fw-bind').value.trim().split(':');
  const bindHost = bind[0] || '127.0.0.1';
  const bindPort = Number(bind[1]) || 0;
  const type = $('#fw-type').value;
  const dest = $('#fw-dest').value.trim().split(':');
  const rule = {
    name: $('#fw-name').value.trim() || `转发${Date.now() % 1000}`,
    type,
    hostId: $('#fw-host').value,
    bindHost, bindPort,
    destHost: type === 'D' ? '' : (dest[0] || ''),
    destPort: type === 'D' ? 0 : (Number(dest[1]) || 0),
    autoStart: $('#fw-auto').checked,
  };
  try {
    await api('forwards:save', rule);
    toast('规则已保存', 'success');
    $('#fw-name').value = '';
    await refreshForwards();
  } catch (e) {
    toast('保存失败:' + e.message, 'error');
  }
}

/* ---------------- 命令历史(F2) ---------------- */

export async function toggleHistory() {
  state.historyOpen = !state.historyOpen;
  let panel = $('#history-panel');
  if (!state.historyOpen) { if (panel) panel.classList.add('hidden'); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'history-panel';
    // 标题栏兼作拖拽把手;带关闭按钮,不必再靠 Esc 或重复点按钮退出
    panel.innerHTML = `
      <div class="pop-head">
        <span class="pop-title">命令历史</span>
        <span class="spacer"></span>
        <input id="hist-search" class="inp" placeholder="过滤历史…" />
        <button id="hist-clear" class="btn sm">清空</button>
        <button id="hist-close" class="btn icon" title="关闭">${icon('x')}</button>
      </div>
      <div id="hist-list"></div>`;
    $('#term-stack').appendChild(panel);
    makeDraggable(panel, panel.querySelector('.pop-head'));
    panel.querySelector('#hist-search').addEventListener('input', (e) => renderHistory(e.target.value));
    panel.querySelector('#hist-close').addEventListener('click', () => toggleHistory());
    panel.querySelector('#hist-clear').addEventListener('click', async () => {
      if (!(await askConfirm('清空全部命令历史?', { title: '清空历史', okText: '清空' }))) return;
      await api('history:clear');
      renderHistory('');
    });
  }
  panel.classList.remove('hidden');
  renderHistory('');
}

export async function renderHistory(kw) {
  const list = await api('history:list', { kw });
  const box = $('#hist-list');
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="file-empty">暂无历史</div>'; return; }
  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<span class="h-cmd"></span><span class="h-meta">${escapeHtml(h.host || '')}</span>`;
    row.querySelector('.h-cmd').textContent = h.cmd;
    row.addEventListener('click', async () => {
      const s = state.sessions.get(state.activeId);
      if (!s || s.status !== 'connected') return toast('请先连接主机', 'error');
      if (await writeSessionInput(s.sessionId, h.cmd)) {
        state.historyOpen = false;
        $('#history-panel')?.classList.add('hidden');
      }
    });
    box.appendChild(row);
  }
}

/* ---------------- 只读(D9) / 清屏(D4) / 日志(J1) ---------------- */

