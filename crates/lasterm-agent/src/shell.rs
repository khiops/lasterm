/// Detect available shells on the system.
/// Linux/macOS: parse /etc/shells + check $SHELL
/// Windows: pwsh and powershell, each where PATH first finds it, then COMSPEC
pub fn detect_available_shells() -> Vec<String> {
    #[cfg(unix)]
    {
        detect_unix_shells()
    }
    #[cfg(windows)]
    {
        detect_windows_shells()
    }
}

/// Get the default shell for the current user: the one a terminal starts when
/// its SPAWN names none.
pub fn get_default_shell() -> String {
    default_shell_among(&detect_available_shells())
}

/// [`default_shell`] for this agent, among the shells it detected. HELLO
/// passes the list it reports, so that both come from one detection.
pub fn default_shell_among(detected: &[String]) -> String {
    default_shell(crate::environment::Platform::current(), detected, |name| {
        std::env::var(name).ok()
    })
}

/// The shell a terminal starts when nothing names one, which HELLO reports as
/// `default_shell`: the hub marks its profile as the host's default while the
/// user has chosen none (#802).
///
/// - Unix: `SHELL`, else `/bin/sh`.
/// - Windows (#804): PowerShell 7 (`pwsh.exe`), else Windows PowerShell
///   (`powershell.exe`), else `COMSPEC`, else `cmd.exe`. The Command Prompt
///   stays a profile of its own.
///
/// A PowerShell is the one `detected` lists, spelled as it lists it: the hub
/// finds a shell's profile by its path, so the default names the path it
/// seeded one for. Detection lists the first of each that `PATH` finds, the
/// one typing its name starts; were one listed twice, the first would win.
pub fn default_shell(
    platform: crate::environment::Platform,
    detected: &[String],
    var: impl Fn(&str) -> Option<String>,
) -> String {
    match platform {
        crate::environment::Platform::Unix => var("SHELL").unwrap_or_else(|| "/bin/sh".into()),
        crate::environment::Platform::Windows => {
            let listed = |file: &str| {
                detected
                    .iter()
                    .find(|shell| windows_file_name(shell).eq_ignore_ascii_case(file))
                    .cloned()
            };
            listed("pwsh.exe")
                .or_else(|| listed("powershell.exe"))
                .or_else(|| var("COMSPEC").filter(|comspec| !comspec.is_empty()))
                .unwrap_or_else(|| "cmd.exe".into())
        }
    }
}

/// A Windows path's file name: what follows its last `\` or `/`.
fn windows_file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Where a terminal starts when its SPAWN names no directory (#581): the home
/// of the user the agent runs as, which is where `ssh host` starts a shell.
///
/// The hub sends no directory for a terminal that has none of its own, on a
/// restart as on the first start: only the agent knows its host's home.
/// `HOME` on Unix, `USERPROFILE` on Windows, as `var` reads them from the
/// agent's own environment. `None` when the variable is unset, empty, or not
/// a directory (`is_dir`): the PTY is then started without one, as before —
/// in the agent's own current directory on Unix.
pub fn default_cwd(
    platform: crate::environment::Platform,
    var: impl Fn(&str) -> Option<String>,
    is_dir: impl Fn(&str) -> bool,
) -> Option<String> {
    let name = match platform {
        crate::environment::Platform::Unix => "HOME",
        crate::environment::Platform::Windows => "USERPROFILE",
    };
    var(name).filter(|home| !home.is_empty() && is_dir(home))
}

/// [`default_cwd`] for this agent: its platform, its environment, its disks.
pub fn agent_default_cwd() -> Option<String> {
    default_cwd(
        crate::environment::Platform::current(),
        |name| std::env::var(name).ok(),
        |path| std::path::Path::new(path).is_dir(),
    )
}

/// The shells known to start as login shells when given `-l` (#576).
pub const LOGIN_SHELLS: &[&str] = &["bash", "zsh", "ksh", "mksh", "fish", "sh", "dash", "ash"];

/// The arguments a shell starts with, once the hub has said whether it wants
/// a login shell.
///
/// `ssh host` gives a login shell, and a remote terminal takes its place: the
/// hub asks for one there, so `~/.profile` is read and `PATH` is right
/// whatever the agent was started with. Only a Unix agent acts on it, only for
/// a shell known to take `-l`, and only when the request named no arguments of
/// its own: those say what the shell is to do, and are passed as they are.
pub fn login_shell_args(
    platform: crate::environment::Platform,
    shell: &str,
    args: Vec<String>,
    login_shell: bool,
) -> Vec<String> {
    if !login_shell || platform != crate::environment::Platform::Unix || !args.is_empty() {
        return args;
    }
    let name = shell.rsplit('/').next().unwrap_or(shell);
    if LOGIN_SHELLS.contains(&name) {
        vec!["-l".to_owned()]
    } else {
        args
    }
}

#[cfg(unix)]
fn detect_unix_shells() -> Vec<String> {
    use std::path::Path;

    let mut shells: Vec<String> = Vec::new();

    // Parse /etc/shells
    if let Ok(content) = std::fs::read_to_string("/etc/shells") {
        for line in content.lines() {
            let line = line.trim();
            // Skip comments and empty lines
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Only include shells that actually exist on disk
            if Path::new(line).exists() && !shells.contains(&line.to_string()) {
                shells.push(line.to_string());
            }
        }
    }

    // Also include $SHELL if set and not already in the list
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && Path::new(&shell).exists() && !shells.contains(&shell) {
            shells.insert(0, shell);
        }
    }

    // Fallback: check common shell paths
    if shells.is_empty() {
        for candidate in &["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/zsh"] {
            if Path::new(candidate).exists() {
                shells.push(candidate.to_string());
            }
        }
    }

    shells
}

#[cfg(windows)]
fn detect_windows_shells() -> Vec<String> {
    use std::path::Path;

    let mut shells: Vec<String> = Vec::new();

    // pwsh.exe and powershell.exe, each where PATH first finds it, the Store's
    // alias in WindowsApps included, then COMSPEC: the order the default is
    // chosen in (#804), and the one a new host's profile menu lists them in
    for name in &["pwsh.exe", "powershell.exe"] {
        if let Some(path) = find_in_path(name) {
            if !shells.contains(&path) {
                shells.push(path);
            }
        }
    }

    // COMSPEC (usually cmd.exe)
    if let Ok(comspec) = std::env::var("COMSPEC") {
        if !comspec.is_empty() && Path::new(&comspec).exists() && !shells.contains(&comspec) {
            shells.push(comspec);
        }
    }

    // Fallback to cmd.exe
    if shells.is_empty() {
        shells.push("cmd.exe".into());
    }

    shells
}

#[cfg(windows)]
fn find_in_path(name: &str) -> Option<String> {
    use std::path::Path;

    let path_var = std::env::var("PATH").ok()?;
    for dir in path_var.split(';') {
        let full = Path::new(dir).join(name);
        if full.exists() {
            return Some(full.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_shells_not_empty() {
        let shells = detect_available_shells();
        assert!(!shells.is_empty(), "should find at least one shell");
    }

    #[test]
    fn test_default_shell_not_empty() {
        let shell = get_default_shell();
        assert!(!shell.is_empty());
    }

    use crate::environment::Platform;

    #[test]
    fn a_known_shell_asked_to_log_in_gets_dash_l() {
        for shell in [
            "/bin/bash",
            "/usr/bin/zsh",
            "/bin/sh",
            "/usr/bin/fish",
            "dash",
        ] {
            assert_eq!(
                login_shell_args(Platform::Unix, shell, Vec::new(), true),
                vec!["-l".to_string()],
                "{shell}"
            );
        }
    }

    #[test]
    fn an_unknown_shell_is_started_as_asked() {
        for shell in [
            "/usr/bin/nu",
            "/usr/bin/xonsh",
            "/usr/bin/python3",
            "/bin/bashful",
        ] {
            assert!(
                login_shell_args(Platform::Unix, shell, Vec::new(), true).is_empty(),
                "{shell}"
            );
        }
    }

    #[test]
    fn explicit_arguments_are_left_as_they_are() {
        let args = vec!["-c".to_string(), "htop".to_string()];
        assert_eq!(
            login_shell_args(Platform::Unix, "/bin/bash", args.clone(), true),
            args
        );
    }

    #[test]
    fn nothing_is_added_unless_the_hub_asks() {
        assert!(login_shell_args(Platform::Unix, "/bin/bash", Vec::new(), false).is_empty());
    }

    // ConPTY shells have no login flavour to ask for. The default a Windows
    // SSH host starts, a PowerShell since #804, is asked for one, and gets no
    // `-Login`: pwsh takes it on Linux and macOS only, powershell.exe never.
    #[test]
    fn a_windows_agent_ignores_the_request() {
        for shell in [
            "sh",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        ] {
            assert!(
                login_shell_args(Platform::Windows, shell, Vec::new(), true).is_empty(),
                "{shell}"
            );
        }
    }

    // ─── The shell a terminal starts when none is named (#804) ──────────────

    const CMD: &str = r"C:\WINDOWS\system32\cmd.exe";
    const PROGRAM_FILES_PWSH: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";
    /// Where `PATH` finds a Store install: its app execution alias.
    const STORE_PWSH: &str = r"C:\Users\pi\AppData\Local\Microsoft\WindowsApps\pwsh.exe";
    /// As `PATH` usually spells it.
    const POWERSHELL: &str = r"C:\windows\system32\windowspowershell\v1.0\powershell.exe";

    fn listed(shells: &[&str]) -> Vec<String> {
        shells.iter().map(|shell| shell.to_string()).collect()
    }

    fn windows_default(detected: &[&str], env: &[(&str, &str)]) -> String {
        default_shell(Platform::Windows, &listed(detected), vars(env))
    }

    #[test]
    fn a_windows_agent_starts_powershell_7_when_installed() {
        let env = [("COMSPEC", CMD)];
        assert_eq!(
            windows_default(&[PROGRAM_FILES_PWSH, POWERSHELL, CMD], &env),
            PROGRAM_FILES_PWSH
        );
        // Whatever the order of the list: an agent before #804 listed COMSPEC first
        assert_eq!(
            windows_default(&[CMD, POWERSHELL, PROGRAM_FILES_PWSH], &env),
            PROGRAM_FILES_PWSH
        );
    }

    // The path is the one listed, for the hub to find the profile it seeded
    // for it: a Store install's alias, not where the package lives.
    #[test]
    fn a_store_install_is_named_by_the_alias_path_finds() {
        assert_eq!(
            windows_default(&[STORE_PWSH, POWERSHELL, CMD], &[("COMSPEC", CMD)]),
            STORE_PWSH
        );
    }

    // Detection lists the one `PATH` finds first, which typing `pwsh` starts.
    #[test]
    fn of_two_powershell_7_the_one_listed_first_is_started() {
        assert_eq!(
            windows_default(&[STORE_PWSH, PROGRAM_FILES_PWSH, CMD], &[]),
            STORE_PWSH
        );
        assert_eq!(
            windows_default(&[PROGRAM_FILES_PWSH, STORE_PWSH, CMD], &[]),
            PROGRAM_FILES_PWSH
        );
    }

    #[test]
    fn without_powershell_7_a_windows_agent_starts_windows_powershell() {
        assert_eq!(
            windows_default(&[CMD, POWERSHELL], &[("COMSPEC", CMD)]),
            POWERSHELL
        );
    }

    // A file name, not a word in the path: case aside, as Windows reads it.
    #[test]
    fn a_powershell_is_told_by_its_file_name() {
        assert_eq!(
            windows_default(&[r"C:\Tools\PWSH.EXE"], &[]),
            r"C:\Tools\PWSH.EXE"
        );
        assert_eq!(
            windows_default(&[r"C:\pwsh.exe.d\bash.exe", r"C:\powershell\cmd.exe"], &[]),
            "cmd.exe"
        );
    }

    #[test]
    fn without_any_powershell_a_windows_agent_starts_comspec() {
        let comspec = r"D:\Shells\tcc.exe";
        assert_eq!(windows_default(&[CMD], &[("COMSPEC", comspec)]), comspec);
    }

    #[test]
    fn with_nothing_a_windows_agent_starts_cmd_exe() {
        assert_eq!(windows_default(&[], &[]), "cmd.exe");
        assert_eq!(windows_default(&["cmd.exe"], &[("COMSPEC", "")]), "cmd.exe");
    }

    // Unchanged on Unix: `SHELL`, whatever the agent found.
    #[test]
    fn a_unix_agent_starts_shell_else_bin_sh() {
        let detected = listed(&["/usr/bin/pwsh", "/bin/bash"]);
        assert_eq!(
            default_shell(
                Platform::Unix,
                &detected,
                vars(&[("SHELL", "/usr/bin/zsh")])
            ),
            "/usr/bin/zsh"
        );
        assert_eq!(
            default_shell(Platform::Unix, &detected, vars(&[])),
            "/bin/sh"
        );
    }

    // ─── The directory a terminal starts in without one (#581) ──────────────

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    fn any_dir(_: &str) -> bool {
        true
    }

    #[test]
    fn a_unix_agent_starts_a_terminal_in_home() {
        let env = [("HOME", "/home/pi"), ("USERPROFILE", r"C:\Users\pi")];
        assert_eq!(
            default_cwd(Platform::Unix, vars(&env), any_dir),
            Some("/home/pi".to_string())
        );
    }

    #[test]
    fn a_windows_agent_starts_a_terminal_in_the_user_profile() {
        let env = [("HOME", "/home/pi"), ("USERPROFILE", r"C:\Users\pi")];
        assert_eq!(
            default_cwd(Platform::Windows, vars(&env), any_dir),
            Some(r"C:\Users\pi".to_string())
        );
    }

    // Without one the PTY starts where it did before this default existed.
    #[test]
    fn no_home_names_no_directory() {
        assert_eq!(default_cwd(Platform::Unix, vars(&[]), any_dir), None);
        assert_eq!(
            default_cwd(Platform::Windows, vars(&[("HOME", "/home/pi")]), any_dir),
            None,
            "a Windows agent does not read HOME"
        );
        assert_eq!(
            default_cwd(Platform::Unix, vars(&[("HOME", "")]), any_dir),
            None
        );
    }

    #[test]
    fn a_home_that_is_not_a_directory_names_none() {
        let env = [("HOME", "/nonexistent")];
        let asked = std::cell::RefCell::new(Vec::new());
        let is_dir = |path: &str| {
            asked.borrow_mut().push(path.to_string());
            false
        };
        assert_eq!(default_cwd(Platform::Unix, vars(&env), is_dir), None);
        assert_eq!(*asked.borrow(), vec!["/nonexistent".to_string()]);
    }

    #[test]
    fn test_all_detected_shells_exist() {
        let shells = detect_available_shells();
        for shell in &shells {
            assert!(
                std::path::Path::new(shell).exists(),
                "shell does not exist: {}",
                shell
            );
        }
    }
}
