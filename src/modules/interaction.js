export function isAppModifier(event, platform) {
  return platform === 'darwin'
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isEditableTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

/// 文档级全选的 selectstart:引擎执行全选(⌘A / Ctrl+A / 编辑菜单「全选」)前,
/// 选区不在可编辑区时派发在 body 上;输入框、文本域内的全选派发在控件自身。
export function isDocumentSelectAll(event, doc = document) {
  const target = event?.target;
  return !!target && (target === doc.body || target === doc.documentElement);
}

export function popupPosition(anchor, size, viewport, margin = 8) {
  const width = Math.max(0, Math.min(size.width, viewport.width - margin * 2));
  const height = Math.max(0, Math.min(size.height, viewport.height - margin * 2));
  const below = viewport.height - anchor.bottom - margin;
  const above = anchor.top - margin;
  const top = height <= below || below >= above ? anchor.bottom : anchor.top - height;
  return {
    left: Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(top, viewport.height - height - margin)),
    width,
    height,
  };
}
