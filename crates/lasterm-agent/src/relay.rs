//! `--attach`: a relay between this process's stdio and a daemon's endpoint.
//!
//! A hub that cannot reach a remote daemon's socket through an SSH channel of
//! its own runs this over an exec channel instead (#755): on a host whose SSH
//! server refuses socket forwarding, and on Windows, where no SSH channel
//! carries a named pipe. The relay connects to the endpoint as the SSH
//! account, which the endpoint's own access rules already admit, and copies
//! bytes both ways. It reads none of them: HELLO, AUTH and everything after
//! go between the hub and the daemon as they would over a socket.
//!
//! **What it says, and where.** stdout carries the daemon's bytes and nothing
//! else. stderr carries one `lasterm-attach: start` line before the endpoint
//! is first tried, then, on a failure this relay decides, exactly one outcome
//! line: `nothing-listens`, `denied`, `busy` or `failed <text>`. Once
//! connected it writes nothing more there. The hub decides by those lines, not
//! by the exit status: a PowerShell `DefaultShell` on Windows hands every
//! non-zero status on as 1. The statuses still mean what [`exit`] says, for a
//! person running it and for tests.

use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

/// What starts every line this relay writes on stderr.
pub(crate) const MARKER: &str = "lasterm-attach:";

/// The exit statuses of `--attach`.
pub(crate) mod exit {
    /// A connection that ended, from either side.
    pub const ENDED: i32 = 0;
    /// Anything this relay could not classify.
    pub const FAILED: i32 = 1;
    /// Nothing listens on the endpoint.
    pub const NOTHING_LISTENS: i32 = 3;
    /// The endpoint refused this account.
    pub const DENIED: i32 = 4;
    /// The pipe exists, and none of its instances freed up in time (Windows).
    pub const BUSY: i32 = 6;
}

/// How often "nothing listens" is tried again within `--wait`.
const RETRY_EVERY: Duration = Duration::from_millis(100);
/// How often a busy pipe is tried again.
#[cfg(windows)]
const BUSY_RETRY_EVERY: Duration = Duration::from_millis(50);
/// The least time a busy pipe is given, whatever `--wait` says: a pipe is
/// busy only between one client connecting and the daemon making the next
/// instance, which is short.
#[cfg(windows)]
const BUSY_AT_LEAST: Duration = Duration::from_millis(2_000);

/// Why connecting failed.
#[derive(Debug)]
enum ConnectError {
    NothingListens,
    Denied,
    #[cfg_attr(not(windows), allow(dead_code))]
    Busy,
    Failed(std::io::Error),
}

fn say(line: &str) {
    // stderr is unbuffered; one write per line keeps lines whole.
    eprintln!("{MARKER} {line}");
}

/// Run the relay and return the process exit status. `endpoint` resolves
/// the endpoint after `start` is said, so that a failure to resolve one is an
/// outcome like any other, not silence.
pub(crate) async fn run(endpoint: impl FnOnce() -> std::io::Result<String>, wait: Duration) -> i32 {
    say("start");
    let endpoint = match endpoint() {
        Ok(endpoint) => endpoint,
        Err(error) => {
            say(&format!("failed {}", one_line(&error.to_string())));
            return exit::FAILED;
        }
    };
    match connect(&endpoint, wait).await {
        Ok(stream) => relay(stream).await,
        Err(ConnectError::NothingListens) => {
            say("nothing-listens");
            eprintln!("nothing listens on {endpoint}");
            exit::NOTHING_LISTENS
        }
        Err(ConnectError::Denied) => {
            say("denied");
            eprintln!("{endpoint} refused this account");
            exit::DENIED
        }
        Err(ConnectError::Busy) => {
            say("busy");
            eprintln!("{endpoint} stayed busy");
            exit::BUSY
        }
        Err(ConnectError::Failed(error)) => {
            say(&format!("failed {}", one_line(&error.to_string())));
            exit::FAILED
        }
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(unix)]
type Endpoint = tokio::net::UnixStream;
#[cfg(windows)]
type Endpoint = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(unix)]
async fn connect(endpoint: &str, wait: Duration) -> Result<Endpoint, ConnectError> {
    let deadline = Instant::now() + wait;
    loop {
        match tokio::net::UnixStream::connect(endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(error) => match error.kind() {
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
                    if Instant::now() >= deadline {
                        return Err(ConnectError::NothingListens);
                    }
                    tokio::time::sleep(RETRY_EVERY).await;
                }
                std::io::ErrorKind::PermissionDenied => return Err(ConnectError::Denied),
                _ => return Err(ConnectError::Failed(error)),
            },
        }
    }
}

#[cfg(windows)]
async fn connect(endpoint: &str, wait: Duration) -> Result<Endpoint, ConnectError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY,
    };
    crate::daemon::require_pipe_name(endpoint).map_err(ConnectError::Failed)?;
    let start = Instant::now();
    let deadline = start + wait;
    let busy_deadline = start + wait.max(BUSY_AT_LEAST);
    loop {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => return Ok(client),
            Err(error) => match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_FILE_NOT_FOUND) => {
                    if Instant::now() >= deadline {
                        return Err(ConnectError::NothingListens);
                    }
                    tokio::time::sleep(RETRY_EVERY).await;
                }
                // The pipe exists: never "nothing listens", which would have
                // the hub start a second daemon beside this one.
                Some(ERROR_PIPE_BUSY) => {
                    if Instant::now() >= busy_deadline {
                        return Err(ConnectError::Busy);
                    }
                    tokio::time::sleep(BUSY_RETRY_EVERY).await;
                }
                Some(ERROR_ACCESS_DENIED) => return Err(ConnectError::Denied),
                _ => return Err(ConnectError::Failed(error)),
            },
        }
    }
}

/// How long the endpoint may take to read what this relay wrote before it is
/// closed anyway, and how long what the daemon sent may take to reach stdout
/// once the hub's side failed.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

/// Copy both ways until one side ends, then exit.
///
/// When stdin ends, the hub is done with this connection: what was read is
/// written out, and the endpoint is closed whole, not half-closed. A Windows
/// pipe client cannot half-close (Tokio's shutdown only flushes), and a daemon
/// waiting for an end that never comes would keep the connection registered.
/// When the endpoint ends, what it sent goes out on stdout, then the relay
/// exits; whatever stdin still holds is the hub's to notice. A failed copy is
/// exit 1: what it was carrying did not all arrive.
async fn relay(stream: Endpoint) -> i32 {
    #[cfg(windows)]
    let raw = {
        use std::os::windows::io::AsRawHandle;
        stream.as_raw_handle() as usize
    };
    let (mut from_daemon, mut to_daemon) = tokio::io::split(stream);
    let mut downstream = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        tokio::io::copy(&mut from_daemon, &mut stdout).await?;
        stdout.flush().await
    });
    let upstream = async {
        let mut stdin = tokio::io::stdin();
        tokio::io::copy(&mut stdin, &mut to_daemon).await?;
        to_daemon.flush().await
    };
    tokio::select! {
        ended = &mut downstream => match ended {
            Ok(Ok(())) => exit::ENDED,
            _ => exit::FAILED,
        },
        written = upstream => {
            if written.is_err() {
                // The daemon's side went away while the hub was writing: what
                // it sent before that, a displacement notice say, still goes
                // out on stdout.
                let _ = tokio::time::timeout(CLOSE_GRACE, &mut downstream).await;
                return exit::FAILED;
            }
            // Closing a pipe client discards what its server has not read
            // yet; `FlushFileBuffers` returns once it has, bounded so that a
            // daemon that stopped reading does not keep the relay alive. The
            // handle stays valid: the write half still owns it.
            #[cfg(windows)]
            {
                let _ = tokio::time::timeout(
                    CLOSE_GRACE,
                    tokio::task::spawn_blocking(move || unsafe {
                        windows_sys::Win32::Storage::FileSystem::FlushFileBuffers(raw as _)
                    }),
                )
                .await;
            }
            downstream.abort();
            let _ = (&mut downstream).await;
            // The read half went with the aborted task; this closes the endpoint.
            drop(to_daemon);
            exit::ENDED
        }
    }
}
