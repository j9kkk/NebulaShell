import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() {
    this.value = ''; this.children = []; this.dataset = {}; this.disabled = false;
    this._text = ''; this._html = ''; this.attributes = new Map(); this.listeners = new Map();
    this.style = {};
    const classes = new Set();
    this.classList = {
      add: (...items) => items.forEach((x) => classes.add(x)),
      remove: (...items) => items.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x, on) => (on ?? !classes.has(x)) ? classes.add(x) : classes.delete(x),
    };
  }
  set textContent(value) { this._text = String(value ?? ''); this._html = ''; }
  get textContent() { return this._text; }
  set innerHTML(value) { this._html = String(value); this._text = this._html.replace(/<[^>]+>/g, ''); this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? ''; }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 100, top: 200, width: 80, height: 24, right: 180, bottom: 224 }; }
}

async function createMonitorModule() {
  const domMap = new Map();
  const getEl = (sel) => {
    const id = sel.startsWith('#') ? sel.slice(1) : sel;
    if (!domMap.has(id)) {
      const el = new Element();
      el.id = id;
      domMap.set(id, el);
    }
    return domMap.get(id);
  };

  const state = {
    activeId: 'sess-1',
    metrics: new Map(),
    metricHistory: new Map(),
    settings: { snippets: [] },
  };

  const core = {
    $: (sel) => getEl(sel),
    api: async () => {},
    askPrompt: async () => null,
    closeModal: () => {},
    openModal: () => {},
    state,
    toast: () => {},
  };
  const interaction = {
    popupPosition: () => ({ left: 120, top: 600 }),
  };
  const terminal = {
    feedTrusted: async () => ({ ok: true }),
  };
  const icons = {
    icon: () => '<svg></svg>',
  };

  const context = vm.createContext({
    document: {
      body: new Element(),
      createElement: () => new Element(),
      querySelector: (sel) => getEl(sel),
    },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => {},
    },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    Math,
    Number,
    String,
    Array,
    Map,
    Set,
  });

  const code = await readFile(new URL('../src/modules/monitor.js', import.meta.url), 'utf8');
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(async (specifier) => {
    if (specifier === './core.js') return new vm.SyntheticModule(Object.keys(core), function() { for (const [k, v] of Object.entries(core)) this.setExport(k, v); }, { context });
    if (specifier === './interaction.js') return new vm.SyntheticModule(Object.keys(interaction), function() { for (const [k, v] of Object.entries(interaction)) this.setExport(k, v); }, { context });
    if (specifier === './terminal.js') return new vm.SyntheticModule(Object.keys(terminal), function() { for (const [k, v] of Object.entries(terminal)) this.setExport(k, v); }, { context });
    if (specifier === '../shared/icons.js') return new vm.SyntheticModule(Object.keys(icons), function() { for (const [k, v] of Object.entries(icons)) this.setExport(k, v); }, { context });
    throw new Error(`Unmapped import: ${specifier}`);
  });
  await mod.evaluate();
  return { mod: mod.namespace, state, domMap, getEl };
}

test('fmtPct / fmtLat 格式化与边界处理', async () => {
  const { mod } = await createMonitorModule();
  assert.equal(mod.fmtPct(null), '…');
  assert.equal(mod.fmtPct(0), '0%');
  assert.equal(mod.fmtPct(9.23), '9.2%');
  assert.equal(mod.fmtPct(100.0), '100%');

  assert.equal(mod.fmtLat(null), '–');
  assert.equal(mod.fmtLat(45), '45ms');
  assert.equal(mod.fmtLat(999), '999ms');
  assert.equal(mod.fmtLat(1500), '1.5s');
  assert.equal(mod.fmtLat(12000), '12s');
});

test('fmtBytes 速率与单位换算', async () => {
  const { mod } = await createMonitorModule();
  assert.equal(mod.fmtBytes(null), '–');
  assert.equal(mod.fmtBytes(512), '512B/s');
  assert.equal(mod.fmtBytes(1024), '1KB/s');
  assert.equal(mod.fmtBytes(1536), '1.5KB/s');
  assert.equal(mod.fmtBytes(1048576), '1MB/s');
  assert.equal(mod.fmtBytes(2.5 * 1048576), '2.5MB/s');
  assert.equal(mod.fmtBytes(1073741824), '1GB/s');
});

test('fmtMemPair 与 fmtDiskPair 量纲对齐', async () => {
  const { mod } = await createMonitorModule();
  assert.equal(mod.fmtMemPair(null, 976), '');
  assert.equal(mod.fmtMemPair(488, 976), '(488/976MB)');
  assert.equal(mod.fmtMemPair(8192, 24576), '(8/24GB)');
  assert.equal(mod.fmtMemPair(131072, 131072), '(128/128GB)');

  assert.equal(mod.fmtDiskPair(null, 1000), '');
  assert.equal(mod.fmtDiskPair(400, 1000), '(400/1000GB)');
  assert.equal(mod.fmtDiskPair(102.4, 200), '(102.4/200GB)');
  assert.equal(mod.fmtDiskPair(10240, 10240), '(10/10TB)');
});

test('calcNetCeiling 动态自适应标尺天花板计算', async () => {
  const { mod } = await createMonitorModule();
  // 小于 10KB/s 时兜底 10KB/s
  assert.equal(mod.calcNetCeiling(0), 10240);
  assert.equal(mod.calcNetCeiling(500), 10240);
  assert.equal(mod.calcNetCeiling(890), 10240);
  assert.equal(mod.calcNetCeiling(10240), 10240);

  // 120 KB/s
  const kb120 = 120 * 1024;
  const ceil120 = mod.calcNetCeiling(kb120);
  assert.ok(ceil120 >= kb120, '标尺必须能包容最大流量');

  // 2.4 MB/s -> 应该向上取整到合适阶梯 (如 5MB/s)
  const mb24 = 2.4 * 1024 * 1024;
  const ceil24 = mod.calcNetCeiling(mb24);
  assert.ok(ceil24 >= mb24);
  assert.equal(mod.fmtBytes(ceil24), '5MB/s');

  // 100 MB/s
  const mb100 = 100 * 1024 * 1024;
  const ceil100 = mod.calcNetCeiling(mb100);
  assert.ok(ceil100 >= mb100);
});

test('spark 字符走势生成', async () => {
  const { mod } = await createMonitorModule();
  assert.equal(mod.spark([]), '');
  assert.equal(mod.spark(null), '');
  const s = mod.spark([0, 50, 100]);
  assert.equal(s.length, 3);
  assert.equal(s[0], '▁');
  assert.equal(s[2], '█');
});

test('renderMonitorBar 正常采样下生成多维历史队列与 SVG 图表', async () => {
  const { mod, state, getEl } = await createMonitorModule();
  state.metrics.set('sess-1', {
    supported: true,
    cpuPct: 35.5,
    memPct: 45.2,
    memUsedMB: 7232,
    memTotalMB: 16000,
    diskPct: 52.0,
    diskUsedGB: 260,
    diskTotalGB: 500,
    rxBps: 204800,
    txBps: 51200,
    latencyMs: 38,
  });

  mod.renderMonitorBar();

  // 数值槽正确填入
  assert.equal(getEl('mon-cpu').textContent, '35.5%');
  assert.equal(getEl('mon-mem').textContent, '45.2%');
  assert.equal(getEl('mon-mem-det').textContent, '(7.1/15.6GB)');
  assert.equal(getEl('mon-disk').textContent, '52%');
  assert.equal(getEl('mon-rx').textContent, '200KB/s');
  assert.equal(getEl('mon-tx').textContent, '50KB/s');
  assert.equal(getEl('mon-lat').textContent, '38ms');

  // metricHistory 队列记录了多维数据 (解构转为主 realm 数组比对)
  const hist = state.metricHistory.get('sess-1');
  assert.ok(hist, 'metricHistory 必须已写入');
  assert.deepEqual([...hist.cpu], [35.5]);
  assert.deepEqual([...hist.mem], [45.2]);
  assert.deepEqual([...hist.rx], [204800]);
  assert.deepEqual([...hist.tx], [51200]);

  // 三张卡片的 SVG 图表路径已生成
  assert.ok(getEl('mon-pop-line').getAttribute('d').startsWith('M '));
  assert.ok(getEl('mon-mem-pop-line').getAttribute('d').startsWith('M '));
  assert.ok(getEl('mon-net-pop-rx-line').getAttribute('d').startsWith('M '));
  assert.ok(getEl('mon-net-pop-tx-line').getAttribute('d').startsWith('M '));
});

test('renderMonitorBar 兼容旧 Array 格式并安全转换', async () => {
  const { mod, state } = await createMonitorModule();
  // 模拟 monitorProbe 传入的旧普通数组
  state.metricHistory.set('sess-1', [10, 20, 30]);
  state.metrics.set('sess-1', {
    supported: true,
    cpuPct: 40,
    memPct: 50,
    memUsedMB: 2000,
    memTotalMB: 4000,
    diskPct: 60,
    diskUsedGB: 60,
    diskTotalGB: 100,
    rxBps: 1024,
    txBps: 2048,
    latencyMs: 50,
  });

  mod.renderMonitorBar();

  const hist = state.metricHistory.get('sess-1');
  assert.deepEqual([...hist.cpu], [10, 20, 30, 40]);
  assert.deepEqual([...hist.mem], [50]);
});
