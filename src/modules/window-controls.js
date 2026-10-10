// 窗口控制。Windows/Linux:decorations:false 后系统标题栏消失,最小化/最大化/
// 关闭由顶层标题栏 #titlebar 行尾的按钮接管。macOS 用原生红绿灯
// (tauri.macos.conf.json 的 titleBarStyle Overlay + trafficLightPosition),
// 构建期 body 只保留 platform-darwin class(见 build.mjs),CSS 据此隐藏按钮。
// 两个平台都要同步全屏状态:body.is-fullscreen 收起红绿灯占位与窗口按钮。
// 经全局 __TAURI__.window 调用,权限见 capabilities/default.json
// (allow-minimize / allow-toggle-maximize / allow-is-maximized / allow-close /
// allow-start-dragging / allow-is-fullscreen / allow-set-fullscreen)。
// 浏览器或 stub 环境无 __TAURI__ 时整体跳过。本模块不 import 任何模块
// (tests/window-controls.test.mjs 以零依赖加载)。
const MAX_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor"/></svg>';
const RESTORE_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor"/><path d="M3 2.5 V1.2 Q3 0.5 3.7 0.5 H8.8 Q9.5 0.5 9.5 1.2 V6.3 Q9.5 7 8.8 7 H7.5" fill="none" stroke="currentColor"/></svg>';
const MIN_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 5.5 H9.5" stroke="currentColor"/></svg>';
const CLOSE_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.7 0.7 L9.3 9.3 M9.3 0.7 L0.7 9.3" stroke="currentColor"/></svg>';

const currentWindow = () => window.__TAURI__?.window?.getCurrentWindow?.() || null;

export function bindWindowControls() {
  const minBtn = document.getElementById('btn-win-min');
  const maxBtn = document.getElementById('btn-win-max');
  const closeBtn = document.getElementById('btn-win-close');
  const win = currentWindow();
  // 无 Tauri 环境(纯浏览器调试):按钮隐藏,不留死按钮
  if (!win) {
    document.getElementById('win-controls')?.classList.add('hidden');
    return;
  }
  const mac = document.body.classList.contains('platform-darwin');
  const pcButtons = !mac && minBtn && maxBtn && closeBtn;
  if (pcButtons) {
    minBtn.innerHTML = MIN_SVG;
    maxBtn.innerHTML = MAX_SVG;
    closeBtn.innerHTML = CLOSE_SVG;
    minBtn.addEventListener('click', () => { win.minimize().catch(() => {}); });
    maxBtn.addEventListener('click', () => { win.toggleMaximize().catch(() => {}); });
    closeBtn.addEventListener('click', () => { win.close().catch(() => {}); });
  }
  // onResized 在还原/最大化/进出全屏/手动缩放时都会发:同步全屏与最大化图标(还原=双框)
  const sync = async () => {
    try {
      if (typeof win.isFullscreen === 'function') document.body.classList.toggle('is-fullscreen', await win.isFullscreen());
      if (pcButtons) {
        const maximized = await win.isMaximized();
        maxBtn.innerHTML = maximized ? RESTORE_SVG : MAX_SVG;
        maxBtn.title = maximized ? '还原' : '最大化';
      }
    } catch { /* 权限或时序问题不应影响主流程 */ }
  };
  if (typeof win.onResized === 'function') {
    win.onResized(sync);
    sync();
  }
}

/// 全屏开关(Windows/Linux 的 F11 与「视图 › 全屏」;macOS 用系统的「进入全屏」)。
/// 返回是否已切换。
export async function toggleFullscreen() {
  const win = currentWindow();
  if (!win || typeof win.setFullscreen !== 'function') return false;
  const next = !(await win.isFullscreen());
  await win.setFullscreen(next);
  document.body.classList.toggle('is-fullscreen', next);
  return true;
}
