// 内存探针:量化 NebulaShell 各进程 footprint,重点是 xterm 回滚缓冲的成本。
// 用法:node /tmp/nb-mem-probe.mjs <scrollbackLines> <dumpKBLines>
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

const { Server } = ssh2;
const ROOT = '/Users/joker/Documents/ssh-client';
const BIN = path.join(ROOT, 'src-tauri/target/debug/nebulashell');
const PASSWORD = 'probe-pass';
const SCROLLBACK = Number(process.argv[2] || 5000);
const DUMP_LINES = Number(process.argv[3] || 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 自定义 mock sshd:shell 收到 "dump N" 就吐 N 行 ----
function startSshd() {
  return new Promise((resolve) => {
    const hostKey = require_key();
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (ac) => ac());
          session.on('shell', (ac) => {
            const stream = ac();
            stream.write('probe-ready\r\nprobe# ');
            let line = '';
            stream.on('data', (d) => {
              for (const ch of d.toString()) {
                if (ch === '\r' || ch === '\n') {
                  const cmd = line.trim();
                  line = '';
                  if (!cmd) { stream.write('probe# '); continue; }
                  const m = cmd.match(/^dump\s+(\d+)$/);
                  if (m) {
                    const n = Number(m[1]);
                    const lineText = 'X'.repeat(100) + '\n';
                    // 分批写,避免一次 write 造成对端巨大单块
                    let buf = '';
                    for (let i = 0; i < n; i++) {
                      buf += String(i).padStart(6, '0') + ' ' + lineText;
                      if (buf.length > 64 * 1024) { stream.write(buf); buf = ''; }
                    }
                    if (buf) stream.write(buf);
                    stream.write('probe# ');
                  } else if (cmd === 'exit') { stream.end(); return; }
                  else { stream.write(`unknown: ${cmd}\r\nprobe# `); }
                } else if (ch === '\x7f') { line = line.slice(0, -1); }
                else if (ch >= ' ') { line += ch; }
              }
            });
          });
        });
      });
      client.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function require_key() {
  const { generateKeyPairSync } = require_crypto();
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
}
function require_crypto() { return cryptoMod; }
import cryptoMod from 'node:crypto';

// ---- WebKit 子进程归属:启动前快照,启动后取新增 PID ----
function webkitPids() {
  const out = execSync("ps -Ao pid,comm | grep -iE 'WebKit' | grep -v grep || true").toString();
  return new Set(out.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[0]));
}
function footprint(pid) {
  try {
    const out = execSync(`vmmap -summary ${pid} 2>/dev/null | grep -m1 'Physical footprint'`).toString();
    const m = out.match(/([\d.]+)([KMG])/);
    if (!m) return 0;
    const v = Number(m[1]);
    return m[2] === 'G' ? v * 1024 : m[2] === 'M' ? v : v / 1024;
  } catch { return 0; }
}
function rss(pid) {
  try { return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024; } catch { return 0; }
}
function snapshot() {
  const rows = [];
  for (const pid of ourPids) {
    const comm = execSync(`ps -o comm= -p ${pid} 2>/dev/null || true`).toString().trim();
    if (!comm) continue;
    const tag = comm.includes('WebContent') ? 'WebContent'
      : comm.includes('WebKit.GPU') ? 'GPU'
      : comm.includes('Networking') ? 'Networking'
      : comm.includes('nebulashell') ? 'MAIN(ours)' : comm;
    rows.push({ pid, tag, fp: footprint(pid), rss: rss(pid) });
  }
  return rows;
}
function report(label, rows) {
  const sumFp = rows.reduce((s, r) => s + r.fp, 0);
  const sumRss = rows.reduce((s, r) => s + r.rss, 0);
  console.log(`\n--- ${label} ---`);
  for (const r of rows) console.log(`  ${r.tag.padEnd(12)} pid=${String(r.pid).padEnd(7)} footprint=${r.fp.toFixed(1).padStart(7)}MB  rss=${r.rss.toFixed(1).padStart(7)}MB`);
  console.log(`  ${'TOTAL(ours)'.padEnd(12)}              footprint=${sumFp.toFixed(1).padStart(7)}MB  rss=${sumRss.toFixed(1).padStart(7)}MB`);
  return { sumFp, sumRss };
}

let proc = null; let sshd = null; let bridge = 0; let work = null; let userData = null;
const ourPids = [];
let seq = 0;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: bridge, path: p, method, timeout: 20000, headers: { Connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body); r.end();
  });
}
async function evalJs(js, timeout = 20000) {
  const id = `e${++seq}`;
  await req('POST', '/eval', JSON.stringify({ id, js }));
  const t0 = Date.now();
  for (;;) {
    const r = await req('GET', `/result/${id}`).catch(() => null);
    if (r && r.status === 200) { const v = JSON.parse(r.body).value; if (typeof v === 'string' && v.startsWith('ERR:')) throw new Error(v); return v; }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout');
    await sleep(120);
  }
}

const main = async () => {
  const before = webkitPids();
  sshd = await startSshd();
  console.log(`mock sshd :${sshd.port}  scrollback=${SCROLLBACK} dumpLines=${DUMP_LINES}`);

  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-probe-'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-probe-data-'));
  // 预置配置:scrollback 与主机
  const host = { id: 'h1', name: 'probe', host: '127.0.0.1', port: sshd.port, username: 'root', authType: 'password', passwordEnc: 'plain:' + Buffer.from(PASSWORD).toString('base64'), group: '', tags: [], jumpIds: [], initcmd: '', cloud: null, keyPath: '' };
  fs.writeFileSync(path.join(userData, 'nebulashell-config.json'), JSON.stringify({
    version: 1, hosts: [host], snippets: [], forwards: [], bookmarks: [], history: [], knownHosts: {},
    settings: { ai: { provider: 'custom', protocol: 'openai', baseUrl: '', model: '', temperature: 0.3 }, terminal: { fontSize: 13, theme: 'nebula', scrollback: SCROLLBACK }, clouds: { tencent: { key: '', endpoint: '' }, aliyun: { key: '', endpoint: '' } } },
  }, null, 2));

  const portFile = path.join(work, 'bridge.port');
  proc = spawn(BIN, [], { env: { ...process.env, NEBULA_TEST: '1', NEBULA_USER_DATA: userData, NEBULA_TEST_BRIDGE_FILE: portFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  globalThis.__logs = []; const appLogs = globalThis.__logs; proc.stdout.on('data', (d) => appLogs.push(String(d))); proc.stderr.on('data', (d) => appLogs.push(String(d)));

  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(portFile)) { bridge = Number(fs.readFileSync(portFile, 'utf8').trim()); if (bridge > 0) break; }
    if (Date.now() - t0 > 45000) throw new Error('bridge timeout');
    await sleep(300);
  }
  await evalJs(`return document.readyState`, 45000);

  const mainPid = proc.pid;
  ourPids.push(mainPid);
  for (const p of webkitPids()) if (!before.has(p)) ourPids.push(p);
  console.log(`main pid=${mainPid} our webkit pids=${ourPids.slice(1).join(',')}`);

  await sleep(2000);
  const base = report('空闲基线(无会话)', snapshot());

  // 连接
  await evalJs(`document.querySelector('.host-item').click(); return 1`);
  const t1 = Date.now();
  for (;;) {
    if (String(await evalJs(`return document.querySelector('#status-text').textContent`)) === '已连接') break;
    if (Date.now() - t1 > 40000) throw new Error('connect timeout');
    await sleep(300);
  }
  await sleep(2500);
  const connected = report('已连接(空终端)', snapshot());

  // 灌入大量终端输出
  const stepLines = Math.round(DUMP_LINES / 4);
  const marks = [];
  for (let i = 0; i < 4; i++) {
    await evalJs(`window.__nbTest.write('dump ${stepLines}\\r'); return 1`);
    await sleep(4500);
    marks.push(report(`灌入后 ~${(i + 1) * stepLines} 行`, snapshot()));
  }

  const wrote = await evalJs(`return JSON.stringify({lines: document.querySelectorAll('.xterm-rows > div').length})`);
  console.log(`\nDOM 行数(可视): ${wrote}`);

  const idle = marks[marks.length - 1];
  console.log(`\n===== 结论 =====`);
  console.log(`空闲→连接:      footprint +${(connected.sumFp - base.sumFp).toFixed(1)}MB`);
  console.log(`连接→${DUMP_LINES}行输出: footprint +${(idle.sumFp - connected.sumFp).toFixed(1)}MB`);
  console.log(`全程总计:        footprint ${idle.sumFp.toFixed(1)}MB / rss ${idle.sumRss.toFixed(1)}MB`);

  proc.kill(); sshd.server.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(0);
};

main().catch((e) => { console.error('探针失败:', e.message); try { console.error('--- app log ---\n' + globalThis.__logs.join('').slice(-2500)); } catch {} try { proc && proc.kill(); } catch {} try { sshd && sshd.server.close(); } catch {} process.exit(1); });
