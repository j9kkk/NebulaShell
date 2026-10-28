// 收起态(40px)侧栏的「悬停浮出」。
//
// 为什么不做主机徽标:40px 放不下可读的名字,任何缩写/字母/图标都是二次编码 ——
// 用户得先学一遍"这枚徽标是谁",而且上百台里必然撞车。这里改为把整块
// `.side-body`(搜索框 + 分组 + 完整主机名)作为覆盖层浮出,看到的永远是真实
// 名字,零学习成本。
//
// 事件绑在 #sidebar 而非窄条上:浮层是 #sidebar 的后代,鼠标从窄条横向移入
// 浮层不会触发 pointerleave,天然形成无间隙桥接。若绑在窄条上就会出现
// "刚滑过去就收回"的抖动。

const HOVER_DELAY = 120;   // 停留多久才浮出:过滤"鼠标路过窗口左边缘"
const LEAVE_DELAY = 200;   // 移开后多久收回:给横向滑入浮层留容差

let showTimer = null;
let hideTimer = null;
let bound = false;

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
  sidebar()?.classList.remove('peek-open');
}

function scheduleOpen() {
  if (!isCollapsed()) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  if (isPeekOpen() || showTimer) return;
  showTimer = setTimeout(() => {
    showTimer = null;
    // 弹窗打开时不浮出:浮层 z-index(35)低于弹窗遮罩,浮出来也看不见,
    // 反而在关闭弹窗后留下一块过期内容
    if (!isCollapsed() || document.querySelector('.modal:not(.hidden)')) return;
    sidebar()?.classList.add('peek-open');
  }, HOVER_DELAY);
}

function scheduleClose() {
  clearTimeout(showTimer);
  showTimer = null;
  if (!isPeekOpen() || hideTimer) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (!sidebar()?.matches(':hover')) {
      sidebar()?.classList.remove('peek-open');
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
    // 指针离开窄条但还没进入浮层(浮层是后代,不会触发父级 leave)
    scheduleClose();
  });

  // 键盘可达:Tab 进窄条按钮或（浮出后）列表里的元素时同样浮出。
  // 不这样做的话,收起态对键盘用户等于内容不存在。
  sb.addEventListener('focusin', () => {
    if (isCollapsed()) scheduleOpen();
  });
  sb.addEventListener('focusout', (e) => {
    // 焦点还在 sidebar 子树内(比如从窄条移到浮层里的输入框)就不收回
    if (e.relatedTarget && sb.contains(e.relatedTarget)) return;
    scheduleClose();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPeekOpen()) {
      e.stopPropagation();
      closePeek();
    }
  });

  // 指针在浮层里点开主机/折叠分组都会重绘 #host-list,浮层本身不重建,
  // 但滚轮事件要能正常落在浮层内 —— 这里不用额外处理,浮层是真实 DOM。
}

/// 侧栏展开/收起切换时调用:切换后浮层状态必须清干净,
/// 否则展开态会带着 peek-open 类(虽然那份 CSS 只作用于 .collapsed)。
export function resetPeekOnToggle() {
  closePeek();
}
