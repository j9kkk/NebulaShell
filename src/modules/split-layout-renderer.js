import { DIVIDER_SIZE, layoutMinSize } from './terminal-layout.js';

// Shared pane/tab tree rendering. Leaf DOM ownership and divider interactions
// stay with the caller; minimum resolves leaf nodes just like layoutMinSize.
export function renderSplitTree(node, { document, leaf, minimum, divider, nodeClass = 'split-node' }) {
  if (!node) return null;
  const render = (current) => {
    const size = layoutMinSize(current, minimum);
    if (current.type === 'leaf') {
      const element = leaf(current);
      // Reused DOM may have been a child in a previous split. In particular a
      // collapsed single leaf must not retain its previous fractional basis.
      element.style.flex = '';
      element.style.boxSizing = 'border-box';
      element.style.minWidth = `${size.width}px`;
      element.style.minHeight = `${size.height}px`;
      return element;
    }
    const wrap = document.createElement('div');
    wrap.className = `${nodeClass} ${current.type === 'v' ? 'v' : 'h'}`;
    wrap.style.display = 'flex';
    wrap.style.flexDirection = current.type === 'v' ? 'column' : 'row';
    wrap.style.boxSizing = 'border-box';
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.minWidth = `${size.width}px`;
    wrap.style.minHeight = `${size.height}px`;
    const a = render(current.a), b = render(current.b);
    const div = document.createElement('div');
    div.className = 'split-divider';
    div.style.boxSizing = 'border-box';
    div.style.flex = `0 0 ${DIVIDER_SIZE}px`;
    // A definite border-box basis excludes leaf padding from flex free-space
    // allocation. Both branches together occupy exactly span - divider pixels.
    a.style.flex = `0 0 calc(${current.ratio * 100}% - ${current.ratio * DIVIDER_SIZE}px)`;
    b.style.flex = `0 0 calc(${(1 - current.ratio) * 100}% - ${(1 - current.ratio) * DIVIDER_SIZE}px)`;
    wrap.appendChild(a); wrap.appendChild(div); wrap.appendChild(b);
    divider?.(div, current, a, b, wrap);
    return wrap;
  };
  return render(node);
}

// WebKit can retain the old tree's scrollbar gutter at exact minimum sizes.
// Build under hidden overflow and flush the finished tree before restoring it.
// build() may return null (empty layout), or append its own additional content.
export function replaceLayoutContent(container, build) {
  const overflow = container.style.overflow;
  const priority = container.style.getPropertyPriority?.('overflow') || '';
  container.style.overflow = 'hidden';
  try {
    container.replaceChildren();
    const content = build();
    if (content) container.appendChild(content);
    void container.offsetWidth;
    return content;
  } finally {
    if (priority) container.style.setProperty('overflow', overflow, priority);
    else container.style.overflow = overflow;
  }
}
