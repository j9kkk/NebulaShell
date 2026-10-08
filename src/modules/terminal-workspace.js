// Outer tab geometry and mounting. Inner trees and terminal instances are never rewritten.
import { layoutMinSize, paneMinSize, planGrid } from './terminal-layout.js';
import { icon } from '../shared/icons.js';
import { renderSplitTree } from './split-layout-renderer.js';

export const TILE_HEADER_HEIGHT = 28;
export const TILE_BORDER_SIZE = 2;

export function tabMinimum(tab) {
  // Deliberately use the underlying tree, even when a pane is locally zoomed.
  // 叶子按窗格类型取最小尺寸(终端/文件分屏),平铺时标签据此分配空间。
  const minimum = layoutMinSize(tab.layout || { type: 'leaf' }, (leaf) => paneMinSize(tab.panes?.get(leaf.paneId)));
  return { width: minimum.width + TILE_BORDER_SIZE, height: minimum.height + TILE_HEADER_HEIGHT + TILE_BORDER_SIZE };
}

export function workspaceSignature(tabs, width, height) {
  return JSON.stringify([width, height, [...tabs.values()].map((tab) => [tab.id, tabMinimum(tab)])]);
}

export function planWorkspace(tabs, width, height) {
  return planGrid([...tabs.keys()], width, height, 'h', {
    leaf: (tabId) => ({ type: 'leaf', tabId }),
    minimum: (tabId) => tabMinimum(tabs.get(tabId)),
  });
}

export function workspaceMinSize(node, tabs) {
  return layoutMinSize(node, (leaf) => tabMinimum(tabs.get(leaf.tabId)));
}

export function ensureWorkspaceTile(tab, { document, activate, close }) {
  if (tab.workspaceTile) return tab.workspaceTile;
  const tile = document.createElement('section');
  tile.className = 'workspace-tile';
  tile.dataset.tab = tab.id;
  const header = document.createElement('div');
  header.className = 'workspace-tile-header';
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-label', '激活标签');
  const dot = document.createElement('span');
  dot.className = 'workspace-tile-dot tab-dot';
  const title = document.createElement('span');
  title.className = 'workspace-tile-title';
  const closeButton = document.createElement('button');
  closeButton.className = 'workspace-tile-close';
  closeButton.innerHTML = icon('x');
  closeButton.title = '关闭标签';
  closeButton.setAttribute('aria-label', '关闭标签');
  // A close operation on an inactive tile must not first activate it.
  closeButton.addEventListener('mousedown', (event) => event.stopPropagation());
  closeButton.addEventListener('focusin', (event) => event.stopPropagation());
  closeButton.addEventListener('click', (event) => { event.stopPropagation(); close(tab.id); });
  header.addEventListener('mousedown', (event) => { if (!event.target.closest?.('.workspace-tile-close')) activate(tab.id, false); });
  header.addEventListener('click', (event) => { if (!event.target.closest?.('.workspace-tile-close')) activate(tab.id); });
  header.addEventListener('focusin', (event) => { if (!event.target.closest?.('.workspace-tile-close')) activate(tab.id, false); });
  header.addEventListener('keydown', (event) => {
    if (event.target !== header || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); activate(tab.id);
  });
  header.appendChild(dot); header.appendChild(title); header.appendChild(closeButton);
  const content = document.createElement('div');
  content.className = 'workspace-tile-content';
  tile.appendChild(header); tile.appendChild(content);
  tab.workspaceTile = tile;
  tab.workspaceContent = content;
  return tile;
}

export function renderWorkspaceTree(node, tabs, options) {
  return renderSplitTree(node, {
    document: options.document,
    leaf: (leaf) => ensureWorkspaceTile(tabs.get(leaf.tabId), options),
    minimum: (leaf) => tabMinimum(tabs.get(leaf.tabId)),
    divider: (divider) => { divider.className = 'workspace-divider'; },
    nodeClass: 'workspace-split-node',
  });
}

export function syncWorkspaceChrome(tabs, activeTabId) {
  for (const tab of tabs.values()) {
    const tile = tab.workspaceTile;
    if (!tile) continue;
    tile.classList.toggle('active', tab.id === activeTabId);
    const title = tile.querySelector('.workspace-tile-title');
    const label = tab.el.querySelector('.tab-title')?.textContent || '新标签';
    if (title) title.textContent = label;
    const sourceDot = tab.el.querySelector('.tab-dot');
    const status = sourceDot?.className.split(/\s+/).find((name) => name !== 'tab-dot') || 'idle';
    const statusLabel = ({ connected: '已连接', connecting: '连接中', disconnected: '已断开', exited: '已退出', error: '连接错误', idle: '尚未连接' })[status] || status;
    const dot = tile.querySelector('.workspace-tile-dot');
    if (dot) { dot.className = `workspace-tile-dot tab-dot ${status}`; dot.title = statusLabel; dot.setAttribute('aria-label', statusLabel); }
    tile.querySelector('.workspace-tile-header')?.setAttribute('aria-label', `激活标签 ${label},${statusLabel}`);
  }
}
