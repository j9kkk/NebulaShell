#!/usr/bin/env node
// 真实窗口定点验证入口 —— 每个样式批次(B1–B5)验收都用它,不再靠手工起 Xvfb/截图。
//
// 它做的事:
//   1) up    : 编好的二进制 + Xvfb + 应用自带测试桥(NEBULA_TEST=1),等桥就绪;
//   2) eval  : 在**真实页面**里跑一段 JS(和写 Playwright 一样,但驱动的是 Tauri 窗口);
//   3) shot  : 截一张窗口图(ImageMagick import,无窗口管理器也能用);
//   4) theme : 走真实 UI 切主题(命令面板 → 设置 → 终端 → 主题 → 保存);
//   5) ab    : 把任意 git ref 的 src/style.css 注入同窗口当基线,比「旧 CSS vs 现状」
//              的计算样式与像素;像素比对自动扣掉光标闪烁/动画造成的时间噪声。
//
// 为什么不直接跑 e2e: 全量 e2e 慢且会连真机;这里只做「这一批改动的定点核对」。
//
// 用法:
//   node scripts/ui-check.mjs up --build      # 首次编译并启动(约 1 分钟,之后增量几秒)
//   node scripts/ui-check.mjs up              # 只启动
//   node scripts/ui-check.mjs status|down
//   node scripts/ui-check.mjs eval 'return document.title'
//   node scripts/ui-check.mjs styles '.io-item,.io-chip'
//   node scripts/ui-check.mjs shot after-b1
//   node scripts/ui-check.mjs theme light
//   node scripts/ui-check.mjs ab b1 --ref v0.7.6
//
// 约定/边界:
//   - 需要 docker(本机需 `sg docker`,脚本会自动探测);镜像默认 nebula-buildenv:1 / nebula-runenv:1;
//   - 数据目录默认 .ui-check/(git 忽略),可用 NEBULA_UI_DATA 覆盖;
//   - 应用只认 NEBULA_TEST_* 这套测试注入,别在生产包上用;
//   - 截图是 1600×1000 的 Xvfb 根窗口,窗口贴 0,0(无 WM 时不会飘);
//   - styles/ab 的选择器只取**首个命中**(querySelector)。要量「非首行」的状态(比如冲突行
//     以外的主机行),写更具体的选择器或用 :nth-child,否则会量到第一行(可能是 .has-diff 变体)。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.NEBULA_UI_DATA || join(ROOT, '.ui-check');
const CONTAINER = process.env.NEBULA_UI_CONTAINER || 'nebula-ui-check';
const DISPLAY = process.env.NEBULA_UI_DISPLAY || ':101';
const SCREEN = process.env.NEBULA_UI_SCREEN || '1600x1000x24';
const BUILD_IMAGE = process.env.NEBULA_UI_BUILD_IMAGE || 'nebula-buildenv:1';
const RUN_IMAGE = process.env.NEBULA_UI_RUN_IMAGE || 'nebula-runenv:1';
const BASELINE_REF = process.env.NEBULA_UI_BASELINE_REF || 'v0.7.6';
const BIN = join(DATA, 'bin', 'nebulashell');
const PORT_FILE = join(DATA, 'run', 'bridge.port');
const USERDATA = join(DATA, 'run', 'userdata');
const IMPORT_FILE = join(DATA, 'run', 'work', 'hosts-export.json');
const SHOTS = join(DATA, 'shots');

// 默认比对的样式面:覆盖 B0 动过的地方(io 导入面板 / RDP 高级区 / AI 徽标)。
// 后续批次改了别处,用 --selectors 传自己的。
const DEFAULT_SELECTORS = [
  '.io-import .io-list', '.io-import .io-list-head', '.io-import .io-item',
  '.io-import .io-chip', '.io-import .io-stat', '.io-import .io-mini-sel',
  '.io-import .io-foot', '.io-import .io-report', '.io-import .io-seg-row',
  '.io-import .io-seg', '.io-import .io-label',
  '.rdp-adv', '.rdp-adv-title', '.rdp-chk',
  '.ai-thread-count-badge',
];
const PROPS = [
  'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderBottomWidth', 'borderBottomStyle',
  'borderLeftWidth', 'borderLeftStyle', 'borderRightWidth', 'borderRightStyle',
  'backgroundColor', 'color', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'padding', 'margin', 'gap', 'borderRadius', 'boxShadow', 'opacity', 'height', 'width', 'textAlign',
  // 圆角批次的红线:布局列宽/行高不得位移,所以这些也必须进比对
  'gridTemplateColumns', 'gridTemplateRows', 'display', 'flexBasis',
  // 亮色批次(B4)的红线:SVG 上的 stroke/fill/stop-color 与 !important 描边也算可见差异
  'stroke', 'fill', 'stopColor', 'outlineColor',
];

// ── shell 工具 ────────────────────────────────────────────────────────────────

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
let dockerMode = null;
function dk(argv, { input, allowFail = false } = {}) {
  if (dockerMode === null) {
    dockerMode = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 ? 'direct' : 'sg';
  }
  const opts = { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 };
  try {
    return dockerMode === 'direct'
      ? execFileSync('docker', argv, opts)
      : execFileSync('sg', ['docker', '-c', ['docker', ...argv].map(q).join(' ')], opts);
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr || e.message || '').toString().trim();
    throw new Error(`docker ${argv[0]} 失败: ${msg}`);
  }
}
// 容器内执行：走 argv 而不是 bash -lc，省掉一层引号地狱（ImageMagick 的 ( ) 很脆）
const dkExec = (argv) => dk(['exec', '-e', `DISPLAY=${DISPLAY}`, CONTAINER, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
const dkShell = (script) => dk(['exec', CONTAINER, 'bash', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
const cpath = (hostPath) => hostPath.replace(DATA, '/data');   // 宿主 → 容器路径
const dkAlive = () => (dk(['inspect', '-f', '{{.State.Running}}', CONTAINER], { allowFail: true }) || '').trim() === 'true';
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

// ── 测试桥（应用自带：POST /eval，GET /result/<id>，/ping 探活）────────────────

let seq = 0;
async function evalJs(js, timeoutMs = 30000) {
  const port = readPort();
  const id = `ui-${Date.now()}-${++seq}`;
  const res = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, js }),
  });
  if (!res.ok) throw new Error(`/eval ${res.status}`);
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`http://127.0.0.1:${port}/result/${id}`);
    if (r.status === 200) {
      const { value } = await r.json();
      if (typeof value === 'string' && value.startsWith('ERR: ')) throw new Error(value.slice(5));
      return value;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`eval 超时 ${timeoutMs}ms: ${js.slice(0, 80)}`);
    await sleep(120);
  }
}

function readPort() {
  if (!existsSync(PORT_FILE)) throw new Error(`找不到 ${PORT_FILE}，先跑 up`);
  const port = readFileSync(PORT_FILE, 'utf8').trim();
  if (!port) throw new Error('测试桥端口文件为空：应用可能还没启动完或启动失败(看 .ui-check/run/app.log)');
  return port;
}

async function waitReady(timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    try {
      readPort();
      const res = await fetch(`http://127.0.0.1:${readPort()}/ping`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return readPort();
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) {
      const log = existsSync(join(DATA, 'run', 'app.log')) ? readFileSync(join(DATA, 'run', 'app.log'), 'utf8').slice(-2000) : '(无)';
      throw new Error(`测试桥 ${timeoutMs}ms 内未就绪。app.log 末尾:\n${log}`);
    }
    await sleep(500);
  }
}

const shot = (name) => {
  mkdirSync(SHOTS, { recursive: true });
  dkShell('mkdir -p /data/shots');
  dkExec(['import', '-window', 'root', `/data/shots/${name}.png`]);
  return join(SHOTS, `${name}.png`);
};

// ── 夹具：1 台本地主机 + 一个 4 台、含 1 条冲突的导入文件 ─────────────────────

function writeFixtures() {
  mkdirSync(USERDATA, { recursive: true });
  mkdirSync(dirname(IMPORT_FILE), { recursive: true });
  const cfg = join(USERDATA, 'nebulashell-config.json');
  if (!existsSync(cfg)) {
    writeFileSync(cfg, JSON.stringify({
      hosts: [{
        id: 'h-local-1', name: 'cache-prod-02', host: '10.0.4.12', port: 22, username: 'root',
        authType: 'password', password: 'demo', group: '生产', tags: [], jumpIds: [],
        createdAt: 1700000000000, updatedAt: 1700000000000,
      }],
      settings: { terminal: { theme: 'nebula' } },
    }, null, 1));
  }
  const hosts = [
    { name: 'cache-prod-02', host: '10.0.4.12', port: 22, username: 'root', group: '数据库', authType: 'password' },
    { name: 'cache-prod-01', host: '10.0.4.11', port: 22, username: 'root', group: '生产', authType: 'password' },
    { name: 'db-replica-3', host: '10.0.9.7', port: 22, username: 'admin', group: '数据库', authType: 'key', keyPath: '/home/demo/.ssh/id_ed25519' },
    { name: 'jump-01', host: '10.0.1.2', port: 2222, username: 'ops', group: '跳板', authType: 'password' },
  ].map((h, i) => ({ ...h, id: `imp-${i + 1}`, tags: [], jumpIds: [] }));
  writeFileSync(IMPORT_FILE, JSON.stringify({ version: 4, hosts }, null, 1));
}

// ── 命令 ─────────────────────────────────────────────────────────────────────

function buildBinary() {
  console.log('[ui-check] cargo build（buildenv 容器，增量几秒）…');
  // nebula-cargo 只放 registry 缓存，挂到 /cargo 并把 CARGO_HOME 指过去；
  // 不能挂到 /usr/local/cargo —— 那会把镜像自带的 cargo 可执行文件整个遮掉
  mkdirSync(join(DATA, 'bin'), { recursive: true });   // 先由宿主建目录，避免容器留下的 root 属主挡住后续 mkdir
  dk(['run', '--rm', '-v', `${ROOT}:/w`, '-v', 'nebula-cargo:/cargo', '-v', 'nebula-target:/target',
    '-w', '/w/src-tauri', '-e', 'CARGO_HOME=/cargo', '-e', 'CARGO_NET_OFFLINE=true', '-e', 'CARGO_TARGET_DIR=/target', BUILD_IMAGE,
    // 注意用 bash -c 而不是 -lc：镜像的 /etc/profile 会把 PATH 重置掉，cargo 就不在 PATH 里了
    'bash', '-c', 'cargo build && cp /target/debug/nebulashell /w/.ui-check/bin/nebulashell.new && mv -f /w/.ui-check/bin/nebulashell.new /w/.ui-check/bin/nebulashell && chown -R 1000:1000 /w/.ui-check'],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  if (!existsSync(BIN)) throw new Error('编译后仍找不到二进制');
}

async function cmdUp(argv) {
  const build = argv.includes('--build');
  const fresh = argv.includes('--fresh');
  if (build || !existsSync(BIN)) { dk(['rm', '-f', CONTAINER], { allowFail: true }); buildBinary(); }
  if (fresh) rmSync(USERDATA, { recursive: true, force: true });
  writeFixtures();
  dk(['rm', '-f', CONTAINER], { allowFail: true });
  rmSync(PORT_FILE, { force: true });
  dk(['run', '-d', '--name', CONTAINER, '--net', 'host', '--user', '1000:1000',
    '-e', 'HOME=/tmp', '-e', 'NEBULA_TEST=1',
    '-e', `NEBULA_USER_DATA=/data/run/userdata`,
    '-e', 'NEBULA_TEST_BRIDGE_FILE=/data/run/bridge.port',
    '-e', 'NEBULA_TEST_IMPORT_PATH=/data/run/work/hosts-export.json',
    '-e', 'NEBULA_TEST_EXPORT_DIR=/data/run/work',
    '-e', 'NEBULA_TEST_PICK_DIR=/data/run/work',
    '-e', 'NEBULA_TEST_PICK_PATHS=/data/run/work/hosts-export.json',
    '-v', `${DATA}:/data`, RUN_IMAGE, 'bash', '-c', [
      `rm -f /tmp/.X${DISPLAY.replace(':', '')}-lock`,
      'mkdir -p /tmp/xdg && chmod 700 /tmp/xdg /data/run',
      `Xvfb ${DISPLAY} -screen 0 ${SCREEN} -ac +extension GLX +extension RANDR +render -noreset > /data/run/xvfb.log 2>&1 &`,
      'sleep 3',
      `export DISPLAY=${DISPLAY} GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 XDG_RUNTIME_DIR=/tmp/xdg`,
      'mkdir -p /data/shots',
      '/data/bin/nebulashell > /data/run/app.log 2>&1 &',
      'sleep 2',
      'tail -f /dev/null',
    ].join('\n')]);
  const port = await waitReady();
  console.log(`[ui-check] 就绪：http://127.0.0.1:${port}  (容器 ${CONTAINER}, 数据 ${DATA})`);
}

async function cmdTheme(argv) {
  const want = (argv[0] || '').toLowerCase();
  if (!['dark', 'light', 'nebula'].includes(want)) throw new Error('用法: theme <light|dark>（dark 与 nebula 等价）');
  const value = want === 'light' ? 'light' : 'nebula';
  // 走真实 UI：命令面板 → 设置 → 终端分区 → 主题 select → 保存
  const out = await evalJs(`
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'P', code:'KeyP', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}));
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('modal-palette')?.classList.add('hidden');
    window.__nbTest.openSettings();
    await new Promise(r => setTimeout(r, 700));
    const sel = document.getElementById('term-theme');
    sel.value = ${JSON.stringify(value)};
    sel.dispatchEvent(new Event('change', {bubbles:true}));
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('btn-term-save').click();
    await new Promise(r => setTimeout(r, 800));
    return {want: ${JSON.stringify(value)}, theme: document.documentElement.dataset.theme,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            settingsClosed: document.getElementById('modal-settings')?.classList.contains('hidden')};
  `, 20000);
  if (out.theme !== value) throw new Error(`主题没切过去: ${JSON.stringify(out)}`);
  console.log(`[ui-check] 主题=${out.theme} (${out.bodyBg})`);
}

// 场景：把应用驱动到一个可复现的状态，ab/截图才有意义（默认面只在导入预览里存在）
const SCENES = {
  // 主机库 → 导入主机 → 选择文件 → 校验预览（4 行、1 条冲突）
  'import-preview': `
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'P', code:'KeyP', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}));
    await new Promise(r => setTimeout(r, 350));
    const pin = document.getElementById('palette-input');
    pin.focus(); pin.value = '主机库'; pin.dispatchEvent(new Event('input', {bubbles:true}));
    await new Promise(r => setTimeout(r, 350));
    pin.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}));
    await new Promise(r => setTimeout(r, 800));
    document.getElementById('hl-import').click();
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('io-import-pick').click();
    for (let i = 0; i < 80; i++) {
      if (document.querySelector('#io-steps li[aria-current=step]')?.dataset.step === '2') break;
      await new Promise(r => setTimeout(r, 120));
    }
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await new Promise(r => setTimeout(r, 300));
    return {step: document.querySelector('#io-steps li[aria-current=step]')?.dataset.step,
            rows: document.querySelectorAll('.io-import .io-item').length};
  `,
  // 新建主机 → 分段控件选 RDP → 滚到底（显示与体验整块可见）
  'rdp-advanced': `
    document.getElementById('btn-add-host').click();
    await new Promise(r => setTimeout(r, 700));
    document.querySelector('#host-protocol-slider .segmented-item[data-value=rdp]').click();
    await new Promise(r => setTimeout(r, 500));
    const card = document.querySelector('#modal-host .modal-card');
    card.scrollTop = card.scrollHeight;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await new Promise(r => setTimeout(r, 400));
    return {protocol: document.getElementById('host-protocol').value,
            port: document.getElementById('host-port').value,
            checks: document.querySelectorAll('.rdp-chk').length};
  `,
  // 新建主机 → 协议选 RDP → 停在顶部（分段控件、字段、端口都在视口内）
  'rdp-top': `
    document.getElementById('btn-add-host').click();
    await new Promise(r => setTimeout(r, 700));
    document.querySelector('#host-protocol-slider .segmented-item[data-value=rdp]').click();
    await new Promise(r => setTimeout(r, 500));
    const top = document.querySelector('#modal-host .modal-card');
    top.scrollTop = 0;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await new Promise(r => setTimeout(r, 400));
    return {protocol: document.getElementById('host-protocol').value,
            port: document.getElementById('host-port').value,
            sliderRadius: getComputedStyle(document.getElementById('host-protocol-slider')).borderRadius,
            thumbRadius: getComputedStyle(document.querySelector('#host-protocol-slider .segmented-thumb')).borderRadius};
  `,
  // 主机库（含分组栏、搜索框、行勾选）
  'host-library': `
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'P', code:'KeyP', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}));
    await new Promise(r => setTimeout(r, 350));
    const pin = document.getElementById('palette-input');
    pin.focus(); pin.value = '主机库'; pin.dispatchEvent(new Event('input', {bubbles:true}));
    await new Promise(r => setTimeout(r, 350));
    pin.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}));
    await new Promise(r => setTimeout(r, 800));
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await new Promise(r => setTimeout(r, 250));
    return {summary: document.getElementById('hl-summary')?.textContent.trim()};
  `,
  // 设置（标签页 + 表单控件）
  'settings': `
    window.__nbTest.openSettings();
    await new Promise(r => setTimeout(r, 800));
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await new Promise(r => setTimeout(r, 250));
    return {theme: document.getElementById('term-theme')?.value,
            open: !document.getElementById('modal-settings').classList.contains('hidden')};
  `,
  // AI 侧栏抽屉:验收阴影(--floating-shadow)、上下文条、能力徽章这些只在 AI 面板出现的 token 站点
  'ai-panel': `
    // 抽屉是 toggle:先看状态再点,否则 ab 连跑两次会把它关回去
    if (document.getElementById('ai-drawer').classList.contains('hidden')) {
      document.getElementById('ai-drawer-toggle').click();
    }
    await new Promise(r => setTimeout(r, 900));
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await new Promise(r => setTimeout(r, 300));
    const drawer = document.getElementById('ai-drawer');
    return {open: drawer ? !drawer.classList.contains('hidden') : false,
            w: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
            bars: document.querySelectorAll('.ai-ctx-bar-seg').length};
  `,
  // 造一个「确认卡里的主机名 chip」:真实类名 + 真实样式,但不触发真实命令执行。
  // 用来验收 B2 里 .ai-confirm-host-tag 从 transparent → var(--hover-bg) 这一处可见变化。
  'host-tag-probe': `
    const old = document.getElementById('__probe-tag'); if (old) old.remove();
    const box = document.createElement('div');
    box.id = '__probe-tag';
    box.style.cssText = 'position:fixed;left:40px;top:60px;z-index:99999;padding:10px 12px;display:flex;gap:8px;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius)';
    box.innerHTML = '<span style="font-size:12px;color:var(--muted)">导入到</span><span class="ai-confirm-host-tag">prod-web-01</span>';
    document.body.appendChild(box);
    const tag = box.querySelector('.ai-confirm-host-tag');
    const cs = getComputedStyle(tag);
    return {bg: cs.backgroundColor, color: cs.color, rect: JSON.stringify(tag.getBoundingClientRect())};
  `,
  // 亮色差异层的定点探针(B4):把「只在亮色下改过值」的那批组件塞进真实 DOM,
  // 用它们的计算样式对照旧 CSS —— 元素不在真实页面里出现也能逐项验等价。
  'light-probe': `
    const old = document.getElementById('__probe-light'); if (old) old.remove();
    const box = document.createElement('div');
    box.id = '__probe-light';
    box.style.cssText = 'position:fixed;left:30px;top:50px;z-index:99999;width:300px;padding:10px;display:flex;flex-direction:column;gap:6px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius)';
    box.innerHTML = [
      '<div class="mon-deck" id="p-deck">cpu 12%</div>',
      '<div class="mon-lat-item"><span class="mon-item" id="p-lat">ssh 18ms</span></div>',
      '<div style="display:flex;gap:8px;align-items:center"><i class="mon-dir mon-up" id="p-up">↑</i><i class="mon-dir mon-down" id="p-down">↓</i>',
      '<div class="mon-pop-dot" id="p-cpudot"></div><div class="mon-mem-dot" id="p-memdot"></div><div class="mon-net-dot" id="p-netdot"></div>',
      '<span class="mon-mem-cur" id="p-memcur">内存</span></div>',
      '<div class="ai-ctx-pop-bar-wrap" id="p-barwrap" style="height:6px"><div style="width:40%;height:100%"></div></div>',
      // 真实结构:触发钮挂在 .mon-ring 包裹里(监控环与上下文环共用 .mon-ring-bg,
      // 两条规则同特异性靠位置决胜)—— 探针必须复刻这层包裹才不会漏判
      '<div class="mon-ring"><button class="ai-context-trigger" id="p-ctxbtn"><svg class="ai-context-ring" viewBox="0 0 20 20"><circle class="mon-ring-bg" id="p-ring" cx="10" cy="10" r="7.5"></circle></svg></button></div>',
      '<div class="ai-reasoning-slider" style="--thumb-s:22px"><div class="ai-reasoning-thumb" id="p-thumb" style="--i:1;--n:3"></div></div>',
      '<svg width="120" height="30"><line class="mon-pop-grid" id="p-grid" x1="0" y1="15" x2="120" y2="15"></line>',
      '<line id="mon-mem-pop-line" x1="0" y1="15" x2="60" y2="8"></line><circle id="mon-mem-pop-point" cx="60" cy="8" r="2"></circle>',
      '<circle id="mon-pop-point" cx="20" cy="6" r="2"></circle></svg>',
    ].join('');
    document.body.appendChild(box);
    await new Promise(r => setTimeout(r, 150));
    const g = (id, p) => getComputedStyle(document.getElementById(id))[p];
    return {memDot: g('p-memdot','backgroundColor') + ' / ' + g('p-memdot','boxShadow'),
            memCur: g('p-memcur','color'), netUp: g('p-up','color'), deckShadow: g('p-deck','boxShadow')};
  `,
  // 干净态：只关弹窗
  'hosts': `
    await new Promise(r => setTimeout(r, 300));
    return 'hosts';
  `,
  // 侧栏多主机 + 1 台激活态探针（非破坏性：只克隆临时 DOM 行，切走场景自动清理）
  'hosts-active': `
    const list = document.getElementById('host-list');
    if (!list) return { ok: false, reason: 'no-host-list' };
    list.querySelectorAll('[data-probe-host]').forEach(e => e.remove());
    const orig = list.querySelector('.host-item');
    if (!orig) return { ok: false, reason: 'no-host-item' };
    const mk = (name, ip, active, dotCls) => {
      const d = orig.cloneNode(true);
      d.dataset.probeHost = '1';
      d.className = 'host-item' + (active ? ' active' : '');
      const t = d.querySelector('.host-name .t'); if (t) t.textContent = name;
      const ipEl = d.querySelector('.host-sub .ip'); if (ipEl) ipEl.textContent = ip;
      const dot = d.querySelector('.host-dot'); if (dot) dot.className = 'host-dot' + (dotCls ? ' ' + dotCls : '');
      return d;
    };
    const act = mk('api-prod-01', '10.0.4.11', true, 'connected');
    const sib = mk('db-prod-01', '10.0.4.15', false, '');
    list.insertBefore(act, orig);
    list.appendChild(sib);
    await new Promise(r => setTimeout(r, 200));
    const rAct = act.querySelector('.host-name .t').getBoundingClientRect();
    const rNorm = orig.querySelector('.host-name .t').getBoundingClientRect();
    return {
      rows: list.querySelectorAll('.host-item').length,
      dx: +(rAct.left - rNorm.left).toFixed(2),
      actH: Math.round(act.getBoundingClientRect().height),
      normH: Math.round(orig.getBoundingClientRect().height),
      actBg: getComputedStyle(act).backgroundColor,
      actFw: getComputedStyle(act.querySelector('.host-name')).fontWeight,
      normFw: getComputedStyle(orig.querySelector('.host-name')).fontWeight,
    };
  `,
};

// 关掉所有打开的弹窗：走它们自己的关闭按钮（不是 classList hack）——
// 直接删 hidden 类会把应用的 activeModals 记账搞乱，后续 openModal 不生效。
const CLEAR_MODALS = `
  const open = [...document.querySelectorAll('.modal:not(.hidden)')];
  for (const m of open) {
    const btn = m.querySelector('#io-import-close, #io-import-cancel, #io-export-close, [id$="-close"], [id$="-cancel"], button[aria-label*="关闭"]');
    if (btn) btn.click(); else m.click();
    await new Promise(r => setTimeout(r, 200));
  }
  await new Promise(r => setTimeout(r, 200));
  return [...document.querySelectorAll('.modal:not(.hidden)')].map(m => m.id);
`;

async function applyScene(name) {
  await evalJs("document.getElementById('__probe-tag')?.remove(); document.getElementById('__probe-light')?.remove(); document.querySelectorAll('[data-probe-host]').forEach(e => e.remove()); return 1;", 10000);
  const left = await evalJs(CLEAR_MODALS, 20000);
  if (left.length) console.log(`[ui-check] 警告：这些弹窗没关掉 ${left.join(', ')}`);
  const js = SCENES[name];
  if (!js) throw new Error(`未知场景 ${name}，可选: ${Object.keys(SCENES).join(' / ')}`);
  const out = await evalJs(js, 40000);
  await sleep(250);
  console.log(`[ui-check] 场景 ${name} → ${JSON.stringify(out)}`);
  return out;
}

function measureJs(selectors) {
  return `
    const sels = ${JSON.stringify(selectors)};
    const props = ${JSON.stringify(PROPS)};
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = 'ABSENT'; continue; }
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of props) o[p] = cs[p];
      out[s] = o;
    }
    return out;`;
}

function diffStyles(a, b) {
  const out = {};
  for (const sel of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[sel], y = b[sel];
    if (x === y) continue;
    if (x === 'ABSENT' || y === 'ABSENT') { out[sel] = {[x === 'ABSENT' ? 'old' : 'new']: 'ABSENT'}; continue; }
    const d = {};
    for (const p of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[p] !== y[p]) d[p] = [x[p], y[p]];
    }
    if (Object.keys(d).length) out[sel] = d;
  }
  return out;
}

async function cmdAb(argv) {
  const name = argv[0];
  if (!name) throw new Error('用法: ab <名字> [--ref v0.7.6] [--selectors a,b,c]');
  const refIdx = argv.indexOf('--ref');
  const ref = refIdx >= 0 ? argv[refIdx + 1] : BASELINE_REF;
  const cssIdx = argv.indexOf('--css');           // 直接指定基线文件（比 ref 更自由：可拿来比两个设计变体）
  const sceneIdx = argv.indexOf('--scene');
  const scene = sceneIdx >= 0 ? argv[sceneIdx + 1] : null;
  const selIdx = argv.indexOf('--selectors');
  const selectors = selIdx >= 0 ? argv[selIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_SELECTORS;

  if (scene) await applyScene(scene);
  const baselineCss = cssIdx >= 0 ? readFileSync(argv[cssIdx + 1], 'utf8') : git(['show', `${ref}:src/style.css`]);
  await evalJs('document.activeElement && document.activeElement.blur && document.activeElement.blur(); return 1;');
  await sleep(300);

  const newStyles = await evalJs(measureJs(selectors), 40000);
  const newShot = shot(`ab-${name}-new`);

  await evalJs(`
    return (() => {
      document.getElementById('ui-check-baseline')?.remove();
      const st = document.createElement('style');
      st.id = 'ui-check-baseline';
      st.textContent = ${JSON.stringify(baselineCss)};
      document.head.appendChild(st);
      return st.sheet.cssRules.length;
    })();`, 60000);
  await sleep(400);
  const oldStyles = await evalJs(measureJs(selectors), 40000);
  const oldShot = shot(`ab-${name}-old`);
  await evalJs("document.getElementById('ui-check-baseline')?.remove(); return 1;");
  await sleep(400);
  const newShot2 = shot(`ab-${name}-new2`);

  // 像素比对全部在容器里用 ImageMagick 做：diff 掩码、噪声掩码、净差异
  // 「净差异」= 旧/新之差 减去 同一状态连拍两帧的时间噪声（光标闪烁、动画）
  const im = (...args) => dkExec(['convert', ...args]);
  const diffPng = '/data/shots/.diff.png', noisePng = '/data/shots/.noise.png', netPng = '/data/shots/.net.png';
  im(cpath(oldShot), cpath(newShot), '-compose', 'difference', '-composite', '-threshold', '0', diffPng);
  im(cpath(newShot), cpath(newShot2), '-compose', 'difference', '-composite', '-threshold', '0', noisePng);
  im(diffPng, '(', noisePng, '-negate', ')', '-compose', 'multiply', '-composite', '-threshold', '0', netPng);
  const count = (f) => Number(dkExec(['convert', f, '-format', '%[fx:int(mean*w*h)]', 'info:']).trim());
  const pixels = { changed: count(diffPng), noise: count(noisePng), net: count(netPng) };
  const bbox = pixels.net ? dkExec(['convert', netPng, '-format', '%@', 'info:']).trim() : null;

  const styleDiffs = diffStyles(oldStyles, newStyles);
  console.log(JSON.stringify({
    baseline: cssIdx >= 0 ? argv[cssIdx + 1] : `${ref}:src/style.css`,
    selectors: selectors.length,
    styles: Object.keys(styleDiffs).length ? styleDiffs : '无差异',
    pixels, netBBox: bbox,
    shots: { old: oldShot, new: newShot },
  }, null, 2));
  if (pixels.net || Object.keys(styleDiffs).length) process.exitCode = 2; // 有净差异 → 让 CI/脚本能判失败
}

function usage() {
  console.log(`真实窗口定点验证（每批样式改动跑一次）

  node scripts/ui-check.mjs up [--build] [--fresh]   起真实窗口（--build 顺带编译，--fresh 重置夹具）
  node scripts/ui-check.mjs down | status
  node scripts/ui-check.mjs eval '<js>'              在页面里执行（多语句需显式 return）
  node scripts/ui-check.mjs styles [a,b,c]           取计算样式（默认面见 DEFAULT_SELECTORS）
  node scripts/ui-check.mjs resize <W>x<H>          真实改窗口尺寸（验收 @media 断点）
  node scripts/ui-check.mjs inject <css>|-c         运行时注入/清除候选 token 覆盖（换皮对比）
  node scripts/ui-check.mjs shot <名字>               截图 → ${SHOTS}/<名字>.png
  node scripts/ui-check.mjs theme dark|light          走真实 UI 切主题并保存
  node scripts/ui-check.mjs scene hosts|hosts-active|import-preview|rdp-top|rdp-advanced|host-library|settings|host-tag-probe|ai-panel|light-probe   驱动到可复现场景
  node scripts/ui-check.mjs ab <名字> [--ref R | --css 文件] [--scene S]
                                                    旧 CSS(默认 ${BASELINE_REF}) vs 现状：样式+像素（净差异非 0 时退出码 2）

环境变量：NEBULA_UI_DATA / NEBULA_UI_CONTAINER / NEBULA_UI_DISPLAY / NEBULA_UI_SCREEN
          NEBULA_UI_BUILD_IMAGE / NEBULA_UI_RUN_IMAGE / NEBULA_UI_BASELINE_REF`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const [cmd = 'help', ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'up': await cmdUp(rest); break;
    case 'down': dk(['rm', '-f', CONTAINER], { allowFail: true }); console.log('[ui-check] 已停止'); break;
    case 'status': console.log(dkAlive() ? `running (port ${readPort()})` : 'not running'); break;
    case 'eval': {
      const js = rest[0] === '-' ? readFileSync(0, 'utf8') : rest.join(' ');
      console.log(JSON.stringify(await evalJs(js), null, 2));
      break;
    }
    case 'styles': {
      const sels = rest[0] ? rest[0].split(',').map((s) => s.trim()) : DEFAULT_SELECTORS;
      console.log(JSON.stringify(await evalJs(measureJs(sels), 40000), null, 2));
      break;
    }
    case 'shot': console.log(shot(rest[0] || `shot-${Date.now()}`)); break;
    case 'scene': await applyScene(rest[0] || 'hosts'); break;
    case 'theme': await cmdTheme(rest); break;
    case 'inject': {
      // inject <css 文件> | inject -c(清除) —— 运行时注入候选 token 覆盖(换皮对比用),
      // 不重编译二进制:注入的 <style> 排在 app.css 之后,token 层直接生效。
      const arg = String(rest[0] || '');
      if (arg === '-c' || arg === '--clear') {
        await evalJs("document.getElementById('ui-check-inject')?.remove(); return 1;");
        console.log('[ui-check] 已移除注入样式');
        break;
      }
      if (!arg) throw new Error('用法: inject <css 文件> | inject -c');
      const css = readFileSync(arg, 'utf8');
      const n = await evalJs(`
        document.getElementById('ui-check-inject')?.remove();
        const st = document.createElement('style');
        st.id = 'ui-check-inject';
        st.textContent = ${JSON.stringify(css)};
        document.head.appendChild(st);
        return st.sheet ? st.sheet.cssRules.length : -1;
      `, 20000);
      await sleep(400);
      const probe = await evalJs("const cs=getComputedStyle(document.documentElement); return {bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim(), theme: document.documentElement.dataset.theme};");
      console.log(JSON.stringify({ file: arg, rules: n, resolved: probe }, null, 2));
      break;
    }
    case 'resize': {
      // resize <WxH> —— 真实改窗口尺寸，用来验收 @media 断点(max-width:480px 这类)
      const spec = String(rest[0] || '');
      if (!/^\d+x\d+$/.test(spec)) throw new Error('用法: resize <宽>x<高>，如 460x700');
      const [w, h] = spec.split('x').map(Number);
      const r = await fetch(`http://127.0.0.1:${readPort()}/resize?w=${w}&h=${h}`);
      if (!r.ok) throw new Error(`/resize ${r.status} —— 应用里的测试桥还是旧版，需 up --build`);
      await sleep(700);
      const v = await evalJs('return {w: innerWidth, h: innerHeight, overflowX: document.documentElement.scrollWidth - innerWidth};');
      console.log(JSON.stringify({ requested: spec, got: v }, null, 2));
      break;
    }
    case 'ab': await cmdAb(rest); break;
    case 'fixtures': writeFixtures(); console.log(`[ui-check] 夹具已写入 ${USERDATA} / ${IMPORT_FILE}`); break;
    default: usage();
  }
} catch (e) {
  console.error(`[ui-check] ${e.message}`);
  process.exit(1);
}
