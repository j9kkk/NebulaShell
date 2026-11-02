/** 全局滚动容器规则:可滚行列表的底部渐隐。
 *
 *  CSS 侧见 style.css「全局:可滚行列表的底部渐隐」。这里只做一件事:按
 *  「有没有溢出、滚到哪」给容器写 `data-scroll` 状态,CSS 负责画渐隐。
 *
 *  为什么不用纯 CSS:滚动到底要不要收回渐隐得看 scrollTop,WebKit 没有
 *  scroll-driven animation(Chromium 才有),而 Tauri 在 macOS 上跑的是
 *  WKWebView。为什么不在某个列表里调容器高:用户明确反对 per-component
 *  特例,规则得对所有可滚行列表一致。
 *
 *  用法:给容器加 `data-scroll-fade` 属性 + 调 `observeScrollFade(el)`。
 */

const observed = new WeakSet();

/** 只按尺寸算状态(纯函数,方便单测):none=没溢出 / start=在顶 / middle / end=到底。 */
export function scrollPos({ scrollTop, scrollHeight, clientHeight }) {
  const max = scrollHeight - clientHeight;
  // 1px 容差:亚像素行高会让 scrollHeight 比 clientHeight 多出不到 1px
  if (max <= 1) return 'none';
  if (scrollTop <= 1) return 'start';
  if (scrollTop >= max - 1) return 'end';
  return 'middle';
}

export function syncScrollFade(el) {
  if (!el) return 'none';
  const pos = scrollPos(el);
  if (el.dataset.scroll !== pos) el.dataset.scroll = pos;
  return pos;
}

/** 让容器进入「底部渐隐」管线的幂等登记。行是整块重绘的(innerHTML),
 *  所以同时盯 childList:行数变了不用调用方记得再 sync 一次。 */
export function observeScrollFade(el) {
  if (!el || observed.has(el)) return;
  observed.add(el);
  el.addEventListener('scroll', () => syncScrollFade(el), { passive: true });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => syncScrollFade(el)).observe(el);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => syncScrollFade(el)).observe(el, { childList: true, subtree: true });
  }
  syncScrollFade(el);
}
