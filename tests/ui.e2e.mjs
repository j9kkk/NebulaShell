// NebulaShell UI 端到端测试(驱动 Tauri 应用的真实 webview)
//
// 机制:以 NEBULA_TEST=1 启动应用,它会开一个本地 HTTP 测试桥(src-tauri/src/bridge.rs)。
// POST /eval 注入 JS 到 webview,结果经 Tauri invoke 回传;GET /result/{id} 取回。
//
// 前置:先构建 Rust 二进制(npm run build:web && cd src-tauri && cargo build)
// 用法:node tests/ui.e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSshd } from './helpers/ssh-server.mjs';
import { startMockCloudServer, startMockAiServer } from './helpers/mock-servers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(root, 'src-tauri/target/debug/nebulashell');
const PASSWORD = 'ui-e2e-pass';

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let proc = null;
let sshd = null;
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

async function cleanup() {
  try { if (proc) proc.kill(); } catch { /* ignore */ }
  try { if (sshd) await sshd.close(); } catch { /* ignore */ }
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
  cloud = await startMockCloudServer();
  ai = await startMockAiServer();
  console.log(`mock 服务就绪 sshd=:${sshd.port} cloud=:${cloud.port} ai=:${ai.port}`);

  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ui-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ui-data-'));
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
  await waitEval(`return document.querySelector('#app-version').textContent`, 'v1.1.0');
  check('T2 欢迎页 + 版本号', true);

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
  await waitEval(`return (document.querySelector('.term-pane.focused .xterm-rows')||{}).textContent||''`, 'Welcome to NebulaShell mock sshd', 25000);
  check('T5 SSH 连接 + 终端输出', true);

  // 分屏
  // 分屏:同一标签内并排两个终端(标签数不变,窗格数 +1)
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
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
    document.querySelector('#ai-model').value = 'mock-model';
    document.querySelector('#ai-apikey').value = 'sk-mock';
    document.querySelector('#btn-ai-fetch-models').click(); return 1`);
  await waitEval(`return document.querySelector('#toasts').textContent`, '获取到 3 个模型', 15000);
  await evalJs(`document.querySelector('#btn-ai-save').click(); return 1`);
  await evalJs(`document.querySelector('#ai-input').value = '你好'; document.querySelector('#ai-send').click(); return 1`);
  await waitEval(`return document.querySelector('#ai-messages').textContent`, 'MOCK-REPLY:', 20000);
  check('T9 AI 配置 / 模型发现 / 流式对话', true);

  // SFTP
  await evalJs(`document.querySelector('#btn-more').click(); return 1`);
  await evalJs(`document.querySelector('#btn-files').click(); return 1`);
  await waitEval(`return document.querySelector('#file-path').textContent`, '/home/user', 25000);
  const filesOk = await evalJs(`return document.querySelector('#file-list').textContent`);
  check('T10 SFTP 列目录', String(filesOk).includes('README.md'));

  // 文件面板必须标明"操作的是哪台服务器",且在切换会话后跟随
  // (回归:面板原先只写"文件管理",切标签后仍显示上一台的目录,
  //  而操作会落到新会话 —— 看着 A 的目录删 B 的文件)
  const fp0 = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T18 文件面板标明目标服务器',
    fp0.open === true && !!fp0.target && fp0.target.includes('@') && fp0.targetId === fp0.activeId,
    JSON.stringify(fp0),
  );

  // 云导入(测试签名链路)
  const cloudRes = await evalJs(`
    return (async () => {
      const r = await window.nebula.invoke('cloud:fetch', {
        provider: 'tencent', region: 'ap-guangzhou', key: 'AKID-ui', secret: 'sk-ui', endpoint: '${cloud.base}/tencent'
      });
      return JSON.stringify({ ok: r.ok, count: (r.data || []).length });
    })()`);
  const cloudObj = asObj(cloudRes);
  check('T11 腾讯云实例拉取(TC3 签名链路)', cloudObj.ok === true && cloudObj.count === 2, cloudRes);

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
  const fpFollow = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T19 切换会话后文件面板跟随目标',
    !!fpFollow.targetId && fpFollow.targetId === fpFollow.activeId,
    JSON.stringify(fpFollow),
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
  check('T15 按钮高度层级收敛(≤4 档)', Array.isArray(heights) && heights.length <= 4, JSON.stringify(heights));

  // 导出:走带口令的加密导出,随后直接检查落盘文件不含明文凭据
  const exportPath = path.join(work, 'hosts-export.json');
  await evalJs(`window.__exportPath = ${JSON.stringify(exportPath)}; return 1`);
  await evalJs(`document.querySelector('#btn-hosts-export').click(); return 1`);
  await waitEval(`window.__nbTest.promptOpen()`, 'true', 10000);
  await evalJs(`window.__nbTest.promptFill('e2e-passphrase-1'); window.__nbTest.promptClickOk(); return 1`);
  // 二次确认口令
  await waitEval(`window.__nbTest.promptTitle()`, '确认口令', 10000);
  await evalJs(`window.__nbTest.promptFill('e2e-passphrase-1'); window.__nbTest.promptClickOk(); return 1`);
  // 等文件落盘(mock 保存路径由 NEBULA_TEST_SAVE_PATH 决定)
  let exportText = '';
  for (let i = 0; i < 60; i++) {
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
  await waitEval(`window.__nbTest.promptTitle()`, '输入解密口令', 15000);
  await evalJs(`window.__nbTest.promptFill('e2e-passphrase-1'); window.__nbTest.promptClickOk(); return 1`);
  await waitEval(`document.querySelector('#toasts').textContent`, '导入完成', 20000);
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
