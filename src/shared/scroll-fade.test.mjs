// 全局滚动容器规则(底部渐隐)的状态机:只按尺寸算状态,不碰 DOM,所以能直接单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollPos } from './scroll-fade.js';

const box = (scrollTop, scrollHeight, clientHeight) => ({ scrollTop, scrollHeight, clientHeight });

test('没溢出 → none(不画渐隐)', () => {
  assert.equal(scrollPos(box(0, 272, 272)), 'none');
  assert.equal(scrollPos(box(0, 200, 272)), 'none');
});

test('溢出且在顶 → start(最后一行被切,提示还能滚)', () => {
  assert.equal(scrollPos(box(0, 285, 272)), 'start');
});

test('滚到中间 → middle(上下都有内容,仍提示)', () => {
  assert.equal(scrollPos(box(6, 285, 272)), 'middle');
});

test('滚到底 → end(渐隐收回,免得最后一行被吃掉一半)', () => {
  assert.equal(scrollPos(box(13, 285, 272)), 'end');
  assert.equal(scrollPos(box(999, 285, 272)), 'end');
});

test('亚像素容差:不足 1px 的差额不算溢出', () => {
  assert.equal(scrollPos(box(0, 272.6, 272)), 'none');
  assert.equal(scrollPos(box(0.4, 285, 272)), 'start');
});
