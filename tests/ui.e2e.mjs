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
  await waitEval(`return document.querySelector('#app-version').textContent`, 'v1.0.0');
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
  await waitEval(`return (document.querySelector('.term-pane.focused .xterm-rows')||{}).innerText||''`, 'Welcome to NebulaShell mock sshd', 25000);
  check('T5 SSH 连接 + 终端输出', true);

  // 分屏
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
  await evalJs(`(document.querySelector('.pane-picker .pp-item')||{click(){}}).click(); return 1`);
  await waitEval(`return document.querySelectorAll('.tab-dot.connected').length`, '2', 30000);
  check('T6 分屏双会话', true);

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
