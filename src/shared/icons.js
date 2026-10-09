/// 单一事实源的 SVG 图标注册表。
/// 背景:此前按钮图标是 Unicode/emoji 混用(⏻✕🧹📢…),Windows 默认字体
/// 对冷门符号(如 U+23FB)缺字形渲染为方框,emoji 又走彩色渲染与单色符号
/// 风格割裂。统一为内联 SVG(stroke 继承 currentColor)后三端渲染一致。
/// 用法:
///   静态 HTML:<span class="mi" data-icon="trash"></span>,boot 时 hydrateIcons(document) 注入;
///   动态 DOM:直接 icon('trash') 拼进 innerHTML。
/// 加图标:在 ICONS 里加一项(24×24 viewBox 的 stroke path,参考 Lucide 风格)。
/// 注意:键盘符号(⌘⇧↵ 等)是文字性质,由 keymap/core 管理,不进本注册表。

const ICONS = {
  // 动作类
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  power: '<path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.36 6.36L3 16"/><path d="M3 21v-5h5"/>',
  upload: '<path d="M12 17V3"/><path d="m6 9 6-6 6 6"/><path d="M4 21h16"/>',
  download: '<path d="M12 3v14"/><path d="m6 11 6 6 6-6"/><path d="M4 21h16"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="m19 12-7 7-7-7"/><path d="M12 5v14"/>',
  zoom: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  zoomOff: '<path d="M8 3H3v5"/><path d="M16 21h5v-5"/><path d="M3 3l7 7"/><path d="M21 21l-7-7"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  // 面板/布局类
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/><path d="M12 3v18"/>',
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  sparkles: '<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  // 会话工具类
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  circleDot: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  shuffle: '<path d="M2 18h2.5a5 5 0 0 0 4.1-2.1L14 8.1A5 5 0 0 1 18.1 6H21"/><path d="M2 6h2.5a5 5 0 0 1 4.1 2.1l.4.6"/><path d="m18 3 3 3-3 3"/><path d="m18 15 3 3-3 3"/><path d="M14.9 15.3a5 5 0 0 0 3.2 1.7H21"/>',
  megaphone: '<path d="m3 11 15-6v14L3 13z"/><path d="M3 11v2a2 2 0 0 0 2 2h2l3 5a1 1 0 0 0 1.7-1L10 15"/>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 8 5-5 5 5"/><path d="M12 3v12"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98A7 7 0 0 0 4.06 12.2 4 4 0 0 0 6 19.9z"/>',
  eject: '<path d="m5 17 7-10 7 10z"/><path d="M5 20h14"/>',
  // 文件类
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M15 2v5h5"/>',
  folderPlus: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  listChecks: '<path d="m3 5 1.5 1.5L7 4"/><path d="m3 12 1.5 1.5L7 11"/><path d="m3 19 1.5 1.5L7 18"/><path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  broom: '<path d="m19 3-7 7"/><path d="m11 9 4 4"/><path d="M13 11 4 20s-1 0-1-1 9-12 9-12z"/>',
  // 状态类(toast/任务中心)
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  transfer: '<path d="m3 8 4-4 4 4"/><path d="M7 4v12"/><path d="m21 16-4 4-4-4"/><path d="M17 20V8"/>',
  dots: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  // 复制/交互
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  arrowUpSend: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
};

/// 图标集合版本号:仅用于测试快照对齐,加图标时不必改。
export const ICON_NAMES = Object.keys(ICONS);

const SIZES = { mi: 14, 'icon-tb': 15, icon: 14 };

/// 生成内联 SVG 字符串。size 缺省 14;cls 追加到 svg class。
export function icon(name, { size = 14, cls = '' } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const klass = cls ? ` class="${cls}"` : '';
  return `<svg${klass} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/// 把静态 HTML 里的 <span class="mi" data-icon="name"> 占位符批量替换为 SVG。
/// 仅处理带 data-icon 的占位;⌘⇧ 等键盘符号与纯文字 .mi 不受影响。
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.dataset.icon;
    const body = ICONS[name];
    if (!body) continue;
    let size = 14;
    if (el.classList.contains('icon-tb') || el.closest('.icon-tb')) size = 15;
    el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    el.removeAttribute('data-icon');
  }
}
