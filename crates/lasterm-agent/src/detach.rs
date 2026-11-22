//! `--daemon --detach`, Windows only: start the daemon outside the job of the
//! SSH session that runs this, so that it outlives the connection (#755).
//!
//! Win32-OpenSSH puts each session's processes in a job that kills them when
//! the session ends, and lets them break away from it. This re-runs the
//! agent's own image with the same arguments, minus `--detach`, broken away
//! from the job, detached from the console, with the null device as stdio,
//! then exits without running a daemon itself.
//!
//! The daemon inherits that null device and no other handle. Started through
//! the account's shell and PowerShell, this launcher holds inheritable handles
//! to the exec channel besides its own stdio; a daemon inheriting one would
//! keep the channel open for as long as it runs, and the hub would never see
//! the launch end.
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
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        UpdateProcThreadAttribute, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP,
        CREATE_NO_WINDOW, DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    let image = std::env::current_exe()?;
    let mut command_line = quote_argument(image.as_os_str());
    for argument in std::env::args_os()
        .skip(1)
        .filter(|argument| argument != "--detach")
    {
        command_line.push(u16::from(b' '));
        command_line.extend(quote_argument(&argument));
    }
    command_line.push(0);

    let nul_name: Vec<u16> = std::ffi::OsStr::new("NUL")
        .encode_wide()
        .chain([0])
        .collect();
    let inheritable = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: a NUL-terminated name and attributes this function owns.
    let nul = unsafe {
        CreateFileW(
            nul_name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &inheritable,
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if nul == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }

    // The one handle the daemon may inherit: the null device, as its stdio.
    let mut size = 0usize;
    // SAFETY: a size query with no list, as documented.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut buffer = vec![0u8; size];
    let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    let handles = [nul];
    // SAFETY: a list in a buffer of the size asked for, holding a pointer to
    // `handles`, which outlives every use of the list below.
    let listed = unsafe {
        InitializeProcThreadAttributeList(list, 1, 0, &mut size) != 0
            && UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(&handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            ) != 0
    };
    let result = if !listed {
        Err(std::io::Error::last_os_error())
    } else {
        // SAFETY: zeroed plain structures, filled as documented.
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = nul;
        startup.StartupInfo.hStdOutput = nul;
        startup.StartupInfo.hStdError = nul;
        startup.lpAttributeList = list;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: a writable NUL-terminated command line, the startup
        // information above, and a process information this function owns.
        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_BREAKAWAY_FROM_JOB
                    | DETACHED_PROCESS
                    | CREATE_NEW_PROCESS_GROUP
                    | CREATE_NO_WINDOW
                    | EXTENDED_STARTUPINFO_PRESENT,
                std::ptr::null(),
                std::ptr::null(),
                &startup.StartupInfo,
                &mut process,
            )
        };
        if created == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: the handles CreateProcessW returned, closed once.
            unsafe {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
            Ok(())
        }
    };
    // SAFETY: the list initialised above, and the handle this function opened.
    unsafe {
        if listed {
            DeleteProcThreadAttributeList(list);
        }
        CloseHandle(nul);
    }
    result
}

/// One argument of a command line, quoted the way the C runtime parses it
/// back: as is when it has no space, tab or quote, else in quotes, with the
/// backslashes before a quote, and at the end, doubled.
#[cfg(windows)]
fn quote_argument(argument: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    const QUOTE: u16 = b'"' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    let units: Vec<u16> = argument.encode_wide().collect();
    let plain = !units.is_empty()
        && !units
            .iter()
            .any(|&unit| unit == u16::from(b' ') || unit == u16::from(b'\t') || unit == QUOTE);
    if plain {
        return units;
    }
    let mut quoted = vec![QUOTE];
    let mut backslashes = 0;
    for unit in units {
        if unit == BACKSLASH {
            backslashes += 1;
            continue;
        }
        let doubled = if unit == QUOTE {
            backslashes * 2 + 1
        } else {
            backslashes
        };
        quoted.extend(std::iter::repeat_n(BACKSLASH, doubled));
        backslashes = 0;
        quoted.push(unit);
    }
    quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2));
    quoted.push(QUOTE);
    quoted
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

#[cfg(all(test, windows))]
mod tests {
    use super::quote_argument;

    fn quoted(argument: &str) -> String {
        String::from_utf16(&quote_argument(std::ffi::OsStr::new(argument))).unwrap()
    }

    // The arguments the daemon is given come back as they were sent.
    // Mutation: quotes or backslashes not doubled.
    #[test]
    fn quotes_arguments_the_way_the_runtime_reads_them() {
        assert_eq!(quoted("--daemon"), "--daemon");
        assert_eq!(
            quoted(r"\\.\pipe\lasterm-agent-me"),
            r"\\.\pipe\lasterm-agent-me"
        );
        assert_eq!(
            quoted(r"C:\Program Files\x\a.exe"),
            r#""C:\Program Files\x\a.exe""#
        );
        assert_eq!(quoted(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(quoted(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quoted(""), r#""""#);
    }
}
