/// 命令行模型:从终端输入流还原"用户在提示符后提交的那一行"。纯函数模块,
/// 不依赖 DOM / xterm;锚点与回显校验在 terminal.js。
///
/// 只有能从按键精确还原的编辑才改模型文本(可打印字符、退格、Ctrl+U/W、
/// bracketed paste)。光标移动、补全、历史调用、搜索等还原不了的按键把行标记
/// 为 dirty,提交时由调用方改读屏幕。Ctrl+C / Ctrl+G 放弃本行。
///
/// 行对象字段:
///   text        模型文本(粘贴块内的换行保留为 \n)
///   started     本行已开始(首个会改变行状态的输入)
///   dirty       出现过无法还原的按键;cleanPrefix 是第一次变脏前的文本
///   typed       有键盘来源的输入;trusted 有可信来源(历史填入、命令块)的输入
///   lost        行开始后按过 Ctrl+L(屏幕重绘,锚点失效)
///   paste       正处在 bracketed paste 块内
///   pending     跨 chunk 未完整的转义序列,留到下一次输入再解析
///   anchor      调用方在 onStart 里挂上的锚点(本模块不解释)

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function createLine() {
  return { text: '', started: false, dirty: false, typed: false, trusted: false, lost: false,
    paste: false, pending: '', cleanPrefix: null, anchor: null };
}

export function resetLine(line) {
  return Object.assign(line, createLine());
}

/// 解析 s[i] 起的转义序列。返回 { len, kind };序列在 chunk 末尾不完整时返回 null。
function scanEscape(s, i) {
  if (i + 1 >= s.length) return null;
  const c = s[i + 1];
  if (c === '[') {
    let j = i + 2;
    while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
    if (j >= s.length) return null;
    const final = s.charCodeAt(j);
    if (final < 0x40 || final > 0x7e) return { len: j - i, kind: 'other' };
    const body = s.slice(i, j + 1);
    if (body === PASTE_START) return { len: body.length, kind: 'paste-start' };
    if (body === PASTE_END) return { len: body.length, kind: 'paste-end' };
    return { len: body.length, kind: 'csi' };
  }
  if (c === 'O') return i + 2 >= s.length ? null : { len: 3, kind: 'ss3' };
  // ESC 后跟控制字符:单独的 Esc 键,控制字符照常处理
  if (c < ' ' || c === '\x7f') return { len: 1, kind: 'esc' };
  return { len: 2, kind: 'alt' };
}

const dropLastChar = (text) => Array.from(text).slice(0, -1).join('');

/// 喂入一段输入(xterm onData 的一个 chunk)。
/// opts.trusted:输入来自可信来源;opts.onStart(line) 在行开始时调用(调用方挂锚点);
/// opts.onSubmit(item) 在每次回车提交时调用;opts.onAbort(anchor) 在放弃本行时调用。
/// 返回本次产生的提交列表(与 onSubmit 收到的相同,按顺序)。
export function feed(line, data, opts = {}) {
  const submits = [];
  const s = line.pending + String(data ?? '');
  line.pending = '';
  const start = () => {
    if (line.started) return;
    line.started = true;
    opts.onStart?.(line);
  };
  const touch = () => { if (opts.trusted) line.trusted = true; else line.typed = true; };
  const append = (text) => { start(); line.text += text; touch(); };
  const markDirty = () => {
    start();
    touch();
    if (!line.dirty) { line.dirty = true; line.cleanPrefix = line.text; }
  };
  const submit = () => {
    const item = { text: line.text, started: line.started, dirty: line.dirty, typed: line.typed, trusted: line.trusted,
      lost: line.lost, cleanPrefix: line.cleanPrefix ?? line.text, anchor: line.anchor };
    resetLine(line);
    submits.push(item);
    opts.onSubmit?.(item);
  };
  const abort = () => {
    const anchor = line.anchor;
    resetLine(line);
    opts.onAbort?.(anchor);
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (line.paste) {
      // 粘贴块内:文字原样进入本行,回车是块内换行(shell 不会逐行执行);只认结束标记
      if (ch === ESC) {
        const rest = s.slice(i);
        if (rest.startsWith(PASTE_END)) { line.paste = false; i += PASTE_END.length; continue; }
        if (PASTE_END.startsWith(rest)) { line.pending = rest; break; }
        i++;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        append('\n');
        i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (ch === '\t' || (ch >= ' ' && ch !== '\x7f')) append(ch);
      i++;
      continue;
    }
    if (ch === ESC) {
      const seq = scanEscape(s, i);
      if (!seq) { line.pending = s.slice(i); break; }
      if (seq.kind === 'paste-start') { start(); line.paste = true; }
      else if (seq.kind !== 'paste-end') markDirty();
      i += seq.len;
      continue;
    }
    switch (ch) {
      case '\r':
      case '\n':
        submit();
        i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
        continue;
      case '\x7f':
      case '\x08':
        if (line.text) { touch(); line.text = dropLastChar(line.text); }
        break;
      case '\x15': // Ctrl+U:删到行首(光标在行尾即清空)
        if (line.text) { touch(); line.text = ''; }
        break;
      case '\x17': // Ctrl+W:删前一个以空白分隔的词
        if (line.text) { touch(); line.text = line.text.replace(/\S*\s*$/, ''); }
        break;
      case '\x03': // Ctrl+C
      case '\x07': // Ctrl+G
        abort();
        break;
      case '\x0c': // Ctrl+L:清屏重绘。空行上按不影响随后的输入(锚点在下一次输入时才取)
        if (line.started) { line.lost = true; markDirty(); }
        break;
      case '\x04': // Ctrl+D:空行上是 EOF(无命令),行内是删除光标处字符
        if (line.started || line.text) markDirty();
        break;
      default:
        if (ch < ' ') markDirty(); // Tab 补全、Ctrl+A/E/B/F/K/R/P/N/T/Y 等
        else append(ch);
    }
    i++;
  }
  return submits;
}

/// 追加可信文本(历史填入、命令块"仅填入"),换行原样保留。
export function appendTrusted(line, text, opts = {}) {
  const value = String(text ?? '').replace(/\r\n|\r/g, '\n');
  if (!value) return line;
  if (!line.started) {
    line.started = true;
    opts.onStart?.(line);
  }
  line.text += value;
  line.trusted = true;
  return line;
}

/// 命令文本的首个非空行(回显校验用)。
export function firstCommandLine(text) {
  return String(text ?? '').trim().split('\n')[0].trim();
}
