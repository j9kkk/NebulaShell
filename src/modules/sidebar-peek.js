// 收起态(40px 窄条)侧栏的「悬浮停靠」。
//
// 为什么浮出整块侧栏而不是主机徽标:40px 放不下可读的名字,任何缩写/字母/图标
// 都是二次编码 —— 用户得先学一遍"这枚徽标是谁",而且上百台里必然撞车。这里把
// 完整的 `.side-panel`(标题、计数、搜索、分组条、主机列表)作为停靠卡片浮出,
// 它与展开态侧栏是同一份 DOM,零二次渲染;看到的永远是真实名字,零学习成本。
//
// 事件绑在 #sidebar 而非窄条上:卡片是 #sidebar 的后代,鼠标从窄条横向移入卡片
// 不会触发 pointerleave;6px 间隙另有 ::after 透明桥接(style.css 收起态规则)。

const HOVER_DELAY = 120;   // 停留多久才浮出:过滤"鼠标路过窗口左边缘"
const LEAVE_DELAY = 200;   // 移开后多久收回:给横向滑入卡片留容差
const RECHECK = 250;       // 收回条件未解除时的复查间隔(搜索聚焦/菜单开着)

let showTimer = null;
let hideTimer = null;
let bound = false;
// 进行中的收回是「指针离开」还是「焦点离开」发起的:决定 focusin 能不能取消它
let closeByPointer = false;

function sidebar() {
  return document.getElementById('sidebar');
}

function isCollapsed() {
  return !!sidebar()?.classList.contains('collapsed');
}

export function isPeekOpen() {
  return !!sidebar()?.classList.contains('peek-open');
}

function clearTimers() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = null;
  hideTimer = null;
}

export function closePeek() {
  clearTimers();
  const sb = sidebar();
  if (!sb) return;
  const dock = sb.querySelector('.side-panel');
  const ae = document.activeElement;
  sb.classList.remove('peek-open');
  // 焦点留在被收起的卡片里会"悬空":还给当前终端;没有终端就放弃焦点。
  // 绝不能把焦点放回窄条按钮 —— focusin 会立刻再次浮出。
  if (dock && ae && dock.contains(ae)) {
    const term = document.querySelector('.term-pane.focused .xterm-helper-textarea');
    if (term) term.focus();
    else ae.blur();
  }
}

function scheduleOpen() {
  if (!isCollapsed()) return;
  const sb = sidebar();
  // 卡片已开、收回由「指针离开」发起、而指针没回到侧栏上时,单纯的 focusin
  // 不算重新进入:菜单关闭会把焦点还给触发按钮并触发 focusin,若在这里取消
  // 收回,菜单关掉后卡片就会永远挂着(指针早已离开,不会再有 pointerleave)。
  // 指针真回来了(指针在侧栏上)或键盘 Tab 回来(收回由 focusout 发起)照常取消。
  if (isPeekOpen() && closeByPointer && !sb.matches(':hover')) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  if (isPeekOpen() || showTimer) return;
  showTimer = setTimeout(() => {
    showTimer = null;
    // 弹窗打开时不浮出:卡片 z-index(66)低于弹窗遮罩,浮出来也看不见,
    // 反而在关闭弹窗后留下一块过期内容
    if (!isCollapsed() || document.body.classList.contains('modal-open')) return;
    sidebar()?.classList.add('peek-open');
  }, HOVER_DELAY);
}

// 到点后仍不收回的条件:指针还在侧栏上 / 有菜单(如卡片里 ⠇ 的下拉)开着 /
// 焦点停在卡片的输入框里(正在搜索)。
function shouldStay() {
  if (sidebar()?.matches(':hover')) return true;
  const menu = document.getElementById('ctx-menu');
  if (menu && !menu.classList.contains('hidden') && menu.getClientRects().length) return true;
  const dock = sidebar()?.querySelector('.side-panel');
  const ae = document.activeElement;
  if (dock && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && dock.contains(ae)) return true;
  return false;
}

function scheduleClose() {
  clearTimeout(showTimer);
  showTimer = null;
  if (!isPeekOpen() || hideTimer) return;
  hideTimer = setTimeout(function tick() {
    hideTimer = null;
    if (shouldStay()) {
      // 收回条件没解除(在搜索/有菜单):间隔复查,解除后立即收回
      hideTimer = setTimeout(tick, RECHECK);
    } else {
      closePeek();
    }
  }, LEAVE_DELAY);
}

/// 绑定一次即可(entry 启动时调用)。重复调用是无害的 no-op。
export function bindSidebarPeek() {
  if (bound) return;
  const sb = sidebar();
  if (!sb) return;
  bound = true;

  sb.addEventListener('pointerenter', scheduleOpen);
  sb.addEventListener('pointerleave', () => {
    // 指针离开窄条但还没进入卡片(卡片是后代,不会触发父级 leave)
    closeByPointer = true;
    scheduleClose();
  });

  // 键盘可达:Tab 进窄条按钮或（浮出后）卡片里的元素时同样浮出。
  // 不这样做的话,收起态对键盘用户等于内容不存在。
  sb.addEventListener('focusin', () => {
    if (isCollapsed()) scheduleOpen();
  });
  sb.addEventListener('focusout', (e) => {
    // 焦点还在 sidebar 子树内(比如从窄条移到卡片里的输入框)就不收回
    if (e.relatedTarget && sb.contains(e.relatedTarget)) return;
    closeByPointer = false;
    scheduleClose();
  });

  // 点卡片外立即收回(捕获阶段,抢在任何 click 处理之前);点 #ctx-menu 不算外
  document.addEventListener('pointerdown', (e) => {
    if (!isPeekOpen() || sb.contains(e.target)) return;
    const menu = document.getElementById('ctx-menu');
    if (menu && menu.contains(e.target)) return;
    closePeek();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isPeekOpen()) return;
    // 弹窗打开时 Esc 归弹窗管
    if (document.body.classList.contains('modal-open')) return;
    e.stopPropagation();
    closePeek();
  });

  // 点/中键卡片里的主机:连接由 host-item 自己的处理器完成(先于 document 冒泡),
  // 这里只负责收回。星标/克隆/编辑/删除按钮自己 stopPropagation,不会走到这里。
  const hostClose = (e) => {
    if (!isPeekOpen()) return;
    const item = e.target?.closest?.('#host-list .host-item');
    if (item && sb.contains(item)) closePeek();
  };
  document.addEventListener('click', hostClose);
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) hostClose(e);
  });

  // 任何弹窗打开(modal-scope 同步 body.modal-open)都立即收回
  document.addEventListener('nebula:modal-scope', () => {
    if (isPeekOpen() && document.body.classList.contains('modal-open')) closePeek();
  });
}

/// 侧栏展开/收起切换时调用:切换后停靠状态必须清干净,
/// 否则展开态会带着 peek-open 类(虽然那份 CSS 只作用于 .collapsed)。
export function resetPeekOnToggle() {
  closePeek();
}
