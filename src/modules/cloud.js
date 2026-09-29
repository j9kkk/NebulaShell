// 云主机导入:多账号凭据 + 全区域一键拉取
import { $, PROVIDER_LABEL, api, askConfirm, closeModal, state, toast } from './core.js';
import { connectHost } from './terminal.js';
import { escapeHtml, refreshHosts } from './hosts.js';

export const VENDOR_LABEL = { tencent: '腾讯云', aliyun: '阿里云' };
export const SERVICE_LABEL = { cvm: 'CVM', lighthouse: '轻量', aliyun: 'ECS', tencent: 'CVM' };

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
}

export function renderCloudAccounts() {
  const box = $('#cloud-accounts');
  box.innerHTML = '';
  if (!state.cloudAccounts.length) {
    box.innerHTML = '<div class="muted small-note" style="padding:6px 2px;">尚未添加账号。添加后即可一键拉取该账号下所有地域的主机(腾讯云自动包含 CVM 与轻量)。</div>';
    return;
  }
  for (const a of state.cloudAccounts) {
    const row = document.createElement('div');
    row.className = 'cloud-account-row';
    row.innerHTML = `
      <span class="ca-vendor">${escapeHtml(VENDOR_LABEL[a.vendor] || a.vendor)}</span>
      <span class="ca-label">${escapeHtml(a.label || '(未命名)')}</span>
      <span class="ca-key mono">${escapeHtml(a.keyId || '')}</span>
      ${a.secretSet ? '<span class="ca-ok">已保存密钥</span>' : '<span class="ca-miss">缺密钥</span>'}
      <span class="spacer"></span>
      <button class="btn small ca-edit">编辑</button>
      <button class="btn small ca-del">删除</button>`;
    row.querySelector('.ca-edit').addEventListener('click', () => editCloudAccount(a));
    row.querySelector('.ca-del').addEventListener('click', async () => {
      if (!(await askConfirm(`删除云账号「${a.label || a.keyId}」?已导入的主机不受影响。`, { title: '删除云账号', okText: '删除' }))) return;
      await api('cloud:deleteAccount', { id: a.id });
      await refreshCloudAccounts();
    });
    box.appendChild(row);
  }
}

/// 添加/编辑账号:在弹窗内用一张表单一次性填完(厂商/备注/Key ID/Secret),
/// 保存前可点"测试连接"实探校验 —— 避免"存了才发现密钥是错的"。
export function editCloudAccount(existing) {
  state.cloudEditing = existing || null;
  const vendor = existing ? existing.vendor : 'tencent';
  $('#cloud-form-vendor').value = vendor;
  $('#cloud-form-label').value = existing ? existing.label || '' : '';
  $('#cloud-form-keyid').value = existing ? existing.keyId || '' : '';
  $('#cloud-form-secret').value = '';
  $('#cloud-form-endpoint').value = existing ? existing.endpoint || '' : '';
  syncCloudFormLabels();
  $('#cloud-test-status').textContent = '';
  $('#cloud-account-form').classList.remove('hidden');
  $('#cloud-form-keyid').focus();
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
  // 编辑已存密钥的账号时,留空 = 保持不变;但换了厂商就不能再沿用旧密钥,
  // 此时要改回真实字段名,避免 placeholder 给出错误暗示。
  const keepExisting = prev && prev.secretSet && prev.vendor === vendor;
  $('#cloud-form-secret').placeholder = keepExisting
    ? '已保存，留空保持不变'
    : secretFieldName(vendor);
  $('#cloud-form-help').innerHTML =
    (CLOUD_KEY_HELP[vendor] || '') + '<br />' + CLOUD_KEY_HELP_FOOT;
}

export function closeCloudForm() {
  state.cloudEditing = null;
  $('#cloud-account-form').classList.add('hidden');
  $('#cloud-test-status').textContent = '';
}

/// 校验结论只对"当时那组凭据"有效:字段一变就得作废,否则会停留在
/// 尚未校验过的新值上,误导用户以为改完仍然正确。
export function clearCloudTestStatus() {
  const el = $('#cloud-test-status');
  if (el.textContent) el.textContent = '';
}

export function cloudFormPayload() {
  return {
    id: state.cloudEditing ? state.cloudEditing.id : '',
    vendor: $('#cloud-form-vendor').value,
    label: $('#cloud-form-label').value.trim(),
    keyId: $('#cloud-form-keyid').value.trim(),
    secret: $('#cloud-form-secret').value.trim(),
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

export async function testCloudAccount() {
  const p = cloudFormPayload();
  const err = validateCloudForm(p);
  if (err) return toast(err, 'error');
  const btn = $('#btn-cloud-test');
  const status = $('#cloud-test-status');
  btn.disabled = true;
  status.textContent = '正在校验…';
  try {
    const r = await api('cloud:testAccount', p);
    status.textContent = `✓ 校验通过：${r.regionCount} 个地域，${r.sampleRegion} 发现 ${r.instanceCount} 台实例`;
    toast('凭据校验通过', 'success');
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    toast('校验失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
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
  let idx = 0;
  for (const [region, list] of groups) {
    const head = document.createElement('tr');
    head.className = 'cloud-group-row';
    head.innerHTML = `<td colspan="8">📍 ${escapeHtml(region)} · ${list.length} 台</td>`;
    tbody.appendChild(head);
    for (const it of list) {
      const i = idx++;
      const running = /running/i.test(it.state);
      const tr = document.createElement('tr');
      tr.className = 'cloud-row';
      tr.innerHTML = `
        <td><input type="checkbox" class="cloud-check" data-i="${i}" ${running ? 'checked' : ''} /></td>
        <td>${escapeHtml(it.name)}</td>
        <td class="mono">${escapeHtml(it.host || '（无公网 IP）')}</td>
        <td><span class="tag">${escapeHtml(SERVICE_LABEL[it.cloud.provider] || it.cloud.provider)}</span></td>
        <td class="muted">${escapeHtml(it.cloud.region)}</td>
        <td><span class="badge ${running ? 'running' : /stop/i.test(it.state) ? 'stopped' : 'other'}">${escapeHtml(it.state || '-')}</span></td>
        <td class="muted">${escapeHtml(it.cloud.os || '-')}</td>
        <td><button class="btn small cloud-connect" data-i="${i}">连接</button></td>`;
      tbody.appendChild(tr);
    }
  }
  tbody.querySelectorAll('.cloud-connect').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const it = state.cloudResults[Number(btn.dataset.i)];
      const saved = await importInstance(it);
      closeModal('#modal-cloud');
      await refreshHosts();
      connectHost(saved.id);
    });
  });
  $('#cloud-table').classList.remove('hidden');
  const checked = tbody.querySelectorAll('.cloud-check:checked').length;
  $('#cloud-count').textContent = `共 ${state.cloudResults.length} 台，已选 ${checked} 台`;
  $('#btn-cloud-import-selected').classList.toggle('hidden', state.cloudResults.length === 0);
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
  const checked = [...document.querySelectorAll('.cloud-check:checked')].map((c) => Number(c.dataset.i));
  if (!checked.length) return toast('请先勾选要导入的实例', 'error');
  try {
    for (const i of checked) await importInstance(state.cloudResults[i]);
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
