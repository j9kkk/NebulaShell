export function activeThreadOf(state) {
  if (!state || !state.aiThreads || !state.activeThreadId) return null;
  return state.aiThreads.get(state.activeThreadId) || null;
}

/// state.aiThreads + state.activeThreadId 是唯一事实源;aiHistory / aiReq 只是指向
/// 活动会话的只读视图 —— 写穿会误伤后台会话的请求(见 0.5.5 并发掐断)。
export function installAiThreadState(state) {
  if (!state) return;
  if (!state.aiThreads) state.aiThreads = new Map();
  if (state.activeThreadId === undefined) state.activeThreadId = null;
  Object.defineProperties(state, {
    aiHistory: {
      get() {
        const th = activeThreadOf(state);
        return th ? th.history : [];
      },
      configurable: true,
      enumerable: true,
    },
    aiReq: {
      get() {
        const th = activeThreadOf(state);
        return th ? th.req : null;
      },
      configurable: true,
      enumerable: true,
    },
  });
}
