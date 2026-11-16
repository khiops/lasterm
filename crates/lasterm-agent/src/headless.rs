use std::num::NonZeroU16;
use std::ops::RangeInclusive;
use std::time::Instant;

use crate::cwd::{self, ShellReport};
use crate::input_modes::InputModes;

/// What xterm resets on DECSTR and vt100 does not (#1012): cursor keys, the
/// keypad, bracketed paste, the cursor style, cursor visibility and the
/// attributes. Fed to the parser where the DECSTR was.
const DECSTR_RESET: &[u8] = b"\x1b[?1l\x1b>\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[m";

/// Sets the mouse mode, the mouse encoding and the cursor style to their
/// defaults, which vt100's `input_mode_formatted` leaves out when they are
/// at them (#1012).
const MODE_RESET: &str = "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[0 q";

/// What vt100 hands back through callbacks rather than keeping on the screen:
/// the window title (OSC 0 and OSC 2), and the OSC sequences it does not
/// handle itself, which is where notifications (OSC 9) and the shell's own
/// report of its directory (OSC 7, OSC 9;9, OSC 633;P;Cwd=, OSC
/// 1337;CurrentDir=) arrive. The parser keeps its state from one chunk to the
/// next, so a sequence split across two reads of the PTY arrives whole.
struct MirrorCallbacks {
    title: String,
    /// The first notification of the chunk being processed.
    notification: Option<String>,
    /// The last directory the shell reported in the chunk being processed.
    shell_cwd: Option<ShellReport>,
    /// This host's name, as an OSC 7 for this host names it.
    local_host: String,
    /// Whether the program asked for focus reports (`?1004`), which vt100
    /// does not follow (#1012).
    focus: bool,
    /// A DECSTR (`CSI … ! p`) completed since the mirror last looked.
    decstr: bool,
}

impl vt100::Callbacks for MirrorCallbacks {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        // A title that is not UTF-8 is ignored, as vt100 did before it moved
        // titles to callbacks.
        if let Ok(title) = std::str::from_utf8(title) {
            self.title = title.to_string();
        }
    }

    fn unhandled_csi(
        &mut self,
        _: &mut vt100::Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        if c == 'p' && i1 == Some(b'!') && i2.is_none() {
            self.decstr = true;
        }
        // A combined sequence comes whole, with the params vt100 handled too.
        if i1 == Some(b'?')
            && i2.is_none()
            && (c == 'h' || c == 'l')
            && params.iter().any(|p| *p == [1004])
        {
            self.focus = c == 'h';
        }
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        match parse_osc(params, &self.local_host) {
            Some(Osc::Notification(message)) => {
                self.notification.get_or_insert(message);
            }
            Some(Osc::Cwd(report)) => self.shell_cwd = Some(report),
            None => {}
        }
    }
}

/// Terminal state mirror backed by vt100::Parser.
/// Tracks screen content, cursor, title, bell, notifications and the
/// directory the shell reports.
pub struct HeadlessMirror {
    parser: vt100::Parser<MirrorCallbacks>,
    current_title: String,
    last_bell: Option<Instant>,
    last_notification: Option<Instant>,
    pending_title_change: Option<String>,
    pending_bell: bool,
    pending_notification: Option<String>,
    pending_shell_cwd: Option<ShellReport>,
    /// The last byte seen that is not a C0 control or DEL, across reads: a
    /// DECSTR's `!` comes right before its `p`, with only those between, which
    /// a parser executes or ignores without leaving the sequence (#1012).
    last_significant: Option<u8>,
    /// An `ESC` was seen with only C0 controls or DEL since, across reads: a
    /// `c` now ends a RIS. CAN and SUB cancel it, as they cancel any sequence.
    escape: bool,
}

const BELL_THROTTLE_MS: u128 = 100;
const NOTIFICATION_THROTTLE_MS: u128 = 500;
const MAX_NOTIFICATION_LEN: usize = 256;
/// The longest host name an OSC 7 may carry.
const MAX_HOST_LEN: usize = 255;
/// ConEmu's and Windows Terminal's OSC 9 sub-commands, `9;1` to `9;12`: `9;4`
/// is progress, `9;9` the shell's directory. None of them is a notification.
const CONEMU_SUBCOMMANDS: RangeInclusive<u32> = 1..=12;

impl HeadlessMirror {
    /// Create a new headless terminal mirror.
    /// scrollback: number of scrollback lines (default 1000)
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self::on_host(cols, rows, scrollback, cwd::local_host_name())
    }

    /// A mirror for a terminal on the host named `local_host`: an OSC 7 that
    /// names another host reports that host, not a directory.
    fn on_host(cols: u16, rows: u16, scrollback: usize, local_host: &str) -> Self {
        let parser = vt100::Parser::new_with_callbacks(
            dimension(rows),
            dimension(cols),
            scrollback,
            MirrorCallbacks {
                title: String::new(),
                notification: None,
                shell_cwd: None,
                local_host: local_host.to_owned(),
                focus: false,
                decstr: false,
            },
        );
        Self {
            parser,
            current_title: String::new(),
            last_bell: None,
            last_notification: None,
            pending_title_change: None,
            pending_bell: false,
            pending_notification: None,
            pending_shell_cwd: None,
            last_significant: None,
            escape: false,
        }
    }

    /// Feed raw PTY output into the terminal parser.
    /// Call this with every chunk of data from the PTY.
    /// After calling, check pending_* fields for events.
    pub fn process(&mut self, data: &[u8]) {
        // Each byte that may end a DECSTR (`p` after `!`) or a RIS (`c` after
        // `ESC`), C0 controls and DEL between them aside, ends a slice, so that what
        // they reset is reset at their place in the stream, before the bytes
        // after them (#1012).
        let mut start = 0;
        for (idx, &byte) in data.iter().enumerate() {
            let c0 = (byte < 0x20 && byte != 0x1b) || byte == 0x7f;
            let decstr_end = byte == b'p' && self.last_significant == Some(b'!');
            let ris = byte == b'c' && self.escape;
            if byte == 0x1b {
                self.escape = true;
            } else if !c0 || byte == 0x18 || byte == 0x1a {
                self.escape = false;
            }
            if !c0 {
                self.last_significant = Some(byte);
            }
            if !decstr_end && !ris {
                continue;
            }
            self.parser.process(&data[start..=idx]);
            start = idx + 1;
            if decstr_end && std::mem::take(&mut self.parser.callbacks_mut().decstr) {
                self.parser.process(DECSTR_RESET);
                self.parser.callbacks_mut().focus = false;
            }
            if ris {
                // vt100 resets the modes it follows itself.
                self.parser.callbacks_mut().focus = false;
            }
        }
        if start < data.len() {
            self.parser.process(&data[start..]);
        }
        // A DECSTR's `p` follows its `!` (C0 controls aside), so its flag is
        // taken at the cut above; none outlives the read, to meet an unrelated
        // `!p` later.
        self.parser.callbacks_mut().decstr = false;

        // Check for title change (OSC 0/2)
        let new_title = &self.parser.callbacks().title;
        if *new_title != self.current_title {
            self.current_title = new_title.clone();
            self.pending_title_change = Some(new_title.clone());
        }

        // Check for bell.
        // vt100 doesn't expose bell directly. We scan for \x07 in the raw data.
        // BUT: \x07 inside an OSC sequence is the terminator, not a bell.
        // Simple heuristic: if \x07 appears outside an escape sequence context,
        // it's a bell. For accuracy, check if data contains bare \x07 not preceded
        // by \x1b] (OSC start).
        if contains_bell(data) {
            let now = Instant::now();
            let should_fire = match self.last_bell {
                Some(last) => now.duration_since(last).as_millis() >= BELL_THROTTLE_MS,
                None => true,
            };
            if should_fire {
                self.pending_bell = true;
                self.last_bell = Some(now);
            }
        }

        // A plain OSC 9 is a notification; its sub-commands are not (#829).
        if let Some(msg) = self.parser.callbacks_mut().notification.take() {
            let now = Instant::now();
            let should_fire = match self.last_notification {
                Some(last) => now.duration_since(last).as_millis() >= NOTIFICATION_THROTTLE_MS,
                None => true,
            };
            if should_fire {
                // Sanitize: strip control chars, limit length
                let sanitized = sanitize_notification(&msg);
                self.pending_notification = Some(sanitized);
                self.last_notification = Some(now);
            }
        }

        // The shell's directory, as it said it last in this chunk (#834).
        if let Some(report) = self.parser.callbacks_mut().shell_cwd.take() {
            self.pending_shell_cwd = Some(report);
        }
    }

    /// Resize the terminal mirror.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.set_size(dimension(rows), dimension(cols));
    }

    /// Produce a snapshot of the current terminal state.
    /// Returns ANSI escape sequences that reconstruct the screen content, and
    /// the input modes and screen the program is in (#1012).
    pub fn snapshot(&self) -> SnapshotInfo {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let focus = if self.parser.callbacks().focus {
            "\x1b[?1004h"
        } else {
            "\x1b[?1004l"
        };
        SnapshotInfo {
            // The screen content with ANSI formatting.
            serialized: screen.contents_formatted(),
            cols: cols.get(),
            rows: rows.get(),
            cursor_x: screen.cursor_position().1,
            cursor_y: screen.cursor_position().0,
            alternate_screen: screen.alternate_screen(),
            input_modes: format!("{MODE_RESET}{}{focus}", screen.input_mode_formatted()),
        }
    }

    /// The program's modes that decide how its input is written (#1012).
    pub(crate) fn input_modes(&self) -> InputModes {
        let screen = self.parser.screen();
        InputModes {
            bracketed_paste: screen.bracketed_paste(),
            application_cursor: screen.application_cursor(),
        }
    }

    /// Take pending title change event (if any).
    pub fn take_title_change(&mut self) -> Option<String> {
        self.pending_title_change.take()
    }

    /// Take pending bell event (if any).
    pub fn take_bell(&mut self) -> bool {
        let v = self.pending_bell;
        self.pending_bell = false;
        v
    }

    /// Take pending notification event (if any).
    pub fn take_notification(&mut self) -> Option<String> {
        self.pending_notification.take()
    }

    /// Take the directory the shell last reported (if it reported one).
    pub(crate) fn take_shell_cwd(&mut self) -> Option<ShellReport> {
        self.pending_shell_cwd.take()
    }
}

/// vt100 takes no zero dimension: the hub never sends one (`isValidDimensions`),
/// and a zero that reaches the agent anyway becomes 1 rather than a panic.
fn dimension(value: u16) -> NonZeroU16 {
    NonZeroU16::new(value).unwrap_or(NonZeroU16::MIN)
}

pub struct SnapshotInfo {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
    /// The program is in the alternate screen.
    pub alternate_screen: bool,
    /// Every input mode the program set, written so that it sets each one
    /// whatever a terminal held before.
    pub input_modes: String,
}

/// Check if data contains a bare bell (\x07) not part of an OSC terminator.
fn contains_bell(data: &[u8]) -> bool {
    // Simple scan: look for \x07 that is NOT preceded by \x1b] ... context
    // A proper approach would track parser state, but for throttled bell detection
    // a simple check is sufficient — false positives are harmless (extra bell event)
    let mut in_osc = false;
    for (i, &byte) in data.iter().enumerate() {
        if byte == 0x1b && data.get(i + 1) == Some(&b']') {
            in_osc = true;
        } else if in_osc && byte == 0x07 {
            in_osc = false; // OSC terminator, not a bell
        } else if byte == 0x07 {
            return true; // Bare bell
        } else if in_osc && byte == 0x1b && data.get(i + 1) == Some(&b'\\') {
            in_osc = false; // ST terminator
        }
    }
    false
}

/// What an OSC sequence vt100 left alone says.
#[derive(Debug, PartialEq, Eq)]
enum Osc {
    /// OSC 9 ; <message>: a desktop notification.
    Notification(String),
    /// The shell's directory.
    Cwd(ShellReport),
}

/// An OSC's parameters joined back with the `;` the parser split them at: a
/// message or a path can hold one.
fn joined(params: &[&[u8]]) -> Vec<u8> {
    params.join(&b';')
}

fn parse_osc(params: &[&[u8]], local_host: &str) -> Option<Osc> {
    let (number, rest) = params.split_first()?;
    match *number {
        b"7" => osc7(&joined(rest), local_host).map(Osc::Cwd),
        b"9" => osc9(rest),
        // VS Code's shell integration: 633 ; P ; Cwd=<dir>.
        b"633" => match rest {
            [b"P", property @ ..] => joined(property)
                .strip_prefix(b"Cwd=")
                .and_then(|value| vscode_cwd(value, local_host))
                .map(Osc::Cwd),
            _ => None,
        },
        // iTerm2's: 1337 ; CurrentDir=<dir>.
        b"1337" => joined(rest)
            .strip_prefix(b"CurrentDir=")
            .and_then(dir)
            .map(|dir| Osc::Cwd(ShellReport::Dir(dir))),
        _ => None,
    }
}

/// OSC 9: a notification, unless it is one of ConEmu's sub-commands, of
/// which only `9;9;<dir>` says anything here.
fn osc9(rest: &[&[u8]]) -> Option<Osc> {
    let first = rest.first()?;
    match subcommand(first) {
        Some(9) => osc9_9(&joined(&rest[1..])).map(Osc::Cwd),
        Some(_) => None,
        None => {
            let message = String::from_utf8_lossy(&joined(rest)).into_owned();
            (!message.is_empty()).then_some(Osc::Notification(message))
        }
    }
}

/// The number of a ConEmu sub-command, when `param` is one.
fn subcommand(param: &[u8]) -> Option<u32> {
    if param.is_empty() || param.len() > 2 || !param.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let number: u32 = std::str::from_utf8(param).ok()?.parse().ok()?;
    CONEMU_SUBCOMMANDS.contains(&number).then_some(number)
}

/// `9;9;<dir>`, the directory quoted or not, as Windows Terminal reads it.
fn osc9_9(value: &[u8]) -> Option<ShellReport> {
    let value = value
        .strip_prefix(b"\"")
        .and_then(|inner| inner.strip_suffix(b"\""))
        .unwrap_or(value);
    dir(value).map(ShellReport::Dir)
}

/// A directory from the bytes a shell sent, when it can be one.
fn dir(bytes: &[u8]) -> Option<String> {
    let dir = std::str::from_utf8(bytes).ok()?;
    cwd::plausible_dir(dir).then(|| dir.to_owned())
}

/// `%XX` decoded. A `%` without two hex digits after it stays as it is.
fn percent_decoded(bytes: &[u8]) -> Vec<u8> {
    let hex = |b: u8| (b as char).to_digit(16);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// OSC 7: `file://<host>/<path>`, the path percent-encoded. Another host's
/// name reports that host: the user is in a session nested in the terminal.
fn osc7(uri: &[u8], local_host: &str) -> Option<ShellReport> {
    let scheme = b"file://";
    if uri.len() < scheme.len() || !uri[..scheme.len()].eq_ignore_ascii_case(scheme) {
        return None;
    }
    let rest = &uri[scheme.len()..];
    let slash = rest.iter().position(|&b| b == b'/')?;
    let host = std::str::from_utf8(&rest[..slash]).ok()?;
    if host.len() > MAX_HOST_LEN || host.chars().any(char::is_control) {
        return None;
    }
    if !cwd::is_local_host(host, local_host) {
        return Some(ShellReport::OtherHost(host.to_owned()));
    }
    let path = String::from_utf8(percent_decoded(&rest[slash..])).ok()?;
    let path = osc7_path(path, cfg!(windows));
    cwd::plausible_dir(&path).then_some(ShellReport::Dir(path))
}

/// An OSC 7 path as this host writes one: on Windows, `/C:/Users/me` is
/// `C:\Users\me`, and `//server/share/dir`, a share's path as PowerShell's
/// prompt writes it (#839), is `\\server\share\dir`.
fn osc7_path(path: String, windows: bool) -> String {
    let bytes = path.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
    let share = bytes.len() >= 3 && bytes[0] == b'/' && bytes[1] == b'/' && bytes[2] != b'/';
    if windows && share {
        return path.replace('/', "\\");
    }
    if !windows || !drive {
        return path;
    }
    let mut dir = path[1..].replace('/', "\\");
    if dir.len() == 2 {
        dir.push('\\');
    }
    dir
}

/// VS Code's `Cwd=` value: `\\` is a backslash and `\xHH` a byte, which is
/// how it escapes `;` and control characters. A `file://` URI reads as OSC 7.
fn vscode_cwd(value: &[u8], local_host: &str) -> Option<ShellReport> {
    let mut out = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        if value[i] == b'\\' {
            if value.get(i + 1) == Some(&b'\\') {
                out.push(b'\\');
                i += 2;
                continue;
            }
            if value.get(i + 1) == Some(&b'x') && i + 3 < value.len() {
                let hex = std::str::from_utf8(&value[i + 2..i + 4]).ok();
                if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(byte);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(value[i]);
        i += 1;
    }
    if out.len() >= 7 && out[..7].eq_ignore_ascii_case(b"file://") {
        return osc7(&out, local_host);
    }
    dir(&out).map(ShellReport::Dir)
}

/// Sanitize a notification message: strip control chars, limit length.
fn sanitize_notification(msg: &str) -> String {
    let cleaned: String = msg
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NOTIFICATION_LEN)
        .collect();
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The D1 reset that `input_modes` starts with (#1012).
    const RESET: &str = "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[0 q";

    #[test]
    fn the_snapshot_carries_the_whole_input_mode_state() {
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        assert_eq!(
            mirror.snapshot().input_modes,
            format!("{RESET}\x1b>\x1b[?1l\x1b[?2004l\x1b[?1004l")
        );

        mirror.process(b"\x1b[?2004h\x1b[?1h\x1b=\x1b[?1000h\x1b[?1006h\x1b[3 q\x1b[?1004h$ ");
        assert_eq!(
            mirror.snapshot().input_modes,
            format!("{RESET}\x1b=\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[3 q\x1b[?1004h")
        );
    }

    #[test]
    fn the_snapshot_says_whether_the_alternate_screen_is_up() {
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        assert!(!mirror.snapshot().alternate_screen);
        mirror.process(b"\x1b[?1049hEDIT");
        assert!(mirror.snapshot().alternate_screen);
        mirror.process(b"\x1b[?1049l");
        assert!(!mirror.snapshot().alternate_screen);
    }

    #[test]
    fn focus_reporting_is_followed_in_combined_sequences() {
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1;1004;2004h");
        assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004h"));
        mirror.process(b"\x1b[?1;1004l");
        assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004l"));
    }

    #[test]
    fn decstr_and_ris_reset_the_modes_xterm_resets() {
        let reset_modes = format!("{RESET}\x1b>\x1b[?1l\x1b[?2004l\x1b[?1004l");
        // Plain.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[3 q\x1b[!p");
        assert_eq!(mirror.snapshot().input_modes, reset_modes);
        // Cursor and attributes.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?25l\x1b[31m\x1b[!pX");
        let snap = mirror.snapshot();
        assert!(
            snap.serialized.starts_with("\x1b[?25h"),
            "{:?}",
            snap.serialized
        );
        assert!(!snap.serialized.contains("31m"), "{:?}", snap.serialized);
        assert_eq!(mirror.parser.screen().contents(), "X");
        // Parameters.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1h\x1b[?2004h\x1b[0!p");
        assert_eq!(mirror.snapshot().input_modes, reset_modes);
        // Split across two reads.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1h\x1b[?2004h\x1b[!");
        mirror.process(b"p");
        assert_eq!(mirror.snapshot().input_modes, reset_modes);
        // Position: what follows the DECSTR in the same read stays.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[!p\x1b[?1h");
        assert!(mirror.snapshot().input_modes.contains("\x1b[?1h"));
        // C0 controls inside a DECSTR or a RIS, which parsers execute in place,
        // and DEL, which they ignore there.
        for inside in [b"\x00", b"\x7f"] {
            let mut mirror = HeadlessMirror::new(20, 5, 100);
            mirror.process(&[b"\x1b[?1h\x1b[?2004h\x1b[!".as_slice(), inside, b"p"].concat());
            assert_eq!(mirror.snapshot().input_modes, reset_modes);
            let mut mirror = HeadlessMirror::new(20, 5, 100);
            mirror.process(&[b"\x1b[?1004h\x1b".as_slice(), inside, b"c"].concat());
            assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004l"));
        }
        // Another intermediate is no DECSTR, and no flag waits for a `!p` in text.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1h\x1b[!\"p");
        mirror.process(b"Wow!pretty");
        assert!(mirror.snapshot().input_modes.contains("\x1b[?1h"));
        // RIS, whole and split.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1004h\x1bc");
        assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004l"));
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[?1004h\x1b");
        mirror.process(b"c");
        assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004l"));
        // Focus set after the reset, in the same read.
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1b[!p\x1b[?1004h");
        assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004h"));
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(b"\x1bc\x1b[?1004h");
        assert!(mirror.snapshot().input_modes.ends_with("\x1b[?1004h"));
    }

    #[test]
    fn the_mirror_hands_over_the_modes_that_decide_input() {
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        assert_eq!(mirror.input_modes(), InputModes::default());
        mirror.process(b"\x1b[?2004h\x1b[?1h");
        assert_eq!(
            mirror.input_modes(),
            InputModes {
                bracketed_paste: true,
                application_cursor: true
            }
        );
    }

    #[test]
    fn test_snapshot_basic() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"hello world");
        let snap = mirror.snapshot();
        assert!(snap.serialized.contains("hello world"));
        assert_eq!(snap.cols, 80);
        assert_eq!(snap.rows, 24);
    }

    #[test]
    fn test_title_change_osc0() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]0;My Title\x07");
        let title = mirror.take_title_change();
        assert_eq!(title, Some("My Title".to_string()));
    }

    #[test]
    fn test_title_change_osc2() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]2;Window Title\x07");
        let title = mirror.take_title_change();
        assert_eq!(title, Some("Window Title".to_string()));
    }

    #[test]
    fn test_same_title_again_is_not_a_change() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]2;Build\x07");
        assert_eq!(mirror.take_title_change(), Some("Build".to_string()));
        mirror.process(b"\x1b]2;Build\x07");
        assert_eq!(mirror.take_title_change(), None);
    }

    #[test]
    fn test_title_not_utf8_is_ignored() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]2;Kept\x07");
        assert_eq!(mirror.take_title_change(), Some("Kept".to_string()));
        mirror.process(b"\x1b]2;\xff\xfe\x07");
        assert_eq!(mirror.take_title_change(), None);
    }

    #[test]
    fn test_bell_detection() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x07");
        assert!(mirror.take_bell());
    }

    #[test]
    fn test_bell_throttle() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x07");
        assert!(mirror.take_bell());
        // Immediately again — should be throttled
        mirror.process(b"\x07");
        assert!(!mirror.take_bell());
    }

    #[test]
    fn test_osc9_notification() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]9;Build complete\x07");
        let notif = mirror.take_notification();
        assert_eq!(notif, Some("Build complete".to_string()));
    }

    #[test]
    fn test_notification_sanitized() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        // Notification with control chars
        mirror.process(b"\x1b]9;Hello\x01World\x07");
        let notif = mirror.take_notification().unwrap();
        assert!(!notif.contains('\x01'));
        assert!(notif.contains("HelloWorld"));
    }

    /// ConEmu's and Windows Terminal's OSC 9 sub-commands are not
    /// notifications: progress from winget or a prompt, the directory from a
    /// PowerShell prompt set up for Windows Terminal (#829).
    #[test]
    fn osc9_sub_commands_are_not_notifications() {
        for sequence in [
            &b"\x1b]9;4;1;50\x07"[..],
            b"\x1b]9;4;0\x1b\\",
            b"\x1b]9;9;\"C:\\Users\\me\"\x1b\\",
            b"\x1b]9;9;/home/me\x07",
            b"\x1b]9;1;500\x07",
            b"\x1b]9;12\x07",
        ] {
            let mut mirror = HeadlessMirror::new(80, 24, 1000);
            mirror.process(sequence);
            assert_eq!(
                mirror.take_notification(),
                None,
                "{}",
                String::from_utf8_lossy(sequence)
            );
        }
    }

    /// A plain message is one, semicolons, digits and all.
    #[test]
    fn a_plain_osc9_message_is_a_notification() {
        for (sequence, message) in [
            (&b"\x1b]9;Build; done\x07"[..], "Build; done"),
            (b"\x1b]9;100% done\x07", "100% done"),
            (b"\x1b]9;42;answer\x07", "42;answer"),
        ] {
            let mut mirror = HeadlessMirror::new(80, 24, 1000);
            mirror.process(sequence);
            assert_eq!(mirror.take_notification().as_deref(), Some(message));
        }
    }

    #[test]
    fn a_notification_split_across_reads_arrives_whole() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"output\x1b]9;Build co");
        assert_eq!(mirror.take_notification(), None);
        mirror.process(b"mplete\x07more");
        assert_eq!(
            mirror.take_notification().as_deref(),
            Some("Build complete")
        );
    }

    fn reported(local_host: &str, chunks: &[&[u8]]) -> Option<ShellReport> {
        let mut mirror = HeadlessMirror::on_host(80, 24, 1000, local_host);
        let mut last = None;
        for chunk in chunks {
            mirror.process(chunk);
            if let Some(report) = mirror.take_shell_cwd() {
                last = Some(report);
            }
        }
        last
    }

    fn dir_of(path: &str) -> Option<ShellReport> {
        Some(ShellReport::Dir(path.into()))
    }

    #[test]
    fn osc7_reports_a_directory_on_this_host() {
        assert_eq!(
            reported("pc", &[b"\x1b]7;file://pc/tmp\x07"]),
            dir_of("/tmp")
        );
        assert_eq!(
            reported("pc", &[b"\x1b]7;file:///srv/a\x1b\\"]),
            dir_of("/srv/a")
        );
        assert_eq!(
            reported("pc", &[b"\x1b]7;file://localhost/home/me/My%20Files\x07"]),
            dir_of("/home/me/My Files")
        );
        assert_eq!(
            reported("pc.lan", &[b"\x1b]7;file://PC/a%3Bb\x07"]),
            dir_of("/a;b")
        );
    }

    #[test]
    fn osc7_for_another_host_reports_that_host_and_no_directory() {
        assert_eq!(
            reported("pc", &[b"\x1b]7;file://server/home/me\x07"]),
            Some(ShellReport::OtherHost("server".into()))
        );
    }

    #[test]
    fn a_report_split_across_reads_arrives_whole() {
        assert_eq!(
            reported("pc", &[b"$ \x1b]7;file://pc/ho", b"me/me\x07$ "]),
            dir_of("/home/me")
        );
    }

    #[test]
    fn osc9_9_reports_a_directory_quoted_or_not() {
        assert_eq!(
            reported("pc", &[b"\x1b]9;9;\"C:\\Users\\me\"\x1b\\"]),
            dir_of("C:\\Users\\me")
        );
        assert_eq!(
            reported("pc", &[b"\x1b]9;9;C:\\a;b\x07"]),
            dir_of("C:\\a;b")
        );
    }

    #[test]
    fn vscode_and_iterm2_report_a_directory() {
        assert_eq!(
            reported("pc", &[b"\x1b]633;P;Cwd=/home/me/a\\x3bb\\\\c\x07"]),
            dir_of("/home/me/a;b\\c")
        );
        assert_eq!(
            reported("pc", &[b"\x1b]633;P;Cwd=file://server/x\x07"]),
            Some(ShellReport::OtherHost("server".into()))
        );
        assert_eq!(reported("pc", &[b"\x1b]633;A\x07"]), None);
        assert_eq!(
            reported("pc", &[b"\x1b]1337;CurrentDir=/Users/me\x07"]),
            dir_of("/Users/me")
        );
    }

    #[test]
    fn the_last_report_of_a_chunk_wins() {
        assert_eq!(
            reported("pc", &[b"\x1b]7;file://pc/a\x07\x1b]7;file://pc/b\x07"]),
            dir_of("/b")
        );
    }

    #[test]
    fn what_cannot_be_a_directory_is_not_reported() {
        assert_eq!(reported("pc", &[b"\x1b]7;file://pc/a%0Ab\x07"]), None);
        assert_eq!(reported("pc", &[b"\x1b]7;http://pc/a\x07"]), None);
        assert_eq!(reported("pc", &[b"\x1b]7;file://pc\x07"]), None);
        assert_eq!(reported("pc", &[b"\x1b]9;9;\x07"]), None);
        assert_eq!(reported("pc", &[b"\x1b]1337;CurrentDir=\xff\x07"]), None);
        assert_eq!(reported("pc", &[b"\x1b]2;title\x07plain text"]), None);
    }

    #[test]
    fn an_osc7_path_is_written_as_windows_writes_it_there() {
        assert_eq!(osc7_path("/C:/Users/me".into(), true), "C:\\Users\\me");
        assert_eq!(osc7_path("/C:".into(), true), "C:\\");
        assert_eq!(osc7_path("/C:/Users/me".into(), false), "/C:/Users/me");
        assert_eq!(osc7_path("/home/me".into(), true), "/home/me");
        // A share, as the PowerShell prompt of #839 writes one after the host.
        assert_eq!(
            osc7_path("//server/share/My Files".into(), true),
            "\\\\server\\share\\My Files"
        );
        assert_eq!(osc7_path("//server/share".into(), false), "//server/share");
        assert_eq!(osc7_path("///x".into(), true), "///x");
    }

    #[test]
    fn percent_decoding_keeps_what_is_not_an_escape() {
        assert_eq!(percent_decoded(b"a%20b"), b"a b");
        assert_eq!(percent_decoded(b"100%"), b"100%");
        assert_eq!(percent_decoded(b"%zz%4"), b"%zz%4");
    }

    #[test]
    fn test_resize_mirror() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.resize(120, 40);
        let snap = mirror.snapshot();
        assert_eq!(snap.cols, 120);
        assert_eq!(snap.rows, 40);
    }

    #[test]
    fn test_zero_size_becomes_one() {
        let mut mirror = HeadlessMirror::new(0, 0, 1000);
        let snap = mirror.snapshot();
        assert_eq!((snap.cols, snap.rows), (1, 1));
        mirror.resize(0, 40);
        let snap = mirror.snapshot();
        assert_eq!((snap.cols, snap.rows), (1, 40));
    }

    #[test]
    fn test_snapshot_cursor_position() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        // Move cursor to row 5, col 10
        mirror.process(b"\x1b[5;10H");
        let snap = mirror.snapshot();
        // vt100 uses 0-indexed, escape sequence is 1-indexed
        assert_eq!(snap.cursor_y, 4);
        assert_eq!(snap.cursor_x, 9);
    }
}
