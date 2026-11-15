// RDP 桌面窗格:远程桌面是标签内的窗格之一(与终端 / 文件分屏同级、同布局规则)。
//
// 模型:
// - 每个 RDP 窗格持有一条后端会话(rdp:connect 返回的 sessionId),画面帧走
//   Tauri Channel 的二进制包(格式见 src-tauri/src/rdp.rs 的 encode_frame_packet),
//   键鼠输入走 rdp:input,尺寸变化走 rdp:resize。
// - 状态机对齐设计稿的四态:connecting / cert-confirm / connected / disconnected
//   (错误也走 disconnected 卡片,只换文案与图标)。
// - 画布是 1:1 的远端桌面缓冲区(offscreen fb),可见 canvas 按 devicePixelRatio
//   放大重采样 —— putImageData 不支持变换,只能先画到 fb 再 drawImage 缩放。
// - 只读模式(pane.readOnly)在输入出口处拦截,不向后端发任何键鼠事件。

import { $, api, parseFpError, showCtxMenu, state, stripFpMark, toast } from './core.js';
import { icon } from '../shared/icons.js';

export const FRAME_MAGIC = 0x5246424e;
export const FRAME_HEADER_LEN = 24;
export const FRAME_KIND_DIRTY = 0;
export const FRAME_KIND_FULL = 1;
/// 帧包版本：1 = 像素原样，2 = zlib(deflate) 压缩（见 rdp.rs FRAME_VERSION_*）
export const FRAME_VERSION_RAW = 1;
export const FRAME_VERSION_DEFLATE = 2;
// 3/4 = RGB24(每像素 3 字节,alpha 隐含为 255):后端把恒为 0xFF 的那 1/4 流量去掉了
export const FRAME_VERSION_RGB24 = 3;
export const FRAME_VERSION_RGB24_DEFLATE = 4;

/// 远端桌面像素上限（约 1600x1000）。超过它只会让每帧 IPC 变大，不会更清晰。
export const REMOTE_PIXEL_BUDGET = 1_600_000;

/// 解码一帧:magic(4) version(2) kind(2) x(2) y(2) w(2) h(2) dw(2) dh(2) reserved(4) + RGBA。
/// 全部小端;像素不足一帧视为坏包返回 null(不抛错,丢帧比崩界面好)。
export function decodeFramePacket(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < FRAME_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== FRAME_MAGIC) return null;
  const version = view.getUint16(4, true);
  if (![FRAME_VERSION_RAW, FRAME_VERSION_DEFLATE, FRAME_VERSION_RGB24, FRAME_VERSION_RGB24_DEFLATE].includes(version)) return null;
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const body = bytes.subarray(FRAME_HEADER_LEN);
  const rgb = version === FRAME_VERSION_RGB24 || version === FRAME_VERSION_RGB24_DEFLATE;
  const compressed = version === FRAME_VERSION_DEFLATE || version === FRAME_VERSION_RGB24_DEFLATE;
  const rawBytes = width * height * (rgb ? 3 : 4);
  if (!compressed && body.length < rawBytes) return null;
  return {
    version,
    rgb,
    compressed,
    kind: view.getUint16(6, true),
    x: view.getUint16(8, true),
    y: view.getUint16(10, true),
    width,
    height,
    desktopWidth: view.getUint16(16, true),
    desktopHeight: view.getUint16(18, true),
    pixels: compressed ? body : body.subarray(0, rawBytes),
  };
}

/// 这个 WebView 能不能解 deflate（WKWebView / Chromium 都有，老引擎没有）。
export function canInflateFrames() {
  return typeof DecompressionStream === 'function' && typeof Blob === 'function';
}

/// RGB24 → RGBA：alpha 补 255。
///
/// 传输时省掉的那 1/4 字节在这里补回来,代价是一次 1.33 倍的拷贝,
/// 比每帧多过 1/4 的 IPC 流量便宜得多。
export function expandRgb24(pixels, width, height) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i += 1) {
    const src = i * 3;
    const dst = i * 4;
    out[dst] = pixels[src];
    out[dst + 1] = pixels[src + 1];
    out[dst + 2] = pixels[src + 2];
    out[dst + 3] = 255;
  }
  return out;
}

/// 解开压缩帧体，返回 RGBA 像素。
export async function inflateFrameBody(body) {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/* ---------------- 键鼠映射 ---------------- */

// XT Set 1 扫描码;扩展键(方向键 / 右 Ctrl / 小键盘除号等)带 0xE000 前缀,
// 与 ironrdp_input::Scancode::from_u16 的约定一致。
const SCANCODES = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a,
  Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f,
  KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38,
  Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035,
  PrintScreen: 0xe037, AltRight: 0xe038,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051,
  Insert: 0xe052, Delete: 0xe053,
  MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d,
};

/// KeyboardEvent.code → XT 扫描码;未知按键返回 null(调用方再试 unicode 通道)。
export function scancodeFor(code) {
  const value = SCANCODES[code];
  return typeof value === 'number' ? value : null;
}

/// DOM 的 button 编号 → RDP 按钮编号(3 = 后退键、4 = 前进键,对应 X1 / X2)。
export function rdpMouseButton(button) {
  if (button === 3) return 8;
  if (button === 4) return 9;
  return button;
}

/// 滚轮像素增量 → RDP 的 120 单位步进。DOM 一次滚动常见 ±100px,
/// 累积到阈值才发一档,避免每个 wheel 事件都触发远端滚动。
export function wheelSteps(acc) {
  if (acc <= -100) return 120;
  if (acc >= 100) return -120;
  return 0;
}

/* ---------------- 窗格状态 ---------------- */

export function createRdpPaneState(host) {
  return {
    kind: 'rdp',
    host: host ? { ...host } : null,
    sessionId: null,
    phase: 'idle', // idle | connecting | cert | connected | down
    reason: '',
    readOnly: false,
    desktop: { width: 0, height: 0 },
    el: null,
    surface: null,
    canvas: null,
    fb: null,
    lastPos: { x: 0, y: 0 },
    wheelAcc: 0,
    connecting: false,
    wantSize: { width: 0, height: 0 },
    frameChannel: null,
  };
}

export function rdpPaneTitle(pane) {
  const host = pane?.host || {};
  return host.name || host.host || '远程桌面';
}

export function rdpPaneAddress(pane) {
  const host = pane?.host || {};
  return `${host.host || ''}:${host.port || 3389}`;
}

function ownerTab(pane) {
  for (const tab of state.tabs.values()) {
    if (tab.panes.get(pane?.id) === pane) return tab;
  }
  return null;
}

export function rdpPanesIn(tab) {
  return tab ? [...tab.panes.values()].filter((p) => p.kind === 'rdp') : [];
}

export function findRdpPane(paneId) {
  if (!paneId) return null;
  for (const tab of state.tabs.values()) {
    const pane = tab.panes.get(paneId);
    if (pane && pane.kind === 'rdp') return pane;
  }
  return null;
}

export function focusedRdpPane() {
  const el = document.querySelector?.('.term-pane.rdp-pane.focused');
  return el ? findRdpPane(el.dataset.pane) : null;
}

export function activeRdpPane() {
  const focused = focusedRdpPane();
  if (focused) return focused;
  const active = state.tabs.get(state.activeTabId);
  const pane = active?.activePaneId ? active.panes.get(active.activePaneId) : null;
  return pane?.kind === 'rdp' ? pane : null;
}

/* ---------------- DOM ---------------- */

export function buildRdpPane(pane) {
  const el = pane.el;
  if (!el) return;
  el.classList.add('rdp-pane');
  // 空窗格上挂着的选主面板必须一起清掉:SSH 路径用 pane.innerHTML = '' 达到同样效果,
  // 桌面窗格若只 append 就会被 .pane-picker(z-index 6)整个盖住,既看不到画面也点不动。
  el.querySelector('.pane-picker')?.remove();
  pane.pickerRendered = false;
  // 标题行常驻:分屏后靠它认出这格是哪台机器,同时给 ✕⤢ 一个不压画面的落脚点
  // (悬浮在右上角会盖住远端窗口自己的关闭按钮)。
  const bar = document.createElement('div');
  bar.className = 'rdp-bar';
  const title = document.createElement('span');
  title.className = 'rdp-bar-title';
  const stateChip = document.createElement('span');
  stateChip.className = 'rdp-bar-state';
  bar.appendChild(title);
  bar.appendChild(stateChip);
  el.appendChild(bar);
  pane.bar = bar;
  const surface = document.createElement('div');
  surface.className = 'rdp-surface';
  surface.tabIndex = 0;
  surface.setAttribute('role', 'application');
  surface.setAttribute('aria-label', '远程桌面');
  const canvas = document.createElement('canvas');
  canvas.className = 'rdp-canvas';
  const overlay = document.createElement('div');
  overlay.className = 'rdp-overlay';
  surface.appendChild(canvas);
  surface.appendChild(overlay);
  el.appendChild(surface);
  pane.surface = surface;
  pane.canvas = canvas;
  pane.ctx = canvas.getContext('2d');
  bindRdpInput(pane);
  bindRdpResize(pane);
  renderRdpOverlay(pane);
}

function overlayHost(pane) {
  return pane?.el?.querySelector?.('.rdp-overlay') || null;
}

const RDP_PHASE_TEXT = {
  idle: '未连接',
  connecting: '连接中',
  cert: '待确认证书',
  connected: '已连接',
  down: '已断开',
};

/// 标题行:主机名 + 地址 + 状态。状态文案与浮层同源,只在状态切换时重画。
function refreshRdpBar(pane) {
  const bar = pane?.el?.querySelector?.('.rdp-bar');
  if (!bar) return;
  const host = pane.host || {};
  const title = bar.querySelector('.rdp-bar-title');
  const state = bar.querySelector('.rdp-bar-state');
  if (title) {
    title.textContent = rdpPaneTitle(pane);
    title.title = `${rdpPaneTitle(pane)} · ${host.username ? `${host.username}@` : ''}${rdpPaneAddress(pane)}`;
  }
  let addr = bar.querySelector('.rdp-bar-addr');
  if (!addr) {
    addr = document.createElement('span');
    addr.className = 'rdp-bar-addr mono';
    bar.insertBefore(addr, state || null);
  }
  addr.textContent = `${host.username ? `${host.username}@` : ''}${rdpPaneAddress(pane)}`;
  // 实时码率 + 帧率:证明「最低网络占用」不是口号,用户能直接看到数
  let stat = bar.querySelector('.rdp-bar-stat');
  if (!stat) {
    stat = document.createElement('span');
    stat.className = 'rdp-bar-stat mono';
    bar.insertBefore(stat, state || null);
  }
  stat.textContent = pane.netStat || '';
  stat.classList.toggle('hidden', pane.phase !== 'connected' || !pane.netStat);
  if (state) {
    state.textContent = RDP_PHASE_TEXT[pane.phase] || RDP_PHASE_TEXT.idle;
    state.dataset.phase = pane.phase;
  }
}

/// 每秒采样一次入站字节与帧数,写进标题行(pane.netStat)。
function sampleNetStat(pane) {
  const now = performance.now();
  const dt = (now - (pane.netAt || now)) / 1000;
  const bytes = (pane.bytesIn || 0) - (pane.bytesBase || 0);
  const frames = (pane.frames || 0) - (pane.framesBase || 0);
  pane.netAt = now;
  pane.bytesBase = pane.bytesIn || 0;
  pane.framesBase = pane.frames || 0;
  if (dt <= 0) return;
  const bps = bytes / dt;
  const rate = bps >= 1024 * 1024 ? `${(bps / 1024 / 1024).toFixed(1)} MB/s`
    : bps >= 1024 ? `${Math.round(bps / 1024)} KB/s`
      : `${Math.round(bps)} B/s`;
  pane.netStat = `↓ ${rate} · ${Math.round(frames / dt)} fps`;
  refreshRdpBar(pane);
}

function startNetStat(pane) {
  stopNetStat(pane);
  pane.netAt = performance.now();
  pane.bytesBase = pane.bytesIn || 0;
  pane.framesBase = pane.frames || 0;
  pane.statTimer = setInterval(() => sampleNetStat(pane), 1000);
  if (pane.statTimer?.unref) pane.statTimer.unref();
}

function stopNetStat(pane) {
  if (pane.statTimer) clearInterval(pane.statTimer);
  pane.statTimer = 0;
  pane.netStat = '';
}

/// 状态栏:RDP 没有 SSH 会话对象,默认那条路径只会写「就绪 — 尚未建立连接」,
/// 于是窗格标题行说「已连接」、底部状态栏说「尚未建立连接」,同一屏自相矛盾。
/// 这里按窗格自己的四态写状态栏,并只点亮远程桌面真正支持的两个动作(断开 / 重连)。
export function updateRdpStatusbar(pane) {
  const dot = $('#status-dot');
  const text = $('#status-text');
  if (!dot || !text || !pane) return;
  const host = pane.host || {};
  const label = `${host.username ? `${host.username}@` : ''}${host.host || ''}:${host.port || 3389}`;
  const connected = pane.phase === 'connected';
  const busy = pane.phase === 'connecting' || pane.phase === 'cert';
  dot.className = `dot ${connected ? 'connected' : busy ? 'connecting' : pane.phase === 'down' ? 'disconnected' : 'idle'}`;
  text.textContent = connected ? `已连接 ${label} · RDP`
    : busy ? `正在连接 ${label} · RDP`
      : pane.phase === 'down' ? `已断开 ${label} · ${pane.reason || '远程桌面会话已结束'}`
        : `就绪 — ${label} · RDP`;
  text.title = pane.phase === 'down' ? (pane.reason || '') : '';
  const setBtn = (id, enabled, why) => {
    const btn = $(id);
    if (!btn) return;
    btn.disabled = !enabled;
    if (why) btn.title = why;
  };
  setBtn('#btn-disconnect', connected || busy, connected ? '断开连接' : '取消连接');
  setBtn('#btn-reconnect', pane.phase === 'down' || pane.phase === 'idle', '重新连接远程桌面');
  setBtn('#btn-readonly', connected, connected ? (pane.readOnly ? '关闭只读模式' : '只读模式,防止误触') : '连接后才可切换只读');
  setBtn('#btn-clear', false, '远程桌面不支持清屏');
  setBtn('#btn-log-toggle', false, '远程桌面不支持会话日志');
  $('#ro-badge')?.classList.toggle('hidden', !pane.readOnly);
  $('#status-hint')?.classList.add('hidden');
}

/// 当前聚焦的桌面窗格才代表状态栏(分屏时其余窗格不抢这条线)。
function syncRdpStatusbar(pane) {
  if (pane?.el?.classList?.contains('focused')) updateRdpStatusbar(pane);
}

/// 四态浮层:连接中 / 证书确认 / 已连接(无浮层) / 断开或失败。
/// 卡片内容变化走整块重建 —— 状态切换是低频动作,不做增量更新。
export function renderRdpOverlay(pane) {
  const host = pane && overlayHost(pane);
  if (!host) return;
  host.dataset.state = pane.phase;
  // 连上后本地光标交给远端画面里的指针,别叠成双鼠标
  if (pane.surface) {
    pane.surface.dataset.pointer = pane.phase === 'connected' ? 'remote' : 'local';
  }
  refreshRdpBar(pane);
  syncRdpStatusbar(pane);
  host.innerHTML = '';
  if (pane.phase === 'connected') return;
  const card = document.createElement('div');
  card.className = `rdp-card rdp-card-${pane.phase}`;
  if (pane.phase === 'connecting') {
    card.innerHTML =
      '<div class="rdp-radar" aria-hidden="true"><span></span><span></span><span></span></div>' +
      `<div class="rdp-card-title">正在连接 ${escapeHtml(rdpPaneTitle(pane))}</div>` +
      `<div class="rdp-card-sub mono">${escapeHtml(rdpPaneAddress(pane))}</div>` +
      `<div class="rdp-chain mono">${escapeHtml(chainText(pane))}</div>`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn rdp-card-btn';
    cancel.textContent = '取消连接';
    cancel.addEventListener('click', () => { disconnectRdpPane(pane); pane.phase = 'idle'; renderRdpOverlay(pane); });
    card.appendChild(cancel);
  } else if (pane.phase === 'cert') {
    const meta = pane.cert || {};
    const fpText = meta.sha256Hex || meta.fingerprint || '';
    card.innerHTML =
      `<div class="rdp-card-title">${icon('alert')}<span>确认远程桌面 TLS 证书指纹</span></div>` +
      '<div class="rdp-fp-row">' +
      `<div class="rdp-fp mono" title="${escapeHtml(fpText)}">${fingerprintRows(fpText)}</div>` +
      '<button type="button" class="btn icon rdp-fp-copy" title="复制完整指纹" aria-label="复制完整指纹"></button>' +
      '</div>' +
      '<dl class="rdp-cert-meta">' +
      `<div><dt>主体</dt><dd class="mono">${escapeHtml(meta.subject || '—')}</dd></div>` +
      `<div><dt>签发者</dt><dd class="mono">${escapeHtml(meta.issuer || '—')}</dd></div>` +
      `<div><dt>有效期</dt><dd class="mono">${escapeHtml(formatCertRange(meta))}</dd></div>` +
      '</dl>' +
      `<div class="rdp-card-note">首次连接需要确认指纹;记录后同一主机的变更会被拒绝。</div>`;
    card.querySelector('.rdp-fp-copy').innerHTML = icon('copy');
    card.querySelector('.rdp-fp-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(fpText);
        toast('指纹已复制');
      } catch {
        toast('复制失败,请手动选择指纹文本', 'error');
      }
    });
    const actions = document.createElement('div');
    actions.className = 'rdp-card-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', async () => { await replyCert(pane.cert?.requestId, false); pane.cert = null; pane.phase = 'idle'; renderRdpOverlay(pane); });
    const trust = document.createElement('button');
    trust.type = 'button';
    trust.className = 'btn primary';
    trust.textContent = '信任并连接';
    trust.addEventListener('click', async () => {
      trust.disabled = true;
      await replyCert(pane.cert?.requestId, true);
      pane.cert = null;
      // 回执发出后后端的 rdp:connect 可能已经落地(微任务早于本行执行),
      // 此时再写 connecting 会把刚到的 connected 盖回去,窗格永远停在"正在连接"。
      if (pane.phase !== 'connected') {
        pane.phase = 'connecting';
        renderRdpOverlay(pane);
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(trust);
    card.appendChild(actions);
  } else {
    const down = pane.phase === 'down';
    card.innerHTML =
      `<div class="rdp-card-title">${icon('power')}<span>${down ? '远程桌面已断开' : '尚未连接'}</span></div>` +
      (pane.reason ? `<div class="rdp-card-err">${escapeHtml(pane.reason)}</div>` : '');
    const actions = document.createElement('div');
    actions.className = 'rdp-card-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn';
    close.textContent = '关闭窗格';
    close.addEventListener('click', () => pane.onClose?.());
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn primary';
    retry.textContent = '立即重连';
    retry.addEventListener('click', () => connectRdpPane(pane));
    actions.appendChild(close);
    actions.appendChild(retry);
    card.appendChild(actions);
  }
  host.appendChild(card);
}

function chainText(pane) {
  const jump = Array.isArray(pane.host?.jumpIds) ? pane.host.jumpIds.length : 0;
  const target = `${rdpPaneAddress(pane)} (TLS + NLA)`;
  return jump ? `本机 → 跳板机 ×${jump} → ${target}` : `本机 → ${target}`;
}

function formatCertRange(meta) {
  if (!meta.validTo) return '—';
  return `${meta.validFrom || '—'} → ${meta.validTo}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/// 指纹按 16 字节一行折成固定两行(共 32 字节)。
/// 不靠"卡片够宽就不折行":等宽字体在缺字的环境里会回退到比例字体,字符宽度能涨到 1.5 倍,
/// 那时长串必然被省略号切掉,用户就没法逐字节核对证书了。固定分行在任何字体下都完整。
export function fingerprintRows(fpText) {
  const raw = String(fpText || '');
  const bytes = raw.replace(/^SHA256:/i, '').split(':').filter(Boolean);
  if (bytes.length !== 32) return escapeHtml(raw);
  const line = (list) => escapeHtml(list.join(':'));
  return `<div class="rdp-fp-line">${line(bytes.slice(0, 16))}</div>`
    + `<div class="rdp-fp-line">${line(bytes.slice(16))}</div>`;
}

/* ---------------- 输入 ---------------- */

function rdpInput(pane, input) {
  if (!pane.sessionId || pane.readOnly) return;
  api('rdp:input', { sessionId: pane.sessionId, input }).catch(() => {});
}

/// 把视口坐标换算成远端桌面坐标(clamp 到桌面范围)。
function desktopPoint(pane, event) {
  const rect = pane.canvas?.getBoundingClientRect?.();
  const dw = pane.desktop.width, dh = pane.desktop.height;
  if (!rect || !dw || !dh) return { x: 0, y: 0 };
  // 先换到画布内部坐标,再按等比适应(P4 留边)反算回远端像素,否则点得越靠右偏得越多
  const canvasX = (event.clientX - rect.left) * (pane.canvas.width / Math.max(1, rect.width));
  const canvasY = (event.clientY - rect.top) * (pane.canvas.height / Math.max(1, rect.height));
  const { scale, ox, oy } = fitRect(pane);
  const x = Math.min(dw - 1, Math.max(0, Math.floor((canvasX - ox) / scale)));
  const y = Math.min(dh - 1, Math.max(0, Math.floor((canvasY - oy) / scale)));
  return { x, y };
}

function bindRdpInput(pane) {
  const surface = pane.surface;
  if (!surface) return;
  let frame = 0;
  const flushMove = () => {
    frame = 0;
    rdpInput(pane, { kind: 'mouse_move', x: pane.lastPos.x, y: pane.lastPos.y });
  };
  surface.addEventListener('mousedown', (event) => {
    event.preventDefault();
    surface.focus();
    const point = desktopPoint(pane, event);
    pane.lastPos = point;
    if (surface.setPointerCapture) {
      try { surface.setPointerCapture(event.pointerId ?? 0); } catch { /* 合成事件没有 pointerId */ }
    }
    rdpInput(pane, { kind: 'mouse_button', button: rdpMouseButton(event.button), pressed: true, x: point.x, y: point.y });
  });
  surface.addEventListener('mouseup', (event) => {
    const point = desktopPoint(pane, event);
    pane.lastPos = point;
    rdpInput(pane, { kind: 'mouse_button', button: rdpMouseButton(event.button), pressed: false, x: point.x, y: point.y });
  });
  surface.addEventListener('mousemove', (event) => {
    pane.lastPos = desktopPoint(pane, event);
    if (!frame) frame = requestAnimationFrame(flushMove);
  });
  surface.addEventListener('contextmenu', (event) => event.preventDefault());
  surface.addEventListener('wheel', (event) => {
    event.preventDefault();
    pane.wheelAcc += event.deltaY;
    const steps = wheelSteps(pane.wheelAcc);
    if (!steps) return;
    pane.wheelAcc = 0;
    rdpInput(pane, { kind: 'wheel', vertical: true, delta: steps });
  }, { passive: false });

  surface.addEventListener('keydown', (event) => {
    if (event.metaKey && event.key === 'Tab') return; // ⌘Tab 留给系统
    const code = event.code;
    const scancode = scancodeFor(code);
    if (scancode !== null) {
      event.preventDefault();
      rdpInput(pane, { kind: 'scancode', code: scancode, pressed: true });
      return;
    }
    if (!hasCommandModifier(event) && event.key && event.key.length === 1) {
      event.preventDefault();
      rdpInput(pane, { kind: 'unicode', ch: event.key, pressed: true });
    }
  });
  surface.addEventListener('keyup', (event) => {
    const scancode = scancodeFor(event.code);
    if (scancode !== null) {
      event.preventDefault();
      rdpInput(pane, { kind: 'scancode', code: scancode, pressed: false });
      return;
    }
    if (!hasCommandModifier(event) && event.key && event.key.length === 1) {
      event.preventDefault();
      rdpInput(pane, { kind: 'unicode', ch: event.key, pressed: false });
    }
  });
  surface.addEventListener('blur', () => {
    // 失焦释放所有按键:否则远端 Ctrl/Alt 会卡住(macOS 切窗口尤其明显)
    if (pane.sessionId && !pane.readOnly) api('rdp:input', { sessionId: pane.sessionId, input: { kind: 'release_all' } }).catch(() => {});
  });
}

function hasCommandModifier(event) {
  return !!(event.ctrlKey || event.altKey || event.metaKey);
}

/* ---------------- 帧绘制 ---------------- */

function ensureFramebuffer(pane, width, height) {
  if (pane.fb && pane.fb.width === width && pane.fb.height === height) return;
  const fb = document.createElement('canvas');
  fb.width = width;
  fb.height = height;
  pane.fb = fb;
  pane.fbCtx = fb.getContext('2d');
  pane.desktop = { width, height };
  sizeVisibleCanvas(pane);
}

function sizeVisibleCanvas(pane) {
  const canvas = pane.canvas;
  const rect = pane.surface?.getBoundingClientRect?.();
  if (!canvas || !rect) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.style.width = `${Math.round(rect.width)}px`;
  canvas.style.height = `${Math.round(rect.height)}px`;
  pane.ctx.imageSmoothingEnabled = true;
  pane.ctx.imageSmoothingQuality = 'high';
  blitFull(pane);
}

/// 画面按「等比适应」画进可见画布:远端分辨率与窗格比例不一致时(分屏、后端还没
/// 跟上 resize)在两侧留背景色,绝不横向/纵向拉伸 —— 拉伸会让窗口与文字比例失真,
/// 用户看到的桌面就是错的比例。返回 {scale, ox, oy} 供脏矩形复用同一套变换。
export function fitRect(pane) {
  const dw = Math.max(1, pane.desktop?.width || 0);
  const dh = Math.max(1, pane.desktop?.height || 0);
  const cw = Math.max(1, pane.canvas?.width || 1);
  const ch = Math.max(1, pane.canvas?.height || 1);
  const scale = Math.min(cw / dw, ch / dh);
  return { scale, ox: (cw - dw * scale) / 2, oy: (ch - dh * scale) / 2 };
}

function blitFull(pane) {
  if (!pane.fb || !pane.ctx) return;
  const { scale, ox, oy } = fitRect(pane);
  pane.ctx.clearRect(0, 0, pane.canvas.width, pane.canvas.height);
  pane.ctx.drawImage(pane.fb, ox, oy, pane.fb.width * scale, pane.fb.height * scale);
}

/// 把一批帧包合成到离屏缓冲，再整体重采样到可见画布。
///
/// 服务端一次操作会推很多小脏矩形（动画、光标、窗口重绘），每包单独 `putImageData`
/// 再 `drawImage` 会把主线程打满，鼠标事件排到后面，表现就是卡顿与操作延迟。
/// 这里按帧合并：所有脏块先贴进缓冲，最后只按包围盒重绘一次。
export function compositePackets(pane, packets) {
  if (!pane || !packets || packets.length === 0) return;
  const last = packets[packets.length - 1];
  const needFramebuffer = !pane.fb
    || pane.fb.width !== last.desktopWidth
    || pane.fb.height !== last.desktopHeight;
  if (needFramebuffer) ensureFramebuffer(pane, last.desktopWidth, last.desktopHeight);
  if (!pane.fbCtx) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let whole = false;
  for (const packet of packets) {
    const expect = packet.width * packet.height * (packet.rgb ? 3 : 4);
    if (!expect || packet.pixels.length < expect) continue;
    // 尺寸已经变过（resize 生效）的旧帧直接丢，别画到新缓冲上
    if (packet.desktopWidth !== pane.fb.width || packet.desktopHeight !== pane.fb.height) continue;
    const rgba = packet.rgb
      ? expandRgb24(packet.pixels, packet.width, packet.height)
      : new Uint8ClampedArray(packet.pixels.slice(0, expect));
    const image = new ImageData(rgba, packet.width, packet.height);
    pane.fbCtx.putImageData(image, packet.x, packet.y);
    if (packet.kind === FRAME_KIND_FULL) whole = true;
    minX = Math.min(minX, packet.x);
    minY = Math.min(minY, packet.y);
    maxX = Math.max(maxX, packet.x + packet.width);
    maxY = Math.max(maxY, packet.y + packet.height);
  }
  if (!Number.isFinite(minX)) return;
  if (whole || needFramebuffer) {
    blitFull(pane);
    return;
  }
  const { scale, ox, oy } = fitRect(pane);
  // 缩小时高质量重采样在 CPU 上很贵（每帧整块画面），降到 low 肉眼几乎看不出差别
  pane.ctx.imageSmoothingQuality = scale < 1 ? 'low' : 'high';
  pane.ctx.drawImage(
    pane.fb,
    minX, minY, maxX - minX, maxY - minY,
    ox + minX * scale, oy + minY * scale,
    (maxX - minX) * scale, (maxY - minY) * scale,
  );
}

/// 单包入口（测试与首次绘制用）。
export function applyFramePacket(pane, packet) {
  if (!packet) return;
  compositePackets(pane, [packet]);
}

/// 按动画帧合帧：一帧内到达的包只重绘一次。
export function queueFramePacket(pane, packet) {
  if (!pane || !packet) return;
  if (!pane.frameQueue) pane.frameQueue = [];
  pane.frameQueue.push(packet);
  if (pane.frameRaf) return;
  const schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);
  pane.frameRaf = schedule(() => {
    pane.frameRaf = 0;
    const queue = pane.frameQueue || [];
    pane.frameQueue = [];
    compositePackets(pane, queue);
  });
}

/* ---------------- 尺寸 ---------------- */

function bindRdpResize(pane) {
  if (typeof ResizeObserver !== 'function') return;
  let timer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sizeVisibleCanvas(pane);
      scheduleRemoteResize(pane);
    }, 180);
  });
  observer.observe(pane.surface);
  pane.resizeObserver = observer;
}

/// 设备像素比(单测环境没有 window,退回 globalThis)
function deviceScale() {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : globalThis.devicePixelRatio;
  return Math.min(2, dpr || 1);
}

/// 可见尺寸变化后把远端桌面分辨率推过去。整两个偶数像素(后端还会再规整)。
export function remoteSizeFor(pane) {
  // 主机钉死了分辨率就照它连,窗格怎么拖都不改远端
  const fixed = pane.host?.rdpDisplay?.resolution;
  if (fixed && fixed !== 'auto') {
    const [fw, fh] = String(fixed).split('x').map(Number);
    if (fw >= 320 && fh >= 240) {
      return { width: fw, height: fh, scaleFactor: Math.round(deviceScale()), fixed: true };
    }
  }
  const rect = pane.surface?.getBoundingClientRect?.();
  if (!rect) return null;
  const dpr = deviceScale();
  // 像素预算：远端每帧都是未压缩 RGBA 过 IPC，2 倍屏下 (width*dpr)² 会让整帧
  // 数据量翻四倍。超过预算就按比例缩，画布再放大显示，视觉上几乎无感但要快得多。
  // 主机级像素上限(mstsc 没有这一项,但我们每帧都是未压缩 RGBA 过 IPC,必须能调)
  const budget = Number(pane.host?.rdpDisplay?.pixelBudget) || REMOTE_PIXEL_BUDGET;
  let w = rect.width * dpr;
  let h = rect.height * dpr;
  const area = w * h;
  if (area > budget) {
    const k = Math.sqrt(budget / area);
    w *= k;
    h *= k;
  }
  const width = Math.max(320, Math.floor(w / 2) * 2);
  const height = Math.max(240, Math.floor(h / 2) * 2);
  return { width, height, scaleFactor: Math.round(dpr) };
}

function scheduleRemoteResize(pane) {
  if (!pane.sessionId || pane.phase !== 'connected') return;
  const size = remoteSizeFor(pane);
  if (!size) return;
  if (pane.wantSize.width === size.width && pane.wantSize.height === size.height) return;
  pane.wantSize = { width: size.width, height: size.height };
  api('rdp:resize', { sessionId: pane.sessionId, width: size.width, height: size.height, scaleFactor: size.scaleFactor }).catch(() => {});
}

/* ---------------- 连接 / 断开 ---------------- */

function makeFrameChannel(pane) {
  const api2 = window.__TAURI__?.core;
  if (!api2 || typeof api2.Channel !== 'function') return null;
  const channel = new api2.Channel((message) => {
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    const packet = decodeFramePacket(bytes);
    if (!packet) {
      pane.badFrames = (pane.badFrames || 0) + 1;
      if (pane.badFrames === 1) console.warn('[rdp] 帧包无法解析', bytes?.length);
      return;
    }
    pane.bytesIn = (pane.bytesIn || 0) + bytes.length;
    if (!packet.compressed) {
      pane.frames = (pane.frames || 0) + 1;
      try {
        queueFramePacket(pane, packet);
      } catch (error) {
        console.error('[rdp] 画布绘制失败', error);
      }
      return;
    }
    // 压缩帧要异步解压：串成一条链保证顺序，乱序贴图会让画面撕裂
    pane.frameChain = (pane.frameChain || Promise.resolve())
      .then(async () => {
        const pixels = await inflateFrameBody(packet.pixels);
        pane.frames = (pane.frames || 0) + 1;
        queueFramePacket(pane, { ...packet, compressed: false, pixels });
      })
      .catch((error) => console.warn('[rdp] 帧解压失败', error));
  });
  return channel;
}

async function replyCert(requestId, accept) {
  if (!requestId) return;
  try { await api('rdp:cert_reply', { requestId, accept }); } catch { /* 会话可能已结束 */ }
}

export async function connectRdpPane(pane) {
  if (!pane || pane.connecting) return;
  if (!pane.host?.id) return toast('找不到 RDP 主机', 'error');
  const size = remoteSizeFor(pane) || { width: 1280, height: 800, scaleFactor: 1 };
  pane.connecting = true;
  pane.sessionId = null;
  pane.cert = null;
  pane.phase = 'connecting';
  pane.reason = '';
  pane.frames = 0;
  pane.badFrames = 0;
  pane.bytesIn = 0;
  pane.frameQueue = [];
  pane.frameRaf = 0;
  pane.frameChain = Promise.resolve();
  pane.wantSize = { width: size.width, height: size.height };
  renderRdpOverlay(pane);
  const channel = makeFrameChannel(pane);
  pane.frameChannel = channel;
  try {
    const data = await api('rdp:connect', {
      hostId: pane.host.id,
      width: size.width,
      height: size.height,
      frameChannel: channel || undefined,
      // 声明能解 deflate：后端会把整帧压缩后再过 IPC，数据量降一个数量级
      compression: canInflateFrames() ? 'deflate' : undefined,
      promptCert: true,
    });
    if (!data?.sessionId) throw new Error('后端未返回会话');
    pane.sessionId = data.sessionId;
    pane.phase = 'connected';
    startNetStat(pane);
    renderRdpOverlay(pane);
    scheduleRemoteResize(pane);
    pane.surface?.focus?.({ preventScroll: true });
  } catch (error) {
    handleConnectError(pane, error);
  } finally {
    pane.connecting = false;
  }
}

function handleConnectError(pane, error) {
  const text = String(error?.message || error || '连接失败');
  const fp = parseFpError(text);
  if (fp) {
    pane.phase = 'down';
    pane.reason = `证书指纹与本地记录不一致(本地 ${fp.stored},服务器 ${fp.current})。确认服务器已重装后可删除旧记录再连。`;
    renderRdpOverlay(pane);
    addRetrustAction(pane, fp);
    return;
  }
  pane.phase = 'down';
  pane.reason = stripFpMark(text) || '连接失败';
  renderRdpOverlay(pane);
}

/// 指纹变更的恢复入口:卡片底部追加一颗按钮,确认后删记录重连。
function addRetrustAction(pane, fp) {
  const host = overlayHost(pane)?.querySelector?.('.rdp-card');
  if (!host) return;
  let actions = host.querySelector('.rdp-card-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'rdp-card-actions';
    host.appendChild(actions);
  }
  const retrust = document.createElement('button');
  retrust.type = 'button';
  retrust.className = 'btn danger';
  retrust.textContent = '删除旧指纹并重连';
  retrust.addEventListener('click', async () => {
    retrust.disabled = true;
    try {
      await api('fingerprints:delete', { id: fp.key });
      await connectRdpPane(pane);
    } catch (e) {
      toast('删除指纹失败:' + e.message, 'error');
      retrust.disabled = false;
    }
  });
  actions.appendChild(retrust);
}

export async function disconnectRdpPane(pane) {
  if (!pane) return;
  const sessionId = pane.sessionId;
  pane.sessionId = null;
  pane.phase = 'idle';
  pane.connecting = false;
  if (!sessionId) return;
  try { await api('rdp:disconnect', { sessionId }); } catch { /* 已断开 */ }
}

/// 关闭窗格 / 关标签时回收:断开后端会话、停掉观察者、解绑事件。
export function disposeRdpPane(pane) {
  if (!pane) return;
  stopNetStat(pane);
  try { pane.resizeObserver?.disconnect?.(); } catch { /* ignore */ }
  pane.resizeObserver = null;
  const sessionId = pane.sessionId;
  pane.sessionId = null;
  pane.phase = 'idle';
  if (sessionId) api('rdp:disconnect', { sessionId }).catch(() => {});
}

export function reconnectRdpPane(pane) {
  disposeRdpPane(pane);
  return connectRdpPane(pane);
}

/* ---------------- 后端事件 ---------------- */

/// 把服务端下发的光标形状画成本地 CSS 光标。
///
/// 关掉软件合成后，远端光标不再画进画面，改由这里一次性转成 PNG dataURL
/// （形状极小，且只在真的换形状时才来一条），之后移动鼠标是浏览器在画，零延迟。
function applyRdpCursor(pane, payload) {
  const surface = pane?.surface;
  if (!surface) return;
  const mode = payload?.mode || 'remote';
  surface.dataset.pointer = mode;
  if (mode === 'local') {
    surface.style.removeProperty('--rdp-cursor');
    return;
  }
  if (mode === 'hidden') {
    surface.style.setProperty('--rdp-cursor', 'none');
    return;
  }
  const cursor = payload?.cursor;
  if (!cursor?.data) {
    // 还没拿到形状：先别显示，避免又出现一只系统箭头
    surface.style.setProperty('--rdp-cursor', 'none');
    return;
  }
  try {
    const raw = Uint8Array.from(atob(cursor.data), (c) => c.charCodeAt(0));
    const width = cursor.width;
    const height = cursor.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raw.buffer), width, height), 0, 0);
    const url = canvas.toDataURL('image/png');
    surface.style.setProperty(
      '--rdp-cursor',
      `url("${url}") ${cursor.hotspotX} ${cursor.hotspotY}, none`,
    );
  } catch {
    surface.style.setProperty('--rdp-cursor', 'none');
  }
}

let eventsBound = false;

/// rdp:state / rdp:cert_confirm 是全局通道,按 sessionId 路由到对应窗格。
export function bindRdpEvents() {
  if (eventsBound || typeof window === 'undefined' || !window.nebula?.on) return;
  eventsBound = true;
  const route = (sessionId) => {
    for (const tab of state.tabs.values()) {
      for (const pane of tab.panes.values()) {
        if (pane.kind === 'rdp' && pane.sessionId === sessionId) return pane;
      }
    }
    // 证书阶段后端还没把 sessionId 交给前端(connect 的 Promise 尚未落地),
    // 此时按"正在等待的桌面窗格"兜底,否则 TOFU 卡片永远弹不出来。
    let pending = null;
    for (const tab of state.tabs.values()) {
      for (const pane of tab.panes.values()) {
        if (pane.kind === 'rdp' && !pane.sessionId && pane.connecting) {
          if (pending) return null; // 多个在连的窗格无法判定归属,不猜
          pending = pane;
        }
      }
    }
    return pending;
  };
  window.nebula.on('rdp:state', (payload) => {
    const pane = route(payload?.sessionId);
    if (!pane) return;
    const next = payload.state;
    if (next === 'connected' || next === 'resized') {
      pane.phase = 'connected';
      if (payload.width && payload.height) {
        // 后端确认的新桌面尺寸:整帧会自动跟上,这里只对齐内部记录
        pane.desktop = { width: payload.width, height: payload.height };
      }
      renderRdpOverlay(pane);
    } else if (next === 'cert-confirm') {
      pane.phase = 'cert';
      renderRdpOverlay(pane);
    } else if (next === 'disconnected') {
      pane.sessionId = null;
      pane.phase = 'down';
      pane.reason = payload.reason || payload.message || '远端已断开';
      renderRdpOverlay(pane);
    } else if (next === 'pointer') {
      applyRdpCursor(pane, payload);
    } else if (next === 'error') {
      handleConnectError(pane, new Error(payload.message || payload.rawError || '远程桌面连接失败'));
    }
  });
  window.nebula.on('rdp:cert_confirm', (payload) => {
    const pane = route(payload?.sessionId);
    if (!pane) return;
    pane.cert = payload;
    pane.phase = 'cert';
    renderRdpOverlay(pane);
  });
}

/* ---------------- 组合键 ---------------- */

export const RDP_COMBOS = [
  { combo: 'ctrl_alt_del', label: 'Ctrl + Alt + Del', hint: '安全选项' },
  { combo: 'win_r', label: 'Win + R', hint: '运行对话框' },
  { combo: 'alt_tab', label: 'Alt + Tab', hint: '切换窗口' },
  { combo: 'win_l', label: 'Win + L', hint: '锁定桌面' },
];

export function sendRdpCombo(pane, combo) {
  const target = pane?.kind === 'rdp' ? pane : activeRdpPane();
  if (!target) return toast('当前没有可操作的远程桌面', 'error');
  if (!target.sessionId) return toast('远程桌面尚未连接', 'error');
  if (target.readOnly) return toast('只读模式下不能发送按键', 'error');
  api('rdp:input', { sessionId: target.sessionId, input: { kind: 'combo', combo } }).catch((e) => toast('发送按键失败:' + e.message, 'error'));
  target.surface?.focus?.({ preventScroll: true });
}

/// 右键菜单(单层 ≤10 行):组合键是二级,一级仍留给会话/布局动作。
export function openRdpKeyMenu(x, y, pane) {
  const target = pane || activeRdpPane();
  if (!target) return;
  showCtxMenu(x, y, RDP_COMBOS.map((item) => ({
    label: item.label,
    hint: item.hint,
    disabled: !target.sessionId,
    run: () => sendRdpCombo(target, item.combo),
  })));
}

export function setRdpReadOnly(pane, value) {
  if (!pane || pane.kind !== 'rdp') return;
  pane.readOnly = !!value;
  if (pane.readOnly && pane.sessionId) api('rdp:input', { sessionId: pane.sessionId, input: { kind: 'release_all' } }).catch(() => {});
}
