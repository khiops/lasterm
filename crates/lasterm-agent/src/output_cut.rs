//! Where a terminal's output may be cut (#954).
//!
//! A pane that attaches is reset, draws the agent's snapshot and then writes
//! the output that follows it. The snapshot carries no parser state, so a
//! snapshot taken while an escape sequence or a UTF-8 character is half read
//! would leave the rest of it to be drawn as text, and its effect lost. The
//! reader therefore hands the mirror and the hub only output that ends where
//! the pane's terminal, xterm 6.0.0, has its parser in ground and no partial
//! character in its decoder, and holds the rest until a later read ends it;
//! except a sequence held past `HOLD_LIMIT`, and what is held when the PTY
//! closes, which go out cut.
//!
//! The rules below follow xterm 6.0.0's `Utf8ToUtf32` decoding loop
//! (`src/common/input/TextDecoder.ts`) and its `VT500_TRANSITION_TABLE`
//! (`src/common/parser/EscapeSequenceParser.ts`). A bump of `@xterm/xterm`
//! must be checked against them.

/// The most output held back for an unfinished sequence. Past it, the held
/// bytes are sent cut, as before #954: an unterminated sequence never holds
/// more than this.
pub(crate) const HOLD_LIMIT: usize = 64 * 1024;

/// A device status report query. ConPTY sends one at start; xterm.js would
/// answer it, and the answer would reach the program as typed input.
const DSR: &[u8] = b"\x1b[6n";

/// The output of one terminal, between its PTY and its mirror.
#[derive(Default)]
pub(crate) struct OutputCut {
    /// How many bytes of a DSR the stream ended on, not yet passed on.
    dsr: usize,
    /// Output passed through DSR stripping and not yet returned: everything
    /// after the last cut point.
    held: Vec<u8>,
    track: Tracker,
}

impl OutputCut {
    /// The output that `read` completes: what was held and the read's bytes,
    /// DSRs stripped, up to the stream's last cut point. The rest is held.
    pub(crate) fn take(&mut self, read: &[u8]) -> Vec<u8> {
        let start = self.held.len();
        self.strip_into(read);
        let cut = self.track.scan(&self.held[start..]).map(|at| start + at);
        let mut out = match cut {
            Some(at) => {
                let rest = self.held.split_off(at);
                std::mem::replace(&mut self.held, rest)
            }
            None => Vec::new(),
        };
        if self.held.len() + self.dsr > HOLD_LIMIT {
            // Sent cut. A DSR's possible start stays with the stripping, which
            // goes on: the next read may complete it.
            out.append(&mut self.held);
        }
        out
    }

    /// Everything held, cut or not: the terminal's output has ended.
    pub(crate) fn finish(&mut self) -> Vec<u8> {
        let prefix = std::mem::take(&mut self.dsr);
        self.held.extend_from_slice(&DSR[..prefix]);
        self.track.scan(&DSR[..prefix]);
        std::mem::take(&mut self.held)
    }

    /// Append `read` to the held bytes without the DSRs it holds, keeping a
    /// DSR's start at its end for the next read.
    fn strip_into(&mut self, mut read: &[u8]) {
        if self.dsr == 0 && !may_hold_dsr(read) {
            self.held.extend_from_slice(read);
            return;
        }
        while let Some((&byte, rest)) = read.split_first() {
            if self.dsr == 0 && byte != DSR[0] {
                // Up to the next ESC, nothing can start a DSR.
                let run = read.iter().position(|&b| b == DSR[0]).unwrap_or(read.len());
                self.held.extend_from_slice(&read[..run]);
                read = &read[run..];
                continue;
            }
            read = rest;
            if byte == DSR[self.dsr] {
                self.dsr += 1;
                if self.dsr == DSR.len() {
                    self.dsr = 0;
                }
                continue;
            }
            self.held.extend_from_slice(&DSR[..self.dsr]);
            if byte == DSR[0] {
                self.dsr = 1;
            } else {
                self.dsr = 0;
                self.held.push(byte);
            }
        }
    }
}

/// The length of the CSI `bytes` starts with when it is whole and holds only
/// parameter bytes (0x30-0x3F) between `ESC [` and its final byte
/// (0x40-0x7E). From ground, xterm's table goes through CSI entry, param or
/// ignore and back to ground on such a sequence.
fn csi_end(bytes: &[u8]) -> Option<usize> {
    let rest = bytes.strip_prefix(b"\x1b[")?;
    let params = rest
        .iter()
        .take_while(|&&b| (0x30..=0x3F).contains(&b))
        .count();
    let last = *rest.get(params)?;
    (0x40..=0x7E).contains(&last).then_some(params + 3)
}

/// Whether `read` holds a DSR, or ends with the start of one.
fn may_hold_dsr(read: &[u8]) -> bool {
    let mut from = 0;
    while let Some(at) = read[from..].iter().position(|&b| b == DSR[0]) {
        let rest = &read[from + at..];
        if rest.starts_with(DSR) || DSR.starts_with(rest) {
            return true;
        }
        from += at + 1;
    }
    false
}

/// xterm's parser states (`ParserState`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
enum State {
    #[default]
    Ground,
    Escape,
    EscapeIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    SosPmApcString,
    OscString,
    DcsEntry,
    DcsParam,
    DcsIntermediate,
    DcsIgnore,
    DcsPassthrough,
}

/// xterm's decoder and parser state, as far as they decide a cut point.
#[derive(Default)]
struct Tracker {
    state: State,
    /// The partial character's length in bytes, 0 when there is none.
    length: u8,
    /// How many of its bytes were seen.
    seen: u8,
    /// Its code point so far.
    code: u32,
}

impl Tracker {
    /// The position after the last byte of `bytes` the stream may be cut
    /// after, if any.
    fn scan(&mut self, bytes: &[u8]) -> Option<usize> {
        let mut cut = None;
        let mut state = self.state;
        let mut at = 0;
        while at < bytes.len() {
            let byte = bytes[at];
            if self.length == 0 && byte < 0x80 {
                if state == State::Ground && byte != 0x1B {
                    // In ground, ASCII but ESC leaves it in ground.
                    let run = bytes[at..]
                        .iter()
                        .position(|&b| b == 0x1B || b >= 0x80)
                        .unwrap_or(bytes.len() - at);
                    at += run;
                    cut = Some(at);
                    continue;
                }
                if let Some(end) = (state == State::Ground)
                    .then(|| csi_end(&bytes[at..]))
                    .flatten()
                {
                    // A whole CSI from ground: ESC `[`, parameters, a final
                    // byte, which `next` takes back to ground.
                    at += end;
                    cut = Some(at);
                    continue;
                }
                // ASCII outside a character: a code point of its own.
                state = TABLE[state as usize][usize::from(byte)];
            } else if let Some(code) = self.decode(byte) {
                state = step(state, code);
            }
            at += 1;
            if self.idle_at(state) {
                cut = Some(at);
            }
        }
        self.state = state;
        cut
    }

    /// In `state`, ground, with no partial character.
    fn idle_at(&self, state: State) -> bool {
        state == State::Ground && self.length == 0
    }

    /// The code point `byte` completes, if any.
    fn decode(&mut self, byte: u8) -> Option<u32> {
        if self.length != 0 {
            if byte & 0xC0 != 0x80 {
                // A wrong continuation: the partial character is dropped and
                // the byte read afresh.
                self.length = 0;
                return self.decode(byte);
            }
            self.code = self.code << 6 | u32::from(byte & 0x3F);
            self.seen += 1;
            if self.seen < self.length {
                return None;
            }
            let (length, code) = (self.length, self.code);
            self.length = 0;
            let legal = match length {
                // An overlong two-byte form: xterm reads its second byte
                // afresh, and a continuation byte read afresh yields nothing.
                2 => code >= 0x80,
                3 => code >= 0x800 && !(0xD800..=0xDFFF).contains(&code) && code != 0xFEFF,
                _ => (0x1_0000..=0x10_FFFF).contains(&code),
            };
            return legal.then_some(code);
        }
        if byte < 0x80 {
            return Some(u32::from(byte));
        }
        let (length, bits) = if byte & 0xE0 == 0xC0 {
            (2, 0x1F)
        } else if byte & 0xF0 == 0xE0 {
            (3, 0x0F)
        } else if byte & 0xF8 == 0xF0 {
            (4, 0x07)
        } else {
            (0, 0)
        };
        if length != 0 {
            self.length = length;
            self.seen = 1;
            self.code = u32::from(byte & bits);
            None
        } else {
            // A lone continuation byte, or F8-FF.
            None
        }
    }
}

/// Every state, in `State`'s order.
const STATES: [State; 14] = [
    State::Ground,
    State::Escape,
    State::EscapeIntermediate,
    State::CsiEntry,
    State::CsiParam,
    State::CsiIntermediate,
    State::CsiIgnore,
    State::SosPmApcString,
    State::OscString,
    State::DcsEntry,
    State::DcsParam,
    State::DcsIntermediate,
    State::DcsIgnore,
    State::DcsPassthrough,
];

/// `next` for every state and every code up to 0xA0, which stands for all
/// the code points from it on, as xterm's table has it.
const TABLE: [[State; 0xA1]; 14] = {
    let mut table = [[State::Ground; 0xA1]; 14];
    let mut state = 0;
    while state < STATES.len() {
        let mut code = 0;
        while code <= 0xA0 {
            table[state][code] = next(STATES[state], code as u32);
            code += 1;
        }
        state += 1;
    }
    table
};

/// The state `state` moves to on `code`, from `TABLE`.
fn step(state: State, code: u32) -> State {
    TABLE[state as usize][code.min(0xA0) as usize]
}

/// The state xterm's `VT500_TRANSITION_TABLE` moves to from `state` on
/// `code`; an ERROR goes to ground.
const fn next(state: State, code: u32) -> State {
    use State::*;
    // Rules for every state.
    match code {
        0x18 | 0x1A | 0x80..=0x8F | 0x91..=0x97 | 0x99 | 0x9A | 0x9C => return Ground,
        0x1B => return Escape,
        0x90 => return DcsEntry,
        0x98 | 0x9E | 0x9F => return SosPmApcString,
        0x9B => return CsiEntry,
        0x9D => return OscString,
        _ => {}
    }
    if code >= 0xA0 {
        return match state {
            OscString | CsiIgnore | DcsIgnore | DcsPassthrough => state,
            _ => Ground,
        };
    }
    // C0 controls but CAN, SUB and ESC: executed or ignored in place.
    let executable = matches!(code, 0x00..=0x17 | 0x19 | 0x1C..=0x1F);
    match state {
        Ground => Ground,
        Escape => match code {
            _ if executable => Escape,
            0x7F => Escape,
            0x20..=0x2F => EscapeIntermediate,
            0x5B => CsiEntry,
            0x5D => OscString,
            0x50 => DcsEntry,
            0x58 | 0x5E | 0x5F => SosPmApcString,
            _ => Ground,
        },
        EscapeIntermediate => match code {
            _ if executable => state,
            0x20..=0x2F | 0x7F => state,
            _ => Ground,
        },
        CsiEntry => match code {
            _ if executable => state,
            0x7F => state,
            0x20..=0x2F => CsiIntermediate,
            0x30..=0x3F => CsiParam,
            _ => Ground,
        },
        CsiParam => match code {
            _ if executable => state,
            0x7F | 0x30..=0x3B => state,
            0x3C..=0x3F => CsiIgnore,
            0x20..=0x2F => CsiIntermediate,
            _ => Ground,
        },
        CsiIntermediate => match code {
            _ if executable => state,
            0x7F | 0x20..=0x2F => state,
            0x30..=0x3F => CsiIgnore,
            _ => Ground,
        },
        CsiIgnore => match code {
            0x40..=0x7E => Ground,
            _ => state,
        },
        OscString => match code {
            0x07 => Ground,
            _ => state,
        },
        SosPmApcString | DcsIgnore | DcsPassthrough => state,
        DcsEntry => match code {
            0x20..=0x2F => DcsIntermediate,
            0x30..=0x3F => DcsParam,
            0x40..=0x7E => DcsPassthrough,
            _ => state,
        },
        DcsParam => match code {
            0x20..=0x2F => DcsIntermediate,
            0x3C..=0x3F => DcsIgnore,
            0x40..=0x7E => DcsPassthrough,
            _ => state,
        },
        DcsIntermediate => match code {
            0x30..=0x3F => DcsIgnore,
            0x40..=0x7E => DcsPassthrough,
            _ => state,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each read's return, through one `OutputCut`.
    fn takes(reads: &[&[u8]]) -> Vec<Vec<u8>> {
        let mut cut = OutputCut::default();
        reads.iter().map(|read| cut.take(read)).collect()
    }

    fn bytes(list: &[&[u8]]) -> Vec<Vec<u8>> {
        list.iter().map(|b| b.to_vec()).collect()
    }

    #[test]
    fn a_csi_cut_by_a_read_is_sent_whole() {
        // AC1
        assert_eq!(
            takes(&[b"$ \x1b[?200", b"4hX"]),
            bytes(&[b"$ ", b"\x1b[?2004hX"])
        );
        // AC9: the bytes before the sequence go at once; a read ending in
        // ground goes whole.
        assert_eq!(takes(&[b"abc\x1b[3"]), bytes(&[b"abc"]));
        assert_eq!(takes(&[b"x\x1b[1mY"]), bytes(&[b"x\x1b[1mY"]));
    }

    #[test]
    fn an_osc_is_held_until_its_terminator() {
        // AC2
        assert_eq!(
            takes(&[b"a\x1b]0;ti", b"tle\x07b"]),
            bytes(&[b"a", b"\x1b]0;title\x07b"])
        );
        assert_eq!(
            takes(&[b"\x1b]0;t\x1b", b"\\c"]),
            bytes(&[b"", b"\x1b]0;t\x1b\\c"])
        );
        // The ESC that ends an OSC starts an escape sequence: a read ending
        // in that one is held too. (A read ending at the ESC itself is held
        // anyway, as a DSR's possible start.)
        assert_eq!(
            takes(&[b"\x1b]0;t\x1b(", b"0"]),
            bytes(&[b"", b"\x1b]0;t\x1b(0"])
        );
    }

    #[test]
    fn dcs_and_apc_are_held_until_their_end() {
        // AC3
        assert_eq!(
            takes(&[b"\x1bP1$r", b"0m\x1b\\d"]),
            bytes(&[b"", b"\x1bP1$r0m\x1b\\d"])
        );
        assert_eq!(
            takes(&[b"\x1b_x", b"y\x1b\\e"]),
            bytes(&[b"", b"\x1b_xy\x1b\\e"])
        );
        // `C3 9C` is `Ü` to xterm, which keeps it in the DCS; vte would end
        // the DCS at the raw 9C.
        assert_eq!(
            takes(&[b"\x1bPq\xc3\x9c", b"HELLO\x1b\\X"]),
            bytes(&[b"", b"\x1bPq\xc3\x9cHELLO\x1b\\X"])
        );
    }

    #[test]
    fn a_partial_character_is_held() {
        // AC4
        assert_eq!(
            takes(&[b"$ \xe2\x94", b"\x80X"]),
            bytes(&[b"$ ", b"\xe2\x94\x80X"])
        );
        assert_eq!(
            takes(&[b"\xf0\x9f", b"\x98", b"\x80"]),
            bytes(&[b"", b"", b"\xf0\x9f\x98\x80"])
        );
        // RT1 / invalid-utf8: nothing is held after a wrong continuation, a
        // lone continuation byte or F8-FF.
        assert_eq!(takes(&[b"\xe2A"]), bytes(&[b"\xe2A"]));
        assert_eq!(takes(&[b"\x80"]), bytes(&[b"\x80"]));
        assert_eq!(takes(&[b"\xff"]), bytes(&[b"\xff"]));
    }

    #[test]
    fn the_decoder_follows_xterm() {
        // RT1 / decoder: a lone lead byte is held.
        assert_eq!(takes(&[b"\xc3", b"\xa9X"]), bytes(&[b"", b"\xc3\xa9X"]));
        // Inside a CSI, a code point xterm yields would end it (ERROR); one
        // it drops leaves it open.
        for dropped in [
            &b"\xef\xbb\xbf"[..],
            b"\xed\xa0\x80",
            b"\xe0\x80\x80",
            b"\xf4\x90\x80\x80",
            b"\xc0\x80",
            // Overlong forms of `A`, which would end the CSI if yielded.
            b"\xc1\x81",
            b"\xe0\x81\x81",
            b"\xf0\x80\x81\x81",
        ] {
            let first = [&b"\x1b[3"[..], dropped].concat();
            let whole = [&first[..], b"1m"].concat();
            assert_eq!(
                takes(&[&first, b"1m"]),
                vec![Vec::new(), whole],
                "{dropped:x?}"
            );
        }
    }

    #[test]
    fn an_escape_and_its_intermediates_are_held() {
        // AC5
        assert_eq!(
            takes(&[b"a\x1b", b"(", b"0q"]),
            bytes(&[b"a", b"", b"\x1b(0q"])
        );
    }

    #[test]
    fn can_and_sub_end_a_held_sequence() {
        // AC6
        for end in [&b"\x18"[..], b"\x1a"] {
            let whole = [&b"\x1b[3"[..], end].concat();
            assert_eq!(takes(&[b"\x1b[3", end]), vec![Vec::new(), whole]);
        }
    }

    #[test]
    fn a_control_inside_a_sequence_does_not_end_it() {
        // AC7
        assert_eq!(takes(&[b"\x1b[3\n", b"1m"]), bytes(&[b"", b"\x1b[3\n1m"]));
    }

    #[test]
    fn a_fragment_over_the_limit_is_sent() {
        // AC8, RT2
        let mut cut = OutputCut::default();
        let start = b"\x1b]52;c;";
        assert!(cut.take(start).is_empty());
        let read = [b'A'; 4096];
        let mut held = start.len();
        let mut sent = Vec::new();
        for _ in 0..32 {
            sent = cut.take(&read);
            held += read.len();
            if !sent.is_empty() {
                break;
            }
            assert!(held <= HOLD_LIMIT, "held {held} bytes");
        }
        assert!(held > HOLD_LIMIT);
        assert_eq!(sent.len(), held);
        assert_eq!(&sent[..start.len()], start);
        // The OSC goes on after the forced return.
        assert!(cut.take(b"x").is_empty());
        assert_eq!(cut.take(b"\x07z"), b"x\x07z");

        // A DSR split at the forced return is still stripped.
        let mut cut = OutputCut::default();
        let mut sent = cut.take(b"\x1b]0;");
        for _ in 0..15 {
            sent.extend(cut.take(&read));
        }
        let last = [&[b'A'; 4092][..], b"\x1b[6"].concat();
        sent.extend(cut.take(&last));
        assert_eq!(sent.len(), 4 + 15 * 4096 + 4092, "held, then sent cut");
        assert_eq!(cut.take(b"n\x07"), b"\x07");
    }

    #[test]
    fn finish_returns_what_is_held() {
        // AC10
        let mut cut = OutputCut::default();
        assert!(cut.take(b"\x1b[3").is_empty());
        assert_eq!(cut.finish(), b"\x1b[3");
        assert!(cut.finish().is_empty());
        // A DSR's possible start, held by its stripping, goes too.
        for start in [&b"\x1b"[..], b"\x1b[", b"\x1b[6"] {
            let mut cut = OutputCut::default();
            let read = [&b"a"[..], start].concat();
            assert_eq!(cut.take(&read), b"a");
            assert_eq!(cut.finish(), start);
            assert!(cut.finish().is_empty());
        }
    }

    #[test]
    fn dsrs_are_stripped_across_reads() {
        // AC11
        assert_eq!(takes(&[b"A\x1b[6", b"nOK"]), bytes(&[b"A", b"OK"]));
        assert_eq!(
            takes(&[b"$ \x1b\x1b[6n", b"[31mX"]),
            bytes(&[b"$ ", b"\x1b[31mX"])
        );
        assert_eq!(takes(&[b"a\x1b[6nb"]), bytes(&[b"ab"]));
    }

    #[test]
    fn a_read_ending_in_each_parser_state_is_held() {
        // AC13: (first read, second read, the second's return).
        let rows: &[(&[u8], &[u8], &[u8])] = &[
            (b"\x1b", b"7", b"\x1b7"),
            (b"\x1b(", b"0", b"\x1b(0"),
            (b"\x1b[", b"m", b"\x1b[m"),
            (b"\x1b[1;", b"2H", b"\x1b[1;2H"),
            (b"\x1b[1 ", b"q", b"\x1b[1 q"),
            (b"\x1b[1<", b"m", b"\x1b[1<m"),
            (b"\x1b]0", b";t\x07", b"\x1b]0;t\x07"),
            (b"\x1bP", b"q\x1b\\", b"\x1bPq\x1b\\"),
            (b"\x1bP1", b"q\x1b\\", b"\x1bP1q\x1b\\"),
            (b"\x1bP$", b"q\x1b\\", b"\x1bP$q\x1b\\"),
            (b"\x1bPqx", b"\x1b\\", b"\x1bPqx\x1b\\"),
            (b"\x1bX", b"s\x1b\\", b"\x1bXs\x1b\\"),
            (b"\x1b^", b"p\x1b\\", b"\x1b^p\x1b\\"),
            (b"\x1b_", b"a\x1b\\", b"\x1b_a\x1b\\"),
            (b"\xc2\x9b1", b"m", b"\xc2\x9b1m"),
        ];
        for (first, second, sent) in rows {
            assert_eq!(
                takes(&[first, second]),
                vec![Vec::new(), sent.to_vec()],
                "{first:x?}"
            );
        }
        // DCS ignore ends only at ESC, CAN or SUB, not at a final byte.
        assert_eq!(
            takes(&[b"\x1bP1<", b"m", b"\x1b\\"]),
            bytes(&[b"", b"", b"\x1bP1<m\x1b\\"])
        );
        // A non-ASCII code point ends a CSI or an APC (ERROR).
        assert_eq!(takes(&[b"\x1b[3\xc3\xa9"]), bytes(&[b"\x1b[3\xc3\xa9"]));
        assert_eq!(takes(&[b"\x1b_\xc3\xa9"]), bytes(&[b"\x1b_\xc3\xa9"]));
    }

    #[test]
    fn an_attach_between_two_reads_of_a_sequence_draws_it_whole() {
        // AC12
        use crate::headless::HeadlessMirror;
        let mut cut = OutputCut::default();
        let mut mirror = HeadlessMirror::new(20, 5, 100);
        mirror.process(&cut.take(b"$ \x1b[?200"));
        let snapshot = mirror.snapshot();
        let tail = cut.take(b"4hX");
        mirror.process(&tail);

        let mut pane = vt100::Parser::new(
            std::num::NonZeroU16::new(5).unwrap(),
            std::num::NonZeroU16::new(20).unwrap(),
            0,
        );
        pane.process(b"\x1bc");
        pane.process(snapshot.serialized.as_bytes());
        pane.process(snapshot.input_modes.as_bytes());
        pane.process(&tail);
        let row = |screen: &vt100::Screen| screen.contents().lines().next().map(str::to_owned);
        assert_eq!(row(pane.screen()).as_deref(), Some("$ X"));
        assert!(pane.screen().bracketed_paste());
        assert!(mirror.input_modes().bracketed_paste);
    }
}
