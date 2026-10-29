/// 终端文本工具:去控制序列、从 xterm 缓冲区读回命令行。纯函数,无 DOM 依赖;
/// buffer 参数只需 xterm IBuffer 的 getLine / length,便于单测。

/// 已确认的超长私有序列上限:超过它就不再缓冲,改用占位符。
/// 与 Rust 侧 session_log.rs 的 MAX_PENDING 同值,两端口径必须一致。
export const LONG_SEQ_LIMIT = 4096;

/// 从 iTerm IIP 的 OSC 头还原可读替代文本,如 `[图片 compare.png · 1240B]`。
/// name 是 base64 的 UTF-8;size 是字节数。缺失字段相应省略。
/// 非 IIP 序列返回 null。与 Rust 侧 iip_placeholder 保持同一形状。
export function iipPlaceholder(seq) {
  const rest = String(seq ?? '').replace(/^\x1b\]1337;File=/, '');
  if (rest === String(seq ?? '')) return null;
  const header = rest.split(':')[0];
  let name = '';
  let size = '';
  for (const field of header.split(';')) {
    if (field.startsWith('name=')) {
      try {
        const bytes = Uint8Array.from(atob(field.slice(5)), (c) => c.charCodeAt(0));
        name = new TextDecoder().decode(bytes).replace(/[\x00-\x1f\x7f]/g, '').trim();
      } catch { /* 非法 base64:忽略文件名 */ }
    } else if (field.startsWith('size=')) {
      const v = field.slice(5);
      if (/^\d+$/.test(v)) size = v;
    }
  }
  return `[图片${name ? ` ${name}` : ''}${size ? ` · ${size}B` : ''}]`;
}

/// 流式过滤器:把超长私有序列(内联图片的 base64 等)替换成占位符。
/// 终端输出是分块到达的,序列可能跨块,因此必须持有跨调用的状态。
/// 用途:AI 诊断素材这类"按块累积、只留尾部"的场景 —— 若不过滤,
/// 一张图就能把 6000 字符的采集窗口全部灌满 base64。
export function createSequenceFilter() {
  let pending = '';
  let discarding = false;
  return {
    /// 喂入一块输出,返回可以累积的文本(可能为空串)
    push(chunk) {
      let out = '';
      for (const c of String(chunk ?? '')) {
        if (discarding) {
          if (c === '\x07') discarding = false;
          else if (c === '\x1b') { discarding = false; pending += c; }
          continue;
        }
        if (pending === '') {
          if (c === '\x1b') pending = c;
          else out += c;
          continue;
        }
        pending += c;
        const second = pending[1];
        if (second !== ']' && second !== 'P') {
          out += pending;
          pending = '';
          continue;
        }
        const end = stringEnd(pending);
        if (end >= 0) {
          out += pending.slice(0, end);
          pending = '';
          continue;
        }
        if (pending.length > LONG_SEQ_LIMIT) {
          out += iipPlaceholder(pending) ?? '';
          pending = '';
          discarding = true;
        }
      }
      return out;
    },
    /// 收尾:吐出攒着的半截序列(丢弃/停止时调用)
    flush() {
      const rest = pending;
      pending = '';
      discarding = false;
      return rest;
    },
  };
}

/// OSC/DCS 的终止位置(BEL 或 ST 的 ESC\)。与 Rust 侧 find_string_end 一致。
function stringEnd(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\x07') return i + 1;
    if (s[i] === '\x1b') return i;
  }
  return -1;
}

/// 去掉控制序列与控制字符,保留换行和制表符:CSI(含私有参数)、OSC(BEL 或 ST
/// 结尾)、DCS/SOS/PM/APC(ST 结尾)、SS2/SS3 连同其后一个字符、字符集指定
/// (ESC ( B 等)、其余两字节 ESC 序列(ESC = / ESC 7 …)、8 位 C1 控制字符。
export function stripTerminalNoise(s) {
  return String(s ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[NO][^\x1b]?/g, '')
    .replace(/\x1b[ -/]+[0-~]/g, '')
    .replace(/\x1b[0-~]/g, '')
    .replace(/[\x80-\x9f]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/// 比较用的空白归一:连续空白压成一个空格(制表符在屏幕上展开成若干空格)。
export const normalizeSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/// row 所在逻辑行(自动折行的续行 isWrapped)的最后一行。
export function logicalLineEnd(buffer, row) {
  let end = row;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
  return end;
}

/// zsh RPROMPT:单行、内容贴到右边界(默认留 1 列),且与前文隔着 ≥3 个空格的
/// 最后一段视为右提示符剔除。
function stripRightPrompt(text, startCol, cols) {
  if (!cols || startCol + text.length < cols - 1) return text;
  let cut = -1;
  for (const m of text.matchAll(/ {3,}/g)) cut = m.index;
  return cut > 0 ? text.slice(0, cut).trimEnd() : text;
}

/// 从 row 行 startCol 列起读出一条逻辑行(跨折行拼接),去掉行尾空白与 RPROMPT。
/// 行不存在时返回 null。
export function readCommandFromBuffer(buffer, row, startCol = 0, cols = 0) {
  const first = buffer.getLine(row);
  if (!first) return null;
  const end = logicalLineEnd(buffer, row);
  if (end === row) return stripRightPrompt(first.translateToString(true, startCol), startCol, cols);
  let text = '';
  for (let r = row; r <= end; r++) {
    const line = buffer.getLine(r);
    if (!line) break;
    const from = r === row ? startCol : 0;
    let to = line.length;
    // 宽字符在行尾放不下时留一个空单元,续接时不能当作空格
    if (r < end && line.getCell?.(to - 1)?.getChars() === '') to -= 1;
    text += line.translateToString(r === end, from, to);
  }
  return text.trimEnd();
}

const PROMPT_END = /[$#%>❯➜»]\s*$/;

/// 一行文字是否以"提示符 + 命令"结尾:命令前紧挨着常见的提示符结束符号。
/// 回显位置不确定时(连续输入、提示符被重绘)用它找命令所在行。
export function endsWithCommand(lineText, command) {
  const text = normalizeSpace(lineText);
  const needle = normalizeSpace(command);
  if (!needle || !text.endsWith(needle)) return false;
  return PROMPT_END.test(text.slice(0, text.length - needle.length));
}
