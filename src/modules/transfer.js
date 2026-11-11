// 主机导入 / 导出
//
// 实现依据:docs/host-import-export-design.md(§5 入口 / §6 导入三步 / §7 导出 / §9 文案与错误)
//
//   - 导入是**一张卡三步**(选择文件 → 校验预览 → 完成),冲突策略是步骤 2 里的一段;
//   - 选择文件只有一个入口(按钮 + 拖放),路径框只读;
//   - 导出范围在卡内可改,入口只给默认值;凭据是否打包、附带几台跳板机必须写在卡上;
//   - 报数只有一个来源:导入看结果态(不弹 toast),导出结果态与 toast 用同一句摘要。
import { $, api, closeModal, copyText, openModal, setModalDismissHandler, state, toast } from './core.js';
import { refreshHosts, groupOf, escapeHtml } from './hosts.js';
import { icon } from '../shared/icons.js';
// 全局滚动容器规则(底部渐隐):导入预览列表静止时最后一行被切一半时,用它提示"还能滚"
import { observeScrollFade } from '../shared/scroll-fade.js';

const PASS_MIN = 8;
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const defaultName = () => `nebulashell-hosts-${today()}.json`;

/// 处置结果 → 报告用中文;后端 rows[].result 只有这五种取值(config.rs import_run)。
const RESULT_LABEL = { written: '新增', overwritten: '覆盖', filled: '补凭据', skipped: '跳过', unchanged: '未改动', invalid: '问题行' };
const KIND_LABEL = { add: '新增', credOnly: '补凭据', conflict: '冲突', identical: '一致', invalid: '问题行' };

function tallyResult(rows) {
  const t = { written: 0, overwritten: 0, filled: 0, skipped: 0, unchanged: 0, invalid: 0 };
  for (const r of rows || []) if (Object.hasOwn(t, r?.result)) t[r.result] += 1;
  return t;
}

// ---------------------------------------------------------------- 导出

const ex = {
  scope: 'all',
  opts: { all: 0, filtered: 0, selected: 0, filteredIds: [], selectedIds: [] },
  path: '',
  busy: false,
  // 两个开关互相独立,默认都关 —— 打开的是一张「纯结构导出」,
  // 密码与密钥路径各自要用户自己勾。
  withPass: false,
  withKeyPaths: false,
  usePass: false,
  pass: '',
  pass2: '',
  revealPass: false,
  done: null,
  error: '',
};
let defaultDirs = null;

/// 入口只给默认范围(D2):有勾选 → 已选;有筛选 → 当前筛选;否则全部。
export function openExportDialog({ scope = 'all', ids = [], filteredIds = null } = {}) {
  const all = (state.hosts || []).length;
  ex.opts.all = all;
  ex.opts.selectedIds = [...(ids || [])];
  ex.opts.selected = ex.opts.selectedIds.length;
  ex.opts.filteredIds = Array.isArray(filteredIds) ? [...filteredIds] : null;
  ex.opts.filtered = ex.opts.filteredIds ? ex.opts.filteredIds.length : 0;
  const want = scope === 'ids' ? (ex.opts.selected ? 'selected' : 'all') : scope === 'filtered' ? (ex.opts.filtered ? 'filtered' : 'all') : 'all';
  ex.scope = want;
  ex.path = `${defaultDirs?.downloads || '~/Downloads'}/${defaultName()}`;
  ex.busy = false;
  ex.withPass = false;
  ex.withKeyPaths = false;
  ex.usePass = false;
  ex.pass = '';
  ex.pass2 = '';
  ex.revealPass = false;
  ex.done = null;
  ex.error = '';
  setPassRevealed('export', false);
  ['#io-export-with-pass', '#io-export-with-keypaths', '#io-export-use-pass'].forEach((sel) => {
    const el = $(sel);
    if (el) el.checked = false;
  });
  const pin = $('#io-export-pass-input');
  if (pin) pin.value = '';
  const pin2 = $('#io-export-pass2');
  if (pin2) pin2.value = '';
  renderExport();
  openModal('#modal-export');
  setTimeout(() => $('#io-export-scope')?.focus?.(), 30);
  if (!defaultDirs) {
    api('app:paths')
      .then((p) => {
        defaultDirs = p || null;
        if (defaultDirs?.downloads) {
          ex.path = `${defaultDirs.downloads}/${defaultName()}`;
          const input = $('#io-export-dir');
          if (input && !ex.done) input.value = ex.path;
          renderExport();
        }
      })
      .catch(() => {});
  }
}

const hostById = () => new Map((state.hosts || []).map((h) => [h.id, h]));

/// 当前范围的主机 id 列表(null = 全部,交给后端 mode:'all')。
function scopeIds() {
  if (ex.scope === 'selected') return ex.opts.selectedIds.filter((id) => hostById().has(id));
  if (ex.scope === 'filtered') return (ex.opts.filteredIds || []).filter((id) => hostById().has(id));
  return null;
}

/// 跳板闭包:把被选中主机引用到、但不在范围内的跳板机补进来(与后端同一规则)。
function jumpClosure(ids) {
  if (!ids) return 0;
  const map = hostById();
  const keep = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...keep]) {
      const host = map.get(id);
      for (const jump of host?.jumpIds || []) {
        if (jump && !keep.has(jump) && map.has(jump)) {
          keep.add(jump);
          grew = true;
        }
      }
    }
  }
  return keep.size - new Set(ids).size;
}

/// 徽标 / 附带行 / 结果 / toast 共用的唯一一次计算(F-06:不许两套数字)。
function scopeSummary() {
  const ids = scopeIds();
  const count = ids ? ids.length : ex.opts.all;
  return { ids, count, jumps: jumpClosure(ids), total: count + jumpClosure(ids) };
}

function renderExport() {
  const sum = scopeSummary();
  const badge = $('#io-export-count');
  if (badge) badge.textContent = `${sum.total} 台`;

  // 范围下拉:只列出真正可用的项,0 台不可选
  const sel = $('#io-export-scope');
  if (sel) {
    const options = [['all', `全部 ${ex.opts.all} 台`]];
    if (ex.opts.filtered && ex.opts.filtered < ex.opts.all) options.push(['filtered', `当前筛选 ${ex.opts.filtered} 台`]);
    if (ex.opts.selected) options.push(['selected', `已选 ${ex.opts.selected} 台`]);
    const sig = options.map(([v, t]) => `${v}:${t}`).join('|');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = options.map(([v, t]) => `<option value="${v}">${escapeHtml(t)}</option>`).join('');
    }
    sel.value = ex.scope;
    sel.disabled = ex.busy || !!ex.done;
  }

  const extra = $('#io-export-extra');
  if (extra) extra.textContent = sum.jumps ? `附带 ${sum.jumps} 台跳板机` : '不含跳板机';

  renderExportPath();

  // 两个开关都不勾 = 纯结构导出,口令加密没有作用对象 → 整行禁用,说明写清楚为什么。
  const usePassEl = $('#io-export-use-pass');
  if (usePassEl) {
    usePassEl.disabled = !ex.withPass || ex.busy;
    usePassEl.checked = ex.withPass && ex.usePass;
  }
  const passOn = ex.withPass && ex.usePass;
  const passRow = $('#io-export-pass-row');
  if (passRow) passRow.classList.toggle('hidden', !passOn);
  const pass2Row = $('#io-export-pass2-row');
  if (pass2Row) pass2Row.classList.toggle('hidden', !passOn);
  const passNote = $('#io-export-pass-note');
  if (passNote) {
    let text;
    let warn = false;
    if (!ex.withPass) {
      text = '没有可加密的内容';
    } else if (passOn) {
      text = '口令只用来加密这个文件,不保存';
    } else {
      text = '关: 内置密钥保护,等同明文';
      warn = true;
    }
    passNote.textContent = text;
    passNote.classList.toggle('warn', warn);
  }

  const passLen = ex.pass.trim().length;
  const tooShort = passOn && passLen > 0 && passLen < PASS_MIN;
  const mismatch = passOn && ex.pass2.length > 0 && ex.pass2 !== ex.pass;
  const passEl = $('#io-export-pass-input');
  if (passEl) {
    passEl.classList.toggle('invalid', tooShort);
    passEl.setAttribute('aria-invalid', tooShort ? 'true' : 'false');
  }
  const pass2 = $('#io-export-pass2');
  if (pass2) {
    pass2.classList.toggle('invalid', mismatch);
    pass2.setAttribute('aria-invalid', mismatch ? 'true' : 'false');
  }
  $('#btn-reveal-export-pass')?.classList.toggle('hidden', !passOn || !ex.pass.length);

  const ok = $('#io-export-ok');
  if (ok) {
    ok.disabled = ex.busy || sum.count === 0 || (passOn && (passLen < PASS_MIN || ex.pass !== ex.pass2));
    ok.textContent = ex.busy ? '导出中…' : '导出';
  }
  const cancel = $('#io-export-cancel');
  if (cancel) cancel.disabled = ex.busy;
  const close = $('#io-export-close');
  if (close) close.disabled = ex.busy;

  const hint = $('#io-export-hint');
  if (hint) {
    // 底栏左侧是「这次到底会导出什么」的唯一一句话:错误优先,没有错误就是范围状态。
    let text = '';
    let bad = false;
    let warn = false;
    if (ex.error) { text = ex.error; bad = true; }
    else if (ex.busy) text = '正在写入文件…';
    else if (sum.count === 0) { text = '没有可导出的主机'; bad = true; }
    else if (passOn && passLen === 0) text = `请输入文件口令(至少 ${PASS_MIN} 位)`;
    else if (tooShort) { text = `文件口令至少 ${PASS_MIN} 位,当前 ${passLen} 位`; bad = true; }
    else if (mismatch) { text = '两次输入的文件口令不一致'; bad = true; }
    else if (passOn && ex.pass2.length === 0) text = '请再次输入文件口令';
    else if (ex.withPass && !ex.withKeyPaths) {
      text = passOn ? `含 ${sum.count} 台密码,已加密` : `含 ${sum.count} 台密码,未加密`;
      warn = !passOn;
    } else if (!ex.withPass && ex.withKeyPaths) text = `含 ${sum.count} 条密钥路径`;
    else if (ex.withPass && ex.withKeyPaths) {
      text = passOn
        ? `含 ${sum.count} 台密码 · ${sum.count} 条密钥路径,已加密`
        : `含 ${sum.count} 台密码 · ${sum.count} 条密钥路径,未加密`;
      warn = !passOn;
    } else text = '不含密码与密钥路径';
    hint.classList.toggle('bad', bad);
    hint.classList.toggle('warn', warn && !bad);
    hint.textContent = text;
  }
}

/// 保存位置:目录只读 + 唯一入口「更改…」,文件名单独一行。
/// 卡里显示 ~ 缩写(路径太长会吃掉整行),实际写盘用绝对路径。
function renderExportPath() {
  const dirEl = $('#io-export-dir');
  const nameEl = $('#io-export-name');
  const cut = ex.path.lastIndexOf('/');
  const dir = cut > 0 ? ex.path.slice(0, cut) : '';
  const name = cut >= 0 ? ex.path.slice(cut + 1) : ex.path;
  const home = defaultDirs?.home;
  const shown = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  if (dirEl && dirEl.textContent !== shown) dirEl.textContent = shown || '~/Downloads';
  if (nameEl && nameEl.value !== name) nameEl.value = name;
}

/// 口令显隐(导出/导入共用):密文 ↔ 明文,图标换 eye/eyeOff,标题跟着变。
function setPassRevealed(which, on) {
  const isImport = which === 'import';
  const input = $(isImport ? '#io-import-pass-input' : '#io-export-pass-input');
  const btn = $(isImport ? '#btn-reveal-import-pass' : '#btn-reveal-export-pass');
  if (isImport) im.revealPass = !!on;
  else ex.revealPass = !!on;
  const revealed = isImport ? im.revealPass : ex.revealPass;
  if (input) input.type = revealed ? 'text' : 'password';
  if (btn) {
    btn.title = revealed ? '隐藏口令' : '显示口令';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = icon(revealed ? 'eye' : 'eyeOff');
  }
}

/// 路径规范化(§7.6):扩展名跟随格式;写成目录(以 / 结尾或末段无扩展名)时补默认文件名。
export function normalizeExportPath(raw) {
  const downloads = defaultDirs?.downloads || '~/Downloads';
  let p = String(raw || '').trim();
  if (!p) return `${downloads}/${defaultName()}`;
  if (p.endsWith('/')) return `${p}${defaultName()}`;
  const cut = p.lastIndexOf('/');
  const dir = cut >= 0 ? p.slice(0, cut + 1) : '';
  const name = cut >= 0 ? p.slice(cut + 1) : p;
  if (!name.includes('.')) return `${dir}${name}/${defaultName()}`.replace(/\/\/+/g, '/');
  if (!/\.json$/i.test(name)) return `${dir}${name.replace(/\.[^.]*$/, '.json')}`;
  return p;
}

async function pickExportDir() {
  const idx = ex.path.lastIndexOf('/');
  const picked = await api('dialog:pickDirectory', { defaultPath: idx > 0 ? ex.path.slice(0, idx) : '' });
  if (picked && typeof picked === 'string') {
    const name = idx > 0 ? ex.path.slice(idx + 1) : defaultName();
    ex.path = `${picked.replace(/\/$/, '')}/${name}`;
    renderExport();
  }
}

/// 导出摘要:结果态与 toast 共用这一句(D8)。说了什么,文件里就有什么。
function exportSummary(res) {
  const parts = [`已导出 ${res.count} 台`];
  if (res.includedJumps) parts.push(`含 ${res.includedJumps} 台跳板机`);
  if (res.passwordsIncluded) parts.push(res.encrypted ? '含密码(已加密)' : '含密码(未加密)');
  if (res.keyPathsIncluded) parts.push('含密钥路径');
  if (!res.passwordsIncluded && !res.keyPathsIncluded) parts.push('不含密码与密钥路径');
  return parts.join(' · ');
}

async function runExport() {
  if (ex.busy) return;
  const sum = scopeSummary();
  if (!sum.count) return;
  const passOn = ex.withPass && ex.usePass;
  if (passOn && (ex.pass.trim().length < PASS_MIN || ex.pass !== ex.pass2)) return;
  // 文件名单独编辑:规范化只作用于末段,目录保持不变
  const nameRaw = $('#io-export-name')?.value ?? '';
  if (nameRaw.trim()) {
    const cut = ex.path.lastIndexOf('/');
    const dir = cut > 0 ? ex.path.slice(0, cut + 1) : '';
    ex.path = normalizeExportPath(`${dir}${nameRaw.trim()}`);
  }
  ex.busy = true;
  ex.error = '';
  renderExport();
  const cut = ex.path.lastIndexOf('/');
  let res;
  try {
    res = await api('hosts:exportFile', {
      scope: sum.ids ? { mode: 'ids', ids: sum.ids } : { mode: 'all' },
      dir: cut > 0 ? ex.path.slice(0, cut) : '',
      filename: cut > 0 ? ex.path.slice(cut + 1) : ex.path,
      passphrase: passOn ? ex.pass : undefined,
      withPasswords: ex.withPass,
      withKeyPaths: ex.withKeyPaths,
    });
  } catch (e) {
    // 失败留在卡里:路径不丢,按钮恢复,原因进底栏(err 文案由后端给)
    ex.busy = false;
    ex.error = e?.message || '导出失败';
    renderExport();
    return;
  }
  ex.busy = false;
  if (!res) {
    renderExport(); // 用户取消保存对话框
    return;
  }
  // encrypted 由本端决定(后端只回 passwordsIncluded),摘要与结果态都读它
  ex.done = { ...res, encrypted: passOn, summary: exportSummary({ ...res, encrypted: passOn }) };
  ex.error = '';
  renderExport();
  renderExportDone();
  toast(ex.done.summary, 'ok', {
    action: { label: '在文件夹中显示', run: () => api('local:reveal', { path: res.path }) },
  });
}

function renderExportDone() {
  const done = ex.done;
  $('#io-export-config')?.classList.toggle('hidden', !!done);
  const box = $('#io-export-done');
  box?.classList.toggle('hidden', !done);
  if (!done) return;
  const ico = $('#io-export-done-ico');
  if (ico) ico.innerHTML = icon('checkCircle');
  const title = $('#io-export-done-title');
  if (title) title.textContent = done.summary;
  const sub = $('#io-export-done-sub');
  if (sub) {
    // 结果态必须说清「下次导入会发生什么」,因为默认就是什么都不带
    let subText;
    if (!done.passwordsIncluded && !done.keyPathsIncluded) subText = '不含密码与密钥路径,导入后需重新填写';
    else if (done.passwordsIncluded && done.encrypted) subText = '密码已用文件口令加密,导入时需要口令';
    else if (done.passwordsIncluded) subText = '密码用内置密钥保护,本机导入可还原';
    else subText = '只含密钥文件路径,换机后需重新选择私钥';
    sub.textContent = subText;
  }
  const pathEl = $('#io-export-done-path');
  if (pathEl) {
    const p = done.path || '';
    const cut = p.lastIndexOf('/');
    pathEl.innerHTML = p
      ? `<span class="io-backup-dir">${escapeHtml(p.slice(0, cut + 1))}</span><b>${escapeHtml(p.slice(cut + 1))}</b>`
      : '';
    pathEl.title = p;
  }
  // 结果态:配置按钮让位给结果动作
  $('#io-export-reveal')?.classList.remove('hidden');
  $('#io-export-cancel')?.classList.add('hidden');
  const ok = $('#io-export-ok');
  if (ok) {
    ok.disabled = false;
    ok.textContent = '完成';
    ok.title = '关闭导出结果';
  }
}

// ---------------------------------------------------------------- 导入

const im = {
  step: 1,
  path: '',
  meta: null,
  inspect: null,
  passphrase: '',
  encrypted: false,
  checking: false,
  error: '',
  busy: false,
  revealPass: false,
  done: null,
  failed: '',
  decision: 'skip',
  perRow: {},
  excluded: new Set(),
  showAll: false,
  // F-04:预检拿到的文件指纹,写入时原样带回;不符则整批拒绝
  digest: '',
  // F-09:结构化问题行 + 用户是否明确同意「只导有效行」(默认 false = 整份拒绝)
  invalid: [],
  partial: false,
  showAllIssues: false,
};
let bound = false;
let dropBound = false;
let inspectSeq = 0;
let passTimer = 0;
const PASS_DEBOUNCE = 450; // 口令输入后等这么久再预检:后端要做一次 scrypt 派生,不能按每个按键发

export function openImportDialog() {
  im.step = 1;
  im.path = '';
  im.meta = null;
  im.inspect = null;
  im.passphrase = '';
  im.encrypted = false;
  im.checking = false;
  im.error = '';
  im.busy = false;
  im.revealPass = false;
  im.done = null;
  im.failed = '';
  im.decision = 'skip';
  im.perRow = {};
  im.excluded = new Set();
  im.showAll = false;
  im.digest = '';
  im.invalid = [];
  im.partial = false;
  im.showAllIssues = false;
  const pass = $('#io-import-pass-input');
  if (pass) pass.value = '';
  const pathInput = $('#io-import-path-input');
  if (pathInput) pathInput.value = '';
  setPassRevealed('import', false);
  renderImport();
  openModal('#modal-import');
  bindDrop();
  setTimeout(() => $('#io-import-pick')?.focus?.(), 30);
}

const conflictRows = () => (im.inspect?.rows || []).filter((r) => r.kind === 'conflict');
const effectiveDecision = (row) => im.perRow[row.key] || (row.kind === 'conflict' ? im.decision : '');
const isExcluded = (row) => im.excluded.has(row.key);
/// 问题行:校验没通过,永远不勾选、永远不写盘(F-09)。
const isInvalid = (row) => row.kind === 'invalid';
/// 会真正写盘的行:未排除、不是「一致」、也不是问题行。
const writableRows = () =>
  (im.inspect?.rows || []).filter((r) => !isExcluded(r) && r.kind !== 'identical' && !isInvalid(r));
/// 有坏行且用户还没勾「只导有效行」:主按钮不可点,默认整份拒绝。
const partialBlocked = () => im.invalid.length > 0 && !im.partial;

function renderImport() {
  const rows = im.inspect?.rows || [];
  const hasFile = !!im.path;
  const locked = hasFile && im.encrypted && !rows.length;
  const stage = im.done ? 'done' : im.failed ? 'failed' : rows.length ? 'preview' : 'pick';
  // 步骤由事件推进(inspect 成功→2,写入结果→3),这里不再"猜"步骤:
  // 否则用户在步骤 2 点「重新选择」会被自动弹回 2,回不去。
  if (stage === 'done' || stage === 'failed') im.step = 3;

  // 步骤条
  document.querySelectorAll('#io-steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('on', n === im.step);
    li.classList.toggle('done', n < im.step);
    if (n === im.step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });

  // 路径框只读展示;只在用户没在拖动选择时重写
  const pathInput = $('#io-import-path-input');
  if (pathInput && pathInput.value !== im.path) pathInput.value = im.path;
  pathInput?.classList.toggle('invalid', !!im.error);
  pathInput?.setAttribute('aria-invalid', im.error ? 'true' : 'false');

  // 口令行:只在文件确实用口令加密时出现
  $('#io-import-pass-row')?.classList.toggle('hidden', !(hasFile && im.encrypted));
  const pass = $('#io-import-pass-input');
  if (pass) {
    pass.classList.toggle('invalid', locked);
    pass.setAttribute('aria-invalid', locked ? 'true' : 'false');
    pass.disabled = im.busy || im.checking || !hasFile;
  }
  $('#btn-reveal-import-pass')?.classList.toggle('hidden', !(hasFile && im.encrypted && im.passphrase.length));

  const errBox = $('#io-import-error');
  errBox?.classList.toggle('hidden', !im.error);
  const errText = $('#io-import-error-t');
  if (errText) errText.textContent = im.error;
  // 路径还在时给一个一键「重新校验」:文件被改后不必重新打开系统文件框
  $('#io-import-recheck')?.classList.toggle('hidden', !(im.error && hasFile));

  const pick = $('#io-import-pick');
  if (pick) {
    pick.disabled = im.busy || im.checking;
    pick.textContent = im.checking ? '正在读取…' : '选择文件';
  }

  // 步骤 1 的拖放区;读取中保留旧预览但降透明度(9.5 加载态)
  const drop = $('#io-import-drop');
  drop?.classList.toggle('hidden', im.step !== 1);
  const dropText = drop?.querySelector('.io-drop-t');
  if (dropText) {
    dropText.textContent = im.checking
      ? '正在读取文件…'
      : hasFile
        ? '把另一个 .json 文件拖到这里可以重新读取'
        : '把导出的 .json 文件拖到这里';
  }

  const preview = $('#io-import-preview');
  preview?.classList.toggle('hidden', im.step !== 2 || !rows.length);
  preview?.classList.toggle('is-loading', im.checking);
  preview?.setAttribute('aria-busy', im.checking ? 'true' : 'false');

  const progress = $('#io-import-progress');
  progress?.classList.toggle('hidden', !im.busy);
  const doneBox = $('#io-import-done');
  doneBox?.classList.toggle('hidden', !(stage === 'done' || stage === 'failed'));

  if (im.step === 2 && rows.length) {
    renderSummary();
    renderIssuebox();
    renderRows();
    renderConflictSegment();
    // 表头全选:只在「有可勾选行」时可用(一致行/问题行永远不勾)
    const selAll = $('#io-import-selectall');
    if (selAll) {
      const pickable = rows.filter((r) => r.kind !== 'identical' && !isInvalid(r));
      const picked = pickable.filter((r) => !isExcluded(r)).length;
      selAll.classList.toggle('disabled', pickable.length === 0);
      const state = picked === 0 || pickable.length === 0 ? 'false' : picked === pickable.length ? 'true' : 'mixed';
      selAll.classList.toggle('on', picked === pickable.length && picked > 0);
      selAll.setAttribute('aria-checked', state);
      selAll.innerHTML = state === 'false' ? '' : state === 'mixed' ? '–' : icon('check', { size: 9 });
    }
  }
  if (stage === 'done' || stage === 'failed') renderResult();

  // 底栏:主按钮文案矩阵 §9.2
  const ok = $('#io-import-ok');
  const cancel = $('#io-import-cancel');
  const back = $('#io-import-back');
  const copy = $('#io-import-copy');
  const reveal = $('#io-import-reveal');
  if (ok) {
    const writable = writableRows().length;
    const blocked = partialBlocked();
    const overwriteCount = (im.inspect?.rows || []).filter(
      (r) => !isExcluded(r) && r.kind === 'conflict' && effectiveDecision(r) === 'overwrite',
    ).length;
    ok.textContent =
      stage === 'done'
        ? '完成'
        : stage === 'failed'
          ? '返回预览'
          : im.busy
            ? '导入中…'
            : blocked
              ? '先处理问题行'
              : im.invalid.length
                ? `只导有效行（${writable} 台）`
                : overwriteCount
                  ? `覆盖 ${overwriteCount} 台并导入`
                  : `导入 ${writable} 台`;
    ok.disabled = im.busy || im.checking || (stage !== 'done' && stage !== 'failed' && (writable === 0 || blocked));
    ok.title =
      stage === 'done'
        ? '关闭结果报告'
        : stage === 'failed'
          ? '写入没有发生,回到预览可以重试'
          : blocked
            ? `文件里有 ${im.invalid.length} 行问题数据;勾选「跳过这些问题行」后才能导入其余主机`
            : writable === 0
              ? '没有选中任何主机'
              : '';
  }
  cancel?.classList.toggle('hidden', stage === 'done');
  if (cancel) cancel.textContent = stage === 'failed' ? '关闭' : '取消';
  cancel?.toggleAttribute('disabled', im.busy);
  back?.classList.toggle('hidden', stage !== 'preview');
  copy?.classList.toggle('hidden', stage !== 'done');
  reveal?.classList.toggle('hidden', stage !== 'done' || !im.done?.result?.backup);
  const close = $('#io-import-close');
  if (close) {
    close.disabled = im.busy;
    close.title = im.busy ? '写入进行中,请等待完成' : '关闭 (Esc)';
  }

  // 状态位:出错 → 过程 → 常驻说明
  const hint = $('#io-import-hint');
  if (hint) {
    hint.classList.toggle('bad', !!im.error);
    if (im.busy) hint.textContent = '';
    else if (im.failed) hint.textContent = '';
    else if (im.error) hint.textContent = '';
    else if (im.checking) hint.textContent = '正在读取文件…';
    else if (locked) hint.textContent = '该文件用口令加密,请输入文件口令';
    else if (!hasFile) hint.textContent = '';
    else if (im.invalid.length)
      hint.textContent = im.partial
        ? `将跳过 ${im.invalid.length} 行问题数据,只导入有效行`
        : `有 ${im.invalid.length} 行无法导入:修正文件后重新校验,或勾选「只导有效行」`;
    else if (im.inspect?.legacyPlaintext) hint.textContent = '该文件含明文凭据,导入后建议重新导出一份';
    else if (im.meta?.encryption === 'builtin') hint.textContent = '凭据用内置密钥加密:同一版本的 App 都能解开,等同明文,请按密码本对待';
    else hint.textContent = '导入前会自动备份当前主机库';
  }
}

function renderSummary() {
  const rows = im.inspect?.rows || [];
  const counts = im.inspect?.counts || {};
  const writable = rows.filter((r) => r.kind !== 'identical').length;
  const box = $('#io-import-summary');
  if (!box) return;
  const picked = writableRows().length;
  const invalid = im.invalid.length;
  box.innerHTML = [
    `<span class="io-sum-item">共 <b>${rows.length}</b> 台</span>`,
    `<span class="io-sum-sep" aria-hidden="true">·</span>`,
    `<span class="io-sum-item">将导入 <b>${picked}</b> 台</span>`,
    ...(invalid
      ? [
          `<span class="io-sum-sep" aria-hidden="true">·</span>`,
          `<span class="io-sum-item bad">${invalid} 行有问题</span>`,
        ]
      : []),
    `<span class="io-chip add">新增 <b>${counts.add || 0}</b></span>`,
    `<span class="io-chip cred">补凭据 <b>${counts.credOnly || 0}</b></span>`,
    `<span class="io-chip warn">冲突 <b>${counts.conflict || 0}</b></span>`,
    `<span class="io-chip mute">一致 <b>${counts.identical || 0}</b></span>`,
  ].join('');
}

function renderRows() {
  const rows = im.inspect?.rows || [];
  const order = { conflict: 0, credOnly: 1, add: 2, identical: 3, invalid: 4 };
  const sorted = [...rows].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  const limit = im.showAll ? sorted.length : 10;
  const visible = sorted.slice(0, limit);
  const posOf = new Map(rows.map((r, i) => [r.key, i + 1]));
  const body = $('#io-import-rows');
  if (!body) return;
  body.innerHTML = visible
    .map((r) => {
      const diff = r.kind === 'conflict' ? (r.diff || []).filter(Boolean) : [];
      // 问题行:第二行显示第一条原因(剩下的在问题区里),让列表本身也能定位
      const issueLine = isInvalid(r)
        ? [r.errors?.[0] ? `${r.errors[0].field}：${r.errors[0].reason}` : '校验失败']
        : [];
      const noteRow = diff.length || issueLine.length
        ? `<div class="io-r-diffrow${isInvalid(r) ? ' bad' : ''}" title="${escapeHtml((diff.length ? diff : issueLine).join(' · '))}">${escapeHtml((diff.length ? diff : issueLine).slice(0, 2).join(' · '))}${(diff.length || issueLine.length) > 2 ? ' …' : ''}</div>`
        : '';
      const disabled = r.kind === 'identical' || isInvalid(r);
      const checked = !isExcluded(r) && !disabled;
      const dec = isInvalid(r)
        ? `<span class="io-r-kind invalid">${KIND_LABEL.invalid}</span>`
        : r.kind === 'conflict'
          ? `<select class="io-mini-sel" data-key="${escapeHtml(r.key)}" aria-label="第 ${posOf.get(r.key)} 台的处置">
             <option value="skip"${effectiveDecision(r) === 'overwrite' ? '' : ' selected'}>跳过</option>
             <option value="overwrite"${effectiveDecision(r) === 'overwrite' ? ' selected' : ''}>覆盖</option>
           </select>`
          : `<span class="io-r-kind ${r.kind}">${KIND_LABEL[r.kind] || r.kind}</span>`;
      return `<div class="io-item k-${r.kind}${diff.length || issueLine.length ? ' has-diff' : ''}${isExcluded(r) ? ' is-out' : ''}">
        <span class="io-c-check"><span class="hl-box${checked ? ' on' : ''}" role="checkbox" tabindex="${disabled ? -1 : 0}"
          aria-checked="${checked}" aria-label="第 ${posOf.get(r.key)} 台 ${escapeHtml(r.name || '')}"
          data-key="${escapeHtml(r.key)}" data-disabled="${disabled}">${checked ? icon('check', { size: 9 }) : ''}</span></span>
        <span class="io-r-pos mono">#${posOf.get(r.key)}</span>
        <span class="io-r-name" title="${escapeHtml(r.name || '')}">${escapeHtml(r.name || r.host || '')}</span>
        <span class="io-r-addr mono" title="${escapeHtml(`${r.username || ''}@${r.host || ''}:${r.port || 22}`)}">${escapeHtml(r.username || '')}@${escapeHtml(r.host || '')}:${r.port || 22}</span>
        <span class="io-r-group">${escapeHtml(r.group || '—')}</span>
        <span class="io-r-cred ${r.hasCredentials ? 'yes' : 'no'}">${r.hasCredentials ? '有' : '无'}</span>
        <span class="io-r-dec">${dec}</span>
        ${noteRow}
      </div>`;
    })
    .join('');

  const more = $('#io-import-more');
  const rest = sorted.length - visible.length;
  if (more) {
    more.classList.toggle('hidden', sorted.length <= 10);
    more.textContent = im.showAll ? '收起' : `查看全部 ${sorted.length} 台`;
    more.setAttribute('aria-expanded', im.showAll ? 'true' : 'false');
  }
  if (rest > 0 && !im.showAll) more?.setAttribute('title', sorted.slice(10).map((r) => r.name || r.host).join('、'));
}

/// 问题区(F-09):坏行结构化列出(位置 · 主机 · 字段:原因),可展开;
/// 「只导有效行」必须由用户明确勾选 —— 默认整份拒绝是安全默认。
function renderIssuebox() {
  const box = $('#io-import-errorbox');
  if (!box) return;
  const issues = im.invalid || [];
  box.classList.toggle('hidden', issues.length === 0);
  if (!issues.length) return;
  const valid = writableRows().length;
  const title = $('#io-issuebox-title');
  if (title) title.textContent = `${issues.length} 行无法导入`;
  const list = $('#io-issuebox-list');
  if (list) {
    const limit = im.showAllIssues ? issues.length : 3;
    list.innerHTML = issues
      .slice(0, limit)
      .map((it) => {
        const loc = it.line ? `第 ${it.line} 行` : `第 ${it.index} 台`;
        return `<li><span class="io-issue-loc">${escapeHtml(loc)}</span>${
          it.name ? ` <span class="io-issue-name">${escapeHtml(it.name)}</span>` : ''
        } · ${escapeHtml(it.field)}：${escapeHtml(it.reason)}</li>`;
      })
      .join('');
  }
  const more = $('#io-issuebox-more');
  if (more) {
    more.classList.toggle('hidden', issues.length <= 3);
    more.textContent = im.showAllIssues ? '收起' : `查看全部 ${issues.length} 行`;
    more.setAttribute('aria-expanded', im.showAllIssues ? 'true' : 'false');
  }
  const chk = $('#io-issuebox-partial');
  if (chk) {
    chk.classList.toggle('on', im.partial);
    chk.setAttribute('aria-checked', im.partial ? 'true' : 'false');
    chk.innerHTML = im.partial ? icon('check', { size: 9 }) : '';
  }
  const note = $('#io-issuebox-partial-note');
  if (note) {
    note.textContent = im.partial
      ? `将跳过这 ${issues.length} 行,导入其余 ${valid} 台`
      : '不勾选则整份文件都不导入';
  }
}

function renderConflictSegment() {
  const conflicts = conflictRows();
  const seg = $('#io-import-conflicts');
  seg?.classList.toggle('hidden', conflicts.length === 0);
  if (!conflicts.length) return;
  const note = $('#io-conflict-count');
  if (note) note.textContent = `${conflicts.length} 台与本地配置不同`;
  document.querySelectorAll('#io-import-decisions .io-seg').forEach((btn) => {
    const on = btn.dataset.decision === im.decision;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $('#io-import-overwrite-scope')?.classList.toggle('hidden', im.decision !== 'overwrite');
}

async function inspect(path) {
  const seq = ++inspectSeq;
  clearTimeout(passTimer);
  im.checking = true;
  im.error = '';
  im.failed = '';
  im.done = null;
  renderImport();
  let res;
  try {
    res = await api('hosts:importInspect', { path: path || '', passphrase: im.passphrase || '' });
  } catch (e) {
    if (seq !== inspectSeq) return;
    // 读取失败 = 回到步骤 1 的单一错误块,并清掉上一份文件的预览与结果(U-02)。
    // 注意:口令错时不能把口令行收起来 —— 那正是用户要重输的地方。
    im.checking = false;
    im.error = e?.message || '读取文件失败';
    im.inspect = null;
    im.meta = null;
    im.digest = '';
    im.invalid = [];
    im.partial = false;
    if (!im.passphrase) im.encrypted = false;
    im.done = null;
    im.step = 1;
    if (path) im.path = path;
    renderImport();
    setTimeout(() => $('#io-import-error')?.scrollIntoView?.({ block: 'nearest' }), 0);
    const pass = $('#io-import-pass-input');
    if (pass && !pass.disabled) pass.focus();
    return;
  }
  if (seq !== inspectSeq) return;
  im.checking = false;
  if (res === null || res === undefined) {
    renderImport(); // 用户取消选择
    return;
  }
  im.path = res.path || path || '';
  im.meta = res.file || null;
  im.digest = res.digest || '';
  im.inspect = res.needsPassphrase ? null : res.inspect;
  im.invalid = res.needsPassphrase ? [] : res.inspect?.invalidRows || [];
  im.partial = false;
  im.showAllIssues = false;
  im.encrypted = !!res.needsPassphrase || im.meta?.encryption === 'passphrase';
  im.error = '';
  im.perRow = {};
  im.decision = 'skip'; // 新文件回到默认策略(冲突默认跳过)
  im.excluded = new Set();
  im.showAll = false;
  im.step = im.inspect?.rows?.length ? 2 : 1;
  renderImport();
  if (res.needsPassphrase) $('#io-import-pass-input')?.focus?.();
  if (im.step === 2) setTimeout(() => $('#io-import-title')?.focus?.(), 0);
}

function schedulePassCheck() {
  clearTimeout(passTimer);
  if (!im.path || !im.passphrase) return;
  passTimer = setTimeout(() => {
    if (im.path && im.passphrase) inspect(im.path);
  }, PASS_DEBOUNCE);
}

/** .json 拖放:导入卡开着 → 预检该文件;主机库开着 → 打开导入卡并预检(设计 §1)。
 *  其它情况不碰,交给 entry.js 的文件面板上传。 */
function bindDrop() {
  if (dropBound) return;
  dropBound = true;
  const win = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
  win?.onDragDropEvent?.(({ payload }) => {
    if (payload?.type !== 'drop') return;
    const paths = payload.paths || [];
    if (!paths.length) return;
    const json = paths.filter((p) => /\.json$/i.test(p));
    const importOpen = !document.getElementById('modal-import')?.classList.contains('hidden');
    const libraryOpen = !document.getElementById('modal-host-library')?.classList.contains('hidden');
    if (!importOpen && !libraryOpen) return;
    if (!json.length) {
      if (importOpen) {
        im.error = '只支持 .json 文件';
        renderImport();
      }
      return;
    }
    if (json.length > 1) {
      if (importOpen) {
        im.error = '一次只能导入一个文件';
        renderImport();
      }
      return;
    }
    if (!importOpen) openImportDialog();
    im.step = 1;
    inspect(json[0]);
  });
}

function reportText() {
  const result = im.done?.result;
  if (!result) return '';
  const t = tallyResult(result.rows);
  const name = im.meta?.name || (im.path || '').split('/').pop() || '';
  return [
    'NebulaShell 主机导入报告',
    `时间: ${new Date().toLocaleString()}`,
    `文件: ${name}`,
    `结果: 新增 ${t.written} · 覆盖 ${t.overwritten} · 补凭据 ${t.filled} · 跳过 ${t.skipped} · 未改动 ${t.unchanged}`,
    `备份: ${result.backup || '(未生成)'}`,
    '',
    '明细:',
    ...(result.rows || []).map((r) => {
      // F-15:私钥写失败的告警跟着行走,复制报告/下载明细里不能丢
      const warns = (r.warnings || []).filter(Boolean);
      const tail = warns.length ? `（${warns.join('；')}）` : '';
      return `  ${r.name || r.key} — ${RESULT_LABEL[r.result] || r.result}${tail}`;
    }),
  ].join('\n');
}

async function runApply() {
  if (im.busy || !im.path || !im.inspect?.rows?.length) return;
  if (partialBlocked()) return; // 有坏行且用户没勾「只导有效行」:默认整份拒绝
  const decisions = {};
  for (const row of im.inspect.rows) {
    if (isInvalid(row)) continue;
    if (isExcluded(row)) decisions[row.key] = 'skip';
    else if (row.kind === 'conflict') decisions[row.key] = effectiveDecision(row) === 'overwrite' ? 'overwrite' : 'skip';
  }
  im.busy = true;
  im.error = '';
  im.failed = '';
  renderImport();
  let res;
  try {
    res = await api('hosts:importApply', {
      path: im.path,
      passphrase: im.passphrase,
      decisions,
      // F-04:预检时确认的那份文件指纹;后端读写各一次,靠它把两次钉在一起
      digest: im.digest,
      // F-09:只有用户明确勾选才允许跳过问题行
      allowPartial: im.partial && im.invalid.length > 0,
    });
  } catch (e) {
    const msg = String(e?.message || '');
    // 文件在确认后被改过:写入没有发生,把卡片退回步骤 1 并保留路径让用户重新校验
    if (msg.startsWith('E_FILE_CHANGED')) {
      im.busy = false;
      im.step = 1;
      im.error = msg.replace(/^E_FILE_CHANGED:\s*/, '');
      im.inspect = null;
      im.invalid = [];
      im.partial = false;
      im.meta = null;
      im.digest = '';
      im.failed = '';
      im.done = null;
      renderImport();
      setTimeout(() => $('#io-import-error')?.scrollIntoView?.({ block: 'nearest' }), 0);
      return;
    }
    // 写入是整批原子:失败 = 什么都没写。留在卡里,失败原因写在结果态横幅里。
    im.busy = false;
    im.failed = msg || '导入失败,请检查文件后重试';
    renderImport();
    return;
  }
  im.busy = false;
  if (res?.needsPassphrase) {
    renderImport();
    return;
  }
  if (!res?.result) {
    im.failed = '后端没有返回结果,请重新读取文件后再试';
    renderImport();
    return;
  }
  // 结果态是唯一报数处(D8):不再弹 toast
  im.done = { at: Date.now(), result: res.result };
  renderImport();
  refreshHosts();
}

/// 结果报告:整批统计 + 逐条处置 + 备份路径。写入是整批原子,
/// 所以没有"单条失败重试",失败只有整批未写入一种形态。
function renderResult() {
  const failed = !!im.failed;
  const result = im.done?.result || null;
  const t = tallyResult(result?.rows);
  const written = t.written + t.overwritten + t.filled;

  $('#io-done-banner')?.classList.toggle('bad', failed);
  const ico = $('#io-done-ico');
  if (ico) ico.innerHTML = icon(failed ? 'alert' : 'checkCircle');
  const title = $('#io-done-title');
  if (title) title.textContent = failed ? '导入失败' : `已导入 ${written} 台主机`;
  const sub = $('#io-done-sub');
  const keyWarnings = (result?.rows || []).reduce((n, r) => n + (r.warnings?.length || 0), 0);
  if (sub) {
    if (failed) {
      sub.textContent = `本次没有写入任何主机,主机库与导入前完全一致${im.failed ? `(${im.failed})` : ''}`;
    } else {
      // F-15:私钥写失败不再静默 —— 成功态副标题也让用户看见(逐行原因在下面明细里)
      const base = result?.backup ? '导入前的配置已备份到本地' : '主机库已更新';
      sub.textContent = keyWarnings ? `${base} · ${keyWarnings} 个私钥写入失败` : base;
    }
  }

  const stats = $('#io-done-stats');
  if (stats) {
    stats.innerHTML = failed
      ? ''
      : [
          ['新增', t.written, 'add'],
          ['覆盖', t.overwritten, 'overwrite'],
          ['补凭据', t.filled, ''],
          ['跳过', t.skipped, 'skip'],
          ['未改动', t.unchanged, ''],
          ...(t.invalid ? [['问题行', t.invalid, 'invalid']] : []),
        ]
          .filter(([, v]) => v > 0 || true)
          .map(([k, v, tone]) => `<div class="io-stat ${tone}"><span class="io-stat-k">${k}</span><span class="io-stat-v">${v}</span></div>`)
          .join('');
  }

  const NOTE = {
    written: '新加入主机库',
    overwritten: '已用文件覆盖',
    filled: '已补全凭据',
    skipped: '按决策跳过,本地保留',
    unchanged: '与本地一致',
    invalid: '校验失败,未导入',
  };
  const list = $('#io-done-rows');
  if (list) {
    const rows = failed ? [] : result?.rows || [];
    list.classList.toggle('hidden', !rows.length);
    list.innerHTML = rows
      .map(
        (r) => {
          // F-15:私钥写入失败等落盘告警压过普通说明,并标黄(标题里带完整原因)
          const warns = (r.warnings || []).filter(Boolean);
          const note = warns.length ? warns.join('；') : NOTE[r.result] || '';
          return `<div class="io-item">
        <span class="io-r-name" title="${escapeHtml(r.name || r.key || '')}">${escapeHtml(r.name || r.key || '')}</span>
        <span class="io-r-note${warns.length ? ' is-warn' : ''}" title="${escapeHtml(note)}">${escapeHtml(note)}</span>
        <span class="io-r-res ${r.result}">${RESULT_LABEL[r.result] || r.result}</span>
      </div>`;
        },
      )
      .join('');
  }

  const backupRow = $('#io-done-backup');
  const backupPath = $('#io-done-backup-path');
  backupRow?.classList.toggle('hidden', failed || !result?.backup);
  if (backupPath) {
    const p = (!failed && result?.backup) || '';
    const cut = p.lastIndexOf('/');
    backupPath.innerHTML = p
      ? `<span class="io-backup-dir">${escapeHtml(p.slice(0, cut + 1))}</span><b>${escapeHtml(p.slice(cut + 1))}</b>`
      : '';
    backupPath.title = p;
  }
}

// ---------------------------------------------------------------- 绑定

export function setupTransfer() {
  if (bound) return;
  bound = true;
  // 拖放监听在 boot 就挂上:库内拖入 .json 也要能直接进导入
  bindDrop();
  // 行列表的底部渐隐(全局滚动容器规则):登记一次,MutationObserver 会跟着行重绘走
  observeScrollFade(document.querySelector('#io-import-rows'));

  // ---- 导出
  $('#io-export-pick')?.addEventListener('click', pickExportDir);
  $('#io-export-scope')?.addEventListener('change', (e) => {
    ex.scope = e.target.value;
    ex.done = null;
    renderExport();
  });
  $('#io-export-name')?.addEventListener('input', (e) => {
    const cut = ex.path.lastIndexOf('/');
    const dir = cut > 0 ? ex.path.slice(0, cut + 1) : '';
    ex.path = `${dir}${e.target.value}`;
    if (ex.error) {
      ex.error = '';
      renderExport();
    }
  });
  $('#io-export-name')?.addEventListener('blur', () => {
    // 只规范化输入框里的值,不在这里重绘整张卡:
    // 重绘会在 mousedown 与 mouseup 之间改按钮文本/布局,WebKit 会因此吞掉对「导出」的点击。
    const cut = ex.path.lastIndexOf('/');
    const dir = cut > 0 ? ex.path.slice(0, cut + 1) : '';
    ex.path = normalizeExportPath(`${dir}${$('#io-export-name')?.value ?? ''}`);
    const input = $('#io-export-name');
    if (input) input.value = cut > 0 ? ex.path.slice(ex.path.lastIndexOf('/') + 1) : ex.path;
  });
  // 两个开关各自独立:关密码不动密钥路径,反之亦然。
  $('#io-export-with-pass')?.addEventListener('change', (e) => {
    ex.withPass = !!e.target.checked;
    // 密码关掉 = 没有可加密的内容,口令状态一并复位(否则再勾回来会带着旧口令)
    if (!ex.withPass) {
      ex.usePass = false;
      const on = $('#io-export-use-pass');
      if (on) on.checked = false;
    }
    renderExport();
  });
  $('#io-export-with-keypaths')?.addEventListener('change', (e) => {
    ex.withKeyPaths = !!e.target.checked;
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
  $('#io-export-pass2')?.addEventListener('input', (e) => {
    ex.pass2 = e.target.value;
    renderExport();
  });
  $('#btn-reveal-export-pass')?.addEventListener('click', () => {
    setPassRevealed('export', !ex.revealPass);
    $('#io-export-pass-input')?.focus?.();
  });
  $('#io-export-ok')?.addEventListener('click', () => {
    if (ex.done) { closeModal('#modal-export'); return; }
    runExport();
  });
  $('#io-export-again')?.addEventListener('click', () => {
    ex.done = null;
    ex.error = '';
    renderExport();
    renderExportDone();
    ['#io-export-reveal', '#io-export-copy', '#io-export-again'].forEach((sel) => $(sel)?.classList.add('hidden'));
    $('#io-export-cancel')?.classList.remove('hidden');
    $('#io-export-config')?.classList.remove('hidden');
    const ok = $('#io-export-ok');
    if (ok) { ok.textContent = '导出'; ok.title = ''; }
  });
  $('#io-export-copy')?.addEventListener('click', async () => {
    const ok = await copyText(ex.done?.path || '');
    toast(ok ? '路径已复制' : '复制失败', ok ? 'ok' : 'error');
  });
  $('#io-export-reveal')?.addEventListener('click', () => {
    const p = ex.done?.path;
    if (p) api('local:reveal', { path: p }).catch((e) => toast(e?.message || '无法打开文件夹', 'error'));
  });
  $('#io-export-cancel')?.addEventListener('click', () => closeModal('#modal-export'));
  $('#io-export-close')?.addEventListener('click', () => closeModal('#modal-export'));
  setModalDismissHandler('#modal-export', () => !ex.busy);

  // ---- 导入
  const pickFile = () => {
    if (im.busy || im.checking) return;
    inspect('');
  };
  $('#io-import-pick')?.addEventListener('click', pickFile);
  $('#io-import-reselect')?.addEventListener('click', pickFile);
  // 文件被改后的一键重校:用保留的路径再读一次,不弹系统文件框
  $('#io-import-recheck')?.addEventListener('click', () => {
    if (im.busy || im.checking || !im.path) return;
    inspect(im.path);
  });
  $('#io-import-back')?.addEventListener('click', () => {
    if (im.busy) return;
    im.step = 1;
    renderImport();
    setTimeout(() => $('#io-import-pick')?.focus?.(), 0);
  });
  $('#io-import-more')?.addEventListener('click', () => {
    im.showAll = !im.showAll;
    renderRows();
  });
  // 问题区:展开全部问题行
  $('#io-issuebox-more')?.addEventListener('click', () => {
    im.showAllIssues = !im.showAllIssues;
    renderIssuebox();
  });
  // 「只导有效行」必须由用户明确勾选(默认整份拒绝是安全默认)
  const togglePartial = () => {
    if (im.busy) return;
    im.partial = !im.partial;
    renderImport();
  };
  $('#io-issuebox-partial-row')?.addEventListener('click', togglePartial);
  $('#io-issuebox-partial')?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      togglePartial();
    }
  });
  // 表头全选 / 全不选(只作用于可勾选行;问题行永远不勾)
  const toggleAll = () => {
    if (im.busy) return;
    const pickable = (im.inspect?.rows || []).filter((r) => r.kind !== 'identical' && !isInvalid(r));
    const allPicked = pickable.length > 0 && pickable.every((r) => !isExcluded(r));
    if (allPicked) pickable.forEach((r) => im.excluded.add(r.key));
    else im.excluded.clear();
    renderImport();
  };
  $('#io-import-selectall')?.addEventListener('click', toggleAll);
  $('#io-import-selectall')?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAll(); }
  });
  document.querySelectorAll('#io-import-decisions .io-seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (im.busy) return;
      im.decision = btn.dataset.decision === 'overwrite' ? 'overwrite' : 'skip';
      im.perRow = {}; // 全局策略覆盖逐台选择(§6.7)
      renderImport();
    });
  });
  // 行内:勾选 = 是否导入;冲突行的下拉 = 逐台处置
  $('#io-import-rows')?.addEventListener('click', (e) => {
    const box = e.target.closest('.hl-box[data-key]');
    if (!box || im.busy || box.dataset.disabled === 'true') return;
    const key = box.dataset.key;
    if (im.excluded.has(key)) im.excluded.delete(key);
    else im.excluded.add(key);
    renderImport();
  });
  $('#io-import-rows')?.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const box = e.target.closest('.hl-box[data-key]');
    if (!box) return;
    e.preventDefault();
    box.click();
  });
  $('#io-import-rows')?.addEventListener('change', (e) => {
    const sel = e.target.closest('.io-mini-sel[data-key]');
    if (!sel || im.busy) return;
    im.perRow[sel.dataset.key] = sel.value === 'overwrite' ? 'overwrite' : 'skip';
    renderImport();
  });
  $('#io-import-cancel')?.addEventListener('click', () => closeModal('#modal-import'));
  $('#io-import-close')?.addEventListener('click', () => closeModal('#modal-import'));
  $('#io-import-ok')?.addEventListener('click', () => {
    if (im.done) { closeModal('#modal-import'); return; }
    if (im.failed) { im.failed = ''; im.step = 2; renderImport(); return; }
    runApply();
  });
  $('#io-import-copy')?.addEventListener('click', async () => {
    const ok = await copyText(reportText());
    toast(ok ? '导入报告已复制' : '复制失败', ok ? 'ok' : 'error');
  });
  $('#io-import-reveal')?.addEventListener('click', () => {
    const path = im.done?.result?.backup;
    if (!path) return;
    api('local:reveal', { path }).catch((e) => toast(e?.message || '无法打开文件夹', 'error'));
  });
  setModalDismissHandler('#modal-import', () => !im.busy);

  // 口令:输入即校验(防抖),回车立刻校验;失败原因写错误块
  $('#io-import-pass-input')?.addEventListener('input', (e) => {
    im.passphrase = e.target.value;
    const len = String(e.target.value || '').length;
    $('#btn-reveal-import-pass')?.classList.toggle('hidden', len === 0);
    if (len === 0 && im.revealPass) setPassRevealed('import', false);
    im.error = '';
    schedulePassCheck();
  });
  $('#io-import-pass-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(passTimer);
      if (im.path && im.passphrase) inspect(im.path);
    }
  });
  $('#btn-reveal-import-pass')?.addEventListener('click', () => {
    setPassRevealed('import', !im.revealPass);
    $('#io-import-pass-input')?.focus?.();
  });

  // 主按钮快捷键(⌘↵ / Ctrl+Enter),禁用时不触发
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    const target = document.activeElement;
    const inExport = target?.closest?.('#modal-export');
    const inImport = target?.closest?.('#modal-import');
    if (inExport) {
      e.preventDefault();
      if (!$('#io-export-ok')?.disabled) $('#io-export-ok')?.click();
    } else if (inImport) {
      e.preventDefault();
      if (!$('#io-import-ok')?.disabled) $('#io-import-ok')?.click();
    }
  });
}
