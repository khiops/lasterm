use napi_derive::napi;
use std::fs::File;
use std::io;
use std::path::Path;

/// Owns the kernel lock. It deliberately owns the file descriptor/handle rather
/// than a pathname: closing this object (or process termination) releases it.
struct KernelLock {
    _file: File,
}

impl KernelLock {
    fn acquire(path: &Path) -> io::Result<Option<Self>> {
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
    // O_CLOEXEC makes descriptor inheritance across the agent's exec impossible.
    // O_NOFOLLOW avoids silently locking a different target through a symlink.
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

    // Never truncate: an existing authority file may be held by a live hub right
    // now, and its length is not ours to change. Creating it when absent is the
    // only write this needs.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    // Node's child creation can only inherit handles marked inheritable. Clear
    // that bit here, next to acquisition, instead of relying on every caller to
    // remember a spawn option.
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
    let code = error.raw_os_error();
    code == Some(ERROR_LOCK_VIOLATION as i32) || code == Some(ERROR_SHARING_VIOLATION as i32)
}

/// JavaScript-visible handle. Keeping this object reachable keeps the kernel
/// lock alive. There is deliberately no JavaScript operation that closes it:
/// only finalization or process death can release the kernel authority.
#[napi]
pub struct HubLock {
    _inner: KernelLock,
    path: String,
}

#[napi]
impl HubLock {
    /// Lets the JavaScript boundary prove that this native handle was acquired
    /// for the exact authority file it is about to serve behind.
    #[napi(getter)]
    pub fn path(&self) -> String {
        self.path.clone()
    }
}

/// Attempts a non-blocking exclusive acquisition. `None` means another live
/// holder owns the authority; every I/O failure is an error and must fail closed.
#[napi]
pub fn try_acquire(path: String) -> napi::Result<Option<HubLock>> {
    let handle_path = path.clone();
    KernelLock::acquire(Path::new(&path))
        .map(|lock| {
            lock.map(|inner| HubLock {
                _inner: inner,
                path: handle_path,
            })
        })
        .map_err(|error| {
            napi::Error::from_reason(format!("cannot acquire hub lock at {path}: {error}"))
        })
}

#[cfg(test)]
mod tests {
    use super::KernelLock;
    use std::env;
    use std::fs::{create_dir, write};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    /// A directory this run created, never one it found.
    ///
    /// A pid-derived name is reused after the pid is, so a killed run's readiness
    /// marker could be adopted by a later one and let `wait_for` return before the
    /// new holder had acquired anything. Creation that fails on an existing name is
    /// what makes the directory this run's own.
    fn test_dir(name: &str) -> PathBuf {
        let base = env::temp_dir();
        let pid = std::process::id();
        for attempt in 0..1024 {
            let dir = base.join(format!("termora-hub-lock-{name}-{pid}-{attempt}"));
            match create_dir(&dir) {
                Ok(()) => return dir,
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => panic!("could not create {}: {err}", dir.display()),
            }
        }
        panic!(
            "could not allocate a unique test directory under {}",
            base.display()
        )
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
        Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::process_death_releases_lock",
                "--nocapture",
            ])
            .env("TERMORA_HUB_LOCK_TEST_ROLE", role)
            .env("TERMORA_HUB_LOCK_TEST_PATH", path)
            .env("TERMORA_HUB_LOCK_TEST_READY", ready)
            .spawn()
            .unwrap()
    }

    #[test]
    fn second_acquisition_fails_until_first_handle_drops() {
        let path = test_dir("second-acquisition").join("hub.lock");
        let first = KernelLock::acquire(&path).unwrap().unwrap();
        assert!(KernelLock::acquire(&path).unwrap().is_none());
        drop(first);
        assert!(KernelLock::acquire(&path).unwrap().is_some());
    }

    #[test]
    fn process_death_releases_lock() {
        let role = env::var("TERMORA_HUB_LOCK_TEST_ROLE").ok();
        if role.as_deref() == Some("holder") {
            let path = PathBuf::from(env::var("TERMORA_HUB_LOCK_TEST_PATH").unwrap());
            let ready = PathBuf::from(env::var("TERMORA_HUB_LOCK_TEST_READY").unwrap());
            let _lock = KernelLock::acquire(&path).unwrap().unwrap();
            write(ready, "ready").unwrap();
            loop {
                sleep(Duration::from_secs(1));
            }
        }
        if role.as_deref() == Some("grandchild") {
            let ready = PathBuf::from(env::var("TERMORA_HUB_LOCK_TEST_READY").unwrap());
            write(ready, "ready").unwrap();
            sleep(Duration::from_secs(2));
            return;
        }
        if role.as_deref() == Some("parent") {
            let path = PathBuf::from(env::var("TERMORA_HUB_LOCK_TEST_PATH").unwrap());
            let ready = PathBuf::from(env::var("TERMORA_HUB_LOCK_TEST_READY").unwrap());
            let _lock = KernelLock::acquire(&path).unwrap().unwrap();
            // This process must exit without waiting: the test proves that the
            // still-running grandchild did not inherit the close-on-exec lock fd.
            #[allow(clippy::zombie_processes)]
            let _grandchild = child("grandchild", &path, &ready);
            wait_for(&ready);
            return;
        }

        let dir = test_dir("process-death");
        let path = dir.join("hub.lock");
        let ready = dir.join("ready");
        let mut holder = child("holder", &path, &ready);
        wait_for(&ready);
        assert!(KernelLock::acquire(&path).unwrap().is_none());
        holder.kill().unwrap();
        holder.wait().unwrap();
        assert!(KernelLock::acquire(&path).unwrap().is_some());
    }

    #[test]
    fn descriptor_is_not_inherited_by_spawned_child() {
        if env::var("TERMORA_HUB_LOCK_TEST_ROLE").ok().as_deref() != Some("parent") {
            let dir = test_dir("descriptor-inheritance");
            let path = dir.join("hub.lock");
            let ready = dir.join("ready");
            let mut parent = child("parent", &path, &ready);
            parent.wait().unwrap();
            wait_for(&ready);
            // The grandchild is still alive, but an exec cannot retain the lock fd.
            assert!(KernelLock::acquire(&path).unwrap().is_some());
        }
    }
}
