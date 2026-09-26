/// Detect available shells on the system.
/// Linux/macOS: parse /etc/shells + check $SHELL
/// Windows: check COMSPEC + look for pwsh/powershell in PATH
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

/// Get the default shell for the current user.
pub fn get_default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
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

    // COMSPEC (usually cmd.exe)
    if let Ok(comspec) = std::env::var("COMSPEC") {
        if !comspec.is_empty() && Path::new(&comspec).exists() {
            shells.push(comspec);
        }
    }

    // Look for pwsh.exe and powershell.exe in PATH
    for name in &["pwsh.exe", "powershell.exe"] {
        if let Some(path) = find_in_path(name) {
            if !shells.contains(&path) {
                shells.push(path);
            }
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

    // ConPTY shells have no login flavour to ask for.
    #[test]
    fn a_windows_agent_ignores_the_request() {
        assert!(login_shell_args(Platform::Windows, "sh", Vec::new(), true).is_empty());
        assert!(login_shell_args(
            Platform::Windows,
            r"C:\Windows\System32\cmd.exe",
            Vec::new(),
            true
        )
        .is_empty());
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
