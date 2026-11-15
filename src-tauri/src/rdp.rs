//! RDP（IronRDP 纯 Rust 协议栈）后端。
//!
//! 链路：`SshService::open_target_stream`（直连 TCP 或多级 SSH `direct_tcpip` 隧道）
//! → X.224/MCS 协商 → TLS 升级 + TOFU 证书指纹守卫 → CredSSP(NLA) → ActiveStage 帧泵。
//!
//! 对外事件（前端 `nebula-shim` 把 `:` 映射成 `__`）：
//! - `rdp:state` `{sessionId, state: connecting|cert-confirm|connected|resized|disconnected|error, ...}`
//! - `rdp:cert_confirm` `{requestId, sessionId, fingerprint, sha256Hex, subject, issuer, validFrom, validTo}`
//!
//! 画面帧不走 JSON：`rdp:connect` 由前端传入 `frameChannel`（Tauri Channel），后端按
//! [`encode_frame_packet`] 的二进制格式推送脏矩形，避免整帧 Base64 阻塞 IPC。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use crate::rdp_clipboard::{
    build_format_data_response, spawn_local_poller, write_local_clipboard, ClipState,
    ClipboardBridge, SharedClip,
};
use base64::engine::general_purpose::STANDARD_NO_PAD as B64_NOPAD;
use base64::Engine as _;
use ironrdp_cliprdr::pdu::{ClipboardFormat, ClipboardFormatId};
use ironrdp_cliprdr::CliprdrClient;
use ironrdp_connector::connection_activation::ConnectionActivationFactory;
use ironrdp_connector::connection_activation::ConnectionActivationState;
use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{
    BitmapConfig, ClientConnector, Config, ConnectionResult, ConnectorError, ConnectorErrorExt,
    ConnectorResult, Credentials, DesktopSize, Sequence as _, ServerName,
};
use ironrdp_core::WriteBuf;
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp_dvc::DrdynvcClient;
use ironrdp_egfx::client::{GraphicsPipelineClient, GraphicsPipelineHandler};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::pointer::DecodedPointer;
use ironrdp_input::{
    synchronize_event, Database as InputDatabase, MouseButton, MousePosition, Operation, Scancode,
    WheelRotations,
};
use ironrdp_pdu::gcc;
use ironrdp_pdu::geometry::{InclusiveRectangle, Rectangle as _};
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::rdp::capability_sets::{self, MajorPlatformType};
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStageBuilder, ActiveStageOutput};
use ironrdp_svc::{StaticChannelSet, SvcProcessor as _};
use ironrdp_tls::CertificateValidation;
use ironrdp_tokio::{
    connect_begin, connect_finalize, mark_as_upgraded, split_tokio_framed, FramedWrite,
    NetworkClient, TokioFramed,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt as _, ReadHalf, WriteHalf};
use tokio::sync::{mpsc, oneshot, watch, Mutex as AsyncMutex};
use x509_cert::der::{Decode as _, Encode as _};

use crate::config::Store;
use crate::ssh::{SetupHandles, SshService};

/// 前端推帧回调：参数为 [`encode_frame_packet`] 产出的二进制包。
pub type FrameSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// 会话所用的具体流类型：TLS 包住的 SSH 隧道/直连流。
/// 写成具体类型而非泛型参数，是为了绕开 rustc 在 `tokio::spawn` 处的
/// higher-ranked lifetime 误报（泛型 S 的 `Send` 断言无法泛化）。
pub type RdpTlsStream = ironrdp_tls::TlsStream<crate::ssh::BoxStream>;

/// 会话事件发射器：把 `AppHandle` 收成具体类型，避免泛型 `Runtime` 参数
/// 让帧泵未来无法满足 `Send`（`tokio::spawn` 处会报 higher-ranked lifetime）。
pub type StateEmitter = Arc<dyn Fn(Value) + Send + Sync>;

/// TOFU 证书确认等待上限：超时按「拒绝」处理。
const CERT_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);
/// 单步握手（TCP/TLS/CredSSP 激活）超时。
const HANDSHAKE_STEP_TIMEOUT: Duration = Duration::from_secs(30);

// ───────────────────────────── 画面帧二进制协议 ─────────────────────────────

/// 帧包魔数 `NBFR`。
pub const FRAME_MAGIC: u32 = 0x5246_424E;
/// 帧包固定头长度。
pub const FRAME_HEADER_LEN: usize = 24;
/// 帧类型：脏矩形。
pub const FRAME_KIND_DIRTY: u16 = 0;
/// 帧类型：整帧（尺寸变化后的首帧）。
pub const FRAME_KIND_FULL: u16 = 1;

/// 一个画面帧包。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramePacket {
    pub version: u16,
    pub kind: u16,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub desktop_width: u16,
    pub desktop_height: u16,
    pub pixels: Vec<u8>,
}

/// 编码帧包：`magic(4) version(2) kind(2) x(2) y(2) w(2) h(2) dw(2) dh(2) reserved(4)` + RGBA 像素。
#[allow(clippy::too_many_arguments)]
pub fn encode_frame_packet(
    kind: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    desktop_width: u16,
    desktop_height: u16,
    pixels: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + pixels.len());
    out.extend_from_slice(&FRAME_MAGIC.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&y.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&desktop_width.to_le_bytes());
    out.extend_from_slice(&desktop_height.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(pixels);
    out
}

/// 帧包版本：1 = 像素原样（RGBA），2 = 像素用 zlib(deflate) 压缩过。
///
/// 远端桌面每帧是未压缩 RGBA，1600×1000 一帧就 6.4MB，30fps 意味着每秒近 200MB
/// 要跨进程拷到 webview —— 这是「能操作但卡顿」的主因。压缩后典型降到几百 KB。
pub const FRAME_VERSION_RAW: u16 = 1;
pub const FRAME_VERSION_DEFLATE: u16 = 2;
/// 3 = 像素压成 RGB24（丢掉恒为 0xFF 的 alpha 字节），4 = RGB24 + deflate。
///
/// 每帧 25% 的体积是 alpha，而它在传输前已经被强制成 0xFF —— 换句话说那 1/4 的
/// 流量全是常量。去掉后：裸帧小 25%，zlib 也少扫 1/4 的字节。
pub const FRAME_VERSION_RGB24: u16 = 3;
pub const FRAME_VERSION_RGB24_DEFLATE: u16 = 4;

/// 小于这个体积不值得压缩（zlib 头 + JS 解压开销）。
const FRAME_COMPRESS_MIN: usize = 4096;

/// 编码 RGB24 帧：能压缩就压成 v4，否则裸 v3。
#[allow(clippy::too_many_arguments)]
pub fn encode_frame_packet_rgb24(
    kind: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    desktop_width: u16,
    desktop_height: u16,
    pixels: &[u8],
) -> Vec<u8> {
    if pixels.len() >= FRAME_COMPRESS_MIN {
        if let Some(body) = deflate(pixels) {
            if body.len() < pixels.len() {
                return build_packet(
                    FRAME_VERSION_RGB24_DEFLATE,
                    kind,
                    x,
                    y,
                    width,
                    height,
                    desktop_width,
                    desktop_height,
                    &body,
                );
            }
        }
    }
    build_packet(
        FRAME_VERSION_RGB24,
        kind,
        x,
        y,
        width,
        height,
        desktop_width,
        desktop_height,
        pixels,
    )
}

/// 编码一帧：能压缩就压（解压不了再退回原样）。
#[allow(clippy::too_many_arguments)]
pub fn encode_frame_packet_deflate(
    kind: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    desktop_width: u16,
    desktop_height: u16,
    pixels: &[u8],
) -> Vec<u8> {
    if pixels.len() >= FRAME_COMPRESS_MIN {
        if let Some(body) = deflate(pixels) {
            if body.len() < pixels.len() {
                return build_packet(
                    FRAME_VERSION_DEFLATE,
                    kind,
                    x,
                    y,
                    width,
                    height,
                    desktop_width,
                    desktop_height,
                    &body,
                );
            }
        }
    }
    encode_frame_packet(
        kind,
        x,
        y,
        width,
        height,
        desktop_width,
        desktop_height,
        pixels,
    )
}

fn deflate(pixels: &[u8]) -> Option<Vec<u8>> {
    use std::io::Write as _;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(pixels).ok()?;
    encoder.finish().ok()
}

#[allow(clippy::too_many_arguments)]
fn build_packet(
    version: u16,
    kind: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    desktop_width: u16,
    desktop_height: u16,
    body: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + body.len());
    out.extend_from_slice(&FRAME_MAGIC.to_le_bytes());
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&kind.to_le_bytes());
    out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&y.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&desktop_width.to_le_bytes());
    out.extend_from_slice(&desktop_height.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// 解码帧包（前端与单测共用同一份格式定义）。
pub fn decode_frame_packet(buf: &[u8]) -> Option<FramePacket> {
    if buf.len() < FRAME_HEADER_LEN {
        return None;
    }
    if u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) != FRAME_MAGIC {
        return None;
    }
    let u16_at = |offset: usize| u16::from_le_bytes([buf[offset], buf[offset + 1]]);
    let version = u16_at(4);
    if version > FRAME_VERSION_RGB24_DEFLATE {
        return None;
    }
    let mut packet = FramePacket {
        version,
        kind: u16_at(6),
        x: u16_at(8),
        y: u16_at(10),
        width: u16_at(12),
        height: u16_at(14),
        desktop_width: u16_at(16),
        desktop_height: u16_at(18),
        pixels: buf[FRAME_HEADER_LEN..].to_vec(),
    };
    // 压缩帧的体积与原像素数无关，长度校验只对原样帧有意义
    let expected = match version {
        FRAME_VERSION_RAW => Some(usize::from(packet.width) * usize::from(packet.height) * 4),
        FRAME_VERSION_RGB24 => Some(usize::from(packet.width) * usize::from(packet.height) * 3),
        _ => None,
    };
    if let Some(expected) = expected {
        if packet.pixels.len() < expected {
            return None;
        }
        packet.pixels.truncate(expected);
    }
    Some(packet)
}

/// 从原始 RGBA 缓冲裁剪 `rect`（越界自动收敛，空矩形返回 `None`）。
pub fn crop_rgba(
    data: &[u8],
    stride: usize,
    bytes_per_pixel: usize,
    image_width: u16,
    image_height: u16,
    rect: &InclusiveRectangle,
) -> Option<(u16, u16, u16, u16, Vec<u8>)> {
    if image_width == 0 || image_height == 0 || bytes_per_pixel == 0 {
        return None;
    }
    if rect.left > rect.right || rect.top > rect.bottom {
        return None;
    }
    if rect.left >= image_width || rect.top >= image_height {
        return None;
    }
    let clamped = InclusiveRectangle {
        left: rect.left,
        top: rect.top,
        right: rect.right.min(image_width - 1),
        bottom: rect.bottom.min(image_height - 1),
    };
    let width = clamped.width();
    let height = clamped.height();
    if width == 0 || height == 0 {
        return None;
    }
    let row_bytes = usize::from(width) * bytes_per_pixel;
    let mut out = Vec::with_capacity(row_bytes * usize::from(height));
    for row in clamped.top..=clamped.bottom {
        let start = usize::from(row) * stride + usize::from(clamped.left) * bytes_per_pixel;
        let end = start + row_bytes;
        if end > data.len() {
            return None;
        }
        out.extend_from_slice(&data[start..end]);
    }
    Some((clamped.left, clamped.top, width, height, out))
}

/// 从 `DecodedImage` 裁剪脏矩形（帧泵热路径）。
pub fn extract_dirty_rect_rgba(
    image: &DecodedImage,
    rect: &InclusiveRectangle,
) -> Option<(u16, u16, u16, u16, Vec<u8>)> {
    let (x, y, width, height, mut pixels) = crop_rgba(
        image.data(),
        image.stride(),
        image.bytes_per_pixel(),
        image.width(),
        image.height(),
        rect,
    )?;
    force_opaque_rgba(&mut pixels);
    Some((x, y, width, height, pixels))
}

/// RGBA → RGB24（每像素丢第 4 字节）。
pub fn rgba_to_rgb24(pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len() / 4 * 3);
    for px in pixels.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
    out
}

/// 裁一块脏矩形并转成 RGB24（帧泵热路径）。
pub fn extract_dirty_rect_rgb24(
    image: &DecodedImage,
    rect: &InclusiveRectangle,
) -> Option<(u16, u16, u16, u16, Vec<u8>)> {
    let (x, y, width, height, pixels) = extract_dirty_rect_rgba(image, rect)?;
    Some((x, y, width, height, rgba_to_rgb24(&pixels)))
}

/// 把像素的第 4 字节强制为不透明。
///
/// 服务端 32bpp 位图的填充字节常是 `0x00`，原样当 alpha 交给画布会让整块画面全透明，
/// 前端只能看到画布底色 —— 表现就是「连上了但全黑」。
pub fn force_opaque_rgba(pixels: &mut [u8]) {
    for px in pixels.chunks_exact_mut(4) {
        px[3] = 0xFF;
    }
}

/// 整桌面一帧（前端据此建立/重建离屏缓冲区）。
pub fn encode_full_frame(image: &DecodedImage) -> Option<Vec<u8>> {
    let (_, _, _, _, mut pixels) = crop_rgba(
        image.data(),
        image.stride(),
        image.bytes_per_pixel(),
        image.width(),
        image.height(),
        &InclusiveRectangle {
            left: 0,
            top: 0,
            right: image.width().saturating_sub(1),
            bottom: image.height().saturating_sub(1),
        },
    )?;
    force_opaque_rgba(&mut pixels);
    let rgb = rgba_to_rgb24(&pixels);
    Some(encode_frame_packet_rgb24(
        FRAME_KIND_FULL,
        0,
        0,
        image.width(),
        image.height(),
        image.width(),
        image.height(),
        &rgb,
    ))
}

/// 合并多个脏矩形为一个包围盒（一帧一次 IPC，避免小矩形风暴）。
pub fn union_rect(rects: &[InclusiveRectangle]) -> Option<InclusiveRectangle> {
    let mut iter = rects.iter();
    let mut acc = iter.next()?.clone();
    for rect in iter {
        acc.left = acc.left.min(rect.left);
        acc.top = acc.top.min(rect.top);
        acc.right = acc.right.max(rect.right);
        acc.bottom = acc.bottom.max(rect.bottom);
    }
    Some(acc)
}

// ───────────────────────────── TOFU 证书指纹 ─────────────────────────────

/// RDP TOFU 存储键：`rdp:{host}:{port}`，与 SSH 的 `host:port` 同表不同前缀。
pub fn rdp_tofu_lookup_key(host: &str, port: u16) -> String {
    format!("rdp:{}:{}", host.trim(), port)
}

/// 计算 DER 的 SHA-256 指纹：`("SHA256:<base64-nopad>", "AA:BB:...")`。
pub fn compute_cert_sha256_fingerprints(der_bytes: &[u8]) -> (String, String) {
    let digest = Sha256::digest(der_bytes);
    let b64 = format!("SHA256:{}", B64_NOPAD.encode(digest));
    let hex = digest
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":");
    (b64, hex)
}

/// TOFU 判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TofuVerdict {
    /// 与本地记录一致，直接放行。
    Match,
    /// 首次见到该主机证书，需用户确认后落盘。
    FirstSeen,
    /// 与本地记录不一致：可能是重装，也可能是中间人。
    Mismatch { stored: String, current: String },
}

/// 纯判定：给定本地记录与服务器出示的指纹，得出 TOFU 结论。
pub fn tofu_verdict(stored: Option<&str>, current: &str) -> TofuVerdict {
    match stored {
        None => TofuVerdict::FirstSeen,
        Some(known) if known == current => TofuVerdict::Match,
        Some(known) => TofuVerdict::Mismatch {
            stored: known.to_string(),
            current: current.to_string(),
        },
    }
}

/// 指纹变更错误串，末尾附可机读标记 `[NB-FP key|stored|current]`（与 SSH 前端解析器共用）。
pub fn fingerprint_mismatch_error(key: &str, stored: &str, current: &str) -> String {
    format!(
        "RDP 服务端 TLS 证书指纹与本地记录不一致（该服务器可能更换过证书）。若非本人操作，请警惕中间人风险。[NB-FP {}|{}|{}]",
        key, stored, current
    )
}

/// RDP 服务端 TLS 证书摘要（TOFU 卡片展示用）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RdpCertSummary {
    pub lookup_key: String,
    /// `SHA256:<base64-nopad>`
    pub fingerprint: String,
    /// `AA:BB:...`
    pub sha256_hex: String,
    pub subject: String,
    pub issuer: String,
    pub valid_from: String,
    pub valid_to: String,
}

/// 从服务端证书提取摘要与用于 CredSSP 绑定的服务器公钥。
pub fn extract_cert_summary_and_pubkey(
    cert: &x509_cert::Certificate,
    host: &str,
    port: u16,
) -> Result<(RdpCertSummary, Vec<u8>), String> {
    let der = cert
        .to_der()
        .map_err(|e| format!("编码服务端证书 DER 失败: {e}"))?;
    let (fingerprint, sha256_hex) = compute_cert_sha256_fingerprints(&der);
    let tbs = cert.tbs_certificate();
    let subject = tbs.subject().to_string();
    let issuer = tbs.issuer().to_string();
    let validity = tbs.validity();
    let pub_key = tbs
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| "服务端证书公钥位串未对齐".to_string())?
        .to_vec();

    let summary = RdpCertSummary {
        lookup_key: rdp_tofu_lookup_key(host, port),
        fingerprint,
        sha256_hex,
        subject: if subject.trim().is_empty() {
            host.to_string()
        } else {
            subject
        },
        issuer: if issuer.trim().is_empty() {
            "Self-Signed".to_string()
        } else {
            issuer
        },
        valid_from: validity.not_before.to_string(),
        valid_to: validity.not_after.to_string(),
    };
    Ok((summary, pub_key))
}

// ───────────────────────────── 输入映射 ─────────────────────────────

/// 桌面尺寸规整：偶数宽、`200..=8192`（Display Control 的强约束）。
pub fn sanitize_rdp_dimensions(width: u32, height: u32) -> (u16, u16) {
    let w = if width == 0 { 1280 } else { width };
    let h = if height == 0 { 800 } else { height };
    let (w, h) = MonitorLayoutEntry::adjust_display_size(w, h);
    (w as u16, h as u16)
}

/// 前端 `rdp:input` 载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RdpInputPayload {
    MouseMove {
        x: u16,
        y: u16,
    },
    MouseButton {
        button: u8,
        pressed: bool,
        x: Option<u16>,
        y: Option<u16>,
    },
    Wheel {
        vertical: bool,
        delta: i16,
    },
    Scancode {
        code: u16,
        pressed: bool,
    },
    Unicode {
        ch: char,
        pressed: bool,
    },
    Combo {
        combo: String,
    },
    SyncLocks {
        scroll_lock: bool,
        num_lock: bool,
        caps_lock: bool,
    },
    ReleaseAll,
}

fn keyboard_flags(extended: bool, release: bool) -> KeyboardFlags {
    let mut flags = KeyboardFlags::empty();
    if extended {
        flags |= KeyboardFlags::EXTENDED;
    }
    if release {
        flags |= KeyboardFlags::RELEASE;
    }
    flags
}

/// 组合键展开为「按下…释放（逆序）」的扫描码序列。
pub fn expand_key_combo(combo: &str) -> Result<Vec<FastPathInputEvent>, String> {
    let normalized = combo.trim().to_ascii_lowercase().replace('-', "_");
    // (extended, scancode) —— XT Set 1
    let keys: Vec<(bool, u8)> = match normalized.as_str() {
        "ctrl_alt_del" | "cad" => vec![(false, 0x1D), (false, 0x38), (true, 0x53)],
        "win_r" => vec![(true, 0x5B), (false, 0x13)],
        "alt_tab" => vec![(false, 0x38), (false, 0x0F)],
        "win_l" | "lock" => vec![(true, 0x5B), (false, 0x26)],
        "ctrl_shift_esc" | "taskmgr" => vec![(false, 0x1D), (false, 0x2A), (false, 0x01)],
        other => return Err(format!("不支持的 RDP 组合键: {other}")),
    };

    let mut events = Vec::with_capacity(keys.len() * 2);
    for &(extended, code) in &keys {
        events.push(FastPathInputEvent::KeyboardEvent(
            keyboard_flags(extended, false),
            code,
        ));
    }
    for &(extended, code) in keys.iter().rev() {
        events.push(FastPathInputEvent::KeyboardEvent(
            keyboard_flags(extended, true),
            code,
        ));
    }
    Ok(events)
}

/// 把前端输入载荷应用到 `InputDatabase`，产出 FastPath 事件。
pub fn apply_input_payload(
    db: &mut InputDatabase,
    payload: &RdpInputPayload,
) -> Result<Vec<FastPathInputEvent>, String> {
    match payload {
        RdpInputPayload::MouseMove { x, y } => {
            let ops = [Operation::MouseMove(MousePosition { x: *x, y: *y })];
            Ok(db.apply(ops).into_vec())
        }
        RdpInputPayload::MouseButton {
            button,
            pressed,
            x,
            y,
        } => {
            let btn = MouseButton::from_web_button(*button)
                .ok_or_else(|| format!("无效的鼠标按键编号: {button}"))?;
            let mut ops = Vec::with_capacity(2);
            if let (Some(px), Some(py)) = (x, y) {
                ops.push(Operation::MouseMove(MousePosition { x: *px, y: *py }));
            }
            ops.push(if *pressed {
                Operation::MouseButtonPressed(btn)
            } else {
                Operation::MouseButtonReleased(btn)
            });
            Ok(db.apply(ops).into_vec())
        }
        RdpInputPayload::Wheel { vertical, delta } => {
            let ops = [Operation::WheelRotations(WheelRotations {
                is_vertical: *vertical,
                rotation_units: *delta,
            })];
            Ok(db.apply(ops).into_vec())
        }
        RdpInputPayload::Scancode { code, pressed } => {
            let sc = Scancode::from_u16(*code);
            let op = if *pressed {
                Operation::KeyPressed(sc)
            } else {
                Operation::KeyReleased(sc)
            };
            Ok(db.apply([op]).into_vec())
        }
        RdpInputPayload::Unicode { ch, pressed } => {
            let op = if *pressed {
                Operation::UnicodeKeyPressed(*ch)
            } else {
                Operation::UnicodeKeyReleased(*ch)
            };
            Ok(db.apply([op]).into_vec())
        }
        RdpInputPayload::Combo { combo } => {
            // 先释放残留修饰键，再发整段组合，避免 Ctrl 卡住
            let mut events = db.release_all().into_vec();
            events.extend(expand_key_combo(combo)?);
            Ok(events)
        }
        RdpInputPayload::SyncLocks {
            scroll_lock,
            num_lock,
            caps_lock,
        } => Ok(vec![synchronize_event(
            *scroll_lock,
            *num_lock,
            *caps_lock,
            false,
        )]),
        RdpInputPayload::ReleaseAll => Ok(db.release_all().into_vec()),
    }
}

// ───────────────────────────── 错误分类 ─────────────────────────────

/// 把 ironrdp / 网络错误归类成前端可渲染的错误码与中文提示。
pub fn classify_rdp_error(message: &str) -> (String, String) {
    let lower = message.to_ascii_lowercase();
    if message.contains("[NB-FP") {
        return ("CERT_CHANGED".to_string(), message.to_string());
    }
    if lower.contains("0x8009030c")
        || lower.contains("logon")
        || lower.contains("credssp")
        || lower.contains(" nla")
        || lower.contains("认证")
    {
        return (
            "AUTH_FAILED".to_string(),
            format!("远程桌面身份认证失败（请检查用户名、域或密码）: {message}"),
        );
    }
    if lower.contains("tls") || lower.contains("certificate") {
        return (
            "TLS_FAILED".to_string(),
            format!("RDP TLS 握手失败: {message}"),
        );
    }
    if lower.contains("超时") || lower.contains("timed out") || lower.contains("timeout") {
        return (
            "CONNECT_TIMEOUT".to_string(),
            format!("连接远程桌面超时: {message}"),
        );
    }
    if lower.contains("redirect") || lower.contains("重定向") {
        return (
            "REDIRECT_UNSUPPORTED".to_string(),
            "服务端要求会话重定向，当前不支持自动跳转。".to_string(),
        );
    }
    (
        "CONNECT_FAILED".to_string(),
        format!("RDP 会话建立失败: {message}"),
    )
}

// ───────────────────────────── 会话与命令 ─────────────────────────────

/// 发往会话主循环的控制指令。
#[derive(Debug)]
pub enum RdpCommand {
    Input(RdpInputPayload),
    Resize {
        width: u32,
        height: u32,
        scale_factor: Option<u32>,
    },
    Disconnect,
}

/// 在线 RDP 会话句柄。
pub struct RdpSession {
    pub session_id: String,
    pub host: Value,
    pub desktop_size: (u16, u16),
    pub hops: usize,
    pub epoch: u64,
    pub alive: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<RdpCommand>,
}

/// 局域网/直连场景下的空 NetworkClient：Kerberos KDC 代理未配置时回落 NTLM。
struct NoopNetworkClient;

impl NetworkClient for NoopNetworkClient {
    fn send(
        &mut self,
        _request: &NetworkRequest,
    ) -> impl std::future::Future<Output = ConnectorResult<Vec<u8>>> {
        async {
            Err(ConnectorError::general(
                "Kerberos KDC network proxy is not configured; using NTLM over CredSSP",
            ))
        }
    }
}

/// RDP 专用运行时：current-thread runtime + LocalSet，跑在独立线程上。
///
/// 存在的原因是 ironrdp 的握手链路里有 `!Send` 的未来：
/// - `ironrdp_async::NetworkClient::send` 返回的 `impl Future` 没有 `Send` 约束，
///   于是 `connect_finalize` 的整体未来不可证明为 `Send`；
/// - `Framed::read_by_hint(&dyn PduHint)` 同样把 trait object 跨 await 持有。
///
/// 把这些未来丢进 `tokio::spawn` 会直接编译不过，而它们又必须在同一个运行时里
/// 创建并驱动自己的 IO（tokio 的 IO 资源绑定运行时）。所以整个 RDP 链路独占一个
/// LocalSet，Tauri 侧只通过 channel 拿结果。
struct LocalRuntime {
    tx: mpsc::UnboundedSender<Box<dyn FnOnce() + Send + 'static>>,
}

impl LocalRuntime {
    fn new() -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Box<dyn FnOnce() + Send + 'static>>();
        std::thread::Builder::new()
            .name("rdp-runtime".to_string())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("[rdp] 启动专用运行时失败: {e}");
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&rt, async move {
                    while let Some(job) = rx.recv().await {
                        job();
                        tokio::task::yield_now().await;
                    }
                });
            })
            .ok();
        Self { tx }
    }

    /// 在 RDP 运行时里派生一个本地任务（未来不必是 `Send`）。
    fn spawn_local<F>(&self, make: F)
    where
        F: FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> + Send + 'static,
    {
        let job: Box<dyn FnOnce() + Send> = Box::new(move || {
            tokio::task::spawn_local(make());
        });
        let _ = self.tx.send(job);
    }
}

/// RDP 服务：持有会话表、取消信号与证书确认等待者。
pub struct RdpService {
    pub store: Arc<Store>,
    pub ssh: Arc<SshService>,
    sessions: AsyncMutex<HashMap<String, Arc<RdpSession>>>,
    cancels: AsyncMutex<HashMap<String, watch::Sender<bool>>>,
    cert_waiters: StdMutex<HashMap<String, oneshot::Sender<bool>>>,
    epoch: AtomicU64,
    /// 同步可读的在线会话计数（窗口关闭守卫在同步回调里，拿不到 tokio 锁）。
    live: AtomicU64,
    runtime: LocalRuntime,
}

impl RdpService {
    pub fn new(store: Arc<Store>, ssh: Arc<SshService>) -> Arc<Self> {
        Arc::new(Self {
            store,
            ssh,
            sessions: AsyncMutex::new(HashMap::new()),
            cancels: AsyncMutex::new(HashMap::new()),
            cert_waiters: StdMutex::new(HashMap::new()),
            epoch: AtomicU64::new(1),
            live: AtomicU64::new(0),
            runtime: LocalRuntime::new(),
        })
    }

    /// 在线会话数（同步、无锁；窗口关闭守卫用）。
    pub fn active_sessions(&self) -> usize {
        self.live.load(Ordering::SeqCst) as usize
    }

    fn add_session(
        &self,
        session: Arc<RdpSession>,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        async move {
            let mut map = self.sessions.lock().await;
            if map.insert(session.session_id.clone(), session).is_none() {
                self.live.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    fn drop_session<'a>(
        &'a self,
        session_id: &'a str,
    ) -> impl std::future::Future<Output = Option<Arc<RdpSession>>> + Send + 'a {
        async move {
            let removed = self.sessions.lock().await.remove(session_id);
            if removed.is_some() {
                self.live.fetch_sub(1, Ordering::SeqCst);
            }
            removed
        }
    }

    /// 在线会话数（关窗守卫用）。
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    pub async fn session_ids(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    /// 证书确认回调：`rdp:cert_reply` 命中挂起请求时返回 true。
    pub fn resolve_cert_decision(&self, request_id: &str, accept: bool) -> bool {
        let waiter = self
            .cert_waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id);
        match waiter {
            Some(tx) => tx.send(accept).is_ok(),
            None => false,
        }
    }

    /// 建立 RDP 会话：返回协商后的桌面尺寸；帧泵在后台任务里跑。
    ///
    /// 握手与帧泵都在 [`LocalRuntime`] 的 LocalSet 上执行，这里只等一个
    /// `oneshot` 结果——命令处理函数的未来因此保持 `Send`。
    pub async fn connect<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: tauri::AppHandle<R>,
        host_id: &str,
        session_id: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        frame_sink: Option<FrameSink>,
        prompt_cert: bool,
        compress_frames: bool,
    ) -> Result<Value, String> {
        let host = self.store.host_full(host_id)?;
        // 主机级显示/体验/网络设置(对标 mstsc)
        let settings = RdpSettings::from_host(&host);
        let frame_interval = match settings.frame_rate {
            None => FrameOut::AUTO_START, // 自适应档:从 60fps 起步,再按实测调
            Some(0) => Duration::ZERO,
            Some(fps) => frame_interval_for(fps),
        };
        let session_id = session_id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("rdp_{host_id}_{}", unix_millis()));
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst);

        // 同 sessionId 重连：旧代次先终止
        self.retire(&session_id).await;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.cancels
            .lock()
            .await
            .insert(session_id.clone(), cancel_tx);

        // 固定分辨率优先于「跟随窗口」;用户选了固定档就不要再被窗格尺寸改回去
        let (req_w, req_h) = match settings.resolution {
            Some((w, h)) => sanitize_rdp_dimensions(u32::from(w), u32::from(h)),
            None => sanitize_rdp_dimensions(width.unwrap_or(1280), height.unwrap_or(800)),
        };
        emit_state(
            &app,
            json!({
                "sessionId": session_id,
                "state": "connecting",
                "host": host["host"],
                "port": host["port"],
                "width": req_w,
                "height": req_h,
            }),
        );

        // 剪贴板共享状态：连接期与整个会话期共用，开关关掉就整条通道不注册
        let clip: Option<SharedClip> = settings
            .clipboard
            .then(|| Arc::new(StdMutex::new(ClipState::default())));

        let (ready_tx, ready_rx) = oneshot::channel::<Result<Value, String>>();
        let service = self.clone();
        let sid = session_id.clone();
        self.runtime.spawn_local(move || {
            Box::pin(async move {
                let mut cancel = cancel_rx.clone();
                let handshake = service.handshake(
                    app.clone(),
                    host,
                    sid.clone(),
                    epoch,
                    (req_w, req_h),
                    frame_sink,
                    prompt_cert,
                    cancel_rx,
                    compress_frames,
                    frame_interval,
                    settings,
                    clip,
                );
                tokio::pin!(handshake);
                let result = tokio::select! {
                    res = &mut handshake => res,
                    _ = wait_cancelled(&mut cancel) => Err("连接已取消".to_string()),
                };
                // 注意：这里**不能**把 cancels 里的发送端移除。
                // 握手成功后 run_session 仍然持有 cancel_rx，发送端被丢掉会让
                // `Receiver::changed()` 立刻返回 Err，帧泵以为「已手动断开」当场退出 ——
                // 表现就是连上瞬间弹「远程桌面已断开 · 已手动断开」。
                // 发送端由 disconnect / retire / drop_session 负责回收。

                let out = match result {
                    Ok(ready) => Ok(json!({
                        "sessionId": sid,
                        "width": ready.desktop_size.0,
                        "height": ready.desktop_size.1,
                        "hops": ready.hops,
                        "epoch": epoch,
                    })),
                    Err(err) => {
                        let (code, message) = classify_rdp_error(&err);
                        emit_state(
                            &app,
                            json!({
                                "sessionId": sid,
                                "state": "error",
                                "code": code,
                                "message": message,
                                "rawError": err,
                            }),
                        );
                        Err(message)
                    }
                };
                let _ = ready_tx.send(out);
            })
        });

        match ready_rx.await {
            Ok(result) => result,
            Err(_) => Err("RDP 会话任务异常退出".to_string()),
        }
    }

    /// 握手 → 注册会话 → 起帧泵。
    #[allow(clippy::too_many_arguments)]
    async fn handshake<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: tauri::AppHandle<R>,
        host: Value,
        session_id: String,
        epoch: u64,
        requested: (u16, u16),
        frame_sink: Option<FrameSink>,
        prompt_cert: bool,
        cancel_rx: watch::Receiver<bool>,
        compress_frames: bool,
        frame_interval: Duration,
        settings: RdpSettings,
        clip: Option<SharedClip>,
    ) -> Result<Ready, String> {
        let host_addr = host["host"].as_str().unwrap_or("").trim().to_string();
        if host_addr.is_empty() {
            return Err("未配置目标主机地址".to_string());
        }
        let port = host["port"]
            .as_i64()
            .filter(|p| (1..=65535).contains(p))
            .map(|p| p as u16)
            .unwrap_or(3389);
        let username = host["username"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Administrator")
            .to_string();
        let password = host["password"].as_str().unwrap_or("").to_string();
        let domain = host["domain"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);

        // 1. 底层流：直连 TCP 或多级 SSH 隧道（跳板句柄必须活到会话结束）
        let (stream, setup_handles) = tokio::time::timeout(
            HANDSHAKE_STEP_TIMEOUT,
            self.ssh.open_target_stream(&host, 3389),
        )
        .await
        .map_err(|_| format!("{host_addr}:{port} 连接超时"))??;
        let hops = setup_handles.0.len();

        // 2. X.224 / MCS 协商
        let config = build_client_config(
            username,
            password,
            domain,
            requested.0,
            requested.1,
            &settings,
        );
        let client_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
        let drdynvc = DrdynvcClient::new()
            .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
        // 剪贴板共享：CLIPRDR 静态通道，只广告 UTF-16 文本
        let mut connector = ClientConnector::new(config, client_addr).with_static_channel(drdynvc);
        if let Some(shared) = clip.as_ref() {
            connector = connector.with_static_channel(CliprdrClient::new(Box::new(
                ClipboardBridge::new(shared.clone()),
            )));
        }
        let mut framed = TokioFramed::new(stream);
        let should_upgrade = tokio::time::timeout(
            HANDSHAKE_STEP_TIMEOUT,
            connect_begin(&mut framed, &mut connector),
        )
        .await
        .map_err(|_| "RDP 协议协商超时".to_string())?
        .map_err(|e| format!("RDP 协议协商失败: {e}"))?;

        let raw = framed.into_inner_no_leftover();

        // 3. TLS 升级 + TOFU
        let (tls_stream, tls_cert) = tokio::time::timeout(
            HANDSHAKE_STEP_TIMEOUT,
            ironrdp_tls::upgrade_with_certificate_validation(
                raw,
                &host_addr,
                CertificateValidation::DangerouslyAcceptInvalidCertificate,
            ),
        )
        .await
        .map_err(|_| "RDP TLS 握手超时".to_string())?
        .map_err(|e| format!("RDP TLS 握手失败: {e}"))?;

        let (summary, server_public_key) =
            extract_cert_summary_and_pubkey(&tls_cert, &host_addr, port)?;
        self.verify_certificate(&app, &session_id, &summary, prompt_cert, cancel_rx.clone())
            .await?;

        // 4. CredSSP (NLA) + 连接激活
        let upgraded = mark_as_upgraded(should_upgrade, &mut connector);
        let mut tls_framed = TokioFramed::new(tls_stream);
        let mut network_client = NoopNetworkClient;
        let outcome = tokio::time::timeout(
            HANDSHAKE_STEP_TIMEOUT,
            connect_finalize(
                upgraded,
                connector,
                &mut tls_framed,
                &mut network_client,
                ServerName::new(host_addr.clone()),
                server_public_key,
                None,
            ),
        )
        .await
        .map_err(|_| "RDP 认证/激活阶段超时".to_string())?
        .map_err(|e| format!("RDP 认证/激活失败: {e}"))?;
        let connection = outcome.into_connected().map_err(|e| e.to_string())?;

        let desktop = (
            connection.desktop_size.width,
            connection.desktop_size.height,
        );
        let (tx, rx) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        self.add_session(Arc::new(RdpSession {
            session_id: session_id.clone(),
            host: host.clone(),
            desktop_size: desktop,
            hops,
            epoch,
            alive: alive.clone(),
            tx,
        }))
        .await;

        emit_state(
            &app,
            json!({
                "sessionId": session_id,
                "state": "connected",
                "width": desktop.0,
                "height": desktop.1,
                "hops": hops,
            }),
        );

        let service = self.clone();
        let sid = session_id.clone();
        let emit: StateEmitter = {
            let app = app.clone();
            Arc::new(move |payload| emit_state(&app, payload))
        };
        // 帧泵同样跑在 RDP 专用 LocalSet 上（未来不必是 Send）。
        tokio::task::spawn_local(async move {
            let reason = Self::run_session(
                service.clone(),
                emit.clone(),
                sid.clone(),
                connection,
                tls_framed,
                rx,
                alive,
                setup_handles,
                frame_sink,
                cancel_rx,
                compress_frames,
                frame_interval,
                settings.clone(),
                clip,
            )
            .await;
            service.drop_session(&sid).await;
            // 会话自然结束：回收取消信号的发送端，别让它留在表里
            service.cancels.lock().await.remove(&sid);
            emit(json!({
                "sessionId": sid,
                "state": "disconnected",
                "reason": reason,
            }));
        });

        Ok(Ready {
            desktop_size: desktop,
            hops,
        })
    }

    /// TOFU：匹配放行；首次见到的证书在 `prompt` 为 false 时直接信任并落盘
    /// （与 SSH 一致：未知主机自动信任，指纹变更才拦截），`prompt` 为 true 时等前端确认；
    /// 指纹变更一律拒绝并返回带 `[NB-FP]` 标记的错误。
    async fn verify_certificate<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        session_id: &str,
        summary: &RdpCertSummary,
        prompt: bool,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let stored = {
            let data = self.store.data.lock().unwrap_or_else(|e| e.into_inner());
            data["knownHosts"][summary.lookup_key.as_str()]
                .as_str()
                .map(String::from)
        };

        match tofu_verdict(stored.as_deref(), &summary.fingerprint) {
            TofuVerdict::Match => Ok(()),
            TofuVerdict::Mismatch { stored, current } => Err(fingerprint_mismatch_error(
                &summary.lookup_key,
                &stored,
                &current,
            )),
            TofuVerdict::FirstSeen => {
                if !prompt {
                    self.record_certificate(&summary.lookup_key, &summary.fingerprint);
                    return Ok(());
                }

                let request_id = format!("{session_id}:{}", unix_millis());
                let (tx, rx) = oneshot::channel();
                self.cert_waiters
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(request_id.clone(), tx);

                crate::ai::emit_evt(
                    app,
                    "rdp:cert_confirm",
                    json!({
                        "requestId": request_id,
                        "sessionId": session_id,
                        "host": summary.lookup_key,
                        "fingerprint": summary.fingerprint,
                        "sha256Hex": summary.sha256_hex,
                        "subject": summary.subject,
                        "issuer": summary.issuer,
                        "validFrom": summary.valid_from,
                        "validTo": summary.valid_to,
                    }),
                );
                emit_state(
                    app,
                    json!({
                        "sessionId": session_id,
                        "state": "cert-confirm",
                        "requestId": request_id,
                        "fingerprint": summary.fingerprint,
                    }),
                );

                let mut cancel = cancel_rx;
                let accept = tokio::select! {
                    res = tokio::time::timeout(CERT_CONFIRM_TIMEOUT, rx) => {
                        matches!(res, Ok(Ok(true)))
                    }
                    _ = wait_cancelled(&mut cancel) => false,
                };
                self.cert_waiters
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&request_id);

                if !accept {
                    return Err("用户未信任该远程桌面证书，连接已取消".to_string());
                }
                self.record_certificate(&summary.lookup_key, &summary.fingerprint);
                Ok(())
            }
        }
    }

    /// 落盘 TOFU 记录（首次信任）。
    pub fn record_certificate(&self, lookup_key: &str, fingerprint: &str) {
        {
            let mut data = self.store.data.lock().unwrap_or_else(|e| e.into_inner());
            data["knownHosts"][lookup_key] = json!(fingerprint);
        }
        self.store.save().ok();
    }

    /// 帧泵：读 PDU + 处理控制指令；返回断开原因。
    #[allow(clippy::too_many_arguments)]
    async fn run_session(
        self: Arc<Self>,
        emit: StateEmitter,
        session_id: String,
        connection: ConnectionResult,
        framed: TokioFramed<RdpTlsStream>,
        mut rx: mpsc::UnboundedReceiver<RdpCommand>,
        alive: Arc<AtomicBool>,
        _setup_handles: SetupHandles,
        frame_sink: Option<FrameSink>,
        cancel_rx: watch::Receiver<bool>,
        compress_frames: bool,
        frame_interval: Duration,
        settings: RdpSettings,
        clip: Option<SharedClip>,
    ) -> String {
        let (mut reader, mut writer) = split_tokio_framed(framed);
        let mut image = DecodedImage::new(
            PixelFormat::RgbA32,
            connection.desktop_size.width,
            connection.desktop_size.height,
        );
        let activation_factory = connection.activation_factory.clone();
        let io_channel_id = connection.io_channel_id;
        let user_channel_id = connection.user_channel_id;
        let mut input_db = InputDatabase::new();
        let mut static_channels = connection.static_channels;
        let gfx = attach_graphics_pipeline(&mut static_channels, settings.egfx);
        if gfx {
            eprintln!("[rdp] EGFX 图形管线已启用（服务端将发送压缩帧）");
        }
        let mut stage = ActiveStageBuilder {
            static_channels,
            user_channel_id,
            io_channel_id,
            message_channel_id: connection.message_channel_id,
            share_id: connection.share_id,
            compression_type: connection.compression_type,
            enable_server_pointer: connection.enable_server_pointer,
            pointer_software_rendering: connection.pointer_software_rendering,
        }
        .build();

        let mut cancel = cancel_rx;
        #[allow(unused_assignments)]
        let mut reason = String::from("网络断开");

        let mut frames = FrameOut::new(
            frame_sink,
            compress_frames && settings.compress,
            frame_interval,
        )
        .with_bandwidth_limit(settings.bandwidth_bps)
        .with_auto(settings.frame_rate.is_none());
        let clip_alive = Arc::new(AtomicBool::new(true));
        if let Some(shared) = clip.as_ref() {
            spawn_local_poller(shared.clone(), clip_alive.clone());
        }
        // 会话建立后先推一帧整桌面：服务端的首帧常常只是登录后重绘的某个脏矩形，
        // 前端需要它来建立/重建离屏缓冲区。
        frames.send_full(&image);

        // 光标由谁画：默认跟随服务端指示，变化时才通知前端一次
        let mut pointer = PointerState::default();

        loop {
            pointer.emit_if_changed(&emit, &session_id, None);
            tokio::select! {
                biased;
                _ = wait_cancelled(&mut cancel) => {
                    reason = "已手动断开".to_string();
                    break;
                }
                cmd = rx.recv() => {
                    match cmd {
                        None => { reason = "会话已关闭".to_string(); break; }
                        Some(RdpCommand::Disconnect) => {
                            let outs = stage.graceful_shutdown().unwrap_or_default();
                            let _ = write_outputs(&mut writer, &image, outs, &mut frames, &mut pointer).await;
                            reason = "已手动断开".to_string();
                            break;
                        }
                        // 用户在主机里钉死了分辨率时,窗格拖拽不再改远端
                        Some(RdpCommand::Resize { .. }) if settings.resolution.is_some() => {}
                        Some(RdpCommand::Resize { width, height, scale_factor }) => {
                            let (w, h) = sanitize_rdp_dimensions(width, height);
                            let encoded = stage.encode_resize(
                                u32::from(w),
                                u32::from(h),
                                scale_factor
                                    .filter(|s| (100..=500).contains(s))
                                    .or(Some(settings.scale_factor)),
                                Some((u32::from(w), u32::from(h))),
                            );
                            match encoded {
                                Some(Ok(bytes)) if !bytes.is_empty() => {
                                    if let Err(e) = writer.write_all(&bytes).await {
                                        reason = format!("发送分辨率调整失败: {e}");
                                        break;
                                    }
                                }
                                Some(Ok(_)) | None => {}
                                Some(Err(e)) => {
                                    reason = format!("编码分辨率调整失败: {e}");
                                    break;
                                }
                            }
                        }
                        Some(RdpCommand::Input(payload)) => {
                            match apply_input_payload(&mut input_db, &payload) {
                                Ok(events) if !events.is_empty() => {
                                    match stage.process_fastpath_input(&mut image, &events) {
                                        Ok(outs) => {
                                            match write_outputs(&mut writer, &image, outs, &mut frames, &mut pointer).await {
                                                Flow::Continue => {}
                                                Flow::DeactivateAll | Flow::Terminate(_) => {}
                                            }
                                        }
                                        Err(e) => { reason = format!("输入处理失败: {e}"); break; }
                                    }
                                }
                                Ok(_) => {}
                                Err(e) => { reason = e; break; }
                            }
                        }
                    }
                }
                // 服务端停止推送时，把最后挂起的那一块补上（否则画面停在半截）
                _ = tokio::time::sleep(frames.interval()), if frames.has_pending() => {
                    frames.flush(&image, true);
                }
                // 剪贴板结账：本机轮询改了文本、服务端来要数据、远端剪贴板变了都在这里发出
                _ = tokio::time::sleep(CLIPBOARD_TICK), if clip.is_some() => {
                    if let Some(shared) = clip.as_ref() {
                        clipboard_tick(&mut stage, &mut writer, shared).await;
                    }
                }
                read = reader.read_pdu() => {
                    let (action, payload) = match read {
                        Ok(v) => v,
                        Err(e) => { reason = format!("网络读取失败: {e}"); break; }
                    };
                    let received_at = reader.last_read_at();
                    let outs = match stage.process(&mut image, action, &payload, received_at) {
                        Ok(v) => v,
                        Err(e) => { reason = format!("协议解码失败: {e}"); break; }
                    };
                    match write_outputs(&mut writer, &image, outs, &mut frames, &mut pointer).await {
                        Flow::Continue => {}
                        Flow::Terminate(why) => { reason = why; break; }
                        Flow::DeactivateAll => {
                            match drive_reactivation(&mut reader, &mut writer, &activation_factory).await {
                                Ok(next) => {
                                    stage.reactivate(
                                        io_channel_id,
                                        user_channel_id,
                                        next.share_id,
                                        next.enable_server_pointer,
                                        next.pointer_software_rendering,
                                        next.static_channel_chunk_size,
                                    );
                                    if (next.desktop_size.width, next.desktop_size.height)
                                        != (image.width(), image.height())
                                    {
                                        image = DecodedImage::new(
                                            PixelFormat::RgbA32,
                                            next.desktop_size.width,
                                            next.desktop_size.height,
                                        );
                                        frames.send_full(&image);
                                    }
                                    emit(json!({
                                        "sessionId": session_id,
                                        "state": "resized",
                                        "width": image.width(),
                                        "height": image.height(),
                                    }));
                                }
                                Err(e) => { reason = e; break; }
                            }
                        }
                    }
                }
            }
        }

        clip_alive.store(false, Ordering::SeqCst);
        alive.store(false, Ordering::SeqCst);
        reason
    }

    /// 发送键盘/鼠标输入（IPC 入口）。
    pub async fn send_input(
        &self,
        session_id: &str,
        payload: RdpInputPayload,
    ) -> Result<(), String> {
        let tx = self.command_tx(session_id).await?;
        tx.send(RdpCommand::Input(payload))
            .map_err(|_| "RDP 会话已结束".to_string())
    }

    /// 调整远端分辨率。
    pub async fn resize(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
        scale_factor: Option<u32>,
    ) -> Result<(), String> {
        let tx = self.command_tx(session_id).await?;
        tx.send(RdpCommand::Resize {
            width,
            height,
            scale_factor,
        })
        .map_err(|_| "RDP 会话已结束".to_string())
    }

    async fn command_tx(
        &self,
        session_id: &str,
    ) -> Result<mpsc::UnboundedSender<RdpCommand>, String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| s.tx.clone())
            .ok_or_else(|| format!("RDP 会话不存在: {session_id}"))
    }

    /// 断开一个会话（连接中或已连接都适用）。
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let canceled = match self.cancels.lock().await.remove(session_id) {
            Some(tx) => tx.send(true).is_ok(),
            None => false,
        };
        let session = self.sessions.lock().await.get(session_id).cloned();
        if let Some(session) = session {
            session.alive.store(false, Ordering::SeqCst);
            let _ = session.tx.send(RdpCommand::Disconnect);
            return Ok(());
        }
        if canceled {
            return Ok(());
        }
        Err(format!("RDP 会话不存在: {session_id}"))
    }

    /// 退出前置：断开全部会话。
    pub async fn disconnect_all(&self) {
        for id in self.session_ids().await {
            let _ = self.disconnect(&id).await;
        }
        let mut cancels = self.cancels.lock().await;
        for (_, tx) in cancels.drain() {
            let _ = tx.send(true);
        }
    }

    /// 旧代次回收：同 sessionId 重连时先终止上一代。
    async fn retire(&self, session_id: &str) {
        if let Some(tx) = self.cancels.lock().await.remove(session_id) {
            let _ = tx.send(true);
        }
        if let Some(session) = self.drop_session(session_id).await {
            session.alive.store(false, Ordering::SeqCst);
            let _ = session.tx.send(RdpCommand::Disconnect);
        }
    }
}

struct Ready {
    desktop_size: (u16, u16),
    hops: usize,
}

struct Reactivated {
    desktop_size: DesktopSize,
    share_id: u32,
    static_channel_chunk_size: usize,
    enable_server_pointer: bool,
    pointer_software_rendering: bool,
}

/// 一帧输出的后续动作。
enum Flow {
    Continue,
    DeactivateAll,
    Terminate(String),
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// 等待取消信号（只关心「变成 true」）。
///
/// 显式写出 `impl Future + Send`：`watch::Receiver::changed()` 直接写在泛型 async fn 里
/// 会触发 rustc 的「Send is not general enough」误报，tokio::spawn 就装不下它。
fn wait_cancelled<'a>(
    cancel: &'a mut watch::Receiver<bool>,
) -> impl std::future::Future<Output = ()> + Send + 'a {
    async move {
        if *cancel.borrow_and_update() {
            return;
        }
        loop {
            if cancel.changed().await.is_err() {
                return;
            }
            if *cancel.borrow_and_update() {
                return;
            }
        }
    }
}

fn emit_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>, payload: Value) {
    crate::ai::emit_evt(app, "rdp:state", payload);
}

/// 远程桌面配置(对标 mstsc 的「显示」「体验」「网络」三页)。
///
/// 全部来自主机 JSON 的 `rdpDisplay` / `rdpExperience` / `rdpNetwork` 三段,
/// 缺省即 mstsc 的默认体验:字体平滑 + 桌面合成,帧率 30,跟随窗口分辨率。
#[derive(Debug, Clone)]
pub struct RdpSettings {
    /// `None` = 自适应（跟着链路实测吞吐升降）；`Some(0)` = 不限
    pub frame_rate: Option<u64>,
    pub resolution: Option<(u16, u16)>,
    pub scale_factor: u32,
    pub color_depth: u32,
    /// 前端画布的像素上限（超过按比例缩远端分辨率）
    pub pixel_budget: u32,
    /// 0 = 不限带宽
    pub bandwidth_bps: u64,
    pub egfx: bool,
    pub compress: bool,
    pub performance_flags: PerformanceFlags,
    /// 连接时启动的程序（mstsc「程序」页）。空 = 正常桌面。
    pub program: String,
    pub working_dir: String,
    /// 本机 ↔ 远端文本剪贴板共享（mstsc「本地资源」→ 剪贴板）
    pub clipboard: bool,
}

impl Default for RdpSettings {
    fn default() -> Self {
        Self {
            frame_rate: Some(30),
            resolution: None,
            scale_factor: 100,
            color_depth: 32,
            pixel_budget: 1_600_000,
            bandwidth_bps: 0,
            egfx: true,
            compress: true,
            performance_flags: PerformanceFlags::ENABLE_FONT_SMOOTHING
                | PerformanceFlags::ENABLE_DESKTOP_COMPOSITION,
            program: String::new(),
            working_dir: String::new(),
            clipboard: true,
        }
    }
}

impl RdpSettings {
    /// 从主机配置解析。非法值一律回落到默认档,不把保存卡死。
    pub fn from_host(host: &serde_json::Value) -> Self {
        let display = host.get("rdpDisplay");
        let exp = host.get("rdpExperience");
        let net = host.get("rdpNetwork");

        let flag = |obj: Option<&serde_json::Value>, key: &str, dflt: bool| {
            obj.and_then(|o| o.get(key))
                .and_then(|v| v.as_bool())
                .unwrap_or(dflt)
        };
        let text = |obj: Option<&serde_json::Value>, key: &str| {
            obj.and_then(|o| o.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };

        // 画质预设决定「没单独指定」时的体验项默认值
        let preset = text(net, "qualityPreset");
        let (dflt_wallpaper, dflt_anim, dflt_composition) = match preset.as_str() {
            "wan" => (false, false, false),
            "lan" => (true, true, true),
            _ => (true, false, true),
        };

        // 帧率:新字段 rdpDisplay.frameRate,兼容 0.6.34 的 rdpFrameRate
        let frame_rate = match display
            .and_then(|d| d.get("frameRate"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
        {
            "auto" => None,
            _ => display
                .and_then(|d| d.get("frameRate"))
                .and_then(|v| v.as_u64())
                .or_else(|| host.get("rdpFrameRate").and_then(|v| v.as_u64()))
                .filter(|f| matches!(f, 0 | 15 | 24 | 30 | 60 | 90 | 120 | 144))
                .or(Some(30)),
        };

        // 分辨率:"auto" = 跟随窗口
        let resolution = match text(display, "resolution").as_str() {
            "1280x720" => Some((1280, 720)),
            "1600x900" => Some((1600, 900)),
            "1920x1080" => Some((1920, 1080)),
            "2560x1440" => Some((2560, 1440)),
            _ => None,
        };

        let scale_factor = display
            .and_then(|d| d.get("scaleFactor"))
            .and_then(|v| v.as_u64())
            .filter(|v| (100..=500).contains(v))
            .unwrap_or(100) as u32;

        let color_depth = display
            .and_then(|d| d.get("colorDepth"))
            .and_then(|v| v.as_u64())
            .filter(|v| matches!(v, 15 | 16 | 32))
            .unwrap_or(32) as u32;

        let pixel_budget = display
            .and_then(|d| d.get("pixelBudget"))
            .and_then(|v| v.as_u64())
            .filter(|v| (200_000..=16_000_000).contains(v))
            .unwrap_or(1_600_000) as u32;

        let bandwidth_bps = net
            .and_then(|n| n.get("bandwidthKbps"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .saturating_mul(1024);

        let mut flags = PerformanceFlags::empty();
        if flag(exp, "fontSmoothing", true) {
            flags |= PerformanceFlags::ENABLE_FONT_SMOOTHING;
        }
        if flag(exp, "desktopComposition", dflt_composition) {
            flags |= PerformanceFlags::ENABLE_DESKTOP_COMPOSITION;
        }
        if !flag(exp, "wallpaper", dflt_wallpaper) {
            flags |= PerformanceFlags::DISABLE_WALLPAPER;
        }
        if !flag(exp, "showWindowContents", dflt_anim) {
            flags |= PerformanceFlags::DISABLE_FULLWINDOWDRAG;
        }
        if !flag(exp, "menuAnimations", dflt_anim) {
            flags |= PerformanceFlags::DISABLE_MENUANIMATIONS;
        }
        if !flag(exp, "theming", true) {
            flags |= PerformanceFlags::DISABLE_THEMING;
        }
        if !flag(exp, "cursorShadow", true) {
            flags |= PerformanceFlags::DISABLE_CURSOR_SHADOW;
        }

        let launch = host.get("rdpLaunch");
        let text_field = |key: &str| {
            launch
                .and_then(|l| l.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let program = text_field("program");
        // 没有程序就没有工作目录（mstsc 也是灰的）
        let working_dir = if program.is_empty() {
            String::new()
        } else {
            text_field("workingDir")
        };

        Self {
            frame_rate,
            resolution,
            scale_factor,
            color_depth,
            pixel_budget,
            bandwidth_bps,
            egfx: flag(net, "egfx", true),
            compress: flag(net, "compressFrames", true),
            performance_flags: flags,
            program,
            working_dir,
            clipboard: flag(exp, "clipboard", true),
        }
    }
}

/// 组装连接参数（尺寸已规整）。
pub fn build_client_config(
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    settings: &RdpSettings,
) -> Config {
    Config {
        desktop_size: DesktopSize { width, height },
        monitor_layout: None,
        desktop_scale_factor: settings.scale_factor,
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: Some(settings.scale_factor),
        monitor_extended_layout: None,
        relative_mouse_input: false,
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        credentials: Credentials::UsernamePassword { username, password },
        domain,
        client_build: 0,
        client_name: "NebulaShell".to_string(),
        keyboard_type: gcc::KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409,
        connection_type: gcc::ConnectionType::Lan,
        ime_file_name: String::new(),
        bitmap: Some(BitmapConfig {
            lossy_compression: true,
            color_depth: settings.color_depth,
            codecs: capability_sets::client_codecs_capabilities(&[]).unwrap_or_default(),
        }),
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_string(),
        alternate_shell: settings.program.clone(),
        work_dir: settings.working_dir.clone(),
        remote_application_mode: false,
        rail_support_level: capability_sets::RailSupportLevel::empty(),
        platform: MajorPlatformType::MACINTOSH,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: false,
        enable_audio_capture: false,
        performance_flags: settings.performance_flags,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: true,
        // 关掉「服务端把光标画进画面」：软件合成会把光标的透明像素写成 (0,0,0,0)，
        // 而我们要把 alpha 一律拉成 255（否则 32bpp 填充位会让整屏透明），
        // 于是光标轮廓变成一圈黑线 —— 鼠标一动就拖一堆细黑线。
        // 改成 Accelerated 目标：光标作为独立的形状交给我们，用 CSS cursor 画。
        pointer_software_rendering: false,
        multitransport_flags: None,
        // 告诉服务端我们支持 Graphics Pipeline（EGFX），否则它只会推未压缩位图
        support_dyn_vc_gfx_protocol: settings.egfx
            && std::env::var_os("NB_RDP_LEGACY_GFX").is_none(),
    }
}

/// EGFX（Graphics Pipeline）只需要默认行为：能力协商、Buffer 管理、帧解码都在
/// `GraphicsPipelineClient` 内部完成，这里只是把它挂到动态通道上。
#[derive(Debug)]
struct DefaultGfxHandler;

impl GraphicsPipelineHandler for DefaultGfxHandler {}

/// 把 EGFX 客户端挂到 Drdynvc 通道上。
///
/// 开了它，服务端不再一帧一帧推未压缩位图，而是用 RFX / Progressive / ClearCodec
/// 编码整帧（典型压缩比 20:1 以上），IPC 数据量直接掉一个数量级 —— 这是「能操作但
/// 卡顿」这类问题的根因解。
///
/// `NB_RDP_LEGACY_GFX=1` 可退回纯位图模式（老服务端或 EGFX 兼容问题时用）。
fn attach_graphics_pipeline(static_channels: &mut StaticChannelSet, allow: bool) -> bool {
    if !allow || std::env::var_os("NB_RDP_LEGACY_GFX").is_some() {
        return false;
    }
    let Some(channel) = static_channels.get_by_type_mut::<DrdynvcClient>() else {
        return false;
    };
    let Some(drdynvc) = channel.channel_processor_downcast_mut::<DrdynvcClient>() else {
        return false;
    };
    if drdynvc.has_registered_dvc::<GraphicsPipelineClient>() {
        return true;
    }
    drdynvc.attach_dynamic_channel(GraphicsPipelineClient::new(
        Box::new(DefaultGfxHandler),
        None,
    ));
    true
}

/// 前端帧推送的节流器。
///
/// 服务端在做动画、拖窗口、光标闪烁时会以几十甚至上百 Hz 推小脏矩形，每个矩形都
/// 立刻过一趟 IPC（跨进程 + webview fetch）会把主线程打满，鼠标事件排在后面，
/// 表现就是「画面能动但操作延迟极高」。这里把发送频率压到 [`FRAME_INTERVAL`]，
/// 期间所有脏矩形并成一个包围盒，宁可掉帧也不让队列越攒越长。
pub(crate) struct FrameOut {
    sink: Option<FrameSink>,
    /// 待发脏矩形：小更新各自成块，不再一律合包围盒
    pending: Vec<InclusiveRectangle>,
    last_flush: Instant,
    /// 前端声明支持 deflate 时才压缩（`DecompressionStream` 不可用的引擎走原样）
    compress: bool,
    /// 两帧之间的最小间隔（来自主机的「画面帧率」设置，0 fps = 不节流）
    interval: Duration,
    /// 带宽上限（字节/秒），0 = 不限
    max_bytes_per_sec: u64,
    pub(crate) window_start: Instant,
    window_bytes: u64,
    /// 自适应档：按「有没有帧被留在队列里」调发送间隔
    auto: bool,
    pub(crate) last_tune: Instant,
    pub(crate) window_frames: u64,
    pub(crate) window_deferred: u64,
}

/// 光标该由谁画。
///
/// `pointer_software_rendering = true` 时服务端把光标**画进画面**，此时本地光标必须隐藏，
/// 否则就是双鼠标；但服务端发 PointerDefault / PointerHidden 时又明确要求「用你自己的系统指针」，
/// 那时再隐藏就没光标了 —— 所以必须跟着这三种状态走，不能一刀切。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PointerMode {
    /// 服务端已把指针画进画面：隐藏本地光标
    #[default]
    Remote,
    /// 服务端让你用自己的箭头
    Default,
    /// 服务端要求隐藏指针
    Hidden,
}

impl PointerMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Remote => "remote",
            Self::Default => "local",
            Self::Hidden => "hidden",
        }
    }
}

/// 光标形状 + 归属状态，变化时才推给前端。
#[derive(Default)]
pub(crate) struct PointerState {
    pub(crate) mode: PointerMode,
    last_mode: Option<PointerMode>,
    last_shape: Option<usize>,
    shape: Option<Arc<DecodedPointer>>,
    painter: bool,
}

impl PointerState {
    /// 有变化就发一条 `rdp:state {state:"pointer"}`。
    pub(crate) fn emit_if_changed(
        &mut self,
        emit: &StateEmitter,
        session_id: &str,
        shape: Option<&Arc<DecodedPointer>>,
    ) {
        let shape = shape.or(self.shape.as_ref());
        let key = shape.map(|p| Arc::as_ptr(p) as usize);
        if self.painter && self.last_mode == Some(self.mode) && self.last_shape == key {
            return;
        }
        self.painter = true;
        self.last_mode = Some(self.mode);
        self.last_shape = key;
        let mut payload = json!({
            "sessionId": session_id,
            "state": "pointer",
            "mode": self.mode.as_str(),
        });
        if let (Some(pointer), Some(_)) = (shape, key) {
            // 形状很小(通常 32×32)，base64 直传；形状只在真正变化时发，不是每帧
            payload["cursor"] = json!({
                "width": pointer.width,
                "height": pointer.height,
                "hotspotX": pointer.hotspot_x,
                "hotspotY": pointer.hotspot_y,
                "data": B64_NOPAD.encode(&pointer.bitmap_data),
            });
        }
        emit(payload);
    }
}

/// 剪贴板结账节拍：轮询线程 1.2s 一次，这里 250ms 结一次账，手感上够「复制即生效」。
const CLIPBOARD_TICK: Duration = Duration::from_millis(250);

/// 默认帧率：30fps。主机里可以改成 15/24/60 或不限，用来验证卡顿是否来自帧率。
const DEFAULT_FRAME_INTERVAL: Duration = Duration::from_millis(30);

/// 把主机设置的帧率换算成发送间隔；0 = 不节流（每批脏矩形立刻发）。
pub fn frame_interval_for(fps: u64) -> Duration {
    match fps {
        0 => Duration::ZERO,
        f => Duration::from_millis((1000 / f.clamp(1, 240)).max(1)),
    }
}

/// 待发脏矩形的上限：再多就说明画面整片在变，合包围盒反而更省。
const MAX_PENDING_RECTS: usize = 6;

fn rects_touch(a: &InclusiveRectangle, b: &InclusiveRectangle) -> bool {
    // 留 2px 容差：相邻一两像素的两块并起来只多传一条边，比多发一个包头划算
    a.left <= b.right.saturating_add(2)
        && b.left <= a.right.saturating_add(2)
        && a.top <= b.bottom.saturating_add(2)
        && b.top <= a.bottom.saturating_add(2)
}

fn union_pair(a: &InclusiveRectangle, b: &InclusiveRectangle) -> InclusiveRectangle {
    InclusiveRectangle {
        left: a.left.min(b.left),
        top: a.top.min(b.top),
        right: a.right.max(b.right),
        bottom: a.bottom.max(b.bottom),
    }
}

fn rect_area(r: &InclusiveRectangle) -> u64 {
    let w = u64::from(r.right.saturating_sub(r.left)) + 1;
    let h = u64::from(r.bottom.saturating_sub(r.top)) + 1;
    w * h
}

/// 找出「并起来最不浪费面积」的一对（块数超上限时用）。
fn cheapest_merge_pair(rects: &[InclusiveRectangle]) -> (usize, usize) {
    let mut best = (0, 1);
    let mut best_waste = u64::MAX;
    for i in 0..rects.len() {
        for j in (i + 1)..rects.len() {
            let waste = rect_area(&union_pair(&rects[i], &rects[j]))
                - rect_area(&rects[i])
                - rect_area(&rects[j]);
            if waste < best_waste {
                best_waste = waste;
                best = (i, j);
            }
        }
    }
    best
}

impl FrameOut {
    pub(crate) fn new(sink: Option<FrameSink>, compress: bool, interval: Duration) -> Self {
        Self {
            sink,
            pending: Vec::new(),
            last_flush: Instant::now(),
            compress,
            interval,
            max_bytes_per_sec: 0,
            window_start: Instant::now(),
            window_bytes: 0,
            auto: false,
            last_tune: Instant::now(),
            window_frames: 0,
            window_deferred: 0,
        }
    }

    /// 自适应档的起点/上下限:60fps 起步,拥堵退到 15fps,通畅最多追到 125fps
    pub(crate) const AUTO_START: Duration = Duration::from_millis(16);
    pub(crate) const AUTO_MIN: Duration = Duration::from_millis(8);
    pub(crate) const AUTO_MAX: Duration = Duration::from_millis(66);

    /// 打开自适应:帧率档位选「自适应」时用。
    pub(crate) fn with_auto(mut self, auto: bool) -> Self {
        self.auto = auto;
        if auto && self.interval.is_zero() {
            self.interval = Self::AUTO_START;
        }
        self
    }

    /// 每秒调一次发送间隔。
    ///
    /// 判据只有一条:**有没有帧因为额度/节流被留在队列里**。
    /// 有 → 说明发不完,放慢;没有 → 说明还有余量,加快。
    /// 不用去猜链路带宽,也不用统计 RTT —— 队列长度本身就是最直接的拥塞信号。
    pub(crate) fn auto_tune(&mut self) {
        if !self.auto || self.last_tune.elapsed() < Duration::from_secs(1) {
            return;
        }
        let deferred = std::mem::take(&mut self.window_deferred);
        let frames = std::mem::take(&mut self.window_frames);
        self.last_tune = Instant::now();
        if frames == 0 && deferred == 0 {
            return;
        }
        self.interval = if deferred > 0 {
            // 放慢 25%,最多到 AUTO_MAX
            (self.interval.mul_f64(1.25)).min(Self::AUTO_MAX)
        } else {
            // 加快 15%,最快到 AUTO_MIN
            (self.interval.mul_f64(0.85)).max(Self::AUTO_MIN)
        };
    }

    /// 当前实际发送间隔(自适应档下会变)。
    pub(crate) fn current_interval(&self) -> Duration {
        self.interval
    }

    /// 主机的「带宽上限」:滑动 1 秒窗口,额度用完就把这块脏矩形留到下一秒,
    /// 宁可掉帧也不超量 —— 这是「最低网络占用」的硬闸,不是建议值。
    pub(crate) fn with_bandwidth_limit(mut self, bytes_per_sec: u64) -> Self {
        self.max_bytes_per_sec = bytes_per_sec;
        self
    }

    /// 本次是否还能发 `len` 字节(超额就返回 false,调用方保留 pending)。
    pub(crate) fn take_budget(&mut self, len: usize) -> bool {
        if self.max_bytes_per_sec == 0 {
            return true;
        }
        if self.window_start.elapsed() >= Duration::from_secs(1) {
            self.window_start = Instant::now();
            self.window_bytes = 0;
        }
        if self.window_bytes + len as u64 > self.max_bytes_per_sec {
            return false;
        }
        self.window_bytes += len as u64;
        true
    }

    /// 定时补发用的等待时长（0 间隔时给个下限，避免 sleep(0) 空转）
    pub(crate) fn interval(&self) -> Duration {
        if self.interval.is_zero() {
            Duration::from_millis(5)
        } else {
            self.interval
        }
    }

    /// 累加脏矩形。
    ///
    /// 以前是无条件合包围盒：光标闪一下(10×20)和角落一个角标(10×20)分开在两个
    /// 对角的角上，合出来就是整屏，白白多传几十倍像素。现在只把相交/相邻的并起来，
    /// 互不相干的各占一块；块数超过 `MAX_PENDING_RECTS` 才挑「合并代价最小」的一对并掉。
    pub(crate) fn merge(&mut self, rect: &InclusiveRectangle) {
        let mut incoming = rect.clone();
        let mut i = 0;
        while i < self.pending.len() {
            if rects_touch(&self.pending[i], &incoming) {
                let cur = self.pending.swap_remove(i);
                incoming = union_pair(&cur, &incoming);
                i = 0; // 并完可能又贴上了别的块，重扫
                continue;
            }
            i += 1;
        }
        self.pending.push(incoming);
        while self.pending.len() > MAX_PENDING_RECTS {
            let (a, b) = cheapest_merge_pair(&self.pending);
            let merged = union_pair(&self.pending[a], &self.pending[b]);
            let (hi, lo) = (a.max(b), a.min(b));
            self.pending.swap_remove(hi);
            self.pending.swap_remove(lo);
            self.pending.push(merged);
        }
    }

    /// 待发块数（单测用）。
    pub(crate) fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// 推到上限就发；`force` 用于会话结束前把最后一块补上。
    pub(crate) fn flush(&mut self, image: &DecodedImage, force: bool) {
        if self.pending.is_empty() || self.sink.is_none() {
            return;
        }
        if !force && self.last_flush.elapsed() < self.interval {
            return;
        }
        self.auto_tune();
        let rects = std::mem::take(&mut self.pending);
        for (idx, rect) in rects.iter().enumerate() {
            if let Some((x, y, w, h, pixels)) = extract_dirty_rect_rgb24(image, rect) {
                let packet = if self.compress {
                    encode_frame_packet_rgb24(
                        FRAME_KIND_DIRTY,
                        x,
                        y,
                        w,
                        h,
                        image.width(),
                        image.height(),
                        &pixels,
                    )
                } else {
                    encode_frame_packet_rgb24(
                        FRAME_KIND_DIRTY,
                        x,
                        y,
                        w,
                        h,
                        image.width(),
                        image.height(),
                        &pixels,
                    )
                };
                if !self.take_budget(packet.len()) {
                    // 本秒额度用完:这块和后面的一起留到下一轮,别丢了
                    self.window_deferred += (rects.len() - idx) as u64;
                    self.pending.extend(rects[idx..].iter().cloned());
                    return;
                }
                self.window_frames += 1;
                if let Some(sink) = self.sink.as_ref() {
                    sink(packet);
                }
                self.last_flush = Instant::now();
            }
        }
    }

    /// 整桌面一帧：会话建立、分辨率重激活后用。
    fn send_full(&self, image: &DecodedImage) {
        let Some(sink) = self.sink.as_ref() else {
            return;
        };
        if let Some(bytes) = encode_full_frame(image) {
            sink(bytes);
        }
    }

    pub(crate) fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

/// 剪贴板善后：把后端回调记下的「待办」变成真正的 CLIPRDR 报文写出去。
///
/// 后端回调（`CliprdrBackend`）跑在 `stage.process()` 里面，拿不到 writer，
/// 所以只记状态；这里在每轮处理完之后统一结账，顺序是：
/// ① 远端文本落到本机剪贴板 → ② 应答服务端的数据请求 → ③ 拉取远端新内容 → ④ 广告本机新内容。
async fn clipboard_tick(
    stage: &mut ironrdp_session::ActiveStage,
    writer: &mut TokioFramed<WriteHalf<RdpTlsStream>>,
    shared: &SharedClip,
) {
    // ① 远端 → 本机（pbcopy 交给独立线程，别堵帧泵）
    let incoming = shared
        .lock()
        .ok()
        .and_then(|mut st| st.incoming_text.take());
    if let Some(text) = incoming {
        std::thread::Builder::new()
            .name("rdp-clipboard-write".to_string())
            .spawn(move || write_local_clipboard(&text))
            .ok();
    }

    // ② 服务端索取数据（Windows 侧按了 Ctrl+V）
    let request = shared
        .lock()
        .ok()
        .and_then(|mut st| st.pending_request.take());
    if let Some(format) = request {
        let text = shared
            .lock()
            .map(|st| st.local_text.clone())
            .unwrap_or_default();
        let messages = stage
            .get_svc_processor::<CliprdrClient>()
            .map(|c| c.submit_format_data(build_format_data_response(format, &text)));
        if let Some(Ok(messages)) = messages {
            if let Ok(bytes) = stage.process_svc_processor_messages(messages) {
                let _ = writer.write_all(&bytes).await;
            }
        }
    }

    // ③ 远端剪贴板变了 → 主动拉一次文本
    let wants_paste = shared
        .lock()
        .map(|mut st| std::mem::take(&mut st.pending_paste))
        .unwrap_or(false);
    if wants_paste {
        let messages = stage
            .get_svc_processor_mut::<CliprdrClient>()
            .map(|c| c.initiate_paste(ClipboardFormatId::CF_UNICODETEXT));
        if let Some(Ok(messages)) = messages {
            if let Ok(bytes) = stage.process_svc_processor_messages(messages) {
                let _ = writer.write_all(&bytes).await;
            }
        }
    }

    // ④ 本机剪贴板变了 → 广告出去（服务端据此知道「可以来要文本了」）
    let advertise = shared.lock().ok().and_then(|mut st| {
        (st.ready && st.local_seq != st.advertised_seq && !st.local_text.is_empty()).then(|| {
            st.advertised_seq = st.local_seq;
        })
    });
    if advertise.is_some() {
        let messages = stage
            .get_svc_processor_mut::<CliprdrClient>()
            .map(|c| c.initiate_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]));
        if let Some(Ok(messages)) = messages {
            if let Ok(bytes) = stage.process_svc_processor_messages(messages) {
                let _ = writer.write_all(&bytes).await;
            }
        }
    }
}

/// 写出 ActiveStage 输出，并把脏矩形合成一帧推给前端。
///
/// 按值消费输出：`ActiveStageOutput` 不是 `Sync`，按引用遍历会让整条会话未来
/// 失去 `Send`（表现是 `tokio::spawn` 处的 higher-ranked lifetime 报错）。
async fn write_outputs(
    writer: &mut TokioFramed<WriteHalf<RdpTlsStream>>,
    image: &DecodedImage,
    outs: Vec<ActiveStageOutput>,
    frames: &mut FrameOut,
    pointer: &mut PointerState,
) -> Flow {
    let mut flow = Flow::Continue;

    for out in outs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => {
                if !frame.is_empty() && Box::pin(writer.write_all(&frame)).await.is_err() {
                    return Flow::Terminate("发送响应帧失败".to_string());
                }
            }
            ActiveStageOutput::GraphicsUpdate(rect) => frames.merge(&rect),
            // 指针状态：画面里有没有那把箭头，决定本地光标该不该出现
            ActiveStageOutput::PointerBitmap(bitmap) => {
                pointer.mode = PointerMode::Remote;
                pointer.shape = Some(bitmap);
            }
            ActiveStageOutput::PointerPosition { .. } => pointer.mode = PointerMode::Remote,
            ActiveStageOutput::PointerDefault => pointer.mode = PointerMode::Default,
            ActiveStageOutput::PointerHidden => pointer.mode = PointerMode::Hidden,
            ActiveStageOutput::DeactivateAll => flow = Flow::DeactivateAll,
            ActiveStageOutput::Terminate(reason) => {
                frames.flush(image, true);
                return Flow::Terminate(format!("服务端结束会话: {}", reason.description()));
            }
            _ => {}
        }
    }

    frames.flush(image, false);

    flow
}

/// 按激活序列的提示读一帧。
///
/// 不用 ironrdp 的 `read_by_hint`：那个 `async fn` 会把 `&dyn PduHint` 跨 await 持有，
/// rustc 无法证明其未来是 `Send`，整条帧泵就 spawn 不出去。这里把提示的作用范围
/// 压在同步块里（只取长度），等待读操作时不持有任何 trait object 借用。
async fn read_activation_frame(
    reader: &mut TokioFramed<ReadHalf<RdpTlsStream>>,
    sequence: &ironrdp_connector::connection_activation::ConnectionActivationSequence,
) -> Result<Vec<u8>, String> {
    loop {
        let decision = {
            let hint = match sequence.next_pdu_hint() {
                Some(hint) => hint,
                None => return Err("激活序列已结束".to_string()),
            };
            hint.find_size(reader.peek())
                .map_err(|e| format!("激活帧长度解析失败: {e}"))?
        };

        match decision {
            Some((true, len)) => {
                let (_, buf) = reader.get_inner_mut();
                return Ok(buf.split_to(len).to_vec());
            }
            Some((false, len)) => {
                let (_, buf) = reader.get_inner_mut();
                let _ = buf.split_to(len);
            }
            None => {
                let (stream, buf) = reader.get_inner_mut();
                buf.reserve(4096);
                let read = stream
                    .read_buf(buf)
                    .await
                    .map_err(|e| format!("重激活读取失败: {e}"))?;
                if read == 0 {
                    return Err("重激活期间连接被关闭".to_string());
                }
            }
        }
    }
}

/// 驱动 Deactivation-Reactivation Sequence（动态分辨率生效后的必经流程）。
async fn drive_reactivation(
    reader: &mut TokioFramed<ReadHalf<RdpTlsStream>>,
    writer: &mut TokioFramed<WriteHalf<RdpTlsStream>>,
    factory: &ConnectionActivationFactory,
) -> Result<Reactivated, String> {
    let mut sequence = factory.create();
    let mut buf = WriteBuf::new();

    loop {
        buf.clear();
        let written = if sequence.next_pdu_hint().is_some() {
            let pdu = Box::pin(read_activation_frame(reader, &sequence)).await?;
            let received_at = reader.last_read_at();
            sequence
                .step(&pdu, received_at, &mut buf)
                .map_err(|e| format!("重激活失败: {e}"))?
        } else {
            sequence
                .step_no_input(&mut buf)
                .map_err(|e| format!("重激活失败: {e}"))?
        };
        if let Some(len) = written.size() {
            Box::pin(writer.write_all(&buf[..len]))
                .await
                .map_err(|e| format!("重激活发送失败: {e}"))?;
        }

        if let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            static_channel_chunk_size,
            enable_server_pointer,
            pointer_software_rendering,
            ..
        } = sequence.connection_activation_state()
        {
            return Ok(Reactivated {
                desktop_size,
                share_id,
                static_channel_chunk_size,
                enable_server_pointer,
                pointer_software_rendering,
            });
        }
    }
}

// ───────────────────────────── 测试夹具辅助 ─────────────────────────────

/// 解析 DER 证书并返回 SHA-256 指纹（测试用）。
pub fn fingerprint_of_der(der: &[u8]) -> Option<String> {
    let cert = x509_cert::Certificate::from_der(der).ok()?;
    let der = cert.to_der().ok()?;
    Some(compute_cert_sha256_fingerprints(&der).0)
}

/// 从 DER 证书提取摘要（测试用）。
pub fn summary_of_der(der: &[u8], host: &str, port: u16) -> Option<RdpCertSummary> {
    let cert = x509_cert::Certificate::from_der(der).ok()?;
    extract_cert_summary_and_pubkey(&cert, host, port)
        .ok()
        .map(|(s, _)| s)
}
