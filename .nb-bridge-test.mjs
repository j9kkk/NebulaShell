import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BIN = '/Users/joker/Documents/ssh-client/src-tauri/target/debug/nebulashell';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-t-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-td-'));
fs.writeFileSync(path.join(userData, 'nebulashell-config.json'), JSON.stringify({
  version: 1, hosts: [], snippets: [], forwards: [], bookmarks: [], history: [], knownHosts: {},
  settings: { ai: {}, terminal: { scrollback: 5000 }, clouds: {} },
}));
const portFile = path.join(work, 'bridge.port');
const proc = spawn(BIN, [], { env: { ...process.env, NEBULA_TEST: '1', NEBULA_USER_DATA: userData, NEBULA_TEST_BRIDGE_FILE: portFile }, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', (d) => process.stdout.write('[app] ' + d));
proc.stderr.on('data', (d) => process.stdout.write('[app!] ' + d));

for (;;) { if (fs.existsSync(portFile)) break; await sleep(200); }
await sleep(6000);
const port = Number(fs.readFileSync(portFile, 'utf8').trim());
console.log('port', port);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000, headers: { Connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('http timeout')));
    if (body) r.write(body); r.end();
  });
}

const id = 'probe1';
const js = 'return document.readyState';
console.log('POST /eval', await req('POST', '/eval', JSON.stringify({ id, js })));
for (let i = 0; i < 10; i++) {
  await sleep(700);
  const r = await req('GET', `/result/${id}`);
  console.log(`t=${i}`, r.status, r.body);
  if (r.status === 200) break;
}
proc.kill();
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
process.exit(0);
