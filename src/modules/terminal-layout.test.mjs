import test from 'node:test';
import assert from 'node:assert/strict';
import { DIVIDER_SIZE, layoutMinSize, paneCapacity, planGrid } from './terminal-layout.js';

function boxes(node, width, height, out = []) {
  if (!node) return out;
  if (node.type === 'leaf') { out.push({ id: node.paneId ?? node.tabId, width, height }); return out; }
  const span = (node.type === 'h' ? width : height) - DIVIDER_SIZE;
  if (node.type === 'h') {
    boxes(node.a, span * node.ratio, height, out);
    boxes(node.b, span * (1 - node.ratio), height, out);
  } else {
    boxes(node.a, width, span * node.ratio, out);
    boxes(node.b, width, span * (1 - node.ratio), out);
  }
  return out;
}
const ids = (n) => Array.from({ length: n }, (_, i) => `pane-${i}`);

test('wide-short dimensions override vertical preference', () => {
  const plan = planGrid(ids(4), 1300, 180, 'v');
  assert.equal(plan.rows, 1);
  assert.equal(plan.cols, 4);
  assert.equal(plan.fits, true);
});

test('tall-narrow dimensions override horizontal preference', () => {
  const plan = planGrid(ids(4), 320, 735, 'h');
  assert.equal(plan.rows, 4);
  assert.equal(plan.cols, 1);
  assert.equal(plan.fits, true);
});

test('capacity counts divider pixels and keeps a single undersized pane usable', () => {
  assert.equal(paneCapacity(640, 360), 1);
  assert.equal(paneCapacity(645, 365), 4);
  assert.equal(paneCapacity(1300, 180), 4);
  assert.equal(paneCapacity(0, 0), 1);
});

test('an undersized axis forbids added panes even when the other axis has room', () => {
  for (const [width, height] of [[316, 550], [319, 920], [970, 179], [1950, 0]]) {
    assert.equal(paneCapacity(width, height), 1, `${width}×${height}`);
    const plan = planGrid(ids(3), width, height);
    assert.equal(plan.capacity, 1);
    assert.equal(plan.fits, false);
    assert.deepEqual(boxes(plan.layout, width, height).map((b) => b.id), ids(3));
  }
  assert.equal(paneCapacity(320, 550), 3);
  assert.equal(paneCapacity(970, 180), 3);
});

test('exact three-pane axis boundaries use every pixel without geometric overflow', () => {
  for (const [width, height, rows, cols] of [[970, 180, 1, 3], [320, 550, 3, 1]]) {
    const plan = planGrid(ids(3), width, height);
    assert.equal(plan.fits, true);
    assert.equal(plan.rows, rows);
    assert.equal(plan.cols, cols);
    assert.deepEqual(layoutMinSize(plan.layout), { width, height });
    for (const box of boxes(plan.layout, width, height)) {
      assert.ok(Math.abs(box.width - 320) < 1e-8);
      assert.ok(Math.abs(box.height - 180) < 1e-8);
    }
  }
});

test('close to one leaf uses the complete container without a split', () => {
  const plan = planGrid(['survivor'], 1500, 800);
  assert.deepEqual(plan.layout, { type: 'leaf', paneId: 'survivor' });
  assert.deepEqual(boxes(plan.layout, 1500, 800), [{ id: 'survivor', width: 1500, height: 800 }]);
});

test('ragged grids preserve real pane order, never dummy panes', () => {
  for (const count of [3, 5, 7, 11]) {
    const plan = planGrid(ids(count), 1950, 1105);
    assert.deepEqual(boxes(plan.layout, 1950, 1105).map((b) => b.id), ids(count));
    assert.deepEqual(plan, planGrid(ids(count), 1950, 1105));
  }
});

test('every count through capacity fits actual recursively divided rectangles', () => {
  for (const [width, height] of [[645, 365], [1300, 555], [320, 920], [1960, 365], [1300, 1105]]) {
    for (let count = 1; count <= paneCapacity(width, height); count++) {
      const plan = planGrid(ids(count), width, height);
      assert.equal(plan.fits, true, `${width}×${height}, n=${count}`);
      for (const box of boxes(plan.layout, width, height)) {
        assert.ok(box.width >= 320 - 1e-8 && box.height >= 180 - 1e-8, JSON.stringify(box));
      }
      const minimum = layoutMinSize(plan.layout);
      assert.ok(minimum.width <= width && minimum.height <= height);
    }
  }
});

test('nine-pane grids retain equal within-band widths and divider-aware allocation', () => {
  for (const [width, height, rows, cols] of [[2920, 180, 1, 9], [970, 550, 3, 3], [1300, 735, 3, 3]]) {
    const plan = planGrid(ids(9), width, height);
    assert.equal(plan.fits, true);
    assert.equal(plan.rows, rows); assert.equal(plan.cols, cols);
    const actual = boxes(plan.layout, width, height);
    assert.deepEqual(actual.map((box) => box.id), ids(9));
    const cellWidth = (width - (cols - 1) * DIVIDER_SIZE) / cols;
    const cellHeight = (height - (rows - 1) * DIVIDER_SIZE) / rows;
    for (const box of actual) {
      assert.ok(Math.abs(box.width - cellWidth) < 1e-8);
      assert.ok(Math.abs(box.height - cellHeight) < 1e-8);
    }
  }
});

test('shrinking below existing capacity retains all actual panes and reports overflow', () => {
  const plan = planGrid(ids(4), 320, 180);
  assert.equal(plan.capacity, 1);
  assert.equal(plan.fits, false);
  assert.equal(boxes(plan.layout, 320, 180).length, 4);
});

test('empty layout is null, not a dummy pane', () => {
  assert.equal(planGrid([], 1000, 1000).layout, null);
  assert.deepEqual(layoutMinSize(null), { width: 0, height: 0 });
});

const tabLeaf = (tabId) => ({ type: 'leaf', tabId });
function assertMinimumBoxes(plan, width, height, minimum) {
  const leafMinimum = (node) => minimum(node.paneId ?? node.tabId);
  const size = layoutMinSize(plan.layout, leafMinimum);
  // Overflow plans are laid out in their minimum-sized scrollable rectangle.
  const actual = boxes(plan.layout, Math.max(width, size.width), Math.max(height, size.height));
  for (const box of actual) {
    const required = minimum(box.id);
    assert.ok(box.width >= required.width - 1e-8, JSON.stringify(box));
    assert.ok(box.height >= required.height - 1e-8, JSON.stringify(box));
  }
  return actual;
}

test('custom tab leaf factories retain identity and stable IDs, called once per real leaf', () => {
  const tabIds = ['tab-z', 'tab-a', 'tab-m', 'tab-b', 'tab-q'];
  const leaves = new Map(tabIds.map((id) => [id, tabLeaf(id)]));
  const built = [], measured = [];
  const plan = planGrid(tabIds, 1300, 555, 'h', {
    leaf: (id) => { built.push(id); return leaves.get(id); },
    minimum: (id) => { measured.push(id); return { width: 320, height: 180 }; },
  });
  assert.deepEqual(built, tabIds);
  assert.deepEqual(measured, tabIds);
  assert.deepEqual(boxes(plan.layout, 1300, 555).map((box) => box.id), tabIds);
  const visit = (node) => {
    if (node.type === 'leaf') assert.equal(node, leaves.get(node.tabId));
    else { visit(node.a); visit(node.b); }
  };
  visit(plan.layout);
  assert.equal(plan.fits, true);
});

test('layout minimum resolver receives leaf nodes and composes nested tab minima', () => {
  const panes = {
    wide: { type: 'h', ratio: 0.5, a: { type: 'leaf', paneId: 'p1' }, b: { type: 'leaf', paneId: 'p2' } },
    tall: { type: 'v', ratio: 0.5, a: { type: 'leaf', paneId: 'p3' }, b: { type: 'leaf', paneId: 'p4' } },
  };
  const a = tabLeaf('wide'), b = tabLeaf('tall');
  const tree = { type: 'h', ratio: 0.5, a, b };
  const seen = [];
  assert.deepEqual(layoutMinSize(tree, (node) => {
    seen.push(node); return layoutMinSize(panes[node.tabId]);
  }), { width: 970, height: 365 });
  assert.deepEqual(seen, [a, b]);
  assert.deepEqual(layoutMinSize(tree), { width: 645, height: 180 });
  const plan = planGrid(['wide', 'tall'], 970, 365, 'h', {
    leaf: tabLeaf, minimum: (id) => layoutMinSize(panes[id]),
  });
  assert.equal(plan.fits, true);
  assertMinimumBoxes(plan, 970, 365, (id) => layoutMinSize(panes[id]));
});

test('heterogeneous exact boundaries fit when equal shares would undersize a leaf', () => {
  for (const [width, height, dir, minima] of [
    [970, 180, 'v', [{ width: 645, height: 180 }, { width: 320, height: 180 }]],
    [320, 550, 'h', [{ width: 320, height: 365 }, { width: 320, height: 180 }]],
  ]) {
    const tabIds = ['large', 'small'], minimum = (id) => minima[tabIds.indexOf(id)];
    const plan = planGrid(tabIds, width, height, dir, { leaf: tabLeaf, minimum });
    assert.equal(plan.fits, true);
    assert.equal(plan.capacity, paneCapacity(width, height));
    const actual = assertMinimumBoxes(plan, width, height, minimum);
    for (let i = 0; i < actual.length; i++) {
      assert.ok(Math.abs(actual[i].width - minima[i].width) < 1e-8);
      assert.ok(Math.abs(actual[i].height - minima[i].height) < 1e-8);
    }
    assert.deepEqual(layoutMinSize(plan.layout, (node) => minimum(node.tabId)), { width, height });
  }
});

test('heterogeneous leaves receive equal within-band shares when those shares fit', () => {
  for (const [width, height, minima] of [
    [1400, 180, [{ width: 645, height: 180 }, { width: 320, height: 180 }]],
    [320, 800, [{ width: 320, height: 365 }, { width: 320, height: 180 }]],
  ]) {
    const tabIds = ['large', 'small'], minimum = (id) => minima[tabIds.indexOf(id)];
    const plan = planGrid(tabIds, width, height, 'h', { leaf: tabLeaf, minimum });
    assert.equal(plan.fits, true);
    const actual = assertMinimumBoxes(plan, width, height, minimum);
    assert.ok(Math.abs(actual[0].width - actual[1].width) < 1e-8);
    assert.ok(Math.abs(actual[0].height - actual[1].height) < 1e-8);
  }
});

test('different band minima fit exact outer-axis boundaries without sacrificing equal inner cells', () => {
  for (const transpose of [false, true]) {
    const tabIds = ['a', 'b', 'c', 'd'];
    const minimum = (id) => {
      const cross = tabIds.indexOf(id) < 2 ? 365 : 180;
      return transpose ? { width: cross, height: 320 } : { width: 320, height: cross };
    };
    const width = transpose ? 550 : 645, height = transpose ? 645 : 550;
    const plan = planGrid(tabIds, width, height, transpose ? 'h' : 'v', { leaf: tabLeaf, minimum });
    assert.equal(plan.fits, true);
    assert.equal(plan.rows, 2); assert.equal(plan.cols, 2);
    const actual = assertMinimumBoxes(plan, width, height, minimum);
    assert.deepEqual(actual.map((box) => box.id), tabIds);
    for (const box of actual) {
      const equalAxis = transpose ? box.height : box.width;
      assert.ok(Math.abs(equalAxis - 320) < 1e-8);
    }
  }
});

test('heterogeneous tabs can fit an earlier ragged band or unequal band counts without reordering', () => {
  for (const smallCount of [2, 4]) {
    for (const transpose of [false, true]) {
      const tabIds = ['wide', ...Array.from({ length: smallCount }, (_, i) => `small-${i}`)];
      const bandSpan = smallCount * 320 + (smallCount - 1) * DIVIDER_SIZE;
      const minimum = (id) => {
        const primary = id === 'wide' ? bandSpan : 320;
        return transpose ? { width: 180, height: primary } : { width: primary, height: 180 };
      };
      const width = transpose ? 365 : bandSpan, height = transpose ? bandSpan : 365;
      const plan = planGrid(tabIds, width, height, transpose ? 'h' : 'v', { leaf: tabLeaf, minimum });
      assert.equal(plan.fits, true);
      assert.equal(plan.rows, transpose ? smallCount : 2);
      assert.equal(plan.cols, transpose ? 2 : smallCount);
      const actual = assertMinimumBoxes(plan, width, height, minimum);
      assert.deepEqual(actual.map((box) => box.id), tabIds);
      for (const box of actual.slice(1)) {
        closeDimension(transpose ? box.height : box.width, 320);
      }
    }
  }
});

function closeDimension(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test('heterogeneous overflow retains every tab and uses finite minimum-sized fallback geometry', () => {
  const minimum = (id) => ({ width: 320 + Number(id.slice(4)) * 75, height: 180 + Number(id.slice(4)) % 3 * 185 });
  for (const count of [1, 2, 5, 11]) {
    const tabIds = Array.from({ length: count }, (_, i) => `tab-${i}`);
    for (const [width, height] of [[1, 1], [320, 179], [1000, 180], [640, 365]]) {
      const plan = planGrid(tabIds, width, height, 'v', { leaf: tabLeaf, minimum });
      const actual = assertMinimumBoxes(plan, width, height, minimum);
      assert.deepEqual(actual.map((box) => box.id), tabIds);
      assert.equal(plan.capacity, paneCapacity(width, height));
      if (width === 1 || height === 179) assert.equal(plan.fits, false);
      const visit = (node) => {
        if (node.type === 'leaf') return;
        assert.ok(Number.isFinite(node.ratio) && node.ratio >= 0 && node.ratio <= 1);
        visit(node.a); visit(node.b);
      };
      visit(plan.layout);
      assert.deepEqual(plan, planGrid(tabIds, width, height, 'v', { leaf: tabLeaf, minimum }));
    }
  }
});

test('missing or invalid minimum dimensions fall back independently to existing pane minima', () => {
  const node = tabLeaf('a');
  assert.deepEqual(layoutMinSize(node, () => undefined), { width: 320, height: 180 });
  assert.deepEqual(layoutMinSize(node, () => ({ width: 645 })), { width: 645, height: 180 });
  assert.deepEqual(layoutMinSize(node, () => ({ width: NaN, height: -1 })), { width: 320, height: 180 });
  assert.deepEqual(layoutMinSize(node, () => ({ width: Infinity, height: 365 })), { width: 320, height: 365 });
  assert.deepEqual(layoutMinSize(node, () => ({ width: 0, height: 0 })), { width: 0, height: 0 });
  const plan = planGrid(['a', 'b'], 645, 180, 'h', { leaf: tabLeaf, minimum: () => ({ width: NaN }) });
  assert.equal(plan.fits, true);
  assert.deepEqual(layoutMinSize(plan.layout), { width: 645, height: 180 });
});

test('empty custom plans do not invoke factories or minimum resolvers', () => {
  const unexpected = () => assert.fail('no leaf callback should run');
  assert.deepEqual(planGrid([], 1, 1, 'v', { leaf: unexpected, minimum: unexpected }), {
    layout: null, rows: 0, cols: 0, capacity: 1, fits: true,
  });
  assert.deepEqual(layoutMinSize(null, unexpected), { width: 0, height: 0 });
});
