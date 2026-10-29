// 超长私有序列过滤器(shared/term-text.js):内联图片的 base64 不能被当正文
// 累积。终端输出按块到达且序列可跨块,所以覆盖分块、终止符、非 IIP 三类情形。
import test from 'node:test';
import assert from 'node:assert/strict';
import { LONG_SEQ_LIMIT, createSequenceFilter, iipPlaceholder } from '../src/shared/term-text.js';

/// 用固定 payload 组一条 iTerm IIP 序列(OSC 1337)
function iip(payloadLen, { name = '', size = 200000, term = '\x07' } = {}) {
  const nameField = name ? `name=${Buffer.from(name).toString('base64')};` : '';
  return `\x1b]1337;File=inline=1;${nameField}size=${size};width=10;height=5:${'A'.repeat(payloadLen)}${term}`;
}

test('超长 IIP 序列被替换为占位符,不泄漏 base64', () => {
  const f = createSequenceFilter();
  const out = f.push(iip(200_000) + 'AFTER');
  assert.ok(!out.includes('AAAA'), `泄漏 base64:${out.length} 字符`);
  assert.ok(out.includes('[图片'), `缺少占位符:${JSON.stringify(out.slice(0, 80))}`);
  assert.ok(out.includes('AFTER'), '终止符之后的正文丢了');
  assert.ok(out.includes('200000B'), '占位符应带字节数');
});

test('占位符还原 IIP 头里的文件名', () => {
  const f = createSequenceFilter();
  const out = f.push(iip(100_000, { name: 'compare.png' }));
  assert.ok(out.includes('[图片 compare.png · 200000B]'), out);
});

test('序列跨块到达时不泄漏且能恢复', () => {
  const f = createSequenceFilter();
  const seq = iip(100_000);
  let out = '';
  // 逐 1000 字符投喂,模拟 SSH 分块
  for (let i = 0; i < seq.length; i += 1000) out += f.push(seq.slice(i, i + 1000));
  out += f.push('AFTER');
  assert.ok(!out.includes('AAAA'), `跨块泄漏:${out.length}`);
  assert.ok(out.includes('AFTER'));
});

test('短 OSC 原样保留(不误伤既有语义)', () => {
  const f = createSequenceFilter();
  assert.equal(f.push('\x1b]0;title\x07plain'), '\x1b]0;title\x07plain');
});

test('普通输出原样透传', () => {
  const f = createSequenceFilter();
  assert.equal(f.push('hello\nworld'), 'hello\nworld');
});

test('非 IIP 的超长私有序列被吞弃且不伪造图片占位符', () => {
  const f = createSequenceFilter();
  const out = f.push(`\x1b]9;${'B'.repeat(50_000)}:note\x07AFTER`);
  assert.ok(!out.includes('BBBB'), '泄漏非图片超长序列');
  assert.ok(!out.includes('[图片'), '不应伪造图片占位符');
  assert.ok(out.includes('AFTER'));
});

test('CSI 序列立即透传,不被当作超长私有序列缓冲', () => {
  const f = createSequenceFilter();
  assert.equal(f.push('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m');
});

test('flush 吐出跨块的半截序列(停止采集时收尾)', () => {
  const f = createSequenceFilter();
  assert.equal(f.push('before\x1b]0;tit'), 'before');
  assert.equal(f.flush(), '\x1b]0;tit');
});

test('ST 终止符(ESC \\)同样结束吞弃', () => {
  const f = createSequenceFilter();
  const out = f.push(iip(200_000, { term: '\x1b\\' }) + 'AFTER');
  assert.ok(!out.includes('AAAA'));
  assert.ok(out.includes('AFTER'));
});

test('iipPlaceholder 对非 IIP 返回 null', () => {
  assert.equal(iipPlaceholder('\x1b]0;title'), null);
  assert.equal(iipPlaceholder('plain text'), null);
});

test('iipPlaceholder 缺字段时省略对应片段', () => {
  assert.equal(iipPlaceholder('\x1b]1337;File=inline=1;size=1234:x'), '[图片 · 1234B]');
  const name = Buffer.from('a.png').toString('base64');
  assert.equal(iipPlaceholder(`\x1b]1337;File=inline=1;name=${name}:x`), '[图片 a.png]');
});

test('阈值与 Rust 侧保持一致(4096)', () => {
  assert.equal(LONG_SEQ_LIMIT, 4096);
});
