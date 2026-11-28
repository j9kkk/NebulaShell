// 左轨（.side-rail）入口契约：一个图标一件事。
//
// 这条契约的由来：此前「主机」图标是唯一会改变布局的入口，而且随状态换壳 ——
// 展开态点=收起侧栏（终端变宽），收起态点=浮一张 264px 停靠卡（布局不动）。
// 同为左轨，其余图标却都是"打开一个界面"（模态/浮层/右侧面板），于是同一个图标、
// 同一次点按，一次是"布局变化"、一次是"弹窗"。用户无从预测。
//
// 现在定死两条规则（改动任何一条都需要同步本文与 CHANGELOG）：
//   R1  左轨「主机」= 侧栏开关，且只有这一件事：转发给 #btn-sidebar-toggle，
//       自己不改 class、不写宽度、不另开表面。展开态点=收起，收起态点=展开。
//   R2  其余左轨按钮 = 打开某功能界面（modal / popover / 右侧面板），
//       一律不改变窗口框架尺寸（不切侧栏、不切右侧栏宽度）。
// 旧「停靠卡」实现（sidebar-peek.js / .peek-open / --side-dock-w）已删除，不得复活。
//
// Run: node --experimental-vm-modules --test tests/rail-entries.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

/// 左轨按钮的静态清单：截到 .side-panel 结束（侧栏本体里的按钮不属于左轨）。
function railMarkup(html) {
  const start = html.indexOf('<div class="side-rail"');
  const end = html.indexOf('<div class="side-panel"');
  assert.ok(start > 0 && end > start, 'index.html 里找不到 .side-rail / .side-panel');
  return html.slice(start, end);
}

function railButtons(markup) {
  return [...markup.matchAll(/<button\b[^>]*>/g)].map((m) => {
    const tag = m[0];
    const attr = (name) => {
      const found = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
      return found ? found[1] : null;
    };
    return { tag, id: attr('id'), command: attr('data-command'), expanded: attr('aria-expanded') };
  });
}

// 左轨里没有走 data-command 的按钮，必须各自有显式的处理器（在哪个模块里写清）。
const EXPLICIT = {
  'rail-hosts': { module: 'src/modules/rail-cards.js', why: '侧栏开关' },
  'rail-session-status': { module: 'src/modules/rail-cards.js', why: '活动会话浮层' },
  'rail-transfers': { module: 'src/modules/file-transfer.js', why: '传输任务浮层' },
};

test('R1 左轨每个可见按钮都有归属：要么 data-command 命中注册表，要么登记在显式处理器清单里', async () => {
  const [html, entry] = await Promise.all([read('src/index.html'), read('src/modules/entry.js')]);
  const buttons = railButtons(railMarkup(html));
  assert.ok(buttons.length >= 8, `左轨按钮数量异常:${buttons.length}`);
  for (const btn of buttons) {
    assert.ok(btn.id, `<button> 缺 id，无法定位:${btn.tag}`);
    if (btn.command) {
      assert.ok(entry.includes(`registerCommand('${btn.command}'`),
        `#${btn.id} 的 data-command='${btn.command}' 在 entry.js 里没有注册`);
      continue;
    }
    const owner = EXPLICIT[btn.id];
    assert.ok(owner, `#${btn.id} 既没有 data-command，也不在显式处理器清单里 —— 会变成死按钮`);
    const source = await read(owner.module);
    assert.ok(source.includes(btn.id), `#${btn.id} 的显式处理器不在 ${owner.module}（登记的语义:${owner.why}）`);
  }
});

test('R1 左轨「主机」只做侧栏开关：转发到 #btn-sidebar-toggle，不自己改 class / 宽度 / 另开表面', async () => {
  const [rail, entry] = await Promise.all([read('src/modules/rail-cards.js'), read('src/modules/entry.js')]);
  assert.match(rail, /getElementById\('rail-hosts'\)\?\.addEventListener\('click',[\s\S]{0,200}?getElementById\('btn-sidebar-toggle'\)\?\.click\(\)/,
    '主机按钮必须转发给标题栏那一个入口(#btn-sidebar-toggle)，收起/展开的副作用只允许在 toggleSidebar 一处');
  // 主机按钮的处理器里不许出现第二套显隐逻辑
  const handler = rail.slice(rail.indexOf("getElementById('rail-hosts')?."), rail.indexOf("getElementById('rail-session-status')"));
  for (const forbidden of ['classList.add', 'classList.remove', 'style.width', 'openOverlay']) {
    assert.ok(!handler.includes(forbidden), `主机按钮的处理器里出现了 ${forbidden}：左轨不允许自己改侧栏状态`);
  }
  // toggleSidebar 仍是唯一实现：class 与宽度都在这里
  assert.match(entry, /function toggleSidebar\(\)[\s\S]*classList\.toggle\('collapsed'/, 'toggleSidebar 不见了或被搬家');
});

test('R2 侧栏收起/展开的入口收敛到 toggleSidebar：左轨不得给别的按钮挂 panel.sidebar', async () => {
  const html = await read('src/index.html');
  const rail = railMarkup(html);
  const buttons = railButtons(rail);
  const togglers = buttons.filter((b) => b.command === 'panel.sidebar');
  assert.equal(togglers.length, 0,
    '左轨不允许再挂 panel.sidebar：会与「主机」形成两个侧栏开关，语义重复');
  // 收起态下左轨按钮的 aria-expanded 只出现在侧栏开关和会话胶囊上
  const expandedIds = buttons.filter((b) => b.expanded !== null).map((b) => b.id).sort();
  assert.deepEqual(expandedIds, ['rail-hosts', 'rail-session-status'],
    'aria-expanded 只属于「侧栏开关」与「活动会话浮层」两个可开合入口');
});

test('停靠卡（peek）不得复活：sidebar-peek.js / .peek-open / --side-dock-w 全部下线', async () => {
  await assert.rejects(access(path.join(root, 'src/modules/sidebar-peek.js')), 'src/modules/sidebar-peek.js 已删除，不能重新引入');
  const [css, html, rail, entry] = await Promise.all([
    read('src/style.css'), read('src/index.html'), read('src/modules/rail-cards.js'), read('src/modules/entry.js'),
  ]);
  const sources = { 'src/style.css': css, 'src/index.html': html, 'src/modules/rail-cards.js': rail, 'src/modules/entry.js': entry };
  for (const [name, text] of Object.entries(sources)) {
    for (const needle of ['peek-open', 'side-dock-w', 'sidebar-peek']) {
      assert.ok(!text.includes(needle), `${name} 里仍有 ${needle}：收起态只能展开侧栏，不能再浮停靠卡`);
    }
  }
});
