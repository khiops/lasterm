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

/// lasterm's own directory for `kind`, from this process's environment.
pub(crate) fn lasterm_dir(kind: DirKind) -> io::Result<PathBuf> {
    lasterm_dir_in(kind, cfg!(windows), |name| std::env::var_os(name))
}

/// The rule itself, with the platform and the environment passed in, so that
/// both platforms' behaviour is exercised on either.
fn lasterm_dir_in(
    kind: DirKind,
    windows: bool,
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
        return Ok(PathBuf::from(value).join("lasterm"));
    }

    let (name, home_default): (&str, &[&str]) = match kind {
        DirKind::State => ("XDG_STATE_HOME", &[".local", "state"]),
        DirKind::Config => ("XDG_CONFIG_HOME", &[".config"]),
    };
    if let Some(value) = var(name).filter(|value| is_absolute(value, false)) {
        return Ok(PathBuf::from(value).join("lasterm"));
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
    Ok(path.join("lasterm"))
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
            lasterm_dir_in(DirKind::State, true, &vars).unwrap(),
            PathBuf::from(r"C:\Users\jane\AppData\Local").join("lasterm")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, true, &vars).unwrap(),
            PathBuf::from(r"C:\Users\jane\AppData\Roaming").join("lasterm")
        );
    }

    #[test]
    fn windows_refuses_an_absent_empty_or_relative_variable_naming_it() {
        assert!(message(lasterm_dir_in(DirKind::State, true, env(&[])))
            .contains("LOCALAPPDATA is absent or empty"));
        assert!(message(lasterm_dir_in(
            DirKind::State,
            true,
            env(&[("LOCALAPPDATA", "")])
        ))
        .contains("LOCALAPPDATA is absent or empty"));
        assert!(message(lasterm_dir_in(
            DirKind::State,
            true,
            env(&[("LOCALAPPDATA", r"AppData\Local")])
        ))
        .contains(r"LOCALAPPDATA is not an absolute path (AppData\Local)"));
    }

    #[test]
    fn windows_configuration_does_not_fall_back_to_localappdata() {
        // The previous rule read LOCALAPPDATA when APPDATA was unset, a
        // directory the hub would never have written auth.json to.
        let vars = env(&[("LOCALAPPDATA", r"C:\Local")]);
        assert!(message(lasterm_dir_in(DirKind::Config, true, vars))
            .contains("APPDATA is absent or empty"));
    }

    #[test]
    fn elsewhere_uses_an_absolute_xdg_variable() {
        let vars = env(&[
            ("XDG_STATE_HOME", "/xdg/state"),
            ("XDG_CONFIG_HOME", "/xdg/config"),
            ("HOME", "/home/jane"),
        ]);
        assert_eq!(
            lasterm_dir_in(DirKind::State, false, &vars).unwrap(),
            PathBuf::from("/xdg/state").join("lasterm")
        );
        assert_eq!(
            lasterm_dir_in(DirKind::Config, false, &vars).unwrap(),
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
                lasterm_dir_in(DirKind::State, false, &vars).unwrap(),
                PathBuf::from("/home/jane/.local/state/lasterm")
            );
            assert_eq!(
                lasterm_dir_in(DirKind::Config, false, &vars).unwrap(),
                PathBuf::from("/home/jane/.config/lasterm")
            );
        }
    }

    #[test]
    fn elsewhere_refuses_without_an_absolute_home_instead_of_using_tmp() {
        for vars in [env(&[]), env(&[("HOME", "")]), env(&[("HOME", "jane")])] {
            assert!(message(lasterm_dir_in(DirKind::Config, false, vars))
                .contains("XDG_CONFIG_HOME is not an absolute path and neither is HOME"));
        }
    }
}
