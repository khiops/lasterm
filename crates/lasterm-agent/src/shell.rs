/// Detect available shells on the system.
/// Linux/macOS: parse /etc/shells + check $SHELL
/// Windows: pwsh and powershell, each where PATH first finds it, then COMSPEC;
/// a Store package's by its alias (#818)
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
/// one typing its name starts, and a Store package's by its alias, never by
/// the directory its next update replaces (#818); were one listed twice, the
/// first would win.
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
    windows_shells(
        |name| std::env::var(name).ok(),
        |path| std::path::Path::new(path).exists(),
    )
}

/// The shells a Windows agent reports, as `var` reads its environment and
/// `exists` its disks: `pwsh.exe` and `powershell.exe`, each where `PATH`
/// first finds it, the Store's alias in WindowsApps included, then `COMSPEC`.
/// That is the order the default is chosen in (#804), and the one a new
/// host's profile menu lists them in. `cmd.exe` when none is found.
///
/// Every path is admitted by [`reported_windows_shell`], and listed once.
#[cfg(any(windows, test))]
fn windows_shells(
    var: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&str) -> bool,
) -> Vec<String> {
    let path_var = var("PATH").unwrap_or_default();
    let in_path = |name: &str| {
        first_reported(
            path_var
                .split(';')
                .filter(|dir| !dir.is_empty())
                .map(|dir| windows_join(dir, name)),
            &var,
            &exists,
        )
    };
    let found = [
        in_path("pwsh.exe"),
        in_path("powershell.exe"),
        first_reported(
            var("COMSPEC").filter(|comspec| !comspec.is_empty()),
            &var,
            &exists,
        ),
    ];

    let mut shells: Vec<String> = Vec::new();
    for shell in found.into_iter().flatten() {
        if !shells.contains(&shell) {
            shells.push(shell);
        }
    }
    if shells.is_empty() {
        shells.push("cmd.exe".into());
    }
    shells
}

/// The first of `candidates` that `exists`, as [`reported_windows_shell`]
/// reports it: one it does not report leaves the search to the next.
#[cfg(any(windows, test))]
fn first_reported(
    candidates: impl IntoIterator<Item = String>,
    var: &impl Fn(&str) -> Option<String>,
    exists: &impl Fn(&str) -> bool,
) -> Option<String> {
    candidates
        .into_iter()
        .filter(|candidate| exists(candidate))
        .find_map(|found| reported_windows_shell(&found, var, exists))
}

/// The path a Windows shell found at `found` is reported by (#818).
///
/// A Store app lives in a package directory under `%ProgramFiles%\WindowsApps`
/// named for its version, which the app's next Store update replaces: a launch
/// profile seeded with that path then fails to start (#816). Such a shell is
/// reported by its app execution alias,
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\<file name>`, which updates keep, or
/// not at all when that alias does not exist. Any other path is reported as
/// found.
///
/// `ProgramFiles` is `C:\Program Files` when unset or empty; paths are
/// compared case aside, as Windows reads them.
#[cfg(any(windows, test))]
fn reported_windows_shell(
    found: &str,
    var: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let set = |name: &str| var(name).filter(|value| !value.is_empty());
    let program_files = set("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".into());
    if !windows_path_within(found, &windows_join(&program_files, "WindowsApps")) {
        return Some(found.to_owned());
    }
    let aliases = windows_join(&set("LOCALAPPDATA")?, r"Microsoft\WindowsApps");
    let alias = windows_join(&aliases, windows_file_name(found));
    exists(&alias).then_some(alias)
}

/// `name` in the Windows directory `dir`, spelled as `Path::join` spells it
/// there: one `\` between them unless `dir` ends with a separator.
#[cfg(any(windows, test))]
fn windows_join(dir: &str, name: &str) -> String {
    if dir.ends_with(['\\', '/']) {
        format!("{dir}{name}")
    } else {
        format!(r"{dir}\{name}")
    }
}

/// Whether the Windows path `path` lies inside the directory `dir`: below it,
/// not `dir` itself. Either separator, repeated or trailing ones aside, and
/// case aside.
#[cfg(any(windows, test))]
fn windows_path_within(path: &str, dir: &str) -> bool {
    fn parts(path: &str) -> impl Iterator<Item = &str> {
        path.split(['\\', '/']).filter(|part| !part.is_empty())
    }
    let mut path = parts(path);
    for dir_part in parts(dir) {
        match path.next() {
            Some(part) if part.eq_ignore_ascii_case(dir_part) => {}
            _ => return false,
        }
    }
    path.next().is_some()
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

    // ─── A Store PowerShell, by the path its updates keep (#818) ────────────

    /// Where a Store PowerShell's package lives, until its next update.
    const STORE_PACKAGE: &str =
        r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe";
    const PACKAGE_PWSH: &str =
        r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe\pwsh.exe";
    /// The directory of the Store's app execution aliases, `STORE_PWSH`'s.
    const STORE_ALIASES: &str = r"C:\Users\pi\AppData\Local\Microsoft\WindowsApps";
    /// As `PATH` usually spells them: `PROGRAM_FILES_PWSH`'s and `POWERSHELL`'s.
    const PROGRAM_FILES_PWSH_DIR: &str = r"C:\Program Files\PowerShell\7\";
    const POWERSHELL_DIR: &str = r"C:\windows\system32\windowspowershell\v1.0\";
    const LOCAL_APP_DATA: &str = r"C:\Users\pi\AppData\Local";

    /// A Windows agent's environment, `PATH` aside.
    fn windows_env(path: &str) -> [(&str, &str); 4] {
        [
            ("PATH", path),
            ("ProgramFiles", r"C:\Program Files"),
            ("LOCALAPPDATA", LOCAL_APP_DATA),
            ("COMSPEC", CMD),
        ]
    }

    /// A disk holding these files, and nothing else.
    fn on_disk<'a>(files: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |path| files.contains(&path)
    }

    // A Store update replaces the package directory, and its alias stays.
    #[test]
    fn a_store_package_shell_is_reported_by_its_alias() {
        let path = [STORE_PACKAGE, POWERSHELL_DIR].join(";");
        let env = windows_env(&path);
        let disk = [PACKAGE_PWSH, STORE_PWSH, POWERSHELL, CMD];
        assert_eq!(
            reported_windows_shell(PACKAGE_PWSH, vars(&env), on_disk(&disk)),
            Some(STORE_PWSH.to_string())
        );
        let shells = windows_shells(vars(&env), on_disk(&disk));
        assert_eq!(shells, listed(&[STORE_PWSH, POWERSHELL, CMD]));
        assert_eq!(
            default_shell(Platform::Windows, &shells, vars(&env)),
            STORE_PWSH
        );
    }

    // Without an alias the package's path is still not reported: the search
    // goes on in the next PATH directories.
    #[test]
    fn a_store_package_shell_without_an_alias_is_not_reported() {
        let disk = [PACKAGE_PWSH, PROGRAM_FILES_PWSH, POWERSHELL, CMD];
        let path = [STORE_PACKAGE, PROGRAM_FILES_PWSH_DIR, POWERSHELL_DIR].join(";");
        let env = windows_env(&path);
        assert_eq!(
            reported_windows_shell(PACKAGE_PWSH, vars(&env), on_disk(&disk)),
            None
        );
        assert_eq!(
            windows_shells(vars(&env), on_disk(&disk)),
            listed(&[PROGRAM_FILES_PWSH, POWERSHELL, CMD])
        );

        let path = [STORE_PACKAGE, POWERSHELL_DIR].join(";");
        let env = windows_env(&path);
        let shells = windows_shells(vars(&env), on_disk(&disk));
        assert_eq!(shells, listed(&[POWERSHELL, CMD]));
        assert_eq!(
            default_shell(Platform::Windows, &shells, vars(&env)),
            POWERSHELL
        );

        // Nor without a LOCALAPPDATA to find the alias in
        let env = [("ProgramFiles", r"C:\Program Files"), ("LOCALAPPDATA", "")];
        assert_eq!(
            reported_windows_shell(PACKAGE_PWSH, vars(&env), |_| true),
            None
        );
    }

    #[test]
    fn a_shell_outside_the_store_packages_is_reported_as_found() {
        let env = windows_env("");
        for found in [
            PROGRAM_FILES_PWSH,
            POWERSHELL,
            STORE_PWSH,
            CMD,
            r"C:\Program Files\WindowsAppsOld\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe\pwsh.exe",
        ] {
            assert_eq!(
                reported_windows_shell(found, vars(&env), |_| false),
                Some(found.to_string()),
                "{found}"
            );
        }
        // Spelled as PATH spells its directory
        let path = [PROGRAM_FILES_PWSH_DIR, "", POWERSHELL_DIR].join(";");
        assert_eq!(
            windows_shells(
                vars(&windows_env(&path)),
                on_disk(&[PROGRAM_FILES_PWSH, POWERSHELL, CMD])
            ),
            listed(&[PROGRAM_FILES_PWSH, POWERSHELL, CMD])
        );
    }

    #[test]
    fn a_store_package_is_told_case_aside() {
        let lower_package =
            r"c:\program files\windowsapps\microsoft.powershell_7.6.8.0_x64__8wekyb3d8bbwe";
        let lower_pwsh = format!(r"{lower_package}\pwsh.exe");
        let disk = [lower_pwsh.as_str(), STORE_PWSH, CMD];
        let env = windows_env(lower_package);
        assert_eq!(
            windows_shells(vars(&env), on_disk(&disk)),
            listed(&[STORE_PWSH, CMD])
        );

        let env = [
            ("ProgramFiles", r"C:\PROGRAM FILES\"),
            ("LOCALAPPDATA", LOCAL_APP_DATA),
        ];
        assert_eq!(
            reported_windows_shell(PACKAGE_PWSH, vars(&env), on_disk(&disk)),
            Some(STORE_PWSH.to_string())
        );
    }

    // Found again where PATH names the alias directory itself, it is listed
    // once, whichever comes first.
    #[test]
    fn a_store_alias_also_on_path_is_listed_once() {
        let disk = [PACKAGE_PWSH, STORE_PWSH, POWERSHELL, CMD];
        for path in [
            [STORE_PACKAGE, STORE_ALIASES, POWERSHELL_DIR].join(";"),
            [STORE_ALIASES, STORE_PACKAGE, POWERSHELL_DIR].join(";"),
        ] {
            assert_eq!(
                windows_shells(vars(&windows_env(&path)), on_disk(&disk)),
                listed(&[STORE_PWSH, POWERSHELL, CMD]),
                "{path}"
            );
        }
    }

    // The package root is `%ProgramFiles%\WindowsApps`, `C:\Program Files`
    // when the variable is unset or empty.
    #[test]
    fn the_store_packages_are_found_under_program_files() {
        let disk = [STORE_PWSH];
        let local = ("LOCALAPPDATA", LOCAL_APP_DATA);
        for env in [vec![local], vec![local, ("ProgramFiles", "")]] {
            assert_eq!(
                reported_windows_shell(PACKAGE_PWSH, vars(&env), on_disk(&disk)),
                Some(STORE_PWSH.to_string())
            );
        }
        let elsewhere =
            r"D:\Apps\WindowsApps\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe\pwsh.exe";
        let env = [local, ("ProgramFiles", r"D:\Apps")];
        assert_eq!(
            reported_windows_shell(elsewhere, vars(&env), on_disk(&disk)),
            Some(STORE_PWSH.to_string())
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
