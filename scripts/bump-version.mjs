// 发版版本号三处同步:package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml。
// 最近 24 小时 6 个提交里 5 个都在手工同步这三处(每个发布提交的 stat 必带这三个文件
// 各 ±1 行),故工具化。零依赖,风格对齐 scripts/commit-review.mjs。
//
// 用法:
//   node scripts/bump-version.mjs <version>   把三处版本号改成 <version>
//   node scripts/bump-version.mjs --check     只校验三处一致,不改文件(CI/发版前自查)
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
  } else if (before.pkg !== before.tauri || before.pkg !== before.cargo) {
    console.error(`版本号不一致:package.json=${before.pkg} tauri.conf.json=${before.tauri} Cargo.toml=${before.cargo}`);
    process.exit(1);
  } else {
    console.log(`三处版本一致:${before.pkg}`);
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
