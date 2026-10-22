// 平台识别:只高亮推荐行,不隐藏其他平台 —— 链接本身永远可用,
// 即使 UA 识别失败也只是少了高亮,不影响下载。
(function () {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const isMac = /Mac|iPhone|iPad/.test(platform) || /Mac OS X/.test(ua);
  const isWin = /Win/.test(platform) || /Windows/.test(ua);
  const isLinux = /Linux|X11/.test(platform) || (/Linux/.test(ua) && !/Android/.test(ua));

  let os = null;
  if (isMac) os = 'mac';
  else if (isWin) os = 'win';
  else if (isLinux) os = 'linux';

  const rows = Array.from(document.querySelectorAll('.dl-table tr[data-os]'));
  if (!os || !rows.length) return;

  // Apple Silicon 判定:WebGL 的 unmasked renderer 在 arm64 上含 "Apple"。
  // 拿不到就不猜 —— 只按 OS 高亮。
  let arch = null;
  if (os === 'mac') {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
      if (/Apple (M\d|GPU)/i.test(renderer)) arch = 'arm64';
      else if (/Intel|AMD|Radeon/i.test(renderer)) arch = 'x64';
    } catch { /* 无 WebGL:s 退回只按 OS 高亮 */ }
  }

  const matches = rows.filter((r) => r.dataset.os === os && (!r.dataset.arch || !arch || r.dataset.arch === arch));
  const pick = matches.find((r) => r.dataset.arch) || matches[0];
  if (!pick) return;
  pick.classList.add('recommended');

  const osName = { mac: 'macOS', win: 'Windows', linux: 'Linux' }[os];
  const archName = arch === 'arm64' ? ' · Apple Silicon' : arch === 'x64' ? ' · Intel' : '';
  const link = pick.querySelector('.dl-link');
  if (link) link.textContent = '推荐下载';

  const box = document.getElementById('dl-mode');
  if (box) {
    box.hidden = false;
    box.innerHTML = '';
    const lead = document.createElement('strong');
    lead.textContent = '检测到 ' + osName + archName;
    box.append(lead, document.createTextNode('，已为你在下表标出对应的安装包。'));
  }
})();
