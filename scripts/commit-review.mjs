// 回顾指定时间范围(或 rev 范围)内的提交,生成 bug 根因汇总 + 修复模式聚类的 Markdown 报告。
// 用法:
//   node scripts/commit-review.mjs [--hours 24] [--rev A..B] [--max-diff 200]
//                                  [--fixes-only] [--author PATTERN] [--output FILE]
//   --hours N    回顾最近 N 小时的提交(默认 24)
//   --rev A..B   直接指定 git rev 范围(优先于 --hours),也支持单个 hash
//   --max-diff N 每个提交最多展示的 diff 行数(默认 200)
//   --fixes-only 只保留 fix/bug/回归相关的提交(subject 或正文命中关键词)
//   --author P   按 git --author 过滤(支持部分匹配,如邮箱前缀)
//   --output F   报告写入文件 F(默认 reports/commit-review-<日期>.md;目录不存在自动创建)
// 零依赖,风格对齐 scripts/extract-changelog.mjs。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const repo = process.cwd();
const maxDiff = Number(argOf('--max-diff', 200));
const revArg = args.includes('--rev') ? argOf('--rev') : null;
const hours = Number(argOf('--hours', 24));
const fixesOnly = args.includes('--fixes-only');
const author = argOf('--author', null);
const output = argOf('--output', null);

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
const logFields = ['%H', '%h', '%ad', '%an', '%s', '%b'].join('%x00');
const raw = git(['log', rev, ...(author ? [`--author=${author}`] : []), `--date=iso`, `--pretty=format:${logFields}%x00END`]);

const commits = raw
  .split(/\x00END\n/)
  .filter((blk) => blk.trim())
  .map((blk) => {
    const [hash, short, date, authorName, subject, body] = blk.split(sep);
    // Conventional Commits: type(scope)!?: subject
    const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:\s*(.*)$/);
    return {
      hash,
      short,
      date,
      author: (authorName || '').trim(),
      subject,
      body: (body || '').trim(),
      type: m ? m[1] : 'other',
      scope: m && m[2] ? m[2].slice(1, -1) : '',
      breaking: Boolean(m && m[3]),
    };
  });

// fix 相关提交过滤:中英文关键词,subject 或正文命中即保留。
const FIX_KEYS = ['fix', 'bug', 'regression', 'deadlock', 'leak', 'race', 'crash', 'hang', '修复', '死锁', '回归', '卡死', '崩溃', '内存泄漏', '竞态'];
const isFix = (c) => {
  const hay = `${c.subject}\n${c.body}`.toLowerCase();
  return FIX_KEYS.some((k) => hay.includes(k.toLowerCase()));
};
const allCommits = commits;
const shownCommits = fixesOnly ? commits.filter(isFix) : commits;

if (shownCommits.length === 0) {
  console.log(
    `范围内无${fixesOnly ? ' fix 相关' : ''}提交(${revArg ? `rev=${revArg}` : `最近 ${hours} 小时`}${author ? `,author=${author}` : ''})。` +
      `\n共扫描 ${allCommits.length} 个提交。`,
  );
  console.log('可尝试扩大范围: node scripts/commit-review.mjs --hours 168');
  process.exit(0);
}

// 每个 commit 附上 stat 与 diff(截断)。
for (const c of shownCommits) {
  c.stat = git(['show', '--stat', '--oneline', c.short]);
  const diff = git(['show', c.short, '--format=', '--unified=1']);
  c.diff = diff.split('\n').length > maxDiff ? diff.split('\n').slice(0, maxDiff).join('\n') + '\n…(截断)' : diff;
  c.files = git(['show', '--format=', '--name-only', c.short]).trim().split('\n').filter(Boolean);
}

// ---- 启发式修复模式聚类 ----
// 每条模式 = 关键词组(在 diff/提交信息中命中) + 说明 + 常见根因/检查清单模板。
// 模式关键词按仓库历史沉淀,换仓库时可自行调整 PATTERNS。
const PATTERNS = [
  {
    name: 'CSS 布局对齐(grid/共享轨道/负 margin)',
    keys: ['grid-template', 'grid-area', 'margin: -', 'align-self'],
    checklist: [
      '同列元素是否显式等宽(input 需要 width:100% 才能对齐)',
      'grid 轨道是否用共享定义(同处一行的控件共用同一 grid 轨道)',
      '收起态是窄条 collapsed 还是 hidden,语义是否一致',
    ],
  },
  {
    name: 'Focus ring / 滚动容器裁剪',
    keys: ['outline', 'focus', 'overflow: auto'],
    checklist: ['overflow:auto 容器是否裁掉 focus ring,需 padding 或负 margin 补偿', '键盘可达性:焦点是否会被弹窗/异步渲染抢占'],
  },
  {
    name: 'CI 镜像/缓存/降级',
    keys: ['windows-20', 'rust-cache', 'prefix-key', 'continue-on-error', 'runs-on'],
    checklist: ['缓存 key 是否包含依赖锁文件哈希', '降级 continue-on-error 是否为临时手段,应有跟踪项'],
  },
  {
    name: '流式/异步性能',
    keys: ['stream', 'chunk', 'timeout', 'setTimeout', 'await'],
    checklist: ['外部 IO(exec/SFTP/HTTP)是否都套了 timeout', '串行批量往返是否可流水线化(滑窗并发)', '重连后旧句柄/缓存是否校验代次(epoch)'],
  },
  {
    name: '测试适配/接口演化',
    keys: ['#[test]', 'MockRuntime', 'assert', 'mock'],
    checklist: ['接口变更是否同步更新 e2e 断言', '新增并发逻辑是否补了单测(如信号量/join 场景)'],
  },
  {
    name: '弹窗/浮层层级',
    keys: ['z-index', 'modal'],
    checklist: ['modal 内联 z-index 递增是否与常驻浮层(toast)层级冲突', '动态 z-index 是否超过常驻浮层'],
  },
];

function classify(c) {
  const hay = `${c.subject}\n${c.body}\n${c.diff}`.toLowerCase();
  return PATTERNS.filter((p) => p.keys.some((k) => hay.includes(k.toLowerCase()))).map((p) => p.name);
}

const lines = [];
lines.push(`# Commit Review 报告`);
lines.push('');
lines.push(
  `- 范围: ${revArg ? `rev=${revArg}` : `最近 ${hours} 小时`}${author ? ` | author: ${author}` : ''}${fixesOnly ? ' | 仅 fix 相关提交' : ''}  生成时间: ${new Date().toISOString()}`,
);
lines.push(`- 提交数: ${shownCommits.length}${fixesOnly ? `(共扫描 ${allCommits.length} 个)` : ''}`);
lines.push('');

lines.push('## 提交清单');
lines.push('');
for (const c of shownCommits) {
  lines.push(`### ${c.short} ${c.subject}`);
  lines.push(`- ${c.date} | ${c.author} | type=${c.type}${c.scope ? `/${c.scope}` : ''}${c.breaking ? ' [BREAKING]' : ''} | 文件: ${c.files.length}`);
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
for (const c of shownCommits) for (const t of classify(c)) counts[t] = (counts[t] || 0) + 1;
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
if (sorted.length === 0) lines.push('(无模式命中)');
for (const [name, n] of sorted) {
  const hs = shownCommits.filter((c) => classify(c).includes(name)).map((c) => c.short);
  lines.push(`- **${name}** — ${n} 个提交(${hs.join(', ')})`);
  const p = PATTERNS.find((x) => x.name === name);
  if (p) {
    lines.push('  - 常见检查清单:');
    for (const item of p.checklist) lines.push(`    - [ ] ${item}`);
  }
}
lines.push('');
lines.push('> 模式命中 ≥2 的项即为"高频修复模式",下次遇到同类问题可直接复用该写法。');
lines.push('> Bug 根因分析与修改建议需人工审读上方各提交的 diff 与正文(仓库习惯:提交正文含"根因→排除项→验证数据")。');

const report = lines.join('\n');
const outPath = output || join(repo, 'reports', `commit-review-${new Date().toISOString().slice(0, 10)}.md`);
mkdirSync(outPath.includes('/') ? outPath.slice(0, outPath.lastIndexOf('/')) : '.', { recursive: true });
writeFileSync(outPath, report + '\n');
console.log(`报告已写入 ${outPath}(${shownCommits.length} 个提交${fixesOnly ? `,共扫描 ${allCommits.length} 个` : ''})。`);
