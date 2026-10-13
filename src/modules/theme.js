// 统一配色主题系统:单一事实源、DOM 与终端协同切换、状态驱动
import { state } from './core.js';

export const THEMES = [
  { id: 'nebula', label: '星云暗（默认）' },
  { id: 'light', label: '日蚀亮' },
];

export const v = (n, f) => (typeof document !== 'undefined' && document.documentElement ? (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || f : f);

export const TERM_THEMES = {
  nebula: () => ({
    background: v('--bg', '#0d1117'),
    foreground: v('--text', '#e6edf3'),
    cursor: '#5b8cff',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(91,140,255,0.35)',
    black: '#0d1117',
    brightBlack: '#57606f',
    green: '#3ddc97',
    brightGreen: '#69f0ae',
    blue: '#5b8cff',
    brightBlue: '#79a2ff',
    red: '#ff6b6b',
    brightRed: '#ff8a8a',
    yellow: '#ffc24b',
    brightYellow: '#ffd37a',
    cyan: '#4dd0e1',
    magenta: '#c792ea',
    white: '#e6edf3',
  }),
  light: () => ({
    background: '#f6f8fa',
    foreground: '#1f2328',
    cursor: '#0969da',
    cursorAccent: '#f6f8fa',
    selectionBackground: 'rgba(9,105,218,0.25)',
    black: '#1f2328',
    brightBlack: '#6e7781',
    green: '#116329',
    brightGreen: '#1a7f37',
    blue: '#0969da',
    brightBlue: '#218bff',
    red: '#cf222e',
    brightRed: '#a40e26',
    yellow: '#9a6700',
    brightYellow: '#bf8700',
    cyan: '#1b7c83',
    magenta: '#8250df',
    white: '#f6f8fa',
  }),
};

export function termTheme(themeKey, stateRef = state) {
  const key = themeKey || (stateRef && stateRef.settings && stateRef.settings.terminal && stateRef.settings.terminal.theme) || 'nebula';
  return (TERM_THEMES[key] || TERM_THEMES.nebula)();
}

/// 一键切换主题:同步更新 DOM 根节点 data-theme 属性与所有活动终端实例的渲染主题
export function applyTheme(themeKey, stateRef = state) {
  const target = themeKey || (stateRef && stateRef.settings && stateRef.settings.terminal && stateRef.settings.terminal.theme) || 'nebula';
  const resolved = TERM_THEMES[target] ? target : 'nebula';
  if (typeof document !== 'undefined' && document.documentElement) {
    if (!document.documentElement.dataset) document.documentElement.dataset = {};
    document.documentElement.dataset.theme = resolved;
  }
  const themeObj = termTheme(resolved, stateRef);
  if (stateRef && stateRef.sessions) {
    for (const s of stateRef.sessions.values()) {
      try {
        if (s.term && s.term.options) {
          s.term.options.theme = themeObj;
        }
      } catch { /* ignore */ }
    }
  }
  return resolved;
}
