//! Generation and safe persistence of the hub's self-signed TLS identity.
//!
//! The public napi surface deliberately exposes certificate material and the
//! certificate's SubjectPublicKeyInfo only. Private key bytes remain in Rust
//! while they are generated, persisted, and used to issue the certificate.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use rcgen::{CertificateParams, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, SanType};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use time::{Duration, OffsetDateTime};
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::{FromDer, X509Certificate};

const VALIDITY_DAYS: i64 = 825;
const RENEWAL_WINDOW_DAYS: i64 = 7;
static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_TEMPORARY_KEY_CLEANUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NEXT_TEMPORARY_FILE_SETUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Certificate material that may cross the napi boundary. It intentionally has
/// no private-key field: the key is never converted into a JavaScript value.
#[napi(object)]
pub struct GeneratedTlsIdentity {
    pub certificate_pem: String,
    pub spki: Buffer,
}

struct TlsIdentity {
    certificate_pem: String,
    spki: Vec<u8>,
}

/// Creates a private key at `key_path` when absent, or safely reuses its
/// existing key and a usable generated leaf at `certificate_path`. A leaf is
/// reissued only when it cannot safely serve that key anymore.
///
/// The returned object contains only public certificate material. In
/// particular, no private key is returned or converted to a JavaScript string.
#[napi]
pub fn generate_tls_identity(
    key_path: String,
    certificate_path: String,
    legacy_certificate_path: Option<String>,
) -> napi::Result<GeneratedTlsIdentity> {
    let identity = generate_identity(
        Path::new(&key_path),
        Path::new(&certificate_path),
        legacy_certificate_path.as_deref().map(Path::new),
    )
    .map_err(|error| {
        napi::Error::from_reason(format!(
            "cannot generate hub TLS identity at {key_path} and {certificate_path}: {error}"
        ))
    })?;

    Ok(GeneratedTlsIdentity {
        certificate_pem: identity.certificate_pem,
        spki: Buffer::from(identity.spki),
    })
}

fn generate_identity(
    key_path: &Path,
    certificate_path: &Path,
    _legacy_certificate_path: Option<&Path>,
) -> io::Result<TlsIdentity> {
    ensure_distinct_identity_paths(key_path, certificate_path)?;
    let key_pair = load_or_create_key(key_path)?;
    let now = OffsetDateTime::now_utc();
    let cached_certificate = load_usable_certificate(certificate_path, &key_pair, now)?;
    if let CertificateCache::Usable(certificate_pem) = cached_certificate {
        return Ok(TlsIdentity {
            certificate_pem,
            spki: key_pair.public_key_der(),
        });
    }

    let certificate_pem = issue_certificate(&key_pair, now)?;
    write_certificate_file(certificate_path, &certificate_pem)?;

    Ok(TlsIdentity {
        certificate_pem,
        spki: key_pair.public_key_der(),
    })
}

fn issue_certificate(key_pair: &KeyPair, now: OffsetDateTime) -> io::Result<String> {
    let mut params = CertificateParams::new(Vec::<String>::new())
        .map_err(|error| io::Error::other(format!("cannot configure certificate: {error}")))?;
    params.subject_alt_names = vec![SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST))];
    // ExplicitNoCa emits the critical basicConstraints CA:FALSE extension rather
    // than relying on rcgen's extension-absent default.
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = now;
    params.not_after = now + Duration::days(VALIDITY_DAYS);

    let certificate = params
        .self_signed(key_pair)
        .map_err(|error| io::Error::other(format!("cannot issue certificate: {error}")))?;
    Ok(certificate.pem())
}

enum CertificateCache {
    Absent,
    Unusable,
    Usable(String),
}

fn load_usable_certificate(
    certificate_path: &Path,
    key_pair: &KeyPair,
    now: OffsetDateTime,
) -> io::Result<CertificateCache> {
    // A certificate from an unsafe parent is never a cache entry we may use or
    // replace. Conversely, a regular, owned cache that cannot be read is only
    // unusable: publishing a replacement does not follow its path.
    check_parent_directory(certificate_path)?;
    let mut file = match open_key_file(
        certificate_path,
        OpenKeyMode::Existing,
        FilePolicy::Certificate,
    ) {
        Ok(Some(file)) => file,
        Ok(None) => return Ok(CertificateCache::Absent),
        Err(_error) if unreadable_certificate_is_replaceable(certificate_path)? => {
            return Ok(CertificateCache::Unusable);
        }
        Err(error) => return Err(error),
    };
    let mut certificate_pem = String::new();
    if file.read_to_string(&mut certificate_pem).is_err() {
        return Ok(CertificateCache::Unusable);
    }
    Ok(
        if certificate_matches_profile(&certificate_pem, key_pair, now) {
            CertificateCache::Usable(certificate_pem)
        } else {
            CertificateCache::Unusable
        },
    )
}

fn certificate_matches_profile(
    certificate_pem: &str,
    key_pair: &KeyPair,
    now: OffsetDateTime,
) -> bool {
    let Ok(mut pems) = pem::parse_many(certificate_pem) else {
        return false;
    };
    if pems.len() != 1 || pems[0].tag() != "CERTIFICATE" {
        return false;
    }
    // `pem::parse_many` intentionally scans for PEM blocks. It can therefore
    // leave malformed framing after a valid block; the cache permits only
    // whitespace outside its one certificate.
    if pem_without_whitespace(certificate_pem) != pem_without_whitespace(&pem::encode(&pems[0])) {
        return false;
    }
    let der = pems.remove(0).into_contents();
    let Ok((remaining, certificate)) = X509Certificate::from_der(&der) else {
        return false;
    };
    if !remaining.is_empty()
        || certificate.public_key().raw != key_pair.public_key_der().as_slice()
        || certificate.issuer() != certificate.subject()
        || certificate.verify_signature(None).is_err()
    {
        return false;
    }

    let validity = certificate.validity();
    let not_before = validity.not_before.to_datetime();
    let not_after = validity.not_after.to_datetime();
    if not_before > now || not_after <= now + Duration::days(RENEWAL_WINDOW_DAYS) {
        return false;
    }

    let Ok(Some(basic_constraints)) = certificate.basic_constraints() else {
        return false;
    };
    if !basic_constraints.critical || basic_constraints.value.ca {
        return false;
    }
    let Ok(Some(subject_alternative_name)) = certificate.subject_alternative_name() else {
        return false;
    };
    if subject_alternative_name.critical
        || subject_alternative_name.value.general_names.len() != 1
        || !subject_alternative_name
            .value
            .general_names
            .iter()
            .any(|name| matches!(name, GeneralName::IPAddress(bytes) if *bytes == [127, 0, 0, 1]))
    {
        return false;
    }
    let Ok(Some(key_usage)) = certificate.key_usage() else {
        return false;
    };
    if !key_usage.critical || key_usage.value.flags != 1 {
        return false;
    }
    let Ok(Some(extended_key_usage)) = certificate.extended_key_usage() else {
        return false;
    };
    if extended_key_usage.critical
        || !extended_key_usage.value.server_auth
        || extended_key_usage.value.any
        || extended_key_usage.value.client_auth
        || extended_key_usage.value.code_signing
        || extended_key_usage.value.email_protection
        || extended_key_usage.value.time_stamping
        || extended_key_usage.value.ocsp_signing
        || !extended_key_usage.value.other.is_empty()
    {
        return false;
    }

    certificate_extensions_match_profile(certificate.extensions())
}

fn pem_without_whitespace(pem: &str) -> Vec<u8> {
    pem.bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect()
}

fn certificate_extensions_match_profile(
    extensions: &[x509_parser::extensions::X509Extension<'_>],
) -> bool {
    const SUBJECT_KEY_IDENTIFIER: &[u8] = &[0x55, 0x1d, 0x0e];
    const SUBJECT_ALTERNATIVE_NAME: &[u8] = &[0x55, 0x1d, 0x11];
    const KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x0f];
    const EXTENDED_KEY_USAGE: &[u8] = &[0x55, 0x1d, 0x25];
    const BASIC_CONSTRAINTS: &[u8] = &[0x55, 0x1d, 0x13];

    let mut seen = HashSet::new();
    extensions.iter().all(|extension| {
        let oid = extension.oid.as_bytes();
        seen.insert(oid)
            && match oid {
                SUBJECT_KEY_IDENTIFIER | SUBJECT_ALTERNATIVE_NAME | EXTENDED_KEY_USAGE => {
                    !extension.critical
                }
                KEY_USAGE | BASIC_CONSTRAINTS => extension.critical,
                // The generated profile has no other extensions. This rejects
                // CA-only extensions such as nameConstraints regardless of
                // whether this parser has a dedicated decoder for them.
                _ => false,
            }
    }) && seen.len() == 5
}

fn unreadable_certificate_is_replaceable(certificate_path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(certificate_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        // SAFETY: geteuid has no preconditions and reads only the caller's uid.
        let current_user = unsafe { libc::geteuid() };
        Ok(metadata.uid() == current_user && metadata.mode() & 0o022 == 0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(true)
    }
}

fn write_certificate_file(certificate_path: &Path, certificate_pem: &str) -> io::Result<()> {
    check_parent_directory(certificate_path)?;
    for _ in 0..128 {
        let temporary_path = temporary_key_path(certificate_path)?;
        let mut temporary_file = match open_key_file(
            &temporary_path,
            OpenKeyMode::CreateNew,
            FilePolicy::Certificate,
        ) {
            Ok(Some(file)) => file,
            Ok(None) => unreachable!("creating a temporary certificate file cannot report absence"),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let write_result = (|| -> io::Result<()> {
            temporary_file.write_all(certificate_pem.as_bytes())?;
            temporary_file.sync_all()?;
            Ok(())
        })();
        drop(temporary_file);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
        // A same-directory rename replaces the old complete cache atomically.
        // Syncing the parent commits that namespace update on Unix filesystems
        // that honor directory fsync, so a power loss leaves either complete
        // leaf rather than a partially written certificate.
        match fs::rename(&temporary_path, certificate_path) {
            Ok(()) => {
                return sync_parent(certificate_path.parent().unwrap_or_else(|| Path::new(".")))
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary_path);
                return Err(error);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary certificate file",
    ))
}

fn load_or_create_key(key_path: &Path) -> io::Result<KeyPair> {
    match read_key_file(key_path)? {
        Some(pem) => KeyPair::from_pem(&pem).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cannot parse existing private key: {error}"),
            )
        }),
        None => create_key_file(key_path),
    }
}

fn read_key_file(key_path: &Path) -> io::Result<Option<String>> {
    let mut file = match open_key_file(key_path, OpenKeyMode::Existing, FilePolicy::PrivateKey)? {
        Some(file) => file,
        None => return Ok(None),
    };
    let mut pem = String::new();
    file.read_to_string(&mut pem)?;
    Ok(Some(pem))
}

fn create_key_file(key_path: &Path) -> io::Result<KeyPair> {
    check_parent_directory(key_path)?;
    let key_pair = KeyPair::generate()
        .map_err(|error| io::Error::other(format!("cannot generate private key: {error}")))?;
    let private_key_pem = key_pair.serialize_pem();

    for _ in 0..128 {
        let temporary_path = temporary_key_path(key_path)?;
        let mut temporary_file = match open_key_file(
            &temporary_path,
            OpenKeyMode::CreateNew,
            FilePolicy::PrivateKey,
        ) {
            Ok(Some(file)) => file,
            Ok(None) => unreachable!("creating a new temporary key file cannot report absence"),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let write_result = (|| -> io::Result<()> {
            temporary_file.write_all(private_key_pem.as_bytes())?;
            temporary_file.sync_all()?;
            Ok(())
        })();
        drop(temporary_file);

        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }

        match fs::hard_link(&temporary_path, key_path) {
            Ok(()) => {
                // The final name becomes visible only after the fully written,
                // owner-only temporary file is synced. Hard links never replace
                // an existing destination, so a concurrent creator cannot be
                // silently overwritten.
                if let Err(error) = remove_temporary_key_file(&temporary_path) {
                    // The authoritative name is already durable. Do not report
                    // that successful install as a startup failure, but make
                    // the owner-only duplicate private key visible to operators.
                    eprintln!(
                        "[lasterm] private key installed at {}; could not remove temporary private-key copy {}: {error}",
                        key_path.display(),
                        temporary_path.display()
                    );
                }
                return Ok(key_pair);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_temporary_key_file(&temporary_path)?;
                return load_or_create_key(key_path);
            }
            Err(error) => {
                let _ = remove_temporary_key_file(&temporary_path);
                return Err(error);
            }
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary private-key file",
    ))
}

fn remove_temporary_key_file(path: &Path) -> io::Result<()> {
    #[cfg(test)]
    if FAIL_NEXT_TEMPORARY_KEY_CLEANUP.with(|fail| fail.replace(false)) {
        return Err(io::Error::other(
            "injected temporary private-key cleanup failure",
        ));
    }
    fs::remove_file(path)
}

fn temporary_key_path(key_path: &Path) -> io::Result<PathBuf> {
    let parent = key_path.parent().unwrap_or_else(|| Path::new("."));
    let filename = key_path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "private-key path must name a file",
        )
    })?;
    let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{}.{}.{}.tmp",
        filename.to_string_lossy(),
        std::process::id(),
        sequence
    )))
}

enum OpenKeyMode {
    Existing,
    CreateNew,
}

#[derive(Clone, Copy)]
enum FilePolicy {
    PrivateKey,
    Certificate,
}

fn ensure_distinct_identity_paths(key_path: &Path, certificate_path: &Path) -> io::Result<()> {
    if resolved_path_for_comparison(key_path)? == resolved_path_for_comparison(certificate_path)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private-key and certificate paths resolve to the same file",
        ));
    }
    Ok(())
}

fn resolved_path_for_comparison(path: &Path) -> io::Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path);
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let filename = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "identity path must name a file",
        )
    })?;
    Ok(fs::canonicalize(parent)?.join(filename))
}

#[cfg(unix)]
fn open_key_file(path: &Path, mode: OpenKeyMode, policy: FilePolicy) -> io::Result<Option<File>> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let flags = match mode {
        OpenKeyMode::Existing => libc::O_RDONLY,
        OpenKeyMode::CreateNew => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
    } | libc::O_CLOEXEC
        | libc::O_NOFOLLOW;
    // SAFETY: path is a NUL-terminated CString, flags are valid open flags, and
    // the creation mode is used only when O_CREAT is set. O_NOFOLLOW prevents a
    // planted symlink from redirecting private-key reads or writes; O_EXCL makes
    // each temporary key file exclusive to this call.
    let fd = unsafe { libc::open(c_path.as_ptr(), flags, 0o600) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        if matches!(mode, OpenKeyMode::Existing) && error.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: libc::open returned a valid owned descriptor. File closes it on
    // every return path, including failed metadata validation below.
    let file = unsafe { File::from_raw_fd(fd) };
    #[cfg(test)]
    if matches!(mode, OpenKeyMode::CreateNew)
        && FAIL_NEXT_TEMPORARY_FILE_SETUP.with(|fail| fail.replace(false))
    {
        drop(file);
        return Err(open_file_setup_error(
            path,
            mode,
            io::Error::other("injected temporary-file setup failure"),
        ));
    }
    if matches!(mode, OpenKeyMode::CreateNew) {
        // SAFETY: file owns a valid descriptor. fchmod overrides the caller's
        // umask so a newly created private key is exactly owner read/write.
        let chmod_result = unsafe { libc::fchmod(file.as_raw_fd(), 0o600) };
        if chmod_result != 0 {
            let error = io::Error::last_os_error();
            drop(file);
            return Err(open_file_setup_error(path, mode, error));
        }
    }
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(file);
            return Err(open_file_setup_error(path, mode, error));
        }
    };
    if !metadata.is_file() {
        let error = io::Error::other("refusing identity path that is not a regular file");
        drop(file);
        return Err(open_file_setup_error(path, mode, error));
    }
    // SAFETY: geteuid has no preconditions and reads only the caller's uid.
    let current_user = unsafe { libc::geteuid() };
    if metadata.uid() != current_user {
        let error = io::Error::new(
            io::ErrorKind::PermissionDenied,
            "identity file is not owned by the current user",
        );
        drop(file);
        return Err(open_file_setup_error(path, mode, error));
    }
    let unsafe_permissions = match policy {
        FilePolicy::PrivateKey => metadata.mode() & 0o077 != 0,
        // Certificates are public, but a group- or world-writable cache is a
        // refusal boundary. Mode 000 remains replaceable when unreadable.
        FilePolicy::Certificate => metadata.mode() & 0o022 != 0,
    };
    if unsafe_permissions {
        let error = io::Error::new(
            io::ErrorKind::PermissionDenied,
            "identity file is writable by group or other",
        );
        drop(file);
        return Err(open_file_setup_error(path, mode, error));
    }
    Ok(Some(file))
}

#[cfg(unix)]
fn check_parent_directory(key_path: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let parent = key_path.parent().unwrap_or_else(|| Path::new("."));
    let metadata = fs::metadata(parent)?;
    if !metadata.is_dir() {
        return Err(io::Error::other("private-key parent is not a directory"));
    }
    // SAFETY: geteuid has no preconditions and reads only the caller's uid.
    let current_user = unsafe { libc::geteuid() };
    if metadata.uid() != current_user {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private-key parent is not owned by the current user",
        ));
    }
    if metadata.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private-key parent is writable by group or other",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn open_key_file(path: &Path, mode: OpenKeyMode, _policy: FilePolicy) -> io::Result<Option<File>> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, GetFileInformationByHandleEx, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide_path.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private-key path contains an interior NUL",
        ));
    }
    wide_path.push(0);
    let disposition = match mode {
        OpenKeyMode::Existing => OPEN_EXISTING,
        OpenKeyMode::CreateNew => CREATE_NEW,
    };
    let desired_access = match mode {
        OpenKeyMode::Existing => GENERIC_READ,
        OpenKeyMode::CreateNew => GENERIC_READ | GENERIC_WRITE,
    };
    // SAFETY: wide_path is NUL-terminated and lives for the call; null security
    // attributes and template handles are permitted. FILE_FLAG_OPEN_REPARSE_POINT
    // opens the final component itself so the tag check below can reject a
    // symlink or junction before it redirects the key.
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            desired_access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        if matches!(mode, OpenKeyMode::Existing) && error.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: CreateFileW returned a valid owned handle. File closes it on all
    // returns below, including reparse-point and inheritability failures.
    let file = unsafe { File::from_raw_handle(handle) };
    #[cfg(test)]
    if matches!(mode, OpenKeyMode::CreateNew)
        && FAIL_NEXT_TEMPORARY_FILE_SETUP.with(|fail| fail.replace(false))
    {
        drop(file);
        return Err(open_file_setup_error(
            path,
            mode,
            io::Error::other("injected temporary-file setup failure"),
        ));
    }
    let mut attributes = FILE_ATTRIBUTE_TAG_INFO {
        FileAttributes: 0,
        ReparseTag: 0,
    };
    // SAFETY: attributes is initialized writable storage of exactly the size
    // GetFileInformationByHandleEx requires for FileAttributeTagInfo.
    let information_ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            std::ptr::from_mut(&mut attributes).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if information_ok == 0 {
        let error = io::Error::last_os_error();
        drop(file);
        return Err(open_file_setup_error(path, mode, error));
    }
    if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        let error = io::Error::other("refusing identity reparse point");
        drop(file);
        return Err(open_file_setup_error(path, mode, error));
    }
    // SAFETY: file owns a valid Windows handle; clearing HANDLE_FLAG_INHERIT
    // prevents child processes from retaining access to the private key.
    let inheritability_ok =
        unsafe { SetHandleInformation(file.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) };
    if inheritability_ok == 0 {
        let error = io::Error::last_os_error();
        drop(file);
        return Err(open_file_setup_error(path, mode, error));
    }
    Ok(Some(file))
}

fn open_file_setup_error(path: &Path, mode: OpenKeyMode, creation_error: io::Error) -> io::Error {
    if matches!(mode, OpenKeyMode::Existing) {
        return creation_error;
    }
    match fs::remove_file(path) {
        Ok(()) => creation_error,
        Err(error) if error.kind() == io::ErrorKind::NotFound => creation_error,
        Err(cleanup_error) => io::Error::new(
            creation_error.kind(),
            format!(
                "temporary file creation failed: {creation_error}; could not remove {}: {cleanup_error}",
                path.display()
            ),
        ),
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let mut wide_parent: Vec<u16> = parent.as_os_str().encode_wide().collect();
    if wide_parent.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "certificate parent contains an interior NUL",
        ));
    }
    wide_parent.push(0);
    // SAFETY: wide_parent is NUL-terminated and lives for the call. Backup
    // semantics permits opening a directory so FlushFileBuffers can commit
    // the rename's namespace update.
    let handle = unsafe {
        CreateFileW(
            wide_parent.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a valid owned directory handle. File closes
    // it on all return paths.
    let directory = unsafe { File::from_raw_handle(handle) };
    // SAFETY: directory owns a valid Windows handle accepted by
    // FlushFileBuffers. Failure is returned so startup never reports the
    // cache durable when the filesystem declines the directory flush.
    if unsafe { FlushFileBuffers(directory.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "certificate parent-directory synchronization is unsupported on this platform",
    ))
}

#[cfg(windows)]
fn check_parent_directory(key_path: &Path) -> io::Result<()> {
    let parent = key_path.parent().unwrap_or_else(|| Path::new("."));
    if !fs::metadata(parent)?.is_dir() {
        return Err(io::Error::other("private-key parent is not a directory"));
    }
    // Files inherit the caller's default DACL. The process-lock sibling uses
    // this same platform boundary: reparse-point redirection is enforced here,
    // while hand-modified directory ACLs are not inspected in this slice.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        generate_identity, load_or_create_key, sync_parent, FAIL_NEXT_TEMPORARY_FILE_SETUP,
        FAIL_NEXT_TEMPORARY_KEY_CLEANUP, VALIDITY_DAYS,
    };
    use rcgen::{
        BasicConstraints, CertificateParams, CustomExtension, ExtendedKeyUsagePurpose, IsCa,
        KeyUsagePurpose, SanType,
    };
    use rustls_pki_types::CertificateDer;
    use std::env;
    use std::fs::{self, create_dir};
    use std::net::{IpAddr, Ipv4Addr};
    use std::path::PathBuf;
    use time::{Duration, OffsetDateTime};
    use webpki::EndEntityCert;
    use x509_parser::extensions::GeneralName;
    use x509_parser::prelude::{FromDer, X509Certificate};

    struct TestDir(PathBuf);

    impl TestDir {
        fn key_path(&self) -> PathBuf {
            self.0.join("hub.key.pem")
        }

        fn certificate_path(&self) -> PathBuf {
            self.0.join("hub.generated-cert.pem")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.0) {
                if error.kind() != std::io::ErrorKind::NotFound {
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
        let process_id = std::process::id();
        for attempt in 0..1024 {
            let path = base.join(format!(
                "lasterm-tls-identity-{name}-{process_id}-{attempt}"
            ));
            match create_dir(&path) {
                Ok(()) => return TestDir(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("could not create {}: {error}", path.display()),
            }
        }
        panic!(
            "could not allocate a unique test directory under {}",
            base.display()
        );
    }

    fn certificate_der(certificate_pem: &str) -> Vec<u8> {
        let pem = pem::parse(certificate_pem).expect("parse generated certificate PEM");
        pem.into_contents()
    }

    #[derive(Clone, Copy)]
    enum CachedLeaf {
        Expired,
        WithinRenewalWindow,
        DatedInTheFuture,
        CertificateAuthority,
        UnsupportedCriticalExtension,
        CriticalNameConstraints,
        DuplicateSubjectAlternativeName,
    }

    fn write_cached_leaf(directory: &TestDir, leaf: CachedLeaf) -> String {
        let key_pair = load_or_create_key(&directory.key_path()).expect("create test key");
        let now = OffsetDateTime::now_utc();
        let mut params =
            CertificateParams::new(Vec::<String>::new()).expect("configure test certificate");
        params.subject_alt_names = vec![SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST))];
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.not_before = now - Duration::days(1);
        params.not_after = now + Duration::days(VALIDITY_DAYS);
        match leaf {
            CachedLeaf::Expired => {
                params.not_before = now - Duration::days(VALIDITY_DAYS);
                params.not_after = now - Duration::days(1);
            }
            CachedLeaf::WithinRenewalWindow => params.not_after = now + Duration::days(7),
            CachedLeaf::DatedInTheFuture => {
                params.not_before = now + Duration::days(1);
                params.not_after = now + Duration::days(VALIDITY_DAYS);
            }
            CachedLeaf::CertificateAuthority => {
                params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            }
            CachedLeaf::UnsupportedCriticalExtension => {
                let mut extension =
                    CustomExtension::from_oid_content(&[1, 2, 3, 4], vec![0x05, 0x00]);
                extension.set_criticality(true);
                params.custom_extensions.push(extension);
            }
            CachedLeaf::CriticalNameConstraints => {
                let mut extension = CustomExtension::from_oid_content(
                    &[2, 5, 29, 30],
                    vec![
                        0x30, 0x0b, 0xa0, 0x09, 0x30, 0x07, 0x82, 0x05, b'l', b'o', b'c', b'a',
                        b'l',
                    ],
                );
                extension.set_criticality(true);
                params.custom_extensions.push(extension);
            }
            CachedLeaf::DuplicateSubjectAlternativeName => {
                params
                    .custom_extensions
                    .push(CustomExtension::from_oid_content(
                        &[2, 5, 29, 17],
                        vec![0x30, 0x06, 0x87, 0x04, 127, 0, 0, 1],
                    ));
            }
        }
        let certificate = params
            .self_signed(&key_pair)
            .expect("issue cached test certificate")
            .pem();
        fs::write(directory.certificate_path(), &certificate)
            .expect("write cached test certificate");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                directory.certificate_path(),
                fs::Permissions::from_mode(0o600),
            )
            .expect("make cached test certificate owner-only");
        }
        certificate
    }

    fn assert_replaced_once(directory: &TestDir, stored: &str) {
        let key_path = directory.key_path();
        let certificate_path = directory.certificate_path();
        let replacement = generate_identity(&key_path, &certificate_path, None)
            .expect("replace unusable cached certificate");
        assert_ne!(
            replacement.certificate_pem, stored,
            "the unusable leaf is not served"
        );
        let restart = generate_identity(&key_path, &certificate_path, None)
            .expect("reuse replacement certificate");
        assert_eq!(
            restart.certificate_pem, replacement.certificate_pem,
            "replacement is issued once rather than on every restart"
        );
    }

    #[test]
    fn generated_certificate_is_a_loopback_tls_server_leaf() {
        let directory = test_dir("certificate-extensions");
        let identity =
            generate_identity(&directory.key_path(), &directory.certificate_path(), None)
                .expect("generate TLS identity");
        let certificate_der = certificate_der(&identity.certificate_pem);
        let (remaining, certificate) =
            X509Certificate::from_der(&certificate_der).expect("parse generated certificate DER");
        assert!(remaining.is_empty(), "certificate DER has trailing bytes");

        let basic_constraints = certificate
            .basic_constraints()
            .expect("parse basic constraints")
            .expect("basic constraints extension is present");
        assert!(basic_constraints.critical, "basic constraints is critical");
        assert!(!basic_constraints.value.ca, "certificate is not a CA");

        let subject_alternative_name = certificate
            .subject_alternative_name()
            .expect("parse subject alternative name")
            .expect("subject alternative name extension is present");
        assert!(
            subject_alternative_name.value.general_names.iter().any(
                |name| matches!(name, GeneralName::IPAddress(bytes) if *bytes == [127, 0, 0, 1])
            ),
            "SAN contains the iPAddress bytes for 127.0.0.1"
        );

        let key_usage = certificate
            .key_usage()
            .expect("parse key usage")
            .expect("key usage extension is present");
        assert!(key_usage.critical, "key usage is critical");
        assert!(
            key_usage.value.digital_signature(),
            "TLS server leaf permits digital signatures"
        );
        assert!(
            !key_usage.value.key_cert_sign(),
            "TLS server leaf cannot sign certificates"
        );

        let extended_key_usage = certificate
            .extended_key_usage()
            .expect("parse extended key usage")
            .expect("extended key usage extension is present");
        assert!(
            extended_key_usage.value.server_auth,
            "extended key usage permits serverAuth"
        );

        let validity = certificate.validity();
        assert_eq!(
            validity.not_after.to_datetime() - validity.not_before.to_datetime(),
            Duration::days(VALIDITY_DAYS),
            "certificate validity is exactly 825 days"
        );
    }

    #[test]
    fn reported_spki_is_what_rustls_webpki_reads_from_the_certificate() {
        let directory = test_dir("spki-reader");
        let identity =
            generate_identity(&directory.key_path(), &directory.certificate_path(), None)
                .expect("generate TLS identity");
        let pem = pem::parse(identity.certificate_pem).expect("parse generated certificate PEM");
        let certificate_der = CertificateDer::from(pem.into_contents());
        let end_entity = EndEntityCert::try_from(&certificate_der)
            .expect("rustls-webpki parses generated certificate");

        assert_eq!(
            end_entity.subject_public_key_info().as_ref(),
            identity.spki.as_slice(),
            "reported SPKI comes from the certificate's actual SubjectPublicKeyInfo"
        );
    }

    #[test]
    fn existing_key_reuses_the_same_certificate_and_spki() {
        let directory = test_dir("reuse");
        let key_path = directory.key_path();
        let certificate_path = directory.certificate_path();
        let first = generate_identity(&key_path, &certificate_path, None)
            .expect("generate initial TLS identity");
        let second = generate_identity(&key_path, &certificate_path, None)
            .expect("reuse TLS identity from existing key");

        assert_eq!(
            first.certificate_pem, second.certificate_pem,
            "restart reuses the leaf"
        );
        assert_eq!(first.spki, second.spki, "reuse preserves the SPKI");
    }

    #[test]
    fn absent_cached_certificate_is_created_once() {
        let directory = test_dir("absent-cache");
        let key_path = directory.key_path();
        let certificate_path = directory.certificate_path();
        let first = generate_identity(&key_path, &certificate_path, None)
            .expect("create absent cached certificate");
        assert!(
            certificate_path.is_file(),
            "the generated cache is committed"
        );
        let restart = generate_identity(&key_path, &certificate_path, None)
            .expect("reuse created cached certificate");
        assert_eq!(first.certificate_pem, restart.certificate_pem);
    }

    #[test]
    fn unparseable_cached_certificate_is_replaced_once() {
        let directory = test_dir("unparseable-cache");
        load_or_create_key(&directory.key_path()).expect("create test key");
        let stored = "not a certificate";
        fs::write(directory.certificate_path(), stored).expect("write corrupt cache");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                directory.certificate_path(),
                fs::Permissions::from_mode(0o600),
            )
            .expect("make corrupt cache owner-only");
        }
        assert_replaced_once(&directory, stored);
    }

    #[test]
    fn expired_cached_certificate_is_replaced_once() {
        let directory = test_dir("expired-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::Expired);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn cached_certificate_in_the_renewal_window_is_replaced_once() {
        let directory = test_dir("renewal-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::WithinRenewalWindow);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn future_dated_cached_certificate_is_replaced_once() {
        let directory = test_dir("future-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::DatedInTheFuture);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn cached_certificate_with_an_invalid_profile_is_replaced_once() {
        let directory = test_dir("ca-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::CertificateAuthority);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn cached_certificate_with_unsupported_critical_extension_is_replaced_once() {
        let directory = test_dir("critical-extension-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::UnsupportedCriticalExtension);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn cached_leaf_with_ca_only_name_constraints_is_replaced_once() {
        let directory = test_dir("name-constraints-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::CriticalNameConstraints);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn cached_leaf_with_a_duplicate_profile_extension_is_replaced_once() {
        let directory = test_dir("duplicate-extension-cache");
        let stored = write_cached_leaf(&directory, CachedLeaf::DuplicateSubjectAlternativeName);
        assert_replaced_once(&directory, &stored);
    }

    #[test]
    fn cached_leaf_for_a_different_key_is_never_served() {
        let directory = test_dir("different-key-cache");
        let other_directory = test_dir("different-key-source");
        let other = generate_identity(
            &other_directory.key_path(),
            &other_directory.certificate_path(),
            None,
        )
        .expect("generate other identity");
        load_or_create_key(&directory.key_path()).expect("create target key");
        fs::write(directory.certificate_path(), &other.certificate_pem).expect("plant other leaf");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                directory.certificate_path(),
                fs::Permissions::from_mode(0o600),
            )
            .expect("make planted leaf owner-only");
        }
        assert_replaced_once(&directory, &other.certificate_pem);
    }

    #[test]
    fn legacy_generated_public_copy_is_not_adopted() {
        let directory = test_dir("legacy-generated-copy");
        let key_path = directory.key_path();
        let legacy_path = directory.0.join("hub-tls-cert.pem");
        let certificate_path = directory.certificate_path();
        let legacy = generate_identity(&key_path, &legacy_path, None)
            .expect("create old generated public copy");
        let replacement = generate_identity(&key_path, &certificate_path, Some(&legacy_path))
            .expect("issue a new leaf instead of adopting the legacy public copy");
        assert_ne!(replacement.certificate_pem, legacy.certificate_pem);
        let restart = generate_identity(&key_path, &certificate_path, None)
            .expect("reuse dedicated generated cache");
        assert_eq!(restart.certificate_pem, replacement.certificate_pem);
    }

    #[test]
    fn valid_cache_followed_by_a_truncated_pem_block_is_replaced_once() {
        let directory = test_dir("trailing-truncated-pem");
        let original =
            generate_identity(&directory.key_path(), &directory.certificate_path(), None)
                .expect("create valid certificate cache");
        let malformed = format!(
            "{}-----BEGIN CERTIFICATE-----\nMIIB",
            original.certificate_pem
        );
        fs::write(directory.certificate_path(), &malformed).expect("append truncated PEM block");
        assert_replaced_once(&directory, &malformed);
    }

    #[test]
    fn resolved_key_and_certificate_aliases_are_refused_before_writing() {
        let directory = test_dir("aliased-identity-paths");
        let key_path = directory.key_path();
        let certificate_path = directory.0.join(".").join("hub.key.pem");

        let error = match generate_identity(&key_path, &certificate_path, None) {
            Ok(_) => panic!("an alias must not overwrite the private key"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(!key_path.exists(), "the private key was not created");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_regular_certificate_cache_is_replaced_once() {
        use std::os::unix::fs::PermissionsExt;

        let directory = test_dir("unreadable-cache");
        let stored = generate_identity(&directory.key_path(), &directory.certificate_path(), None)
            .expect("create valid certificate cache")
            .certificate_pem;
        fs::set_permissions(
            directory.certificate_path(),
            fs::Permissions::from_mode(0o000),
        )
        .expect("deny reads from the regular cache");
        assert_replaced_once(&directory, &stored);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_certificate_cache_is_refused_instead_of_replaced() {
        use std::os::unix::fs::symlink;

        let directory = test_dir("symlinked-certificate-cache");
        load_or_create_key(&directory.key_path()).expect("create test key");
        let target = directory.0.join("certificate-target.pem");
        fs::write(&target, "not a certificate").expect("write symlink target");
        symlink(&target, directory.certificate_path()).expect("plant certificate symlink");

        assert!(
            generate_identity(&directory.key_path(), &directory.certificate_path(), None).is_err(),
            "the unsafe cache path is refused rather than replaced"
        );
        assert!(
            fs::symlink_metadata(directory.certificate_path())
                .expect("inspect cache path")
                .file_type()
                .is_symlink(),
            "the refused symlink was not replaced"
        );
    }

    #[cfg(unix)]
    #[test]
    fn generated_cache_directory_is_synced_after_atomic_publish() {
        let directory = test_dir("certificate-parent-sync");
        generate_identity(&directory.key_path(), &directory.certificate_path(), None)
            .expect("write and publish certificate cache");
        sync_parent(&directory.0).expect("sync the directory containing the rename");
        assert!(directory.certificate_path().is_file());
    }

    #[test]
    fn temporary_file_setup_failure_leaves_no_key_or_certificate_temporary_file() {
        let directory = test_dir("temporary-setup-cleanup");
        FAIL_NEXT_TEMPORARY_FILE_SETUP.with(|fail| fail.set(true));
        assert!(
            generate_identity(&directory.key_path(), &directory.certificate_path(), None).is_err()
        );
        assert!(
            !directory.key_path().exists(),
            "failed key setup leaves no key"
        );
        assert!(
            !directory.certificate_path().exists(),
            "failed key setup leaves no cache"
        );
        assert_no_temporary_files(&directory);

        load_or_create_key(&directory.key_path()).expect("create the key for certificate setup");
        FAIL_NEXT_TEMPORARY_FILE_SETUP.with(|fail| fail.set(true));
        assert!(
            generate_identity(&directory.key_path(), &directory.certificate_path(), None).is_err()
        );
        assert!(
            directory.key_path().is_file(),
            "existing key remains intact"
        );
        assert!(
            !directory.certificate_path().exists(),
            "failed cache setup leaves no cache"
        );
        assert_no_temporary_files(&directory);
    }

    fn assert_no_temporary_files(directory: &TestDir) {
        assert!(
            fs::read_dir(&directory.0)
                .expect("read identity directory")
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")),
            "failed setup leaves no temporary identity file"
        );
    }

    #[test]
    fn installed_key_is_successful_even_when_temporary_copy_cleanup_fails() {
        let directory = test_dir("installed-key-cleanup-warning");
        let key_path = directory.key_path();
        FAIL_NEXT_TEMPORARY_KEY_CLEANUP.with(|fail| fail.set(true));

        let installed = load_or_create_key(&key_path)
            .expect("a committed authoritative private key is not reported as a failure");

        assert!(key_path.is_file(), "the authoritative key was installed");
        assert!(
            fs::read_dir(&directory.0)
                .expect("read temporary-key directory")
                .filter_map(Result::ok)
                .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp")),
            "the injected cleanup failure leaves an observable temporary key copy"
        );
        assert_eq!(
            installed.public_key_der(),
            load_or_create_key(&key_path)
                .expect("the installed key remains usable after its cleanup warning")
                .public_key_der()
        );
    }

    #[cfg(unix)]
    #[test]
    fn generated_private_key_is_owner_only() {
        use std::os::unix::fs::MetadataExt;

        let directory = test_dir("owner-only-key");
        let key_path = directory.key_path();
        generate_identity(&key_path, &directory.certificate_path(), None)
            .expect("generate TLS identity");
        assert_eq!(
            fs::metadata(key_path).expect("inspect private key").mode() & 0o777,
            0o600,
            "private key is owner read/write only"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_private_key_path_is_refused() {
        use std::os::unix::fs::symlink;

        let directory = test_dir("symlink-refusal");
        let target = directory.0.join("target.key.pem");
        fs::write(&target, "not a private key").expect("write symlink target");
        let key_path = directory.key_path();
        symlink(&target, &key_path).expect("plant private-key symlink");

        let error = match load_or_create_key(&key_path) {
            Ok(_) => panic!("private-key symlink was accepted"),
            Err(error) => error,
        };
        assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn group_writable_parent_is_refused_before_a_key_is_written() {
        use std::os::unix::fs::PermissionsExt;

        let directory = test_dir("unsafe-parent");
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o700))
            .expect("make test directory private");
        let key_path = directory.key_path();
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o720))
            .expect("make test directory group writable");

        let error = load_or_create_key(&key_path).expect_err("reject unsafe parent directory");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!key_path.exists(), "unsafe parent receives no key");
    }
}
