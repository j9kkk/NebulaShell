// 计数版 mock sshd:供 Rust 集成测试断言"连接/通道是否泄漏"。
// 把活跃连接数、活跃 shell 通道数、exec 次数实时写入计数文件(JSON),
// 测试侧轮询该文件即可判断资源是否被正确回收。
//
// 用法:node sshd-counting.mjs <portFile> <countFile> [password]
import { startMockSshd } from './ssh-server.mjs';
import fs from 'node:fs';

const portFile = process.argv[2];
const countFile = process.argv[3];
const password = process.argv[4] || 'itest-pass';

let clients = 0;
let shells = 0;
let execs = 0;
let sftpOpens = 0;
let peaks = { clients: 0, shells: 0 };

function flush() {
  const snap = { clients, shells, execs, sftpOpens, peakClients: peaks.clients, peakShells: peaks.shells };
  try {
    fs.writeFileSync(countFile, JSON.stringify(snap));
  } catch { /* ignore */ }
}

export function bump(kind, delta) {
  if (kind === 'client') clients += delta;
  if (kind === 'shell') shells += delta;
  if (kind === 'exec') execs += delta;
  if (kind === 'sftp') sftpOpens += delta;
  peaks.clients = Math.max(peaks.clients, clients);
  peaks.shells = Math.max(peaks.shells, shells);
  flush();
}

// 启动 mock sshd,并在其内部钩住连接/会话生命周期做计数。
const sshd = await startMockSshd({ password, onEvent: bump });
fs.writeFileSync(portFile, String(sshd.port));
flush();
console.log('counting sshd ready on', sshd.port);

// 保活
setInterval(() => {}, 1 << 30);
