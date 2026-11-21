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

export function createAiNoticeElement({ kind = '', level = 'info', iconName = 'zap', text = '', actions = [] } = {}) {
  const row = el('div', 'ai-notice' + (level && level !== 'info' ? ' ' + level : ''));
  if (kind) row.dataset.kind = kind;
  if (level) row.dataset.level = level;
  row.dataset.role = 'notice';
  const ic = el('span', 'ai-notice-icon mi');
  ic.innerHTML = icon(iconName, { size: 12 });
  const txt = el('span', 'ai-notice-text', text);
  row.append(ic, txt);
  row.__label = txt;
  if (Array.isArray(actions) && actions.length) {
    const actWrap = el('span', 'ai-notice-actions');
    for (const a of actions) {
      if (!a || !a.label) continue;
      const b = btn(a.label, 'ai-notice-act' + (a.className ? ' ' + a.className : ''));
      if (a.action) b.dataset.noticeAction = a.action;
      if (a.hostKey) b.dataset.hostKey = a.hostKey;
      if (typeof a.onClick === 'function') {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          a.onClick(e, row);
        });
      }
      actWrap.append(b);
    }
    row.append(actWrap);
  }
  return row;
}

export function createAgentAdapter({ mount, onGrow, isActive, setPending, onRunAndAuto, canAllow, onAllowAlways, audit, canUseSaved, onReconnectHost }) {
  const steps = new Map();

  const stateText = (refs, text, cls = '') => {
    refs.state.textContent = text;
    refs.state.className = 'ai-step-state' + (cls ? ' ' + cls : '');
  };

  /// 步骤失败时把完整原因放进卡片内的独立错误行（不再挤进 26px 的状态位）。
  /// session_gone / host_unreachable 时右侧给「重连」，回调由调用方注入。
  const setStepError = (refs, step, res) => {
    if (!refs.errEl) return;
    const msg = String(res?.message || '').trim();
    const hostKey = step?.hostKey || step?.host || '';
    const canReconnect = (res?.code === 'session_gone' || res?.code === 'host_unreachable')
      && !!hostKey && typeof onReconnectHost === 'function';
    refs.errEl.replaceChildren();
    if (!msg && !canReconnect) { refs.errEl.hidden = true; return; }
    refs.errEl.append(el('span', 'ai-step-err-txt', msg || '主机已断开'));
    if (canReconnect) {
      const act = btn('重连', 'ai-step-err-act');
      act.addEventListener('click', async (e) => {
        e.stopPropagation();
        act.disabled = true;
        act.textContent = '连接中…';
        let ok = false;
        try { ok = !!(await onReconnectHost(hostKey)); } catch { ok = false; }
        act.textContent = ok ? '已重连' : '重连失败';
        act.dataset.ok = ok ? 'true' : 'false';
        if (ok) refs.state.className = 'ai-step-state ok';
        setTimeout(() => {
          if (act.isConnected) { act.disabled = false; act.textContent = '重连'; }
        }, 2400);
      });
      refs.errEl.append(act);
    }
    refs.errEl.hidden = false;
    refs.errEl.title = msg;
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

  const applyStepHostBadge = (hostBadge, step) => {
    if (!hostBadge) return;
    const hostText = String(step?.hostName || step?.args?.host || '').trim();
    if (hostText) {
      hostBadge.textContent = '@' + hostText.replace(/^@/, '');
      hostBadge.hidden = false;
    } else {
      hostBadge.textContent = '';
      hostBadge.hidden = true;
    }
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
      const hostBadge = el('span', 'ai-step-host');
      applyStepHostBadge(hostBadge, step);
      const detailEl = el('code', 'ai-step-detail', detail);
      title.append(hostBadge, el('span', 'ai-step-verb', verb), detailEl);
      const state = el('span', 'ai-step-state', '进行中…');
      head.append(ic, title, state);
      const errEl = el('div', 'ai-step-err');
      errEl.hidden = true;
      const body = el('div', 'ai-step-body');
      body.hidden = true;
      const log = el('pre', 'ai-step-log');
      body.append(log);
      const card = el('div', 'ai-step-card');
      root.append(head, errEl, card, body);
      head.addEventListener('click', () => {
        body.hidden = !body.hidden;
        head.setAttribute('aria-expanded', String(!body.hidden));
      });
      const refs = { root, head, hostBadge, detailEl, state, errEl, body, log, card, started: Date.now(), timer: 0, onGrow };
      steps.set(step.id, refs);
      mount(root);
    },

    stepRun(step, toolRunId) {
      const refs = steps.get(step.id);
      if (!refs) return;
      runs.set(toolRunId, refs);
      refs.runId = toolRunId;
      refs.started = Date.now();
      if (refs.errEl) { refs.errEl.hidden = true; refs.errEl.replaceChildren(); }
      if (step.tool !== 'exec') return;
      clearTicker(refs);
      // 一次 exec 可能被重跑（确认卡、sudo 密码卡都会重发同一步），每轮都会走到
      // 这里：先摘掉上一轮的停止按钮，否则重试几次就在行尾叠出几个红按钮。
      refs.stopBtn?.remove();
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
      if (!refs) return;
      refs.detailEl.textContent = stepTitle(step)[1];
      applyStepHostBadge(refs.hostBadge, step);
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
        // 26px 的步骤头装不下一句 20 字的错误文案:状态位只留短标签,完整原因走独立错误行。
        const shortMsg = res.code === 'out_of_scope'
          ? '越界已拦截'
          : (res.code === 'host_unreachable' ? '主机不可达' : '失败');
        stateText(refs, shortMsg, 'error');
        if (res.message) refs.state.title = res.message;
        setStepError(refs, step, res);
      }
      const text = [res.output, res.note, res.status === 'error' ? res.message : ''].filter(Boolean).join('\n');
      if (text) refs.log.textContent = text;
      // 按会话授权免确认执行的命令要能一眼看出来（可追溯，也提醒授权仍在生效）。
      const whitelisted = grantItems(res.whitelisted);
      if (whitelisted.length) {
        const tag = el('span', 'ai-step-tag', '按授权');
        tag.title = `按会话授权自动执行：${grantText(whitelisted)}`;
        refs.state.before(tag);
      }
      // 完全托管下放行的高危命令:没有确认卡,事后唯一能看出「这条本该确认」的就是这个标签。
      if (res.decision === 'managed' && res.tier && res.tier !== 'normal') {
        const tag = el('span', 'ai-step-tag danger', '托管执行');
        tag.title = `完全托管下直接执行（${res.tier === 'danger' ? '高危' : '外联'}命令），未经确认`;
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
        head.append(el('span', 'ai-confirm-title', titles[tier] || titles.normal));

        // B1：确认卡卡头目标主机胶囊；范围 ≥ 2 台时可下拉切换改派本条命令的目标主机
        const scopeHosts = Array.isArray(p.scopeHosts) ? p.scopeHosts.filter((h) => h && !h.unreachable) : [];
        const initialHostName = String(p.host || p.step?.hostName || p.step?.args?.host || (scopeHosts[0]?.name || '')).trim();
        const initialHostKey = String(p.hostKey || p.step?.hostKey || (scopeHosts.find((h) => h.name === initialHostName)?.hostId || scopeHosts[0]?.hostId || '')).trim();
        let selectedHostName = initialHostName;
        let selectedHostKey = initialHostKey;
        let hostPickEl = null;

        const metaTextEl = el('span', 'ai-confirm-meta-text');
        const updateMetaText = () => {
          metaTextEl.textContent = [selectedHostName && '主机 ' + selectedHostName, p.cwd && '目录 ' + p.cwd].filter(Boolean).join(' · ');
        };
        updateMetaText();
        const meta = el('div', 'ai-confirm-meta');
        meta.append(metaTextEl);
        if (p.asRoot) meta.append(el('span', 'ai-root-badge', 'root'));

        if (selectedHostName) {
          if (scopeHosts.length > 1) {
            const hostBtn = btn(null, 'ai-confirm-host-btn');
            hostBtn.setAttribute('aria-haspopup', 'listbox');
            hostBtn.setAttribute('aria-expanded', 'false');
            hostBtn.title = '切换此命令的目标主机（本会话允许范围内）';
            const hostLbl = el('span', 'ai-confirm-host-label', '@' + selectedHostName.replace(/^@/, ''));
            const hostCaret = el('span', 'ai-confirm-host-caret mi');
            hostCaret.innerHTML = icon('chevronDown', { size: 12 });
            hostBtn.append(hostLbl, hostCaret);
            head.append(hostBtn);

            hostPickEl = el('div', 'ai-confirm-host-pick');
            hostPickEl.setAttribute('role', 'listbox');
            hostPickEl.hidden = true;
            const renderHostOpts = () => {
              const opts = [];
              for (const h of scopeHosts) {
                const hKey = h.hostKey || h.hostId || '';
                const isSel = (selectedHostKey && hKey === selectedHostKey) || h.name === selectedHostName;
                const opt = btn(null, 'ai-confirm-host-opt' + (isSel ? ' on' : ''));
                opt.setAttribute('role', 'option');
                opt.setAttribute('aria-selected', isSel ? 'true' : 'false');
                opt.dataset.hostId = hKey;
                opt.dataset.hostKey = hKey;
                opt.dataset.hostName = h.name || '';
                const ck = el('span', 'ai-confirm-host-ck');
                if (isSel) ck.innerHTML = icon('check', { size: 12 });
                const nm = el('span', 'ai-confirm-host-nm', h.name || hKey);
                const addr = el('span', 'ai-confirm-host-addr', h.address || '');
                opt.append(ck, nm, addr);
                opt.addEventListener('click', (e) => {
                  e.stopPropagation();
                  selectedHostKey = hKey;
                  selectedHostName = h.name || hKey;
                  hostLbl.textContent = '@' + selectedHostName.replace(/^@/, '');
                  updateMetaText();
                  if (p.step) {
                    p.step.hostName = selectedHostName;
                    p.step.hostKey = selectedHostKey;
                    applyStepHostBadge(refs.hostBadge, p.step);
                  }
                  hostPickEl.hidden = true;
                  hostBtn.setAttribute('aria-expanded', 'false');
                  renderHostOpts();
                });
                opts.push(opt);
              }
              hostPickEl.replaceChildren(...opts);
            };
            renderHostOpts();
            hostBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const nextOpen = hostPickEl.hidden;
              hostPickEl.hidden = !nextOpen;
              hostBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
            });
          } else {
            head.append(el('span', 'ai-confirm-host-tag', '@' + selectedHostName.replace(/^@/, '')));
          }
        }

        // 命令区本身就是可编辑的:想改命令直接在这里改,点「执行」就按改后的命令跑
        // (不再单开「改后执行」步骤;后端会按新命令重新判档,升档时再确认一次)。
        const cmd = el('textarea', 'ai-confirm-cmd');
        cmd.value = p.cmd;
        cmd.rows = 2;
        cmd.spellcheck = false;
        cmd.title = '可以直接修改命令,点「执行」按改后的命令运行';
        card.append(head);
        if (hostPickEl) card.append(hostPickEl);
        card.append(meta, cmd);
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
        // 三个按钮按序:执行(主)/ 自动执行(次)/ 跳过(纯文字)。
        // 命令想改就在上面的命令框里改,所以不再有「改后执行」这一步。
        const run = btn(null, tier === 'danger' ? 'btn danger' : 'btn primary');
        run.innerHTML = icon('play', { size: 12 }) + `<span>${tier === 'danger' ? '确认执行' : '执行'}</span>`;
        const skip = btn('跳过', 'btn ghost');
        const baseActions = [run];
        let auto = null;
        if (tier === 'normal' && !p.forceConfirm && onRunAndAuto) {
          auto = btn(null, 'btn');
          auto.innerHTML = icon('zap', { size: 12 }) + '<span>自动执行</span>';
          auto.title = '执行这条命令,并把本对话切到自动执行';
          baseActions.push(auto);
        }
        baseActions.push(skip);
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
        // 命令框里改过内容就按改后的命令执行(decision:edit),否则就是原命令；若在卡头切换了目标主机则附带 host/hostKey。
        const decisionFor = () => {
          const v = cmd.value.trim();
          const out = v && v !== p.cmd.trim() ? { decision: 'edit', cmd: v } : { decision: 'run' };
          const hostChanged = Boolean(selectedHostName && selectedHostName !== initialHostName);
          if (hostChanged) {
            out.host = selectedHostName;
            if (selectedHostKey) out.hostKey = selectedHostKey;
          }
          return out;
        };
        const submit = (note) => {
          const d = decisionFor();
          const hostSuffix = d.host ? `（已改派至 @${d.host}）` : '';
          done(d, (d.decision === 'edit' ? '已改为：' + d.cmd : note || '已确认执行') + hostSuffix);
        };
        run.addEventListener('click', () => submit());
        auto?.addEventListener('click', () => { onRunAndAuto(); submit('已执行，并切换到自动模式'); });
        skip.addEventListener('click', () => done({ decision: 'skip' }, '已跳过'));
        // 命令框按内容长高(上限由 CSS 的 max-height 管),一条长命令不用先滚才能看全。
        const grow = () => {
          cmd.style.height = 'auto';
          cmd.style.height = Math.min(160, cmd.scrollHeight + 2) + 'px';
          // 命令被清空时没有东西可执行:避免「点执行结果跑了原来那条」。
          const empty = !cmd.value.trim();
          run.disabled = empty;
          if (auto) auto.disabled = empty;
        };
        cmd.addEventListener('input', grow);
        // 普通档：焦点落在「执行」上，回车即执行；高危/外联档没有默认按钮，回车无效。
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); done({ decision: 'skip' }, '已跳过'); }
        });
        attachCard(refs, card, tier === 'normal' ? run : card);
        grow();
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

    turnSummary({ execs, status }) {
      const card = el('div', 'ai-turn-card ai-turn-summary');
      card.append(el('div', 'ai-turn-summary-title', `本轮执行记录（${execs.length} 条命令${status === 'aborted' ? '，已中止' : ''}）`));
      const ul = el('ul');
      const label = (e) => {
        if (e.decision === 'skipped') return '已跳过';
        if (e.status === 'aborted') return '已中止';
        if (e.status === 'error') return '失败';
        return '退出码 ' + (e.exitCode ?? '—') + (e.decision === 'edited' ? '（命令已修改）' : '');
      };
      for (const e of execs) {
        const li = el('li');
        li.dataset.state = e.decision === 'skipped' ? 'skipped' : e.status === 'done' && !e.exitCode ? 'ok' : 'warn';
        if (e.host) {
          li.append(el('span', 'ai-step-host', '@' + String(e.host).replace(/^@/, '')));
        }
        li.append(el('code', null, e.cmd), el('span', null, label(e)));
        ul.append(li);
      }
      card.append(ul);
      mount(card);
    },

    audit,
  };
}

/// 执行模式选择器:触发钮只显示档位名称(「手动确认」/「自动执行」/「完全托管」),常驻显示。
/// 「不操作主机 / 作用于哪些主机」归顶栏主机下拉,这里不再重复。
const MODES = [
  { id: 'manual', icon: 'lock', title: '手动确认', short: '手动', desc: '执行命令前先向你确认' },
  { id: 'auto', icon: 'zap', title: '自动执行', short: '自动', desc: '普通命令自动执行，高危和外联仍会确认' },
  { id: 'full', icon: 'unlock', title: '完全托管', short: '托管', desc: '不再确认任何命令，包括高危和外联' },
];
const MODE_TITLES = Object.fromEntries(MODES.map((m) => [m.id, m.title]));
// 窄档(T3/T4)触发钮只显示双字,省下的宽度留给主机名(见 style.css 的 composer 容器查询)
const MODE_SHORTS = Object.fromEntries(MODES.map((m) => [m.id, m.short]));
// 「?」帮助浮层的内容：三档沿用菜单图标；主机安全逐条配图标，会外发数据的那条用警示色。
const MODE_HELP = {
  modes: {
    manual: '每条命令先展示给你，确认后才执行。',
    auto: '普通命令直接执行；高危、外联、覆盖文件的命令仍会停下来确认。',
    full: '一条也不再确认：高危、外联、删除数据、覆盖文件都直接执行，做错了没有挽回的机会。',
  },
  // 每档的补充说明：自动档讲会话授权；托管档只讲风险与适用场景。
  notes: {
    auto: {
      icon: 'checkCircle',
      text: '下载、修改或删除文件、结束进程、卸载软件包可在确认卡上「本会话总是允许」（按站点、目录、进程名或包名）。之后同类操作直接执行、无法撤销；授权可在本菜单撤销。多主机模式下不提供「总是允许」，每条命令都单独确认。',
    },
    full: {
      icon: 'alert',
      warn: true,
      text: '完全托管等于把主机交给 AI 连续操作：没有确认卡，也没有「跳过」的机会，误删数据、改坏配置都会立即生效。仅在你信任这次任务、且这台主机可以重建时使用；换主机或换链接方式会自动退回手动确认。',
    },
  },
  footnote: '本会话允许操作哪些主机，请在输入框左下角的主机按钮里勾选（仅限制本会话，与终端标签无关）。',
  security: [
    { icon: 'terminal', text: '命令只会发送到本会话已勾选的主机范围内（运行时硬校验，越界拒绝执行）。' },
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
    if (MODE_HELP.notes[m.id]) {
      const n = MODE_HELP.notes[m.id];
      const note = el('div', 'mh-note' + (n.warn ? ' warn' : ''));
      note.append(iconBox('mh-note-icon', n.icon, 12), el('span', null, n.text));
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
  const chatNote = $('#ai-chat-note');
  const input = $('#ai-input');
  if (!trigger) return;
  if (info) {
    lastPickerInfo = info;
    if (onSelectMode) pickerHandlers = { onSelectMode, onRevoke };
  }
  const showMode = info ? info.showModeControl !== false : false;
  trigger.hidden = !showMode;
  if (chatNote) chatNote.hidden = showMode;
  if (input) {
    const ph = showMode
      ? '输入 @ 从范围内选主机，或直接提问…'
      : '纯对话模式（未选择主机）…';
    if (input.tagName === 'TEXTAREA') input.placeholder = ph;
    if (input.dataset) input.dataset.placeholder = ph;
    input.setAttribute?.('data-placeholder', ph);
  }
  if (!showMode) closeModeMenu();

  const mode = info?.mode || 'manual';
  trigger.dataset.mode = mode;
  trigger.dataset.locked = info?.modeLocked ? 'true' : 'false';
  trigger.dataset.degraded = info?.warn ? 'true' : 'false';
  $('#ai-mode-name').textContent = MODE_TITLES[mode] || mode;
  const shortEl = $('#ai-mode-short');
  if (shortEl) shortEl.textContent = MODE_SHORTS[mode] || MODE_TITLES[mode] || mode;

  const iconWrap = trigger.querySelector('.ai-mode-icon');
  if (iconWrap) iconWrap.innerHTML = icon(MODES.find((m) => m.id === mode)?.icon || 'lock', { size: 13 });

  const grants = info?.grants?.length ? `\n本会话已授权 ${info.grants.length} 项（点击查看或撤销）` : '';
  const host = info?.hostSummary ? `\n会话范围：${info.hostSummary}` : '';
  // 托管档没有确认卡,触发钮本身就是随时可见的唯一警示:标题里直接写明「不再确认」。
  const modeHint = mode === 'full' ? '（不再确认任何命令）' : '';
  trigger.title = info?.warn
    ? info.warn
    : info?.modeLocked
      ? `执行模式：${MODE_TITLES[mode]}（范围内主机设置为只允许手动确认）\n点击查看/切换执行模式`
      : `执行模式：${MODE_TITLES[mode]}${modeHint}${host}\n点击切换执行模式${grants}`;
  trigger.disabled = !!info?.disabled;

  // 菜单若开着，同步刷新（线程/范围变化时）
  if (!$('#ai-mode-menu').classList.contains('hidden')) renderModeMenu(lastPickerInfo);
}

/// 「本会话已授权」：逐项可撤销。授权只在自动模式生效；手动/对话/托管下仅作展示
/// (托管档本来就不确认,授权列表不参与判定,但保留着以便切回自动档继续用)。
function renderGrants(info) {
  const box = $('#ai-mode-grants');
  if (!box) return;
  const grants = info.grants || [];
  box.hidden = !grants.length;
  box.replaceChildren();
  if (!grants.length) return;
  const title = info.mode === 'auto'
    ? '本会话已授权'
    : info.mode === 'full'
      ? '本会话已授权（完全托管下不再使用）'
      : '本会话已授权（切到自动执行后生效）';
  const head = el('div', 'ai-mode-grants-title', title);
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
  // 第一行左对齐显示本会话的主机范围摘要(未选主机 / 主机名 / N 台可操作)。
  const ctx = $('#ai-mode-menu-ctx');
  ctx.innerHTML = '';
  ctx.textContent = info?.hostSummary || '未选主机';
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
    // 主机策略「仅手动确认」是硬上限:自动与托管两档一起置灰,而不是只锁自动。
    if (m.id !== 'manual' && info.modeLocked) {
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
  $('#ai-scope-menu')?.classList.add('hidden');
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
// 输入框左下角主机范围按钮（#ai-scope-trigger）与范围选择器浮层（#ai-scope-menu）
// -------------------------------------------------------------

let targetHandlers = {};

/// 输入框左下角主机范围钮：文案 = hostSummary（未选主机 / 主机名 / N 台可操作）。
export function updateTargetBar(view) {
  const trigger = $('#ai-scope-trigger');
  if (!trigger) return;
  if (!view) {
    trigger.disabled = true;
    return;
  }
  trigger.disabled = false;
  const isEmpty = view.kind === 'chat' || !view.count;
  trigger.dataset.empty = isEmpty ? 'true' : 'false';
  trigger.dataset.tone = view.tone || 'idle';
  trigger.dataset.count = String(view.count || 0);
  trigger.title = `${view.ariaLabel || '会话主机范围'}\n点击选择或修改本会话允许操作的主机范围`;
  trigger.setAttribute('aria-label', view.ariaLabel || '会话主机范围');

  const name = $('#ai-scope-name');
  if (name) name.textContent = view.hostSummary || view.displayName || '未选主机';
}

/// 构造开关节点。外观只有 4 种：off / on / connecting / half；
/// error、dropped 一律按 off 渲染 —— 失败信息交给状态点、行文案与悬停原因行，
/// 不给开关再造红描边/灰蓝混色第二套语义（同一个开关不该有两种「关」）。
function createSwitch(state, { role = 'switch', extraClass = '', decorative = false } = {}) {
  const st = ['off', 'on', 'connecting', 'half'].includes(state) ? state : 'off';
  const sw = el('span', ['ai-pick-sw', st === 'off' ? '' : st, extraClass].filter(Boolean).join(' '));
  sw.dataset.state = st;
  if (decorative) {
    // 主机行本身是 role=switch 的可聚焦控件，里面的轨道只是它的「脸」
    sw.setAttribute('aria-hidden', 'true');
  } else {
    sw.setAttribute('role', role);
    // role=switch 不接受 mixed，半选只存在于目录行（checkbox 语义）
    sw.setAttribute('aria-checked', st === 'on' ? 'true' : (st === 'half' ? 'mixed' : 'false'));
  }
  sw.append(el('i', 'ai-pick-sw-knob'));
  return sw;
}

/// 构造单条主机行（分组内或搜索结果扁平列表共用）。
function createHostRow(h, { isSearch = false } = {}) {
  const checked = !!h.checked;
  const row = el('div', 'ai-pick-host ai-target-host' + (checked ? ' on is-on' : '') + (isSearch ? ' is-search' : ''));
  row.dataset.hostId = h.hostId;
  row.setAttribute('role', 'switch');
  row.setAttribute('aria-checked', checked ? 'true' : 'false');
  row.tabIndex = 0;

  const isOff = !!h.unreachable || h.status === 'error';
  const dot = el('span', 'ai-pick-dot dot ' + (isOff ? 'off idle' : 'connected'));
  const nameEl = el('span', 'ai-pick-host-name ai-target-host-name', h.name || h.hostId);
  nameEl.title = h.name || h.hostId;

  let metaEl;
  if (isSearch) {
    metaEl = el('span', 'ai-pick-crumb ai-target-host-meta', `${h.group || '我的主机'} ›`);
  } else if (isOff) {
    metaEl = el('span', 'ai-pick-host-meta ai-target-host-meta bad', h.errorText || '连接超时');
  } else {
    metaEl = el('span', 'ai-pick-host-meta ai-target-host-meta', h.address || '');
  }

  // 开关外观：连接中 → connecting；已勾选 → on；其余（含 error/dropped）→ off
  const swState = checked ? (h.connectState === 'connecting' ? 'connecting' : 'on') : 'off';
  const sw = createSwitch(swState, { decorative: true });
  sw.title = checked ? '取消在本会话使用该主机' : '连接并加入本会话范围';
  row.append(dot, nameEl, metaEl, sw);

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    targetHandlers.onToggleHost?.(h.hostId);
  });
  // 键盘交给菜单级 onTargetMenuKeydown 统一处理（它会把焦点行 click 一次）。
  // 这里再加一个 keydown→onToggleHost 会和它重复触发，实测「按空格来回切换一次=没反应」。
  return row;
}

/// 主机范围选择器浮层（P5：按目录分组 + 三态方框 + 常驻已选汇总 + 扁平搜索，A6 / D1–D4）。
/// 菜单内勾选/取消/清空/展开目录原地重绘，不自动收起。
export function renderTargetMenu(menuData, handlers = {}, { focusHostId } = {}) {
  const list = $('#ai-scope-menu-list');
  if (!list) return;
  if (handlers && Object.keys(handlers).length) targetHandlers = { ...targetHandlers, ...handlers };

  const data = menuData || {};
  list.replaceChildren();

  const rawHosts = data.hosts || [];
  const totalHosts = typeof data.totalCount === 'number' ? data.totalCount : rawHosts.length;
  const scopeCount = typeof data.scopeCount === 'number'
    ? data.scopeCount
    : (Array.isArray(data.scope) ? data.scope.length : rawHosts.filter((h) => h.checked).length);
  const query = String(data.query || '');
  const hasQuery = query.trim().length > 0;

  // 若调用方未预构建 groups（如旧单测直接传 hosts 数组），在渲染层自动按 group 聚合
  let groups = data.groups;
  if (!Array.isArray(groups)) {
    const map = new Map();
    for (const h of rawHosts) {
      const gName = h.group || '我的主机';
      if (!map.has(gName)) map.set(gName, []);
      map.get(gName).push(h);
    }
    groups = [...map.entries()].map(([name, gHosts]) => {
      const sel = gHosts.filter((h) => h.checked).length;
      const st = sel === 0 ? 'none' : (sel === gHosts.length ? 'all' : 'part');
      return {
        name,
        keys: gHosts.map((h) => h.hostId),
        hosts: gHosts,
        totalCount: gHosts.length,
        selectedCount: sel,
        state: st,
        expanded: sel > 0 || map.size === 1,
      };
    });
  }
  const groupCount = typeof data.groupCount === 'number' ? data.groupCount : groups.length;

  // 1. 第一行：搜索框（36px）
  const searchRow = el('div', 'ai-pick-search ai-target-hosts-search' + (hasQuery ? ' on' : ''));
  const searchIcon = el('span', 'ai-pick-search-ic');
  searchIcon.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const search = document.createElement('input');
  search.className = 'inp ai-pick-search-inp';
  search.type = 'text';
  search.placeholder = '搜索主机或目录…';
  search.setAttribute('aria-label', '搜索主机或目录');
  search.autocomplete = 'off';
  search.value = query;
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => targetHandlers.onSearch?.(search.value), 60);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hasQuery) {
      e.preventDefault();
      e.stopPropagation();
      targetHandlers.onClearSearch?.();
      return;
    }
    if (e.key !== 'Escape') e.stopPropagation();
  });
  searchRow.append(searchIcon, search);
  if (hasQuery) {
    const clearQ = btn('', 'ai-pick-qx');
    clearQ.title = '清空搜索';
    clearQ.setAttribute('aria-label', '清空搜索');
    clearQ.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    clearQ.addEventListener('click', (e) => {
      e.stopPropagation();
      if (targetHandlers.onClearSearch) targetHandlers.onClearSearch();
      else targetHandlers.onSearch?.('');
    });
    searchRow.append(clearQ);
  }
  list.append(searchRow);

  // 2. 第二行：常驻已选汇总条（34px）
  const sumRow = el('div', 'ai-pick-sum ai-target-hosts-head' + (scopeCount === 0 ? ' zero' : ''));
  if (scopeCount > 0) {
    const b = el('b', 'ai-target-hosts-count', `已选 ${scopeCount} 台`);
    const names = Array.isArray(data.selectedNames) && data.selectedNames.length
      ? data.selectedNames
      : rawHosts.filter((h) => h.checked).map((h) => h.name || h.hostId);
    const preview = names.slice(0, 2).join('、') + (names.length > 2 ? ` +${names.length - 2}` : '');
    const namesEl = el('span', 'ai-pick-sum-names', preview);
    namesEl.title = names.join('、');
    const clearBtn = btn('清空', 'ai-pick-clear ai-target-hosts-clear');
    clearBtn.dataset.scopeAction = 'clear';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      targetHandlers.onClearHosts?.();
    });
    sumRow.append(b, namesEl, clearBtn);
  } else {
    sumRow.append(el('b', 'ai-target-hosts-count', '未选主机 · 纯对话'));
  }
  list.append(sumRow);

  // 3. 搜索态 vs 目录分组态
  const listEl = el('div', 'ai-pick-list ai-target-hosts-list');

  if (hasQuery) {
    // D2 / D4：搜索态扁平结果头部
    const resHead = el('div', 'ai-pick-res-head');
    resHead.append(el('span', 'n', `${rawHosts.length} 条结果`));
    if (rawHosts.length > 0) {
      const actLabel = rawHosts.length > 10 ? '选择前 10 条' : '全选结果';
      const selectResBtn = btn(actLabel, 'act ai-pick-select-results ai-target-hosts-select-all');
      selectResBtn.dataset.scopeAction = 'select-results';
      selectResBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const keys = rawHosts.map((h) => h.hostId).filter(Boolean);
        if (targetHandlers.onSelectSearchResults) targetHandlers.onSelectSearchResults(keys);
        else targetHandlers.onToggleAll?.(true);
      });
      resHead.append(selectResBtn);
    }
    list.append(resHead);

    if (rawHosts.length === 0) {
      // D4：搜索无结果
      const emptyBox = el('div', 'ai-pick-empty ai-target-hosts-empty');
      emptyBox.append(el('div', 't', `没有匹配 "${query.trim()}" 的主机或目录`));
      const resetBtn = btn('清空搜索', 's ai-pick-empty-reset');
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (targetHandlers.onClearSearch) targetHandlers.onClearSearch();
        else targetHandlers.onSearch?.('');
      });
      emptyBox.append(resetBtn);
      listEl.append(emptyBox);
    } else {
      for (const h of rawHosts) {
        listEl.append(createHostRow(h, { isSearch: true }));
      }
    }
  } else {
    // D1 / D3：按目录分组 + 三态方框
    if (groups.length === 0) {
      listEl.append(el('div', 'ai-pick-empty ai-target-hosts-empty', '还没有配置主机'));
    } else {
      for (const g of groups) {
        const dirRow = el('div', 'ai-pick-dir' + (g.expanded ? ' is-expanded' : ''));
        dirRow.dataset.folder = g.name;
        const chev = el('span', 'ai-pick-chev');
        chev.innerHTML = g.expanded
          ? '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
          : '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
        const dirName = el('span', 'ai-pick-dir-name', g.name);
        dirName.title = g.name;
        const dirCount = el('span', 'ai-pick-dir-count', `${g.selectedCount}/${g.totalCount}`);
        const dirBox = createSwitch(g.state === 'all' ? 'on' : (g.state === 'part' ? 'half' : 'off'), {
          role: 'checkbox',
          extraClass: 'ai-pick-dir-sw',
        });
        dirBox.title = g.state === 'all' ? `取消全选「${g.name}」` : `全选「${g.name}」`;

        // B.1 #2/#3/#4：点右侧三态方框 = 整目录全选/全不选
        dirBox.addEventListener('click', (e) => {
          e.stopPropagation();
          if (targetHandlers.onToggleGroup) {
            targetHandlers.onToggleGroup(g.name, g.keys);
          } else {
            for (const k of g.keys) targetHandlers.onToggleHost?.(k);
          }
        });

        // B.1 #1/#6：点目录行（非方框）= 展开/收起，不改选择
        dirRow.addEventListener('click', () => {
          targetHandlers.onToggleFolderExpand?.(g.name);
        });

        dirRow.append(chev, dirName, dirCount, dirBox);
        listEl.append(dirRow);

        if (g.expanded) {
          for (const h of g.hosts) {
            listEl.append(createHostRow(h, { isSearch: false }));
          }
        }
      }

      // D3：未选任何主机时在目录列表下方显示说明框
      if (scopeCount === 0) {
        listEl.append(
          el(
            'div',
            'ai-pick-tip',
            '未选主机时 AI 只回答问题，不会连接任何机器。要它排查就勾上至少一台 —— 勾选即授予本会话的操作权限。',
          ),
        );
      }
    }
  }
  list.append(listEl);

  // 4. 底栏（40px）：左侧统计 + 右侧「完成」按钮
  const foot = el('div', 'ai-pick-foot');
  const footCntText = hasQuery && rawHosts.length > 0
    ? `搜 "${query.trim()}" · 命中 ${rawHosts.length} 台`
    : `${groupCount} 个目录 · ${totalHosts} 台`;
  foot.append(el('span', 'cnt', footCntText));
  const doneBtn = btn('完成', 'ai-pick-done' + (scopeCount === 0 ? ' off' : ''));
  doneBtn.dataset.scopeAction = 'done';
  doneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (targetHandlers.onDone) targetHandlers.onDone();
    else closeTargetMenu({ focusTrigger: true });
  });
  foot.append(doneBtn);
  list.append(foot);

  const menu = $('#ai-scope-menu');
  const trigger = $('#ai-scope-trigger');
  if (menu && trigger && !menu.classList.contains('hidden') && typeof trigger.getBoundingClientRect === 'function') {
    anchorMenu(menu, trigger, { placement: 'top', width: 344, height: 340 });
  }

  if (focusHostId) {
    const row = list.querySelector(`.ai-target-host[data-host-id="${CSS.escape(focusHostId)}"]`);
    row?.focus?.();
  }
}

export function openTargetMenu(menuData, handlers) {
  const menu = $('#ai-scope-menu');
  const trigger = $('#ai-scope-trigger');
  if (!menu || !trigger || trigger.disabled) return;
  $('#ai-model-menu')?.classList.add('hidden');
  $('#ai-thread-menu')?.classList.add('hidden');
  $('#ai-mode-menu')?.classList.add('hidden');

  if (menuData) renderTargetMenu(menuData, handlers);
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  anchorMenu(menu, trigger, { placement: 'top', width: 344, height: 340 });

  const searchInp = menu.querySelector('.ai-pick-search-inp');
  if (searchInp) searchInp.focus?.();
}

export function closeTargetMenu({ focusTrigger = false } = {}) {
  const menu = $('#ai-scope-menu');
  const trigger = $('#ai-scope-trigger');
  if (menu) menu.classList.add('hidden');
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger && typeof trigger.focus === 'function') trigger.focus();
  }
}

export function toggleTargetMenu(menuData, handlers) {
  const menu = $('#ai-scope-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openTargetMenu(menuData, handlers);
  else closeTargetMenu();
}

/// 这次点击是否来自指定菜单/触发钮内部。
export function clickFromMenu(event, ids) {
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
  if (path.some((node) => node && ids.includes(node.id))) return true;
  return ids.some((id) => !!event?.target?.closest?.(`#${id}`));
}

export function onTargetMenuKeydown(e) {
  const menu = $('#ai-scope-menu');
  menuKeydown(e, menu, '.ai-target-host', { onClose: closeTargetMenu });
}
