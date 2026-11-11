//! Descriptor-relative access to fixed, absolute protected paths.
//!
//! Unix descent starts from `/` and opens every directory relative to the
//! descriptor already held.  `O_NOFOLLOW` applies to every component, not just
//! the leaf. Every ancestor must be readable as well as searchable: portable
//! Unix has no search-only directory descriptor. Callers retain ownership of
//! object-specific policy decisions.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path};

/// A single, validated final pathname component that every supported platform
/// treats as an ordinary child entry.
///
/// `Directory` only accepts this type for leaf operations, so a capability
/// cannot be made to address its parent or another rooted path by accident.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeafName(OsString);

impl LeafName {
    /// Accept exactly one normal path component.
    pub fn new(name: &OsStr) -> io::Result<Self> {
        if contains_nul(name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected leaf contains an interior NUL",
            ));
        }
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
        if !is_ordinary_child_name(component) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected leaf is reserved or has a character treated specially by a supported platform",
            ));
        }
        Ok(Self(component.to_os_string()))
    }

    pub fn as_os_str(&self) -> &OsStr {
        &self.0
    }
}

/// A single existing directory component used only while descending a protected
/// path. Unlike `LeafName`, this accepts every platform-legal directory name:
/// ancestors belong to the user's existing namespace, while protected leaves
/// are names this application creates and must be ordinary on every platform.
#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct AncestorName(OsString);

#[cfg(unix)]
impl AncestorName {
    /// Accept exactly one normal path component and no interior NUL. This is
    /// deliberately less restrictive than `LeafName`; do not use it for a
    /// public `Directory` operation.
    fn new(name: &OsStr) -> io::Result<Self> {
        if contains_nul(name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected ancestor contains an interior NUL",
            ));
        }
        let path = Path::new(name);
        let mut components = path.components();
        let Some(Component::Normal(component)) = components.next() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected ancestor is not one normal path component",
            ));
        };
        if components.next().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "protected ancestor is not one normal path component",
            ));
        }
        Ok(Self(component.to_os_string()))
    }

    fn as_os_str(&self) -> &OsStr {
        &self.0
    }
}

fn contains_nul(name: &OsStr) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        name.as_bytes().contains(&0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        name.encode_wide().any(|unit| unit == 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        name.to_string_lossy().contains('\0')
    }
}

/// Whether `name` is an ordinary child entry on every supported platform.
///
/// Windows interprets these names specially, so they are refused everywhere:
/// callers must never create a protected leaf that another supported platform
/// cannot address as an ordinary child.
fn is_ordinary_child_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    if name
        .chars()
        .last()
        .is_some_and(|character| matches!(character, '.' | ' '))
        || name.chars().any(|character| {
            character <= '\u{1f}'
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return false;
    }

    let base = name.split('.').next().unwrap_or_default();
    let base = base.to_ascii_uppercase();
    !matches!(
        base.as_str(),
        "CON"
            | "CONIN$"
            | "CONOUT$"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

// Win32 maps both ERROR_FILE_NOT_FOUND (2) and ERROR_PATH_NOT_FOUND (3) to
// ErrorKind::NotFound. Only the former denotes an absent final component.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_file_not_found_status(status: Option<i32>) -> bool {
    status == Some(2)
}

/// Converts an absolute Win32 path to the verbatim form required by the raw
/// Win32 pathname APIs used below. This stays independent of the host OS so
/// its prefix rules can be tested wherever this crate's tests run.
#[cfg_attr(not(windows), allow(dead_code))]
fn verbatim_wide_path(mut path: Vec<u16>, description: &str) -> io::Result<Vec<u16>> {
    const BACKSLASH: u16 = b'\\' as u16;
    const SLASH: u16 = b'/' as u16;
    const QUESTION: u16 = b'?' as u16;
    const DOT: u16 = b'.' as u16;
    const COLON: u16 = b':' as u16;
    const U: u16 = b'U' as u16;
    const N: u16 = b'N' as u16;
    const C: u16 = b'C' as u16;
    const VERBATIM_PREFIX: &[u16] = &[BACKSLASH, BACKSLASH, QUESTION, BACKSLASH];
    const DEVICE_PREFIX: &[u16] = &[BACKSLASH, BACKSLASH, DOT, BACKSLASH];
    const NT_PREFIX: &[u16] = &[BACKSLASH, QUESTION, QUESTION, BACKSLASH];

    if path.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{description} contains an interior NUL"),
        ));
    }

    if path.starts_with(VERBATIM_PREFIX) {
        path.push(0);
        return Ok(path);
    }

    for unit in &mut path {
        if *unit == SLASH {
            *unit = BACKSLASH;
        }
    }

    if path.starts_with(DEVICE_PREFIX) || path.starts_with(NT_PREFIX) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{description} uses a Windows device namespace"),
        ));
    }

    let mut verbatim = if matches!(path.as_slice(), [drive, COLON, BACKSLASH, ..] if *drive != BACKSLASH)
    {
        VERBATIM_PREFIX.to_vec()
    } else if path.starts_with(&[BACKSLASH, BACKSLASH]) {
        vec![
            BACKSLASH, BACKSLASH, QUESTION, BACKSLASH, U, N, C, BACKSLASH,
        ]
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{description} is not an absolute Windows drive or UNC path"),
        ));
    };
    if path.starts_with(&[BACKSLASH, BACKSLASH]) {
        verbatim.extend_from_slice(&path[2..]);
    } else {
        verbatim.extend_from_slice(&path);
    }
    verbatim.push(0);
    Ok(verbatim)
}

#[cfg(unix)]
mod unix {
    use std::ffi::CString;
    use std::fs::{File, Metadata};
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    use super::{io, AncestorName, Component, LeafName, Path};

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
                name.as_os_str(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0,
                "protected path",
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
            #[expect(
                clippy::disallowed_methods,
                reason = "the crate's Unix descriptor-relative metadata primitive"
            )]
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
                name.as_os_str(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
                "protected path",
            )?;
            // SAFETY: openat returned a valid owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        pub fn rename(&self, from: &LeafName, to: &LeafName, replace: bool) -> io::Result<()> {
            if !replace {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Unix has no portable no-replace descriptor-relative rename",
                ));
            }
            let from = c_name(from)?;
            let to = c_name(to)?;
            #[expect(
                clippy::disallowed_methods,
                reason = "the crate's Unix descriptor-relative replacement primitive"
            )]
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
            #[expect(
                clippy::disallowed_methods,
                reason = "the crate's Unix descriptor-relative leaf-removal primitive"
            )]
            // SAFETY: name is NUL-terminated and the descriptor is owned.
            if unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn hard_link(&self, from: &LeafName, to: &LeafName) -> io::Result<()> {
            let from = c_name(from)?;
            let to = c_name(to)?;
            #[expect(
                clippy::disallowed_methods,
                reason = "the crate's Unix descriptor-relative link primitive"
            )]
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
        c_os_str(name.as_os_str(), "protected path")
    }

    fn c_os_str(name: &std::ffi::OsStr, description: &str) -> io::Result<CString> {
        if name.as_bytes().contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid {description} component"),
            ));
        }
        CString::new(name.as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{description} contains an interior NUL"),
            )
        })
    }

    fn open_at(
        parent: i32,
        name: &std::ffi::OsStr,
        flags: i32,
        mode: u32,
        description: &str,
    ) -> io::Result<i32> {
        let name = c_os_str(name, description)?;
        #[expect(
            clippy::disallowed_methods,
            reason = "the crate's Unix descriptor-relative leaf primitive"
        )]
        // SAFETY: the directory descriptor and C string remain valid for the call.
        let fd = unsafe { libc::openat(parent, name.as_ptr(), flags, mode) };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(fd)
        }
    }

    fn open_ancestor(parent: i32, name: &AncestorName) -> io::Result<i32> {
        open_at(
            parent,
            name.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0,
            "protected ancestor",
        )
        .map_err(|error| {
            if error.kind() == io::ErrorKind::PermissionDenied {
                io::Error::new(
                    error.kind(),
                    format!(
                        "protected path ancestor {} must be readable as well as searchable: {error}",
                        name.as_os_str().to_string_lossy(),
                    ),
                )
            } else {
                error
            }
        })
    }

    /// Parses every directory component of an absolute, normalized path before
    /// a root descriptor is opened. Callers must descend over these exact
    /// validated names so validation and use cannot diverge.
    fn ancestor_names(path: &Path, description: &str) -> io::Result<Vec<AncestorName>> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{description} is not absolute"),
            ));
        }

        path.components()
            .map(|component| match component {
                Component::RootDir => Ok(None),
                Component::Normal(name) => AncestorName::new(name).map(Some),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{description} is not normalized"),
                )),
            })
            .collect::<io::Result<Vec<_>>>()
            .map(|names| names.into_iter().flatten().collect())
    }

    /// Opens the parent of an absolute protected path by descending from `/`.
    pub fn open_parent(path: &Path) -> io::Result<(Directory, LeafName)> {
        let mut names = ancestor_names(path, "protected path")?;
        let leaf = names.pop().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "protected path has no leaf")
        })?;
        let leaf = LeafName::new(leaf.as_os_str())?;
        let root = CString::new("/").expect("root has no NUL");
        #[expect(
            clippy::disallowed_methods,
            reason = "the crate's Unix root-directory primitive"
        )]
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
            let fd = open_ancestor(directory.0.as_raw_fd(), &name)?;
            // SAFETY: openat returned an owned descriptor, replacing the parent only after success.
            directory = Directory(unsafe { File::from_raw_fd(fd) });
        }
        Ok((directory, leaf))
    }

    /// Opens an absolute directory by the same root-to-leaf descent.  Missing
    /// components are created relative to their verified parent when requested.
    pub fn open_directory(path: &Path, create: bool, mode: u32) -> io::Result<Directory> {
        let names = ancestor_names(path, "protected directory")?;
        let root = CString::new("/").expect("root has no NUL");
        #[expect(
            clippy::disallowed_methods,
            reason = "the crate's Unix root-directory primitive"
        )]
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
        for ancestor in names {
            let fd = open_ancestor(directory.0.as_raw_fd(), &ancestor);
            let fd = match fd {
                Ok(fd) => fd,
                Err(error) => {
                    if !create || error.kind() != io::ErrorKind::NotFound {
                        return Err(error);
                    }
                    let c_name = c_os_str(ancestor.as_os_str(), "protected ancestor")?;
                    #[expect(
                        clippy::disallowed_methods,
                        reason = "the crate's Unix descriptor-relative creation of a missing ancestor"
                    )]
                    // SAFETY: name is NUL-terminated and parent is an owned directory.
                    if unsafe {
                        libc::mkdirat(
                            directory.0.as_raw_fd(),
                            c_name.as_ptr(),
                            mode as libc::mode_t,
                        )
                    } != 0
                    {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::AlreadyExists {
                            return Err(error);
                        }
                    }
                    open_ancestor(directory.0.as_raw_fd(), &ancestor)?
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
        CreateFileW, CreateHardLinkW, DeleteFileW, FileAttributeTagInfo,
        GetFileInformationByHandleEx, MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
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
    /// On Windows the leaf-read race is closed — a protected file is opened once and every check and
    /// read uses that handle. Publication is pathname-based and is not protected against concurrent
    /// namespace changes, and ancestor directories are not protected either. Closing those needs
    /// handle-relative opens through `NtCreateFile`, which this does not use.
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
                GENERIC_READ | GENERIC_WRITE,
            )
        }

        pub fn rename(&self, from: &LeafName, to: &LeafName, replace: bool) -> io::Result<()> {
            if !replace {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Windows has no pathname rename that atomically refuses replacement",
                ));
            }
            let from = wide_path(&self.path.join(from.as_os_str()), "protected source path")?;
            let to = wide_path(
                &self.path.join(to.as_os_str()),
                "protected destination path",
            )?;
            #[expect(
                clippy::disallowed_methods,
                reason = "atomically replaces the Windows certificate pathname with write-through durability"
            )]
            // SAFETY: both paths are NUL-terminated and remain live for the call.
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

        pub fn remove_file(&self, name: &LeafName) -> io::Result<()> {
            let path = wide_path(&self.path.join(name.as_os_str()), "protected path")?;
            #[expect(
                clippy::disallowed_methods,
                reason = "removes Windows temporary leaves by pathname during cleanup"
            )]
            // SAFETY: path is NUL-terminated and remains live for the call.
            if unsafe { DeleteFileW(path.as_ptr()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn hard_link(&self, from: &LeafName, to: &LeafName) -> io::Result<()> {
            let from = wide_path(&self.path.join(from.as_os_str()), "protected source path")?;
            let to = wide_path(
                &self.path.join(to.as_os_str()),
                "protected destination path",
            )?;
            #[expect(
                clippy::disallowed_methods,
                reason = "publishes the Windows private-key leaf without replacing an existing key"
            )]
            // SAFETY: both paths are NUL-terminated and remain live for the call.
            if unsafe { CreateHardLinkW(to.as_ptr(), from.as_ptr(), std::ptr::null()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    fn is_missing_leaf(error: &io::Error) -> bool {
        super::windows_file_not_found_status(error.raw_os_error())
    }

    fn wide_path(path: &Path, description: &str) -> io::Result<Vec<u16>> {
        super::verbatim_wide_path(path.as_os_str().encode_wide().collect(), description)
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
        #[expect(
            clippy::disallowed_methods,
            reason = "the crate's Windows one-handle protected-leaf primitive"
        )]
        // SAFETY: wide is NUL-terminated and lives for the call. Delete sharing
        // preserves pathname publication and cleanup while a protected handle is open.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
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
            #[expect(
                clippy::disallowed_methods,
                reason = "Windows requested-directory creation has no public handle-relative primitive; the boundary comment states this limit"
            )]
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
#[expect(
    clippy::disallowed_methods,
    reason = "the tests build their fixtures by pathname, in temporary directories of their own"
)]
mod tests {
    #[cfg(unix)]
    use super::AncestorName;
    use super::LeafName;
    #[cfg(unix)]
    use super::{open_directory, open_parent};
    use std::fs;
    #[cfg(unix)]
    use std::io;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn verbatim_wide_path_preserves_win32_absolute_path_access() {
        fn convert(path: &str) -> String {
            let wide = super::verbatim_wide_path(path.encode_utf16().collect(), "test path")
                .expect("convert absolute Windows path");
            String::from_utf16(&wide[..wide.len() - 1]).expect("converted UTF-16 path")
        }

        assert_eq!(
            convert(r"C:\Users\lasterm\identity"),
            r"\\?\C:\Users\lasterm\identity"
        );

        let long_path = format!(r"C:\{}", "identity\\".repeat(40));
        assert!(
            long_path.encode_utf16().count() > 260,
            "test path exceeds MAX_PATH"
        );
        assert_eq!(convert(&long_path), format!(r"\\?\{long_path}"));

        assert_eq!(
            convert(r"\\server\share\identity"),
            r"\\?\UNC\server\share\identity"
        );

        assert_eq!(
            convert(r"\\?\C:\already-verbatim\identity"),
            r"\\?\C:\already-verbatim\identity"
        );

        let error =
            super::verbatim_wide_path(r"\\.\PhysicalDrive0".encode_utf16().collect(), "test path")
                .expect_err("device namespaces are not protected paths");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("device namespace"));
    }

    #[test]
    fn leaf_name_rejects_nonordinary_names_on_every_platform() {
        use std::ffi::{OsStr, OsString};

        assert!(LeafName::new(OsStr::new("ordinary-name")).is_ok());
        for invalid in ["", ".", "..", "a/b", "/abs"] {
            assert!(
                LeafName::new(OsStr::new(invalid)).is_err(),
                "{invalid:?} must not be a protected leaf"
            );
        }
        let interior_nul = OsString::from("ordinary\0name");
        assert!(
            LeafName::new(&interior_nul).is_err(),
            "an interior NUL must never be a protected leaf"
        );
        for invalid in [
            "CON",
            "CON.txt",
            "NUL.tar.gz",
            "COM1",
            "LPT9",
            // Documented beside the rest; the list missed them (#227).
            "CONIN$",
            "conout$",
            "CoNiN$.log",
            "auth.json:stream",
            "trailing.",
            "trailing ",
        ] {
            assert!(
                LeafName::new(OsStr::new(invalid)).is_err(),
                "{invalid:?} is not an ordinary child name on every supported platform"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn ancestor_name_only_rejects_non_components_and_interior_nuls() {
        use std::ffi::{OsStr, OsString};

        for accepted in ["CON", "team:data", "trailing.", "trailing "] {
            assert!(
                AncestorName::new(OsStr::new(accepted)).is_ok(),
                "{accepted:?} is a platform-legal existing ancestor"
            );
        }
        let separator = AncestorName::new(OsStr::new("ancestor/child"))
            .expect_err("an ancestor is exactly one component");
        assert!(separator.to_string().contains("ancestor"));
        let interior_nul = AncestorName::new(&OsString::from("ancestor\0child"))
            .expect_err("an ancestor contains no interior NUL");
        assert!(interior_nul.to_string().contains("ancestor"));
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_walk_reads_platform_legal_ancestor_names() {
        use std::io::Read;

        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-legal-ancestors-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);

        for ancestor in ["CON", "team:data"] {
            let protected = root.join(ancestor).join("auth.json");
            fs::create_dir_all(protected.parent().expect("protected parent"))
                .expect("create legal ancestor");
            fs::write(&protected, ancestor).expect("write protected file");

            let (parent, leaf) =
                open_parent(&protected).expect("a platform-legal ancestor remains traversable");
            let mut file = parent
                .open_existing(&leaf)
                .expect("open protected file")
                .expect("protected file exists");
            let mut contents = String::new();
            file.read_to_string(&mut contents)
                .expect("read protected file through its directory capability");
            assert_eq!(contents, ancestor);
        }

        assert!(
            LeafName::new(std::ffi::OsStr::new("CON")).is_err(),
            "a DOS device basename remains invalid for a protected leaf"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_walk_refuses_unsafe_components_and_keeps_absence_distinct() {
        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-descriptor-walk-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("safe/nested")).unwrap();
        let clean = root.join("safe/nested/leaf");
        let (parent, leaf) = open_parent(&clean).unwrap();
        assert!(parent.open_existing(&leaf).unwrap().is_none());
        fs::write(&clean, "ok").unwrap();
        assert!(parent.open_existing(&leaf).unwrap().is_some());
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
    fn invalid_directory_component_creates_no_directory() {
        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-invalid-directory-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create empty fixture root");
        let invalid = root.join("created-before-invalid").join("..").join("later");

        let error = match open_directory(&invalid, true, 0o700) {
            Ok(_) => panic!("an invalid directory component is refused before creation"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(
            fs::read_dir(&root)
                .expect("read unchanged fixture root")
                .next()
                .is_none(),
            "an invalid directory component creates no directory"
        );
        fs::remove_dir_all(root).expect("remove fixture root");
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

    #[cfg(unix)]
    #[test]
    fn execute_only_ancestor_error_names_the_readable_prerequisite() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-readable-ancestor-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let ancestor = root.join("execute-only");
        fs::create_dir_all(ancestor.join("child")).expect("create protected path");
        // A mode-0711 directory owned by another user is execute-only to this
        // process. This test owns its fixture, so mode 0111 reproduces that
        // same no-read, search-only access without requiring another account.
        fs::set_permissions(&ancestor, fs::Permissions::from_mode(0o111))
            .expect("make ancestor search-only");

        let error = match open_parent(&ancestor.join("child/leaf")) {
            Ok(_) => panic!("a search-only ancestor cannot supply a portable directory descriptor"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(
            error
                .to_string()
                .contains("must be readable as well as searchable"),
            "{error}"
        );

        fs::set_permissions(&ancestor, fs::Permissions::from_mode(0o700))
            .expect("restore fixture permissions");
        fs::remove_dir_all(root).expect("remove fixture");
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
        symlink_dir(root.join("safe"), &linked_directory).expect("create directory reparse point");
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

    #[cfg(windows)]
    #[test]
    fn windows_leaf_open_refuses_when_an_existing_store_ancestor_vanishes() {
        use super::open_parent;
        use std::io::ErrorKind;
        use windows_sys::Win32::Foundation::ERROR_PATH_NOT_FOUND;

        let root = std::env::temp_dir().join(format!(
            "lasterm-protected-fs-windows-vanished-ancestor-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let store = root.join("identity");
        let pin = store.join("hub-pins.json");
        fs::create_dir_all(&store).expect("create existing pin store");
        fs::write(&pin, "{}").expect("write existing pin");

        let (directory, leaf) = open_parent(&pin).expect("open existing pin-store directory");
        fs::rename(&store, root.join("identity-moved"))
            .expect("make the existing store ancestor vanish");
        let error = directory
            .open_existing(&leaf)
            .expect_err("a vanished ancestor is not an absent leaf");
        assert_eq!(error.kind(), ErrorKind::NotFound);
        assert_eq!(error.raw_os_error(), Some(ERROR_PATH_NOT_FOUND as i32));

        fs::remove_dir_all(&root).expect("remove fixture");
    }
}
