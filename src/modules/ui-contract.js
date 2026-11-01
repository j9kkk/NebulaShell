// UI 布局契约的运行时自检（对应 docs/ui-layout-contract.md §四 / D1-D2）。
//
// 目的:把"关系式断言"提前到写代码的当下 —— 打开弹窗、切换状态、改完样式刷新,
// 控制台立刻报出「非数据行占了行槽位」「空态没居中」「按钮越界」这类问题,
// 而不是等发布前的像素基线。
//
// 断言一律是**关系式**（相对容器/相邻元素),不写绝对像素,因此跨平台、跨字体度量成立。
// 默认静默:干净时不打印任何东西;只在有 issue 时输出折叠分组。
//
// 开关(任一即可,生产默认全关):
//   ?ui-contract          URL 参数
//   localStorage['nb.uiContract'] = '1'
//   window.__NB_UI_CONTRACT__ = true
//   window.nebula.testMode（NEBULA_TEST=1 的真身冒烟）
// 手动调用:window.__uiContract.run() / .last / .on() / .off()

let installed = false;
let timer = 0;
let last = { issues: [], checked: 0, at: 0 };
let runs = 0;

const isOn = () => {
  try {
    // __NB_E2E__ 由测试桥注入(真身 NEBULA_TEST=1 时存在);nebula.testMode 在部分
    // 构建里是 undefined,两个都要认,否则契约在真身里永远不装。
    if (globalThis.__NB_E2E__ || globalThis.__NB_UI_CONTRACT__) return true;
    if (window.nebula?.testMode) return true;
    if (new URLSearchParams(location.search).has('ui-contract')) return true;
    return localStorage.getItem('nb.uiContract') === '1';
  } catch { return false; }
};

const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('.hidden');
const rectOf = (el) => el.getBoundingClientRect();
const px = (v) => parseFloat(v) || 0;

/* ---------------- 通用断言(可在 e2e / 单测里单独复用) ---------------- */

/// 子元素必须落在容器内容盒内(容差 tol)。历史 bug:窄面板下按钮溢出、卡片内容出界。
export function expectContained(container, child, tol = 1) {
  const c = rectOf(container);
  const b = rectOf(child);
  const left = b.left - c.left;
  const right = c.right - b.right;
  const top = b.top - c.top;
  const bottom = c.bottom - b.bottom;
  const bad = [];
  if (left < -tol) bad.push(`左侧超出 ${Math.round(-left)}px`);
  if (right < -tol) bad.push(`右侧超出 ${Math.round(-right)}px`);
  if (top < -tol) bad.push(`上方超出 ${Math.round(-top)}px`);
  if (bottom < -tol) bad.push(`下方超出 ${Math.round(-bottom)}px`);
  return bad.length ? { ok: false, detail: bad.join('、') } : { ok: true };
}

/// 兄弟控件不得重叠(容差 tol)。历史 bug:标题栏与二级区、状态栏按钮被挤到一起。
export function expectNoOverlap(a, b, tol = 1) {
  const ra = rectOf(a);
  const rb = rectOf(b);
  const dx = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
  const dy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
  return dx > tol && dy > tol
    ? { ok: false, detail: `重叠 ${Math.round(dx)}×${Math.round(dy)}px` }
    : { ok: true };
}

/// 文本不得被截断(有意省略号的单元格除外)。历史 bug:长主机名/长模型名被切。
export function expectNoOverflowText(el, tol = 1) {
  const over = el.scrollWidth - el.clientWidth;
  return over > tol ? { ok: false, detail: `文本溢出 ${over}px` } : { ok: true };
}

/// 内容必须在自身内容盒内双向居中(容差 tol)。历史 bug:空态贴顶、垂直居中靠 height hack。
/// 参考系刻意用**元素自己的内容盒**,不用父容器:父容器可能有 scrollbar-gutter 占位
/// (Chromium 经典滚动条会真的吃掉 9px),按父边框盒量就会误报"横向偏 9px"。
export function expectCentered(el, tol = 1) {
  const kids = [...el.children].filter((k) => visible(k));
  if (!kids.length) return { ok: true };
  const box = rectOf(el);
  const cs = getComputedStyle(el);
  const innerTop = box.top + px(cs.paddingTop) + px(cs.borderTopWidth);
  const innerBottom = box.bottom - px(cs.paddingBottom) - px(cs.borderBottomWidth);
  const innerLeft = box.left + px(cs.paddingLeft) + px(cs.borderLeftWidth);
  const innerRight = box.right - px(cs.paddingRight) - px(cs.borderRightWidth);
  const top = Math.min(...kids.map((k) => rectOf(k).top));
  const bottom = Math.max(...kids.map((k) => rectOf(k).bottom));
  const left = Math.min(...kids.map((k) => rectOf(k).left));
  const right = Math.max(...kids.map((k) => rectOf(k).right));
  const above = top - innerTop;
  const below = innerBottom - bottom;
  const axisX = Math.abs((left - innerLeft) - (innerRight - right));
  const bad = [];
  if (Math.abs(above - below) > tol) bad.push(`纵向偏差 ${Math.round(above - below)}px(上 ${Math.round(above)} / 下 ${Math.round(below)})`);
  if (axisX > tol * 2) bad.push(`横向偏差 ${Math.round(axisX)}px`);
  return bad.length ? { ok: false, detail: bad.join('、') } : { ok: true };
}

/// 数据槽位只放数据行:tbody 里出现"单格跨全列且无内容标记"的行 = 有人把非数据态塞进了行槽位。
/// 历史 bug:空态 <tr><td colspan=9> 继承了行分隔线,多出一条悬空的线。
/// 例外:唯一的跨列行若带 class / data-* (云主机按地域分组的标题行),属内容行,不算占位。
export function expectDataRowsOnly(tbody) {
  const rows = [...tbody.rows];
  const bad = [];
  rows.forEach((tr, i) => {
    const cells = [...tr.cells];
    if (cells.length !== 1) return;
    if (Number(cells[0].colSpan) <= 1) return;
    const marked = !!tr.getAttribute('class') || Object.keys(tr.dataset).length > 0;
    if (marked && rows.length > 1) return;
    const border = getComputedStyle(cells[0]).borderBottomWidth;
    bad.push(`第 ${i + 1} 行是跨列占位行(非数据态占了数据槽位)${border !== '0px' ? `,且带 ${border} 行线` : ''}`);
  });
  return bad.length ? { ok: false, detail: bad.join(';') } : { ok: true };
}

/// 容器不应出现意外的纵向滚动(空态/短内容时容器内容不该超出)。
export function expectNoUnexpectedScroll(container, tol = 1) {
  const over = container.scrollHeight - container.clientHeight;
  return over > tol ? { ok: false, detail: `内容超出容器 ${over}px(出现滚动)` } : { ok: true };
}

/* ---------------- 自动巡检 ---------------- */

const issues = [];

function note(scope, target, fn, ...args) {
  const res = fn(...args);
  if (res.ok) return;
  issues.push({
    scope,
    selector: label(target),
    detail: res.detail,
  });
}

function label(el) {
  if (!el) return '?';
  const id = el.id ? `#${el.id}` : '';
  const cls = [...el.classList].filter((c) => c !== 'hidden').slice(0, 3).map((c) => `.${c}`).join('');
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/// 巡检当前可见界面。scope 只用于在报告里区分触发点。
export function runUiContract(scope = 'manual') {
  issues.length = 0;
  let checked = 0;

  // ① 非数据态不得占用数据槽位(R1)
  for (const tbody of document.querySelectorAll('tbody')) {
    if (!visible(tbody) || !tbody.rows.length) continue;
    checked++;
    note(scope, tbody, expectDataRowsOnly, tbody);
  }

  // ② 空态原语:居中 + 无边框 + 父容器不滚动(R1/R2/R7)
  for (const box of document.querySelectorAll('.empty-state')) {
    if (!visible(box)) continue;
    checked++;
    note(scope, box, expectCentered, box);
    const cs = getComputedStyle(box);
    if (px(cs.borderTopWidth) + px(cs.borderBottomWidth) > 0) {
      issues.push({ scope, selector: label(box), detail: '空态容器不应带边框(行线属于数据行)' });
    }
    const parent = box.parentElement;
    if (parent && getComputedStyle(parent).overflowY !== 'hidden') {
      note(scope, parent, expectNoUnexpectedScroll, parent);
    }
  }

  // ③ 模态卡内可见控件不得越界 + 成组按钮不得重叠(R4/几何契约)
  //    跳过位于内部滚动容器里的控件:滚动后"出卡"是正常的,不构成越界。
  const scrolls = (el, stop) => {
    for (let p = el.parentElement; p && p !== stop; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if (o === 'auto' || o === 'scroll') return true;
    }
    return false;
  };
  for (const card of document.querySelectorAll('.modal-card')) {
    if (!visible(card)) continue;
    for (const btn of card.querySelectorAll('button')) {
      if (!visible(btn) || scrolls(btn, card)) continue;
      checked++;
      note(scope, btn, expectContained, card, btn);
    }
    for (const group of card.querySelectorAll('.modal-actions, .modal-toolbar, .hl-batch, .hl-batch-active')) {
      if (!visible(group)) continue;
      const kids = [...group.querySelectorAll(':scope > button, :scope > span > button')].filter(visible);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          checked++;
          note(scope, kids[i], expectNoOverlap, kids[i], kids[j]);
        }
      }
    }
  }

  runs++;
  last = { issues: [...issues], checked, at: Date.now(), scope, runs };
  report(last);
  return last;
}

function report(result) {
  if (!result.issues.length) return;
  const head = `[ui-contract] ${result.issues.length} 处布局契约问题 (${result.scope}, 检查 ${result.checked} 项)`;
  if (console.groupCollapsed) console.groupCollapsed(head); else console.warn(head);
  for (const it of result.issues) console.warn(`${it.selector} — ${it.detail}`);
  if (console.groupEnd) console.groupEnd();
}

/* ---------------- 触发器 ---------------- */

/// 弹窗显隐、列表重绘、窗口尺寸变化后各跑一次(去抖),覆盖"改完就看到"的场景。
export function installUiContract() {
  if (installed || !isOn()) return false;
  installed = true;
  const schedule = (scope) => {
    clearTimeout(timer);
    timer = setTimeout(() => requestAnimationFrame(() => runUiContract(scope)), 80);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName === 'class') {
        const t = r.target;
        if (t.closest?.('.modal, #modal-host-library, .modal-card') || t.id?.startsWith('hl-')) {
          schedule('class:' + label(t));
          return;
        }
      }
      if (r.type === 'childList' && (r.target.id === 'hl-tbody' || r.target.id === 'hl-groups')) {
        schedule('list:' + label(r.target));
        return;
      }
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => requestAnimationFrame(() => runUiContract('resize')), 150);
  });
  window.__uiContract = {
    run: (scope) => runUiContract(scope || 'manual'),
    get last() { return last; },
    get runs() { return runs; },
    get issues() { return [...issues]; },
    on: () => { try { localStorage.setItem('nb.uiContract', '1'); } catch { /* private mode */ } return 'reload to apply'; },
    off: () => { try { localStorage.removeItem('nb.uiContract'); } catch { /* noop */ } return 'reload to apply'; },
    // 供测试断言单独复用
    expectCentered, expectContained, expectNoOverlap, expectNoOverflowText, expectDataRowsOnly, expectNoUnexpectedScroll,
  };
  schedule('boot');
  return true;
}
