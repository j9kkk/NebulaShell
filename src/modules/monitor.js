// 资源监控:指标采集与监控条
import { $, api, askPrompt, closeModal, openModal, state, toast } from './core.js';
import { popupPosition } from './interaction.js';
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

function renderCpuPopoverChart(hist, curPct) {
  const pop = $('#mon-cpu-popover');
  if (!pop) return;
  const curEl = $('#mon-pop-cur');
  const statCur = $('#mon-pop-stat-cur');
  const statMax = $('#mon-pop-stat-max');
  const statAvg = $('#mon-pop-stat-avg');
  const areaEl = $('#mon-pop-area');
  const lineEl = $('#mon-pop-line');
  const ptEl = $('#mon-pop-point');

  const vals = (hist || []).slice(-16);
  const curTxt = curPct == null ? '–' : fmtPct(curPct);
  if (curEl) curEl.textContent = curTxt;
  if (statCur) statCur.textContent = curTxt;

  if (!vals.length || curPct == null) {
    if (statMax) statMax.textContent = '–';
    if (statAvg) statAvg.textContent = '–';
    if (areaEl) areaEl.setAttribute('d', '');
    if (lineEl) lineEl.setAttribute('d', '');
    return;
  }

  const maxV = Math.max(...vals);
  const avgV = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (statMax) statMax.textContent = fmtPct(maxV);
  if (statAvg) statAvg.textContent = fmtPct(avgV);

  const pts = vals.length === 1 ? [vals[0], vals[0]] : vals;
  const W = 236;
  const H = 60;
  const padY = 6;
  const plotH = H - padY * 2;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const clamped = Math.min(100, Math.max(0, v));
    const y = H - padY - (clamped / 100) * plotH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const { dLine, dArea } = buildSplinePath(coords, W, H);
  if (lineEl) lineEl.setAttribute('d', dLine);
  if (areaEl) areaEl.setAttribute('d', dArea);
  if (ptEl) {
    const last = coords[coords.length - 1];
    ptEl.setAttribute('cx', String(last[0]));
    ptEl.setAttribute('cy', String(last[1]));
  }
}

function renderMemPopoverChart(hist, curPct, curUsedMB, curTotalMB) {
  const pop = $('#mon-mem-popover');
  if (!pop) return;
  const curEl = $('#mon-mem-pop-cur');
  const statCur = $('#mon-mem-pop-stat-cur');
  const statMax = $('#mon-mem-pop-stat-max');
  const statAvail = $('#mon-mem-pop-stat-avail');
  const areaEl = $('#mon-mem-pop-area');
  const lineEl = $('#mon-mem-pop-line');
  const ptEl = $('#mon-mem-pop-point');

  const vals = (hist || []).slice(-16);
  const curTxt = curPct == null ? '–' : (fmtPct(curPct) + (curUsedMB != null && curTotalMB != null ? ' ' + fmtMemPair(curUsedMB, curTotalMB) : ''));
  if (curEl) curEl.textContent = curTxt;
  if (statCur) statCur.textContent = curPct == null ? '–' : fmtPct(curPct);

  if (!vals.length || curPct == null) {
    if (statMax) statMax.textContent = '–';
    if (statAvail) statAvail.textContent = '–';
    if (areaEl) areaEl.setAttribute('d', '');
    if (lineEl) lineEl.setAttribute('d', '');
    return;
  }

  const maxV = Math.max(...vals);
  if (statMax) statMax.textContent = fmtPct(maxV);
  if (statAvail) {
    if (curUsedMB != null && curTotalMB != null) {
      const availMB = Math.max(0, curTotalMB - curUsedMB);
      statAvail.textContent = curTotalMB >= 1024 ? `${trim1(availMB / 1024)} GB` : `${Math.round(availMB)} MB`;
    } else {
      statAvail.textContent = fmtPct(100 - curPct);
    }
  }

  const pts = vals.length === 1 ? [vals[0], vals[0]] : vals;
  const W = 236;
  const H = 60;
  const padY = 6;
  const plotH = H - padY * 2;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const clamped = Math.min(100, Math.max(0, v));
    const y = H - padY - (clamped / 100) * plotH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const { dLine, dArea } = buildSplinePath(coords, W, H);
  if (lineEl) lineEl.setAttribute('d', dLine);
  if (areaEl) areaEl.setAttribute('d', dArea);
  if (ptEl) {
    const last = coords[coords.length - 1];
    ptEl.setAttribute('cx', String(last[0]));
    ptEl.setAttribute('cy', String(last[1]));
  }
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

function renderNetPopoverChart(rxHist, txHist, curRxBps, curTxBps) {
  const pop = $('#mon-net-popover');
  if (!pop) return;
  const statRx = $('#mon-net-pop-stat-rx');
  const statTx = $('#mon-net-pop-stat-tx');
  const statCur = $('#mon-net-pop-stat-cur');
  const scaleEl = $('#mon-net-pop-scale');
  const rxAreaEl = $('#mon-net-pop-rx-area');
  const rxLineEl = $('#mon-net-pop-rx-line');
  const rxPtEl = $('#mon-net-pop-rx-point');
  const txLineEl = $('#mon-net-pop-tx-line');
  const txPtEl = $('#mon-net-pop-tx-point');

  const rxVals = (rxHist || []).slice(-16);
  const txVals = (txHist || []).slice(-16);
  const curTxt = curRxBps == null ? '–' : fmtBytes(curRxBps);
  if (statCur) statCur.textContent = curTxt;

  if ((!rxVals.length && !txVals.length) || (curRxBps == null && curTxBps == null)) {
    if (statRx) statRx.textContent = '–';
    if (statTx) statTx.textContent = '–';
    if (scaleEl) scaleEl.textContent = '标尺: –';
    if (rxAreaEl) rxAreaEl.setAttribute('d', '');
    if (rxLineEl) rxLineEl.setAttribute('d', '');
    if (txLineEl) txLineEl.setAttribute('d', '');
    return;
  }

  const maxRx = rxVals.length ? Math.max(...rxVals) : (curRxBps || 0);
  const maxTx = txVals.length ? Math.max(...txVals) : (curTxBps || 0);
  if (statRx) statRx.textContent = fmtBytes(maxRx);
  if (statTx) statTx.textContent = fmtBytes(maxTx);

  const ceiling = calcNetCeiling(Math.max(maxRx, maxTx, curRxBps || 0, curTxBps || 0));
  if (scaleEl) scaleEl.textContent = `标尺顶格: ${fmtBytes(ceiling)}`;

  const W = 236;
  const H = 60;
  const padY = 6;
  const plotH = H - padY * 2;

  // RX 曲线 (下行，实线 + 面积)
  const ptsRx = rxVals.length <= 1 ? [(rxVals[0] || 0), (rxVals[0] || 0)] : rxVals;
  const coordsRx = ptsRx.map((v, i) => {
    const x = (i / (ptsRx.length - 1)) * W;
    const clamped = Math.min(ceiling, Math.max(0, v));
    const y = H - padY - (clamped / ceiling) * plotH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const { dLine: dRxLine, dArea: dRxArea } = buildSplinePath(coordsRx, W, H);
  if (rxLineEl) rxLineEl.setAttribute('d', dRxLine);
  if (rxAreaEl) rxAreaEl.setAttribute('d', dRxArea);
  if (rxPtEl) {
    const last = coordsRx[coordsRx.length - 1];
    rxPtEl.setAttribute('cx', String(last[0]));
    rxPtEl.setAttribute('cy', String(last[1]));
  }

  // TX 曲线 (上行，虚线)
  const ptsTx = txVals.length <= 1 ? [(txVals[0] || 0), (txVals[0] || 0)] : txVals;
  const coordsTx = ptsTx.map((v, i) => {
    const x = (i / (ptsTx.length - 1)) * W;
    const clamped = Math.min(ceiling, Math.max(0, v));
    const y = H - padY - (clamped / ceiling) * plotH;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const { dLine: dTxLine } = buildSplinePath(coordsTx, W, H);
  if (txLineEl) txLineEl.setAttribute('d', dTxLine);
  if (txPtEl) {
    const last = coordsTx[coordsTx.length - 1];
    txPtEl.setAttribute('cx', String(last[0]));
    txPtEl.setAttribute('cy', String(last[1]));
  }
}

const POPOVER_ENTRIES = [
  { id: 'cpu', triggerId: '#mon-cpu-trigger', popoverId: '#mon-cpu-popover' },
  { id: 'mem', triggerId: '#mon-mem-trigger', popoverId: '#mon-mem-popover' },
  { id: 'net', triggerId: '#mon-net-trigger', popoverId: '#mon-net-popover' },
];

let activePopoverId = null;
let popoversBound = false;
let popoverHideTimer = null;

function hideAllPopovers() {
  if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
  activePopoverId = null;
  for (const entry of POPOVER_ENTRIES) {
    const pop = $(entry.popoverId);
    if (pop) pop.classList.add('hidden');
  }
}

function positionPopover(entry) {
  const pop = $(entry.popoverId);
  const trigger = $(entry.triggerId);
  if (!pop || !trigger || pop.classList.contains('hidden')) return;
  const anchor = trigger.getBoundingClientRect?.();
  if (!anchor) return;
  const size = { width: pop.offsetWidth || 270, height: pop.offsetHeight || 156 };
  const pos = popupPosition(anchor, size, { width: window.innerWidth || 1280, height: window.innerHeight || 800 }, 8);
  pop.style.left = `${pos.left}px`;
  pop.style.top = `${pos.top}px`;
}

function positionActivePopover() {
  if (!activePopoverId) return;
  const entry = POPOVER_ENTRIES.find((e) => e.id === activePopoverId);
  if (entry) positionPopover(entry);
}

export function positionCpuPopover() {
  positionActivePopover();
}

function bindMonitorPopoversOnce() {
  if (popoversBound) return;
  const triggersExist = POPOVER_ENTRIES.some((e) => $(e.triggerId));
  if (!triggersExist) return;
  popoversBound = true;

  for (const entry of POPOVER_ENTRIES) {
    const trigger = $(entry.triggerId);
    const pop = $(entry.popoverId);
    if (!trigger || !pop || !trigger.addEventListener) continue;

    if (typeof document !== 'undefined' && document.body && pop.parentElement && pop.parentElement !== document.body) {
      document.body.appendChild(pop);
    }

    const showThis = () => {
      if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
      const bar = $('#monitor-bar');
      if (!bar || bar.classList.contains('hidden') || bar.classList.contains('mon-unsupported')) return;
      for (const other of POPOVER_ENTRIES) {
        if (other.id !== entry.id) {
          const otherPop = $(other.popoverId);
          if (otherPop) otherPop.classList.add('hidden');
        }
      }
      activePopoverId = entry.id;
      pop.classList.remove('hidden');
      positionPopover(entry);
    };

    const scheduleHide = () => {
      if (popoverHideTimer) clearTimeout(popoverHideTimer);
      popoverHideTimer = setTimeout(() => {
        hideAllPopovers();
      }, 120);
    };

    trigger.addEventListener('mouseenter', showThis);
    trigger.addEventListener('mouseleave', scheduleHide);
    pop.addEventListener('mouseenter', () => {
      if (popoverHideTimer) { clearTimeout(popoverHideTimer); popoverHideTimer = null; }
    });
    pop.addEventListener('mouseleave', scheduleHide);
  }

  window.addEventListener?.('resize', positionActivePopover);
}

export function renderMonitorBar() {
  bindMonitorPopoversOnce();
  const bar = $('#monitor-bar');
  // 监控固定显示在状态栏,不再有开关(旧 #btn-monitor 已移除)。
  // 无活动会话时隐藏:此时状态栏显示"就绪 — 尚未建立连接",监控块没有意义。
  if (!state.activeId) {
    bar.classList.add('hidden');
    hideAllPopovers();
    return;
  }
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
  if (!m) {
    bar.classList.remove('mon-unsupported');
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    setLat(null);
    set('#mon-note', ''); set('#mon-spark-cpu', '');
    setRing('#mon-cpu-bar', null); setRing('#mon-mem-bar', null); setRing('#mon-disk-bar', null);
    renderCpuPopoverChart([], null);
    renderMemPopoverChart([], null, null, null);
    renderNetPopoverChart([], [], null, null);
    return;
  }
  if (m.supported === false) {
    // 整条切到"不支持"布局:数值槽位隐藏,避免终态文案把长条撑成两行。
    // 延迟例外:echo 往返不依赖 /proc,非 Linux 主机照样有实时延迟可看。
    bar.classList.add('mon-unsupported');
    hideAllPopovers();
    set('#mon-cpu', '–'); set('#mon-mem', '–'); set('#mon-disk', '–'); set('#mon-rx', '–'); set('#mon-tx', '–');
    setV('#mon-mem-det', ''); setV('#mon-disk-det', '');
    setLat(m.latencyMs);
    set('#mon-note', '该主机暂不支持资源监控(仅支持 Linux)');
    set('#mon-spark-cpu', '');
    setRing('#mon-cpu-bar', null); setRing('#mon-mem-bar', null); setRing('#mon-disk-bar', null);
    renderCpuPopoverChart([], null);
    renderMemPopoverChart([], null, null, null);
    renderNetPopoverChart([], [], null, null);
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
  renderCpuPopoverChart(cpuHist, m.cpuPct);
  renderMemPopoverChart(memHist, m.memPct, m.memUsedMB, m.memTotalMB);
  renderNetPopoverChart(rxHist, txHist, m.rxBps, m.txBps);
}

/* ---------------- AI 设置弹窗 ---------------- */

