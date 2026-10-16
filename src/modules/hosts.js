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
      // 点击或中键:直接在新标签连接(若当前停留于空白单窗格标签则就地复用)。
      item.addEventListener('click', () => {
        connectHost(h.id, null, { newTab: true });
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
        const hasSession = [...state.sessions.values()].some((s) => s.host.id === h.id && ['connected', 'connecting'].includes(s.status));
        showCtxMenu(e.clientX, e.clientY, [
          { label: '连接', run: () => connectHost(h.id, null, { newTab: true }) },
          { label: '在新标签连接', run: () => connectHost(h.id, null, { newTab: true }) },
          ...(hasSession ? [{ label: '切换到已有标签', run: () => connectHost(h.id, null, { reuseExisting: true }) }] : []),
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

export const MASKED_SECRET = '••••••••';
export function secretMask(len = 8) {
  return '•'.repeat(Math.max(1, len || 8));
}

let hostSecretState = {
  password: { has: false, len: 0, mask: '', plain: null, revealed: false },
  passphrase: { has: false, len: 0, mask: '', plain: null, revealed: false },
  clearPrivateKey: false,
};

let currentJumpIds = [];
let currentHostTags = [];

export function syncAuthSliderUI(val) {
  const slider = $('#host-auth-slider');
  if (!slider) return;
  const current = val || $('#host-auth')?.value || 'password';
  slider.dataset.value = current;
  slider.querySelectorAll('.segmented-item').forEach((btn) => {
    const isAct = btn.dataset.value === current;
    btn.classList.toggle('active', isAct);
    btn.setAttribute?.('aria-checked', String(isAct));
  });
}

export function setHostAuthMode(val) {
  const sel = $('#host-auth');
  if (sel) {
    sel.value = val;
    if (typeof Event !== 'undefined' && typeof sel.dispatchEvent === 'function') {
      sel.dispatchEvent(new Event('change'));
    } else {
      syncAuthSliderUI(val);
      toggleAuthRows();
    }
  } else {
    syncAuthSliderUI(val);
    toggleAuthRows();
  }
}

export function getAllHostTags() {
  const set = new Set();
  for (const h of state.hosts || []) {
    for (const t of h.tags || []) {
      if (t && typeof t === 'string' && t.trim()) set.add(t.trim());
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function renderHostTagChips() {
  const listEl = $('#host-tags-list');
  const inputEl = $('#host-tag-input');
  const hiddenInput = $('#host-tags');
  if (!listEl) return;
  listEl.innerHTML = '';

  currentHostTags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.dataset.tag = tag;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tag-chip-name';
    nameSpan.textContent = tag;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'tag-chip-remove';
    delBtn.title = `移除标签 ${tag}`;
    delBtn.setAttribute?.('aria-label', `移除标签 ${tag}`);
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeHostTag(tag);
    });

    chip.appendChild(nameSpan);
    chip.appendChild(delBtn);
    listEl.appendChild(chip);
  });

  if (hiddenInput) {
    hiddenInput.value = currentHostTags.join(', ');
  }
  if (inputEl) {
    inputEl.placeholder = currentHostTags.length > 0 ? '继续输入…' : '输入标签按回车，或下拉选择…';
  }
}

export function addHostTag(rawTag) {
  if (!rawTag) return;
  const tag = String(rawTag).trim().replace(/^,+|,+$/g, '');
  if (!tag) return;
  if (!currentHostTags.includes(tag)) {
    currentHostTags.push(tag);
    renderHostTagChips();
  }
}

export function removeHostTag(tag) {
  currentHostTags = currentHostTags.filter((t) => t !== tag);
  renderHostTagChips();
  renderTagMenu($('#host-tag-input')?.value || '');
}

export function renderTagMenu(query = '') {
  const menu = $('#host-tags-menu');
  if (!menu) return;
  const kw = (query || '').trim().toLowerCase();
  const allTags = getAllHostTags();
  const filtered = allTags.filter((t) => !kw || t.toLowerCase().includes(kw));

  menu.innerHTML = '';
  if (filtered.length === 0 && !kw) {
    const empty = document.createElement('div');
    empty.className = 'tag-menu-empty';
    empty.textContent = '暂无历史标签，可输入新标签按回车创建';
    menu.appendChild(empty);
  } else {
    for (const t of filtered) {
      const isSelected = currentHostTags.includes(t);
      const item = document.createElement('div');
      item.className = 'tag-menu-item' + (isSelected ? ' selected' : '');
      item.dataset.tag = t;
      item.innerHTML = `<span>${escapeHtml(t)}</span>${isSelected ? '<span class="tag-check">✓</span>' : ''}`;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isSelected) {
          removeHostTag(t);
        } else {
          addHostTag(t);
        }
        const inp = $('#host-tag-input');
        if (inp) {
          inp.value = '';
          inp.focus();
        }
        renderTagMenu('');
      });
      menu.appendChild(item);
    }
    if (kw && !allTags.some((t) => t.toLowerCase() === kw) && !currentHostTags.some((t) => t.toLowerCase() === kw)) {
      const addRow = document.createElement('div');
      addRow.className = 'tag-menu-add-new';
      addRow.textContent = `按回车新增标签 "${query.trim()}"`;
      addRow.addEventListener('click', (e) => {
        e.stopPropagation();
        addHostTag(query);
        const inp = $('#host-tag-input');
        if (inp) {
          inp.value = '';
          inp.focus();
        }
        renderTagMenu('');
      });
      menu.appendChild(addRow);
    }
  }
}

export function toggleTagMenu(open) {
  const menu = $('#host-tags-menu');
  if (!menu) return;
  const shouldOpen = open !== undefined ? open : menu.classList.contains('hidden');
  if (!shouldOpen) {
    menu.classList.add('hidden');
    return;
  }
  const currentQuery = $('#host-tag-input')?.value || '';
  renderTagMenu(currentQuery);
  menu.classList.remove('hidden');
}

export function updateSessionLogHint() {
  const sel = $('#host-sessionlog');
  const hint = $('#host-sessionlog-hint');
  if (!sel || !hint) return;
  if (sel.value === 'default') {
    const auto = !!state.settings?.sessionLog?.auto;
    hint.textContent = `当前全局：${auto ? '已开启自动记录' : '未开启自动记录'}`;
  } else {
    hint.textContent = '';
  }
}

export async function toggleHostSecret(field) {
  const st = hostSecretState[field];
  if (!st) return;
  const input = $(`#host-${field}`);
  const btn = $(`#btn-reveal-host-${field}`);
  const hostId = $('#host-id').value;
  if (!st.revealed) {
    if (st.has && st.plain === null && (input.value === st.mask || input.value === MASKED_SECRET) && hostId) {
      try {
        const res = await api('hosts:revealSecret', { id: hostId, field });
        st.plain = res?.value || '';
        st.len = st.plain.length;
        st.mask = secretMask(st.len);
        input.value = st.plain;
      } catch (e) {
        toast('获取明文失败：' + e.message, 'error');
        return;
      }
    }
    input.type = 'text';
    st.revealed = true;
    if (btn) {
      btn.title = '隐藏' + (field === 'password' ? '密码' : '口令');
      btn.innerHTML = icon('eye');
    }
  } else {
    input.type = 'password';
    st.revealed = false;
    if (btn) {
      btn.title = '显示' + (field === 'password' ? '密码' : '口令');
      btn.innerHTML = icon('eyeOff');
    }
  }
}

export function onHostSecretInput(field) {
  const input = $(`#host-${field}`);
  const btn = $(`#btn-reveal-host-${field}`);
  if (!input) return;
  const val = input.value;
  const st = hostSecretState[field];
  if (btn) btn.classList.toggle('hidden', val.length === 0);
  if (val.length === 0 && st && st.revealed) {
    input.type = 'password';
    st.revealed = false;
    if (btn) {
      btn.title = '显示' + (field === 'password' ? '密码' : '口令');
      btn.innerHTML = icon('eyeOff');
    }
  }
}

export function clearHostPrivateKey() {
  state.pickedKey = null;
  hostSecretState.clearPrivateKey = true;
  $('#key-path').textContent = '未选择';
  $('#btn-clear-key')?.classList.add('hidden');
}

export function renderJumpChips() {
  const listEl = $('#host-jump-list');
  const emptyEl = $('#host-jump-placeholder');
  const hiddenSel = $('#host-jump');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (hiddenSel) hiddenSel.innerHTML = '';

  if (currentJumpIds.length === 0) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  currentJumpIds.forEach((id, idx) => {
    const h = state.hosts.find((x) => x.id === id);
    const name = h ? `${h.name || h.host}` : id;

    if (idx > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'jump-arrow';
      arrow.textContent = '→';
      listEl.appendChild(arrow);
    }

    const chip = document.createElement('span');
    chip.className = 'jump-chip';
    chip.dataset.id = id;
    chip.title = `${name}${h ? ` (${h.host})` : ''} - 跳板第 ${idx + 1} 级`;

    const num = document.createElement('span');
    num.className = 'jump-chip-index';
    num.textContent = String(idx + 1);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'jump-chip-name';
    nameSpan.textContent = name;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'jump-chip-remove';
    delBtn.title = '移除此跳板';
    delBtn.setAttribute('aria-label', `移除跳板 ${name}`);
    delBtn.innerHTML = icon('x');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentJumpIds = currentJumpIds.filter((x) => x !== id);
      renderJumpChips();
    });

    chip.appendChild(num);
    chip.appendChild(nameSpan);
    chip.appendChild(delBtn);
    listEl.appendChild(chip);

    if (hiddenSel) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.selected = true;
      hiddenSel.appendChild(opt);
    }
  });
}

export function toggleJumpMenu(open) {
  const menu = $('#host-jump-menu');
  if (!menu) return;
  const shouldOpen = open !== undefined ? open : menu.classList.contains('hidden');
  if (!shouldOpen) {
    menu.classList.add('hidden');
    return;
  }
  const hostId = $('#host-id').value;
  const candidates = state.hosts.filter((h) => (!hostId || h.id !== hostId) && !currentJumpIds.includes(h.id));
  menu.innerHTML = '';
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'jump-menu-empty';
    empty.textContent = state.hosts.length <= 1 ? '暂无可用的其他主机作为跳板' : '所有其他主机已在跳板链中';
    menu.appendChild(empty);
  } else {
    for (const h of candidates) {
      const item = document.createElement('div');
      item.className = 'jump-menu-item';
      item.innerHTML = `<span>${escapeHtml(h.name || h.host)}</span><span class="muted">${escapeHtml(h.host)}</span>`;
      item.addEventListener('click', () => {
        currentJumpIds.push(h.id);
        renderJumpChips();
        toggleJumpMenu(false);
      });
      menu.appendChild(item);
    }
  }
  menu.classList.remove('hidden');
}

export function openHostModal(host) {
  state.pickedKey = null;
  const pwHas = !!(host && host.hasPassword);
  const pwLen = (host && host.passwordLen) || 8;
  const pwMask = secretMask(pwLen);

  const ppHas = !!(host && host.hasPassphrase);
  const ppLen = (host && host.passphraseLen) || 8;
  const ppMask = secretMask(ppLen);

  hostSecretState = {
    password: { has: pwHas, len: pwLen, mask: pwMask, plain: null, revealed: false },
    passphrase: { has: ppHas, len: ppLen, mask: ppMask, plain: null, revealed: false },
    clearPrivateKey: false,
  };

  $('#host-modal-title').textContent = host ? '编辑主机' : '新建主机';
  $('#host-id').value = host ? host.id : '';
  $('#host-name').value = host ? host.name : '';
  $('#host-host').value = host ? host.host : '';
  $('#host-port').value = host ? host.port : 22;
  $('#host-username').value = host ? host.username : 'root';
  const authMode = host ? host.authType : 'password';
  if ($('#host-auth')) $('#host-auth').value = authMode;
  syncAuthSliderUI(authMode);

  // 密码初始化
  const pwInput = $('#host-password');
  const pwRevealBtn = $('#btn-reveal-host-password');
  pwInput.type = 'password';
  if (pwHas) {
    pwInput.value = pwMask;
    if (pwRevealBtn) {
      pwRevealBtn.classList.remove('hidden');
      pwRevealBtn.title = '显示密码';
      pwRevealBtn.innerHTML = icon('eyeOff');
    }
  } else {
    pwInput.value = '';
    if (pwRevealBtn) pwRevealBtn.classList.add('hidden');
  }

  // 私钥口令初始化
  const ppInput = $('#host-passphrase');
  const ppRevealBtn = $('#btn-reveal-host-passphrase');
  ppInput.type = 'password';
  if (ppHas) {
    ppInput.value = ppMask;
    if (ppRevealBtn) {
      ppRevealBtn.classList.remove('hidden');
      ppRevealBtn.title = '显示口令';
      ppRevealBtn.innerHTML = icon('eyeOff');
    }
  } else {
    ppInput.value = '';
    if (ppRevealBtn) ppRevealBtn.classList.add('hidden');
  }

  // 私钥文件路径与清除按钮
  $('#key-path').textContent = host && host.keyPath ? host.keyPath : '未选择';
  const clearKeyBtn = $('#btn-clear-key');
  if (clearKeyBtn) {
    clearKeyBtn.classList.toggle('hidden', !(host && host.keyPath));
  }

  $('#host-group').value = host ? groupOf(host) : '';
  const initialTags = (host && Array.isArray(host.tags)) ? [...host.tags] : (host?.tags || []);
  currentHostTags = [...initialTags];
  if ($('#host-tag-input')) $('#host-tag-input').value = '';
  renderHostTagChips();
  toggleTagMenu(false);

  // 跳板机初始化
  currentJumpIds = (host && Array.isArray(host.jumpIds)) ? [...host.jumpIds] : [];
  renderJumpChips();
  toggleJumpMenu(false);

  $('#host-initcmd').value = host && host.initcmd ? host.initcmd : '';
  $('#host-sessionlog').value = (host && host.sessionLog) || 'default';
  updateSessionLogHint();

  if ($('#host-aiaccess')) $('#host-aiaccess').value = (host && host.aiAccess) || 'default';
  toggleAuthRows();
  openModal('#modal-host');
  $('#host-name').focus();
}

export function toggleAuthRows() {
  const current = $('#host-auth')?.value || 'password';
  const isKey = current === 'key';
  $('#row-password')?.classList.toggle('hidden', isKey);
  $('#row-key')?.classList.toggle('hidden', !isKey);
  syncAuthSliderUI(current);
}

export async function saveHostModal() {
  const id = $('#host-id').value;
  const payload = {
    id: id || undefined,
    name: $('#host-name').value.trim(),
    host: $('#host-host').value.trim(),
    port: Number($('#host-port').value) || 22,
    username: $('#host-username').value.trim() || 'root',
    authType: $('#host-auth').value,
    group: $('#host-group').value.trim(),
    jumpIds: [...currentJumpIds],
    initcmd: $('#host-initcmd').value.trim(),
    sessionLog: $('#host-sessionlog') ? $('#host-sessionlog').value : 'default',
    aiAccess: $('#host-aiaccess') ? $('#host-aiaccess').value : undefined,
  };

  const clearSecrets = [];

  // 密码处理: 手动清空已有密码视为删除; 非空且非占位掩码且非原明文视为新密码; 占位掩码保持不变
  const pwVal = $('#host-password').value;
  const pwSt = hostSecretState.password;
  const pwIsMask = pwVal === pwSt.mask || pwVal === MASKED_SECRET;
  const pwIsPlain = pwSt.plain !== null && pwVal === pwSt.plain;
  if (pwSt.has && pwVal === '') {
    clearSecrets.push('password');
  } else if (pwVal !== '' && !pwIsMask && !pwIsPlain) {
    payload.password = pwVal;
  }

  // 私钥口令处理
  const ppVal = $('#host-passphrase').value;
  const ppSt = hostSecretState.passphrase;
  const ppIsMask = ppVal === ppSt.mask || ppVal === MASKED_SECRET;
  const ppIsPlain = ppSt.plain !== null && ppVal === ppSt.plain;
  if (ppSt.has && ppVal === '') {
    clearSecrets.push('passphrase');
  } else if (ppVal !== '' && !ppIsMask && !ppIsPlain) {
    payload.passphrase = ppVal;
  }

  // 私钥文件清除
  if (hostSecretState.clearPrivateKey) {
    clearSecrets.push('privateKey');
  }

  if (clearSecrets.length > 0) {
    payload.clearSecrets = clearSecrets;
  }

  // 标签保存前处理:若行内输入框中尚有未按回车提交的非空文字,先自动追加
  const pendingTag = $('#host-tag-input')?.value.trim();
  if (pendingTag) {
    addHostTag(pendingTag);
    if ($('#host-tag-input')) $('#host-tag-input').value = '';
  }
  if ($('#host-tags')) {
    const explicitVal = $('#host-tags').value.trim();
    if (explicitVal) {
      payload.tags = explicitVal.split(',').map((tag) => tag.trim()).filter(Boolean);
    } else {
      payload.tags = [...currentHostTags];
    }
  } else {
    payload.tags = [...currentHostTags];
  }

  if (!payload.host) return toast('请填写主机地址', 'error');
  if (payload.authType === 'key') {
    if (state.pickedKey) {
      payload.privateKey = state.pickedKey.content;
      payload.keyPath = state.pickedKey.path;
    } else if (id && !hostSecretState.clearPrivateKey) {
      // 编辑时不重选私钥文件 → 保持原私钥
    } else {
      return toast('请选择私钥文件', 'error');
    }
  }

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
        tr.innerHTML = `<td class="mono">${escapeHtml(f.id)}</td><td class="mono"><span tabindex="0" aria-label="完整主机指纹" style="display:block;white-space:normal;overflow-wrap:anywhere;user-select:text">${escapeHtml(fingerprint)}</span></td><td class="fp-actions"><span class="fp-row-actions"><button class="btn small fp-copy" aria-label="${escapeHtml(f.id)} 复制完整指纹">复制</button><button class="btn small danger fp-del" aria-label="${escapeHtml(f.id)} 删除指纹">删除</button></span></td>`;
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

