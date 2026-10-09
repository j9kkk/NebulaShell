/// 终端文本工具:去控制序列、从 xterm 缓冲区读回命令行。纯函数,无 DOM 依赖;
/// buffer 参数只需 xterm IBuffer 的 getLine / length,便于单测。

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
