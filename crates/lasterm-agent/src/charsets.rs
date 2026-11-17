//! The character sets a terminal's program has selected (#1013).
//!
//! vt100, the mirror's screen model, ignores character-set designations
//! (`ESC ( 0`) and shifts (SO, SI), so a border drawn with the DEC Special
//! Graphics set is stored as the letters the program sent: `lqqk` for `┌──┐`.
//! A pane that attaches then draws the snapshot's letters. The mirror
//! therefore follows the sets as the pane's terminal, xterm 6.0.0, does, and
//! hands vt100 a copy of the output where each character xterm draws through
//! DEC Special Graphics is the one it draws. The snapshot ends with the
//! designations and shift, so that what follows it is drawn as live.
//!
//! The parsing follows xterm 6.0.0's decoder and transition table, the ones
//! `output_cut.rs` follows and shares; the sets follow its
//! `src/common/services/CharsetService.ts`, `src/common/data/Charsets.ts` and
//! the handlers of `src/common/InputHandler.ts` (`selectCharset`,
//! `setgLevel`, `saveCursor`, `restoreCursor`, `softReset`, DECSET 2, 47,
//! 1047, 1048, 1049). A bump of `@xterm/xterm` must be checked against them.

use std::borrow::Cow;

use crate::output_cut::{step, Decoder, State};

const ESC: u8 = 0x1B;
const SO: u8 = 0x0E;
const SI: u8 = 0x0F;

/// xterm's largest parameter value (`Params.ts`, `MAX_VALUE`).
const MAX_PARAM: u32 = 0x7FFF_FFFF;
/// The most parameters xterm keeps.
const MAX_PARAMS: usize = 32;

/// The flags of xterm's national replacement sets, besides `0` (DEC Special
/// Graphics) and `B` (US).
const NATIONAL: &[u8] = b"A4C5RQKYE6ZH7=";

/// DEC Special Graphics, from `` ` `` (0x60) to `~` (0x7E), as xterm draws it
/// (`Charsets.ts`, `CHARSETS['0']`).
const DEC_SPECIAL_GRAPHICS: [&str; 31] = [
    "\u{25c6}", "\u{2592}", "\u{2409}", "\u{240c}", "\u{240d}", "\u{240a}", "\u{00b0}", "\u{00b1}",
    "\u{2424}", "\u{240b}", "\u{2518}", "\u{2510}", "\u{250c}", "\u{2514}", "\u{253c}", "\u{23ba}",
    "\u{23bb}", "\u{2500}", "\u{23bc}", "\u{23bd}", "\u{251c}", "\u{2524}", "\u{2534}", "\u{252c}",
    "\u{2502}", "\u{2264}", "\u{2265}", "\u{03c0}", "\u{2260}", "\u{00a3}", "\u{00b7}",
];

/// A character set a G register holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Set {
    /// US ASCII, the default; also what a restore of nothing saved gives.
    #[default]
    Us,
    /// DEC Special Graphics, `0`.
    Dec,
    /// A national replacement set, by its flag: kept, not translated.
    National(u8),
}

impl Set {
    /// The set a designation's final byte names, if xterm knows it.
    fn from_flag(flag: u8) -> Option<Self> {
        match flag {
            b'0' => Some(Set::Dec),
            b'B' => Some(Set::Us),
            _ if NATIONAL.contains(&flag) => Some(Set::National(flag)),
            _ => None,
        }
    }

    fn flag(self) -> u8 {
        match self {
            Set::Us => b'B',
            Set::Dec => b'0',
            Set::National(flag) => flag,
        }
    }
}

/// The character-set state of one terminal, and the parser state that
/// decides which bytes xterm prints.
#[derive(Default)]
pub(crate) struct Charsets {
    /// G0 to G3.
    g: [Set; 4],
    /// The G shifted into GL.
    glevel: usize,
    /// The set printed characters go through: `g[glevel]`, except after a
    /// restore, which sets it alone.
    active: Set,
    /// The set saved with the cursor, per buffer: normal, alternate.
    saved: [Set; 2],
    /// The alternate buffer is the current one.
    alternate: bool,
    state: State,
    decoder: Decoder,
    /// The first intermediate of the sequence being read, and how many.
    intermediate: u8,
    intermediates: u8,
    /// The CSI's private prefix (`<`, `=`, `>`, `?`), 0 when none.
    prefix: u8,
    params: [u32; MAX_PARAMS],
    /// The index of the parameter being read.
    param: usize,
    /// A sub-parameter (after `:`) is being read: its digits are skipped.
    sub_param: bool,
    /// Past xterm's 32 parameters: the digits of the rest are dropped.
    reject_digits: bool,
}

impl Charsets {
    /// `data` as vt100 should parse it: each byte xterm prints through DEC
    /// Special Graphics replaced by the character it draws. `data` itself
    /// when nothing is replaced.
    pub(crate) fn translate<'a>(&mut self, data: &'a [u8]) -> Cow<'a, [u8]> {
        let mut out: Option<Vec<u8>> = None;
        let mut at = 0;
        while at < data.len() {
            let byte = data[at];
            let ground = self.state == State::Ground && self.decoder.idle();
            let run = if ground { ground_run(&data[at..]) } else { 0 };
            if run > 0 {
                // A run in ground of ASCII other than ESC, SO and SI, and of
                // whole characters from U+00A0: printed or executed in place,
                // none of it changes a set.
                let bytes = &data[at..at + run];
                if self.active == Set::Dec && bytes.iter().any(|&b| dec_char(b).is_some()) {
                    let out = out.get_or_insert_with(|| copy_of(data, at));
                    for &b in bytes {
                        match dec_char(b) {
                            Some(c) => out.extend_from_slice(c.as_bytes()),
                            None => out.push(b),
                        }
                    }
                } else if let Some(out) = out.as_mut() {
                    out.extend_from_slice(bytes);
                }
                at += run;
                continue;
            }
            if ground && byte == ESC {
                if let Some(end) = self.whole_csi(&data[at..]) {
                    // A whole CSI of parameters in one step (M14).
                    if let Some(out) = out.as_mut() {
                        out.extend_from_slice(&data[at..at + end]);
                    }
                    at += end;
                    continue;
                }
            }
            let printed = match self.decoder.decode(byte) {
                Some(code) => self.code(code),
                None => None,
            };
            match printed
                .and_then(|code| u8::try_from(code).ok())
                .and_then(|b| (self.active == Set::Dec).then(|| dec_char(b)).flatten())
            {
                Some(c) => {
                    out.get_or_insert_with(|| copy_of(data, at))
                        .extend_from_slice(c.as_bytes());
                }
                None => {
                    if let Some(out) = out.as_mut() {
                        out.push(byte);
                    }
                }
            }
            at += 1;
        }
        match out {
            Some(out) => Cow::Owned(out),
            None => Cow::Borrowed(data),
        }
    }

    /// The escape sequences that set a terminal reset by RIS to this state:
    /// the designations that differ from US, then the shift. The shifted G
    /// is designated as the active set where a restore made them differ.
    pub(crate) fn suffix(&self) -> String {
        let mut g = self.g;
        g[self.glevel] = self.active;
        let mut suffix = String::new();
        for (index, set) in g.iter().enumerate() {
            if *set != Set::Us {
                suffix.push('\u{1b}');
                suffix.push(char::from(b"()*+"[index]));
                suffix.push(char::from(set.flag()));
            }
        }
        suffix.push_str(match self.glevel {
            1 => "\u{e}",
            2 => "\u{1b}n",
            3 => "\u{1b}o",
            _ => "",
        });
        suffix
    }

    /// Read a CSI made only of an optional prefix, digits and `;`, and a
    /// final byte, at the start of `bytes`, from ground: its length. `None`
    /// for anything else, which the table then reads from the ESC, collecting
    /// afresh.
    fn whole_csi(&mut self, bytes: &[u8]) -> Option<usize> {
        let rest = bytes.strip_prefix(b"\x1b[")?;
        self.clear();
        let rest_at = match rest.first() {
            Some(&p @ 0x3C..=0x3F) => {
                self.prefix = p;
                1
            }
            _ => 0,
        };
        for (offset, &b) in rest[rest_at..].iter().enumerate() {
            match b {
                b'0'..=b'9' => self.digit(b),
                b';' => self.next_param(),
                0x40..=0x7E => {
                    self.csi_dispatch(b);
                    return Some(2 + rest_at + offset + 1);
                }
                _ => return None,
            }
        }
        None
    }

    /// Step the parser on one code point. Returns it when xterm prints it.
    fn code(&mut self, code: u32) -> Option<u32> {
        let from = self.state;
        let to = step(from, code);
        // Entering a sequence starts its collection afresh (xterm's CLEAR).
        if code == 0x1B || code == 0x9B || (from == State::Escape && code == 0x5B) {
            self.clear();
        }
        let executable = matches!(code, 0x00..=0x17 | 0x19 | 0x1C..=0x1F);
        let printed = match from {
            State::Ground if code >= 0x20 && code != 0x7F && to == State::Ground => {
                if (0x80..0xA0).contains(&code) {
                    None
                } else {
                    Some(code)
                }
            }
            _ => None,
        };
        let executes = matches!(
            from,
            State::Ground
                | State::Escape
                | State::EscapeIntermediate
                | State::CsiEntry
                | State::CsiParam
                | State::CsiIntermediate
                | State::CsiIgnore
        );
        if executable && executes {
            self.execute(code as u8);
        }
        if let Ok(b) = u8::try_from(code) {
            match (from, b) {
                (State::Escape | State::EscapeIntermediate, 0x20..=0x2F)
                | (State::CsiEntry | State::CsiParam | State::CsiIntermediate, 0x20..=0x2F) => {
                    if self.intermediates == 0 {
                        self.intermediate = b;
                    }
                    self.intermediates = self.intermediates.saturating_add(1);
                }
                (State::CsiEntry, 0x3C..=0x3F) => self.prefix = b,
                (State::CsiEntry | State::CsiParam, b'0'..=b'9') if !self.sub_param => {
                    self.digit(b);
                }
                (State::CsiEntry | State::CsiParam, b';') => {
                    self.sub_param = false;
                    self.next_param();
                }
                (State::CsiEntry | State::CsiParam, b':') => self.sub_param = true,
                _ => {}
            }
            if to == State::Ground {
                match from {
                    State::Escape | State::EscapeIntermediate if (0x30..=0x7E).contains(&b) => {
                        self.esc_dispatch(b);
                    }
                    State::CsiEntry | State::CsiParam | State::CsiIntermediate
                        if (0x40..=0x7E).contains(&b) =>
                    {
                        self.csi_dispatch(b);
                    }
                    _ => {}
                }
            }
        }
        self.state = to;
        printed
    }

    fn clear(&mut self) {
        self.intermediate = 0;
        self.intermediates = 0;
        self.prefix = 0;
        self.params[0] = 0;
        self.param = 0;
        self.sub_param = false;
        self.reject_digits = false;
    }

    fn digit(&mut self, digit: u8) {
        if !self.reject_digits {
            self.params[self.param] = add_digit(self.params[self.param], digit);
        }
    }

    /// A `;`: the next parameter starts; past xterm's 32 the rest are
    /// dropped, as xterm's `Params.addParam` does.
    fn next_param(&mut self) {
        if self.param + 1 < MAX_PARAMS {
            self.param += 1;
            self.params[self.param] = 0;
        } else {
            self.reject_digits = true;
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            SO => self.shift(1),
            SI => self.shift(0),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, last: u8) {
        match (self.intermediates, self.intermediate, last) {
            (0, _, b'7') => self.save(),
            (0, _, b'8') => self.restore(),
            (0, _, b'c') => *self = Charsets::default(),
            (0, _, b'n' | b'}') => self.shift(2),
            (0, _, b'o' | b'|') => self.shift(3),
            (0, _, b'~') => self.shift(1),
            (1, b'%', b'@' | b'G') => {
                self.shift(0);
                self.designate(0, Set::Us);
            }
            (1, i, flag) => {
                let g = match i {
                    b'(' => 0,
                    b')' | b'-' => 1,
                    b'*' | b'.' => 2,
                    b'+' => 3,
                    _ => return,
                };
                if let Some(set) = Set::from_flag(flag) {
                    self.designate(g, set);
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, last: u8) {
        let modes = self.param + 1;
        match (self.prefix, self.intermediates, self.intermediate, last) {
            (0, 0, _, b's') => self.save(),
            (0, 0, _, b'u') => self.restore(),
            (0, 1, b'!', b'p') => {
                self.g = [Set::Us; 4];
                self.shift(0);
                self.saved[usize::from(self.alternate)] = Set::Us;
            }
            (b'?', 0, _, b'h') => {
                for index in 0..modes {
                    let mode = self.params[index];
                    match mode {
                        2 => (0..4).for_each(|g| self.designate(g, Set::Us)),
                        47 | 1047 => self.alternate = true,
                        1048 => self.save(),
                        1049 => {
                            self.save();
                            self.alternate = true;
                        }
                        _ => {}
                    }
                }
            }
            (b'?', 0, _, b'l') => {
                for index in 0..modes {
                    let mode = self.params[index];
                    match mode {
                        47 | 1047 => self.alternate = false,
                        1048 => self.restore(),
                        1049 => {
                            self.alternate = false;
                            self.restore();
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn designate(&mut self, g: usize, set: Set) {
        self.g[g] = set;
        if self.glevel == g {
            self.active = set;
        }
    }

    fn shift(&mut self, g: usize) {
        self.glevel = g;
        self.active = self.g[g];
    }

    fn save(&mut self) {
        self.saved[usize::from(self.alternate)] = self.active;
    }

    fn restore(&mut self) {
        self.active = self.saved[usize::from(self.alternate)];
    }
}

/// The length of the run at the start of `bytes` that xterm, in ground,
/// prints or executes without changing a set: ASCII but ESC, SO and SI, and
/// whole UTF-8 characters from U+00A0 (below it, U+0080 to U+009F are C1
/// controls, which the table must see). Malformed UTF-8 ends the run and
/// goes through the decoder.
fn ground_run(bytes: &[u8]) -> usize {
    let mut at = 0;
    loop {
        // ASCII first, in one scan.
        at += bytes[at..]
            .iter()
            .position(|&b| b >= 0x80 || b == ESC || b == SO || b == SI)
            .unwrap_or(bytes.len() - at);
        let Some(&lead) = bytes.get(at) else {
            return at;
        };
        let width = match lead {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return at,
        };
        match bytes.get(at..at + width).map(std::str::from_utf8) {
            Some(Ok(text)) if text >= "\u{a0}" => at += width,
            _ => return at,
        }
    }
}

/// The character DEC Special Graphics draws for `byte`, if it maps it.
fn dec_char(byte: u8) -> Option<&'static str> {
    (0x60..=0x7E)
        .contains(&byte)
        .then(|| DEC_SPECIAL_GRAPHICS[usize::from(byte - 0x60)])
}

/// The translated copy of `data`, begun with its first `at` bytes, with room
/// for the rest to grow.
fn copy_of(data: &[u8], at: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 2);
    out.extend_from_slice(&data[..at]);
    out
}

/// `value` with the decimal digit `digit` appended, saturating as xterm's
/// parameters do.
fn add_digit(value: u32, digit: u8) -> u32 {
    value
        .saturating_mul(10)
        .saturating_add(u32::from(digit - b'0'))
        .min(MAX_PARAM)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A C1 code point acts as xterm's: U+009B starts a CSI whose final `m`
    /// is not printed, so only the `q` after it is translated. vt100, which
    /// executes U+009B, would print `31m`, so this reads the tracker's copy.
    #[test]
    fn a_c1_csi_is_a_csi() {
        let mut charsets = Charsets::default();
        assert_eq!(
            &*charsets.translate(b"\x1b(0\xc2\x9b31mq"),
            "\x1b(0\u{9b}31m\u{2500}".as_bytes()
        );
    }

    /// Nothing translated: the read itself, not a copy.
    #[test]
    fn a_read_with_nothing_to_translate_is_not_copied() {
        let mut charsets = Charsets::default();
        assert!(matches!(
            charsets.translate(b"\x1b[31mtext"),
            Cow::Borrowed(_)
        ));
    }
}
