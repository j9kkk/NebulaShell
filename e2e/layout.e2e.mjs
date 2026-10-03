// Targeted real-WebView regression: narrow controls, footer alignment and xterm clipping.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSshd } from './helpers/ssh-server.mjs';
import { auditNarrowPanels, auditTerminalViewport } from './helpers/layout-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-layout-'));
const password = 'layout-test-pass';
const sshd = await startMockSshd({ password });
fs.writeFileSync(path.join(work, 'nebulashell-config.json'), JSON.stringify({
  knownHosts: { [`127.0.0.1:${sshd.port}`]: sshd.hostFingerprintB64 }, hosts: [], settings: {},
}));
const portFile = path.join(work, 'bridge.port');
const proc = spawn(process.env.NEBULA_E2E_BIN || path.join(root, 'src-tauri/target/debug/nebulashell' + (process.platform === 'win32' ? '.exe' : '')), [], {
  env: { ...process.env, NEBULA_TEST: '1', NEBULA_USER_DATA: work, NEBULA_TEST_BRIDGE_FILE: portFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', port, seq = 0;
proc.stdout.on('data', d => { logs += d; });
proc.stderr.on('data', d => { logs += d; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(js) {
  const id = `layout-${++seq}`;
  await fetch(`http://127.0.0.1:${port}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, js }) });
  for (let i = 0; i < 150; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/result/${id}`);
    if (response.ok) {
      const { value } = await response.json();
      if (typeof value === 'string' && value.startsWith('ERR:')) throw new Error(value);
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
    await sleep(100);
  }
  throw new Error('WebView evaluation timed out: ' + js.slice(0, 80));
}
async function wait(js) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(js)) return;
    await sleep(200);
  }
  throw new Error('WebView state timed out: ' + js);
}
const watchdog = setTimeout(() => { proc.kill(); console.error('Layout test timed out\n' + logs); process.exitCode = 1; }, 90000);
try {
  for (let i = 0; i < 120 && !fs.existsSync(portFile); i++) await sleep(200);
  port = Number(fs.readFileSync(portFile, 'utf8'));
  await wait('return !!window.__nbTest && !!document.querySelector("#host-list")');
  await evaluate(`document.querySelector('#btn-add-host').click();
    document.querySelector('#host-name').value = 'layout-local';
    document.querySelector('#host-host').value = '127.0.0.1';
    document.querySelector('#host-port').value = '${sshd.port}';
    document.querySelector('#host-username').value = 'root';
    document.querySelector('#host-password').value = '${password}';
    document.querySelector('#btn-host-save').click(); return true;`);
  await wait('return !!document.querySelector(".host-item")');
  await evaluate('document.querySelector(".host-item").click(); return true;');
  await wait('return document.querySelector("#status-text").textContent.includes("已连接")');
  const panels = await evaluate(`return (${auditNarrowPanels.toString()})().then(JSON.stringify);`);
  console.log('PANELS ' + JSON.stringify(panels));
  const terminal = await evaluate(`return (${auditTerminalViewport.toString()})().then(JSON.stringify);`);
  console.log('TERMINAL ' + JSON.stringify(terminal));
  assert.equal(panels.issues.length + terminal.issues.length, 0, 'Layout regression findings');
  console.log(`PASS ${panels.samples} panel widths, collapsed footer, ${terminal.samples} live terminal sizes`);
} catch (error) {
  console.error(error.message);
  if (logs.includes('panicked')) console.error(logs);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  proc.kill();
  await sshd.close();
  fs.rmSync(work, { recursive: true, force: true });
}
