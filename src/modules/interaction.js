export function isAppModifier(event, platform) {
  return platform === 'darwin'
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isEditableTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
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
