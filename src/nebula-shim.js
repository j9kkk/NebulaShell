// Tauri 环境下的 window.nebula 适配层:与 Electron preload 契约一致
// Electron 下 preload 已定义 window.nebula,本脚本自动跳过
(function () {
  if (window.nebula) return;
  const tauri = window.__TAURI__;
  if (!tauri) return;
  const map = (c) => String(c).replace(/:/g, '__');
  window.__NB_E2E__ = true;
  window.nebula = {
    invoke: (channel, payload) =>
      tauri.core.invoke('nebula_invoke', {
        channel: map(channel),
        payload: payload === undefined ? null : payload,
      }),
    // 仅测试模式:主窗口跟随所有 Space 并聚焦(e2e 可见性预检用)
    testPinWindow: () => tauri.core.invoke('nebula_test_pin_window'),
    on: (channel, cb) => {
      let un = null;
      tauri.event.listen(map(channel), (e) => cb(e.payload)).then((u) => { un = u; });
      return () => { if (un) un(); };
    },
    platform: navigator.userAgent.includes('Mac')
      ? 'darwin'
      : navigator.userAgent.includes('Win')
        ? 'windows'
        : 'linux',
  };
})();
