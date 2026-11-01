// CSS 契约检查(零依赖):把「UI 布局契约」里能静态判定的规则落成可执行检查。
// 用法:
//   node scripts/lint-css-contract.mjs              报告(warn 不阻断)
//   node scripts/lint-css-contract.mjs --strict     有 warn 即失败(供将来接门禁)
//   node scripts/lint-css-contract.mjs --quiet      只打印汇总
//
// 命名依据 docs/ui-layout-contract.md 的 R1/R1b/R4/R5。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');
// 检查面:只扫手写样式,产物(dist/)与依赖不参与
const targets = files.length ? files : ['src/style.css'];

/* ---------------- 极简 CSS 扫描器 ---------------- */

/// 去掉注释与字符串内容,但保留换行(否则行号会整体漂移)
function blank(text) {
  let out = '';
  const keepNewlines = (chunk) => chunk.replace(/[^\n]/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      if (j < 0) j = text.length;
      out += keepNewlines(text.slice(i, j + 2));
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += c + keepNewlines(text.slice(i + 1, j)) + (text[j] === c ? c : '');
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

/// 扫描出所有「声明」及其所在的规则链(用于判断 :root / @media / 平台作用域)
function scan(css) {
  const clean = blank(css);
  const lineOf = (idx) => clean.slice(0, idx).split('\n').length;
  const decls = [];
  const stack = []; // { selector | atrule }
  let buf = '';
  let bufStart = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '{') {
      const head = buf.trim();
      stack.push({ head, start: bufStart, isAt: head.startsWith('@') });
      buf = ''; bufStart = i + 1;
    } else if (c === '}') {
      flushDecls(buf, bufStart, stack, decls, lineOf);
      buf = ''; bufStart = i + 1;
      stack.pop();
    } else if (c === ';') {
      flushDecls(buf + ';', bufStart, stack, decls, lineOf);
      buf = ''; bufStart = i + 1;
    } else {
      buf += c;
    }
  }
  return decls;
}

function flushDecls(chunk, start, stack, out, lineOf) {
  const text = chunk.trim();
  if (!text || text.startsWith('@')) return;
  const selectorFrames = stack.filter((f) => !f.isAt);
  if (!selectorFrames.length) return; // 顶层垃圾
  const selector = selectorFrames.map((f) => f.head.trim()).join(' ');
  const atrules = stack.filter((f) => f.isAt).map((f) => f.head.trim());
  // 一个块里可能有多条声明,按位置逐条定位
  let cursor = start;
  for (const part of text.split(';')) {
    const raw = part.trim();
    cursor = start + (chunk.indexOf(part, Math.max(0, cursor - start)) | 0);
    if (!raw || !raw.includes(':')) continue;
    const idx = raw.indexOf(':');
    const prop = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!prop) continue;
    out.push({ prop, value, selector, atrules, line: lineOf(start), frame: stack.length });
  }
}

/* ---------------- 规则 ---------------- */

const COLOR_LITERAL = /(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:red|blue|green|white|black|gray|grey|yellow|orange|purple)\b)/;
const PLATFORM_SCOPE = /platform-(?:darwin|nonmacos)/;
const COLOR_PROPS = new Set(['color', 'background', 'background-color', 'border-color', 'border-top-color',
  'border-bottom-color', 'border-left-color', 'border-right-color', 'outline-color', 'fill', 'stroke',
  'box-shadow', 'text-shadow', 'caret-color', 'text-decoration-color']);
const SIZING_PROPS = new Set(['width', 'height', 'padding', 'padding-top', 'padding-bottom', 'padding-left',
  'padding-right', 'padding-inline', 'padding-block', 'margin', 'margin-top', 'margin-bottom',
  'margin-left', 'margin-right', 'gap', 'row-gap', 'column-gap', 'border-radius']);
const VAR_OK = /^var\(--/;

const rules = [
  {
    // R4:颜色必须来自 token(自定义属性定义处豁免)
    id: 'token-color',
    level: 'warn',
    check: ({ prop, value }) => {
      if (!COLOR_PROPS.has(prop)) return null;
      if (VAR_OK.test(value) || /^(transparent|inherit|currentColor|none|unset|initial)$/i.test(value)) return null;
      if (/^var\(/.test(value)) return null;
      const m = COLOR_LITERAL.exec(value);
      return m ? `颜色字面量 ${m[1]} —— 改用 var(--…)` : null;
    },
  },
  {
    // R4:圆角必须来自 token(0/50%/inherit 例外,胶囊也是 token)
    id: 'token-radius',
    level: 'warn',
    check: ({ prop, value }) => {
      if (prop !== 'border-radius') return null;
      if (/^var\(|^(0|50%|inherit|none|unset)$/.test(value)) return null;
      return `圆角裸值 ${value} —— 改用 var(--radius-*)`;
    },
  },
  {
    // R5:平台特值只允许出现在 platform-* 作用域
    id: 'platform-scope',
    level: 'warn',
    check: ({ prop, value, selector, atrules }) => {
      const inPlatform = PLATFORM_SCOPE.test(selector) || atrules.some((a) => PLATFORM_SCOPE.test(a));
      if (inPlatform) return null;
      if (/\b(999px|9999px)\b/.test(value)) return `${prop}: ${value} 是胶囊尺寸,应走平台 token 覆盖层`;
      return null;
    },
  },
  {
    // R5:@media 里不写尺寸(尺寸差异归 platform-* 覆盖层)
    id: 'media-sizing',
    level: 'warn',
    check: ({ prop, atrules, selector }) => {
      // 只有"尺寸查询"才算:prefers-reduced-motion / hover / pointer 这类不是布局断点
      const sizeQuery = atrules.some((a) => a.startsWith('@media') && /(min|max)-(width|height)/.test(a));
      if (!sizeQuery) return null;
      if (PLATFORM_SCOPE.test(selector)) return null;
      if (!SIZING_PROPS.has(prop)) return null;
      return `@media 内声明 ${prop} —— 尺寸差异请移到 platform-* 覆盖层`;
    },
  },
  {
    // R5:平台选择器必须集中在文件末尾的「平台覆盖层」段落(R5 的守门规则)
    id: 'platform-section',
    level: 'warn',
    check: ({ selector, atrules, prop, sectionLine, line }) => {
      if (prop.startsWith('--')) return null;
      const hit = PLATFORM_SCOPE.test(selector) || atrules.some((a) => PLATFORM_SCOPE.test(a));
      if (!hit) return null;
      if (!Number.isFinite(sectionLine)) return '未找到「平台覆盖层」段落标记 —— 平台差异必须集中归档';
      if (line >= sectionLine) return null;
      return `平台选择器出现在「平台覆盖层」段落之外(第 ${line} 行 < ${sectionLine} 行)`;
    },
  },
  {
    // R1:td/th/li 上画线需确认「数据槽位只放数据行」;值必须是变量或 none/0
    id: 'row-decoration',
    level: 'info',
    check: ({ prop, value, selector }) => {
      if (!/^(border|border-top|border-bottom|border-left|border-right)$/.test(prop)) return null;
      if (!/\b(td|th|li)\b/.test(selector)) return null;
      if (/^(none|0)$|^var\(--/.test(value.trim())) return null;
      return `${selector} 上的 ${prop} 为字面量;行级装饰应走 token,且必须保证空态不占行槽位`;
    },
  },
];

/* ---------------- 执行 ---------------- */

let total = 0;
const byRule = new Map();
const findings = [];
for (const rel of targets) {
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!fs.existsSync(file)) { console.error(`[css-contract] 跳过不存在的文件 ${rel}`); continue; }
  const css = fs.readFileSync(file, 'utf8');
  const decls = scan(css);
  // 「平台覆盖层」段落起始行:平台选择器只允许出现在此行之后(见 R5)
  const markIdx = css.indexOf('平台覆盖层');
  const sectionLine = markIdx < 0 ? Infinity : css.slice(0, markIdx).split('\n').length;
  for (const d of decls) d.sectionLine = sectionLine;
  for (const d of decls) {
    // token 定义处(:root 里的 --x)是唯一允许出现裸值的地方
    if (d.prop.startsWith('--') || /^:root\b|^html\b/.test(d.selector)) continue;
    for (const rule of rules) {
      const msg = rule.check(d);
      if (!msg) continue;
      findings.push({ rule: rule.id, level: rule.level, file: rel, line: d.line, selector: d.selector, prop: d.prop, value: d.value, msg });
      byRule.set(rule.id, (byRule.get(rule.id) || 0) + 1);
      total++;
    }
  }
}

const counts = { error: 0, warn: 0, info: 0 };
for (const f of findings) counts[f.level]++;

if (!quiet) {
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || a.line - b.line);
  // 默认每规则只展示前几条(存量待收敛),--all 看全量
  const showAll = process.argv.includes('--all');
  const perRule = new Map();
  let shown = 0;
  for (const f of findings) {
    const n = perRule.get(f.rule) || 0;
    if (!showAll && n >= 5) { perRule.set(f.rule, n + 1); continue; }
    perRule.set(f.rule, n + 1);
    shown++;
    console.log(`${f.level.padEnd(5)} ${f.file}:${f.line}  [${f.rule}] ${f.prop}: ${f.value}`);
    console.log(`      ${f.selector}`);
    console.log(`      → ${f.msg}`);
  }
  if (shown < findings.length) console.log(`\n(还有 ${findings.length - shown} 条未展示,加 --all 看全量)`);
}

console.log(`\n[css-contract] ${targets.join(', ')} — error ${counts.error} / warn ${counts.warn} / info ${counts.info}`);
for (const [id, n] of byRule) console.log(`  ${id.padEnd(16)} ${n}`);
if (strict && (counts.error || counts.warn)) process.exit(1);
