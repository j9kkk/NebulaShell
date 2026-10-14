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

export function createAgentAdapter({ mount, onGrow, isActive, setPending, onRunAndAuto, audit, canUseSaved }) {
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
        actions.append(run, edit, skip, skipWhy);
        if (tier === 'normal' && !p.forceConfirm && onRunAndAuto) {
          const auto = btn('执行并切到自动', 'btn ghost');
          auto.addEventListener('click', () => { onRunAndAuto(); done({ decision: 'run' }, '已执行，并切换到自动模式'); });
          actions.append(auto);
        }
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
          cancel.addEventListener('click', () => { area.replaceWith(cmd); actions.replaceChildren(run, edit, skip, skipWhy); });
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

/// 主机条：AI 工具作用于哪台主机、执行模式，以及为什么暂时不能用工具。
export function updateHostBar(info, { onToggleMode } = {}) {
  const bar = $('#ai-hostbar');
  if (!bar) return;
  bar.hidden = !info?.visible;
  if (!info?.visible) return;
  $('#ai-hostbar-label').textContent = info.label || '';
  $('#ai-hostbar-root').hidden = !info.isRoot;
  const warn = $('#ai-hostbar-warn');
  warn.textContent = info.warn || '';
  warn.hidden = !info.warn;
  const toggle = $('#ai-mode-toggle');
  toggle.dataset.mode = info.mode;
  toggle.textContent = info.mode === 'auto' ? '自动执行' : '手动确认';
  toggle.disabled = !!info.modeLocked || !!info.disabled;
  toggle.title = info.modeLocked ? '该主机设置为只允许手动确认' : info.mode === 'auto' ? '自动：普通命令直接执行，高危/外联仍需确认。点击切回手动' : '手动：每条命令都先确认。点击切换到自动';
  toggle.onclick = onToggleMode || null;
}
