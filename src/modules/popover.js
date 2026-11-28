/// 锚定浮层公共原语（Popover）：统一全站锚定定位、挂 body 防裁切、aria-expanded 同步、
/// 接入全局 overlay-manager（互斥 / Esc / 点外 / resize / 焦点归还）与悬停防抖桥。

import { computeAnchorPosition } from '../shared/overlay-position.js';
import { closeOverlay, isOverlayOpen, openOverlay } from './overlay-manager.js';

/// 将浮层挂到 document.body 并按锚点做 fixed 定位。
export function positionAnchoredElement(el, trigger, opts = {}) {
  if (!el || !trigger) return null;
  if (opts.reparent !== false && typeof document !== 'undefined' && document.body && el.parentElement && el.parentElement !== document.body) {
    document.body.appendChild(el);
  }
  const anchor = trigger.getBoundingClientRect?.();
  if (!anchor) return null;
  const size = {
    width: el.offsetWidth || opts.width || 240,
    height: el.offsetHeight || opts.height || 200,
  };
  const viewport = {
    width: (typeof window !== 'undefined' && window.innerWidth) || 1280,
    height: (typeof window !== 'undefined' && window.innerHeight) || 800,
  };
  const pos = computeAnchorPosition(anchor, size, viewport, {
    placement: opts.placement ?? 'bottom',
    align: opts.align ?? 'start',
    gap: opts.gap ?? 6,
    margin: opts.margin ?? 8,
    flip: opts.flip ?? true,
  });
  if (el.style) {
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  }
  return pos;
}

/// 打开一个标准锚定浮层并纳入全局弹层栈。
export function openAnchoredPopover(opts = {}) {
  const {
    id,
    el,
    trigger,
    triggers = null,
    kind = 'popover',
    group = 'floating',
    parentId = null,
    placement = 'bottom',
    align = 'start',
    gap = 6,
    margin = 8,
    width = 240,
    height = 200,
    flip = true,
    reparent = true,
    closeOnOutside = true,
    closeOnEsc = true,
    closeOnResize = true,
    onResize = null,
    onClose = null,
  } = opts;
  if (!el) return null;
  const overlayId = id || el.id;
  if (reparent && typeof document !== 'undefined' && document.body && el.parentElement && el.parentElement !== document.body) {
    document.body.appendChild(el);
  }
  el.classList?.remove('hidden');
  trigger?.setAttribute?.('aria-expanded', 'true');
  const pos = trigger
    ? positionAnchoredElement(el, trigger, { placement, align, gap, margin, width, height, flip, reparent: false })
    : null;

  openOverlay({
    id: overlayId,
    kind,
    group,
    parentId,
    el,
    triggers: triggers || (trigger ? [trigger] : []),
    closeOnOutside,
    closeOnEsc,
    closeOnResize,
    onResize: onResize || (closeOnResize === false && trigger
      ? () => positionAnchoredElement(el, trigger, { placement, align, gap, margin, width, height, flip, reparent: false })
      : null),
    close: (closeOpts = {}) => {
      el.classList?.add('hidden');
      trigger?.setAttribute?.('aria-expanded', 'false');
      onClose?.(closeOpts);
      if (closeOpts.focusTrigger && typeof trigger?.focus === 'function') {
        trigger.focus();
      }
    },
  });
  return pos;
}

export function closeAnchoredPopover(id, opts = {}) {
  return closeOverlay(id, opts);
}

export function isAnchoredPopoverOpen(id) {
  return isOverlayOpen(id);
}

/// 悬停防抖桥：鼠标从触发钮移进浮层时不闪烁关闭，离开两者后按 delay 收起。
export function bindHoverPopover(trigger, pop, { onOpen, onClose, delay = 150 } = {}) {
  if (!trigger || !pop) return { cancel() {} };
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const open = () => { cancel(); onOpen?.(); };
  const scheduleClose = () => { cancel(); timer = setTimeout(() => { timer = null; onClose?.(); }, delay); };
  trigger.addEventListener?.('mouseenter', open);
  trigger.addEventListener?.('mouseleave', scheduleClose);
  pop.addEventListener?.('mouseenter', cancel);
  pop.addEventListener?.('mouseleave', scheduleClose);
  return { cancel, open, scheduleClose };
}
