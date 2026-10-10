/// 文件与传输相关的显示格式和速度估算。纯函数,不 import 任何模块。

const pad2 = (n) => String(n).padStart(2, '0');

/// 字节数 → '512 B' / '1.5 KB' / '700.0 MB'。非数或负数返回 ''。
export function fmtSize(n) {
  if (n == null || !Number.isFinite(Number(n)) || n < 0) return '';
  if (n < 1024) return Math.round(n) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

/// 字节/秒 → '12.4 MB/s';没有有效速度返回 ''。
export function fmtSpeed(bytesPerSecond) {
  return bytesPerSecond > 0 && Number.isFinite(bytesPerSecond) ? fmtSize(bytesPerSecond) + '/s' : '';
}

/// 毫秒时长 → '不到 1 秒' / '28 秒' / '3 分 05 秒' / '1 小时 02 分'。
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 1) return '不到 1 秒';
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${pad2(total % 60)} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${pad2(minutes % 60)} 分`;
}

/// 文件列表的修改时间:今年 'MM-DD HH:mm',往年 'YYYY-MM-DD';没有时间(0)返回 ''。
export function fmtMtime(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  if (d.getFullYear() !== new Date(now).getFullYear()) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/// 完整时间 'YYYY-MM-DD HH:mm:ss'(悬停提示用)。
export function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/// 时刻 'HH:mm'(「16:42 完成」)。
export function fmtClock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/// 速度采样窗口:samples 是按时间排序的 [时刻 ms, 累计字节];保留最近 windowMs 内的点
/// (至少留一个更早的点作基线)。返回新数组,不修改入参。
export function pushSample(samples, at, bytes, windowMs = 5000) {
  const next = [...(samples || []), [at, bytes]];
  let start = 0;
  while (start < next.length - 2 && next[start + 1][0] <= at - windowMs) start++;
  return next.slice(start);
}

/// 窗口内的平均速度(字节/秒);样本不足或时间跨度过短(<300ms)返回 0。
export function rateOf(samples) {
  if (!samples || samples.length < 2) return 0;
  const [t0, b0] = samples[0];
  const [t1, b1] = samples[samples.length - 1];
  const span = t1 - t0;
  if (span < 300 || b1 < b0) return 0;
  return ((b1 - b0) * 1000) / span;
}

/// 剩余时间(毫秒);总量未知或速度为 0 时返回 null(界面不显示剩余时间)。
export function remainingMs(bytes, total, rate) {
  if (!(total > 0) || !(rate > 0) || bytes >= total) return null;
  return ((total - bytes) / rate) * 1000;
}
