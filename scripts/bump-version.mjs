// 发版版本号同步:package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
// 是构建用的"三处",外加 README 与站点(静态产品介绍页)里的版本引用。
// 最近 24 小时 6 个提交里 5 个都在手工同步这三处(每个发布提交的 stat 必带这三个文件
// 各 ±1 行),故工具化。零依赖,风格对齐 scripts/commit-review.mjs。
//
// README 与 site/ 里的版本号是纯文本引用(下载文件名、徽章文案、release 直链),
// 靠人记一定会漏 —— 0.6.12 一直残留到 0.6.17 才被发现。这里一并改写:
// 版本号形状的串(见 VERSION_REF)替换为新版本,docs 类文案一并跟上。
//
// 用法:
//   node scripts/bump-version.mjs <version>   把各处版本号改成 <version>
//   node scripts/bump-version.mjs --check     只校验一致,不改文件(CI/发版前自查)
//
// CHANGELOG:改完后校验 CHANGELOG.md 是否已有 `## [<version>]` 段落,没有则提示
// 补写(不代写内容 —— 段落文案要人写,见 scripts/extract-changelog.mjs 的提取用法)。
// 仓库根从脚本自身位置推导,与调用方 cwd 无关(同 commit-review.mjs)。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

const FILES = {
  pkg: join(repo, 'package.json'),
  tauri: join(repo, 'src-tauri/tauri.conf.json'),
  cargo: join(repo, 'src-tauri/Cargo.toml'),
  changelog: join(repo, 'CHANGELOG.md'),
  readme: join(repo, 'README.md'),
  siteHtml: join(repo, 'site/index.html'),
  siteJs: join(repo, 'site/app.js'),
};

// 只认完整三段 x.y.z(可带 -pre/-rc.1 后缀)。这个仓库从未用过 build 元数据,不支持。
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readVersions() {
  const pkg = JSON.parse(readFileSync(FILES.pkg, 'utf8'));
  const tauri = JSON.parse(readFileSync(FILES.tauri, 'utf8'));
  // Cargo.toml 是 TOML,不做完整解析 —— 版本行固定是段内的 `version = "x.y.z"`
  // (工作区清单唯一一个 [package] version;依赖的 version = 只出现在行中间,
  // 不会命中 ^version 锚点)。
  const cargoText = readFileSync(FILES.cargo, 'utf8');
  const cargo = cargoText.match(/^version = "([^"]+)"/m);
  return { pkg: pkg.version, tauri: tauri.version, cargo: cargo && cargo[1], cargoText };
}

function writeVersion(target, version, cargoText) {
  if (target === 'cargo') {
    writeFileSync(FILES.cargo, cargoText.replace(/^(version = ")[^"]+(")/m, `$1${version}$2`));
  } else {
    const file = target === 'pkg' ? FILES.pkg : FILES.tauri;
    const text = readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    data.version = version;
    // 保留原缩进与结尾换行,不重排键序(JSON.stringify 生成后逐行对比会只有版本行变化)
    const indent = text.match(/\n(\s*)"/)[1];
    writeFileSync(file, JSON.stringify(data, null, indent) + (text.endsWith('\n') ? '\n' : ''));
  }
}

/// README 与站点里的版本引用。只匹配"产品版本"的具体形状,不能笼统匹配
/// 所有 `vX.Y.Z` —— README 的源码构建示例里有 `git tag v0.1.0`(示例值,
/// 改动它是错的)。允许的形状:
///   1. 安装包文件名前缀:`NebulaShell_0.6.17_`(README 表格、site 直链)
///   2. release 下载目录:`releases/download/v0.6.17/`
///   3. 站点徽章文案:`>v0.6.17<` 与 `v0.6.17 最新版`
const VERSION_REF = [
  /\bNebulaShell[_-](\d+\.\d+\.\d+)_/g,
  /releases\/download\/v(\d+\.\d+\.\d+)\//g,
  />v(\d+\.\d+\.\d+)</g,
  /v(\d+\.\d+\.\d+) 最新版/g,
];

function listVersionRefs(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  for (const re of VERSION_REF) {
    for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/// 改写:只替换上面四个形状里的版本号片段,其余文本原样保留。
function writeVersionRefs(file, version) {
  const text = readFileSync(file, 'utf8');
  let next = text;
  for (const re of VERSION_REF) {
    next = next.replace(re, (whole) => whole.replace(/\d+\.\d+\.\d+/, version));
  }
  if (next !== text) writeFileSync(file, next);
  return next !== text;
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const version = args.find((a) => !a.startsWith('--'));

  if (checkOnly && version) {
    console.error('--check 与 <version> 不能同时给');
    process.exit(2);
  }
  if (version && !SEMVER.test(version)) {
    console.error(`非法版本号:${version}(需要 x.y.z 或 x.y.z-后缀)`);
    process.exit(2);
  }

  const before = readVersions();
  const missing = Object.entries({ 'package.json': before.pkg, 'tauri.conf.json': before.tauri, 'Cargo.toml': before.cargo })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`读不到版本号:${missing.join(', ')}(Cargo.toml 须有 [package] version = "…")`);
    process.exit(1);
  }

  if (!checkOnly) {
    if (!version) {
      console.error('用法: node scripts/bump-version.mjs <version> | --check');
      process.exit(2);
    }
    if (version === before.pkg && version === before.tauri && version === before.cargo) {
      console.log(`三处已是 ${version},无需改动。`);
    } else {
      writeVersion('pkg', version);
      writeVersion('tauri', version);
      writeVersion('cargo', version, before.cargoText);
      console.log(`版本号已同步为 ${version}:`);
      console.log(`  package.json        ${before.pkg} -> ${version}`);
      console.log(`  tauri.conf.json     ${before.tauri} -> ${version}`);
      console.log(`  src-tauri/Cargo.toml ${before.cargo} -> ${version}`);
      console.log('注意:Cargo.toml 变更后下次构建会刷新 Cargo.lock(正常,一并提交)。');
    }
    // README 与站点文案里的版本引用(与三处独立:它们可能已经落后好几版,
    // 所以不能跟着"三处是否相同"的分支跳过)
    for (const [label, file] of [['README.md', FILES.readme], ['site/index.html', FILES.siteHtml], ['site/app.js', FILES.siteJs]]) {
      if (writeVersionRefs(file, version)) console.log(`  ${label.padEnd(18)} 版本引用 -> ${version}`);
    }
  } else if (before.pkg !== before.tauri || before.pkg !== before.cargo) {
    console.error(`版本号不一致:package.json=${before.pkg} tauri.conf.json=${before.tauri} Cargo.toml=${before.cargo}`);
    process.exit(1);
  } else {
    console.log(`三处版本一致:${before.pkg}`);
    // 文档侧漂移检查:README/站点里的版本引用必须与 package.json 一致,
    // 否则产品介绍页会一直挂着旧版本号和失效的下载直链(0.6.12 曾残留五版)
    const stale = [];
    for (const [label, file] of [['README.md', FILES.readme], ['site/index.html', FILES.siteHtml], ['site/app.js', FILES.siteJs]]) {
      const refs = listVersionRefs(file).filter((r) => !r.includes(before.pkg));
      if (refs.length) stale.push(`${label}(${refs.join(', ')})`);
    }
    if (stale.length) {
      console.error(`\n警告:以下文件仍引用旧版本号,应同步到 ${before.pkg}:`);
      for (const s of stale) console.error(`  ${s}`);
      console.error('文件:README.md、site/index.html、site/app.js');
      console.error('修正:node scripts/bump-version.mjs ' + before.pkg);
      process.exitCode = 1;
    }
  }

  // CHANGELOG 段落校验(改写与 --check 都做:发版前它必须已存在)
  const current = checkOnly ? before.pkg : version;
  const changelog = readFileSync(FILES.changelog, 'utf8');
  if (!changelog.includes(`## [${current}]`)) {
    console.error(`\n警告:CHANGELOG.md 还没有 "## [${current}]" 段落。`);
    console.error(`发版提交前须补写(Release 工作流用 extract-changelog.mjs 提取该段落):`);
    console.error(`  node scripts/extract-changelog.mjs  # 查看提取效果`);
    process.exitCode = 1;
  } else if (checkOnly) {
    console.log(`CHANGELOG.md 已有 [${current}] 段落。`);
  }
}

main();
