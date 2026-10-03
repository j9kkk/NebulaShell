import test from 'node:test';
import assert from 'node:assert/strict';
import { DIVIDER_SIZE, layoutMinSize, planGrid } from './terminal-layout.js';
import { renderSplitTree, replaceLayoutContent } from './split-layout-renderer.js';

// Small DOM adapter plus a definite-basis flex geometry fixture. This is not a
// browser emulator: it checks padding/border inclusion, minima and split spans
// directly, so changing back to indefinite flex bases cannot silently pass.
class Element {
  constructor() {
    this.style = { flex: '', overflow: '', boxSizing: 'content-box' };
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.padding = { width: 0, height: 0 };
    this.border = { width: 0, height: 0 };
    this.onFlush = () => {};
  }
  appendChild(child) {
    if (child.parentElement) {
      const siblings = child.parentElement.children;
      siblings.splice(siblings.indexOf(child), 1);
    }
    this.children.push(child); child.parentElement = this;
    return child;
  }
  replaceChildren() {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  get offsetWidth() { this.onFlush(); return 1000; }
  addEventListener() { assert.fail('the shared renderer must not install dragging'); }
}
const document = { createElement: () => new Element() };
const leaf = (paneId) => ({ type: 'leaf', paneId });
const tabLeaf = (tabId) => ({ type: 'leaf', tabId });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const pixels = (value) => value ? Number.parseFloat(value) : 0;

function paddedLeaf(node) {
  const element = new Element();
  element.id = node.paneId ?? node.tabId;
  element.style.flex = '0.25 1 0';
  element.padding = { width: 10, height: 8 };
  element.border = { width: 2, height: 2 };
  return element;
}
function basis(element, span, axis) {
  const match = /^0 0 calc\(([\d.e+-]+)% - ([\d.e+-]+)px\)$/.exec(element.style.flex);
  assert.ok(match, `expected definite, non-growing border-box basis: ${element.style.flex}`);
  const borderBox = span * Number(match[1]) / 100 - Number(match[2]);
  const extras = element.style.boxSizing === 'border-box' ? 0 : element.padding[axis] + element.border[axis];
  return Math.max(borderBox + extras, pixels(axis === 'width' ? element.style.minWidth : element.style.minHeight));
}
function rectangles(element, width, height, x = 0, y = 0, out = []) {
  width = Math.max(width, pixels(element.style.minWidth));
  height = Math.max(height, pixels(element.style.minHeight));
  if (!element.children.length) {
    out.push({ id: element.id, x, y, width, height,
      contentWidth: width - element.padding.width - element.border.width,
      contentHeight: height - element.padding.height - element.border.height });
    return out;
  }
  const [a, divider, b] = element.children;
  assert.equal(element.children.length, 3);
  assert.equal(divider.style.flex, `0 0 ${DIVIDER_SIZE}px`);
  const vertical = element.style.flexDirection === 'column';
  const axis = vertical ? 'height' : 'width', span = vertical ? height : width;
  const aspan = basis(a, span, axis), bspan = basis(b, span, axis);
  close(aspan + DIVIDER_SIZE + bspan, span);
  if (vertical) {
    rectangles(a, width, aspan, x, y, out);
    rectangles(b, width, bspan, x, y + aspan + DIVIDER_SIZE, out);
  } else {
    rectangles(a, aspan, height, x, y, out);
    rectangles(b, bspan, height, x + aspan + DIVIDER_SIZE, y, out);
  }
  return out;
}
function expectedRectangles(node, width, height, x = 0, y = 0, out = []) {
  if (node.type === 'leaf') { out.push({ id: node.paneId ?? node.tabId, x, y, width, height }); return out; }
  const vertical = node.type === 'v', span = (vertical ? height : width) - DIVIDER_SIZE;
  if (vertical) {
    expectedRectangles(node.a, width, span * node.ratio, x, y, out);
    expectedRectangles(node.b, width, span * (1 - node.ratio), x, y + span * node.ratio + DIVIDER_SIZE, out);
  } else {
    expectedRectangles(node.a, span * node.ratio, height, x, y, out);
    expectedRectangles(node.b, span * (1 - node.ratio), height, x + span * node.ratio + DIVIDER_SIZE, y, out);
  }
  return out;
}
function assertGeometry(rendered, tree, width, height) {
  const actual = rectangles(rendered, width, height), expected = expectedRectangles(tree, width, height);
  assert.deepEqual(actual.map((box) => box.id), expected.map((box) => box.id));
  for (let i = 0; i < actual.length; i++) {
    for (const dimension of ['x', 'y', 'width', 'height']) close(actual[i][dimension], expected[i][dimension]);
    close(actual[i].contentWidth, actual[i].width - 12);
    close(actual[i].contentHeight, actual[i].height - 10);
  }
  return actual;
}

test('null tree returns null without creating placeholders or calling leaf resolver', () => {
  const unexpected = () => assert.fail('empty render callback');
  assert.equal(renderSplitTree(null, { document: { createElement: unexpected }, leaf: unexpected, minimum: unexpected }), null);
});

test('single reused leaf resets fractional inline flex and preserves caller DOM', () => {
  const node = tabLeaf('tab-a'), element = paddedLeaf(node);
  element.className = 'tab-tile';
  const existing = new Element(); element.appendChild(existing);
  const rendered = renderSplitTree(node, {
    document, leaf: (received) => { assert.equal(received, node); return element; },
    minimum: (received) => { assert.equal(received, node); return { width: 647, height: 210 }; },
  });
  assert.equal(rendered, element);
  assert.equal(element.style.flex, '');
  assert.equal(element.style.boxSizing, 'border-box');
  assert.equal(element.style.minWidth, '647px');
  assert.equal(element.style.minHeight, '210px');
  assert.equal(element.className, 'tab-tile');
  assert.deepEqual(element.children, [existing]);
});

test('nested splits set classes, composed minima and definite bases before divider callback', () => {
  const a = tabLeaf('a'), b = tabLeaf('b'), c = tabLeaf('c');
  const inner = { type: 'v', ratio: 0.6, a, b };
  const tree = { type: 'h', ratio: 0.7, a: inner, b: c };
  const sizes = { a: { width: 647, height: 210 }, b: { width: 322, height: 395 }, c: { width: 322, height: 210 } };
  const calls = [];
  const rendered = renderSplitTree(tree, {
    document, leaf: paddedLeaf, minimum: (node) => sizes[node.tabId], nodeClass: 'workspace-split',
    divider: (div, node, first, second, wrap) => {
      assert.deepEqual(wrap.children, [first, div, second]);
      assert.equal(first.parentElement, wrap); assert.equal(second.parentElement, wrap);
      assert.match(first.style.flex, /^0 0 calc\(/); assert.match(second.style.flex, /^0 0 calc\(/);
      assert.equal(div.className, 'split-divider');
      calls.push(node);
    },
  });
  assert.deepEqual(calls, [inner, tree]);
  assert.equal(rendered.className, 'workspace-split h');
  assert.equal(rendered.children[0].className, 'workspace-split v');
  assert.equal(rendered.style.display, 'flex');
  assert.equal(rendered.style.flexDirection, 'row');
  assert.equal(rendered.children[0].style.flexDirection, 'column');
  assert.equal(rendered.style.minWidth, '974px');
  assert.equal(rendered.style.minHeight, '610px');
  assert.equal(rendered.children[0].style.minWidth, '647px');
  assert.equal(rendered.children[0].style.minHeight, '610px');
  assert.equal(rendered.children[0].style.flex, '0 0 calc(70% - 3.5px)');
});

test('padded leaf geometry equals planner rectangles at exact and roomy pane boundaries', () => {
  for (const [count, width, height] of [[3, 970, 180], [3, 320, 550], [4, 645, 365], [4, 1300, 180], [7, 1950, 1105]]) {
    const ids = Array.from({ length: count }, (_, index) => `pane-${index}`);
    const plan = planGrid(ids, width, height);
    assert.equal(plan.fits, true);
    const rendered = renderSplitTree(plan.layout, { document, leaf: paddedLeaf });
    if (count > 1) assert.match(rendered.className, /^split-node [hv]$/);
    const actual = assertGeometry(rendered, plan.layout, width, height);
    assert.equal(actual.length, count);
    for (const box of actual) {
      assert.ok(box.width >= 320 - 1e-8); assert.ok(box.height >= 180 - 1e-8);
    }
  }
});

test('nine padded panes preserve equal widths and definite divider-aware border-box bases', () => {
  for (const [width, height] of [[2920, 180], [970, 550], [1300, 735]]) {
    const ids = Array.from({ length: 9 }, (_, index) => `pane-${index}`);
    const plan = planGrid(ids, width, height);
    assert.equal(plan.fits, true);
    const rendered = renderSplitTree(plan.layout, { document, leaf: paddedLeaf });
    const actual = assertGeometry(rendered, plan.layout, width, height);
    assert.equal(actual.length, 9);
    const cellWidth = (width - (plan.cols - 1) * DIVIDER_SIZE) / plan.cols;
    for (const box of actual) close(box.width, cellWidth);
    const checkBases = (element, node) => {
      if (node.type === 'leaf') { assert.equal(element.style.boxSizing, 'border-box'); return; }
      const [a, divider, b] = element.children;
      assert.equal(a.style.flex, `0 0 calc(${node.ratio * 100}% - ${node.ratio * DIVIDER_SIZE}px)`);
      assert.equal(b.style.flex, `0 0 calc(${(1 - node.ratio) * 100}% - ${(1 - node.ratio) * DIVIDER_SIZE}px)`);
      assert.equal(divider.style.flex, `0 0 ${DIVIDER_SIZE}px`);
      checkBases(a, node.a); checkBases(b, node.b);
    };
    checkBases(rendered, plan.layout);
  }
});

test('geometry fixture detects missing border-box sizing and indefinite flex regression', () => {
  const tree = { type: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') };
  const rendered = renderSplitTree(tree, { document, leaf: paddedLeaf });
  assertGeometry(rendered, tree, 1300, 400);
  const a = rendered.children[0], correct = a.style.flex;
  a.style.flex = '0.5 1 0';
  assert.throws(() => rectangles(rendered, 1300, 400), /expected definite/);
  a.style.flex = correct; a.style.boxSizing = 'content-box';
  assert.throws(() => rectangles(rendered, 1300, 400), /!=/);
});

test('tab tiles include subtree minimum plus header28 and border2 in fit and overflow geometry', () => {
  const tabIds = ['wide', 'tall', 'single'];
  const panes = {
    wide: { type: 'h', ratio: 0.5, a: leaf('p1'), b: leaf('p2') },
    tall: { type: 'v', ratio: 0.5, a: leaf('p3'), b: leaf('p4') },
    single: leaf('p5'),
  };
  const minimum = (id) => {
    const size = layoutMinSize(panes[id]);
    return { width: size.width + 2, height: size.height + 28 + 2 };
  };
  for (const [width, height] of [[2000, 900], [1301, 395], [100, 100]]) {
    const plan = planGrid(tabIds, width, height, 'h', { leaf: tabLeaf, minimum });
    assert.equal(plan.fits, width !== 100);
    const min = layoutMinSize(plan.layout, (node) => minimum(node.tabId));
    const rendered = renderSplitTree(plan.layout, { document, leaf: paddedLeaf, minimum: (node) => minimum(node.tabId) });
    const actual = assertGeometry(rendered, plan.layout, Math.max(width, min.width), Math.max(height, min.height));
    assert.deepEqual(actual.map((box) => box.id), tabIds);
    for (const box of actual) {
      assert.ok(box.width >= minimum(box.id).width - 1e-8);
      assert.ok(box.height >= minimum(box.id).height - 1e-8);
    }
  }
});

test('leaf formerly in a split expands after reparenting into a single-leaf layout', () => {
  const a = leaf('a'), b = leaf('b'), reused = paddedLeaf(a);
  const previous = renderSplitTree({ type: 'h', ratio: 0.25, a, b }, {
    document, leaf: (node) => node === a ? reused : paddedLeaf(node),
  });
  assert.equal(reused.style.flex, '0 0 calc(25% - 1.25px)');
  const root = new Element(); root.appendChild(previous);
  replaceLayoutContent(root, () => renderSplitTree(a, { document, leaf: () => reused }));
  assert.deepEqual(root.children, [reused]);
  assert.equal(reused.parentElement, root);
  assert.equal(reused.style.flex, '');
  assert.equal(previous.children.includes(reused), false);
});

test('replacement clears before build and flushes the finished tree before restoring overflow', () => {
  for (const overflow of ['', 'auto', 'scroll', 'hidden']) {
    const root = new Element(), old = new Element(), content = new Element(), events = [];
    root.style.overflow = overflow; root.appendChild(old);
    root.onFlush = () => {
      assert.equal(root.style.overflow, 'hidden');
      assert.deepEqual(root.children, [content]); events.push('flush');
    };
    const result = replaceLayoutContent(root, () => {
      assert.equal(root.style.overflow, 'hidden');
      assert.deepEqual(root.children, []);
      assert.equal(old.parentElement, null); events.push('build');
      return content;
    });
    assert.equal(result, content);
    assert.equal(root.style.overflow, overflow);
    assert.deepEqual(events, ['build', 'flush']);
  }
});

test('replacement supports empty results and caller-appended auxiliary content', () => {
  const root = new Element(); root.appendChild(new Element());
  let flushes = 0; root.onFlush = () => flushes++;
  assert.equal(replaceLayoutContent(root, () => null), null);
  assert.deepEqual(root.children, []);
  const content = new Element(), chip = new Element();
  assert.equal(replaceLayoutContent(root, () => {
    root.appendChild(content); root.appendChild(chip);
  }), undefined);
  assert.deepEqual(root.children, [content, chip]);
  assert.equal(flushes, 2);
});

test('replacement restores overflow when build or layout flush throws', () => {
  const root = new Element(); root.style.overflow = 'auto';
  const failure = new Error('test failure');
  assert.throws(() => replaceLayoutContent(root, () => { throw failure; }), (error) => error === failure);
  assert.equal(root.style.overflow, 'auto');
  root.onFlush = () => { throw failure; };
  assert.throws(() => replaceLayoutContent(root, () => new Element()), (error) => error === failure);
  assert.equal(root.style.overflow, 'auto');
});

test('replacement preserves inline overflow important priority', () => {
  const root = new Element(), restored = [];
  root.style.overflow = 'auto';
  root.style.getPropertyPriority = (name) => { assert.equal(name, 'overflow'); return 'important'; };
  root.style.setProperty = (name, value, priority) => {
    restored.push([name, value, priority]); root.style[name] = value;
  };
  replaceLayoutContent(root, () => null);
  assert.deepEqual(restored, [['overflow', 'auto', 'important']]);
  assert.equal(root.style.overflow, 'auto');
});
