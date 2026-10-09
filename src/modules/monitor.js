// 资源监控:指标采集与监控条
import { $, api, state, toast } from './core.js';
import { feedTrusted } from './terminal.js';
import { icon } from '../shared/icons.js';

// 状态栏数值一律定长展示:最多 1 位小数、去掉无意义的尾 .0(100.0→100)。
// 多位小数既挤占槽位也让数字难以速读,这里统一收口。
function trim1(v) {
  const s = Number(v).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function fmtPct(v) {
  return v == null ? '…' : trim1(v) + '%';
}

export function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return Math.round(n) + 'B/s';
  const units = ['KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // ≥100 的量级小数没有信息量,削掉能让 100GbE 这类速率仍留在窄槽内
  return (v >= 100 ? Math.round(v) : trim1(v)) + units[i];
}

// 内存 used/total:MB 值 ≥1GB 就整对换算成 GB(如 (488/976MB)→(4.9/9.5GB)),
// 槽位更短、与磁盘详情同一量纲;两端必须同单位,否则括号里的比值没有意义。
export function fmtMemPair(usedMB, totalMB) {
  if (usedMB == null || totalMB == null) return '';
  if (totalMB >= 1024) return `(${trim1(usedMB / 1024)}/${trim1(totalMB / 1024)}GB)`;
  return `(${Math.round(usedMB)}/${Math.round(totalMB)}MB)`;
}

// 磁盘 used/total:总量 ≥1TB 换 TB(100TB 盘不再写成 (102400/102400GB)),否则 GB。
export function fmtDiskPair(usedGB, totalGB) {
  if (usedGB == null || totalGB == null) return '';
  if (totalGB >= 1024) return `(${trim1(usedGB / 1024)}/${trim1(totalGB / 1024)}TB)`;
  return `(${trim1(usedGB)}/${trim1(totalGB)}GB)`;
}

// 连接延迟:<1s 用 ms(整数),1-10s 用 1 位小数,更大直接取整秒 ——
// 保证任何取值都不超过 5 字符,不突破定宽槽。
export function fmtLat(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 10000) return trim1(ms / 1000) + 's';
  return Math.round(ms / 1000) + 's';
}

/// 常用命令是右侧工具栏的一个页签(见 right-panel.js),执行后页签保持打开,
/// 焦点回到终端,方便接着看输出或继续输入。
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
    row.innerHTML = `<span class="s-name"></span><span class="s-cmd"></span><button class="s-del" type="button" title="删除" aria-label="删除">${icon('trash', { size: 13 })}</button>`;
    row.querySelector('.s-name').textContent = s.name;
    row.querySelector('.s-cmd').textContent = s.cmd;
    row.title = `${s.cmd}\n点击在当前终端执行`;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.s-del')) return;
      const r = await feedTrusted(s.cmd, { execute: true });
      if (!r.ok) toast(r.reason, 'error');
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
  // 延迟按阈值着色(<150ms 绿 / <400ms 琥珀 / 更高红),链路质量不用读数字也能感知
  const setLat = (ms) => {
    const el = $('#mon-lat');
    el.textContent = fmtLat(ms);
    el.title = ms == null ? '' : `连接延迟(echo 往返):${fmtLat(ms)}`;
    el.classList.toggle('lat-ok', ms != null && ms < 150);
    el.classList.toggle('lat-mid', ms != null && ms >= 150 && ms < 400);
    el.classList.toggle('lat-bad', ms != null && ms >= 400);
  };
  const w = (id, pct) => { $(id).style.width = (pct == null ? 0 : Math.min(100, pct)) + '%'; };
  let hist = state.metricHistory.get(state.activeId) || [];
  if (!m) {
    bar.classList.remove('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    setLat(null);
    set('#mon-note', ''); set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  if (m.supported === false) {
    // 整条切到"不支持"布局:数值槽位隐藏,避免终态文案把长条撑成两行。
    // 延迟例外:echo 往返不依赖 /proc,非 Linux 主机照样有实时延迟可看。
    bar.classList.add('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    setLat(m.latencyMs);
    set('#mon-note', '该主机暂不支持资源监控(仅支持 Linux)');
    set('#mon-spark-cpu', '');
    w('#mon-cpu-bar', 0); w('#mon-mem-bar', 0);
    return;
  }
  bar.classList.remove('mon-unsupported');
  hist = [...hist, m.cpuPct == null ? 0 : m.cpuPct].slice(-32);
  state.metricHistory.set(state.activeId, hist);
  // 标签与数值分开槽位:数值统一走定宽格式化(≤1 位小数、去尾 .0),
  // 任何取值都只在自己槽内变化,不推动邻居。
  setV('#mon-cpu', fmtPct(m.cpuPct));
  setV('#mon-mem', fmtPct(m.memPct));
  setV('#mon-mem-det', fmtMemPair(m.memUsedMB, m.memTotalMB));
  setV('#mon-disk', m.diskPct == null ? '–' : fmtPct(m.diskPct));
  setV('#mon-disk-det', fmtDiskPair(m.diskUsedGB, m.diskTotalGB));
  setV('#mon-rx', fmtBytes(m.rxBps));
  setV('#mon-tx', fmtBytes(m.txBps));
  setLat(m.latencyMs);
  set('#mon-note', '');
  set('#mon-spark-cpu', spark(hist));
  w('#mon-cpu-bar', m.cpuPct);
  w('#mon-mem-bar', m.memPct);
}

/* ---------------- AI 设置弹窗 ---------------- */

