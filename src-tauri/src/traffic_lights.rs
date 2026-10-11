//! macOS 红绿灯:titleBarStyle Overlay 下,把系统的关闭 / 最小化 / 缩放按钮在顶层
//! 标题栏(style.css 的 --titlebar-h)里垂直居中,横向位置保持系统布局。
//!
//! 不用 tauri.conf 的 trafficLightPosition:tao 只拉高标题栏容器、不动按钮的纵向
//! 位置,按钮离底边的距离沿用系统按默认标题栏高度(macOS 27 是 32pt)算出的值,
//! 结果随系统版本漂移;0.3.0 设 y=11 时按钮中心实际落在 9pt。
//! AppKit 在窗口缩放、进出全屏、切换前后台时会重新布局标题栏,这些窗口事件后
//! 都要重新摆放(lib.rs 的 on_window_event)。

use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::NSPoint;

/// 与 style.css 的 --titlebar-h 一致(pt)
const TITLEBAR_HEIGHT: f64 = 36.0;

pub fn place(window: &tauri::WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let _ = window.run_on_main_thread(move || unsafe { layout(ns_window as *const NSWindow) });
}

unsafe fn layout(ns_window: *const NSWindow) {
    let Some(window) = ns_window.as_ref() else {
        return;
    };
    // 全屏时标题栏随菜单栏滑出,由系统管理
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|kind| window.standardWindowButton(kind));
    let Some(close) = &buttons[0] else {
        return;
    };
    let Some(titlebar) = close.superview() else {
        return;
    };
    let Some(container) = titlebar.superview() else {
        return;
    };
    // 标题栏容器至少要有标题栏那么高(顶边贴窗口顶边):按钮超出父视图的部分
    // 画得出来却点不到
    let mut frame = container.frame();
    if frame.size.height < TITLEBAR_HEIGHT {
        frame.size.height = TITLEBAR_HEIGHT;
        frame.origin.y = window.frame().size.height - TITLEBAR_HEIGHT;
        container.setFrame(frame);
    }
    let bar_height = titlebar.frame().size.height;
    for button in buttons.iter().flatten() {
        let f = button.frame();
        let top = (TITLEBAR_HEIGHT - f.size.height) / 2.0;
        let y = if titlebar.isFlipped() {
            top
        } else {
            bar_height - top - f.size.height
        };
        button.setFrameOrigin(NSPoint::new(f.origin.x, y));
    }
}
