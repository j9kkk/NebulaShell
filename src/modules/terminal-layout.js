// Pure geometry shared by capacity checks, automatic reflow and divider bounds.
export const MIN_PANE_WIDTH = 320;
export const MIN_PANE_HEIGHT = 180;
export const DIVIDER_SIZE = 5;

export function paneCapacity(width, height) {
  // One existing pane remains usable by scrolling, but neither axis may borrow
  // its minimum from the other: an undersized area cannot fit an added pane.
  if (width < MIN_PANE_WIDTH || height < MIN_PANE_HEIGHT) return 1;
  const cols = Math.max(1, Math.floor((Math.max(0, width) + DIVIDER_SIZE) / (MIN_PANE_WIDTH + DIVIDER_SIZE)));
  const rows = Math.max(1, Math.floor((Math.max(0, height) + DIVIDER_SIZE) / (MIN_PANE_HEIGHT + DIVIDER_SIZE)));
  return cols * rows;
}

function leafMinSize(minimum) {
  const dimension = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    width: dimension(minimum?.width, MIN_PANE_WIDTH),
    height: dimension(minimum?.height, MIN_PANE_HEIGHT),
  };
}

// The resolver receives a leaf node, not its ID: tab leaves can resolve their
// minimum from a nested pane layout without changing either tree's shape.
export function layoutMinSize(node, leafMinimum) {
  if (!node) return { width: 0, height: 0 };
  if (node.type === 'leaf') return leafMinSize(leafMinimum?.(node));
  const a = layoutMinSize(node.a, leafMinimum), b = layoutMinSize(node.b, leafMinimum);
  return node.type === 'h'
    ? { width: a.width + b.width + DIVIDER_SIZE, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + DIVIDER_SIZE };
}

// Equal shares where possible; pin larger minima before sharing the remainder.
// An undersized container gets minimum-sized fallback cells, never negative ones.
function allocate(minima, span) {
  const total = minima.reduce((sum, minimum) => sum + minimum, 0);
  let remaining = Math.max(total, span - (minima.length - 1) * DIVIDER_SIZE);
  const cells = new Array(minima.length);
  let pending = minima.map((_, index) => index);
  while (pending.length) {
    const share = remaining / pending.length;
    const pinned = pending.filter((index) => minima[index] > share);
    if (!pinned.length) {
      for (const index of pending) cells[index] = share;
      break;
    }
    for (const index of pinned) { cells[index] = minima[index]; remaining -= minima[index]; }
    pending = pending.filter((index) => cells[index] === undefined);
  }
  return cells;
}

function join(nodes, axis, cells) {
  let node = nodes[0], span = cells[0];
  for (let i = 1; i < nodes.length; i++) {
    const available = span + cells[i];
    node = { type: axis, ratio: available > 0 ? span / available : i / (i + 1), a: node, b: nodes[i] };
    span = available + DIVIDER_SIZE;
  }
  return node;
}

function bandGeometry(minima, sizes, primary, cross) {
  let cursor = 0;
  const groups = sizes.map((count) => minima.slice(cursor, cursor += count));
  const primaryMinimum = Math.max(...groups.map((group) =>
    group.reduce((sum, minimum) => sum + minimum[primary], 0) + (group.length - 1) * DIVIDER_SIZE));
  const crossMinima = groups.map((group) => Math.max(...group.map((minimum) => minimum[cross])));
  const crossMinimum = crossMinima.reduce((sum, minimum) => sum + minimum, 0) + (sizes.length - 1) * DIVIDER_SIZE;
  return { groups, primaryMinimum, crossMinima, crossMinimum };
}

// Heterogeneous tabs may need an earlier ragged band (wide tab, then two small
// tabs), or unequal band counts. Find contiguous, stable-order partitions with
// the smallest cross-axis minimum for each band count; do not reorder leaves.
function fittingBandSizes(minima, primary, cross, primarySpan, crossSpan) {
  const costs = Array.from({ length: minima.length + 1 }, () => new Array(minima.length + 1).fill(Infinity));
  const starts = costs.map(() => []);
  costs[0][0] = 0;
  for (let bands = 1; bands <= minima.length; bands++) {
    for (let end = bands; end <= minima.length; end++) {
      let length = 0, breadth = 0;
      for (let start = end - 1; start >= bands - 1; start--) {
        length += minima[start][primary] + (start < end - 1 ? DIVIDER_SIZE : 0);
        breadth = Math.max(breadth, minima[start][cross]);
        if (length > primarySpan) break;
        const cost = costs[bands - 1][start] + breadth + (bands > 1 ? DIVIDER_SIZE : 0);
        if (cost < costs[bands][end]) { costs[bands][end] = cost; starts[bands][end] = start; }
      }
    }
  }
  return costs.map((row, bands) => {
    if (!bands || row[minima.length] > crossSpan) return null;
    const sizes = [];
    let end = minima.length;
    for (let count = bands; count > 0; count--) {
      const start = starts[count][end];
      sizes.unshift(end - start); end = start;
    }
    return sizes;
  });
}

// Ragged bands contain only real leaves; no placeholders. Stable ID order.
// Planner minimum callbacks receive IDs; leaf factories run only for the winner.
export function planGrid(paneIds, width, height, dir = 'h', options = {}) {
  const ids = [...paneIds];
  if (!ids.length) return { layout: null, rows: 0, cols: 0, capacity: paneCapacity(width, height), fits: true };
  width = Math.max(1, Number.isFinite(Number(width)) ? Number(width) : MIN_PANE_WIDTH);
  height = Math.max(1, Number.isFinite(Number(height)) ? Number(height) : MIN_PANE_HEIGHT);
  const minima = ids.map((id) => leafMinSize(options.minimum?.(id)));
  const heterogeneous = minima.some((minimum) => minimum.width !== minima[0].width || minimum.height !== minima[0].height);
  let best;
  for (const axis of ['h', 'v']) {
    const primary = axis === 'h' ? 'width' : 'height', cross = axis === 'h' ? 'height' : 'width';
    const primarySpan = axis === 'h' ? width : height, crossSpan = axis === 'h' ? height : width;
    let fittedSizes;
    for (let bands = 1; bands <= ids.length; bands++) {
      let sizes = [];
      let left = ids.length;
      for (let i = 0; i < bands; i++) {
        const take = Math.ceil(left / (bands - i));
        sizes.push(take); left -= take;
      }
      let geometry = bandGeometry(minima, sizes, primary, cross);
      let fits = geometry.primaryMinimum <= primarySpan && geometry.crossMinimum <= crossSpan;
      if (!fits && heterogeneous) {
        fittedSizes ??= fittingBandSizes(minima, primary, cross, primarySpan, crossSpan);
        if (fittedSizes[bands]) {
          sizes = fittedSizes[bands];
          geometry = bandGeometry(minima, sizes, primary, cross);
          fits = true;
        }
      }
      const { groups, primaryMinimum, crossMinima } = geometry;
      const bandSpan = (crossSpan - (bands - 1) * DIVIDER_SIZE) / bands;
      let score = 0;
      for (const group of groups) {
        const itemSpan = ((axis === 'h' ? width : height) - (group.length - 1) * DIVIDER_SIZE) / group.length;
        const w = axis === 'h' ? itemSpan : bandSpan, h = axis === 'h' ? bandSpan : itemSpan;
        for (const minimum of group) {
          const mw = Math.max(1, minimum.width), mh = Math.max(1, minimum.height);
          const overflow = Math.max(0, minimum.width - w) / mw + Math.max(0, minimum.height - h) / mh;
          score += overflow * 1000 + Math.abs(Math.log(Math.max(0.001, w / h) / (mw / mh)));
        }
      }
      score /= ids.length;
      // Direction only breaks geometry ties; it cannot force an unusable split.
      score += (axis === dir ? 0 : 1e-7) + bands * 1e-9;
      if (!best || (fits && !best.fits) || fits === best.fits && score < best.score) {
        best = { axis, bands, sizes, groups, primaryMinimum, crossMinima, score, fits };
      }
    }
  }
  const primary = best.axis === 'h' ? 'width' : 'height';
  const primarySpan = Math.max(best.primaryMinimum, best.axis === 'h' ? width : height);
  const crossCells = allocate(best.crossMinima, best.axis === 'h' ? height : width);
  const makeLeaf = options.leaf || ((paneId) => ({ type: 'leaf', paneId }));
  let cursor = 0;
  const bands = best.sizes.map((count, index) => {
    const leaves = ids.slice(cursor, cursor += count).map((id) => makeLeaf(id));
    return join(leaves, best.axis, allocate(best.groups[index].map((minimum) => minimum[primary]), primarySpan));
  });
  return {
    layout: join(bands, best.axis === 'h' ? 'v' : 'h', crossCells),
    rows: best.axis === 'h' ? best.bands : Math.max(...best.sizes),
    cols: best.axis === 'h' ? Math.max(...best.sizes) : best.bands,
    capacity: paneCapacity(width, height), fits: best.fits,
  };
}
