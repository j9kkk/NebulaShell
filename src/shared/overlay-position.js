/// 纯函数锚定定位算法（零 DOM 依赖，供全站 Popover / 菜单 / 帮助浮层共用）。
///
/// placement: 'bottom' | 'top' | 'left' | 'right'（优先落位方向）
/// align:     'start' | 'end' | 'center'（沿交叉轴对齐方式）
/// gap:       锚点与浮层之间的像素缝隙
/// margin:    距视口四边的最小安全留白
/// flip:      空间不足时是否自动翻转到对侧（默认 true）
export function computeAnchorPosition(anchor, size, viewport, opts = {}) {
  const {
    placement = 'bottom',
    align = 'start',
    gap = 6,
    margin = 8,
    flip = true,
  } = opts;

  const vw = Math.max(0, Number(viewport?.width) || 1280);
  const vh = Math.max(0, Number(viewport?.height) || 800);
  const width = Math.max(0, Math.min(Number(size?.width) || 0, Math.max(0, vw - margin * 2)));
  const height = Math.max(0, Math.min(Number(size?.height) || 0, Math.max(0, vh - margin * 2)));

  const aLeft = Number(anchor?.left) || 0;
  const aRight = Number(anchor?.right ?? aLeft) || 0;
  const aTop = Number(anchor?.top) || 0;
  const aBottom = Number(anchor?.bottom ?? aTop) || 0;

  const spaceBelow = vh - aBottom - gap - margin;
  const spaceAbove = aTop - gap - margin;
  const spaceRight = vw - aRight - gap - margin;
  const spaceLeft = aLeft - gap - margin;

  let resolved = placement;
  if (flip) {
    if (placement === 'bottom' && height > spaceBelow && spaceAbove > spaceBelow) resolved = 'top';
    else if (placement === 'top' && height > spaceAbove && spaceBelow > spaceAbove) resolved = 'bottom';
    else if (placement === 'left' && width > spaceLeft && spaceRight > spaceLeft) resolved = 'right';
    else if (placement === 'right' && width > spaceRight && spaceLeft > spaceRight) resolved = 'left';
  }

  let left;
  let top;

  if (resolved === 'top' || resolved === 'bottom') {
    top = resolved === 'bottom' ? aBottom + gap : aTop - height - gap;
    if (align === 'end') left = aRight - width;
    else if (align === 'center') left = aLeft + (aRight - aLeft - width) / 2;
    else left = aLeft;
  } else {
    left = resolved === 'right' ? aRight + gap : aLeft - width - gap;
    if (align === 'end') top = aBottom - height;
    else if (align === 'center') top = aTop + (aBottom - aTop - height) / 2;
    else top = aTop;
  }

  const maxLeft = Math.max(margin, vw - width - margin);
  const maxTop = Math.max(margin, vh - height - margin);

  return {
    left: Math.round(Math.max(margin, Math.min(left, maxLeft))),
    top: Math.round(Math.max(margin, Math.min(top, maxTop))),
    width,
    height,
    placement: resolved,
  };
}
