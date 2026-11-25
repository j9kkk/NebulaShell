#!/usr/bin/env node
// 主题参数的客观体检：对比度 + 表面台阶。
//
//   node scripts/token-contrast.mjs                 体检当前 src/style.css
//   node scripts/token-contrast.mjs cand-a.css …    把候选覆盖叠在基线上再体检
//
// 为什么要这个脚本：换皮时「看着还行」不算数 —— 暗色下 10px 辅助字最容易踩
// 4.5:1 的边缘(历史遗留问题)，而表面台阶差不到 3 个 L* 时人眼分不出层级，
// 却又会在截图上显得「发灰、脏」。这两类问题都能用数字卡住，不必靠人反复看。
//
// 阈值(可调，但下调必须在 PR 里写理由):
//   正文/辅助文字 → 所在表面 ≥ 4.5:1（WCAG AA 常规字号）
//   强调块上的反白 → 强调色 ≥ 4.5:1
//   相邻表面 L* 台阶 ≥ 3（不足则两者视觉上黏在一起）
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = `${ROOT}src/style.css`;

function readTokens(css) {
  // 取出某个 token 块（选择器精确匹配，块内只认 --x: value）
  const grab = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) return {};
    let d = 0, j = css.indexOf('{', i), end = -1;
    for (let k = j; k < css.length; k++) {
      if (css[k] === '{') d++;
      else if (css[k] === '}') { d--; if (d === 0) { end = k; break; } }
    }
    const body = css.slice(j + 1, end);
    const out = {};
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  return {
    dark: grab(':root, [data-theme="nebula"] {'),
    light: grab('[data-theme="light"] {'),
  };
}

const overrides = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const base = readTokens(readFileSync(BASE, 'utf8'));
for (const f of overrides) {
  if (!existsSync(f)) { console.error(`找不到 ${f}`); process.exit(2); }
  const o = readTokens(readFileSync(f, 'utf8'));
  Object.assign(base.dark, o.dark);
  Object.assign(base.light, o.light);
}

/* ---------- 颜色计算 ---------- */
const NAMED = { transparent: null, none: null };
function parseColor(v) {
  if (!v) return null;
  v = v.trim();
  if (v in NAMED) return NAMED[v];
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.some(Number.isNaN)) return null;
    // rgba 按 alpha 与白/黑背景合成太依赖场景，这里只取 alpha=1 的值
    if (p.length >= 4 && p[3] < 0.999) return null;
    return p.slice(0, 3).map((x) => x / 255);
  }
  return null;
}
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => {
  if (!a || !b) return null;
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// CIE L*（感知明度）
const lstar = ([r, g, b]) => {
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};

/* ---------- 体检项 ---------- */
const SURFACES = ['--bg', '--panel', '--bg2', '--field'];
const find = (t, name) => (t[name] ? parseColor(t[name]) : null);

let bad = 0;
const rows = [];
const step = (label, a, b, min) => {
  const c = contrast(a, b);
  if (c == null) return rows.push({ label, value: '跳过(含 alpha 或未定义)', ok: true });
  const ok = c >= min;
  if (!ok) bad++;
  rows.push({ label, value: `${c.toFixed(2)}:1`, min: `${min}:1`, ok });
};

for (const theme of ['dark', 'light']) {
  const t = base[theme];
  const bg = find(t, '--bg');
  process.stdout.write(`\n${theme === 'dark' ? '暗色' : '亮色'}\n`);
  const local = [];
  for (const s of SURFACES) {
    if (!t[s]) continue;
    step(`${'--text'.padEnd(15)} on ${s.padEnd(7)}`, find(t, '--text'), find(t, s), 4.5);
    step(`${'--muted'.padEnd(15)} on ${s.padEnd(7)}`, find(t, '--muted'), find(t, s), 4.5);
  }
  step(`${'--text-on-accent'.padEnd(15)} on --accent`, find(t, '--text-on-accent'), find(t, '--accent'), 4.5);
  step(`${'--text-on-accent'.padEnd(15)} on --danger`, find(t, '--text-on-accent'), find(t, '--danger'), 4.5);
  // 表面台阶
  const present = SURFACES.filter((s) => parseColor(t[s]));
  const Ls = present.map((s) => lstar(parseColor(t[s])));
  for (let i = 1; i < present.length; i++) {
    const d = Math.abs(Ls[i] - Ls[i - 1]);
    const ok = d >= 3;
    if (!ok) bad++;
    local.push({ label: `${present[i - 1]} → ${present[i]} 的 L* 台阶`, value: d.toFixed(1), min: '3.0', ok });
  }
  for (const r of rows.splice(0)) local.push(r);
  for (const r of local) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}  ${r.value}${r.min ? `  (要求 ≥${r.min})` : ''}`);
  }
}

console.log(`\n${bad ? `✗ ${bad} 项未达标` : '✓ 全部达标'}`);
process.exit(bad ? 1 : 0);
