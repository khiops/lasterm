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
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
    };

    let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
    if path.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "lock file path contains an interior NUL",
        ));
    }
    path.push(0);
    // Opening the final component itself is the Windows counterpart to Unix's
    // O_NOFOLLOW. Without FILE_FLAG_OPEN_REPARSE_POINT, CreateFileW follows a
    // planted junction or symlink before we can examine what was opened.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            // This must match Rust's OpenOptions sharing semantics. A second
            // holder needs to open the same file and reach LockFileEx, where
            // ERROR_LOCK_VIOLATION is the actual contention outcome.
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a valid owned handle above. `File` closes it
    // on every error below as well as on normal lock release.
    let file = unsafe { File::from_raw_handle(handle) };
    let mut attributes = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    let information_ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            std::ptr::from_mut(&mut attributes).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if information_ok == 0 {
        return Err(io::Error::last_os_error());
    }
    if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("refusing lock file reparse point"));
    }
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
    use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;

    matches!(error.raw_os_error(), Some(code) if code == ERROR_LOCK_VIOLATION as i32)
}

#[cfg(test)]
mod tests {
    use super::ProcessLock;
    use std::env;
    use std::fs::{create_dir, read_dir, write};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    struct TestDir(PathBuf);

    impl std::ops::Deref for TestDir {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                if error.kind() != io::ErrorKind::NotFound {
                    eprintln!(
                        "could not remove test directory {}: {error}",
                        self.0.display()
                    );
                }
            }
        }
    }

    fn test_dir(name: &str) -> TestDir {
        let base = env::temp_dir();
        let pid = std::process::id();
        for attempt in 0..1024 {
            let dir = base.join(format!("lasterm-process-lock-{name}-{pid}-{attempt}"));
            match create_dir(&dir) {
                Ok(()) => return TestDir(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("could not create {}: {error}", dir.display()),
            }
        }
        panic!(
            "could not allocate a unique test directory under {}",
            base.display()
        );
    }

    fn wait_for(path: &Path) -> io::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::symlink_metadata(path) {
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!("timed out waiting for {}", path.display()),
                        ));
                    }
                    sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(io::Error::new(
                        error.kind(),
                        format!(
                            "could not inspect {} while waiting: {error}",
                            path.display()
                        ),
                    ));
                }
            }
        }
    }

    struct TestChild(Child);

    impl TestChild {
        fn wait_success(&mut self) {
            assert!(self.0.wait().expect("wait for child").success());
        }

        fn kill_and_wait(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    impl Drop for TestChild {
        fn drop(&mut self) {
            self.kill_and_wait();
        }
    }

    struct GrandchildReleaseGuard {
        release: PathBuf,
        done: PathBuf,
        completed: bool,
    }

    impl GrandchildReleaseGuard {
        fn finish(&mut self) {
            write(&self.release, "release").expect("release grandchild");
            wait_for(&self.done).expect("wait for grandchild shutdown");
            self.completed = true;
        }
    }

    impl Drop for GrandchildReleaseGuard {
        fn drop(&mut self) {
            if self.completed {
                return;
            }
            if let Err(error) = write(&self.release, "release") {
                eprintln!(
                    "could not release test grandchild {}: {error}",
                    self.release.display()
                );
                return;
            }
            if let Err(error) = wait_for(&self.done) {
                eprintln!(
                    "could not wait for test grandchild {}: {error}",
                    self.done.display()
                );
            }
        }
    }

    fn child(role: &str, path: &Path, ready: &Path) -> TestChild {
        child_with_signals(role, path, ready, None, None)
    }

    fn child_with_signals(
        role: &str,
        path: &Path,
        ready: &Path,
        release: Option<&Path>,
        done: Option<&Path>,
    ) -> TestChild {
        let mut command = Command::new(env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "tests::process_death_releases_lock",
                "--nocapture",
            ])
            .env("LASTERM_PROCESS_LOCK_TEST_ROLE", role)
            .env("LASTERM_PROCESS_LOCK_TEST_PATH", path)
            .env("LASTERM_PROCESS_LOCK_TEST_READY", ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(release) = release {
            command.env("LASTERM_PROCESS_LOCK_TEST_RELEASE", release);
        }
        if let Some(done) = done {
            command.env("LASTERM_PROCESS_LOCK_TEST_DONE", done);
        }
        command.spawn().map(TestChild).expect("spawn child")
    }

    fn concurrent_child(
        path: &Path,
        start: &Path,
        attempted: &Path,
        acquired: &Path,
        release: &Path,
    ) -> TestChild {
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
            .map(TestChild)
            .expect("spawn concurrent child")
    }

    fn wait_for_entries(path: &Path, expected: usize) -> io::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let entries = read_dir(path)?.count();
            if entries == expected {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "timed out waiting for {expected} entries in {} (found {entries})",
                        path.display()
                    ),
                ));
            }
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
            wait_for(&start).expect("wait for candidate start");
            let lock = ProcessLock::try_acquire(&path).unwrap();
            if lock.is_some() {
                write(acquired.join(std::process::id().to_string()), "acquired").unwrap();
            }
            // The parent may assert only after every candidate has completed its
            // acquisition attempt, not while a winner is descheduled before it
            // can publish the result.
            write(attempted.join(std::process::id().to_string()), "attempted").unwrap();
            if lock.is_some() {
                wait_for(&release).expect("wait for candidate release");
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
            wait_for_entries(&attempted, 2).expect("wait for all candidate attempts");
            let acquired_count = read_dir(&acquired).unwrap().count();
            write(&release, "release").unwrap();
            assert_eq!(acquired_count, 1);
            for child in &mut candidates {
                child.wait_success();
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
                let release = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_RELEASE").unwrap());
                let done = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_DONE").unwrap());
                wait_for(&release).expect("wait for grandchild release");
                write(done, "done").unwrap();
                return;
            }
            Some("parent") => {
                let path = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_PATH").unwrap());
                let ready = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_READY").unwrap());
                let _lock = ProcessLock::try_acquire(&path).unwrap().unwrap();
                let release = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_RELEASE").unwrap());
                let done = PathBuf::from(env::var("LASTERM_PROCESS_LOCK_TEST_DONE").unwrap());
                let grandchild =
                    child_with_signals("grandchild", &path, &ready, Some(&release), Some(&done));
                wait_for(&ready).expect("wait for grandchild readiness");
                // The root test owns the release signal and waits for `done`; do not
                // drop this guard here or it would kill the very inherited child the
                // test needs to observe after this parent exits.
                std::mem::forget(grandchild);
                return;
            }
            _ => {}
        }

        let dir = test_dir("process-death");
        let path = dir.join("desktop.lock");
        let ready = dir.join("ready");
        let mut holder = child("holder", &path, &ready);
        wait_for(&ready).expect("wait for lock holder readiness");
        assert!(ProcessLock::try_acquire(&path).unwrap().is_none());
        holder.kill_and_wait();
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
        let release = dir.join("release");
        let done = dir.join("done");
        let mut grandchild = GrandchildReleaseGuard {
            release: release.clone(),
            done: done.clone(),
            completed: false,
        };
        let mut parent = child_with_signals("parent", &path, &ready, Some(&release), Some(&done));
        parent.wait_success();
        wait_for(&ready).expect("wait for grandchild readiness");
        // The exec'd grandchild remains alive, so this catches a descriptor that
        // escaped its parent and would wedge every future desktop launch.
        assert!(ProcessLock::try_acquire(&path).unwrap().is_some());
        grandchild.finish();
    }

    #[cfg(unix)]
    fn path_with_interior_nul(dir: &Path) -> PathBuf {
        use std::os::unix::ffi::OsStringExt;

        dir.join(std::ffi::OsString::from_vec(
            b"desktop.lock\0suffix".to_vec(),
        ))
    }

    #[cfg(windows)]
    fn path_with_interior_nul(dir: &Path) -> PathBuf {
        use std::os::windows::ffi::OsStringExt;

        dir.join(std::ffi::OsString::from_wide(&[
            b'd' as u16,
            b'e' as u16,
            b's' as u16,
            b'k' as u16,
            b't' as u16,
            b'o' as u16,
            b'p' as u16,
            b'.' as u16,
            b'l' as u16,
            b'o' as u16,
            b'c' as u16,
            b'k' as u16,
            0,
            b's' as u16,
            b'u' as u16,
            b'f' as u16,
            b'f' as u16,
            b'i' as u16,
            b'x' as u16,
        ]))
    }

    #[test]
    fn interior_nul_in_lock_path_is_refused() {
        let dir = test_dir("interior-nul");
        let result = ProcessLock::try_acquire(&path_with_interior_nul(&dir));

        assert!(
            result.is_err(),
            "an interior NUL must not name a truncated lock path"
        );
    }

    /// Kills the P6 mutation that lets CreateFile follow a reparse point before
    /// the lock is acquired on the target chosen by that link.
    #[cfg(windows)]
    #[test]
    fn windows_reparse_point_at_the_lock_path_is_refused() {
        let dir = test_dir("windows-reparse-lock");
        let target = dir.join("target.lock");
        let link = dir.join("desktop.lock");
        write(&target, "target").unwrap();
        std::os::windows::fs::symlink_file(&target, &link).unwrap();

        let error = match ProcessLock::try_acquire(&link) {
            Ok(_) => panic!("the reparse-point open must not acquire the target"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("reparse") || error.raw_os_error().is_some(),
            "the reparse-point open must fail rather than acquire the target: {error}"
        );
    }
}
