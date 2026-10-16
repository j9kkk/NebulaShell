//! Shell 词法：一遍扫描产出分段、词、重定向与命令替换正文。
//!
//! 不是完整的 POSIX 解析器，只为分级规则提供足够且保守的信息：引号与转义被
//! 去掉；运行期才能确定的部分（参数展开、命令替换等）原样保留并标记
//! `dynamic`；命令替换、进程替换与 heredoc 的正文单独收集，供上层递归分级。
//! 无法闭合的结构记为 `unbalanced`，由上层按 fail-closed 处理。

#[derive(Debug, Clone, Default)]
pub struct Word {
    /// 去引号、去转义后的文本；展开部分（如 `$HOME`、`$(...)`）原样保留。
    pub text: String,
    /// 含运行期才能确定的部分：参数/算术展开、命令替换、ANSI-C 引号。
    pub dynamic: bool,
    /// 进程替换 `<(...)`/`>(...)` 占位。
    pub proc_subst: bool,
    /// 含未加引号的 glob 字符。
    pub glob: bool,
    /// 含引号或转义。
    pub quoted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sep {
    Start,
    Seq,
    And,
    Or,
    Pipe,
    Background,
}

#[derive(Debug, Clone)]
pub struct Redirect {
    pub op: &'static str,
    pub target: Word,
    /// `<<`/`<<-` 的正文。
    pub heredoc: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub sep_before: Sep,
    pub words: Vec<Word>,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, Default)]
pub struct Lexed {
    pub segments: Vec<Segment>,
    /// `$(...)` 与反引号的正文（含双引号内的）。
    pub substitutions: Vec<String>,
    /// `<(...)`/`>(...)` 的正文。
    pub proc_substitutions: Vec<String>,
    /// 引号、替换或重定向等结构未闭合。
    pub unbalanced: bool,
    /// 出现函数定义 `name() ...`。
    pub func_def: bool,
    /// 出现子 shell 分组 `( ... )`：分段已拍平，组内 `cd` 的作用范围无从得知。
    pub subshell: bool,
}

pub fn lex(src: &str) -> Lexed {
    let chars: Vec<char> = src.chars().collect();
    let mut lx = Lexer {
        c: &chars,
        i: 0,
        out: Lexed::default(),
        words: Vec::new(),
        redirects: Vec::new(),
        sep: Sep::Start,
        pending_heredocs: Vec::new(),
    };
    lx.run();
    lx.out
}

fn is_meta(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\r' | '\n' | ';' | '&' | '|' | '<' | '>' | '(' | ')'
    )
}

struct Lexer<'a> {
    c: &'a [char],
    i: usize,
    out: Lexed,
    words: Vec<Word>,
    redirects: Vec<Redirect>,
    sep: Sep,
    /// (段下标, 重定向下标, 定界符, 是否剥前导 tab)
    pending_heredocs: Vec<(usize, usize, String, bool)>,
}

impl Lexer<'_> {
    fn peek(&self, k: usize) -> Option<char> {
        self.c.get(self.i + k).copied()
    }

    fn run(&mut self) {
        while let Some(ch) = self.peek(0) {
            match ch {
                ' ' | '\t' | '\r' => self.i += 1,
                '\n' => {
                    self.i += 1;
                    self.end_segment(Sep::Seq);
                    self.read_heredocs();
                }
                '#' => {
                    while self.peek(0).is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                }
                ';' => {
                    self.i += if self.peek(1) == Some(';') { 2 } else { 1 };
                    self.end_segment(Sep::Seq);
                }
                '&' => match self.peek(1) {
                    Some('&') => {
                        self.i += 2;
                        self.end_segment(Sep::And);
                    }
                    Some('>') => {
                        let op = if self.peek(2) == Some('>') {
                            "&>>"
                        } else {
                            "&>"
                        };
                        self.i += op.len();
                        self.read_redirect(op);
                    }
                    _ => {
                        self.i += 1;
                        self.end_segment(Sep::Background);
                    }
                },
                '|' => {
                    let (n, sep) = match self.peek(1) {
                        Some('|') => (2, Sep::Or),
                        Some('&') => (2, Sep::Pipe),
                        _ => (1, Sep::Pipe),
                    };
                    self.i += n;
                    self.end_segment(sep);
                }
                '(' => {
                    if self.peek(1) == Some(')') {
                        self.out.func_def = true;
                        self.i += 2;
                    } else {
                        self.out.subshell = true;
                        self.i += 1;
                        self.end_segment(Sep::Seq);
                    }
                }
                ')' => {
                    self.i += 1;
                    self.end_segment(Sep::Seq);
                }
                '<' | '>' if self.peek(1) == Some('(') => self.read_proc_subst(),
                '<' | '>' => {
                    let op = self.read_redirect_op();
                    self.read_redirect(op);
                }
                c if c.is_ascii_digit() && self.fd_redirect_ahead() => {
                    while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                        self.i += 1;
                    }
                    let op = self.read_redirect_op();
                    self.read_redirect(op);
                }
                _ => {
                    let w = self.read_word();
                    self.push_word(w);
                }
            }
        }
        self.end_segment(Sep::Seq);
        self.read_heredocs();
    }

    fn push_word(&mut self, w: Word) {
        // 分组用的 `{` `}` 与管道取反 `!` 只在段首有语法意义，丢掉不影响分级。
        if self.words.is_empty() && !w.quoted && matches!(w.text.as_str(), "{" | "}" | "!") {
            return;
        }
        self.words.push(w);
    }

    fn end_segment(&mut self, next: Sep) {
        if self.words.is_empty() && self.redirects.is_empty() {
            // `a |\n b`：运算符后的换行/括号不能冲掉待续的管道语义。
            let pending_op = matches!(self.sep, Sep::Pipe | Sep::And | Sep::Or);
            if !(pending_op && next == Sep::Seq) {
                self.sep = next;
            }
            return;
        }
        self.out.segments.push(Segment {
            sep_before: self.sep,
            words: std::mem::take(&mut self.words),
            redirects: std::mem::take(&mut self.redirects),
        });
        self.sep = next;
    }

    fn fd_redirect_ahead(&self) -> bool {
        let mut k = self.i;
        while self.c.get(k).is_some_and(|c| c.is_ascii_digit()) {
            k += 1;
        }
        matches!(self.c.get(k), Some('<' | '>'))
    }

    fn read_redirect_op(&mut self) -> &'static str {
        let (op, n) = match (self.peek(0), self.peek(1), self.peek(2)) {
            (Some('<'), Some('<'), Some('<')) => ("<<<", 3),
            (Some('<'), Some('<'), Some('-')) => ("<<-", 3),
            (Some('<'), Some('<'), _) => ("<<", 2),
            (Some('<'), Some('&'), _) => ("<&", 2),
            (Some('<'), Some('>'), _) => ("<>", 2),
            (Some('<'), _, _) => ("<", 1),
            (Some('>'), Some('>'), _) => (">>", 2),
            (Some('>'), Some('|'), _) => (">|", 2),
            (Some('>'), Some('&'), _) => (">&", 2),
            _ => (">", 1),
        };
        self.i += n;
        op
    }

    fn read_redirect(&mut self, op: &'static str) {
        while matches!(self.peek(0), Some(' ' | '\t')) {
            self.i += 1;
        }
        if self.peek(0).is_none_or(is_meta) {
            self.out.unbalanced = true;
            return;
        }
        let target = self.read_word();
        if op == "<<" || op == "<<-" {
            self.pending_heredocs.push((
                self.out.segments.len(),
                self.redirects.len(),
                target.text.clone(),
                op == "<<-",
            ));
        }
        self.redirects.push(Redirect {
            op,
            target,
            heredoc: None,
        });
    }

    fn read_heredocs(&mut self) {
        for (seg, red, delim, strip_tabs) in std::mem::take(&mut self.pending_heredocs) {
            let mut body = String::new();
            while self.i < self.c.len() {
                let start = self.i;
                while self.peek(0).is_some_and(|c| c != '\n') {
                    self.i += 1;
                }
                let line: String = self.c[start..self.i].iter().collect();
                if self.i < self.c.len() {
                    self.i += 1;
                }
                let cmp = if strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    line.as_str()
                };
                if cmp == delim {
                    break;
                }
                body.push_str(&line);
                body.push('\n');
            }
            if let Some(r) = self
                .out
                .segments
                .get_mut(seg)
                .and_then(|s| s.redirects.get_mut(red))
            {
                r.heredoc = Some(body);
            }
        }
    }

    fn read_proc_subst(&mut self) {
        let kind = self.c[self.i];
        match self.find_balanced(self.i + 1) {
            Some(end) => {
                let body: String = self.c[self.i + 2..end - 1].iter().collect();
                self.out.proc_substitutions.push(body.clone());
                self.i = end;
                self.push_word(Word {
                    text: format!("{kind}({body})"),
                    dynamic: true,
                    proc_subst: true,
                    ..Word::default()
                });
            }
            None => {
                self.out.unbalanced = true;
                self.i = self.c.len();
            }
        }
    }

    fn read_word(&mut self) -> Word {
        let mut w = Word::default();
        while let Some(ch) = self.peek(0) {
            if is_meta(ch) {
                break;
            }
            match ch {
                '\\' => {
                    w.quoted = true;
                    if let Some(n) = self.peek(1) {
                        if n != '\n' {
                            w.text.push(n);
                        }
                    }
                    self.i = (self.i + 2).min(self.c.len());
                }
                '\'' => {
                    w.quoted = true;
                    self.i += 1;
                    match self.find_from(self.i, '\'') {
                        Some(end) => {
                            w.text.extend(&self.c[self.i..end]);
                            self.i = end + 1;
                        }
                        None => {
                            self.out.unbalanced = true;
                            w.text.extend(&self.c[self.i..]);
                            self.i = self.c.len();
                        }
                    }
                }
                '"' => {
                    w.quoted = true;
                    self.i += 1;
                    self.read_double_quoted(&mut w);
                }
                '`' => {
                    self.i += 1;
                    self.read_backtick(&mut w);
                }
                '$' => self.read_dollar(&mut w, false),
                '*' | '?' | '[' => {
                    w.glob = true;
                    w.text.push(ch);
                    self.i += 1;
                }
                _ => {
                    w.text.push(ch);
                    self.i += 1;
                }
            }
        }
        w
    }

    fn read_double_quoted(&mut self, w: &mut Word) {
        while let Some(ch) = self.peek(0) {
            match ch {
                '"' => {
                    self.i += 1;
                    return;
                }
                '\\' => match self.peek(1) {
                    Some(n @ ('"' | '\\' | '$' | '`')) => {
                        w.text.push(n);
                        self.i += 2;
                    }
                    Some('\n') => self.i += 2,
                    _ => {
                        w.text.push('\\');
                        self.i += 1;
                    }
                },
                '`' => {
                    self.i += 1;
                    self.read_backtick(w);
                }
                '$' => self.read_dollar(w, true),
                _ => {
                    w.text.push(ch);
                    self.i += 1;
                }
            }
        }
        self.out.unbalanced = true;
    }

    fn read_backtick(&mut self, w: &mut Word) {
        w.dynamic = true;
        let mut body = String::new();
        while let Some(ch) = self.peek(0) {
            match ch {
                '`' => {
                    self.i += 1;
                    w.text.push_str(&format!("`{body}`"));
                    self.out.substitutions.push(body);
                    return;
                }
                '\\' => {
                    match self.peek(1) {
                        Some(n @ ('`' | '\\' | '$')) => body.push(n),
                        Some(n) => {
                            body.push('\\');
                            body.push(n);
                        }
                        None => {}
                    }
                    self.i = (self.i + 2).min(self.c.len());
                }
                _ => {
                    body.push(ch);
                    self.i += 1;
                }
            }
        }
        self.out.unbalanced = true;
        self.out.substitutions.push(body);
    }

    fn read_dollar(&mut self, w: &mut Word, in_dq: bool) {
        match self.peek(1) {
            Some('(') => {
                w.dynamic = true;
                let arithmetic = self.peek(2) == Some('(');
                match self.find_balanced(self.i + 1) {
                    Some(end) => {
                        let body: String = self.c[self.i + 2..end - 1].iter().collect();
                        w.text.push_str(&format!("$({body})"));
                        if !arithmetic {
                            self.out.substitutions.push(body);
                        }
                        self.i = end;
                    }
                    None => {
                        self.out.unbalanced = true;
                        let body: String = self.c[self.i + 2..].iter().collect();
                        self.out.substitutions.push(body);
                        self.i = self.c.len();
                    }
                }
            }
            Some('{') => {
                w.dynamic = true;
                match self.find_brace(self.i + 1) {
                    Some(end) => {
                        w.text.extend(&self.c[self.i..end]);
                        self.i = end;
                    }
                    None => {
                        self.out.unbalanced = true;
                        self.i = self.c.len();
                    }
                }
            }
            Some('\'') if !in_dq => {
                // ANSI-C 引号能编码任意字符（$'\x72\x6d' 即 rm），按动态处理。
                w.dynamic = true;
                w.quoted = true;
                self.i += 2;
                while let Some(ch) = self.peek(0) {
                    self.i += 1;
                    match ch {
                        '\\' => {
                            if let Some(n) = self.peek(0) {
                                w.text.push(n);
                                self.i += 1;
                            }
                        }
                        '\'' => return,
                        _ => w.text.push(ch),
                    }
                }
                self.out.unbalanced = true;
            }
            Some('"') if !in_dq => {
                w.quoted = true;
                self.i += 2;
                self.read_double_quoted(w);
            }
            Some(n) if n.is_ascii_alphabetic() || n == '_' => {
                w.dynamic = true;
                w.text.push('$');
                self.i += 1;
                while self
                    .peek(0)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    w.text.push(self.c[self.i]);
                    self.i += 1;
                }
            }
            Some(n) if n.is_ascii_digit() || "@*#?-$!".contains(n) => {
                w.dynamic = true;
                w.text.push('$');
                w.text.push(n);
                self.i += 2;
            }
            _ => {
                w.text.push('$');
                self.i += 1;
            }
        }
    }

    fn find_from(&self, from: usize, ch: char) -> Option<usize> {
        (from..self.c.len()).find(|&k| self.c[k] == ch)
    }

    /// `open` 处是 `(`，返回与之配对的 `)` 之后的下标；感知引号、转义与嵌套。
    fn find_balanced(&self, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        let mut k = open;
        while k < self.c.len() {
            match self.c[k] {
                '\\' => k += 1,
                '\'' => k = self.find_from(k + 1, '\'')?,
                '"' => k = self.skip_double_quoted(k + 1)? - 1,
                '`' => k = self.find_from(k + 1, '`')?,
                '(' => depth += 1,
                ')' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Some(k + 1);
                    }
                }
                _ => {}
            }
            k += 1;
        }
        None
    }

    /// 从双引号内部起扫描，返回闭合引号之后的下标。
    fn skip_double_quoted(&self, mut k: usize) -> Option<usize> {
        while k < self.c.len() {
            match self.c[k] {
                '\\' => k += 2,
                '"' => return Some(k + 1),
                '$' if self.c.get(k + 1) == Some(&'(') => k = self.find_balanced(k + 1)?,
                '`' => k = self.find_from(k + 1, '`')? + 1,
                _ => k += 1,
            }
        }
        None
    }

    /// `open` 处是 `{`，返回配对 `}` 之后的下标。
    fn find_brace(&self, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        let mut k = open;
        while k < self.c.len() {
            match self.c[k] {
                '\\' => k += 1,
                '\'' => k = self.find_from(k + 1, '\'')?,
                '"' => k = self.skip_double_quoted(k + 1)? - 1,
                '{' => depth += 1,
                '}' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Some(k + 1);
                    }
                }
                _ => {}
            }
            k += 1;
        }
        None
    }
}
