// These functions run inside the WebView; keep them independent of module state.
export async function auditNarrowPanels() {
  const panels = [...document.querySelectorAll('#sidebar, #ai-panel, #file-panel')];
  const controls = [...document.querySelectorAll('#file-mkdir-row, #file-chmod-row, #ai-send')];
  const saved = [...panels, ...controls].map(el => ({ el, style: el.style.cssText, className: el.className }));
  const select = document.querySelector('#ai-model-switch');
  const options = select.innerHTML;
  const selected = select.value;
  const issues = [];
  let samples = 0;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
    select.innerHTML = '<option>provider/very-long-model-name-with-version-2026</option>';
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
    const file = document.querySelector('#file-status').getBoundingClientRect();
    if (Math.abs(footer.top - status.top) > 1 || Math.abs(file.top - status.top) > 1) issues.push({ kind: 'footer-misaligned', sidebar: footer.top, main: status.top, file: file.top });
    document.querySelector('#sidebar').classList.add('collapsed');
    await frame();
    audit(document.querySelector('#sidebar'), 40);
    const collapsed = document.querySelector('.side-foot').getBoundingClientRect();
    if (Math.abs(collapsed.top - status.top) > 1) issues.push({ kind: 'collapsed-footer-misaligned' });
    return { samples, issues };
  } finally {
    select.innerHTML = options;
    select.value = selected;
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
      await new Promise(resolve => setTimeout(resolve, 80));
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
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}
