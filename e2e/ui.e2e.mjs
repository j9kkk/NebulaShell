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
const BIN = path.join(root, 'src-tauri/target/debug/nebulashell');
const PASSWORD = 'ui-e2e-pass';
// 版本号从配置读,避免每发一版都要改测试(T2 断言用)
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'),
).version;

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
  // 预置 legacy 格式(64 位 hex)的 knownHosts 记录:模拟 Electron 时代迁移过来的数据。
  // 回归:旧记录与现行 base64 指纹编码不同,曾被误判成"服务器密钥变更"而拒连
  // (表现为 "Unknown server key")。T5 的连接必须照常成功,且记录被自愈升级。
  const tofuKey = `127.0.0.1:${sshd.port}`;
  fs.writeFileSync(
    path.join(userData, 'nebulashell-config.json'),
    JSON.stringify({ knownHosts: { [tofuKey]: sshd.hostFingerprintHex }, hosts: [], settings: {} }),
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
  await waitEval(`return document.querySelector('#app-version').textContent`, `v${APP_VERSION}`);
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

  // legacy hex 指纹被兼容(连接已成功)后,记录必须被自愈升级为现行 base64 格式
  await sleep(500);
  const upgradedFp = JSON.parse(fs.readFileSync(path.join(userData, 'nebulashell-config.json'), 'utf8')).knownHosts[tofuKey];
  check(
    'T5b legacy hex 指纹放行并自愈升级为 base64',
    upgradedFp === sshd.hostFingerprintB64,
    `got=${String(upgradedFp).slice(0, 20)}… want=${sshd.hostFingerprintB64.slice(0, 20)}…`,
  );

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
  const fpFollow = asObj(await evalJs(`return JSON.stringify(window.__nbTest.filePanel())`));
  check(
    'T19 切换会话后文件面板跟随目标',
    !!fpFollow.targetId && fpFollow.targetId === fpFollow.activeId,
    JSON.stringify(fpFollow),
  );

  // 放大按钮回归:单窗格时不得进入"已放大"态(视觉无变化,角标让用户以为按钮失效)
  // 此时处于 T13 的新标签里(单窗格)
  await evalJs(`
    const pane = document.querySelector('.term-pane.focused') || document.querySelector('.term-pane');
    (pane.querySelector('.pane-zoom-btn')||{}).click?.();
    return 1`);
  await sleep(1200);
  const noZoom = asObj(await evalJs(`return JSON.stringify({ chip: !!document.querySelector('.zoom-chip'), toast: document.querySelector('#toasts').textContent })`));
  check(
    'T20 单窗格点放大不进入无效放大态',
    noZoom.chip === false && noZoom.toast.includes('无需放大'),
    JSON.stringify(noZoom),
  );

  // 分屏 → 放大 → 窗格占满;还原后窗格数恢复
  await evalJs(`document.querySelector('#btn-split').click(); return 1`);
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
