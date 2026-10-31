/// Detect available shells on the system.
/// Linux/macOS: parse /etc/shells + check $SHELL, each file once (#821)
/// Windows: pwsh and powershell, each where PATH first finds it, then COMSPEC;
/// a Store app's by its alias (#818, #821)
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
    default_shell(
        crate::environment::Platform::current(),
        detected,
        |name| std::env::var(name).ok(),
        real_path,
    )
}

/// The shell a terminal starts when nothing names one, which HELLO reports as
/// `default_shell`: the hub marks its profile as the host's default while the
/// user has chosen none (#802).
///
/// - Unix: `SHELL`, else `/bin/sh`, spelled as `detected` lists the same file
///   ([`unix_shell_identity`], as `resolve` resolves paths): with a merged
///   `/usr`, `SHELL=/usr/bin/bash` is `/bin/bash` when that is what is listed
///   (#821). As it is when `detected` lists no such file.
/// - Windows (#804): PowerShell 7 (`pwsh.exe`), else Windows PowerShell
///   (`powershell.exe`), else `COMSPEC`, else `cmd.exe`. The Command Prompt
///   stays a profile of its own.
///
/// A PowerShell is the one `detected` lists, spelled as it lists it: the hub
/// finds a shell's profile by its path, so the default names the path it
/// seeded one for. Detection lists the first of each that `PATH` finds, the
/// one typing its name starts, and a Store app's by its alias, never by the
/// directory its next update replaces (#818); were one listed twice, the
/// first would win.
pub fn default_shell(
    platform: crate::environment::Platform,
    detected: &[String],
    var: impl Fn(&str) -> Option<String>,
    resolve: impl Fn(&str) -> Option<String>,
) -> String {
    match platform {
        crate::environment::Platform::Unix => {
            let shell = var("SHELL").unwrap_or_else(|| "/bin/sh".into());
            unix_shell_identity(&shell, &resolve)
                .and_then(|file| {
                    detected.iter().find(|listed| {
                        unix_shell_identity(listed, &resolve).as_ref() == Some(&file)
                    })
                })
                .cloned()
                .unwrap_or(shell)
        }
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
    unix_shells(
        &std::fs::read_to_string("/etc/shells").unwrap_or_default(),
        std::env::var("SHELL").ok(),
        real_path,
    )
}

/// The shells a Unix agent reports, from the content of `/etc/shells` and
/// `SHELL`, as `resolve` resolves paths on its disks: each line of
/// `/etc/shells` that exists, then `SHELL` first when they hold no such file,
/// and the common shells when neither gives one.
///
/// Each file is listed once, under the first spelling listed (#821): with a
/// merged `/usr`, Debian's `/etc/shells` lists `/bin/bash`, then
/// `/usr/bin/bash`, the same file, and the hub would seed a profile for each.
/// [`unix_shell_identity`] tells them apart.
#[cfg(any(unix, test))]
fn unix_shells(
    etc_shells: &str,
    shell: Option<String>,
    resolve: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    // (file, spelling)
    let mut shells: Vec<(String, String)> = Vec::new();
    let is_new = |shells: &[(String, String)], path: &str| {
        unix_shell_identity(path, &resolve)
            .filter(|file| shells.iter().all(|(listed, _)| listed != file))
    };

    for line in etc_shells.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(file) = is_new(&shells, line) {
            shells.push((file, line.to_owned()));
        }
    }

    if let Some(shell) = shell.filter(|shell| !shell.is_empty()) {
        if let Some(file) = is_new(&shells, &shell) {
            shells.insert(0, (file, shell));
        }
    }

    if shells.is_empty() {
        for candidate in ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/zsh"] {
            if let Some(file) = is_new(&shells, candidate) {
                shells.push((file, candidate.to_owned()));
            }
        }
    }

    shells.into_iter().map(|(_, spelling)| spelling).collect()
}

/// The file a Unix shell's `path` starts, as `resolve` resolves paths: two
/// paths are the same shell when this is equal (#821). `None` when the path
/// does not exist.
///
/// A path is resolved whole when that keeps its file name: `/bin/bash`
/// through a merged `/usr` is `/usr/bin/bash`, and so is `/usr/bin/bash`.
/// A link to a file of another name, as Debian's `rbash` to `bash` or `sh` to
/// `dash`, is a shell of its own: those behave by the name they are started
/// under. Only its directory is resolved then, and it keeps its name.
fn unix_shell_identity(path: &str, resolve: impl Fn(&str) -> Option<String>) -> Option<String> {
    let real = resolve(path)?;
    let name = |path: &str| path.rsplit('/').next().unwrap_or(path).to_owned();
    if name(&real) == name(path) {
        return Some(real);
    }
    match path.rsplit_once('/') {
        Some((dir, file)) => {
            let dir = resolve(if dir.is_empty() { "/" } else { dir })?;
            Some(format!("{}/{file}", dir.trim_end_matches('/')))
        }
        None => Some(path.to_owned()),
    }
}

/// `path` with every link resolved, as this agent's disks have it: `None`
/// when it does not exist.
fn real_path(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|real| real.to_string_lossy().into_owned())
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

/// The path a Windows shell found at `found` is reported by: a Store app's by
/// its app execution alias, `%LOCALAPPDATA%\Microsoft\WindowsApps\<file name>`,
/// which is one path for one app, and which its updates keep.
///
/// - Under `%ProgramFiles%\WindowsApps`, a Store app lives in a package
///   directory named for its version, which the app's next Store update
///   replaces: a launch profile seeded with that path then fails to start
///   (#816, #818). Reported by its alias, or not at all when that alias does
///   not exist.
/// - Under `%LOCALAPPDATA%\Microsoft\WindowsApps`, an app also has an alias
///   in a folder named for its package family, such as
///   `Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe`: the same shell by a second
///   path, which the hub would seed a second profile for (#821). Reported by
///   the alias beside that folder when it exists, else as found: it stays.
/// - Any other path is reported as found.
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
    let aliases = set("LOCALAPPDATA").map(|local| windows_join(&local, r"Microsoft\WindowsApps"));
    let alias = || {
        aliases
            .as_deref()
            .map(|aliases| windows_join(aliases, windows_file_name(found)))
            .filter(|alias| exists(alias))
    };

    let program_files = set("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".into());
    if windows_depth_within(found, &windows_join(&program_files, "WindowsApps")) > 0 {
        return alias();
    }
    match aliases.as_deref() {
        Some(aliases) if windows_depth_within(found, aliases) > 1 => {
            Some(alias().unwrap_or_else(|| found.to_owned()))
        }
        _ => Some(found.to_owned()),
    }
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

/// How many levels below the directory `dir` the Windows path `path` lies: 1
/// for a file in it, 2 for one in a folder of it, 0 when it is not inside it,
/// or is `dir` itself. Either separator, repeated or trailing ones aside, and
/// case aside.
#[cfg(any(windows, test))]
fn windows_depth_within(path: &str, dir: &str) -> usize {
    fn parts(path: &str) -> impl Iterator<Item = &str> {
        path.split(['\\', '/']).filter(|part| !part.is_empty())
    }
    let mut path = parts(path);
    for dir_part in parts(dir) {
        match path.next() {
            Some(part) if part.eq_ignore_ascii_case(dir_part) => {}
            _ => return 0,
        }
    }
    path.count()
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
        default_shell(
            Platform::Windows,
            &listed(detected),
            vars(env),
            nothing_resolves,
        )
    }

    /// A disk where no path exists, for a default that resolves none.
    fn nothing_resolves(_: &str) -> Option<String> {
        None
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

    // On Unix: `SHELL`, as it is when the agent found no other spelling of it.
    #[test]
    fn a_unix_agent_starts_shell_else_bin_sh() {
        let detected = listed(&["/usr/bin/pwsh", "/bin/bash"]);
        assert_eq!(
            default_shell(
                Platform::Unix,
                &detected,
                vars(&[("SHELL", "/usr/bin/zsh")]),
                nothing_resolves
            ),
            "/usr/bin/zsh"
        );
        assert_eq!(
            default_shell(Platform::Unix, &detected, vars(&[]), nothing_resolves),
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
            default_shell(Platform::Windows, &shells, vars(&env), nothing_resolves),
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
            default_shell(Platform::Windows, &shells, vars(&env), nothing_resolves),
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

    // ─── One shell, one path (#821) ─────────────────────────────────────────

    /// The folder of a Store PowerShell's alias named for its package family,
    /// which a Store PowerShell puts first on the `PATH` it hands down.
    const FAMILY_ALIASES: &str =
        r"C:\Users\pi\AppData\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe";
    const FAMILY_PWSH: &str = r"C:\Users\pi\AppData\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe";

    #[test]
    fn a_package_family_alias_is_reported_by_the_alias_beside_its_folder() {
        let disk = [FAMILY_PWSH, STORE_PWSH, POWERSHELL, CMD];
        let env = windows_env("");
        assert_eq!(
            reported_windows_shell(FAMILY_PWSH, vars(&env), on_disk(&disk)),
            Some(STORE_PWSH.to_string())
        );
        let lower = format!(r"{}\pwsh.exe", FAMILY_ALIASES.to_lowercase());
        assert_eq!(
            reported_windows_shell(&lower, vars(&env), on_disk(&disk)),
            Some(STORE_PWSH.to_string()),
            "case aside"
        );

        for path in [
            [FAMILY_ALIASES, STORE_ALIASES, POWERSHELL_DIR].join(";"),
            [STORE_ALIASES, FAMILY_ALIASES, POWERSHELL_DIR].join(";"),
        ] {
            let env = windows_env(&path);
            let shells = windows_shells(vars(&env), on_disk(&disk));
            assert_eq!(shells, listed(&[STORE_PWSH, POWERSHELL, CMD]), "{path}");
            assert_eq!(
                default_shell(Platform::Windows, &shells, vars(&env), nothing_resolves),
                STORE_PWSH
            );
        }
    }

    // Unlike a package's directory, it stays through updates: without the
    // alias beside its folder, it is reported as found.
    #[test]
    fn a_package_family_alias_alone_is_reported_as_found() {
        let disk = [FAMILY_PWSH, POWERSHELL, CMD];
        let path = [FAMILY_ALIASES, POWERSHELL_DIR].join(";");
        assert_eq!(
            windows_shells(vars(&windows_env(&path)), on_disk(&disk)),
            listed(&[FAMILY_PWSH, POWERSHELL, CMD])
        );
        let no_local = [("ProgramFiles", r"C:\Program Files")];
        assert_eq!(
            reported_windows_shell(FAMILY_PWSH, vars(&no_local), |_| true),
            Some(FAMILY_PWSH.to_string())
        );
    }

    /// Raspberry Pi OS or Debian with a merged `/usr`: `/bin` is a link to
    /// `/usr/bin`, `sh` one to `dash` and `rbash` one to `bash`.
    fn merged_usr(path: &str) -> Option<String> {
        let path = match path.strip_prefix("/bin") {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("/usr/bin{rest}"),
            _ => path.to_owned(),
        };
        match path.as_str() {
            "/usr/bin/sh" => Some("/usr/bin/dash".into()),
            "/usr/bin/rbash" | "/usr/local/bin/bash" => Some("/usr/bin/bash".into()),
            "/" | "/usr/bin" | "/usr/local/bin" | "/usr/bin/bash" | "/usr/bin/dash"
            | "/usr/bin/mksh" | "/usr/bin/zsh" => Some(path),
            _ => None,
        }
    }

    /// Debian's `/etc/shells`, which lists each shell under both spellings.
    const DEBIAN_ETC_SHELLS: &str = "# /etc/shells: valid login shells
/bin/sh
/usr/bin/sh
/bin/bash
/usr/bin/bash
/bin/rbash
/usr/bin/rbash
/bin/dash
/usr/bin/dash
/usr/bin/mksh
/bin/mksh
/bin/fish
";

    #[test]
    fn a_unix_agent_lists_each_shell_once_under_its_first_spelling() {
        assert_eq!(
            unix_shells(DEBIAN_ETC_SHELLS, None, merged_usr),
            listed(&[
                "/bin/sh",
                "/bin/bash",
                "/bin/rbash",
                "/bin/dash",
                "/usr/bin/mksh"
            ])
        );
    }

    // `rbash` and `sh` behave by the name they are started under: links to
    // `bash` and `dash`, they stay shells of their own. A link of the same
    // name is the file it names.
    #[test]
    fn a_shell_is_its_file_under_its_own_name() {
        let file = |path: &str| unix_shell_identity(path, merged_usr);
        assert_eq!(file("/bin/bash"), Some("/usr/bin/bash".to_string()));
        assert_eq!(
            file("/usr/local/bin/bash"),
            Some("/usr/bin/bash".to_string())
        );
        assert_eq!(file("/bin/rbash"), Some("/usr/bin/rbash".to_string()));
        assert_eq!(file("/bin/sh"), Some("/usr/bin/sh".to_string()));
        assert_eq!(file("/bin/fish"), None, "not on this disk");
    }

    #[test]
    fn shell_is_started_under_the_spelling_detection_lists() {
        let shells = unix_shells(DEBIAN_ETC_SHELLS, Some("/usr/bin/bash".into()), merged_usr);
        assert_eq!(shells, unix_shells(DEBIAN_ETC_SHELLS, None, merged_usr));
        for shell in ["/usr/bin/bash", "/usr/local/bin/bash", "/bin/bash"] {
            assert_eq!(
                default_shell(
                    Platform::Unix,
                    &shells,
                    vars(&[("SHELL", shell)]),
                    merged_usr
                ),
                "/bin/bash",
                "{shell}"
            );
        }
        assert_eq!(
            default_shell(Platform::Unix, &shells, vars(&[]), merged_usr),
            "/bin/sh"
        );
    }

    #[test]
    fn a_shell_etc_shells_lacks_is_listed_first() {
        let shells = unix_shells(DEBIAN_ETC_SHELLS, Some("/bin/zsh".into()), merged_usr);
        assert_eq!(shells.first().map(String::as_str), Some("/bin/zsh"));
        assert_eq!(
            default_shell(
                Platform::Unix,
                &shells,
                vars(&[("SHELL", "/bin/zsh")]),
                merged_usr
            ),
            "/bin/zsh"
        );

        // Not on the disk: not listed, and the default all the same, as before
        let missing = "/opt/fish/bin/fish";
        let shells = unix_shells("/bin/bash\n", Some(missing.into()), merged_usr);
        assert_eq!(shells, listed(&["/bin/bash"]));
        assert_eq!(
            default_shell(
                Platform::Unix,
                &shells,
                vars(&[("SHELL", missing)]),
                merged_usr
            ),
            missing
        );
    }

    #[test]
    fn without_etc_shells_the_common_shells_are_listed_once() {
        assert_eq!(
            unix_shells("", None, merged_usr),
            listed(&["/bin/sh", "/bin/bash", "/bin/zsh"])
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
