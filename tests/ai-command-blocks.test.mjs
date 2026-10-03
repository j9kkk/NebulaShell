import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, mdToHtml } from '../src/shared/markdown.js';
import { classifyCommandBlock } from '../src/shared/ai-command-blocks.js';

const block = (text, overrides = {}) => ({ index: 0, language: 'bash', text, closed: true, ...overrides });
const classify = (text, overrides) => classifyCommandBlock(block(text, overrides));
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

test('renderMarkdown exposes ordered block metadata and mdToHtml stays compatible', () => {
  const source = '# Title\n\nText **bold**\n\n```BASH\necho hi\n```\n\n~~~python\nprint(1)\n~~~';
  const rendered = renderMarkdown(source);
  assert.deepEqual(rendered.codeBlocks, [
    block('echo hi'),
    block('print(1)', { index: 1, language: 'python' }),
  ]);
  assert.equal(rendered.html, '<h3>Title</h3><p>Text <strong>bold</strong></p><pre><code>echo hi</code></pre><pre><code>print(1)</code></pre>');
  assert.equal(mdToHtml(source), rendered.html);
  assert.deepEqual(renderMarkdown(null), { html: '', codeBlocks: [] });
  assert.deepEqual(renderMarkdown(undefined), { html: '', codeBlocks: [] });
});

test('default code rendering escapes all untrusted content without Markdown processing', () => {
  const text = '<script>"x" & \'y\'</script>\n**bold** [x](javascript:alert(1))';
  const result = renderMarkdown('```bash\n' + text + '\n```');
  assert.equal(result.codeBlocks[0].text, text);
  assert.equal(result.html, `<pre><code>${escapeHtml(text)}</code></pre>`);
  assert.ok(!result.html.includes('<script>'));
  assert.ok(!result.html.includes('<strong>'));
});

test('custom renderer receives raw blocks exactly once and owns its HTML escaping', () => {
  const seen = [];
  const result = renderMarkdown('```sh\n<x>\r\ny\n```\n~~~\nz\n~~~', {
    renderCodeBlock(value) {
      seen.push(value);
      return `<section data-index="${value.index}">${escapeHtml(value.text)}</section>`;
    },
  });
  assert.deepEqual(seen, result.codeBlocks);
  assert.equal(seen[0], result.codeBlocks[0]);
  assert.equal(seen[0].text, '<x>\r\ny');
  assert.equal(result.html, '<section data-index="0">&lt;x&gt;\r\ny</section><section data-index="1">z</section>');
});

for (const mark of ['```', '`````', '~~~', '~~~~~']) {
  test(`closing ${mark} requires same character, sufficient length, and only trailing whitespace`, () => {
    const wrong = mark[0] === '`' ? '~~~~~~' : '``````';
    const short = mark[0].repeat(mark.length - 1);
    const body = ['echo before', short, wrong, mark + 'bash', mark + ' trailing', '    ' + mark, 'echo after'].join('\n');
    const source = mark + 'bash\n' + body + '\n  ' + mark + mark[0] + '\t \nnormal';
    const result = renderMarkdown(source);
    assert.deepEqual(result.codeBlocks, [block(body)]);
    assert.ok(result.html.endsWith('<p>normal</p>'));
  });
}

for (const indent of ['', ' ', '  ', '   ']) {
  test(`opening fences accept ${indent.length} spaces after an ordinary paragraph`, () => {
    const result = renderMarkdown('Intro\n' + indent + '```zsh\n  printf ok\n' + indent + '```');
    assert.deepEqual(result.codeBlocks, [block('  printf ok', { language: 'zsh' })]);
    assert.equal(result.html, '<p>Intro</p><pre><code>  printf ok</code></pre>');
  });
}

test('four-space and tab indentation do not open fenced blocks', () => {
  for (const indent of ['    ', '\t']) {
    assert.deepEqual(renderMarkdown(indent + '```bash\n' + indent + 'echo hi\n' + indent + '```').codeBlocks, []);
  }
});

test('unknown opening info captures nested shell fences as inert code, never executable blocks', () => {
  const source = '````python title="example"\n```bash\nrm -rf /\n```\n````\n\n~~~json title=x\n```sh\necho inner\n```\n~~~';
  const blocks = renderMarkdown(source).codeBlocks;
  assert.deepEqual(blocks, [
    block('```bash\nrm -rf /\n```', { language: 'python' }),
    block('```sh\necho inner\n```', { index: 1, language: 'json' }),
  ]);
  for (const value of blocks) assert.equal(classifyCommandBlock(value).eligible, false);
});

test('arbitrary info strings are still fences and unlabelled blocks stay copy-only', () => {
  for (const info of ['python title=foo', '{.python #sample}', 'console session=1', 'text/html', '']) {
    const blocks = renderMarkdown('```' + info + '\n~~~bash\necho nested\n~~~\n```').codeBlocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, '~~~bash\necho nested\n~~~');
    assert.equal(classifyCommandBlock(blocks[0]).eligible, false);
  }
});

test('language is the case-normalized first info word', () => {
  assert.deepEqual(renderMarkdown('   ~~~ \tZSH title=demo\necho hi\n~~~').codeBlocks, [
    block('echo hi', { language: 'zsh' }),
  ]);
});

test('raw text preserves mixed line endings, whitespace, indentation, and internal blank lines', () => {
  const raw = '  echo "one"\r\n\techo two\n\r\n  echo three  ';
  const result = renderMarkdown('Intro\r\n```bash\r\n' + raw + '\r\n```\r\nEnd');
  assert.equal(result.codeBlocks[0].text, raw);
  assert.ok(result.html.includes(escapeHtml(raw.replace(/\r\n/g, '\n'))));
  assert.ok(!result.html.includes('\r'));
  assert.equal(classifyCommandBlock(result.codeBlocks[0]).lineCount, 4);
});

test('only the line ending immediately before the closing fence is excluded', () => {
  for (const newline of ['\n', '\r\n']) {
    const examples = [
      ['```bash' + newline + '```', ''],
      ['```bash' + newline + newline + '```', ''],
      ['```bash' + newline + 'a' + newline + '```', 'a'],
      ['```bash' + newline + 'a' + newline + newline + '```', 'a' + newline],
      ['```bash' + newline + newline + 'a' + newline + newline + '```', newline + 'a' + newline],
    ];
    for (const [source, expected] of examples) {
      assert.equal(renderMarkdown(source).codeBlocks[0].text, expected);
    }
  }
});

test('streaming unclosed fences render safely and preserve genuine EOF newlines', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const text of ['', '<img onerror=evil()>', 'echo a' + newline, 'echo a' + newline + newline]) {
      const result = renderMarkdown('```bash' + newline + text);
      assert.deepEqual(result.codeBlocks, [block(text, { closed: false })]);
      assert.equal(result.html, `<pre><code>${escapeHtml(text.replace(/\r\n/g, '\n'))}</code></pre>`);
      assert.equal(classifyCommandBlock(result.codeBlocks[0]).reason, 'unclosed');
    }
  }
  assert.deepEqual(renderMarkdown('```sh').codeBlocks, [block('', { language: 'sh', closed: false })]);
});

test('table collection does not swallow a fence whose info includes a pipe', () => {
  const result = renderMarkdown('| A | B |\n| -- | -- |\n| 1 | 2 |\n```python title=a|b\nx\n```');
  assert.match(result.html, /<table>/);
  assert.deepEqual(result.codeBlocks, [block('x', { language: 'python' })]);
});

test('existing lists, quotes, links and tables still render with safe text', () => {
  const source = '- a\n- b\n\n1. c\n2. d\n\n> quote\n\n---\n\n[x](https://example.com) [bad](javascript:evil) <b>\n\n| A | B |\n| -- | -- |\n| <x> | `y` |';
  const result = renderMarkdown(source);
  assert.deepEqual(result.codeBlocks, []);
  for (const html of ['<ul><li>a</li><li>b</li></ul>', '<ol><li>c</li><li>d</li></ol>', '<blockquote>quote</blockquote>', '<hr>', 'href="https://example.com"', '[bad](javascript:evil)', '&lt;b&gt;', '<td>&lt;x&gt;</td>', '<td><code>y</code></td>']) {
    assert.ok(result.html.includes(html), html);
  }
});

test('classification returns the complete interface without mutating or splitting commands', () => {
  const value = Object.freeze(block('  echo one\r\n\techo two  '));
  assert.deepEqual(classifyCommandBlock(value), {
    shell: true, eligible: true, reason: 'eligible', multiline: true, lineCount: 2, risk: '',
    blockedReasons: [], warnings: [],
  });
  assert.equal(value.text, '  echo one\r\n\techo two  ');
});

test('only the explicit shell language whitelist is eligible', () => {
  for (const language of ['sh', 'bash', 'zsh', 'shell', 'BASH']) {
    assert.equal(classify('echo hi', { language }).eligible, true, language);
  }
  for (const language of ['', 'console', 'terminal', 'shellscript', 'fish', 'powershell', 'cmd', 'python', 'js', 'bash-session', 'sh-session', 'bash title=demo']) {
    assert.deepEqual(classify('echo hi', { language }), {
      shell: false, eligible: false, reason: 'unsupported-language', multiline: false, lineCount: 1, risk: '',
      blockedReasons: ['unsupported-language'], warnings: [],
    }, language);
  }
});

test('empty or incomplete blocks are ineligible; empty text has zero lines', () => {
  for (const text of ['', ' ', '\t\r\n  ']) {
    assert.equal(classify(text).reason, 'empty');
    assert.equal(classify(text).eligible, false);
  }
  assert.equal(classify('').lineCount, 0);
  assert.equal(classify('echo hi', { closed: false }).reason, 'unclosed');
  assert.equal(classify('echo hi', { closed: undefined }).reason, 'unclosed');
  assert.equal(classifyCommandBlock(null).eligible, false);
});

test('lineCount counts all raw lines including preserved trailing blank lines', () => {
  for (const [text, count] of [['x', 1], ['x\ny', 2], ['x\r\ny', 2], ['x\n', 2], ['\nx\n\n', 4]]) {
    assert.equal(classify(text).lineCount, count);
    assert.equal(classify(text).multiline, count > 1);
  }
});

test('C0/C1 control characters and lone carriage returns are ineligible', () => {
  const controls = [
    ...Array.from({ length: 32 }, (_, n) => n).filter((n) => ![9, 10, 13].includes(n)),
    ...Array.from({ length: 33 }, (_, n) => n + 127),
  ];
  for (const code of controls) {
    assert.equal(classify('echo a' + String.fromCharCode(code) + 'b').reason, 'control-character', String(code));
  }
  assert.equal(classify('echo a\recho b').reason, 'control-character');
  assert.equal(classify('printf ok\t\r\necho yes').eligible, true);
  assert.equal(classify('cat <<EOF\n\x1b[31m\nEOF').reason, 'control-character');
});

for (const placeholder of ['<YOUR_HOST>', '<your-host>', '<HOST>', '<PATH>', '<REPLACE_ME>', '{{YOUR_HOST}}', '{{ YOUR_API_KEY }}', '{{REPLACE_ME}}', 'YOUR_HOST', 'YOUR_API_KEY', 'REPLACE_ME']) {
  test(`obvious example parameter ${JSON.stringify(placeholder)} is advisory even inside quotes`, () => {
    const text = 'echo "' + placeholder + '"';
    const value = Object.freeze(block(text));
    const result = classifyCommandBlock(value);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'eligible');
    assert.deepEqual(result.blockedReasons, []);
    assert.deepEqual(result.warnings, [{
      kind: 'suspected-placeholder', token: placeholder,
      message: '该命名通常用于需要用户填写的示例参数，请确认其含义',
    }]);
    assert.equal(value.text, text);
  });
}

test('example reminders deduplicate exact tokens without matching wrapped interiors again', () => {
  const result = classify('echo "<YOUR_HOST> <YOUR_HOST> {{YOUR_HOST}} {{YOUR_HOST}} YOUR_API_KEY YOUR_API_KEY"');
  assert.deepEqual(result.warnings.map(({ token }) => token), ['<YOUR_HOST>', '{{YOUR_HOST}}', 'YOUR_API_KEY']);
  assert.ok(result.warnings.every(({ kind, message }) => kind === 'suspected-placeholder' && /[\u4e00-\u9fff]/.test(message)));
  assert.equal(result.eligible, true);
});

test('structural reasons accumulate and coexist with example reminders and risk hints', () => {
  const text = '$ rm -rf YOUR_HOST\n\x1b';
  const value = Object.freeze(block(text, { closed: false }));
  assert.deepEqual(classifyCommandBlock(value), {
    shell: true, eligible: false, reason: 'unclosed', multiline: true, lineCount: 2,
    risk: '递归删除', blockedReasons: ['unclosed', 'control-character', 'shell-prompt'],
    warnings: [{
      kind: 'suspected-placeholder', token: 'YOUR_HOST',
      message: '该命名通常用于需要用户填写的示例参数，请确认其含义',
    }],
  });
  assert.equal(value.text, text);
  assert.deepEqual(classify('', { language: 'python', closed: false }).blockedReasons,
    ['unsupported-language', 'unclosed', 'empty']);
  assert.deepEqual(classify('YOUR_HOST\x00', { language: 'python', closed: false }), {
    shell: false, eligible: false, reason: 'unsupported-language', multiline: false, lineCount: 1,
    risk: '', blockedReasons: ['unsupported-language', 'unclosed', 'control-character'], warnings: [],
  });
  assert.equal(classify('$ echo <YOUR_HOST>').reason, 'shell-prompt');
  assert.equal(classify('echo YOUR_HOST\x00').reason, 'control-character');
});

for (const prompt of ['$ echo hi', '  $ sudo ls', '$', 'user@host:~$ ls', 'root@host:/tmp# whoami', 'user@host $ pwd', '[root@host ~]# ls', '[user@host ~/work] $ pwd']) {
  test(`shell prompt ${JSON.stringify(prompt)} is copy-only and remains unchanged`, () => {
    const value = block(prompt);
    assert.equal(classifyCommandBlock(value).reason, 'shell-prompt');
    assert.equal(value.text, prompt);
  });
}

test('ordinary comments, variables, substitutions, and redirections are not prompts or placeholders', () => {
  for (const text of [
    '# regular comment\necho hi', '#', '# $ echo sample\necho real',
    '# YOUR_HOST is an example\necho real', 'echo hi # REPLACE_ME in a comment',
    '$HOME/bin/run', '$COMMAND --flag', 'echo "$PATH"', 'HOST=server\necho ${HOST}',
    'YOUR_HOST=server\necho "$YOUR_HOST"', 'echo ${YOUR_HOST}', 'echo ${YOUR_HOST:-localhost}',
    'export YOUR_HOST="server" YOUR_API_KEY=secret', 'YOUR_HOST+=suffix', 'YOUR_HOST[0]=server',
    'echo "$YOUR_HOST" "${YOUR_HOST}" "${!YOUR_HOST}" "${#YOUR_HOST}"',
    'echo $(date)', 'printf "%s" "user@host $ text"', 'cat <input >output',
    'echo your_host_name', 'cat ./YOUR_HOST.txt /tmp/YOUR_HOST.json my-YOUR_HOST.log',
    'cat <<< "$HOME"\necho done', '((value = 1 << 2))\necho "$value"',
  ]) {
    const result = classify(text);
    assert.equal(result.eligible, true, text);
    assert.deepEqual(result.blockedReasons, [], text);
    assert.deepEqual(result.warnings, [], text);
  }
});

for (const [opener, end, body] of [
  ['cat <<EOF', 'EOF', '$ not a prompt\nroot@host # literal text\n<YOUR_HOST>\n{{ template }}'],
  ["cat <<'EOF'", 'EOF', '$HOME\n$ literal'],
  ['cat <<"EOF"', 'EOF', 'user@host:~$ literal'],
  ['cat <<\\EOF', 'EOF', '$ literal'],
  ['cat <<E"OF"', 'EOF', '$ literal'],
  ["cat <<'END TEXT'", 'END TEXT', '$ literal'],
  ['cat <<-EOF', '\tEOF', '\t$ literal\n\troot@host # text'],
]) {
  test(`legal here-doc ${opener} does not classify literal body content`, () => {
    const text = opener + '\n' + body + '\n' + end + '\necho done';
    const value = block(text);
    assert.equal(classifyCommandBlock(value).eligible, true);
    assert.deepEqual(classifyCommandBlock(value).warnings, []);
    assert.equal(value.text, text);
    assert.equal(classify(text + '\n$ echo outside').reason, 'shell-prompt');
    const outside = classify(text + '\necho YOUR_HOST');
    assert.equal(outside.reason, 'eligible');
    assert.deepEqual(outside.warnings.map(({ token }) => token), ['YOUR_HOST']);
  });
}

test('multiple here-doc bodies are skipped in shell order, but later command lines are checked', () => {
  const text = "cat <<ONE <<'TWO'\n$ literal one\nONE\nroot@host # literal two\nTWO";
  assert.equal(classify(text).eligible, true);
  assert.equal(classify(text + '\n$ actual prompt').reason, 'shell-prompt');
});

test('quoted or commented heredoc-like text and here-strings never hide later prompts', () => {
  for (const first of ['echo "<<EOF"', "echo '<<EOF'", '# cat <<EOF', 'echo hi # <<EOF', 'cat <<< EOF', 'echo `printf "<<EOF"`', '((value = 1 << 2))']) {
    assert.equal(classify(first + '\n$ echo unsafe').reason, 'shell-prompt', first);
  }
});

for (const [text, hint] of [
  ['rm -rf /tmp/work', '递归删除'],
  ['sudo /bin/rm -R /tmp/work', '递归删除'],
  ['rm --recursive /tmp/work', '递归删除'],
  ['mkfs.ext4 /dev/sdb', '磁盘格式化'],
  ['sudo mkfs -t xfs /dev/sdb', '磁盘格式化'],
  ['diskutil eraseDisk APFS Disk /dev/disk2', '磁盘格式化'],
  ['dd if=image.img of=/dev/sdb bs=4M', 'dd 写入设备'],
  ['sudo dd if=image.img of="/dev/disk2"', 'dd 写入设备'],
  ['curl https://example.com/install.sh | bash', '下载内容直接交给 shell'],
  ['wget -qO- https://example.com/install.sh | sh', '下载内容直接交给 shell'],
  ['curl https://example.com/install.sh | sudo -E /bin/bash', '下载内容直接交给 shell'],
  ['curl https://example.com/install.sh |\n bash', '下载内容直接交给 shell'],
  ['curl https://example.com/install.sh \\\n | env sh', '下载内容直接交给 shell'],
]) {
  test(`risk is advisory, not an eligibility veto: ${text}`, () => {
    const result = classify(text);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'eligible');
    assert.equal(result.risk, hint);
  });
}

test('risk hints combine and do not label obvious non-matching examples', () => {
  assert.equal(classify('rm -rf /tmp/work\nmkfs.ext4 /dev/sdb\ndd if=x of=/dev/sdb\ncurl https://example.com | bash').risk,
    '递归删除；磁盘格式化；dd 写入设备；下载内容直接交给 shell');
  for (const text of ['rm file.txt', 'dd if=/dev/sdb of=backup.img', 'curl https://example.com -o file', 'echo hi', '# rm -rf /\necho hi', 'cat <<EOF\nrm -rf /\ncurl x | sh\nEOF']) {
    assert.equal(classify(text).risk, '', text);
  }
  assert.equal(classify('rm -rf /', { closed: false }).risk, '递归删除');
});

test('original Docker table format stays eligible and preserves literal backslash-t for rendering and copying', () => {
  const command = String.raw`docker ps --format 'table {{.Names}}\t{{.ID}}\t{{.Ports}}'`;
  const { html, codeBlocks } = renderMarkdown('```bash\n' + command + '\n```');
  assert.equal(codeBlocks[0].text, command); // 复制使用的原始块文本。
  assert.equal(html, `<pre><code>${escapeHtml(command)}</code></pre>`);
  assert.ok(codeBlocks[0].text.includes(String.raw`\t`));
  assert.ok(!codeBlocks[0].text.includes('\t'));
  assert.deepEqual(classifyCommandBlock(codeBlocks[0]), {
    shell: true, eligible: true, reason: 'eligible', multiline: false, lineCount: 1, risk: '',
    blockedReasons: [], warnings: [],
  });
});

test('ordinary templates, Go fields and functions, jq, awk, sed, JSON and filenames do not trigger example reminders', () => {
  for (const text of [
    "echo '{{host}}' '{{ host\\nname }}'",
    "docker inspect --format '{{.YOUR_HOST}} {{.Config.YOUR_HOST}} {{.REPLACE_ME}}' app",
    "docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' app",
    "docker inspect --format '{{if .State.Running}}{{printf \"%s\" .Name}}{{else}}stopped{{end}}' app",
    "docker inspect --format '{{index .Config.Labels \"com.example.host\"}}' app",
    "custom-tool --format '{{range .YOUR_HOST}}{{printf \"%s\" .Name}}{{end}}'",
    "jq '.YOUR_HOST // .host' data.json",
    "jq --arg host \"$YOUR_HOST\" '{host: $host}' data.json",
    "awk '{print $1, \"{{host}}\"}' data.txt",
    "sed 's/{{host}}/localhost/g' config.json",
    String.raw`curl -H 'Content-Type: application/json' -d '{"host":"{{host}}","template":"{{.Names}}"}' https://example.com`,
    "cat '{{host}}.json' './YOUR_HOST.txt' /tmp/REPLACE_ME.log",
  ]) {
    const result = classify(text);
    assert.equal(result.eligible, true, text);
    assert.deepEqual(result.blockedReasons, [], text);
    assert.deepEqual(result.warnings, [], text);
  }
});

test('reminders are not command-whitelisted or suppressed by quotes, JSON, comments or here-doc elsewhere', () => {
  for (const text of [
    'custom-tool --host YOUR_HOST',
    "jq --arg host 'YOUR_HOST' '{host: $host}' data.json",
    "curl -d '{\"host\":\"YOUR_HOST\"}' https://example.com",
    "awk '{print \"YOUR_HOST\"}' data.txt",
    "sed 's/host/YOUR_HOST/g' config.json",
    '# {{YOUR_API_KEY}} and REPLACE_ME\necho "YOUR_HOST" # <YOUR_HOST>',
    'cat <<EOF\n{{YOUR_API_KEY}} and REPLACE_ME\nEOF\necho YOUR_HOST',
  ]) {
    const result = classify(text);
    assert.equal(result.eligible, true, text);
    assert.deepEqual(result.warnings.map(({ token }) => token), ['YOUR_HOST'], text);
    assert.deepEqual(classify(text), result, 'repeated classification stays deterministic');
  }
  assert.equal(classify('rm -rf "YOUR_HOST"').risk, '递归删除');
  assert.equal(classify('rm -rf "YOUR_HOST"').eligible, true);
});

test('parser and classifier integrate without guessing languages or rewriting risky scripts', () => {
  const script = '  # backup first\r\n  rm -rf /tmp/work\r\n\tprintf done';
  const source = '```bash\r\n' + script + '\r\n```\r\n```\r\necho unlabelled\r\n```\r\n```sh\r\necho unfinished';
  const { codeBlocks } = renderMarkdown(source);
  assert.equal(codeBlocks[0].text, script);
  assert.deepEqual(classifyCommandBlock(codeBlocks[0]), {
    shell: true, eligible: true, reason: 'eligible', multiline: true, lineCount: 3, risk: '递归删除',
    blockedReasons: [], warnings: [],
  });
  assert.equal(classifyCommandBlock(codeBlocks[1]).reason, 'unsupported-language');
  assert.equal(classifyCommandBlock(codeBlocks[2]).reason, 'unclosed');
});
