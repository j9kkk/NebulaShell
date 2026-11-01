// 主机导入 / 导出(简化版 v4)
//
// 设计约束(见 import-export-redesign/simplified/SIMPLIFIED-DESIGN.md):
// 1. 范围在入口决定:主机库「导出全部 / 导出所选」,弹框内只读;
// 2. 凭据由后端内置密钥自动加密,界面不出现口令(只有旧版 v2/v3 文件才补口令);
// 3. 导入先预检、再按决策落盘:预检不写盘,写入整批原子;
// 4. 冲突只问一次(skip / overwrite),只影响列出的主机。
import { $, api, closeModal, openModal, setModalDismissHandler, state, toast } from './core.js';
import { refreshHosts, groupOf, escapeHtml } from './hosts.js';

const ex = { scope: 'all', ids: [], path: '', busy: false, usePass: false, pass: '', withKeys: false };
let defaultDirs = null;
const im = { path: '', meta: null, inspect: null, passphrase: '', needsPass: false, busy: false };
let bound = false;
let dropBound = false;

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const defaultName = () => `nebulashell-hosts-${today()}.json`;

/** 当前导出范围内的主机(打开弹框时快照,之后改勾选不影响本次)。 */
const scopedHosts = () => {
  const all = state.hosts || [];
  if (ex.scope !== 'ids') return all;
  const ids = new Set(ex.ids);
  return all.filter((h) => ids.has(h.id));
};

const groupSummary = (hosts) => {
  const names = [...new Set(hosts.map((h) => groupOf(h) || '我的主机'))];
  if (!names.length) return '—';
  if (names.length <= 2) return names.join(' · ');
  return `${names.slice(0, 2).join(' · ')} 等 ${names.length} 个分组`;
};

// ---------------------------------------------------------------- 导出

export function openExportDialog({ scope = 'all', ids = [] } = {}) {
  ex.scope = scope === 'ids' && ids.length ? 'ids' : 'all';
  ex.ids = ex.scope === 'ids' ? [...ids] : [];
  ex.path = `${defaultDirs?.downloads || '~/Downloads'}/${defaultName()}`;
  ex.busy = false;
  ex.usePass = false;
  ex.pass = '';
  ex.withKeys = false;
  const cb = $('#io-export-use-pass');
  if (cb) cb.checked = false;
  const kb = $('#io-export-with-keys');
  if (kb) kb.checked = false;
  const pin = $('#io-export-pass-input');
  if (pin) pin.value = '';
  const din = $('#io-export-dir');
  if (din) din.value = '';
  renderExport();
  openModal('#modal-export');
  if (!defaultDirs) {
    api('app:paths')
      .then((p) => {
        defaultDirs = p || null;
        if (defaultDirs?.downloads) {
          ex.path = `${defaultDirs.downloads}/${defaultName()}`;
          renderExport();
        }
      })
      .catch(() => {});
  }
}

function renderExport() {
  const hosts = scopedHosts();
  const n = hosts.length;
  $('#io-export-count').textContent = `${n} 台`;
  $('#io-export-scope').textContent = ex.scope === 'ids' ? '选中的主机' : '全部主机';
  $('#io-export-groups').textContent = groupSummary(hosts);
  // 输入框直接展示完整默认路径(不再用「下载文件夹」占位)
  const dirInput = $('#io-export-dir');
  if (dirInput && dirInput.value !== ex.path) dirInput.value = ex.path;
  $('#io-export-cred').textContent = ex.usePass
    ? '随文件打包(口令加密)'
    : '随文件打包(内置密钥)';
  // hosts:list 的公开形态只暴露 hasKey,不暴露 keyPath
  const keyHosts = hosts.filter((h) => h.hasKey || (h.keyPath || '').trim()).length;
  $('#io-export-keys-note').textContent = ex.withKeys
    ? keyHosts
      ? `打包 ${keyHosts} 个私钥文件`
      : '范围内没有配私钥的主机'
    : '不打包私钥文件';
  $('#io-export-pass-input').classList.toggle('hidden', !ex.usePass);

  const tooShort = ex.usePass && ex.pass.trim().length < 8;
  const ok = $('#io-export-ok');
  ok.disabled = ex.busy || n === 0 || tooShort;
  ok.textContent = ex.busy ? '导出中…' : '导出';
  const hint = $('#io-export-hint');
  // 位数提示交给 placeholder,底栏不再重复一遍
  if (ex.usePass && tooShort) hint.textContent = '';
  else if (ex.usePass) hint.textContent = '口令需要另外口头告知对方,别和文件一起发';
  else hint.textContent = '文件可直接发给同事,但请按密码本对待';
}

async function pickExportDir() {
  const idx = ex.path.lastIndexOf('/');
  const picked = await api('dialog:pickDirectory', { defaultPath: idx > 0 ? ex.path.slice(0, idx) : '' });
  if (picked && typeof picked === 'string') {
    ex.path = `${picked.replace(/\/$/, '')}/${ex.path.slice(idx + 1) || defaultName()}`;
    renderExport();
  }
}

async function runExport() {
  if (ex.busy || !scopedHosts().length) return;
  ex.busy = true;
  renderExport();
  const cut = ex.path.lastIndexOf('/');
  const res = await api('hosts:exportFile', {
    scope: { mode: ex.scope, ids: ex.ids },
    dir: cut > 0 ? ex.path.slice(0, cut) : '',
    filename: cut > 0 ? ex.path.slice(cut + 1) : ex.path,
    passphrase: ex.usePass ? ex.pass : undefined,
    withKeys: ex.withKeys,
  });
  ex.busy = false;
  if (!res) {
    renderExport(); // 用户取消
    return;
  }
  closeModal('#modal-export');
  const keys = res.includedKeys ? ` · 含 ${res.includedKeys} 个私钥` : '';
  toast(`已导出 ${res.count} 台${keys} → ${res.path}`, 'ok');
}

// ---------------------------------------------------------------- 导入

export function openImportDialog() {
  im.path = '';
  im.meta = null;
  im.inspect = null;
  im.passphrase = '';
  im.needsPass = false;
  im.busy = false;
  renderImport();
  openModal('#modal-import');
  bindDrop();
}

function renderImport() {
  const has = !!im.path && !!im.meta;
  const rows = im.inspect?.rows || [];
  const counts = im.inspect?.counts;
  $('#io-import-empty').classList.toggle('hidden', has);
  $('#io-import-file').classList.toggle('hidden', !has);
  $('#io-import-list').classList.toggle('hidden', !rows.length);
  $('#io-import-summary').classList.toggle('hidden', !rows.length);
  $('#io-import-progress').classList.toggle('hidden', !im.busy);
  $('#io-import-pass').classList.toggle('hidden', !im.needsPass);

  if (has) {
    // 目录 + 文件名分开渲染:整体右对齐靠 direction:rtl 会把开头的 "/" 视觉移到末尾
    // (截图里就成了 "...json/"),所以这里只让目录段自己截断。
    const cut = im.path.lastIndexOf('/');
    const dir = cut > 0 ? im.path.slice(0, cut + 1) : '';
    $('#io-import-path').innerHTML =
      `<span class="io-dir">${escapeHtml(dir)}</span><b>${escapeHtml(im.path.slice(cut + 1))}</b>`;
  }

  if (rows.length) renderRows(rows);
  if (counts) {
    $('#io-import-summary').innerHTML = [
      ['新增', counts.add, 'add'],
      ['补凭据', counts.credOnly, 'cred'],
      ['冲突', counts.conflict, 'warn'],
      ['一致', counts.identical, 'mute'],
    ]
      .map(([label, v, tone]) => `<span class="io-chip ${tone}">${label} <b>${v}</b></span>`)
      .join('');
  }

  const ok = $('#io-import-ok');
  ok.disabled = im.busy || !rows.length;
  ok.textContent = im.busy
    ? '导入中…'
    : counts?.conflict
      ? `导入(${counts.conflict} 台冲突)`
      : '导入';

  const hint = $('#io-import-hint');
  if (im.busy || !has) hint.textContent = '';
  else if (im.inspect?.legacyPlaintext) hint.textContent = '该文件含明文凭据,导入后建议重新导出一份';
  else if (im.meta?.encryption === 'builtin') hint.textContent = '凭据用内置密钥保护,请按密码本对待';
  else hint.textContent = '导入前会自动备份当前主机库';
}

function renderRows(rows) {
  const order = { conflict: 0, credOnly: 1, add: 2, identical: 3 };
  const sorted = [...rows].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  const visible = sorted.slice(0, 8);
  const label = { add: '新增', credOnly: '补凭据', conflict: '冲突', identical: '一致' };
  $('#io-import-rows').innerHTML = visible
    .map(
      (r) => `<div class="io-item k-${r.kind}">
        <span class="io-r-name" title="${escapeHtml(r.name || '')}">${escapeHtml(r.name || r.host || '')}</span>
        <span class="io-r-addr mono">${escapeHtml(r.username || '')}@${escapeHtml(r.host || '')}:${r.port || 22}</span>
        <span class="io-r-group">${escapeHtml(r.group || '—')}</span>
        <span class="io-r-cred ${r.hasCredentials ? 'yes' : 'no'}">${r.hasCredentials ? '有' : '无'}</span>
        <span class="io-r-kind ${r.kind}">${label[r.kind] || r.kind}</span>
      </div>`,
    )
    .join('');
  const more = $('#io-import-more');
  const rest = sorted.length - visible.length;
  more.classList.toggle('hidden', rest <= 0);
  if (rest > 0) {
    // 冲突永远排在最前,折叠的只会是新增/一致 —— 鼠标悬停给出名字,避免"看不见就不知道"。
    more.textContent = `还有 ${rest} 台…`;
    more.title = sorted.slice(8).map((r) => r.name || r.host).join('、');
  }
}

function setPassError(msg) {
  const el = $('#io-import-pass-err');
  if (el) el.textContent = msg || '';
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** path 为空 = 让后端弹系统文件选择框。 */
async function inspect(path, passphrase) {
  $('#io-import-hint').textContent = '读取文件…';
  setPassError('');
  let res;
  try {
    res = await api('hosts:importInspect', { path: path || '', passphrase: passphrase || '' });
  } catch (e) {
    // 解密失败/文件损坏必须当场说清楚:留在口令行里,并把焦点还给输入框
    $('#io-import-hint').textContent = '';
    setPassError(e?.message || '读取失败');
    im.needsPass = true;
    renderImport();
    $('#io-import-pass-input')?.focus?.();
    $('#io-import-pass-input')?.select?.();
    return;
  }
  if (res === null || res === undefined) {
    $('#io-import-hint').textContent = ''; // 用户取消
    return;
  }
  im.path = res.path;
  im.meta = res.file;
  if (res.needsPassphrase) {
    im.inspect = null;
    im.needsPass = true;
  } else {
    im.inspect = res.inspect;
    im.needsPass = false;
  }
  renderImport();
  if (res.needsPassphrase) $('#io-import-pass-input')?.focus?.();
}

/** 只在这张弹框打开时接管文件拖放,避免与 SFTP 上传抢同一个落点。 */
function bindDrop() {
  if (dropBound) return;
  dropBound = true;
  const win = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
  win?.onDragDropEvent?.(({ payload }) => {
    const modal = document.getElementById('modal-import');
    if (!modal || modal.classList.contains('hidden')) return;
    if (payload?.type !== 'drop') return;
    const file = (payload.paths || []).find((p) => /\.json$/i.test(p));
    if (file) inspect(file, im.passphrase);
  });
}

function openConflict() {
  const rows = (im.inspect?.rows || []).filter((r) => r.kind === 'conflict');
  if (!rows.length) {
    runApply('skip');
    return;
  }
  $('#io-conflict-title').textContent = `${rows.length} 台主机与本地配置不同`;
  $('#io-conflict-rows').innerHTML = rows
    .map(
      (r) => `<div class="io-item conflict">
        <span class="io-r-name">${escapeHtml(r.name || r.host || '')}</span>
        <span class="io-r-addr mono">${escapeHtml(r.username || '')}@${escapeHtml(r.host || '')}:${r.port || 22}</span>
        <span class="io-r-diff" title="${escapeHtml((r.diff || []).join(' · '))}">${escapeHtml((r.diff || []).join(' · ') || '属性不同')}</span>
      </div>`,
    )
    .join('');
  selectDecision('skip');
  openModal('#modal-import-conflict');
}

function selectDecision(value) {
  document.querySelectorAll('#modal-import-conflict .io-opt').forEach((el) => {
    const on = el.dataset.decision === value;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

const currentDecision = () =>
  document.querySelector('#modal-import-conflict .io-opt.on')?.dataset.decision || 'skip';

async function runApply(decision) {
  if (im.busy || !im.path) return;
  const decisions = {};
  (im.inspect?.rows || [])
    .filter((r) => r.kind === 'conflict')
    .forEach((r) => {
      decisions[r.key] = decision === 'overwrite' ? 'overwrite' : 'skip';
    });
  im.busy = true;
  renderImport();
  const res = await api('hosts:importApply', {
    path: im.path,
    passphrase: im.passphrase,
    decisions,
  });
  im.busy = false;
  if (res?.needsPassphrase) {
    im.needsPass = true;
    renderImport();
    return;
  }
  if (!res?.result) {
    renderImport();
    $('#io-import-hint').textContent = '导入失败,请检查文件后重试';
    return;
  }
  closeModal('#modal-import-conflict');
  closeModal('#modal-import');
  const r = res.result;
  const parts = [`新增 ${r.added}`];
  if (r.overwritten) parts.push(`覆盖 ${r.overwritten}`);
  if (r.updated) parts.push(`更新 ${r.updated}`);
  toast(`导入完成:${parts.join(' · ')}`, 'ok');
  refreshHosts();
}

// ---------------------------------------------------------------- 绑定

export function setupTransfer() {
  if (bound) return;
  bound = true;

  $('#io-export-pick')?.addEventListener('click', pickExportDir);
  $('#io-export-dir')?.addEventListener('input', (e) => {
    ex.path = e.target.value.trim();
  });
  $('#io-export-with-keys')?.addEventListener('change', (e) => {
    ex.withKeys = !!e.target.checked;
    renderExport();
  });
  $('#io-export-use-pass')?.addEventListener('change', (e) => {
    ex.usePass = !!e.target.checked;
    renderExport();
    if (ex.usePass) $('#io-export-pass-input')?.focus?.();
  });
  $('#io-export-pass-input')?.addEventListener('input', (e) => {
    ex.pass = e.target.value;
    renderExport();
  });
  $('#io-export-ok')?.addEventListener('click', runExport);
  $('#io-export-cancel')?.addEventListener('click', () => closeModal('#modal-export'));
  $('#io-export-close')?.addEventListener('click', () => closeModal('#modal-export'));
  setModalDismissHandler('#modal-export', () => !ex.busy);

  // 整块虚线区 = 选择文件入口(没有单独按钮)
  const drop = $('#io-import-empty');
  drop?.addEventListener('click', () => inspect('', im.passphrase));
  drop?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inspect('', im.passphrase);
    }
  });
  $('#io-import-repick')?.addEventListener('click', () => inspect('', im.passphrase));
  $('#io-import-cancel')?.addEventListener('click', () => closeModal('#modal-import'));
  $('#io-import-close')?.addEventListener('click', () => closeModal('#modal-import'));
  $('#io-import-ok')?.addEventListener('click', openConflict);
  setModalDismissHandler('#modal-import', () => !im.busy);

  const passOk = () => {
    im.passphrase = $('#io-import-pass-input')?.value || '';
    inspect(im.path, im.passphrase);
  };
  $('#io-import-pass-ok')?.addEventListener('click', passOk);
  $('#io-import-pass-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passOk();
  });

  document.querySelectorAll('#modal-import-conflict .io-opt').forEach((el) => {
    el.addEventListener('click', () => selectDecision(el.dataset.decision));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDecision(el.dataset.decision);
      }
    });
  });
  $('#io-conflict-ok')?.addEventListener('click', () => runApply(currentDecision()));
  $('#io-conflict-back')?.addEventListener('click', () => closeModal('#modal-import-conflict'));
  $('#io-conflict-close')?.addEventListener('click', () => closeModal('#modal-import-conflict'));
  setModalDismissHandler('#modal-import-conflict', () => true);
}
