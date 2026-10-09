/// 命令面板的检索与排序(纯函数,不碰 DOM,单测直接覆盖)。
///
/// 排序依次为:名称前缀、名称包含、关键词(英文别名 / 拼音首字母)前缀、
/// 分类名、模糊匹配(查询串按顺序出现在名称或关键词里,间隔越小越靠前)。
/// 不区分大小写;查询中的空白分词,每个词都要命中。同分保持输入顺序。

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/// 子序列匹配得分:全部字符按序出现返回 1..100(越紧凑越高),否则 0。
export function fuzzyScore(query, text) {
  const q = norm(query).replace(/ /g, '');
  const t = norm(text);
  if (!q || !t) return 0;
  let from = 0;
  let first = -1;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return 0;
    if (first < 0) first = at;
    last = at;
    from = at + 1;
  }
  const spread = last - first + 1 - q.length;
  return Math.max(1, 100 - spread * 5 - first);
}

/// 单个词对一个条目的得分,未命中返回 0。
function termScore(term, item) {
  const name = norm(item.name);
  if (name.startsWith(term)) return 1000;
  if (name.includes(term)) return 800;
  const keywords = (item.keywords || []).map(norm).filter(Boolean);
  if (keywords.some((k) => k === term)) return 700;
  if (keywords.some((k) => k.startsWith(term))) return 600;
  if (keywords.some((k) => k.includes(term))) return 500;
  const category = norm(item.category);
  if (category && category.includes(term)) return 400;
  return Math.max(fuzzyScore(term, name), ...keywords.map((k) => fuzzyScore(term, k)), 0);
}

/// 条目得分:所有词都命中才算命中,取各词得分之和。空查询一律 1。
export function matchScore(query, item) {
  const terms = norm(query).split(' ').filter(Boolean);
  if (!terms.length) return 1;
  let total = 0;
  for (const term of terms) {
    const score = termScore(term, item);
    if (!score) return 0;
    total += score;
  }
  return total;
}

/// 过滤并排序:items 形如 { name, keywords?, category? },返回命中项(稳定排序)。
export function rankItems(query, items) {
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/// 快速连接目标:必须带 user@,避免每个普通检索词都冒出"快速连接"项。
export function quickTargetOf(query) {
  const m = String(query || '').trim().match(/^([\w.-]+)@([\w.-]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const port = Number(m[3]) || 22;
  if (port < 1 || port > 65535) return null;
  return { username: m[1], host: m[2], port };
}
