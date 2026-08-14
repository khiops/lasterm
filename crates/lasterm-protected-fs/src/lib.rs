//! Descriptor-relative access to fixed, absolute protected paths.
//!
//! Unix descent starts from `/` and opens every directory relative to the
//! descriptor already held.  `O_NOFOLLOW` applies to every component, not just
//! the leaf.  Callers retain ownership of object-specific policy decisions.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path};

/// A single, validated final pathname component.
///
/// `Directory` only accepts this type for leaf operations, so a capability
/// cannot be made to address its parent or another rooted path by accident.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeafName(OsString);

impl LeafName {
    /// Accept exactly one normal path component.
    pub fn new(name: &OsStr) -> io::Result<Self> {
        let path = Path::new(name);
        let mut components = path.components();
        let Some(Component::Normal(component)) = components.next() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected leaf is not one normal path component",
            ));
        };
        if components.next().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected leaf is not one normal path component",
            ));
        }
        Ok(Self(component.to_os_string()))
    }

    pub fn as_os_str(&self) -> &OsStr {
        &self.0
    }
}

// Win32 maps both ERROR_FILE_NOT_FOUND (2) and ERROR_PATH_NOT_FOUND (3) to
// ErrorKind::NotFound. Only the former denotes an absent final component.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_file_not_found_status(status: Option<i32>) -> bool {
    status == Some(2)
}

#[cfg(unix)]
mod unix {
    use std::ffi::CString;
    use std::fs::{File, Metadata};
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    use super::{io, Component, LeafName, Path};

    /// Metadata read with `fstatat(2)` relative to a checked directory handle.
    pub struct LeafMetadata(libc::stat);

    impl LeafMetadata {
        pub fn is_file(&self) -> bool {
            self.0.st_mode & libc::S_IFMT == libc::S_IFREG
        }

        pub fn uid(&self) -> u32 {
            self.0.st_uid
        }

        pub fn mode(&self) -> u32 {
            #[allow(clippy::useless_conversion)] // Darwin's mode_t is u16.
            u32::from(self.0.st_mode)
        }
    }

    /// An owned directory descriptor obtained by a no-symlink descent from `/`.
    pub struct Directory(File);

    impl Directory {
        pub fn metadata(&self) -> io::Result<Metadata> {
            self.0.metadata()
        }

        pub fn sync_all(&self) -> io::Result<()> {
            self.0.sync_all()
        }

        /// ```compile_fail
        /// use lasterm_protected_fs::Directory;
        /// use std::ffi::OsStr;
        ///
        /// fn cannot_escape(dir: &Directory, name: &OsStr) {
        ///     let _ = dir.open_existing(name);
        /// }
        /// ```
        pub fn open_existing(&self, name: &LeafName) -> io::Result<Option<File>> {
            match open_at(
                self.0.as_raw_fd(),
                name,
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
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

        pub fn inspect_existing(&self, name: &LeafName) -> io::Result<Option<LeafMetadata>> {
            let name = c_name(name)?;
            let mut stat = MaybeUninit::<libc::stat>::uninit();
            // SAFETY: the directory descriptor and C string are valid, and stat
            // points to suitably aligned uninitialized storage for fstatat.
            if unsafe {
                libc::fstatat(
                    self.0.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                let error = io::Error::last_os_error();
                return if error.kind() == io::ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            // SAFETY: fstatat filled the storage on its successful return.
            Ok(Some(LeafMetadata(unsafe { stat.assume_init() })))
        }

        pub fn create_new(&self, name: &LeafName) -> io::Result<File> {
            let fd = open_at(
                self.0.as_raw_fd(),
                name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )?;
            // SAFETY: openat returned a valid owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        pub fn rename(
            &self,
            source: &File,
            from: &LeafName,
            to: &LeafName,
            replace: bool,
        ) -> io::Result<()> {
            let _ = source;
            if !replace {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Unix has no portable no-replace descriptor-relative rename",
                ));
            }
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

        pub fn remove_file(&self, name: &LeafName) -> io::Result<()> {
            let name = c_name(name)?;
            // SAFETY: name is NUL-terminated and the descriptor is owned.
            if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn hard_link(&self, source: &File, from: &LeafName, to: &LeafName) -> io::Result<()> {
            let _ = source;
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

    fn c_name(name: &LeafName) -> io::Result<CString> {
        if name.as_os_str().as_bytes().contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid protected path component",
            ));
        }
        CString::new(name.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected path contains an interior NUL",
            )
        })
    }

    fn open_at(parent: i32, name: &LeafName, flags: i32, mode: u32) -> io::Result<i32> {
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
    pub fn open_parent(path: &Path) -> io::Result<(Directory, LeafName)> {
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
                Component::Normal(name) => names.push(LeafName::new(name)?),
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
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
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
                &LeafName::new(name)?,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
            );
            let fd = match fd {
                Ok(fd) => fd,
                Err(error) => {
                if !create || error.kind() != io::ErrorKind::NotFound {
                    return Err(error);
                }
                let name = LeafName::new(name)?;
                let c_name = c_name(&name)?;
                // SAFETY: name is NUL-terminated and parent is an owned directory.
                if unsafe {
                    libc::mkdirat(
                        directory.0.as_raw_fd(),
                        c_name.as_ptr(),
                        mode as libc::mode_t,
                    )
                } != 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
                open_at(
                    directory.0.as_raw_fd(),
                    &name,
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
pub use unix::{open_directory, open_parent, Directory, LeafMetadata};

#[cfg(windows)]
mod windows {
    use std::fs::{File, Metadata};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileRenameInfo, DELETE,
        GetFileInformationByHandleEx, SetFileInformationByHandle, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_RENAME_INFO_0, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    use super::{io, Component, LeafName, Path};

    /// Metadata read through an opened, checked Windows leaf handle.
    pub struct LeafMetadata(Metadata);

    impl LeafMetadata {
        pub fn is_file(&self) -> bool {
            self.0.is_file()
        }
    }

    /// A Windows directory handle plus its lexical path for initial leaf opens
    /// and requested directory creation.
    ///
    /// Windows has no public handle-relative open. Ancestor substitution is not
    /// prevented. Initial leaf opens and `open_directory(create: true)` both
    /// reconstruct a path. Each leaf is then opened once with delete sharing
    /// withheld and inspected through that same handle; publication and
    /// deletion use that handle rather than reconstructing its path.
    pub struct Directory {
        file: File,
        path: PathBuf,
    }

    impl Directory {
        pub fn metadata(&self) -> io::Result<Metadata> {
            self.file.metadata()
        }

        pub fn open_existing(&self, name: &LeafName) -> io::Result<Option<File>> {
            match open_leaf(
                &self.path.join(name.as_os_str()),
                OPEN_EXISTING,
                GENERIC_READ,
            ) {
                Ok(file) => Ok(Some(file)),
                Err(error) if is_missing_leaf(&error) => Ok(None),
                Err(error) => Err(error),
            }
        }

        pub fn inspect_existing(&self, name: &LeafName) -> io::Result<Option<LeafMetadata>> {
            match open_leaf(
                &self.path.join(name.as_os_str()),
                OPEN_EXISTING,
                FILE_READ_ATTRIBUTES,
            ) {
                Ok(file) => Ok(Some(LeafMetadata(file.metadata()?))),
                Err(error) if is_missing_leaf(&error) => Ok(None),
                Err(error) => Err(error),
            }
        }

        pub fn create_new(&self, name: &LeafName) -> io::Result<File> {
            open_leaf(
                &self.path.join(name.as_os_str()),
                CREATE_NEW,
                GENERIC_READ | GENERIC_WRITE | DELETE,
            )
        }

        pub fn rename(
            &self,
            source: &File,
            _from: &LeafName,
            to: &LeafName,
            replace: bool,
        ) -> io::Result<()> {
            let mut information = rename_information(self.file.as_raw_handle(), to, replace)?;
            // SAFETY: source is the checked temporary handle, and information is
            // a correctly sized FILE_RENAME_INFO buffer with a relative leaf.
            if unsafe {
                SetFileInformationByHandle(
                    source.as_raw_handle(),
                    FileRenameInfo,
                    information.as_mut_ptr().cast(),
                    information.len() as u32,
                )
            } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn remove_file(&self, name: &LeafName) -> io::Result<()> {
            let file = open_leaf(
                &self.path.join(name.as_os_str()),
                OPEN_EXISTING,
                GENERIC_READ | DELETE,
            )?;
            let information = FILE_DISPOSITION_INFO { DeleteFile: 1 };
            // SAFETY: file is the checked leaf handle and DELETE access was
            // requested when it was opened.
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    std::ptr::from_ref(&information).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn hard_link(
            &self,
            _source: &File,
            _from: &LeafName,
            _to: &LeafName,
        ) -> io::Result<()> {
            // SetFileInformationByHandle has no FileLinkInfo class. Refuse this
            // operation rather than reopening a checked source by its pathname.
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Windows has no handle-based hard-link publication primitive",
            ))
        }
    }

    fn is_missing_leaf(error: &io::Error) -> bool {
        super::windows_file_not_found_status(error.raw_os_error())
    }

    fn rename_information(
        directory: std::os::windows::io::RawHandle,
        name: &LeafName,
        replace: bool,
    ) -> io::Result<Vec<u8>> {
        let filename: Vec<u16> = name.as_os_str().encode_wide().collect();
        if filename.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected leaf contains an interior NUL",
            ));
        }
        let header = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let mut buffer = vec![0_u8; header + filename.len() * std::mem::size_of::<u16>()];
        let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // SAFETY: buffer is exactly FILE_RENAME_INFO's fixed header plus its
        // variable UTF-16 leaf; Vec's allocation alignment satisfies the struct.
        unsafe {
            std::ptr::write(
                information,
                FILE_RENAME_INFO {
                    Anonymous: FILE_RENAME_INFO_0 {
                        ReplaceIfExists: replace as u8,
                    },
                    RootDirectory: directory,
                    FileNameLength: (filename.len() * std::mem::size_of::<u16>()) as u32,
                    FileName: [0],
                },
            );
            std::ptr::copy_nonoverlapping(
                filename.as_ptr(),
                buffer.as_mut_ptr().add(header).cast::<u16>(),
                filename.len(),
            );
        }
        Ok(buffer)
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
        if disposition != CREATE_NEW {
            reject_reparse_point(&file)?;
            make_non_inheritable(&file)?;
        }
        Ok(file)
    }

    fn open_leaf(path: &Path, disposition: u32, access: u32) -> io::Result<File> {
        validate_path(path, true)?;
        open_path(path, disposition, access, 0)
    }

    pub fn open_parent(path: &Path) -> io::Result<(Directory, LeafName)> {
        validate_path(path, true)?;
        let parent = path.parent().expect("a path with a leaf has a parent");
        let leaf = LeafName::new(path.file_name().expect("validated path has a leaf"))?;
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
pub use windows::{open_directory, open_parent, Directory, LeafMetadata};

#[cfg(test)]
mod tests {
    use super::LeafName;
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
                call: "std::fs::create_dir_all(parent)",
                why: "creates the non-protected close-behavior preference directory",
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
                call: "if is_reparse_point || metadata.file_type().is_symlink() || !metadata.is_dir()",
                why: "examines already-read runtime-directory metadata to reject symlinks",
            },
            AllowedCall {
                source: "desktop",
                call: "if metadata.file_type().is_symlink() || !metadata.is_dir()",
                why: "examines already-read runtime-directory metadata to reject symlinks",
            },
            AllowedCall {
                source: "desktop",
                call: "if selected_metadata.file_type().is_symlink()",
                why: "examines already-read explicitly user-selected agent metadata",
            },
            AllowedCall {
                source: "desktop",
                call: "if canonical_metadata.file_type().is_symlink()",
                why: "examines already-read resolved explicitly user-selected agent metadata",
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
                source: "desktop",
                call: "std::fs::create_dir_all(&log_dir)",
                why: "creates the non-protected hub diagnostic-log directory",
            },
            AllowedCall {
                source: "identity",
                call: "fs::remove_file(path)",
                why: "unsupported-platform temporary cleanup; Unix and Windows use the crate",
            },
            AllowedCall {
                source: "identity",
                call: "fs::hard_link(&temporary_path, key_path)",
                why: "unsupported-platform private-key publication fallback; Unix and Windows use the crate",
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
                call: "CreateFileW, FileAttributeTagInfo, FileDispositionInfo",
                why: "imports the crate's Windows checked-handle file primitives",
            },
            AllowedCall {
                source: "protected-fs",
                call: "CreateFileW(",
                why: "the crate's Windows one-handle protected-leaf primitive",
            },
            AllowedCall {
                source: "protected-fs",
                call: "std::fs::create_dir_all(path)",
                why: "Windows requested-directory creation has no public handle-relative primitive; the boundary comment states this limit",
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
            "fs::remove_dir_all",
            "fs::metadata",
            "fs::symlink_metadata",
            "fs::hard_link",
            "fs::create_dir",
            "fs::create_dir_all",
            "fs::set_permissions",
            "fs::read_dir",
            "fs::copy",
            "fs::canonicalize",
            "File::open",
            "File::create",
            "OpenOptions",
            "libc::open",
            "CreateFileW",
            "symlink(",
            "MoveFileExW",
            "DeleteFileW",
            "CreateHardLinkW",
            "RemoveDirectoryW",
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

    #[test]
    fn leaf_name_accepts_exactly_one_normal_component() {
        use std::ffi::OsStr;

        assert!(LeafName::new(OsStr::new("ordinary-name")).is_ok());
        for invalid in ["", ".", "..", "a/b", "/abs"] {
            assert!(
                LeafName::new(OsStr::new(invalid)).is_err(),
                "{invalid:?} must not be a protected leaf"
            );
        }
        #[cfg(windows)]
        assert!(LeafName::new(OsStr::new(r"C:\\escape")).is_err());
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
            .open_existing(&leaf)
            .unwrap()
            .is_none());
        fs::write(&clean, "ok").unwrap();
        assert!(parent
            .open_existing(&leaf)
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

    #[cfg(unix)]
    #[test]
    fn descriptor_relative_metadata_inspects_an_unreadable_regular_leaf() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-metadata-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("unreadable-certificate");
        fs::write(&path, "certificate").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

        let (parent, leaf) = open_parent(&path).unwrap();
        assert!(parent
            .inspect_existing(&leaf)
            .unwrap()
            .expect("the regular leaf exists")
            .is_file());

        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn windows_only_file_not_found_means_an_absent_leaf() {
        assert!(super::windows_file_not_found_status(Some(2)));
        assert!(
            !super::windows_file_not_found_status(Some(3)),
            "ERROR_PATH_NOT_FOUND is an ancestor failure, not an absent leaf"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_not_found_is_not_an_absent_leaf() {
        use windows_sys::Win32::Foundation::ERROR_PATH_NOT_FOUND;

        assert!(
            !super::windows_file_not_found_status(Some(ERROR_PATH_NOT_FOUND as i32)),
            "ERROR_PATH_NOT_FOUND is an ancestor failure, not an absent leaf"
        );
    }
}
