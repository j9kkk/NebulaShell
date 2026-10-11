//! 终端文本的转义序列识别:命令历史清洗(config.rs)与会话日志格式化
//! (session_log.rs)共用同一套覆盖范围,与前端 shared/term-text.js 的
//! stripTerminalNoise 一致:CSI、OSC(BEL 或 ST 结尾)、DCS/SOS/PM/APC
//! (ST 或 BEL 结尾)、SS2/SS3 连同其后一个字符、字符集指定、其余 ESC 序列。

/// 跳过 chars[i] 起的 ESC 序列,返回其后的位置。
pub(crate) fn skip_escape(chars: &[char], i: usize) -> usize {
    let n = chars.len();
    let st_end = |from: usize, bel: bool| {
        let mut j = from;
        while j < n {
            if bel && chars[j] == '\x07' {
                return j + 1;
            }
            if chars[j] == '\x1b' {
                return if chars.get(j + 1) == Some(&'\\') {
                    j + 2
                } else {
                    j
                };
            }
            j += 1;
        }
        n
    };
    let Some(&next) = chars.get(i + 1) else {
        return i + 1;
    };
    match next {
        '[' => {
            let mut j = i + 2;
            while j < n && ('\x30'..='\x3f').contains(&chars[j]) {
                j += 1;
            }
            while j < n && ('\x20'..='\x2f').contains(&chars[j]) {
                j += 1;
            }
            if j < n && ('\x40'..='\x7e').contains(&chars[j]) {
                j + 1
            } else {
                j
            }
        }
        ']' => st_end(i + 2, true),
        'P' | 'X' | '^' | '_' => st_end(i + 2, false),
        'N' | 'O' => match chars.get(i + 2) {
            Some(c) if *c != '\x1b' => i + 3,
            _ => i + 2,
        },
        '\x20'..='\x2f' => {
            let mut j = i + 2;
            while j < n && ('\x20'..='\x2f').contains(&chars[j]) {
                j += 1;
            }
            if j < n && ('\x30'..='\x7e').contains(&chars[j]) {
                j + 1
            } else {
                j
            }
        }
        '\x30'..='\x7e' => i + 2,
        _ => i + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripped(s: &str) -> String {
        let chars: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '\x1b' {
                i = skip_escape(&chars, i);
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    #[test]
    fn skips_the_same_families_as_history_cleaning() {
        assert_eq!(stripped("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(stripped("\x1b]0;title\x07tail"), "tail");
        assert_eq!(stripped("\x1b]8;;url\x1b\\x"), "x");
        assert_eq!(stripped("\x1bP+q544e\x1b\\"), "");
        assert_eq!(stripped("\x1bOB"), "");
        assert_eq!(stripped("\x1b(B"), "");
        assert_eq!(stripped("\x1b7x"), "x");
        assert_eq!(stripped("plain"), "plain");
    }
}
