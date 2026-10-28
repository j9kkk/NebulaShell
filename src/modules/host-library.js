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

import { $, api, askConfirm, askPrompt, closeModal, copyText, openModal, state, toast } from './core.js';
import { executeCommand } from './commands.js';
import { icon } from '../shared/icons.js';
import { escapeHtml, groupOf, openHostModal, refreshHosts, renderHosts, saveUiPrefs, STAR_NOTE, uiPrefs } from './hosts.js';
import { startMouseDrag } from '../shared/drag.js';

let selected = new Set();
let activeGroup = '';     // '' = 全部
let keyword = '';
let dragging = null;

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

/// 所有分组名(含派生分组),按首次出现顺序。
function allGroups() {
  const out = [];
  for (const h of hosts()) {
    const g = groupOf(h);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

/// 该分组是否可作为拖拽落点。派生分组(云厂商 / 我的主机)拖进去会写入
/// 字面量分组名,和真实数据混在一起且外部无法区分,所以一律不可落点。
/// 注意不能硬编码中文分组名:用户完全可以自建一个叫「阿里云」的组。
function droppableGroup(name) {
  if (name === STAR_NOTE) return false;
  const members = hosts().filter((h) => groupOf(h) === name);
  if (!members.length) return false;
  return !members.every((h) => !h.group && h.cloud);
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
  const card = $('#modal-host-library');
  if (!card) return;
  const inp = $('#hl-search');
  if (inp) inp.value = '';
  renderLibrary();
  openModal('#modal-host-library');
  inp?.focus();
}

function updateBatchBar() {
  const bar = $('#hl-batch');
  if (!bar) return;
  bar.classList.toggle('hidden', selected.size === 0);
  const n = $('#hl-sel-count');
  if (n) n.textContent = `已选 ${selected.size} 台`;
}

function renderGroups() {
  const box = $('#hl-groups');
  if (!box) return;
  box.innerHTML = '';
  const fav = favSet();
  const entries = [
    { name: '', label: '全部', count: hosts().length, icon: 'listChecks' },
    // 常用是星标集合(favoriteHostIds),不是目录:必须禁用落点,
    // 否则拖入会写入 h.group='⭐ 常用',列表出现第二个同名「常用」目录。
    { name: STAR_NOTE, label: '常用', count: fav.size, icon: 'star', fav: true, derived: true },
  ];
  for (const g of allGroups()) {
    entries.push({
      name: g,
      label: g,
      count: hosts().filter((h) => groupOf(h) === g).length,
      icon: 'folder',
      derived: !droppableGroup(g),
    });
  }
  for (const e of entries) {
    const el = document.createElement('div');
    el.className = 'hl-group'
      + (activeGroup === e.name ? ' on' : '')
      + (e.derived ? ' dis' : '')
      + (e.fav ? ' fav' : '');
    el.dataset.group = e.name;
    el.dataset.droppable = String(!e.derived && e.name !== '');
    if (e.derived) el.title = '这是派生分组,不能作为移动目标';
    el.innerHTML = `${icon(e.icon, { size: 12 })}<span class="hlg-name">${escapeHtml(e.label)}</span>`
      + `<span class="hlg-n">${e.count}</span>`;
    el.addEventListener('click', () => {
      activeGroup = e.name;
      renderLibrary();
    });
    box.appendChild(el);
  }
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
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="9" class="hl-empty">${
      hosts().length ? '没有匹配的主机' : '还没有主机,先新建一台'
    }</td>`;
    tbody.appendChild(tr);
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

    // 行点击 = 选中切换;操作列与拖拽把手各自 stopPropagation
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.hl-acts') || e.target.closest('.hl-grip')) return;
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

function dragStart(ev, host, tr) {
  const ids = selected.has(host.id) ? [...selected] : [host.id];
  if (!selected.has(host.id)) {
    selected.add(host.id);
    renderLibrary();
    // renderLibrary 重建了 DOM,原 handle 已脱离文档;后续判定按 id 走
  }
  const rows = [...document.querySelectorAll('#hl-tbody tr[data-id]')]
    .filter((el) => ids.includes(el.dataset.id));
  let ghost = null;
  let dropGroup = null;
  let insertBefore = null;

  const clearHints = () => {
    for (const el of document.querySelectorAll('#hl-tbody tr.insert')) el.classList.remove('insert');
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
      }
      ghost.style.left = `${e.clientX + 14}px`;
      ghost.style.top = `${e.clientY + 10}px`;

      clearHints();
      dropGroup = null;
      insertBefore = null;

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
          overTr.classList.add('insert');
          insertBefore = overHost.id;
        }
      }
    },
    onEnd: () => {
      clearHints();
      ghost?.remove();
      if (dropGroup !== null) moveToGroup(ids, dropGroup);
      else if (insertBefore) reorderTo(ids, insertBefore);
      else renderLibrary();
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

async function reorderTo(ids, beforeId) {
  const current = hosts().map((h) => h.id);
  const moving = ids.filter((id) => id !== beforeId);
  const rest = current.filter((id) => !moving.includes(id));
  const at = rest.indexOf(beforeId);
  if (at < 0) return;
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
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
  const raw = await askPrompt(
    '批量标签,逗号分隔;前缀 - 表示移除(例如 prod,-old)',
    { title: '批量标签', okText: '应用' },
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
