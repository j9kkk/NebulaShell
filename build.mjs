// 前端构建:esbuild 打包渲染层 → dist/(由 Tauri 的 frontendDist 引用)
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.');
const dist = path.join(root, 'dist');

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

await cp(path.join(root, 'src/index.html'), path.join(dist, 'index.html'));
await cp(path.join(root, 'src/nebula-shim.js'), path.join(dist, 'nebula-shim.js'));

console.log('[build] frontend -> dist/');
