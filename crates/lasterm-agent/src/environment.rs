//! The environment a terminal starts with (#576).
//!
//! The agent builds it whole and spawns the PTY from a cleared environment,
//! in this order:
//!
//! 1. The **base**: in `inherit` mode, the agent's own environment; in
//!    `minimal`, only the variables programs need to run, taken from it. A
//!    value is never invented: a variable the agent does not have is absent.
//! 2. The inherited variables a terminal keeps to itself (`NO_COLOR`,
//!    [`crate::color_veto`]) are dropped.
//! 3. The **identity** variables are set: every terminal emulator says what it
//!    is to its shells, whatever it was started with itself.
//! 4. The profile's removals, then the values the SPAWN carries (the scopes',
//!    the launch profile's and the request's, already merged by the hub).
//! 5. What elevation needs, last.
//!
//! [`base`] is steps 1 to 3, and it is what `ENV_QUERY` answers: the variables
//! a terminal would start with before the profile changes anything.
//!
//! Names compare as the platform compares them: on Windows `Path` and `PATH`
//! are one variable, and the name keeps the casing it first had.
//!
//! Nothing here logs a name or a value: an environment holds secrets often
//! enough (CLAUDE.md, Logging).

use std::collections::{BTreeMap, HashMap};

/// How a platform tells two variable names apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Unix,
    Windows,
}

impl Platform {
    /// The platform this agent runs on.
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }

    /// The key a name is known by: itself on Unix, its upper case on Windows.
    fn key(self, name: &str) -> String {
        match self {
            Platform::Unix => name.to_owned(),
            Platform::Windows => name.to_uppercase(),
        }
    }
}

/// What a terminal's environment starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnvMode {
    /// The agent's own environment.
    #[default]
    Inherit,
    /// Only the variables programs need to run, from the agent's environment.
    Minimal,
}

impl EnvMode {
    /// The mode a SPAWN or an ENV_QUERY names. Anything but `minimal` is
    /// `inherit`, which is what an agent did before it read the field at all.
    pub fn parse(mode: Option<&str>) -> Self {
        match mode {
            Some("minimal") => EnvMode::Minimal,
            _ => EnvMode::Inherit,
        }
    }
}

/// The variables `minimal` keeps on Unix. A name ending in `*` keeps every
/// variable starting with what precedes it.
const MINIMAL_UNIX: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_*",
    "TZ",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
];

/// The variables `minimal` keeps on Windows: what Windows programs need to
/// find the system, the user's folders and the machine they run on. Compared
/// without regard to case, as Windows does.
const MINIMAL_WINDOWS: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "Path",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "ProgramData",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "ProgramFiles*",
    "ProgramW6432",
    "CommonProgramFiles*",
    "CommonProgramW6432",
    "PROCESSOR_*",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "COMPUTERNAME",
    "PSModulePath",
];

/// Whether `minimal` keeps this variable on this platform.
pub fn kept_by_minimal(platform: Platform, name: &str) -> bool {
    let (list, key) = match platform {
        Platform::Unix => (MINIMAL_UNIX, name.to_owned()),
        Platform::Windows => (MINIMAL_WINDOWS, name.to_uppercase()),
    };
    list.iter().any(|pattern| {
        let pattern = match platform {
            Platform::Unix => pattern.to_string(),
            Platform::Windows => pattern.to_uppercase(),
        };
        match pattern.strip_suffix('*') {
            Some(prefix) => key.starts_with(prefix),
            None => key == pattern,
        }
    })
}

/// What a terminal tells the programs in it about itself. `TERM` only on
/// Unix: ConPTY translates on Windows, where nothing expects it.
pub fn identity(platform: Platform) -> Vec<(&'static str, &'static str)> {
    let mut vars = Vec::with_capacity(4);
    if platform == Platform::Unix {
        vars.push(("TERM", "xterm-256color"));
    }
    vars.push(("COLORTERM", "truecolor"));
    vars.push(("TERM_PROGRAM", "lasterm"));
    vars.push(("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION")));
    vars
}

/// A name a request may set or remove: not empty, and holding neither `=`,
/// which ends a name in an environment block, nor NUL, which ends the entry.
fn is_settable_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('=') && !name.contains('\0')
}

/// An environment as a platform reads it: one entry per name, in its sense
/// of "the same name".
#[derive(Debug, Clone)]
pub struct Environment {
    platform: Platform,
    entries: BTreeMap<String, (String, String)>,
}

impl Environment {
    pub fn new(platform: Platform) -> Self {
        Self {
            platform,
            entries: BTreeMap::new(),
        }
    }

    /// Set a variable. One already there keeps the casing of its name.
    pub fn set(&mut self, name: &str, value: &str) {
        let key = self.platform.key(name);
        match self.entries.get_mut(&key) {
            Some(entry) => entry.1 = value.to_owned(),
            None => {
                self.entries
                    .insert(key, (name.to_owned(), value.to_owned()));
            }
        }
    }

    pub fn remove(&mut self, name: &str) {
        self.entries.remove(&self.platform.key(name));
    }

    #[cfg(test)]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .get(&self.platform.key(name))
            .map(|(_, value)| value.as_str())
    }

    /// Whether a variable is there under exactly this name.
    #[cfg(test)]
    pub fn has_exact(&self, name: &str) -> bool {
        self.entries
            .get(&self.platform.key(name))
            .is_some_and(|(kept, _)| kept == name)
    }

    /// Remove the variables a request names, skipping names no platform has.
    pub fn apply_unset<S: AsRef<str>>(&mut self, names: &[S]) {
        for name in names {
            let name = name.as_ref();
            if is_settable_name(name) {
                self.remove(name);
            }
        }
    }

    /// Set the variables a request carries, skipping the ones no platform can
    /// hold.
    pub fn apply<I, K, V>(&mut self, vars: I)
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        for (name, value) in vars {
            let (name, value) = (name.as_ref(), value.as_ref());
            if is_settable_name(name) && !value.contains('\0') {
                self.set(name, value);
            }
        }
    }

    /// The entries, by name, in a stable order.
    pub fn into_pairs(self) -> Vec<(String, String)> {
        self.entries.into_values().collect()
    }

    pub fn into_map(self) -> HashMap<String, String> {
        self.entries.into_values().collect()
    }
}

/// What a terminal starts with before the profile changes anything: the base
/// for `mode`, without what a terminal keeps to itself, with its identity.
pub fn base<I>(inherited: I, mode: EnvMode, platform: Platform) -> Environment
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut environment = Environment::new(platform);
    for (name, value) in inherited {
        if mode == EnvMode::Minimal && !kept_by_minimal(platform, &name) {
            continue;
        }
        environment.set(&name, &value);
    }
    for name in crate::color_veto::VETOED_INHERITED {
        environment.remove(name);
    }
    for (name, value) in identity(platform) {
        environment.set(name, value);
    }
    environment
}

/// The agent's own environment, as a terminal can be given it. A variable
/// whose name or value is not Unicode cannot be passed to a PTY spawn, which
/// takes strings, and is left out.
pub fn inherited_from_process() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// The OS the agent runs on, named as the hub names a host's.
pub fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    fn names(environment: &Environment) -> Vec<String> {
        environment
            .clone()
            .into_pairs()
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    }

    #[test]
    fn inherit_starts_from_everything_the_agent_has() {
        let environment = base(
            vars(&[
                ("HOME", "/home/pi"),
                ("EDITOR", "hx"),
                ("SSH_AUTH_SOCK", "/tmp/a"),
            ]),
            EnvMode::Inherit,
            Platform::Unix,
        );

        assert_eq!(environment.get("EDITOR"), Some("hx"));
        assert_eq!(environment.get("SSH_AUTH_SOCK"), Some("/tmp/a"));
        assert_eq!(environment.get("HOME"), Some("/home/pi"));
    }

    #[test]
    fn minimal_keeps_only_what_programs_need_and_invents_nothing() {
        let environment = base(
            vars(&[
                ("HOME", "/home/pi"),
                ("PATH", "/usr/bin:/bin"),
                ("LC_ALL", "C.UTF-8"),
                ("LC_TIME", "fr_FR.UTF-8"),
                ("EDITOR", "hx"),
                ("SSH_AUTH_SOCK", "/tmp/a"),
                ("LCX", "not a locale"),
            ]),
            EnvMode::Minimal,
            Platform::Unix,
        );

        assert_eq!(environment.get("HOME"), Some("/home/pi"));
        assert_eq!(environment.get("PATH"), Some("/usr/bin:/bin"));
        assert_eq!(environment.get("LC_ALL"), Some("C.UTF-8"));
        assert_eq!(environment.get("LC_TIME"), Some("fr_FR.UTF-8"));
        assert_eq!(environment.get("EDITOR"), None);
        assert_eq!(environment.get("SSH_AUTH_SOCK"), None);
        assert_eq!(environment.get("LCX"), None);
        // The agent had no USER, LANG or TZ: none is made up.
        assert_eq!(environment.get("USER"), None);
        assert_eq!(environment.get("LANG"), None);
        assert_eq!(environment.get("TZ"), None);
    }

    #[test]
    fn minimal_on_windows_reads_names_without_case() {
        let environment = base(
            vars(&[
                ("Path", r"C:\Windows"),
                ("SYSTEMROOT", r"C:\Windows"),
                ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                ("PROCESSOR_ARCHITECTURE", "AMD64"),
                ("OneDrive", r"C:\Users\me\OneDrive"),
            ]),
            EnvMode::Minimal,
            Platform::Windows,
        );

        assert!(environment.has_exact("Path"));
        assert!(environment.has_exact("SYSTEMROOT"));
        assert!(environment.has_exact("ProgramFiles(x86)"));
        assert!(environment.has_exact("PROCESSOR_ARCHITECTURE"));
        assert_eq!(environment.get("OneDrive"), None);
    }

    #[test]
    fn the_inherited_no_color_is_dropped_in_either_mode() {
        for mode in [EnvMode::Inherit, EnvMode::Minimal] {
            let environment = base(
                vars(&[("NO_COLOR", "1"), ("PATH", "/bin")]),
                mode,
                Platform::Unix,
            );
            assert_eq!(environment.get("NO_COLOR"), None, "{mode:?}");
        }
    }

    // The shell talks to xterm.js, not to whatever started the agent: a TERM
    // inherited from there says nothing true about this terminal.
    #[test]
    fn the_identity_overrides_what_was_inherited() {
        let environment = base(
            vars(&[
                ("TERM", "dumb"),
                ("COLORTERM", "no"),
                ("TERM_PROGRAM", "vscode"),
            ]),
            EnvMode::Inherit,
            Platform::Unix,
        );

        assert_eq!(environment.get("TERM"), Some("xterm-256color"));
        assert_eq!(environment.get("COLORTERM"), Some("truecolor"));
        assert_eq!(environment.get("TERM_PROGRAM"), Some("lasterm"));
        assert_eq!(
            environment.get("TERM_PROGRAM_VERSION"),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn a_minimal_environment_still_says_what_the_terminal_is() {
        let environment = base(Vec::new(), EnvMode::Minimal, Platform::Unix);

        assert_eq!(
            names(&environment),
            ["COLORTERM", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]
        );
    }

    #[test]
    fn windows_gets_no_term() {
        let environment = base(
            vars(&[("TERM", "cygwin")]),
            EnvMode::Inherit,
            Platform::Windows,
        );

        // An inherited one is kept as it was: only Unix agents set it.
        assert_eq!(environment.get("TERM"), Some("cygwin"));
        let clean = base(Vec::new(), EnvMode::Inherit, Platform::Windows);
        assert_eq!(clean.get("TERM"), None);
        assert_eq!(clean.get("COLORTERM"), Some("truecolor"));
    }

    // A profile can take the identity back out, and can say otherwise: it
    // speaks after the terminal does.
    #[test]
    fn removals_then_values_come_after_the_identity() {
        let mut environment = base(
            vars(&[("EDITOR", "vi"), ("PAGER", "less")]),
            EnvMode::Inherit,
            Platform::Unix,
        );

        environment.apply_unset(&["COLORTERM", "PAGER", "EDITOR"]);
        environment.apply([("TERM", "screen-256color"), ("EDITOR", "hx")]);

        assert_eq!(environment.get("COLORTERM"), None);
        assert_eq!(environment.get("PAGER"), None);
        assert_eq!(environment.get("TERM"), Some("screen-256color"));
        // Removed, then set again by a value: the value is what the request says.
        assert_eq!(environment.get("EDITOR"), Some("hx"));
    }

    #[test]
    fn what_is_applied_last_wins() {
        let mut environment = base(Vec::new(), EnvMode::Inherit, Platform::Unix);

        environment.apply([("SUDO_ASKPASS", "from-the-request")]);
        environment.apply([("SUDO_ASKPASS", "from-elevation")]);

        assert_eq!(environment.get("SUDO_ASKPASS"), Some("from-elevation"));
    }

    #[test]
    fn windows_names_are_one_variable_whatever_their_case() {
        let mut environment = base(
            vars(&[("Path", r"C:\Windows"), ("TEMP", r"C:\Temp")]),
            EnvMode::Inherit,
            Platform::Windows,
        );

        environment.apply([("PATH", r"C:\Tools;C:\Windows")]);
        environment.apply_unset(&["temp"]);

        assert!(environment.has_exact("Path"), "the platform's casing stays");
        assert_eq!(environment.get("path"), Some(r"C:\Tools;C:\Windows"));
        assert_eq!(environment.get("TEMP"), None);
        assert_eq!(
            environment
                .clone()
                .into_pairs()
                .iter()
                .filter(|(name, _)| name.eq_ignore_ascii_case("path"))
                .count(),
            1
        );
    }

    #[test]
    fn unix_names_differ_by_case() {
        let mut environment = base(vars(&[("Path", "a")]), EnvMode::Inherit, Platform::Unix);

        environment.apply([("PATH", "b")]);
        environment.apply_unset(&["path"]);

        assert_eq!(environment.get("Path"), Some("a"));
        assert_eq!(environment.get("PATH"), Some("b"));
    }

    // A name with `=` would end early in the block the platform builds, and a
    // NUL would end the entry: neither reaches the spawn.
    #[test]
    fn what_no_environment_can_hold_is_left_out() {
        let mut environment = base(Vec::new(), EnvMode::Minimal, Platform::Unix);

        environment.apply([("", "empty"), ("A=B", "c"), ("NUL", "a\0b"), ("OK", "yes")]);
        environment.apply_unset(&["", "TERM=x"]);

        assert_eq!(environment.get("OK"), Some("yes"));
        assert_eq!(environment.get("NUL"), None);
        assert_eq!(environment.get("TERM"), Some("xterm-256color"));
        assert!(!names(&environment)
            .iter()
            .any(|name| name.is_empty() || name.contains('=')));
    }

    #[test]
    fn a_mode_is_inherit_unless_it_says_minimal() {
        assert_eq!(EnvMode::parse(Some("minimal")), EnvMode::Minimal);
        assert_eq!(EnvMode::parse(Some("inherit")), EnvMode::Inherit);
        assert_eq!(EnvMode::parse(Some("something-else")), EnvMode::Inherit);
        assert_eq!(EnvMode::parse(None), EnvMode::Inherit);
    }
}
