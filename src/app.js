// NebulaShell 渲染层入口:只做装配,具体实现见 modules/
// 拆分前这里是 3092 行的单文件;按域拆成 modules/ 后本文件仅保留入口与全局样式引入。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import './modules/entry.js';
