/// Get the daemon log file path.
/// Linux/macOS: $XDG_STATE_HOME/lasterm/logs/agent-daemon.jsonl
/// Windows: %LOCALAPPDATA%\lasterm\logs\agent-daemon.jsonl
pub fn daemon_log_path() -> std::path::PathBuf {
    let state_dir = std::env::var("XDG_STATE_HOME").unwrap_or_else(|_| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("LOCALAPPDATA"))
            .unwrap_or_else(|_| "/tmp".into());
        #[cfg(windows)]
        {
            home
        }
        #[cfg(not(windows))]
        {
            format!("{}/.local/state", home)
        }
    });
    let dir = std::path::PathBuf::from(state_dir)
        .join("lasterm")
        .join("logs");
    std::fs::create_dir_all(&dir).ok();
    dir.join("agent-daemon.jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_log_path_returns_jsonl() {
        let path = daemon_log_path();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jsonl"));
        assert!(path.to_string_lossy().contains("lasterm"));
        assert!(path.to_string_lossy().contains("logs"));
        assert!(path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .starts_with("agent-daemon"));
    }

    #[test]
    fn daemon_log_path_xdg_state_home_respected() {
        // Override XDG_STATE_HOME for this test.
        let tmp = std::env::temp_dir().join("lasterm-test-logging-state");
        std::env::set_var("XDG_STATE_HOME", tmp.to_str().unwrap());
        let path = daemon_log_path();
        assert!(path.starts_with(&tmp));
        std::env::remove_var("XDG_STATE_HOME");
    }
}
