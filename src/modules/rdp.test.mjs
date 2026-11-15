// RDP 窗格的纯逻辑:帧包解码、键鼠映射、滚轮量化。
// 这几条是前后端唯一的契约面(rdp.rs 的 encode_frame_packet / RdpInputPayload),
// 编解码任何一侧漂移都会让画面或输入整体失效,所以逐字段断言而不是只测往返。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_HEADER_LEN, FRAME_KIND_FULL, FRAME_MAGIC, FRAME_VERSION_RGB24, REMOTE_PIXEL_BUDGET, applyFramePacket, decodeFramePacket, expandRgb24, inflateFrameBody, queueFramePacket, fingerprintRows, fitRect, rdpMouseButton, scancodeFor, wheelSteps, remoteSizeFor } from './rdp.js';

/// 按后端 encode_frame_packet 的字段次序造一个帧包
function packet({ kind = 0, x = 0, y = 0, w = 2, h = 2, dw = 4, dh = 4, pixels = null } = {}) {
  const buf = new Uint8Array(FRAME_HEADER_LEN + w * h * 4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, kind, true);
  view.setUint16(8, x, true);
  view.setUint16(10, y, true);
  view.setUint16(12, w, true);
  view.setUint16(14, h, true);
  view.setUint16(16, dw, true);
  view.setUint16(18, dh, true);
  view.setUint32(20, 0, true);
  if (pixels) buf.set(pixels, FRAME_HEADER_LEN);
  return buf;
}

/// RGB24 版本(3):每像素 3 字节,解出来要标成 rgb 且像素长度按 3 校验
function rgbPacket({ w = 2, h = 2, pixels = null } = {}) {
  const buf = new Uint8Array(FRAME_HEADER_LEN + w * h * 3);
  const view = new DataView(buf.buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint16(4, FRAME_VERSION_RGB24, true);
  view.setUint16(6, 0, true);
  view.setUint16(12, w, true);
  view.setUint16(14, h, true);
  view.setUint16(16, w, true);
  view.setUint16(18, h, true);
  if (pixels) buf.set(pixels, FRAME_HEADER_LEN);
  return buf;
}

test('RGB24 帧包:v3 按每像素 3 字节校验,且标成 rgb', () => {
  const frame = decodeFramePacket(rgbPacket({ w: 3, h: 2 }));
  assert.ok(frame, 'v3 必须能解');
  assert.equal(frame.rgb, true);
  assert.equal(frame.compressed, false);
  assert.equal(frame.pixels.length, 3 * 2 * 3);
});

test('RGB24 帧包:像素不足 3 字节/像素时直接丢弃', () => {
  const buf = rgbPacket({ w: 4, h: 4 });
  assert.equal(decodeFramePacket(buf.subarray(0, FRAME_HEADER_LEN + 10)), null);
});

test('expandRgb24 把 alpha 补成 255 且颜色顺序不变', () => {
  const rgba = expandRgb24(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1);
  assert.deepEqual([...rgba], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('帧包解码:头部字段逐项对齐 encode_frame_packet 的布局', () => {
  const buf = packet({ kind: FRAME_KIND_FULL, x: 3, y: 7, w: 5, h: 6, dw: 40, dh: 30 });
  const frame = decodeFramePacket(buf);
  assert.ok(frame);
  assert.equal(frame.kind, FRAME_KIND_FULL);
  assert.equal(frame.x, 3);
  assert.equal(frame.y, 7);
  assert.equal(frame.width, 5);
  assert.equal(frame.height, 6);
  assert.equal(frame.desktopWidth, 40);
  assert.equal(frame.desktopHeight, 30);
  assert.equal(frame.pixels.length, 5 * 6 * 4);
});

test('帧包解码:magic 不对 / 头不全 / 像素不足都返回 null', () => {
  const bad = packet();
  bad[0] = 0x00;
  assert.equal(decodeFramePacket(bad), null, 'magic 不符');
  assert.equal(decodeFramePacket(new Uint8Array(10)), null, '头不全');
  const truncated = packet({ w: 8, h: 8 }).slice(0, FRAME_HEADER_LEN + 16);
  assert.equal(decodeFramePacket(truncated), null, '像素不足');
});

test('帧包解码:像素按 RGBA 原样透出(不重排、不换算)', () => {
  const pixels = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  const frame = decodeFramePacket(packet({ w: 2, h: 2, pixels }));
  assert.deepEqual([...frame.pixels], [...pixels]);
});

test('扫描码:常用键落在 XT Set 1,扩展键带 0xE000 前缀', () => {
  assert.equal(scancodeFor('KeyA'), 0x1e);
  assert.equal(scancodeFor('Enter'), 0x1c);
  assert.equal(scancodeFor('ShiftLeft'), 0x2a);
  assert.equal(scancodeFor('ControlLeft'), 0x1d);
  assert.equal(scancodeFor('F5'), 0x3f);
  assert.equal(scancodeFor('Space'), 0x39);
  // 方向键 / 右 Ctrl / 小键盘除号 / Win 键在 RDP 里是扩展键
  assert.equal(scancodeFor('ArrowUp'), 0xe048);
  assert.equal(scancodeFor('ControlRight'), 0xe01d);
  assert.equal(scancodeFor('NumpadDivide'), 0xe035);
  assert.equal(scancodeFor('MetaLeft'), 0xe05b);
  assert.equal(scancodeFor('UnknownKey'), null);
});

test('扫描码:全部为 0..0xE0FF 的整数,且不含重复映射', () => {
  const codes = ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F12', 'ArrowLeft', 'Insert', 'Delete'];
  const seen = new Set();
  for (const code of codes) {
    const value = scancodeFor(code);
    assert.equal(Number.isInteger(value), true, code);
    assert.ok(value >= 0 && value <= 0xe0ff, code);
    assert.equal(seen.has(value), false, `${code} 与前面的键撞码`);
    seen.add(value);
  }
});

test('鼠标按钮:DOM 的 3/4 映射到 RDP 的 X1/X2,其余原样', () => {
  assert.equal(rdpMouseButton(0), 0);
  assert.equal(rdpMouseButton(1), 1);
  assert.equal(rdpMouseButton(2), 2);
  assert.equal(rdpMouseButton(3), 8);
  assert.equal(rdpMouseButton(4), 9);
});

test('滚轮:累积到阈值才发一档 120 单位,方向与 DOM 相反', () => {
  assert.equal(wheelSteps(0), 0);
  assert.equal(wheelSteps(40), 0);
  assert.equal(wheelSteps(120), -120);
  assert.equal(wheelSteps(-120), 120);
});

test('远端尺寸:无布局信息时返回 null,不猜默认值', () => {
  assert.equal(remoteSizeFor({ surface: null }), null);
});

test('等比适应:画面按远端比例缩到画布内并居中留边,绝不拉伸', () => {
  // 1280×800 画进 1011×1294 的窄高画布:受宽度限制,上下留边
  const narrow = fitRect({ canvas: { width: 1011, height: 1294 }, desktop: { width: 1280, height: 800 } });
  assert.equal(Math.round(narrow.scale * 1280), 1011);
  assert.equal(Math.round(narrow.scale * 800), 632);
  assert.equal(Math.round(narrow.ox), 0);
  assert.equal(Math.round(narrow.oy), 331);
  // 反过来画布更宽时受高度限制,左右留边
  const wide = fitRect({ canvas: { width: 2032, height: 1000 }, desktop: { width: 1280, height: 800 } });
  assert.equal(Math.round(wide.scale * 800), 1000);
  assert.ok(Math.abs(wide.ox - (2032 - 1280 * wide.scale) / 2) < 0.001);
  // 无桌面尺寸时不产生 NaN / Infinity
  const empty = fitRect({ canvas: { width: 10, height: 10 }, desktop: { width: 0, height: 0 } });
  assert.ok(Number.isFinite(empty.scale) && empty.scale > 0);
});

test('指纹分行:32 字节按 16 字节折成固定两行,其余原样转义', () => {
  const fp = 'SHA256:' + Array.from({ length: 32 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const html = fingerprintRows(fp);
  assert.equal((html.match(/rdp-fp-line/g) || []).length, 2);
  assert.ok(html.includes('00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F'));
  assert.ok(html.includes('10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F'));
  // 结构不符的输入(不是 32 字节)不硬拆,原样显示
  assert.equal(fingerprintRows('SHA256:AB:CD'), 'SHA256:AB:CD');
  assert.equal(fingerprintRows(''), '');
});

/// 搭一套最小 DOM:离屏缓冲是 canvas,可见画布只需要记录 drawImage 调用。
function fakePane() {
  const puts = [];
  const draws = [];
  const canvas = { width: 0, height: 0, style: {} };
  const pane = {
    canvas,
    ctx: {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      clearRect() {},
      drawImage(...args) { draws.push(args); },
    },
    surface: { getBoundingClientRect: () => ({ width: 200, height: 100 }) },
    desktop: null,
    fb: null,
    fbCtx: null,
    puts,
    draws,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ImageData = class {
    constructor(data, width, height) {
      if (!(data.length === width * height * 4)) throw new Error('IndexSizeError: 像素数与尺寸不符');
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      style: {},
      getContext() {
        return {
          putImageData(image, x, y) { puts.push({ size: [image.width, image.height], x, y }); },
          drawImage() {},
        };
      },
    }),
  };
  return pane;
}

test('首帧就是脏矩形:按桌面尺寸建缓冲区并把像素放到 (x, y),不抛错', () => {
  const pane = fakePane();
  const frame = decodeFramePacket(packet({ kind: 0, x: 1, y: 1, w: 2, h: 2, dw: 4, dh: 4 }));
  assert.doesNotThrow(() => applyFramePacket(pane, frame));
  assert.equal(pane.fb.width, 4);
  assert.equal(pane.fb.height, 4);
  assert.deepEqual(pane.puts, [{ size: [2, 2], x: 1, y: 1 }]);
  assert.ok(pane.draws.length >= 1, '首帧要整体重绘');
  assert.deepEqual(pane.draws.at(-1).slice(1), [50, 0, 100, 100], '整桌面按等比适应铺满高度');
});

test('脏矩形:同一桌面尺寸只贴那一块并只重绘那一块', () => {
  const pane = fakePane();
  applyFramePacket(pane, decodeFramePacket(packet({ kind: FRAME_KIND_FULL, x: 0, y: 0, w: 4, h: 4, dw: 4, dh: 4 })));
  pane.puts.length = 0;
  pane.draws.length = 0;
  applyFramePacket(pane, decodeFramePacket(packet({ kind: 0, x: 2, y: 0, w: 1, h: 1, dw: 4, dh: 4 })));
  assert.deepEqual(pane.puts, [{ size: [1, 1], x: 2, y: 0 }]);
  assert.equal(pane.draws.length, 1);
  assert.deepEqual(pane.draws[0].slice(1), [2, 0, 1, 1, 100, 0, 25, 25], '只重采样这一块');
});

test('像素不足的帧包直接丢掉,不写脏缓冲区', () => {
  const pane = fakePane();
  const frame = { kind: 0, x: 0, y: 0, width: 4, height: 4, desktopWidth: 4, desktopHeight: 4, pixels: new Uint8Array(4) };
  applyFramePacket(pane, frame);
  assert.deepEqual(pane.puts, []);
});

test('远端尺寸:超过像素预算就等比缩,保住比例且不超过上限', () => {
  const pane = { surface: { getBoundingClientRect: () => ({ width: 1500, height: 900 }) } };
  globalThis.window = { devicePixelRatio: 2 };
  const size = remoteSizeFor(pane);
  assert.ok(size.width * size.height <= REMOTE_PIXEL_BUDGET * 1.02, '像素数要落在预算内');
  assert.ok(Math.abs(size.width / size.height - 1500 / 900) < 0.02, '比例不能变');
  assert.ok(size.width % 2 === 0 && size.height % 2 === 0, '宽高取偶数');
  // 小窗格不受预算影响,仍按 DPR 提清晰度
  const small = remoteSizeFor({ surface: { getBoundingClientRect: () => ({ width: 600, height: 400 }) } });
  assert.deepEqual(small, { width: 1200, height: 800, scaleFactor: 2 });
});

test('远端尺寸:主机钉死分辨率时照它连,忽略窗格尺寸', () => {
  globalThis.window = { devicePixelRatio: 2 };
  const pane = {
    host: { rdpDisplay: { resolution: '1920x1080' } },
    surface: { getBoundingClientRect: () => ({ width: 600, height: 400 }) },
  };
  assert.deepEqual(remoteSizeFor(pane), { width: 1920, height: 1080, scaleFactor: 2, fixed: true });
  // auto 仍按窗格走
  const auto = remoteSizeFor({
    host: { rdpDisplay: { resolution: 'auto' } },
    surface: { getBoundingClientRect: () => ({ width: 600, height: 400 }) },
  });
  assert.deepEqual(auto, { width: 1200, height: 800, scaleFactor: 2 });
});

test('远端尺寸:主机像素上限覆盖默认预算', () => {
  globalThis.window = { devicePixelRatio: 1 };
  const pane = {
    host: { rdpDisplay: { pixelBudget: 400000 } },
    surface: { getBoundingClientRect: () => ({ width: 1500, height: 900 }) },
  };
  const size = remoteSizeFor(pane);
  assert.ok(size.width * size.height <= 400000 * 1.02, '要落在主机设定的上限内');
});

test('一帧内的多个帧包合成一次重绘,只画包围盒', async () => {
  const pane = fakePane();
  applyFramePacket(pane, decodeFramePacket(packet({ kind: FRAME_KIND_FULL, x: 0, y: 0, w: 8, h: 8, dw: 8, dh: 8 })));
  pane.puts.length = 0;
  pane.draws.length = 0;
  queueFramePacket(pane, decodeFramePacket(packet({ kind: 0, x: 0, y: 0, w: 1, h: 1, dw: 8, dh: 8 })));
  queueFramePacket(pane, decodeFramePacket(packet({ kind: 0, x: 6, y: 6, w: 2, h: 2, dw: 8, dh: 8 })));
  assert.equal(pane.draws.length, 0, '还没到动画帧,不画');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(pane.puts.length, 2, '两块都贴进缓冲');
  assert.equal(pane.draws.length, 1, '只重绘一次');
  // 画布 200x100、桌面 8x8 → scale 12.5、oy 0、ox 50
  assert.deepEqual(pane.draws[0].slice(1), [0, 0, 8, 8, 50, 0, 100, 100]);
});

test('压缩帧:v2 头解出 compressed 标记,帧体不再按像素数校验', () => {
  const buf = packet({ kind: 0, x: 1, y: 2, w: 40, h: 30, dw: 64, dh: 48, pixels: null });
  const view = new DataView(buf.buffer);
  view.setUint16(4, 2, true); // 版本 2 = deflate
  const short = buf.subarray(0, FRAME_HEADER_LEN + 10);
  const frame = decodeFramePacket(short);
  assert.ok(frame, '压缩帧体体积与原像素数无关');
  assert.equal(frame.version, 2);
  assert.equal(frame.compressed, true);
  assert.equal(frame.pixels.length, 10);
  assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [1, 2, 40, 30]);
});

test('压缩帧:inflate 后像素与原始 RGBA 一致(引擎支持 DecompressionStream 时)', async (t) => {
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') {
    t.skip('当前 Node 没有 CompressionStream');
    return;
  }
  const width = 8, height = 8;
  const raw = new Uint8Array(width * height * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 251;
  const packed = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
  const header = packet({ kind: 0, x: 0, y: 0, w: width, h: height, dw: width, dh: height, pixels: null });
  const view = new DataView(header.buffer);
  view.setUint16(4, 2, true);
  const frame = decodeFramePacket(new Uint8Array([...header.subarray(0, FRAME_HEADER_LEN), ...packed]));
  assert.ok(frame?.compressed);
  const pixels = await inflateFrameBody(frame.pixels);
  assert.deepEqual([...pixels], [...raw]);
});
