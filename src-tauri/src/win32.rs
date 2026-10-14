//! Windows 进程启动辅助:统一"不闪控制台窗口"与"不经 shell 打开外部目标"。
//!
//! 历史上 CREATE_NO_WINDOW 常量与 CommandExt 导入在 config.rs / commands.rs 各写一份;
//! 打开外链曾走 `cmd /C start "" url`,URL 中的 `&` 会被 cmd 当作命令分隔符
//! (同 sftp.rs 对路径元字符的分析),因此 URL 也改走不经 shell 的调用方。

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
/// macOS `open`、Linux `xdg-open` 直接收 URL;Windows 用 `cmd /C start` 的替代——
/// rundll32 只接受规范 URL 且 `url.dll,FileProtocolHandler` 后的参数不被 shell 二次解析,
/// 配合整体引号确保 `&` 等字符原样到达。
#[allow(unused_variables)]
pub fn open_url(url: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
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
