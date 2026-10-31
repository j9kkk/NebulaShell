// 主机库:百台级批量管理弹窗。
//
// 为什么单独做一个弹窗而不是把多选塞进侧栏:侧栏 264px,行的点击语义已经是
// "左键连接 / 中键新标签连接 / 右键菜单"三种,再叠一个多选模式是明确的 bug
// 温床;而批量改分组/打标签/删除是低频但要横向空间的活。职责拆开:
// 侧栏负责快速访问,主机库负责库管理。
//
// 本模块不从 hosts.js 取渲染函数:hosts.js 的 vm 单测依赖映射只有
// core/terminal/icons 三项,给它加 import 会直接 link 失败。这里反向
// import hosts.js 是安全的(方向是 新模块 → 旧模块)。

import { $, api, askConfirm, askPrompt, bindMenuButton, closeModal, openModal, setModalEscapeHandler, showCtxMenu, state, toast } from './core.js';
import { executeCommand } from './commands.js';
import { icon } from '../shared/icons.js';
import { DEFAULT_GROUP, escapeHtml, groupOf, isCloudGroup, openHostModal, refreshHosts, renderHosts, saveUiPrefs, sortGroupsByPref, STAR_NOTE, uiPrefs } from './hosts.js';
import { startMouseDrag } from '../shared/drag.js';
import { connectHost } from './terminal.js';

let selected = new Set();
let activeGroup = '';     // '' = 全部
let keyword = '';
let dragEndedAt = 0;
let groupDragEndedAt = 0;
// 分组原地编辑会话(取代第二层 askPrompt 弹窗)。渲染以它为准:任何重绘
// (renderLibrary / nebula:hosts-changed)都从该状态恢复草稿并重新聚焦输入框。
let editing = null; // { mode: 'create'|'rename', from, moveIds, draft, error, _focused }

function hosts() {
  return state.hosts || [];
}

/// 星标集合。收藏是界面偏好,不写进 host 字段。
function favSet() {
  return new Set(uiPrefs().favoriteHostIds);
}

function toggleFavorite(id) {
  const next = favSet();
  if (next.has(id)) next.delete(id); else next.add(id);
  saveUiPrefs({ favoriteHostIds: [...next] });
  renderLibrary();
  // 侧栏那份列表也要跟着变:显式重绘,不依赖事件(renderHosts 是同步纯渲染)
  renderHosts();
}

/* ---------------- 分组 ---------------- */

function ensureCustomGroup(name) {
  const custom = Array.isArray(uiPrefs().customGroups) ? uiPrefs().customGroups : [];
  if (!custom.includes(name)) {
    saveUiPrefs({ customGroups: [...custom, name] });
  }
}

/// 分组模型。real = 真实目录:customGroups(哪怕为空,保持用户排序)在前,
/// 显式 h.group 出现的组按首次出现顺序补后 —— 含默认组「我的主机」;
/// cloud = 云厂商自动归类:不在 customGroups 且成员全是未显式指定分组的
/// 云主机(按导入来源兜底归组)。判定不硬编码厂商名:用户可以自建
/// 名为「阿里云」的真实分组,那样它就是 real 而不是 cloud。
function groupModel() {
  const hostsArr = hosts();
  const custom = (Array.isArray(uiPrefs().customGroups) ? uiPrefs().customGroups : [])
    .filter((g) => g && g !== STAR_NOTE);
  const seen = new Set(custom);
  const extra = [];
  for (const h of hostsArr) {
    const g = groupOf(h);
    if (g && !seen.has(g)) { seen.add(g); extra.push(g); }
  }
  const cloud = [];
  const real = [];
  for (const g of [...custom, ...extra]) {
    (isCloudGroup(g, hostsArr, custom) ? cloud : real).push(g);
  }
  // 用户拖拽过的次序优先(settings.ui.groupOrder);没记录过的分组按原相对
  // 次序排在后面 —— 新建/首次出现的组不会插进用户排好的队列中间。
  real.splice(0, real.length, ...sortGroupsByPref(real));
  // 默认组「我的主机」是收件箱桶:固定排在「分组」段最后,不随主机出现顺序跳动
  const di = real.indexOf(DEFAULT_GROUP);
  if (di !== -1) real.splice(di, 1), real.push(DEFAULT_GROUP);
  return { custom, real, cloud };
}

/// 分组名校验,返回错误文案;null = 合法。保留名与任何已有组(含云厂商组)
/// 都不能重名,重命名时豁免自己当前的名字。
function validateGroupName(raw, entry) {
  const name = String(raw).trim();
  if (!name) return '请输入分组名称';
  if (name.length > 40) return '分组名称不能超过 40 个字符';
  if (name === STAR_NOTE || name === '全部' || name === '常用') return `「${name}」是保留名称`;
  const exempt = entry?.mode === 'rename' && name === entry.from;
  if (!exempt) {
    const { real, cloud } = groupModel();
    if ([...real, ...cloud].includes(name)) return `已存在同名分组「${name}」`;
  }
  return null;
}

/* ---------------- 过滤 ---------------- */

function filterRows() {
  let list = hosts();
  if (activeGroup === STAR_NOTE) {
    const fav = favSet();
    list = list.filter((h) => fav.has(h.id));
  } else if (activeGroup) {
    list = list.filter((h) => groupOf(h) === activeGroup);
  }
  const kw = keyword.trim().toLowerCase();
  if (!kw) return list;
  return list.filter((h) =>
    `${h.name || ''} ${h.username || ''} ${h.host || ''} ${groupOf(h)} ${(h.tags || []).join(' ')}`
      .toLowerCase()
      .includes(kw));
}

/* ---------------- 渲染 ---------------- */

export function openHostLibrary() {
  selected = new Set();
  activeGroup = '';
  keyword = '';
  editing = null; // 上次可能带着未完成的编辑直接关了弹窗
  const card = $('#modal-host-library');
  if (!card) return;
  const inp = $('#hl-search');
  if (inp) inp.value = '';
  renderLibrary();
  openModal('#modal-host-library');
  inp?.focus();
}

function updateBatchBar() {
  const empty = $('#hl-batch-empty');
  const active = $('#hl-batch-active');
  const hasSel = selected.size > 0;
  empty?.classList.toggle('hidden', hasSel);
  active?.classList.toggle('hidden', !hasSel);
  const n = $('#hl-sel-count');
  if (n) n.textContent = `已选 ${selected.size} 台`;
  const sum = $('#hl-summary');
  if (sum) {
    const total = hosts().length;
    // 「全部」且无关键词 = 未筛选,直接报总数;否则报「显示 M / N 台」
    const filtered = !!activeGroup || !!keyword.trim();
    sum.textContent = filtered ? `显示 ${filterRows().length} / ${total} 台` : `共 ${total} 台`;
  }
}

function groupItem({ name, label, count, icon: ic, fav = false, cloud = false, droppable, editable = false, draggable = false, title = '' }) {
  const el = document.createElement('div');
  el.className = 'hl-group'
    + (activeGroup === name ? ' on' : '')
    + (fav ? ' fav' : '')
    + (cloud ? ' cloud' : '')
    + (editable ? ' editable' : '');
  el.dataset.group = name;
  el.dataset.droppable = String(droppable);
  if (draggable) el.dataset.draggable = 'true';
  if (title) el.title = title;
  el.innerHTML = `${icon(ic, { size: 12 })}<span class="hlg-name">${escapeHtml(label)}</span><span class="hlg-n">${count}</span>`;
  el.addEventListener('click', () => {
    // 拖拽结束的余波不算点击(否则拖完顺手换掉当前筛选)
    if (Date.now() - groupDragEndedAt < 300) return;
    if (activeGroup === name) return; // 已是当前视图,不重绘
    activeGroup = name;
    renderLibrary();
  });
  if (editable) bindGroupActions(el, name);
  if (draggable) bindGroupDrag(el, name);
  return el;
}

/// 可编辑分组的 ✎/🗑 悬停动作、右键菜单与双击重命名
function bindGroupActions(el, name) {
  const acts = document.createElement('span');
  acts.className = 'hlg-acts';
  const mk = (act, cls, ic, tip) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hlg-act' + (cls ? ` ${cls}` : '');
    b.dataset.act = act;
    b.title = tip;
    b.setAttribute('aria-label', `${tip}：${name}`);
    b.innerHTML = icon(ic, { size: 12 });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (act === 'rename') startRename(name);
      else deleteGroup(name);
    });
    acts.appendChild(b);
  };
  mk('rename', '', 'pencil', '重命名');
  mk('delete', 'del', 'trash', '删除分组');
  el.appendChild(acts);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 别让窗口级 contextmenu 处理器把刚弹出的菜单立刻关掉
    e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '重命名…', icon: 'pencil', run: () => startRename(name) },
      { label: '删除分组…', icon: 'trash', danger: true, run: () => deleteGroup(name) },
    ], { trigger: el, label: '分组' });
  });
  el.addEventListener('dblclick', () => startRename(name));
}

/// 原地编辑行:文件夹图标 + 单行输入框(错误态类由状态决定)
function buildEditorRow() {
  const row = document.createElement('div');
  row.className = 'hl-group hl-group-edit';
  row.innerHTML = `${icon('folder', { size: 12 })}<input class="hlg-input${editing.error ? ' invalid' : ''}" type="text" maxlength="40" placeholder="分组名称" aria-label="分组名称" />`;
  const input = row.querySelector('input');
  input.value = editing.draft;
  input.addEventListener('input', () => {
    editing.draft = input.value;
    // 一旦重新输入就撤掉错误提示,不打断打字
    if (editing.error) {
      editing.error = null;
      input.classList.remove('invalid');
      input.closest('#hl-groups')?.querySelector('.hlg-err')?.remove();
    }
  });
  input.addEventListener('keydown', (e) => {
    // Enter 提交;Esc 由 document 捕获层的弹窗 Esc 钩子接管(core.js)
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      commitEditByKey();
    }
  });
  input.addEventListener('blur', () => {
    // 延迟到 click 之后:点行内按钮(新建/重命名/删除)时先让点击走完
    const entry = editing;
    setTimeout(() => {
      // 重绘换掉了输入框(isConnected=false)或编辑会话已切换 → 不是用户失焦
      if (!input.isConnected || editing !== entry) return;
      finishBlur(entry);
    }, 0);
  });
  return row;
}

function renderGroups() {
  const box = $('#hl-groups');
  if (!box) return;
  // 重绘会清空 DOM:拖拽排序/改名后不要把左栏滚回顶部
  const keepTop = box.scrollTop;
  box.innerHTML = '';
  const fav = favSet();
  const model = groupModel();
  const countOf = (g) => hosts().filter((h) => groupOf(h) === g).length;

  // 视图区:全部 / ☆常用。是筛选不是目录,一律不可落点。
  box.appendChild(groupItem({ name: '', label: '全部', count: hosts().length, icon: 'listChecks', droppable: false }));
  // 常用是星标集合(favoriteHostIds),不是目录:必须禁用落点,
  // 否则拖入会写入 h.group='⭐ 常用',列表出现第二个同名「常用」目录。
  box.appendChild(groupItem({ name: STAR_NOTE, label: '常用', count: fav.size, icon: 'star', fav: true, droppable: false }));

  // 「分组」段:真实目录,全部可落点;除默认组外可重命名/删除
  const sec1 = document.createElement('div');
  sec1.className = 'hlg-sec hlg-sec-first';
  sec1.textContent = '分组';
  box.appendChild(sec1);
  for (const g of model.real) {
    if (editing?.mode === 'rename' && editing.from === g) {
      box.appendChild(buildEditorRow());
      if (editing.error) box.appendChild(errNode());
      continue;
    }
    box.appendChild(groupItem({
      name: g,
      label: g,
      count: countOf(g),
      icon: 'folder',
      droppable: true,
      editable: g !== DEFAULT_GROUP,
      // 默认组是收件箱桶,位置由模型钉在段尾,拖动它只会"拖了没反应",禁用
      draggable: g !== DEFAULT_GROUP,
      title: g === DEFAULT_GROUP ? '默认分组:未指定分组的主机' : '拖动可调整分组顺序',
    }));
  }

  // 「＋ 新建分组」常驻行:点击(或拖入)进入原地输入,可携带待移入主机
  if (editing?.mode === 'create') {
    box.appendChild(buildEditorRow());
    if (editing.error) box.appendChild(errNode());
  } else {
    const newEl = document.createElement('div');
    newEl.className = 'hl-group hl-group-new';
    newEl.dataset.group = '__new__';
    newEl.dataset.droppable = 'true';
    newEl.title = '新建自建分组，或直接拖拽选中主机到此处';
    newEl.innerHTML = `${icon('plus', { size: 12 })}<span class="hlg-name">新建分组</span>`;
    newEl.addEventListener('click', () => startCreate(null));
    box.appendChild(newEl);
  }

  // 「云厂商」段:按导入来源自动归类,可点选筛选,不可落点/改名/删除
  if (model.cloud.length) {
    const sec2 = document.createElement('div');
    sec2.className = 'hlg-sec';
    sec2.innerHTML = '云厂商<span class="hlg-sec-note">自动归类</span>';
    box.appendChild(sec2);
    for (const g of model.cloud) {
      box.appendChild(groupItem({
        name: g,
        label: g,
        count: countOf(g),
        icon: 'cloud',
        cloud: true,
        droppable: false,
        title: '云厂商分组:按导入来源自动归类,不能拖入;把主机拖到上方分组即可自定义归属',
      }));
    }
  }

  // 重绘后恢复滚动位置(拖拽排序后列表不应跳回顶部)
  box.scrollTop = keepTop;

  // 重绘后恢复编辑焦点(草稿在 editing 里);重命名首次聚焦时全选旧名
  if (editing) {
    const inp = box.querySelector('input.hlg-input');
    if (inp) {
      inp.focus();
      if (!editing._focused) {
        if (editing.mode === 'rename') inp.select();
        editing._focused = true;
      }
    }
  }
}

function errNode() {
  const err = document.createElement('div');
  err.className = 'hlg-err';
  err.textContent = editing.error || '';
  return err;
}

export function renderLibrary() {
  const tbody = $('#hl-tbody');
  if (!tbody) return;
  const fav = favSet();
  const rows = filterRows();
  const keepTop = $('#hl-table-wrap')?.scrollTop || 0;

  const countEl = $('#hl-count');
  if (countEl) countEl.textContent = `${hosts().length} 台`;
  renderGroups();

  // 全选状态:只看当前筛选结果(与批量执行的"隐藏已选"语义一致)
  const box = $('#hl-check-all');
  if (box) {
    const all = rows.length > 0 && rows.every((h) => selected.has(h.id));
    const some = rows.some((h) => selected.has(h.id));
    box.classList.toggle('on', all);
    box.classList.toggle('part', !all && some);
    // on 必须有对钩(纯实心块读不出"已勾选"),与行内复选框同一套视觉
    box.innerHTML = all ? icon('check', { size: 9 }) : '';
  }

  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.appendChild(emptyRow());
    updateBatchBar();
    return;
  }

  for (const h of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = h.id;
    if (selected.has(h.id)) tr.classList.add('sel');
    const isFav = fav.has(h.id);
    const needCred = !h.hasPassword && !h.hasKey;
    const port = Number(h.port) || 22;
    const tags = (h.tags || []).map((t) => `<span class="hl-tag">${escapeHtml(t)}</span>`).join('');
    tr.innerHTML = `
      <td class="hl-c-h"><span class="hl-grip" title="拖动调整顺序">${icon('gripVertical', { size: 12 })}</span></td>
      <td class="hl-c-chk"><span class="hl-box${selected.has(h.id) ? ' on' : ''}">${
        selected.has(h.id) ? icon('check', { size: 9 }) : ''
      }</span></td>
      <td class="hl-c-name" title="${escapeHtml(h.name || '')}">${escapeHtml(h.name || h.host)}</td>
      <td class="hl-c-user">${escapeHtml(h.username || 'root')}</td>
      <td class="hl-c-addr" title="${escapeHtml(h.host)}:${port}">${escapeHtml(h.host)}<span class="hl-port">:${port}</span></td>
      <td class="hl-c-grp" title="${escapeHtml(groupOf(h))}">${escapeHtml(groupOf(h))}</td>
      <td class="hl-c-tags">${tags}</td>
      <td class="hl-c-cred${needCred ? ' warn' : ''}">${needCred ? '待补全' : '已存'}</td>
      <td class="hl-c-act"><div class="hl-acts">
        <button class="hl-fav${isFav ? ' on' : ''}" data-act="fav" title="${isFav ? '取消常用' : '标记为常用'}" aria-pressed="${isFav}">${icon('star', { size: 12 })}</button>
        <button data-act="edit" title="编辑">${icon('pencil', { size: 12 })}</button>
        <button data-act="clone" title="复制">${icon('copy', { size: 12 })}</button>
        <button class="del" data-act="del" title="删除">${icon('trash', { size: 12 })}</button>
      </div></td>`;

    // 行点击 = 选中切换;操作列与拖拽把手各自 stopPropagation;拖动刚结束时防误触
    tr.addEventListener('click', (e) => {
      if (Date.now() - dragEndedAt < 300) return;
      if (e.target.closest('.hl-acts') || e.target.closest('.hl-grip')) return;
      // Chromium 里 click 先于 blur 的 setTimeout 执行:先了结编辑会话再重绘,
      // 否则这里的整库重绘会换掉输入框,失焦提交被 isConnected 守卫误判放弃
      if (editing) finishBlur(editing);
      if (selected.has(h.id)) selected.delete(h.id); else selected.add(h.id);
      renderLibrary();
    });
    tr.querySelector('[data-act="fav"]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(h.id);
    });
    tr.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openHostModal(h);
    });
    tr.querySelector('[data-act="clone"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api('hosts:clone', { id: h.id });
        toast('已复制主机', 'success');
        await refreshHosts();
        renderLibrary();
      } catch (err) {
        toast('复制失败：' + err.message, 'error');
      }
    });
    tr.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await askConfirm(`确定删除主机「${h.name}」吗？此操作不可撤销。`, { title: '删除主机', okText: '删除' }))) return;
      try {
        await api('hosts:delete', { id: h.id });
        selected.delete(h.id);
        toast('已删除', 'success');
        await refreshHosts();
        renderLibrary();
      } catch (err) {
        toast('删除失败：' + err.message, 'error');
      }
    });

    bindRowDrag(tr, h);
    tbody.appendChild(tr);
  }

  const wrap = $('#hl-table-wrap');
  if (wrap) wrap.scrollTop = keepTop;
  updateBatchBar();
}

/// 空表按语境给出口径与下一步动作,而不是一句通用的「没有匹配」
function emptyRow() {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 9;
  td.className = 'hl-empty';
  const title = document.createElement('div');
  title.className = 'hl-empty-title';
  const hint = document.createElement('div');
  hint.className = 'hl-empty-hint';
  let action = null;
  if (!hosts().length) {
    title.textContent = '还没有主机';
    action = mkEmptyAction('新建主机', () => openHostModal(null));
  } else if (keyword.trim()) {
    title.textContent = `没有匹配「${keyword.trim()}」的主机`;
    action = mkEmptyAction('清空搜索', () => {
      keyword = '';
      const inp = $('#hl-search');
      if (inp) { inp.value = ''; inp.focus(); }
      renderLibrary();
    });
  } else if (activeGroup === STAR_NOTE) {
    title.textContent = '还没有常用主机';
    hint.textContent = '点击行尾 ☆ 即可标记常用';
  } else if (activeGroup) {
    title.textContent = `分组「${activeGroup}」还没有主机`;
    hint.textContent = '在「全部」里勾选主机后点「移动到…」,或把行首 ⋮⋮ 拖到左侧分组';
    action = mkEmptyAction('查看全部', () => {
      activeGroup = '';
      renderLibrary();
    });
  }
  td.appendChild(title);
  if (hint.textContent) td.appendChild(hint);
  if (action) td.appendChild(action);
  tr.appendChild(td);
  return tr;
}

function mkEmptyAction(label, run) {
  const b = document.createElement('button');
  b.id = 'hl-empty-action';
  b.type = 'button';
  b.className = 'btn small';
  b.textContent = label;
  b.addEventListener('click', run);
  return b;
}

/* ---------------- 分组原地编辑 ---------------- */

function startCreate(moveIds) {
  editing = { mode: 'create', from: null, moveIds: moveIds?.length ? [...moveIds] : null, draft: '', error: null, _focused: false };
  renderLibrary();
}

function startRename(from) {
  editing = { mode: 'rename', from, moveIds: null, draft: from, error: null, _focused: false };
  renderLibrary();
}

function cancelEdit() {
  if (!editing) return;
  editing = null;
  renderLibrary();
}

/// Enter 提交:非法时保持编辑,就地显示错误(草稿不丢)
function commitEditByKey() {
  const entry = editing;
  if (!entry) return;
  const name = entry.draft.trim();
  if (entry.mode === 'rename' && name === entry.from) { cancelEdit(); return; }
  const error = validateGroupName(entry.draft, entry);
  if (error) {
    editing.error = error;
    renderGroups(); // 从状态重绘:草稿保留、错误显示、输入重新聚焦
    return;
  }
  commitEdit(name);
}

/// 失焦提交:空/未改 = 放弃;非法 = 放弃并 toast;合法且变更 = 提交
function finishBlur(entry) {
  if (editing !== entry) return;
  const name = entry.draft.trim();
  if (!name) { cancelEdit(); return; }
  const error = validateGroupName(entry.draft, entry);
  if (error) { cancelEdit(); toast(error, 'error'); return; }
  if (entry.mode === 'rename' && name === entry.from) { cancelEdit(); return; }
  commitEdit(name);
}

async function commitEdit(name) {
  const entry = editing;
  if (!entry) return;
  editing = null;
  if (entry.mode === 'create') await commitCreate(name, entry.moveIds);
  else await commitRename(entry.from, name);
}

async function commitCreate(name, moveIds) {
  ensureCustomGroup(name);
  if (moveIds?.length) { await moveToGroup(moveIds, name); return; }
  // 新建后停在当前视图,方便马上把主机拖进新组
  renderLibrary();
  renderHosts(); // 侧栏分组条同步出现新组
  const el = [...($('#hl-groups')?.children || [])].find((n) => n.dataset?.group === name);
  if (el) {
    el.classList.add('just-added');
    el.scrollIntoView({ block: 'nearest' });
    setTimeout(() => el.classList.remove('just-added'), 1200);
  }
  toast(`已创建分组「${name}」,把主机拖到这里即可移入`, 'success');
}

async function commitRename(from, to) {
  const ids = hosts().filter((h) => h.group === from).map((h) => h.id);
  try {
    if (ids.length) await api('hosts:bulkUpdate', { ids, patch: { group: to } });
    const custom = uiPrefs().customGroups;
    const order = uiPrefs().groupOrder;
    // 排序表里的名字跟着改名走,否则该组会被当成"没记录过"掉到队列末尾
    saveUiPrefs({
      customGroups: custom.includes(from) ? custom.map((g) => (g === from ? to : g)) : custom,
      groupOrder: order.includes(from) ? order.map((g) => (g === from ? to : g)) : order,
    });
    if (activeGroup === from) activeGroup = to;
    await refreshHosts();
  } catch (e) {
    toast('重命名失败：' + e.message, 'error');
    renderLibrary();
    return;
  }
  renderLibrary();
  toast(`已重命名为「${to}」`, 'success');
}

async function deleteGroup(name) {
  const ids = hosts().filter((h) => h.group === name).map((h) => h.id);
  if (ids.length && !(await askConfirm(
    `删除分组「${name}」？其中 ${ids.length} 台主机会移出该分组（归入「我的主机」或其云厂商分组），主机本身不会删除。`,
    { title: '删除分组', okText: '删除分组' },
  ))) return;
  try {
    if (ids.length) await api('hosts:bulkUpdate', { ids, patch: { group: '' } });
  } catch (e) {
    toast('删除分组失败：' + e.message, 'error');
    return;
  }
  const custom = uiPrefs().customGroups;
  const order = uiPrefs().groupOrder;
  saveUiPrefs({
    customGroups: custom.includes(name) ? custom.filter((g) => g !== name) : custom,
    groupOrder: order.filter((g) => g !== name),
  });
  if (activeGroup === name) activeGroup = '';
  await refreshHosts();
  renderLibrary();
  toast(ids.length ? `已删除分组「${name}」，${ids.length} 台主机已移出` : `已删除空分组「${name}」`, 'success');
}

/* ---------------- 拖拽 ---------------- */

/// 拖动行:已被选中的行拖动时整批移动;未选中的单行只移动自己并加入选择。
/// 落点有两种:左栏分组(移动分组)、同组行(排序)。
function bindRowDrag(tr, host) {
  const grip = tr.querySelector('.hl-grip');
  if (!grip) return;
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 否则 WebKit 会从按下就开始选文字,拖完还残留
    e.preventDefault();
    dragStart(e, host, tr);
  });
}

/// 分组目录排序:整行按下即待拖,位移过阈值才进入拖拽(单击仍是筛选)。
/// 只允许「分组」段里的真实目录互相排序 —— 全部/常用是视图、云厂商是自动归类、
/// 「新建分组」是动作行,默认组「我的主机」按设计钉在段尾,都不参与。
function bindGroupDrag(el, name) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 行内 ✎/🗑 与重命名输入框自己处理点击
    if (e.target.closest?.('.hlg-acts, .hlg-input')) return;
    dragGroupStart(e, name, el);
  });
}

function dragGroupStart(ev, name, el) {
  const rows = [...document.querySelectorAll('#hl-groups .hl-group[data-draggable="true"]')];
  let ghost = null;
  let target = null; // { name, after }
  const clearHints = () => {
    for (const n of rows) n.classList.remove('insert-top', 'insert-bottom');
  };
  startMouseDrag(ev, el, {
    onMove: (e) => {
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'hl-dragon';
        ghost.textContent = name;
        document.body.appendChild(ghost);
        el.classList.add('dragging');
      }
      ghost.style.left = `${e.clientX + 12}px`;
      ghost.style.top = `${e.clientY + 8}px`;
      clearHints();
      target = null;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#hl-groups .hl-group');
      if (over && over !== el && over.dataset.draggable === 'true') {
        const rect = over.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        over.classList.add(after ? 'insert-bottom' : 'insert-top');
        target = { name: over.dataset.group, after };
      }
    },
    onEnd: () => {
      groupDragEndedAt = Date.now();
      clearHints();
      ghost?.remove();
      el.classList.remove('dragging');
      if (target) reorderGroups(name, target.name, target.after);
      else renderLibrary(); // 落在空白处 = 次序不变,但要清掉拖拽态
    },
  });
}

/// 把 from 插到 to 的前/后,写回 settings.ui.groupOrder。默认组固定段尾,
/// 不进这个数组(写进去也会被 groupModel 挪回最后)。
function reorderGroups(from, to, after) {
  if (from === to) return;
  const order = groupModel().real.filter((g) => g !== from && g !== DEFAULT_GROUP);
  const at = order.indexOf(to);
  if (at === -1) return;
  order.splice(after ? at + 1 : at, 0, from);
  saveUiPrefs({ groupOrder: order });
  renderLibrary();
  renderHosts(); // 侧栏分组条读同一份次序
  toast(`已调整「${from}」的顺序`, 'success');
}

function dragStart(ev, host, tr) {
  // 如果当前行不在 selected 里，拖拽只针对当前行，不要强行污染 selected
  const ids = selected.has(host.id) ? [...selected] : [host.id];
  const rows = [...document.querySelectorAll('#hl-tbody tr[data-id]')]
    .filter((el) => ids.includes(el.dataset.id));
  let ghost = null;
  let dropGroup = null;
  let insertTarget = null; // { id: string, after: boolean }

  const clearHints = () => {
    for (const el of document.querySelectorAll('#hl-tbody tr.insert, #hl-tbody tr.insert-top, #hl-tbody tr.insert-bottom')) {
      el.classList.remove('insert', 'insert-top', 'insert-bottom');
    }
    for (const el of document.querySelectorAll('.hl-group.drop')) el.classList.remove('drop');
  };

  startMouseDrag(ev, tr, {
    onMove: (e) => {
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'hl-dragon';
        ghost.textContent = ids.length > 1 ? `移动 ${ids.length} 台` : (host.name || host.host);
        document.body.appendChild(ghost);
        for (const el of rows) el.classList.add('drag');
        // 拖拽真正开始才进入拖拽态:此时不可落点分组才置灰(CSS)
        $('#modal-host-library .hl-card')?.classList.add('hl-dragging');
      }
      ghost.style.left = `${e.clientX + 14}px`;
      ghost.style.top = `${e.clientY + 10}px`;

      clearHints();
      dropGroup = null;
      insertTarget = null;

      // ① 落在左栏可接受分组 → 移动分组
      const gEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.hl-group');
      if (gEl && gEl.dataset.droppable === 'true') {
        gEl.classList.add('drop');
        dropGroup = gEl.dataset.group;
        return;
      }
      // ② 落在同组行 → 排序(跨组行不响应:那是"移动分组",不该混进排序)
      const overTr = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#hl-tbody tr[data-id]');
      if (overTr && overTr !== tr && !ids.includes(overTr.dataset.id)) {
        const overHost = hosts().find((h) => h.id === overTr.dataset.id);
        const srcHost = hosts().find((h) => h.id === host.id);
        // 只有同组内才允许排序 —— 组内次序才有意义,跨组会同时改分组
        if (overHost && srcHost && !keyword.trim() && sameGroupForSort(overHost, srcHost)) {
          const rect = overTr.getBoundingClientRect();
          const isAfter = (e.clientY - rect.top) > (rect.height / 2);
          if (isAfter) {
            overTr.classList.add('insert-bottom');
            insertTarget = { id: overHost.id, after: true };
          } else {
            overTr.classList.add('insert-top');
            insertTarget = { id: overHost.id, after: false };
          }
        }
      }
    },
    onEnd: () => {
      dragEndedAt = Date.now();
      clearHints();
      ghost?.remove();
      $('#modal-host-library .hl-card')?.classList.remove('hl-dragging');
      for (const el of rows) el.classList.remove('drag');
      if (dropGroup === '__new__') {
        // 拖到「新建分组」= 新建并移入:原地输入,提交后整批移入
        startCreate(ids);
      } else if (dropGroup !== null) {
        moveToGroup(ids, dropGroup);
      } else if (insertTarget) {
        reorderTo(ids, insertTarget.id, insertTarget.after);
      } else {
        renderLibrary();
      }
    },
  });
}

/// 排序只在"两个主机当前显示在同一个分组视图里"时成立。
/// 全部视图下也允许:此时顺序是全局顺序,拖到谁前面就插到谁前面。
function sameGroupForSort(a, b) {
  if (!activeGroup) return true;
  return groupOf(a) === groupOf(b);
}

async function moveToGroup(ids, group) {
  const before = hosts().map((h) => h.id);
  ensureCustomGroup(group);
  try {
    const r = await api('hosts:bulkUpdate', { ids, patch: { group } });
    await refreshHosts();
    renderLibrary();
    const n = r?.updated ?? ids.length;
    toast(`已移动 ${n} 台到「${group}」`, 'success');
  } catch (e) {
    selected = new Set(before.filter((id) => selected.has(id)));
    toast('移动失败：' + e.message, 'error');
    renderLibrary();
  }
}

async function reorderTo(ids, targetId, after = false) {
  const current = hosts().map((h) => h.id);
  const moving = ids.filter((id) => id !== targetId);
  const rest = current.filter((id) => !moving.includes(id));
  const at = rest.indexOf(targetId);
  if (at < 0) return;
  const insertIndex = after ? at + 1 : at;
  const next = [...rest.slice(0, insertIndex), ...moving, ...rest.slice(insertIndex)];
  // 乐观更新:先把本地数组排好,侧栏与弹窗一起重绘;失败再回滚
  const snapshot = state.hosts.slice();
  const byId = new Map(state.hosts.map((h) => [h.id, h]));
  state.hosts = next.map((id) => byId.get(id)).filter(Boolean);
  renderLibrary();
  try {
    await api('hosts:reorder', { orderedIds: next });
  } catch (e) {
    state.hosts = snapshot;
    renderLibrary();
    toast('保存顺序失败：' + e.message, 'error');
  }
}

/* ---------------- 批量操作 ---------------- */

async function bulkDelete() {
  if (!selected.size) return;
  const ids = [...selected];
  if (!(await askConfirm(`确定删除选中的 ${ids.length} 台主机吗？此操作不可撤销。`, { title: '批量删除', okText: '删除' }))) return;
  try {
    const r = await api('hosts:bulkDelete', { ids });
    selected.clear();
    toast(`已删除 ${r?.deleted ?? ids.length} 台`, 'success');
    await refreshHosts();
    renderLibrary();
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

async function bulkTag() {
  if (!selected.size) return;
  const allTags = [...new Set(hosts().flatMap((h) => h.tags || []))].filter(Boolean);
  const tagHint = allTags.length ? `\n（已有标签：${allTags.slice(0, 8).join(', ')}${allTags.length > 8 ? '…' : ''}）` : '';
  const raw = await askPrompt(
    `输入标签（逗号分隔；前缀 - 表示移除，如 -old）：${tagHint}`,
    { title: `批量标签 (已选 ${selected.size} 台)`, okText: '应用' },
  );
  if (raw === null) return;
  const addTags = [];
  const removeTags = [];
  for (const part of String(raw).split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('-')) removeTags.push(t.slice(1).trim());
    else addTags.push(t);
  }
  if (!addTags.length && !removeTags.length) return;
  try {
    const ids = [...selected];
    const r = await api('hosts:bulkUpdate', { ids, patch: { addTags, removeTags } });
    toast(`已更新 ${r?.updated ?? ids.length} 台`, 'success');
    await refreshHosts();
    renderLibrary();
  } catch (e) {
    toast('更新失败：' + e.message, 'error');
  }
}

/* ---------------- 事件绑定 ---------------- */

let bound = false;
export function bindHostLibrary() {
  if (bound) return;
  const card = $('#modal-host-library');
  if (!card) return;
  bound = true;

  $('#hl-search')?.addEventListener('input', (e) => {
    keyword = e.target.value;
    renderLibrary();
  });
  $('#hl-search-clear')?.addEventListener('click', () => {
    keyword = '';
    const inp = $('#hl-search');
    if (inp) { inp.value = ''; inp.focus(); }
    renderLibrary();
  });
  $('#hl-close')?.addEventListener('click', () => closeModal('#modal-host-library'));

  // Esc 分层:编辑中 → 取消编辑;有选择 → 清空选择;都否则交给 core 关闭弹窗。
  // core 在 document 捕获阶段拦 Esc,这里的 handler 返回 true 即视为已消化。
  setModalEscapeHandler(card, () => {
    if (editing) { cancelEdit(); return true; }
    if (selected.size) { selected.clear(); renderLibrary(); return true; }
    return false;
  });

  $('#hl-check-all')?.addEventListener('click', () => {
    const rows = filterRows();
    const all = rows.length > 0 && rows.every((h) => selected.has(h.id));
    if (all) for (const h of rows) selected.delete(h.id);
    else for (const h of rows) selected.add(h.id);
    renderLibrary();
  });
  $('#hl-cancel-sel')?.addEventListener('click', () => {
    selected.clear();
    renderLibrary();
  });

  // 批量移动下拉菜单(只列真实分组;云厂商组与视图不是目录)
  bindMenuButton($('#hl-bulk-move'), () => {
    if (!selected.size) return [];
    const ids = [...selected];
    const items = groupModel().real.map((g) => ({
      label: g,
      icon: 'folder',
      run: () => moveToGroup(ids, g),
    }));
    if (items.length) items.push('-');
    items.push({
      label: '＋ 新建分组并移入…',
      icon: 'plus',
      // run 在 closeCtxMenu 恢复焦点后的微任务里执行,原地输入框聚焦安全
      run: () => startCreate(ids),
    });
    return items;
  }, { label: '移动到分组' });

  // 批量连接
  $('#hl-bulk-connect')?.addEventListener('click', () => {
    if (!selected.size) return;
    const ids = [...selected];
    closeModal('#modal-host-library');
    for (const id of ids) {
      connectHost(id, null, { newTab: true });
    }
    toast(`已在新标签打开 ${ids.length} 台主机连接`, 'success');
  });

  $('#hl-bulk-tag')?.addEventListener('click', bulkTag);
  $('#hl-bulk-del')?.addEventListener('click', bulkDelete);
  // 库级动作收在工具栏右侧(搜索旁),底部只留提示
  // 导入/导出的实现驻留在 entry.js;从这里反向 import 会成环,
  // 走命令注册表触发(data-command 同一条路径)
  $('#hl-import')?.addEventListener('click', () => executeCommand('hosts.import'));
  $('#hl-export')?.addEventListener('click', () => executeCommand('hosts.export'));
  $('#hl-new-host')?.addEventListener('click', () => openHostModal(null));

  // 主机保存/删除后,若弹窗开着就刷新
  document.addEventListener('nebula:hosts-changed', () => {
    if ($('#modal-host-library')?.classList.contains('hidden') === false) renderLibrary();
  });
}
