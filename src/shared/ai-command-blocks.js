// 仅分类,不执行、不改写原文。eligible 不是 shell 语法校验或安全保证。
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'zsh', 'shell']);
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)/;
// 仅提示明显示例参数,不把任意 {{...}} 当成占位符或解析模板语义。
const WRAPPED_PLACEHOLDER = /<\s*(?:(?:YOUR|INSERT|REPLACE|CHANGE)[_ -][A-Z0-9_ -]+|HOST|HOSTNAME|IP|IP_ADDRESS|USER|USERNAME|PASSWORD|TOKEN|API_KEY|PATH|FILE|DIRECTORY|PORT|COMMAND|REPLACE_ME)\s*>|\{\{\s*(?:YOUR_[A-Z0-9_]+|REPLACE_ME)\s*\}\}/gi;
// 正常变量引用/赋值、字段 .YOUR_HOST 和文件名 YOUR_HOST.txt 不作示例猜测。
const BARE_PLACEHOLDER = /(?<![\w$.-])(?<!\$\{)(?<!\$\{[!#])(?:YOUR_[A-Z0-9_]+|REPLACE_ME)(?![\w.-])(?![ \t]*(?:\+?=|\[[^\]\n]*\][ \t]*=))/g;
const PROMPT = /^[ \t]*(?:\$(?:[ \t]+|$)|(?:\[[^\]\r\n]*[\w.-]+@[\w.-]+[^\]\r\n]*\]|[\w.-]+@[\w.-]+[^\r\n$#]*?)\s*[$#](?:[ \t]+|$))/;

// 有限的 here-doc 边界识别,不是完整 shell parser。去除 delimiter 的引号/
// 转义,支持 <<EOF、<<'EOF'、<<-EOF、多 here-doc;正文不做提示符/占位符匹配。
function readDelimiter(line, start) {
  let i = start;
  while (/[ \t]/.test(line[i] ?? '') && i < line.length) i += 1;
  let delimiter = '', quote = '', seen = false;
  for (; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\' && quote !== "'") {
      if (i + 1 >= line.length) return null;
      delimiter += line[++i]; seen = true;
    } else if (quote) {
      if (c === quote) quote = '';
      else delimiter += c;
    } else if (c === "'" || c === '"') {
      quote = c; seen = true;
    } else if (/[\s;&|<>()]/.test(c)) {
      break;
    } else {
      delimiter += c; seen = true;
    }
  }
  return seen && !quote ? { delimiter, end: i } : null;
}

function inspectLine(line) {
  const hereDocs = [];
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\' && quote !== "'") { i += 1; continue; }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    // 普通注释既不是 root 提示符,也不参与占位符和风险匹配。
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) {
      return { code: line.slice(0, i), hereDocs };
    }
    // 算术位移不是重定向;这里只识别同一行的常见算术表达式。
    if (line.startsWith('$((', i) || line.startsWith('((', i)) {
      const end = line.indexOf('))', i + 2);
      if (end !== -1) { i = end + 1; continue; }
    }
    if (line.startsWith('<<<', i)) { i += 2; continue; } // here-string
    if (!line.startsWith('<<', i)) continue;
    const stripTabs = line[i + 2] === '-';
    const word = readDelimiter(line, i + (stripTabs ? 3 : 2));
    if (word) {
      hereDocs.push({ delimiter: word.delimiter, stripTabs });
      i = word.end - 1;
    }
  }
  return { code: line, hereDocs };
}

function inspectionView(text) {
  const pending = [], code = [];
  let prompt = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (pending.length) {
      const { delimiter, stripTabs } = pending[0];
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) pending.shift();
      continue;
    }
    if (PROMPT.test(line)) prompt = true;
    const inspected = inspectLine(line);
    code.push(inspected.code);
    pending.push(...inspected.hereDocs);
  }
  return { code: code.join('\n'), prompt };
}

// 提醒用的启发式,不拦截风险命令。空字符串仅表示未发现这些明显模式。
// 多个提示用中文分号连接;不声称涵盖所有危险操作。
function riskHint(code) {
  const hints = [];
  const text = code.replace(/\\\n/g, ' ');
  const rmCommands = text.matchAll(/\brm[ \t]+([^\n;&|]*)/g);
  if ([...rmCommands].some((match) => /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$)/i.test(match[1]))) {
    hints.push('递归删除');
  }
  if (/\b(?:mkfs(?:\.[\w-]+)?|mkswap)(?=\s|$)|\bdiskutil\s+(?:eraseDisk|eraseVolume|partitionDisk)\b/i.test(text)) {
    hints.push('磁盘格式化');
  }
  if (/\bdd\s+[^\n;&|]*\bof\s*=\s*["']?\/dev\//.test(text)) {
    hints.push('dd 写入设备');
  }
  if (/\b(?:curl|wget)\b[^;\n]*\|\s*(?:(?:sudo|env)\s+(?:-[\w-]+\s+)*)?(?:\/[\w./-]+\/)?(?:sh|bash|zsh)\b/.test(text)) {
    hints.push('下载内容直接交给 shell');
  }
  return hints.join('；');
}

function placeholderWarnings(code) {
  const tokens = new Set(), wrapped = [];
  for (const match of code.matchAll(WRAPPED_PLACEHOLDER)) {
    wrapped.push({ start: match.index, end: match.index + match[0].length });
    tokens.add(match[0]);
  }
  for (const match of code.matchAll(BARE_PLACEHOLDER)) {
    // 同一 wrapped 标记只提示一次,不要再提示内部的裸参数名。
    if (wrapped.some(({ start, end }) => match.index >= start && match.index < end)) continue;
    tokens.add(match[0]);
  }
  return [...tokens].map((token) => ({
    kind: 'suspected-placeholder',
    token,
    message: '该命名通常用于需要用户填写的示例参数，请确认其含义',
  }));
}

// reason 是首个 blockedReason 或 eligible;内容提醒不参与结构阻断。
// blockedReasons 稳定值: unsupported-language / unclosed / empty /
// control-character / shell-prompt。
// lineCount 计入保留的空行(空 text 为 0),multiline 等于 lineCount > 1。
export function classifyCommandBlock(block) {
  const shell = SHELL_LANGUAGES.has(String(block?.language ?? '').trim().toLowerCase());
  const text = typeof block?.text === 'string' ? block.text : '';
  const lineCount = text === '' ? 0 : text.split(/\r\n|\n|\r/).length;
  const view = inspectionView(text);
  const blockedReasons = [];
  if (!shell) blockedReasons.push('unsupported-language');
  if (block?.closed !== true) blockedReasons.push('unclosed');
  if (text.trim() === '') blockedReasons.push('empty');
  if (CONTROL.test(text)) blockedReasons.push('control-character');
  if (shell && view.prompt) blockedReasons.push('shell-prompt');
  return {
    shell,
    eligible: blockedReasons.length === 0,
    reason: blockedReasons[0] ?? 'eligible',
    multiline: lineCount > 1,
    lineCount,
    risk: shell ? riskHint(view.code) : '',
    blockedReasons,
    warnings: shell ? placeholderWarnings(view.code) : [],
  };
}
