// 极简 Markdown → HTML,专为 AI 助手的输出设计。
//
// 为什么不用第三方库(marked/markdown-it):模型输出是**不可信内容**,渲染进
// innerHTML 前必须先转义;自己实现可以把"先转义、再套结构"的顺序钉死,
// 不必引入 sanitize 依赖。覆盖 AI 回复里实际出现的结构:
// 围栏代码块 / 行内代码 / 标题 / 无序有序列表 / 引用 / 分隔线 / 粗斜体 / 链接。
// 链接只放行 http(s),其余协议(javascript: 等)一律当纯文本。

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 行内语法。入参必须是**已转义**的文本。
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function isListItem(line) {
  return /^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
}

// GFM 表格行:| a | b | 或 a | b(首尾竖线可省,但格内不能有空竖线歧义)
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
const isTableRow = (l) => /^\s*\|?.+\|/.test(l) && l.includes('|');
// 分隔行:| --- | :--: | 至少一个杠,冒号可选(对齐写法)
const isSepRow = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

/// 把一段连续行渲染成一个块;返回 null 表示"这一行我自己处理不了"
function renderBlock(lines) {
  const first = lines[0];
  const heading = /^(#{1,6})\s+(.*)$/.exec(first);
  if (heading) {
    const level = Math.min(heading[1].length + 2, 6); // h3 起步:气泡里 h1 太大
    return `<h${level}>${inline(esc(heading[2]))}</h${level}>`;
  }
  if (/^(-{3,}|\*{3,})\s*$/.test(first)) return '<hr>';
  if (/^>\s?/.test(first)) {
    return `<blockquote>${lines.map((l) => inline(esc(l.replace(/^>\s?/, '')))).join('<br>')}</blockquote>`;
  }
  if (lines.every((l) => /^[-*+]\s+/.test(l))) {
    return `<ul>${lines.map((l) => `<li>${inline(esc(l.replace(/^[-*+]\s+/, '')))}</li>`).join('')}</ul>`;
  }
  if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
    return `<ol>${lines.map((l) => `<li>${inline(esc(l.replace(/^\d+[.)]\s+/, '')))}</li>`).join('')}</ol>`;
  }
  if (lines.every((l) => !isListItem(l) && l.trim() !== '')) {
    return `<p>${lines.map((l) => inline(esc(l))).join('<br>')}</p>`;
  }
  return null;
}

// info 的首个词是语言标签;其余信息也属于 opening fence,不能落回普通文本。
function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
  if (!match) return null;
  return { mark: match[1], language: match[2].trim().split(/[ \t]+/)[0].toLowerCase() };
}

function closesFence(line, mark) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!match && match[1][0] === mark[0] && match[1].length >= mark.length;
}

// 默认渲染始终转义。自定义 renderer 收到未经转义的原文,必须自行安全转义。
// index 从 0 开始;language 是小写标签;closed 仅表示 Markdown 围栏已闭合。
export function renderMarkdown(src, { renderCodeBlock } = {}) {
  // 捕获行尾分隔符,避免接口中的命令原文被 CRLF → LF 或 trim 改写。
  const parts = String(src ?? '').split(/(\r\n|\n)/);
  const rawLines = [];
  for (let n = 0; n < parts.length; n += 2) {
    rawLines.push({ text: parts[n], eol: parts[n + 1] ?? '' });
  }
  const lines = rawLines.map((line) => line.text);
  const out = [];
  const codeBlocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 围栏代码块:``` 或 ~~~ 开头。流式输出时结尾围栏可能还没到 ——
    // 按"未闭合"处理,把剩余内容全部当代码渲染,别把命令原文当 HTML。
    const fence = openingFence(line);
    if (fence) {
      const buf = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i], fence.mark)) {
        buf.push(rawLines[i]);
        i += 1;
      }
      const closed = i < lines.length;
      // 围栏前的最后一个行尾只是正文/围栏分隔符,不属于 text。
      // 未闭合且 EOF 以换行结尾时,split 产生的空行会保留真实尾部换行。
      const text = buf.map((l, n) => l.text + (n < buf.length - 1 ? l.eol : '')).join('');
      const block = { index: codeBlocks.length, language: fence.language, text, closed };
      codeBlocks.push(block);
      if (closed) i += 1;
      out.push(renderCodeBlock
        ? renderCodeBlock(block)
        : `<pre><code>${esc(text.replace(/\r\n/g, '\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '') { i += 1; continue; }
    // GFM 表格:当前行是表格行、下一行是分隔行(| --- |)。表格必须显式
    // 识别 —— 否则 | 报错 | 原因 | 这类内容会整段漏成纯文本。
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const head = splitTableRow(line);
      i += 2; // 跳过表头与分隔行
      const rows = [];
      while (i < lines.length && !openingFence(lines[i]) && isTableRow(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const cell = (c) => `<td>${inline(esc(c))}</td>`;
      const headHtml = `<tr>${head.map((c) => `<th>${inline(esc(c))}</th>`).join('')}</tr>`;
      const bodyHtml = rows
        .map((r) => `<tr>${head.map((_, ci) => cell(r[ci] ?? '')).join('')}</tr>`)
        .join('');
      out.push(`<div class="md-table-wrap"><table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }
    // 就近收集同构块的行:遇到空行/围栏/另一种块首即停。
    // 无序与有序混排时要按类型断开,否则会渲染成一个个孤立的列表。
    const firstIsUl = /^[-*+]\s+/.test(line);
    const firstIsOl = /^\d+[.)]\s+/.test(line);
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !openingFence(lines[i])
      && !/^(#{1,6})\s/.test(lines[i])) {
      if (firstIsUl && !/^[-*+]\s+/.test(lines[i])) break;
      if (firstIsOl && !/^\d+[.)]\s+/.test(lines[i])) break;
      buf.push(lines[i]);
      i += 1;
    }
    const html = renderBlock(buf);
    if (html) { out.push(html); continue; }
    // 混合行(如列表中混着普通行):逐行当段落
    out.push(buf.map((l) => (isListItem(l)
      ? `<ul><li>${inline(esc(l.replace(/^[-*+]\s+/, '')))}</li></ul>`
      : `<p>${inline(esc(l))}</p>`)).join(''));
  }
  return { html: out.join(''), codeBlocks };
}

// 兼容现有调用方,不启用命令操作 UI。
export function mdToHtml(src) {
  return renderMarkdown(src).html;
}
