// 资源监控:指标采集与监控条
import { $, api, state, toast } from './core.js';

export function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return n + 'B/s';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB/s';
  return (n / 1024 / 1024).toFixed(1) + 'MB/s';
}

export function closeSnippetMenu() {
  const menu = $('#snippet-menu');
  if (menu) menu.classList.add('hidden');
}

export function renderSnippets() {
  const list = $('#snippet-list');
  list.innerHTML = '';
  const items = (state.settings && state.settings.snippets) || [];
  if (!items.length) {
    list.innerHTML = '<div class="file-empty">还没有常用命令，在下方添加</div>';
    return;
  }
  for (const s of items) {
    const row = document.createElement('div');
    row.className = 'snippet-row';
    row.innerHTML = `<span class="s-name"></span><span class="s-cmd"></span><button class="s-del" title="删除">🗑</button>`;
    row.querySelector('.s-name').textContent = s.name;
    row.querySelector('.s-cmd').textContent = s.cmd;
    row.addEventListener('click', async (e) => {
      if (e.target.classList.contains('s-del')) return;
      const cur = state.sessions.get(state.activeId);
      if (!cur || cur.status !== 'connected') return toast('请先连接主机', 'error');
      await api('ssh:write', { sessionId: cur.sessionId, data: s.cmd + '\r' }).catch(() => {});
      closeSnippetMenu();
    });
    row.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      state.settings.snippets = items.filter((x) => x !== s);
      await saveSnippets();
    });
    list.appendChild(row);
  }
}

export async function saveSnippets() {
  state.settings = await api('settings:save', { snippets: state.settings.snippets });
  renderSnippets();
}

export async function addSnippet() {
  const name = $('#snippet-name').value.trim();
  const cmd = $('#snippet-cmd').value.trim();
  if (!name || !cmd) return toast('请填写名称和命令', 'error');
  const items = (state.settings && state.settings.snippets) || [];
  items.push({ name, cmd });
  state.settings.snippets = items;
  $('#snippet-name').value = '';
  $('#snippet-cmd').value = '';
  await saveSnippets();
}

/* ---------------- SFTP 文件面板 ---------------- */

export function spark(values) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (!values || !values.length) return '';
  return values.slice(-16).map((v) => blocks[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))]).join('');
}

export function renderMonitorBar() {
  const bar = $('#monitor-bar');
  if (!state.monitorVisible || !state.activeId) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const m = state.metrics.get(state.activeId);
  const set = (id, txt) => { $(id).textContent = txt; };
  const w = (id, pct) => { $(id).style.width = (pct == null ? 0 : Math.min(100, pct)) + '%'; };
  let hist = state.metricHistory.get(state.activeId) || [];
  if (!m) {
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    set('#mon-note', ''); set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  if (m.supported === false) {
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    set('#mon-note', '该主机暂不支持资源监控(仅支持 Linux)');
    set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  hist = [...hist, m.cpuPct == null ? 0 : m.cpuPct].slice(-32);
  state.metricHistory.set(state.activeId, hist);
  set('#mon-cpu', m.cpuPct == null ? '…' : m.cpuPct + '%');
  set('#mon-mem', m.memPct == null ? '…' : `${m.memPct}%(${m.memUsedMB}/${m.memTotalMB}MB)`);
  set('#mon-disk', m.diskPct == null ? '–' : `${m.diskPct}%(${m.diskUsedGB}/${m.diskTotalGB}GB)`);
  set('#mon-rx', fmtBytes(m.rxBps));
  set('#mon-tx', fmtBytes(m.txBps));
  set('#mon-note', '');
  set('#mon-spark-cpu', spark(hist));
  w('#mon-cpu-bar', m.cpuPct);
  w('#mon-mem-bar', m.memPct);
}

/* ---------------- AI 设置弹窗 ---------------- */

