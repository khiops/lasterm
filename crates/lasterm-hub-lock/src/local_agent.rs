//! The hub's connection to the local agent, and the account at its other end.
//!
//! The first thing the hub writes to the local agent is its token, and what
//! follows is everything typed into a terminal. The process at the other end
//! must therefore run as the hub's own account, and Node cannot say which
//! account that is: it has no `SO_PEERCRED` for a Unix socket, and no way to
//! name the server process of a named pipe. So the connection is opened here,
//! where the operating system can be asked, and Node receives it as a
//! descriptor. The hub writes to that descriptor only once `verify_peer` has
//! accepted it.
//!
//! On Windows the pipe is opened at `SECURITY_IDENTIFICATION`, so the server
//! can learn who connected but cannot act as that account.

use std::fmt;

/// Why the endpoint could not be reached. `code` is the name Node gives the
/// same failure (`ENOENT`, `ECONNREFUSED`, `EACCES`, `EBUSY`, ...), so a caller
/// still tells "nobody is there" from "not allowed there".
#[derive(Debug)]
pub(crate) struct ConnectError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ConnectError {
    fn new(code: &'static str, path: &str, detail: impl fmt::Display) -> Self {
        Self {
            code,
            message: format!("cannot connect to the local agent at {path}: {detail}"),
        }
    }
}

#[cfg(unix)]
pub(crate) use unix::{connect_for_node, verify_for_node};
#[cfg(windows)]
pub(crate) use windows::{connect_for_node, verify_for_node};

#[cfg(unix)]
mod unix {
    use super::ConnectError;
    use std::io;
    use std::os::fd::{AsRawFd, BorrowedFd, IntoRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;

    /// Connect to the socket at `path`. Nothing is written to it.
    pub(crate) fn connect(path: &str) -> Result<OwnedFd, ConnectError> {
        UnixStream::connect(path)
            .map(OwnedFd::from)
            .map_err(|error| ConnectError::new(errno_name(&error), path, error))
    }

    /// `connect`, with the connection handed over as a raw descriptor for Node
    /// to adopt, and close.
    pub(crate) fn connect_for_node(path: &str) -> Result<i32, ConnectError> {
        connect(path).map(IntoRawFd::into_raw_fd)
    }

    /// The process at the other end of `connection` must run as this process's
    /// effective user.
    pub(crate) fn verify_peer(connection: BorrowedFd<'_>) -> Result<(), String> {
        // SAFETY: geteuid has no preconditions and cannot fail.
        verify_peer_runs_as(connection, unsafe { libc::geteuid() })
    }

    /// `verify_peer` on a descriptor Node holds.
    pub(crate) fn verify_for_node(fd: i32) -> Result<(), String> {
        if fd < 0 {
            return Err(format!("{fd} is not a descriptor"));
        }
        // SAFETY: the caller holds `fd` open for the duration of this call.
        verify_peer(unsafe { BorrowedFd::borrow_raw(fd) })
    }

    /// `verify_peer` against a given user, so a test can name another one.
    pub(crate) fn verify_peer_runs_as(
        connection: BorrowedFd<'_>,
        expected: libc::uid_t,
    ) -> Result<(), String> {
        let peer = peer_uid(connection).map_err(|error| {
            format!("cannot tell which account the local agent runs as: {error}")
        })?;
        if peer != expected {
            return Err(format!(
                "the local agent runs as uid {peer}, not as this user (uid {expected})"
            ));
        }
        Ok(())
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn peer_uid(connection: BorrowedFd<'_>) -> io::Result<libc::uid_t> {
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let expected = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let mut length = expected;
        // SAFETY: the pointer and length describe `credentials`, which this
        // frame owns for the duration of the call.
        let result = unsafe {
            libc::getsockopt(
                connection.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        if length != expected {
            return Err(io::Error::other("SO_PEERCRED returned a short answer"));
        }
        Ok(credentials.uid)
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    fn peer_uid(connection: BorrowedFd<'_>) -> io::Result<libc::uid_t> {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: both out-pointers refer to locals of this frame.
        if unsafe { libc::getpeereid(connection.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }

    fn errno_name(error: &io::Error) -> &'static str {
        match error.raw_os_error() {
            Some(libc::ENOENT) => "ENOENT",
            Some(libc::ECONNREFUSED) => "ECONNREFUSED",
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            Some(libc::EAGAIN) => "EAGAIN",
            Some(libc::ENOTDIR) => "ENOTDIR",
            Some(libc::ELOOP) => "ELOOP",
            Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
            _ if error.kind() == io::ErrorKind::InvalidInput => "EINVAL",
            _ => "UNKNOWN",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::fd::AsFd;
        use std::os::unix::fs::DirBuilderExt;
        use std::os::unix::net::UnixListener;
        use std::path::PathBuf;

        /// A private directory this test made, removed however the test ends.
        struct TestDir(PathBuf);

        impl TestDir {
            fn new(label: &str) -> Self {
                let base = std::env::temp_dir();
                let pid = std::process::id();
                for attempt in 0..1024 {
                    let dir = base.join(format!("lasterm-local-agent-{label}-{pid}-{attempt}"));
                    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                        Ok(()) => return Self(dir),
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                        Err(error) => panic!("could not create {}: {error}", dir.display()),
                    }
                }
                panic!(
                    "could not allocate a test directory under {}",
                    base.display()
                );
            }
        }

        impl Drop for TestDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn a_socket_this_user_serves_is_accepted() {
            let dir = TestDir::new("own");
            let path = dir.0.join("agent.sock");
            let _listener = UnixListener::bind(&path).expect("bind a test socket");

            let connection = connect(path.to_str().unwrap()).expect("connect to it");
            verify_peer(connection.as_fd()).expect("our own socket is ours");
        }

        #[test]
        fn a_peer_running_as_another_user_is_refused() {
            let dir = TestDir::new("other");
            let path = dir.0.join("agent.sock");
            let _listener = UnixListener::bind(&path).expect("bind a test socket");

            let connection = connect(path.to_str().unwrap()).expect("connect to it");
            // SAFETY: geteuid has no preconditions.
            let someone_else = unsafe { libc::geteuid() }.wrapping_add(1);
            let refusal = verify_peer_runs_as(connection.as_fd(), someone_else)
                .expect_err("a peer of another uid must be refused");
            assert!(
                refusal.contains(&format!("uid {someone_else}")),
                "{refusal}"
            );
        }

        #[test]
        fn a_missing_socket_is_enoent() {
            let dir = TestDir::new("missing");
            let path = dir.0.join("agent.sock");
            let error = connect(path.to_str().unwrap()).expect_err("nothing is there");
            assert_eq!(error.code, "ENOENT", "{}", error.message);
            assert!(error.message.contains(path.to_str().unwrap()));
        }

        #[test]
        fn a_socket_nobody_listens_on_is_econnrefused() {
            let dir = TestDir::new("stale");
            let path = dir.0.join("agent.sock");
            drop(UnixListener::bind(&path).expect("bind a test socket"));
            let error = connect(path.to_str().unwrap()).expect_err("nobody listens");
            assert_eq!(error.code, "ECONNREFUSED", "{}", error.message);
        }

        #[test]
        fn a_negative_descriptor_is_refused_without_a_call() {
            assert!(verify_for_node(-1).is_err());
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::ConnectError;
    use std::ffi::{c_int, CStr, OsStr};
    use std::fmt;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_BAD_PATHNAME, ERROR_FILE_NOT_FOUND, ERROR_INVALID_NAME,
        ERROR_PATH_NOT_FOUND, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const LOCAL_PIPE_PREFIX: &str = r"\\.\pipe\";

    /// Open the named pipe at `path` as a client. Nothing is written to it.
    pub(crate) fn connect(path: &str) -> Result<OwnedHandle, ConnectError> {
        let is_local_pipe = path.len() > LOCAL_PIPE_PREFIX.len()
            && path
                .get(..LOCAL_PIPE_PREFIX.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(LOCAL_PIPE_PREFIX));
        if !is_local_pipe {
            return Err(ConnectError::new(
                "EINVAL",
                path,
                format!("not a pipe name of this machine ({LOCAL_PIPE_PREFIX}<name>)"),
            ));
        }
        let wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call; no security
        // attributes means the handle is not inheritable.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = io::Error::last_os_error();
            return Err(ConnectError::new(error_name(&error), path, error));
        }
        // SAFETY: CreateFileW returned a handle this function now owns.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    /// `connect`, with the handle handed over as a descriptor of Node's own C
    /// runtime for Node to adopt, and close.
    ///
    /// Node links its C runtime into its executable, and a descriptor only
    /// means something to the runtime that issued it, so it is issued there,
    /// through `uv_open_osfhandle`, which the executable exports for addons.
    pub(crate) fn connect_for_node(path: &str) -> Result<i32, ConnectError> {
        let pipe = connect(path)?;
        let symbol = host_symbol(c"uv_open_osfhandle")
            .map_err(|detail| ConnectError::new("UNKNOWN", path, detail))?;
        // SAFETY: libuv declares `int uv_open_osfhandle(uv_os_fd_t)`, and
        // uv_os_fd_t is HANDLE on Windows.
        let open = unsafe {
            std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                unsafe extern "C" fn(HANDLE) -> c_int,
            >(symbol)
        };
        let raw = pipe.as_raw_handle();
        // SAFETY: `raw` is a valid handle; on success the runtime owns it.
        let fd = unsafe { open(raw) };
        if fd < 0 {
            return Err(ConnectError::new(
                "UNKNOWN",
                path,
                "the pipe handle could not be given a descriptor",
            ));
        }
        // The descriptor owns the handle from here on.
        std::mem::forget(pipe);
        Ok(fd)
    }

    /// The process serving `pipe` must run as this process's user.
    pub(crate) fn verify_peer(pipe: BorrowedHandle<'_>) -> Result<(), String> {
        // SAFETY: the pseudo-handle of the current process needs no closing.
        let own = process_user(unsafe { GetCurrentProcess() })
            .map_err(|error| format!("cannot tell which account this process runs as: {error}"))?;
        verify_peer_runs_as(pipe, &own)
    }

    /// `verify_peer` on a descriptor of Node's C runtime.
    pub(crate) fn verify_for_node(fd: i32) -> Result<(), String> {
        let symbol = host_symbol(c"uv_get_osfhandle")?;
        // SAFETY: libuv declares `uv_os_fd_t uv_get_osfhandle(int)`, and
        // uv_os_fd_t is HANDLE on Windows.
        let get = unsafe {
            std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                unsafe extern "C" fn(c_int) -> HANDLE,
            >(symbol)
        };
        // SAFETY: an unknown descriptor yields INVALID_HANDLE_VALUE, checked below.
        let handle = unsafe { get(fd) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(format!("{fd} is not a descriptor"));
        }
        // SAFETY: the caller holds `fd`, and with it this handle, open for the
        // duration of this call.
        verify_peer(unsafe { BorrowedHandle::borrow_raw(handle) })
    }

    /// `verify_peer` against a given account, so a test can name another one.
    pub(crate) fn verify_peer_runs_as(
        pipe: BorrowedHandle<'_>,
        expected: &Sid,
    ) -> Result<(), String> {
        let mut pid = 0u32;
        // SAFETY: `pipe` is a live handle and `pid` a local of this frame.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
            return Err(format!(
                "cannot tell which process serves the local agent's pipe: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: plain call; a null result is checked below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(format!(
                "cannot open process {pid}, which serves the local agent's pipe: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: OpenProcess returned a handle this function now owns.
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        let server = process_user(process.as_raw_handle()).map_err(|error| {
            format!("cannot tell which account process {pid}, which serves the local agent's pipe, runs as: {error}")
        })?;
        if server != *expected {
            return Err(format!(
                "the local agent's pipe is served by process {pid}, which runs as {server}, not as this user ({expected})"
            ));
        }
        Ok(())
    }

    /// A security identifier, as the bytes Windows compares.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(crate) struct Sid(Vec<u8>);

    impl Sid {
        #[cfg(test)]
        pub(crate) fn from_bytes(bytes: &[u8]) -> Self {
            Self(bytes.to_vec())
        }
    }

    /// The `S-1-…` form, for messages.
    impl fmt::Display for Sid {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            let bytes = &self.0;
            if bytes.len() < 8 {
                return write!(f, "an unreadable SID");
            }
            let authority = bytes[2..8]
                .iter()
                .fold(0u64, |value, byte| (value << 8) | u64::from(*byte));
            write!(f, "S-{}-{authority}", bytes[0])?;
            for chunk in bytes[8..].as_chunks::<4>().0 {
                write!(f, "-{}", u32::from_le_bytes(*chunk))?;
            }
            Ok(())
        }
    }

    /// The user a process runs as: the user of its primary token.
    pub(crate) fn process_user(process: HANDLE) -> io::Result<Sid> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: `process` is a live process handle; `token` is a local.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken returned a handle this function now owns.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut length = 0u32;
        // SAFETY: a size query: no buffer, and the needed length is written to
        // a local. It fails by design; the length says whether it answered.
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut length,
            )
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64 storage keeps TOKEN_USER, which holds a pointer, aligned.
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        // SAFETY: `buffer` holds at least `length` writable bytes.
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetTokenInformation filled `buffer` with a TOKEN_USER whose
        // SID points into the same buffer, which is alive until we return.
        let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        // SAFETY: `sid` points into `buffer`, as above.
        if unsafe { IsValidSid(sid) } == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the token holds no valid user SID",
            ));
        }
        // SAFETY: `sid` is valid and GetLengthSid bytes long.
        let bytes =
            unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize) };
        Ok(Sid(bytes.to_vec()))
    }

    /// A function the host executable exports, found by name at run time.
    fn host_symbol(name: &CStr) -> Result<unsafe extern "system" fn() -> isize, String> {
        // SAFETY: a null name asks for the executable, which is always loaded.
        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        if module.is_null() {
            return Err(format!(
                "cannot find the host executable: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: `name` is NUL-terminated.
        unsafe { GetProcAddress(module, name.as_ptr().cast()) }.ok_or_else(|| {
            format!(
                "the host executable does not export {}",
                name.to_string_lossy()
            )
        })
    }

    fn error_name(error: &io::Error) -> &'static str {
        match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => "ENOENT",
            Some(ERROR_PIPE_BUSY) => "EBUSY",
            Some(ERROR_ACCESS_DENIED) => "EACCES",
            Some(ERROR_BAD_PATHNAME | ERROR_INVALID_NAME) => "EINVAL",
            _ => "UNKNOWN",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::io::AsHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinLocalSystemSid};
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
        };

        fn pipe_name(label: &str) -> String {
            format!(
                r"\\.\pipe\lasterm-hub-lock-test-{label}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )
        }

        /// A pipe this process serves, closed when the test ends.
        struct Server(HANDLE);

        impl Server {
            fn new(name: &str) -> Self {
                let wide: Vec<u16> = OsStr::new(name)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                // SAFETY: `wide` is NUL-terminated and outlives the call.
                let handle = unsafe {
                    CreateNamedPipeW(
                        wide.as_ptr(),
                        PIPE_ACCESS_DUPLEX,
                        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                        1,
                        4096,
                        4096,
                        0,
                        std::ptr::null(),
                    )
                };
                assert_ne!(
                    handle,
                    INVALID_HANDLE_VALUE,
                    "create a test pipe: {}",
                    io::Error::last_os_error()
                );
                Self(handle)
            }
        }

        impl Drop for Server {
            fn drop(&mut self) {
                // SAFETY: the server owns its handle and nothing uses it after.
                unsafe { CloseHandle(self.0) };
            }
        }

        fn local_system() -> Sid {
            let mut bytes = [0u8; 68];
            let mut length = bytes.len() as u32;
            // SAFETY: `bytes` holds `length` writable bytes.
            let ok = unsafe {
                CreateWellKnownSid(
                    WinLocalSystemSid,
                    std::ptr::null_mut(),
                    bytes.as_mut_ptr().cast(),
                    &mut length,
                )
            };
            assert_ne!(ok, 0, "{}", io::Error::last_os_error());
            Sid::from_bytes(&bytes[..length as usize])
        }

        #[test]
        fn a_pipe_this_user_serves_is_accepted() {
            let name = pipe_name("own");
            let _server = Server::new(&name);
            let client = connect(&name).expect("connect to our own pipe");
            verify_peer(client.as_handle()).expect("our own pipe is ours");
        }

        #[test]
        fn a_pipe_served_as_another_account_is_refused() {
            let name = pipe_name("other");
            let _server = Server::new(&name);
            let client = connect(&name).expect("connect to our own pipe");
            let system = local_system();
            let refusal = verify_peer_runs_as(client.as_handle(), &system)
                .expect_err("a server of another account must be refused");
            assert!(refusal.contains("S-1-5-18"), "{refusal}");
            assert!(
                refusal.contains(&std::process::id().to_string()),
                "{refusal}"
            );
        }

        #[test]
        fn a_handle_that_is_not_a_pipe_is_refused() {
            let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
            assert!(verify_peer(file.as_handle()).is_err());
        }

        #[test]
        fn a_missing_pipe_is_enoent() {
            let name = pipe_name("missing");
            let error = connect(&name).expect_err("nothing is there");
            assert_eq!(error.code, "ENOENT", "{}", error.message);
            assert!(error.message.contains(&name));
        }

        #[test]
        fn a_pipe_whose_one_instance_is_taken_is_ebusy() {
            let name = pipe_name("busy");
            let _server = Server::new(&name);
            let _first = connect(&name).expect("the one instance");
            let error = connect(&name).expect_err("no instance left");
            assert_eq!(error.code, "EBUSY", "{}", error.message);
        }

        #[test]
        fn a_path_that_is_not_a_local_pipe_is_refused_unopened() {
            for path in [
                r"C:\Windows\notepad.exe",
                r"\\server\pipe\lasterm-agent",
                r"\\.\pipe\",
            ] {
                let error = connect(path).expect_err(path);
                assert_eq!(error.code, "EINVAL", "{path}: {}", error.message);
            }
        }

        #[test]
        fn a_sid_reads_as_windows_writes_it() {
            assert_eq!(local_system().to_string(), "S-1-5-18");
        }
    }
}
