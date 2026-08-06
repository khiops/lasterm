use std::time::Instant;

/// Terminal state mirror backed by vt100::Parser.
/// Tracks screen content, cursor, title, bell, and notifications.
pub struct HeadlessMirror {
    parser: vt100::Parser,
    current_title: String,
    last_bell: Option<Instant>,
    last_notification: Option<Instant>,
    pending_title_change: Option<String>,
    pending_bell: bool,
    pending_notification: Option<String>,
}

const BELL_THROTTLE_MS: u128 = 100;
const NOTIFICATION_THROTTLE_MS: u128 = 500;
const MAX_NOTIFICATION_LEN: usize = 256;

impl HeadlessMirror {
    /// Create a new headless terminal mirror.
    /// scrollback: number of scrollback lines (default 1000)
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let parser = vt100::Parser::new(rows, cols, scrollback);
        Self {
            parser,
            current_title: String::new(),
            last_bell: None,
            last_notification: None,
            pending_title_change: None,
            pending_bell: false,
            pending_notification: None,
        }
    }

    /// Feed raw PTY output into the terminal parser.
    /// Call this with every chunk of data from the PTY.
    /// After calling, check pending_* fields for events.
    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);

        // Check for title change (OSC 0/2)
        let new_title = self.parser.screen().title().to_string();
        if new_title != self.current_title {
            self.current_title = new_title.clone();
            self.pending_title_change = Some(new_title);
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

        // Check for OSC 9 (notification)
        // Scan data for \x1b]9;...\x07 or \x1b]9;...\x1b\\
        if let Some(msg) = extract_osc9(data) {
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
    }

    /// Resize the terminal mirror.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.set_size(rows, cols);
    }

    /// Produce a snapshot of the current terminal state.
    /// Returns ANSI escape sequences that reconstruct the screen content.
    pub fn snapshot(&self) -> SnapshotInfo {
        let screen = self.parser.screen();
        // contents_formatted returns the screen content with ANSI formatting
        let serialized_bytes = screen.contents_formatted();
        let serialized = String::from_utf8_lossy(&serialized_bytes).to_string();
        SnapshotInfo {
            serialized,
            cols: screen.size().1,
            rows: screen.size().0,
            cursor_x: screen.cursor_position().1,
            cursor_y: screen.cursor_position().0,
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
}

pub struct SnapshotInfo {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
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

/// Extract OSC 9 notification message from raw data.
fn extract_osc9(data: &[u8]) -> Option<String> {
    // Look for \x1b]9;...\x07 or \x1b]9;...\x1b\\
    let data_str = String::from_utf8_lossy(data);
    // Pattern: ESC ] 9 ; <message> BEL  or  ESC ] 9 ; <message> ST
    if let Some(start) = data_str.find("\x1b]9;") {
        let msg_start = start + 4; // skip \x1b]9;
        let remaining = &data_str[msg_start..];
        // Find terminator: \x07 or \x1b\\
        let end = remaining
            .find('\x07')
            .or_else(|| remaining.find("\x1b\\"))
            .unwrap_or(remaining.len());
        let msg = &remaining[..end];
        if !msg.is_empty() {
            return Some(msg.to_string());
        }
    }
    None
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

    #[test]
    fn test_resize_mirror() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.resize(120, 40);
        let snap = mirror.snapshot();
        assert_eq!(snap.cols, 120);
        assert_eq!(snap.rows, 40);
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
