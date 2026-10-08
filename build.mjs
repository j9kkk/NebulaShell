// 前端构建:esbuild 打包渲染层 → dist/(由 Tauri 的 frontendDist 引用)
// 平台样式在构建期烙进产物:Tauri 不支持跨平台打包,build 永远发生在目标
// 平台上(process.platform 即目标平台),故 index.html 预置两套 class
// (platform-darwin / platform-nonmacos),构建时删掉不适用的那套 ——
// 不依赖运行时 UA/平台探测,也不会因字符串差异失效。
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.');
const dist = path.join(root, 'dist');
// HTML/CSS 分支 class:macOS 构建留 darwin,Windows/Linux 留 nonmacos
const macosBuild = process.platform === 'darwin';
const keep = macosBuild ? 'platform-darwin' : 'platform-nonmacos';

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/app.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outfile: path.join(dist, 'app.js'),
  logLevel: 'warning',
});

// index.html:body class 只保留本平台的那个;side-header 上的
// data-platform-darwin-only="tl-row" 转成 macOS 构建的实际 class,
// 非 macOS 构建移除该属性(无红绿灯,不需要让位行)。
let html = await readFile(path.join(root, 'src/index.html'), 'utf8');
html = html
  .replace(`<body class="platform-darwin platform-nonmacos">`, `<body class="${keep}">`)
  .replace(
    /<div class="side-header"([^>]*)data-platform-darwin-only="tl-row">/,
    macosBuild
      ? '<div class="side-header tl-row"$1>'
      : '<div class="side-header"$1>',
  );
await writeFile(path.join(dist, 'index.html'), html);

// CSS:esbuild 处理 app.js 的 `import '@xterm/xterm/css/xterm.css'` 与
// `import './style.css'`,合并输出到 dist/app.css。绝不能在这里再 cp
// src/style.css 覆盖它 —— 那会把 xterm.css 剪掉(现象:终端 textarea/测宽
// 元素失去 absolute 定位,把 .xterm-rows 往下顶约 40px,整屏内容压边错乱)。
await cp(path.join(root, 'src/nebula-shim.js'), path.join(dist, 'nebula-shim.js'));
// AI 头像引用的应用图标(单一来源:src-tauri/icons/icon.svg,勿在 JS 里复制)
await cp(path.join(root, 'src-tauri/icons/icon.svg'), path.join(dist, 'icon.svg'));

console.log(`[build] frontend -> dist/ (platform: ${macosBuild ? 'darwin' : 'nonmacos'})`);
