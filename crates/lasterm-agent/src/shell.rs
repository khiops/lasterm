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
