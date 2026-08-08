use lasterm_process_lock::ProcessLock;
use napi_derive::napi;
use std::io;
use std::path::Path;

/// Owns the kernel lock. It deliberately owns the file descriptor/handle rather
/// than a pathname: closing this object (or process termination) releases it.
struct KernelLock {
    _inner: ProcessLock,
}

impl KernelLock {
    fn acquire(path: &Path) -> io::Result<Option<Self>> {
        ProcessLock::try_acquire(path).map(|lock| lock.map(|inner| Self { _inner: inner }))
    }
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
            let dir = base.join(format!("lasterm-hub-lock-{name}-{pid}-{attempt}"));
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
            .env("LASTERM_HUB_LOCK_TEST_ROLE", role)
            .env("LASTERM_HUB_LOCK_TEST_PATH", path)
            .env("LASTERM_HUB_LOCK_TEST_READY", ready)
            .spawn()
            .unwrap()
    }

    /// This wrapper still proves that a live JavaScript-visible handle excludes a
    /// second acquisition. The platform mechanics, SIGKILL release, concurrent
    /// races, and descriptor inheritance are tested directly in
    /// `lasterm-process-lock`, the one implementation both consumers now share.
    #[test]
    fn second_acquisition_is_refused_while_the_first_handle_lives() {
        let path = test_dir("second-acquisition").join("hub.lock");
        let first = KernelLock::acquire(&path).unwrap().unwrap();
        assert!(KernelLock::acquire(&path).unwrap().is_none());
        drop(first);
    }

    #[test]
    fn process_death_releases_lock() {
        let role = env::var("LASTERM_HUB_LOCK_TEST_ROLE").ok();
        if role.as_deref() == Some("holder") {
            let path = PathBuf::from(env::var("LASTERM_HUB_LOCK_TEST_PATH").unwrap());
            let ready = PathBuf::from(env::var("LASTERM_HUB_LOCK_TEST_READY").unwrap());
            let _lock = KernelLock::acquire(&path).unwrap().unwrap();
            write(ready, "ready").unwrap();
            loop {
                sleep(Duration::from_secs(1));
            }
        }
        if role.as_deref() == Some("grandchild") {
            let ready = PathBuf::from(env::var("LASTERM_HUB_LOCK_TEST_READY").unwrap());
            write(ready, "ready").unwrap();
            sleep(Duration::from_secs(2));
            return;
        }
        if role.as_deref() == Some("parent") {
            let path = PathBuf::from(env::var("LASTERM_HUB_LOCK_TEST_PATH").unwrap());
            let ready = PathBuf::from(env::var("LASTERM_HUB_LOCK_TEST_READY").unwrap());
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
        if env::var("LASTERM_HUB_LOCK_TEST_ROLE").ok().as_deref() != Some("parent") {
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
