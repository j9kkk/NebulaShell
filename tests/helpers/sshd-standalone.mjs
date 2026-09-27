// 独立 mock sshd 启动器:供 Rust 集成测试使用;端口写入指定文件,循环保活
import { startMockSshd } from './ssh-server.mjs';

const portFile = process.argv[2];
const password = process.argv[3] || 'itest-pass';
import fs from 'node:fs';
const sshd = await startMockSshd({ password });
fs.writeFileSync(portFile, String(sshd.port));
console.log('sshd ready on', sshd.port);
process.on('exit', () => {});
setInterval(() => {}, 1 << 30);
