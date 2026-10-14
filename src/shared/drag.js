// 通用鼠标拖拽把手:标签条(tab strip)与平铺工作区瓦片标题栏共用。
// 抽取自两处几乎相同的实现 —— 修「丢 mouseup / 按下起选区」类 bug 时不用再各打一遍补丁。
// 契约(与 0.5.5/0.5.7 行为一致):
//   - 左键按下且位移 ≥ threshold(默认 5px)才进入拖拽态;
//   - onMove 里 buttons === 0 兜底 mouseup 丢失(按键已抬起却没收到事件);
//   - 拖拽期间把手/容器加 .dragging,body 加 .tab-dragging(样式层禁 hover 残留与指针穿透)。

/**
 * @param {MouseEvent} ev0 起始 mousedown 事件
 * @param {HTMLElement} handleEl 拖拽期间加 .dragging 的元素(把手本身)
 * @param {object} opts
 * @param {(ev: MouseEvent) => void} opts.onMove 拖拽态下每次 mousemove;不需再判 buttons/阈值
 * @param {(ev: MouseEvent) => void} opts.onEnd 拖拽结束(仅在进入过拖拽态后调用)
 * @param {number} [opts.threshold] 进入拖拽态的最小位移,默认 5px
 */
export function startMouseDrag(ev0, handleEl, { onMove, onEnd, threshold = 5 }) {
  const startX = ev0.clientX;
  const startY = ev0.clientY;
  let dragging = false;
  const up = (ev) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (!dragging) return;
    handleEl.classList.remove('dragging');
    document.body?.classList?.remove('tab-dragging');
    onEnd(ev);
  };
  const move = (ev) => {
    // 按键已抬起却没收到 mouseup:就此结束,把手不能跟着空移的鼠标走
    if (ev.buttons === 0) { up(ev); return; }
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < threshold) return;
      dragging = true;
      handleEl.classList.add('dragging');
      document.body?.classList?.add('tab-dragging');
    }
    ev.preventDefault?.();
    onMove(ev);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
