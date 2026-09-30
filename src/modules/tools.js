// 批量执行、命令历史、端口转发
import { $, api, askConfirm, makeDraggable, openModal, state, stripFpMark, toast } from './core.js';
import { escapeHtml } from './hosts.js';

export let batchChecked = new Set();

export function renderBatchHosts(kw) {
  const box = $('#batch-hosts');
  box.innerHTML = '';
  for (const h of state.hosts) {
    const label = `${h.name} · ${h.username}@${h.host}`;
    if (kw && !label.toLowerCase().includes(String(kw).toLowerCase())) continue;
    const el = document.createElement('label');
    el.innerHTML = `<input type="checkbox" value="${h.id}" ${batchChecked.has(h.id) ? 'checked' : ''}/><span>${escapeHtml(label)}</span>`;
    el.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) batchChecked.add(h.id); else batchChecked.delete(h.id);
    });
    box.appendChild(el);
  }
}

export function openBatchModal() {
  batchChecked = new Set();
  renderBatchHosts('');
  $('#batch-cmd').value = '';
  $('#batch-results').classList.add('hidden');
  $('#batch-tbody').innerHTML = '';
  $('#batch-status').textContent = '';
  openModal('#modal-batch');
}

export async function runBatch() {
  const cmd = $('#batch-cmd').value.trim();
  if (!cmd) return toast('请输入命令', 'error');
  if (!batchChecked.size) return toast('请选择目标主机', 'error');
  const hostIds = [...batchChecked];
  const timeoutMs = (Number($('#batch-timeout').value) || 30) * 1000;
  $('#btn-batch-run').disabled = true;
  $('#batch-status').textContent = `执行中(0/${hostIds.length})…`;
  const done = [];
  const table = $('#batch-results');
  table.classList.remove('hidden');
  const tbody = $('#batch-tbody');
  tbody.innerHTML = '';
  const rowFor = (hostId) => {
    let tr = tbody.querySelector(`tr[data-h="${hostId}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.h = hostId;
      tbody.appendChild(tr);
    }
    return tr;
  };
  const off = window.nebula.on('batch:progress', (p) => {
    done.push(p);
    $('#batch-status').textContent = `执行中(${done.length}/${hostIds.length})…`;
    const tr = rowFor(p.hostId);
    // 错误串可能带指纹变更的可机读标记,展示前剥掉(批量场景不弹恢复框,
    // 也不该让用户看到 [NB-FP …] 这种内部编码)。
    const detail = stripFpMark(p.output || p.error || '');
    tr.innerHTML = `<td>${escapeHtml(p.host)}</td><td>${p.ok ? '<span class="tag ok">成功</span>' : `<span class="tag p1">失败 ${p.code != null ? 'code ' + p.code : ''}</span>`}</td><td>${p.ms}ms</td><td class="out" title="${escapeHtml(detail)}">${escapeHtml(detail.slice(0, 120))}</td>`;
  });
  try {
    const results = await api('batch:exec', { hostIds, command: cmd, timeoutMs, maxParallel: Number($('#batch-parallel').value) || 5 });
    off();
    const okCount = results.filter((r) => r.ok).length;
    $('#batch-status').textContent = `完成:${okCount} 成功 / ${results.length - okCount} 失败`;
    toast(`批量执行完成(${okCount}/${results.length} 成功)`, okCount === results.length ? 'success' : 'error');
  } catch (e) {
    off();
    $('#batch-status').textContent = '执行失败:' + e.message;
  } finally {
    $('#btn-batch-run').disabled = false;
  }
}

/* ---------------- 指纹管理(B6) ---------------- */

export let fwRules = [];

export async function refreshForwards() {
  fwRules = await api('forwards:list');
  const states = await api('forward:states', { ids: fwRules.map((r) => r.id) }).catch(() => ({}));
  const tbody = $('#fw-tbody');
  tbody.innerHTML = '';
  if (!fwRules.length) $('#fw-table').classList.add('hidden');
  else $('#fw-table').classList.remove('hidden');
  for (const r of fwRules) {
    const running = states[r.id];
    const typeLabel = { L: '本地', R: '远程', D: 'SOCKS' }[r.type] || r.type;
    const bind = r.type === 'R' ? `${r.bindHost}:${r.bindPort}(远端)` : `${r.bindHost}:${r.bindPort}`;
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
        else { const res = await api('forward:start', r); toast(`已启动,监听 ${res.port}`, 'success'); }
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
        <span class="pop-title">🕘 命令历史</span>
        <span class="spacer"></span>
        <input id="hist-search" class="inp" placeholder="过滤历史…" />
        <button id="hist-clear" class="btn sm">清空</button>
        <button id="hist-close" class="btn icon" title="关闭">✕</button>
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
    row.addEventListener('click', () => {
      const s = state.sessions.get(state.activeId);
      if (!s || s.status !== 'connected') return toast('请先连接主机', 'error');
      api('ssh:write', { sessionId: s.sessionId, data: h.cmd }).catch(() => {});
      toggleHistory();
    });
    box.appendChild(row);
  }
}

/* ---------------- 只读(D9) / 清屏(D4) / 日志(J1) ---------------- */

