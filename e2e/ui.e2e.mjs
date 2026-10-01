// NebulaShell UI 端到端测试(驱动 Tauri 应用的真实 webview)
//
// 机制:以 NEBULA_TEST=1 启动应用,它会开一个本地 HTTP 测试桥(src-tauri/src/bridge.rs)。
// POST /eval 注入 JS 到 webview,结果经 Tauri invoke 回传;GET /result/{id} 取回。
//
// 前置:先构建 Rust 二进制(npm run build:web && cd src-tauri && cargo build)
// 用法:node e2e/ui.e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSshd } from './helpers/ssh-server.mjs';
import { startMockCloudServer, startMockAiServer } from './helpers/mock-servers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 的 cargo 产物带 .exe 后缀,按平台补齐。
// 可用 NEBULA_E2E_BIN 指定被测二进制(例如直接回归已安装版本:
//   NEBULA_E2E_BIN="C:\Users\user\AppData\Local\NebulaShell\nebulashell.exe" node e2e/ui.e2e.mjs
// ),用户数据仍走本套件自建的临时目录,不触碰真实配置。
const BIN = process.env.NEBULA_E2E_BIN
  || path.join(root, 'src-tauri/target/debug/nebulashell' + (process.platform === 'win32' ? '.exe' : ''));
const PASSWORD = 'ui-e2e-pass';
// 版本号从配置读,避免每发一版都要改测试(T2 断言用)
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
).version;

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let proc = null;
let sshd = null;
let sshd2 = null;
let cloud = null;
let ai = null;
let bridge = 0;
let work = null;
let userData = null;
const appLogs = [];
const results = [];
let seq = 0;

const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? PASS : FAIL} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: bridge, path: p, method, timeout: timeoutMs, headers: { Connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('http timeout')));
    if (body) r.write(body);
    r.end();
  });
}

const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function evalJs(js, timeout = 15000) {
  const id = `e${++seq}`;
  await req('POST', '/eval', JSON.stringify({ id, js }));
  const t0 = Date.now();
  for (;;) {
    const r = await req('GET', `/result/${id}`).catch(() => null);
    if (r && r.status === 200) {
      const v = JSON.parse(r.body).value;
      if (typeof v === 'string' && v.startsWith('ERR:')) throw new Error(v.slice(5));
      return v;
    }
    if (Date.now() - t0 > timeout) throw new Error('eval 超时: ' + js.slice(0, 70));
    await sleep(120);
  }
}

async function waitEval(js, needle, timeout = 20000) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    try { last = String(await evalJs(js, 6000)); } catch { /* 重试 */ }
    if (last.includes(needle)) return last;
    if (Date.now() - t0 > timeout) throw new Error(`等待「${needle}」超时,当前: ${last.slice(0, 180)}`);
    await sleep(250);
  }
}

/// 回答应用内输入框(askPrompt),并把"输入是否真被接受"变成被检验的事实。
/// 为什么不能"填一次就假定成功":askPrompt 建弹窗时会 `input.value = ''`,
/// 若填值落在弹窗重建的那一瞬,值会被清空 —— 校验(如"两次口令不一致")随即
/// 静默拒绝、弹窗停留不放,后续整条流程卡死(表现为超时,且当前标题仍是
/// 上一个弹窗的,例如"等 输入解密口令 却看到 确认口令")。
/// 判据用**标题**而非"弹窗是否可见":确认口令框会在上一个答完后立刻接棒,
/// 用可见性判断会把"换成了下一个框"误判成"这一个没答上"。
async function answerPrompt(value, expectTitle, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await waitEval(`window.__nbTest.promptOpen()`, 'true', 10000);
    await waitEval(`window.__nbTest.promptTitle()`, expectTitle, 10000);
    await evalJs(`window.__nbTest.promptFill(${JSON.stringify(value)}); window.__nbTest.promptClickOk(); return 1`);
    // 等它确实离开:标题变了(接棒下一个)或整框收起(流程结束)都算成功
    const t0 = Date.now();
    for (;;) {
      const st = asObj(await evalJs(`return JSON.stringify({ open: window.__nbTest.promptOpen(), title: window.__nbTest.promptTitle() })`));
      if (!st.open || st.title !== expectTitle) return;
      if (Date.now() - t0 > 2000) break; // 仍在原框上:再试一次
      await sleep(150);
    }
  }
  throw new Error(`输入框「${expectTitle}」未被接受(值可能被弹窗重建清空)`);
}

async function cleanup() {
  try { if (proc) proc.kill(); } catch { /* ignore */ }
  try { if (sshd) await sshd.close(); } catch { /* ignore */ }
  try { if (sshd2) await sshd2.close(); } catch { /* ignore */ }
  try { if (cloud) await cloud.close(); } catch { /* ignore */ }
  try { if (ai) await ai.close(); } catch { /* ignore */ }
  try { if (work) fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}

const watchdog = setTimeout(() => {
  console.error(`${FAIL} UI e2e 总体超时(240s)`);
  console.error(appLogs.join('').slice(-1500));
  cleanup().finally(() => process.exit(1));
}, 240000);

async function main() {
  if (!fs.existsSync(BIN)) throw new Error(`未找到应用二进制: ${BIN}\n请先执行: npm run build:web && cd src-tauri && cargo build`);

  sshd = await startMockSshd({ password: PASSWORD });
  // 第二台 mock sshd:主机密钥与 sshd 不同,用于制造"服务器指纹变更"(T32)。
  sshd2 = await startMockSshd({ password: PASSWORD });
  cloud = await startMockCloudServer();
  ai = await startMockAiServer();
  console.log(`mock 服务就绪 sshd=:${sshd.port} cloud=:${cloud.port} ai=:${ai.port}`);

  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ui-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ui-data-'));
  // 预置 legacy 格式(64 位 hex)的 knownHosts 记录:模拟 Electron 时代迁移过来的数据。
  // 回归:旧记录与现行 base64 指纹编码不同,曾被误判成"服务器密钥变更"而拒连
  // (表现为 "Unknown server key")。T5 的连接必须照常成功,且记录被自愈升级。
  const tofuKey = `127.0.0.1:${sshd.port}`;
  // 另为第二台服务预置一份"错误"指纹(用第一台的指纹冒充):连接 sshd2 时,
  // 记录里的指纹与它实际出示的不符 —— 这就是"服务器更换了主机密钥"的真实形态,
  // 用于验证 T32 的指纹变更弹窗与一键重置信任。
  const fpKey2 = `127.0.0.1:${sshd2.port}`;
  fs.writeFileSync(
    path.join(userData, 'nebulashell-config.json'),
    JSON.stringify({
      knownHosts: { [tofuKey]: sshd.hostFingerprintHex, [fpKey2]: sshd.hostFingerprintB64 },
      hosts: [],
      settings: {},
    }),
  );
  const portFile = path.join(work, 'bridge.port');
  const uploadSrc = path.join(work, 'upload.txt');
  const uploadPayload = 'ui-e2e-upload-' + 'Z'.repeat(1024);
  fs.writeFileSync(uploadSrc, uploadPayload);

  proc = spawn(BIN, [], {
    env: {
      ...process.env,
      NEBULA_TEST: '1',
      NEBULA_USER_DATA: userData,
      NEBULA_TEST_BRIDGE_FILE: portFile,
      NEBULA_TEST_PICK_PATHS: uploadSrc,
      NEBULA_TEST_SAVE_PATH: path.join(work, 'hosts-export.json'),
      NEBULA_TEST_IMPORT_PATH: path.join(work, 'hosts-export.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => appLogs.push(String(d)));
  proc.stderr.on('data', (d) => appLogs.push(String(d)));

  // 等测试桥
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(portFile)) {
      bridge = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (bridge > 0) break;
    }
    if (Date.now() - t0 > 40000) throw new Error('测试桥启动超时');
    await sleep(300);
  }
  console.log(`测试桥 :${bridge}`);

  // 等 webview 就绪
  await waitEval(`return document.readyState`, 'complete', 40000);
  await evalJs(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); 0`);
  check('T1 应用启动 / webview 就绪', true);

  await evalJs(`return document.querySelector('#welcome') ? 1 : 0`);
  // 版本号不再显示在侧边栏左下角,而是收进「关于」弹窗(功能菜单 → 关于)。
  // 断言改为:点开「关于」能看到版本与平台,且侧边栏底部已无版本号。
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await evalJs(`document.querySelector('#btn-about').click(); return 1`);
  await waitEval(`window.__nbTest.about().open`, 'true', 10000);
  const about = asObj(await evalJs(`return JSON.stringify(window.__nbTest.about())`));
  check('T2 欢迎页 + 关于弹窗显示版本号', about.version === `v${APP_VERSION}` && !!about.platform, JSON.stringify(about));
  await evalJs(`document.querySelector('#btn-about-close').click(); return 1`);
  const footer = asObj(await evalJs(`return JSON.stringify(window.__nbTest.footer())`));
  check(
    'T2b 侧边栏底部已移除版本号',
    footer.hasVersion === false && !String(footer.text).includes('v' + APP_VERSION),
    JSON.stringify(footer),
  );

  // 新建主机(密码)
  await evalJs(`
    document.querySelector('#btn-add-host').click();
    document.querySelector('#host-name').value = 'ui-a';
    document.querySelector('#host-host').value = '127.0.0.1';
    document.querySelector('#host-port').value = '${sshd.port}';
    document.querySelector('#host-username').value = 'root';
    document.querySelector('#host-password').value = '${PASSWORD}';
    document.querySelector('#btn-host-save').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent`, 'ui-a');
  check('T3 新建主机', true);

  // 凭据持久化(回归:密码保存后 hasPassword 必须为真)
  const cred = await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('hosts:list');
      const h = r.data.find((x) => x.host === '127.0.0.1');
      return JSON.stringify({ hasPassword: h.hasPassword, marked: !document.querySelector('.host-chip') });
    })()`);
  const credObj = asObj(cred);
  check('T4 密码保存生效(hasPassword=true,界面无"待补全凭据")', credObj.hasPassword === true && credObj.marked === true, cred);

  // 连接
  await evalJs(`document.querySelector('.host-item').click(); return 1`);
  await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 30000);
  // 用 textContent 而非 innerText:后者依赖 CSS 布局与可见性计算,
  // xterm 尚未完成首帧渲染时会返回空串,造成偶发超时(约 1/12);
  // textContent 直接读 DOM 文本,更贴合"输出是否已到达终端"的语义。
  // 终端输出走 __NB_TERM_TEXT__ 钩子(buffer API,渲染无关):
  // WebGL 渲染器下文本画在 canvas 上,.xterm-rows 的 DOM 文本恒为空;
  // 且 buffer 不依赖首帧绘制,顺带消除了旧 DOM 断言的偶发首帧超时。
  await waitEval(`return window.__NB_TERM_TEXT__ ? window.__NB_TERM_TEXT__() : (document.querySelector('.term-pane.focused .xterm-rows')||{}).textContent||''`, 'Welcome to NebulaShell mock sshd', 25000);
  check('T5 SSH 连接 + 终端输出', true);

  // legacy hex 指纹被兼容(连接已成功)后,记录必须被自愈升级为现行 base64 格式
  await sleep(500);
  const upgradedFp = JSON.parse(fs.readFileSync(path.join(userData, 'nebulashell-config.json'), 'utf8')).knownHosts[tofuKey];
  check(
    'T5b legacy hex 指纹放行并自愈升级为 base64',
    upgradedFp === sshd.hostFingerprintB64,
    `got=${String(upgradedFp).slice(0, 20)}… want=${sshd.hostFingerprintB64.slice(0, 20)}…`,
  );

  // WebGL 渲染器激活:canvas 由 addon 创建,GL 上下文创建失败会抛错走 DOM 回退,
  // 此时 canvas 不存在 —— 该断言防止渲染器被静默降级而不自知。
  const glCanvas = await evalJs(`return String(!!document.querySelector('.term-pane.focused canvas'))`);
  check('T5c WebGL 渲染器激活(canvas 已挂载)', glCanvas === 'true', glCanvas);

  // 分屏
  // 分屏:同一标签内并排两个终端(标签数不变,窗格数 +1)
  // ⛶ 按钮现在弹出方向选择(与 title 声明一致),走真实路径选"左右分屏"。
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await sleep(200);
  await evalJs(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.textContent.includes('左右分屏')).click(); return 1`);
  await evalJs(`(document.querySelector('.pane-picker .pp-item')||{click(){}}).click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, '2', 30000);
  const splitState = await evalJs(`return JSON.stringify({ tabs: document.querySelectorAll('.tab').length, panes: document.querySelectorAll('.term-pane').length })`);
  check('T6 分屏双会话(同一标签内并排)', asObj(splitState).panes === 2, splitState);

  // 删除确认对话框(回归:confirm 在 WKWebView 失效 → 已换应用内实现)
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    it.querySelector('.hi-clone').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent`, '副本', 10000);
  const confirmShown = await evalJs(`
    return (() => {
      const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('副本'));
      it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      it.querySelector('.hi-del').click();
      return !document.querySelector('#modal-confirm').classList.contains('hidden');
    })()`);
  check('T7 删除弹出应用内确认框(替代失效的 confirm)', confirmShown === true);

  await evalJs(`document.querySelector('#btn-confirm-ok').click(); return 1`);
  await sleep(800);
  const afterDel = await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('hosts:list');
      return JSON.stringify({ hosts: r.data.length, confirmClosed: document.querySelector('#modal-confirm').classList.contains('hidden') });
    })()`);
  const delObj = asObj(afterDel);
  check('T8 确认后主机被删除 + 弹窗关闭', delObj.hosts === 1 && delObj.confirmClosed === true, afterDel);

  // AI:配置 + 拉取模型 + 对话
  await evalJs(`document.querySelector('#btn-ai-toggle').click(); return 1`);
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-provider').value = 'custom';
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-fetch-models').click(); return 1`);
  await waitEval(`return document.querySelector('#toasts').textContent`, '获取到 3 个模型', 15000);

  // 拉取结果改为弹框多选:每个模型展示"名称 + 属性(归属方/日期)",勾中的才可用
  await waitEval(`return JSON.stringify({ open: window.__nbTest.modelPickerOpen(), ids: window.__nbTest.modelPickerIds() })`, 'mock-model-1', 15000);
  const picker = asObj(await evalJs(`return JSON.stringify({
    open: window.__nbTest.modelPickerOpen(),
    ids: window.__nbTest.modelPickerIds(),
    items: window.__nbTest.modelPickerItems(),
  })`));
  const itemText = picker.items.join(' | ');
  check('T9f 拉取模型弹出多选框，候选含名称与属性',
    picker.open === true && picker.ids.length === 3
    && itemText.includes('mock-model-1') && itemText.includes('mock-provider') && itemText.includes('2026-01-02'),
    JSON.stringify(picker));

  // 只有勾中的模型才可用:全新配置下弹框默认零勾选
  const initial = asObj(await evalJs(`return JSON.stringify({
    checked: window.__nbTest.modelPickerChecked(),
    chips: window.__nbTest.modelChips(),
  })`));
  check('T9g 未勾选的模型不可用(初始零勾选，模型栏为空)',
    initial.checked.length === 0 && initial.chips.length === 0, JSON.stringify(initial));

  // 勾选两个 + 键盘操作:空格切换勾选、↓ 移动焦点
  await evalJs(`window.__nbTest.modelPickerToggle('mock-model-1'); return 1`);
  await evalJs(`window.__nbTest.modelPickerKey('ArrowDown'); return 1`);
  await evalJs(`window.__nbTest.modelPickerKey(' '); return 1`);
  const twoChecked = asObj(await evalJs(`return JSON.stringify({
    checked: window.__nbTest.modelPickerChecked(),
    count: window.__nbTest.modelPickerCount(),
  })`));
  check('T9h 多选:点击与空格都能勾选，计数同步',
    twoChecked.checked.length === 2
    && twoChecked.checked.includes('mock-model-1') && twoChecked.checked.includes('mock-model-2')
    && twoChecked.count.includes('2'), JSON.stringify(twoChecked));

  // 搜索过滤仍可用,且计数反映"命中/总数"
  await evalJs(`window.__nbTest.modelPickerFilter('model-3'); return 1`);
  const filtered = asObj(await evalJs(`return JSON.stringify({ ids: window.__nbTest.modelPickerIds(), count: window.__nbTest.modelPickerCount() })`));
  check('T9i 模型弹框搜索过滤(已勾选不受过滤影响)',
    filtered.ids.length === 1 && filtered.ids[0] === 'mock-model-3' && filtered.count.includes('2'), JSON.stringify(filtered));
  await evalJs(`window.__nbTest.modelPickerFilter(''); return 1`);

  // Esc 只关最上层:模型弹框关闭后,AI 设置必须还开着(否则用户的编辑内容凭空消失)
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1`);
  await sleep(200);
  const escState = asObj(await evalJs(`return JSON.stringify({ picker: window.__nbTest.modelPickerOpen(), settings: window.__nbTest.aiSettingsOpen() })`));
  check('T9j Esc 只关最上层的模型弹框,AI 设置仍打开', escState.picker === false && escState.settings === true, JSON.stringify(escState));

  // 重新勾选并确定:勾中的模型必须出现在"模型"一栏(chip)并成为生效模型
  await evalJs(`document.querySelector('#btn-ai-fetch-models').click(); return 1`);
  await sleep(400);
  await evalJs(`window.__nbTest.modelPickerSelectNone(); return 1`);
  await evalJs(`window.__nbTest.modelPickerToggle('mock-model-2'); return 1`);
  await evalJs(`window.__nbTest.modelPickerToggle('mock-model-3'); return 1`);
  await evalJs(`document.querySelector('#btn-model-picker-ok').click(); return 1`);
  await sleep(200);
  const applied = asObj(await evalJs(`return JSON.stringify({
    chips: window.__nbTest.modelChips(),
    active: window.__nbTest.modelChipActive(),
    value: window.__nbTest.modelPickerValue(),
    pickerOpen: window.__nbTest.modelPickerOpen(),
    settingsOpen: window.__nbTest.aiSettingsOpen(),
  })`));
  check('T9k 勾选结果写入"模型"一栏，首个勾选项成为生效模型',
    applied.chips.length === 2 && applied.chips.includes('mock-model-2') && applied.chips.includes('mock-model-3')
    && applied.value === 'mock-model-2' && applied.active === 'mock-model-2'
    && applied.pickerOpen === false && applied.settingsOpen === true,
    JSON.stringify(applied));

  await evalJs(`document.querySelector('#btn-ai-save').click(); return 1`);
  // 保存后"模型切换"下拉只列已启用模型,且选中已保存的生效模型
  await waitEval(`return document.querySelector('#ai-model-switch').value`, 'mock-model-2', 15000);
  const switchState = asObj(await evalJs(`return JSON.stringify({
    options: window.__nbTest.modelSwitchOptions(),
    value: document.querySelector('#ai-model-switch').value,
  })`));
  check('T9l 对话页模型下拉只含已勾选模型',
    switchState.options.length === 2
    && switchState.options.includes('mock-model-2') && switchState.options.includes('mock-model-3')
    && !switchState.options.includes('mock-model-1')
    && switchState.value === 'mock-model-2',
    JSON.stringify(switchState));

  // 温度设置已移除
  const tempGone = await evalJs(`return window.__nbTest.hasTempField() ? 1 : 0`);
  check('T9m 温度设置已从 AI 设置移除', tempGone === 0, String(tempGone));

  // 拉取按钮与"模型"一栏等高(第 4 条)
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await sleep(200);
  const rowH = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiRowHeights())`));
  check('T9n 模型栏与"拉取模型"按钮等高', Math.abs(rowH.btn - rowH.chips) <= 1, JSON.stringify(rowH));
  await evalJs(`document.querySelector('#btn-ai-cancel').click(); return 1`);
  await sleep(200);

  // AI 头部:设置/关闭按钮有间距(第 6 条),模型下拉与按钮等高(第 7 条)
  const headGeom = asObj(await evalJs(`return JSON.stringify({ gap: window.__nbTest.aiHeaderGap(), h: window.__nbTest.aiHeaderHeights() })`));
  check('T9o AI 头部:设置与关闭按钮留间距，模型下拉与按钮等高',
    headGeom.gap >= 6
    && headGeom.h.select === headGeom.h.settings && headGeom.h.select === headGeom.h.close,
    JSON.stringify(headGeom));

  // 流式渲染:先出现"正在思考…"等待态,再逐段落地为正文。
  // 必须走 /slow 端点 —— 正常端点几十毫秒就跑完,等待态一闪而过,断言不可靠。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}/slow';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await waitEval(`return document.querySelector('#modal-ai').classList.contains('hidden') ? 1 : 0`, '1', 15000);
  await evalJs(`document.querySelector('#ai-input').value = '慢速测试'; document.querySelector('#ai-send').click(); return 1`);
  const pendingSeen = await waitEval(
    `return JSON.stringify(window.__nbTest.aiBubbles())`, '"pending":true', 10000,
  ).then(() => true).catch(() => false);
  const pendingShape = asObj(await evalJs(`return JSON.stringify((window.__nbTest.aiBubbles()||[]).slice(-1)[0] || {})`));
  check('T9p 等待响应时显示"正在思考…"气泡(含转圈)',
    pendingSeen && pendingShape.hasSpinner === true && pendingShape.text.includes('正在思考'),
    JSON.stringify(pendingShape));

  // 首个 token 到达后转入流式态(等待占位被清掉),结束后状态收敛
  const streamingSeen = await waitEval(
    `return JSON.stringify(window.__nbTest.aiBubbles())`, '"streaming":true', 15000,
  ).then(() => true).catch(() => false);
  // 先等正文收全,再等 ai:done 把流式标记撤掉 —— 只等正文会在最后一帧
  // 尚未收尾时断言,拿到 streaming:true 的中间态。
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'SLOW-REPLY: 首段 次段', 20000);
  await waitEval(`return JSON.stringify((window.__nbTest.aiBubbles()||[]).slice(-1)[0] || {})`, '"streaming":false', 15000);
  const doneBubbles = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiBubbles())`));
  const lastBubble = doneBubbles[doneBubbles.length - 1] || {};
  check('T9q 流式态可见,结束后清除等待/流式标记并保留正文',
    streamingSeen && lastBubble.pending === false && lastBubble.streaming === false
    && lastBubble.text.includes('SLOW-REPLY: 首段 次段'),
    JSON.stringify({ streamingSeen, lastBubble }));

  // 还原 base,后续用例仍走正常端点
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await sleep(300);

  // 「生成命令」按钮已移除(与"直接提问"重复,且输入框本身就能描述需求)
  const genGone = asObj(await evalJs(`return JSON.stringify({ gone: window.__nbTest.genButtonGone(), noTemp: !window.__nbTest.hasTempField() })`));
  check('T9s 生成命令按钮已移除', genGone.gone === true && genGone.noTemp === true, JSON.stringify(genGone));

  // 发送按钮与输入框等高(用户第 2 条:此前按钮比两行的输入框矮一截)
  const inRow = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiInputHeights())`));
  check('T9t 发送按钮与输入框等高', Math.abs(inRow.input - inRow.send) <= 1, JSON.stringify(inRow));

  // Markdown 渲染 + 每条消息一键复制
  const bootMsgs = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiMsgDetail())`));
  const greet = bootMsgs.find((m) => m.role === 'assistant');
  check('T9u 助手消息按 Markdown 渲染,每条消息带复制按钮',
    greet && greet.mdBlocks > 0 && bootMsgs.every((m) => m.hasCopy)
    && String(await evalJs(`return document.querySelector('#ai-messages .ai-msg .ai-body').innerHTML`)).includes('<strong>'),
    JSON.stringify(bootMsgs.slice(0, 1)));
  await evalJs(`window.__nbTest.aiCopyClick(0); return 1`);
  const copyToast = await waitEval(`return document.querySelector('#toasts').textContent`, '已复制', 10000);
  check('T9v 一键复制消息内容', copyToast.includes('已复制'), copyToast.slice(-60));

  // 中文跨 chunk 乱码回归:mock 逐字节发送含中文的 SSE,多字节字符被拦腰
  // 切开时,按 chunk 做 from_utf8_lossy 会把一个字变两个 �。修复后按行攒字节。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}/utf8split';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await waitEval(`return document.querySelector('#modal-ai').classList.contains('hidden') ? 1 : 0`, '1', 15000);
  await evalJs(`document.querySelector('#ai-input').value = 'utf8测试'; document.querySelector('#ai-send').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, '中文测试-要知', 30000);
  const utf8Text = String(await evalJs(`return document.querySelector('#ai-messages').textContent`));
  check('T9w 中文跨 chunk 不乱码(按行攒字节解码)',
    utf8Text.includes('中文测试-要知') && !utf8Text.includes('\uFFFD'),
    utf8Text.slice(-120));
  // 还原 base,后续用例仍走正常端点
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-baseurl').value = '${ai.base}';
    document.querySelector('#btn-ai-save').click(); return 1`);
  await sleep(300);

  check('T9 AI 配置 / 模型发现 / 流式对话 / 保存后下拉即时刷新', true);

  // T9b:未保存的表单值可直接"测试连接"(曾误报"未配置");后端流式任务的 HTTP 错误
  // 必须经 ai:error 透出 —— 曾被吞掉,前端永远停在"生成中…"。
  // 用 /err 前缀 base:mock 对该路径的 chat 请求返回 401,若仍走已保存配置则会成功。
  // 模型栏现在是 chip(不可直接输入),先把已勾选的 mock-model-2 选为生效模型。
  await evalJs(`document.querySelector('#ai-settings-open').click(); return 1`);
  await evalJs(`document.querySelectorAll('#ai-model-chips .model-chip')[0].click(); return 1`);
  await evalJs(`
    document.querySelector('#ai-provider').value = 'custom';
    document.querySelector('#ai-protocol').value = 'openai';
    document.querySelector('#ai-baseurl').value = '${ai.base}/err';
    document.querySelector('#ai-apikey').value = 'sk-err';
    document.querySelector('#btn-ai-test').click(); return 1`);
  const t9bToast = await waitEval(`return document.querySelector('#toasts').textContent`, '测试失败', 20000);
  check('T9b 未保存表单直测连接 + HTTP 错误透出(不卡生成中)', t9bToast.includes('HTTP 401'), t9bToast);

  // T9c:失败的测试不占用请求槽位,正常对话立即可用
  await evalJs(`document.querySelector('#btn-ai-cancel').click(); return 1`);
  await evalJs(`document.querySelector('#ai-input').value = 'T9b-ok'; document.querySelector('#ai-send').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'T9b-ok', 20000);
  check('T9c 测试失败后请求槽位已释放(可继续对话)', true);

  // SFTP:首次打开默认落在「当前主机命令执行路径」(mock exec 探针返回 ~/data),
  // 路径栏是输入框,断言读 value(textContent 恒空)
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await evalJs(`document.querySelector('#btn-files').click(); return 1`);
  await waitEval(`return window.__nbTest.filePanel().pathValue`, '/home/user/data', 25000);
  const filesOk = await evalJs(`return document.querySelector('#file-list').textContent`);
  check('T10 SFTP 首次打开默认 shell 当前 cwd(~/data)', String(filesOk).includes('app.log'), filesOk.slice(0, 60));

  // —— 文件导航:上一级 / 后退 / 前进(资源管理器逻辑)+ 路径栏编辑 ——
  await evalJs(`document.querySelector('#btn-file-up').click(); return 1`);
  await waitEval(`return document.querySelector('#file-list').textContent`, 'README.md', 20000);
  let nav = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().nav)`));
  check('T10b 上一级到 ~(后退可用/前进禁用)', nav.back === true && nav.forward === false && nav.up === true, JSON.stringify(nav));

  await evalJs(`document.querySelector('#btn-file-back').click(); return 1`);
  await waitEval(`return document.querySelector('#file-list').textContent`, 'app.log', 20000);
  nav = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().nav)`));
  check('T10c 后退回 ~/data(前进恢复可用)', nav.back === false && nav.forward === true && nav.up === true, JSON.stringify(nav));

  await evalJs(`document.querySelector('#btn-file-forward').click(); return 1`);
  await waitEval(`return document.querySelector('#file-list').textContent`, 'README.md', 20000);
  check('T10d 前进到 ~', true);

  // 路径栏输入绝对路径回车跳转(派发真实 keydown,走与用户相同的监听器)
  const setPath = (v) => `
    const el = document.querySelector('#file-path');
    el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1`;
  await evalJs(setPath('/home/user/data'));
  await waitEval(`return document.querySelector('#file-list').textContent`, 'app.log', 20000);
  check('T10e 路径栏回车跳转到 ~/data', true);

  // `~` / `~/x` 是路径栏手输的高频写法:SFTP 协议不认波浪号,
  // 客户端要展开成家目录绝对路径(mock REALPATH '.' → /home/user)
  await evalJs(setPath('~/data'));
  await waitEval(`return document.querySelector('#file-list').textContent`, 'app.log', 20000);
  const tilde = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check('T10e2 路径栏支持 ~ 展开(~/data → /home/user/data)', tilde.cwd === '/home/user/data', tilde.cwd);

  await evalJs(setPath('/no-such-dir-e2e'));
  await waitEval(`return window.__nbTest.filePanel().status`, '加载失败', 20000);
  const badPath = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T10f 路径栏无效路径:报错并回落当前目录',
    badPath.cwd === '/home/user/data' && badPath.pathValue === '/home/user/data',
    JSON.stringify({ cwd: badPath.cwd, pathValue: badPath.pathValue }),
  );

  // 根目录已是顶层:上一级禁用
  await evalJs(setPath('/'));
  await waitEval(`return JSON.stringify(window.__nbTest.filePanel().cwd)`, '"/"', 20000);
  nav = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().nav)`));
  check('T10g 根目录的上一级禁用', nav.up === false, JSON.stringify(nav));

  // 回到 ~:后续用例(T54 右键 README.md 等)依赖当前目录里有它
  await evalJs(setPath('/home/user'));
  await waitEval(`return document.querySelector('#file-list').textContent`, 'README.md', 20000);
  check('T10h 路径栏跳转恢复,回到 ~', true);

  // 文件面板必须标明"操作的是哪台服务器",且在切换会话后跟随
  // (回归:面板原先只写"文件管理",切标签后仍显示上一台的目录,
  //  而操作会落到新会话 —— 看着 A 的目录删 B 的文件)
  const fp0 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T18 文件面板标明目标服务器',
    fp0.open === true && !!fp0.target && fp0.target.includes('@') && fp0.targetId === fp0.activeId,
    JSON.stringify(fp0),
  );

  // —— 4 文件工具栏:导航三连 + 图标化,下载/重命名/删除移入右键菜单 ——
  const tb = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().toolbar)`));
  const tbIds = tb.map((b) => b.id);
  check(
    'T52 文件工具栏 = 导航三连+刷新/新建/上传(图标按钮)',
    JSON.stringify(tbIds) === JSON.stringify(['btn-file-back', 'btn-file-forward', 'btn-file-up', 'btn-file-refresh', 'btn-file-mkdir', 'btn-file-upload'])
      // 文字按钮已去除:按钮文案应是图标字形,不是"新建文件夹/上传/下载"这类词
      && tb.every((b) => !/新建文件夹|上传|下载|重命名|权限|删除|书签/.test(b.text)),
    JSON.stringify(tb),
  );
  // 工具栏里不再有下载/重命名/权限/删除/书签按钮(它们已挪进右键菜单)
  const goneBtns = await evalJs(`return JSON.stringify(['#btn-file-download','#btn-file-rename','#btn-file-chmod','#btn-file-delete','#btn-file-bookmark'].filter((s) => document.querySelector(s)))`);
  check('T53 下载/重命名/权限/删除/书签按钮已从工具栏移除', goneBtns === '[]', goneBtns);

  // 右键文件行 → 弹出针对该文件的菜单(含下载/重命名/权限/删除)
  const fileCtx = asObj(await evalJs(`return JSON.stringify(window.__nbTest.fileCtxMenu('README.md'))`));
  const labels = fileCtx.map((i) => i.label);
  check(
    'T54 右键文件弹出下载/重命名/权限/删除菜单',
    labels.some((l) => l.includes('下载')) && labels.some((l) => l.includes('重命名'))
      && labels.some((l) => l.includes('权限')) && labels.some((l) => l.includes('删除')),
    JSON.stringify(labels),
  );
  // 删除走右键菜单:确认框里的目标名必须是"右键那一行",而不是别的选中项
  await evalJs(`window.__nbTest.ctxItemClick('删除文件'); return 1`);
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 10000);
  const delMsg = String(await evalJs(`return window.__nbTest.confirmText()`));
  check('T54b 右键删除的确认框指向右键的那一行', delMsg.includes('README.md'), delMsg);
  await evalJs(`window.__nbTest.confirmClickCancel(); return 1`); // 不真删(后面用例还要用)

  // —— 右键「打开」:下载临时副本 + 交系统默认程序(test_mode 只落盘不拉起,
  //    否则会在测试机上真的弹开一个编辑器窗口) ——
  const openMenu = asObj(await evalJs(`return JSON.stringify(window.__nbTest.fileCtxMenu('README.md'))`));
  check(
    'T54c 右键文件菜单含「打开(临时副本)」',
    openMenu.some((i) => i.label === '打开(临时副本)') && openMenu.some((i) => i.label === '下载…'),
    JSON.stringify(openMenu.map((i) => i.label)),
  );
  await evalJs(`window.__nbTest.ctxItemClick('打开(临时副本)'); return 1`);
  await waitEval(`return window.__nbTest.filePanel().status`, '已用本地程序打开', 25000);
  const openInfo = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel().lastOpen)`));
  const tmpOk = !!(openInfo && openInfo.localPath && fs.existsSync(openInfo.localPath))
    && fs.readFileSync(openInfo.localPath, 'utf8') === 'hello from nebula sftp\n';
  check('T54d 打开 = 远端文件落临时目录(内容一致,未拉起系统程序)', tmpOk, JSON.stringify(openInfo));

  // —— 3 拖拽上传(走 Tauri onDragDropEvent 真实通道) ——
  // 造一个真实本地文件,注入 drag-enter/drop 事件(带面板内的物理坐标)。
  const dropSrc = path.join(work, 'dropped.txt');
  fs.writeFileSync(dropSrc, 'dropped-by-drag-' + 'D'.repeat(512));
  const panelRect = asObj(await evalJs(`return JSON.stringify((() => {
    const r = document.querySelector('#file-panel').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 面板中心(转成物理像素,与真机事件一致)
    return { x: Math.round((r.left + r.width / 2) * dpr), y: Math.round((r.top + r.height / 2) * dpr) };
  })())`));
  await evalJs(`window.__nbTest.fireDragDrop('enter', [${JSON.stringify(dropSrc)}], { x: ${panelRect.x}, y: ${panelRect.y} }); return 1`);
  await sleep(300);
  const hintShown = await evalJs(`return String(window.__nbTest.dropHintVisible())`);
  check('T55 拖入文件面板时显示上传提示', hintShown === 'true', hintShown);
  await evalJs(`window.__nbTest.fireDragDrop('drop', [${JSON.stringify(dropSrc)}], { x: ${panelRect.x}, y: ${panelRect.y} }); return 1`);
  await waitEval(`document.querySelector('#file-list').textContent`, 'dropped.txt', 25000);
  check('T55b 拖放文件实际上传到当前远程目录', true);

  // 云导入:在界面上一张表单填完凭据 + 保存前"测试连接"校验,
  // 然后多账号 CRUD + 一键全区域拉取(腾讯云 CVM+轻量合并)。
  // 回归:轻量实例的 IP 字段名(PublicAddresses)与 CVM(PublicIpAddresses)不同,
  // 旧实现读不到 → 轻量主机被过滤 → "没有获取到可用实例"。
  await evalJs(`document.querySelector('#btn-cloud-import').click(); return 1`);
  await waitEval(`return String(!document.querySelector('#modal-cloud').classList.contains('hidden'))`, 'true', 10000);
  // 打开添加账号表单:厂商切换必须同步字段名(阿里云是 AccessKeyId/Secret)
  await evalJs(`document.querySelector('#btn-cloud-add-account').click(); return 1`);
  const formOpen = asObj(await evalJs(`window.__nbTest.cloudFormFill({ vendor: 'tencent' }); return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T23 云账号凭据表单一次展开(腾讯云字段名)',
    formOpen.open === true && formOpen.editingId === null && formOpen.keyIdLabel === 'SecretId',
    JSON.stringify(formOpen),
  );
  // 密钥帮助随表单厂商切换;外链必须是白名单控制台域名(回归:90f0e96 重构时整块丢失)
  check(
    'T23b 密钥帮助说明随表单展示(腾讯云,白名单外链)',
    formOpen.helpHtml.includes('QcloudCVMReadOnlyAccess')
      && formOpen.helpHtml.includes('data-url="https://console.cloud.tencent.com/cam/capi"')
      && formOpen.helpHtml.includes('密钥仅加密保存在本机'),
    formOpen.helpHtml.slice(0, 80),
  );
  const aliyunLabels = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ vendor: 'aliyun' });
    const a = window.__nbTest.cloudForm();
    window.__nbTest.cloudFormFill({ vendor: 'tencent' });
    return JSON.stringify(a)`));
  check(
    'T24 切换厂商同步字段名与帮助(阿里云 AccessKeyId/AccessKeySecret)',
    aliyunLabels.keyIdLabel === 'AccessKeyId' && aliyunLabels.secretLabel === 'AccessKeySecret'
      && aliyunLabels.helpHtml.includes('AliyunECSReadOnlyAccess')
      && aliyunLabels.helpHtml.includes('data-url="https://ram.console.aliyun.com/manage/ak"'),
    JSON.stringify(aliyunLabels),
  );

  // 负例:故意填错密钥,"测试连接"必须报错且不落库
  await evalJs(`
    window.__nbTest.cloudFormFill({ label: 'e2e错密钥', keyId: 'BADAKID-ui', secret: 'sk-bad', endpoint: '${cloud.base}' });
    window.__nbTest.cloudFormTest(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().testStatus`, '✗', 20000);
  const badTest = asObj(await evalJs(`return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T25 错误密钥测试连接失败且不保存',
    badTest.testStatus.startsWith('✗') && badTest.accountCount === 0,
    JSON.stringify(badTest),
  );

  // 正例:正确密钥 → 校验通过(报出地域数/实例数),再保存
  await evalJs(`
    window.__nbTest.cloudFormFill({ label: 'e2e账号', keyId: 'AKID-ui', secret: 'sk-ui' });
    window.__nbTest.cloudFormTest(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().testStatus`, '✓', 20000);
  const goodTest = asObj(await evalJs(`return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T26 正确密钥测试连接通过(报出地域与实例数)',
    goodTest.testStatus.includes('校验通过') && goodTest.testStatus.includes('2 个地域'),
    JSON.stringify(goodTest),
  );
  // 校验结论只对当时那组凭据有效:改动字段后必须作废(否则"✓ 通过"会
  // 停留在未校验过的新值上,用户改错密钥还以为是好的)
  const staleCleared = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ keyId: 'AKID-changed-after-test' });
    return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T31 改动凭据后上次校验结论作废',
    staleCleared.testStatus === '',
    JSON.stringify(staleCleared),
  );
  // 改回来再测一次,恢复通过态以便后续保存
  await evalJs(`
    window.__nbTest.cloudFormFill({ keyId: 'AKID-ui' });
    window.__nbTest.cloudFormTest(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().testStatus`, '✓', 20000);
  await evalJs(`window.__nbTest.cloudFormSave(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().accountCount`, '1', 10000);
  const saved = asObj(await evalJs(`return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T27 保存后表单收起且账号入列',
    saved.open === false && saved.accountCount === 1,
    JSON.stringify(saved),
  );

  // 一键拉取:直接点界面按钮(而非 IPC),验证全区域 CVM+轻量合并
  await evalJs(`document.querySelector('#btn-cloud-fetch').click(); return 1`);
  await waitEval(`return document.querySelector('#cloud-status').textContent`, '获取到', 30000);
  const fetchAll = asObj(await evalJs(`
    return JSON.stringify({
      status: document.querySelector('#cloud-status').textContent,
      rows: document.querySelectorAll('#cloud-tbody .cloud-row').length,
      groups: document.querySelectorAll('#cloud-tbody .cloud-group-row').length,
    })`));
  const lhRow = await evalJs(`return document.querySelector('#cloud-tbody').textContent.includes('203.0.113.30')`);
  const cvmRow = await evalJs(`return document.querySelector('#cloud-tbody').textContent.includes('203.0.113.10')`);
  check(
    'T11 云账号一键拉取(全区域,CVM+轻量合并)',
    fetchAll.rows >= 3 && cvmRow === true && lhRow === true,
    `rows=${fetchAll.rows} groups=${fetchAll.groups} cvm=${cvmRow} lh=${lhRow}`,
  );

  // 编辑已存账号:密钥留空 = 保持不变(不该因"没重输密钥"而保存失败)
  await evalJs(`document.querySelector('.cloud-account-row .ca-edit').click(); return 1`);
  const editState = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ keyId: 'AKID-ui-edited' });
    return JSON.stringify(window.__nbTest.cloudForm())`));
  check(
    'T28 编辑已存账号可留空密钥(placeholder 提示保持不变)',
    editState.open === true && !!editState.editingId && editState.secretLabel.includes('保持不变'),
    JSON.stringify(editState),
  );
  await evalJs(`window.__nbTest.cloudFormSave(); return 1`);
  await waitEval(`window.__nbTest.cloudForm().accountCount`, '1', 10000);
  const afterEdit = asObj(await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('cloud:accounts');
      const a = r.data.accounts[0];
      return JSON.stringify({ count: r.data.accounts.length, keyId: a.keyId, secretSet: a.secretSet });
    })()`));
  check(
    'T29 编辑保存后 keyId 更新且密钥仍保留',
    afterEdit.count === 1 && afterEdit.keyId === 'AKID-ui-edited' && afterEdit.secretSet === true,
    JSON.stringify(afterEdit),
  );

  // 编辑时改厂商不能沿用旧密钥:placeholder 撤销"保持不变"暗示,保存被拦下
  await evalJs(`document.querySelector('.cloud-account-row .ca-edit').click(); return 1`);
  const vendorSwitch = asObj(await evalJs(`
    window.__nbTest.cloudFormFill({ vendor: 'aliyun' });
    const s = window.__nbTest.cloudForm();
    window.__nbTest.cloudFormSave();
    return JSON.stringify({ secretLabel: s.secretLabel, keyIdLabel: s.keyIdLabel })`));
  await sleep(400);
  const vendorBlocked = asObj(await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('cloud:accounts');
      return JSON.stringify({ vendor: r.data.accounts[0].vendor, toast: document.querySelector('#toasts').textContent,
                              open: window.__nbTest.cloudForm().open });
    })()`));
  check(
    'T30 编辑改厂商时必须重输密钥(不静默沿用旧密钥)',
    vendorSwitch.keyIdLabel === 'AccessKeyId' && !vendorSwitch.secretLabel.includes('保持不变')
      && vendorBlocked.vendor === 'tencent' && vendorBlocked.toast.includes('请填写 AccessKeySecret')
      && vendorBlocked.open === true,
    `${JSON.stringify(vendorSwitch)} | ${JSON.stringify(vendorBlocked)}`,
  );
  await evalJs(`document.querySelector('#btn-cloud-form-cancel').click(); return 1`);
  await sleep(300);
  await evalJs(`document.querySelector('#btn-cloud-close').click(); return 1`);
  await sleep(300);

  // 同一主机再开一个独立标签(回归:此前同主机点击只切焦点,无法多开会话)
  const beforeTabs = Number(await evalJs(`return document.querySelectorAll('.tab').length`));
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    it.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true }));
    return 1`);
  await waitEval(`return document.querySelectorAll('.tab').length`, String(beforeTabs + 1), 30000);
  // 两个会话都要保活:切标签不应销毁另一个会话的终端
  const twoTabs = asObj(await evalJs(`return JSON.stringify(window.__nbTest.tabState())`));
  const allMountedOrAlive = twoTabs.sessions.length >= 2 && twoTabs.sessions.every((s) => s.hasText);
  check('T13 同主机可再开标签且会话互不干扰', twoTabs.tabs === beforeTabs + 1 && allMountedOrAlive, JSON.stringify(twoTabs));

  // 切换会话后,文件面板必须跟着换目标(否则会出现"显示 A、操作到 B")。
  // 用 sessionId 比对:同主机可能有多个会话,按名字比不足以判别。
  // 先等新会话真正 connected:T13 只等到标签出现,此刻新会话可能仍在 connecting,
  // 面板会短暂停在"未连接"(followFilePanel 在 ssh:status → connected 时才补一次),
  // 直接断言就会偶发失败。
  await waitEval(`return String(!!window.__nbTest.filePanel().targetId)`, 'true', 20000);
  const fpFollow = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T19 切换会话后文件面板跟随目标',
    !!fpFollow.targetId && fpFollow.targetId === fpFollow.activeId,
    JSON.stringify(fpFollow),
  );

  // 诊断报错只取"最后一次输入的命令 + 其后的控制台输出",不再扫整屏:
  // 整屏里早前的欢迎横幅等无关内容会稀释诊断焦点。
  // 此刻 ui-a 会话已连接,直接敲一条带标记的命令。
  await evalJs(`window.__nbTest.write('echo NB_DIAG_MARK_42\\r'); return 1`);
  await sleep(900);
  const diagSrc = asObj(await evalJs(`return JSON.stringify(window.__nbTest.diagSource())`));
  check('T9x 诊断素材 = 最后一次命令及其后的输出(不含更早的整屏)',
    diagSrc.cmd.includes('NB_DIAG_MARK_42') && diagSrc.output.includes('NB_DIAG_MARK_42')
    && !diagSrc.output.includes('Welcome to NebulaShell'),
    JSON.stringify(diagSrc));

  // 点「诊断报错」:AI 提问里应带上这条命令,而不带整屏历史
  await evalJs(`
    if (document.querySelector('#ai-panel').classList.contains('hidden')) document.querySelector('#btn-ai-toggle').click();
    return 1`);
  await evalJs(`document.querySelector('#btn-ai-diagnose').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'NB_DIAG_MARK_42', 20000);
  const diagMsgs = asObj(await evalJs(`return JSON.stringify(window.__nbTest.aiMsgDetail())`));
  const diagUser = [...diagMsgs].reverse().find((m) => m.role === 'user');
  check('T9y 诊断提问只含最后一次命令与输出',
    diagUser && diagUser.text.includes('NB_DIAG_MARK_42')
    && !diagUser.text.includes('Welcome to NebulaShell mock sshd'),
    JSON.stringify(diagUser));
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'MOCK-REPLY', 20000);

  // 放大按钮回归:单窗格时不得进入"已放大"态(视觉无变化,角标让用户以为按钮失效)
  // 此时处于 T13 的新标签里(单窗格)
  await evalJs(`
    const pane = document.querySelector('.term-pane.focused') || document.querySelector('.term-pane');
    (pane.querySelector('.pane-zoom-btn')||{}).click?.();    return 1`);
  await sleep(1200);
  const noZoom = asObj(await evalJs(`return JSON.stringify({ chip: !!document.querySelector('.zoom-chip'), toast: document.querySelector('#toasts').textContent })`));
  check(
    'T20 单窗格点放大不进入无效放大态',
    noZoom.chip === false && noZoom.toast.includes('无需放大'),
    JSON.stringify(noZoom),
  );

  // 分屏 → 放大 → 窗格占满;还原后窗格数恢复
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await sleep(200);
  await evalJs(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.textContent.includes('左右分屏')).click(); return 1`);
  await evalJs(`(document.querySelector('.pane-picker .pp-item')||{click(){}}).click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, '2', 30000);
  await evalJs(`document.querySelector('.term-pane.focused .pane-zoom-btn').click(); return 1`);
  await waitEval(`return String(!!document.querySelector('.zoom-chip'))`, 'true', 10000);
  const zoomed = asObj(await evalJs(`return JSON.stringify((() => {
    const ps = [...document.querySelectorAll('.term-pane')].map(p => Math.round(p.getBoundingClientRect().width));
    return { chip: !!document.querySelector('.zoom-chip'), panes: ps, maxW: Math.max(...ps) };
  })())`));
  check(
    'T21 分屏后放大窗格占满终端区',
    zoomed.chip === true && zoomed.panes.length === 1,
    JSON.stringify(zoomed),
  );
  await evalJs(`document.querySelector('.zoom-chip').click(); return 1`);
  await waitEval(`return String(!!document.querySelector('.zoom-chip'))`, 'false', 10000);
  const panesRestored = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
  check('T22 还原后恢复分屏布局', panesRestored === 2, `panes=${panesRestored}`);

  // 资源监控:固定显示在状态栏,采样值长度会变(9.2% ↔ 100%、890B/s ↔ 12.5GB/s、
  // 内存 (488/976MB) ↔ (128/128GB)),每 3s 刷新一次。
  // 回归两件事:①数值变化不得推动同一行里的行尾按钮;②状态栏不得因此折行(折行会占终端高度)。
  const monSamples = [
    // 首个采样到达前:所有字段都是占位符("…"/"")——占位与实数之间的切换正是抖动高发区
    { cpuPct: null, memPct: null, memUsedMB: null, memTotalMB: null, diskPct: null, diskUsedGB: null, diskTotalGB: null, rxBps: null, txBps: null, latencyMs: null },
    { cpuPct: 5, memPct: 9.7, memUsedMB: 46, memTotalMB: 976, diskPct: 4, diskUsedGB: 4, diskTotalGB: 100, rxBps: 0, txBps: 0, latencyMs: 45 },
    { cpuPct: 9.2, memPct: 50, memUsedMB: 488, memTotalMB: 976, diskPct: 40, diskUsedGB: 400, diskTotalGB: 1000, rxBps: 890, txBps: 1536, latencyMs: 123 },
    { cpuPct: 12.5, memPct: 33.3, memUsedMB: 8192, memTotalMB: 24576, diskPct: 55.5, diskUsedGB: 102.4, diskTotalGB: 200, rxBps: 1048576, txBps: 524288, latencyMs: 999 },
    { cpuPct: 100, memPct: 100, memUsedMB: 131072, memTotalMB: 131072, diskPct: 99.9, diskUsedGB: 10240, diskTotalGB: 10240, rxBps: 1073741824, txBps: 1073741824, latencyMs: 1500 },
  ];
  const monRows = asObj(await evalJs(`return JSON.stringify(window.__nbTest.monitorProbe(${JSON.stringify(monSamples)}))`));
  const monDrift = (() => {
    if (!Array.isArray(monRows) || !monRows.length) return { err: 'no rows' };
    const keys = Object.keys(monRows[0]).filter((k) => k !== '__text' && k !== '__bar');
    let maxLeft = 0; let maxWidth = 0;
    for (const k of keys) {
      const L = monRows.map((r) => r[k][0]);
      const W = monRows.map((r) => r[k][1]);
      maxLeft = Math.max(maxLeft, Math.max(...L) - Math.min(...L));
      maxWidth = Math.max(maxWidth, Math.max(...W) - Math.min(...W));
    }
    const heights = [...new Set(monRows.map((r) => r.__bar[0]))];
    // 行尾按钮的右边缘在所有采样下必须完全一致(监控不得推开按钮)
    const btnRights = monRows.map((r) => JSON.stringify(r.__bar[3]));
    const btnStable = [...new Set(btnRights)].length === 1;
    const overflow = Math.max(...monRows.map((r) => r.__bar[1]));
    return { maxLeft, maxWidth, heights, overflow, btnStable, btns: btnRights[0] };
  })();
  // 先确认值真的变了(否则"几何不变"可能只是没渲染):覆盖 占位 → 小值 → 常规 → 极值
  // 同时锁定新格式契约:≤1 位小数、去尾 .0、内存/磁盘详情自动换 GB/TB、延迟自适应单位
  const monTexts = Array.isArray(monRows) ? monRows.map((r) => r.__text) : [];
  check(
    'T34 监控数值随采样更新(非空转,格式收口)',
    monTexts.length === monSamples.length
      && monTexts[0].cpu === '…'
      && monTexts[2].cpu === '9.2%'
      && monTexts[4].cpu === '100%'
      && monTexts[2].mem === '(488/976MB)' && monTexts[4].mem === '(128/128GB)'
      && monTexts[3].mem === '(8/24GB)'
      && monTexts[3].disk === '(102.4/200GB)' && monTexts[4].disk === '(10/10TB)'
      && monTexts[2].rx === '890B/s' && monTexts[4].rx === '1GB/s'
      && monTexts[0].lat === '–' && monTexts[1].lat === '45ms'
      && monTexts[3].lat === '999ms' && monTexts[4].lat === '1.5s',
    JSON.stringify(monTexts).slice(0, 300),
  );
  check(
    'T35 监控布局不随数据长度抖动,且不推动行尾按钮',
    monDrift.maxLeft <= 0.6 && monDrift.maxWidth <= 0.6 && monDrift.heights.length === 1 && monDrift.overflow <= 0 && monDrift.btnStable,
    JSON.stringify(monDrift),
  );
  // 极端数值(1TB 内存 / 100TB 盘 / 100GbE)也不得改变状态栏高度或推开按钮:
  // 槽位定长 + overflow 兜底,超出槽宽的字符在自己槽内被裁。
  const monWorst = asObj(await evalJs(`return JSON.stringify(window.__nbTest.monitorProbe([
    { cpuPct: 100, memPct: 100, memUsedMB: 1048576, memTotalMB: 1048576, diskPct: 100, diskUsedGB: 102400, diskTotalGB: 102400, rxBps: 13421772800, txBps: 13421772800 }
  ]))`));
  const monBaseH = monRows[2].__bar[0];
  check(
    'T36 监控超大数值不撑高/不推开按钮',
    Array.isArray(monWorst) && monWorst[0].__bar[0] === monBaseH && monWorst[0].__bar[1] <= 0
      && JSON.stringify(monWorst[0].__bar[3]) === JSON.stringify(monRows[2].__bar[3]),
    JSON.stringify({ worst: monWorst && monWorst[0] && monWorst[0].__bar, base: monRows[2].__bar }),
  );
  // "暂不支持"是终态:文案比任何数值都长,曾把整条撑成两行。切到专用布局后必须仍是一行。
  const monUnsup = asObj(await evalJs(`return JSON.stringify(window.__nbTest.monitorProbe([
    { cpuPct: null, memPct: null, diskPct: null, rxBps: null, txBps: null, supported: false }
  ]))`));
  check(
    'T37 监控"不支持"终态仍是单行(不撑高)',
    Array.isArray(monUnsup) && monUnsup[0].__bar[0] === monBaseH && monUnsup[0].__bar[1] <= 0
      && String(monUnsup[0].__text.note).includes('仅支持 Linux'),
    JSON.stringify(monUnsup && monUnsup[0] && { bar: monUnsup[0].__bar, note: monUnsup[0].__text.note }),
  );

  // 右键:屏蔽 WebView 原生菜单,终端内弹应用菜单
  const ctx = asObj(await evalJs(`return JSON.stringify((() => {
    const pane = document.querySelector('.term-pane .xterm');
    const r = (pane || document.body).getBoundingClientRect();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 });
    (pane || document.body).dispatchEvent(e);
    const menu = document.querySelector('#ctx-menu');
    return { prevented: e.defaultPrevented, items: menu.querySelectorAll('.ctx-item').length };
  })())`));
  check('T14 右键屏蔽原生菜单并弹出应用菜单', ctx.prevented === true && ctx.items >= 4, JSON.stringify(ctx));

  // 按钮尺寸收敛(回归:此前存在 15/27/28/42px 四种高度混杂)
  const btnHeights = await evalJs(`return JSON.stringify((() => {
    const hs = new Set();
    for (const b of document.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      if (r.height > 0 && !b.closest('.hidden') && !b.closest('#ctx-menu')) hs.add(Math.round(r.height));
    }
    return [...hs].sort((a, b) => a - b);
  })())`);
  const heights = asObj(btnHeights);
  // ≤5 档:AI 助手输入行的发送按钮按用户要求与两行输入框等高(50px),
  // 是有意引入的第 5 档 —— 输入控件旁的按钮随输入框拉伸,不套通用刻度。
  check('T15 按钮高度层级收敛(≤5 档)', Array.isArray(heights) && heights.length <= 5, JSON.stringify(heights));

  // 导出:走带口令的加密导出,随后直接检查落盘文件不含明文凭据
  const exportPath = path.join(work, 'hosts-export.json');
  await evalJs(`window.__exportPath = ${JSON.stringify(exportPath)}; return 1`);
  await evalJs(`document.querySelector('#btn-hosts-export').click(); return 1`);
  await answerPrompt('e2e-passphrase-1', '导出主机');
  // 二次确认口令(标题不同,answerPrompt 靠标题区分两个框)
  await answerPrompt('e2e-passphrase-1', '确认口令');
  // 等文件落盘(mock 保存路径由 NEBULA_TEST_SAVE_PATH 决定)。
  // 预算放宽到 60s:带口令导出要走 scrypt 派生(N=2^15),e2e 跑的是 **debug 构建**,
  // 未优化下单次派生实测 ~2.9s,机器负载高(load avg 30+)时可达 20-48s ——
  // 15s 的旧预算会间歇性超时。测的是导出正确性,不是加密耗时。
  let exportText = '';
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    if (fs.existsSync(exportPath)) {
      const t = fs.readFileSync(exportPath, 'utf8');
      if (t.includes('credentialsIncluded')) { exportText = t; break; } // 等写完整
    }
  }
  const exportObj = exportText ? JSON.parse(exportText) : {};
  // 不能用 /password/i 这类关键词判断 —— authType:"password" 与 credentialsIncluded
  // 等键名本身就会命中。要断言的是"主机字段里没有明文凭据值"。
  const credFields = (exportObj.hosts || []).flatMap((h) =>
    ['password', 'privateKey', 'passphrase'].map((k) => h[k]));
  const hasPlainCredField = credFields.some((v) => v !== undefined && v !== null && String(v) !== '');
  const leaksValue = exportText.includes(PASSWORD) || /BEGIN [A-Z ]*PRIVATE KEY/.test(exportText);
  check(
    'T16 导出含加密凭据且文件无明文密码',
    exportObj.credentialsIncluded === true && !!exportObj.credentials && !hasPlainCredField && !leaksValue,
    `included=${exportObj.credentialsIncluded} plainField=${hasPlainCredField} leakedValue=${leaksValue}`,
  );

  // 导入验证:先删掉该主机,再从导出文件导回 —— 这样能真正检验"凭据被恢复",
  // 而不是被去重逻辑挡掉(同一 profile 里主机还在时会算重复)。
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    it.querySelector('.hi-del').click(); return 1`);
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 10000);
  await evalJs(`window.__nbTest.confirmClickOk(); return 1`);
  await sleep(800);
  await evalJs(`document.querySelector('#btn-hosts-import').click(); return 1`);
  await answerPrompt('e2e-passphrase-1', '输入解密口令');
  // 导入同样要走 scrypt 派生(debug 构建下数秒,高负载时更久),预算放宽
  await waitEval(`document.querySelector('#toasts').textContent`, '导入完成', 60000);
  const importToast = await evalJs(`return document.querySelector('#toasts').textContent`);
  // 恢复后的主机应带凭据(界面不再标记"待补全凭据")
  const restored = asObj(await evalJs(`return JSON.stringify((() => {
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-a'));
    return { chip: !!(it && it.querySelector('.host-chip')), hosts: document.querySelectorAll('.host-item').length };
  })())`));
  check(
    'T17 导入加密导出文件并恢复凭据',
    String(importToast).includes('恢复凭据') && restored.chip === false,
    `${String(importToast).slice(0, 90)} | chip=${restored.chip}`,
  );

  // 指纹变更(B6):预置的记录与服务器实际出示的指纹不符 → 连接被拒,
  // 应弹出"服务器指纹已变更"确认框(默认焦点在"取消",避免顺手回车放行),
  // 确认后删除旧记录并重连成功。这是"服务器换钥后怎么恢复"的唯一出口,
  // 也是 TOFU 的安全语义所在 —— 恢复必须由用户主动确认,而非静默自动信任。
  await evalJs(`
    document.querySelector('#btn-add-host').click();
    document.querySelector('#host-name').value = 'ui-fp';
    document.querySelector('#host-host').value = '127.0.0.1';
    document.querySelector('#host-port').value = '${sshd2.port}';
    document.querySelector('#host-username').value = 'root';
    document.querySelector('#host-password').value = '${PASSWORD}';
    document.querySelector('#btn-host-save').click(); return 1`);
  await waitEval(`return document.querySelector('#host-list').textContent`, 'ui-fp', 15000);
  await evalJs(`
    const it = [...document.querySelectorAll('.host-item')].find((x) => x.textContent.includes('ui-fp'));
    it.click(); return 1`);
  await waitEval(`window.__nbTest.confirmOpen()`, 'true', 20000);
  const fpDialog = asObj(await evalJs(`return JSON.stringify({
    title: window.__nbTest.confirmTitle(),
    focus: window.__nbTest.confirmFocus(),
    text: window.__nbTest.confirmText(),
    toast: document.querySelector('#toasts').textContent,
    status: document.querySelector('#status-text').textContent,
  })`));
  check(
    'T32 指纹变更:弹窗含新旧指纹且默认焦点在"取消"',
    fpDialog.title === '服务器指纹已变更'
      && fpDialog.focus === 'cancel'
      && fpDialog.text.includes(sshd.hostFingerprintB64)
      && fpDialog.text.includes(sshd2.hostFingerprintB64),
    JSON.stringify({ title: fpDialog.title, focus: fpDialog.focus }),
  );
  // 可机读标记是前后端之间的内部协议,绝不能漏到用户可见的任何位置
  check(
    'T32b 指纹标记不泄漏到界面(toast/状态栏/弹窗正文)',
    !fpDialog.text.includes('NB-FP')
      && !fpDialog.toast.includes('NB-FP')
      && !fpDialog.status.includes('NB-FP'),
    JSON.stringify({ toast: String(fpDialog.toast).slice(0, 80) }),
  );

  // 确认"重新信任并重连" → 删除旧记录、重连成功
  await evalJs(`window.__nbTest.confirmClickOk(); return 1`);
  await waitEval(`return document.querySelector('#status-text').textContent`, '已连接', 30000);
  await sleep(500); // 等新指纹落盘
  const refp = JSON.parse(fs.readFileSync(path.join(userData, 'nebulashell-config.json'), 'utf8')).knownHosts[fpKey2];
  check(
    'T33 重新信任后记录更新为服务器实际指纹',
    refp === sshd2.hostFingerprintB64,
    `got=${String(refp).slice(0, 16)}… want=${sshd2.hostFingerprintB64.slice(0, 16)}…`,
  );

  // 分屏:必须能"进去也能出来"(曾经分屏后没有关闭入口),且支持上下方向
  const splitMenu = asObj(await evalJs(`return JSON.stringify((() => {
    document.querySelector('#btn-more').click();
    const items = [...document.querySelectorAll('#more-menu .btn')].map((b) => b.textContent.trim());
    const has = (s) => items.some((t) => t.includes(s));
    return { items, lr: has('左右分屏'), tb: has('上下分屏'), auto: has('自动整理布局'), close: has('关闭当前窗格') };
  })())`));
  check(
    'T38 分屏菜单含左右/上下/自动整理/关闭窗格',
    splitMenu.lr && splitMenu.tb && splitMenu.auto && splitMenu.close,
    JSON.stringify(splitMenu.items),
  );
  const beforePanes = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
  await evalJs(`document.querySelector('#btn-split-top-bottom').click(); return 1`);
  await sleep(600);
  const splitDir = await evalJs(`return JSON.stringify([...document.querySelectorAll('.split-node')].map((n) => n.className))`);
  check('T39 上下分屏生成纵向布局节点', String(splitDir).includes('split-node v'), splitDir);
  await evalJs(`(document.querySelector('.pane-picker .pp-item')||{click(){}}).click(); return 1`);
  await waitEval(`return document.querySelectorAll('.term-pane .xterm').length`, String(beforePanes + 1), 30000);
  // 关闭当前窗格:曾经分屏后无法退出(空窗格更没有入口)。
  // 关掉 N 个窗格中的一个后应剩 N-1 个;只有回到 1 个时布局树才不再有分隔节点。
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(200);
  await evalJs(`document.querySelector('#btn-close-pane').click(); return 1`);
  await sleep(1200);
  const afterClose = asObj(await evalJs(`return JSON.stringify({ panes: document.querySelectorAll('.term-pane').length, nodes: document.querySelectorAll('.split-node').length })`));
  check(
    'T40 关闭当前窗格可退出分屏(窗格数 -1)',
    afterClose.panes === beforePanes && afterClose.nodes === (beforePanes <= 1 ? 0 : 1),
    JSON.stringify({ ...afterClose, beforePanes }),
  );

  // 多分屏可达性 + 自动整理布局:6 个窗格时容器必须可滚动,整理后行列均衡且无溢出
  for (let i = 0; i < 5; i++) {
    await evalJs(`document.querySelector('#btn-more').click(); return 1`);
    await sleep(150);
    await evalJs(`document.querySelector('#btn-split-left-right').click(); return 1`);
    await sleep(350);
  }
  const many = asObj(await evalJs(`return JSON.stringify((() => {
    const lr = document.querySelector('#layout-root');
    return { panes: document.querySelectorAll('.term-pane').length, canScroll: lr.scrollWidth > lr.clientWidth || lr.scrollHeight > lr.clientHeight, ow: getComputedStyle(lr).overflow };
  })())`));
  check(
    'T41 多窗格溢出时容器可滚动(窗格都可达)',
    many.panes >= 6 && many.canScroll && many.ow === 'auto',
    JSON.stringify(many),
  );
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(200);
  await evalJs(`document.querySelector('#btn-auto-layout').click(); return 1`);
  await sleep(1200);
  const auto = asObj(await evalJs(`return JSON.stringify((() => {
    const panes = [...document.querySelectorAll('.term-pane')].map((p) => { const r = p.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
    const lr = document.querySelector('#layout-root');
    const tops = [...new Set(panes.map((p) => p[1]))].sort((a, b) => a - b);
    const rows = tops.map((t) => panes.filter((p) => p[1] === t).length);
    return {
      count: panes.length, rows,
      // 主区过窄时多列放不下(窗格有 min-width),此时靠容器滚动保证可达
      overflowX: lr.scrollWidth - lr.clientWidth, overflowY: lr.scrollHeight - lr.clientHeight,
      scrollable: getComputedStyle(lr).overflow === 'auto',
      minW: Math.min(...panes.map((p) => p[2])), minH: Math.min(...panes.map((p) => p[3])),
    };
  })())`));
  check(
    'T42 自动整理布局:行列均衡的网格,放不下时可滚动可达',
    auto.count >= 6
      && auto.rows.length >= 2
      // 每行窗格数最多相差 1(均衡),而不是"一行塞满、最后一行剩 1 个"的畸形
      && Math.max(...auto.rows) - Math.min(...auto.rows) <= 1
      && (auto.overflowX <= 0 || auto.scrollable)
      && (auto.overflowY <= 0 || auto.scrollable)
      // 每个窗格都还得是可用的尺寸(没被压成窄条)
      && auto.minW >= 100 && auto.minH >= 100,
    JSON.stringify(auto),
  );
  // 收尾:把上面开出来的一堆窗格关回 1 个,避免影响后续用例(它们假定特定的窗格数)
  for (let i = 0; i < 10; i++) {
    const n = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
    if (n <= 1) break;
    await evalJs(`document.querySelector('#btn-more').click(); return 1`);
    await sleep(120);
    await evalJs(`document.querySelector('#btn-close-pane').click(); return 1`);
    await sleep(400);
  }
  const restoredPanes = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
  check('T42b 连续关闭可回到单窗格', restoredPanes === 1, `panes=${restoredPanes}`);



  // 浮动面板:可拖动 + 有明确关闭入口(此前只能用 Esc 或重复点菜单按钮)
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(150);
  await evalJs(`document.querySelector('#btn-snippets').click(); return 1`);
  await sleep(400);
  const snip = asObj(await evalJs(`return JSON.stringify((() => {
    const m = document.querySelector('#snippet-menu');
    const head = m.querySelector('.pop-head');
    const hb = head.getBoundingClientRect();
    const before = m.getBoundingClientRect();
    const fire = (t, x, y, target) => (target || document).dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    fire('mousedown', hb.left + 40, hb.top + 8, head);
    fire('mousemove', hb.left + 140, hb.top + 88, document);
    fire('mouseup', hb.left + 140, hb.top + 88, document);
    const after = m.getBoundingClientRect();
    return { open: !m.classList.contains('hidden'), hasClose: !!m.querySelector('#btn-snippet-close'), dx: Math.round(after.left - before.left), dy: Math.round(after.top - before.top) };
  })())`));
  check(
    'T43 片段面板可拖动且有关闭按钮',
    snip.hasClose && (snip.dx !== 0 || snip.dy !== 0),
    JSON.stringify(snip),
  );
  const snipClosed = await evalJs(`document.querySelector('#btn-snippet-close').click(); return JSON.stringify({ hidden: document.querySelector('#snippet-menu').classList.contains('hidden') })`);
  check('T44 片段面板关闭按钮可收起', asObj(snipClosed).hidden === true, snipClosed);

  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(150);
  await evalJs(`document.querySelector('#btn-history').click(); return 1`);
  await sleep(600);
  const hist = asObj(await evalJs(`return JSON.stringify((() => {
    const p = document.querySelector('#history-panel');
    if (!p) return { missing: true };
    return { open: !p.classList.contains('hidden'), hasClose: !!p.querySelector('#hist-close'), hasSearch: !!p.querySelector('#hist-search') };
  })())`));
  check('T45 历史面板有关闭按钮', hist.hasClose === true && hist.hasSearch === true, JSON.stringify(hist));
  const histClosed = await evalJs(`document.querySelector('#hist-close').click(); return JSON.stringify({ hidden: document.querySelector('#history-panel').classList.contains('hidden') })`);
  check('T46 历史面板关闭按钮可收起', asObj(histClosed).hidden === true, histClosed);

  // 交互动效:存在动画,且带 prefers-reduced-motion 兜底(无障碍)
  const anim = asObj(await evalJs(`return JSON.stringify((() => {
    const mm = document.querySelector('#more-menu');
    mm.classList.remove('hidden');
    const menuAnim = getComputedStyle(mm).animationName;
    mm.classList.add('hidden');
    let reduced = false;
    for (const s of document.styleSheets) {
      try { if ([...s.cssRules].some((r) => r.conditionText && r.conditionText.includes('prefers-reduced-motion'))) reduced = true; } catch { /* ignore */ }
    }
    return { menuAnim, reduced };
  })())`));
  check(
    'T47 存在交互动效且尊重 prefers-reduced-motion',
    anim.menuAnim && anim.menuAnim !== 'none' && anim.reduced === true,
    JSON.stringify(anim),
  );

  // 对齐类缺陷是像素级可测的,不必靠肉眼:逐一量出边界并断言一致。
  const align = asObj(await evalJs(`return JSON.stringify((() => {
    // ① 标签栏右侧按钮:顶边与垂直中心都必须一致(曾因 .ai-btn 单加 margin-bottom 而错位)
    const tbIds = ['#btn-newtab', '#btn-split', '#btn-ai-toggle', '#btn-more'];
    const tbs = tbIds.map((id) => { const r = document.querySelector(id).getBoundingClientRect(); return { id, top: Math.round(r.top * 10) / 10, cy: Math.round((r.top + r.height / 2) * 10) / 10 }; });
    const tabbarAligned = new Set(tbs.map((t) => t.top)).size === 1 && new Set(tbs.map((t) => t.cy)).size === 1;
    // ② 功能菜单(现为横向工具条):每个按钮内"图标→文字"的间距必须一致,
    //    图标在本按钮内垂直居中。图标字形宽度不一(📁/⚙️/◫ 各不相同,emoji 还带
    //    不可见的变体选择符),若间距不固定,同一行里各按钮的文字就会错开。
    //    (菜单从竖排列表改为横排后,原先"各行文字起点(x)相同"的判据不再适用。)
    const mm = document.querySelector('#more-menu');
    const wasHidden = mm.classList.contains('hidden');
    mm.classList.remove('hidden');
    const items = [...mm.querySelectorAll('.btn')].map((b) => {
      const mi = b.querySelector('.mi');
      const br = b.getBoundingClientRect();
      const mr = mi.getBoundingClientRect();
      // 文字节点:图标之后的第一个非空文本节点
      const tn = [...b.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      const gap = tn ? Math.round(((() => {
        const rng = document.createRange();
        rng.selectNodeContents(tn);
        return rng.getBoundingClientRect().left - mr.right;
      })()) * 10) / 10 : null;
      return { right: Math.round(mr.right * 10) / 10, gap, dCy: Math.round(Math.abs((mr.top + mr.height / 2) - (br.top + br.height / 2)) * 10) / 10 };
    });
    if (wasHidden) mm.classList.add('hidden');
    const menuGapUniform = new Set(items.map((i) => i.gap)).size === 1;
    const menuIconCentered = items.every((i) => i.dCy <= 1);
    return { tabbarAligned, menuGapUniform, menuIconCentered, items, maxIconDCy: Math.max(...items.map((i) => i.dCy)) };
  })())`));
  check(
    'T48 标签栏按钮对齐 / 菜单图标-文字间距一致且图标居中',
    align.tabbarAligned && align.menuGapUniform && align.menuIconCentered,
    JSON.stringify(align),
  );

  // 状态栏监控:窄窗口下必须"先收缩监控/状态文字,绝不遮挡行尾按钮",且高度恒定
  const sbWidths = [1016, 900, 700, 500, 380, 316];
  const sbProbe = asObj(await evalJs(`return JSON.stringify(${JSON.stringify(sbWidths)}.map((w) => {
    const main = document.querySelector('#main');
    const save = main.style.cssText;
    main.style.flex = '0 0 ' + w + 'px'; main.style.width = w + 'px';
    void main.getBoundingClientRect();
    const sb = document.querySelector('#statusbar');
    const sbR = sb.getBoundingClientRect();
    const mon = document.querySelector('#monitor-bar');
    const monVis = getComputedStyle(mon).display !== 'none';
    const monR = mon.getBoundingClientRect();
    const btns = [...sb.querySelectorAll('.btn')].filter((e) => !e.classList.contains('hidden'))
      .map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    const out = {
      w,
      h: Math.round(sbR.height),
      overflow: sb.scrollWidth - sb.clientWidth,
      allBtnsInside: btns.every((b) => b.right <= sbR.right + 0.5 && b.left >= sbR.left - 0.5),
      noOverlap: !monVis || btns.every((b) => monR.right <= b.left + 0.5),
    };
    main.style.cssText = save;
    return out;
  }))`));
  check(
    'T49 状态栏监控不遮挡行尾按钮,高度恒定',
    sbProbe.every((r) => r.overflow <= 0 && r.allBtnsInside && r.noOverlap && r.h === sbProbe[0].h),
    JSON.stringify(sbProbe),
  );

  /* ===== 本轮改动(1–7)的回归 ===== */

  // —— 7 指纹功能已并入功能菜单列表 ——
  const moreItems = asObj(await evalJs(`document.querySelector('#btn-more').click(); return JSON.stringify(window.__nbTest.moreMenuItems())`));
  check(
    'T50 指纹与关于已并入功能菜单,侧栏不再有指纹按钮',
    moreItems.some((t) => t.includes('主机指纹')) && moreItems.some((t) => t.includes('关于')) && footer.hasFingerprintBtn === false,
    JSON.stringify({ moreItems, footerHasFp: footer.hasFingerprintBtn }),
  );
  // 从菜单点开指纹弹窗,确认链路仍通(此前是侧边栏底部的按钮)
  await evalJs(`document.querySelector('#btn-fingerprints').click(); return 1`);
  await sleep(800);
  const fpOpen = await evalJs(`return String(!document.querySelector('#modal-fp').classList.contains('hidden'))`);
  check('T50b 功能菜单可打开指纹管理', fpOpen === 'true', fpOpen);
  await evalJs(`document.querySelector('#btn-fp-close') && document.querySelector('#btn-fp-close').click(); return 1`);

  // —— 5 更多菜单不得遮挡文件管理展示区 ——
  // 打开文件面板(已开则保持),再展开功能菜单,断言两者矩形不相交。
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  const panelWasOpen = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`)).open;
  if (!panelWasOpen) await evalJs(`document.querySelector('#btn-files').click(); return 1`);
  await waitEval(`window.__nbTest.filePanel().open`, 'true', 15000);
  const geom = asObj(await evalJs(`return JSON.stringify((() => {
    document.querySelector('#btn-more').click();
    return window.__nbTest.moreMenuGeom();
  })())`));
  check(
    'T51 文件面板打开时功能菜单不遮挡展示区',
    geom.panelOpen === true && geom.overlap === false,
    JSON.stringify(geom),
  );
  await evalJs(`document.querySelector('#btn-more').click(); return 1`); // 收起菜单
  await evalJs(`document.querySelector('#btn-file-close').click(); return 1`);

  // —— 1 新增分屏后自动整理为均衡网格 ——
  // 从单窗格连开两次,断言变成"行列均衡、同列宽/同行高一致"的网格,
  // 而不是被反复一刀切出的失衡形状。
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(150);
  await evalJs(`document.querySelector('#btn-split-left-right').click(); return 1`);
  await sleep(400);
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await sleep(150);
  await evalJs(`document.querySelector('#btn-split-top-bottom').click(); return 1`);
  await sleep(700);
  const grid = asObj(await evalJs(`return JSON.stringify(window.__nbTest.paneGrid())`));
  check(
    'T56 新增分屏后自动整理为行列均衡的等分网格',
    grid.count === 3
      // 3 个窗格 → 2 行(2+1):行内窗格数最多相差 1,而不是"一刀切"出的 1+1+1 细条
      && grid.rows.length === 2 && Math.max(...grid.rows) - Math.min(...grid.rows) <= 1
      // 行内等宽(同一行并排的窗格必须一样宽)
      && grid.withinRowWidthSpread <= 2
      // 行间等高。容差 10px:嵌套的 .split-node 带 height:100%,在 flex 列里
      // 会与 flex-basis:0 产生约 8px 的高度差 —— 这是既有的 CSS 行为(旧布局
      // 代码同样如此),肉眼不可见,不属于本次网格算法引入的问题。
      && grid.acrossRowHeightSpread <= 10
      // 放不下的极端情况靠滚动兜底,但每个窗格都得是可用的尺寸
      && grid.minW >= 100 && grid.minH >= 100,
    JSON.stringify(grid),
  );

  // —— 2 快捷键提示按平台渲染 ——
  const acc = asObj(await evalJs(`return JSON.stringify(window.__nbTest.accelTitles())`));
  const macLike = acc.platform === 'darwin';
  const wantMod = macLike ? '⌘' : 'Ctrl';
  check(
    'T57 快捷键提示按运行平台渲染(mac ⌘ / 其它 Ctrl)',
    // 标题里出现正确的修饰键,且不出现另一种平台的符号
    acc.newtab.includes(wantMod) && acc.split.includes(wantMod) && acc.closePane.includes(wantMod)
      && (macLike ? !/Ctrl/.test(acc.split) : !/⌘/.test(acc.split))
      // macOS 用连接符省略写法(⌘T),其它平台用 Ctrl+T
      && (macLike ? acc.newtab.includes('⌘T') : acc.newtab.includes('Ctrl+T')),
    JSON.stringify(acc),
  );

  // 收尾:把 T56 开出来的窗格关回 1 个,避免影响后续(以及可重复性)
  for (let i = 0; i < 6; i++) {
    const n = Number(await evalJs(`return document.querySelectorAll('.term-pane').length`));
    if (n <= 1) break;
    await evalJs(`document.querySelector('#btn-more').click(); return 1`);
    await sleep(120);
    await evalJs(`document.querySelector('#btn-close-pane').click(); return 1`);
    await sleep(400);
  }

  /* ===== 菜单重构(P0)的回归:标签/主机右键菜单、功能菜单分组与快捷键列 ===== */

  // —— 标签右键:关闭/关闭其他/关闭右侧/重命名 ——
  const tabCtx = asObj(await evalJs(`return JSON.stringify((() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab');
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    return [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => ({ label: b.querySelector('.ctx-label').textContent, disabled: b.disabled }));
  })())`));
  const tabHas = (l) => tabCtx.find((i) => i.label === l);
  check(
    'T58 标签右键菜单:关闭/关闭其他/关闭右侧/重命名/复制地址/新建',
    !!tabHas('关闭标签') && !!tabHas('关闭其他标签') && !!tabHas('关闭右侧标签') && !!tabHas('重命名…') && !!tabHas('复制主机地址') && !!tabHas('新建标签'),
    JSON.stringify(tabCtx),
  );
  // 重命名走应用内输入框(prompt 在 WKWebView 下不返回),留空可恢复默认
  await evalJs(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.querySelector('.ctx-label').textContent === '重命名…').click(); return 1`);
  await sleep(200);
  const renameOpen = asObj(await evalJs(`return JSON.stringify({ open: window.__nbTest.promptOpen(), title: window.__nbTest.promptTitle() })`));
  await evalJs(`window.__nbTest.promptFill('生产机'); window.__nbTest.promptClickOk(); return 1`);
  await sleep(200);
  const renamed = await evalJs(`return document.querySelector('.tab.active .tab-title').textContent`);
  check(
    'T58b 重命名标签生效',
    renameOpen.open === true && renamed === '生产机',
    JSON.stringify({ renameOpen, renamed }),
  );
  await evalJs(`
    const tab = document.querySelector('.tab.active');
    const r = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    return 1`);
  await sleep(150);
  await evalJs(`[...document.querySelectorAll('#ctx-menu .ctx-item')].find((b) => b.querySelector('.ctx-label').textContent === '重命名…').click(); return 1`);
  await sleep(150);
  await evalJs(`window.__nbTest.promptFill(''); window.__nbTest.promptClickOk(); return 1`);
  await sleep(150);
  const restoredTitle = await evalJs(`return document.querySelector('.tab.active .tab-title').textContent`);
  check('T58c 清空重命名恢复默认(跟随主机名)', restoredTitle !== '生产机', `title=${restoredTitle}`);

  // —— 主机右键:连接/新标签连接/编辑/克隆/复制/删除,与悬停图标同源 ——
  const hostCtx = asObj(await evalJs(`return JSON.stringify((() => {
    const it = [...document.querySelectorAll('.host-item')][0];
    const r = it.getBoundingClientRect();
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
    return [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.querySelector('.ctx-label').textContent);
  })())`));
  check(
    'T59 主机右键菜单:连接/新标签连接/编辑/克隆/复制/删除',
    hostCtx.includes('连接') && hostCtx.includes('在新标签连接') && hostCtx.includes('编辑…') && hostCtx.includes('克隆') && hostCtx.includes('复制 user@host') && hostCtx.includes('删除…'),
    JSON.stringify(hostCtx),
  );
  // 收起右键菜单,避免影响后续
  await evalJs(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1`);

  // —— 功能菜单:四组(布局/面板/会话/配置)+ 快捷键列按平台渲染 ——
  const menuStruct = asObj(await evalJs(`return JSON.stringify((() => {
    document.querySelector('#btn-more').click();
    const heads = [...document.querySelectorAll('#more-menu .mm-head')].map((h) => h.textContent.trim());
    const keys = [...document.querySelectorAll('#more-menu .mm-key')].filter((k) => k.textContent.trim()).map((k) => k.textContent.trim());
    const isMac = window.nebula.platform === 'darwin';
    document.querySelector('#btn-more').click();
    return { heads, keys, isMac };
  })())`));
  check(
    'T60 功能菜单按任务分组(布局/面板/会话/配置)',
    JSON.stringify(menuStruct.heads) === JSON.stringify(['布局', '面板', '会话', '配置']),
    JSON.stringify(menuStruct.heads),
  );
  check(
    'T60b 菜单行快捷键列按平台渲染(mac ⌘ / 其它 Ctrl)',
    menuStruct.keys.length > 0 && menuStruct.keys.some((k) => (menuStruct.isMac ? k.includes('⌘') : k.includes('Ctrl'))),
    JSON.stringify(menuStruct.keys),
  );

  /* ===== 终端复制三连修(T61):Ctrl+C 按选区分流 / 失败可见 ===== */

  // 有选区:Ctrl+C 必须是复制,不能把 \x03 发给 shell(否则正在跑的命令被误杀);
  // prevented = 自定义处理器介入的证据(旧实现从不 preventDefault)
  const withSel = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termCopyProbe({ select: true }))`));
  check(
    'T61 有选区时 Ctrl+C 复制而不中断(不给 shell 发 \\x03)',
    withSel.ok === true && withSel.prevented === true && withSel.hadSelection === true && String(withSel.selection).includes('PROBE-COPY-MARK-9137') && withSel.sigintSent === false && withSel.emitted === '',
    JSON.stringify(withSel),
  );

  // Shift 变形键:Ctrl+Shift+C 的 ev.key 是 'C',旧判定只认小写 'c' —— 此前是死键
  const shiftC = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termCopyProbe({ select: true, key: 'C', shift: true }))`));
  check(
    'T61b Ctrl+Shift+C(键面 C)同样复制而不发 \\x03',
    shiftC.ok === true && shiftC.prevented === true && shiftC.hadSelection === true && shiftC.sigintSent === false && shiftC.emitted === '',
    JSON.stringify(shiftC),
  );

  // 无选区:Ctrl+C 维持标准终端行为 —— 放行 \x03(SIGINT)发给 shell,
  // 同时 preventDefault 拦掉浏览器默认复制(别处 UI 的 DOM 选区)
  const noSel = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termCopyProbe({ select: false }))`));
  check(
    'T61c 无选区时 Ctrl+C 仍发送 SIGINT,且拦截浏览器默认复制',
    noSel.ok === true && noSel.prevented === true && noSel.hadSelection === false && noSel.sigintSent === true,
    JSON.stringify(noSel),
  );

  // Ctrl+V 粘贴必须只插一次:浏览器默认粘贴事件被拦截(prevented/pasteEvents=0),
  // 手动链路至多插一次(pasteCalls≤1)—— 修复前两条链路各插一次,内容翻倍
  const paste = asObj(await evalJs(`return JSON.stringify(await window.__nbTest.termPasteProbe())`));
  check(
    'T62 Ctrl+V 只粘贴一次(不触发原生 paste 事件,不重复插入)',
    paste.ok === true && paste.prevented === true && paste.pasteEvents === 0 && paste.pasteCalls <= 1,
    JSON.stringify(paste),
  );

  // 无未捕获异常
  const errs = await evalJs(`return JSON.stringify(window.__errs)`);
  check('T12 渲染层无未捕获异常', errs === '[]', String(errs).slice(0, 150));

  clearTimeout(watchdog);
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  clearTimeout(watchdog);
  console.error(`\n${FAIL} UI e2e 失败: ${e.message}`);
  if (appLogs.length) console.error('--- 应用日志 ---\n' + appLogs.join('').slice(-1200));
  await cleanup();
  process.exit(1);
});
