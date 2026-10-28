//! What a hub's terminals print while that hub has no connection (#553).
//!
//! A daemon keeps running a hub's terminals while the hub is away, and keeps
//! their output for its next connection, up to a bound in bytes per terminal
//! and another per hub. Past those bounds the oldest output goes: a terminal's
//! own beyond `AWAY_BYTES_PER_CHANNEL`, then, while the hub's terminals
//! together hold more than `AWAY_BYTES_PER_HUB`, that of whichever holds the
//! most. One busy terminal therefore never pushes out another's output: it
//! loses its own first. A terminal's newest frame is never dropped, so neither
//! is its CHANNEL_EXIT, the last frame it sends.
//!
//! What is dropped never reaches the hub, its spool or a client's scrollback.
//! The screen itself comes back with the snapshot of the next ATTACH: the
//! agent's screen model has read everything the terminal printed, dropped or
//! not. What is lost is the output in between, scrolled past.
//!
//! The bounds are constants. The `--buffer-per-channel` and `--buffer-global`
//! flags, which hubs from before still pass with values sized for the Node
//! agent, stay ignored: reading them would change these bounds on such a hub.

use std::collections::{HashMap, VecDeque};

/// What one terminal keeps while its hub is away: its newest 1 MiB, some
/// 10,000 lines of 100 columns, beyond what its screen shows.
pub(crate) const AWAY_BYTES_PER_CHANNEL: usize = 1024 * 1024;

/// What all of a hub's terminals keep together while it is away: sixteen
/// terminals at their full bound.
pub(crate) const AWAY_BYTES_PER_HUB: usize = 16 * 1024 * 1024;

/// One terminal's frames, oldest first, each with its rank among all the
/// hub's frames.
#[derive(Default)]
struct ChannelBacklog {
    frames: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
}

impl ChannelBacklog {
    /// Drop the oldest frame, unless it is the newest: a terminal always keeps
    /// its last word. Returns the bytes dropped.
    fn drop_oldest(&mut self) -> usize {
        if self.frames.len() <= 1 {
            return 0;
        }
        let (_, frame) = self.frames.pop_front().expect("more than one frame");
        self.bytes -= frame.len();
        frame.len()
    }
}

/// One hub's queue while it has no connection.
#[derive(Default)]
pub(crate) struct AwayQueue {
    channels: HashMap<String, ChannelBacklog>,
    /// Bytes held across all the hub's terminals.
    bytes: usize,
    /// The rank the next frame takes: the order frames go out in.
    next: u64,
    /// Bytes dropped since the hub left, for the log.
    dropped: usize,
}

impl AwayQueue {
    /// Keep a frame of `channel_id`, dropping the oldest output beyond the
    /// bounds.
    pub(crate) fn push(&mut self, channel_id: &str, frame: Vec<u8>) {
        let rank = self.next;
        self.next += 1;
        let len = frame.len();
        let backlog = self.channels.entry(channel_id.to_owned()).or_default();
        backlog.frames.push_back((rank, frame));
        backlog.bytes += len;
        self.bytes += len;

        while backlog.bytes > AWAY_BYTES_PER_CHANNEL {
            let dropped = backlog.drop_oldest();
            if dropped == 0 {
                break;
            }
            self.bytes -= dropped;
            self.dropped += dropped;
        }

        while self.bytes > AWAY_BYTES_PER_HUB {
            let Some(largest) = self
                .channels
                .values_mut()
                .filter(|backlog| backlog.frames.len() > 1)
                .max_by_key(|backlog| backlog.bytes)
            else {
                break;
            };
            let dropped = largest.drop_oldest();
            self.bytes -= dropped;
            self.dropped += dropped;
        }
    }

    /// The frames kept, in the order they were pushed, and the bytes dropped.
    pub(crate) fn drain(self) -> (Vec<Vec<u8>>, usize) {
        let mut ranked: Vec<(u64, Vec<u8>)> = self
            .channels
            .into_values()
            .flat_map(|backlog| backlog.frames)
            .collect();
        ranked.sort_unstable_by_key(|(rank, _)| *rank);
        (
            ranked.into_iter().map(|(_, frame)| frame).collect(),
            self.dropped,
        )
    }
}
