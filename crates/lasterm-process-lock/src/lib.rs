//! A non-blocking, kernel-released exclusive process lock.
//!
//! `ProcessLock` owns the file descriptor/handle rather than a pathname. The lock
//! is released when the last descriptor for its open file description closes;
//! process death does that unless a `fork` without `exec` inherited the descriptor.

use std::fs::File;
use std::io;
use std::path::Path;

/// Owns an exclusive kernel lock until it is dropped.
pub struct ProcessLock {
    _file: File,
}

impl ProcessLock {
    /// Attempts one immediate exclusive acquisition.
    ///
    /// `Ok(None)` means another live process holds the lock. All other I/O failures
    /// are returned so callers can fail closed rather than mistaking them for
    /// contention.
    pub fn try_acquire(path: &Path) -> io::Result<Option<Self>> {
        let file = open_lock_file(path)?;
        match lock_file(&file) {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(error) if is_lock_contended(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(unix)]
fn open_lock_file(path: &Path) -> io::Result<File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // O_CLOEXEC is load-bearing: a sidecar that inherited this descriptor would
    // keep the flock alive after the desktop holder exits. O_NOFOLLOW prevents a
    // symlink from silently changing the lock authority.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn open_lock_file(path: &Path) -> io::Result<File> {
    use std::fs::OpenOptions;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    // A child must not retain the kernel lock after its desktop parent exits.
    let ok = unsafe { SetHandleInformation(file.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

#[cfg(unix)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    let ok = unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if ok != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn is_lock_contended(error: &io::Error) -> bool {
    let code = error.raw_os_error();
    code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN)
}

#[cfg(windows)]
fn is_lock_contended(error: &io::Error) -> bool {
    use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};

    matches!(
        error.raw_os_error(),
        Some(code) if code == ERROR_LOCK_VIOLATION as i32 || code == ERROR_SHARING_VIOLATION as i32
    )
}

#[cfg(test)]
mod tests {
    use super::ProcessLock;
    use std::env;
    use std::fs::{create_dir, read_dir, write};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    fn test_dir(name: &str) -> PathBuf {
        let base = env::temp_dir();
        let pid = std::process::id();
        for attempt in 0..1024 {
            let dir = base.join(format!("lasterm-process-lock-{name}-{pid}-{attempt}"));
            match create_dir(&dir) {
                Ok(()) => return dir,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("could not create {}: {error}", dir.display()),
            }
        }
        panic!(
            "could not allocate a unique test directory under {}",
            base.display()
        );
    }

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            sleep(Duration::from_millis(10));
        }
    }

    fn child(role: &str, path: &Path, ready: &Path) -> Child {
        Command::new(env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "tests::process_death_releases_lock",
                "--nocapture",
            ])
            .env("LASTERM_PROCESS_LOCK_TEST_ROLE", role)
            .env("LASTERM_PROCESS_LOCK_TEST_PATH", path)
            .env("LASTERM_PROCESS_LOCK_TEST_READY", ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child")
    }

    fn concurrent_child(
        path: &Path,
        start: &Path,
        attempted: &Path,
        acquired: &Path,
        release: &Path,
    ) -> Child {
        Command::new(env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "tests::only_one_of_many_concurrent_attempts_acquires",
                "--nocapture",
            ])
            .env("LASTERM_PROCESS_LOCK_TEST_ROLE", "candidate")
            .env("LASTERM_PROCESS_LOCK_TEST_PATH", path)
            .env("LASTERM_PROCESS_LOCK_TEST_START", start)
            .env("LASTERM_PROCESS_LOCK_TEST_ATTEMPTED", attempted)
            .env("LASTERM_PROCESS_LOCK_TEST_ACQUIRED", acquired)
            .env("LASTERM_PROCESS_LOCK_TEST_RELEASE", release)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn concurrent child")
    }

    fn wait_for_entries(path: &Path, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let entries = read_dir(path).unwrap().count();
            if entries == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {expected} entries in {} (found {entries})",
                path.display()
            );
            sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn only_one_of_many_concurrent_attempts_acquires() {
        if env::var("LASTERM_PROCESS_LOCK_TEST_ROLE").ok().as_deref() == Some("candidate") {
            let path = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_PATH").unwrap());
            let start = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_START").unwrap());
            let attempted = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_ATTEMPTED").unwrap());
            let acquired = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_ACQUIRED").unwrap());
            let release = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_RELEASE").unwrap());
            wait_for(&start);
            let lock = ProcessLock::try_acquire(&path).unwrap();
            if lock.is_some() {
                write(acquired.join(std::process::id().to_string()), "acquired").unwrap();
            }
            // The parent may assert only after every candidate has completed its
            // acquisition attempt, not while a winner is descheduled before it
            // can publish the result.
            write(attempted.join(std::process::id().to_string()), "attempted").unwrap();
            if lock.is_some() {
                wait_for(&release);
            }
            return;
        }

        // 100 cold races exercise the atomic kernel decision with independent
        // processes, not merely two calls in one process.
        for round in 0..100 {
            let dir = test_dir(&format!("concurrent-{round}"));
            let path = dir.join("desktop.lock");
            let start = dir.join("start");
            let attempted = dir.join("attempted");
            let acquired = dir.join("acquired");
            let release = dir.join("release");
            create_dir(&attempted).unwrap();
            create_dir(&acquired).unwrap();
            let mut candidates = (0..2)
                .map(|_| concurrent_child(&path, &start, &attempted, &acquired, &release))
                .collect::<Vec<_>>();
            write(&start, "go").unwrap();
            wait_for_entries(&attempted, 2);
            let acquired_count = read_dir(&acquired).unwrap().count();
            write(&release, "release").unwrap();
            assert_eq!(acquired_count, 1);
            for child in &mut candidates {
                assert!(child.wait().unwrap().success());
            }
        }
    }

    #[test]
    fn process_death_releases_lock() {
        match env::var("LASTERM_PROCESS_LOCK_TEST_ROLE").ok().as_deref() {
            Some("candidate") => return,
            Some("holder") => {
                let path = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_PATH").unwrap());
                let ready = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_READY").unwrap());
                let _lock = ProcessLock::try_acquire(&path).unwrap().unwrap();
                write(ready, "ready").unwrap();
                loop {
                    sleep(Duration::from_secs(1));
                }
            }
            Some("grandchild") => {
                let ready = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_READY").unwrap());
                write(ready, "ready").unwrap();
                sleep(Duration::from_secs(2));
                return;
            }
            Some("parent") => {
                let path = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_PATH").unwrap());
                let ready = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_READY").unwrap());
                let _lock = ProcessLock::try_acquire(&path).unwrap().unwrap();
                #[allow(clippy::zombie_processes)]
                let _grandchild = child("grandchild", &path, &ready);
                wait_for(&ready);
                return;
            }
            _ => {}
        }

        let dir = test_dir("process-death");
        let path = dir.join("desktop.lock");
        let ready = dir.join("ready");
        let mut holder = child("holder", &path, &ready);
        wait_for(&ready);
        assert!(ProcessLock::try_acquire(&path).unwrap().is_none());
        holder.kill().unwrap();
        holder.wait().unwrap();
        assert!(ProcessLock::try_acquire(&path).unwrap().is_some());
    }

    #[test]
    fn descriptor_is_not_inherited_by_spawned_child() {
        if env::var("LASTERM_PROCESS_LOCK_TEST_ROLE").ok().as_deref() == Some("parent") {
            return;
        }
        let dir = test_dir("descriptor-inheritance");
        let path = dir.join("desktop.lock");
        let ready = dir.join("ready");
        let mut parent = child("parent", &path, &ready);
        parent.wait().unwrap();
        wait_for(&ready);
        // The exec'd grandchild remains alive, so this catches a descriptor that
        // escaped its parent and would wedge every future desktop launch.
        assert!(ProcessLock::try_acquire(&path).unwrap().is_some());
    }
}
