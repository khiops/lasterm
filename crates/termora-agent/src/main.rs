mod batch;
mod daemon;
mod elevation;
mod expand;
mod framing;
mod handler;
mod headless;
mod identity;
mod logging;
mod process;
mod protocol;
mod pty;
mod shell;

use clap::Parser;
use clap::ValueEnum;

#[derive(Parser)]
#[command(name = "termora-agent", version)]
struct Cli {
    /// Run in stdio mode (default, used by hub LocalAgent)
    #[arg(long)]
    stdio: bool,

    /// Run as daemon (UDS server mode)
    #[arg(long)]
    daemon: bool,

    /// Socket path for daemon mode
    #[arg(long)]
    socket: Option<String>,

    /// Per-channel output buffer size (daemon mode)
    #[arg(long)]
    buffer_per_channel: Option<usize>,

    /// Global output buffer size (daemon mode)
    #[arg(long)]
    buffer_global: Option<usize>,

    /// Stop the process described by the matching local daemon record. This does not prove that process still owns the endpoint. Unix requests graceful shutdown; Windows terminates it, so no exit record is written. This does not check for a hub; a live hub may relaunch it.
    #[arg(
        long,
        conflicts_with_all = ["daemon", "stdio", "buffer_per_channel", "buffer_global"]
    )]
    stop: bool,

    /// Agent tracing level from the shared [logging] contract
    #[arg(long = "log-level", value_enum, default_value = "info")]
    log_level: LogLevel,

    /// Agent tracing line format from the shared [logging] contract
    #[arg(long = "format", value_enum, default_value = "jsonl")]
    format: LogFormat,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
enum LogFormat {
    Text,
    Jsonl,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
struct LoggingConfig {
    level: LogLevel,
    format: LogFormat,
}

impl From<&Cli> for LoggingConfig {
    fn from(cli: &Cli) -> Self {
        Self {
            level: cli.log_level,
            format: cli.format,
        }
    }
}

/// After a graceful-stop request, give the daemon this long to leave its
/// accept loop and tear down terminal workloads. Exiting after the bound is
/// correct because a wedged agent that cannot be stopped is worse than an
/// operator having to clean up its remaining local process tree manually.
const DAEMON_GRACEFUL_SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Eq, PartialEq)]
enum ForcedShutdown {
    SecondSignal,
    DeadlineElapsed,
}

#[cfg(unix)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum UnixShutdownSignal {
    Sigterm,
    Sigint,
}

#[cfg(unix)]
impl UnixShutdownSignal {
    fn name(self) -> &'static str {
        match self {
            Self::Sigterm => "SIGTERM",
            Self::Sigint => "SIGINT",
        }
    }
}

async fn wait_for_second_signal_or_deadline<F, D>(second_signal: F, deadline: D) -> ForcedShutdown
where
    F: std::future::Future<Output = ()>,
    D: std::future::Future<Output = ()>,
{
    tokio::select! {
        biased;
        _ = second_signal => ForcedShutdown::SecondSignal,
        _ = deadline => ForcedShutdown::DeadlineElapsed,
    }
}

/// Await either installed signal. Returning `None` means neither handler was
/// installed, so the caller must not pretend a shutdown request can arrive.
#[cfg(unix)]
async fn wait_for_available_signal<F, G, T, U>(
    first: Option<F>,
    second: Option<G>,
) -> Option<UnixShutdownSignal>
where
    F: std::future::Future<Output = T>,
    G: std::future::Future<Output = U>,
{
    match (first, second) {
        (Some(first), Some(second)) => {
            tokio::select! {
                _ = first => Some(UnixShutdownSignal::Sigterm),
                _ = second => Some(UnixShutdownSignal::Sigint),
            }
        }
        (Some(first), None) => {
            first.await;
            Some(UnixShutdownSignal::Sigterm)
        }
        (None, Some(second)) => {
            second.await;
            Some(UnixShutdownSignal::Sigint)
        }
        (None, None) => None,
    }
}

fn daemon_process_exit_status(result: &std::io::Result<pty::DestroyAllSummary>) -> i32 {
    match result {
        Ok(summary) => daemon::teardown_exit_status(summary),
        Err(_) => 1,
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Parse CLI args
    let cli = Cli::parse();
    let logging_config = LoggingConfig::from(&cli);

    init_tracing(logging_config, cli.daemon)?;

    if cli.stop {
        let socket = cli.socket.unwrap_or_else(default_socket_path);
        let socket_identity = identity::socket_identity(&socket);
        let outcome = identity::stop(
            &identity::state_dir_for_socket(&socket_identity),
            &socket_identity,
            DAEMON_GRACEFUL_SHUTDOWN_DEADLINE,
        )?;
        println!("{}", outcome.words());
        if outcome == identity::StopOutcome::Stopped {
            return Ok(());
        }
        // A request only succeeds after the record's exact identity is gone;
        // delivery, a missing record, and a stale record are not success.
        std::process::exit(1);
    }

    if cli.daemon {
        // Daemon mode writes to its own log file; stdio mode writes to stderr.
        let log_path = logging::daemon_log_path();
        tracing::info!(log_path = %log_path.display(), "daemon log file opened");
        // Resolve socket path — platform-specific default when not provided via --socket
        let socket = cli.socket.unwrap_or_else(default_socket_path);

        // Ensure the socket's parent directory exists when --socket is provided.
        // The unwrap_or_else default branch already calls create_dir_all for its
        // own path; an explicit --socket value may point to a directory that was
        // never created (e.g. /run/user/1000/termora/ under XDG_RUNTIME_DIR on
        // a freshly-booted WSL2 instance), causing UnixListener::bind to fail
        // with ENOENT and the daemon to exit silently.
        // On Windows the socket is a named pipe (\\.\pipe\...) with no real
        // parent directory — skip create_dir_all to avoid a misleading error.
        #[cfg(unix)]
        if let Some(parent) = std::path::Path::new(&socket).parent() {
            if !parent.as_os_str().is_empty() {
                use std::os::unix::fs::DirBuilderExt;
                if let Err(e) = std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(parent)
                {
                    tracing::warn!(error = %e, dir = ?parent, "failed to create socket parent directory");
                }
            }
        }

        let socket_identity = identity::socket_identity(&socket);
        let identity_state_dir = identity::state_dir_for_socket(&socket_identity);
        let daemon_identity = daemon_identity_for_endpoint(socket_identity, &identity_state_dir)?;

        let (shutdown_tx, shutdown_rx) = daemon::shutdown_channel();
        let cleanup_shutdown_tx = shutdown_tx.clone();
        let stop_requested = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        #[cfg(unix)]
        // A record must never advertise SIGTERM stoppability before the handler
        // exists. SIGINT is useful for an interactive operator, but SIGTERM is
        // the protocol the stopper sends, so its installation is mandatory.
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        #[cfg(unix)]
        let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .map_err(|error| {
                tracing::error!(%error, "SIGINT handler unavailable; SIGTERM remains available for daemon shutdown");
                error
            })
            .ok();

        // The signal task only asks the daemon loop to stop. The loop owns the
        // PtyManager, so it is the only place that can perform its full sweep.
        let signal_stop_requested = std::sync::Arc::clone(&stop_requested);
        let mut signal_task = tokio::spawn(async move {
            #[cfg(unix)]
            {
                let Some(first_signal) = wait_for_available_signal(
                    Some(sigterm.recv()),
                    sigint.as_mut().map(|signal| signal.recv()),
                )
                .await
                else {
                    tracing::error!("no Unix termination handlers installed; daemon cannot receive a shutdown signal");
                    std::future::pending::<()>().await;
                    unreachable!("a daemon without signal handlers must remain parked");
                };
                tracing::info!(
                    signal = first_signal.name(),
                    "shutdown signal received, requesting daemon shutdown"
                );
                let deadline = tokio::time::sleep(DAEMON_GRACEFUL_SHUTDOWN_DEADLINE);
                tokio::pin!(deadline);
                signal_stop_requested.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = shutdown_tx.send(true);
                crate::elevation::cleanup_all();

                // Two identical Unix signals can coalesce into one pending
                // notification; SIGTERM followed by SIGINT reliably reaches
                // this immediate-exit path, but two of the same may not.
                wait_for_second_signal_or_deadline(
                    async {
                        let _ = wait_for_available_signal(
                            Some(sigterm.recv()),
                            sigint.as_mut().map(|signal| signal.recv()),
                        )
                        .await;
                    },
                    &mut deadline,
                )
                .await
            }
            #[cfg(not(unix))]
            {
                if let Err(error) = tokio::signal::ctrl_c().await {
                    tracing::error!(%error, "Ctrl+C handler unavailable; daemon shutdown signal task cannot continue");
                    std::future::pending::<()>().await;
                }
                tracing::info!("Ctrl+C received, requesting daemon shutdown");
                let deadline = tokio::time::sleep(DAEMON_GRACEFUL_SHUTDOWN_DEADLINE);
                tokio::pin!(deadline);
                signal_stop_requested.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = shutdown_tx.send(true);
                crate::elevation::cleanup_all();
                wait_for_second_signal_or_deadline(
                    async {
                        if let Err(error) = tokio::signal::ctrl_c().await {
                            tracing::error!(%error, "second Ctrl+C handler unavailable; waiting for shutdown deadline");
                            std::future::pending::<()>().await;
                        }
                    },
                    &mut deadline,
                )
                .await
            }
        });

        let (endpoint_bound_tx, endpoint_bound_rx) = tokio::sync::oneshot::channel();
        let mut daemon_task = tokio::spawn(daemon::run_daemon(
            socket,
            shutdown_rx,
            Some(endpoint_bound_tx),
        ));
        if endpoint_bound_rx.await.is_err() {
            signal_task.abort();
            return match daemon_task.await {
                Ok(Err(error)) => Err(error),
                Ok(Ok(_)) => Err(std::io::Error::other(
                    "daemon exited before reporting its bound endpoint",
                )),
                Err(error) => Err(std::io::Error::other(format!(
                    "daemon task failed before binding its endpoint: {error}"
                ))),
            };
        }
        if let Some(daemon_identity) = daemon_identity.as_ref() {
            if let Err(error) = identity::write_live_record(&identity_state_dir, daemon_identity) {
                signal_task.abort();
                let _ = cleanup_shutdown_tx.send(true);
                let _ = daemon_task.await;
                // An atomic publication can report a post-rename directory
                // sync failure. Remove only a record that still names this
                // attempt.
                let _ = identity::remove_live_record(&identity_state_dir, daemon_identity);
                return Err(error);
            }
        }
        tokio::select! {
            biased;
            result = &mut daemon_task => {
                signal_task.abort();
                match result {
                    Ok(Ok(summary)) => {
                        let result = Ok(summary);
                        let identity_cleanup_status = match daemon_identity {
                            Some(daemon_identity) => match write_clean_exit_record(
                                &identity_state_dir,
                                daemon_identity,
                                stop_requested.load(std::sync::atomic::Ordering::SeqCst),
                                &result,
                            ) {
                                Ok(()) => 0,
                                Err(error) => {
                                    tracing::error!(%error, "daemon identity cleanup was not confirmed");
                                    1
                                }
                            },
                            None => 0,
                        };
                        std::process::exit(
                            daemon_process_exit_status(&result).max(identity_cleanup_status),
                        );
                    }
                    Ok(Err(error)) => {
                        tracing::error!(%error, "daemon failed before clean shutdown could be confirmed");
                        std::process::exit(1);
                    }
                    Err(error) => {
                        tracing::error!(%error, "daemon task failed before terminal teardown could be confirmed");
                        std::process::exit(1);
                    }
                }
            }
            forced_shutdown = &mut signal_task => {
                let forced_shutdown = forced_shutdown.expect("signal task must not panic");
                let status = match forced_shutdown {
                    ForcedShutdown::SecondSignal => {
                        tracing::warn!("second shutdown signal received before teardown completion; exiting unconfirmed without an exit record");
                        1
                    }
                    ForcedShutdown::DeadlineElapsed => {
                        tracing::error!(
                            deadline = ?DAEMON_GRACEFUL_SHUTDOWN_DEADLINE,
                            "daemon did not finish teardown before the shutdown deadline; exiting anyway"
                        );
                        1
                    }
                };
                // A forced path interrupted confirmation, so it cannot report success.
                std::process::exit(status);
            }
        }
    } else {
        // Stdio mode — on Windows, prevent ConPTY children from inheriting
        // our stdout pipe (which carries the MessagePack protocol stream).
        #[cfg(windows)]
        protect_stdio_handles();

        let summary = handler::run_stdio().await?;
        std::process::exit(handler::stdio_exit_status(&summary));
    }
}

fn default_socket_path() -> String {
    #[cfg(unix)]
    {
        let state_dir = identity::state_dir_for_socket("");
        let _ = std::fs::create_dir_all(&state_dir);
        state_dir
            .join("agent.socket")
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(windows)]
    {
        let username = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
        format!(r"\\.\pipe\termora-agent-{username}")
    }
    #[cfg(not(any(unix, windows)))]
    {
        "/tmp/termora-agent.socket".into()
    }
}

/// A daemon may run without an identity when this platform cannot make a safe
/// process fingerprint or its requested record directory is not account-private.
fn daemon_identity_for_endpoint(
    socket_identity: String,
    state_dir: &std::path::Path,
) -> std::io::Result<Option<identity::IdentityRecord>> {
    match identity::create_identity(socket_identity) {
        Ok(identity) => match identity::ensure_private_state_dir(state_dir) {
            Ok(()) => Ok(Some(identity)),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                tracing::warn!(%error, "daemon identity will not be published; --stop is unavailable for this endpoint");
                Ok(None)
            }
            Err(error) => Err(error),
        },
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => {
            tracing::warn!(%error, "daemon identity will not be published because this platform has no safe process fingerprint; --stop is unavailable");
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn write_clean_exit_record(
    state_dir: &std::path::Path,
    daemon_identity: identity::IdentityRecord,
    stop_requested: bool,
    result: &std::io::Result<pty::DestroyAllSummary>,
) -> std::io::Result<()> {
    let (outcome, unconfirmed_terminals) = match result {
        Ok(summary) if summary.unresolved.is_empty() => ("stopped".to_string(), Vec::new()),
        Ok(summary) => (
            "unconfirmed terminals".to_string(),
            summary
                .unresolved
                .iter()
                .map(|channel| format!("{}:{}", channel.channel_id, channel.pid))
                .collect(),
        ),
        Err(error) => (format!("daemon error: {error}"), Vec::new()),
    };
    let exit = identity::ExitRecord {
        identity: daemon_identity,
        stop_requested,
        forced: false,
        outcome,
        unconfirmed_terminals,
    };
    identity::write_exit_record(state_dir, &exit)?;
    identity::remove_live_record(state_dir, &exit.identity)
}

fn init_tracing(config: LoggingConfig, daemon: bool) -> std::io::Result<()> {
    if daemon {
        let log_path = logging::daemon_log_path();
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        match config.format {
            LogFormat::Jsonl => tracing_subscriber::fmt()
                .with_env_filter(env_filter(config.level))
                .json()
                .with_writer(log_file)
                .init(),
            LogFormat::Text => tracing_subscriber::fmt()
                .with_env_filter(env_filter(config.level))
                .with_target(false)
                .with_writer(log_file)
                .init(),
        }
    } else {
        match config.format {
            LogFormat::Jsonl => tracing_subscriber::fmt()
                .with_env_filter(env_filter(config.level))
                .json()
                .with_writer(std::io::stderr)
                .init(),
            LogFormat::Text => tracing_subscriber::fmt()
                .with_env_filter(env_filter(config.level))
                .with_target(false)
                .with_writer(std::io::stderr)
                .init(),
        }
    }
    Ok(())
}

fn env_filter(level: LogLevel) -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| format!("termora_agent={}", level.as_str()).into())
}

/// Replace stdout/stderr with non-inheritable duplicates.
///
/// When the hub spawns us with stdio pipes, Node.js creates inheritable handles.
/// `CreatePseudoConsole` internally spawns `conhost.exe` which inherits all
/// inheritable handles from the calling process — including our stdout pipe.
/// This causes ConPTY child output (e.g. cmd.exe banner) to leak onto our
/// stdout, corrupting the MessagePack protocol stream.
///
/// Simply clearing `HANDLE_FLAG_INHERIT` is not sufficient — conhost.exe may
/// bypass this flag. Instead, we DuplicateHandle each handle as non-inheritable,
/// close the original, and replace it via SetStdHandle. This ensures no
/// inheritable copy of our stdout pipe exists for conhost to find.
#[cfg(windows)]
fn protect_stdio_handles() {
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let current = GetCurrentProcess();
        for std_id in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let old = GetStdHandle(std_id);
            if old.is_null() || old == INVALID_HANDLE_VALUE {
                continue;
            }
            let mut new_handle = INVALID_HANDLE_VALUE;
            let ok = DuplicateHandle(
                current,
                old,
                current,
                &mut new_handle,
                0,
                0, // bInheritHandle = FALSE
                DUPLICATE_SAME_ACCESS,
            );
            if ok != 0 && new_handle != INVALID_HANDLE_VALUE {
                CloseHandle(old);
                SetStdHandle(std_id, new_handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logging_config_defaults_to_jsonl_info() {
        let cli = Cli::try_parse_from(["termora-agent"]).unwrap();
        let config = LoggingConfig::from(&cli);

        assert_eq!(config.level, LogLevel::Info);
        assert_eq!(config.format, LogFormat::Jsonl);
    }

    #[test]
    fn logging_config_reads_cli_level_and_format() {
        let cli = Cli::try_parse_from([
            "termora-agent",
            "--daemon",
            "--log-level",
            "debug",
            "--format",
            "text",
        ])
        .unwrap();
        let config = LoggingConfig::from(&cli);

        assert_eq!(config.level, LogLevel::Debug);
        assert_eq!(config.format, LogFormat::Text);
    }

    #[tokio::test(start_paused = true)]
    async fn hard_shutdown_deadline_fires_when_daemon_does_not_return() {
        let wait = tokio::spawn(async {
            let daemon_never_returns = std::future::pending::<()>();
            tokio::pin!(daemon_never_returns);
            tokio::select! {
                _ = &mut daemon_never_returns => unreachable!("fixture daemon must remain wedged"),
                forced_shutdown = wait_for_second_signal_or_deadline(
                    std::future::pending(),
                    tokio::time::sleep(DAEMON_GRACEFUL_SHUTDOWN_DEADLINE),
                ) => forced_shutdown,
            }
        });
        tokio::task::yield_now().await;
        tokio::time::advance(DAEMON_GRACEFUL_SHUTDOWN_DEADLINE).await;

        assert_eq!(
            wait.await.unwrap(),
            ForcedShutdown::DeadlineElapsed,
            "a wedged daemon must resolve the wait to DeadlineElapsed rather than hang"
        );
        // This covers the decision, not the wiring: main turns DeadlineElapsed
        // into std::process::exit(1), because the deadline interrupted terminal
        // confirmation and cannot truthfully report a clean shutdown.
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_installed_signal_still_requests_shutdown_when_its_sibling_is_unavailable() {
        let (installed_tx, installed_rx) = tokio::sync::oneshot::channel::<()>();
        let wait = tokio::spawn(wait_for_available_signal(
            Some(installed_rx),
            None::<std::future::Pending<()>>,
        ));

        installed_tx
            .send(())
            .expect("installed signal waiter must still be polled");
        assert_eq!(
            wait.await.expect("signal waiter task must not panic"),
            Some(UnixShutdownSignal::Sigterm)
        );

        // Mutation caught: parking as soon as either registration fails leaves
        // the successfully installed signal unpolled and this task never ends.
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn daemon_that_cannot_start_has_a_failing_process_status() {
        let (_shutdown_tx, shutdown_rx) = daemon::shutdown_channel();
        let result = daemon::run_daemon("x".repeat(101), shutdown_rx, None).await;

        assert!(
            result.is_err(),
            "overlong socket path must prevent daemon startup"
        );
        assert_eq!(daemon_process_exit_status(&result), 1);
    }

    #[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
    #[test]
    fn daemon_without_a_safe_fingerprint_starts_without_an_identity() {
        let state_dir = std::env::temp_dir().join(format!("termora-agent-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&state_dir).expect("create state directory");
        assert!(daemon_identity_for_endpoint("socket".into(), &state_dir)
            .expect("unsupported fingerprint must not fail daemon startup")
            .is_none());
        std::fs::remove_dir_all(state_dir).expect("remove state directory");
        // Mutation caught: propagating an unsupported process fingerprint
        // rejects daemon mode instead of merely disabling --stop.
    }
}
