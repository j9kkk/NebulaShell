// 主机列表、主机编辑弹窗、指纹管理
import { $, PROVIDER_LABEL, api, askConfirm, closeModal, copyText, openModal, showCtxMenu, state, toast } from './core.js';
import { icon } from '../shared/icons.js';
import { connectHost } from './terminal.js';

export function groupOf(h) {
  return h.group || (h.cloud ? PROVIDER_LABEL[h.cloud.provider] || h.cloud.provider : '') || '我的主机';
}

export async function refreshHosts() {
  state.hosts = await api('hosts:list');
  renderHosts();
}

export function renderHosts() {
  const kw = ($('#host-search').value || '').trim().toLowerCase();
  const list = state.hosts.filter((h) => !kw || h.name.toLowerCase().includes(kw) || h.host.toLowerCase().includes(kw));
  const groups = new Map();
  for (const h of list) {
    const g = groupOf(h);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  const nav = $('#host-list');
  nav.innerHTML = '';
  if (!list.length) {
    nav.innerHTML = '<div class="host-empty">还没有主机<br />点击「新建主机」或「导入云主机」开始</div>';
    return;
  }
  for (const [g, hosts] of groups) {
    const title = document.createElement('div');
    title.className = 'host-group-title';
    title.textContent = `${g} · ${hosts.length}`;
    nav.appendChild(title);
    for (const h of hosts) {
      const item = document.createElement('div');
      item.className = 'host-item' + (isActiveHost(h.id) ? ' active' : '');
      item.dataset.id = h.id;
      const sub = `${h.username}@${h.host}:${h.port}` + (h.cloud && h.cloud.region ? `  ·  ${h.cloud.region}` : '');
      item.innerHTML = `
        <div class="host-main">
          <div class="host-name">${escapeHtml(h.name)}${!h.hasPassword && !h.hasKey ? '<span class="host-chip">待补全凭据</span>' : ''}</div>
          <div class="host-sub">${escapeHtml(sub)}</div>
        </div>
        <div class="host-actions">
          <button class="hi-clone" title="克隆">${icon('copy')}</button>
          <button class="hi-edit" title="编辑">${icon('settings')}</button>
          <button class="hi-del" title="删除">${icon('trash')}</button>
        </div>`;
      // 普通点击:已有会话则切过去,否则连接。
      // ⌘/Ctrl+点击 或 中键:强制新开一个标签(支持同主机多会话)。
      item.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey) connectHost(h.id, null, { newTab: true });
        else connectHost(h.id);
      });
      item.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); connectHost(h.id, null, { newTab: true }); }
      });
      // 悬停图标与右键菜单共用同一组动作(菜单多出"新标签连接/复制地址")。
      // 图标保留给习惯鼠标悬停的人;右键兜底 —— 此前主机是全应用唯一
      // 没有右键菜单的列表对象,终端、文件行都能右键,这里却毫无反应。
      const cloneThis = async () => {
        try {
          await api('hosts:clone', { id: h.id });
          toast('已克隆主机', 'success');
          refreshHosts();
        } catch (err) {
          toast('克隆失败：' + err.message, 'error');
        }
      };
      const delThis = async () => {
        if (!(await askConfirm(`确定删除主机「${h.name}」吗？此操作不可撤销。`, { title: '删除主机', okText: '删除' }))) return;
        await api('hosts:delete', { id: h.id });
        toast('已删除', 'success');
        refreshHosts();
      };
      item.querySelector('.hi-clone').addEventListener('click', (e) => { e.stopPropagation(); cloneThis(); });
      item.querySelector('.hi-edit').addEventListener('click', (e) => { e.stopPropagation(); openHostModal(h); });
      item.querySelector('.hi-del').addEventListener('click', (e) => { e.stopPropagation(); delThis(); });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation(); // 别让窗口级处理器(终端菜单)再插一手
        showCtxMenu(e.clientX, e.clientY, [
          { label: '连接', run: () => connectHost(h.id) },
          { label: '在新标签连接', run: () => connectHost(h.id, null, { newTab: true }) },
          '-',
          { label: '编辑…', run: () => openHostModal(h) },
          { label: '克隆', run: () => cloneThis() },
          { label: '复制 user@host', run: () => {
            copyText(`${h.username}@${h.host}:${h.port}`).then((ok) => toast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error'));
          } },
          '-',
          { label: '删除…', danger: true, run: () => delThis() },
        ]);
      });
      nav.appendChild(item);
    }
  }
}

export function isActiveHost(hostId) {
  for (const s of state.sessions.values()) {
    if (s.host.id === hostId && s.sessionId === state.activeId) return true;
  }
  return false;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 主机编辑弹窗 ---------------- */

export function openHostModal(host) {
  state.pickedKey = null;
  $('#host-modal-title').textContent = host ? '编辑主机' : '新建主机';
  $('#host-id').value = host ? host.id : '';
  $('#host-name').value = host ? host.name : '';
  $('#host-host').value = host ? host.host : '';
  $('#host-port').value = host ? host.port : 22;
  $('#host-username').value = host ? host.username : 'root';
  $('#host-auth').value = host ? host.authType : 'password';
  $('#host-password').value = '';
  $('#host-password').placeholder = host && host.hasPassword ? '已保存（留空保持不变）' : '密码';
  $('#host-passphrase').value = '';
  $('#host-passphrase').placeholder = host && host.hasPassphrase ? '已保存（留空保持不变）' : '无则留空';
  $('#key-path').textContent = host && host.keyPath ? host.keyPath : '未选择';
  $('#host-group').value = host ? groupOf(host) : '';
  if ($('#host-tags')) $('#host-tags').value = (host?.tags || []).join(', ');
  for (const field of ['password', 'key', 'passphrase']) {
    const control = $(`#host-clear-${field}`);
    if (control) {
      control.checked = false;
      control.disabled = !host;
    }
  }
  // 跳板机多选(I3):排除自身
  const jumpSel = $('#host-jump');
  jumpSel.innerHTML = '<option value="">(无)</option>';
  for (const h of state.hosts) {
    if (host && h.id === host.id) continue;
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `${h.name}(${h.host})`;
    jumpSel.appendChild(o);
  }
  if (host && Array.isArray(host.jumpIds)) {
    for (const id of host.jumpIds) {
      const o = [...jumpSel.options].find((x) => x.value === id);
      if (o) o.selected = true;
    }
  }
  $('#host-initcmd').value = host && host.initcmd ? host.initcmd : '';
  toggleAuthRows();
  openModal('#modal-host');
  $('#host-name').focus();
}

export function toggleAuthRows() {
  const isKey = $('#host-auth').value === 'key';
  $('#row-password').classList.toggle('hidden', isKey);
  $('#row-key').classList.toggle('hidden', !isKey);
}

export async function saveHostModal() {
  const id = $('#host-id').value;
  const jumpIds = [...$('#host-jump').selectedOptions].map((o) => o.value).filter(Boolean);
  const payload = {
    id: id || undefined,
    name: $('#host-name').value.trim(),
    host: $('#host-host').value.trim(),
    port: Number($('#host-port').value) || 22,
    username: $('#host-username').value.trim() || 'root',
    authType: $('#host-auth').value,
    group: $('#host-group').value.trim(),
    jumpIds,
    initcmd: $('#host-initcmd').value.trim(),
    password: $('#host-password').value || undefined,
    passphrase: $('#host-passphrase').value || undefined,
  };
  if ($('#host-tags')) payload.tags = $('#host-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  payload.clearSecrets = ['password', 'privateKey', 'passphrase'].filter((field) =>
    $(`#host-clear-${field === 'privateKey' ? 'key' : field}`)?.checked);
  if (!payload.host) return toast('请填写主机地址', 'error');
  if (payload.authType === 'key') {
    if (state.pickedKey) {
      payload.privateKey = state.pickedKey.content;
      payload.keyPath = state.pickedKey.path;
    } else if (id) {
      // 编辑时不重选私钥文件 → 保持原私钥
    } else {
      return toast('请选择私钥文件', 'error');
    }
  }
  if (payload.clearSecrets.length && !(await askConfirm('保存后将删除所选的已保存凭据。空白输入原本会保留凭据，此处为明确删除。', { title: '清除主机凭据', okText: '清除并保存' }))) return;
  try {
    await api('hosts:save', payload);
    closeModal('#modal-host');
    toast('已保存主机', 'success');
    await refreshHosts();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/* ---------------- 终端会话 ---------------- */

export async function openFingerprints() {
  try {
    const list = await api('fingerprints:list');
    const tbody = $('#fp-tbody');
    tbody.innerHTML = '';
    if (!list.length) {
      $('#fp-table').classList.add('hidden');
      tbody.innerHTML = '<tr><td colspan="3" class="muted">暂无记录</td></tr>';
      $('#fp-table').classList.remove('hidden');
    } else {
      for (const f of list) {
        const tr = document.createElement('tr');
        const fingerprint = String(f.fp);
        tr.innerHTML = `<td class="mono">${escapeHtml(f.id)}</td><td class="mono"><span tabindex="0" aria-label="完整主机指纹" style="display:block;white-space:normal;overflow-wrap:anywhere;user-select:text">${escapeHtml(fingerprint)}</span></td><td><button class="btn small fp-copy" aria-label="${escapeHtml(f.id)} 复制完整指纹">复制</button> <button class="btn small fp-del">删除</button></td>`;
        tr.querySelector('.fp-copy').addEventListener('click', async () => {
          const ok = await copyText(fingerprint);
          toast(ok ? '完整指纹已复制' : '复制失败', ok ? 'success' : 'error');
        });
        tr.querySelector('.fp-del').addEventListener('click', async () => {
          if (!(await askConfirm(`删除主机 ${f.id} 的指纹?下次连接将重新信任。`, { title: '删除指纹', okText: '删除' }))) return;
          await api('fingerprints:delete', { id: f.id });
          openFingerprints();
        });
        tbody.appendChild(tr);
      }
      $('#fp-table').classList.remove('hidden');
    }
    openModal('#modal-fp');
  } catch (e) {
    toast('加载指纹失败:' + e.message, 'error');
  }
}

/* ---------------- 端口转发管理(I1/I2) ---------------- */

