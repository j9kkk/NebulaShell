// AI 工具循环的界面：步骤行、确认卡、sudo 密码卡、继续询问、变更清单、主机条。
// 卡片都挂在对应步骤行里（而不是全局模态）：命令和决定始终在一起，也不与
// 模态层级、「模态打开时终端拒写」的规则互相干扰。
import { icon } from '../shared/icons.js';
import { $, api } from './core.js';
import { escapeHtml } from './hosts.js';
import { threadBusy } from './ai.js';

const TOOL_ICONS = {
  exec: 'terminal', read_terminal: 'terminal', read_file: 'file', tail_file: 'file', search_file: 'zoom',
  list_dir: 'folder', file_size: 'info', read_journal: 'listChecks', host_info: 'info',
};
const LOG_MAX = 200_000;

// toolRunId → 步骤 DOM，ai:tool-output 按它路由。
const runs = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function btn(text, cls) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

export function stepTitle(step) {
  const a = step.args || {};
  switch (step.tool) {
    case 'exec': return ['执行', a.cmd || ''];
    case 'read_file': return ['读取', (a.path || '') + (a.offset ? `（第 ${a.offset} 字节起）` : '')];
    case 'tail_file': return ['查看末尾', (a.path || '') + (a.lines ? ` · ${a.lines} 行` : '')];
    case 'search_file': return ['搜索', `${a.path || ''} · “${a.pattern ?? ''}”`];
    case 'list_dir': return ['列出目录', a.path || ''];
    case 'file_size': return ['查看大小', a.path || ''];
    case 'read_journal': return ['读取系统日志', [a.unit, a.since, a.grep].filter(Boolean).join(' · ')];
    case 'host_info': return ['识别主机环境', ''];
    case 'read_terminal': return ['读取终端', a.lines ? `最近 ${a.lines} 行` : '最近输出'];
    default: return [step.tool, ''];
  }
}

function fmtSecs(ms) {
  return ms >= 10_000 ? Math.round(ms / 1000) + ' 秒' : (ms / 1000).toFixed(1) + ' 秒';
}

/// 授权条目：后端给数组（一条命令可同时命中下载、修改文件等多类），每条 {rule, label, keys}。
function grantItems(v) {
  return (Array.isArray(v) ? v : v ? [v] : []).filter((a) => a?.keys?.length);
}

function grantText(items, sep = ' · ') {
  return items.map((a) => `${a.label}${sep}${a.keys.join('、')}`).join('；');
}

/// 只在用户正在 AI 面板里操作时抢焦点：用户在终端里打字时弹出卡片不能吞掉按键。
function aiPanelFocused() {
  const panel = $('#ai-panel');
  return !!(panel && document.activeElement && panel.contains(document.activeElement));
}

export function routeToolOutput({ toolRunId, chunk }) {
  const refs = runs.get(toolRunId);
  if (!refs || !chunk) return;
  refs.streamed = true;
  if (refs.body.hidden) {
    refs.body.hidden = false;
    refs.head.setAttribute('aria-expanded', 'true');
  }
  let text = refs.log.textContent + chunk;
  if (text.length > LOG_MAX) text = '…（前面的输出已省略）\n' + text.slice(-LOG_MAX);
  refs.log.textContent = text;
  refs.log.scrollTop = refs.log.scrollHeight;
  refs.onGrow?.();
}

export function createAgentAdapter({ mount, onGrow, isActive, setPending, onRunAndAuto, canAllow, onAllowAlways, audit, canUseSaved }) {
  const steps = new Map();

  const stateText = (refs, text, cls = '') => {
    refs.state.textContent = text;
    refs.state.className = 'ai-step-state' + (cls ? ' ' + cls : '');
  };

  const clearTicker = (refs) => {
    clearInterval(refs.timer);
    refs.timer = 0;
  };

  const attachCard = (refs, card, focusTarget) => {
    refs.card.replaceChildren(card);
    refs.root.dataset.status = 'pending';
    onGrow?.();
    if (aiPanelFocused()) (focusTarget || card).focus?.();
    if (!isActive?.()) setPending?.(true, true);
    else setPending?.(true, false);
  };

  const settleCard = (refs, note, cls = '') => {
    refs.card.replaceChildren(note ? el('div', 'ai-card-done' + (cls ? ' ' + cls : ''), note) : '');
    refs.root.dataset.status = 'running';
    setPending?.(false);
  };

  return {
    stepStart(step) {
      const root = el('div', 'ai-step');
      root.dataset.tool = step.tool;
      root.dataset.status = 'running';
      const head = btn(null, 'ai-step-head');
      head.setAttribute('aria-expanded', 'false');
      const ic = el('span', 'ai-step-icon');
      ic.innerHTML = icon(TOOL_ICONS[step.tool] || 'zap', { size: 14 });
      const [verb, detail] = stepTitle(step);
      const title = el('span', 'ai-step-title');
      const detailEl = el('code', 'ai-step-detail', detail);
      title.append(el('span', 'ai-step-verb', verb), detailEl);
      const state = el('span', 'ai-step-state', '进行中…');
      head.append(ic, title, state);
      const body = el('div', 'ai-step-body');
      body.hidden = true;
      const log = el('pre', 'ai-step-log');
      body.append(log);
      const card = el('div', 'ai-step-card');
      root.append(head, card, body);
      head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        head.setAttribute('aria-expanded', String(!body.hidden));
      });
      const refs = { root, head, detailEl, state, body, log, card, started: Date.now(), timer: 0, onGrow };
      steps.set(step.id, refs);
      mount(root);
    },

    stepRun(step, toolRunId) {
      const refs = steps.get(step.id);
      if (!refs) return;
      runs.set(toolRunId, refs);
      refs.runId = toolRunId;
      refs.started = Date.now();
      if (step.tool !== 'exec') return;
      clearTicker(refs);
      const stop = btn(null, 'ai-step-stop');
      stop.title = '停止这条命令';
      stop.innerHTML = icon('stop', { size: 12 });
      stop.addEventListener('click', (e) => {
        e.stopPropagation();
        api('ai:tool-cancel', { toolRunId }).catch(() => {});
        stop.disabled = true;
      });
      const tick = () => stateText(refs, '运行中 ' + fmtSecs(Date.now() - refs.started));
      tick();
      refs.timer = setInterval(tick, 1000);
      refs.state.after(stop);
      refs.stopBtn = stop;
    },

    stepUpdate(step) {
      const refs = steps.get(step.id);
      if (refs) refs.detailEl.textContent = stepTitle(step)[1];
    },

    stepEnd(step, res) {
      const refs = steps.get(step.id);
      if (!refs) return;
      clearTicker(refs);
      refs.stopBtn?.remove();
      if (refs.runId) runs.delete(refs.runId);
      const status = res.status === 'done' ? (step.tool === 'exec' && res.exitCode && res.exitCode !== 0 ? 'warn' : 'ok') : res.status;
      refs.root.dataset.status = status;
      const took = res.durationMs != null ? ' · ' + fmtSecs(res.durationMs) : '';
      if (res.status === 'done') {
        stateText(refs, step.tool === 'exec' ? `退出码 ${res.exitCode ?? '—'}${took}` : '完成', status === 'warn' ? 'warn' : 'ok');
      } else if (res.status === 'skipped') {
        stateText(refs, res.reason === 'sudo' ? '未输入密码' : '已跳过', 'muted');
      } else if (res.status === 'aborted') {
        stateText(refs, '已中止', 'muted');
      } else {
        stateText(refs, res.message || '失败', 'error');
      }
      const text = [res.output, res.note].filter(Boolean).join('\n');
      if (text) refs.log.textContent = text;
      // 按会话授权免确认执行的命令要能一眼看出来（可追溯，也提醒授权仍在生效）。
      const whitelisted = grantItems(res.whitelisted);
      if (whitelisted.length) {
        const tag = el('span', 'ai-step-tag', '按授权');
        tag.title = `按会话授权自动执行：${grantText(whitelisted)}`;
        refs.state.before(tag);
      }
      if (!text && !refs.streamed) refs.body.hidden = true;
      else if (status === 'ok') {
        refs.body.hidden = true;
        refs.head.setAttribute('aria-expanded', 'false');
      }
      if (refs.card.querySelector('.ai-confirm, .ai-sudo')) settleCard(refs, '');
      onGrow?.();
    },

    requestConfirm(p) {
      const refs = steps.get(p.step?.id);
      if (!refs) return Promise.resolve({ decision: 'skip' });
      return new Promise((resolve) => {
        const tier = p.tier || 'normal';
        const card = el('div', `ai-confirm tier-${tier}`);
        card.tabIndex = -1;
        card.setAttribute('role', 'group');
        const head = el('div', 'ai-confirm-head');
        head.innerHTML = icon(tier === 'normal' ? 'info' : 'alert', { size: 14 });
        const titles = { normal: p.forceConfirm ? '无法识别主机系统，需要你确认' : '确认后执行', egress: '访问外部网络，需要你确认', danger: '高危操作，需要你确认' };
        head.append(el('span', null, titles[tier] || titles.normal));
        const meta = el('div', 'ai-confirm-meta', [p.host && '主机 ' + p.host, p.cwd && '目录 ' + p.cwd].filter(Boolean).join(' · '));
        if (p.asRoot) meta.append(el('span', 'ai-root-badge', 'root'));
        const cmd = el('pre', 'ai-confirm-cmd', p.cmd);
        card.append(head, meta, cmd);
        if (p.reasons?.length) {
          const ul = el('ul', 'ai-confirm-reasons');
          for (const r of p.reasons) ul.append(el('li', null, r));
          card.append(ul);
        }
        // 后端复核出的实际作用对象：要结束的进程、模拟出的卸载集合（含连带卸载）。
        if (p.procs?.length) card.append(el('div', 'ai-confirm-targets', '将结束：' + p.procs.map((x) => `${x.name}（${x.pid}）`).join('、')));
        if (p.pkgs?.length) card.append(el('div', 'ai-confirm-targets', '将卸载：' + p.pkgs.join('、')));
        if (p.preview) {
          const pv = el('div', 'ai-confirm-preview');
          pv.append(el('div', 'ai-confirm-preview-title', '影响范围（只读预览）'), el('pre', null, p.preview.output || '（无输出）'));
          card.append(pv);
        }
        const actions = el('div', 'ai-confirm-actions');
        const run = btn(tier === 'danger' ? '确认执行' : '执行', tier === 'danger' ? 'btn danger' : 'btn primary');
        const edit = btn('改后执行', 'btn');
        const skip = btn('跳过', 'btn');
        const skipWhy = btn('跳过并说明原因', 'btn ghost');
        const baseActions = [run, edit, skip, skipWhy];
        if (tier === 'normal' && !p.forceConfirm && onRunAndAuto) {
          const auto = btn('执行并切到自动', 'btn ghost');
          auto.addEventListener('click', () => { onRunAndAuto(); done({ decision: 'run' }, '已执行，并切换到自动模式'); });
          baseActions.push(auto);
        }
        // 会话授权（仅自动模式）：后端判定这类命令可授权才给 allowable；
        // 差一点可授权时给 allowBlocked，说明为什么不能「总是允许」。
        const allowHere = !!canAllow?.();
        const grants = grantItems(p.allowable);
        if (allowHere && grants.length) {
          const always = btn(`本会话总是允许：${grantText(grants)}`, 'btn ghost ai-confirm-allow');
          always.title = grants.some((a) => a.rule !== 'egress.download')
            ? '授权后，本会话内此范围的同类操作将直接执行，无法撤销（仅本会话、本主机有效，可在执行模式菜单里撤销授权）。'
            : '之后在自动模式下，对这些站点的同类下载直接执行（仅本会话、本主机有效，可在执行模式菜单里撤销）。\n'
              + '仅在信任该站点运营方时使用：AI 可能把读到的内容写进访问地址。';
          always.addEventListener('click', () => {
            onAllowAlways?.(grants);
            done({ decision: 'run' }, `已执行，并授权本会话自动${grantText(grants, '：')}`);
          });
          baseActions.push(always);
        } else if (allowHere && p.allowBlocked) {
          card.append(el('div', 'ai-confirm-hint', `这条命令不能设为「总是允许」：${p.allowBlocked}`));
        }
        actions.append(...baseActions);
        card.append(actions);

        const onAbort = () => done(null, '已中止');
        function done(decision, note) {
          p.signal?.removeEventListener?.('abort', onAbort);
          settleCard(refs, note, decision?.decision === 'skip' ? 'muted' : '');
          resolve(decision);
        }
        p.signal?.addEventListener?.('abort', onAbort, { once: true });
        run.addEventListener('click', () => done({ decision: 'run' }, '已确认执行'));
        skip.addEventListener('click', () => done({ decision: 'skip' }, '已跳过'));
        skipWhy.addEventListener('click', () => {
          const input = el('input', 'ai-confirm-input');
          input.placeholder = '跳过原因（会告诉 AI），回车确认';
          const ok = btn('确认跳过', 'btn');
          const submit = () => done({ decision: 'skip', reason: input.value.trim() }, '已跳过' + (input.value.trim() ? '：' + input.value.trim() : ''));
          ok.addEventListener('click', submit);
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
          actions.replaceChildren(input, ok, skip);
          input.focus();
        });
        edit.addEventListener('click', () => {
          const area = el('textarea', 'ai-confirm-edit');
          area.value = p.cmd;
          area.rows = Math.min(6, Math.max(2, p.cmd.split('\n').length));
          cmd.replaceWith(area);
          const apply = btn('执行修改后的命令', 'btn primary');
          const cancel = btn('取消修改', 'btn');
          apply.addEventListener('click', () => {
            const v = area.value.trim();
            if (v) done({ decision: 'edit', cmd: v }, v === p.cmd ? '已确认执行' : '已改为：' + v);
          });
          cancel.addEventListener('click', () => { area.replaceWith(cmd); actions.replaceChildren(...baseActions); });
          actions.replaceChildren(apply, cancel);
          area.focus();
        });
        // 普通档：焦点落在「执行」上，回车即执行；高危/外联档没有默认按钮，回车无效。
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); done({ decision: 'skip' }, '已跳过'); }
        });
        attachCard(refs, card, tier === 'normal' ? run : card);
      });
    },

    requestSudoPassword(p) {
      const refs = steps.get(p.step?.id);
      if (!refs) return Promise.resolve(null);
      return new Promise((resolve) => {
        const card = el('div', 'ai-sudo');
        const head = el('div', 'ai-confirm-head');
        head.innerHTML = icon('lock', { size: 14 });
        head.append(el('span', null, `命令需要 sudo 密码${p.host ? '（' + p.host + '）' : ''}`));
        card.append(head);
        if (p.error) card.append(el('div', 'ai-sudo-error', p.error));
        const row = el('div', 'ai-sudo-row');
        const input = el('input', 'ai-confirm-input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.placeholder = '输入 sudo 密码，回车确认';
        const rememberLabel = el('label', 'switch ai-sudo-remember');
        const remember = el('input');
        remember.type = 'checkbox';
        const slider = el('span', 'switch-slider');
        const label = el('span', 'switch-label', '本会话记住（仅内存）');
        rememberLabel.append(remember, slider, label);
        row.append(input, rememberLabel);
        const actions = el('div', 'ai-confirm-actions');
        const ok = btn('确定', 'btn primary');
        const cancel = btn('取消', 'btn');
        actions.append(ok);
        if (canUseSaved?.()) {
          const saved = btn('使用已保存的登录密码', 'btn');
          saved.addEventListener('click', () => done({ useSaved: true, remember: remember.checked }, '使用已保存的登录密码'));
          actions.append(saved);
        }
        actions.append(cancel);
        card.append(row, el('div', 'ai-sudo-hint', '密码只交给 sudo，不会发送给 AI，也不会写入日志。'), actions);
        const onAbort = () => done(null, '已中止');
        function done(v, note) {
          p.signal?.removeEventListener?.('abort', onAbort);
          input.value = '';
          settleCard(refs, note, v ? '' : 'muted');
          resolve(v);
        }
        p.signal?.addEventListener?.('abort', onAbort, { once: true });
        const submit = () => { if (input.value) done({ password: input.value, remember: remember.checked }, '已提交 sudo 密码'); };
        ok.addEventListener('click', submit);
        cancel.addEventListener('click', () => done(null, '已取消'));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.preventDefault(); done(null, '已取消'); }
        });
        attachCard(refs, card, input);
      });
    },

    confirmContinue(n) {
      return new Promise((resolve) => {
        const card = el('div', 'ai-turn-card');
        card.append(el('div', null, `AI 已连续执行 ${n} 个步骤，是否继续？`));
        const actions = el('div', 'ai-confirm-actions');
        const go = btn('继续', 'btn primary');
        const stop = btn('到此为止', 'btn');
        actions.append(go, stop);
        card.append(actions);
        const done = (v) => { card.replaceChildren(el('div', 'ai-card-done', v ? '已继续' : '已停止继续执行')); setPending?.(false); resolve(v); };
        go.addEventListener('click', () => done(true));
        stop.addEventListener('click', () => done(false));
        mount(card);
        setPending?.(true, !isActive?.());
        if (aiPanelFocused()) go.focus();
      });
    },

    turnSummary({ execs, status }) {
      const card = el('div', 'ai-turn-card ai-turn-summary');
      card.append(el('div', 'ai-turn-summary-title', `本轮执行记录（${execs.length} 条命令${status === 'aborted' ? '，已中止' : ''}）`));
      const ul = el('ul');
      const label = (e) => {
        if (e.decision === 'skipped') return '已跳过' + (e.reason ? '：' + e.reason : '');
        if (e.status === 'aborted') return '已中止';
        if (e.status === 'error') return '失败';
        return '退出码 ' + (e.exitCode ?? '—') + (e.decision === 'edited' ? '（改后执行）' : '');
      };
      for (const e of execs) {
        const li = el('li');
        li.dataset.state = e.decision === 'skipped' ? 'skipped' : e.status === 'done' && !e.exitCode ? 'ok' : 'warn';
        li.append(el('code', null, e.cmd), el('span', null, label(e)));
        ul.append(li);
      }
      card.append(ul);
      mount(card);
    },

    audit,
  };
}

/// 执行模式选择器:触发钮只显示档位名称(「手动确认」或「自动执行」),常驻显示。
/// 「不操作主机 / 作用于哪些主机」归顶栏主机下拉,这里不再重复。
const MODES = [
  { id: 'manual', icon: 'lock', title: '手动确认', desc: '执行命令前先向你确认' },
  { id: 'auto', icon: 'zap', title: '自动执行', desc: '普通命令自动执行，高危和外联仍会确认' },
];
const MODE_TITLES = Object.fromEntries(MODES.map((m) => [m.id, m.title]));
// 「?」帮助浮层的内容：两档沿用菜单图标；主机安全逐条配图标，会外发数据的那条用警示色。
const MODE_HELP = {
  modes: {
    manual: '每条命令先展示给你，确认后才执行。',
    auto: '普通命令直接执行；高危、外联、覆盖文件的命令仍会停下来确认。',
  },
  footnote: '这个对话作用于哪些主机，请在顶栏的主机下拉里选择（对话模式 / 跟随命令窗口 / 多主机）。',
  grant: '下载、修改或删除文件、结束进程、卸载软件包可在确认卡上「本会话总是允许」（按站点、目录、进程名或包名）。之后同类操作直接执行、无法撤销；授权可在本菜单撤销。多主机模式下不提供「总是允许」，每条命令都单独确认。',
  security: [
    { icon: 'terminal', text: '命令只会发送到本对话已链接的主机（服务端二次校验，模型无法指定其他会话）。' },
    { icon: 'key', text: 'sudo 密码与 SSH 登录凭据不会发送给 AI。' },
    { icon: 'alert', warn: true, text: '命令输出和读取的文件内容会发送给 AI 模型。发送前自动脱敏常见的密钥、令牌与密码格式，但无法保证识别所有敏感信息。' },
  ],
};

function iconBox(cls, name, size) {
  const box = el('span', cls);
  box.innerHTML = icon(name, { size });
  return box;
}

function renderModeHelp(pop) {
  const head = el('div', 'mh-head');
  head.append(el('div', 'mh-title', '执行模式'), el('div', 'mh-sub', '决定 AI 能否在你的主机上执行命令'));
  const modes = el('div', 'mh-list');
  for (const m of MODES) {
    const body = el('div', 'mh-body');
    body.append(el('div', 'mh-name', m.title), el('div', 'mh-desc', MODE_HELP.modes[m.id]));
    if (m.id === 'auto') {
      const note = el('div', 'mh-note');
      note.append(iconBox('mh-note-icon', 'checkCircle', 12), el('span', null, MODE_HELP.grant));
      body.append(note);
    }
    const row = el('div', `mh-row mh-mode-${m.id}`);
    row.append(iconBox('mh-icon', m.icon, 13), body);
    modes.append(row);
  }
  if (MODE_HELP.footnote) {
    const fn = el('div', 'mh-desc', MODE_HELP.footnote);
    fn.style.padding = '4px 8px';
    fn.style.color = 'var(--muted)';
    fn.style.fontSize = '11px';
    modes.append(fn);
  }
  const section = el('div', 'mh-section');
  section.append(iconBox('mh-section-icon', 'lock', 12), el('span', null, '主机安全'));
  const security = el('div', 'mh-list');
  for (const s of MODE_HELP.security) {
    const row = el('div', 'mh-row mh-sec' + (s.warn ? ' warn' : ''));
    row.append(iconBox('mh-icon', s.icon, 13), el('div', 'mh-desc', s.text));
    security.append(row);
  }
  pop.replaceChildren(head, modes, section, security);
}

let helpHideTimer = null;

/// 悬停/聚焦「?」立即展开（原生 title 有延迟）。优先放在菜单左侧——输入区在 AI 面板里，
/// 面板多贴窗口右侧；左右都放不下就放到菜单上方。
export function showModeHelp() {
  const pop = $('#ai-mode-help-pop');
  const menu = $('#ai-mode-menu');
  if (!pop || !menu || menu.classList.contains('hidden')) return;
  clearTimeout(helpHideTimer);
  if (!pop.childElementCount) renderModeHelp(pop);
  pop.classList.remove('hidden');
  const mr = menu.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitsLeft = mr.left - w - gap >= gap;
  const fitsRight = mr.right + gap + w <= vw - gap;
  let left;
  let top;
  if (fitsLeft || fitsRight) {
    left = fitsLeft ? mr.left - w - gap : mr.right + gap;
    top = Math.min(mr.top, vh - h - gap);
  } else {
    left = Math.min(mr.left, vw - w - gap);
    top = mr.top - h - gap >= gap ? mr.top - h - gap : Math.min(mr.bottom + gap, vh - h - gap);
  }
  pop.style.left = Math.max(gap, left) + 'px';
  pop.style.top = Math.max(gap, top) + 'px';
}

/// 移开指针时稍等再收起，留出从「?」移进浮层的时间。
export function hideModeHelp({ delay = 0 } = {}) {
  clearTimeout(helpHideTimer);
  const hide = () => $('#ai-mode-help-pop')?.classList.add('hidden');
  if (delay) helpHideTimer = setTimeout(hide, delay);
  else hide();
}

// 最近一次渲染的选择器信息与选中回调:菜单开合/选中由 entry.js 的事件调用,
// 状态留在本模块,entry 不持有跨模块变量。
let lastPickerInfo = null;
let pickerHandlers = {};

export function selectMode(mode) {
  pickerHandlers.onSelectMode?.(mode);
}

export function revokeGrant(index) {
  pickerHandlers.onRevoke?.(index);
}

export function updateModePicker(info, { onSelectMode, onRevoke } = {}) {
  const trigger = $('#ai-mode-trigger');
  if (!trigger) return;
  if (info) {
    lastPickerInfo = info;
    if (onSelectMode) pickerHandlers = { onSelectMode, onRevoke };
  }
  // 常驻显示:档位与"作用于哪台主机"解耦后,任何时候都能看到/切换执行模式。
  const mode = info?.mode || 'manual';
  trigger.hidden = false;
  trigger.dataset.mode = mode;
  trigger.dataset.locked = info?.modeLocked ? 'true' : 'false';
  trigger.dataset.degraded = info?.warn ? 'true' : 'false';
  $('#ai-mode-name').textContent = MODE_TITLES[mode] || mode;

  const iconWrap = trigger.querySelector('.ai-mode-icon');
  if (iconWrap) iconWrap.innerHTML = icon(MODES.find((m) => m.id === mode)?.icon || 'lock', { size: 13 });

  const grants = info?.grants?.length ? `\n本会话已授权 ${info.grants.length} 项（点击查看或撤销）` : '';
  const host = info?.hostSummary ? `\n作用于：${info.hostSummary}` : '';
  trigger.title = info?.warn
    ? info.warn
    : info?.modeLocked
      ? `执行模式：${MODE_TITLES[mode]}（该主机设置为只允许手动确认）\n点击查看/切换执行模式`
      : `执行模式：${MODE_TITLES[mode]}${host}\n点击切换执行模式${grants}`;
  trigger.disabled = !!info?.disabled;

  // 菜单若开着，同步刷新（线程/绑定变化时）
  if (!$('#ai-mode-menu').classList.contains('hidden')) renderModeMenu(lastPickerInfo);
}

/// 「本会话已授权」：逐项可撤销。授权只在自动模式生效，手动/对话模式下仅作展示。
function renderGrants(info) {
  const box = $('#ai-mode-grants');
  if (!box) return;
  const grants = info.grants || [];
  box.hidden = !grants.length;
  box.replaceChildren();
  if (!grants.length) return;
  const head = el('div', 'ai-mode-grants-title', info.mode === 'auto' ? '本会话已授权' : '本会话已授权（切到自动执行后生效）');
  box.append(head);
  grants.forEach((g, i) => {
    const row = el('div', 'ai-mode-grant');
    row.append(el('span', 'ai-mode-grant-name', `${g.label || '下载'} · ${g.key}`));
    const revoke = btn(null, 'ai-mode-grant-revoke');
    revoke.innerHTML = icon('x', { size: 12 });
    revoke.title = '撤销这项授权';
    revoke.setAttribute('aria-label', `撤销授权：${g.label || '下载'} · ${g.key}`);
    revoke.dataset.revoke = String(i);
    row.append(revoke);
    box.append(row);
  });
}

export function renderModeMenu(info) {
  const list = $('#ai-mode-menu-list');
  if (!list) return;
  // 第一行左对齐显示本对话的主机摘要(未链接主机 / 已链接 X / 已链接 N 台主机)。
  const ctx = $('#ai-mode-menu-ctx');
  ctx.innerHTML = '';
  ctx.textContent = info?.hostSummary || '未链接主机';
  if (info?.isRoot) {
    ctx.append(Object.assign(document.createElement('span'), { className: 'ai-root-badge', textContent: 'root' }));
  }
  list.innerHTML = '';
  for (const m of MODES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ai-mode-menu-item' + (m.id === info.mode ? ' active' : '');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', m.id === info.mode ? 'true' : 'false');
    item.dataset.mode = m.id;
    const ic = document.createElement('span');
    ic.className = 'mi';
    ic.innerHTML = icon(m.icon, { size: 14 });
    const body = document.createElement('span');
    body.className = 'mode-item-body';
    const title = document.createElement('span');
    title.className = 'mode-item-title';
    title.append(Object.assign(document.createElement('span'), { textContent: m.title }));
    title.append(Object.assign(document.createElement('span'), { className: 'check', textContent: '✓' }));
    body.append(title);
    body.append(Object.assign(document.createElement('span'), { className: 'mode-item-desc', textContent: m.desc }));
    if (m.id === 'auto' && info.modeLocked) {
      item.disabled = true;
      body.append(Object.assign(document.createElement('span'), { className: 'mode-item-lock', textContent: '该主机设置为只允许手动确认' }));
    }
    item.append(ic, body);
    list.append(item);
  }
  renderGrants(info);
}

function anchorMenu(menu, trigger, { placement = 'bottom', width = 260, height = 240, gap = 4 } = {}) {
  if (!menu || !trigger) return;
  const tr = trigger.getBoundingClientRect();
  const w = menu.offsetWidth || width;
  const h = menu.offsetHeight || height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(tr.left, vw - w - 8));
  let top = placement === 'top'
    ? Math.max(8, tr.top - h - gap)
    : Math.min(vh - h - 8, tr.bottom + gap);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function menuKeydown(e, menu, itemSelector, { onClose } = {}) {
  if (!e || !menu || menu.classList.contains('hidden')) return;
  const key = e.key;
  if (key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    onClose?.({ focusTrigger: true });
    return;
  }
  if (key === 'Tab') {
    onClose?.();
    return;
  }
  const items = Array.from(menu.querySelectorAll(itemSelector));
  if (!items.length) return;
  const activeEl = document.activeElement;
  const currentIndex = items.indexOf(activeEl);
  if (key === 'ArrowDown' || key === 'Down') {
    e.preventDefault();
    items[(currentIndex + 1) % items.length]?.focus();
  } else if (key === 'ArrowUp' || key === 'Up') {
    e.preventDefault();
    items[(currentIndex - 1 + items.length) % items.length]?.focus();
  } else if ((key === 'Enter' || key === ' ') && items.includes(activeEl)) {
    e.preventDefault();
    activeEl.click();
  }
}

export function openModeMenu(info = lastPickerInfo) {
  const menu = $('#ai-mode-menu');
  const trigger = $('#ai-mode-trigger');
  if (!menu || !trigger || trigger.disabled) return;
  $('#ai-model-menu')?.classList.add('hidden');
  $('#ai-thread-menu')?.classList.add('hidden');
  $('#ai-target-menu')?.classList.add('hidden');
  if (info) lastPickerInfo = info;
  renderModeMenu(lastPickerInfo);
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  anchorMenu(menu, trigger, { placement: 'top', width: 240, height: 220 });
  const active = menu.querySelector('.ai-mode-menu-item.active');
  if (active) active.focus();
}

export function closeModeMenu({ focusTrigger = false } = {}) {
  const menu = $('#ai-mode-menu');
  const trigger = $('#ai-mode-trigger');
  hideModeHelp();
  if (menu) menu.classList.add('hidden');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger && typeof trigger.focus === 'function') trigger.focus();
  }
}

export function toggleModeMenu() {
  const menu = $('#ai-mode-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openModeMenu();
  else closeModeMenu();
}

export function onModeMenuKeydown(e) {
  const menu = $('#ai-mode-menu');
  menuKeydown(e, menu, '.ai-mode-menu-item:not(:disabled)', { onClose: closeModeMenu });
}

// -------------------------------------------------------------
// Ops Target Bar 目标作用域看板、跨标签智能感知横条与目标选择菜单
// -------------------------------------------------------------

let targetHandlers = {};

/// 顶栏主机链接钮:文案 = hostSummary(未链接主机 / 已链接 X / 已链接 N 台主机),
/// 前导为状态点,右侧语境动作(连接/重连)。点击开合菜单由 entry.js 绑定。
export function updateTargetBar(view, handlers = {}) {
  const trigger = $('#ai-target-trigger');
  if (!trigger) return;
  if (!view) {
    trigger.disabled = true;
    return;
  }
  trigger.disabled = false;
  trigger.dataset.tone = view.tone || 'idle';
  trigger.dataset.connected = (view.kind === 'bound' || view.kind === 'multi') ? 'true' : 'false';
  trigger.title = `${view.ariaLabel || 'AI 操作目标'}\n点击选择作用主机`;
  trigger.setAttribute('aria-label', view.ariaLabel || 'AI 操作目标');

  const lead = $('#ai-target-lead');
  if (lead) {
    if (view.linkMode === 'chat') lead.innerHTML = icon('messageSquare', { size: 12 });
    else lead.innerHTML = `<span class="dot ${view.tone || 'idle'}"></span>`;
  }

  const name = $('#ai-target-name');
  if (name) name.textContent = view.hostSummary || '未链接主机';

  const actionBtn = $('#ai-target-action');
  if (actionBtn) {
    if (view.actionText) {
      actionBtn.textContent = view.actionText;
      actionBtn.classList.remove('hidden');
      actionBtn.onclick = (e) => { e.stopPropagation(); handlers.onAction?.(); };
    } else {
      actionBtn.classList.add('hidden');
      actionBtn.onclick = null;
    }
  }
}

/// 顶栏主机菜单:三种互斥模式(各带 switch) + 多主机清单。
///   menuData = {
///     notice?, linkMode, disabled,
///     chat: {checked}, follow: {checked, hostLabel}, multi: {checked, showHosts},
///     hosts: [{ hostId, name, address, linked, status, error, disabled }],
///     query, linkCount,
///   }
/// 选择模式/切换开关都回调 handlers(onSelectMode / onToggleHost / onClearHosts / onSearch)。
///
/// 菜单内的任何点击都不收起菜单:调模式、开主机开关后原地重绘,用户可以连续操作。
/// 收起只发生在:点菜单外、Esc、再点一次触发钮。
export function renderTargetMenu(menuData, handlers = {}, { focusMode, focusHostId } = {}) {
  const list = $('#ai-target-menu-list');
  if (!list) return;
  if (handlers && Object.keys(handlers).length) targetHandlers = { ...targetHandlers, ...handlers };

  const data = menuData || {};
  // 结构没变时只更新状态,不重建 DOM —— 否则 switch 的轨道/滑块换成了全新节点,
  // 刚点下去的那次过渡就丢了(表现为"第一次点没有果冻,第二次才有")。
  if (patchTargetMenu(list, data)) {
    if (focusHostId) {
      list.querySelector(`.ai-target-host[data-host-id="${CSS.escape(focusHostId)}"] input`)?.focus();
    } else if (focusMode) {
      list.querySelector(`.ai-target-mode[data-mode="${focusMode}"]`)?.focus();
    }
    return;
  }

  list.replaceChildren();

  if (data.notice) list.append(el('div', 'ai-target-menu-note', data.notice));

  const modeOn = (id) => !!data[id]?.checked;

  // 三种模式互斥:优雅的单选卡片交互(Radio 单选指示器)。
  // 顶层三模式 N 选 1,任意时刻必须且只能选择其中一种,整行点击即切换;
  // 已激活的模式再次点击保持激活(单选规范),彻底解决 Switch 误导「可以全部关闭」的认知矛盾。
  const modeRow = (modeId, iconName, label, desc) => {
    const on = modeOn(modeId);
    const row = el('div', 'ai-target-mode' + (on ? ' is-on' : ''));
    row.dataset.mode = modeId;
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', on ? 'true' : 'false');
    row.tabIndex = -1;
    if (data.disabled) row.setAttribute('aria-disabled', 'true');
    const ic = el('span', 'mi');
    ic.innerHTML = icon(iconName, { size: 14 });
    const body = el('span', 'ai-target-mode-body');
    body.append(el('span', 'ai-target-mode-name', label), el('span', 'ai-target-mode-desc', desc));
    row.append(ic, body);
    const radio = el('span', 'ai-target-mode-radio');
    row.append(radio);

    // 整行可点 = 单选切到这个模式(已是当前模式点击保持原状,不取消)。
    const isOnNow = () => row.getAttribute('aria-checked') === 'true';
    const isDisabledNow = () => row.getAttribute('aria-disabled') === 'true';
    row.addEventListener('click', () => {
      if (isDisabledNow() || isOnNow()) return;
      targetHandlers.onSelectMode?.(modeId);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      row.click();
    });
    return row;
  };

  // 1. 对话模式
  list.append(modeRow('chat', 'messageSquare', '对话模式', '不链接任何主机，只回答不操作'));

  // 2. 跟随命令窗口(描述实时显示跟随到哪台主机)
  const followDesc = data.follow?.hostLabel
    ? `已链接 ${data.follow.hostLabel}`
    : '跟随当前命令窗口的主机';
  list.append(modeRow('follow', 'terminal', '跟随命令窗口', followDesc));

  // 3. 多主机模式(启用后才展开清单)
  list.append(modeRow(
    'multi', 'plug', '多主机模式',
    data.linkCount > 0 ? `已链接 ${data.linkCount} 台主机` : '批量链接多台主机统一管理',
  ));

  if (data.multi?.showHosts) {
    list.append(renderHostList(data, handlers));
  }

  renderTargetFooter(list, data, handlers);

  // 重绘后把焦点放回刚操作过的那一项,键盘/鼠标连续操作不丢位置。
  if (focusHostId) {
    const sw = list.querySelector(`.ai-target-host[data-host-id="${CSS.escape(focusHostId)}"] input`);
    sw?.focus();
  } else if (focusMode) {
    list.querySelector(`.ai-target-mode[data-mode="${focusMode}"]`)?.focus();
  }
}

/// 把已存在行上的 switch 更新成目标状态,而不是重建 DOM。
/// 重建会让轨道/滑块变成全新节点,浏览器没有"旧值 → 新值"可插值,
/// 果冻过渡在首次点击时就播不出来(第二次才正常,因为节点换成了刚建好的那批)。
/// 返回 true 表示成功就地更新(结构未变)。
function syncSwitch(row, checked, disabled) {
  const input = row?.querySelector?.('.switch input');
  if (!input) return false;
  if (input.checked !== checked) input.checked = checked;
  if (input.disabled !== disabled) input.disabled = disabled;
  return true;
}

/// 在多主机模式开启时把清单+页脚插到模式行之后(不重建模式行,保住 switch 动画)。
function insertHostBlock(list, data) {
  const rows = [...list.querySelectorAll('.ai-target-mode')];
  const anchor = rows[rows.length - 1];
  const hostEl = renderHostList(data, {});
  const footNodes = buildTargetFooter(data, {});
  const after = anchor ? anchor.nextSibling : null;
  list.insertBefore(hostEl, after);
  for (const node of footNodes) list.insertBefore(node, after);
}

/// 清单块重建(主机增删/搜索过滤):整块替换清单与页脚,模式行仍保留。
function rebuildHostBlock(list, data) {
  list.querySelector('.ai-target-hosts')?.remove();
  for (const node of [...list.querySelectorAll('.ai-target-menu-sep, .ai-target-menu-foot')]) node.remove();
  const rows = [...list.querySelectorAll('.ai-target-mode')];
  const anchor = rows[rows.length - 1];
  const after = anchor ? anchor.nextSibling : null;
  list.insertBefore(renderHostList(data, {}), after);
  for (const node of buildTargetFooter(data, {})) list.insertBefore(node, after);
}
function patchTargetMenu(list, data) {
  const modeRows = [...list.querySelectorAll('.ai-target-mode')];
  if (modeRows.length !== 3) return false;

  // 模式行状态同步(勾选态/描述/开关可用性)。就地改写,不换节点。
  const syncModeRows = () => {
    for (const modeId of ['chat', 'follow', 'multi']) {
      const row = modeRows.find((r) => r.dataset.mode === modeId);
      if (!row) continue;
      const on = !!data[modeId]?.checked;
      row.classList.toggle('is-on', on);
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      const desc = row.querySelector('.ai-target-mode-desc');
      const text = modeId === 'follow'
        ? (data.follow?.hostLabel ? `已链接 ${data.follow.hostLabel}` : '跟随当前命令窗口的主机')
        : modeId === 'multi'
          ? (data.linkCount > 0 ? `已链接 ${data.linkCount} 台主机` : '批量链接多台主机统一管理')
          : '';
      if (desc && text && desc.textContent !== text) desc.textContent = text;
    }
  };

  // ---- 模式行 ----
  // 勾选态变化不重建:模式 switch 的果冻动画依赖"同一个 DOM 节点"。
  const disabledAttr = !!data.disabled;
  for (const modeId of ['chat', 'follow', 'multi']) {
    const row = modeRows.find((r) => r.dataset.mode === modeId);
    if (!row) return false;
    if (disabledAttr !== (row.getAttribute('aria-disabled') === 'true')) return false;
  }

  // ---- 主机清单 ----
  // 清单的出现/消失只增删它自己那一块,不重建整张菜单 —— 否则切到多主机那一下
  // 连模式 switch 都被换成新节点,果冻动画同样丢失。
  const hostWrap = list.querySelector('.ai-target-hosts');
  const foot = list.querySelector('.ai-target-menu-foot');
  const wantHosts = !!data.multi?.showHosts;
  const wasHosts = !!hostWrap;

  let hostRows = [];
  if (wantHosts && wasHosts) {
    hostRows = [...list.querySelectorAll('.ai-target-host')];
    const hosts = data.hosts || [];
    // 主机数量变化(增删/搜索过滤):只重建清单块,模式行保留(动画不丢)。
    if (hostRows.length !== hosts.length) {
      rebuildHostBlock(list, data);
      return true;
    }
    for (let i = 0; i < hosts.length; i++) {
      if (hostRows[i].dataset.hostId !== hosts[i].hostId) {
        rebuildHostBlock(list, data);
        return true;
      }
    }
  } else if (wantHosts !== wasHosts) {
    // 多主机开/关:只增删清单 + 页脚,模式行原样保留(动画不丢)。
    if (wantHosts) insertHostBlock(list, data);
    else { hostWrap?.remove(); foot?.remove(); }
    syncModeRows();
    return true;
  }

  // ===== 到这里确认结构一致,只更新内容 =====
  syncModeRows();

  if (wantHosts) {
    const hosts = data.hosts || [];
    hostRows.forEach((row, i) => {
      const h = hosts[i];
      const pending = h.status === 'connecting' || h.status === 'disconnecting';
      row.classList.toggle('is-on', !!h.linked);
      row.classList.toggle('ai-target-host-error', !!h.error);
      row.classList.toggle('is-pending', pending);
      const meta = row.querySelector('.ai-target-host-meta');
      const next = h.status === 'connecting' ? '连接中…'
        : h.status === 'disconnecting' ? '断开中…'
          : h.error ? h.error
            : h.linked ? '已链接'
              : (h.address || '');
      if (meta && meta.textContent !== next) meta.textContent = next;
      syncSwitch(row, !!h.linked, !!data.disabled || pending);
    });
    const count = list.querySelector('.ai-target-hosts-count');
    const countText = `已链接 ${data.linkCount || 0} / 共 ${(data.hosts || []).length}`;
    if (count && count.textContent !== countText) count.textContent = countText;
  }

  const footEl = list.querySelector('.ai-target-menu-foot');
  if (footEl) {
    const text = data.linkCount > 0 ? `已链接 ${data.linkCount} 台主机` : '未链接主机';
    const label = footEl.querySelector('.ai-target-menu-foot-text');
    if (label && label.textContent !== text) label.textContent = text;
  }
  return true;
}

/// 多主机清单:搜索 + 计数 + 可滚动列表(每台一个 switch)。100 台也只是一段滚动区。
function renderHostList(data, handlers) {
  const wrap = el('div', 'ai-target-hosts');
  const head = el('div', 'ai-target-hosts-head');
  head.append(el('span', 'ai-target-hosts-count', `已链接 ${data.linkCount || 0} / 共 ${(data.hosts || []).length}`));
  head.append(el('span', 'spacer'));
  const allOn = data.linkCount > 0 && data.linkCount >= (data.hosts || []).length;
  const clearBtn = btn(allOn ? '全部关闭' : '全部开启', 'btn small ghost');
  clearBtn.addEventListener('click', () => {
    targetHandlers.onToggleAll?.(!allOn);
  });
  head.append(clearBtn);
  wrap.append(head);

  const searchRow = el('div', 'ai-target-hosts-search');
  const search = document.createElement('input');
  search.className = 'inp';
  search.type = 'text';
  search.placeholder = '搜索主机…';
  search.setAttribute('aria-label', '搜索主机');
  search.autocomplete = 'off';
  search.value = data.query || '';
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => targetHandlers.onSearch?.(search.value), 120);
  });
  // 搜索框里回车/空格不该触发菜单项的键盘选择
  search.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  searchRow.append(search);
  wrap.append(searchRow);

  const listEl = el('div', 'ai-target-hosts-list');
  const hosts = data.hosts || [];
  if (!hosts.length) {
    listEl.append(el('div', 'ai-target-hosts-empty', data.query ? '没有匹配的主机' : '还没有配置主机'));
  }
  for (const h of hosts) {
    const pending = h.status === 'connecting' || h.status === 'disconnecting';
    const row = el('div', 'ai-target-host'
      + (h.linked ? ' is-on' : '')
      + (h.error ? ' ai-target-host-error' : '')
      + (pending ? ' is-pending' : ''));
    row.dataset.hostId = h.hostId;
    const body = el('div', 'ai-target-host-body');
    const nameEl = el('span', 'ai-target-host-name', h.name || h.hostId);
    nameEl.title = h.name || h.hostId;
    // 三段可见状态:连接中… / 断开中… → 已链接 / 失败原因 → 地址
    const meta = h.status === 'connecting' ? '连接中…'
      : h.status === 'disconnecting' ? '断开中…'
        : h.error ? h.error
          : h.linked ? '已链接'
            : (h.address || '');
    body.append(nameEl, el('span', 'ai-target-host-meta', meta));
    const sw = makeSwitch({
      checked: !!h.linked,
      // 操作进行中禁用,避免连点把状态机打乱
      disabled: !!data.disabled || pending,
      label: `链接 ${h.name || h.hostId}`,
      onChange: (on) => { targetHandlers.onToggleHost?.(h.hostId, on); },
    });
    row.append(body, sw);
    listEl.append(row);
  }
  wrap.append(listEl);
  return wrap;
}

/// 页脚节点(分隔线 + 「已链接 N 台主机」+「断开全部」)。返回节点数组,便于整块增删。
function buildTargetFooter(data, handlers) {
  if (!data.hosts?.length) return [];
  const sep = el('div', 'ai-target-menu-sep');
  const foot = el('div', 'ai-target-hosts-head ai-target-menu-foot');
  const label = el('span', 'ai-target-menu-foot-text', data.linkCount > 0 ? `已链接 ${data.linkCount} 台主机` : '未链接主机');
  foot.append(label);
  foot.append(el('span', 'spacer'));
  if (data.linkCount > 0) {
    const off = btn('断开全部', 'btn small ghost');
    off.addEventListener('click', () => targetHandlers.onClearHosts?.());
    foot.append(off);
  }
  return [sep, foot];
}

function renderTargetFooter(list, data, handlers) {
  for (const node of buildTargetFooter(data, handlers)) list.append(node);
}


/// 复用 .switch 组件的复选框(与设置页同款滑块样式)。
function makeSwitch({ checked, disabled, label, onChange, onClick } = {}) {
  const wrap = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.disabled = !!disabled;
  input.setAttribute('aria-label', label || '开关');
  const slider = el('span', 'switch-slider');
  if (onClick) wrap.addEventListener('click', onClick);
  input.addEventListener('change', () => onChange?.(input.checked));
  wrap.append(input, slider);
  return wrap;
}

export function openTargetMenu(menuData, handlers) {
  const menu = $('#ai-target-menu');
  const trigger = $('#ai-target-trigger');
  if (!menu || !trigger || trigger.disabled) return;
  $('#ai-model-menu')?.classList.add('hidden');
  $('#ai-thread-menu')?.classList.add('hidden');
  $('#ai-mode-menu')?.classList.add('hidden');

  if (menuData) renderTargetMenu(menuData, handlers);
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  anchorMenu(menu, trigger, { placement: 'bottom', width: 300, height: 320 });

  const activeItem = menu.querySelector('.ai-target-mode[aria-checked="true"]');
  if (activeItem) activeItem.focus();
}

export function closeTargetMenu({ focusTrigger = false } = {}) {
  const menu = $('#ai-target-menu');
  const trigger = $('#ai-target-trigger');
  if (menu) menu.classList.add('hidden');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger && typeof trigger.focus === 'function') trigger.focus();
  }
}

export function toggleTargetMenu(menuData, handlers) {
  const menu = $('#ai-target-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openTargetMenu(menuData, handlers);
  else closeTargetMenu();
}

/// 这次点击是否来自指定菜单/触发钮内部。
///
/// 不能用 e.target.closest():菜单内的原地重绘(切模式、拨开关后刷新清单)会把被点中
/// 的那一行从文档里摘掉,事件继续冒泡到 document 时 closest 已经是 null,于是被误判成
/// "点了菜单外",表现为切个模式/拨个开关菜单就自己收起。composedPath 在事件派发时就
/// 已算好,元素脱离文档也不影响,能稳定认出"这次点击来自菜单内部"。
export function clickFromMenu(event, ids) {
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
  if (path.some((node) => node && ids.includes(node.id))) return true;
  return ids.some((id) => !!event?.target?.closest?.(`#${id}`));
}

export function onTargetMenuKeydown(e) {
  const menu = $('#ai-target-menu');
  // 模式行现在是 div(不是 button),可用性由 aria-disabled 表达;主机开关单独可聚焦。
  menuKeydown(e, menu, '.ai-target-mode:not([aria-disabled="true"])', { onClose: closeTargetMenu });
}

export function updateContextBanner(view, thread, handlers = {}) {
  const banner = $('#ai-context-banner');
  if (!banner) return;

  if (!view || !thread) {
    banner.classList.add('hidden');
    return;
  }

  const textEl = $('#ai-context-banner-text');
  const actionsEl = $('#ai-context-banner-actions');
  const closeBtn = $('#ai-context-banner-close');

  // 变体 1: 消息未发送 (发送拦截)
  if (thread.sendBlocked && view.kind === 'offline') {
    banner.classList.remove('hidden');
    if (textEl) {
      const safeHost = escapeHtml(view.hostLabel || '目标主机');
      textEl.innerHTML = `<b>消息未发送</b>：${safeHost} 未连接，AI 无法在它上面执行命令。`;
    }
    if (actionsEl) {
      actionsEl.replaceChildren();
      if (view.connectable) {
        const connBtn = btn(`${view.actionText || '连接'} ${view.hostLabel || ''}`, 'btn small primary');
        connBtn.addEventListener('click', () => handlers.onConnect?.());
        actionsEl.append(connBtn);
      }
      if (view.active?.session) {
        const switchBtn = btn(`改在 ${view.active.hostLabel} 上发送`, 'btn small');
        switchBtn.addEventListener('click', () => handlers.onSendOnActive?.());
        actionsEl.append(switchBtn);
      }
      const chatBtn = btn('改为对话模式发送', 'btn small ghost');
      chatBtn.addEventListener('click', () => handlers.onSendAsChat?.());
      actionsEl.append(chatBtn);
    }
    if (closeBtn) {
      closeBtn.onclick = () => {
        banner.classList.add('hidden');
        handlers.onDismissBlocked?.();
      };
    }
    return;
  }

  // 跟随模式下目标恒等于当前窗口,不存在「跨标签指向另一台主机」的情形,
  // 因此跨标签横条已随本轮重构移除(第二行目标栏的职责并入顶栏主机下拉)。
  banner.classList.add('hidden');
}
