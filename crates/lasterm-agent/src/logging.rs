use std::path::{Path, PathBuf};

use crate::platform_dirs::{lasterm_dir, DirKind};

/// Get the daemon log file path, creating its directory:
/// `<state>/logs/agent-daemon.jsonl`, in the state directory the hub uses
/// (`$XDG_STATE_HOME/lasterm` or `~/.local/state/lasterm`, `%LOCALAPPDATA%\lasterm`).
pub fn daemon_log_path() -> std::io::Result<PathBuf> {
    let path = log_path_under(&lasterm_dir(DirKind::State)?);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    Ok(path)
}

fn log_path_under(state_dir: &Path) -> PathBuf {
    state_dir.join("logs").join("agent-daemon.jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_daemon_log_is_a_jsonl_file_in_the_state_logs_directory() {
        // Which state directory is platform_dirs' concern and tested there;
        // resolving it here would read, and create inside, the real profile.
        let state = PathBuf::from("state-root").join("lasterm");
        assert_eq!(
            log_path_under(&state),
            state.join("logs").join("agent-daemon.jsonl")
        );
    }
}
