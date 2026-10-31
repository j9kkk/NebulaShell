// 收起态主机按钮的停靠卡。
//
// v7 统一模型：窄条所有按钮 hover 只出 tooltip，click 才开/关浮层。
// 主机按钮 click 只开关 264 停靠卡，不再自动展开侧栏；展开走标题栏开关或 ⌘B。
// 卡片是 `.side-panel` 本体（与展开态同一份 DOM），用 #sidebar.peek-open 控制显隐，
// 不复制一份主机列表。

let bound = false;

function sidebar() {
  return document.getElementById('sidebar');
}

function hostButton() {
  return document.getElementById('rail-hosts');
}

function hostDock() {
  return sidebar()?.querySelector('.side-panel');
}

export function isPeekOpen() {
  return !!sidebar()?.classList.contains('peek-open');
}

function syncHostButton(on) {
  const btn = hostButton();
  if (!btn) return;
  btn.classList.toggle('rail-on', on);
  btn.setAttribute('aria-expanded', String(on));
}

export function closePeek({ focusBack = false } = {}) {
  const sb = sidebar();
  if (!sb || !sb.classList.contains('peek-open')) return;
  const panel = hostDock();
  const ae = document.activeElement;
  const wasInside = !!(panel && ae && panel.contains(ae));
  sb.classList.remove('peek-open');
  syncHostButton(false);
  // 卡片里还有焦点时不能让它悬空：Esc 回触发按钮；点外面交给点击目标。
  if (wasInside) {
    if (focusBack) hostButton()?.focus();
    else {
      const term = document.querySelector('.term-pane.focused .xterm-helper-textarea');
      if (term) term.focus();
      else ae?.blur();
    }
  }
}

function openPeek() {
  const sb = sidebar();
  if (!sb || sb.classList.contains('peek-open') || !sb.classList.contains('collapsed')) return;
  if (document.body.classList.contains('modal-open')) return;
  // 工具卡 / 会话卡让位：同屏只允许一个浮层
  document.dispatchEvent(new CustomEvent('nebula:peek-open'));
  sb.classList.add('peek-open');
  syncHostButton(true);
}

export function togglePeek() {
  if (isPeekOpen()) closePeek({ focusBack: true });
  else openPeek();
}

/// 绑定一次即可（entry 启动时调用）。重复调用无害。
export function bindSidebarPeek() {
  if (bound) return;
  const sb = sidebar();
  const btn = hostButton();
  if (!sb || !btn) return;
  bound = true;

  btn.addEventListener('click', togglePeek);

  // 点卡片外立即收回（捕获阶段，抢在任何 click 处理之前）；点 #ctx-menu 不算外
  document.addEventListener('pointerdown', (e) => {
    if (!isPeekOpen() || sb.contains(e.target)) return;
    const menu = document.getElementById('ctx-menu');
    if (menu && menu.contains(e.target)) return;
    closePeek();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isPeekOpen()) return;
    if (document.body.classList.contains('modal-open')) return;
    e.stopPropagation();
    closePeek({ focusBack: true });
  });

  // 点/中键卡片里的主机：连接由 host-item 自己的处理器完成，这里只负责收回。
  const hostClose = (e) => {
    if (!isPeekOpen()) return;
    const item = e.target?.closest?.('#host-list .host-item');
    if (item && sb.contains(item)) closePeek();
  };
  document.addEventListener('click', hostClose);
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) hostClose(e);
  });

  // 弹窗 / 工具卡打开时让位
  document.addEventListener('nebula:modal-scope', () => {
    if (isPeekOpen() && document.body.classList.contains('modal-open')) closePeek();
  });
  document.addEventListener('nebula:rail-card-open', () => {
    if (isPeekOpen()) closePeek();
  });
}

/// 侧栏展开/收起切换时清干净停靠态（否则展开态会带着 peek-open）。
export function resetPeekOnToggle() {
  closePeek();
}
