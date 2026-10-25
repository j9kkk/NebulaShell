// 云主机导入:多账号凭据 + 全区域一键拉取
import { $, PROVIDER_LABEL, api, askConfirm, closeModal, state, toast } from './core.js';
import { connectHost } from './terminal.js';
import { escapeHtml, refreshHosts, secretMask } from './hosts.js';
import { icon } from '../shared/icons.js';

export const VENDOR_LABEL = { tencent: '腾讯云', aliyun: '阿里云' };
export const SERVICE_LABEL = { cvm: 'CVM', lighthouse: '轻量', aliyun: 'ECS', tencent: 'CVM' };
export const CLOUD_OFFICIAL_ENDPOINTS = {
  tencent: 'https://cvm.tencentcloudapi.com',
  aliyun: 'https://ecs.aliyuncs.com',
};

// 密钥获取帮助:随表单厂商切换;外链仅白名单控制台域名(见 commands.rs regex_lite)。
// 多账号重构(90f0e96)时整块随旧 UI 丢失,现恢复并挂到新表单里。
export const CLOUD_KEY_HELP = {
  tencent: `<b>腾讯云 SecretId / SecretKey</b> 获取：登录控制台 → <span class="help-link" data-url="https://console.cloud.tencent.com/cam/capi">访问管理 CAM · API 密钥管理</span> → 「新建密钥」。建议使用子用户密钥并仅授予只读策略 <b>QcloudCVMReadOnlyAccess</b>（轻量服务器为 <b>QcloudLighthouseReadOnlyAccess</b>），避免直接使用主账号密钥。`,
  aliyun: `<b>阿里云 AccessKeyId / AccessKeySecret</b> 获取：登录控制台 → <span class="help-link" data-url="https://ram.console.aliyun.com/manage/ak">RAM 访问控制 · AccessKey 管理</span> → 「创建 AccessKey」。<b>AccessKeySecret 仅在创建时显示一次</b>，请立即保存；建议创建 RAM 子用户并仅授予只读权限 <b>AliyunECSReadOnlyAccess</b>。`,
};
export const CLOUD_KEY_HELP_FOOT = '密钥仅加密保存在本机，不会上传到任何第三方服务器。';

export function providerLabel(p) { return PROVIDER_LABEL[p] || p; }

/// 账号列表(含已保存凭据的形态)。secret 不回传,编辑时留空 = 保持不变
export async function refreshCloudAccounts() {
  const r = await api('cloud:accounts');
  state.cloudAccounts = r.accounts || [];
  renderCloudAccounts();
  renderCloudImportStrip();
}

export function renderCloudAccounts() {
  const box = $('#cloud-accounts');
  if (!box) return;
  // 编辑器可能被移动到账号行下方,list 重建前先摘下,渲染完按当前编辑态归位
  const form = $('#cloud-account-form');
  const formOpen = form && !form.classList.contains('hidden');
  form?.remove();
  box.innerHTML = '';
  const countEl = $('#settings-cloud-count');
  if (countEl) countEl.textContent = `共 ${state.cloudAccounts.length} 个账号`;
  if (!state.cloudAccounts.length) {
    box.innerHTML = '<div class="muted small-note" style="padding:10px 4px;">尚未添加云账号。添加后即可一键拉取该账号下所有地域的主机（腾讯云自动包含 CVM 与轻量）。</div>';
    if (form) {
      if (formOpen) attachCloudForm(form);
      else { box.after(form); form.classList.add('hidden'); }
    }
    return;
  }
  for (const a of state.cloudAccounts) {
    const row = document.createElement('div');
    row.className = 'cloud-account-row';
    row.dataset.accountId = a.id;
    if (state.cloudEditing?.id === a.id) row.classList.add('editing');
    const vendorClass = a.vendor === 'aliyun' ? 'aliyun' : 'tencent';
    const vendorName = VENDOR_LABEL[a.vendor] || a.vendor;
    const scopeText = a.vendor === 'aliyun' ? 'ECS (自动探测)' : 'CVM + 轻量 (自动探测)';
    row.innerHTML = `
      <div class="cloud-card-row1">
        <span class="cloud-vendor-pill ${vendorClass}">${escapeHtml(vendorName)}</span>
        <span class="cloud-card-label ca-label">${escapeHtml(a.label || '(未命名)')}</span>
        <div class="cloud-card-actions">
          <button class="btn small ca-test" type="button" title="测试该账号凭据有效性">测试</button>
          <button class="btn small ca-edit" type="button">编辑</button>
          <button class="btn small ghost danger ca-del" type="button">删除</button>
        </div>
      </div>
      <div class="cloud-card-row2">
        <span class="cloud-card-key ca-key mono">${escapeHtml(a.keyId || '')}</span>
        ${a.secretSet ? '<span class="cloud-status-dot ok ca-ok">● 密钥已保存</span>' : '<span class="cloud-status-dot warn ca-miss">● 缺密钥</span>'}
        <span class="cloud-scope-hint">${escapeHtml(scopeText)}</span>
      </div>
      <div class="cloud-card-test-result hidden" id="cloud-test-result-${escapeHtml(a.id)}"></div>`;

    const testBtn = row.querySelector('.ca-test');
    const testResultEl = row.querySelector(`#cloud-test-result-${CSS.escape(a.id)}`);
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResultEl.className = 'cloud-card-test-result';
      testResultEl.classList.remove('hidden');
      testResultEl.textContent = '正在探测所有地域并校验凭据…';
      try {
        const r = await api('cloud:testAccount', { id: a.id });
        testResultEl.className = 'cloud-card-test-result success';
        testResultEl.textContent = `✓ 校验通过：${r.regionCount} 个地域，共发现 ${r.instanceCount} 台实例` +
          (r.errorCount ? `；另有 ${r.errorCount} 项地域查询失败` : '');
        toast('凭据校验通过', 'success');
      } catch (e) {
        testResultEl.className = 'cloud-card-test-result error';
        testResultEl.textContent = '✗ 校验失败：' + e.message;
        toast('校验失败：' + e.message, 'error');
      } finally {
        testBtn.disabled = false;
      }
    });

    row.querySelector('.ca-edit').addEventListener('click', () => editCloudAccount(a));
    row.querySelector('.ca-del').addEventListener('click', async () => {
      if (!(await askConfirm(`删除云账号「${a.label || a.keyId}」?已导入的主机不受影响。`, { title: '删除云账号', okText: '删除' }))) return;
      await api('cloud:deleteAccount', { id: a.id });
      if (state.cloudEditing?.id === a.id) closeCloudForm();
      await refreshCloudAccounts();
    });
    box.appendChild(row);
  }
  if (form) {
    if (formOpen) attachCloudForm(form);
    else {
      form.classList.remove('inline');
      form.classList.add('hidden');
      box.after(form);
    }
  }
}

/// 折叠编辑器的落位:编辑已有账号 → 嵌入该账号卡片内部(与信息区融为一体,
/// 加 .inline 走无边框分隔线样式);新增 → 列表顶部独立卡片(无账号可依附)。
/// 账号行已被删除等找不到目标时收起编辑器。
function attachCloudForm(form) {
  const list = $('#cloud-accounts');
  if (!list) return;
  if (state.cloudEditing) {
    const row = list.querySelector(`.cloud-account-row[data-account-id="${CSS.escape(state.cloudEditing.id)}"]`);
    if (row) {
      row.appendChild(form);
      form.classList.add('inline');
      return;
    }
    closeCloudForm();
    return;
  }
  form.classList.remove('inline');
  const first = list.querySelector('.cloud-account-row');
  if (first) first.before(form);
  else list.appendChild(form);
}

/// 云导入向导瘦身横条与零账号引导状态
export function renderCloudImportStrip() {
  const strip = $('#cloud-import-account-strip');
  if (!strip) return;
  const summaryEl = $('#cloud-strip-summary');
  const hintEl = $('#cloud-strip-hint');
  const fetchBtn = $('#btn-cloud-fetch');
  const emptyGuide = $('#cloud-import-empty-guide');
  const cloudTable = $('#cloud-table');
  const statusEl = $('#cloud-status');

  const count = state.cloudAccounts.length;
  if (count === 0) {
    strip.classList.add('empty');
    if (summaryEl) summaryEl.textContent = '尚未配置云厂商 API 凭据，无法探测云端实例';
    if (hintEl) hintEl.classList.add('hidden');
    if (fetchBtn) fetchBtn.disabled = true;
    if (statusEl) statusEl.textContent = '请先在设置中添加云账号';
    if (emptyGuide && !state.cloudResults?.length) emptyGuide.classList.remove('hidden');
    if (cloudTable && !state.cloudResults?.length) cloudTable.classList.add('hidden');
  } else {
    strip.classList.remove('empty');
    const names = state.cloudAccounts.map((a) => `${VENDOR_LABEL[a.vendor] || a.vendor}${a.label ? ' (' + a.label + ')' : ''}`).join('、');
    if (summaryEl) summaryEl.innerHTML = `已生效 <b>${count} 个云账号</b>：${escapeHtml(names)}`;
    if (hintEl) {
      hintEl.classList.remove('hidden');
      hintEl.textContent = '· 支持全地域自动发现';
    }
    if (fetchBtn) fetchBtn.disabled = false;
    if (emptyGuide) emptyGuide.classList.add('hidden');
    if (statusEl && !state.cloudResults?.length) {
      statusEl.textContent = '点击拉取将自动探测已配账号的所有地域';
    }
  }
}

/// 已存密钥的编辑态:默认只显示实际长度的 • 掩码(与主机弹窗密钥规范一致),
/// 明文在用户点眼睛时经 cloud:revealSecret 按需取回;掩码原样提交 = 保持不变。
let cloudSecret = { len: 0, mask: '', revealed: false };

/// 伸缩折叠编辑器:点「编辑」在对应账号卡片内部展开(与信息区融为一体)、
/// 再点同一个「编辑」折叠;「＋ 添加账号」(existing 为空)在列表顶部独立展开。
export function editCloudAccount(existing) {
  const form = $('#cloud-account-form');
  // 同一目标的编辑器已展开 → 折叠收起(按 id 比对,列表刷新后对象引用会换新)
  const sameTarget = state.cloudEditing && existing
    ? state.cloudEditing.id === existing.id
    : state.cloudEditing === existing;
  if (form && !form.classList.contains('hidden') && sameTarget) {
    closeCloudForm();
    return;
  }
  state.cloudEditing = existing || null;
  const vendor = existing ? existing.vendor : 'tencent';
  $('#cloud-form-vendor').value = vendor;
  $('#cloud-form-label').value = existing ? existing.label || '' : '';
  $('#cloud-form-keyid').value = existing ? existing.keyId || '' : '';
  const secInput = $('#cloud-form-secret');
  secInput.type = 'password';
  const revBtn = $('#btn-reveal-cloud-secret');
  if (existing?.secretSet) {
    cloudSecret = { len: existing.secretLen || 8, mask: secretMask(existing.secretLen), revealed: false };
    secInput.value = cloudSecret.mask;
    if (revBtn) {
      revBtn.classList.remove('hidden');
      revBtn.title = '显示密钥';
      revBtn.setAttribute('aria-label', '显示密钥');
      revBtn.innerHTML = icon('eyeOff');
    }
  } else {
    cloudSecret = { len: 0, mask: '', revealed: false };
    secInput.value = '';
    if (revBtn) revBtn.classList.add('hidden');
  }
  $('#cloud-form-endpoint').value = existing ? existing.endpoint || '' : '';
  const titleEl = $('#cloud-form-title');
  if (titleEl) {
    titleEl.textContent = existing
      ? `编辑云账号：${existing.label || existing.keyId}`
      : '添加云账号';
  }
  syncCloudFormLabels();
  form.classList.remove('hidden');
  markEditingRow();
  attachCloudForm(form);
  // 不抢焦点:展开即聚焦会把键盘输入/输入法从用户当前操作中夺走
  const sec = $('#settings-sec-cloud');
  if (sec) {
    const top = form.offsetTop - sec.offsetTop;
    sec.scrollTo({ top: Math.max(0, top - 8), left: 0, behavior: 'smooth' });
    sec.scrollLeft = 0;
  }
}

/// 正在编辑的账号行加高亮描边,其余还原
function markEditingRow() {
  const list = $('#cloud-accounts');
  if (!list) return;
  const id = state.cloudEditing?.id;
  for (const row of list.querySelectorAll('.cloud-account-row')) {
    row.classList.toggle('editing', !!id && row.dataset.accountId === id);
  }
}

export async function toggleCloudSecretVisibility() {
  const input = $('#cloud-form-secret');
  const btn = $('#btn-reveal-cloud-secret');
  if (!input || !btn) return;
  if (input.type === 'password') {
    // 首次揭示:值仍是掩码时才向后端按需取明文(掩码本身不含密钥)
    if (
      state.cloudEditing
      && cloudSecret.mask
      && input.value === cloudSecret.mask
    ) {
      try {
        const r = await api('cloud:revealSecret', { id: state.cloudEditing.id });
        cloudSecret.revealed = true;
        cloudSecret.len = (r?.value || '').length;
        cloudSecret.mask = secretMask(cloudSecret.len);
        input.value = r?.value || '';
      } catch (e) {
        toast('获取明文失败：' + e.message, 'error');
        return;
      }
    } else {
      cloudSecret.revealed = true;
    }
    input.type = 'text';
    btn.title = '隐藏密钥';
    btn.setAttribute('aria-label', '隐藏密钥');
    btn.innerHTML = icon('eye');
  } else {
    input.type = 'password';
    cloudSecret.revealed = false;
    btn.title = '显示密钥';
    btn.setAttribute('aria-label', '显示密钥');
    btn.innerHTML = icon('eyeOff');
  }
}

export function onCloudSecretInput() {
  const input = $('#cloud-form-secret');
  const btn = $('#btn-reveal-cloud-secret');
  if (!input) return;
  if (btn) btn.classList.toggle('hidden', input.value.length === 0);
  if (input.value.length === 0 && cloudSecret.revealed) {
    input.type = 'password';
    cloudSecret.revealed = false;
    if (btn) {
      btn.title = '显示密钥';
      btn.setAttribute('aria-label', '显示密钥');
      btn.innerHTML = icon('eyeOff');
    }
  }
}

export function secretFieldName(vendor) {
  return vendor === 'aliyun' ? 'AccessKeySecret' : 'SecretKey';
}
export function keyIdFieldName(vendor) {
  return vendor === 'aliyun' ? 'AccessKeyId' : 'SecretId';
}

export function syncCloudFormLabels() {
  const vendor = $('#cloud-form-vendor').value;
  $('#cloud-form-keyid-label').textContent = keyIdFieldName(vendor);
  $('#cloud-form-keyid').placeholder = vendor === 'aliyun' ? 'LTAI…' : 'AKID…';
  const prev = state.cloudEditing;
  // 编辑已存密钥的账号时,留空 = 保持不变;但换了厂商就不能再沿用旧密钥:
  // 掩码一并清掉(它代表的是旧厂商的密钥),placeholder 改回真实字段名。
  const keepExisting = prev && prev.secretSet && prev.vendor === vendor;
  const secInput = $('#cloud-form-secret');
  if (prev && prev.secretSet && prev.vendor !== vendor) {
    cloudSecret = { len: 0, mask: '', revealed: false };
    secInput.value = '';
    secInput.type = 'password';
    $('#btn-reveal-cloud-secret')?.classList.add('hidden');
  }
  secInput.placeholder = keepExisting
    ? '已保存，留空保持不变'
    : secretFieldName(vendor);
  const epDisplay = $('#cloud-form-endpoint-display');
  if (epDisplay) {
    epDisplay.textContent = CLOUD_OFFICIAL_ENDPOINTS[vendor] || 'https://cvm.tencentcloudapi.com';
  }
  $('#cloud-form-help').innerHTML =
    (CLOUD_KEY_HELP[vendor] || '') + '<br />' + CLOUD_KEY_HELP_FOOT;
}

export function closeCloudForm() {
  state.cloudEditing = null;
  const form = $('#cloud-account-form');
  form.classList.add('hidden');
  form.classList.remove('inline');
  // 收起时把编辑器挪回账号列表之后的常驻位置,列表刷新不会误伤它
  const list = $('#cloud-accounts');
  if (list && form) list.after(form);
  markEditingRow();
  const sec = $('#settings-sec-cloud');
  if (sec) sec.scrollLeft = 0;
}

export function cloudFormPayload() {
  const raw = $('#cloud-form-secret').value;
  // 掩码原样(未被改动)提交 = 保持已存密钥不变;清空同理。明文只在
  // 用户揭示或重新输入后才随表单发送。
  const secretUnchanged = state.cloudEditing
    && cloudSecret.mask
    && (raw === cloudSecret.mask || raw.trim() === '');
  return {
    id: state.cloudEditing ? state.cloudEditing.id : '',
    vendor: $('#cloud-form-vendor').value,
    label: $('#cloud-form-label').value.trim(),
    keyId: $('#cloud-form-keyid').value.trim(),
    secret: secretUnchanged ? '' : raw.trim(),
    endpoint: $('#cloud-form-endpoint').value.trim(),
  };
}

/// 保存前校验:新账号必填两项;编辑时留空则以已存密钥兜底
export function validateCloudForm(p) {
  if (!p.keyId) return `${keyIdFieldName(p.vendor)} 不能为空`;
  const prev = state.cloudEditing;
  const hasSaved = prev && prev.secretSet;
  // 换了厂商还沿用旧密钥必然是错的(后端会保留原 Secret),必须重输
  const vendorChanged = hasSaved && prev.vendor !== p.vendor;
  if (!p.secret && (!hasSaved || vendorChanged)) {
    return `请填写 ${secretFieldName(p.vendor)}`;
  }
  return null;
}

export async function saveCloudAccountFromForm() {
  const p = cloudFormPayload();
  const err = validateCloudForm(p);
  if (err) return toast(err, 'error');
  try {
    await api('cloud:saveAccount', p);
    toast(state.cloudEditing ? '云账号已更新' : '云账号已添加', 'success');
    closeCloudForm();
    await refreshCloudAccounts();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/// 一键拉取:所有(或勾选的)账号 × 全部地域,腾讯云自动合并 CVM + 轻量
export async function cloudFetchAll() {
  const ids = state.cloudAccounts.map((a) => a.id);
  if (!ids.length) return toast('请先添加云账号', 'error');
  $('#cloud-status').textContent = '正在探测所有地域并拉取实例…(首次约需数秒)';
  $('#btn-cloud-fetch').disabled = true;
  try {
    const r = await api('cloud:fetchAll', { accountIds: ids });
    state.cloudResults = (r.instances || []).filter((i) => i.host);
    // 错误去重后展示(单地域失败不阻断)
    const errs = [...new Set(r.errors || [])];
    const errBox = $('#cloud-errors');
    if (errs.length) {
      errBox.classList.remove('hidden');
      errBox.innerHTML = `<b>部分地域拉取失败(${errs.length})</b>` +
        errs.slice(0, 5).map((e) => `<div class="muted">${escapeHtml(e)}</div>`).join('') +
        (errs.length > 5 ? `<div class="muted">… 共 ${errs.length} 条</div>` : '');
    } else {
      errBox.classList.add('hidden');
    }
    if (!state.cloudResults.length) {
      $('#cloud-status').textContent = '所有地域均未发现可用实例(无公网 IP 的实例已过滤)';
      renderCloudRows();
      return;
    }
    $('#cloud-status').textContent = `获取到 ${state.cloudResults.length} 台实例(按地域分组)`;
    renderCloudRows();
  } catch (e) {
    $('#cloud-status').textContent = '获取失败';
    toast('获取失败：' + e.message, 'error');
  } finally {
    $('#btn-cloud-fetch').disabled = false;
  }
}

export function renderCloudRows() {
  const tbody = $('#cloud-tbody');
  tbody.innerHTML = '';
  // 按地域分组展示(组内:厂商 + 实例)
  const groups = new Map();
  for (const it of state.cloudResults) {
    const g = `${it.cloud.region}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const instances = new Map(state.cloudResults.map((it) => [cloudInstanceIdentity(it), it]));
  for (const [region, list] of groups) {
    const head = document.createElement('tr');
    head.className = 'cloud-group-row';
    head.innerHTML = `<td colspan="8">📍 ${escapeHtml(region)} · ${list.length} 台</td>`;
    tbody.appendChild(head);
    for (const it of list) {
      const identity = escapeHtml(cloudInstanceIdentity(it));
      const running = /running/i.test(it.state);
      const tr = document.createElement('tr');
      tr.className = 'cloud-row';
      tr.innerHTML = `
        <td><input type="checkbox" class="cloud-check" data-instance="${identity}" ${running ? 'checked' : ''} /></td>
        <td>${escapeHtml(it.name)}</td>
        <td class="mono">${escapeHtml(it.host || '（无公网 IP）')}</td>
        <td><span class="tag">${escapeHtml(SERVICE_LABEL[it.cloud.provider] || it.cloud.provider)}</span></td>
        <td class="muted">${escapeHtml(it.cloud.region)}</td>
        <td><span class="badge ${running ? 'running' : /stop/i.test(it.state) ? 'stopped' : 'other'}">${escapeHtml(it.state || '-')}</span></td>
        <td class="muted">${escapeHtml(it.cloud.os || '-')}</td>
        <td><button class="btn small cloud-connect" data-instance="${identity}">连接</button></td>`;
      tbody.appendChild(tr);
    }
  }
  tbody.querySelectorAll('.cloud-connect').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const it = instances.get(btn.dataset.instance);
      if (!it) return toast('实例列表已变化，请重新拉取', 'error');
      btn.disabled = true;
      try {
        const saved = await importInstance(it);
        closeModal('#modal-cloud');
        await refreshHosts();
        connectHost(saved.id);
      } catch (e) {
        toast('导入失败：' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
  $('#cloud-table').classList.remove('hidden');
  const checked = tbody.querySelectorAll('.cloud-check:checked').length;
  $('#cloud-count').textContent = `共 ${state.cloudResults.length} 台，已选 ${checked} 台`;
  $('#btn-cloud-import-selected').classList.toggle('hidden', state.cloudResults.length === 0);
}

// Identity must not depend on the region-grouped presentation order or mutable IP/name.
export function cloudInstanceIdentity(it) {
  const cloud = it.cloud || {};
  return JSON.stringify([cloud.accountId || '', cloud.provider || '', cloud.region || '', cloud.instanceId || '']);
}

export function selectedCloudInstances(results, checks) {
  const instances = new Map(results.map((it) => [cloudInstanceIdentity(it), it]));
  return [...new Set([...checks].map((c) => c.dataset.instance))].map((key) => {
    const it = instances.get(key);
    if (!it) throw new Error('实例列表已变化，请重新拉取');
    return it;
  });
}

export function instancePayload(it, group) {
  return {
    name: it.name,
    host: it.host,
    port: it.port || 22,
    username: it.username || 'root',
    authType: 'password',
    group,
    tags: [providerLabel(it.cloud.provider), it.cloud.region],
    cloud: it.cloud,
  };
}

export async function importInstance(it) {
  return api('hosts:save', instancePayload(it, providerLabel(it.cloud.provider)));
}

export async function cloudImportSelected() {
  const checks = document.querySelectorAll('#cloud-tbody .cloud-check:checked');
  if (!checks.length) return toast('请先勾选要导入的实例', 'error');
  try {
    const checked = selectedCloudInstances(state.cloudResults, checks);
    for (const it of checked) await importInstance(it);
    toast(`已导入 ${checked.length} 台主机，请编辑主机补全登录凭据`, 'success');
    closeModal('#modal-cloud');
    await refreshHosts();
  } catch (e) {
    toast('导入失败：' + e.message, 'error');
  }
}

/* ---------------- AI 助手 ---------------- */

// 对话上下文窗口:只保留最近 N 轮往返。
// 旧实现里 aiHistory 无上限,且每次请求都全量发给模型 —— 长会话会既吃内存
// 又持续抬高请求体(直到超出模型上下文而报错)。
