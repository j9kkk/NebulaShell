// 回顾指定时间范围(或 rev 范围)内的提交,生成 bug 根因汇总 + 修复模式聚类的 Markdown 报告。
// 用法:
//   node scripts/commit-review.mjs [--hours 24] [--rev A..B] [--max-diff 400]
//   --hours N    回顾最近 N 小时的提交(默认 24)
//   --rev A..B   直接指定 git rev 范围(优先于 --hours),也支持单个 hash
//   --max-diff N 每个提交最多展示的 diff 行数(默认 200)
// 零依赖,风格对齐 scripts/extract-changelog.mjs。
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const repo = process.cwd();
const maxDiff = Number(argOf('--max-diff', 200));
const revArg = args.includes('--rev') ? argOf('--rev') : null;
const hours = Number(argOf('--hours', 24));

function git(gitArgs) {
  return execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const rev = revArg
  ? // 单 hash 会被 git log 展开为"该提交及全部祖先",改为只看该提交本身;
    // 根提交无父提交,git 直接接受单个 hash。
    /[\s.^^]/.test(revArg) || execFileSync('git', ['-C', repo, 'rev-list', '--max-parents=1', revArg], { encoding: 'utf8' }).trim().split('\n').length === 1
    ? revArg
    : `${revArg}~1..${revArg}`
  : `--since="${hours} hours ago"`;
// 字段用 %x00(NUL)分隔,避免消息内含 % 等字符破坏解析;END 行标记记录结束。
const sep = '\u0000';
const logFields = ['%H', '%h', '%ad', '%s', '%b'].join('%x00');
const raw = git(['log', rev, `--date=iso`, `--pretty=format:${logFields}%x00END`]);

const commits = raw
  .split(/\x00END\n/)
  .filter((blk) => blk.trim())
  .map((blk) => {
    const [hash, short, date, subject, body] = blk.split(sep);
    // Conventional Commits: type(scope)!?: subject
    const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:\s*(.*)$/);
    return {
      hash,
      short,
      date,
      subject,
      body: (body || '').trim(),
      type: m ? m[1] : 'other',
      scope: m && m[2] ? m[2].slice(1, -1) : '',
      breaking: Boolean(m && m[3]),
    };
  });

if (commits.length === 0) {
  console.log(`范围内无提交(${revArg ? `rev=${revArg}` : `最近 ${hours} 小时`})。`);
  console.log('可尝试扩大范围: node scripts/commit-review.mjs --hours 168');
  process.exit(0);
}

// 每个 commit 附上 stat 与 diff(截断)。
for (const c of commits) {
  c.stat = git(['show', '--stat', '--oneline', c.short]);
  const diff = git(['show', c.short, '--format=', '--unified=1']);
  c.diff = diff.split('\n').length > maxDiff ? diff.split('\n').slice(0, maxDiff).join('\n') + '\n…(截断)' : diff;
  c.files = git(['show', '--format=', '--name-only', c.short]).trim().split('\n').filter(Boolean);
}

// ---- 启发式修复模式聚类 ----
// 每条模式 = 关键词组(在 diff/提交信息中命中) + 说明。命中两个及以上提交的模式排在前面。
const PATTERNS = [
  { name: 'CSS 布局对齐(grid/共享轨道/负 margin)', keys: ['grid-template', 'grid-area', 'margin: -', 'align-self'] },
  { name: 'Focus ring / 滚动容器裁剪', keys: ['outline', 'focus', 'overflow: auto'] },
  { name: 'CI 镜像/缓存/降级', keys: ['windows-20', 'rust-cache', 'prefix-key', 'continue-on-error', 'runs-on'] },
  { name: '流式/异步性能', keys: ['stream', 'chunk', 'timeout', 'setTimeout', 'await'] },
  { name: '测试适配/接口演化', keys: ['#[test]', 'MockRuntime', 'assert', 'mock'] },
  { name: '弹窗/浮层层级', keys: ['z-index', 'modal'] },
];

function classify(c) {
  const hay = `${c.subject}\n${c.body}\n${c.diff}`;
  return PATTERNS.filter((p) => p.keys.some((k) => hay.includes(k))).map((p) => p.name);
}

const lines = [];
lines.push(`# Commit Review 报告`);
lines.push('');
lines.push(`- 范围: ${revArg ? `rev=${revArg}` : `最近 ${hours} 小时`}  生成时间: ${new Date().toISOString()}`);
lines.push(`- 提交数: ${commits.length}`);
lines.push('');

lines.push('## 提交清单');
lines.push('');
for (const c of commits) {
  lines.push(`### ${c.short} ${c.subject}`);
  lines.push(`- ${c.date} | type=${c.type}${c.scope ? `/${c.scope}` : ''}${c.breaking ? ' [BREAKING]' : ''} | 文件: ${c.files.length}`);
  lines.push('```');
  lines.push(c.stat.trim());
  lines.push('```');
  if (c.body) {
    lines.push('<details><summary>提交正文</summary>');
    lines.push('');
    lines.push(c.body);
    lines.push('');
    lines.push('</details>');
  }
  lines.push('<details><summary>diff 摘要</summary>');
  lines.push('');
  lines.push('```diff');
  lines.push(c.diff);
  lines.push('```');
  lines.push('</details>');
  const tags = classify(c);
  if (tags.length) lines.push(`- 命中模式: ${tags.join('、')}`);
  lines.push('');
}

lines.push('## 修复模式聚类(按命中提交数排序)');
lines.push('');
const counts = {};
for (const c of commits) for (const t of classify(c)) counts[t] = (counts[t] || 0) + 1;
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
if (sorted.length === 0) lines.push('(无模式命中)');
for (const [name, n] of sorted) {
  const hs = commits.filter((c) => classify(c).includes(name)).map((c) => c.short);
  lines.push(`- **${name}** — ${n} 个提交(${hs.join(', ')})`);
}
lines.push('');
lines.push('> 模式命中 ≥2 的项即为"高频修复模式",下次遇到同类问题可直接复用该写法。');
lines.push('> Bug 根因分析与修改建议需人工审读上方各提交的 diff 与正文(仓库习惯:提交正文含"根因→排除项→验证数据")。');

console.log(lines.join('\n'));
