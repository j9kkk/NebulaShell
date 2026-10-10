// Focused module-level regression tests; no browser, network, or native app.
// Run: node --experimental-vm-modules --test e2e/host_cloud_ux.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
class Element {
  value = '';
  textContent = '';
  children = [];
  dataset = {};
  events = {};
  checked = false;
  disabled = false;
  className = '';
  classList = { add() {}, remove() {}, toggle() {} };
  get options() { return this.children; }
  get selectedOptions() { return this.children.filter((c) => c.selected); }
  set innerHTML(html) {
    this.html = html;
    this.children = [];
    for (const match of html.matchAll(/<(input|button)\b([^>]*)>/g)) {
      const child = new Element();
      child.className = /class="([^"]+)"/.exec(match[2])?.[1] || '';
      const identity = /data-instance="([^"]+)"/.exec(match[2]);
      if (identity) child.dataset.instance = decode(identity[1]);
      child.checked = /\bchecked\b/.test(match[2]);
      this.children.push(child);
    }
  }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, fn) { this.events[type] = fn; }
  querySelectorAll(selector) {
    const cls = selector.slice(1).split(':')[0];
    return this.children.flatMap((c) => [c, ...c.querySelectorAll(selector)]).filter((c) =>
      c.className.split(' ').includes(cls) && (!selector.includes(':checked') || c.checked));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
}

async function fixture() {
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const calls = [], connections = [], copies = [];
  const state = { cloudResults: [], hosts: [], sessions: new Map(), activeId: null };
  let fingerprints = [];
  const context = vm.createContext({
    document: {
      createElement: () => new Element(),
      querySelectorAll: () => $('#cloud-tbody').querySelectorAll('.cloud-check:checked'),
    },
  });
  const core = {
    $, state, PROVIDER_LABEL: { cvm: '腾讯云', lighthouse: '腾讯云轻量', aliyun: '阿里云' },
    api: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === 'hosts:save') return { id: payload.cloud?.instanceId || payload.id || 'saved' };
      if (channel === 'hosts:list') return [];
      if (channel === 'fingerprints:list') return fingerprints;
      return {};
    },
    askConfirm: async () => true,
    closeModal() {}, openModal() {}, showCtxMenu() {}, toast() {},
    copyText: async (text) => { copies.push(text); return true; },
  };
  const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
  const modules = new Map([
    ['./core.js', synthetic(core)],
    ['./terminal.js', synthetic({ connectHost: (id) => connections.push(id) })],
    ['../shared/icons.js', synthetic({ icon: (name) => `<svg data-icon="${name}"></svg>` })],
  ]);
  for (const name of ['hosts', 'cloud']) {
    modules.set(`./${name}.js`, new vm.SourceTextModule(await readFile(new URL(`../src/modules/${name}.js`, import.meta.url), 'utf8'), { context }));
  }
  const cloud = modules.get('./cloud.js');
  await cloud.link((specifier) => modules.get(specifier));
  await cloud.evaluate();
  return { $, state, calls, connections, copies, cloud: cloud.namespace, hosts: modules.get('./hosts.js').namespace, setFingerprints: (list) => { fingerprints = list; } };
}
const instance = (id, region, accountId = 'account') => ({
  name: id, host: `192.0.2.${id.length}`, state: 'RUNNING',
  cloud: { accountId, provider: 'cvm', region, instanceId: id },
});

test('grouped cloud rows connect the exact instance, not original-array display index', async () => {
  const f = await fixture();
  f.state.cloudResults = [instance('first', 'a'), instance('second', 'b'), instance('third', 'a')];
  f.cloud.renderCloudRows();
  const buttons = f.$('#cloud-tbody').querySelectorAll('.cloud-connect');
  assert.equal(buttons.length, 3);
  await buttons[1].events.click();
  assert.equal(f.calls.find((call) => call.channel === 'hosts:save').payload.cloud.instanceId, 'third');
  assert.deepEqual(f.connections, ['third']);
});

test('selected grouped cloud imports preserve scoped stable identity after result reordering', async () => {
  const f = await fixture();
  const a = instance('same', 'a', 'account-a');
  const b = instance('same', 'a', 'account-b');
  assert.notEqual(f.cloud.cloudInstanceIdentity(a), f.cloud.cloudInstanceIdentity(b));
  f.state.cloudResults = [a, instance('other', 'b'), b];
  f.cloud.renderCloudRows();
  const checks = f.$('#cloud-tbody').querySelectorAll('.cloud-check');
  checks.forEach((c) => { c.checked = false; });
  checks[1].checked = true; // Second grouped row is account-b, not 'other'.
  f.state.cloudResults.reverse();
  await f.cloud.cloudImportSelected();
  const imports = f.calls.filter((call) => call.channel === 'hosts:save');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].payload.cloud.accountId, 'account-b');
  assert.equal(imports[0].payload.cloud.instanceId, 'same');
});

test('async repeated cloud imports retain identity across cloud IP/name updates without sending secret replacements', async () => {
  const f = await fixture();
  const original = instance('stable-id', 'a');
  const refreshed = { ...original, name: 'cloud-renamed', host: '192.0.2.99' };
  assert.equal(f.cloud.cloudInstanceIdentity(original), f.cloud.cloudInstanceIdentity(refreshed));
  await f.cloud.importInstance(original);
  await f.cloud.importInstance(refreshed);
  const imports = f.calls.filter((call) => call.channel === 'hosts:save');
  assert.equal(imports.length, 2);
  assert.equal(imports[1].payload.host, '192.0.2.99');
  assert.deepEqual(imports[0].payload.cloud, imports[1].payload.cloud);
  for (const call of imports) {
    assert.equal(call.payload.id, undefined); // Cloud identity selects preserve mode in Store.
    assert.equal(call.payload.password, undefined);
    assert.equal(call.payload.privateKey, undefined);
    assert.equal(call.payload.passphrase, undefined);
    assert.equal(call.payload.clearSecrets, undefined);
  }
});

test('stale selections are rejected rather than retargeted', async () => {
  const f = await fixture();
  const it = instance('original', 'a');
  assert.throws(() => f.cloud.selectedCloudInstances([instance('replacement', 'a')], [{ dataset: { instance: f.cloud.cloudInstanceIdentity(it) } }]), /实例列表已变化/);
});

test('fingerprint modal exposes and copies the full fingerprint accessibly', async () => {
  const f = await fixture();
  const fp = `SHA256:${'long-fingerprint-content-'.repeat(5)}`;
  f.setFingerprints([{ id: 'server.test:22', fp }]);
  await f.hosts.openFingerprints();
  const row = f.$('#fp-tbody').children[0];
  assert.ok(row.innerHTML.includes(fp));
  assert.ok(row.innerHTML.includes('tabindex="0"'));
  assert.ok(row.innerHTML.includes('aria-label="完整主机指纹"'));
  await row.querySelector('.fp-copy').events.click();
  assert.deepEqual(f.copies, [fp]);
});

test('host modal resets secret-clear controls and explicitly serializes selected clears', async () => {
  const f = await fixture();
  f.$('#host-clear-password').checked = true;
  f.$('#host-clear-key').checked = true;
  f.hosts.openHostModal({ id: 'host', name: 'edited', host: 'server.test', username: 'root', port: 22, authType: 'password', hasPassword: true, tags: ['ops'] });
  assert.equal(f.$('#host-clear-password').checked, false);
  assert.equal(f.$('#host-clear-key').checked, false);
  f.$('#host-clear-password').checked = true;
  f.$('#host-clear-passphrase').checked = true;
  f.$('#host-tags').value = 'ops, team, ';
  await f.hosts.saveHostModal();
  const payload = f.calls.find((call) => call.channel === 'hosts:save').payload;
  assert.deepEqual(Array.from(payload.clearSecrets), ['password', 'passphrase']);
  assert.deepEqual(Array.from(payload.tags), ['ops', 'team']);
  assert.equal(payload.password, undefined);
});
