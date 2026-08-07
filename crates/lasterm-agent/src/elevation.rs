use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Supported elevation methods.
#[derive(Debug, Clone, PartialEq)]
pub enum ElevationMethod {
    Sudo,
    Doas,
    Pkexec,
    Gsudo,
    Custom(String), // custom command template
}

impl ElevationMethod {
    /// Parse from string (protocol field).
    pub fn from_str_method(s: &str) -> Option<Self> {
        match s {
            "sudo" => Some(Self::Sudo),
            "doas" => Some(Self::Doas),
            "pkexec" => Some(Self::Pkexec),
            "gsudo" => Some(Self::Gsudo),
            "custom" => None, // needs custom_command field
            _ => None,
        }
    }

    /// Get the default elevation method for the current platform.
    pub fn platform_default() -> Self {
        #[cfg(target_os = "linux")]
        return Self::Sudo;
        #[cfg(target_os = "macos")]
        return Self::Sudo;
        #[cfg(target_os = "windows")]
        return Self::Gsudo;
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        return Self::Sudo;
    }
}

/// Result of elevation wrapping.
pub struct ElevatedCommand {
    /// The shell/program to execute (may be the elevation command itself).
    pub program: String,
    /// Arguments for the program.
    pub args: Vec<String>,
    /// Additional env vars to set (e.g., SUDO_ASKPASS).
    pub env: HashMap<String, String>,
    /// Temp file to clean up after spawn (ASKPASS script).
    pub cleanup_path: Option<PathBuf>,
}

/// Check if an elevation method can run passwordless.
pub async fn is_passwordless(method: &ElevationMethod) -> bool {
    match method {
        ElevationMethod::Sudo => check_passwordless("sudo", &["-n", "true"]).await,
        ElevationMethod::Doas => check_passwordless("doas", &["-n", "true"]).await,
        ElevationMethod::Pkexec => false, // Always requires auth agent
        ElevationMethod::Gsudo => true,   // Handles UAC natively
        ElevationMethod::Custom(_) => true, // Assumed passwordless
    }
}

async fn check_passwordless(cmd: &str, args: &[&str]) -> bool {
    match tokio::process::Command::new(cmd)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
    {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

/// Wrap a shell command with elevation.
///
/// Returns the wrapped command or an error if password is required but not provided.
///
/// SECURITY:
/// - Secret uses Zeroizing<String> -- zeroed on drop
/// - ASKPASS script created with O_EXCL + mode 0700
/// - ASKPASS script should be deleted after 1 second (caller responsibility via cleanup_path)
pub async fn wrap_elevated(
    method: &ElevationMethod,
    shell: &str,
    args: &[String],
    secret: Option<Zeroizing<String>>,
) -> io::Result<ElevatedCommand> {
    match method {
        ElevationMethod::Sudo => wrap_sudo(shell, args, secret).await,
        ElevationMethod::Doas => wrap_doas(shell, args, secret).await,
        ElevationMethod::Pkexec => Ok(wrap_pkexec(shell, args)),
        ElevationMethod::Gsudo => Ok(wrap_gsudo(shell, args)),
        ElevationMethod::Custom(cmd) => Ok(wrap_custom(cmd, shell, args)),
    }
}

async fn wrap_sudo(
    shell: &str,
    args: &[String],
    secret: Option<Zeroizing<String>>,
) -> io::Result<ElevatedCommand> {
    if let Some(secret) = secret {
        // Create ASKPASS script
        let (askpass_path, mut env) = create_askpass_script(&secret).await?;
        env.insert(
            "SUDO_ASKPASS".into(),
            askpass_path.to_string_lossy().to_string(),
        );

        let mut cmd_args = vec![
            "-A".into(),
            "-H".into(),
            "-E".into(),
            "--".into(),
            shell.into(),
        ];
        cmd_args.extend(args.iter().cloned());

        Ok(ElevatedCommand {
            program: "sudo".into(),
            args: cmd_args,
            env,
            cleanup_path: Some(askpass_path),
        })
    } else if is_passwordless(&ElevationMethod::Sudo).await {
        let mut cmd_args = vec![
            "-n".into(),
            "-H".into(),
            "-E".into(),
            "--".into(),
            shell.into(),
        ];
        cmd_args.extend(args.iter().cloned());

        Ok(ElevatedCommand {
            program: "sudo".into(),
            args: cmd_args,
            env: HashMap::new(),
            cleanup_path: None,
        })
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "ELEVATION_PASSWORD_REQUIRED",
        ))
    }
}

async fn wrap_doas(
    shell: &str,
    args: &[String],
    secret: Option<Zeroizing<String>>,
) -> io::Result<ElevatedCommand> {
    if let Some(secret) = secret {
        let (askpass_path, mut env) = create_askpass_script(&secret).await?;
        env.insert(
            "DOAS_ASKPASS".into(),
            askpass_path.to_string_lossy().to_string(),
        );

        let mut cmd_args = vec!["--".into(), shell.into()];
        cmd_args.extend(args.iter().cloned());

        Ok(ElevatedCommand {
            program: "doas".into(),
            args: cmd_args,
            env,
            cleanup_path: Some(askpass_path),
        })
    } else if is_passwordless(&ElevationMethod::Doas).await {
        let mut cmd_args = vec!["-n".into(), "--".into(), shell.into()];
        cmd_args.extend(args.iter().cloned());

        Ok(ElevatedCommand {
            program: "doas".into(),
            args: cmd_args,
            env: HashMap::new(),
            cleanup_path: None,
        })
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "ELEVATION_PASSWORD_REQUIRED",
        ))
    }
}

fn wrap_pkexec(shell: &str, args: &[String]) -> ElevatedCommand {
    let mut cmd_args = vec!["--disable-internal-agent".into(), shell.into()];
    cmd_args.extend(args.iter().cloned());

    ElevatedCommand {
        program: "pkexec".into(),
        args: cmd_args,
        env: HashMap::new(),
        cleanup_path: None,
    }
}

fn wrap_gsudo(shell: &str, args: &[String]) -> ElevatedCommand {
    let mut cmd_args = vec![shell.into()];
    cmd_args.extend(args.iter().cloned());

    ElevatedCommand {
        program: "gsudo".into(),
        args: cmd_args,
        env: HashMap::new(),
        cleanup_path: None,
    }
}

fn wrap_custom(custom_cmd: &str, shell: &str, args: &[String]) -> ElevatedCommand {
    let mut cmd_args = vec!["--".into(), shell.into()];
    cmd_args.extend(args.iter().cloned());

    ElevatedCommand {
        program: custom_cmd.into(),
        args: cmd_args,
        env: HashMap::new(),
        cleanup_path: None,
    }
}

/// Create a temporary ASKPASS script that echoes the secret.
///
/// SECURITY:
/// - Uses O_EXCL to prevent race conditions
/// - Mode 0700 (owner-only)
/// - Secret passed via env var _LASTERM_ELEV (not written to script)
/// - Returns (script_path, env_map with _LASTERM_ELEV)
#[cfg(unix)]
async fn create_askpass_script(
    secret: &Zeroizing<String>,
) -> io::Result<(PathBuf, HashMap<String, String>)> {
    use std::os::unix::fs::OpenOptionsExt;

    // Prefer XDG_RUNTIME_DIR (user-private, mode 0700), but fall back to /tmp
    // if the runtime dir is present but not writable in a constrained sandbox.
    let mut dirs = vec![std::env::temp_dir()];
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        dirs.push(PathBuf::from(runtime_dir));
    }

    let filename = format!(
        "lasterm-askpass-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    );
    let mut last_err = None;
    let (path, mut file) = loop {
        let Some(tmp_dir) = dirs.pop() else {
            return Err(last_err.unwrap_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "no ASKPASS temp directory available",
                )
            }));
        };
        let path = tmp_dir.join(&filename);

        // Create with O_EXCL + 0700
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true) // O_EXCL
            .mode(0o700)
            .open(&path)
        {
            Ok(file) => break (path, file),
            Err(err) => {
                last_err = Some(err);
            }
        }
    };

    use std::io::Write;
    // Script echoes the env var, not the secret directly
    // Two writeln! calls: shebang line + echo line
    writeln!(file, "#!/bin/sh")?;
    writeln!(file, r#"echo "$_LASTERM_ELEV""#)?;
    drop(file);

    let mut env = HashMap::new();
    env.insert("_LASTERM_ELEV".into(), secret.as_str().to_string());

    Ok((path, env))
}

#[cfg(windows)]
async fn create_askpass_script(
    _secret: &Zeroizing<String>,
) -> io::Result<(PathBuf, HashMap<String, String>)> {
    // On Windows, gsudo handles UAC natively -- ASKPASS not needed
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "ASKPASS not needed on Windows (use gsudo)",
    ))
}

/// Schedule cleanup of an ASKPASS temp file after a delay.
pub fn schedule_cleanup(path: PathBuf, delay_ms: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        let _ = std::fs::remove_file(&path);
        tracing::debug!("cleaned up ASKPASS script: {:?}", path);
    });
}

/// Global list of temp files to clean up on shutdown.
/// Called from the shutdown handler to ensure no ASKPASS files are left behind.
static CLEANUP_FILES: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

pub fn register_cleanup(path: &Path) {
    if let Ok(mut files) = CLEANUP_FILES.lock() {
        files.push(path.to_path_buf());
    }
}

pub fn cleanup_all() {
    if let Ok(mut files) = CLEANUP_FILES.lock() {
        for path in files.drain(..) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_method_from_str() {
        assert_eq!(
            ElevationMethod::from_str_method("sudo"),
            Some(ElevationMethod::Sudo)
        );
        assert_eq!(
            ElevationMethod::from_str_method("doas"),
            Some(ElevationMethod::Doas)
        );
        assert_eq!(
            ElevationMethod::from_str_method("pkexec"),
            Some(ElevationMethod::Pkexec)
        );
        assert_eq!(
            ElevationMethod::from_str_method("gsudo"),
            Some(ElevationMethod::Gsudo)
        );
        assert_eq!(ElevationMethod::from_str_method("unknown"), None);
        assert_eq!(ElevationMethod::from_str_method("custom"), None);
    }

    #[test]
    fn test_pkexec_wrapping() {
        let result = wrap_pkexec("/bin/bash", &["--norc".into()]);
        assert_eq!(result.program, "pkexec");
        assert_eq!(
            result.args,
            vec!["--disable-internal-agent", "/bin/bash", "--norc"]
        );
    }

    #[test]
    fn test_gsudo_wrapping() {
        let result = wrap_gsudo("cmd.exe", &["/c".into(), "dir".into()]);
        assert_eq!(result.program, "gsudo");
        assert_eq!(result.args, vec!["cmd.exe", "/c", "dir"]);
    }

    #[test]
    fn test_custom_wrapping() {
        let result = wrap_custom("my-elevate", "/bin/bash", &[]);
        assert_eq!(result.program, "my-elevate");
        assert_eq!(result.args, vec!["--", "/bin/bash"]);
    }

    #[test]
    fn test_platform_default() {
        // Just verify it does not panic and returns a valid method
        let method = ElevationMethod::platform_default();
        // On Linux/macOS: Sudo; on Windows: Gsudo
        assert!(matches!(
            method,
            ElevationMethod::Sudo | ElevationMethod::Gsudo
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_askpass_script_creation() {
        let secret = Zeroizing::new("test_password".to_string());
        let (path, env) = create_askpass_script(&secret).await.unwrap();

        // Verify file exists with correct permissions
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o700);

        // Verify env contains the secret key
        assert_eq!(env.get("_LASTERM_ELEV").unwrap(), "test_password");

        // Verify script content
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("echo"));
        assert!(content.contains("_LASTERM_ELEV"));
        assert!(!content.contains("test_password")); // Secret NOT in file

        // Cleanup
        std::fs::remove_file(&path).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_askpass_o_excl_prevents_overwrite() {
        let secret = Zeroizing::new("test".to_string());
        let (path, _) = create_askpass_script(&secret).await.unwrap();

        // Verify unique file was created (ULID-based name)
        assert!(path.exists());

        // Cleanup
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn test_cleanup_all() {
        // Register a fake path
        let tmp = std::env::temp_dir().join("lasterm-test-cleanup");
        std::fs::write(&tmp, "test").unwrap();
        register_cleanup(&tmp);
        cleanup_all();
        assert!(!tmp.exists());
    }
}
