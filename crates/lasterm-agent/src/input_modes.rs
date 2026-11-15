//! The agent decides the form of paste markers and cursor keys it writes to a
//! terminal, from its own screen model (#1012): the program asked for one form,
//! and what a client's xterm believes may differ (a pane attached later, a
//! cached screen, a truncated tail).

use std::sync::atomic::{AtomicU8, Ordering};

const OPEN: &[u8] = b"\x1b[200~";
const CLOSE: &[u8] = b"\x1b[201~";

const BRACKETED_PASTE: u8 = 1;
const APPLICATION_CURSOR: u8 = 2;

/// The modes of a terminal's program that decide how its input is written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct InputModes {
    /// The program set bracketed paste (`?2004`).
    pub bracketed_paste: bool,
    /// The program set application cursor keys (DECCKM, `?1`).
    pub application_cursor: bool,
}

/// Where a terminal's reader publishes its modes after each read, for its
/// input path to read: the two run in different tasks.
#[derive(Debug, Default)]
pub(crate) struct InputModeCell(AtomicU8);

impl InputModeCell {
    pub(crate) fn store(&self, modes: InputModes) {
        let mut bits = 0;
        if modes.bracketed_paste {
            bits |= BRACKETED_PASTE;
        }
        if modes.application_cursor {
            bits |= APPLICATION_CURSOR;
        }
        self.0.store(bits, Ordering::Release);
    }

    pub(crate) fn load(&self) -> InputModes {
        let bits = self.0.load(Ordering::Acquire);
        InputModes {
            bracketed_paste: bits & BRACKETED_PASTE != 0,
            application_cursor: bits & APPLICATION_CURSOR != 0,
        }
    }
}

/// Write one INPUT frame in the program's form.
///
/// - A paste runs from an `ESC[200~` to the next `ESC[201~` in the frame (or
///   to its end). Its markers are kept when the program set bracketed paste
///   and removed otherwise; nothing inside it is rewritten.
/// - Outside a paste, an unmodified cursor key (`A` `B` `C` `D`, Home `H`,
///   End `F`), in either its CSI or its SS3 form, is written in SS3 form when
///   the program set application cursor keys, and in CSI form otherwise.
///   Sequences with parameters, such as `ESC[1;5A`, are left as they are.
/// - Only whole sequences within the frame match: one split across two
///   frames is written unchanged.
pub(crate) fn adapt(data: &[u8], modes: InputModes) -> Vec<u8> {
    if !data.contains(&0x1b) {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(data.len());
    let mut in_paste = false;
    let mut i = 0;
    while i < data.len() {
        let rest = &data[i..];
        if !in_paste && rest.starts_with(OPEN) {
            in_paste = true;
            if modes.bracketed_paste {
                out.extend_from_slice(OPEN);
            }
            i += OPEN.len();
            continue;
        }
        if rest.starts_with(CLOSE) {
            in_paste = false;
            if modes.bracketed_paste {
                out.extend_from_slice(CLOSE);
            }
            i += CLOSE.len();
            continue;
        }
        if !in_paste
            && rest.len() >= 3
            && rest[0] == 0x1b
            && (rest[1] == b'[' || rest[1] == b'O')
            && matches!(rest[2], b'A' | b'B' | b'C' | b'D' | b'H' | b'F')
        {
            out.push(0x1b);
            out.push(if modes.application_cursor { b'O' } else { b'[' });
            out.push(rest[2]);
            i += 3;
            continue;
        }
        out.push(data[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASTE_ON: InputModes = InputModes {
        bracketed_paste: true,
        application_cursor: false,
    };
    const PASTE_OFF: InputModes = InputModes {
        bracketed_paste: false,
        application_cursor: false,
    };
    const CURSOR_ON: InputModes = InputModes {
        bracketed_paste: false,
        application_cursor: true,
    };
    const BOTH_ON: InputModes = InputModes {
        bracketed_paste: true,
        application_cursor: true,
    };

    #[test]
    fn a_paste_loses_its_markers_when_the_program_did_not_set_bracketed_paste() {
        assert_eq!(adapt(b"\x1b[200~a\rb\r\x1b[201~", PASTE_OFF), b"a\rb\r");
    }

    #[test]
    fn a_paste_keeps_its_markers_when_the_program_set_bracketed_paste() {
        assert_eq!(
            adapt(b"\x1b[200~a\rb\r\x1b[201~", PASTE_ON),
            b"\x1b[200~a\rb\r\x1b[201~"
        );
    }

    #[test]
    fn cursor_keys_take_the_application_form_under_decckm() {
        assert_eq!(
            adapt(b"\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F", CURSOR_ON),
            b"\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF"
        );
        // Already in form: unchanged.
        assert_eq!(
            adapt(b"\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF", CURSOR_ON),
            b"\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF"
        );
    }

    #[test]
    fn cursor_keys_take_the_normal_form_without_decckm() {
        assert_eq!(
            adapt(b"\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF", PASTE_OFF),
            b"\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F"
        );
    }

    #[test]
    fn modified_keys_plain_text_and_split_sequences_are_left_as_they_are() {
        for modes in [PASTE_OFF, BOTH_ON] {
            assert_eq!(adapt(b"\x1b[1;5A", modes), b"\x1b[1;5A");
            assert_eq!(adapt(b"echo hello\r", modes), b"echo hello\r");
            // ESC[A split across two frames.
            assert_eq!(adapt(b"x\x1b[", modes), b"x\x1b[");
            assert_eq!(adapt(b"Ay", modes), b"Ay");
        }
        // A marker split across two frames, bracketed paste off.
        assert_eq!(adapt(b"\x1b[20", PASTE_OFF), b"\x1b[20");
        assert_eq!(adapt(b"0~x", PASTE_OFF), b"0~x");
    }

    #[test]
    fn nothing_inside_a_paste_is_rewritten() {
        assert_eq!(
            adapt(b"\x1b[200~\x1b[Ax\x1b[201~\x1b[A", BOTH_ON),
            b"\x1b[200~\x1b[Ax\x1b[201~\x1bOA"
        );
        assert_eq!(
            adapt(b"\x1b[200~\x1b[Ax\x1b[201~\x1b[A", CURSOR_ON),
            b"\x1b[Ax\x1bOA"
        );
    }

    #[test]
    fn the_cell_hands_over_the_modes_it_was_given() {
        let cell = InputModeCell::default();
        assert_eq!(cell.load(), InputModes::default());
        cell.store(BOTH_ON);
        assert_eq!(cell.load(), BOTH_ON);
        cell.store(PASTE_ON);
        assert_eq!(cell.load(), PASTE_ON);
    }
}
