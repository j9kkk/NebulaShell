// 独立 mock sshd 启动器:供 Rust 集成测试使用;端口写入指定文件,循环保活
import { startMockSshd } from './ssh-server.mjs';

const portFile = process.argv[2];
const password = process.argv[3] || 'itest-pass';
const readDelayMs = Number(process.argv[4] || 0) || 0;
import fs from 'node:fs';
// 第 5 个参数:catCloseAfter(常驻延迟探测通道在回显 N 条后关闭),默认关闭。
const catCloseAfter = Number(process.argv[5] || 0) || 0;
const sshd = await startMockSshd({ password, sftpReadDelayMs: readDelayMs, catCloseAfter });
fs.writeFileSync(portFile, String(sshd.port));
console.log('sshd ready on', sshd.port);
process.on('exit', () => {});
setInterval(() => {}, 1 << 30);
