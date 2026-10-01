// 从 CHANGELOG.md 提取指定版本的变更段落,供 release 工作流生成 releaseBody。
// 用法: node extract-changelog.mjs 0.1.1 [CHANGELOG路径]
// 找不到对应段落时输出空串并退出码 0(发布不因此失败),stderr 提示。
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const file = process.argv[3] || 'CHANGELOG.md';
if (!version) {
  console.error('用法: node extract-changelog.mjs <版本号> [CHANGELOG路径]');
  process.exit(1);
}

const md = readFileSync(file, 'utf8');
// 匹配 "## [0.1.1] - 2026-10-01" 到下一个 "## [" 标题之间的内容。
// 不能用 \s*$ 作为边界:\s 会吞掉正文换行导致捕获为空。
const lines = md.split(/\n(?=^## \[)/m);
const section = lines.find((l) => l.startsWith(`## [${version}]`));
if (!section) {
  console.error(`CHANGELOG 中未找到 ${version} 的段落`);
  process.exit(0);
}
console.log(
  section
    .split('\n')
    .slice(1) // 去掉 "## [x.y.z] - 日期" 标题行
    .join('\n')
    .trim(),
);
