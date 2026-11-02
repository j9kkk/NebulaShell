// 「给标签补 for」的守卫:包裹式标签(.switch 里包着 checkbox)不能被改写。
//
// 回归背景(0.6.25 → 未发布):导出卡的开关行改成设置页同款两列后,`.switch` 的
// label 落进了 `.form-grid`。bindModalInteractions 里那段补 for 的循环把它的
// htmlFor 指到了同一行的口令输入框,于是点开关等于点口令框 —— 「启用加密」永远
// 打不开。隐式关联(标签内部那个 input)必须优先。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const stubDocument = (labels) => ({
  querySelectorAll: (sel) => (sel === '.form-grid label' ? labels : []),
  querySelector: () => null,
  addEventListener() {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, append() {}, setAttribute() {}, addEventListener() {} }),
  body: { appendChild() {} },
});

async function loadCore(labels) {
  const context = vm.createContext({
    console,
    document: stubDocument(labels),
    window: { nebula: { platform: 'darwin', invoke: async () => ({ ok: true, data: null }) }, innerWidth: 1280, innerHeight: 800 },
    navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,
    setTimeout,
  });
  const cache = new Map();
  const load = async (name) => {
    const file = name.startsWith('../') ? name.replace('../', '../src/') : `../src/modules/${name}`;
    if (!cache.has(name)) {
      cache.set(name, new vm.SourceTextModule(await readFile(new URL(file, import.meta.url), 'utf8'), { context, identifier: name }));
    }
    return cache.get(name);
  };
  const core = await load('core.js');
  await core.link((s) => load(s.startsWith('./') ? s.slice(2) : s));
  await core.evaluate();
  return core.namespace;
}

test('包裹式标签(.switch)不被补 for:开关的可标注控件是它内部的 checkbox', async () => {
  const checkbox = { id: 'io-export-use-pass', tagName: 'INPUT' };
  // .switch 的下一个兄弟正是同一行的口令输入框 —— 旧实现会把它当成标签的目标
  const passInput = {
    id: 'io-export-pass-input',
    matches: (sel) => sel === 'input, select, textarea',
    querySelector: () => null,
  };
  const switchLabel = {
    htmlFor: undefined,
    querySelector: (sel) => (sel === 'input, select, textarea' ? checkbox : null),
    nextElementSibling: passInput,
  };
  const rawLabel = { htmlFor: undefined, querySelector: () => null, nextElementSibling: { id: 'io-export-dir', matches: () => true, querySelector: () => null } };

  const core = await loadCore([switchLabel, rawLabel]);
  core.linkFormGridLabels();

  assert.equal(switchLabel.htmlFor, undefined, '包裹式标签被改写了 for,点击将转发到同行输入框');
  assert.equal(rawLabel.htmlFor, 'io-export-dir', '裸标签应继续补上 for');
});
