// NebulaShell 官网交互与平台识别逻辑
// 零外部依赖 · 纯原生 JavaScript

(function () {
  // 1. 舞台 Tab 切换逻辑
  const stageTabs = document.querySelectorAll('.stage-tab');
  const stagePanels = document.querySelectorAll('.stage-panel');

  stageTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      stageTabs.forEach((t) => t.classList.remove('active'));
      stagePanels.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const activePanel = document.getElementById(`stage-panel-${target}`);
      if (activePanel) activePanel.classList.add('active');
    });
  });

  // 2. 交互式 AI 步骤折叠试玩卡片
  const foldToggle = document.getElementById('mock-fold-toggle');
  if (foldToggle) {
    const toggleFold = () => {
      foldToggle.classList.toggle('open');
      const badge = foldToggle.querySelector('.fold-badge');
      if (badge) {
        badge.textContent = foldToggle.classList.contains('open') ? '点击收起' : '点击展开查看详情';
      }
    };
    foldToggle.addEventListener('click', toggleFold);
    foldToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleFold();
      }
    });
  }

  // 3. AI 执行模式切换试玩
  const modeChips = document.querySelectorAll('.mode-chip');
  const modeDesc = document.getElementById('mode-desc-text');
  const modeLabel = document.getElementById('ai-mock-mode-label');

  const MODE_INFOS = {
    manual: {
      label: '手动确认模式',
      desc: '<strong>手动逐条确认</strong>：每条要下发的命令都弹出卡片等待审批，安全底线永远由你把控。',
    },
    auto: {
      label: '自动执行模式',
      desc: '<strong>普通命令自动执行</strong>：只读、巡检、排查命令自动下发；高危与修改类操作依然拦截确认。',
    },
    full: {
      label: '完全托管模式',
      desc: '<strong>完全托管</strong>：无断点全流程自主分析与执行，适合快速自动化批量交付。',
    },
  };

  modeChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      modeChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const m = chip.dataset.mode;
      const info = MODE_INFOS[m];
      if (info) {
        if (modeDesc) modeDesc.innerHTML = info.desc;
        if (modeLabel) modeLabel.textContent = info.label;
      }
    });
  });

  // 4. 复制命令行按钮
  document.querySelectorAll('.btn-copy-cmd').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const originalText = btn.textContent;
        btn.textContent = '已复制！';
        btn.style.color = '#3ddc97';
        btn.style.borderColor = '#3ddc97';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.color = '';
          btn.style.borderColor = '';
        }, 2000);
      } catch (err) {
        prompt('请复制以下命令：', text);
      }
    });
  });

  // 5. 平台识别与推荐下载卡片高亮
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const isMac = /Mac|iPhone|iPad/.test(platform) || /Mac OS X/.test(ua);
  const isWin = /Win/.test(platform) || /Windows/.test(ua);
  const isLinux = /Linux|X11/.test(platform) || (/Linux/.test(ua) && !/Android/.test(ua));

  let os = null;
  if (isMac) os = 'mac';
  else if (isWin) os = 'win';
  else if (isLinux) os = 'linux';

  const cards = Array.from(document.querySelectorAll('.dl-card[data-os]'));
  if (!os || !cards.length) return;

  // Apple Silicon 判定
  let arch = null;
  if (os === 'mac') {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
      if (/Apple (M\d|GPU)/i.test(renderer)) arch = 'arm64';
      else if (/Intel|AMD|Radeon/i.test(renderer)) arch = 'x64';
    } catch { /* 退回基础系统高亮 */ }
  }

  const matches = cards.filter((c) => c.dataset.os === os && (!c.dataset.arch || !arch || c.dataset.arch === arch));
  const pick = matches.find((c) => c.dataset.arch) || matches[0];
  if (!pick) return;

  pick.classList.add('recommended');

  const osName = { mac: 'macOS', win: 'Windows', linux: 'Linux' }[os];
  const archName = arch === 'arm64' ? ' · Apple Silicon' : arch === 'x64' ? ' · Intel' : '';
  const actionBtn = pick.querySelector('.dl-action-btn');
  if (actionBtn) {
    actionBtn.classList.remove('btn-secondary');
    actionBtn.classList.add('btn-primary');
    actionBtn.textContent = '优先推荐下载';
  }

  // 顶栏首屏按钮同步文本
  const heroBtnLabel = document.getElementById('hero-dl-label');
  if (heroBtnLabel) {
    heroBtnLabel.textContent = `下载 ${osName}${archName} 客户端`;
  }

  // 提示框反馈
  const detectBox = document.getElementById('dl-mode');
  const detectText = document.getElementById('dl-mode-text');
  if (detectBox && detectText) {
    detectBox.hidden = false;
    detectText.innerHTML = `已为你识别到当前操作系统：<strong>${osName}${archName}</strong>，并在下方优先高亮对应安装包。`;
  }
})();
