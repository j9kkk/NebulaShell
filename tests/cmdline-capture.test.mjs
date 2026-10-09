// 命令行模型(shared/cmdline.js)与终端文本工具(shared/term-text.js)。
// 屏幕读取用真实 xterm(Node 下不调用 open(),无需 DOM)。
// 经 terminal.js 的端到端采集矩阵(回显校验、密码不记)见 src/modules/terminal.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { appendTrusted, createLine, feed, firstCommandLine } from '../src/shared/cmdline.js';
import { endsWithCommand, logicalLineEnd, normalizeSpace, readCommandFromBuffer, stripTerminalNoise } from '../src/shared/term-text.js';

const { Terminal } = xterm;

function run(...chunks) {
  const line = createLine();
  const submits = [];
  const events = [];
  for (const chunk of chunks) {
    feed(line, chunk, { onStart: () => events.push('start'), onSubmit: (s) => { events.push('submit'); submits.push(s); }, onAbort: () => events.push('abort') });
  }
  return { line, submits, events };
}

test('可打印字符、退格(含多字节字符)与回车', () => {
  const { submits } = run('lss', '\x7f', ' -la', '\r');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].text, 'ls -la');
  assert.equal(submits[0].dirty, false);
  assert.equal(submits[0].typed, true);
  assert.equal(run('echo 你好😀', '\x7f\x08', '\r').submits[0].text, 'echo 你');
});

test('Ctrl+U 清空、Ctrl+W 删前一个词,都不算脏', () => {
  assert.equal(run('echo hello world\x17\r').submits[0].text, 'echo hello ');
  assert.equal(run('echo hello   \x17\r').submits[0].text, 'echo ');
  const u = run('rm -rf /\x15ls\r').submits[0];
  assert.equal(u.text, 'ls');
  assert.equal(u.dirty, false);
});

test('Ctrl+C / Ctrl+G 放弃本行,之后的输入是新的一行', () => {
  const { submits, events } = run('rm -rf /tmp/x', '\x03', 'pwd\r');
  assert.deepEqual(submits.map((s) => s.text), ['pwd']);
  assert.deepEqual(events, ['start', 'abort', 'start', 'submit']);
  assert.deepEqual(run('git log\x07ls\r').submits.map((s) => s.text), ['ls']);
});

test('bracketed paste:去掉标记,块内回车是换行,块后回车才提交', () => {
  const single = run('\x1b[200~ss -tulnp | grep 80\x1b[201~', '\r').submits;
  assert.deepEqual(single.map((s) => s.text), ['ss -tulnp | grep 80']);
  assert.equal(single[0].dirty, false);
  const multi = run('\x1b[200~echo a\recho b\r\x1b[201~\r').submits;
  assert.deepEqual(multi.map((s) => s.text), ['echo a\necho b\n']);
  // 标记被 chunk 拆开
  const split = run('\x1b[20', '0~ls -l', 'a\x1b[2', '01~\r').submits;
  assert.deepEqual(split.map((s) => s.text), ['ls -la']);
});

test('非 bracketed 的多行粘贴按行提交,与 shell 实际执行一致', () => {
  assert.deepEqual(run('echo a\recho b\r').submits.map((s) => s.text), ['echo a', 'echo b']);
});

test('方向键、Tab、Home/End、Alt 键、Ctrl+R 等把行标记为脏,记下变脏前的文字', () => {
  for (const key of ['\x1b[A', '\x1bOA', '\t', '\x1b[H', '\x1b[3~', '\x1bb', '\x12', '\x01', '\x1b[1;5D']) {
    const s = run('git ch', key, 'eckout\r').submits[0];
    assert.equal(s.dirty, true, JSON.stringify(key));
    assert.equal(s.cleanPrefix, 'git ch', JSON.stringify(key));
  }
  // 跨 chunk 的转义序列先暂存,不把 [A 当成文字
  const split = run('\x1b', '[A', '\r').submits[0];
  assert.equal(split.dirty, true);
  assert.equal(split.text, '');
});

test('单独的 Esc 键后接控制字符;Ctrl+L 只在行内才使锚点失效;Ctrl+D 空行无事', () => {
  const esc = run('ls\x1b\r').submits[0];
  assert.equal(esc.dirty, true);
  assert.equal(esc.text, 'ls');
  const cleared = run('\x0c', 'pwd\r').submits[0];
  assert.equal(cleared.lost, false);
  assert.equal(cleared.dirty, false);
  assert.equal(run('pw\x0cd\r').submits[0].lost, true);
  assert.equal(run('\x04').line.started, false);
});

test('空行回车也产生提交(调用方据此开启新的输出采集)', () => {
  const s = run('\r').submits[0];
  assert.equal(s.text, '');
  assert.equal(s.started, false);
});

test('可信文本:appendTrusted 原样保留换行,随后的键盘编辑标记 typed', () => {
  const line = createLine();
  appendTrusted(line, 'echo one\r\n  echo two');
  assert.equal(line.text, 'echo one\n  echo two');
  const [plain] = feed(line, '\r');
  assert.deepEqual([plain.trusted, plain.typed, plain.dirty], [true, false, false]);
  appendTrusted(line, 'df -h');
  const [edited] = feed(line, '\x7fH\r');
  assert.equal(edited.text, 'df -H');
  assert.deepEqual([edited.trusted, edited.typed], [true, true]);
  const trusted = createLine();
  feed(trusted, 'uptime', { trusted: true });
  assert.equal(feed(trusted, '\r', { trusted: true })[0].typed, false);
});

test('firstCommandLine 取首个非空行', () => {
  assert.equal(firstCommandLine('\n  echo a\necho b'), 'echo a');
  assert.equal(firstCommandLine('  ls -la  '), 'ls -la');
});

test('stripTerminalNoise 去掉 CSI/OSC/DCS/SS3/字符集指定/C1,保留换行与制表符', () => {
  assert.equal(stripTerminalNoise('\x1b[31merror\x1b[0m\x1b]0;title\x07\nnext'), 'error\nnext');
  assert.equal(stripTerminalNoise('\x1b[200~ls\x1b[201~'), 'ls');
  assert.equal(stripTerminalNoise('a\x1bOAb\x1b(Bc\x1b=d\x1b7e'), 'abcde');
  assert.equal(stripTerminalNoise('x\x1bPq#0;1\x1b\\y\x1b_apc\x1b\\z'), 'xyz');
  assert.equal(stripTerminalNoise('a\x9b31mb\x85c\tok\x7f\x03'), 'a31mbc\tok');
});

async function screen(cols, ...writes) {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: false });
  for (const data of writes) await new Promise((resolve) => term.write(data, resolve));
  return term;
}

test('readCommandFromBuffer:从提示符后读出,跨自动折行拼接,行尾空白去掉', async () => {
  const term = await screen(20, '$ ', 'echo 0123456789abcdefghij  ', '\r\nnext');
  const buf = term.buffer.normal;
  assert.equal(logicalLineEnd(buf, 0), 1);
  assert.equal(readCommandFromBuffer(buf, 0, 2, 20), 'echo 0123456789abcdefghij');
  assert.equal(readCommandFromBuffer(buf, 2, 0, 20), 'next');
  assert.equal(readCommandFromBuffer(buf, 9, 0, 20), null);
});

test('宽字符在行尾放不下留下的空单元不当作空格', async () => {
  const term = await screen(10, '$ echo 中文测试');
  const buf = term.buffer.normal;
  assert.equal(logicalLineEnd(buf, 0), 1);
  assert.equal(readCommandFromBuffer(buf, 0, 2, 10), 'echo 中文测试');
});

test('zsh RPROMPT:贴右边界、与命令隔 ≥3 个空格的一段剔除;没贴边不动', async () => {
  // zsh 默认 RPROMPT 末字符落在倒数第 2 列(ZLE_RPROMPT_INDENT=1)
  const term = await screen(40, '% \x1b7\x1b[33G[12:30]\x1b8', 'git status');
  const buf = term.buffer.normal;
  assert.equal(readCommandFromBuffer(buf, 0, 2, 40), 'git status');
  const plain = await screen(40, '% echo "a   b"');
  assert.equal(readCommandFromBuffer(plain.buffer.normal, 0, 2, 40), 'echo "a   b"');
});

test('endsWithCommand:命令前必须紧挨提示符结束符号', () => {
  assert.equal(endsWithCommand('root@h:/tmp# ls -la', 'ls -la'), true);
  assert.equal(endsWithCommand('~/src on main ❯ git  status', 'git status'), true);
  assert.equal(endsWithCommand('PS C:\\> dir', 'dir'), true);
  assert.equal(endsWithCommand('root', 'root'), false, '输出行恰好等于输入不算回显');
  assert.equal(endsWithCommand('[sudo] password for root: ', 'root'), false);
  assert.equal(endsWithCommand('user: root', 'root'), false);
  assert.equal(normalizeSpace(' a \t b  '), 'a b');
});
