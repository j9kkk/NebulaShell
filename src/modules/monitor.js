// 资源监控:指标采集与监控条
import { $, api, makeDraggable, state, toast } from './core.js';

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

/// 打开/收起片段面板。首次打开时把标题栏注册为拖拽把手 ——
/// 面板固定在左上角会遮住主机列表,用户必须能把它挪开。
export function toggleSnippetMenu() {
  const menu = $('#snippet-menu');
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if (opening) {
    makeDraggable(menu, menu.querySelector('.pop-head'));
    renderSnippets();
  }
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
  // 监控固定显示在状态栏,不再有开关(旧 #btn-monitor 已移除)。
  // 无活动会话时隐藏:此时状态栏显示"就绪 — 尚未建立连接",监控块没有意义。
  if (!state.activeId) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const m = state.metrics.get(state.activeId);
  const set = (id, txt) => { $(id).textContent = txt; };
  // 数值槽是定长的,超大主机(如 100TB 盘)的详情可能被裁掉;裁切时把完整值放进
  // title,悬停仍可读到精确数字 —— 定长换来的稳定不该以丢信息为代价。
  const setV = (id, txt) => { const el = $(id); el.textContent = txt; el.title = txt; };
  const w = (id, pct) => { $(id).style.width = (pct == null ? 0 : Math.min(100, pct)) + '%'; };
  let hist = state.metricHistory.get(state.activeId) || [];
  if (!m) {
    bar.classList.remove('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    set('#mon-note', ''); set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  if (m.supported === false) {
    // 整条切到"不支持"布局:数值槽位隐藏,避免终态文案把长条撑成两行
    bar.classList.add('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    set('#mon-note', '该主机暂不支持资源监控(仅支持 Linux)');
    set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  bar.classList.remove('mon-unsupported');
  hist = [...hist, m.cpuPct == null ? 0 : m.cpuPct].slice(-32);
  state.metricHistory.set(state.activeId, hist);
  // 百分号与括号详情分开写:两者各自有定长槽位,单位从 % 跳到 (n/m) 也不会推动邻居
  setV('#mon-cpu', m.cpuPct == null ? '…' : m.cpuPct + '%');
  setV('#mon-mem', m.memPct == null ? '…' : `${m.memPct}%`);
  setV('#mon-mem-det', m.memUsedMB == null ? '' : `(${m.memUsedMB}/${m.memTotalMB}MB)`);
  setV('#mon-disk', m.diskPct == null ? '–' : `${m.diskPct}%`);
  setV('#mon-disk-det', m.diskUsedGB == null ? '' : `(${m.diskUsedGB}/${m.diskTotalGB}GB)`);
  setV('#mon-rx', fmtBytes(m.rxBps));
  setV('#mon-tx', fmtBytes(m.txBps));
  set('#mon-note', '');
  set('#mon-spark-cpu', spark(hist));
  w('#mon-cpu-bar', m.cpuPct);
  w('#mon-mem-bar', m.memPct);
}

/* ---------------- AI 设置弹窗 ---------------- */

