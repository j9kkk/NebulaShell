// 测试用 mock SSH 服务端:密码 + 公钥认证,shell 回显并处理探测命令,支持 exec、内存版 SFTP、
// direct-tcpip(跳板 forwardOut 的对端)与 tcpip-forward(远程转发的对端)
import ssh2 from 'ssh2';
import crypto from 'node:crypto';
import net from 'node:net';

const { Server } = ssh2;
const { STATUS_CODE: SFTP_STATUS_CODE, OPEN_MODE: SFTP_OPEN_MODE } = ssh2.utils.sftp;

// 内存文件系统：path -> { type: 'dir'|'file'|'symlink', data: Buffer, mtime, target }
function makeMemFs() {
  const tree = new Map();
  const now = Math.floor(Date.now() / 1000);
  const put = (p, type, data = null, target = null) => tree.set(p, { type, data: data ? Buffer.from(data) : null, mtime: now, target });
  put('/', 'dir');
  put('/home', 'dir');
  put('/home/user', 'dir');
  put('/home/user/README.md', 'file', 'hello from nebula sftp\n');
  put('/home/user/data', 'dir');
  put('/home/user/data/app.log', 'file', 'x'.repeat(4096));
  // 跨主机复制夹具:单文件 + 嵌套目录(含空子目录/点文件)+ 符号链接
  put('/home/user/copy-src.txt', 'file', 'copy me across hosts\n');
  put('/home/user/srcdir', 'dir');
  put('/home/user/srcdir/inner.txt', 'file', 'inner\n');
  put('/home/user/srcdir/sub', 'dir');
  put('/home/user/srcdir/sub/deep.txt', 'file', 'deep\n');
  put('/home/user/srcdir/empty', 'dir');
  put('/home/user/srcdir/.dotfile', 'file', 'dot\n');
  put('/home/user/srcdir/link-dangling', 'symlink', null, '/nowhere-target');
  return tree;
}

function memFsResolve(base, p) {
  const joined = p.startsWith('/') ? p : base.replace(/\/$/, '') + '/' + p;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

function memFsAttrs(node) {
  const mode = node.type === 'dir' ? 0o040755 : node.type === 'symlink' ? 0o120777 : 0o100644;
  return {
    mode,
    uid: 0, gid: 0,
    size: node.data ? node.data.length : 0,
    atime: node.mtime, mtime: node.mtime,
  };
}

/// STAT 跟随符号链接解析目标;LSTAT 不跟随(transfer 引擎靠它识别链接并跳过)
function memFsStat(tree, rp) {
  let node = tree.get(rp);
  if (node && node.type === 'symlink') {
    const target = memFsResolve(rp.replace(/\/[^/]*$/, ''), node.target);
    node = tree.get(target);
    if (!node) return null;
  }
  return node || null;
}

// 挂载最小 SFTP 服务端：REALPATH / OPENDIR / READDIR / OPEN / READ / WRITE / CLOSE / MKDIR / RMDIR / REMOVE / STAT
// opts.readDelayMs: 每个 READ 响应人为延迟(模拟慢网/慢盘),0 = 不延迟;仅测试床使用,默认关闭。
function attachMockSftp(session, tree, emit = () => {}, { readDelayMs = 0 } = {}) {
  // 注意:ssh2 在存在 'sftp' 监听器时只发 'sftp' 事件、不发 'subsystem'
  // (见 ssh2/lib/server.js 的 case 'subsystem'),故计数必须挂在 'sftp' 上。
  session.on('subsystem', (accept) => accept && accept()); // russh 客户端需显式请求 sftp 子系统
  session.on('sftp', (accept) => {
    emit('sftp', +1);
    const sftp = accept();
    const handles = new Map();
    let handleSeq = 0;
    const newHandle = (info) => {
      const h = Buffer.from('h' + (++handleSeq));
      handles.set(h.toString(), info);
      return h;
    };
    const getHandle = (h) => handles.get(h.toString());
    const fail = (reqId, err) => sftp.status(reqId, err && err.code === 2 ? SFTP_STATUS_CODE.NO_SUCH_FILE : SFTP_STATUS_CODE.FAILURE);

    sftp.on('REALPATH', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p || '.'));
      if (!tree.has(rp)) return fail(reqId, { code: 2 });
      sftp.name(reqId, [{ filename: rp }]);
    });
    sftp.on('OPENDIR', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p || '.'));
      const node = memFsStat(tree, rp) || tree.get(rp);
      if (!node || node.type !== 'dir') return fail(reqId, { code: 2 });
      sftp.handle(reqId, newHandle({ type: 'dir', path: rp, listed: false }));
    });
    sftp.on('READDIR', (reqId, h) => {
      const info = getHandle(h);
      if (!info || info.type !== 'dir') return fail(reqId, { code: 2 });
      if (info.listed) return sftp.status(reqId, SFTP_STATUS_CODE.EOF);
      info.listed = true;
      const prefix = info.path === '/' ? '/' : info.path + '/';
      const names = [...tree.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, n]) => ({
          filename: p.split('/').pop(),
          longname: (n.type === 'dir' ? 'drwxr-xr-x' : n.type === 'symlink' ? 'lrwxrwxrwx' : '-rw-r--r--') + ' mock ' + (n.data ? n.data.length : 0),
          attrs: memFsAttrs(n),
        }));
      sftp.name(reqId, names);
    });
    sftp.on('OPEN', (reqId, p, flags, attrs) => {
      const rp = memFsResolve('/home/user', String(p));
      let node = tree.get(rp);
      const wantRead = (flags & SFTP_OPEN_MODE.READ) !== 0;
      const wantWrite = (flags & SFTP_OPEN_MODE.WRITE) !== 0 || (flags & SFTP_OPEN_MODE.CREAT) !== 0;
      const trunc = (flags & SFTP_OPEN_MODE.TRUNC) !== 0;
      // EXCLUDE(独占创建):已存在即失败 —— 后端靠它做"默认不覆盖"的
      // 服务端守卫(上传冲突/复制临时文件分配)。
      if ((flags & SFTP_OPEN_MODE.EXCLUDE) !== 0 && wantWrite && node) {
        return fail(reqId, null);
      }
      // 符号链接按打开语义跟随(与真实 sftp-server 一致)
      if (node && node.type === 'symlink') {
        node = memFsStat(tree, rp);
        if (!node) return fail(reqId, { code: 2 });
      }
      if (wantRead && (!node || node.type !== 'file')) return fail(reqId, { code: 2 });
      if (wantWrite) {
        if (node && node.type === 'dir') return fail(reqId, null);
        const data = node ? (trunc ? Buffer.alloc(0) : Buffer.from(node.data || '')) : Buffer.alloc(0);
        tree.set(rp, { type: 'file', data, mtime: Math.floor(Date.now() / 1000) });
      }
      const cur = tree.get(rp);
      sftp.handle(reqId, newHandle({ type: 'file', path: rp, buf: Buffer.from(cur.data || ''), write: wantWrite }));
    });
    sftp.on('READ', (reqId, h, offset, size) => {
      const info = getHandle(h);
      if (!info || info.type !== 'file') return fail(reqId, { code: 2 });
      const node = tree.get(info.path);
      if (!node) return fail(reqId, { code: 2 });
      const slice = (node.data || Buffer.alloc(0)).slice(offset, offset + size);
      if (!slice.length) return sftp.status(reqId, SFTP_STATUS_CODE.EOF);
      const reply = () => sftp.data(reqId, slice);
      if (readDelayMs > 0) setTimeout(reply, readDelayMs);
      else reply();
    });
    sftp.on('WRITE', (reqId, h, offset, data) => {
      const info = getHandle(h);
      if (!info || info.type !== 'file' || !info.write) return fail(reqId, null);
      if (offset + data.length > info.buf.length) {
        const bigger = Buffer.alloc(offset + data.length);
        info.buf.copy(bigger, 0);
        info.buf = bigger;
      }
      data.copy(info.buf, offset);
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    sftp.on('CLOSE', (reqId, h) => {
      const info = getHandle(h);
      if (info && info.write) {
        tree.set(info.path, { type: 'file', data: info.buf, mtime: Math.floor(Date.now() / 1000) });
      }
      handles.delete(h.toString());
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    sftp.on('MKDIR', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p));
      if (tree.has(rp)) return fail(reqId, null);
      tree.set(rp, { type: 'dir', data: null, mtime: Math.floor(Date.now() / 1000) });
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    sftp.on('RMDIR', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p));
      const node = tree.get(rp);
      if (!node || node.type !== 'dir') return fail(reqId, { code: 2 });
      const hasChild = [...tree.keys()].some((k) => k !== rp && k.startsWith(rp + '/'));
      if (hasChild) return fail(reqId, null);
      tree.delete(rp);
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    sftp.on('REMOVE', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p));
      const node = tree.get(rp);
      if (!node || node.type !== 'file') return fail(reqId, { code: 2 });
      tree.delete(rp);
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    sftp.on('STAT', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p));
      const node = memFsStat(tree, rp);
      if (!node) return fail(reqId, { code: 2 });
      sftp.attrs(reqId, memFsAttrs(node));
    });
    // LSTAT 不跟随符号链接:传输引擎用它区分链接/普通文件
    sftp.on('LSTAT', (reqId, p) => {
      const rp = memFsResolve('/home/user', String(p));
      const node = tree.get(rp);
      if (!node) return fail(reqId, { code: 2 });
      sftp.attrs(reqId, memFsAttrs(node));
    });
    // RENAME:协议级语义 —— 目标已存在即失败(OpenSSH 对 SSH_FXP_RENAME
    // 目标存在一律拒绝)。原子替换必须走 posix-rename@openssh.com 扩展,
    // 不给 RENAME 开"目标存在也成功"的口子,否则会掩盖真机
    // "占位 0 字节文件 + 普通 RENAME 失败"的发布缺陷(e2e 假绿)。
    sftp.on('RENAME', (reqId, from, to) => {
      const rf = memFsResolve('/home/user', String(from));
      const rt = memFsResolve('/home/user', String(to));
      const node = tree.get(rf);
      if (!node || rf === rt) return fail(reqId, { code: 2 });
      if (tree.has(rt)) return fail(reqId, null); // EEXIST → 泛化 Failure,同真实 OpenSSH
      tree.set(rt, node);
      tree.delete(rf);
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    // posix-rename@openssh.com:目标存在则原子替换(OpenSSH 扩展)
    sftp.on('EXTENDED', (reqId, extName, extData) => {
      if (extName !== 'posix-rename@openssh.com') return fail(reqId, { code: 8 }); // unsupported
      // extData: STRING from, STRING to
      const fromLen = extData.readUInt32BE(0);
      const rf = memFsResolve('/home/user', extData.slice(4, 4 + fromLen).toString());
      const toOff = 4 + fromLen;
      const toLen = extData.readUInt32BE(toOff);
      const rt = memFsResolve('/home/user', extData.slice(toOff + 4, toOff + 4 + toLen).toString());
      const node = tree.get(rf);
      if (!node || rf === rt) return fail(reqId, { code: 2 });
      tree.delete(rt);
      tree.set(rt, node);
      tree.delete(rf);
      sftp.status(reqId, SFTP_STATUS_CODE.OK);
    });
    sftp.on('error', () => {});
  });
}

export async function startMockSshd({ user = 'root', password = 'test-pass-123', port = 0, onEvent, commandBlockInput = false, sftpReadDelayMs = 0 } = {}) {
  const hostPrivateKey = crypto
    .generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' });
  const tree = makeMemFs();

  const clientListenServers = [];
  const windowChanges = [];
  // Observation only; channel IDs let UI E2E prove which shell received bytes.
  const shellWrites = [];
  const shellCommands = [];
  let shellSeq = 0;
  // 生命周期计数器(可选):用于断言连接/通道是否被正确回收。
  const emit = (kind, delta) => { try { onEvent && onEvent(kind, delta); } catch { /* ignore */ } };
  const server = new Server({ hostKeys: [hostPrivateKey], debug: process.env.SSHD_DEBUG ? (l) => console.log('[SSHD]', l) : undefined }, (client) => {
    emit('client', +1);
    client.on('close', () => emit('client', -1));
    client.on('authentication', (ctx) => {
      // ssh2 服务端认证上下文用 ctx.method 区分认证方式
      if (ctx.method === 'password') {
        if (ctx.username === user && ctx.password === password) return ctx.accept();
        return ctx.reject();
      }
      if (ctx.method === 'publickey') return ctx.accept(); // 测试服务器接受任意公钥（用于验证客户端 key 认证链路）
      return ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        attachMockSftp(session, tree, emit, { readDelayMs: sftpReadDelayMs });
        session.on('pty', (ac) => ac());
        session.on('shell', (ac) => {
          emit('shell', +1);
          const stream = ac();
          stream.on('close', () => emit('shell', -1));
          let line = '';
          const shellId = ++shellSeq;
          let bracketed = false;
          let inPaste = false;
          let input = '';
          const pasteStart = '\x1b[200~', pasteEnd = '\x1b[201~';
          const submit = () => {
            const cmd = line.trim();
            line = '';
            if (cmd) {
              shellCommands.push({ shellId, command: cmd });
              stream.write('\r\n');
              if (commandBlockInput && cmd === 'nebula-e2e-bracketed-on') {
                bracketed = true;
                stream.write('\x1b[?2004hBRACKETED-ON\r\n');
              } else if (commandBlockInput && cmd === 'nebula-e2e-bracketed-off') {
                bracketed = false;
                stream.write('\x1b[?2004lBRACKETED-OFF\r\n');
              } else if (commandBlockInput && cmd === 'whoami\nnebula-probe') {
                // One submitted block, not two Enter events. The mock never evals it.
                stream.write('root\r\nPROBE-OK nebula-e2e\r\n');
              } else if (cmd === 'whoami') stream.write('root\r\n');
              else if (cmd === 'nebula-probe') stream.write('PROBE-OK nebula-e2e\r\n');
              else if (cmd === 'exit') { stream.end(); return false; }
              else stream.write(`bash: ${cmd}: command not found\r\n`);
            }
            stream.write('root@mock:~# ');
            return true;
          };
          stream.write('Welcome to NebulaShell mock sshd\r\n');
          stream.write('root@mock:~# ');
          stream.on('data', (d) => {
            shellWrites.push({ shellId, data: d.toString() });
            stream.write(d); // 模拟 PTY 回显
            // Default parsing stays unchanged; opt-in channels recognize paste
            // boundaries even when SSH splits an escape sequence across packets.
            input += d.toString();
            while (input) {
              if (commandBlockInput && bracketed) {
                const marker = inPaste ? pasteEnd : pasteStart;
                if (input.startsWith(marker)) {
                  inPaste = !inPaste;
                  input = input.slice(marker.length);
                  continue;
                }
                if (marker.startsWith(input)) break;
              }
              const ch = input[0];
              input = input.slice(1);
              if (commandBlockInput && bracketed && ch === '\x03') {
                line = ''; inPaste = false;
                stream.write('^C\r\nroot@mock:~# ');
              } else if (ch === '\r' && !inPaste) {
                if (!submit()) return;
              } else if (ch === '\x7f') {
                line = line.slice(0, -1);
              } else {
                line += inPaste && ch === '\r' ? '\n' : ch;
              }
            }
          });
        });
        session.on('window-change', (ac, reject, info) => {
          windowChanges.push(info); // 验证 PTY 尺寸同步(E3)
        });
        session.on('exec', (ac, reject, info) => {
          emit('exec', +1);
          const stream = ac();
          if (String(info.command).includes('utf8split')) {
            // 逐字节发送一个多字节字符串:强制跨 SSH 消息边界,
            // 用于回归"from_utf8_lossy 逐消息转换会把汉字切坏"。
            const bytes = Buffer.from('中文测试\n', 'utf8');
            let i = 0;
            const step = () => {
              if (i >= bytes.length) { stream.exit(0); stream.end(); return; }
              stream.write(bytes.subarray(i, i + 1));
              i += 1;
              setTimeout(step, 120);
            };
            step();
            return;
          }
          // 资源监控探测(monitor::PROBE 读 /proc/*):返回可解析的假数据。
          // 必须让 parse_proc 判定 supported=true,否则监控循环会立刻退出,
          // 监控任务的启停行为就无从观察(回归测试会失去判别力)。
          if (String(info.command).includes('/proc/stat') || String(info.command).includes('__NB_DONE__')) {
            stream.write(
              'cpu  100 0 100 800 0 0 0 0 0 0\n' +
              'MemTotal: 1000000 kB\n' +
              'MemAvailable: 500000 kB\n' +
              'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
              '/dev/sda1 10000000 4000000 6000000 40% /\n' +
              '__NB_DONE__\n'
            );
            stream.exit(0);
            stream.end();
            return;
          }
          // 文件面板 cwd 探针(ssh::CWD_PROBE 含 NB_CWD 标记):模拟
          // "交互 shell 已 cd 到 ~/data" —— 用于回归"文件面板首次打开
          // 默认落在当前主机命令执行路径"。
          if (String(info.command).includes('NB_CWD')) {
            stream.write('NB_CWD /home/user/data\n');
            stream.exit(0);
            stream.end();
            return;
          }
          stream.write(`EXEC-OK:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => {});
    // —— direct-tcpip:把通道桥接到真实 TCP 目标(跳板链/本地转发的服务端行为) ——
    client.on('tcpip', (accept, reject, info) => {
      let stream = null;
      const upstream = net.connect(info.destPort, info.destIP, () => {
        stream = accept();
        upstream.pipe(stream).pipe(upstream);
        stream.on('close', die); stream.on('error', die);
      });
      const die = () => { try { upstream.destroy(); } catch { /* ignore */ } try { stream && stream.end(); } catch { /* ignore */ } };
      upstream.on('error', die); upstream.on('close', () => { if (stream) die(); });
    });
    // —— tcpip-forward:远端监听,入站连接以 forwarded-tcpip 通道回送客户端 ——
    const listenServers = new Map();
    client.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') {
        const bindAddr = info.bindAddr || '127.0.0.1';
        const srv = net.createServer((sock) => {
          // 服务端方向的 forwardOut = 向客户端打开 forwarded-tcpip 通道
          client.forwardOut(bindAddr, info.bindPort, sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, (err, chan) => {
            if (err) { sock.destroy(); return; }
            sock.pipe(chan).pipe(sock);
            const die = () => { try { sock.destroy(); } catch { /* ignore */ } try { chan.end(); } catch { /* ignore */ } };
            sock.on('error', die); sock.on('close', die); chan.on('error', die); chan.on('close', die);
          });
        });
        srv.listen(info.bindPort === 0 ? 0 : info.bindPort, '127.0.0.1', () => {
          const port = srv.address().port;
          if (accept) accept(port); // 必须先应答(accept 闭包校验 data.bindPort===0),再改写 info
          if (info.bindPort === 0) info.bindPort = port; // 回连通道携带实际分配端口
          listenServers.set(`${bindAddr}:${info.bindPort}`, srv);
          clientListenServers.push(srv);
        });
        srv.on('error', () => { if (reject) reject(); });
        return;
      }
      if (name === 'cancel-tcpip-forward') {
        const key = `${info.bindAddr || '127.0.0.1'}:${info.bindPort}`;
        const srv = listenServers.get(key);
        if (srv) { try { srv.close(); } catch { /* ignore */ } listenServers.delete(key); }
        if (accept) accept();
        return;
      }
      if (accept) accept();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  // 主机密钥指纹:SSH wire blob 的 SHA256,hex(legacy 格式)与 base64-nopad(现行)都要给 ——
  // e2e 用它预置 knownHosts 遗留记录,回归"legacy hex 指纹被误判为密钥变更"。
  // ssh2 1.16 的 utils.parseKey 不吃裸 PEM,这里从 JWK 手工拼 ssh-rsa wire blob
  // (已与 `ssh-keygen -y` 输出逐字节比对一致)。
  const jwk = crypto.createPublicKey(hostPrivateKey).export({ format: 'jwk' });
  const mpint = (b64url) => {
    let b = Buffer.from(b64url, 'base64url');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const name = Buffer.from(jwk.kty === 'RSA' ? 'ssh-rsa' : jwk.kty);
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32BE(name.length);
  const hostKeyBlob = Buffer.concat([nameLen, name, mpint(jwk.e), mpint(jwk.n)]);
  const hostFingerprintHex = crypto.createHash('sha256').update(hostKeyBlob).digest('hex');
  const hostFingerprintB64 = crypto
    .createHash('sha256')
    .update(hostKeyBlob)
    .digest('base64')
    .replace(/=+$/, '');

  return {
    port: server.address().port,
    hostPrivateKey,
    hostFingerprintHex,
    hostFingerprintB64,
    windowChanges,
    shellWrites,
    shellCommands,
    close: () => new Promise((r) => {
      for (const s of clientListenServers) { try { s.close(); } catch { /* ignore */ } }
      server.close(r);
    }),
  };
}
