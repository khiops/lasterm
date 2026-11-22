//! `--daemon --detach`, Windows only: start the daemon outside the job of the
//! SSH session that runs this, so that it outlives the connection (#755).
//!
//! Win32-OpenSSH puts each session's processes in a job that kills them when
//! the session ends, and lets them break away from it. This re-runs the
//! agent's own image with the same arguments, minus `--detach`, broken away
//! from the job, detached from the console, with the null device as stdio,
//! then exits without running a daemon itself.
//!
//! stderr carries one `lasterm-detach:` line a hub reads, whatever the exit
//! status the account's shell hands on: `started` (0), `breakaway-refused` (5,
//! followed by a plain line saying why), or `failed <text>` (1).

/// What a hub shows when the session's job forbids breaking away.
#[cfg(windows)]
const BREAKAWAY_REFUSED: &str = "this SSH session's job does not allow a process to break away; the daemon would end with the connection";

/// Start the detached daemon; the process's exit status.
#[cfg(windows)]
pub(crate) fn run() -> i32 {
    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;

    match spawn_detached() {
        Ok(()) => {
            eprintln!("lasterm-detach: started");
            0
        }
        // A job that does not allow breakaway refuses the flag with access
        // denied. Outside a job, the same error is some other failure.
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) && in_a_job() => {
            eprintln!("lasterm-detach: breakaway-refused");
            eprintln!("{BREAKAWAY_REFUSED}");
            5
        }
        Err(error) => {
            let text = error.to_string().replace(['\r', '\n'], " ");
            eprintln!("lasterm-detach: failed {}", text.trim());
            1
        }
    }
}

#[cfg(windows)]
fn spawn_detached() -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
    };

    // This launcher's stdio is the SSH session's exec channel. A daemon that
    // inherited it would hold the channel open for as long as it runs, and
    // the hub would never see this launcher end.
    keep_own_stdio_from_children();

    let image = std::env::current_exe()?;
    let arguments = std::env::args_os()
        .skip(1)
        .filter(|argument| argument != "--detach");
    std::process::Command::new(image)
        .args(arguments)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(
            CREATE_BREAKAWAY_FROM_JOB
                | DETACHED_PROCESS
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_NO_WINDOW,
        )
        .spawn()
        .map(drop)
}

/// Mark this process's standard handles as not inherited.
#[cfg(windows)]
fn keep_own_stdio_from_children() {
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: standard handles of this process; clearing the inherit flag
        // of one that is absent or invalid fails harmlessly.
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Whether this process runs inside a job. A failed query counts as not.
#[cfg(windows)]
fn in_a_job() -> bool {
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut in_job = 0;
    // SAFETY: the pseudo-handle of this process, no job handle (any job), and
    // a BOOL this function owns.
    let ok = unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) };
    ok != 0 && in_job != 0
}

/// The usage error `--detach` gives outside Windows.
pub(crate) const POSIX_REFUSAL: &str =
    "--detach is for Windows; a POSIX launch detaches through the shell";
