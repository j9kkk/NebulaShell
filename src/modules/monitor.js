// 资源监控:指标采集与监控条
import { $, api, askPrompt, closeModal, openModal, state, toast } from './core.js';
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

/// 常用命令是右侧工具栏的一个页签(见 right-panel.js)。行内三按钮:
/// ▶ 执行(主操作) / ✏ 编辑 / 🗑 删除,三者常显。整行点击不执行 ——
/// 避免在远程主机上误触;执行只认 ▶。编辑在行内原地把名称/命令文本换成
/// 输入框(单行,与展示行同构),同一时间只允许一行处于编辑态:
/// inputs 只存在于 DOM,开始另一行的编辑即丢弃未保存的修改。
let editingSnippet = null;

/// 收藏自命令历史时的默认名称:全文截 16 字符(超出加 …),用户可用 ✏ 改名。
export function snippetNameFor(cmd) {
  const t = String(cmd).trim();
  return t.length > 16 ? t.slice(0, 16) + '…' : t;
}

/// 命令是否已在常用命令中(历史页签 ★ 的点亮态依据)。
export function isSnippetCmd(cmd) {
  const t = String(cmd).trim();
  return (state.settings?.snippets || []).some((s) => s.cmd === t);
}

/// 从命令历史一键收藏(见 tools.js renderHistory 的 ★):先弹名称输入框,确认后
/// 才保存 —— 预填命令前 16 字符并全选,直接输入即覆盖,取消/关弹窗不保存。
/// 命令相同视为已收藏,只提示、不弹框(删除入口只在常用命令页签)。
export async function addSnippetFromCmd(cmd) {
  const t = String(cmd).trim();
  if (!t) return false;
  const items = state.settings.snippets || [];
  if (items.some((s) => s.cmd === t)) { toast('该命令已在常用命令中', 'info'); return false; }
  const base = snippetNameFor(t);
  // 弹窗里放命令原文(超长截断)让用户确认存的是什么;名称沿用编辑态的 50 字上限
  const shown = t.length > 160 ? t.slice(0, 160) + '…' : t;
  const raw = await askPrompt(shown, {
    title: '存为常用命令',
    okText: '保存',
    password: false,
    value: base,
    placeholder: '请输入名称',
    validate: (v) => {
      const s = v.trim();
      if (!s) return '请输入名称';
      if (s.length > 50) return '名称不能超过 50 字符';
      return null;
    },
  });
  if (raw == null) return false;
  let name = raw.trim();
  for (let n = 2; items.some((s) => s.name === name); n++) name = `${name}(${n})`;
  items.push({ name, cmd: t.slice(0, 2000) });
  state.settings.snippets = items;
  await saveSnippets();
  toast(`已加入常用命令：${name}`, 'success');
  return true;
}

export function openSnippetsModal() {
  closeModal('#modal-history');   // 两个管理弹窗互斥:同时叠开会互相遮挡且焦点游移
  openModal('#modal-snippets');
  renderSnippets();
  const search = $('#snippet-search');
  if (search) {
    search.focus();
    search.select?.();
  }
}

export function renderSnippets() {
  const list = $('#snippet-list');
  if (!list) return;
  list.innerHTML = '';
  const all = (state.settings && state.settings.snippets) || [];
  // 过滤词留在输入框里(弹窗或页签切换不丢);名称、命令都做不区分大小写的子串匹配。
  const kw = ($('#snippet-search')?.value || '').trim().toLowerCase();
  const items = kw ? all.filter((s) => `${s.name || ''}\n${s.cmd || ''}`.toLowerCase().includes(kw)) : all;
  if (!all.length) {
    list.innerHTML = '<div class="file-empty">还没有常用命令，在下方添加或从命令历史收藏</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="file-empty">没有匹配的常用命令，换个关键词试试。</div>';
    return;
  }
  for (const s of items) {
    const row = document.createElement('div');
    if (editingSnippet === s) {
      row.className = 'snippet-row editing';
      renderSnippetEditor(row, s);
    } else {
      row.className = 'snippet-row';
      row.innerHTML = `<span class="s-name"></span><span class="s-cmd"></span>`
        + `<button class="s-exec" type="button" title="在当前终端执行" aria-label="在当前终端执行">${icon('play', { size: 14 })}</button>`
        + `<button class="s-edit" type="button" title="编辑" aria-label="编辑">${icon('pencil', { size: 14 })}</button>`
        + `<button class="s-del" type="button" title="删除" aria-label="删除">${icon('trash', { size: 14 })}</button>`;
      row.querySelector('.s-name').textContent = s.name;
      row.querySelector('.s-cmd').textContent = s.cmd;
      row.title = s.cmd;
      row.querySelector('.s-exec').addEventListener('click', async () => {
        // 模态打开期间终端拒写(见 commandBlockTargetAvailability),先收起本弹窗再投递
        if ($('#modal-snippets') && !$('#modal-snippets').classList.contains('hidden')) {
          closeModal('#modal-snippets');
        }
        const r = await feedTrusted(s.cmd, { execute: true });
        if (!r.ok) toast(r.reason, 'error');
      });
      row.querySelector('.s-edit').addEventListener('click', () => {
        editingSnippet = s;
        renderSnippets();
      });
      row.querySelector('.s-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (editingSnippet === s) editingSnippet = null;
        state.settings.snippets = items.filter((x) => x !== s);
        await saveSnippets();
      });
    }
    list.appendChild(row);
  }
}

/// 行内编辑态:输入框原地替换名称/命令文本(单行,与展示行同构),输入框为空时
/// 显示占位提示。编辑态只保留保存/取消两个按钮(▶/✏/🗑 不在)。
/// Enter 保存、Esc 取消(preventDefault 挡住右侧栏根节点的 Esc 处理器)。
function renderSnippetEditor(row, s) {
  row.innerHTML = `<input class="s-edit-name" type="text" maxlength="50" placeholder="请输入名称" aria-label="命令名称" />`
    + `<input class="s-edit-cmd" type="text" maxlength="2000" placeholder="请输入命令" aria-label="命令内容" />`
    + `<button class="s-save" type="button" title="保存" aria-label="保存">${icon('check', { size: 14 })}</button>`
    + `<button class="s-cancel" type="button" title="取消" aria-label="取消">${icon('x', { size: 14 })}</button>`;
  const nameInput = row.querySelector('.s-edit-name');
  const cmdInput = row.querySelector('.s-edit-cmd');
  nameInput.value = s.name;
  cmdInput.value = s.cmd;
  const close = () => { editingSnippet = null; renderSnippets(); };
  const save = async () => {
    const name = nameInput.value.trim();
    const cmd = cmdInput.value.trim();
    if (!name || !cmd) return toast('请填写名称和命令', 'error');
    s.name = name;
    s.cmd = cmd;
    close();
    await saveSnippets();
  };
  row.querySelector('.s-save').addEventListener('click', save);
  row.querySelector('.s-cancel').addEventListener('click', close);
  for (const input of [nameInput, cmdInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === 'Enter') { event.preventDefault(); save(); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
  }
  nameInput.focus();
  nameInput.select();
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

const RING_CIRC = 47.12; // 2 * Math.PI * 7.5

function setRing(id, pct) {
  const ring = $(id);
  if (!ring) return;
  const fg = ring.querySelector?.('.mon-ring-fg');
  if (pct == null) {
    if (fg) fg.style.strokeDashoffset = String(RING_CIRC);
    ring.classList?.remove('ring-warn', 'ring-danger');
    return;
  }
  const clamped = Math.min(100, Math.max(0, pct));
  if (fg) fg.style.strokeDashoffset = (RING_CIRC * (1 - clamped / 100)).toFixed(2);
  ring.classList?.toggle('ring-warn', clamped >= 70 && clamped < 85);
  ring.classList?.toggle('ring-danger', clamped >= 85);
}

function buildSplinePath(coords, W, H) {
  if (!coords || !coords.length) return { dLine: '', dArea: '' };
  let dLine = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = coords[i];
    const [x1, y1] = coords[i + 1];
    const cx = Number(((x0 + x1) / 2).toFixed(1));
    dLine += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
  }
  const dArea = `${dLine} L ${W} ${H} L 0 ${H} Z`;
  return { dLine, dArea };
}

export function calcNetCeiling(maxBps) {
  if (!maxBps || maxBps <= 10240) return 10240; // 10 KB/s
  let unit = 1024;
  while (maxBps >= unit * 1024 && unit < 1024 * 1024 * 1024) {
    unit *= 1024;
  }
  const val = maxBps / unit;
  const mag = Math.pow(10, Math.floor(Math.log10(val)));
  const norm = val / mag;
  let factor = 10;
  if (norm <= 1) factor = 1;
  else if (norm <= 2) factor = 2;
  else if (norm <= 5) factor = 5;
  else factor = 10;
  return Math.max(10240, factor * mag * unit);
}

function fmtDrawerPct(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${Number(v).toFixed(1)}%`;
}

function plotDrawerSeries(vals, maxVal, lineEl, areaEl, ptEl) {
  const W = 260;
  const H = 64;
  const padX = 5;
  const padY = 6;
  const plotW = W - padX * 2;
  const plotH = H - padY * 2;
  if (!vals || !vals.length) {
    if (lineEl) lineEl.setAttribute('d', '');
    if (areaEl) areaEl.setAttribute('d', '');
    if (ptEl) { ptEl.setAttribute('cx', '-10'); ptEl.setAttribute('cy', '-10'); }
    return;
  }
  const pts = vals.length === 1 ? [vals[0], vals[0]] : vals;
  const ceil = maxVal > 0 ? maxVal : 100;
  const coords = pts.map((v, i) => {
    const x = padX + (i / (pts.length - 1)) * plotW;
    const clamped = Math.min(ceil, Math.max(0, v));
    const y = H - padY - (clamped / ceil) * plotH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const { dLine } = buildSplinePath(coords, W, H);
  const firstX = coords[0][0];
  const lastX = coords[coords.length - 1][0];
  const dArea = `${dLine} L ${lastX} ${H} L ${firstX} ${H} Z`;
  if (lineEl) lineEl.setAttribute('d', dLine);
  if (areaEl) areaEl.setAttribute('d', dArea);
  if (ptEl) {
    const last = coords[coords.length - 1];
    ptEl.setAttribute('cx', String(last[0]));
    ptEl.setAttribute('cy', String(last[1]));
  }
}

/// 刷新右侧「监控」抽屉(E3):主机状态头卡、双层故障诊断卡、CPU/内存/磁盘/网络趋势图。
/// 所有 DOM 访问均空值安全,兼容单元测试轻量 mock 环境。
export function renderMonitorDrawer() {
  const page = $('#rp-monitor');
  if (!page) return;
  const active = state.activeId ? state.sessions.get(state.activeId) : null;
  const dot = $('#rp-mon-status-dot');
  const hostEl = $('#rp-mon-host');
  const pill = $('#rp-mon-state-pill');
  const heroSub = $('#rp-mon-hero-sub');
  const latEl = $('#rp-mon-lat');
  const addrEl = $('#rp-mon-addr');
  const emptyEl = $('#rp-mon-empty');
  const diagCard = $('#rp-diag-card');
  const unsupEl = $('#rp-mon-unsupported');
  const cardsEl = $('#rp-mon-cards');
  const tabDot = $('#rp-mon-dot');

  const setText = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };

  if (!active) {
    if (dot) dot.className = 'dot idle';
    if (hostEl) hostEl.textContent = '尚未建立连接';
    if (pill) { pill.textContent = '未连接'; pill.dataset.state = 'idle'; }
    heroSub?.classList?.add('hidden');
    setText('#rp-mon-empty-title', '暂无实时监控数据');
    setText('#rp-mon-empty-desc', '从左侧主机列表连接任意 SSH 会话后，将自动展示 CPU、内存、磁盘、网络趋势与连接诊断。');
    emptyEl?.classList?.remove('hidden');
    diagCard?.classList?.add('hidden');
    unsupEl?.classList?.add('hidden');
    cardsEl?.classList?.add('hidden');
    if (tabDot) { tabDot.classList.add('hidden'); tabDot.dataset.state = 'idle'; }
    return;
  }

  emptyEl?.classList?.add('hidden');
  const h = active.host || {};
  const addr = h.host ? `${h.username ? `${h.username}@` : ''}${h.host}:${h.port || 22}` : '';
  const hostTitle = h.name || active.label || addr || '当前会话';
  const status = active.status || 'disconnected';
  const connected = status === 'connected';
  const connecting = status === 'connecting';

  if (dot) dot.className = `dot ${status}`;
  if (hostEl) { hostEl.textContent = hostTitle; hostEl.title = addr || hostTitle; }
  if (pill) {
    pill.textContent = connected ? '已连接' : connecting ? '连接中' : '已断开';
    pill.dataset.state = connected ? 'connected' : connecting ? 'connecting' : 'disconnected';
  }
  if (addrEl) { addrEl.textContent = addr; addrEl.title = addr; }
  if (tabDot) {
    tabDot.classList.remove('hidden');
    tabDot.dataset.state = connected ? 'connected' : connecting ? 'connecting' : 'disconnected';
  }

  // 非连接态:connecting 显示连接过渡态,disconnected / error 显示双层故障诊断卡
  if (!connected) {
    heroSub?.classList?.add('hidden');
    unsupEl?.classList?.add('hidden');
    cardsEl?.classList?.add('hidden');
    if (connecting) {
      diagCard?.classList?.add('hidden');
      setText('#rp-mon-empty-title', '正在建立 SSH 连接…');
      setText('#rp-mon-empty-desc', '握手完成后将自动开始采集 CPU、内存、磁盘与网络指标。');
      emptyEl?.classList?.remove('hidden');
      return;
    }
    diagCard?.classList?.remove('hidden');
    const summary = active._diagSummary || (active.manualDisconnect ? '已手动断开连接' : '连接已断开');
    const raw = active._diagRaw || (active.manualDisconnect ? '' : String(active.lastError || ''));
    setText('#rp-diag-summary', summary);
    setText('#rp-diag-sub', active.manualDisconnect
      ? '你已主动断开当前会话，随时可以一键重连。'
      : '检查网络连通性、端口或凭据，或交由 AI 排查。');
    setText('#rp-diag-target', addr || hostTitle);
    setText('#rp-diag-status', status);
    setText('#rp-diag-raw', raw || '无额外底层错误输出（正常关闭或手动断开）');
    return;
  }

  // 已连接态:隐藏诊断卡,展示延迟 + 四张实时趋势卡
  diagCard?.classList?.add('hidden');
  heroSub?.classList?.remove('hidden');
  const m = state.metrics.get(state.activeId);
  if (latEl) {
    const ms = m?.latencyMs;
    latEl.textContent = fmtLat(ms);
    latEl.classList.toggle('lat-ok', ms != null && ms < 75);
    latEl.classList.toggle('lat-mid', ms != null && ms >= 75 && ms < 200);
    latEl.classList.toggle('lat-bad', ms != null && ms >= 200);
  }
  if (m && m.supported === false) {
    unsupEl?.classList?.remove('hidden');
    cardsEl?.classList?.add('hidden');
    return;
  }
  unsupEl?.classList?.add('hidden');
  cardsEl?.classList?.remove('hidden');

  const rawHist = state.metricHistory.get(state.activeId);
  const cpuHist = (Array.isArray(rawHist) ? rawHist : (rawHist?.cpu || [])).slice(-24);
  const memHist = (Array.isArray(rawHist) ? [] : (rawHist?.mem || [])).slice(-24);
  const rxHist = (Array.isArray(rawHist) ? [] : (rawHist?.rx || [])).slice(-24);
  const txHist = (Array.isArray(rawHist) ? [] : (rawHist?.tx || [])).slice(-24);

  // CPU 卡
  setText('#rp-mon-cpu-val', m ? fmtDrawerPct(m.cpuPct) : '–');
  if (cpuHist.length && m?.cpuPct != null) {
    const maxCpu = Math.max(...cpuHist);
    const avgCpu = cpuHist.reduce((a, b) => a + b, 0) / cpuHist.length;
    setText('#rp-mon-cpu-max', fmtDrawerPct(maxCpu));
    setText('#rp-mon-cpu-avg', fmtDrawerPct(avgCpu));
    plotDrawerSeries(cpuHist, 100, $('#rp-mon-cpu-line'), $('#rp-mon-cpu-area'), $('#rp-mon-cpu-pt'));
  } else {
    setText('#rp-mon-cpu-max', '–');
    setText('#rp-mon-cpu-avg', '–');
    plotDrawerSeries([], 100, $('#rp-mon-cpu-line'), $('#rp-mon-cpu-area'), $('#rp-mon-cpu-pt'));
  }

  // 内存卡
  setText('#rp-mon-mem-val', m ? fmtDrawerPct(m.memPct) : '–');
  setText('#rp-mon-mem-det', m ? fmtMemPair(m.memUsedMB, m.memTotalMB) : '');
  if (memHist.length && m?.memPct != null) {
    setText('#rp-mon-mem-max', fmtDrawerPct(Math.max(...memHist)));
    if (m.memUsedMB != null && m.memTotalMB != null) {
      const availMB = Math.max(0, m.memTotalMB - m.memUsedMB);
      setText('#rp-mon-mem-avail', m.memTotalMB >= 1024 ? `${trim1(availMB / 1024)}GB` : `${Math.round(availMB)}MB`);
    } else {
      setText('#rp-mon-mem-avail', fmtDrawerPct(100 - m.memPct));
    }
    plotDrawerSeries(memHist, 100, $('#rp-mon-mem-line'), $('#rp-mon-mem-area'), $('#rp-mon-mem-pt'));
  } else {
    setText('#rp-mon-mem-max', '–');
    setText('#rp-mon-mem-avail', '–');
    plotDrawerSeries([], 100, $('#rp-mon-mem-line'), $('#rp-mon-mem-area'), $('#rp-mon-mem-pt'));
  }

  // 磁盘卡
  const diskPct = m?.diskPct;
  setText('#rp-mon-disk-val', diskPct == null ? '–' : fmtDrawerPct(diskPct));
  setText('#rp-mon-disk-det', m ? fmtDiskPair(m.diskUsedGB, m.diskTotalGB) : '');
  if (m && m.diskUsedGB != null && m.diskTotalGB != null) {
    const availGB = Math.max(0, m.diskTotalGB - m.diskUsedGB);
    setText('#rp-mon-disk-avail', availGB >= 1024 ? `${trim1(availGB / 1024)}TB` : `${trim1(availGB)}GB`);
  } else {
    setText('#rp-mon-disk-avail', '–');
  }
  const diskFill = $('#rp-mon-disk-fill');
  if (diskFill) {
    const pct = diskPct == null ? 0 : Math.max(0, Math.min(100, diskPct));
    diskFill.style.width = `${pct}%`;
    diskFill.classList.toggle('warn', pct >= 70 && pct < 90);
    diskFill.classList.toggle('hot', pct >= 90);
  }

  // 网络吞吐卡
  setText('#rp-mon-net-rx', m ? fmtBytes(m.rxBps) : '–');
  setText('#rp-mon-net-tx', m ? fmtBytes(m.txBps) : '–');
  if ((rxHist.length || txHist.length) && m && (m.rxBps != null || m.txBps != null)) {
    const maxRx = rxHist.length ? Math.max(...rxHist) : (m.rxBps || 0);
    const maxTx = txHist.length ? Math.max(...txHist) : (m.txBps || 0);
    const ceiling = calcNetCeiling(Math.max(maxRx, maxTx, m.rxBps || 0, m.txBps || 0));
    setText('#rp-mon-net-max-rx', fmtBytes(maxRx));
    setText('#rp-mon-net-max-tx', fmtBytes(maxTx));
    setText('#rp-mon-net-scale', `标尺 ${fmtBytes(ceiling)}`);
    plotDrawerSeries(rxHist.length ? rxHist : [0], ceiling, $('#rp-mon-net-rx-line'), $('#rp-mon-net-rx-area'), $('#rp-mon-net-rx-pt'));
    plotDrawerSeries(txHist.length ? txHist : [0], ceiling, $('#rp-mon-net-tx-line'), null, $('#rp-mon-net-tx-pt'));
  } else {
    setText('#rp-mon-net-max-rx', '–');
    setText('#rp-mon-net-max-tx', '–');
    setText('#rp-mon-net-scale', '标尺 –');
    plotDrawerSeries([], 10240, $('#rp-mon-net-rx-line'), $('#rp-mon-net-rx-area'), $('#rp-mon-net-rx-pt'));
    plotDrawerSeries([], 10240, $('#rp-mon-net-tx-line'), null, $('#rp-mon-net-tx-pt'));
  }
}

export function renderMonitorBar() {
  const bar = $('#monitor-bar');
  // 监控固定显示在状态栏,不再有开关(旧 #btn-monitor 已移除)。
  // 无活动会话时隐藏:此时状态栏显示"就绪 — 尚未建立连接",监控块没有意义。
  const active = state.activeId ? state.sessions.get(state.activeId) : null;
  // 未连接时同样隐藏:指标来自 SSH 会话,断开后 entry.js 已删掉 metrics,
  // 这一整块只剩一排"–",却仍占几百像素,把断开原因和重连提示挤成省略号。
  // 断开态状态栏最该说清"为什么断、怎么连回来",这几个空仪表没有任何信息。
  if (!active || active.status !== 'connected') {
    bar.classList.add('hidden');
    renderMonitorDrawer();
    return;
  }
  bar.classList.remove('hidden');
  const m = state.metrics.get(state.activeId);
  const set = (id, txt) => { $(id).textContent = txt; };
  // 数值槽是定长的,超大主机(如 100TB 盘)的详情可能被裁掉;裁切时把完整值放进
  // title,悬停仍可读到精确数字 —— 定长换来的稳定不该以丢信息为代价。
  const setV = (id, txt) => { const el = $(id); el.textContent = txt; el.title = txt; };
  // 延迟按阈值着色(<75ms 绿 / <200ms 琥珀 / 更高红):这是单次往返的
  // 真实 RTT,同城直连在绿档、跨省多半琥珀、跨国专线进红档 —— 阈值按
  // 用户敲一个键到看到回显的感知划档,不用读数字也能判断链路质量。
  const setLat = (ms) => {
    const el = $('#mon-lat');
    el.textContent = fmtLat(ms);
    el.title = ms == null ? '' : `连接延迟(单次往返):${fmtLat(ms)}`;
    el.classList.toggle('lat-ok', ms != null && ms < 75);
    el.classList.toggle('lat-mid', ms != null && ms >= 75 && ms < 200);
    el.classList.toggle('lat-bad', ms != null && ms >= 200);
  };
  if (!m) {
    bar.classList.remove('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    setLat(null);
    set('#mon-note', ''); set('#mon-spark-cpu', '');
    setRing('#mon-cpu-bar', null); setRing('#mon-mem-bar', null); setRing('#mon-disk-bar', null);
    renderMonitorDrawer();
    return;
  }
  if (m.supported === false) {
    // 整条切到"不支持"布局:数值槽位隐藏,避免终态文案把长条撑成两行。
    // 延迟例外:echo 往返不依赖 /proc,非 Linux 主机照样有实时延迟可看。
    bar.classList.add('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    setLat(m.latencyMs);
    set('#mon-note', '该主机暂不支持资源监控(仅支持 Linux / macOS)');
    set('#mon-spark-cpu', '');
    setRing('#mon-cpu-bar', null); setRing('#mon-mem-bar', null); setRing('#mon-disk-bar', null);
    renderMonitorDrawer();
    return;
  }
  bar.classList.remove('mon-unsupported');

  const rawHist = state.metricHistory.get(state.activeId);
  const cpuHist = [...(Array.isArray(rawHist) ? rawHist : (rawHist?.cpu || [])), m.cpuPct == null ? 0 : m.cpuPct].slice(-32);
  const memHist = [...(Array.isArray(rawHist) ? [] : (rawHist?.mem || [])), m.memPct == null ? 0 : m.memPct].slice(-32);
  const rxHist = [...(Array.isArray(rawHist) ? [] : (rawHist?.rx || [])), m.rxBps == null ? 0 : m.rxBps].slice(-32);
  const txHist = [...(Array.isArray(rawHist) ? [] : (rawHist?.tx || [])), m.txBps == null ? 0 : m.txBps].slice(-32);
  const histObj = { cpu: cpuHist, mem: memHist, rx: rxHist, tx: txHist };
  state.metricHistory.set(state.activeId, histObj);

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
  set('#mon-spark-cpu', spark(cpuHist));
  setRing('#mon-cpu-bar', m.cpuPct);
  setRing('#mon-mem-bar', m.memPct);
  setRing('#mon-disk-bar', m.diskPct);
  renderMonitorDrawer();
}

/* ---------------- AI 设置弹窗 ---------------- */

