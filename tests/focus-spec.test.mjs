// 焦点规范守卫:按钮族只允许一条全局焦点规则,防止各处再写"外圈 + 边框"的双层框。
//
// 背景:按钮自身带 1px 边框,任何额外画在框外的 outline(offset >= 0)在视觉上都是
// "边框 + 隔一道缝的第二圈" —— 用户多次反馈的"双重边框"就是这么来的。规范(见
// src/style.css 顶部与文件末尾「焦点规范」)要求:
//   * 按钮族只有一条规则:`:where(button, [role="menuitem"], summary, [tabindex]:not([tabindex="-1"])):focus-visible`,
//     声明 2px 实线 + outline-offset:-2px(环压住自身边框)。
//   * 组件不得再为按钮写 focus 描边/光晕(会和边框叠成双层框);显式 outline:none
//     的写法同样危险(键盘焦点会彻底看不见),新增前先想清楚为什么全局规则不够。
// 判断"是不是按钮"不能只看选择器写没写 button —— .rp-tab / .btn / .settings-tab
// 这类类名选择器同样落在按钮上,所以这里反着来:除了全局规则与下面这份原生控件
// 白名单,任何 :focus 规则都不许画 outline。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');

// 粗略切规则:样式表里没有嵌套括号写法,足够覆盖本文件的用法。
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().split('\n').pop().trim(),
  body: m[2],
}));

// 原生控件不是"框内有文字"的语义,焦点环允许画在控件外(带 offset)。
const NATIVE_OUTLINE_OK = /\[type=["']?(checkbox|radio|range|file|color)|\.ai-reasoning-slider/;

const globalRule = rules.find(
  (r) => r.selector.includes(':where(button') && r.selector.includes(':focus-visible'),
);

test('按钮族的全局焦点规则存在且为内嵌 2px 实线', () => {
  assert.ok(globalRule, '找不到 :where(button, ...):focus-visible 全局规则');
  assert.match(globalRule.selector, /\[tabindex\]:not\(\[tabindex="-1"\]\)/,
    '全局规则应排除 tabindex="-1"(程序化聚焦落点),否则弹窗容器会被套框');
  const offset = globalRule.body.match(/outline-offset\s*:\s*(-?\d+(?:\.\d+)?)px/);
  assert.ok(offset, '全局规则必须显式声明 outline-offset');
  assert.equal(Number(offset[1]), -2,
    'outline-offset 必须是 -2px(环压住自身 1px 边框);正值会在边框外隔缝再画一圈');
  assert.match(globalRule.body, /outline\s*:\s*2px\s+solid\s+var\(--focus-ring,\s*var\(--accent\)\)/,
    '全局规则必须是 2px 实线,颜色取 --focus-ring(缺省 --accent)');
});

test('除全局规则与原生控件外,没有组件的 :focus 规则再画 outline', () => {
  const offenders = rules.filter((r) => {
    if (r === globalRule) return false;
    if (!r.selector.includes(':focus')) return false;
    if (NATIVE_OUTLINE_OK.test(r.selector)) return false;
    // 只关心真的画线的声明:outline: none / 0 是无害的显式清零
    const outline = r.body.match(/(?:^|[;\s])outline\s*:\s*([^;]+)/);
    if (!outline) return false;
    const value = outline[1].trim();
    return !/^(none|0|medium none)\b/.test(value) && !/^(none|0)\b/.test(value);
  });
  assert.deepEqual(
    offenders.map((r) => r.selector),
    [],
    '按钮/标签的焦点描边只能在全局规则里出现:组件自己的 :focus 描边会与 1px 边框叠成双层框。'
    + '要例外请先改「焦点规范」并把它加进本测试的白名单。',
  );
});

test('实心按钮的环色有明确来源(--focus-ring)', () => {
  const primary = rules.find((r) => r.selector.includes('.btn.primary') && r.body.includes('--focus-ring'));
  const danger = rules.find((r) => r.selector.includes('.btn.danger') && r.body.includes('--focus-ring'));
  assert.ok(primary, '.btn.primary 未声明 --focus-ring(同色环压在实心主色底上看不见)');
  assert.ok(danger, '.btn.danger 未声明 --focus-ring');
  assert.match(primary.body, /--focus-ring\s*:\s*color-mix\(/, '实心按钮的环色应为主色/危险色与白的混合色');
  assert.match(danger.body, /--focus-ring\s*:\s*color-mix\(/);
});
