//! This build's channel (#1084): `release` for what the release workflow
//! builds, `dev` for every other build. A development build then uses its own
//! directories, lock, pipes and app identity, so it runs beside the Store
//! install on one account.
//!
//! build.rs compiles the channel in as `LASTERM_BUILD_CHANNEL`. The marker
//! `lasterm-build-channel:<channel>` is what pack-msix.ps1 searches the
//! executable for; the channel is read from it at run time, so the linker keeps
//! it in the binary.

const CHANNEL_MARKER: &str = concat!("lasterm-build-channel:", env!("LASTERM_BUILD_CHANNEL"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Channel {
    Release,
    Dev,
}

impl Channel {
    /// The name every channel-specific directory, pipe and lock is built from.
    pub(crate) fn base_name(self) -> &'static str {
        match self {
            Channel::Release => "lasterm",
            Channel::Dev => "lasterm-dev",
        }
    }

    /// What the window, the tray and the dialogs call the app.
    pub(crate) fn product_name(self) -> &'static str {
        match self {
            Channel::Release => "Lasterm",
            Channel::Dev => "Lasterm Dev",
        }
    }

    /// The value `lasterm-hub start --channel` takes.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Channel::Release => "release",
            Channel::Dev => "dev",
        }
    }
}

/// The channel this executable was built for, read from its marker.
pub(crate) fn build_channel() -> Channel {
    // black_box: the marker is read, not folded away, so it stays in the binary.
    // Its end is compared, with no prefix literal of its own: the linker lays
    // literals side by side, and a prefix placed before "release" would read as
    // the release marker in a dev build.
    if std::hint::black_box(CHANNEL_MARKER).ends_with(":release") {
        Channel::Release
    } else {
        Channel::Dev
    }
}

/// This build's base name: `lasterm` or `lasterm-dev`.
pub(crate) fn base_name() -> &'static str {
    build_channel().base_name()
}

/// This build's product name: `Lasterm` or `Lasterm Dev`.
pub(crate) fn product_name() -> &'static str {
    build_channel().product_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_channel() {
        assert_eq!(Channel::Release.base_name(), "lasterm");
        assert_eq!(Channel::Dev.base_name(), "lasterm-dev");
        assert_eq!(Channel::Release.product_name(), "Lasterm");
        assert_eq!(Channel::Dev.product_name(), "Lasterm Dev");
        assert_eq!(Channel::Release.as_str(), "release");
        assert_eq!(Channel::Dev.as_str(), "dev");
    }

    // The tests are built like any build: from LASTERM_CHANNEL.
    #[test]
    fn the_build_channel_is_the_one_compiled_in() {
        let expected = if env!("LASTERM_BUILD_CHANNEL") == "release" {
            Channel::Release
        } else {
            Channel::Dev
        };
        assert_eq!(build_channel(), expected);
    }
}
