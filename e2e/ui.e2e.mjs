// NebulaShell UI 端到端测试(驱动 Tauri 应用的真实 webview)
//
// 机制:以 NEBULA_TEST=1 启动应用,它会开一个本地 HTTP 测试桥(src-tauri/src/bridge.rs)。
// POST /eval 注入 JS 到 webview,结果经 Tauri invoke 回传;GET /result/{id} 取回。
//
// 前置:先构建 Rust 二进制(npm run build:web && cd src-tauri && cargo build)
// 用法:node e2e/ui.e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSshd } from './helpers/ssh-server.mjs';
import { AI_COMMAND_BLOCKS, startMockCloudServer, startMockAiServer } from './helpers/mock-servers.mjs';
import { auditNarrowPanels, auditTerminalViewport } from './helpers/layout-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 的 cargo 产物带 .exe 后缀,按平台补齐。
// 可用 NEBULA_E2E_BIN 指定被测二进制(例如直接回归已安装版本:
//   NEBULA_E2E_BIN="C:\Users\user\AppData\Local\NebulaShell\nebulashell.exe" node e2e/ui.e2e.mjs
// ),用户数据仍走本套件自建的临时目录,不触碰真实配置。
const BIN = process.env.NEBULA_E2E_BIN
  || path.join(root, 'src-tauri/target/debug/nebulashell' + (process.platform === 'win32' ? '.exe' : ''));
const PASSWORD = 'ui-e2e-pass';
// 版本号从配置读,避免每发一版都要改测试(T2 断言用)
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
).version;

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let proc = null;
let sshd = null;
let sshd2 = null;
let tileSshd = null;
let sshConnectionsOpened = 0;
const countSshConnections = (kind, delta) => { if (kind === 'client' && delta > 0) sshConnectionsOpened += delta; };
let cloud = null;
let ai = null;
let bridge = 0;
let work = null;
let userData = null;
const appLogs = [];
const results = [];
let seq = 0;

const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? PASS : FAIL} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: bridge, path: p, method, timeout: timeoutMs, headers: { Connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('http timeout')));
    if (body) r.write(body);
    r.end();
  });
}

const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function evalJs(js, timeout = 15000) {
  const id = `e${++seq}`;
  await req('POST', '/eval', JSON.stringify({ id, js }));
  const t0 = Date.now();
  for (;;) {
    const r = await req('GET', `/result/${id}`).catch(() => null);
    if (r && r.status === 200) {
      const v = JSON.parse(r.body).value;
      if (typeof v === 'string' && v.startsWith('ERR:')) throw new Error(v.slice(5));
      return v;
    }
    if (Date.now() - t0 > timeout) throw new Error('eval 超时: ' + js.slice(0, 70));
    await sleep(120);
  }
}

async function waitEval(js, needle, timeout = 20000) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    try { last = String(await evalJs(js, 6000)); } catch { /* 重试 */ }
    if (last.includes(needle)) return last;
    if (Date.now() - t0 > timeout) throw new Error(`等待「${needle}」超时,当前: ${last.slice(0, 180)}`);
    await sleep(250);
  }
}

/// 回答应用内输入框(askPrompt),并把"输入是否真被接受"变成被检验的事实。
/// 为什么不能"填一次就假定成功":askPrompt 建弹窗时会 `input.value = ''`,
/// 若填值落在弹窗重建的那一瞬,值会被清空 —— 校验(如"两次口令不一致")随即
/// 静默拒绝、弹窗停留不放,后续整条流程卡死(表现为超时,且当前标题仍是
/// 上一个弹窗的,例如"等 输入解密口令 却看到 确认口令")。
/// 判据用**标题**而非"弹窗是否可见":确认口令框会在上一个答完后立刻接棒,
/// 用可见性判断会把"换成了下一个框"误判成"这一个没答上"。
async function answerPrompt(value, expectTitle, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await waitEval(`window.__nbTest.promptOpen()`, 'true', 10000);
    await waitEval(`window.__nbTest.promptTitle()`, expectTitle, 10000);
    await evalJs(`window.__nbTest.promptFill(${JSON.stringify(value)}); window.__nbTest.promptClickOk(); return 1`);
    // 等它确实离开:标题变了(接棒下一个)或整框收起(流程结束)都算成功
    const t0 = Date.now();
    for (;;) {
      const st = asObj(await evalJs(`return JSON.stringify({ open: window.__nbTest.promptOpen(), title: window.__nbTest.promptTitle() })`));
      if (!st.open || st.title !== expectTitle) return;
      if (Date.now() - t0 > 2000) break; // 仍在原框上:再试一次
      await sleep(150);
    }
  }
  throw new Error(`输入框「${expectTitle}」未被接受(值可能被弹窗重建清空)`);
}

// Bridge events are untrusted: WebView does not perform native button activation.
// Emulate that default only for an uncancelled Enter on the current visible button;
// arrows/Escape/Tab and dialog Enter always go through the real app listeners.
async function focusedKey(key, options = {}) {
  return asObj(await evalJs(`return JSON.stringify((() => {
    const target = document.activeElement;
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ${JSON.stringify(key)}, ...${JSON.stringify(options)} });
    target.dispatchEvent(event);
    if (event.key === 'Enter' && !event.defaultPrevented && !event.isComposing
        && target.matches('button:not(:disabled)') && target.getClientRects().length
        && !target.closest('.hidden, [inert]') && document.activeElement === target) target.click();
    return { prevented: event.defaultPrevented, focus: document.activeElement?.id || '', menuOpen: !document.querySelector('#more-menu').classList.contains('hidden') };
  })())`));
}

// Select a visible paged-menu route through its keyboard navigation, not hidden .click().
async function menuFocus(selector) {
  for (let i = 0; i < 24; i++) {
    const state = asObj(await evalJs(`return JSON.stringify({ found: document.activeElement.matches(${JSON.stringify(selector)}),
      hidden: document.querySelector('#more-menu').classList.contains('hidden'),
      startupBlur: window.__menuTrace?.some(x => x.type === 'blur' && x.at >= window.__e2eMenuOpenAt),
      retried: !!window.__e2eStartupBlurRetried })`));
    if (state.found) return;
    // A late native launch blur legitimately dismisses the popup; retry once only
    // when that external focus transition was observed after this open.
    if (state.hidden && state.startupBlur && !state.retried) {
      await evalJs(`window.__e2eStartupBlurRetried = true; document.querySelector('#btn-more').click(); return 1`);
      continue;
    }
    await focusedKey('ArrowDown');
  }
  const detail = await evalJs(`return JSON.stringify({ focus: document.activeElement?.outerHTML, documentFocused: document.hasFocus(), trace: window.__menuTrace, menuHidden: document.querySelector('#more-menu').classList.contains('hidden'), modal: [...document.querySelectorAll('.modal:not(.hidden), dialog[open]')].map(x => x.id) })`);
  throw new Error('菜单键盘无法到达: ' + selector + ' — ' + detail);
}

async function openMenuPage(page = 'root') {
  await evalJs(`
    const menu = document.querySelector('#more-menu');
    if (!menu.classList.contains('hidden')) document.querySelector('#btn-more').click();
    window.__e2eMenuOpenAt = Date.now();
    document.querySelector('#btn-more').focus(); document.querySelector('#btn-more').click(); return 1`);
  if (page !== 'root') {
    await menuFocus('[data-menu-page="' + page + '"]');
    await focusedKey('Enter');
  }
}

// The planner may choose balanced rows OR columns according to available dimensions.
function balancedGrid(boxes) {
  const bands = (axis, size, otherSize) => {
    const starts = [...new Set(boxes.map((b) => b[axis]))];
    const groups = starts.map((p) => boxes.filter((b) => b[axis] === p));
    const counts = groups.map((g) => g.length);
    const spread = (values) => Math.max(...values) - Math.min(...values);
    return counts.length > 0 && spread(counts) <= 1
      && groups.every((g) => spread(g.map((b) => b[size])) <= 2)
      && spread(groups.map((g) => g[0][otherSize])) <= 2;
  };
  return boxes.length > 0 && (bands(1, 2, 3) || bands(0, 3, 2));
}

// These are untrusted bridge-dispatched WebView events against mock SSH servers,
// not native OS mouse/keyboard coverage. Every fixture tab is tracked by ID; the
// already-connected baseline session must survive even if an assertion throws.
async function tabTilingRegressions() {
  const snapshot = async () => asObj(await evalJs(`return JSON.stringify(window.__nbTest.workspaceState(true))`));
  const prior = await snapshot();
  const priorFile = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  const baselineTabs = new Set(prior.tabs.map((tab) => tab.id));
  const setTiled = async (enabled) => {
    if ((await snapshot()).mode === (enabled ? 'tiled' : 'single')) return;
    await openMenuPage(); await menuFocus('#btn-tile-tabs'); await focusedKey('Enter');
    await waitEval(`return window.__nbTest.workspaceState().mode`, enabled ? 'tiled' : 'single');
    await sleep(180);
  };
  const focusSession = async (id) => {
    await evalJs(`const s = window.__nbTest.workspaceState().sessions.find(s => s.id === ${JSON.stringify(id)});
      if (!s) throw new Error('fixture session missing');
      document.querySelector('.tab[data-tab="' + s.tabId + '"]').click();
      const pane = document.querySelector('.term-pane[data-pane="' + s.paneId + '"]');
      pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      pane.querySelector('textarea')?.focus(); return 1`);
    await sleep(100);
  };
  const content = (text) => String(text).replace(/\s/g, ''); // Resizes may rewrap the same xterm buffer.
  const sameSessions = (before, after) => before.sessions.every((s) => {
    const current = after.sessions.find((candidate) => candidate.id === s.id);
    return current && ['identity', 'termIdentity', 'fitIdentity', 'paneIdentity', 'host', 'tabId', 'paneId', 'status'].every((key) => current[key] === s[key])
      && content(current.buffer).includes(content(s.buffer));
  });
  const sameLayouts = (before, after) => before.tabs.every((tab) => {
    const current = after.tabs.find((candidate) => candidate.id === tab.id);
    return current && current.identity === tab.identity && current.layoutIdentity === tab.layoutIdentity
      && JSON.stringify(current.layout) === JSON.stringify(tab.layout)
      && tab.panes.every((pane) => current.panes.some((p) => p.id === pane.id && p.identity === pane.identity && p.elementIdentity === pane.elementIdentity));
  });
  try {
    await setTiled(false);
    // An independent saved-host tab with an internal split, and an independent
    // temporary-host tab targeting the fixture-only mock endpoint.
    await evalJs(`const host = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('ui-a'));
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true })); return 1`);
    await waitEval(`return document.querySelector('#status-text').textContent`, '已连接');
    const tabA = (await snapshot()).activeTabId;
    await evalJs(`document.querySelector('#btn-split').click(); return 1`);
    await waitEval(`return window.__nbTest.workspaceState().sessions.filter(s => s.tabId === ${JSON.stringify(tabA)} && s.status === 'connected').length`, '2');
    const sessionsA = (await snapshot()).sessions.filter((s) => s.tabId === tabA);
    await evalJs(`document.querySelector('#btn-newtab').click();
      const input = document.querySelector('.pane-picker input'); input.value = 'root@127.0.0.1:${tileSshd.port}';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1`);
    await answerPrompt(PASSWORD, '快速连接');
    await waitEval(`return document.querySelector('#status-text').textContent`, '已连接');
    await waitEval(`return window.__nbTest.workspaceState(true).sessions.find(s => s.id === window.__nbTest.workspaceState().activeId)?.buffer`, 'Welcome to NebulaShell mock sshd');
    const before = await snapshot();
    const sessionB = before.sessions.find((s) => s.id === before.activeId);
    const opened = sshConnectionsOpened;
    await setTiled(true);
    const tiled = await snapshot();
    check('T70 标签平铺:独立 mock 端点保留会话/xterm/fit/窗格身份、内层布局、缓冲及连接数',
      sessionB.host !== sessionsA[0].host && tiled.mode === 'tiled' && sameSessions(before, tiled) && sameLayouts(before, tiled)
      && tiled.sessions.every((s) => s.mounted && s.visible) && opened === sshConnectionsOpened, JSON.stringify({ before, tiled, opened, now: sshConnectionsOpened }));
    await openMenuPage();
    const menu = asObj(await evalJs(`return JSON.stringify({ checked: document.querySelector('#btn-tile-tabs').getAttribute('aria-checked'),
      label: document.querySelector('#btn-auto-layout .mm-label').textContent,
      tileButtons: document.querySelectorAll('[data-command="workspace.tile"]').length,
      toolbarTile: !!document.querySelector('#tabbar > [data-command="workspace.tile"]'), accel: document.querySelector('#btn-tile-tabs').dataset.accel || '' })`));
    check('T70b 平铺只在更多根菜单提供勾选入口,整理明确限于当前标签,无快捷键/常驻图标',
      menu.checked === 'true' && menu.label === '整理当前标签分屏' && menu.tileButtons === 1 && !menu.toolbarTile && !menu.accel, JSON.stringify(menu));
    await focusedKey('Escape');
    const tileChrome = asObj(await evalJs(`return JSON.stringify([...document.querySelectorAll('.workspace-tile-header')].map(header => ({
      title: header.querySelector('.workspace-tile-title')?.textContent || '', connected: !!header.querySelector('.tab-dot.connected'),
      closeLabel: header.querySelector('.workspace-tile-close')?.getAttribute('aria-label') || '' })))`));
    check('T70c 平铺标题保留标签名、连接状态和有标识的关闭入口', tileChrome.length === before.tabs.length
      && tileChrome.every((tile) => tile.title && tile.connected && tile.closeLabel === '关闭标签'), JSON.stringify(tileChrome));
    await evalJs(`window.__e2eTileMountChanges = 0;
      const relevant = node => node.nodeType === 1 && (node.matches('.term-pane,.term-surface,.workspace-tile,.split-node,.workspace-split-node') || node.querySelector('.term-pane,.workspace-tile'));
      window.__e2eTileObserver = new MutationObserver(records => { for (const record of records) if ([...record.addedNodes, ...record.removedNodes].some(relevant)) window.__e2eTileMountChanges++; });
      window.__e2eTileObserver.observe(document.querySelector('#layout-root'), { childList: true, subtree: true }); return 1`);
    await focusSession(sessionsA[0].id);
    await evalJs(`document.querySelector('.workspace-tile[data-tab="${sessionB.tabId}"] .workspace-tile-header').click(); return 1`);
    await sleep(180);
    const focused = await snapshot();
    const mountChanges = Number(await evalJs(`return window.__e2eTileMountChanges`));
    check('T71 点击非活动窗格/标签标题只更新焦点,不摘挂任何平铺或终端节点', focused.activeId === sessionB.id
      && focused.activeTabId === sessionB.tabId && sameSessions(tiled, focused) && sameLayouts(tiled, focused) && mountChanges === 0, JSON.stringify({ active: focused.activeId, mountChanges }));
    await evalJs(`window.__e2eTileObserver.disconnect(); delete window.__e2eTileObserver; delete window.__e2eTileMountChanges; return 1`);
    const geometry = await snapshot();
    check('T72 平铺内层使用扣除边框/标题的内容盒,所有可见会话 fit 到自身表面', geometry.tabs.every((tab) => tab.header && tab.content
      && Math.abs(tab.header.height - 28) <= 1 && Math.abs(tab.tile.height - tab.content.height - 30) <= 1
      && Math.abs(tab.tile.width - tab.content.width - 2) <= 1)
      && geometry.sessions.filter((s) => s.visible).every((s) => {
        const tab = geometry.tabs.find((t) => t.id === s.tabId);
        const pane = tab.panes.find((p) => p.id === s.paneId).rect;
        return s.surface && s.surface.width > 0 && s.surface.height > 0 && s.surface.left >= pane.left - 1
          && s.surface.right <= pane.right + 1 && s.surface.top >= tab.header.bottom - 1 && s.surface.bottom <= pane.bottom + 1
          && s.proposed && s.cols === s.proposed.cols && s.rows === s.proposed.rows;
      }), JSON.stringify(geometry));
    await evalJs(`const stack = document.querySelector('#term-stack'); window.__e2eTilingStackStyle = stack.getAttribute('style');
      stack.style.flex = 'none'; stack.style.width = '480px'; stack.style.height = '240px'; return 1`);
    await waitEval(`return window.__nbTest.workspaceState().fits`, 'false');
    await sleep(200);
    const overflow = asObj(await evalJs(`return JSON.stringify((() => {
      const hint = document.querySelector('#workspace-layout-hint'), root = document.querySelector('#layout-root');
      const h = hint.getBoundingClientRect(), r = root.getBoundingClientRect();
      return { shown: !hint.classList.contains('hidden'), sibling: hint.parentNode === root.parentNode,
        height: h.height, separated: h.bottom <= r.top + 1, scrollable: root.scrollWidth > root.clientWidth || root.scrollHeight > root.clientHeight };
    })())`));
    check('T72b 空间不足使用全局非重叠提示条和滚动,不重排内层布局或重建终端', overflow.shown && overflow.sibling
      && overflow.height === 28 && overflow.separated && overflow.scrollable && sameLayouts(geometry, await snapshot())
      && sameSessions(geometry, await snapshot()), JSON.stringify(overflow));
    await evalJs(`const root = document.querySelector('#layout-root'); root.scrollLeft = root.scrollWidth; root.scrollTop = root.scrollHeight;
      document.querySelector('.tab[data-tab="${prior.activeTabId}"]').click(); return 1`);
    await sleep(180);
    const revealed = asObj(await evalJs(`return JSON.stringify((() => {
      const scroller = document.querySelector('#layout-root');
      const root = scroller.getBoundingClientRect();
      const header = document.querySelector('.workspace-tile[data-tab="${prior.activeTabId}"] .workspace-tile-header').getBoundingClientRect();
      return { active: window.__nbTest.workspaceState().activeTabId, reachable: header.right > root.left && header.left < root.right
        && header.bottom > root.top && header.top < root.bottom, root: root.toJSON(), header: header.toJSON(),
        scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop, focus: document.activeElement?.className };
    })())`));
    check('T72c 顶部标签激活自动将溢出的对应卡片滚入可见区域', revealed.active === prior.activeTabId && revealed.reachable, JSON.stringify(revealed));
    await evalJs(`const stack = document.querySelector('#term-stack');
      if (window.__e2eTilingStackStyle === null) stack.removeAttribute('style'); else stack.setAttribute('style', window.__e2eTilingStackStyle);
      delete window.__e2eTilingStackStyle; return 1`);
    await sleep(200);
    await focusSession(sessionB.id);

    // The inactive owner's explicit controls must not affect the active B tab.
    await evalJs(`document.querySelector('.term-pane[data-pane="${sessionsA[0].paneId}"] .pane-zoom-btn').click(); return 1`);
    const zoomed = await snapshot();
    check('T73 非活动标签显式放大仅改变其内层,不抢活动标签或隐藏其他标签', zoomed.activeId === sessionB.id
      && zoomed.tabs.find((t) => t.id === tabA).zoomPaneId === sessionsA[0].paneId
      && zoomed.sessions.find((s) => s.id === sessionB.id).mounted, JSON.stringify(zoomed));
    await evalJs(`document.querySelector('.term-pane[data-pane="${sessionsA[0].paneId}"] .pane-zoom-btn').click(); return 1`);
    await evalJs(`document.querySelector('.term-pane[data-pane="${sessionsA[1].paneId}"] .pane-close-btn').click(); return 1`);
    const explicitClose = await snapshot();
    check('T73b 非活动窗格显式关闭只释放目标会话,当前 B 与既有基线保活', explicitClose.activeId === sessionB.id
      && !explicitClose.sessions.some((s) => s.id === sessionsA[1].id) && sameSessions(prior, explicitClose), JSON.stringify(explicitClose));
    await evalJs(`document.querySelector('#btn-newtab').click(); return 1`);
    const emptyTab = (await snapshot()).activeTabId;
    await focusSession(sessionB.id);
    await evalJs(`document.querySelector('.workspace-tile[data-tab="${emptyTab}"] .pane-picker-close').click(); return 1`);
    const emptyClosed = await snapshot();
    check('T73c 非活动空选择器可关闭其自身标签且不触碰当前会话', !emptyClosed.tabs.some((t) => t.id === emptyTab)
      && emptyClosed.activeId === sessionB.id && sameSessions(prior, emptyClosed), JSON.stringify(emptyClosed));

    await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
    await waitEval(`return window.__nbTest.workspaceState().sessions.find(s => s.id === ${JSON.stringify(sessionB.id)}).readOnly`, 'true');
    await evalJs(`window.__nbTest.write('echo NB_TILE_READONLY_BLOCKED\\r'); return 1`);
    if (!priorFile.open) { await openMenuPage(); await menuFocus('#btn-files'); await focusedKey('Enter'); }
    await waitEval(`return window.__nbTest.filePanel().targetId`, sessionB.id);
    await openMenuPage('session'); await menuFocus('#btn-broadcast'); await focusedKey('Enter');
    await waitEval(`return !!document.querySelector('#bc-list')`, 'true');
    const readonlyExcluded = await evalJs(`return !document.querySelector('#bc-list input[value="${sessionB.id}"]')`);
    await evalJs(`for (const input of document.querySelectorAll('#bc-list input')) input.checked = input.value === ${JSON.stringify(sessionsA[0].id)};
      document.querySelector('#bc-ok').click(); return 1`);
    await setTiled(false); await setTiled(true);
    const policy = await snapshot();
    await focusSession(sessionsA[0].id);
    await waitEval(`return window.__nbTest.filePanel().targetId`, sessionsA[0].id);
    await evalJs(`window.__nbTest.write('echo NB_TILE_BROADCAST_ONLY_A\\r'); return 1`);
    await waitEval(`return window.__nbTest.workspaceState(true).sessions.find(s => s.id === ${JSON.stringify(sessionsA[0].id)}).buffer.replace(/\\s/g, '')`, 'NB_TILE_BROADCAST_ONLY_A');
    const broadcast = await snapshot();
    check('T74 平铺开关保留只读/广播,文件目标跟随焦点且广播不写只读或未选基线', readonlyExcluded === true
      && policy.sessions.find((s) => s.id === sessionB.id).readOnly && JSON.stringify(policy.broadcast) === JSON.stringify([sessionsA[0].id])
      && content(broadcast.sessions.find((s) => s.id === sessionsA[0].id).buffer).includes('NB_TILE_BROADCAST_ONLY_A')
      && !content(broadcast.sessions.find((s) => s.id === sessionB.id).buffer).includes('NB_TILE_BROADCAST_ONLY_A')
      && !content(broadcast.sessions.find((s) => s.id === sessionB.id).buffer).includes('NB_TILE_READONLY_BLOCKED')
      && prior.sessions.every((s) => !content(broadcast.sessions.find((now) => now.id === s.id).buffer).includes('NB_TILE_BROADCAST_ONLY_A')), JSON.stringify(policy));
    await evalJs(`document.querySelector('#btn-broadcast-stop').click(); return 1`);
    await focusSession(sessionB.id);
    await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
    await waitEval(`return window.__nbTest.workspaceState().sessions.find(s => s.id === ${JSON.stringify(sessionB.id)}).readOnly`, 'false');
    await evalJs(`document.querySelector('.workspace-tile[data-tab="${tabA}"] .workspace-tile-close').click(); return 1`);
    const closedA = await snapshot();
    check('T75 非活动平铺标签关闭不抢当前 B,只释放该标签连接', !closedA.tabs.some((t) => t.id === tabA)
      && closedA.activeId === sessionB.id && sameSessions(prior, closedA), JSON.stringify(closedA));
    await focusSession(prior.activeId);
    await evalJs(`document.querySelector('.workspace-tile[data-tab="${sessionB.tabId}"] .workspace-tile-close').click(); return 1`);
    const last = await snapshot();
    check('T75b 关闭到最后一个标签仍保留当前会话身份/布局/缓冲,平铺模式可退出', last.tabs.length === prior.tabs.length
      && last.mode === 'tiled' && last.activeId === prior.activeId && sameSessions(prior, last) && sameLayouts(prior, last)
      && last.tabs.every((tab) => Math.abs(tab.tile.width - last.root.width) <= 1 && Math.abs(tab.tile.height - last.root.height) <= 1), JSON.stringify(last));
    const beforeExitConnections = sshConnectionsOpened;
    await setTiled(false);
    const untiled = await snapshot();
    check('T75c 退出平铺恢复单标签语义,无重连或会话重建', untiled.mode === 'single' && sameSessions(prior, untiled)
      && sameLayouts(prior, untiled) && beforeExitConnections === sshConnectionsOpened, JSON.stringify(untiled));
  } finally {
    await evalJs(`window.__e2eTileObserver?.disconnect(); delete window.__e2eTileObserver; delete window.__e2eTileMountChanges;
      if ('__e2eTilingStackStyle' in window) {
        const stack = document.querySelector('#term-stack');
        if (window.__e2eTilingStackStyle === null) stack.removeAttribute('style'); else stack.setAttribute('style', window.__e2eTilingStackStyle);
        delete window.__e2eTilingStackStyle;
      }
      document.querySelector('#bc-cancel')?.click(); document.querySelector('#btn-broadcast-stop')?.click();
      const baseline = new Set(${JSON.stringify([...baselineTabs])});
      for (const tab of window.__nbTest.workspaceState().tabs) if (!baseline.has(tab.id)) document.querySelector('.tab[data-tab="' + tab.id + '"] .tab-close')?.click(); return 1`);
    await setTiled(prior.mode === 'tiled');
    if (prior.activeId) await focusSession(prior.activeId);
    if (!priorFile.open) await evalJs(`document.querySelector('#btn-file-close').click(); return 1`);
    await evalJs(`return window.nebula.invoke('fingerprints:delete', { id: '127.0.0.1:${tileSshd.port}' })`);
    const restored = await snapshot();
    check('T75d 平铺用例清理只移除自建标签/会话,还原原模式与活动基线', restored.mode === prior.mode
      && restored.activeId === prior.activeId && sameSessions(prior, restored) && sameLayouts(prior, restored)
      && restored.tabs.length === prior.tabs.length && restored.sessions.length === prior.sessions.length, JSON.stringify(restored));
  }
}

// Command-block coverage uses rendered buttons and the production SSE -> AI ->
// SSH IPC path. __nbTest.write is only terminal typing/setup, never an AI handler.
async function aiCommandBlockRegressions() {
  const snapshot = async () => asObj(await evalJs(`return JSON.stringify(window.__nbTest.workspaceState())`));
  const prior = await snapshot();
  const active = prior.sessions.find((s) => s.id === prior.activeId);
  const peer = prior.sessions.find((s) => s.id !== prior.activeId && s.tabId === prior.activeTabId);
  if (!active || !peer) throw new Error('AI command E2E requires the existing T6 split sessions');
  await waitEval(`return window.__nbTest.workspaceState().sessions.filter(s => s.tabId === ${JSON.stringify(prior.activeTabId)} && s.status === 'connected').length`, '2');
  const focusSession = async (s) => {
    await evalJs(`document.querySelector('.tab[data-tab="${s.tabId}"]').click();
      const pane = document.querySelector('.term-pane[data-pane="${s.paneId}"]');
      pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      pane.querySelector('textarea').focus(); return 1`);
    await waitEval(`return window.__nbTest.workspaceState().activeId`, s.id);
  };
  const setBase = async (suffix) => {
    await evalJs(`document.querySelector('#ai-settings-open').click();
      document.querySelector('#ai-baseurl').value = ${JSON.stringify(ai.base)} + ${JSON.stringify(suffix)};
      document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-ai-save').click(); return 1`);
    await waitEval(`return document.querySelector('#modal-ai').classList.contains('hidden')`, 'true');
  };
  const send = async (text) => {
    const count = Number(await evalJs(`document.querySelector('#ai-input').value = ${JSON.stringify(text)};
      document.querySelector('#ai-send').click(); return document.querySelectorAll('#ai-messages .ai-msg').length`));
    return `#ai-messages .ai-msg:nth-child(${count})`;
  };
  let bubble = '';
  const blockSelector = (index) => `${bubble} .ai-code-block[data-code-index="${index}"]`;
  const actionSelector = (index, action) => `${blockSelector(index)} [data-ai-code-action="${action}"]`;
  const blockStates = async () => asObj(await evalJs(`return JSON.stringify([...document.querySelectorAll(${JSON.stringify(bubble + ' .ai-code-block')})].map(block => {
    const copy = block.querySelector('[data-ai-code-action="copy"]');
    const execute = block.querySelector('[data-ai-code-action="execute"]');
    const insert = block.querySelector('[data-ai-code-action="insert"]');
    const warnings = [...block.querySelectorAll('.ai-code-warning')].map(note => ({
      text: note.textContent, visible: !!note.getClientRects().length && getComputedStyle(note).visibility !== 'hidden'
    }));
    return { index: Number(block.dataset.codeIndex), language: block.querySelector('.ai-code-language')?.textContent,
      text: block.querySelector('pre code')?.textContent, toolbar: !!block.querySelector('.ai-code-toolbar .ai-code-actions'),
      copy: !!copy && !copy.disabled, execute: !!execute, disabled: execute?.disabled,
      title: execute?.title || '', insert: !!insert, insertDisabled: insert?.disabled, insertTitle: insert?.title || '', warnings,
      insertInMenu: !!insert?.closest('details.ai-code-menu') };
  }))`));
  const clickAction = async (index, action) => {
    await evalJs(`const block = document.querySelector(${JSON.stringify(blockSelector(index))});
      if (!block) throw new Error('AI command block missing');
      if (${JSON.stringify(action)} === 'insert') block.querySelector('.ai-code-menu summary').click();
      const button = block.querySelector(${JSON.stringify('[data-ai-code-action="' + action + '"]')});
      if (!button || button.disabled || !button.getClientRects().length) throw new Error('AI command action not available');
      button.scrollIntoView({ block: 'nearest' }); button.click(); return 1`);
  };
  const waitSsh = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('等待 mock SSH 命令块输入超时');
      await sleep(50);
    }
  };
  const mark = () => ({ writes: sshd.shellWrites.length, commands: sshd.shellCommands.length });
  const traffic = (from) => ({ writes: sshd.shellWrites.slice(from.writes), commands: sshd.shellCommands.slice(from.commands) });
  const wireIs = (observed, shellId, text) => observed.writes.length > 0
    && observed.writes.every((write) => write.shellId === shellId)
    && observed.writes.map((write) => write.data).join('') === text;
  const noTraffic = (from) => sshd.shellWrites.length === from.writes && sshd.shellCommands.length === from.commands;
  let bracketedOn = false;
  let readonlyOn = false;
  let emptyTab = null;
  let shellId = null;
  try {
    await focusSession(active);
    await setBase('/commands');
    bubble = await send('AI 命令块真实端到端测试');
    await waitEval(`return document.querySelector(${JSON.stringify(bubble)})?.dataset.responseState`, 'streaming');
    await waitEval(`return document.querySelector(${JSON.stringify(blockSelector(0) + ' pre code')})?.textContent`, 'nebula-probe');
    const during = await blockStates();
    const streamingMark = mark();
    await evalJs(`document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).click();
      document.querySelector(${JSON.stringify(blockSelector(0) + ' summary')}).click();
      document.querySelector(${JSON.stringify(actionSelector(0, 'insert'))}).click(); return 1`);
    check('T76 完整闭合 bash 块在实际生成期间可复制但执行/填入禁用,点击不发 SSH',
      during.length === 1 && during[0].text === 'nebula-probe' && during[0].copy
      && during[0].disabled && during[0].insertDisabled && during[0].title.includes('生成中')
      && noTraffic(streamingMark), JSON.stringify(during));
    await waitEval(`return document.querySelector(${JSON.stringify(bubble)})?.dataset.responseState`, 'completed');
    const done = await blockStates();
    check('T76b 正常 ai:done 后硬保护保持,示例参数仅提醒且按钮可用,合法模板无提醒',
      done.length === AI_COMMAND_BLOCKS.length && done.every((block, i) => {
        const expected = AI_COMMAND_BLOCKS[i];
        const enabled = expected.eligible && i !== 1 && i !== 9; // Newlines and actual TAB require remote paste mode.
        const warningMatches = expected.warning
          ? block.warnings.length === 1 && block.warnings[0].visible
            && block.warnings[0].text.includes(expected.warning.token) && block.warnings[0].text.includes(expected.warning.reason)
            && block.warnings[0].text.includes('可仅填入终端修改')
            && block.title.includes(block.warnings[0].text) && block.insertTitle.includes(block.warnings[0].text)
          : block.warnings.length === 0;
        return block.index === i && block.text === expected.text && block.language === (expected.language || '代码')
          && block.toolbar && block.copy && block.execute === expected.shell && block.insert === expected.shell
          && (!expected.shell || (block.disabled === !enabled && block.insertDisabled === !enabled && block.insertInMenu))
          && (!expected.reason || block.title.includes(expected.reason)) && warningMatches;
      }) && done[1]?.title.includes('bracketed paste'), JSON.stringify(done));

    // Capture the boundary used by copyText, including its denied-API fallback.
    // No internal copy handler is called, and both own-property descriptors are
    // restored in finally (including the inherited/absent-property case).
    await evalJs(`window.__e2eCommandClipboard = {
      clipboardDescriptor: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
      execDescriptor: Object.getOwnPropertyDescriptor(document, 'execCommand'), copies: [], fallback: false
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
      if (window.__e2eCommandClipboard.fallback) throw new Error('E2E clipboard denied');
      window.__e2eCommandClipboard.copies.push({ text, via: 'clipboard' });
    } } });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: command => {
      if (command !== 'copy') throw new Error('unexpected execCommand');
      const selected = document.activeElement;
      window.__e2eCommandClipboard.copies.push({ text: selected.value.slice(selected.selectionStart, selected.selectionEnd), via: 'fallback' });
      return true;
    } }); return 1`);
    const copied = [];
    for (let i = 0; i < AI_COMMAND_BLOCKS.length; i++) {
      if (!AI_COMMAND_BLOCKS[i].text) continue; // copyText deliberately rejects empty text.
      const before = copied.length;
      await clickAction(i, 'copy');
      await waitEval(`return window.__e2eCommandClipboard.copies.length`, String(before + 1));
      copied.push(asObj(await evalJs(`return JSON.stringify(window.__e2eCommandClipboard.copies.at(-1))`)));
    }
    check('T77 每块独立复制精确原文(含换行、非 Shell、占位符及未闭合块),不夹带围栏/工具栏',
      copied.length === AI_COMMAND_BLOCKS.filter((block) => block.text).length
      && copied.every((copy, i) => copy.text === AI_COMMAND_BLOCKS.filter((block) => block.text)[i].text && copy.via === 'clipboard'), JSON.stringify(copied));
    await evalJs(`window.__e2eCommandClipboard.fallback = true; return 1`);
    await clickAction(1, 'copy');
    await waitEval(`return window.__e2eCommandClipboard.copies.length`, String(copied.length + 1));
    const fallback = asObj(await evalJs(`return JSON.stringify(window.__e2eCommandClipboard.copies.at(-1))`));
    check('T77b Clipboard API 拒绝时真实 copyText 回退仍复制完整多行原文',
      fallback.via === 'fallback' && fallback.text === AI_COMMAND_BLOCKS[1].text, JSON.stringify(fallback));

    const singleMark = mark();
    await clickAction(0, 'execute');
    await waitSsh(() => sshd.shellCommands.length > singleMark.commands);
    shellId = sshd.shellCommands[singleMark.commands].shellId;
    await waitEval(`return JSON.stringify(window.__nbTest.diagSource())`, 'PROBE-OK nebula-e2e');
    const single = traffic(singleMark);
    const diag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    check('T78 单行执行通过真实 SSH 得到 probe 输出,诊断素材记录命令及远端输出',
      wireIs(single, shellId, 'nebula-probe\r') && single.commands.length === 1
      && single.commands[0].command === 'nebula-probe' && diag.cmd === 'nebula-probe'
      && diag.output.includes('PROBE-OK nebula-e2e'), JSON.stringify({ single, diag }));

    const tabBlockedMark = mark();
    await evalJs(`document.querySelector(${JSON.stringify(actionSelector(9, 'execute'))}).click();
      document.querySelector(${JSON.stringify(actionSelector(9, 'insert'))}).click(); return 1`);
    check('T78b 未开启 bracketed paste 的单行 TAB 块可复制但执行/填入禁用,不发补全键',
      done[9].copy && done[9].disabled && done[9].insertDisabled
      && done[9].title.includes('TAB') && noTraffic(tabBlockedMark), JSON.stringify(done[9]));

    // Keep the user's literal backslash-t template on the plain single-line path.
    // This mock records SSH input but never runs Docker on the host; its unknown-
    // command response must not be mistaken for a successful Docker invocation.
    const targetTitle = String(await evalJs(`return document.querySelector(${JSON.stringify(actionSelector(10, 'execute'))}).title`));
    const targetLabel = targetTitle.match(/^执行到：(.+?)。/)?.[1] || '';
    const targetPane = prior.tabs.find((tab) => tab.id === active.tabId).panes.findIndex((pane) => pane.id === active.paneId) + 1;
    const templateMark = mark();
    await clickAction(10, 'execute');
    await waitSsh(() => sshd.shellCommands.length > templateMark.commands);
    await waitEval(`return JSON.stringify(window.__nbTest.diagSource())`, 'command not found');
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(10, 'execute'))}).disabled`, 'false');
    const template = traffic(templateMark);
    const templateDiag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    check('T78c 合法 Docker 模板无提醒/确认,真实按钮一次 SSH 原文提交,仅断言 mock 输入而非 Docker 成功',
      done[10].warnings.length === 0 && !done[10].disabled && !done[10].insertDisabled
      && !(await evalJs(`return window.__nbTest.confirmOpen()`))
      && AI_COMMAND_BLOCKS[10].text.includes('\\t') && !AI_COMMAND_BLOCKS[10].text.includes('\t')
      && template.writes.length === 1 && wireIs(template, shellId, AI_COMMAND_BLOCKS[10].text + '\r')
      && template.commands.length === 1 && template.commands[0].command === AI_COMMAND_BLOCKS[10].text
      && templateDiag.cmd === AI_COMMAND_BLOCKS[10].text && templateDiag.output.includes('command not found'), JSON.stringify({ template, templateDiag }));

    const placeholderWarning = done[5].warnings[0]?.text.split('\n')[0] || '';
    const placeholderCancelMark = mark();
    await clickAction(5, 'execute');
    await waitEval(`return window.__nbTest.confirmOpen()`, 'true');
    const placeholderConfirm = asObj(await evalJs(`return JSON.stringify({ title: window.__nbTest.confirmTitle(),
      text: window.__nbTest.confirmText(), focus: window.__nbTest.confirmFocus() })`));
    check('T78d 疑似示例参数提醒可见且按钮可用,确认含具体 token/理由/全文/目标且默认取消',
      !done[5].disabled && !done[5].insertDisabled && done[5].warnings[0]?.visible
      && placeholderWarning.includes(AI_COMMAND_BLOCKS[5].warning.token) && placeholderWarning.includes(AI_COMMAND_BLOCKS[5].warning.reason)
      && placeholderConfirm.title === '确认执行 AI 命令' && placeholderConfirm.focus === 'cancel'
      && placeholderConfirm.text.includes(placeholderWarning) && placeholderConfirm.text.includes(AI_COMMAND_BLOCKS[5].text)
      && targetLabel.includes('ui-a') && targetLabel.includes(`root@127.0.0.1:${sshd.port}`)
      && targetLabel.endsWith(`窗格 ${targetPane}`) && placeholderConfirm.text.includes(`目标：${targetLabel}`)
      && noTraffic(placeholderCancelMark), JSON.stringify(placeholderConfirm));
    await evalJs(`document.querySelector('#btn-confirm-cancel').click(); return 1`);
    await waitEval(`return window.__nbTest.confirmOpen()`, 'false');
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(5, 'execute'))}).disabled`, 'false');
    await sleep(180);
    check('T78e 取消示例参数确认不产生任何 SSH 输入或提交', noTraffic(placeholderCancelMark), JSON.stringify(traffic(placeholderCancelMark)));
    const placeholderMark = mark();
    await clickAction(5, 'execute');
    await waitEval(`return window.__nbTest.confirmOpen()`, 'true');
    await evalJs(`document.querySelector('#btn-confirm-ok').click(); return 1`);
    await waitSsh(() => sshd.shellCommands.length > placeholderMark.commands);
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(5, 'execute'))}).disabled`, 'false');
    await sleep(180);
    const placeholder = traffic(placeholderMark);
    check('T78f 接受示例参数确认后仅一次原文 SSH 提交,不替换 token/不重复确认',
      placeholder.writes.length === 1 && wireIs(placeholder, shellId, AI_COMMAND_BLOCKS[5].text + '\r')
      && placeholder.commands.length === 1 && placeholder.commands[0].command === AI_COMMAND_BLOCKS[5].text
      && !(await evalJs(`return window.__nbTest.confirmOpen()`)), JSON.stringify(placeholder));

    const modeMark = mark();
    bracketedOn = true;
    await evalJs(`window.__nbTest.write('nebula-e2e-bracketed-on\\r'); return 1`);
    await waitSsh(() => sshd.shellCommands.slice(modeMark.commands).some((entry) => entry.command === 'nebula-e2e-bracketed-on'));
    await waitEval(`return window.__NB_TERM_TEXT__()`, 'BRACKETED-ON');
    await focusSession(active); // Real focus refresh after xterm parsed the remote mode.
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(1, 'execute'))}).disabled`, 'false');
    const cancelMark = mark();
    await clickAction(1, 'execute');
    await waitEval(`return window.__nbTest.confirmOpen()`, 'true');
    const multiConfirm = asObj(await evalJs(`return JSON.stringify({ title: window.__nbTest.confirmTitle(),
      text: window.__nbTest.confirmText(), focus: window.__nbTest.confirmFocus() })`));
    check('T79 多行执行确认展示完整两行文本及目标标签/主机/窗格,安全焦点默认取消',
      multiConfirm.title === '确认执行 AI 命令' && multiConfirm.focus === 'cancel'
      && multiConfirm.text.includes('whoami\nnebula-probe') && multiConfirm.text.includes('2 行')
      && targetLabel.includes('ui-a') && targetLabel.includes(`root@127.0.0.1:${sshd.port}`)
      && targetLabel.endsWith(`窗格 ${targetPane}`) && multiConfirm.text.includes(`目标：${targetLabel}`), JSON.stringify(multiConfirm));
    await evalJs(`document.querySelector('#btn-confirm-cancel').click(); return 1`);
    await waitEval(`return window.__nbTest.confirmOpen()`, 'false');
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(1, 'execute'))}).disabled`, 'false');
    await sleep(180);
    check('T79b 取消多行确认不产生任何 SSH 输入或提交', noTraffic(cancelMark), JSON.stringify(traffic(cancelMark)));
    const multiMark = mark();
    await clickAction(1, 'execute');
    await waitEval(`return window.__nbTest.confirmOpen()`, 'true');
    await evalJs(`document.querySelector('#btn-confirm-ok').click(); return 1`);
    await waitSsh(() => sshd.shellCommands.length > multiMark.commands);
    await waitEval(`return JSON.stringify(window.__nbTest.diagSource())`, 'PROBE-OK nebula-e2e');
    const multi = traffic(multiMark);
    const multiDiag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    check('T79c 确认后 bracketed paste 整体发送多行,仅末尾提交一次,诊断保留整个块',
      wireIs(multi, shellId, '\x1b[200~whoami\rnebula-probe\x1b[201~\r')
      && multi.commands.length === 1 && multi.commands[0].command === 'whoami\nnebula-probe'
      && multiDiag.cmd === 'whoami\nnebula-probe' && multiDiag.output.includes('PROBE-OK nebula-e2e'), JSON.stringify({ multi, multiDiag }));

    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(7, 'execute'))}).disabled`, 'false');
    const riskMark = mark();
    await clickAction(7, 'execute');
    await waitEval(`return window.__nbTest.confirmOpen()`, 'true');
    const risk = asObj(await evalJs(`return JSON.stringify({ text: window.__nbTest.confirmText(), focus: window.__nbTest.confirmFocus() })`));
    await evalJs(`document.querySelector('#btn-confirm-cancel').click(); return 1`);
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).disabled`, 'false');
    check('T80 明显危险单行也需确认,风险/完整命令/目标可见且默认取消,取消不发送',
      risk.focus === 'cancel' && risk.text.includes('递归删除') && risk.text.includes(AI_COMMAND_BLOCKS[7].text)
      && risk.text.includes(`目标：${targetLabel}`) && noTraffic(riskMark), JSON.stringify(risk));

    const insertMark = mark();
    const beforeInsertDiag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    await clickAction(1, 'insert');
    await waitSsh(() => sshd.shellWrites.length > insertMark.writes);
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(1, 'insert'))}).disabled`, 'false');
    await sleep(180);
    const inserted = traffic(insertMark);
    const afterInsertDiag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    check('T81 details 菜单仅填入完整多行,无末尾回车/SSH 提交/新的诊断命令',
      wireIs(inserted, shellId, '\x1b[200~whoami\rnebula-probe\x1b[201~') && inserted.commands.length === 0
      && afterInsertDiag.cmd === beforeInsertDiag.cmd, JSON.stringify(inserted));
    // User-visible Ctrl+C discards the fixture's unsubmitted input before later cases.
    await evalJs(`window.__nbTest.write('\\x03'); return 1`);
    await sleep(150);

    const tabInsertMark = mark();
    await clickAction(9, 'insert');
    await waitSsh(() => sshd.shellWrites.length > tabInsertMark.writes);
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(9, 'insert'))}).disabled`, 'false');
    await sleep(180);
    const tabInserted = traffic(tabInsertMark);
    check('T81b 开启 bracketed paste 后含 TAB 单行精确填入,不改为空格/补全且不提交回车',
      wireIs(tabInserted, shellId, '\x1b[200~' + AI_COMMAND_BLOCKS[9].text + '\x1b[201~')
      && tabInserted.commands.length === 0, JSON.stringify(tabInserted));
    await evalJs(`window.__nbTest.write('\\x03'); return 1`);
    await sleep(150);

    const placeholderInsertMark = mark();
    const beforePlaceholderInsertDiag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    await clickAction(5, 'insert');
    await waitSsh(() => sshd.shellWrites.length > placeholderInsertMark.writes);
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(5, 'insert'))}).disabled`, 'false');
    await sleep(180);
    const placeholderInserted = traffic(placeholderInsertMark);
    const afterPlaceholderInsertDiag = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
    check('T81c 有提醒的仅填入不弹确认,bracketed 全文无末尾回车/命令增长/新诊断命令',
      !(await evalJs(`return window.__nbTest.confirmOpen()`))
      && wireIs(placeholderInserted, shellId, '\x1b[200~' + AI_COMMAND_BLOCKS[5].text + '\x1b[201~')
      && placeholderInserted.commands.length === 0 && afterPlaceholderInsertDiag.cmd === beforePlaceholderInsertDiag.cmd,
      JSON.stringify(placeholderInserted));
    await evalJs(`window.__nbTest.write('\\x03'); return 1`);
    await sleep(150);

    readonlyOn = true;
    await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
    await waitEval(`return window.__nbTest.workspaceState().sessions.find(s => s.id === ${JSON.stringify(active.id)}).readOnly`, 'true');
    const readonly = await blockStates();
    const readonlyMark = mark();
    await evalJs(`document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).click(); return 1`);
    check('T82 只读会话禁用所有 Shell 执行/填入但保留复制,禁用按钮不写 SSH',
      readonly.every((block) => block.copy && (!block.execute || (block.disabled && block.insertDisabled)))
      && readonly[0].title.includes('只读') && noTraffic(readonlyMark), JSON.stringify(readonly));
    await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
    readonlyOn = false;
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).disabled`, 'false');
    await evalJs(`document.querySelector('#btn-newtab').click(); return 1`);
    emptyTab = (await snapshot()).activeTabId;
    const empty = await blockStates();
    const emptyMark = mark();
    await evalJs(`document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).click(); return 1`);
    check('T82b 空 pane 不回退到其他已连接会话,执行/填入禁用且复制可用',
      !(await snapshot()).activeId && empty.every((block) => block.copy && (!block.execute || (block.disabled && block.insertDisabled)))
      && empty[0].title.includes('没有活动终端') && noTraffic(emptyMark), JSON.stringify(empty));
    await evalJs(`document.querySelector('.tab[data-tab="${emptyTab}"] .tab-close').click(); return 1`);
    emptyTab = null;
    await focusSession(active);

    await openMenuPage('session'); await menuFocus('#btn-broadcast'); await focusedKey('Enter');
    await waitEval(`return !!document.querySelector('#bc-list')`, 'true');
    await evalJs(`for (const input of document.querySelectorAll('#bc-list input')) input.checked = ${JSON.stringify([active.id, peer.id])}.includes(input.value);
      document.querySelector('#bc-ok').click(); return 1`);
    const broadcasting = await snapshot();
    const broadcastMark = mark();
    await waitEval(`return document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).disabled`, 'false');
    await clickAction(0, 'execute');
    await waitSsh(() => sshd.shellCommands.length > broadcastMark.commands);
    await sleep(180);
    const broadcast = traffic(broadcastMark);
    check('T83 广播选中两个真实会话时,AI 命令仍只发当前 activeId 的 SSH channel',
      broadcasting.broadcast.length === 2 && broadcasting.broadcast.includes(active.id) && broadcasting.broadcast.includes(peer.id)
      && wireIs(broadcast, shellId, '\x1b[200~nebula-probe\x1b[201~\r')
      && broadcast.commands.length === 1 && broadcast.commands[0].shellId === shellId && broadcast.commands[0].command === 'nebula-probe', JSON.stringify({ broadcasting, broadcast }));
    await evalJs(`document.querySelector('#btn-broadcast-stop').click(); return 1`);

    await setBase('/commands/incomplete');
    bubble = await send('命令块不正常结束测试');
    await waitEval(`return document.querySelector(${JSON.stringify(bubble)})?.dataset.responseState`, 'incomplete');
    const incomplete = await blockStates();
    check('T84 HTTP EOF 无 DONE 的完整 Shell 块仅可复制,不误启用执行/填入',
      incomplete.length === AI_COMMAND_BLOCKS.length && incomplete.every((block) => block.copy && (!block.execute || (block.disabled && block.insertDisabled)))
      && incomplete[0].title.includes('未正常结束'), JSON.stringify(incomplete));
    await setBase('/commands/length');
    bubble = await send('供应商 token 截断命令块测试');
    await waitEval(`return document.querySelector(${JSON.stringify(bubble)})?.dataset.responseState`, 'incomplete');
    const truncated = await blockStates();
    const truncatedMark = mark();
    await evalJs(`document.querySelector(${JSON.stringify(actionSelector(0, 'execute'))}).click();
      document.querySelector(${JSON.stringify(actionSelector(0, 'insert'))}).click(); return 1`);
    check('T84d 供应商 finish_reason=length 即使返回 DONE,闭合 Shell 块仍仅可复制且不发 SSH',
      truncated.length === AI_COMMAND_BLOCKS.length
      && truncated.every(block => block.copy && (!block.execute || (block.disabled && block.insertDisabled)))
      && truncated[0].title.includes('未正常结束') && noTraffic(truncatedMark), JSON.stringify(truncated));

    await setBase('/commands');
    bubble = await send('命令块停止生成测试');
    await waitEval(`return document.querySelector(${JSON.stringify(blockSelector(0) + ' pre code')})?.textContent`, 'nebula-probe');
    const abortMark = mark();
    await evalJs(`document.querySelector('#ai-send').click(); return 1`); // Actual busy-state Stop button.
    await waitEval(`return document.querySelector(${JSON.stringify(bubble)})?.dataset.responseState`, 'aborted');
    const aborted = await blockStates();
    check('T84b 用户停止实际流式回复后完整 Shell 块仅可复制,不发送 SSH',
      aborted.length > 0 && aborted.every((block) => block.copy && (!block.execute || (block.disabled && block.insertDisabled)))
      && aborted[0].title.includes('中止') && noTraffic(abortMark), JSON.stringify(aborted));
  } finally {
    const restoredBoundaries = asObj(await evalJs(`const saved = window.__e2eCommandClipboard;
      let clipboardRestored = true, execRestored = true;
      if (saved) {
        if (saved.clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', saved.clipboardDescriptor); else delete navigator.clipboard;
        if (saved.execDescriptor) Object.defineProperty(document, 'execCommand', saved.execDescriptor); else delete document.execCommand;
        const sameDescriptor = (actual, expected) => !expected ? !actual : !!actual
          && ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(key => actual[key] === expected[key]);
        clipboardRestored = sameDescriptor(Object.getOwnPropertyDescriptor(navigator, 'clipboard'), saved.clipboardDescriptor);
        execRestored = sameDescriptor(Object.getOwnPropertyDescriptor(document, 'execCommand'), saved.execDescriptor);
        delete window.__e2eCommandClipboard;
      }
      document.querySelector('#btn-confirm-cancel')?.click(); document.querySelector('#bc-cancel')?.click();
      document.querySelector('#btn-broadcast-stop')?.click();
      if (document.querySelector('#ai-send')?.title === '停止生成') document.querySelector('#ai-send').click();
      return JSON.stringify({ clipboardRestored, execRestored })`));
    if (emptyTab) await evalJs(`document.querySelector('.tab[data-tab="${emptyTab}"] .tab-close')?.click(); return 1`);
    await focusSession(active);
    if (readonlyOn) await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
    if (bracketedOn) {
      const resetMark = mark();
      await evalJs(`window.__nbTest.write('\\x03'); window.__nbTest.write('nebula-e2e-bracketed-off\\r'); return 1`);
      await waitSsh(() => sshd.shellCommands.slice(resetMark.commands).some((entry) => entry.shellId === shellId && entry.command === 'nebula-e2e-bracketed-off'));
      await waitEval(`return window.__NB_TERM_TEXT__()`, 'BRACKETED-OFF');
    }
    await setBase('');
    await focusSession(active);
    const restored = await snapshot();
    check('T84c 命令块用例还原 clipboard/AI endpoint/只读/广播/空标签,基线会话保留',
      restoredBoundaries.clipboardRestored && restoredBoundaries.execRestored
      && restored.activeId === prior.activeId && restored.broadcast.length === 0
      && restored.tabs.length === prior.tabs.length && restored.sessions.length === prior.sessions.length
      && restored.sessions.every((s) => prior.sessions.some((before) => before.id === s.id && before.readOnly === s.readOnly)), JSON.stringify({ restored, restoredBoundaries }));
  }
}

async function cleanup() {
  try { if (proc) proc.kill(); } catch { /* ignore */ }
  try { if (sshd) await sshd.close(); } catch { /* ignore */ }
  try { if (sshd2) await sshd2.close(); } catch { /* ignore */ }
  try { if (tileSshd) await tileSshd.close(); } catch { /* ignore */ }
  try { if (cloud) await cloud.close(); } catch { /* ignore */ }
  try { if (ai) await ai.close(); } catch { /* ignore */ }
  try { if (work) fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}

const watchdog = setTimeout(() => {
  console.error(`${FAIL} UI e2e 总体超时(240s)`);
  console.error(appLogs.join('').slice(-1500));
  cleanup().finally(() => process.exit(1));
}, 240000);

async function main() {
  if (!fs.existsSync(BIN)) throw new Error(`未找到应用二进制: ${BIN}\n请先执行: npm run build:web && cd src-tauri && cargo build`);

  sshd = await startMockSshd({ password: PASSWORD, onEvent: countSshConnections, commandBlockInput: true });
  // A fixture-only endpoint: never consume sshd2's deliberately mismatched
  // fingerprint, which belongs to the later security/retrust regression.
  tileSshd = await startMockSshd({ password: PASSWORD, onEvent: countSshConnections });
  // 第二台 mock sshd:主机密钥与 sshd 不同,用于制造"服务器指纹变更"(T32)。
  sshd2 = await startMockSshd({ password: PASSWORD });
  cloud = await startMockCloudServer();
  ai = await startMockAiServer();
  console.log(`mock 服务就绪 sshd=:${sshd.port} cloud=:${cloud.port} ai=:${ai.port}`);

  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ui-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ui-data-'));
  // 预置 legacy 格式(64 位 hex)的 knownHosts 记录:模拟 Electron 时代迁移过来的数据。
  // 回归:旧记录与现行 base64 指纹编码不同,曾被误判成"服务器密钥变更"而拒连
  // (表现为 "Unknown server key")。T5 的连接必须照常成功,且记录被自愈升级。
  const tofuKey = `127.0.0.1:${sshd.port}`;
  // 另为第二台服务预置一份"错误"指纹(用第一台的指纹冒充):连接 sshd2 时,
  // 记录里的指纹与它实际出示的不符 —— 这就是"服务器更换了主机密钥"的真实形态,
  // 用于验证 T32 的指纹变更弹窗与一键重置信任。
  const fpKey2 = `127.0.0.1:${sshd2.port}`;
  fs.writeFileSync(
    path.join(userData, 'nebulashell-config.json'),
    JSON.stringify({
      knownHosts: { [tofuKey]: sshd.hostFingerprintHex, [fpKey2]: sshd.hostFingerprintB64, [`127.0.0.1:${tileSshd.port}`]: tileSshd.hostFingerprintB64 },
      hosts: [],
      settings: {},
    }),
  );
  const portFile = path.join(work, 'bridge.port');
  const uploadSrc = path.join(work, 'upload.txt');
  const uploadPayload = 'ui-e2e-upload-' + 'Z'.repeat(1024);
  fs.writeFileSync(uploadSrc, uploadPayload);

  proc = spawn(BIN, [], {
    env: {
      ...process.env,
      NEBULA_TEST: '1',
      NEBULA_USER_DATA: userData,
      NEBULA_TEST_BRIDGE_FILE: portFile,
      NEBULA_TEST_PICK_PATHS: uploadSrc,
      NEBULA_TEST_SAVE_PATH: path.join(work, 'hosts-export.json'),
      NEBULA_TEST_IMPORT_PATH: path.join(work, 'hosts-export.json'),
      NEBULA_TEST_EXPORT_DIR: work,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => appLogs.push(String(d)));
  proc.stderr.on('data', (d) => appLogs.push(String(d)));

  // 等测试桥
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(portFile)) {
      bridge = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (bridge > 0) break;
    }
    if (Date.now() - t0 > 40000) throw new Error('测试桥启动超时');
    await sleep(300);
  }
  console.log(`测试桥 :${bridge}`);

  // The initial blank WebView can already be complete before the app loads.
  await waitEval(`return document.readyState`, 'complete', 40000);
  await waitEval(`return !!document.querySelector('#more-menu') && !!window.__nbTest`, 'true', 40000);
  await evalJs(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); window.__menuTrace = []; for (const type of ['focus', 'blur']) window.addEventListener(type, () => window.__menuTrace.push({ type, focus: document.activeElement?.id, at: Date.now() })); 0`);
  check('T1 应用启动 / webview 就绪', true);

  await evalJs(`return document.querySelector('#welcome') ? 1 : 0`);
  // 版本号不再显示在侧边栏左下角,而是收进「关于」弹窗(功能菜单 → 关于)。
  // 断言改为:点开「关于」能看到版本与平台,且侧边栏底部已无版本号。
  await openMenuPage('settings');
  await menuFocus('#btn-about');
  await focusedKey('Enter');
  await waitEval(`window.__nbTest.about().open`, 'true', 10000);
  const about = asObj(await evalJs(`return JSON.stringify(window.__nbTest.about())`));
  check('T2 欢迎页 + 关于弹窗显示版本号', about.version === `v${APP_VERSION}` && !!about.platform, JSON.stringify(about));
  await evalJs(`document.querySelector('#btn-about-close').click(); return 1`);
  const footer = asObj(await evalJs(`return JSON.stringify(window.__nbTest.footer())`));
  check(
    'T2b 侧边栏底部已移除版本号',
    footer.hasVersion === false && !String(footer.text).includes('v' + APP_VERSION),
    JSON.stringify(footer),
  );

  // 新建主机(密码)
  await evalJs(`
    document.querySelector('#btn-add-host').click();
    document.querySelector('#host-name').value = 'ui-a';
    document.querySelector('#host-host').value = '127.0.0.1';
    document.querySelector('#host-port').value = '${sshd.port}';
    document.querySelector('#host-username').value = 'root';
    document.querySelector('#host-password').value = '${PASSWORD}';
    document.querySelector('#btn-host-save').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent`, 'ui-a');
  check('T3 新建主机', true);

  // 凭据持久化(回归:密码保存后 hasPassword 必须为真)
  const cred = await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('hosts:list');
      const h = r.data.find((x) => x.host === '127.0.0.1');
      return JSON.stringify({ hasPassword: h.hasPassword, marked: !document.querySelector('.host-chip') });
    })()`);
  const credObj = asObj(cred);
  check('T4 密码保存生效(hasPassword=true,界面无"待补全凭据")', credObj.hasPassword === true && credObj.marked === true, cred);

  // 连接
  await evalJs(`document.querySelector('.host-item').click(); return 1`);
  await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 30000);
  // 用 textContent 而非 innerText:后者依赖 CSS 布局与可见性计算,
  // xterm 尚未完成首帧渲染时会返回空串,造成偶发超时(约 1/12);
  // textContent 直接读 DOM 文本,更贴合"输出是否已到达终端"的语义。
  // 终端输出走 __NB_TERM_TEXT__ 钩子(buffer API,渲染无关):
  // WebGL 渲染器下文本画在 canvas 上,.xterm-rows 的 DOM 文本恒为空;
  // 且 buffer 不依赖首帧绘制,顺带消除了旧 DOM 断言的偶发首帧超时。
  await waitEval(`return window.__NB_TERM_TEXT__ ? window.__NB_TERM_TEXT__() : (document.querySelector('.term-pane.focused .xterm-rows')||{}).textContent||''`, 'Welcome to NebulaShell mock sshd', 25000);
  check('T5 SSH 连接 + 终端输出', true);

  // legacy hex 指纹被兼容(连接已成功)后,记录必须被自愈升级为现行 base64 格式
  await sleep(500);
  const upgradedFp = JSON.parse(fs.readFileSync(path.join(userData, 'nebulashell-config.json'), 'utf8')).knownHosts[tofuKey];
  check(
    'T5b legacy hex 指纹放行并自愈升级为 base64',
    upgradedFp === sshd.hostFingerprintB64,
    `got=${String(upgradedFp).slice(0, 20)}… want=${sshd.hostFingerprintB64.slice(0, 20)}…`,
  );

  // WebGL 渲染器激活:canvas 由 addon 创建,GL 上下文创建失败会抛错走 DOM 回退,
  // 此时 canvas 不存在 —— 该断言防止渲染器被静默降级而不自知。
  const glCanvas = await evalJs(`return String(!!document.querySelector('.term-pane.focused canvas'))`);
  check('T5c WebGL 渲染器激活(canvas 已挂载)', glCanvas === 'true', glCanvas);
  const terminalViewport = asObj(await evalJs(`return (${auditTerminalViewport.toString()})().then(JSON.stringify)`));
  check('T5d 终端完整行和底部留白不被裁切(5 宽度 × 10 高度)', terminalViewport.issues.length === 0, JSON.stringify(terminalViewport));

  // Run while there is one baseline tab so closing to the last remaining tab
  // can be exercised without ever disconnecting existing baseline sessions.
  await tabTilingRegressions();

  // 分屏
  // 分屏:同一标签内并排两个终端(标签数不变,窗格数 +1)
  // ⛶ 现在直接分屏并自动整理,不再弹方向菜单;新窗格也直接复用当前
  // 已连接主机,不再出现"选择主机"的空窗格步骤。
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, '2', 30000);
  const splitState = await evalJs(`return JSON.stringify({ tabs: document.querySelectorAll('.tab').length, panes: document.querySelectorAll('.term-pane').length })`);
  check('T6 分屏双会话(同一标签内并排)', asObj(splitState).panes === 2, splitState);
  const splitViewport = asObj(await evalJs(`return (${auditTerminalViewport.toString()})().then(JSON.stringify)`));
  check('T6b 分屏和滚动容器内终端完整行不被裁切', splitViewport.issues.length === 0, JSON.stringify(splitViewport));

  // 删除确认对话框(回归:confirm 在 WKWebView 失效 → 已换应用内实现)
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    it.querySelector('.hi-clone').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent`, '副本', 10000);
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('副本'));
    it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    it.querySelector('.hi-del').click(); return 1`);
  // askConfirm 经 FIFO promise 队列打开,不能在 .click() 同一栈内抢读可见性。
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 10000);
  check('T7 删除弹出应用内确认框(替代失效的 confirm)', await evalJs(`return window.__nbTest.confirmOpen()`) === true);

  await evalJs(`document.querySelector('#btn-confirm-ok').click(); return 1`);
  await sleep(800);
  const afterDel = await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('hosts:list');
      return JSON.stringify({ hosts: r.data.length, confirmClosed: document.querySelector('#modal-confirm').classList.contains('hidden') });
    })()`);
  const delObj = asObj(afterDel);
  check('T8 确认后主机被删除 + 弹窗关闭', delObj.hosts === 1 && delObj.confirmClosed === true, afterDel);

  // AI:配置 + 拉取模型 + 对话
  await evalJs(`document.querySelector('#btn-ai-toggle').click(); return 1`);
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-provider').value = 'custom';
    document.querySelector('#ai-provider').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-fetch-models').click(); return 1`);
  await waitEval(`return document.querySelector('#toasts').textContent`, '获取到 3 个模型', 15000);

  // 拉取结果改为弹框多选:每个模型展示"名称 + 属性(归属方/日期)",勾中的才可用
  await waitEval(`return JSON.stringify({ open: window.__nbTest.modelPickerOpen(), ids: window.__nbTest.modelPickerIds() })`, 'mock-model-1', 15000);
  const picker = asObj(await evalJs(`return JSON.stringify({
    open: window.__nbTest.modelPickerOpen(),
    ids: window.__nbTest.modelPickerIds(),
    items: window.__nbTest.modelPickerItems(),
  })`));
  const itemText = picker.items.join(' | ');
  check('T9f 拉取模型弹出多选框，候选含名称与属性',
    picker.open === true && picker.ids.length === 3
    && itemText.includes('mock-model-1') && itemText.includes('mock-provider') && itemText.includes('2026-01-02'),
    JSON.stringify(picker));

  // 只有勾中的模型才可用:全新配置下弹框默认零勾选
  const initial = asObj(await evalJs(`return JSON.stringify({
    checked: window.__nbTest.modelPickerChecked(),
    chips: window.__nbTest.modelChips(),
  })`));
  check('T9g 未勾选的模型不可用(初始零勾选，模型栏为空)',
    initial.checked.length === 0 && initial.chips.length === 0, JSON.stringify(initial));

  // 勾选两个 + 键盘操作:空格切换勾选、↓ 移动焦点
  await evalJs(`window.__nbTest.modelPickerToggle('mock-model-1'); return 1`);
  await evalJs(`window.__nbTest.modelPickerKey('ArrowDown'); return 1`);
  await evalJs(`window.__nbTest.modelPickerKey(' '); return 1`);
  const twoChecked = asObj(await evalJs(`return JSON.stringify({
    checked: window.__nbTest.modelPickerChecked(),
    count: window.__nbTest.modelPickerCount(),
  })`));
  check('T9h 多选:点击与空格都能勾选，计数同步',
    twoChecked.checked.length === 2
    && twoChecked.checked.includes('mock-model-1') && twoChecked.checked.includes('mock-model-2')
    && twoChecked.count.includes('2'), JSON.stringify(twoChecked));

  // 搜索过滤仍可用,且计数反映"命中/总数"
  await evalJs(`window.__nbTest.modelPickerFilter('model-3'); return 1`);
  const filtered = asObj(await evalJs(`return JSON.stringify({ ids: window.__nbTest.modelPickerIds(), count: window.__nbTest.modelPickerCount() })`));
  check('T9i 模型弹框搜索过滤(已勾选不受过滤影响)',
    filtered.ids.length === 1 && filtered.ids[0] === 'mock-model-3' && filtered.count.includes('2'), JSON.stringify(filtered));
  await evalJs(`window.__nbTest.modelPickerFilter(''); return 1`);

  // Esc 只关最上层:模型弹框关闭后,AI 设置必须还开着(否则用户的编辑内容凭空消失)
  await focusedKey('Escape');
  await sleep(200);
  const escState = asObj(await evalJs(`return JSON.stringify({ picker: window.__nbTest.modelPickerOpen(), settings: window.__nbTest.aiSettingsOpen() })`));
  check('T9j Esc 只关最上层的模型弹框,AI 设置仍打开', escState.picker === false && escState.settings === true, JSON.stringify(escState));

  // 重新勾选并确定:勾中的模型必须出现在"模型"一栏(chip)并成为生效模型
  await evalJs(`document.querySelector('#btn-ai-fetch-models').click(); return 1`);
  await sleep(400);
  await evalJs(`window.__nbTest.modelPickerSelectNone(); return 1`);
  await evalJs(`window.__nbTest.modelPickerToggle('mock-model-2'); return 1`);
  await evalJs(`window.__nbTest.modelPickerToggle('mock-model-3'); return 1`);
  await evalJs(`document.querySelector('#btn-model-picker-ok').click(); return 1`);
  await sleep(200);
  const applied = asObj(await evalJs(`return JSON.stringify({
    chips: window.__nbTest.modelChips(),
    active: window.__nbTest.modelChipActive(),
    value: window.__nbTest.modelPickerValue(),
    pickerOpen: window.__nbTest.modelPickerOpen(),
    settingsOpen: window.__nbTest.aiSettingsOpen(),
  })`));
  check('T9k 勾选结果写入"模型"一栏，首个勾选项成为生效模型',
    applied.chips.length === 2 && applied.chips.includes('mock-model-2') && applied.chips.includes('mock-model-3')
    && applied.value === 'mock-model-2' && applied.active === 'mock-model-2'
    && applied.pickerOpen === false && applied.settingsOpen === true,
    JSON.stringify(applied));

  await evalJs(`document.querySelector('#btn-ai-save').click(); return 1`);
  // 保存后"模型切换"下拉只列已启用模型,且选中已保存的生效模型
  await waitEval(`return document.querySelector('#ai-model-switch').value`, 'mock-model-2', 15000);
  const switchState = asObj(await evalJs(`return JSON.stringify({
    options: window.__nbTest.modelSwitchOptions(),
    value: document.querySelector('#ai-model-switch').value,
  })`));
  check('T9l 对话页模型下拉只含已勾选模型',
    switchState.options.length === 2
    && switchState.options.includes('mock-model-2') && switchState.options.includes('mock-model-3')
    && !switchState.options.includes('mock-model-1')
    && switchState.value === 'mock-model-2',
    JSON.stringify(switchState));

  // 温度设置已移除
  const tempGone = await evalJs(`return window.__nbTest.hasTempField() ? 1 : 0`);
  check('T9m 温度设置已从 AI 设置移除', tempGone === 0, String(tempGone));

  // 拉取按钮与"模型"一栏等高(第 4 条)
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await sleep(200);
  const rowH = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiRowHeights())`));
  check('T9n 模型栏与"拉取模型"按钮等高', Math.abs(rowH.btn - rowH.chips) <= 1, JSON.stringify(rowH));
  await evalJs(`document.querySelector('#btn-ai-cancel').click(); return 1`);
  await sleep(200);

  // AI 头部:设置/关闭按钮有间距(第 6 条),模型下拉与按钮等高(第 7 条)
  const headGeom = asObj(await evalJs(`return JSON.stringify({ gap: window.__nbTest.aiHeaderGap(), h: window.__nbTest.aiHeaderHeights() })`));
  check('T9o AI 头部:设置与关闭按钮留间距，模型下拉与按钮等高',
    headGeom.gap >= 6
    && headGeom.h.select === headGeom.h.settings && headGeom.h.select === headGeom.h.close,
    JSON.stringify(headGeom));

  // 流式渲染:先出现"正在思考…"等待态,再逐段落地为正文。
  // 必须走 /slow 端点 —— 正常端点几十毫秒就跑完,等待态一闪而过,断言不可靠。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}/slow';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await waitEval(`return document.querySelector('#modal-ai').classList.contains('hidden') ? 1 : 0`, '1', 15000);
  await evalJs(`document.querySelector('#ai-input').value = '慢速测试'; document.querySelector('#ai-send').click(); return 1`);
  const pendingSeen = await waitEval(
    `return JSON.stringify(window.__nbTest.aiBubbles())`, '"pending":true', 10000,
  ).then(() => true).catch(() => false);
  const pendingShape = asObj(await evalJs(`return JSON.stringify((window.__nbTest.aiBubbles()||[]).slice(-1)[0] || {})`));
  check('T9p 等待响应时显示"正在思考…"气泡(含转圈)',
    pendingSeen && pendingShape.hasSpinner === true && pendingShape.text.includes('正在思考'),
    JSON.stringify(pendingShape));

  // 首个 token 到达后转入流式态(等待占位被清掉),结束后状态收敛
  const streamingSeen = await waitEval(
    `return JSON.stringify(window.__nbTest.aiBubbles())`, '"streaming":true', 15000,
  ).then(() => true).catch(() => false);
  // 先等正文收全,再等 ai:done 把流式标记撤掉 —— 只等正文会在最后一帧
  // 尚未收尾时断言,拿到 streaming:true 的中间态。
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'SLOW-REPLY: 首段 次段', 20000);
  await waitEval(`return JSON.stringify((window.__nbTest.aiBubbles()||[]).slice(-1)[0] || {})`, '"streaming":false', 15000);
  const doneBubbles = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiBubbles())`));
  const lastBubble = doneBubbles[doneBubbles.length - 1] || {};
  check('T9q 流式态可见,结束后清除等待/流式标记并保留正文',
    streamingSeen && lastBubble.pending === false && lastBubble.streaming === false
    && lastBubble.text.includes('SLOW-REPLY: 首段 次段'),
    JSON.stringify({ streamingSeen, lastBubble }));

  // 还原 base,后续用例仍走正常端点
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await sleep(300);

  // 「生成命令」按钮已移除(与"直接提问"重复,且输入框本身就能描述需求)
  const genGone = asObj(await evalJs(`return JSON.stringify({ gone: window.__nbTest.genButtonGone(), noTemp: !window.__nbTest.hasTempField() })`));
  check('T9s 生成命令按钮已移除', genGone.gone === true && genGone.noTemp === true, JSON.stringify(genGone));

  // 发送按钮与输入框等高(用户第 2 条:此前按钮比两行的输入框矮一截)
  const inRow = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiInputHeights())`));
  check('T9t 发送按钮与输入框等高', Math.abs(inRow.input - inRow.send) <= 1, JSON.stringify(inRow));

  // Markdown 渲染 + 每条消息一键复制
  const bootMsgs = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiMsgDetail())`));
  const greet = bootMsgs.find((m) => m.role === 'assistant');
  check('T9u 助手消息按 Markdown 渲染,每条消息带复制按钮',
    greet && greet.mdBlocks > 0 && bootMsgs.every((m) => m.hasCopy)
    && String(await evalJs(`return document.querySelector('#ai-messages .ai-msg .ai-body').innerHTML`)).includes('<strong>'),
    JSON.stringify(bootMsgs.slice(0, 1)));
  await evalJs(`window.__nbTest.aiCopyClick(0); return 1`);
  const copyToast = await waitEval(`return document.querySelector('#toasts').textContent`, '已复制', 10000);
  check('T9v 一键复制消息内容', copyToast.includes('已复制'), copyToast.slice(-60));

  // 中文跨 chunk 乱码回归:mock 逐字节发送含中文的 SSE,多字节字符被拦腰
  // 切开时,按 chunk 做 from_utf8_lossy 会把一个字变两个 �。修复后按行攒字节。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}/utf8split';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await waitEval(`return document.querySelector('#modal-ai').classList.contains('hidden') ? 1 : 0`, '1', 15000);
  await evalJs(`document.querySelector('#ai-input').value = 'utf8测试'; document.querySelector('#ai-send').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, '中文测试-要知', 30000);
  const utf8Text = String(await evalJs(`return document.querySelector('#ai-messages').textContent`));
  check('T9w 中文跨 chunk 不乱码(按行攒字节解码)',
    utf8Text.includes('中文测试-要知') && !utf8Text.includes('\uFFFD'),
    utf8Text.slice(-120));
  // 还原 base,后续用例仍走正常端点
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await sleep(300);

  // —— 滚动行为:贴底跟随 + "回到底部"按钮(T9x 系列) ——
  // /long 端点 120 段 × 60ms 流式,把消息区撑出滚动条。断言全部走 DOM 桥。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}/long';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await waitEval(`return document.querySelector('#modal-ai').classList.contains('hidden') ? 1 : 0`, '1', 15000);
  await evalJs(`document.querySelector('#ai-input').value = '长回复滚动测试'; document.querySelector('#ai-send').click(); return 1`);
  // T9x1: 流式期间贴底跟随(在流式窗口内至少一个采样点距底 ≤24px)
  const t9x1 = await waitEval(`return (() => {
    const b = document.querySelector('#ai-messages');
    const off = b.scrollHeight - b.scrollTop - b.clientHeight;
    return (off <= 24 && !!document.querySelector('.ai-msg.streaming')) ? 'ok'
      : 'off=' + Math.round(off) + ',streaming=' + !!document.querySelector('.ai-msg.streaming');
  })()`, 'ok', 20000).then(() => true).catch((e) => String(e).slice(-120));
  check('T9x1 流式期间贴底跟随最新内容', t9x1 === true, String(t9x1));
  // T9x2: 流式中上滚阅读不被拽回,按钮浮现
  await evalJs(`document.querySelector('#ai-messages').scrollTop = 0; return 1`);
  await sleep(500);
  const t9x2 = asObj(await evalJs(`return JSON.stringify((() => {
    const b = document.querySelector('#ai-messages');
    return { st: Math.round(b.scrollTop), btn: document.querySelector('#ai-scroll-bottom').classList.contains('show'),
      streaming: !!document.querySelector('.ai-msg.streaming') };
  })())`));
  check('T9x2 流式中上滚不被拽回,回到底部按钮浮现',
    t9x2.st <= 2 && t9x2.btn === true && t9x2.streaming === true, JSON.stringify(t9x2));
  // T9x3: 点按钮立即回底(流式态为瞬时滚动,避免被后续帧打断)
  await evalJs(`document.querySelector('#ai-scroll-bottom').click(); return 1`);
  const t9x3 = await waitEval(`return (() => {
    const b = document.querySelector('#ai-messages');
    const off = b.scrollHeight - b.scrollTop - b.clientHeight;
    return off <= 24 ? 'ok' : 'off=' + Math.round(off);
  })()`, 'ok', 8000).then(() => true).catch((e) => String(e).slice(-120));
  check('T9x3 流式态点"回到底部"恢复贴底跟随', t9x3 === true, String(t9x3));
  // 等流式收尾(第 120 段落盘 + streaming 标记撤除)
  await waitEval(`return document.querySelector('#ai-messages').textContent`, '长回复第120段', 30000);
  await waitEval(`return !!document.querySelector('.ai-msg.streaming') ? 'streaming' : 'done'`, 'done', 15000);
  // T9x4: 回复完成后仍停在底部(回归"完成瞬间滚动锚定上跳"),按钮隐藏
  const t9x4 = await waitEval(`return (() => {
    const b = document.querySelector('#ai-messages');
    const off = Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
    const btn = document.querySelector('#ai-scroll-bottom').classList.contains('show');
    return (off <= 2 && !btn) ? 'ok' : 'off=' + off + ',btn=' + btn;
  })()`, 'ok', 8000).then(() => true).catch((e) => String(e).slice(-120));
  check('T9x4 回复完成后停在底部,按钮隐藏', t9x4 === true, String(t9x4));
  // T9x5: 空闲态上滚浮现按钮,点击(平滑)回底后按钮隐藏
  await evalJs(`document.querySelector('#ai-messages').scrollTop = 0; return 1`);
  await sleep(300);
  const t9x5a = asObj(await evalJs(`return JSON.stringify((() => {
    const b = document.querySelector('#ai-messages');
    return { st: Math.round(b.scrollTop), btn: document.querySelector('#ai-scroll-bottom').classList.contains('show') };
  })())`));
  await evalJs(`document.querySelector('#ai-scroll-bottom').click(); return 1`);
  await sleep(900); // 平滑滚动约 300ms,等动画结束再断言
  const t9x5b = asObj(await evalJs(`return JSON.stringify((() => {
    const b = document.querySelector('#ai-messages');
    return { off: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
      btn: document.querySelector('#ai-scroll-bottom').classList.contains('show') };
  })())`));
  check('T9x5 空闲态上滚浮现按钮,点击回底后按钮隐藏',
    t9x5a.st <= 2 && t9x5a.btn === true && t9x5b.off <= 2 && t9x5b.btn === false,
    JSON.stringify({ t9x5a, t9x5b }));
  // T9x6: 面板隐藏期间收到完整回复,经真实入口(#btn-ai-close / #btn-ai-menu)
  // 重开后自动贴底 —— display:none 下滚动全是空操作,重开必须补一次。
  await evalJs(`document.querySelector('#ai-input').value = '隐藏面板滚动测试'; document.querySelector('#ai-send').click(); return 1`);
  await sleep(400);
  await evalJs(`document.querySelector('#btn-ai-close').click(); return 1`);
  // 第二轮流式正文与第一轮相同,用"第120段"出现次数 ≥2 判断第二轮收完
  await waitEval(`return document.querySelector('#ai-messages').textContent.split('长回复第120段').length - 1 >= 2
    && !document.querySelector('.ai-msg.streaming') ? 'done' : 'wait'`, 'done', 30000);
  await evalJs(`document.querySelector('#btn-ai-menu').click(); return 1`);
  const t9x6 = await waitEval(`return (() => {
    const b = document.querySelector('#ai-messages');
    const off = Math.round(b.scrollHeight - b.scrollTop - b.clientHeight);
    return off <= 2 ? 'ok' : 'off=' + off;
  })()`, 'ok', 10000).then(() => true).catch((e) => String(e).slice(-120));
  check('T9x6 面板隐藏期间收到回复,重开自动贴底', t9x6 === true, String(t9x6));
  // 还原 base,后续用例仍走正常端点
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await sleep(300);

  await aiCommandBlockRegressions();

  check('T9 AI 配置 / 模型发现 / 流式对话 / 保存后下拉即时刷新', true);

  // T9b:未保存的表单值可直接"测试连接"(曾误报"未配置");后端流式任务的 HTTP 错误
  // 必须经 ai:error 透出 —— 曾被吞掉,前端永远停在"生成中…"。
  // 用 /err 前缀 base:mock 对该路径的 chat 请求返回 401,若仍走已保存配置则会成功。
  // 模型栏:点 chip 切换生效模型(也可在框内输入 ID 回车添加),先把已勾选的 mock-model-2 选为生效模型。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`document.querySelectorAll('#ai-model-chips .model-chip')[0].click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-provider').value = 'custom';
    document.querySelector('#ai-provider').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ai-protocol').value = 'openai';
    document.querySelector('#ai-protocol').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ai-baseurl').value = '${ai.base}/err';
    document.querySelector('#ai-baseurl').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ai-apikey').value = 'sk-err';
    document.querySelector('#btn-ai-test').click(); return 1`);
  const t9bToast = await waitEval(`return document.querySelector('#toasts').textContent`, '测试失败', 20000);
  check('T9b 未保存表单直测连接 + HTTP 错误透出(不卡生成中)', t9bToast.includes('HTTP 401'), t9bToast);

  // T9c:失败的测试不占用请求槽位,正常对话立即可用
  await evalJs(`document.querySelector('#btn-ai-cancel').click(); return 1`);
  await evalJs(`document.querySelector('#ai-input').value = 'T9b-ok'; document.querySelector('#ai-send').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'T9b-ok', 20000);
  check('T9c 测试失败后请求槽位已释放(可继续对话)', true);

  // SFTP:首次打开默认落在「当前主机命令执行路径」(mock exec 探针返回 ~/data),
  // 路径栏是输入框,断言读 value(textContent 恒空)
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await evalJs(`document.querySelector('#btn-files').click(); return 1`);
  await waitEval(`return window.__nbTest.filePanel().pathValue`, '/home/user/data', 25000);
  const filesOk = await evalJs(`return document.querySelector('#file-list').textContent`);
  check('T10 SFTP 首次打开默认 shell 当前 cwd(~/data)', String(filesOk).includes('app.log'), filesOk.slice(0, 60));

  // —— 文件导航:上一级 / 后退 / 前进(资源管理器逻辑)+ 路径栏编辑 ——
  await evalJs(`document.querySelector('#btn-file-up').click(); return 1`);
  await waitEval(`return document.querySelector('#file-list').textContent`, 'README.md', 20000);
  let nav = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().nav)`));
  check('T10b 上一级到 ~(后退可用/前进禁用)', nav.back === true && nav.forward === false && nav.up === true, JSON.stringify(nav));

  await evalJs(`document.querySelector('#btn-file-back').click(); return 1`);
  await waitEval(`return document.querySelector('#file-list').textContent`, 'app.log', 20000);
  nav = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().nav)`));
  check('T10c 后退回 ~/data(前进恢复可用)', nav.back === false && nav.forward === true && nav.up === true, JSON.stringify(nav));

  await evalJs(`document.querySelector('#btn-file-forward').click(); return 1`);
  await waitEval(`return document.querySelector('#file-list').textContent`, 'README.md', 20000);
  check('T10d 前进到 ~', true);

  // 路径栏输入绝对路径回车跳转(派发真实 keydown,走与用户相同的监听器)
  const setPath = (v) => `
    const el = document.querySelector('#file-path');
    el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1`;
  await evalJs(setPath('/home/user/data'));
  await waitEval(`return document.querySelector('#file-list').textContent`, 'app.log', 20000);
  check('T10e 路径栏回车跳转到 ~/data', true);

  // `~` / `~/x` 是路径栏手输的高频写法:SFTP 协议不认波浪号,
  // 客户端要展开成家目录绝对路径(mock REALPATH '.' → /home/user)
  await evalJs(setPath('~/data'));
  await waitEval(`return document.querySelector('#file-list').textContent`, 'app.log', 20000);
  const tilde = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check('T10e2 路径栏支持 ~ 展开(~/data → /home/user/data)', tilde.cwd === '/home/user/data', tilde.cwd);

  await evalJs(setPath('/no-such-dir-e2e'));
  await waitEval(`return window.__nbTest.filePanel().status`, '加载失败', 20000);
  const badPath = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T10f 路径栏无效路径:报错并回落当前目录',
    badPath.cwd === '/home/user/data' && badPath.pathValue === '/home/user/data',
    JSON.stringify({ cwd: badPath.cwd, pathValue: badPath.pathValue }),
  );

  // 根目录已是顶层:上一级禁用
  await evalJs(setPath('/'));
  await waitEval(`return JSON.stringify(window.__nbTest.filePanel().cwd)`, '"/"', 20000);
  nav = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().nav)`));
  check('T10g 根目录的上一级禁用', nav.up === false, JSON.stringify(nav));

  // 回到 ~:后续用例(T54 右键 README.md 等)依赖当前目录里有它
  await evalJs(setPath('/home/user'));
  await waitEval(`return document.querySelector('#file-list').textContent`, 'README.md', 20000);
  check('T10h 路径栏跳转恢复,回到 ~', true);

  // 文件面板必须标明"操作的是哪台服务器",且在切换会话后跟随
  // (回归:面板原先只写"文件管理",切标签后仍显示上一台的目录,
  //  而操作会落到新会话 —— 看着 A 的目录删 B 的文件)
  const fp0 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T18 文件面板标明目标服务器',
    fp0.open === true && !!fp0.target && fp0.target.includes('@') && fp0.targetId === fp0.activeId,
    JSON.stringify(fp0),
  );

  // —— 4 文件工具栏:导航三连 + 图标化,下载/重命名/删除移入右键菜单 ——
  const tb = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().toolbar)`));
  const tbIds = tb.map((b) => b.id);
  check(
    'T52 文件工具栏 = 导航三连+刷新/收藏/新建/上传(图标按钮)',
    JSON.stringify(tbIds) === JSON.stringify(['btn-file-back', 'btn-file-forward', 'btn-file-up', 'btn-file-refresh', 'btn-file-bookmark', 'btn-file-mkdir', 'btn-file-upload'])
      // 文字按钮已去除:按钮文案应是图标字形,不是"新建文件夹/上传/下载"这类词
      && tb.every((b) => !/新建文件夹|上传|下载|重命名|权限|删除|书签/.test(b.text)),
    JSON.stringify(tb),
  );
  // 文件动作属于文件右键菜单;目录收藏保留独立的可发现入口。
  const goneBtns = await evalJs(`return JSON.stringify(['#btn-file-download','#btn-file-rename','#btn-file-chmod','#btn-file-delete'].filter((s) => document.querySelector(s)))`);
  check('T53 下载/重命名/权限/删除按钮已从工具栏移除', goneBtns === '[]', goneBtns);
  await evalJs(`document.querySelector('#btn-file-bookmark').click(); return 1`);
  await waitEval(`return document.querySelector('#toasts').textContent`, '已收藏当前目录', 10000);
  const bookmark = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check('T53b 可见收藏入口保存当前目录', bookmark.bookmarks.some(b => b.includes(bookmark.cwd)), JSON.stringify(bookmark.bookmarks));

  // 右键文件行 → 弹出针对该文件的菜单(含下载/重命名/权限/删除)
  const fileCtx = asObj(await evalJs(`return JSON.stringify(window.__nbTest.fileCtxMenu('README.md'))`));
  const labels = fileCtx.map((i) => i.label);
  check(
    'T54 右键文件弹出下载/重命名/权限/删除菜单',
    labels.some((l) => l.includes('下载')) && labels.some((l) => l.includes('重命名'))
      && labels.some((l) => l.includes('权限')) && labels.some((l) => l.includes('删除')),
    JSON.stringify(labels),
  );
  // 删除走右键菜单:确认框里的目标名必须是"右键那一行",而不是别的选中项
  await evalJs(`window.__nbTest.ctxItemClick('删除文件'); return 1`);
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 10000);
  const delMsg = String(await evalJs(`return window.__nbTest.confirmText()`));
  check('T54b 右键删除的确认框指向右键的那一行', delMsg.includes('README.md'), delMsg);
  await evalJs(`window.__nbTest.confirmClickCancel(); return 1`); // 不真删(后面用例还要用)

  // —— 右键「打开」:下载临时副本 + 交系统默认程序(test_mode 只落盘不拉起,
  //    否则会在测试机上真的弹开一个编辑器窗口) ——
  const openMenu = asObj(await evalJs(`return JSON.stringify(window.__nbTest.fileCtxMenu('README.md'))`));
  check(
    'T54c 右键文件菜单含「打开(临时副本)」',
    openMenu.some((i) => i.label === '打开(临时副本)') && openMenu.some((i) => i.label === '下载…'),
    JSON.stringify(openMenu.map((i) => i.label)),
  );
  await evalJs(`window.__nbTest.ctxItemClick('打开(临时副本)'); return 1`);
  await waitEval(`return window.__nbTest.filePanel().status`, '已用本地程序打开', 25000);
  const openInfo = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().lastOpen)`));
  const tmpOk = !!(openInfo && openInfo.localPath && fs.existsSync(openInfo.localPath))
    && fs.readFileSync(openInfo.localPath, 'utf8') === 'hello from nebula sftp\n';
  check('T54d 打开 = 远端文件落临时目录(内容一致,未拉起系统程序)', tmpOk, JSON.stringify(openInfo));

  // —— 3 拖拽上传(走 Tauri onDragDropEvent 真实通道) ——
  // 造一个真实本地文件,注入 drag-enter/drop 事件(带面板内的物理坐标)。
  const dropSrc = path.join(work, 'dropped.txt');
  fs.writeFileSync(dropSrc, 'dropped-by-drag-' + 'D'.repeat(512));
  const panelRect = asObj(await evalJs(`return JSON.stringify((() => {
    const r = document.querySelector('#file-panel').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 面板中心(转成物理像素,与真机事件一致)
    return { x: Math.round((r.left + r.width / 2) * dpr), y: Math.round((r.top + r.height / 2) * dpr) };
  })())`));
  await evalJs(`window.__nbTest.fireDragDrop('enter', [${JSON.stringify(dropSrc)}], { x: ${panelRect.x}, y: ${panelRect.y} }); return 1`);
  await sleep(300);
  const hintShown = await evalJs(`return String(window.__nbTest.dropHintVisible())`);
  check('T55 拖入文件面板时显示上传提示', hintShown === 'true', hintShown);
  await evalJs(`window.__nbTest.fireDragDrop('drop', [${JSON.stringify(dropSrc)}], { x: ${panelRect.x}, y: ${panelRect.y} }); return 1`);
  await waitEval(`document.querySelector('#file-list').textContent`, 'dropped.txt', 25000);
  check('T55b 拖放文件实际上传到当前远程目录', true);

  // 云导入:在界面上一张表单填完凭据 + 保存前"测试连接"校验,
  // 然后多账号 CRUD + 一键全区域拉取(腾讯云 CVM+轻量合并)。
  // 回归:轻量实例的 IP 字段名(PublicAddresses)与 CVM(PublicIpAddresses)不同,
  // 旧实现读不到 → 轻量主机被过滤 → "没有获取到可用实例"。
  await evalJs(`document.querySelector('#btn-cloud-import').click(); return 1`);
  await waitEval(`return String(!document.querySelector('#modal-cloud').classList.contains('hidden'))`, 'true', 10000);
  // 打开添加账号表单:厂商切换必须同步字段名(阿里云是 AccessKeyId/Secret)
  await evalJs(`document.querySelector('#btn-cloud-add-account').click(); return 1`);
  const formOpen = asObj(await evalJs(`window.__nbTest.cloudFormFill({ vendor: 'tencent' }); return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T23 云账号凭据表单一次展开(腾讯云字段名)',
    formOpen.open === true && formOpen.editingId === null && formOpen.keyIdLabel === 'SecretId',
    JSON.stringify(formOpen),
  );
  // 密钥帮助随表单厂商切换;外链必须是白名单控制台域名(回归:90f0e96 重构时整块丢失)
  check(
    'T23b 密钥帮助说明随表单展示(腾讯云,白名单外链)',
    formOpen.helpHtml.includes('QcloudCVMReadOnlyAccess')
      && formOpen.helpHtml.includes('data-url="https://console.cloud.tencent.com/cam/capi"')
      && formOpen.helpHtml.includes('密钥仅加密保存在本机'),
    formOpen.helpHtml.slice(0, 80),
  );
  const aliyunLabels = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ vendor: 'aliyun' });
    const a = window.__nbTest.cloudForm();
    window.__nbTest.cloudFormFill({ vendor: 'tencent' });
    return JSON.stringify(a)`));
  check(
    'T24 切换厂商同步字段名与帮助(阿里云 AccessKeyId/AccessKeySecret)',
    aliyunLabels.keyIdLabel === 'AccessKeyId' && aliyunLabels.secretLabel === 'AccessKeySecret'
      && aliyunLabels.helpHtml.includes('AliyunECSReadOnlyAccess')
      && aliyunLabels.helpHtml.includes('data-url="https://ram.console.aliyun.com/manage/ak"'),
    JSON.stringify(aliyunLabels),
  );

  // 负例:故意填错密钥,"测试连接"必须报错且不落库
  await evalJs(`
    window.__nbTest.cloudFormFill({ label: 'e2e错密钥', keyId: 'BADAKID-ui', secret: 'sk-bad', endpoint: '${cloud.base}' });
    window.__nbTest.cloudFormTest(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().testStatus`, '✗', 20000);
  const badTest = asObj(await evalJs(`return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T25 错误密钥测试连接失败且不保存',
    badTest.testStatus.startsWith('✗') && badTest.accountCount === 0,
    JSON.stringify(badTest),
  );
  // 回归:弹窗打开时 syncModalScope 会内联设 z-index 200+,toast 容器曾停在 99,
  // 失败提示被弹窗整个盖住 —— 通知必须浮在所有操作界面之上。
  // 弹窗仍开着,对 toast 中心做命中测试:命中的必须是 toast 自己(而不是弹窗遮罩)。
  await evalJs(`
    window.__nbTest.cloudFormFill({ label: 'e2e错密钥2', keyId: 'BADAKID-ui2', secret: 'sk-bad2', endpoint: '${cloud.base}' });
    window.__nbTest.cloudFormTest(); return 1`);
  const toastTop = await waitEval(`
    const t = document.querySelector('#toasts .toast.error');
    if (!t) return '';
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return 'toast-hit=' + String(hit === t || t.contains(hit));
  `, 'toast-hit=', 20000);
  check('T25b 弹窗打开时失败 toast 保持在最顶层(不被遮挡)', toastTop.includes('toast-hit=true'), toastTop);

  // 正例:正确密钥 → 校验通过(报出地域数/实例数),再保存。
  // 回归:校验曾是"只抽样首个地域"的路径,报的实例数与拉取结果对不上 ——
  // 现在校验与拉取共用同一条全量扫描路径,数字必须一致:
  // mock 里 CVM 地域表 {广州,上海} + 轻量地域表 {广州},共 2 地域 5 台(4 CVM + 1 轻量)。
  await evalJs(`
    window.__nbTest.cloudFormFill({ label: 'e2e账号', keyId: 'AKID-ui', secret: 'sk-ui' });
    window.__nbTest.cloudFormTest(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().testStatus`, '✓', 20000);
  const goodTest = asObj(await evalJs(`return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T26 正确密钥测试连接通过(全量扫描口径:地域与实例数)',
    goodTest.testStatus.includes('校验通过') &&
      goodTest.testStatus.includes('2 个地域') &&
      goodTest.testStatus.includes('共发现 5 台'),
    JSON.stringify(goodTest),
  );
  // 校验结论只对当时那组凭据有效:改动字段后必须作废(否则"✓ 通过"会
  // 停留在未校验过的新值上,用户改错密钥还以为是好的)
  const staleCleared = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ keyId: 'AKID-changed-after-test' });
    return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T31 改动凭据后上次校验结论作废',
    staleCleared.testStatus === '',
    JSON.stringify(staleCleared),
  );
  // 改回来再测一次,恢复通过态以便后续保存
  await evalJs(`
    window.__nbTest.cloudFormFill({ keyId: 'AKID-ui' });
    window.__nbTest.cloudFormTest(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().testStatus`, '✓', 20000);
  await evalJs(`window.__nbTest.cloudFormSave(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().accountCount`, '1', 10000);
  const saved = asObj(await evalJs(`return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T27 保存后表单收起且账号入列',
    saved.open === false && saved.accountCount === 1,
    JSON.stringify(saved),
  );

  // 一键拉取:直接点界面按钮(而非 IPC),验证全区域 CVM+轻量合并
  await evalJs(`document.querySelector('#btn-cloud-fetch').click(); return 1`);
  await waitEval(`return document.querySelector('#cloud-status').textContent`, '获取到', 30000);
  const fetchAll = asObj(await evalJs(`
    return JSON.stringify({
      status: document.querySelector('#cloud-status').textContent,
      rows: document.querySelectorAll('#cloud-tbody .cloud-row').length,
      groups: document.querySelectorAll('#cloud-tbody .cloud-group-row').length,
    })`));
  const lhRow = await evalJs(`return document.querySelector('#cloud-tbody').textContent.includes('203.0.113.30')`);
  const cvmRow = await evalJs(`return document.querySelector('#cloud-tbody').textContent.includes('203.0.113.10')`);
  check(
    'T11 云账号一键拉取(全区域,CVM+轻量合并)',
    fetchAll.rows >= 3 && cvmRow === true && lhRow === true,
    `rows=${fetchAll.rows} groups=${fetchAll.groups} cvm=${cvmRow} lh=${lhRow}`,
  );

  // 编辑已存账号:密钥留空 = 保持不变(不该因"没重输密钥"而保存失败)
  await evalJs(`document.querySelector('.cloud-account-row .ca-edit').click(); return 1`);
  const editState = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ keyId: 'AKID-ui-edited' });
    return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T28 编辑已存账号可留空密钥(placeholder 提示保持不变)',
    editState.open === true && !!editState.editingId && editState.secretLabel.includes('保持不变'),
    JSON.stringify(editState),
  );
  await evalJs(`window.__nbTest.cloudFormSave(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().accountCount`, '1', 10000);
  const afterEdit = asObj(await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('cloud:accounts');
      const a = r.data.accounts[0];
      return JSON.stringify({ count: r.data.accounts.length, keyId: a.keyId, secretSet: a.secretSet });
    })()`));
  check(
    'T29 编辑保存后 keyId 更新且密钥仍保留',
    afterEdit.count === 1 && afterEdit.keyId === 'AKID-ui-edited' && afterEdit.secretSet === true,
    JSON.stringify(afterEdit),
  );

  // 编辑时改厂商不能沿用旧密钥:placeholder 撤销"保持不变"暗示,保存被拦下
  await evalJs(`document.querySelector('.cloud-account-row .ca-edit').click(); return 1`);
  const vendorSwitch = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ vendor: 'aliyun' });
    const s = window.__nbTest.cloudForm();
    window.__nbTest.cloudFormSave();
    return JSON.stringify({ secretLabel: s.secretLabel, keyIdLabel: s.keyIdLabel })`));
  await sleep(400);
  const vendorBlocked = asObj(await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('cloud:accounts');
      return JSON.stringify({ vendor: r.data.accounts[0].vendor, toast: document.querySelector('#toasts').textContent,
                              open: window.__nbTest.cloudForm().open });
    })()`));
  check(
    'T30 编辑改厂商时必须重输密钥(不静默沿用旧密钥)',
    vendorSwitch.keyIdLabel === 'AccessKeyId' && !vendorSwitch.secretLabel.includes('保持不变')
      && vendorBlocked.vendor === 'tencent' && vendorBlocked.toast.includes('请填写 AccessKeySecret')
      && vendorBlocked.open === true,
    `${JSON.stringify(vendorSwitch)} | ${JSON.stringify(vendorBlocked)}`,
  );
  await evalJs(`document.querySelector('#btn-cloud-form-cancel').click(); return 1`);
  await sleep(300);
  await evalJs(`document.querySelector('#btn-cloud-close').click(); return 1`);
  await sleep(300);

  // 同一主机再开一个独立标签(回归:此前同主机点击只切焦点,无法多开会话)
  const beforeTabs = Number(await evalJs(`return document.querySelectorAll('.tab').length`));
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    it.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }));
    return 1`);
  await waitEval(`return document.querySelectorAll('.tab').length`, String(beforeTabs + 1), 30000);
  // 两个会话都要保活:切标签不应销毁另一个会话的终端
  const twoTabs = asObj(await evalJs(`return JSON.stringify(window.__nbTest.tabState())`));
  const allMountedOrAlive = twoTabs.sessions.length >= 2 && twoTabs.sessions.every((s) => s.hasText);
  check('T13 同主机可再开标签且会话互不干扰', twoTabs.tabs === beforeTabs + 1 && allMountedOrAlive, JSON.stringify(twoTabs));

  // 切换会话后,文件面板必须跟着换目标(否则会出现"显示 A、操作到 B")。
  // 用 sessionId 比对:同主机可能有多个会话,按名字比不足以判别。
  // 先等新会话真正 connected:T13 只等到标签出现,此刻新会话可能仍在 connecting,
  // 面板会短暂停在"未连接"(followFilePanel 在 ssh:status → connected 时才补一次),
  // 直接断言就会偶发失败。
  await waitEval(`return String(!!window.__nbTest.filePanel().targetId)`, 'true', 20000);
  const fpFollow = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T19 切换会话后文件面板跟随目标',
    !!fpFollow.targetId && fpFollow.targetId === fpFollow.activeId,
    JSON.stringify(fpFollow),
  );

  // 诊断报错只取"最后一次输入的命令 + 其后的控制台输出",不再扫整屏:
  // 整屏里早前的欢迎横幅等无关内容会稀释诊断焦点。
  // 此刻 ui-a 会话已连接,直接敲一条带标记的命令。
  await evalJs(`window.__nbTest.write('echo NB_DIAG_MARK_42\\r'); return 1`);
  await sleep(900);
  const diagSrc = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
  check('T9x 诊断素材 = 最后一次命令及其后的输出(不含更早的整屏)',
    diagSrc.cmd.includes('NB_DIAG_MARK_42') && diagSrc.output.includes('NB_DIAG_MARK_42')
    && !diagSrc.output.includes('Welcome to NebulaShell'),
    JSON.stringify(diagSrc));

  // 点「诊断报错」:AI 提问里应带上这条命令,而不带整屏历史
  await evalJs(`
    if (document.querySelector('#ai-panel').classList.contains('hidden')) document.querySelector('#btn-ai-toggle').click();
    return 1`);
  await evalJs(`document.querySelector('#btn-ai-diagnose').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'NB_DIAG_MARK_42', 20000);
  const diagMsgs = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiMsgDetail())`));
  const diagUser = [...diagMsgs].reverse().find((m) => m.role === 'user');
  check('T9y 诊断提问只含最后一次命令与输出',
    diagUser && diagUser.text.includes('NB_DIAG_MARK_42')
    && !diagUser.text.includes('Welcome to NebulaShell mock sshd'),
    JSON.stringify(diagUser));
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'MOCK-REPLY', 20000);

  // 放大按钮回归:单窗格时不得进入"已放大"态(视觉无变化,角标让用户以为按钮失效)
  // 此时处于 T13 的新标签里(单窗格)
  await evalJs(`
    const pane = document.querySelector('.term-pane.focused') || document.querySelector('.term-pane');
    (pane.querySelector('.pane-zoom-btn')||{}).click?.();    return 1`);
  await sleep(1200);
  const noZoom = asObj(await evalJs(`return JSON.stringify({ chip: !!document.querySelector('.zoom-chip'), disabled: document.querySelector('.term-pane .pane-zoom-btn').disabled, panes: document.querySelectorAll('.term-pane').length })`));
  check(
    'T20 单窗格放大按钮禁用且不进入无效放大态',
    noZoom.chip === false && noZoom.disabled === true && noZoom.panes === 1,
    JSON.stringify(noZoom),
  );

  // 分屏放大在足够大的终端区验收;双侧面板造成的不足宽度另有容量阻止回归。
  await evalJs(`
    if (!document.querySelector('#ai-panel').classList.contains('hidden')) document.querySelector('#btn-ai-close').click();
    if (!document.querySelector('#file-panel').classList.contains('hidden')) document.querySelector('#btn-file-close').click();
    return 1`);
  await waitEval(`return String(!document.querySelector('#btn-split').disabled)`, 'true', 10000);
  // 分屏 → 放大 → 窗格占满;还原后窗格数恢复(⛶ 直接分屏,新窗格复用当前主机)
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, '2', 30000);
  await evalJs(`document.querySelector('.term-pane.focused .pane-zoom-btn').click(); return 1`);
  await waitEval(`return String(!!document.querySelector('.zoom-chip'))`, 'true', 10000);
  const zoomed = asObj(await evalJs(`return JSON.stringify((() => {
    const ps = [...document.querySelectorAll('.term-pane')].map(p => Math.round(p.getBoundingClientRect().width));
    return { chip: !!document.querySelector('.zoom-chip'), panes: ps, maxW: Math.max(...ps) };
  })())`));
  check(
    'T21 分屏后放大窗格占满终端区',
    zoomed.chip === true && zoomed.panes.length === 1,
    JSON.stringify(zoomed),
  );
  await evalJs(`document.querySelector('.zoom-chip').click(); return 1`);
  await waitEval(`return String(!!document.querySelector('.zoom-chip'))`, 'false', 10000);
  const panesRestored = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
  check('T22 还原后恢复分屏布局', panesRestored === 2, `panes=${panesRestored}`);

  // 资源监控:固定显示在状态栏,采样值长度会变(9.2% ↔ 100%、890B/s ↔ 12.5GB/s、
  // 内存 (488/976MB) ↔ (128/128GB)),每 3s 刷新一次。
  // 回归两件事:①数值变化不得推动同一行里的行尾按钮;②状态栏不得因此折行(折行会占终端高度)。
  const monSamples = [
    // 首个采样到达前:所有字段都是占位符("…"/"")——占位与实数之间的切换正是抖动高发区
    { cpuPct: null, memPct: null, memUsedMB: null, memTotalMB: null, diskPct: null, diskUsedGB: null, diskTotalGB: null, rxBps: null, txBps: null, latencyMs: null },
    { cpuPct: 5, memPct: 9.7, memUsedMB: 46, memTotalMB: 976, diskPct: 4, diskUsedGB: 4, diskTotalGB: 100, rxBps: 0, txBps: 0, latencyMs: 45 },
    { cpuPct: 9.2, memPct: 50, memUsedMB: 488, memTotalMB: 976, diskPct: 40, diskUsedGB: 400, diskTotalGB: 1000, rxBps: 890, txBps: 1536, latencyMs: 123 },
    { cpuPct: 12.5, memPct: 33.3, memUsedMB: 8192, memTotalMB: 24576, diskPct: 55.5, diskUsedGB: 102.4, diskTotalGB: 200, rxBps: 1048576, txBps: 524288, latencyMs: 999 },
    { cpuPct: 100, memPct: 100, memUsedMB: 131072, memTotalMB: 131072, diskPct: 99.9, diskUsedGB: 10240, diskTotalGB: 10240, rxBps: 1073741824, txBps: 1073741824, latencyMs: 1500 },
  ];
  const monRows = asObj(await evalJs(`return JSON.stringify(window.__nbTest.monitorProbe(${JSON.stringify(monSamples)}))`));
  const monDrift = (() => {
    if (!Array.isArray(monRows) || !monRows.length) return { err: 'no rows' };
    const keys = Object.keys(monRows[0]).filter((k) => k !== '__text' && k !== '__bar');
    let maxLeft = 0; let maxWidth = 0;
    for (const k of keys) {
      const L = monRows.map((r) => r[k][0]);
      const W = monRows.map((r) => r[k][1]);
      maxLeft = Math.max(maxLeft, Math.max(...L) - Math.min(...L));
      maxWidth = Math.max(maxWidth, Math.max(...W) - Math.min(...W));
    }
    const heights = [...new Set(monRows.map((r) => r.__bar[0]))];
    // 行尾按钮的右边缘在所有采样下必须完全一致(监控不得推开按钮)
    const btnRights = monRows.map((r) => JSON.stringify(r.__bar[3]));
    const btnStable = [...new Set(btnRights)].length === 1;
    const overflow = Math.max(...monRows.map((r) => r.__bar[1]));
    return { maxLeft, maxWidth, heights, overflow, btnStable, btns: btnRights[0] };
  })();
  // 先确认值真的变了(否则"几何不变"可能只是没渲染):覆盖 占位 → 小值 → 常规 → 极值
  // 同时锁定新格式契约:≤1 位小数、去尾 .0、内存/磁盘详情自动换 GB/TB、延迟自适应单位
  const monTexts = Array.isArray(monRows) ? monRows.map((r) => r.__text) : [];
  check(
    'T34 监控数值随采样更新(非空转,格式收口)',
    monTexts.length === monSamples.length
      && monTexts[0].cpu === '…'
      && monTexts[2].cpu === '9.2%'
      && monTexts[4].cpu === '100%'
      && monTexts[2].mem === '(488/976MB)' && monTexts[4].mem === '(128/128GB)'
      && monTexts[3].mem === '(8/24GB)'
      && monTexts[3].disk === '(102.4/200GB)' && monTexts[4].disk === '(10/10TB)'
      && monTexts[2].rx === '890B/s' && monTexts[4].rx === '1GB/s'
      && monTexts[0].lat === '–' && monTexts[1].lat === '45ms'
      && monTexts[3].lat === '999ms' && monTexts[4].lat === '1.5s',
    JSON.stringify(monTexts).slice(0, 300),
  );
  check(
    'T35 监控布局不随数据长度抖动,且不推动行尾按钮',
    monDrift.maxLeft <= 0.6 && monDrift.maxWidth <= 0.6 && monDrift.heights.length === 1 && monDrift.overflow <= 0 && monDrift.btnStable,
    JSON.stringify(monDrift),
  );
  // 极端数值(1TB 内存 / 100TB 盘 / 100GbE)也不得改变状态栏高度或推开按钮:
  // 槽位定长 + overflow 兜底,超出槽宽的字符在自己槽内被裁。
  const monWorst = asObj(await evalJs(`return JSON.stringify(window.__nbTest.monitorProbe([
    { cpuPct: 100, memPct: 100, memUsedMB: 1048576, memTotalMB: 1048576, diskPct: 100, diskUsedGB: 102400, diskTotalGB: 102400, rxBps: 13421772800, txBps: 13421772800 }
  ]))`));
  const monBaseH = monRows[2].__bar[0];
  check(
    'T36 监控超大数值不撑高/不推开按钮',
    Array.isArray(monWorst) && monWorst[0].__bar[0] === monBaseH && monWorst[0].__bar[1] <= 0
      && JSON.stringify(monWorst[0].__bar[3]) === JSON.stringify(monRows[2].__bar[3]),
    JSON.stringify({ worst: monWorst && monWorst[0] && monWorst[0].__bar, base: monRows[2].__bar }),
  );
  // "暂不支持"是终态:文案比任何数值都长,曾把整条撑成两行。切到专用布局后必须仍是一行。
  const monUnsup = asObj(await evalJs(`return JSON.stringify(window.__nbTest.monitorProbe([
    { cpuPct: null, memPct: null, diskPct: null, rxBps: null, txBps: null, supported: false }
  ]))`));
  check(
    'T37 监控"不支持"终态仍是单行(不撑高)',
    Array.isArray(monUnsup) && monUnsup[0].__bar[0] === monBaseH && monUnsup[0].__bar[1] <= 0
      && String(monUnsup[0].__text.note).includes('仅支持 Linux'),
    JSON.stringify(monUnsup && monUnsup[0] && { bar: monUnsup[0].__bar, note: monUnsup[0].__text.note }),
  );

  // 右键:屏蔽 WebView 原生菜单,终端内弹应用菜单
  const ctx = asObj(await evalJs(`return JSON.stringify((() => {
    const pane = document.querySelector('.term-pane .xterm');
    const r = (pane || document.body).getBoundingClientRect();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 });
    (pane || document.body).dispatchEvent(e);
    const menu = document.querySelector('#ctx-menu');
    return { prevented: e.defaultPrevented, items: menu.querySelectorAll('.ctx-item').length };
  })())`));
  check('T14 右键屏蔽原生菜单并弹出应用菜单', ctx.prevented === true && ctx.items >= 4, JSON.stringify(ctx));

  // 按钮尺寸收敛(回归:此前存在 15/27/28/42px 四种高度混杂)
  const btnHeights = await evalJs(`return JSON.stringify((() => {
    const hs = new Set();
    for (const b of document.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.height > 0 && !b.closest('.hidden') && !b.closest('#ctx-menu')) hs.add(Math.round(r.height));
    }
    return [...hs].sort((a, b) => a - b);
  })())`);
  const heights = asObj(btnHeights);
  // ≤5 档:AI 助手输入行的发送按钮按用户要求与两行输入框等高(50px),
  // 是有意引入的第 5 档 —— 输入控件旁的按钮随输入框拉伸,不套通用刻度。
  check('T15 按钮高度层级收敛(≤5 档)', Array.isArray(heights) && heights.length <= 5, JSON.stringify(heights));

  // 导出:走带口令的加密导出,随后直接检查落盘文件不含明文凭据
  const exportPath = path.join(work, 'hosts-export.json');
  await evalJs(`window.__exportPath = ${JSON.stringify(exportPath)}; return 1`);
  await evalJs(`document.querySelector('#btn-hosts-export').click(); return 1`);
  await answerPrompt('e2e-passphrase-1', '导出主机');
  // 二次确认口令(标题不同,answerPrompt 靠标题区分两个框)
  await answerPrompt('e2e-passphrase-1', '确认口令');
  // 等文件落盘(mock 保存路径由 NEBULA_TEST_SAVE_PATH 决定)。
  // 预算放宽到 60s:带口令导出要走 scrypt 派生(N=2^15),e2e 跑的是 **debug 构建**,
  // 未优化下单次派生实测 ~2.9s,机器负载高(load avg 30+)时可达 20-48s ——
  // 15s 的旧预算会间歇性超时。测的是导出正确性,不是加密耗时。
  let exportText = '';
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    if (fs.existsSync(exportPath)) {
      const t = fs.readFileSync(exportPath, 'utf8');
      if (t.includes('credentialsIncluded')) { exportText = t; break; } // 等写完整
    }
  }
  const exportObj = exportText ? JSON.parse(exportText) : {};
  // 不能用 /password/i 这类关键词判断 —— authType:"password" 与 credentialsIncluded
  // 等键名本身就会命中。要断言的是"主机字段里没有明文凭据值"。
  const credFields = (exportObj.hosts || []).flatMap((h) =>
    ['password', 'privateKey', 'passphrase'].map((k) => h[k]));
  const hasPlainCredField = credFields.some((v) => v !== undefined && v !== null && String(v) !== '');
  const leaksValue = exportText.includes(PASSWORD) || /BEGIN [A-Z ]*PRIVATE KEY/.test(exportText);
  check(
    'T16 导出含加密凭据且文件无明文密码',
    exportObj.credentialsIncluded === true && !!exportObj.credentials && !hasPlainCredField && !leaksValue,
    `included=${exportObj.credentialsIncluded} plainField=${hasPlainCredField} leakedValue=${leaksValue}`,
  );

  // 导入验证:先删掉该主机,再从导出文件导回 —— 这样能真正检验"凭据被恢复",
  // 而不是被去重逻辑挡掉(同一 profile 里主机还在时会算重复)。
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    it.querySelector('.hi-del').click(); return 1`);
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 10000);
  await evalJs(`window.__nbTest.confirmClickOk(); return 1`);
  await sleep(800);
  await evalJs(`document.querySelector('#btn-hosts-import').click(); return 1`);
  await answerPrompt('e2e-passphrase-1', '输入解密口令');
  // 导入同样要走 scrypt 派生(debug 构建下数秒,高负载时更久),预算放宽
  await waitEval(`document.querySelector('#toasts').textContent`, '导入完成', 60000);
  const importToast = await evalJs(`return document.querySelector('#toasts').textContent`);
  // 恢复后的主机应带凭据(界面不再标记"待补全凭据")
  const restored = asObj(await evalJs(`return JSON.stringify((() => {
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    return { chip: !!(it && it.querySelector('.host-chip')), hosts: document.querySelectorAll('.host-item').length };
  })())`));
  check(
    'T17 导入加密导出文件并恢复凭据',
    String(importToast).includes('恢复凭据') && restored.chip === false,
    `${String(importToast).slice(0, 90)} | chip=${restored.chip}`,
  );

  // 指纹变更(B6):预置的记录与服务器实际出示的指纹不符 → 连接被拒,
  // 应弹出"服务器指纹已变更"确认框(默认焦点在"取消",避免顺手回车放行),
  // 确认后删除旧记录并重连成功。这是"服务器换钥后怎么恢复"的唯一出口,
  // 也是 TOFU 的安全语义所在 —— 恢复必须由用户主动确认,而非静默自动信任。
  await evalJs(`
    document.querySelector('#btn-add-host').click();
    document.querySelector('#host-name').value = 'ui-fp';
    document.querySelector('#host-host').value = '127.0.0.1';
    document.querySelector('#host-port').value = '${sshd2.port}';
    document.querySelector('#host-username').value = 'root';
    document.querySelector('#host-password').value = '${PASSWORD}';
    document.querySelector('#btn-host-save').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent`, 'ui-fp', 15000);
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-fp'));
    it.click(); return 1`);
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 20000);
  const fpDialog = asObj(await evalJs(`return JSON.stringify({
    title: window.__nbTest.confirmTitle(),
    focus: window.__nbTest.confirmFocus(),
    text: window.__nbTest.confirmText(),
    toast: document.querySelector('#toasts').textContent,
    status: document.querySelector('#status-text').textContent,
  })`));
  check(
    'T32 指纹变更:弹窗含新旧指纹且默认焦点在"取消"',
    fpDialog.title === '服务器指纹已变更'
      && fpDialog.focus === 'cancel'
      && fpDialog.text.includes(sshd.hostFingerprintB64)
      && fpDialog.text.includes(sshd2.hostFingerprintB64),
    JSON.stringify({ title: fpDialog.title, focus: fpDialog.focus }),
  );
  // 可机读标记是前后端之间的内部协议,绝不能漏到用户可见的任何位置
  check(
    'T32b 指纹标记不泄漏到界面(toast/状态栏/弹窗正文)',
    !fpDialog.text.includes('NB-FP')
      && !fpDialog.toast.includes('NB-FP')
      && !fpDialog.status.includes('NB-FP'),
    JSON.stringify({ toast: String(fpDialog.toast).slice(0, 80) }),
  );

  // 确认"重新信任并重连" → 删除旧记录、重连成功
  await evalJs(`window.__nbTest.confirmClickOk(); return 1`);
  await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 30000);
  await sleep(500); // 等新指纹落盘
  const refp = JSON.parse(fs.readFileSync(path.join(userData, 'nebulashell-config.json'), 'utf8')).knownHosts[fpKey2];
  check(
    'T33 重新信任后记录更新为服务器实际指纹',
    refp === sshd2.hostFingerprintB64,
    `got=${String(refp).slice(0, 16)}… want=${sshd2.hostFingerprintB64.slice(0, 16)}…`,
  );

  // 缩到不足单格宽度时不得继续分屏,但不能销毁已有会话。
  const narrowBefore = asObj(await evalJs(`return JSON.stringify(window.__nbTest.tabState())`));
  await evalJs(`const lr = document.querySelector('#layout-root'); window.__narrowLayoutStyle = lr.style.cssText;
    lr.style.width = '319px'; lr.style.height = '550px'; lr.style.flex = 'none'; return 1`);
  await openMenuPage();
  if (narrowBefore.panes > 1) {
    await menuFocus('#btn-auto-layout');
    await focusedKey('Enter');
  } else await focusedKey('Escape');
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  const narrow = asObj(await evalJs(`return JSON.stringify({ state: window.__nbTest.tabState(),
    disabled: document.querySelector('#btn-split').disabled, width: document.querySelector('#layout-root').offsetWidth,
    scrollable: getComputedStyle(document.querySelector('#layout-root')).overflow === 'auto' })`));
  check('T38a 不足 320px 时禁止新增分屏并保留全部原会话', narrow.width === 319 && narrow.disabled
    && narrow.scrollable && JSON.stringify(narrow.state) === JSON.stringify(narrowBefore), JSON.stringify(narrow));
  await evalJs(`document.querySelector('#layout-root').style.cssText = window.__narrowLayoutStyle;
    delete window.__narrowLayoutStyle;
    if (!document.querySelector('#ai-panel').classList.contains('hidden')) document.querySelector('#btn-ai-close').click();
    if (!document.querySelector('#file-panel').classList.contains('hidden')) document.querySelector('#btn-file-close').click();
    return 1`);

  // 分屏入口统一为工具栏按钮;根页仅保留整理/放大/关闭,不再有方向菜单。
  await openMenuPage();
  const splitMenu = asObj(await evalJs(`return JSON.stringify((() => {
    const root = document.querySelector('#more-menu .mm-page[data-page="root"]');
    return {
      items: [...root.querySelectorAll('.btn')].map((b) => b.textContent.trim()),
      commands: [...root.querySelectorAll('[data-command]')].map((b) => b.dataset.command),
      splitCommand: document.querySelector('#btn-split').dataset.command,
      hasDirections: window.__nbTest.accelTitles().hasDirectionMenus,
    };
  })())`));
  check(
    'T38 统一分屏入口,根菜单保留整理/放大/关闭且无方向按钮',
    splitMenu.splitCommand === 'pane.split' && splitMenu.hasDirections === false
      && ['pane.reflow', 'pane.zoom', 'workspace.close'].every((id) => splitMenu.commands.includes(id)),
    JSON.stringify(splitMenu),
  );
  await focusedKey('Escape');
  const beforePanes = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  // 分屏不再经过"选择主机"的空窗格:新窗格直接复用当前已连接主机
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, String(beforePanes + 1), 30000);
  // 关闭当前窗格:曾经分屏后无法退出(空窗格更没有入口)。
  // 关掉 N 个窗格中的一个后应剩 N-1 个;只有回到 1 个时布局树才不再有分隔节点。
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(200);
  await evalJs(`document.querySelector('#btn-close-pane').click(); return 1`);
  await sleep(1200);
  const afterClose = asObj(await evalJs(`return JSON.stringify({ panes: document.querySelectorAll('.term-pane').length, nodes: document.querySelectorAll('.split-node').length })`));
  check(
    'T40 关闭当前窗格可退出分屏(窗格数 -1)',
    afterClose.panes === beforePanes && afterClose.nodes === Math.max(0, beforePanes - 1),
    JSON.stringify({ ...afterClose, beforePanes }),
  );

  // 多分屏可达性 + 自动整理布局:容量上限由 320×180 与 5px 分隔条计算。
  // 命令在满容量时禁用,不再要求禁用按钮仍制造 toast。
  const splitLimit = Number(await evalJs(`const lr = document.querySelector('#layout-root');
    return Math.max(1, Math.floor((lr.clientWidth + 5) / 325)) * Math.max(1, Math.floor((lr.clientHeight + 5) / 185))`));
  for (let i = 0; i <= splitLimit; i++) {
    const before = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
    await evalJs(`document.querySelector('#btn-split').click(); return 1`);
    const after = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
    if (after === before) break;
    await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, String(after), 20000);
    await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 20000);
  }
  const many = asObj(await evalJs(`return JSON.stringify((() => {
    const lr = document.querySelector('#layout-root');
    return { panes: document.querySelectorAll('.term-pane').length, canScroll: lr.scrollWidth > lr.clientWidth + 1 || lr.scrollHeight > lr.clientHeight + 1, ow: getComputedStyle(lr).overflow, splitDisabled: document.querySelector('#btn-split').disabled };
  })())`));
  check(
    'T41 多窗格不溢出可视区(受容量上限约束)',
    many.panes >= 2 && many.panes === splitLimit && many.splitDisabled && !many.canScroll && many.ow === 'auto',
    JSON.stringify(many),
  );
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(200);
  await evalJs(`document.querySelector('#btn-auto-layout').click(); return 1`);
  await sleep(1200);
  const auto = asObj(await evalJs(`return JSON.stringify((() => {
    const panes = [...document.querySelectorAll('.term-pane')].map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
    const lr = document.querySelector('#layout-root');
    const tops = [...new Set(panes.map((p) => p[1]))].sort((a, b) => a - b);
    const rows = tops.map((t) => panes.filter((p) => p[1] === t).length);
    return {
      count: panes.length, rows, panes,
      capacity: Math.max(1, Math.floor((lr.clientWidth + 5) / 325)) * Math.max(1, Math.floor((lr.clientHeight + 5) / 185)),
      // 尺寸规划器可选横向或纵向网格,每格至少 320×180。
      overflowX: lr.scrollWidth - lr.clientWidth, overflowY: lr.scrollHeight - lr.clientHeight,
      scrollable: getComputedStyle(lr).overflow === 'auto',
      minW: Math.min(...panes.map((p) => p[2])), minH: Math.min(...panes.map((p) => p[3])),
    };
  })())`));
  check(
    'T42 自动整理布局:行列均衡的网格',
    auto.count >= 2 && auto.count === auto.capacity
      && balancedGrid(auto.panes)
      && auto.overflowX <= 1 && auto.overflowY <= 1 && auto.scrollable
      // 不以滚动豁免容量内的溢出,也不再接受 100px 的不可用窄条。
      && auto.minW >= 319 && auto.minH >= 179,
    JSON.stringify(auto),
  );
  // 收尾:把上面开出来的一堆窗格关回 1 个,避免影响后续用例(它们假定特定的窗格数)
  for (let i = 0; i < 10; i++) {
    const n = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
    if (n <= 1) break;
    await evalJs(`document.querySelector('#btn-more').click(); return 1`);
    await sleep(120);
    await evalJs(`document.querySelector('#btn-close-pane').click(); return 1`);
    await sleep(400);
  }
  const restoredPanes = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
  check('T42b 连续关闭可回到单窗格', restoredPanes === 1, `panes=${restoredPanes}`);



  // 浮动面板:可拖动 + 有明确关闭入口(此前只能用 Esc 或重复点菜单按钮)
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(150);
  await evalJs(`document.querySelector('#btn-snippets').click(); return 1`);
  await sleep(400);
  const snip = asObj(await evalJs(`return JSON.stringify((() => {
    const m = document.querySelector('#snippet-menu');
    const head = m.querySelector('.pop-head');
    const hb = head.getBoundingClientRect();
    const before = m.getBoundingClientRect();
    const fire = (t, x, y, target) => (target || document).dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    fire('mousedown', hb.left + 40, hb.top + 8, head);
    fire('mousemove', hb.left + 140, hb.top + 88, document);
    fire('mouseup', hb.left + 140, hb.top + 88, document);
    const after = m.getBoundingClientRect();
    return { open: !m.classList.contains('hidden'), hasClose: !!m.querySelector('#btn-snippet-close'), dx: Math.round(after.left - before.left), dy: Math.round(after.top - before.top) };
  })())`));
  check(
    'T43 片段面板可拖动且有关闭按钮',
    snip.hasClose && (snip.dx !== 0 || snip.dy !== 0),
    JSON.stringify(snip),
  );
  const snipClosed = await evalJs(`document.querySelector('#btn-snippet-close').click(); return JSON.stringify({ hidden: document.querySelector('#snippet-menu').classList.contains('hidden') })`);
  check('T44 片段面板关闭按钮可收起', asObj(snipClosed).hidden === true, snipClosed);

  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(150);
  await evalJs(`document.querySelector('#btn-history').click(); return 1`);
  await sleep(600);
  const hist = asObj(await evalJs(`return JSON.stringify((() => {
    const p = document.querySelector('#history-panel');
    if (!p) return { missing: true };
    return { open: !p.classList.contains('hidden'), hasClose: !!p.querySelector('#hist-close'), hasSearch: !!p.querySelector('#hist-search') };
  })())`));
  check('T45 历史面板有关闭按钮', hist.hasClose === true && hist.hasSearch === true, JSON.stringify(hist));
  const histClosed = await evalJs(`document.querySelector('#hist-close').click(); return JSON.stringify({ hidden: document.querySelector('#history-panel').classList.contains('hidden') })`);
  check('T46 历史面板关闭按钮可收起', asObj(histClosed).hidden === true, histClosed);

  // 交互动效:存在动画,且带 prefers-reduced-motion 兜底(无障碍)
  await openMenuPage();
  const anim = asObj(await evalJs(`return JSON.stringify((() => {
    const mm = document.querySelector('#more-menu');
    const menuAnim = getComputedStyle(mm).animationName;
    let reduced = false;
    for (const s of document.styleSheets) {
      try { if ([...s.cssRules].some((r) => r.conditionText && r.conditionText.includes('prefers-reduced-motion'))) reduced = true; } catch { /* ignore */ }
    }
    return { menuAnim, reduced };
  })())`));
  check(
    'T47 存在交互动效且尊重 prefers-reduced-motion',
    anim.menuAnim && anim.menuAnim !== 'none' && anim.reduced === true,
    JSON.stringify(anim),
  );
  await focusedKey('Escape');

  // 对齐类缺陷是像素级可测的,不必靠肉眼:逐一量出边界并断言一致。
  await openMenuPage();
  const align = asObj(await evalJs(`return JSON.stringify((() => {
    // ① 标签栏右侧按钮:顶边与垂直中心都必须一致(曾因 .ai-btn 单加 margin-bottom 而错位)
    const tbIds = ['#btn-newtab', '#btn-split', '#btn-ai-toggle', '#btn-more'];
    const tbs = tbIds.map((id) => { const r = document.querySelector(id).getBoundingClientRect(); return { id, top: Math.round(r.top * 10) / 10, cy: Math.round((r.top + r.height / 2) * 10) / 10 }; });
    const tabbarAligned = new Set(tbs.map((t) => t.top)).size === 1 && new Set(tbs.map((t) => t.cy)).size === 1;
    // ② 竖向根页:图标、显式 .mm-label 列与行高都可测,不把隐藏页的零矩形算入。
    const mm = document.querySelector('#more-menu');
    const items = [...mm.querySelectorAll('.mm-page:not(.hidden) .btn')].map((b) => {
      const br = b.getBoundingClientRect();
      const mr = b.querySelector('.mi').getBoundingClientRect();
      const lr = b.querySelector('.mm-label').getBoundingClientRect();
      return { labelLeft: Math.round(lr.left * 10) / 10, gap: Math.round((lr.left - mr.right) * 10) / 10,
        h: br.height, dCy: Math.round(Math.abs((mr.top + mr.height / 2) - (br.top + br.height / 2)) * 10) / 10 };
    });
    const menuGapUniform = items.length > 0 && new Set(items.map((i) => i.gap)).size === 1
      && new Set(items.map((i) => i.labelLeft)).size === 1 && items.every((i) => i.gap >= 6 && i.h >= 34);
    const menuIconCentered = items.every((i) => i.dCy <= 1);
    return { tabbarAligned, menuGapUniform, menuIconCentered, items, maxIconDCy: Math.max(...items.map((i) => i.dCy)) };
  })())`));
  check(
    'T48 标签栏按钮对齐 / 菜单图标-文字间距一致且图标居中',
    align.tabbarAligned && align.menuGapUniform && align.menuIconCentered,
    JSON.stringify(align),
  );
  await focusedKey('Escape');

  // 状态栏监控:窄窗口下必须"先收缩监控/状态文字,绝不遮挡行尾按钮",且高度恒定。
  // 宽度取现实档位:1248 = 14 寸默认(1512 − 侧栏 264);888 = 14 寸 + AI 面板(曾
  // 因降级档位差 8px 不触发而被静默裁掉网络数值);其余为逐级收窄的档位。
  // monClip 检查监控条**内部**裁切:容器级 overflow 只保证按钮在界内,监控条
  // 自己 overflow:hidden 仍可能把最后的网络数值裁没 —— 这是本轮踩的坑。
  const sbWidths = [1248, 1016, 900, 888, 700, 640, 500, 420, 380, 316];
  const sbProbe = asObj(await evalJs(`return JSON.stringify(${JSON.stringify(sbWidths)}.map((w) => {
    const main = document.querySelector('#main');
    const save = main.style.cssText;
    main.style.flex = '0 0 ' + w + 'px'; main.style.width = w + 'px';
    void main.getBoundingClientRect();
    const sb = document.querySelector('#statusbar');
    const sbR = sb.getBoundingClientRect();
    const mon = document.querySelector('#monitor-bar');
    const monVis = getComputedStyle(mon).display !== 'none';
    const monR = mon.getBoundingClientRect();
    const btns = [...sb.querySelectorAll('.btn')].filter((e) => !e.classList.contains('hidden'))
      .map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    const out = {
      w,
      h: Math.round(sbR.height),
      overflow: sb.scrollWidth - sb.clientWidth,
      allBtnsInside: btns.every((b) => b.right <= sbR.right + 0.5 && b.left >= sbR.left - 0.5),
      noOverlap: !monVis || btns.every((b) => monR.right <= b.left + 0.5),
      monClip: monVis ? mon.scrollWidth - mon.clientWidth : 0,
    };
    main.style.cssText = save;
    return out;
  }))`));
  check(
    'T49 状态栏监控不遮挡行尾按钮,高度恒定,监控条自身无裁切',
    sbProbe.every((r) => r.overflow <= 0 && r.allBtnsInside && r.noOverlap && r.monClip <= 0 && r.h === sbProbe[0].h),
    JSON.stringify(sbProbe),
  );

  // T49b 延迟槽在各宽度档不被裁:'999ms' 是 #mon-lat 定宽槽(42px)的极端载荷,
  // 曾在 14 寸收窄窗口下被槽位 overflow:hidden 裁掉 'ms' 尾巴 —— 容器级检查
  // (monClip)看不到槽内裁切,必须量元素自身的 scrollWidth。
  const latProbe = asObj(await evalJs(`return JSON.stringify(${JSON.stringify(sbWidths)}.map((w) => {
    const main = document.querySelector('#main');
    const save = main.style.cssText;
    main.style.flex = '0 0 ' + w + 'px'; main.style.width = w + 'px';
    void main.getBoundingClientRect();
    window.__nbTest.monitorProbe([
      { cpuPct: 9.2, memPct: 50, memUsedMB: 488, memTotalMB: 976, diskPct: 40, diskUsedGB: 400, diskTotalGB: 1000, rxBps: 890, txBps: 1536, latencyMs: 999 },
    ]);
    const lat = document.querySelector('#mon-lat');
    const item = lat.closest('.mon-item');
    const r = lat.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    const out = {
      w,
      latText: lat.textContent,
      latClipped: lat.scrollWidth - lat.clientWidth > 0 || r.right > ir.right + 0.5,
    };
    main.style.cssText = save;
    return out;
  }))`));
  check(
    'T49b 延迟数值(999ms)在各宽度档完整可见',
    latProbe.every((r) => !r.latClipped && r.latText === '999ms'),
    JSON.stringify(latProbe),
  );

  // T49c 连续宽度扫描:档位断点只验证离散点,拖动窗口是连续的 —— 档位之间的
  // 过渡带曾因 flex 比例收缩把压力平摊给组内容而出现裁切(1300→300 每 8px 扫过)。
  const sweep = asObj(await evalJs(`return JSON.stringify((() => {
    const main = document.querySelector('#main');
    const save = main.style.cssText;
    const bad = [];
    for (let w = 1300; w >= 300; w -= 8) {
      main.style.flex = '0 0 ' + w + 'px'; main.style.width = w + 'px';
      void main.getBoundingClientRect();
      window.__nbTest.monitorProbe([
        { cpuPct: 9.2, memPct: 50, memUsedMB: 488, memTotalMB: 976, diskPct: 40, diskUsedGB: 400, diskTotalGB: 1000, rxBps: 890, txBps: 1536, latencyMs: 999 },
      ]);
      const bar = document.querySelector('#monitor-bar');
      if (getComputedStyle(bar).display === 'none') continue;
      const g = Math.max(0, ...[...bar.querySelectorAll('.mon-group')].map((el) => el.scrollWidth - el.clientWidth));
      const lat = document.querySelector('#mon-lat');
      const b = bar.scrollWidth - bar.clientWidth;
      const l = lat.scrollWidth - lat.clientWidth;
      if (g > 0 || b > 0 || l > 0) bad.push({ w, group: g, bar: b, lat: l });
    }
    main.style.cssText = save;
    return bad;
  })())`));
  check(
    'T49c 连续宽度扫描(1300→300 每 8px)无任何裁切',
    Array.isArray(sweep) && sweep.length === 0,
    JSON.stringify(sweep),
  );

  // T49d 长主机名不溢出条目边框(盒级+省略号约束)。
  // 分屏不再产生"选择主机"的空窗格(新窗格直接复用当前主机),但主机列表
  // 与侧边栏同样承载任意长度的主机名 —— 同一套盒级+ellipsis 约束在这里断言。
  await evalJs(`
    document.querySelector('#btn-add-host').click();
    document.querySelector('#host-name').value = '长度测试-超长主机名称用于验证窗格选择器溢出行为AAAA';
    document.querySelector('#host-host').value = '127.0.0.1';
    document.querySelector('#host-port').value = '${sshd.port}';
    document.querySelector('#host-username').value = 'root';
    document.querySelector('#host-password').value = '${PASSWORD}';
    document.querySelector('#btn-host-save').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent.includes('长度测试')`, 'true', 10000);
  const ppCheck = asObj(await evalJs(`return JSON.stringify((() => {
    // 约束在 .host-name/.host-sub 上(host-item 是 flex 容器,省略号三件套
    // 落在其文本子元素);盒级断言同时看条目与文本行是否越出父容器。
    const rows = [...document.querySelectorAll('#host-list .host-item')]
      .filter((el) => el.textContent.includes('长度测试'));
    if (!rows.length) return { err: 'long-host item not found', items: 0 };
    const out = [];
    for (const el of rows) {
      const pr = el.parentElement.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const boxInside = er.right <= pr.right + 0.5 && er.left >= pr.left - 0.5;
      for (const sel of ['.host-name', '.host-sub']) {
        const t = el.querySelector(sel);
        if (!t) continue;
        const cs = getComputedStyle(t);
        const tr = t.getBoundingClientRect();
        out.push({
          sel,
          textW: Math.round(tr.width * 10) / 10,
          parentW: Math.round(pr.width * 10) / 10,
          boxInside,
          constrained: cs.overflowX === 'hidden' && cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis',
        });
      }
    }
    return out;
  })())`));
  check(
    'T49d 长主机名不溢出条目边框(盒级+省略号约束)',
    Array.isArray(ppCheck) && ppCheck.length > 0 && ppCheck.every((r) => r.boxInside && r.constrained),
    JSON.stringify(ppCheck),
  );

  /* ===== 本轮改动(1–7)的回归 ===== */

  // —— 7 指纹功能已并入功能菜单列表 ——
  await openMenuPage('settings');
  const moreItems = asObj(await evalJs(`return JSON.stringify([...document.querySelectorAll('#more-menu .mm-page:not(.hidden) .btn')].map((b) => b.textContent.trim()))`));
  check(
    'T50 指纹与关于已并入功能菜单,侧栏不再有指纹按钮',
    moreItems.some((t) => t.includes('主机指纹')) && moreItems.some((t) => t.includes('关于')) && footer.hasFingerprintBtn === false,
    JSON.stringify({ moreItems, footerHasFp: footer.hasFingerprintBtn }),
  );
  // T50c 主机导入/导出移入「配置」分组:侧栏底部不再有这两个按钮
  check(
    'T50c 主机导入/导出可从「设置与管理」页到达',
    moreItems.some((t) => t.includes('导入主机')) && moreItems.some((t) => t.includes('导出主机')) && footer.text === '',
    JSON.stringify({ moreItems, footerText: footer.text }),
  );
  // 从菜单点开指纹弹窗,确认链路仍通(此前是侧边栏底部的按钮)
  await menuFocus('#btn-fingerprints');
  await focusedKey('Enter');
  await sleep(800);
  const fpOpen = await evalJs(`return String(!document.querySelector('#modal-fp').classList.contains('hidden'))`);
  check('T50b 功能菜单可打开指纹管理', fpOpen === 'true', fpOpen);
  await evalJs(`document.querySelector('#btn-fp-close') && document.querySelector('#btn-fp-close').click(); return 1`);

  // 固定 300px 浮层允许覆盖文件面板,但必须贴合工具按钮并钳制在视口内。
  const panelWasOpen = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`)).open;
  if (!panelWasOpen) {
    await openMenuPage();
    await menuFocus('#btn-files');
    await focusedKey('Enter');
  }
  await waitEval(`window.__nbTest.filePanel().open`, 'true', 15000);
  await openMenuPage();
  const geom = asObj(await evalJs(`return JSON.stringify((() => {
    const out = window.__nbTest.moreMenuGeom();
    const anchor = document.querySelector('#btn-more').getBoundingClientRect();
    const r = document.querySelector('#more-menu').getBoundingClientRect();
    const width = window.innerWidth, height = window.innerHeight;
    const below = height - anchor.bottom - 8, above = anchor.top - 8;
    const rawTop = r.height <= below || below >= above ? anchor.bottom : anchor.top - r.height;
    return { ...out, width, height, actualWidth: r.width,
      expectedLeft: width < 360 ? 8 : Math.max(8, Math.min(anchor.right - r.width, width - r.width - 8)),
      expectedTop: width < 360 ? Math.max(8, (height - r.height) / 2) : Math.max(8, Math.min(rawTop, height - r.height - 8)),
      expanded: document.querySelector('#btn-more').getAttribute('aria-expanded') };
  })())`));
  check(
    'T51 文件面板打开时菜单固定宽度、贴合锚点且钳制在视口内',
    geom.panelOpen === true && geom.expanded === 'true'
      && Math.abs(geom.actualWidth - Math.min(300, geom.width - 16)) <= 1
      && geom.menu[0] >= 7 && geom.menu[1] >= 7 && geom.menu[2] <= geom.width - 7 && geom.menu[3] <= geom.height - 7
      && Math.abs(geom.menu[0] - geom.expectedLeft) <= 1 && Math.abs(geom.menu[1] - geom.expectedTop) <= 1,
    JSON.stringify(geom),
  );
  await focusedKey('Escape');
  // Hook opens/closes through the real button when initially hidden; no stale aria state.
  const geomHook = asObj(await evalJs(`return JSON.stringify({ geom: window.__nbTest.moreMenuGeom(), hidden: document.querySelector('#more-menu').classList.contains('hidden'), expanded: document.querySelector('#btn-more').getAttribute('aria-expanded') })`));
  check('T51b 隐藏态几何钩子测得菜单并完整复位', geomHook.hidden && geomHook.expanded === 'false'
    && geomHook.geom.menu[2] > geomHook.geom.menu[0], JSON.stringify(geomHook));
  await evalJs(`document.querySelector('#btn-file-close').click(); return 1`);

  // T63 侧边栏收缩:侧栏底部按钮 / 功能菜单 / 把手双击三处入口,同一 toggle。
  // 断言:面板与拖拽把手同步显隐、按钮 active 态正确、主区宽度实变(终端拿到空间)。
  {
    const sb0 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.sidebar())`));
    check('T63a 侧边栏初始展开', sb0.open === true && sb0.resizerOpen === true && sb0.btnActive === true, JSON.stringify(sb0));
    const w0 = sb0.mainW;
    await evalJs(`document.querySelector('#btn-sidebar-toggle').click(); return 1`);
    const sb1 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.sidebar())`));
    check(
      'T63b 侧栏底部按钮收起(面板+把手隐藏,主区变宽)',
      sb1.open === false && sb1.resizerOpen === false && sb1.btnActive === false && sb1.mainW > w0 + 200,
      JSON.stringify({ before: w0, after: sb1.mainW }),
    );
    await evalJs(`document.querySelector('#btn-sidebar-menu').click(); return 1`);
    const sb2 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.sidebar())`));
    check('T63c 功能菜单恢复展开', sb2.open === true && sb2.resizerOpen === true && sb2.btnActive === true, JSON.stringify(sb2));
    await evalJs(`document.querySelector('#sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1`);
    const sb3 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.sidebar())`));
    check('T63b2 把手双击收起', sb3.open === false && sb3.btnActive === false, JSON.stringify(sb3));
    await evalJs(`document.querySelector('#btn-sidebar-toggle').click(); return 1`);
    const sb4 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.sidebar())`));
    check('T63d 再点恢复,状态完整回位', sb4.open === true && sb4.resizerOpen === true && sb4.btnActive === true && sb4.mainW === w0, JSON.stringify(sb4));

    // 模拟实际 pointer 拖动链路;合成 pointer 没有系统捕获,仅替换捕获调用。
    const drag = asObj(await evalJs(`return JSON.stringify((() => {
      const sidebar = document.querySelector('#sidebar');
      const grip = document.querySelector('#sidebar-resizer');
      window.__e2eSidebarStyle = sidebar.style.cssText;
      const before = sidebar.getBoundingClientRect().width;
      const x = grip.getBoundingClientRect().left + 2;
      const capture = grip.setPointerCapture;
      try {
        grip.setPointerCapture = () => {};
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 91, button: 0, clientX: x }));
      } finally { grip.setPointerCapture = capture; }
      for (const type of ['pointermove', 'pointerup']) grip.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 91, button: 0, clientX: x + 72 }));
      return { before, after: sidebar.getBoundingClientRect().width, inlineWidth: sidebar.style.width,
        mainW: document.querySelector('#main').getBoundingClientRect().width,
        dragging: document.body.classList.contains('resizing') || grip.classList.contains('dragging') };
    })())`));
    check('T63e 拖动侧栏留下真实 inline width 并释放拖动态', !!drag.inlineWidth
      && drag.after > drag.before + 40 && !drag.dragging, JSON.stringify(drag));
    await evalJs(`document.querySelector('#btn-sidebar-toggle').click(); return 1`);
    const collapsed = asObj(await evalJs(`return JSON.stringify({ ...window.__nbTest.sidebar(), width: document.querySelector('#sidebar').getBoundingClientRect().width,
      inlineWidth: document.querySelector('#sidebar').style.width, expanded: document.querySelector('#btn-sidebar-toggle').getAttribute('aria-expanded') })`));
    check('T63f 拖宽后收起不被 inline width 撑开,主区收回空间', collapsed.open === false
      && !collapsed.resizerOpen && !collapsed.btnActive && collapsed.width <= 44 && collapsed.inlineWidth === ''
      && collapsed.expanded === 'false' && collapsed.mainW > drag.mainW + drag.after - collapsed.width - 8, JSON.stringify(collapsed));
    await openMenuPage();
    await menuFocus('#btn-sidebar-menu');
    await focusedKey('Enter');
    const expanded = asObj(await evalJs(`return JSON.stringify({ ...window.__nbTest.sidebar(), width: document.querySelector('#sidebar').getBoundingClientRect().width,
      expanded: document.querySelector('#btn-sidebar-toggle').getAttribute('aria-expanded') })`));
    check('T63g 菜单恢复拖宽尺寸且状态同步', expanded.open && expanded.resizerOpen && expanded.btnActive
      && expanded.expanded === 'true' && Math.abs(expanded.width - drag.after) <= 1
      && Math.abs(expanded.mainW - drag.mainW) <= 1, JSON.stringify(expanded));
    await evalJs(`document.querySelector('#sidebar').style.cssText = window.__e2eSidebarStyle; delete window.__e2eSidebarStyle; return 1`);
  }

  // T64 全页溢出审计:多宽度 × 多面板状态组合下,扫描可视元素找两类回归:
  // ①文档级横向溢出(documentElement.scrollWidth > clientWidth,页面出现整体滚动);
  // ②"静默裁切":元素文字被 nowrap + overflow:hidden 压缩,且**可见宽 < 内容宽超 20px**
  //   —— 用 getClientRects 不可靠(报告完整内容),改量父级盒链:元素自身盒超出了
  //   其"布局容器"(最近的非 inline 祖先)的 content 盒即为溢出。
  // 白名单:有意滚动的容器(host-list/file-list/tabs/md 预览等)与其内部的省略行。
  // 断言口径:有边框/背景的**卡片类**元素必须完整落在视口内 —— 文字省略是设计,
  // 盒子越界是 bug。
  {
    // 注意:auditJs 必须是**表达式**(不能以 return 开头)—— 它被外层模板串
    // 内嵌为 `const out = (${auditJs})()`;含 return 则整体语法错误,bridge
    // 注入的 eval 静默挂掉,表现为 eval 超时(语法错误不会回 ERR:)。
    const auditJs = `
      JSON.stringify((() => {
        const WIN = ['host-list', 'tabs', 'file-list', 'fp-tbody', 'ai-messages', 'snippet-list',
          'cloud-tbody', 'batch-tbody', 'more-menu', 'model-picker-list', 'history-list', 'statusbar', 'tabbar', 'layout-root'];
        const inWin = (el) => WIN.some((id) => document.getElementById(id) && document.getElementById(id).contains(el));
        const out = [];
        const vw = document.querySelector('#app').getBoundingClientRect().right;
        // 只扫可视布局区的浅层(状态栏/标签栏/侧栏/面板头/终端窗格),全 body
        // querySelectorAll('*') 会带出 xterm 上万节点导致 eval 超时。
        const roots = ['#statusbar', '#tabbar', '#sidebar', '.ai-header', '.ai-quick', '.ai-input-row',
          '.file-toolbar', '#file-mkdir-row', '#file-chmod-row', '#file-bookmarks', '#file-status',
          '#more-menu', '#welcome', '.pane-picker'];
        const seen = new Set();
        for (const sel of roots) {
          for (const root of document.querySelectorAll(sel)) {
            if (!root.getClientRects().length) continue;
            const all = root.querySelectorAll('*');
            for (let ci = 0; ci < all.length && ci < 200; ci++) { const child = all[ci];
              if (seen.has(child)) continue; seen.add(child);
              if (!child.getClientRects().length) continue;
              const cs = getComputedStyle(child);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              // ①卡片类:自身盒超出视口右缘/左缘
              const r = child.getBoundingClientRect();
              const hasBox = cs.borderStyle !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
              if (hasBox && !inWin(child) && (r.right > vw + 1 || r.left < -1)) {
                out.push({ kind: 'box-outside-viewport', sel: child.tagName.toLowerCase() + (child.id ? '#' + child.id : '') + '.' + String(child.className).split(' ')[0], right: Math.round(r.right), left: Math.round(r.left), vw });
              }
              // ②内容撑破自身盒(非白名单、非滚动容器):内容比盒子宽 20px 以上
              const scrollable = cs.overflowX === 'auto' || cs.overflowY === 'auto' || cs.overflowX === 'scroll';
              if (!scrollable && !inWin(child) && child.clientWidth > 0 && child.scrollWidth - child.clientWidth > 20) {
                out.push({ kind: 'content-clipped', sel: child.tagName.toLowerCase() + (child.id ? '#' + child.id : '') + '.' + String(child.className).split(' ')[0], clip: child.scrollWidth - child.clientWidth });
              }
              if (out.length > 30) return out;
            }
          }
        }
        return out;
      })())`;
    const states = [
      { name: '默认布局', setup: '' },
      { name: '侧栏收起', setup: `document.querySelector('#sidebar').classList.add('collapsed'); document.querySelector('#sidebar-resizer').classList.add('hidden');` },
      { name: '侧栏+AI面板', setup: `document.querySelector('#ai-panel').classList.remove('hidden'); document.querySelector('#ai-resizer').classList.remove('hidden');` },
      { name: '侧栏+文件面板', setup: `document.querySelector('#file-panel').classList.remove('hidden'); document.querySelector('#file-resizer').classList.remove('hidden');` },
      { name: '全开', setup: `document.querySelector('#sidebar').classList.remove('collapsed'); document.querySelector('#sidebar-resizer').classList.remove('hidden'); document.querySelector('#ai-panel').classList.remove('hidden'); document.querySelector('#ai-resizer').classList.remove('hidden'); document.querySelector('#file-panel').classList.remove('hidden'); document.querySelector('#file-resizer').classList.remove('hidden');` },
    ];
    const widths = [1512, 1280, 1100, 1040, 980];
    const findings = [];
    for (const st of states) {
      for (const w of widths) {
        const res = asObj(await evalJs(`return JSON.stringify((() => {
          const app = document.querySelector('#app');
          const save = app.style.cssText;
          const panels = [...document.querySelectorAll('#sidebar, #sidebar-resizer, #ai-panel, #ai-resizer, #file-panel, #file-resizer')];
          const classes = panels.map(el => el.className);
          document.querySelector('#sidebar').classList.remove('collapsed');
          document.querySelector('#sidebar-resizer').classList.remove('hidden');
          for (const el of panels.filter(el => el.id !== 'sidebar' && el.id !== 'sidebar-resizer')) el.classList.add('hidden');
          ${st.setup}
          // Constrain the entire workspace so both side panels consume the tested width.
          app.style.width = ${w} + 'px';
          void app.getBoundingClientRect();
          const out = ${auditJs};
          app.style.cssText = save;
          panels.forEach((el, i) => { el.className = classes[i]; });
          return out;
        })())`, 60000));
        if (Array.isArray(res) && res.length) findings.push({ state: st.name, w, issues: res.slice(0, 6) });
      }
    }
    // 复位面板状态
    await evalJs(`document.querySelector('#ai-panel').classList.add('hidden'); document.querySelector('#ai-resizer').classList.add('hidden'); document.querySelector('#file-panel').classList.add('hidden'); document.querySelector('#file-resizer').classList.add('hidden'); return 1`);
    check(
      'T64 全页溢出审计(5 状态 × 5 宽度)无盒子越界/静默裁切',
      findings.length === 0,
      JSON.stringify(findings).slice(0, 1200),
    );
  }

  const narrowPanels = asObj(await evalJs(`return (${auditNarrowPanels.toString()})().then(JSON.stringify)`));
  check('T64e 窄面板按钮不溢出/变形且底栏对齐(18 种宽度)', narrowPanels.issues.length === 0, JSON.stringify(narrowPanels));

  // T64b 对齐审计:批量执行弹框"同列元素必须等宽对齐"。
  // 设计规范:同一列里水平堆叠的输入框/列表框,左缘、右缘必须对齐;
  // 全宽结果表必须与上方配置区左右缘对齐。只断言几何,不依赖任何主题。
  // 表格宽度断言必须在执行完成、表格可见后进行(隐藏元素没有可断言的几何)。
  {
    await evalJs(`document.querySelector('#btn-batch').click(); return 1`);
    await sleep(300);
    const alignDraft = asObj(await evalJs(`return JSON.stringify((() => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
      const issues = [];
      const eq = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1 : tol);
      // ①批量弹框:过滤输入框与主机列表框必须等宽对齐(左右缘一致)
      const search = document.querySelector('#batch-search');
      const hosts = document.querySelector('#batch-hosts');
      if (search && hosts) {
        const s = R(search), h = R(hosts);
        if (!eq(s.l, h.l) || !eq(s.r, h.r)) issues.push({ where: 'batch-left-col', search: s, hosts: h });
      }
      // ②底部操作栏(状态 + 执行/取消/关闭)必须完整落在视口内:头尾固定不随内容滚动
      const foot = document.querySelector('#modal-batch .batch-foot');
      if (foot) {
        const f = R(foot);
        if (f.l < 0 || f.r > window.innerWidth) issues.push({ where: 'batch-footer-x', foot: f, vw: window.innerWidth });
      }
      return { issues };
    })())`, 30000));
    check('T64b 批量执行弹框同列元素等宽对齐(草稿态)', alignDraft.issues.length === 0, JSON.stringify(alignDraft));
    await evalJs(`return (async () => {
      const response = await window.nebula.invoke('hosts:list');
      const host = response.data.find(h => h.host === '127.0.0.1' && Number(h.port) === ${sshd.port});
      if (!host) throw new Error('本地批量执行测试主机缺失');
      const input = [...document.querySelectorAll('#batch-hosts input')].find(x => x.value === host.id);
      if (!input) throw new Error('批量目标列表缺少本地主机');
      input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
      // 执行按钮现在随"命令非空 + 已选目标"启停:填充后须派发 input,模拟真实键入
      const cmd = document.querySelector('#batch-cmd');
      cmd.value = 'echo ux-batch-export';
      cmd.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-batch-run').click(); return 1;
    })()`);
    await waitEval(`return document.querySelector('#batch-status').textContent`, '完成:1 成功', 15000);
    const alignResult = asObj(await evalJs(`return JSON.stringify((() => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
      const issues = [];
      const eq = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1 : tol);
      // ③结果可见后:结果表横跨整卡,与上方双列配置区左右缘对齐
      const table = document.querySelector('#batch-results');
      const grid = document.querySelector('#modal-batch .batch-grid');
      if (table && grid && !table.classList.contains('hidden')) {
        const t = R(table), g = R(grid);
        if (!eq(t.l, g.l) || !eq(t.r, g.r)) issues.push({ where: 'batch-results-full-width', table: t, grid: g });
      }
      return { issues };
    })())`, 30000));
    check('T64b2 批量结果表全宽且与配置区对齐(结果可见后)', alignResult.issues.length === 0, JSON.stringify(alignResult));
    await evalJs(`document.querySelector('#batch-tbody button').click(); return 1`);
    const detail = await evalJs(`return document.querySelector('#batch-detail-output').value`);
    check('T64c 批量结果详情保留完整本地执行输出', String(detail).includes('EXEC-OK:echo ux-batch-export'), String(detail));
    await evalJs(`document.querySelector('#btn-batch-export').click(); return 1`);
    await waitEval(`return document.querySelector('#toasts').textContent`, '已导出批量结果:', 10000);
    const batchExportFiles = fs.readdirSync(work).filter(name => /^NebulaShell-batch-.*\.json$/.test(name));
    const batchExport = batchExportFiles.length === 1 ? JSON.parse(fs.readFileSync(path.join(work, batchExportFiles[0]), 'utf8')) : [];
    check('T64d WebView 原生导出 IPC 将结果写入隔离目录', batchExport.length === 1
      && batchExport[0].ok === true && batchExport[0].output.includes('EXEC-OK:echo ux-batch-export')
      && batchExport[0].detail === detail, JSON.stringify({ files: batchExportFiles, count: batchExport.length }));
    await evalJs(`document.querySelector('#btn-batch-close').click(); return 1`);
    await sleep(200);
  }

  // —— 1 新增分屏后自动整理为均衡网格 ——
  // 从单窗格连开两次,断言变成"行列均衡、同列宽/同行高一致"的网格,
  // 而不是被反复一刀切出的失衡形状。
  // 固定为可容纳 2×2 的最小尺寸:3 个窗格应为 2+1,不能用旧的 100px 下限。
  await evalJs(`const lr = document.querySelector('#layout-root'); window.__e2eLayoutStyle = lr.style.cssText;
    lr.style.width = '645px'; lr.style.height = '365px'; lr.style.flex = 'none'; return 1`);
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, '2', 30000);
  await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 20000);
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, '3', 30000);
  await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 20000);
  const grid = asObj(await evalJs(`return JSON.stringify(window.__nbTest.paneGrid())`));
  check(
    'T56 新增分屏后自动整理为行列均衡的等分网格',
    grid.count === 3
      // 3 个窗格 → 2 行(2+1):行内窗格数最多相差 1,而不是"一刀切"出的 1+1+1 细条
      && grid.rows.length === 2 && Math.max(...grid.rows) - Math.min(...grid.rows) <= 1
      // 行内等宽(同一行并排的窗格必须一样宽)
      && grid.withinRowWidthSpread <= 2
      && grid.acrossRowHeightSpread <= 2
      && grid.minW >= 319 && grid.minH >= 179,
    JSON.stringify(grid),
  );
  const plannerAxes = asObj(await evalJs(`return JSON.stringify([[970, 180], [320, 550]].map(([width, height]) => {
    const lr = document.querySelector('#layout-root');
    lr.style.width = width + 'px'; lr.style.height = height + 'px';
    document.querySelector('#btn-auto-layout').click();
    const boxes = [...document.querySelectorAll('.term-pane')].map((p) => {
      const r = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    });
    return { width, height, boxes, overflowX: lr.scrollWidth - lr.clientWidth, overflowY: lr.scrollHeight - lr.clientHeight };
  }))`));
  check('T56b 宽矮/窄高区域按真实尺寸规划横排/竖排,每格至少 320×180',
    plannerAxes.length === 2 && plannerAxes.every((r) => r.boxes.length === 3 && balancedGrid(r.boxes)
      && r.boxes.every((b) => b[2] >= 319 && b[3] >= 179) && r.overflowX <= 1 && r.overflowY <= 1)
      && new Set(plannerAxes[0].boxes.map((b) => b[1])).size === 1
      && new Set(plannerAxes[1].boxes.map((b) => b[0])).size === 1,
    JSON.stringify(plannerAxes));
  await evalJs(`document.querySelector('#layout-root').style.cssText = window.__e2eLayoutStyle;
    delete window.__e2eLayoutStyle; document.querySelector('#btn-auto-layout').click(); return 1`);

  // —— 2 快捷键提示按平台渲染 ——
  const acc = asObj(await evalJs(`return JSON.stringify(window.__nbTest.accelTitles())`));
  const macLike = acc.platform === 'darwin';
  const wantMod = macLike ? '⌘' : 'Ctrl';
  check(
    'T57 快捷键提示按运行平台渲染(mac ⌘ / 其它 Ctrl)',
    // 标题里出现正确的修饰键,且不出现另一种平台的符号
    acc.hasDirectionMenus === false
      && acc.newtab.includes(wantMod) && acc.split.includes(wantMod) && acc.closePane.includes(wantMod)
      && (macLike ? !/Ctrl/.test(acc.split) : !/⌘/.test(acc.split))
      // macOS 用连接符省略写法(⌘T),其它平台用 Ctrl+T
      && (macLike ? acc.newtab.includes('⌘T') : acc.newtab.includes('Ctrl+T')),
    JSON.stringify(acc),
  );

  // 收尾:把 T56 开出来的窗格关回 1 个,避免影响后续(以及可重复性)
  for (let i = 0; i < 6; i++) {
    const n = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
    if (n <= 1) break;
    await evalJs(`document.querySelector('#btn-more').click(); return 1`);
    await sleep(120);
    await evalJs(`document.querySelector('#btn-close-pane').click(); return 1`);
    await sleep(400);
  }

  /* ===== 菜单重构(P0)的回归:标签/主机右键菜单、功能菜单分组与快捷键列 ===== */

  // —— 标签右键:关闭/关闭其他/关闭右侧/重命名 ——
  const tabCtx = asObj(await evalJs(`return JSON.stringify((() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab');
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    return [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => ({ label: b.querySelector('.ctx-label').textContent, disabled: b.disabled }));
  })())`));
  const tabHas = (l) => tabCtx.find((i) => i.label === l);
  check(
    'T58 标签右键菜单:关闭/关闭其他/关闭右侧/重命名/复制地址/新建',
    !!tabHas('关闭标签') && !!tabHas('关闭其他标签') && !!tabHas('关闭右侧标签') && !!tabHas('重命名…') && !!tabHas('复制主机地址') && !!tabHas('新建标签'),
    JSON.stringify(tabCtx),
  );
  // 重命名走应用内输入框(prompt 在 WKWebView 下不返回),留空可恢复默认
  await evalJs(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.querySelector('.ctx-label').textContent === '重命名…').click(); return 1`);
  await sleep(200);
  const renameOpen = asObj(await evalJs(`return JSON.stringify({ open: window.__nbTest.promptOpen(), title: window.__nbTest.promptTitle() })`));
  await evalJs(`window.__nbTest.promptFill('生产机'); window.__nbTest.promptClickOk(); return 1`);
  await sleep(200);
  const renamed = await evalJs(`return document.querySelector('.tab.active .tab-title').textContent`);
  check(
    'T58b 重命名标签生效',
    renameOpen.open === true && renamed === '生产机',
    JSON.stringify({ renameOpen, renamed }),
  );
  await evalJs(`
    const tab = document.querySelector('.tab.active');
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    return 1`);
  await sleep(150);
  await evalJs(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.querySelector('.ctx-label').textContent === '重命名…').click(); return 1`);
  await sleep(150);
  await evalJs(`window.__nbTest.promptFill(''); window.__nbTest.promptClickOk(); return 1`);
  await sleep(150);
  const restoredTitle = await evalJs(`return document.querySelector('.tab.active .tab-title').textContent`);
  check('T58c 清空重命名恢复默认(跟随主机名)', restoredTitle !== '生产机', `title=${restoredTitle}`);

  // —— 主机右键:连接/新标签连接/编辑/克隆/复制/删除,与悬停图标同源 ——
  const hostCtx = asObj(await evalJs(`return JSON.stringify((() => {
    const it = [...document.querySelectorAll('.host-item')][0];
    const r = it.getBoundingClientRect();
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
    return [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.querySelector('.ctx-label').textContent);
  })())`));
  check(
    'T59 主机右键菜单:连接/新标签连接/编辑/克隆/复制/删除',
    hostCtx.includes('连接') && hostCtx.includes('在新标签连接') && hostCtx.includes('编辑…') && hostCtx.includes('克隆') && hostCtx.includes('复制 user@host') && hostCtx.includes('删除…'),
    JSON.stringify(hostCtx),
  );
  // 收起右键菜单,避免影响后续
  await evalJs(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1`);

  // 分页菜单的真实可见路由(桥接键盘模拟,Enter 默认激活见 focusedKey)。
  await openMenuPage();
  const menuStruct = asObj(await evalJs(`return JSON.stringify((() => {
    const root = document.querySelector('#more-menu .mm-page:not(.hidden)');
    return { page: root.dataset.page, heads: [...root.querySelectorAll('.mm-head')].map((h) => h.textContent.trim()),
      routes: [...root.querySelectorAll('[data-menu-page]')].map((b) => b.dataset.menuPage),
      keys: [...root.querySelectorAll('[data-accel] .mm-key')].map((k) => k.textContent.trim()).filter(Boolean),
      isMac: window.nebula.platform === 'darwin' };
  })())`));
  check('T60 根页为布局/面板,会话与设置使用独立分页', menuStruct.page === 'root'
    && JSON.stringify(menuStruct.heads) === JSON.stringify(['布局', '面板'])
    && JSON.stringify(menuStruct.routes) === JSON.stringify(['session', 'settings']), JSON.stringify(menuStruct));
  check('T60b 可见菜单快捷键列按平台渲染', menuStruct.keys.length > 0
    && menuStruct.keys.every((k) => menuStruct.isMac ? k.includes('⌘') && !k.includes('Ctrl') : k.includes('Ctrl') && !k.includes('⌘')),
    JSON.stringify(menuStruct.keys));
  for (const page of ['session', 'settings']) {
    await menuFocus('[data-menu-page="' + page + '"]');
    await focusedKey('Enter');
    const subpage = asObj(await evalJs(`return JSON.stringify((() => {
      const menu = document.querySelector('#more-menu');
      const visible = [...menu.querySelectorAll('.mm-page')].filter((p) => p.getClientRects().length);
      const focus = document.activeElement;
      const r = menu.getBoundingClientRect();
      return { pages: visible.map((p) => p.dataset.page), backFocused: focus.hasAttribute('data-menu-back'),
        focusVisible: !!focus.getClientRects().length, buttons: [...visible[0].querySelectorAll('button')].map((b) => ({ id: b.id, h: b.getBoundingClientRect().height })),
        inside: r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7 };
    })())`));
    check('T60c ' + page + ' 页仅自身可见,返回项获焦且菜单不越界', JSON.stringify(subpage.pages) === JSON.stringify([page])
      && subpage.backFocused && subpage.focusVisible && subpage.inside && subpage.buttons.every((b) => b.h >= 34), JSON.stringify(subpage));
    // Enter 返回应恢复到原根页入口,不是随便落到第一个菜单项。
    await focusedKey('Enter');
    const backFocus = await evalJs(`return document.activeElement.dataset.menuPage`);
    check('T60d ' + page + ' 返回恢复入口焦点', backFocus === page, String(backFocus));
    await focusedKey('Enter');
    await focusedKey('ArrowLeft');
    check('T60e ' + page + ' 左方向键同样返回并恢复焦点', await evalJs(`return document.activeElement.dataset.menuPage`) === page);
  }
  await menuFocus('[data-menu-page="settings"]');
  await focusedKey('Enter');
  await focusedKey('Escape');
  const escaped = asObj(await evalJs(`return JSON.stringify({ hidden: document.querySelector('#more-menu').classList.contains('hidden'),
    focus: document.activeElement.id, expanded: document.querySelector('#btn-more').getAttribute('aria-expanded') })`));
  check('T60f 子页 Escape 关闭菜单并将焦点归还工具按钮', escaped.hidden && escaped.focus === 'btn-more' && escaped.expanded === 'false', JSON.stringify(escaped));
  await openMenuPage();
  check('T60g 再次打开重置为根页且焦点在可见启用项', await evalJs(`return document.activeElement.matches('button:not(:disabled)')
    && !!document.activeElement.closest('.mm-page[data-page="root"]:not(.hidden)') && !!document.activeElement.getClientRects().length`) === true);
  await focusedKey('Escape');

  // 模态作用域、队列与当前焦点语义:使用真实 ask* promise,不手改 modal class。
  await openMenuPage('settings');
  await menuFocus('#btn-about');
  await focusedKey('Enter');
  await waitEval(`window.__nbTest.about().open`, 'true', 10000);
  await evalJs(`window.__e2eDialogResults = [];
    for (const title of ['queue-p1', 'queue-p2', 'queue-p3']) {
      window.__nbTest.askPrompt(title, { title, password: false }).then((value) => window.__e2eDialogResults.push({ title, value }));
    } return 1`);
  await waitEval(`window.__nbTest.promptTitle()`, 'queue-p1', 10000);
  const scope = asObj(await evalJs(`return JSON.stringify((() => {
    const prompt = document.querySelector('#modal-prompt');
    const parent = document.querySelector('#modal-about');
    const before = window.__nbTest.tabState().tabs;
    document.querySelector('#btn-more').click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true,
      metaKey: window.nebula.platform === 'darwin', ctrlKey: window.nebula.platform !== 'darwin' }));
    document.querySelector('#btn-newtab').focus();
    const controls = [...prompt.querySelectorAll('input, button')].filter((b) => !b.disabled && b.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    first.focus();
    const reverse = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); first.dispatchEvent(reverse);
    const reverseWrap = document.activeElement === last && reverse.defaultPrevented;
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); last.dispatchEvent(forward);
    return { appInert: document.querySelector('#app').inert, parentInert: parent.inert, parentOpen: !parent.classList.contains('hidden'),
      topInert: prompt.inert, focusInside: prompt.contains(document.activeElement), role: prompt.getAttribute('role'), ariaModal: prompt.getAttribute('aria-modal'),
      reverseWrap, forwardWrap: document.activeElement === first && forward.defaultPrevented,
      tabsStable: window.__nbTest.tabState().tabs === before, menuClosed: document.querySelector('#more-menu').classList.contains('hidden') };
  })())`));
  check('T65 顶层模态隔离背景/下层弹窗,阻止应用快捷键并循环 Tab 焦点', scope.appInert && scope.parentInert && scope.parentOpen
    && !scope.topInert && scope.focusInside && scope.role === 'dialog' && scope.ariaModal === 'true'
    && scope.reverseWrap && scope.forwardWrap && scope.tabsStable && scope.menuClosed, JSON.stringify(scope));
  await evalJs(`window.__nbTest.promptFill('must-not-leak'); document.querySelector('#modal-prompt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); return 1`);
  await waitEval(`window.__nbTest.promptTitle()`, 'queue-p2', 10000);
  const queuedPrompt = asObj(await evalJs(`return JSON.stringify({ results: window.__e2eDialogResults,
    value: document.querySelector('#prompt-input').value, focus: document.activeElement.id, open: window.__nbTest.promptOpen() })`));
  check('T65b backdrop 取消首个 prompt,下一项 FIFO 打开且输入/焦点不串台', queuedPrompt.open
    && queuedPrompt.results.length === 1 && queuedPrompt.results[0].title === 'queue-p1' && queuedPrompt.results[0].value === null
    && queuedPrompt.value === '' && queuedPrompt.focus === 'prompt-input', JSON.stringify(queuedPrompt));
  await evalJs(`window.__nbTest.promptFill('accepted-p2'); return 1`);
  await focusedKey('Enter');
  await waitEval(`window.__nbTest.promptTitle()`, 'queue-p3', 10000);
  await focusedKey('Escape');
  await waitEval(`return window.__e2eDialogResults.length`, '3', 10000);
  const promptDone = asObj(await evalJs(`return JSON.stringify({ results: window.__e2eDialogResults, open: window.__nbTest.promptOpen(),
    parentOpen: window.__nbTest.about().open, parentInert: document.querySelector('#modal-about').inert,
    focus: document.activeElement.id, appInert: document.querySelector('#app').inert })`));
  check('T65c queued prompt Enter 接受/Escape 取消各结算一次并回到父弹窗', JSON.stringify(promptDone.results) === JSON.stringify([
    { title: 'queue-p1', value: null }, { title: 'queue-p2', value: 'accepted-p2' }, { title: 'queue-p3', value: null },
  ]) && !promptDone.open && promptDone.parentOpen && !promptDone.parentInert && promptDone.appInert
    && promptDone.focus === 'btn-about-close', JSON.stringify(promptDone));
  await evalJs(`document.querySelector('#modal-about').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); return 1`);
  const restoredScope = asObj(await evalJs(`return JSON.stringify({ open: window.__nbTest.about().open, inert: document.querySelector('#app').inert,
    focus: document.activeElement.id, modalOpen: document.body.classList.contains('modal-open') })`));
  check('T65d 父弹窗 backdrop 关闭后解除 inert 并恢复工具按钮焦点', !restoredScope.open && !restoredScope.inert
    && !restoredScope.modalOpen && restoredScope.focus === 'btn-more', JSON.stringify(restoredScope));

  await evalJs(`window.__e2eDialogResults = [];
    for (const [title, danger] of [['queue-c1', true], ['queue-c2', false], ['queue-c3', true], ['queue-c4', true]]) {
      window.__nbTest.askConfirm(title, { title, danger }).then((value) => window.__e2eDialogResults.push({ title, value }));
    } return 1`);
  await waitEval(`window.__nbTest.confirmTitle()`, 'queue-c1', 10000);
  check('T66 危险 confirm 默认取消获焦', await evalJs(`return window.__nbTest.confirmFocus()`) === 'cancel');
  await evalJs(`document.querySelector('#btn-confirm-ok').focus(); return 1`);
  await focusedKey('Enter');
  await waitEval(`window.__nbTest.confirmTitle()`, 'queue-c2', 10000);
  check('T66b 非危险 confirm 默认确定获焦', await evalJs(`return window.__nbTest.confirmFocus()`) === 'ok');
  await evalJs(`document.querySelector('#btn-confirm-cancel').focus(); return 1`);
  await focusedKey('Enter');
  await waitEval(`window.__nbTest.confirmTitle()`, 'queue-c3', 10000);
  await evalJs(`document.querySelector('#modal-confirm').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); return 1`);
  await waitEval(`window.__nbTest.confirmTitle()`, 'queue-c4', 10000);
  await focusedKey('Escape');
  await waitEval(`return window.__e2eDialogResults.length`, '4', 10000);
  const confirmDone = asObj(await evalJs(`return JSON.stringify({ results: window.__e2eDialogResults, open: window.__nbTest.confirmOpen(),
    appInert: document.querySelector('#app').inert, focus: document.activeElement.id })`));
  check('T66c queued confirm Enter 服从当前焦点而非默认值,backdrop/Escape 取消且无遗留 waiter',
    JSON.stringify(confirmDone.results) === JSON.stringify([
      { title: 'queue-c1', value: true }, { title: 'queue-c2', value: false }, { title: 'queue-c3', value: false }, { title: 'queue-c4', value: false },
    ]) && !confirmDone.open && !confirmDone.appInert && confirmDone.focus === 'btn-more', JSON.stringify(confirmDone));
  await evalJs(`delete window.__e2eDialogResults; return 1`);

  // macOS 的 Ctrl+D/W 属于 shell 控制键,不能触发应用分屏或关闭。
  if (macLike) {
    const ctrlShell = asObj(await evalJs(`return JSON.stringify((() => {
      const before = window.__nbTest.tabState();
      const beforeIds = [...document.querySelectorAll('.term-pane')].map((p) => p.dataset.pane);
      const prevented = ['d', 'w'].map((key) => {
        const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
        document.querySelector('.term-pane.focused').dispatchEvent(event); return event.defaultPrevented;
      });
      const after = window.__nbTest.tabState();
      return { before, after, beforeIds, afterIds: [...document.querySelectorAll('.term-pane')].map((p) => p.dataset.pane), prevented };
    })())`));
    check('T67 mac Ctrl+D/W 不触发应用、不吞掉 shell 键', JSON.stringify(ctrlShell.before) === JSON.stringify(ctrlShell.after)
      && JSON.stringify(ctrlShell.beforeIds) === JSON.stringify(ctrlShell.afterIds) && ctrlShell.prevented.every((v) => !v), JSON.stringify(ctrlShell));
  }

  // 命令统一后每个入口只能新建一个标签/窗格,不能重复绑定产生两个。
  const tabBaseline = asObj(await evalJs(`return JSON.stringify(window.__nbTest.tabState())`));
  for (const route of ['toolbar', 'shortcut', 'context']) {
    if (route === 'toolbar') await evalJs(`document.querySelector('#btn-newtab').click(); return 1`);
    else if (route === 'shortcut') {
      await evalJs(`document.querySelector('#btn-more').focus(); return 1`);
      await focusedKey('t', { metaKey: macLike, ctrlKey: !macLike });
    } else {
      await evalJs(`const tab = document.querySelector('.tab.active'); const r = tab.getBoundingClientRect();
        tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 8 })); return 1`);
      await focusedKey('End');
      await focusedKey('Enter');
    }
    await sleep(150); // 允许重复的 async listener 也执行,不能只检验第一帧。
    const created = asObj(await evalJs(`return JSON.stringify(window.__nbTest.tabState())`));
    check('T68 ' + route + ' 新建命令仅执行一次', created.tabs === tabBaseline.tabs + 1
      && created.panes === 1 && created.sessions.length === tabBaseline.sessions.length
      && JSON.stringify(created.sessions.map(({ id, host, tabId }) => ({ id, host, tabId })))
        === JSON.stringify(tabBaseline.sessions.map(({ id, host, tabId }) => ({ id, host, tabId })))
      && created.activeTab !== tabBaseline.activeTab, JSON.stringify(created));
    await evalJs(`document.querySelector('#btn-more').focus(); return 1`);
    await focusedKey('w', { metaKey: macLike, ctrlKey: !macLike });
    await evalJs(`document.querySelector('[data-tab="' + ${JSON.stringify(tabBaseline.activeTab)} + '"]').click(); return 1`);
    const closed = asObj(await evalJs(`return JSON.stringify(window.__nbTest.tabState())`));
    check('T68b ' + route + ' 关闭新标签后会话/窗格完整回位', JSON.stringify(closed) === JSON.stringify(tabBaseline), JSON.stringify(closed));
  }

  /* ===== 终端复制三连修(T61):Ctrl+C 按选区分流 / 失败可见 ===== */

  // 有选区:Ctrl+C 必须是复制,不能把 \x03 发给 shell(否则正在跑的命令被误杀);
  // prevented = 自定义处理器介入的证据(旧实现从不 preventDefault)
  const withSel = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termCopyProbe({ select: true }))`));
  check(
    'T61 有选区时 Ctrl+C 复制而不中断(不给 shell 发 \\x03)',
    withSel.ok === true && withSel.prevented === true && withSel.hadSelection === true && String(withSel.selection).includes('PROBE-COPY-MARK-9137') && withSel.sigintSent === false && withSel.emitted === '',
    JSON.stringify(withSel),
  );

  // Shift 变形键:Ctrl+Shift+C 的 ev.key 是 'C',旧判定只认小写 'c' —— 此前是死键
  const shiftC = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termCopyProbe({ select: true, key: 'C', shift: true }))`));
  check(
    'T61b Ctrl+Shift+C(键面 C)同样复制而不发 \\x03',
    shiftC.ok === true && shiftC.prevented === true && shiftC.hadSelection === true && shiftC.sigintSent === false && shiftC.emitted === '',
    JSON.stringify(shiftC),
  );

  // 无选区:Ctrl+C 维持标准终端行为 —— 放行 \x03(SIGINT)发给 shell,
  // 同时 preventDefault 拦掉浏览器默认复制(别处 UI 的 DOM 选区)
  const noSel = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termCopyProbe({ select: false }))`));
  check(
    'T61c 无选区时 Ctrl+C 仍发送 SIGINT,且拦截浏览器默认复制',
    noSel.ok === true && noSel.prevented === true && noSel.hadSelection === false && noSel.sigintSent === true,
    JSON.stringify(noSel),
  );

  // Ctrl+V 粘贴必须只插一次:浏览器默认粘贴事件被拦截(prevented/pasteEvents=0),
  // 手动链路至多插一次(pasteCalls≤1)—— 修复前两条链路各插一次,内容翻倍
  const paste = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termPasteProbe())`));
  check(
    'T62 Ctrl+V 只粘贴一次(不触发原生 paste 事件,不重复插入)',
    paste.ok === true && paste.prevented === true && paste.pasteEvents === 0 && paste.pasteCalls <= 1,
    JSON.stringify(paste),
  );

  await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
  await waitEval(`return document.querySelector('#toasts').textContent`, '已开启只读模式', 10000);
  const readonlyWrite = asObj(await evalJs(`return JSON.stringify(await window.nebula.invoke('ssh:write', {
    sessionId: window.__nbTest.filePanel().activeId, data: 'echo ux-readonly-probe\\r'
  }))`));
  check('T69 后端拒绝只读会话直接 IPC 写入', readonlyWrite.ok === false
    && String(readonlyWrite.error).includes('只读'), JSON.stringify(readonlyWrite));
  await evalJs(`document.querySelector('#btn-readonly').click(); return 1`);
  await waitEval(`return document.querySelector('#toasts').textContent`, '已关闭只读模式', 10000);

  // 无未捕获异常
  const errs = await evalJs(`return JSON.stringify(window.__errs)`);
  check('T12 渲染层无未捕获异常', errs === '[]', String(errs).slice(0, 150));

  clearTimeout(watchdog);
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  clearTimeout(watchdog);
  console.error(`\n${FAIL} UI e2e 失败: ${e.message}`);
  if (appLogs.length) console.error('--- 应用日志 ---\n' + appLogs.join('').slice(-1200));
  await cleanup();
  process.exit(1);
});
