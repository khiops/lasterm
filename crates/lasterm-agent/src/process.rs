#[cfg(unix)]
use std::path::Path;

/// Poll the foreground process name for a given PID.
/// Returns the process name (e.g. "vim", "bash") or None if unavailable.
///
/// Platform-specific:
/// - Linux: reads /proc/{pid}/comm (preferred) or /proc/{pid}/cmdline
/// - macOS: uses `ps -p {pid} -o comm=`
/// - Windows: uses `QueryFullProcessImageNameW` (native Win32 API, no subprocess)
pub async fn get_process_title(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    return get_title_linux(pid).await;

    #[cfg(target_os = "macos")]
    return get_title_macos(pid).await;

    #[cfg(target_os = "windows")]
    return get_title_windows(pid).await;

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    return None;
}

#[cfg(target_os = "linux")]
async fn get_title_linux(pid: u32) -> Option<String> {
    // Try /proc/{pid}/comm first (just the process name, no args)
    let comm_path = format!("/proc/{}/comm", pid);
    if let Ok(comm) = tokio::fs::read_to_string(&comm_path).await {
        let name = comm.trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    // Fallback: /proc/{pid}/cmdline (NUL-separated, first element is the command)
    let cmdline_path = format!("/proc/{}/cmdline", pid);
    if let Ok(data) = tokio::fs::read(&cmdline_path).await {
        if let Some(first) = data.split(|&b| b == 0).next() {
            let s = String::from_utf8_lossy(first);
            // Extract just the binary name from the full path
            let name = Path::new(s.as_ref())
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| s.to_string());
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
async fn get_title_macos(pid: u32) -> Option<String> {
    let output = tokio::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // Extract just the binary name from the full path
        let short = Path::new(&name)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(name);
        if !short.is_empty() {
            return Some(short);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn get_title_windows_native(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 260]; // MAX_PATH
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        // Extract filename from full path
        // e.g. "C:\Program Files\PowerShell\7\pwsh.exe" → "pwsh.exe"
        path.rsplit('\\').next().map(|s| s.to_string())
    }
}

#[cfg(target_os = "windows")]
async fn get_title_windows(pid: u32) -> Option<String> {
    get_title_windows_native(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_own_process_title() {
        // Our own PID should have a valid process name
        let pid = std::process::id();
        let title = get_process_title(pid).await;
        assert!(title.is_some(), "should be able to read own process title");
        let name = title.unwrap();
        assert!(!name.is_empty());
    }

    #[tokio::test]
    async fn test_nonexistent_pid() {
        // PID 99999999 almost certainly doesn't exist
        let title = get_process_title(99999999).await;
        assert!(title.is_none());
    }
}
