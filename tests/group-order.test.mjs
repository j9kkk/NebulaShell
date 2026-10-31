// 分组目录次序解析(主机库左栏拖拽排序的排序内核)。纯函数,不碰 DOM。
// Run: node --experimental-vm-modules --test tests/group-order.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const state = { settings: { ui: {} }, hosts: [] };
const imports = {
  './core.js': {
    $: () => null,
    PROVIDER_LABEL: { tencent: '腾讯云', aliyun: '阿里云' },
    api: async () => ({}),
    askConfirm: async () => true,
    closeModal() {}, copyText() {}, openModal() {}, showCtxMenu() {},
    state,
    toast() {},
  },
  '../shared/icons.js': { icon: () => '' },
  './terminal.js': { connectHost: async () => {}, rankPickerHosts: (x) => x, refreshPickers() {} },
};

async function loadHosts() {
  const context = vm.createContext({ console });
  const module = new vm.SourceTextModule(
    await readFile(new URL('../src/modules/hosts.js', import.meta.url), 'utf8'),
    { context },
  );
  await module.link(async (specifier) => {
    const values = imports[specifier];
    assert.ok(values, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('sortGroupsByPref 按拖拽次序排;未记录的组保持原相对次序排在后面', async () => {
  const hosts = await loadHosts();
  state.settings.ui = { groupOrder: ['zzz', '生产'] };
  assert.deepEqual(
    [...hosts.sortGroupsByPref(['aaa', '生产', 'zzz', '测试'])],
    ['zzz', '生产', 'aaa', '测试'],
    '拖拽过的组先按记录次序,其余保持传入顺序',
  );
});

test('没有拖拽记录时保持原样,且不改动传入数组', async () => {
  const hosts = await loadHosts();
  state.settings.ui = {};
  const input = ['b', 'a', 'c'];
  const out = hosts.sortGroupsByPref(input);
  assert.deepEqual([...out], ['b', 'a', 'c'], '空记录 = 不做任何重排');
  assert.deepEqual(input, ['b', 'a', 'c'], '返回新数组,不就地改入参');
  assert.notEqual(out, input);
});

test('次序里残留的旧组名(已改名/删除)不影响其余分组', async () => {
  const hosts = await loadHosts();
  state.settings.ui = { groupOrder: ['已删除的分组', 'c'] };
  assert.deepEqual([...hosts.sortGroupsByPref(['a', 'b', 'c'])], ['c', 'a', 'b']);
});
