// 自定义窗口控制(Windows/Linux:decorations:false 后系统标题栏消失,
// 最小化/最大化/关闭由前端接管)。macOS 用原生红绿灯(tauri.macos.conf.json
// 的 titleBarStyle Overlay),构建期 body 只保留 platform-darwin class
// (见 build.mjs),CSS 据此隐藏按钮;这里只需跳过绑定。
// 经全局 __TAURI__.window 调用,权限见 capabilities/default.json
// (allow-minimize / allow-toggle-maximize / allow-is-maximized / allow-close /
// allow-start-dragging)。浏览器或 stub 环境无 __TAURI__ 时整体跳过。
const MAX_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor"/></svg>';
const RESTORE_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor"/><path d="M3 2.5 V1.2 Q3 0.5 3.7 0.5 H8.8 Q9.5 0.5 9.5 1.2 V6.3 Q9.5 7 8.8 7 H7.5" fill="none" stroke="currentColor"/></svg>';
const MIN_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 5.5 H9.5" stroke="currentColor"/></svg>';
const CLOSE_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.7 0.7 L9.3 9.3 M9.3 0.7 L0.7 9.3" stroke="currentColor"/></svg>';

export function bindWindowControls() {
  const tauri = window.__TAURI__;
  const minBtn = document.getElementById('btn-win-min');
  const maxBtn = document.getElementById('btn-win-max');
  const closeBtn = document.getElementById('btn-win-close');
  if (!minBtn || !maxBtn || !closeBtn) return;
  // macOS 构建(原生红绿灯):CSS 已隐藏按钮,跳过绑定
  if (document.body.classList.contains('platform-darwin')) return;
  // 无 Tauri 环境(纯浏览器调试):按钮隐藏,不留死按钮
  if (!tauri || !tauri.window || !tauri.window.getCurrentWindow) {
    const box = document.getElementById('win-controls');
    if (box) box.classList.add('hidden');
    return;
  }
  const win = tauri.window.getCurrentWindow();
  minBtn.innerHTML = MIN_SVG;
  maxBtn.innerHTML = MAX_SVG;
  closeBtn.innerHTML = CLOSE_SVG;
  minBtn.addEventListener('click', () => { win.minimize().catch(() => {}); });
  maxBtn.addEventListener('click', () => { win.toggleMaximize().catch(() => {}); });
  closeBtn.addEventListener('click', () => { win.close().catch(() => {}); });
  // 最大化状态变化同步图标(还原=双框);onResized 在还原/最大化/手动缩放时都会发
  if (typeof win.onResized === 'function') {
    const sync = async () => {
      try {
        const maximized = await win.isMaximized();
        maxBtn.innerHTML = maximized ? RESTORE_SVG : MAX_SVG;
        maxBtn.title = maximized ? '还原' : '最大化';
      } catch { /* 权限或时序问题不应影响主流程 */ }
    };
    win.onResized(sync);
    sync();
  }
}
