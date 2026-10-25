//! 跨平台"打开外部目标"辅助:统一"用户永远不应感知子窗口被拉起"与"不经 shell"。
//!
//! 历史上 CREATE_NO_WINDOW 常量与 CommandExt 导入在 config.rs / commands.rs 各写一份;
//! 打开外链曾走 `cmd /C start "" url`,URL 中的 `&` 会被 cmd 当作命令分隔符
//! (同 sftp.rs 对路径元字符的分析),因此 URL 也改走不经 shell 的调用方。
//!
//! macOS 上打开外链/文件一律调 AppKit NSWorkspace,不派生 `open` CLI —— GUI 进程
//! 拉起命令行工具会在部分 macOS 版本上闪出终端窗口(凭据密钥派生的 hostname
//! 子进程同病,已在 config.rs 改原生 gethostname)。

/// Windows 下隐藏子进程控制台窗口。
/// 非 Windows 平台是恒等函数,调用方无需再写 #[cfg] 分支。
#[allow(unused_variables)]
pub fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 用系统默认浏览器打开 URL,不经 shell:
/// macOS 走 NSWorkspace(LaunchServices XPC,零子进程);
/// Linux `xdg-open` 直接收 URL;Windows 用 `cmd /C start` 的替代——
/// rundll32 只接受规范 URL 且 `url.dll,FileProtocolHandler` 后的参数不被 shell 二次解析,
/// 配合整体引号确保 `&` 等字符原样到达。
#[allow(unused_variables)]
pub fn open_url(url: &str) {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSString, NSURL};
        let ns_url = NSString::from_str(url);
        if let Some(u) = NSURL::URLWithString(&ns_url) {
            objc2_app_kit::NSWorkspace::sharedWorkspace().openURL(&u);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut arg = std::ffi::OsString::from("\"");
        arg.push(url);
        arg.push("\"");
        let _ = std::process::Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .raw_arg(arg)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// 用系统默认程序打开本机文件/目录(macOS 专用;其他平台在 sftp.rs 各自分支)。
/// NSWorkspace 与 `open <path>` 同走 LaunchServices,但零子进程、不闪终端窗口。
#[cfg(target_os = "macos")]
pub fn open_path_native(path: &std::path::Path) {
    use objc2_foundation::{NSString, NSURL};
    let ns_path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&ns_path);
    objc2_app_kit::NSWorkspace::sharedWorkspace().openURL(&url);
}

/// 在 Finder 中显示并选中文件(macOS 专用;等价 `open -R` 但零子进程)。
#[cfg(target_os = "macos")]
pub fn reveal_path_native(path: &std::path::Path) {
    use objc2_foundation::{NSArray, NSString, NSURL};
    let ns_path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&ns_path);
    let urls = NSArray::from_retained_slice(&[url]);
    objc2_app_kit::NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
}
