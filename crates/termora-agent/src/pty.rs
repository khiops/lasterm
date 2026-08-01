use std::collections::HashMap;
use std::io;
use std::time::Duration;

use async_xpty::{CommandBuilder, ExitStatus, PtyProcess};
use tokio::task::JoinHandle;

const CHANNEL_TEARDOWN_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct PtyChannelState {
    pub process: PtyProcess,
    pub seq: u64,
}

pub struct PtyManager {
    pub(crate) channels: HashMap<String, PtyChannelState>,
    shutting_down: bool,
    teardown_wait_timeout: Duration,
    #[cfg(test)]
    fail_next_teardown_signal: bool,
    #[cfg(test)]
    sweep_next_reader_lookup: bool,
}

/// The result of trying to end a terminal workload.
#[derive(Debug)]
pub(crate) enum TeardownOutcome {
    Exited {
        channel_id: String,
        pid: u32,
        status: ExitStatus,
    },
    SignalledButUnconfirmed {
        channel_id: String,
        pid: u32,
        reason: UnconfirmedTeardown,
    },
    SignallingFailed {
        channel_id: String,
        pid: u32,
        error: io::Error,
    },
    AlreadyExited {
        channel_id: String,
        pid: u32,
    },
}

#[derive(Debug)]
pub(crate) enum UnconfirmedTeardown {
    WaitFailed(io::Error),
    TimedOut { timeout: Duration },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UnresolvedTeardown {
    SignallingFailed,
    WaitFailed,
    TimedOut,
    ConfirmationTaskFailed,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UnresolvedChannel {
    pub channel_id: String,
    pub pid: u32,
    pub reason: UnresolvedTeardown,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DestroyAllSummary {
    /// Number of spawned shells whose exit was confirmed. This does not confirm
    /// that every workload descendant exited: `PtyProcess::wait()` observes the
    /// shell only, while `PtyProcess::kill_tree_scope()` describes the platform
    /// scope that teardown attempts to reach.
    pub confirmed_shell_exits: usize,
    pub unresolved: Vec<UnresolvedChannel>,
}

/// The process has been signalled and now belongs to its confirmation task.
pub(crate) struct TeardownConfirmation {
    channel_id: String,
    pid: u32,
    process: PtyProcess,
    wait_timeout: Duration,
}

pub(crate) enum TeardownStart {
    Signalled { pid: u32 },
    AlreadyExited(TeardownOutcome),
}

struct TeardownWait {
    channel_id: String,
    pid: u32,
    wait: JoinHandle<TeardownOutcome>,
}

impl TeardownOutcome {
    fn unresolved_channel(&self) -> Option<UnresolvedChannel> {
        let (channel_id, pid, reason) = match self {
            Self::SignalledButUnconfirmed {
                channel_id,
                pid,
                reason: UnconfirmedTeardown::WaitFailed(_),
            } => (channel_id, *pid, UnresolvedTeardown::WaitFailed),
            Self::SignalledButUnconfirmed {
                channel_id,
                pid,
                reason: UnconfirmedTeardown::TimedOut { .. },
            } => (channel_id, *pid, UnresolvedTeardown::TimedOut),
            Self::SignallingFailed {
                channel_id, pid, ..
            } => (channel_id, *pid, UnresolvedTeardown::SignallingFailed),
            Self::Exited { .. } | Self::AlreadyExited { .. } => return None,
        };
        Some(UnresolvedChannel {
            channel_id: channel_id.clone(),
            pid,
            reason,
        })
    }
}

impl DestroyAllSummary {
    fn record_outcome(&mut self, outcome: &TeardownOutcome) {
        if let Some(unresolved) = outcome.unresolved_channel() {
            self.unresolved.push(unresolved);
        } else {
            self.confirmed_shell_exits += 1;
        }
    }

    /// Every channel present when teardown started is either confirmed or
    /// unresolved. `record_outcome` is total, so this holds by construction and
    /// a violation would mean the caller miscounted the sweep.
    ///
    /// Debug-only on purpose: this runs while the agent is shutting down, and
    /// the caller consults the summary to decide whether it is safe to replace
    /// files on disk. Panicking here would withhold that answer at the one
    /// moment it is needed.
    fn assert_complete(&self, swept_channels: usize) {
        debug_assert_eq!(
            self.confirmed_shell_exits + self.unresolved.len(),
            swept_channels,
            "every channel present when teardown started must be confirmed or unresolved"
        );
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            channels: HashMap::new(),
            shutting_down: false,
            teardown_wait_timeout: CHANNEL_TEARDOWN_WAIT_TIMEOUT,
            #[cfg(test)]
            fail_next_teardown_signal: false,
            #[cfg(test)]
            sweep_next_reader_lookup: false,
        }
    }

    /// Construct a manager with a custom confirmation bound. Daemon tests use
    /// this to exercise unresolved-workload reporting without waiting for the
    /// production five-second shutdown bound.
    #[cfg(test)]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn with_teardown_wait_timeout(teardown_wait_timeout: Duration) -> Self {
        Self {
            teardown_wait_timeout,
            ..Self::new()
        }
    }

    /// Prevent future workload creation before the daemon sweeps existing
    /// channels. This is irreversible for this manager's lifetime.
    pub(crate) fn begin_shutdown(&mut self) {
        self.shutting_down = true;
    }

    /// Take a reader only while its channel remains registered. A daemon sweep
    /// can remove the channel between spawn and reader registration.
    pub(crate) fn reader_for(&mut self, channel_id: &str) -> Option<async_xpty::PtyReader> {
        #[cfg(test)]
        if std::mem::take(&mut self.sweep_next_reader_lookup) {
            self.remove(channel_id);
            return None;
        }
        self.channels
            .get(channel_id)
            .map(|channel| channel.process.reader())
    }

    /// Test seam for the spawn-versus-shutdown handoff: the channel is swept
    /// after `spawn` succeeds but before handler reader registration.
    #[cfg(test)]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn sweep_next_reader_lookup(&mut self) {
        self.sweep_next_reader_lookup = true;
    }

    /// Spawn a new PTY channel. Returns (channel_id, pid).
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn(
        &mut self,
        channel_id: Option<String>,
        shell: &str,
        args: &[String],
        cwd: Option<&str>,
        env: Option<&HashMap<String, String>>,
        cols: u16,
        rows: u16,
    ) -> std::io::Result<(String, u32)> {
        if self.shutting_down {
            return Err(std::io::Error::other(
                "agent is shutting down; refusing to spawn a terminal",
            ));
        }

        if let Some(ref id) = channel_id {
            if self.channels.contains_key(id) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "channel already exists",
                ));
            }
        }

        let id = channel_id.unwrap_or_else(|| ulid::Ulid::new().to_string().to_lowercase());

        let mut cmd = CommandBuilder::new(shell);
        for arg in args {
            cmd = cmd.arg(arg);
        }
        if let Some(d) = cwd {
            cmd = cmd.current_dir(d);
        }
        if let Some(e) = env {
            for (k, v) in e {
                cmd = cmd.env(k, v);
            }
        }
        cmd = cmd.size(cols, rows);

        let process = cmd.spawn().await?;
        let pid = process.pid();
        let kill_tree_scope = process.kill_tree_scope();
        tracing::debug!(channel_id = %id, ?kill_tree_scope, "PTY kill-tree scope");
        self.channels
            .insert(id.clone(), PtyChannelState { process, seq: 0 });
        Ok((id, pid))
    }

    #[allow(dead_code)] // Used in tests
    pub fn get_mut(&mut self, channel_id: &str) -> Option<&mut PtyProcess> {
        self.channels
            .get_mut(channel_id)
            .map(|channel| &mut channel.process)
    }

    pub fn remove(&mut self, channel_id: &str) -> Option<PtyProcess> {
        self.channels
            .remove(channel_id)
            .map(|channel| channel.process)
    }

    #[allow(dead_code)] // Used in tests
    pub fn contains(&self, channel_id: &str) -> bool {
        self.channels.contains_key(channel_id)
    }

    #[allow(dead_code)] // Used in tests
    pub fn channel_ids(&self) -> Vec<String> {
        self.channels.keys().cloned().collect()
    }

    #[cfg(test)]
    pub(crate) fn fail_next_teardown_signal(&mut self) {
        self.fail_next_teardown_signal = true;
    }

    /// Signal an active channel while it remains registered.
    pub(crate) fn start_teardown(
        &mut self,
        channel_id: &str,
    ) -> Result<TeardownStart, TeardownOutcome> {
        #[cfg(test)]
        let fail_signal = std::mem::take(&mut self.fail_next_teardown_signal);
        #[cfg(not(test))]
        let fail_signal = false;
        let channel = self
            .channels
            .get(channel_id)
            .expect("start teardown only for a registered channel");
        let pid = channel.process.pid();
        let signal_result = if fail_signal {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "test-only injected kill_tree failure",
            ))
        } else {
            channel.process.kill_tree()
        };

        match signal_result {
            Ok(()) => Ok(TeardownStart::Signalled { pid }),
            // async-xpty reports this exact error when the reader's wait()
            // already observed exit. That target is gone, not still running.
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(
                TeardownStart::AlreadyExited(TeardownOutcome::AlreadyExited {
                    channel_id: channel_id.to_owned(),
                    pid,
                }),
            ),
            Err(error) => Err(TeardownOutcome::SignallingFailed {
                channel_id: channel_id.to_owned(),
                pid,
                error,
            }),
        }
    }

    /// Destroy all channels (graceful shutdown).
    pub async fn destroy_all(&mut self) -> DestroyAllSummary {
        let channel_ids = self.channel_ids();
        let swept_channels = channel_ids.len();
        let mut teardown_waits = Vec::with_capacity(channel_ids.len());
        let mut summary = DestroyAllSummary::default();
        for channel_id in channel_ids {
            match self.start_teardown(&channel_id) {
                Ok(TeardownStart::Signalled { pid }) => {
                    let process = self
                        .remove(&channel_id)
                        .expect("signalled channel must remain registered until removal");
                    let confirmation = TeardownConfirmation {
                        channel_id: channel_id.clone(),
                        pid,
                        process,
                        wait_timeout: self.teardown_wait_timeout,
                    };
                    teardown_waits.push(TeardownWait {
                        channel_id,
                        pid,
                        wait: tokio::spawn(async move { confirmation.confirm().await }),
                    });
                }
                Ok(TeardownStart::AlreadyExited(outcome)) => {
                    self.remove(&channel_id);
                    summary.record_outcome(&outcome);
                    log_teardown_outcome(outcome, "shutdown");
                }
                Err(outcome) => {
                    // Nothing retries a failed teardown today; leave the only
                    // PtyProcess handle registered so a live workload does not
                    // become unreachable while shutdown drains other channels.
                    summary.record_outcome(&outcome);
                    log_teardown_outcome(outcome, "shutdown");
                }
            }
        }

        // Every workload was signalled above before this first await. The
        // confirmation tasks therefore overlap, so this remains one wait bound
        // for the entire shutdown rather than one bound per channel.
        for teardown_wait in teardown_waits {
            match teardown_wait.wait.await {
                Ok(outcome) => {
                    summary.record_outcome(&outcome);
                    log_teardown_outcome(outcome, "shutdown");
                }
                Err(error) => {
                    tracing::error!(
                        %error,
                        channel_id = %teardown_wait.channel_id,
                        pid = teardown_wait.pid,
                        "channel teardown confirmation task failed"
                    );
                    summary.unresolved.push(UnresolvedChannel {
                        channel_id: teardown_wait.channel_id,
                        pid: teardown_wait.pid,
                        reason: UnresolvedTeardown::ConfirmationTaskFailed,
                    });
                }
            }
        }
        summary.assert_complete(swept_channels);
        summary
    }
}

impl TeardownConfirmation {
    pub(crate) fn new(channel_id: String, pid: u32, process: PtyProcess) -> Self {
        Self {
            channel_id,
            pid,
            process,
            wait_timeout: CHANNEL_TEARDOWN_WAIT_TIMEOUT,
        }
    }

    async fn confirm(mut self) -> TeardownOutcome {
        // On Windows a timed-out `wait()` retains a blocking-pool worker; one
        // detached task per channel is intentional. See khiops/async-xpty#5.
        match tokio::time::timeout(self.wait_timeout, self.process.wait()).await {
            Ok(Ok(status)) => TeardownOutcome::Exited {
                channel_id: self.channel_id,
                pid: self.pid,
                status,
            },
            Ok(Err(error)) => TeardownOutcome::SignalledButUnconfirmed {
                channel_id: self.channel_id,
                pid: self.pid,
                reason: UnconfirmedTeardown::WaitFailed(error),
            },
            Err(_) => TeardownOutcome::SignalledButUnconfirmed {
                channel_id: self.channel_id,
                pid: self.pid,
                reason: UnconfirmedTeardown::TimedOut {
                    timeout: self.wait_timeout,
                },
            },
        }
    }
}

/// Confirm a signalled workload in one task and let that task log its result.
pub(crate) fn spawn_teardown_confirmation(
    confirmation: TeardownConfirmation,
    site: &'static str,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let outcome = confirmation.confirm().await;
        log_teardown_outcome(outcome, site);
    })
}

pub(crate) fn log_teardown_outcome(outcome: TeardownOutcome, site: &'static str) {
    match outcome {
        TeardownOutcome::Exited {
            channel_id,
            pid,
            status,
        } => {
            tracing::info!(%site, %channel_id, pid, ?status, "terminal workload exited after tree teardown")
        }
        TeardownOutcome::SignalledButUnconfirmed {
            channel_id,
            pid,
            reason: UnconfirmedTeardown::WaitFailed(error),
        } => {
            tracing::warn!(%site, %channel_id, pid, %error, "terminal workload was signalled but its exit was not confirmed")
        }
        TeardownOutcome::SignalledButUnconfirmed {
            channel_id,
            pid,
            reason: UnconfirmedTeardown::TimedOut { timeout },
        } => {
            tracing::warn!(%site, %channel_id, pid, ?timeout, "terminal workload was signalled but its exit was not confirmed before the timeout")
        }
        TeardownOutcome::SignallingFailed {
            channel_id,
            pid,
            error,
        } => {
            tracing::warn!(%site, %channel_id, pid, %error, "failed to signal terminal workload; it may still be running")
        }
        TeardownOutcome::AlreadyExited { channel_id, pid } => {
            tracing::info!(%site, %channel_id, pid, "terminal workload had already exited before tree teardown")
        }
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell that exists on this platform and, attached to a PTY with nobody
    /// typing, blocks on input rather than exiting. Tests that hardcoded
    /// `/bin/sh` failed everywhere on Windows for as long as they existed,
    /// unnoticed because CI never ran the Rust suite there.
    fn test_shell() -> &'static str {
        if cfg!(windows) {
            "cmd.exe"
        } else {
            "/bin/sh"
        }
    }

    #[tokio::test]
    async fn test_spawn_channel() {
        let mut mgr = PtyManager::new();
        let (id, pid) = mgr
            .spawn(None, test_shell(), &[], None, None, 80, 24)
            .await
            .unwrap();
        assert!(!id.is_empty());
        assert!(pid > 0);
        assert!(mgr.contains(&id));
        // Cleanup
        if let Some(ch) = mgr.remove(&id) {
            let _ = ch.kill();
        }
    }

    #[tokio::test]
    async fn test_duplicate_channel_id_rejected() {
        let mut mgr = PtyManager::new();
        let fixed_id = "test-channel-01".to_string();
        let (id, _) = mgr
            .spawn(
                Some(fixed_id.clone()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .unwrap();
        assert_eq!(id, fixed_id);

        let err = mgr
            .spawn(
                Some(fixed_id.clone()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);

        // Cleanup
        if let Some(ch) = mgr.remove(&fixed_id) {
            let _ = ch.kill();
        }
    }

    #[tokio::test]
    async fn spawn_is_refused_after_shutdown_begins() {
        let mut manager = PtyManager::new();
        manager.begin_shutdown();

        let error = manager
            .spawn(
                Some("post-shutdown-spawn".to_owned()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .expect_err("a manager being swept must refuse a later spawn");

        assert!(error.to_string().contains("agent is shutting down"));
        assert!(manager.channels.is_empty());

        // Mutation caught: removing the shutting_down guard permits a detached
        // daemon handler to create a workload after the shutdown sweep began.
    }

    #[tokio::test]
    async fn test_destroy_all() {
        let mut mgr = PtyManager::new();
        mgr.spawn(None, test_shell(), &[], None, None, 80, 24)
            .await
            .unwrap();
        mgr.spawn(None, test_shell(), &[], None, None, 80, 24)
            .await
            .unwrap();
        assert_eq!(mgr.channel_ids().len(), 2);
        let summary = mgr.destroy_all().await;
        assert_eq!(summary.confirmed_shell_exits, 2);
        assert!(summary.unresolved.is_empty());
        assert_eq!(mgr.channel_ids().len(), 0);
    }

    #[tokio::test]
    async fn destroy_all_reports_a_signalling_failure_as_unresolved() {
        let mut manager = PtyManager::new();
        let channel_id = "signal-failure-shutdown".to_string();
        let (spawned_channel_id, pid) = manager
            .spawn(
                Some(channel_id.clone()),
                test_shell(),
                // No args: an idle shell on a PTY blocks reading input, which is
                // all this needs, and the sleep had no portable equivalent.
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .expect("spawn terminal workload");
        manager.fail_next_teardown_signal();

        let summary = manager.destroy_all().await;

        assert_eq!(summary.confirmed_shell_exits, 0);
        assert_eq!(
            summary.unresolved,
            vec![UnresolvedChannel {
                channel_id: spawned_channel_id.clone(),
                pid,
                reason: UnresolvedTeardown::SignallingFailed,
            }]
        );
        assert_eq!(
            summary.confirmed_shell_exits + summary.unresolved.len(),
            1,
            "every channel present when teardown started must be represented"
        );
        assert!(manager.contains(&spawned_channel_id));

        if let Some(process) = manager.remove(&spawned_channel_id) {
            let _ = process.kill_tree();
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_teardown_tests {
        use std::fs;
        use std::io;
        use std::path::{Path, PathBuf};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        use tokio::sync::{mpsc, Mutex};

        use super::*;
        use crate::batch::OutputEvent;
        use crate::handler::{handle_message, SnapshotSenders};
        use crate::protocol::HubToAgent;

        const FIXTURE_DEADLINE: Duration = Duration::from_secs(10);
        const TRACED_EXIT_RELEASE_DELAY: Duration = Duration::from_millis(250);

        /// Ensures a fixture does not survive if a test fails before teardown.
        struct WorkloadCleanup {
            shell_pid: i32,
            child_pid: i32,
            pid_file: PathBuf,
            armed: bool,
        }

        impl WorkloadCleanup {
            fn disarm(mut self) {
                let _ = fs::remove_file(&self.pid_file);
                self.armed = false;
            }
        }

        impl Drop for WorkloadCleanup {
            fn drop(&mut self) {
                if !self.armed {
                    return;
                }
                // SAFETY: the shell PID comes from the PTY we just spawned. The
                // negative PID addresses that shell's process group, which the
                // fixture below verifies contains the reported child.
                // These raw PIDs can theoretically be reused after the fixture
                // exits and before an unwind; the fixture is short-lived, so
                // this deliberately accepted cleanup-only risk stays bounded.
                unsafe {
                    libc::kill(-self.shell_pid, libc::SIGKILL);
                    libc::kill(self.child_pid, libc::SIGKILL);
                }
                let _ = fs::remove_file(&self.pid_file);
            }
        }

        fn quote_for_sh(path: &Path) -> String {
            format!(
                "'{}'",
                path.display().to_string().replace('\'', "'\\\"'\\\"'")
            )
        }

        fn pid_file() -> PathBuf {
            std::env::temp_dir().join(format!(
                "termora-agent-tree-teardown-{}-{}.pid",
                std::process::id(),
                ulid::Ulid::new()
            ))
        }

        fn pid_is_alive(pid: i32) -> io::Result<bool> {
            // SAFETY: signal 0 checks liveness without delivering a signal.
            let rc = unsafe { libc::kill(pid, 0) };
            if rc == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ESRCH) => Ok(false),
                Some(libc::EPERM) => Ok(true),
                _ => Err(error),
            }
        }

        fn enable_subreaper() -> io::Result<()> {
            // Reap an orphaned background child ourselves in containers whose
            // PID 1 does not promptly reap zombies, keeping kill(pid, 0) honest.
            // SAFETY: PR_SET_CHILD_SUBREAPER affects only this test process and
            // its descendants; the remaining varargs are zero as required. It
            // is process-global and intentionally not restored, so sibling-test
            // orphaned grandchildren can also be adopted and left unreaped.
            let rc = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
            if rc == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        fn reap_if_adopted(pid: i32) -> io::Result<()> {
            let mut status = 0;
            // SAFETY: pid is a fixture child; WNOHANG prevents blocking.
            let rc = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if rc == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ECHILD) {
                    return Err(error);
                }
            }
            Ok(())
        }

        fn hold_at_exit(pid: i32) -> io::Result<()> {
            // PTRACE_O_TRACEEXIT leaves the tracee stopped after SIGKILL until
            // the test releases it. This makes the fixture's death observably
            // slow without changing the production teardown timeout.
            // SAFETY: pid belongs to a PTY child spawned by this test; the
            // option value is passed as the ptrace data word.
            let rc = unsafe {
                libc::ptrace(
                    libc::PTRACE_SEIZE,
                    pid,
                    std::ptr::null_mut::<libc::c_void>(),
                    libc::PTRACE_O_TRACEEXIT as *mut libc::c_void,
                )
            };
            if rc == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        fn release_exit(pid: i32) -> io::Result<()> {
            // SAFETY: a successfully seized fixture is stopped at its traced
            // exit event before this function is called.
            let rc = unsafe {
                libc::ptrace(
                    libc::PTRACE_CONT,
                    pid,
                    std::ptr::null_mut::<libc::c_void>(),
                    std::ptr::null_mut::<libc::c_void>(),
                )
            };
            if rc == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        struct TracedProcessesCleanup {
            pids: Vec<i32>,
        }

        impl Drop for TracedProcessesCleanup {
            fn drop(&mut self) {
                for &pid in &self.pids {
                    // Best effort only: an assertion may fire before a traced
                    // process has reached its exit stop. Resume any stopped
                    // tracee after SIGKILL so this test cannot strand it.
                    // SAFETY: each PID was just spawned and seized by this test.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                        libc::ptrace(
                            libc::PTRACE_CONT,
                            pid,
                            std::ptr::null_mut::<libc::c_void>(),
                            std::ptr::null_mut::<libc::c_void>(),
                        );
                    }
                }
            }
        }

        async fn wait_for_child_pid(path: &Path) -> i32 {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                if let Ok(contents) = fs::read_to_string(path) {
                    if let Ok(pid) = contents.trim().parse() {
                        return pid;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "fixture did not write child PID to {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn wait_until_gone(pid: i32) {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                reap_if_adopted(pid).expect("reap adopted fixture child");
                if !pid_is_alive(pid).expect("check fixture child liveness") {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "background child PID {pid} survived terminal teardown"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn spawn_background_workload(
            manager: &mut PtyManager,
            channel_id: String,
        ) -> (String, WorkloadCleanup) {
            let child_pid_file = pid_file();
            let args = vec![
                "-c".to_string(),
                format!(
                    "set +m; /bin/sh -c 'trap \"\" HUP; exec sleep 30' & child=$!; printf '%s\\n' \"$child\" > {}; wait",
                    quote_for_sh(&child_pid_file)
                ),
            ];
            let (channel_id, shell_pid) = manager
                .spawn(Some(channel_id), "/bin/sh", &args, None, None, 80, 24)
                .await
                .expect("spawn background workload");
            let child_pid = wait_for_child_pid(&child_pid_file).await;
            assert!(pid_is_alive(child_pid).expect("check fixture child liveness"));
            // SAFETY: child_pid was written by the live fixture and getpgid only
            // observes its process group.
            assert_eq!(unsafe { libc::getpgid(child_pid) }, shell_pid as i32);
            (
                channel_id,
                WorkloadCleanup {
                    shell_pid: shell_pid as i32,
                    child_pid,
                    pid_file: child_pid_file,
                    armed: true,
                },
            )
        }

        #[tokio::test]
        async fn destroy_all_kills_a_background_child_in_the_shell_process_group() {
            // Regression: replacing kill_tree() with kill() kills only the
            // shell, leaving this background child alive and making this fail.
            enable_subreaper().expect("enable child subreaper");
            let mut manager = PtyManager::new();
            let (_channel_id, cleanup) =
                spawn_background_workload(&mut manager, "destroy-all-tree".to_string()).await;

            manager.destroy_all().await;
            wait_until_gone(cleanup.child_pid).await;
            cleanup.disarm();
        }

        #[tokio::test]
        async fn destroy_message_kills_a_background_child_in_the_shell_process_group() {
            enable_subreaper().expect("enable child subreaper");
            let manager = Arc::new(Mutex::new(PtyManager::new()));
            let (channel_id, cleanup) = {
                let mut guard = manager.lock().await;
                spawn_background_workload(&mut guard, "destroy-message-tree".to_string()).await
            };
            let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
            let (output_tx, _output_rx) = mpsc::unbounded_channel::<OutputEvent>();
            let cmd_senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));

            // There is deliberately no reader task here, so this test cannot
            // cover a reused channel ID interacting with a reader; #114 owns
            // that pre-existing ID-only cleanup problem.

            handle_message(
                HubToAgent::Destroy {
                    channel_id: channel_id.clone(),
                },
                Arc::clone(&manager),
                frame_tx,
                output_tx,
                cmd_senders,
            )
            .await
            .expect("handle DESTROY message");

            assert!(!manager.lock().await.contains(&channel_id));
            wait_until_gone(cleanup.child_pid).await;
            cleanup.disarm();
        }

        #[tokio::test]
        async fn destroy_all_reports_a_workload_unconfirmed_at_the_wait_bound() {
            let mut manager = PtyManager::new();
            let (channel_id, pid) = manager
                .spawn(
                    Some("unconfirmed-shutdown".to_string()),
                    "/bin/sh",
                    &["-c".to_string(), "sleep 30".to_string()],
                    None,
                    None,
                    80,
                    24,
                )
                .await
                .expect("spawn terminal workload");
            hold_at_exit(pid as i32).expect("trace terminal workload exit");
            let traced_cleanup = TracedProcessesCleanup {
                pids: vec![pid as i32],
            };

            let summary = manager.destroy_all().await;

            assert_eq!(summary.confirmed_shell_exits, 0);
            assert_eq!(
                summary.unresolved,
                vec![UnresolvedChannel {
                    channel_id,
                    pid,
                    reason: UnresolvedTeardown::TimedOut,
                }]
            );

            release_exit(pid as i32).expect("release terminal workload exit");
            drop(traced_cleanup);
        }

        #[tokio::test]
        async fn destroy_all_tears_down_several_channels_with_one_wait_bound() {
            let manager = Arc::new(Mutex::new(PtyManager::new()));
            let mut traced_pids = Vec::new();
            for number in 0..6 {
                let mut guard = manager.lock().await;
                let (_channel_id, pid) = guard
                    .spawn(
                        Some(format!("many-teardown-{number}")),
                        "/bin/sh",
                        &["-c".to_string(), "sleep 30".to_string()],
                        None,
                        None,
                        80,
                        24,
                    )
                    .await
                    .expect("spawn terminal workload");
                hold_at_exit(pid as i32).expect("trace terminal workload exit");
                traced_pids.push(pid as i32);
            }
            let traced_cleanup = TracedProcessesCleanup { pids: traced_pids };

            let started = Instant::now();
            let teardown_manager = Arc::clone(&manager);
            let teardown = tokio::spawn(async move {
                teardown_manager.lock().await.destroy_all().await;
            });

            tokio::time::sleep(TRACED_EXIT_RELEASE_DELAY).await;
            for &pid in &traced_cleanup.pids {
                release_exit(pid).expect("all workloads must be signalled before waiting");
            }
            teardown.await.expect("destroy all task");
            assert!(
                started.elapsed() < TRACED_EXIT_RELEASE_DELAY + Duration::from_secs(1),
                "all channels must wait concurrently after being signalled"
            );
            assert!(manager.lock().await.channel_ids().is_empty());

            // Mutation caught: changing destroy_all() to a sequential
            // signal-and-wait loop leaves five tracees running here, so their
            // release_exit() calls fail instead of reaching this assertion.
        }
    }
}
