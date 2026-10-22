// NebulaShell 官网交互、粒子引力与动态质感引擎
// 零外部依赖 · 纯原生 JavaScript · 极致轻量硬件加速

(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // ==========================================
  // 1. 舞台 Tab 切换逻辑
  // ==========================================
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

  // ==========================================
  // 2. 交互式 AI 步骤折叠试玩卡片
  // ==========================================
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

  // ==========================================
  // 3. AI 执行模式切换试玩
  // ==========================================
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

  // ==========================================
  // 4. 复制命令行按钮
  // ==========================================
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

  // ==========================================
  // 5. 平台识别与推荐下载卡片高亮
  // ==========================================
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
  if (os && cards.length) {
    let arch = null;
    if (os === 'mac') {
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
        if (/Apple (M\d|GPU)/i.test(renderer)) arch = 'arm64';
        else if (/Intel|AMD|Radeon/i.test(renderer)) arch = 'x64';
      } catch { /* 降级 */ }
    }

    const matches = cards.filter((c) => c.dataset.os === os && (!c.dataset.arch || !arch || c.dataset.arch === arch));
    const pick = matches.find((c) => c.dataset.arch) || matches[0];
    if (pick) {
      pick.classList.add('recommended');

      const osName = { mac: 'macOS', win: 'Windows', linux: 'Linux' }[os];
      const archName = arch === 'arm64' ? ' · Apple Silicon' : arch === 'x64' ? ' · Intel' : '';
      const actionBtn = pick.querySelector('.dl-action-btn');
      if (actionBtn) {
        actionBtn.classList.remove('btn-secondary');
        actionBtn.classList.add('btn-primary');
        actionBtn.textContent = '优先推荐下载';
      }

      const heroBtnLabel = document.getElementById('hero-dl-label');
      if (heroBtnLabel) {
        heroBtnLabel.textContent = `下载 ${osName}${archName} 客户端`;
      }

      const detectBox = document.getElementById('dl-mode');
      const detectText = document.getElementById('dl-mode-text');
      if (detectBox && detectText) {
        detectBox.hidden = false;
        detectText.innerHTML = `已为你识别到当前操作系统：<strong>${osName}${archName}</strong>，并在下方优先高亮对应安装包。`;
      }
    }
  }

  // ==========================================
  // 6. 光标雷达探照灯 (Cursor Spotlight Effect)
  // ==========================================
  if (!isTouch) {
    const spotlightCards = document.querySelectorAll('.spotlight-card');
    spotlightCards.forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        card.style.setProperty('--mouse-x', `${x}px`);
        card.style.setProperty('--mouse-y', `${y}px`);
      });
    });
  }

  // ==========================================
  // 7. 首屏 3D 偏转视差 (Perspective 3D Tilt)
  // ==========================================
  const heroSection = document.getElementById('hero-section');
  const heroTiltWindow = document.getElementById('hero-tilt-window');
  const ambientGlow = document.querySelector('.ambient-glow');

  if (heroSection && heroTiltWindow && !isTouch && !reducedMotion) {
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let isHovering = false;

    heroSection.addEventListener('pointermove', (e) => {
      const rect = heroSection.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const offsetX = (e.clientX - centerX) / (rect.width / 2);
      const offsetY = (e.clientY - centerY) / (rect.height / 2);

      targetY = Math.max(-1, Math.min(1, offsetX)) * 4.5; // rotateY
      targetX = Math.max(-1, Math.min(1, offsetY)) * -4.5; // rotateX
      isHovering = true;

      // 背景光晕微量视差反向偏转
      if (ambientGlow) {
        const glowX = -offsetX * 20;
        const glowY = -offsetY * 15;
        ambientGlow.style.transform = `translate(calc(-50% + ${glowX}px), ${glowY}px)`;
      }
    });

    heroSection.addEventListener('pointerleave', () => {
      targetX = 0;
      targetY = 0;
      isHovering = false;
      if (ambientGlow) ambientGlow.style.transform = 'translateX(-50%)';
    });

    const updateTilt = () => {
      currentX += (targetX - currentX) * 0.1;
      currentY += (targetY - currentY) * 0.1;

      if (isHovering || Math.abs(currentX) > 0.05 || Math.abs(currentY) > 0.05) {
        heroTiltWindow.style.transform = `perspective(1200px) rotateX(${currentX.toFixed(2)}deg) rotateY(${currentY.toFixed(2)}deg)`;
      } else {
        heroTiltWindow.style.transform = '';
      }
      requestAnimationFrame(updateTilt);
    };
    requestAnimationFrame(updateTilt);
  }

  // ==========================================
  // 8. 原生星辰粒子引力网络 (Canvas Constellation)
  // ==========================================
  const canvas = document.getElementById('hero-particles');
  if (canvas && !reducedMotion) {
    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;
    let dpr = 1;
    let particles = [];
    let mouse = { x: -9999, y: -9999, active: false };
    let isVisible = true;

    // 视口感知暂停，节省资源
    const observer = new IntersectionObserver((entries) => {
      isVisible = entries[0].isIntersecting;
    });
    observer.observe(canvas);

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.parentElement.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      initParticles();
    };

    const initParticles = () => {
      particles = [];
      const count = Math.max(25, Math.min(55, Math.floor((width * height) / 22000)));
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.45,
          vy: (Math.random() - 0.5) * 0.45,
          radius: Math.random() * 1.5 + 0.8,
          alpha: Math.random() * 0.5 + 0.2,
          color: Math.random() > 0.4 ? '91, 140, 255' : '61, 220, 151',
        });
      }
    };

    window.addEventListener('resize', resize);
    resize();

    if (!isTouch) {
      canvas.parentElement.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
        mouse.active = true;
      });

      canvas.parentElement.addEventListener('pointerleave', () => {
        mouse.active = false;
        mouse.x = -9999;
        mouse.y = -9999;
      });
    }

    const animate = () => {
      if (isVisible) {
        ctx.clearRect(0, 0, width, height);

        // 绘制粒子与引力微吸
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];

          // 鼠标交互引力
          if (mouse.active) {
            const dx = mouse.x - p.x;
            const dy = mouse.y - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 150) {
              const force = (1 - dist / 150) * 0.6;
              p.x += (dx / dist) * force;
              p.y += (dy / dist) * force;
            }
          }

          p.x += p.vx;
          p.y += p.vy;

          if (p.x < 0) p.x = width;
          if (p.x > width) p.x = 0;
          if (p.y < 0) p.y = height;
          if (p.y > height) p.y = 0;

          // 画粒子本体
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${p.color}, ${p.alpha})`;
          ctx.fill();

          // 临近粒子星轨连线
          for (let j = i + 1; j < particles.length; j++) {
            const p2 = particles[j];
            const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
            if (dist < 110) {
              const lineAlpha = (1 - dist / 110) * 0.16;
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.strokeStyle = `rgba(91, 140, 255, ${lineAlpha})`;
              ctx.lineWidth = 0.8;
              ctx.stroke();
            }
          }
        }
      }
      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }
})();
