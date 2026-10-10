// 显示格式与传输速度估算(src/shared/format.js)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtClock, fmtDateTime, fmtDuration, fmtMtime, fmtSize, fmtSpeed, pushSample, rateOf, remainingMs } from '../src/shared/format.js';

test('fmtSize:B 取整,KB 以上一位小数,非数/负数为空', () => {
  assert.equal(fmtSize(0), '0 B');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(1536), '1.5 KB');
  assert.equal(fmtSize(700 * 1024 * 1024), '700.0 MB');
  assert.equal(fmtSize(3 * 1024 ** 4), '3.0 TB');
  assert.equal(fmtSize(null), '');
  assert.equal(fmtSize(-1), '');
  assert.equal(fmtSize(Number.NaN), '');
});

test('fmtSpeed / fmtDuration', () => {
  assert.equal(fmtSpeed(12.4 * 1024 * 1024), '12.4 MB/s');
  assert.equal(fmtSpeed(0), '');
  assert.equal(fmtSpeed(Infinity), '');
  assert.equal(fmtDuration(400), '不到 1 秒');
  assert.equal(fmtDuration(28_000), '28 秒');
  assert.equal(fmtDuration(185_000), '3 分 05 秒');
  assert.equal(fmtDuration(3_720_000), '1 小时 02 分');
  assert.equal(fmtDuration(-1), '');
});

test('fmtMtime:今年显示月日时分,往年显示年月日,0 为空;fmtDateTime / fmtClock', () => {
  const now = new Date(2026, 9, 10, 12, 0).getTime();
  assert.equal(fmtMtime(new Date(2026, 0, 3, 9, 5).getTime(), now), '01-03 09:05');
  assert.equal(fmtMtime(new Date(2025, 11, 31, 23, 59).getTime(), now), '2025-12-31');
  assert.equal(fmtMtime(0, now), '');
  assert.equal(fmtDateTime(new Date(2026, 9, 1, 3, 4, 5).getTime()), '2026-10-01 03:04:05');
  assert.equal(fmtClock(new Date(2026, 9, 1, 16, 42).getTime()), '16:42');
});

test('速度窗口:保留最近 5 秒的样本,至少留一个基线点;速度按窗口首尾计算', () => {
  let samples = [];
  for (let t = 0; t <= 10_000; t += 1000) samples = pushSample(samples, t, t * 1024);
  assert.equal(samples[0][0], 5000, '窗口外的旧样本被丢弃');
  assert.equal(samples.at(-1)[0], 10_000);
  assert.equal(rateOf(samples), 1024 * 1000);
  assert.equal(rateOf([[0, 0]]), 0, '单个样本没有速度');
  assert.equal(rateOf([[0, 0], [100, 5000]]), 0, '时间跨度太短不估速');
  // 停滞后窗口里只剩相同字节数:速度为 0
  let stalled = [];
  for (let t = 0; t <= 8000; t += 1000) stalled = pushSample(stalled, t, 4096);
  assert.equal(rateOf(stalled), 0);
});

test('剩余时间:总量未知 / 速度为 0 / 已完成时为 null', () => {
  assert.equal(remainingMs(50, 100, 10), 5000);
  assert.equal(remainingMs(50, 0, 10), null);
  assert.equal(remainingMs(50, 100, 0), null);
  assert.equal(remainingMs(100, 100, 10), null);
});
