// 测试用 mock SSH 服务端:密码 + 公钥认证,shell 回显并处理探测命令,支持 exec、内存版 SFTP、
// direct-tcpip(跳板 forwardOut 的对端)与 tcpip-forward(远程转发的对端)
import ssh2 from 'ssh2';
import crypto from 'node:crypto';
import net from 'node:net';

const { Server } = ssh2;
const { STATUS_CODE: SFTP_STATUS_CODE, OPEN_MODE: SFTP_OPEN_MODE } = ssh2.utils.sftp;

// 内存文件系统：path -> { type: 'dir'|'file', data: Buffer, mtime }
function makeMemFs() {
  const tree = new Map();
  const now = Math.floor(Date.now() / 1000);
  const put = (p, type, data = null) => tree.set(p, { type, data: data ? Buffer.from(data) : null, mtime: now });
  put('/', 'dir');
  put('/home', 'dir');
  put('/home/user', 'dir');
  put('/home/user/README.md', 'file', 'hello from nebula sftp\n');
  put('/home/user/data', 'dir');
  put('/home/user/data/app.log', 'file', 'x'.repeat(4096));
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
  return {
    mode: node.type === 'dir' ? 0o040755 : 0o100644,
    uid: 0, gid: 0,
    size: node.data ? node.data.length : 0,
    atime: node.mtime, mtime: node.mtime,
  };
}

// 挂载最小 SFTP 服务端：REALPATH / OPENDIR / READDIR / OPEN / READ / WRITE / CLOSE / MKDIR / RMDIR / REMOVE / STAT
function attachMockSftp(session, tree) {
  session.on('subsystem', (accept) => accept && accept()); // sftp 子系统:russh 客户端需显式请求
  session.on('sftp', (accept) => {
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
      const node = tree.get(rp);
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
          longname: (n.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--') + ' mock ' + (n.data ? n.data.length : 0),
          attrs: memFsAttrs(n),
        }));
      sftp.name(reqId, names);
    });
    sftp.on('OPEN', (reqId, p, flags, attrs) => {
      const rp = memFsResolve('/home/user', String(p));
      const node = tree.get(rp);
      const wantRead = (flags & SFTP_OPEN_MODE.READ) !== 0;
      const wantWrite = (flags & SFTP_OPEN_MODE.WRITE) !== 0 || (flags & SFTP_OPEN_MODE.CREAT) !== 0;
      const trunc = (flags & SFTP_OPEN_MODE.TRUNC) !== 0;
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
      sftp.data(reqId, slice);
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
      const node = tree.get(rp);
      if (!node) return fail(reqId, { code: 2 });
      sftp.attrs(reqId, memFsAttrs(node));
    });
    sftp.on('error', () => {});
  });
}

export async function startMockSshd({ user = 'root', password = 'test-pass-123', port = 0 } = {}) {
  const hostPrivateKey = crypto
    .generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' });
  const tree = makeMemFs();

  const clientListenServers = [];
  const windowChanges = [];
  const server = new Server({ hostKeys: [hostPrivateKey], debug: process.env.SSHD_DEBUG ? (l) => console.log('[SSHD]', l) : undefined }, (client) => {
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
        attachMockSftp(session, tree);
        session.on('pty', (ac) => ac());
        session.on('shell', (ac) => {
          const stream = ac();
          let line = '';
          stream.write('Welcome to NebulaShell mock sshd\r\n');
          stream.write('root@mock:~# ');
          stream.on('data', (d) => {
            stream.write(d); // 模拟 PTY 回显
            for (const ch of d.toString()) {
              if (ch === '\r') {
                const cmd = line.trim();
                line = '';
                if (cmd) {
                  stream.write('\r\n');
                  if (cmd === 'whoami') stream.write('root\r\n');
                  else if (cmd === 'nebula-probe') stream.write('PROBE-OK nebula-e2e\r\n');
                  else if (cmd === 'exit') { stream.end(); return; }
                  else stream.write(`bash: ${cmd}: command not found\r\n`);
                }
                stream.write('root@mock:~# ');
              } else if (ch === '\x7f') {
                line = line.slice(0, -1);
              } else {
                line += ch;
              }
            }
          });
        });
        session.on('window-change', (ac, reject, info) => {
          windowChanges.push(info); // 验证 PTY 尺寸同步(E3)
        });
        session.on('exec', (ac, reject, info) => {
          const stream = ac();
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

  return {
    port: server.address().port,
    hostPrivateKey,
    windowChanges,
    close: () => new Promise((r) => {
      for (const s of clientListenServers) { try { s.close(); } catch { /* ignore */ } }
      server.close(r);
    }),
  };
}
