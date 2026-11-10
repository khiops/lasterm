//! A terminal's working directory as it is now, not as it started (#834).
//!
//! The shell's own report wins while it keeps reporting: OSC 7, OSC 9;9,
//! OSC 633;P;Cwd= or OSC 1337;CurrentDir= in its output, parsed by
//! [`crate::headless`]. Otherwise the agent reads the shell's process: its
//! directory under `/proc` on Linux, its PEB for `cmd.exe` on Windows.
//! Otherwise the directory is unknown.
//!
//! A directory is user content: nothing here logs one, at any level.

use crate::protocol::AgentToHub;
use serde::Serialize;

/// The longest directory reported, in bytes. A report longer than this is not
/// a directory anyone typed: it is dropped.
pub(crate) const MAX_DIR_LEN: usize = 4096;

/// Where the directory a CWD_CHANGE carries came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CwdSource {
    /// The shell said so in its output. With `cwd: null`, it said it is on
    /// another host (`other_host`).
    Shell,
    /// Read from the shell's process. With `cwd: null`, the process cannot
    /// tell: its directory is gone, it cannot be read, or it does not follow
    /// the shell's (PowerShell).
    Process,
    /// The directory the agent started the terminal in, before any read.
    Start,
}

/// What a shell reported in its output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ShellReport {
    /// It is in this directory, on this host.
    Dir(String),
    /// It is on another host, by this name: a session nested in the terminal,
    /// over ssh most often. Its directory there is not one of this host's.
    OtherHost(String),
}

/// What reading a shell's process found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProcessRead {
    /// Its directory, when the process can tell.
    pub cwd: Option<String>,
    /// Whether the shell is at its prompt: false while a program it started
    /// holds the terminal. None where that cannot be read (Windows).
    pub at_prompt: Option<bool>,
    /// The program holding the terminal, when not the shell.
    pub foreground: Option<String>,
}

/// What a CWD_CHANGE says about a terminal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CwdState {
    pub cwd: Option<String>,
    pub source: CwdSource,
    pub at_prompt: Option<bool>,
    pub foreground: Option<String>,
    pub other_host: Option<String>,
}

impl CwdState {
    pub(crate) fn into_message(self, channel_id: String) -> AgentToHub {
        AgentToHub::CwdChange {
            channel_id,
            cwd: self.cwd,
            source: self.source,
            at_prompt: self.at_prompt,
            foreground: self.foreground,
            other_host: self.other_host,
        }
    }
}

/// A shell's report, and what the process read said once it was made.
struct ShellEntry {
    report: ShellReport,
    /// The first process read after the report. A shell that keeps reporting
    /// reports every change: the process moving away from this without a new
    /// report, or the program that made it leaving the foreground, means the
    /// report no longer speaks for the terminal.
    baseline: Option<ProcessRead>,
}

/// One terminal's directory: what was reported and read, and what was sent.
pub(crate) struct CwdTracker {
    /// The directory the terminal started in, when its process directory
    /// follows its shell's; None otherwise.
    start: Option<String>,
    /// Whether the program's process directory follows its shell's.
    follows: bool,
    shell: Option<ShellEntry>,
    process: Option<ProcessRead>,
    sent: Option<CwdState>,
}

impl CwdTracker {
    /// A terminal running `program`, started in `start`.
    pub(crate) fn new(program: &str, start: Option<String>) -> Self {
        let follows = directory_follows(program);
        Self {
            start: if follows { start } else { None },
            follows,
            shell: None,
            process: None,
            sent: None,
        }
    }

    /// The shell reported where it is. It wins over the process read until
    /// that read says the shell has stopped reporting.
    pub(crate) fn shell_reported(&mut self, report: ShellReport) {
        self.shell = Some(ShellEntry {
            report,
            baseline: None,
        });
    }

    /// The shell's process was read.
    pub(crate) fn process_read(&mut self, read: ProcessRead) {
        if let Some(entry) = &mut self.shell {
            match &entry.baseline {
                None => entry.baseline = Some(read.clone()),
                Some(baseline) => {
                    let moved = baseline.cwd != read.cwd;
                    let program_left =
                        baseline.at_prompt == Some(false) && read.at_prompt == Some(true);
                    if moved || program_left {
                        self.shell = None;
                    }
                }
            }
        }
        self.process = Some(read);
    }

    /// What the terminal's directory is now.
    pub(crate) fn state(&self) -> CwdState {
        let (at_prompt, foreground) = match &self.process {
            Some(read) => (read.at_prompt, read.foreground.clone()),
            None => (None, None),
        };
        let (cwd, source, other_host) = match (&self.shell, &self.process) {
            (Some(entry), _) => match &entry.report {
                ShellReport::Dir(dir) => (Some(dir.clone()), CwdSource::Shell, None),
                ShellReport::OtherHost(host) => (None, CwdSource::Shell, Some(host.clone())),
            },
            (None, Some(read)) => (read.cwd.clone(), CwdSource::Process, None),
            (None, None) if self.follows => (self.start.clone(), CwdSource::Start, None),
            (None, None) => (None, CwdSource::Process, None),
        };
        CwdState {
            cwd,
            source,
            at_prompt,
            foreground,
            other_host,
        }
    }

    /// The state to send: whenever it differs from the last one sent, and
    /// always when `answering` a CWD_QUERY.
    pub(crate) fn change_to_send(&mut self, answering: bool) -> Option<CwdState> {
        let state = self.state();
        if !answering && self.sent.as_ref() == Some(&state) {
            return None;
        }
        self.sent = Some(state.clone());
        Some(state)
    }
}

/// The file name of a program, lowercased, without `.exe`.
fn program_stem(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.to_ascii_lowercase();
    match name.strip_suffix(".exe") {
        Some(stem) => stem.to_owned(),
        None => name,
    }
}

/// Whether reading this program's process directory says where its shell is.
///
/// PowerShell's does not: `Set-Location` leaves the process directory where it
/// was, so the read would be wrong rather than missing. It reports its
/// directory through its prompt instead (OSC 9;9 or OSC 7, #839). On Windows
/// only `cmd.exe` is read, as #834 specifies.
pub(crate) fn directory_follows(program: &str) -> bool {
    let stem = program_stem(program);
    if cfg!(windows) {
        stem == "cmd"
    } else {
        !matches!(stem.as_str(), "pwsh" | "powershell")
    }
}

/// A reported directory, if it can be one: not empty, no control character,
/// not longer than [`MAX_DIR_LEN`].
pub(crate) fn plausible_dir(dir: &str) -> bool {
    !dir.is_empty() && dir.len() <= MAX_DIR_LEN && !dir.chars().any(char::is_control)
}

/// This host's name, as an OSC 7 `file://<host>/` names it. Read once.
pub(crate) fn local_host_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(read_host_name)
}

#[cfg(unix)]
fn read_host_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname writes at most
    // that many bytes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(windows)]
fn read_host_name() -> String {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW,
    };
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    // SAFETY: the buffer is valid for `len` UTF-16 units, which the call
    // updates to the number it wrote.
    let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) };
    if ok == 0 {
        return std::env::var("COMPUTERNAME").unwrap_or_default();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

#[cfg(not(any(unix, windows)))]
fn read_host_name() -> String {
    String::new()
}

/// Whether an OSC 7 host names this one: empty, `localhost`, this host's
/// name, or a name whose first label is this host's (`pc.lan` for `pc`).
pub(crate) fn is_local_host(host: &str, local: &str) -> bool {
    if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if local.is_empty() {
        return false;
    }
    let first = |name: &str| name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    host.eq_ignore_ascii_case(local) || first(host) == first(local)
}

/// Read the shell's process: its directory, and whether it is at its prompt.
/// Never fails: what cannot be read is unknown.
pub(crate) async fn read_process(pid: u32) -> ProcessRead {
    tokio::task::spawn_blocking(move || read_process_blocking(pid))
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn read_process_blocking(pid: u32) -> ProcessRead {
    linux::read(pid)
}

#[cfg(all(windows, target_pointer_width = "64"))]
fn read_process_blocking(pid: u32) -> ProcessRead {
    windows::read(pid)
}

#[cfg(not(any(target_os = "linux", all(windows, target_pointer_width = "64"))))]
fn read_process_blocking(_pid: u32) -> ProcessRead {
    ProcessRead::default()
}

/// The process group and the terminal's foreground process group, from the
/// text of `/proc/<pid>/stat`. The command name, in parentheses, can hold
/// spaces and parentheses itself: the fields are counted from the last `)`.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn stat_groups(stat: &str) -> Option<(i32, i32)> {
    let after = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // state ppid pgrp session tty_nr tpgid
    let pgrp = fields.get(2)?.parse().ok()?;
    let tpgid = fields.get(5)?.parse().ok()?;
    Some((pgrp, tpgid))
}

/// A `/proc/<pid>/cwd` link's target as a directory: None when the directory
/// was deleted, which the kernel marks with a ` (deleted)` suffix. A
/// directory whose own name ends that way still exists, and is kept.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn live_dir(target: &str, exists: impl Fn(&str) -> bool) -> Option<String> {
    if target.ends_with(" (deleted)") && !exists(target) {
        return None;
    }
    Some(target.to_owned())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{directory_follows, live_dir, plausible_dir, stat_groups, ProcessRead};
    use std::path::Path;

    fn comm(pid: i32) -> Option<String> {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        let name = name.trim();
        (!name.is_empty()).then(|| name.to_owned())
    }

    pub(super) fn read(pid: u32) -> ProcessRead {
        let Ok(pid) = i32::try_from(pid) else {
            return ProcessRead::default();
        };
        let Some(name) = comm(pid) else {
            // Gone, or never there: nothing to read.
            return ProcessRead::default();
        };
        let (at_prompt, foreground) = match std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .as_deref()
            .and_then(stat_groups)
        {
            // No foreground group: no controlling terminal to say anything of.
            Some((_, tpgid)) if tpgid <= 0 => (None, None),
            Some((pgrp, tpgid)) if pgrp == tpgid => (Some(true), None),
            Some((_, tpgid)) => (Some(false), comm(tpgid)),
            None => (None, None),
        };
        let cwd = if directory_follows(&name) {
            std::fs::read_link(format!("/proc/{pid}/cwd"))
                .ok()
                .and_then(|target| target.to_str().map(str::to_owned))
                .and_then(|target| live_dir(&target, |dir| Path::new(dir).exists()))
                .filter(|dir| plausible_dir(dir))
        } else {
            None
        };
        ProcessRead {
            cwd,
            at_prompt,
            foreground,
        }
    }
}

/// `cmd.exe`'s directory, read from its process environment block: the
/// `CurrentDirectory` of its `RTL_USER_PROCESS_PARAMETERS`, which
/// `SetCurrentDirectory` updates. The 32-bit PEB for a WOW64 shell.
#[cfg(all(windows, target_pointer_width = "64"))]
mod windows {
    use super::{directory_follows, plausible_dir, ProcessRead};
    use std::ffi::c_void;
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessBasicInformation, ProcessWow64Information,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_BASIC_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    /// `PEB.ProcessParameters`, 64-bit and 32-bit.
    const PARAMETERS_IN_PEB: usize = 0x20;
    const PARAMETERS_IN_PEB32: usize = 0x10;
    /// `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath`, a
    /// `UNICODE_STRING`: its length in bytes, then its buffer's address.
    const CURRENT_DIRECTORY: usize = 0x38;
    const CURRENT_DIRECTORY32: usize = 0x24;
    /// The most a `UNICODE_STRING` holds, in bytes.
    const MAX_UNICODE_BYTES: usize = 0xFFFE;

    struct Process(HANDLE);

    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by OpenProcess and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Process {
        fn open(pid: u32) -> Option<Self> {
            // SAFETY: plain call; a null handle is checked.
            let handle =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid) };
            (!handle.is_null()).then_some(Self(handle))
        }

        fn image_name(&self) -> Option<String> {
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            // SAFETY: the buffer is valid for `size` UTF-16 units.
            let ok = unsafe { QueryFullProcessImageNameW(self.0, 0, buf.as_mut_ptr(), &mut size) };
            (ok != 0).then(|| String::from_utf16_lossy(&buf[..size as usize]))
        }

        fn read(&self, address: usize, buf: &mut [u8]) -> Option<()> {
            let mut read = 0usize;
            // SAFETY: `buf` is valid for its length; the address is the other
            // process's and ReadProcessMemory checks it.
            let ok = unsafe {
                ReadProcessMemory(
                    self.0,
                    address as *const c_void,
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    &mut read,
                )
            };
            (ok != 0 && read == buf.len()).then_some(())
        }

        fn read_u32(&self, address: usize) -> Option<u32> {
            let mut buf = [0u8; 4];
            self.read(address, &mut buf)?;
            Some(u32::from_le_bytes(buf))
        }

        fn read_u64(&self, address: usize) -> Option<u64> {
            let mut buf = [0u8; 8];
            self.read(address, &mut buf)?;
            Some(u64::from_le_bytes(buf))
        }

        /// The 32-bit PEB's address for a WOW64 process; None for a native one.
        fn peb32(&self) -> Option<usize> {
            let mut peb32: usize = 0;
            // SAFETY: the buffer is a ULONG_PTR, as ProcessWow64Information returns.
            let status = unsafe {
                NtQueryInformationProcess(
                    self.0,
                    ProcessWow64Information,
                    (&mut peb32 as *mut usize).cast(),
                    std::mem::size_of::<usize>() as u32,
                    std::ptr::null_mut(),
                )
            };
            (status >= 0 && peb32 != 0).then_some(peb32)
        }

        fn peb(&self) -> Option<usize> {
            let mut info = PROCESS_BASIC_INFORMATION::default();
            // SAFETY: the buffer is a PROCESS_BASIC_INFORMATION, as asked.
            let status = unsafe {
                NtQueryInformationProcess(
                    self.0,
                    ProcessBasicInformation,
                    (&mut info as *mut PROCESS_BASIC_INFORMATION).cast(),
                    std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            };
            (status >= 0 && !info.PebBaseAddress.is_null()).then_some(info.PebBaseAddress as usize)
        }

        /// The UTF-16 text of a `UNICODE_STRING` of `len` bytes at `buffer`.
        fn read_text(&self, buffer: usize, len: usize) -> Option<String> {
            if buffer == 0 || len == 0 || !len.is_multiple_of(2) || len > MAX_UNICODE_BYTES {
                return None;
            }
            let mut bytes = vec![0u8; len];
            self.read(buffer, &mut bytes)?;
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect();
            String::from_utf16(&units).ok()
        }

        fn current_directory(&self) -> Option<String> {
            if let Some(peb32) = self.peb32() {
                let parameters = self.read_u32(peb32 + PARAMETERS_IN_PEB32)? as usize;
                let dos_path = parameters + CURRENT_DIRECTORY32;
                let len = self.read_u32(dos_path)? & 0xFFFF;
                let buffer = self.read_u32(dos_path + 4)? as usize;
                return self.read_text(buffer, len as usize);
            }
            let peb = self.peb()?;
            let parameters = self.read_u64(peb + PARAMETERS_IN_PEB)? as usize;
            let dos_path = parameters + CURRENT_DIRECTORY;
            let len = self.read_u32(dos_path)? & 0xFFFF;
            let buffer = self.read_u64(dos_path + 8)? as usize;
            self.read_text(buffer, len as usize)
        }
    }

    /// `C:\Windows\` as `C:\Windows`; a drive's root keeps its backslash.
    pub(super) fn without_trailing_separator(dir: String) -> String {
        let is_drive_root = dir.len() == 3 && dir.ends_with(":\\");
        match dir.strip_suffix('\\') {
            Some(trimmed) if !is_drive_root && !trimmed.is_empty() => trimmed.to_owned(),
            _ => dir,
        }
    }

    pub(super) fn read(pid: u32) -> ProcessRead {
        let cwd = Process::open(pid).and_then(|process| {
            // Only a program whose directory follows its shell's is read:
            // cmd.exe. Anything else, PowerShell first, is unknown.
            if !directory_follows(&process.image_name()?) {
                return None;
            }
            process
                .current_directory()
                .map(without_trailing_separator)
                .filter(|dir| plausible_dir(dir))
        });
        ProcessRead {
            cwd,
            at_prompt: None,
            foreground: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(cwd: Option<&str>, at_prompt: Option<bool>) -> ProcessRead {
        ProcessRead {
            cwd: cwd.map(str::to_owned),
            at_prompt,
            foreground: None,
        }
    }

    fn shell_program() -> &'static str {
        if cfg!(windows) {
            "C:\\Windows\\System32\\cmd.exe"
        } else {
            "/bin/bash"
        }
    }

    #[test]
    fn a_terminal_starts_in_its_start_directory() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/start".into()));
        let state = tracker
            .change_to_send(false)
            .expect("the first state is sent");
        assert_eq!(state.cwd.as_deref(), Some("/start"));
        assert_eq!(state.source, CwdSource::Start);
        assert_eq!(tracker.change_to_send(false), None, "nothing changed");
    }

    /// PowerShell's process directory stays where it started: its start
    /// directory would be wrong as soon as it moves, and is never reported.
    #[test]
    fn powershell_is_unknown_never_its_start_directory() {
        for program in [
            "pwsh",
            "pwsh.exe",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ] {
            let mut tracker = CwdTracker::new(program, Some("/start".into()));
            let state = tracker.change_to_send(false).unwrap();
            assert_eq!(state.cwd, None, "{program}");
            assert_eq!(state.source, CwdSource::Process, "{program}");
            tracker.process_read(read(None, None));
            assert_eq!(tracker.change_to_send(false), None, "{program}");
        }
        let mut tracker = CwdTracker::new("powershell.exe", Some("/start".into()));
        assert_eq!(tracker.state().cwd, None);
        // Its prompt can say where it is.
        tracker.shell_reported(ShellReport::Dir("C:\\Users\\me".into()));
        let state = tracker.change_to_send(false).unwrap();
        assert_eq!(state.cwd.as_deref(), Some("C:\\Users\\me"));
        assert_eq!(state.source, CwdSource::Shell);
    }

    #[test]
    fn only_cmd_is_read_on_windows_and_all_but_powershell_on_linux() {
        assert!(directory_follows("cmd.exe"));
        assert!(directory_follows("C:\\Windows\\SysWOW64\\CMD.EXE"));
        assert!(!directory_follows("pwsh.exe"));
        assert!(!directory_follows("/usr/bin/pwsh"));
        assert!(!directory_follows("powershell"));
        assert_eq!(directory_follows("/bin/bash"), cfg!(not(windows)));
        assert_eq!(directory_follows("nu.exe"), cfg!(not(windows)));
    }

    #[test]
    fn a_process_read_replaces_the_start_and_is_sent_on_change_only() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/start".into()));
        tracker.change_to_send(false);
        tracker.process_read(read(Some("/start"), Some(true)));
        let state = tracker.change_to_send(false).expect("its source changed");
        assert_eq!(state.source, CwdSource::Process);
        assert_eq!(state.at_prompt, Some(true));
        tracker.process_read(read(Some("/start"), Some(true)));
        assert_eq!(tracker.change_to_send(false), None);
        tracker.process_read(read(Some("/tmp"), Some(true)));
        assert_eq!(
            tracker.change_to_send(false).unwrap().cwd.as_deref(),
            Some("/tmp")
        );
        tracker.process_read(ProcessRead {
            cwd: Some("/tmp".into()),
            at_prompt: Some(false),
            foreground: Some("vim".into()),
        });
        let state = tracker
            .change_to_send(false)
            .expect("a program took the terminal");
        assert_eq!(state.at_prompt, Some(false));
        assert_eq!(state.foreground.as_deref(), Some("vim"));
        tracker.process_read(read(Some("/tmp"), Some(true)));
        let state = tracker.change_to_send(false).expect("back at the prompt");
        assert_eq!((state.at_prompt, state.foreground), (Some(true), None));
    }

    #[test]
    fn a_query_is_answered_even_when_nothing_changed() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/start".into()));
        tracker.change_to_send(false);
        assert_eq!(tracker.change_to_send(false), None);
        assert_eq!(
            tracker.change_to_send(true).unwrap().cwd.as_deref(),
            Some("/start")
        );
    }

    #[test]
    fn the_shell_wins_over_the_process_while_it_keeps_reporting() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/start".into()));
        tracker.process_read(read(Some("/real/dir"), Some(true)));
        tracker.shell_reported(ShellReport::Dir("/link/dir".into()));
        let state = tracker.change_to_send(false).unwrap();
        assert_eq!(state.cwd.as_deref(), Some("/link/dir"));
        assert_eq!(state.source, CwdSource::Shell);
        // Reads that agree it has not moved leave the report standing.
        tracker.process_read(read(Some("/real/dir"), Some(true)));
        tracker.process_read(read(Some("/real/dir"), Some(true)));
        assert_eq!(tracker.change_to_send(false), None);
        // It reports the next move itself.
        tracker.shell_reported(ShellReport::Dir("/link/other".into()));
        tracker.process_read(read(Some("/real/other"), Some(true)));
        assert_eq!(
            tracker.change_to_send(false).unwrap().cwd.as_deref(),
            Some("/link/other")
        );
    }

    #[test]
    fn a_shell_that_stops_reporting_gives_way_to_the_process() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/start".into()));
        tracker.shell_reported(ShellReport::Dir("/reported".into()));
        tracker.process_read(read(Some("/reported"), Some(true)));
        tracker.change_to_send(false);
        // The process moved, and the shell said nothing of it.
        tracker.process_read(read(Some("/elsewhere"), Some(true)));
        let state = tracker.change_to_send(false).unwrap();
        assert_eq!(state.cwd.as_deref(), Some("/elsewhere"));
        assert_eq!(state.source, CwdSource::Process);
    }

    #[test]
    fn a_report_made_by_a_program_ends_with_it() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/home".into()));
        tracker.process_read(read(Some("/home"), Some(true)));
        // ssh holds the terminal, and the remote shell reports its host.
        tracker.process_read(ProcessRead {
            cwd: Some("/home".into()),
            at_prompt: Some(false),
            foreground: Some("ssh".into()),
        });
        tracker.shell_reported(ShellReport::OtherHost("server".into()));
        tracker.process_read(ProcessRead {
            cwd: Some("/home".into()),
            at_prompt: Some(false),
            foreground: Some("ssh".into()),
        });
        let state = tracker.change_to_send(false).unwrap();
        assert_eq!(state.cwd, None);
        assert_eq!(state.source, CwdSource::Shell);
        assert_eq!(state.other_host.as_deref(), Some("server"));
        assert_eq!(state.foreground.as_deref(), Some("ssh"));
        // ssh ended: the local shell is back, at the directory it never left.
        tracker.process_read(read(Some("/home"), Some(true)));
        let state = tracker.change_to_send(false).unwrap();
        assert_eq!(state.cwd.as_deref(), Some("/home"));
        assert_eq!(state.source, CwdSource::Process);
        assert_eq!(state.other_host, None);
    }

    /// A directory deleted under the shell, or a process that can no longer
    /// be read, is unknown rather than the last directory seen.
    #[test]
    fn a_directory_that_cannot_be_read_is_unknown() {
        let mut tracker = CwdTracker::new(shell_program(), Some("/start".into()));
        tracker.process_read(read(Some("/start"), Some(true)));
        tracker.change_to_send(false);
        tracker.process_read(read(None, None));
        let state = tracker.change_to_send(false).unwrap();
        assert_eq!(state.cwd, None);
        assert_eq!(state.source, CwdSource::Process);
    }

    #[test]
    fn stat_groups_are_counted_from_the_last_parenthesis() {
        let stat = "4521 (my (odd) sh) S 4500 4521 4521 34816 4600 4194560 0 0";
        assert_eq!(stat_groups(stat), Some((4521, 4600)));
        assert_eq!(stat_groups("12 (bash) S 1 12 12 0 -1 0"), Some((12, -1)));
        assert_eq!(stat_groups("garbage"), None);
        assert_eq!(stat_groups("1 (x) S 0"), None);
    }

    #[test]
    fn a_deleted_directory_is_gone_and_one_named_so_is_not() {
        assert_eq!(live_dir("/tmp/x (deleted)", |_| false), None);
        assert_eq!(
            live_dir("/tmp/x (deleted)", |_| true).as_deref(),
            Some("/tmp/x (deleted)")
        );
        assert_eq!(live_dir("/tmp/x", |_| false).as_deref(), Some("/tmp/x"));
    }

    #[test]
    fn local_hosts_are_told_from_others() {
        assert!(is_local_host("", "pc"));
        assert!(is_local_host("localhost", "pc"));
        assert!(is_local_host("PC", "pc"));
        assert!(is_local_host("pc.lan", "pc"));
        assert!(is_local_host("pc", "pc.example.com"));
        assert!(!is_local_host("server", "pc"));
        assert!(!is_local_host("server.lan", "pc.lan"));
        assert!(!is_local_host("server", ""));
    }

    #[test]
    fn this_host_has_a_name() {
        assert!(!local_host_name().is_empty());
        assert!(is_local_host(local_host_name(), local_host_name()));
    }

    #[test]
    fn implausible_directories_are_refused() {
        assert!(plausible_dir("/tmp"));
        assert!(plausible_dir("C:\\Users\\me"));
        assert!(!plausible_dir(""));
        assert!(!plausible_dir("/tmp\nrm -rf"));
        assert!(!plausible_dir(&"a".repeat(MAX_DIR_LEN + 1)));
    }

    #[test]
    fn cwd_change_puts_null_on_the_wire_and_leaves_out_what_it_does_not_know() {
        let state = CwdState {
            cwd: None,
            source: CwdSource::Process,
            at_prompt: None,
            foreground: None,
            other_host: None,
        };
        let bytes = rmp_serde::to_vec_named(&state.into_message("ch-1".into())).unwrap();
        let decoded: serde_json::Value = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(
            decoded,
            serde_json::json!({
                "type": "CWD_CHANGE", "channel_id": "ch-1", "cwd": null, "source": "process",
            })
        );
        let state = CwdState {
            cwd: Some("/tmp".into()),
            source: CwdSource::Shell,
            at_prompt: Some(false),
            foreground: Some("vim".into()),
            other_host: None,
        };
        let bytes = rmp_serde::to_vec_named(&state.into_message("ch-1".into())).unwrap();
        let decoded: serde_json::Value = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded["cwd"], "/tmp");
        assert_eq!(decoded["source"], "shell");
        assert_eq!(decoded["at_prompt"], false);
        assert_eq!(decoded["foreground"], "vim");
    }

    #[tokio::test]
    async fn a_process_that_is_gone_reads_as_unknown() {
        assert_eq!(read_process(99_999_999).await, ProcessRead::default());
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    use crate::owner::OwnerId;
    use crate::pty::PtyManager;
    use std::time::Duration;

    fn shell() -> &'static str {
        if std::path::Path::new("/bin/bash").exists() {
            "/bin/bash"
        } else {
            "/bin/sh"
        }
    }

    fn args() -> Vec<String> {
        if shell() == "/bin/bash" {
            vec!["--norc".into(), "--noprofile".into()]
        } else {
            Vec::new()
        }
    }

    /// Read `pid` until `done` says so, for up to ten seconds.
    async fn read_until(pid: u32, done: impl Fn(&ProcessRead) -> bool) -> ProcessRead {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let read = read_process(pid).await;
            if done(&read) || tokio::time::Instant::now() > deadline {
                return read;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    struct Terminal {
        manager: PtyManager,
        pid: u32,
    }

    impl Terminal {
        async fn start(dir: &std::path::Path) -> Self {
            let mut manager = PtyManager::new();
            let (_, pid) = manager
                .spawn(
                    OwnerId::stdio(),
                    Some("cwd".into()),
                    shell(),
                    &args(),
                    Some(dir.to_str().unwrap()),
                    None,
                    80,
                    24,
                )
                .await
                .expect("spawn a shell");
            Self { manager, pid }
        }

        fn type_line(&self, line: &str) {
            let channel = self.manager.channels.get("cwd").expect("the terminal");
            channel.input.offer(format!("{line}\n").into_bytes());
        }
    }

    impl Drop for Terminal {
        fn drop(&mut self) {
            if let Some(process) = self.manager.remove("cwd") {
                let _ = process.kill_tree();
            }
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lasterm-cwd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// No shell setup at all: `cd` is followed through `/proc`, and a
    /// program in the foreground is named until the prompt is back.
    #[tokio::test]
    async fn a_shell_is_followed_through_proc() {
        let start = temp_dir("follow");
        let terminal = Terminal::start(&start).await;
        let first = read_until(terminal.pid, |r| r.at_prompt == Some(true)).await;
        assert_eq!(first.cwd.as_deref(), start.to_str());
        assert_eq!(
            (first.at_prompt, first.foreground.as_deref()),
            (Some(true), None)
        );

        let tmp = std::path::Path::new("/tmp").canonicalize().unwrap();
        terminal.type_line("cd /tmp");
        let moved = read_until(terminal.pid, |r| r.cwd.as_deref() == tmp.to_str()).await;
        assert_eq!(moved.cwd.as_deref(), tmp.to_str());

        terminal.type_line("sleep 30");
        // The child the shell forks for sleep may hold the terminal before
        // it execs, still named after the shell: wait for sleep itself (#919).
        let busy = read_until(terminal.pid, |r| {
            r.at_prompt == Some(false) && r.foreground.as_deref() == Some("sleep")
        })
        .await;
        assert_eq!(busy.at_prompt, Some(false));
        assert_eq!(busy.foreground.as_deref(), Some("sleep"));
        assert_eq!(busy.cwd.as_deref(), tmp.to_str(), "the shell has not moved");

        // Ctrl-C ends it; the shell is back at its prompt.
        let channel = terminal.manager.channels.get("cwd").unwrap();
        channel.input.offer(vec![0x03]);
        let back = read_until(terminal.pid, |r| r.at_prompt == Some(true)).await;
        assert_eq!((back.at_prompt, back.foreground), (Some(true), None));
        drop(terminal);
        let _ = std::fs::remove_dir_all(&start);
    }

    #[tokio::test]
    async fn a_deleted_directory_reads_as_unknown() {
        let start = temp_dir("deleted");
        let terminal = Terminal::start(&start).await;
        let first = read_until(terminal.pid, |r| r.cwd.is_some()).await;
        assert_eq!(first.cwd.as_deref(), start.to_str());
        std::fs::remove_dir(&start).expect("remove the shell's directory");
        let gone = read_until(terminal.pid, |r| r.cwd.is_none()).await;
        assert_eq!(gone.cwd, None);
        assert_eq!(gone.at_prompt, Some(true), "the rest is still read");
    }

    /// A process of another user, as an elevated shell is: nothing to read,
    /// and no error.
    #[tokio::test]
    async fn another_users_process_is_unreadable_without_error() {
        // SAFETY: plain call.
        if unsafe { libc::geteuid() } == 0 {
            return; // root reads everything
        }
        assert_eq!(read_process(1).await.cwd, None);
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    struct Killed(Child);

    impl Drop for Killed {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn start(program: &str, args: &[&str], dir: &std::path::Path) -> Killed {
        Killed(
            Command::new(program)
                .args(args)
                .current_dir(dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .unwrap_or_else(|e| panic!("start {program}: {e}")),
        )
    }

    async fn read_until(pid: u32, done: impl Fn(&ProcessRead) -> bool) -> ProcessRead {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let read = read_process(pid).await;
            if done(&read) || tokio::time::Instant::now() > deadline {
                return read;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The same directory, however each side spells it: a short name, the
    /// case of a letter.
    fn same_dir(read: &ProcessRead, dir: &std::path::Path) -> bool {
        read.cwd.as_deref().is_some_and(|cwd| {
            match (std::fs::canonicalize(cwd), std::fs::canonicalize(dir)) {
                (Ok(a), Ok(b)) => a == b,
                _ => cwd.eq_ignore_ascii_case(dir.to_str().unwrap()),
            }
        })
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lasterm-cwd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `cmd.exe`'s directory, through its PEB: where it started, then where
    /// `cd` took it.
    async fn follows_cmd(cmd: &str, name: &str) {
        let start_dir = temp_dir(name);
        let mut shell = start(cmd, &["/d", "/q", "/k"], &start_dir);
        let pid = shell.0.id();
        let first = read_until(pid, |r| same_dir(r, &start_dir)).await;
        assert!(same_dir(&first, &start_dir), "{first:?}");
        assert_eq!((first.at_prompt, first.foreground), (None, None));

        let windows = std::path::Path::new("C:\\Windows");
        let stdin = shell.0.stdin.as_mut().unwrap();
        stdin.write_all(b"cd /d C:\\Windows\r\n").unwrap();
        stdin.flush().unwrap();
        let moved = read_until(pid, |r| same_dir(r, windows)).await;
        assert!(same_dir(&moved, windows), "{moved:?}");

        // A drive's root keeps its separator.
        stdin.write_all(b"cd \\\r\n").unwrap();
        stdin.flush().unwrap();
        let root = std::path::Path::new("C:\\");
        let at_root = read_until(pid, |r| same_dir(r, root)).await;
        assert!(same_dir(&at_root, root), "{at_root:?}");
        drop(shell);
        let _ = std::fs::remove_dir_all(&start_dir);
    }

    #[tokio::test]
    async fn cmd_is_followed_through_its_peb() {
        follows_cmd("C:\\Windows\\System32\\cmd.exe", "cmd64").await;
    }

    /// A 32-bit `cmd.exe` keeps its directory in its 32-bit PEB.
    #[tokio::test]
    async fn a_wow64_cmd_is_followed_through_its_32_bit_peb() {
        let wow64 = "C:\\Windows\\SysWOW64\\cmd.exe";
        if !std::path::Path::new(wow64).exists() {
            return; // no 32-bit subsystem on this machine
        }
        follows_cmd(wow64, "cmd32").await;
    }

    /// PowerShell is never read: `Set-Location` leaves its process directory
    /// behind, so what the read would give is its start directory.
    #[tokio::test]
    async fn powershell_is_not_read() {
        let start_dir = temp_dir("pwsh");
        let shell = start(
            "powershell.exe",
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 30",
            ],
            &start_dir,
        );
        // Long enough for it to be running, whatever it reads first.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let read = read_process(shell.0.id()).await;
        assert_eq!(read, ProcessRead::default());
        drop(shell);
        let _ = std::fs::remove_dir_all(&start_dir);
    }

    #[test]
    fn a_trailing_separator_goes_except_at_a_drive_root() {
        use super::windows::without_trailing_separator as trim;
        assert_eq!(trim("C:\\Windows\\".into()), "C:\\Windows");
        assert_eq!(trim("C:\\".into()), "C:\\");
        assert_eq!(trim("\\\\server\\share\\".into()), "\\\\server\\share");
        assert_eq!(trim("C:\\Windows".into()), "C:\\Windows");
    }
}
