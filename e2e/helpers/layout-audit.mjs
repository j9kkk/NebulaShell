// These functions run inside the WebView; keep them independent of module state.
export async function auditNarrowPanels() {
  // 文件分屏是布局树窗格(非可拖宽侧板),宽度档位审计只覆盖侧栏/AI 面板;
  // 文件分屏控件的最小尺寸由布局规划器(paneMinSize)保证。
  const panels = [...document.querySelectorAll('#sidebar, #ai-panel')];
  const controls = [...document.querySelectorAll('#ai-send')];
  const saved = [...panels, ...controls].map(el => ({ el, style: el.style.cssText, className: el.className }));
  // 模型选择器现为「触发钮 + 自定义菜单」(#ai-model-name 展示当前模型);
  // 长名溢出审计改为改写触发钮文字(2026-10-08 composer 重构)。
  const modelName = document.querySelector('#ai-model-name');
  const options = modelName ? modelName.textContent : '';
  const issues = [];
  let samples = 0;
  // rAF 双帧等待 + 定时器兜底:窗口被遮挡时 WKWebView 可能完全停摆 rAF,
  // 纯 rAF 等待会让审计永远挂起 —— 兜底牺牲一点布局稳定性换取可结束性。
  const frame = () => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 120);
  });
  const audit = (root, width) => {
    const box = root.getBoundingClientRect();
    const children = root.querySelectorAll('button, input, textarea, select, .ai-title, .file-toolbar-hint');
    for (const el of children) {
      if (!el.getClientRects().length || el.closest('#host-list, #file-list, #ai-messages')) continue;
      const rect = el.getBoundingClientRect();
      const where = el.id || el.className;
      if (rect.left < box.left - 1 || rect.right > box.right + 1) issues.push({ width, where, kind: 'outside-panel' });
      if (el.matches('button')) {
        if (el.scrollWidth > el.clientWidth + 1) issues.push({ width, where, kind: 'button-text-overflow', overflow: el.scrollWidth - el.clientWidth });
        if (el.classList.contains('icon') && Math.abs(rect.width - rect.height) > 1) issues.push({ width, where, kind: 'deformed-icon', w: rect.width, h: rect.height });
        if (rect.height < 25) issues.push({ width, where, kind: 'compressed-height', h: rect.height });
        const siblings = [...el.parentElement.children].filter(other => other !== el && other.matches('button, input, textarea, select') && other.getClientRects().length);
        for (const other of siblings) {
          const r = other.getBoundingClientRect();
          if (Math.min(rect.right, r.right) - Math.max(rect.left, r.left) > 1 && Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top) > 1) {
            issues.push({ width, where, other: other.id, kind: 'overlapping-controls' });
          }
        }
      }
    }
  };
  try {
    if (modelName) modelName.textContent = 'provider/very-long-model-name-with-version-2026';
    for (const panel of panels) {
      for (const other of panels) other.classList.toggle('hidden', other !== panel && other.id !== 'sidebar');
      panel.classList.remove('collapsed', 'hidden');
      panel.style.animation = 'none';
      const widths = panel.id === 'sidebar' ? [180, 196, 220, 264, 320, 480] : [260, 280, 320, 340, 360, 480];
      for (const width of widths) {
        panel.style.width = width + 'px';
        for (const el of controls) el.classList.remove('hidden');
        await frame();
        audit(panel, width);
        samples++;
      }
    }
    const status = document.querySelector('#statusbar').getBoundingClientRect();
    // 分层契约:顶层标题栏与二级区(标签行、侧栏、右侧工具栏、状态栏)互不重合
    const bar = document.querySelector('#titlebar').getBoundingClientRect();
    for (const sel of ['#tabbar', '#sidebar', '#ai-panel', '#statusbar']) {
      const r = document.querySelector(sel).getBoundingClientRect();
      if (r.width && r.height && Math.min(bar.bottom, r.bottom) - Math.max(bar.top, r.top) > 0.5
        && Math.min(bar.right, r.right) - Math.max(bar.left, r.left) > 0.5) issues.push({ kind: 'titlebar-overlap', with: sel });
    }
    // 标签行与右侧工具栏页签行共用 --tabbar-h:两条底部分隔线横向对齐
    const tabbar = document.querySelector('#tabbar').getBoundingClientRect();
    const aiHeader = document.querySelector('.ai-header').getBoundingClientRect();
    if (Math.abs(tabbar.bottom - aiHeader.bottom) > 1) issues.push({ kind: 'tabbar-aiheader-misaligned', tabbar: tabbar.bottom, aiHeader: aiHeader.bottom });
    // 右侧栏(此刻展开):常用命令页添加行上边框与状态栏上边框齐平;历史工具行输入框与按钮等高
    const snippetAdd = document.querySelector('#rp-snippets .snippet-add').getBoundingClientRect();
    if (Math.abs(snippetAdd.top - status.top) > 1) issues.push({ kind: 'snippet-add-misaligned', snippets: snippetAdd.top, main: status.top });
    const histSearch = document.querySelector('#hist-search').getBoundingClientRect();
    const histClear = document.querySelector('#hist-clear').getBoundingClientRect();
    if (Math.abs(histSearch.height - histClear.height) > 0.5) issues.push({ kind: 'history-toolbar-height', input: histSearch.height, button: histClear.height });
    document.querySelector('#sidebar').classList.add('collapsed');
    await frame();
    audit(document.querySelector('#sidebar'), 40);
    return { samples, issues };
  } finally {
    if (modelName) modelName.textContent = options;
    for (const { el, style, className } of saved) { el.style.cssText = style; el.className = className; }
    await frame();
  }
}

export async function auditTerminalViewport() {
  const root = document.querySelector('#layout-root');
  const stack = document.querySelector('#term-stack');
  const saved = stack.style.cssText;
  const issues = [];
  let samples = 0;
  try {
    for (const width of [320, 321, 336, 480, 645]) for (const height of [180, 181, 186, 191, 199, 205, 219, 240, 365, 550]) {
      stack.style.width = width + 'px';
      stack.style.flex = '0 0 ' + height + 'px';
      stack.style.height = height + 'px';
      // 应用侧布局调度是 rAF + 120ms 定时器兜底(失焦窗口 rAF 停摆),
      // 这里必须等过兜底窗口,否则 fit 尚未执行就量几何 —— 全是假裁切。
      await new Promise(resolve => setTimeout(resolve, 300));
      for (const pane of root.querySelectorAll('.term-pane')) {
        const screen = pane.querySelector('.xterm-screen');
        const viewport = pane.querySelector('.xterm-viewport');
        if (!screen || !viewport) continue;
        const p = pane.getBoundingClientRect(), s = screen.getBoundingClientRect(), v = viewport.getBoundingClientRect();
        samples++;
        if (s.bottom > p.bottom - 2 + 0.5 || s.right > p.right - 2 + 0.5 || s.height > viewport.clientHeight + 0.5 || s.top < v.top - 0.5 || s.bottom > v.bottom + 0.5) {
          issues.push({ width, height, pane: pane.dataset.pane, kind: 'terminal-clipped', screenBottom: s.bottom, paneBottom: p.bottom, screenHeight: s.height, viewportHeight: viewport.clientHeight, screenRight: s.right, paneRight: p.right });
        }
      }
    }
    if (!samples) issues.push({ kind: 'missing-live-terminal' });
    return { samples, issues };
  } finally {
    stack.style.cssText = saved;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

/// 文件分屏工具栏在多个窗格宽度下的几何:按钮不出窗格、互不重叠、保持单行;
/// 窗格内容宽 ≤400px 时 ⋯ 出现并收起新建文件夹/全选,更宽时 ⋯ 隐藏;✕⤢ 始终在行尾可见。
/// 宽度用内联样式强制(min-width 一并放开),与布局规划器无关。
export async function auditFilePaneToolbar(widths = [300, 326, 360, 400, 480]) {
  const pane = [...document.querySelectorAll('.term-pane.file-pane')].find((el) => el.getClientRects().length);
  if (!pane) return { samples: 0, issues: [{ kind: 'missing-file-pane' }], shown: [] };
  const saved = pane.style.cssText;
  const frame = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 120);
  });
  const issues = [];
  const shown = [];
  let samples = 0;
  const name = (b) => [...b.classList].find((c) => c.startsWith('fp-') || c.startsWith('pane-')) || b.className;
  try {
    for (const width of widths) {
      Object.assign(pane.style, { flex: `0 0 ${width}px`, width: `${width}px`, minWidth: '0', maxWidth: `${width}px`, right: 'auto' });
      await frame();
      samples++;
      const box = pane.getBoundingClientRect();
      if (Math.abs(box.width - width) > 1) { issues.push({ width, kind: 'width-not-applied', actual: box.width }); continue; }
      const bar = pane.querySelector('.file-toolbar');
      const barBox = bar.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll('button')]
        .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden');
      shown.push({ width, buttons: buttons.map(name) });
      const rects = buttons.map((b) => b.getBoundingClientRect());
      rects.forEach((r, i) => {
        const where = name(buttons[i]);
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5) issues.push({ width, where, kind: 'outside-pane', left: Math.round(r.left), right: Math.round(r.right), pane: [Math.round(box.left), Math.round(box.right)] });
        if (r.top < barBox.top - 0.5 || r.bottom > barBox.bottom + 0.5) issues.push({ width, where, kind: 'outside-toolbar-row' });
        for (let j = i + 1; j < rects.length; j++) {
          // 分体按钮(★▾)有意压住 1px 共用边框
          const group = buttons[i].closest('.split-group');
          if (group && group === buttons[j].closest('.split-group')) continue;
          const o = rects[j];
          if (Math.min(r.right, o.right) - Math.max(r.left, o.left) > 0.5 && Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top) > 0.5) {
            issues.push({ width, kind: 'overlap', a: where, b: name(buttons[j]) });
          }
        }
      });
      const centers = rects.map((r) => (r.top + r.bottom) / 2);
      if (centers.length && Math.max(...centers) - Math.min(...centers) > 2) issues.push({ width, kind: 'toolbar-wrapped' });
      const has = (cls) => buttons.some((b) => b.classList.contains(cls));
      const cs = getComputedStyle(pane);
      const inner = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const narrow = inner <= 400;
      if (has('fp-more') !== narrow) issues.push({ width, kind: narrow ? 'more-missing' : 'more-shown-wide' });
      if (narrow && (has('fp-mkdir') || has('fp-selectall'))) issues.push({ width, kind: 'low-frequency-not-folded' });
      if (!has('pane-close-btn') || !has('pane-zoom-btn')) issues.push({ width, kind: 'pane-buttons-missing' });
      const last = buttons[buttons.length - 1];
      if (last && !last.closest('.pane-toolbar')) issues.push({ width, kind: 'pane-buttons-not-at-end', last: name(last) });
    }
    return { samples, issues, shown };
  } finally {
    pane.style.cssText = saved;
    await frame();
  }
}
