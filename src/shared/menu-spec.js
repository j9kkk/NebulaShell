/// 一级菜单表:macOS 原生菜单栏(native-menu.js)与 Windows/Linux 标题栏里的菜单栏
/// (menubar.js)共用这一份。{ cmd } 是命令,{ predefined } 是 macOS 系统预定义项
/// (只在 mac),'-' 是分隔线;only: 'mac' | 'pc' 把条目限定在一个平台。
/// 标签、快捷键文字、勾选与禁用原因运行时取自命令注册表与 keymap。
/// 纯数据 + 纯函数,不 import 任何模块。

export const SEP = '-';
const cmd = (id, extra = {}) => ({ cmd: id, ...extra });
const pre = (item, text) => ({ predefined: item, text, only: 'mac' });

export const MENU_SPEC = [
  { submenu: 'NebulaShell', only: 'mac', items: [
    cmd('app.about'), SEP,
    cmd('settings.open'), SEP,
    pre('Services', '服务'), SEP,
    pre('Hide', '隐藏 NebulaShell'), pre('HideOthers', '隐藏其他'), pre('ShowAll', '全部显示'), SEP,
    cmd('app.quit'),
  ] },
  { submenu: '文件', items: [
    cmd('tab.new'), cmd('tab.rename'), SEP,
    cmd('pane.split'), cmd('tab.file.add'), SEP,
    cmd('files.revealLastDownload'), SEP,
    cmd('settings.open', { only: 'pc' }), SEP,
    cmd('workspace.close'), cmd('window.close', { only: 'mac' }), cmd('app.quit', { only: 'pc' }),
  ] },
  { submenu: '编辑', items: [
    pre('Undo', '撤销'), pre('Redo', '重做'), SEP,
    pre('Cut', '剪切'), pre('Copy', '拷贝'), pre('Paste', '粘贴'), pre('SelectAll', '全选'),
    cmd('term.copy', { only: 'pc' }), cmd('term.paste', { only: 'pc' }), SEP,
    cmd('session.search'), cmd('session.clear'),
  ] },
  { submenu: '视图', items: [
    cmd('palette.open'), SEP,
    cmd('panel.sidebar'), cmd('panel.tools'), SEP,
    cmd('panel.ai'), cmd('panel.history'), cmd('panel.snippets'), SEP,
    cmd('tabs.list'), cmd('workspace.tile'), cmd('pane.reflow'), cmd('pane.zoom'), SEP,
    pre('Fullscreen', '进入全屏'), cmd('window.fullscreen', { only: 'pc' }),
  ] },
  { submenu: '主机', items: [
    cmd('host.new'), cmd('cloud.import'), SEP,
    cmd('hosts.import'), cmd('hosts.export'), SEP,
    cmd('settings.fingerprints'), cmd('tools.forwards'), cmd('tools.batch'),
  ] },
  { submenu: '会话', items: [
    cmd('session.reconnect'), cmd('session.disconnect'), SEP,
    cmd('session.readonly'), cmd('session.log'), SEP,
    cmd('tools.broadcast'), cmd('session.diagnose'),
  ] },
  { submenu: '窗口', role: 'window', only: 'mac', items: [
    pre('Minimize', '最小化'), pre('Maximize', '缩放'), SEP,
    pre('BringAllToFront', '前置全部窗口'),
  ] },
  { submenu: '帮助', role: 'help', items: [
    cmd('palette.open', { text: '命令与快捷键…', accelerator: false, alias: 'help' }), SEP,
    cmd('app.about', { only: 'pc' }),
  ] },
];

/// 某平台('mac' | 'pc')的菜单表:去掉另一平台的条目,收拢开头、结尾与连续的分隔线。
export function specFor(platform, spec = MENU_SPEC) {
  const tidy = (items) => {
    const out = [];
    for (const item of items) {
      if (item !== SEP && item.only && item.only !== platform) continue;
      if (item === SEP && (!out.length || out.at(-1) === SEP)) continue;
      out.push(item.items ? { ...item, items: tidy(item.items) } : item);
    }
    while (out.at(-1) === SEP) out.pop();
    return out;
  };
  return tidy(spec);
}

/// 菜单表里出现的全部命令 id(可达性测试用)。
export function menuCommandIds(spec = MENU_SPEC) {
  const ids = new Set();
  const walk = (items) => { for (const it of items) { if (it.cmd) ids.add(it.cmd); if (it.items) walk(it.items); } };
  walk(spec);
  return [...ids];
}
