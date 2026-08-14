//! Descriptor-relative access to fixed, absolute protected paths.
//!
//! Unix descent starts from `/` and opens every directory relative to the
//! descriptor already held.  `O_NOFOLLOW` applies to every component, not just
//! the leaf.  Callers retain ownership of object-specific policy decisions.

#[cfg(unix)]
mod unix {
    use std::ffi::CString;
    use std::ffi::OsStr;
    use std::fs::{File, Metadata};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path};

    /// An owned directory descriptor obtained by a no-symlink descent from `/`.
    pub struct Directory(File);

    impl Directory {
        pub fn metadata(&self) -> io::Result<Metadata> {
            self.0.metadata()
        }

        pub fn sync_all(&self) -> io::Result<()> {
            self.0.sync_all()
        }

        pub fn open_existing(&self, name: &OsStr, flags: i32) -> io::Result<Option<File>> {
            match open_at(
                self.0.as_raw_fd(),
                name,
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
            ) {
                Ok(fd) => {
                    // SAFETY: openat returned a valid owned descriptor.
                    Ok(Some(unsafe { File::from_raw_fd(fd) }))
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        }

        pub fn create_new(&self, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
            let fd = open_at(
                self.0.as_raw_fd(),
                name,
                flags | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                mode,
            )?;
            // SAFETY: openat returned a valid owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        pub fn rename(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
            let from = c_name(from)?;
            let to = c_name(to)?;
            // SAFETY: names are NUL-terminated and the descriptors are owned.
            if unsafe {
                libc::renameat(
                    self.0.as_raw_fd(),
                    from.as_ptr(),
                    self.0.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn remove_file(&self, name: &OsStr) -> io::Result<()> {
            let name = c_name(name)?;
            // SAFETY: name is NUL-terminated and the descriptor is owned.
            if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn hard_link(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
            let from = c_name(from)?;
            let to = c_name(to)?;
            // SAFETY: names are NUL-terminated and the descriptor is owned.
            if unsafe {
                libc::linkat(
                    self.0.as_raw_fd(),
                    from.as_ptr(),
                    self.0.as_raw_fd(),
                    to.as_ptr(),
                    0,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    fn c_name(name: &OsStr) -> io::Result<CString> {
        if name.is_empty() || name.as_bytes().contains(&0) || name.as_bytes().contains(&b'/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid protected path component",
            ));
        }
        CString::new(name.as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected path contains an interior NUL",
            )
        })
    }

    fn open_at(parent: i32, name: &OsStr, flags: i32, mode: u32) -> io::Result<i32> {
        let name = c_name(name)?;
        // SAFETY: the directory descriptor and C string remain valid for the call.
        let fd = unsafe { libc::openat(parent, name.as_ptr(), flags, mode) };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(fd)
        }
    }

    /// Opens the parent of an absolute protected path by descending from `/`.
    pub fn open_parent(path: &Path) -> io::Result<(Directory, std::ffi::OsString)> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected path is not absolute",
            ));
        }
        let mut names = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => names.push(name.to_os_string()),
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "protected path is not normalized",
                    ))
                }
            }
        }
        let leaf = names.pop().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "protected path has no leaf")
        })?;
        let root = CString::new("/").expect("root has no NUL");
        // SAFETY: root is NUL-terminated; O_DIRECTORY requires the root directory.
        let root_fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if root_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: open returned an owned descriptor.
        let mut directory = Directory(unsafe { File::from_raw_fd(root_fd) });
        for name in names {
            let fd = open_at(
                directory.0.as_raw_fd(),
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
            )?;
            // SAFETY: openat returned an owned descriptor, replacing the parent only after success.
            directory = Directory(unsafe { File::from_raw_fd(fd) });
        }
        Ok((directory, leaf))
    }

    /// Opens an absolute directory by the same root-to-leaf descent.  Missing
    /// components are created relative to their verified parent when requested.
    pub fn open_directory(path: &Path, create: bool, mode: u32) -> io::Result<Directory> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected directory is not absolute",
            ));
        }
        let root = CString::new("/").expect("root has no NUL");
        // SAFETY: root is NUL-terminated; O_DIRECTORY requires the root directory.
        let root_fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if root_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: open returned an owned descriptor.
        let mut directory = Directory(unsafe { File::from_raw_fd(root_fd) });
        for component in path.components() {
            let Component::Normal(name) = component else {
                if matches!(component, Component::RootDir) {
                    continue;
                }
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "protected directory is not normalized",
                ));
            };
            let fd = open_at(
                directory.0.as_raw_fd(),
                name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
            );
            let fd = match fd {
                Ok(fd) => fd,
                Err(error) => {
                if !create || error.kind() != io::ErrorKind::NotFound {
                    return Err(error);
                }
                let c_name = c_name(name)?;
                // SAFETY: name is NUL-terminated and parent is an owned directory.
                if unsafe { libc::mkdirat(directory.0.as_raw_fd(), c_name.as_ptr(), mode) } != 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
                open_at(
                    directory.0.as_raw_fd(),
                    name,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                    0,
                )?
                }
            };
            // SAFETY: openat returned an owned descriptor, replacing the parent only after success.
            directory = Directory(unsafe { File::from_raw_fd(fd) });
        }
        Ok(directory)
    }
}

#[cfg(unix)]
pub use unix::{open_directory, open_parent, Directory};

#[cfg(windows)]
mod windows {
    use std::ffi::{OsStr, OsString};
    use std::fs::{File, Metadata};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::path::{Component, Path, PathBuf};
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, CreateHardLinkW, DeleteFileW, FileAttributeTagInfo, GetFileInformationByHandleEx,
        MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
    };

    /// A Windows directory handle plus its lexical path for Win32's pathname-only
    /// leaf operations.
    ///
    /// Windows has no public handle-relative open. Ancestor substitution is not
    /// prevented: each final component is still opened once with delete sharing
    /// withheld and inspected through that same handle.
    pub struct Directory {
        file: File,
        path: PathBuf,
    }

    impl Directory {
        pub fn metadata(&self) -> io::Result<Metadata> {
            self.file.metadata()
        }

        pub fn open_existing(&self, name: &OsStr) -> io::Result<Option<File>> {
            match open_leaf(&self.path.join(name), OPEN_EXISTING, GENERIC_READ) {
                Ok(file) => Ok(Some(file)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        }

        pub fn inspect_existing(&self, name: &OsStr) -> io::Result<Option<File>> {
            match open_leaf(&self.path.join(name), OPEN_EXISTING, FILE_READ_ATTRIBUTES) {
                Ok(file) => Ok(Some(file)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        }

        pub fn create_new(&self, name: &OsStr) -> io::Result<File> {
            open_leaf(&self.path.join(name), CREATE_NEW, GENERIC_READ | GENERIC_WRITE)
        }

        pub fn rename(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
            let from = wide_path(&self.path.join(from), "protected source path")?;
            let to = wide_path(&self.path.join(to), "protected destination path")?;
            // SAFETY: both paths are NUL-terminated and remain valid for the call.
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn remove_file(&self, name: &OsStr) -> io::Result<()> {
            let name = wide_path(&self.path.join(name), "protected path")?;
            // SAFETY: the path is NUL-terminated and remains valid for the call.
            if unsafe { DeleteFileW(name.as_ptr()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn hard_link(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
            let from = wide_path(&self.path.join(from), "protected source path")?;
            let to = wide_path(&self.path.join(to), "protected destination path")?;
            // SAFETY: both paths are NUL-terminated and remain valid for the call.
            if unsafe { CreateHardLinkW(to.as_ptr(), from.as_ptr(), std::ptr::null()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    fn wide_path(path: &Path, description: &str) -> io::Result<Vec<u16>> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{description} contains an interior NUL"),
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    fn validate_path(path: &Path, require_leaf: bool) -> io::Result<()> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected path is not absolute",
            ));
        }
        for component in path.components() {
            if matches!(component, Component::CurDir | Component::ParentDir) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "protected path is not normalized",
                ));
            }
        }
        if require_leaf && path.file_name().is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected path has no leaf",
            ));
        }
        Ok(())
    }

    fn reject_reparse_point(file: &File) -> io::Result<()> {
        let mut attributes = FILE_ATTRIBUTE_TAG_INFO {
            FileAttributes: 0,
            ReparseTag: 0,
        };
        // SAFETY: attributes is writable storage of the exact documented size.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileAttributeTagInfo,
                std::ptr::from_mut(&mut attributes).cast(),
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("refusing protected reparse point"));
        }
        Ok(())
    }

    fn make_non_inheritable(file: &File) -> io::Result<()> {
        // SAFETY: file owns a valid Windows handle.
        if unsafe { SetHandleInformation(file.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn open_path(path: &Path, disposition: u32, access: u32, flags: u32) -> io::Result<File> {
        let wide = wide_path(path, "protected path")?;
        // SAFETY: wide is NUL-terminated and lives for the call. Omitting
        // FILE_SHARE_DELETE prevents a name replacement racing this checked handle.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                disposition,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | flags,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateFileW returned an owned handle.
        let file = unsafe { File::from_raw_handle(handle) };
        reject_reparse_point(&file)?;
        make_non_inheritable(&file)?;
        Ok(file)
    }

    fn open_leaf(path: &Path, disposition: u32, access: u32) -> io::Result<File> {
        validate_path(path, true)?;
        open_path(path, disposition, access, 0)
    }

    pub fn open_parent(path: &Path) -> io::Result<(Directory, OsString)> {
        validate_path(path, true)?;
        let parent = path.parent().expect("a path with a leaf has a parent");
        let leaf = path.file_name().expect("validated path has a leaf").to_os_string();
        Ok((open_directory(parent, false, 0)?, leaf))
    }

    pub fn open_directory(path: &Path, create: bool, _mode: u32) -> io::Result<Directory> {
        validate_path(path, false)?;
        if create {
            std::fs::create_dir_all(path)?;
        }
        let file = open_path(
            path,
            OPEN_EXISTING,
            GENERIC_READ,
            FILE_FLAG_BACKUP_SEMANTICS,
        )?;
        if !file.metadata()?.is_dir() {
            return Err(io::Error::other("protected path is not a directory"));
        }
        Ok(Directory {
            file,
            path: path.to_path_buf(),
        })
    }
}

#[cfg(windows)]
pub use windows::{open_directory, open_parent, Directory};

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::open_parent;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    #[derive(Clone, Copy)]
    struct AllowedCall {
        source: &'static str,
        call: &'static str,
        why: &'static str,
    }

    #[test]
    fn protected_path_callers_have_no_unreviewed_pathname_filesystem_bypass() {
        // This reads source text rather than Rust's resolved AST. It catches plain
        // pathname calls in these three files, but a call hidden by an alias or a
        // macro is invisible and still needs review.
        let allowed = [
            AllowedCall {
                source: "desktop",
                call: "std::fs::remove_file(&self.path)",
                why: "removes the Unix desktop-raise socket, not a protected file",
            },
            AllowedCall {
                source: "desktop",
                call: "std::fs::remove_file(path)",
                why: "removes a stale Unix desktop-raise socket before binding",
            },
            AllowedCall {
                source: "desktop",
                call: "CreateFileW, FlushFileBuffers, OPEN_EXISTING",
                why: "imports the Windows named-pipe client primitive",
            },
            AllowedCall {
                source: "desktop",
                call: "CreateFileW(",
                why: "opens the Windows named pipe, not a filesystem object",
            },
            AllowedCall {
                source: "desktop",
                call: "let contents = match std::fs::read_to_string(path)",
                why: "reads the non-protected close-behavior preference",
            },
            AllowedCall {
                source: "desktop",
                call: "std::fs::rename(source, target)",
                why: "replaces the non-protected close-behavior preference",
            },
            AllowedCall {
                source: "desktop",
                call: "match std::fs::OpenOptions::new()",
                why: "creates a non-protected close-behavior temporary file",
            },
            AllowedCall {
                source: "desktop",
                call: "std::fs::remove_file(&temp_path)",
                why: "cleans a non-protected close-behavior temporary file",
            },
            AllowedCall {
                source: "desktop",
                call: "std::fs::symlink_metadata(&path)",
                why: "checks an explicitly user-selected agent file",
            },
            AllowedCall {
                source: "desktop",
                call: "std::fs::symlink_metadata(&canonical_path)",
                why: "checks the resolved explicitly user-selected agent file",
            },
            AllowedCall {
                source: "desktop",
                call: "std::fs::File::open(&canonical_path)",
                why: "reads an explicitly user-selected agent file",
            },
            AllowedCall {
                source: "desktop",
                call: "let mut file = match std::fs::OpenOptions::new()",
                why: "opens the non-protected hub diagnostic log",
            },
            AllowedCall {
                source: "identity",
                call: "fs::remove_file(path)",
                why: "unsupported-platform temporary cleanup; Unix and Windows use the crate",
            },
            AllowedCall {
                source: "protected-fs",
                call: "libc::openat(parent, name.as_ptr(), flags, mode)",
                why: "the crate's Unix descriptor-relative leaf primitive",
            },
            AllowedCall {
                source: "protected-fs",
                call: "libc::open(",
                why: "the crate's Unix root-directory primitive",
            },
            AllowedCall {
                source: "protected-fs",
                call: "CreateFileW, CreateHardLinkW, DeleteFileW",
                why: "imports the crate's Windows protected-file primitives",
            },
            AllowedCall {
                source: "protected-fs",
                call: "CreateFileW(",
                why: "the crate's Windows one-handle protected-leaf primitive",
            },
        ];
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest
            .parent()
            .and_then(|path| path.parent())
            .expect("protected-fs lives directly under the workspace crates directory");
        let sources = [
            ("desktop", root.join("packages/clients/desktop/src-tauri/src/lib.rs")),
            ("identity", root.join("crates/lasterm-tls-identity/src/lib.rs")),
            ("protected-fs", root.join("crates/lasterm-protected-fs/src/lib.rs")),
        ];
        let patterns = [
            "fs::read",
            "fs::read_to_string",
            "fs::write",
            "fs::rename",
            "fs::remove_file",
            "fs::metadata",
            "fs::symlink_metadata",
            "File::open",
            "File::create",
            "OpenOptions",
            "libc::open",
            "CreateFileW",
        ];

        for (source_name, path) in sources {
            let source = fs::read_to_string(&path).expect("read guarded source file");
            let production = &source[..source
                .rfind("\n#[cfg(test)]")
                .expect("guarded source has a trailing test module")];
            for (line_number, line) in production.lines().enumerate() {
                let code = line.split("//").next().unwrap_or(line);
                if patterns.iter().any(|pattern| code.contains(pattern)) {
                    let allowed_call = allowed.iter().find(|allowed| {
                        allowed.source == source_name && code.contains(allowed.call)
                    });
                    assert!(
                        allowed_call.is_some(),
                        "unallowlisted protected-path filesystem call in {}:{}: {}",
                        path.display(),
                        line_number + 1,
                        code.trim(),
                    );
                    assert!(
                        !allowed_call.expect("checked above").why.is_empty(),
                        "allowlist entry must explain its permitted pathname call"
                    );
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_walk_refuses_unsafe_components_and_keeps_absence_distinct() {
        let root =
            std::env::temp_dir().join(format!("lasterm-protected-fs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("safe/nested")).unwrap();
        let clean = root.join("safe/nested/leaf");
        let (parent, leaf) = open_parent(&clean).unwrap();
        assert!(parent
            .open_existing(&leaf, libc::O_RDONLY)
            .unwrap()
            .is_none());
        fs::write(&clean, "ok").unwrap();
        assert!(parent
            .open_existing(&leaf, libc::O_RDONLY)
            .unwrap()
            .is_some());
        fs::create_dir_all(root.join("decoy/nested")).unwrap();
        fs::write(root.join("decoy/nested/leaf"), "decoy").unwrap();
        fs::rename(root.join("safe"), root.join("safe-real")).unwrap();
        symlink(root.join("decoy"), root.join("safe")).unwrap();
        assert!(open_parent(&clean).is_err());
        fs::remove_file(root.join("safe")).unwrap();
        fs::write(root.join("file"), "not a directory").unwrap();
        assert!(open_parent(&root.join("file/leaf")).is_err());
        assert!(open_parent(std::path::Path::new("relative/leaf")).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_leaf_and_directory_reparse_points_are_refused_by_handle() {
        use super::{open_directory, open_parent};
        use std::io::Read;
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-windows-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("safe")).expect("create real directory");
        let protected = root.join("safe/leaf");
        fs::write(&protected, "checked handle").expect("write regular leaf");
        let (parent, leaf) = open_parent(&protected).expect("open regular parent");
        let mut file = parent
            .open_existing(&leaf)
            .expect("open regular leaf")
            .expect("regular leaf exists");
        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .expect("read the checked handle");
        assert_eq!(contents, "checked handle");

        let linked_leaf = root.join("safe/linked-leaf");
        symlink_file(&protected, &linked_leaf).expect("create leaf reparse point");
        let (parent, leaf) = open_parent(&linked_leaf).expect("open linked leaf parent");
        let error = parent
            .open_existing(&leaf)
            .expect_err("a leaf reparse point is refused through its opened handle");
        assert!(error.to_string().contains("reparse point"));

        let linked_directory = root.join("linked-directory");
        symlink_dir(root.join("safe"), &linked_directory)
            .expect("create directory reparse point");
        let error = match open_directory(&linked_directory, false, 0) {
            Ok(_) => panic!("a directory reparse point is refused through its opened handle"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("reparse point"));
        fs::remove_dir_all(root).expect("remove test directory");
    }
}
