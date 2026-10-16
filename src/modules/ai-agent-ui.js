// AI 工具循环的界面：步骤行、确认卡、sudo 密码卡、继续询问、变更清单、主机条。
// 卡片都挂在对应步骤行里（而不是全局模态）：命令和决定始终在一起，也不与
// 模态层级、「模态打开时终端拒写」的规则互相干扰。
import { icon } from '../shared/icons.js';
import { $, api } from './core.js';

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
        const rememberLabel = el('label', 'ai-sudo-remember');
        const remember = el('input');
        remember.type = 'checkbox';
        rememberLabel.append(remember, document.createTextNode('本会话记住（仅内存）'));
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

/// 执行模式选择器（原主机条已并入）：触发钮显示「主机名 · 模式」，菜单展开时
/// 顶部标明「主机 · 名称」（未绑定时「未链接主机」）。对话模式不绑定主机，触发钮只显「对话模式」。
const MODES = [
  { id: 'chat', icon: 'messageSquare', title: '对话模式', desc: '不操作主机，命令仅展示供你自己执行' },
  { id: 'manual', icon: 'lock', title: '手动确认', desc: '执行命令前先向你确认' },
  { id: 'auto', icon: 'zap', title: '自动执行', desc: '普通命令自动执行，高危和外联仍会确认' },
];
const MODE_TITLES = Object.fromEntries(MODES.map((m) => [m.id, m.title]));
// 「?」帮助浮层的内容：三档沿用菜单图标；主机安全逐条配图标，会外发数据的那条用警示色。
const MODE_HELP = {
  modes: {
    chat: 'AI 只回复文字，命令由你自己决定是否执行。',
    manual: '每条命令先展示给你，确认后才执行。',
    auto: '普通命令直接执行；高危、外联、覆盖文件的命令仍会停下来确认。',
  },
  grant: '下载、修改或删除文件、结束进程、卸载软件包可在确认卡上「本会话总是允许」（按站点、目录、进程名或包名）。之后同类操作直接执行、无法撤销；授权可在本菜单撤销。',
  security: [
    { icon: 'terminal', text: '命令只在当前会话绑定的主机上执行。' },
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
  const visible = !!info?.visible;
  trigger.hidden = !visible;
  if (!visible) {
    closeModeMenu();
    return;
  }
  const mode = info.mode || 'manual';
  trigger.dataset.mode = mode;
  trigger.dataset.locked = info.modeLocked ? 'true' : 'false';
  trigger.dataset.degraded = info.warn ? 'true' : 'false';
  $('#ai-mode-name').textContent = MODE_TITLES[mode] || mode;
  const hostEl = $('#ai-mode-host');
  const sepEl = trigger.querySelector('.ai-mode-sep');
  const host = info.hostLabel || '';
  hostEl.textContent = host;
  hostEl.parentElement.hidden = !host;
  sepEl.hidden = !host;
  const iconWrap = trigger.querySelector('.ai-mode-icon');
  iconWrap.innerHTML = icon(MODES.find((m) => m.id === mode)?.icon || 'lock', { size: 13 });
  const grants = info.grants?.length ? `\n本会话已授权 ${info.grants.length} 项（点击查看或撤销）` : '';
  trigger.title = info.warn
    ? info.warn
    : info.modeLocked
      ? `执行模式：${MODE_TITLES[mode]}（该主机设置为只允许手动确认）\n点击查看/切换执行模式`
      : `执行模式：${MODE_TITLES[mode]}${host ? ` · ${host}` : ''}\n点击切换执行模式${grants}`;
  trigger.disabled = !!info.disabled;
  // 开合绑定在 entry.js(addEventListener 一次);这里只管状态,避免双绑定开又关。
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
  $('#ai-mode-menu-ctx').innerHTML = '';
  $('#ai-mode-menu-ctx').textContent = info.ctxLabel || '';
  if (info.isRoot) {
    $('#ai-mode-menu-ctx').append(Object.assign(document.createElement('span'), { className: 'ai-root-badge', textContent: 'root' }));
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

export function openModeMenu(info = lastPickerInfo) {
  const menu = $('#ai-mode-menu');
  const trigger = $('#ai-mode-trigger');
  if (!menu || !trigger || trigger.disabled) return;
  $('#ai-model-menu')?.classList.add('hidden');
  $('#ai-thread-menu')?.classList.add('hidden');
  if (info) lastPickerInfo = info;
  renderModeMenu(lastPickerInfo);
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  // 锚定触发钮上方（输入区在面板底部，向下没有空间），左缘对齐触发钮
  const tr = trigger.getBoundingClientRect();
  const size = { width: menu.offsetWidth || 240, height: menu.offsetHeight || 220 };
  const left = Math.max(8, Math.min(tr.left, window.innerWidth - size.width - 8));
  menu.style.left = left + 'px';
  menu.style.top = Math.max(8, tr.top - size.height - 6) + 'px';
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
  if (!e) return;
  const menu = $('#ai-mode-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  const key = e.key;
  if (key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeModeMenu({ focusTrigger: true });
    return;
  }
  if (key === 'Tab') {
    closeModeMenu();
    return;
  }
  const items = Array.from(menu.querySelectorAll('.ai-mode-menu-item:not(:disabled)'));
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
