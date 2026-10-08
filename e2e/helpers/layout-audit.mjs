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
    const footer = document.querySelector('.side-foot').getBoundingClientRect();
    const status = document.querySelector('#statusbar').getBoundingClientRect();
    // 底栏对齐契约:侧栏底部与主状态栏顶对齐(文件分屏已并入布局树,无独立底栏)
    if (Math.abs(footer.top - status.top) > 1) issues.push({ kind: 'footer-misaligned', sidebar: footer.top, main: status.top });
    document.querySelector('#sidebar').classList.add('collapsed');
    await frame();
    audit(document.querySelector('#sidebar'), 40);
    const collapsed = document.querySelector('.side-foot').getBoundingClientRect();
    if (Math.abs(collapsed.top - status.top) > 1) issues.push({ kind: 'collapsed-footer-misaligned' });
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
