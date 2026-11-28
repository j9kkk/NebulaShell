// AI 输入区富文本编辑器（contenteditable="true"）
// P3：替代 <textarea id="ai-input">，提供纯文本 / 分段读写、data-empty 占位符同步、
//     纯文本粘贴、IME 组合输入守卫与高度自适应（52px–132px）。
// P4：在此之上扩展内联 @主机 chip（.ai-chip）与 @ 候选浮层（#ai-mention-pop）。

import { $ } from './core.js';
import { closeOverlay, openOverlay } from './overlay-manager.js';

let isComposing = false;

/// 获取编辑器 DOM 节点（支持传入节点或默认查 #ai-input）。
export function composerEl(el) {
  return el || $('#ai-input');
}

/// 将 DOM 树解析为段列表：[{ type: 'text', text } | { type: 'chip', hostKey, label, out }]。
/// 兼容旧测试环境中直接对 el.value 赋值的场景。
export function getComposerSegs(el) {
  const root = composerEl(el);
  if (!root) return [];

  const children = root.childNodes || root.children || [];
  if (children.length === 0) {
    const raw = typeof root.value === 'string' && root.value.length > 0
      ? root.value
      : (root.textContent || '');
    return raw ? [{ type: 'text', text: String(raw).replace(/\u00a0/g, ' ') }] : [];
  }

  const segs = [];
  const pushText = (str) => {
    if (!str) return;
    const norm = String(str).replace(/\u00a0/g, ' ');
    if (!norm) return;
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') {
      last.text += norm;
    } else {
      segs.push({ type: 'text', text: norm });
    }
  };

  const walk = (node, indexInParent = 0) => {
    if (!node) return;
    const nodeType = node.nodeType;
    if (nodeType === 3) {
      pushText(node.nodeValue ?? node.textContent ?? '');
      return;
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (node.classList?.contains?.('ai-chip') || node.dataset?.hostKey) {
      const hostKey = node.dataset?.hostKey || node.getAttribute?.('data-host-key') || '';
      const rawLabel = (node.textContent || '').trim().replace(/^@/, '');
      const label = node.dataset?.hostLabel || rawLabel || hostKey;
      const out = node.dataset?.out === 'true' || node.getAttribute?.('data-out') === 'true';
      segs.push({ type: 'chip', hostKey, label, out });
      return;
    }
    if (tag === 'BR') {
      // contenteditable 末尾占位的 <br> 不计入换行
      const parent = node.parentNode;
      const pKids = parent ? (parent.childNodes || parent.children || []) : [];
      const isTrailingOnlyBr = pKids.length === 1 || (indexInParent === pKids.length - 1 && tag === 'BR' && !node._fromShiftEnter);
      if (!isTrailingOnlyBr || pKids.length > 1) {
        pushText('\n');
      }
      return;
    }
    const isBlock = tag === 'DIV' || tag === 'P';
    if (isBlock && segs.length > 0) {
      const last = segs[segs.length - 1];
      if (!last || last.type !== 'text' || !last.text.endsWith('\n')) {
        pushText('\n');
      }
    }
    const kids = node.childNodes || node.children || [];
    if (kids.length > 0) {
      for (let i = 0; i < kids.length; i++) {
        walk(kids[i], i);
      }
    } else if (node.textContent) {
      pushText(node.textContent);
    }
  };

  for (let i = 0; i < children.length; i++) {
    walk(children[i], i);
  }
  return segs;
}

/// 序列化为纯文本（chip 序列化为 `@${label}`），用于发送给模型、计算 token 与复制。
export function getComposerText(el) {
  const root = composerEl(el);
  if (!root) return '';
  const segs = getComposerSegs(root);
  if (segs.length === 0) return '';
  return segs
    .map((s) => (s.type === 'chip' ? `@${s.label}` : s.text))
    .join('');
}

/// 提取当前编辑器内所有合法的内联 chip 主机键列表（去重，按出现序）。
/// 范围外手打的 `@foo` 纯文本不会成为 `.ai-chip` 节点，因此不会出现在此列表中（F11）。
export function getComposerMentions(el, { includeOut = false } = {}) {
  const segs = getComposerSegs(el);
  const out = [];
  const seen = new Set();
  for (const s of segs) {
    if (s.type !== 'chip' || !s.hostKey) continue;
    if (!includeOut && s.out) continue;
    if (!seen.has(s.hostKey)) {
      seen.add(s.hostKey);
      out.push(s.hostKey);
    }
  }
  return out;
}

/// 读取当前编辑器内的全部 chip 详情（含是否已失效 out）。
export function getComposerChips(el) {
  return getComposerSegs(el).filter((s) => s.type === 'chip');
}

/// 创建单个内联 chip DOM 节点（contenteditable="false" 原子节点）。
export function createChipElement(doc, { hostKey, label, out = false }) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const span = d ? d.createElement('span') : null;
  if (!span) return null;
  span.className = 'ai-chip';
  span.setAttribute('contenteditable', 'false');
  span.dataset.hostKey = String(hostKey || '');
  span.dataset.hostLabel = String(label || hostKey || '');
  if (out) {
    span.dataset.out = 'true';
    span.setAttribute('data-out', 'true');
  }
  span.textContent = `@${label || hostKey}`;
  return span;
}

/// 同步 data-empty 属性与自适应高度。
export function syncComposerState(el) {
  const root = composerEl(el);
  if (!root) return;
  const segs = getComposerSegs(root);
  const hasContent = segs.some((s) => s.type === 'chip' || (s.type === 'text' && s.text.length > 0));
  if (root.dataset) {
    root.dataset.empty = hasContent ? '0' : '1';
  }
  if (root.setAttribute) {
    root.setAttribute('data-empty', hasContent ? '0' : '1');
  }
  // 同步镜像到 root.value，兼容旧读取点
  const plain = segs.map((s) => (s.type === 'chip' ? `@${s.label}` : s.text)).join('');
  root.value = plain;
}

/// 用段列表或纯文本/草稿对象重绘编辑器内容（F21）。
/// draft 支持：string | { text, segs, mentions } | Array<seg>
export function setComposerSegs(draft, el) {
  const root = composerEl(el);
  if (!root) return;
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);

  let segs = [];
  if (Array.isArray(draft)) {
    segs = draft;
  } else if (draft && typeof draft === 'object') {
    if (Array.isArray(draft.segs)) {
      segs = draft.segs;
    } else if (typeof draft.text === 'string' && draft.text) {
      segs = [{ type: 'text', text: draft.text }];
    }
  } else if (typeof draft === 'string' && draft.length > 0) {
    segs = [{ type: 'text', text: draft }];
  }

  if (typeof root.replaceChildren === 'function') {
    root.replaceChildren();
  } else {
    root.innerHTML = '';
    if (Array.isArray(root.children)) root.children.length = 0;
  }
  root.value = '';

  for (const s of segs) {
    if (!s) continue;
    if (s.type === 'chip' && s.hostKey) {
      const chip = createChipElement(doc, s);
      if (chip) root.appendChild(chip);
    } else if (s.type === 'text' && s.text) {
      if (doc && typeof doc.createTextNode === 'function') {
        root.appendChild(doc.createTextNode(s.text));
      } else if (doc && typeof doc.createElement === 'function') {
        const span = doc.createElement('span');
        span.textContent = s.text;
        root.appendChild(span);
      } else {
        root.textContent = (root.textContent || '') + s.text;
      }
    }
  }

  syncComposerState(root);
}

/// 设置纯文本内容（清空现有 chip）。
export function setComposerText(text, el) {
  setComposerSegs(typeof text === 'string' ? text : String(text ?? ''), el);
}

/// 清空编辑器内容并恢复空态占位符。
export function clearComposer(el) {
  setComposerSegs([], el);
}

/// 读取可持久化的草稿结构（若只含纯文本则返回字符串，含 chip 则返回 { text, segs, mentions }）。
export function getComposerDraft(el) {
  const segs = getComposerSegs(el);
  if (segs.length === 0) return '';
  const hasChip = segs.some((s) => s.type === 'chip');
  const text = segs.map((s) => (s.type === 'chip' ? `@${s.label}` : s.text)).join('');
  if (!hasChip) return text;
  return {
    text,
    segs,
    mentions: getComposerMentions(el, { includeOut: true }),
  };
}

/// 在当前光标处插入纯文本（用于粘贴 text/plain 或快捷插入）。
export function insertComposerText(text, el) {
  const root = composerEl(el);
  if (!root || !text) return;
  const clean = String(text).replace(/\r\n?/g, '\n');
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);

  if (win && typeof win.getSelection === 'function' && doc?.createTextNode) {
    const sel = win.getSelection();
    if (sel && sel.rangeCount > 0 && root.contains?.(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = doc.createTextNode(clean);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      sel.removeAllRanges();
      sel.addRange(range);
      syncComposerState(root);
      return;
    }
  }

  // 无活动选区时追加到末尾
  if (doc && typeof doc.createTextNode === 'function') {
    root.appendChild(doc.createTextNode(clean));
  } else {
    const prev = getComposerText(root);
    setComposerText(prev + clean, root);
    return;
  }
  syncComposerState(root);
}

/// 当 thread.scope 变化时，实时更新编辑器内已有 chip 的 data-out 状态（F13 / F25）：
/// 不在 scope 内的 chip 标 data-out="true"（灰化+删除线），重新加回 scope 后恢复正常。
export function refreshComposerChipsScope(scope = [], el) {
  const root = composerEl(el);
  if (!root || !root.querySelectorAll) return { outCount: 0, outLabels: [] };
  const set = new Set(Array.isArray(scope) ? scope : []);
  const chips = root.querySelectorAll('.ai-chip');
  let outCount = 0;
  const outLabels = [];
  for (const chip of chips) {
    const key = chip.dataset?.hostKey || chip.getAttribute?.('data-host-key') || '';
    const isOut = !set.has(key);
    if (isOut) {
      chip.dataset.out = 'true';
      chip.setAttribute?.('data-out', 'true');
      outCount++;
      outLabels.push(chip.dataset?.hostLabel || (chip.textContent || '').replace(/^@/, '') || key);
    } else {
      delete chip.dataset.out;
      chip.removeAttribute?.('data-out');
    }
  }
  syncComposerState(root);
  return { outCount, outLabels };
}

/// 移除编辑器内所有失效（data-out="true"）的 chip。
export function removeOutChips(el) {
  const root = composerEl(el);
  if (!root || !root.querySelectorAll) return 0;
  const chips = [...root.querySelectorAll('.ai-chip[data-out="true"]')];
  for (const c of chips) c.remove();
  syncComposerState(root);
  return chips.length;
}

/// 当前是否处于 IME 组合输入中。
export function isComposerComposing() {
  return isComposing;
}

// -------------------------------------------------------------
// P4：@ 触发检测、#ai-mention-pop 候选浮层与 chip 插入/灰化闭环
// -------------------------------------------------------------

let mentionState = {
  open: false,
  query: '',
  activeIndex: 0,
  candidates: [],
  textNode: null,
  atOffset: -1,
  caretOffset: -1,
  onInsert: null,
  onOpenScope: null,
};

/// 检测当前光标是否紧跟在一个合法的 `@[A-Za-z0-9_.-]*` 触发词后（F9）。
export function detectMentionAtCursor(el) {
  const root = composerEl(el);
  if (!root) return null;
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);

  let textNode = null;
  let caretOffset = -1;

  if (win && typeof win.getSelection === 'function') {
    const sel = win.getSelection();
    if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
      const anchor = sel.anchorNode;
      if (anchor && root.contains?.(anchor)) {
        if (anchor.nodeType === 3) {
          textNode = anchor;
          caretOffset = sel.anchorOffset;
        } else if (anchor === root && root.childNodes?.length) {
          const idx = Math.min(sel.anchorOffset, root.childNodes.length) - 1;
          const child = root.childNodes[idx];
          if (child && child.nodeType === 3) {
            textNode = child;
            caretOffset = (child.nodeValue || '').length;
          }
        }
      }
    }
  }

  // Fallback（无 selection 或单测环境）：取最后一个文本节点末尾
  if (!textNode) {
    const kids = root.childNodes || root.children || [];
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i]?.nodeType === 3) {
        textNode = kids[i];
        caretOffset = (textNode.nodeValue || '').length;
        break;
      }
    }
  }

  if (!textNode) return null;
  const val = String(textNode.nodeValue ?? textNode.textContent ?? '');
  const before = val.slice(0, caretOffset);
  const atIdx = before.lastIndexOf('@');
  if (atIdx < 0) return null;

  // `@` 前一个字符若为 ASCII 单词字符（user@host），不触发
  if (atIdx > 0 && /[A-Za-z0-9_.-]/.test(before[atIdx - 1])) {
    return null;
  }

  const query = before.slice(atIdx + 1);
  // `@` 后若已出现空格或换行，说明走出了本次 @ 引用
  if (/[\s\n]/.test(query)) return null;

  return {
    textNode,
    atOffset: atIdx,
    caretOffset,
    query,
  };
}

/// 在当前 `@query` 位置替换为 `.ai-chip` 原子节点 + 尾随空格，并把光标放到空格后（F9 / F10）。
export function insertChipAtMention(host, el, hitOverride = null) {
  const root = composerEl(el);
  if (!root || !host) return false;
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);

  const hostKey = host.hostKey || host.hostId || host.id || host.name || '';
  const label = host.label || host.name || host.host || hostKey;
  const chip = createChipElement(doc, { hostKey, label, out: false });
  if (!chip) return false;

  const hit = hitOverride || (mentionState.textNode ? {
    textNode: mentionState.textNode,
    atOffset: mentionState.atOffset,
    caretOffset: mentionState.caretOffset,
  } : detectMentionAtCursor(root));

  if (hit && hit.textNode && hit.textNode.parentNode === root) {
    const raw = String(hit.textNode.nodeValue ?? hit.textNode.textContent ?? '');
    const prefix = raw.slice(0, hit.atOffset);
    const suffix = raw.slice(hit.caretOffset);
    const afterText = suffix.startsWith(' ') ? suffix : ' ' + suffix;
    const afterNode = doc.createTextNode(afterText);

    if (prefix) {
      hit.textNode.nodeValue = prefix;
      if (hit.textNode.nextSibling) {
        root.insertBefore(chip, hit.textNode.nextSibling);
      } else {
        root.appendChild(chip);
      }
    } else {
      root.insertBefore(chip, hit.textNode);
      root.removeChild(hit.textNode);
    }

    if (chip.nextSibling) {
      root.insertBefore(afterNode, chip.nextSibling);
    } else {
      root.appendChild(afterNode);
    }

    if (win && typeof win.getSelection === 'function' && doc?.createRange) {
      try {
        const range = doc.createRange();
        range.setStart(afterNode, 1);
        range.setEnd(afterNode, 1);
        const sel = win.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* ignore in mock DOM */ }
    }
  } else {
    root.appendChild(chip);
    if (doc?.createTextNode) {
      root.appendChild(doc.createTextNode(' '));
    }
  }

  closeMentionPop();
  syncComposerState(root);
  return true;
}

/// 关闭 `#ai-mention-pop` 浮层。
export function closeMentionPop() {
  mentionState.open = false;
  mentionState.candidates = [];
  mentionState.textNode = null;
  mentionState.atOffset = -1;
  mentionState.caretOffset = -1;
  const pop = $('#ai-mention-pop');
  if (pop) {
    pop.classList.add('hidden');
  }
  closeOverlay('ai-mention-pop');
}

function showMentionPop(pop) {
  pop.classList.remove('hidden');
  openOverlay({
    id: 'ai-mention-pop',
    kind: 'popover',
    group: 'floating',
    el: pop,
    triggers: () => [$('#ai-input')].filter(Boolean),
    close: () => {
      if (mentionState.open) closeMentionPop();
    },
  });
}

/// 当前 `@` 候选浮层是否打开。
export function isMentionPopOpen() {
  const pop = $('#ai-mention-pop');
  return !!(mentionState.open && pop && !pop.classList.contains('hidden'));
}

/// 渲染 `#ai-mention-pop` 候选浮层（只展示当前会话 `scope` 内的主机，F9 / A2 / A3）。
export function renderMentionPop({ scopeHosts = [], query = '', onSelect, onOpenScope } = {}) {
  const pop = $('#ai-mention-pop');
  if (!pop) return;

  const q = String(query || '').trim().toLowerCase();
  const filtered = q
    ? scopeHosts.filter((h) => `${h.name || ''} ${h.address || ''} ${h.group || ''}`.toLowerCase().includes(q))
    : scopeHosts;

  mentionState.open = true;
  mentionState.query = query;
  mentionState.candidates = filtered;
  if (mentionState.activeIndex >= filtered.length) {
    mentionState.activeIndex = 0;
  }
  if (onSelect) mentionState.onInsert = onSelect;
  if (onOpenScope) mentionState.onOpenScope = onOpenScope;

  const doc = pop.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;

  pop.replaceChildren?.();
  if (!pop.replaceChildren) pop.innerHTML = '';

  const hd = doc.createElement('div');
  hd.className = 'ai-mention-hd';
  hd.textContent = scopeHosts.length > 0
    ? `本会话可引用 ${scopeHosts.length} 台`
    : '本会话尚未勾选可操作主机';
  pop.appendChild(hd);

  if (scopeHosts.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'ai-mention-empty';
    const msg = doc.createElement('span');
    msg.textContent = '未勾选可操作主机';
    empty.appendChild(msg);
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-mention-open-scope';
    btn.textContent = '选择主机…';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMentionPop();
      mentionState.onOpenScope?.();
    });
    empty.appendChild(btn);
    pop.appendChild(empty);
    showMentionPop(pop);
    return;
  }

  if (filtered.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'ai-mention-empty';
    empty.textContent = `范围内无匹配「@${query}」的主机`;
    pop.appendChild(empty);
    showMentionPop(pop);
    return;
  }

  filtered.forEach((h, idx) => {
    const row = doc.createElement('button');
    row.type = 'button';
    row.className = 'ai-mention-row' + (idx === mentionState.activeIndex ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', idx === mentionState.activeIndex ? 'true' : 'false');
    row.dataset.hostKey = h.hostKey || h.hostId || '';

    const dot = doc.createElement('span');
    dot.className = 'dot' + (h.connected ? '' : ' off');
    const nm = doc.createElement('span');
    nm.className = 'nm';
    nm.textContent = h.name || h.hostKey;
    const meta = doc.createElement('span');
    meta.className = 'meta';
    meta.textContent = h.address || '';

    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(meta);

    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      mentionState.onInsert?.(h);
    });

    pop.appendChild(row);
  });

  showMentionPop(pop);
}

/// 处理 `#ai-mention-pop` 打开时的键盘导航（↑ / ↓ / Enter / Tab / Escape）及 Backspace 整颗删除 chip。
export function handleComposerKeydown(e, el) {
  const root = composerEl(el);
  if (!root || !e) return false;

  if (isMentionPopOpen()) {
    const len = mentionState.candidates.length;
    if (e.key === 'ArrowDown' || e.key === 'Down') {
      if (len > 0) {
        e.preventDefault();
        mentionState.activeIndex = (mentionState.activeIndex + 1) % len;
        updateMentionActiveRow();
        return true;
      }
    }
    if (e.key === 'ArrowUp' || e.key === 'Up') {
      if (len > 0) {
        e.preventDefault();
        mentionState.activeIndex = (mentionState.activeIndex - 1 + len) % len;
        updateMentionActiveRow();
        return true;
      }
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      if (len > 0) {
        e.preventDefault();
        const chosen = mentionState.candidates[mentionState.activeIndex] || mentionState.candidates[0];
        if (chosen) {
          mentionState.onInsert?.(chosen);
          return true;
        }
      } else {
        closeMentionPop();
        return false;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation?.();
      closeMentionPop();
      return true;
    }
  }

  // Backspace 紧贴 `.ai-chip` 右侧时整颗删除 chip（F10）
  if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (win && typeof win.getSelection === 'function') {
      const sel = win.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const anchor = sel.anchorNode;
        const offset = sel.anchorOffset;
        let prevChip = null;
        if (anchor && anchor.nodeType === 3 && offset === 0) {
          const prev = anchor.previousSibling;
          if (prev && prev.classList?.contains?.('ai-chip')) prevChip = prev;
        } else if (anchor === root && offset > 0) {
          const prev = root.childNodes[offset - 1];
          if (prev && prev.classList?.contains?.('ai-chip')) prevChip = prev;
        }
        if (prevChip) {
          e.preventDefault();
          prevChip.remove();
          syncComposerState(root);
          root.dispatchEvent?.(new Event('input', { bubbles: true }));
          return true;
        }
      }
    }
  }

  return false;
}

function updateMentionActiveRow() {
  const pop = $('#ai-mention-pop');
  if (!pop || !pop.querySelectorAll) return;
  const rows = pop.querySelectorAll('.ai-mention-row');
  rows.forEach((r, idx) => {
    const on = idx === mentionState.activeIndex;
    r.classList.toggle('active', on);
    r.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/// 绑定 contenteditable 编辑器的基础事件（input / composition / paste）。
export function bindComposerEvents(el, { onInput, getScopeHosts, onOpenScope } = {}) {
  const root = composerEl(el);
  if (!root || root._composerBound) return;
  root._composerBound = true;

  syncComposerState(root);

  const checkMention = () => {
    if (isComposing || typeof getScopeHosts !== 'function') return;
    const hit = detectMentionAtCursor(root);
    if (!hit) {
      if (isMentionPopOpen()) closeMentionPop();
      return;
    }
    mentionState.textNode = hit.textNode;
    mentionState.atOffset = hit.atOffset;
    mentionState.caretOffset = hit.caretOffset;
    const scopeHosts = getScopeHosts() || [];
    renderMentionPop({
      scopeHosts,
      query: hit.query,
      onSelect: (h) => {
        insertChipAtMention(h, root, hit);
        onInput?.();
      },
      onOpenScope,
    });
  };

  root.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  root.addEventListener('compositionend', () => {
    isComposing = false;
    syncComposerState(root);
    checkMention();
    onInput?.();
  });
  root.addEventListener('input', () => {
    syncComposerState(root);
    checkMention();
    onInput?.();
  });
  root.addEventListener('click', () => {
    checkMention();
  });
  root.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData?.('text/plain');
    if (typeof text === 'string') {
      e.preventDefault?.();
      insertComposerText(text, root);
      closeMentionPop();
      onInput?.();
    }
  });
}
