//! The directory a daemon's Unix socket lives in.
//!
//! Whoever can write that directory can put their own socket where a hub looks
//! for this daemon's, or take this one's name. So before the daemon binds, the
//! directory must be a real directory, not a symbolic link, owned by this
//! process's effective user, with no permission for group or others. A missing
//! one is created 0700 and then judged as if it had been found: another process
//! could have made it between the two looks. The hub makes the same checks from
//! its side before it connects (`local-agent-endpoint.ts`).

use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::Path;

/// What the check reads of the directory, so a test can describe one it cannot
/// make, such as another account's.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DirFacts {
    pub(crate) is_symlink: bool,
    pub(crate) is_dir: bool,
    pub(crate) uid: u32,
    pub(crate) mode: u32,
}

impl DirFacts {
    fn of(metadata: &fs::Metadata) -> Self {
        Self {
            is_symlink: metadata.file_type().is_symlink(),
            is_dir: metadata.file_type().is_dir(),
            uid: metadata.uid(),
            mode: metadata.mode(),
        }
    }
}

/// Make sure the directory of `socket` exists and is this user's own. A
/// relative socket lives in the current directory, which is then the one
/// judged.
pub(crate) fn ensure_private_socket_dir_for(socket: &Path) -> io::Result<()> {
    let dir = match socket.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    ensure_private_socket_dir(dir)
}

/// Make sure `dir` exists and is this user's own: see the module.
pub(crate) fn ensure_private_socket_dir(dir: &Path) -> io::Result<()> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    let own = unsafe { libc::geteuid() };
    ensure_with(dir, own, |dir| {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    })
}

/// `ensure_private_socket_dir`, with the user and the creation supplied, so a
/// test can stand in another account, or a directory that appears between the
/// two looks.
fn ensure_with(
    dir: &Path,
    own_uid: u32,
    create: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let facts = match fs::symlink_metadata(dir) {
        Ok(metadata) => DirFacts::of(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match create(dir) {
                Ok(()) => {}
                // Something took the name first: judged below, like anything found.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            DirFacts::of(&fs::symlink_metadata(dir)?)
        }
        Err(error) => return Err(error),
    };
    check(dir, facts, own_uid)
}

/// Whether a directory with these facts may hold this user's socket.
pub(crate) fn check(dir: &Path, facts: DirFacts, own_uid: u32) -> io::Result<()> {
    let refuse = |reason: String| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing the socket directory {}: {reason}", dir.display()),
        ))
    };
    if facts.is_symlink {
        return refuse("it is a symbolic link, not a directory".into());
    }
    if !facts.is_dir {
        return refuse("it is not a directory".into());
    }
    if facts.uid != own_uid {
        return refuse(format!(
            "it is owned by uid {}, not by this user (uid {own_uid})",
            facts.uid
        ));
    }
    if facts.mode & 0o077 != 0 {
        return refuse(format!(
            "it gives group or others access (mode {:o}); it must be 700",
            facts.mode & 0o777
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// A private directory this test made, removed however the test ends.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lasterm-socket-dir-{label}-{}",
                ulid::Ulid::generate().to_string().to_lowercase()
            ));
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .expect("create a private test directory");
            Self(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn own() -> u32 {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() }
    }

    fn mode_of(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn refusal(result: io::Result<()>) -> String {
        let error = result.expect_err("the directory must be refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{error}");
        error.to_string()
    }

    #[test]
    fn a_missing_directory_is_created_owner_only_with_its_parents() {
        let base = TestDir::new("missing");
        let dir = base.0.join("missing").join("nested");
        ensure_private_socket_dir(&dir).expect("a missing directory is created");
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(mode_of(dir.parent().unwrap()), 0o700);
    }

    #[test]
    fn a_private_directory_of_this_user_is_accepted() {
        let base = TestDir::new("private");
        ensure_private_socket_dir(&base.0).expect("our own 0700 directory");
    }

    #[test]
    fn a_directory_open_to_group_or_others_is_refused() {
        for mode in [0o750, 0o705, 0o770, 0o777] {
            let base = TestDir::new("open");
            fs::set_permissions(&base.0, fs::Permissions::from_mode(mode)).unwrap();
            let message = refusal(ensure_private_socket_dir(&base.0));
            assert!(message.contains(&base.0.display().to_string()), "{message}");
            assert!(message.contains(&format!("mode {mode:o}")), "{message}");
            // Refused, not repaired.
            assert_eq!(mode_of(&base.0), mode);
        }
    }

    #[test]
    fn a_symbolic_link_is_refused_even_to_a_private_directory() {
        let base = TestDir::new("symlink");
        let real = base.0.join("real");
        fs::DirBuilder::new().mode(0o700).create(&real).unwrap();
        let link = base.0.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let message = refusal(ensure_private_socket_dir(&link));
        assert!(message.contains("symbolic link"), "{message}");
    }

    #[test]
    fn a_file_is_refused() {
        let base = TestDir::new("file");
        let file = base.0.join("not-a-directory");
        fs::write(&file, b"").unwrap();
        let message = refusal(ensure_private_socket_dir(&file));
        assert!(message.contains("not a directory"), "{message}");
    }

    #[test]
    fn a_directory_another_account_owns_is_refused() {
        let facts = DirFacts {
            is_symlink: false,
            is_dir: true,
            uid: own().wrapping_add(1),
            mode: 0o40700,
        };
        let message = refusal(check(Path::new("/tmp/lasterm-1000"), facts, own()));
        assert!(message.contains("/tmp/lasterm-1000"), "{message}");
        assert!(
            message.contains(&format!("owned by uid {}", own().wrapping_add(1))),
            "{message}"
        );
    }

    #[test]
    fn a_directory_that_appears_between_the_two_looks_is_judged_as_found() {
        // Missing at the first look; by the second, someone made it 0755.
        let base = TestDir::new("race");
        let dir = base.0.join("socket-dir");
        let message = refusal(ensure_with(&dir, own(), |dir| {
            fs::DirBuilder::new().mode(0o755).create(dir)?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o755))?;
            Err(io::Error::from(io::ErrorKind::AlreadyExists))
        }));
        assert!(message.contains("mode 755"), "{message}");
    }

    #[test]
    fn a_directory_created_as_another_account_would_be_is_refused() {
        // The creation went through, but the directory is judged by the look
        // after it, here as another account's.
        let base = TestDir::new("created");
        let dir = base.0.join("socket-dir");
        let someone_else = own().wrapping_add(1);
        let message = refusal(ensure_with(&dir, someone_else, |dir| {
            fs::DirBuilder::new().mode(0o700).create(dir)
        }));
        assert!(message.contains("owned by uid"), "{message}");
    }

    /// A relative socket's directory is the current one, which a test cannot
    /// change safely; the daemon test with a relative socket in
    /// tests/integration.rs covers it.
    #[test]
    fn the_directory_judged_is_the_one_holding_the_socket() {
        let private = TestDir::new("holding");
        ensure_private_socket_dir_for(&private.0.join("agent.sock"))
            .expect("its directory is private");
        let open = TestDir::new("holding-open");
        fs::set_permissions(&open.0, fs::Permissions::from_mode(0o755)).unwrap();
        refusal(ensure_private_socket_dir_for(&open.0.join("agent.sock")));
    }
}
