import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, TERM_THEMES, termTheme, applyTheme, v } from '../src/modules/theme.js';

test('THEMES 提供标准的三套主题定义', () => {
  assert.equal(THEMES.length, 3);
  const ids = THEMES.map((t) => t.id);
  assert.deepEqual(ids, ['nebula', 'light', 'forest']);
});

test('termTheme 按键名正确解析各主题调色板', () => {
  const nebula = termTheme('nebula');
  assert.equal(nebula.cursor, '#5b8cff');

  const light = termTheme('light');
  assert.equal(light.cursor, '#0969da');
  assert.equal(light.background, '#f6f8fa');

  const forest = termTheme('forest');
  assert.equal(forest.cursor, '#34d399');
  assert.equal(forest.background, '#0b1f16');

  // 未知主题回退到 nebula
  const fallback = termTheme('non-existent');
  assert.equal(fallback.cursor, '#5b8cff');
});

test('termTheme 读取 state.settings.terminal.theme', () => {
  const mockState = {
    settings: {
      terminal: { theme: 'light' },
    },
  };
  const theme = termTheme(null, mockState);
  assert.equal(theme.background, '#f6f8fa');
});

test('applyTheme 同步更新 document.dataset.theme 与所有活跃会话', () => {
  const dummyDoc = {
    documentElement: {
      dataset: {},
      style: {},
    },
  };
  globalThis.document = dummyDoc;

  const mockSession1 = {
    term: { options: { theme: null } },
  };
  const mockSession2 = {
    term: { options: { theme: null } },
  };
  const mockState = {
    sessions: new Map([
      ['s1', mockSession1],
      ['s2', mockSession2],
    ]),
    settings: { terminal: { theme: 'nebula' } },
  };

  const applied = applyTheme('forest', mockState);
  assert.equal(applied, 'forest');
  assert.equal(dummyDoc.documentElement.dataset.theme, 'forest');
  assert.equal(mockSession1.term.options.theme.cursor, '#34d399');
  assert.equal(mockSession2.term.options.theme.cursor, '#34d399');

  delete globalThis.document;
});

test('style.css 包含完整的三套主题定义与核心语义变量', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

  // 必须声明的三套主题选择器
  assert.match(css, /\[data-theme="nebula"\]/);
  assert.match(css, /\[data-theme="light"\]/);
  assert.match(css, /\[data-theme="forest"\]/);

  // 核心语义变量在三套主题中均有定义
  const requiredTokens = [
    '--bg:', '--bg2:', '--panel:', '--border:', '--border-hover:',
    '--text:', '--muted:', '--accent:', '--accent2:', '--danger:', '--warn:',
    '--titlebar-bg:', '--color-scheme:', '--surface-hover:', '--hover-bg:',
    '--active-bg:', '--btn-primary-bg:', '--btn-primary-text:',
    '--ai-user-bubble:', '--ai-user-text:', '--modal-backdrop:',
    '--card-shadow:', '--menu-shadow:', '--scrollbar-thumb-hover:',
  ];

  for (const token of requiredTokens) {
    const matches = css.match(new RegExp(token.replace(':', '\\:'), 'g')) || [];
    assert.ok(matches.length >= 3, `变量 ${token} 必须在全部三套主题中定义 (当前出现 ${matches.length} 次)`);
  }
});
