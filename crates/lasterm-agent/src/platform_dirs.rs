//! Where the agent finds lasterm's state and configuration.
//!
//! The same rule the hub (`@lasterm/shared/dist/platform-dirs.js`, #297) and
//! the desktop (#241) apply, so the three agree on one directory or refuse:
//!
//! - Windows: `LOCALAPPDATA` (state) or `APPDATA` (configuration) must be an
//!   absolute path; absent, empty or relative, the lookup fails and names the
//!   variable.
//! - Elsewhere: `XDG_STATE_HOME` or `XDG_CONFIG_HOME` when it is an absolute
//!   path; a relative or empty one is ignored, as the XDG Base Directory
//!   specification requires, and `$HOME/.local/state` or `$HOME/.config` is
//!   used, which needs an absolute `HOME`.
//!
//! Nothing is invented (#165). The agent used to fall back to
//! `C:\lasterm-state`, `C:\lasterm-config`, `/tmp` or the working directory.
//! A configuration directory that is not the hub's has no `auth.json` and no
//! `meta.db` beside it, which the daemon reads as a first run and so accepts
//! connections without authentication.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The build channel whose names this agent uses (#1084). A dev hub starts its
/// local daemon with `--channel dev`, so the daemon keeps its records and reads
/// `auth.json` in the dev hub's directories, never the Store build's. Absent,
/// release: the names every earlier hub expects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum Channel {
    Release,
    Dev,
}

impl Channel {
    /// The name every channel-specific directory and pipe is built from.
    pub(crate) fn base_name(self) -> &'static str {
        match self {
            Channel::Release => "lasterm",
            Channel::Dev => "lasterm-dev",
        }
    }
}

static CHANNEL: OnceLock<Channel> = OnceLock::new();

/// Fix this process's channel, once, from its command line, before anything
/// resolves a directory.
pub(crate) fn set_channel(channel: Channel) {
    let _ = CHANNEL.set(channel);
}

/// This process's channel: release unless `set_channel` said otherwise.
pub(crate) fn channel() -> Channel {
    CHANNEL.get().copied().unwrap_or(Channel::Release)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DirKind {
    State,
    Config,
}

impl DirKind {
    fn label(self) -> &'static str {
        match self {
            DirKind::State => "state",
            DirKind::Config => "configuration",
        }
    }
}

/// The agent's default Windows pipe on `channel`: `\\.\pipe\<base>-agent-<user>`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn default_pipe_name(channel: Channel, username: &str) -> String {
    format!(r"\\.\pipe\{}-agent-{username}", channel.base_name())
}

/// lasterm's own directory for `kind`, from this process's environment and
/// channel.
pub(crate) fn lasterm_dir(kind: DirKind) -> io::Result<PathBuf> {
    lasterm_dir_for(kind, channel())
}

/// lasterm's own directory for `kind` on `channel`, from this process's
/// environment.
pub(crate) fn lasterm_dir_for(kind: DirKind, channel: Channel) -> io::Result<PathBuf> {
    lasterm_dir_in(kind, cfg!(windows), channel.base_name(), |name| {
        std::env::var_os(name)
    })
}

/// The rule itself, with the platform and the environment passed in, so that
/// both platforms' behaviour is exercised on either.
fn lasterm_dir_in(
    kind: DirKind,
    windows: bool,
    base: &str,
    var: impl Fn(&str) -> Option<OsString>,
) -> io::Result<PathBuf> {
    if windows {
        let name = match kind {
            DirKind::State => "LOCALAPPDATA",
            DirKind::Config => "APPDATA",
        };
        let value = var(name).filter(|value| !value.is_empty()).ok_or_else(|| {
            unresolved(format!(
                "{name} is absent or empty, so the lasterm {} directory cannot be located",
                kind.label()
            ))
        })?;
        if !is_absolute(&value, true) {
            return Err(unresolved(format!(
                "{name} is not an absolute path ({}), so the lasterm {} directory cannot be located",
                value.to_string_lossy(),
                kind.label()
            )));
        }
        return Ok(PathBuf::from(value).join(base));
    }

    let (name, home_default): (&str, &[&str]) = match kind {
        DirKind::State => ("XDG_STATE_HOME", &[".local", "state"]),
        DirKind::Config => ("XDG_CONFIG_HOME", &[".config"]),
    };
    if let Some(value) = var(name).filter(|value| is_absolute(value, false)) {
        return Ok(PathBuf::from(value).join(base));
    }
    let home = var("HOME")
        .filter(|home| is_absolute(home, false))
        .ok_or_else(|| {
            unresolved(format!(
                "the lasterm {} directory cannot be located: {name} is not an absolute path and neither is HOME",
                kind.label()
            ))
        })?;
    let mut path = PathBuf::from(home);
    path.extend(home_default);
    Ok(path.join(base))
}

/// Absoluteness by the rules of the platform being resolved for, not the one
/// compiling this: a drive letter and separator, or a UNC prefix, on Windows;
/// a leading slash elsewhere.
fn is_absolute(value: &OsString, windows: bool) -> bool {
    let value = value.to_string_lossy();
    if windows {
        let bytes = value.as_bytes();
        let drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/');
        drive || value.starts_with(r"\\")
    } else {
        value.starts_with('/')
    }
}

fn unresolved(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn message(result: io::Result<PathBuf>) -> String {
        result.expect_err("the lookup must refuse").to_string()
    }

    #[test]
    fn windows_uses_localappdata_for_state_and_appdata_for_configuration() {
        let vars = env(&[
            ("LOCALAPPDATA", r"C:\Users\jane\AppData\Local"),
            ("APPDATA", r"C:\Users\jane\AppData\Roaming"),
            ("XDG_STATE_HOME", "/ignored"),
        ]);
        assert_eq!(
            lasterm_dir_in(DirKind::State, true, "lasterm", &vars).unwrap(),
            PathBuf::from(r"C:\Users\jane\AppData\Local").join("lasterm")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, true, "lasterm", &vars).unwrap(),
            PathBuf::from(r"C:\Users\jane\AppData\Roaming").join("lasterm")
        );
    }

    #[test]
    fn windows_refuses_an_absent_empty_or_relative_variable_naming_it() {
        assert!(
            message(lasterm_dir_in(DirKind::State, true, "lasterm", env(&[])))
                .contains("LOCALAPPDATA is absent or empty")
        );
        assert!(message(lasterm_dir_in(
            DirKind::State,
            true,
            "lasterm",
            env(&[("LOCALAPPDATA", "")])
        ))
        .contains("LOCALAPPDATA is absent or empty"));
        assert!(message(lasterm_dir_in(
            DirKind::State,
            true,
            "lasterm",
            env(&[("LOCALAPPDATA", r"AppData\Local")])
        ))
        .contains(r"LOCALAPPDATA is not an absolute path (AppData\Local)"));
    }

    #[test]
    fn windows_configuration_does_not_fall_back_to_localappdata() {
        // The previous rule read LOCALAPPDATA when APPDATA was unset, a
        // directory the hub would never have written auth.json to.
        let vars = env(&[("LOCALAPPDATA", r"C:\Local")]);
        assert!(
            message(lasterm_dir_in(DirKind::Config, true, "lasterm", vars))
                .contains("APPDATA is absent or empty")
        );
    }

    #[test]
    fn elsewhere_uses_an_absolute_xdg_variable() {
        let vars = env(&[
            ("XDG_STATE_HOME", "/xdg/state"),
            ("XDG_CONFIG_HOME", "/xdg/config"),
            ("HOME", "/home/jane"),
        ]);
        assert_eq!(
            lasterm_dir_in(DirKind::State, false, "lasterm", &vars).unwrap(),
            PathBuf::from("/xdg/state").join("lasterm")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, false, "lasterm", &vars).unwrap(),
            PathBuf::from("/xdg/config").join("lasterm")
        );
    }

    #[test]
    fn elsewhere_ignores_a_relative_or_empty_xdg_variable_for_the_home_default() {
        for value in ["relative/state", ""] {
            let vars = env(&[
                ("XDG_STATE_HOME", value),
                ("XDG_CONFIG_HOME", value),
                ("HOME", "/home/jane"),
            ]);
            assert_eq!(
                lasterm_dir_in(DirKind::State, false, "lasterm", &vars).unwrap(),
                PathBuf::from("/home/jane/.local/state/lasterm")
            );
            assert_eq!(
                lasterm_dir_in(DirKind::Config, false, "lasterm", &vars).unwrap(),
                PathBuf::from("/home/jane/.config/lasterm")
            );
        }
    }

    #[test]
    fn elsewhere_refuses_without_an_absolute_home_instead_of_using_tmp() {
        for vars in [env(&[]), env(&[("HOME", "")]), env(&[("HOME", "jane")])] {
            assert!(
                message(lasterm_dir_in(DirKind::Config, false, "lasterm", vars))
                    .contains("XDG_CONFIG_HOME is not an absolute path and neither is HOME")
            );
        }
    }

    // #1084. Mutations: a branch left joining `lasterm` (red on its dev case,
    // the HOME fallback included); the channel ignored by the lookup.
    #[test]
    fn the_dev_channel_names_lasterm_dev_on_every_branch() {
        let windows = env(&[("LOCALAPPDATA", r"C:\Local"), ("APPDATA", r"C:\Roaming")]);
        assert_eq!(
            lasterm_dir_in(DirKind::State, true, "lasterm-dev", &windows).unwrap(),
            PathBuf::from(r"C:\Local").join("lasterm-dev")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, true, "lasterm-dev", &windows).unwrap(),
            PathBuf::from(r"C:\Roaming").join("lasterm-dev")
        );
        let xdg = env(&[
            ("XDG_STATE_HOME", "/xdg/state"),
            ("XDG_CONFIG_HOME", "/xdg/config"),
        ]);
        assert_eq!(
            lasterm_dir_in(DirKind::State, false, "lasterm-dev", &xdg).unwrap(),
            PathBuf::from("/xdg/state").join("lasterm-dev")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, false, "lasterm-dev", &xdg).unwrap(),
            PathBuf::from("/xdg/config").join("lasterm-dev")
        );
        let home = env(&[("HOME", "/home/jane")]);
        assert_eq!(
            lasterm_dir_in(DirKind::State, false, "lasterm-dev", &home).unwrap(),
            PathBuf::from("/home/jane/.local/state/lasterm-dev")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, false, "lasterm-dev", &home).unwrap(),
            PathBuf::from("/home/jane/.config/lasterm-dev")
        );
    }

    // Mutation: the default pipe left spelled `lasterm-agent-` (red on dev).
    #[test]
    fn the_default_pipe_follows_the_channel() {
        assert_eq!(
            default_pipe_name(Channel::Release, "alice"),
            r"\\.\pipe\lasterm-agent-alice"
        );
        assert_eq!(
            default_pipe_name(Channel::Dev, "alice"),
            r"\\.\pipe\lasterm-dev-agent-alice"
        );
    }

    #[test]
    fn the_channel_base_names_are_lasterm_and_lasterm_dev() {
        assert_eq!(Channel::Release.base_name(), "lasterm");
        assert_eq!(Channel::Dev.base_name(), "lasterm-dev");
    }

    // The lookup this process makes follows the channel passed: the
    // configuration directory, which holds the hub's auth.json, included.
    #[test]
    fn lasterm_dir_for_follows_the_channel() {
        for kind in [DirKind::State, DirKind::Config] {
            let release = lasterm_dir_for(kind, Channel::Release).unwrap();
            let dev = lasterm_dir_for(kind, Channel::Dev).unwrap();
            assert_eq!(release.file_name().unwrap(), "lasterm");
            assert_eq!(dev.file_name().unwrap(), "lasterm-dev");
            assert_eq!(release.parent(), dev.parent());
        }
    }
}
