<!--
doc-meta:
  story_id: in-app-update-flow
  status: draft
  complexity: COMPLEX
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: false
  issue: 86
-->

# In-app update flow

## §1 Scope

Let the desktop app update itself without the user hunting for an installer, and
without an update ever destroying terminals behind their back.

The design rests on two decisions that make the hard cases disappear rather than
be negotiated:

- **Ownership.** A locally spawned hub and agent are *our children* — tracked and
  contained, so we can end them and everything they spawned. A remote agent is a
  *peer* over SSH and is never ours to kill.
- **Apply at cold start.** Updates are staged in the background and applied at
  launch, before anything is running. No terminal is ever killed to install.

**In scope:** update detection and notification, background staging with
signature verification, cold-start application, the process containment that
makes a clean teardown possible, the `hide`/`quit` split that gives the teardown
a meaning, and the release-side publication of signed artifacts + `latest.json`.

**Out of scope:** the Store/MSIX channel (updates through the Store; already
excluded by the merged guard), rollback (§8), macOS/Linux channels.

## §2 Reality constraints (verified against `main`, with the code that proves them)

- **C1 — Stopping the agent while the hub lives resurrects it.** `agent.on("close")`
  calls `reconnectDaemon` → `attachDaemonFresh` → `connectOrLaunch`, which
  **spawns a fresh daemon** (`hub/src/session/agent-connection-manager.ts:454-489,
  :534`). Channels go `dead` only after repeated failures. Any teardown must
  therefore stop the **hub first**, or set an explicit no-relaunch latch before
  touching the agent. *(An earlier draft asserted the opposite and built a
  sequence the code actively defeats.)*
- **C2 — Nothing in the stack kills a process tree.** On Windows `kill()` is
  `TerminateProcess` on the immediate shell; there is no Job Object anywhere in
  the repo or in `async-xpty`. On Unix it is `kill(pid)`, not `killpg`, against a
  shell that `setsid()` made a session leader. `destroy_all()` does not `wait()`.
  The agent's signal handler calls `exit(0)` without touching the PTY manager.
  Grandchildren survive every path — and a surviving grandchild can hold a handle
  in the install directory.
- **C3 — Stage before you stop.** The artifact must be downloaded, verified and
  written to disk before anything is torn down. Otherwise a failed download
  leaves the user with neither a working app nor an update.
- **C4 — Process lifetime is commanded, never inferred.** "The agent exits when
  the hub disconnects" is rejected: it would break the promise that local
  sessions survive a hub restart.
- **C5 — Tauri quits the app itself before installing on Windows.** `install()`
  commits and NSIS relaunches; `on_before_exit` is a last-resort hook, not a
  teardown coordinator. Anything that must succeed has to complete *before*
  `install()` is called — after it, there is nothing to abort into. At cold start
  this is benign: nothing is running to tear down.
- **C6 — No bootstrap.** Installs ≤ 0.6.0 have no update flow and will never
  update themselves. In-app updating is supported *from* the first release that
  ships it; earlier installs need one manual upgrade. Say so in the release notes.
- **C7 — A surviving old agent bricks local sessions.** The hub enforces strict
  build-version equality and aborts on mismatch. An agent that outlives an update
  leaves the new hub unable to connect, with no shutdown message it understands.
  Full teardown on quit is what prevents this; force-termination by recorded
  identity is the repair.

## §3 Current state

| Fact | Evidence |
|------|----------|
| Updater plugin registered, never invoked | `desktop/src-tauri/src/lib.rs`; no `check()` caller anywhere |
| Store/MSIX builds skip the updater, fail-closed | merged in `3626f92` |
| Public key embedded and pinned by a test; CI holds the private half | `tauri.conf.json`, `tauri-config.spec.ts` |
| `createUpdaterArtifacts` disabled; nothing signed or published | `tauri.conf.json` |
| No SHUTDOWN in the hub↔agent protocol; daemon loop never exits | `crates/termora-agent/src/protocol.rs`, `daemon.rs` |
| Agent spawned detached + `unref()`; PID recorded nowhere | `hub/src/session/agent-launcher.ts` |
| Hub auto-relaunches the agent on close | `agent-connection-manager.ts:454-489`, `:534` (C1) |
| No process-tree termination on any platform | `crates/termora-agent/src/pty.rs`, `async-xpty` (C2) |
| Hub stop is pid-confirmed by the caller, not by the route | `lib.rs` `confirm_hub_stopped_or_kill`; `POST /api/shutdown` returns then tears down |
| Connected-client count excludes the caller only if it sends its client id | `session-manager.ts` `getOthersCount`; the CLI does not send it |
| Four quit paths exist; only the window-close one reaches the webview | `App.vue`, `desktop-lifecycle.ts`, `lib.rs` `handle_tray_quit`, `cli.ts` `cmdStop`, OS shutdown |
| `closeBehavior` is a shipped setting whose `tray` value means "never quit" | `close-behavior.ts`, `DesktopCategory.vue` |
| Hardened GitHub-Releases download prior art exists | `hub/src/agent-fetch.ts`, `agent-cache.ts` (HTTPS-on-redirect, size caps, timeouts, 0600 temp files, 0700 dirs) |

## §4 Design

### §4.1 Hide and quit

`closeBehavior` becomes **`ask` / `hide` / `quit`**, replacing `ask` / `tray` /
`quit`. The rename is the point: the old `tray` value described *where the window
went*, not what happened to the user's work.

| Gesture | Meaning |
|---------|---------|
| **Hide** | The window closes. The hub, the agent and every terminal keep running. Reopen from the tray. |
| **Quit** | Everything local stops: window, hub, agent, and the processes they spawned — the whole tree on Windows, the shell's process group on Unix (§4.2). Terminals end. |

Persisted values migrate `tray → hide` on read; an unknown value falls back to
`ask`. Every quit path — window close, tray menu, `termora stop`, OS logoff —
means the same thing, so the coordinator lives in Rust with the webview as one
presenter among several rather than as the owner of the decision.

Remote agents are untouched by either gesture: they are peers, not children.

### §4.2 Process ownership and containment (the enabling work)

Containment is a property of *spawning*, so it lives where the spawn lives: in
`async-xpty`, which owns `CreateProcessW` and the primary-thread handle. The
agent cannot retrofit it — see §4.2.1.

**Windows.** Each locally spawned PTY workload is born inside a **Job Object**
with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigned at creation through
`PROC_THREAD_ATTRIBUTE_JOB_LIST` on the attribute list the spawn already builds
for the pseudoconsole. Closing the handle ends the entire tree, including
grandchildren, **even when the agent itself is force-killed**. One job per PTY
process, so one terminal can be torn down without touching its siblings.

**Unix — best effort, and the spec says so.** Terminate the shell's process
group; the group exists because `child_setup()` calls `setsid()`. This is *not*
a process-tree primitive. An interactive shell puts each job in its **own**
process group, and any child may `setpgid`/`setsid` itself out of the group. So
a background job started from the terminal, and a daemonizing grandchild, can
survive. Unix teardown reaches the shell's process group — nothing broader is
claimed, and Windows is deliberately the stronger platform here. Strong Linux
containment (cgroup v2 scope, or a subreaper walking descendants) is a separate
follow-up, not a prerequisite for the update flow.

**Both.** `destroy_all()` kills *and* `wait()`s, bounded.

**Shutdown ownership.** The daemon loop owns the `PtyManager` exclusively and
selects on a shutdown channel: the signal task only *requests* shutdown, and the
loop stops accepting work, runs the bounded teardown, reports completion, then
exits. A hard deadline still reaches the emergency exit, so a wedged teardown
delays exit by a bound rather than preventing it. Sharing the manager through a
lock instead would put teardown in a race with message handling and blur which
side owns the exit.

#### §4.2.1 Where the work lands

`async-xpty` is consumed as a rev-pinned git dependency, so the containment
primitives ship upstream first and termora consumes them by moving the pin.

| Repo | Change |
|------|--------|
| `khiops/async-xpty` | Job Object at creation (Windows), process-group signal (Unix), bounded `wait()`, exposed as a **new** `kill_tree()` — `kill()` keeps meaning "terminate the direct process". Widening `kill()` in place would be a silent semantic break for every other consumer of a general-purpose crate. The job handle is owned by the process value, and `Drop` closes it. |
| `khiops/termora` | Move the rev pin; `destroy_all()` calls `kill_tree()` and waits, bounded; identity file; `SHUTDOWN` protocol; no-relaunch latch; the shutdown channel above. |

Until the pin moves, the agent cannot honestly answer `childrenExited: true`.

**Identity.** The agent writes an identity file beside its socket at startup —
pid, process creation time, executable path, instance nonce — mode 0600, in the
0700 directory the launcher already creates, and **version-tagged so a newer hub
can read an older agent's file**. The hub reads it and cross-checks it against
`HELLO`. The agent writes it, not the hub, because the daemon outlives hubs: a
fresh hub attaching to a pre-existing daemon has recorded nothing.

A bare pid is never sufficient — pids are reused; identity is pid *plus*
creation time.

### §4.3 Stopping cleanly

Order matters, and C1 dictates it:

1. Set the **no-relaunch latch**. The hub is the only component that brings
   things back, so the latch lives there and covers **three** paths, not one:

   | Path | What it revives | Trigger |
   |------|-----------------|---------|
   | `reconnectDaemon` / `warmRestartLocal` | the agent | the agent's connection closes (C1) |
   | `respawnDeadChannel` | a terminal, under its **old channel id** | a client reattaches to a dead channel |
   | `restartChannel` | a terminal, under its **old channel id** | the user asks for a restart |

   The middle one matters most because nothing initiates it: a client that
   reattaches during a quit resurrects a terminal that was just torn down, with
   no user action to blame it on.

   The latch belongs to the hub for the same reason it does in every process
   supervisor: systemd declines to apply `Restart=` when the death was its own
   doing, supervisord's `STOPPED` state suppresses `autorestart`, and neither
   asks the supervised process to remember that it should stay dead — the thing
   being stopped may be the thing that is broken. Note also what none of them
   do: reserve the stopped entity's identity while it dies. Kubernetes gives the
   replacement a new name rather than blocking the old one. Reusing a channel id
   is how `restartChannel` and `respawnDeadChannel` work, so a teardown that
   held an id back would break both.

2. Stop the **hub**, confirmed by recorded identity (reuse
   `confirm_hub_stopped_or_kill`; do not derive a third variant).
3. Stop the **agent**: `SHUTDOWN { reason }` on the protocol — a daemon-level
   message, not overloaded `DESTROY`. Acknowledgement is two-phase:
   `SHUTDOWN_ACCEPTED` (received) then `SHUTDOWN_COMPLETE { childrenExited }`.
   Receipt is not exit.
4. Confirm exit **by pid + creation time** (authoritative); pipe disappearance is
   a fast-path hint, not proof.
5. If exit cannot be confirmed within the bound, force-terminate by recorded
   identity — the Job Object makes that clean. This is a normal repair path
   (C7), not an exotic fallback.

### §4.4 Applying an update

**Preferred — cold start.** At launch, before the hub sidecar is spawned and
before any agent exists, a staged and re-verified update is applied. Nothing is
running, so nothing is lost. Because *quit* now ends everything (§4.1), every
launch after a quit is a cold start.

**If the app launches and finds a live hub** (attached to a pre-existing one, or
the user only ever hides), the update stays staged and the user is told it will
apply next time they quit and reopen. No terminals are killed to hurry it.

There is no mid-session teardown, no fencing, no maintenance lease and no
"end N terminals" negotiation: the model removes the situation those existed to
manage.

**Other clients.** Quit already refuses to stop a hub serving browser or mobile
clients without an explicit confirmation; that guard is unchanged and remains
load-bearing, because forcing it ends *remote* users' work too. The caller must
always send its client id, or it counts itself and can never proceed.

### §4.5 Staging

Check the endpoint; on a newer version, download, verify the signature against
the embedded key, confirm target and installer kind, and stage. Preflight first:
disk space, install scope (per-user vs per-machine), architecture, installer kind.

Reuse the hardened transport already in `agent-fetch.ts` — HTTPS enforced across
redirects, size caps, timeouts, exclusive-create 0600 temp files — rather than
writing a second downloader.

The staging directory is per-user with restrictive ACLs, under a parent the user
cannot swap, with a random filename and no reparse points.

**Re-verify immediately before executing**, over the same bytes that will run:
reopen without following reparse points, re-check path identity, hash, size,
signer and signature against what the journal recorded. This matters concretely
because `installMode` is `"both"`: a per-machine install runs **elevated**, so
executing user-writable bytes would turn a file write into privilege escalation.
When the install will be elevated, do not execute from a user-writable path.

### §4.6 Journal and recovery

A journal in the user state directory — never in the install directory, which the
installer replaces — written atomically (temp file, 0600, fsync, rename; the
pattern already in `cli.ts`) and carrying a `journal_version`.

States: `idle → available → downloading → staged → apply-armed → apply-launched → verifying → idle`,
plus `failed { reason, attempts, lastAttemptAt }`.

- `downloading` is cancellable back to `available`; partial files are cleaned up
  on leaving it. On a metered connection, defer rather than download.
- `apply-armed` is written and fsync'd **immediately before** launching the
  installer, carrying installer pid, launch time, source and target versions.
- Recovery classifies by reading the **version actually on disk** — the only
  ground truth that separates "installer never launched" (safe retry) from
  "already updated" (clear the journal) from "half-written" (never auto-retry;
  offer the artifact and the release page).
- After N failed applies the state is terminal: no further automatic retry, only
  manual reinstall instructions. A health-check failure must never loop back into
  reinstalling the version that just failed it.
- A newer version appearing while one is staged supersedes it: the old artifact
  is deleted and the journal target replaced atomically.
- The journal is the arbiter against a second instance: an exclusive-create lock
  held for the whole `apply-armed → verifying` span, stale-keyed on pid +
  creation time. (`tauri-plugin-single-instance` is not a dependency today.)

### §4.7 Release side

- Enable `createUpdaterArtifacts` **only for the release build**, via the
  `--config` override; enabling it in the committed config breaks every unsigned
  build path.
- Upload signed artifacts and publish `latest.json`. **`gh release upload
  "file#name"` sets a display label, not the asset name** — copy or rename before
  uploading and resolve assets by their real names.
- The pipeline verifies that the CI private key is the counterpart of the
  embedded public key, and that every published signature verifies against its
  artifact. This is a hard gate that fails the release.
- After publishing, assert the manifest **exists and parses at its public URL** —
  a missing asset otherwise fails silently forever.
- **Never register a `version_comparator`.** Tauri refuses downgrades by default;
  the requirement is an absence, so it needs a test asserting the absence.
- Key rotation is a breaking change: installed clients trust only the embedded
  key, so rotating strands them into a manual reinstall. Document the migration.

### §4.8 Trust boundary (state it, don't assume it)

The manifest is protected by TLS only; the **artifact** is minisign-authentic;
anti-downgrade rests on version monotonicity. Every manifest-sourced string
(notes, flags) renders as plain text, length-capped — never as HTML, and never as
the sole basis for a destructive default.

### §4.9 Renderer contract

Expose a three-way state — *managed externally (Store)* / *unavailable (probe
failed)* / *available* — derived from the same package-identity probe the Rust
guard uses, not inferred from an IPC error string. Revisit `updater:default`,
today granted unconditionally even where the plugin is not registered.

## §5 BDD scenarios

```
Scenario: Hide keeps everything running
  Given closeBehavior is "hide"
  When the user closes the window
  Then the window hides and the hub, agent and terminals keep running

Scenario: Quit ends the contained tree on Windows
  Given terminals are running with background grandchildren
  When the user quits
  Then the hub stops, then the agent stops, and the job object ends every
       descendant, grandchildren included

Scenario: Quit ends the shell's process group on Unix
  Given a terminal is running a child in the shell's own process group
  When the user quits
  Then the hub stops, then the agent stops, and that group is terminated
  And a child that moved itself to another process group is documented as
      surviving — Unix teardown claims the group, not the tree

Scenario: The hub does not resurrect the agent during teardown
  Given the hub is running
  When the agent is stopped for a teardown
  Then the no-relaunch latch prevents a replacement daemon from being launched

Scenario: A staged update applies at cold start with nothing running
  Given an update is staged and no hub is alive
  When the app launches
  Then the update is re-verified and applied before any hub or agent starts
  And no terminal is affected

Scenario: A live hub defers the update instead of killing terminals
  Given an update is staged and a hub with live channels is running
  When the app launches
  Then the update stays staged and the user is told when it will apply

Scenario: Nothing is stopped before the artifact is safe
  When the download or signature verification fails
  Then the app keeps running untouched and no teardown is attempted

Scenario: A modified staged artifact is refused
  Given a staged artifact is altered after verification
  When apply runs
  Then re-verification fails and it is not executed

Scenario: A surviving old agent is repaired, not tolerated
  Given an agent from the previous version outlived an update
  When the new hub starts
  Then it terminates it by recorded identity and launches the matching one

Scenario: An interrupted update is classified, not blindly retried
  Given the machine died after the installer launched
  When the app starts
  Then recovery reads the version on disk to decide between retry, clear and manual

Scenario: Quit never silently cuts a remote client
  Given a browser client is attached
  When the user quits with an update staged
  Then the impact is stated before anything stops

Scenario: Store builds do none of this
  Given a packaged MSIX build
  Then no check runs and no update affordance is shown
```

## §6 Slices

| Slice | Content | Depends on |
|-------|---------|-----------|
| **S1a** Containment primitives (`async-xpty`) | Job Object at creation (Windows), process-group signal (Unix), bounded `wait()`, new `kill_tree()` leaving `kill()` semantics intact | — |
| **S1b** Consume the primitives | Move the rev pin; `destroy_all()` uses `kill_tree()` and waits, bounded | S1a |
| **S1c** Lifecycle | Shutdown channel owned by the daemon loop, agent-written versioned identity file, `SHUTDOWN` two-phase protocol, no-relaunch latch, identity-confirmed stop | S1b |
| **S2** Release publication | release-only `createUpdaterArtifacts`, signed upload with real asset names, `latest.json`, key-pair and per-signature pipeline gates, post-publish URL assertion | — |
| **S0** Notify only | check the endpoint, surface "0.8.0 is available" with a link. No download, no staging, no code-execution path | S2 |
| **S3** Stage | preflight, download (reusing `agent-fetch` hardening), verify, stage, journal, renderer contract | S2 to ship; buildable and testable against the §7 fixture endpoint without it |
| **S4a** Cold-start applier | re-verification, apply-at-launch, recovery classification, terminal-failure handling — headless, driven by the harness | S1c, S3 |
| **S4b** Gestures & UI | `ask`/`hide`/`quit` rename + migration, one coordinator in Rust with webview and native presenters, staged-update surfacing | S4a |

The S1 chain and S2 run in parallel; inside the chain, S1a→S1b→S1c is strictly
ordered because S1a lands in another repo and S1b is what moves the pin.
**S0 ships first user value** and exercises the manifest end-to-end with real
users before anything trusts it for code execution.

## §7 Test strategy

No throwaway releases.

1. **Pure logic in CI** — gesture resolution and migration, state transitions,
   version comparison, target and installer-kind matching, recovery
   classification.
2. **Local fixture endpoint + test keypair** — hand-written `latest.json`, a
   locally built and locally signed artifact, served over a local HTTP server.
   Exercises the real manifest parser, verifier, downloader and selection,
   offline and repeatably. **Negative fixtures:** malformed manifest, wrong
   target, bad signature, wrong key, altered bytes, unreachable endpoint,
   attempted downgrade, superseded staging.
3. **Lifecycle harness** — fake the agent *process*, never the coordinator under
   test. Its first test asserts, against the **real** `agent-connection-manager`,
   that stopping the agent while the hub lives launches no replacement (C1). Then
   failure injection at every transition, each naming the mutation it catches.
4. **Tree-containment tests** — spawn a grandchild holding a handle in a fixture
   install directory; assert quit ends it, and that an install blocked by a
   surviving lock fails *cleanly* rather than half-applying. Per platform: on
   Windows the grandchild dies because the job closes; on Unix the test asserts
   the documented bound — a grandchild in the shell's group dies, one that
   `setsid`s away survives. A test that asserts the Unix escapee dies would be
   asserting a promise §4.2 does not make.
5. **Windows CI install job** — install release N, point the updater at a fixture
   endpoint serving N+1, apply, assert the version, hub reachability and agent
   spawnability. This converts the highest-risk surface from manual-once to
   automated-always.
6. **Real Windows manual smoke** — UAC, antivirus, shortcut replacement, Tauri's
   real restart. Explicitly includes **antivirus quarantining the staged artifact
   between stage and apply**: the artifact is unsigned until #86 lands, so this is
   the expected case, not an edge case.
7. **Regression locks proven RED→GREEN by reverting the fix**: the relaunch
   latch, apply-time re-verification, and the absent `version_comparator`.

Still uncovered and accepted for now: disk-full mid-install, OS logoff as the
quit trigger, and dual-instance racing beyond the journal lock.

## §8 Deferred

- **Rollback.** Binaries can be replaced while `meta.db` / `spool.db` migrations
  make a downgrade unsafe. Revisit only with retained known-good installers and
  tested downgrade migrations.
- **Cross-grading installer kinds** (NSIS ↔ MSI) or changing per-user vs
  per-machine scope during an update.
- **Strong Unix containment.** cgroup v2 scope, or `PR_SET_CHILD_SUBREAPER` plus a
  descendant walk, to reach what a process group cannot (§4.2). Linux-specific;
  macOS would need its own design. Tracked in #113 — the update flow does not
  wait on it, because apply-at-cold-start never needs to end a live tree.
- **Beta channel.** `/releases/latest/` never resolves to a prerelease, so a beta
  manifest needs its own URL. Deferred, but movable: no stable release ships
  until the update path is trustworthy end to end, and a beta channel is the way
  to exercise it against real installs without making everyone the test.
- macOS / Linux channels.
- The agent-binary fetch path is SHA-256-only and can skip the checksum for
  legacy versions; that asymmetry with minisign-signed desktop updates is known
  and out of scope here.

## §12.5 Adversarial ledger

35 findings; 6 blocking. Folded: the C1 reversal (hub relaunches the agent — the
previous sequence was refuted by the code), no process-tree kill anywhere (C2),
Tauri's auto-quit before install (C5), four quit paths with the UI in only one
(§4.1), apply-at-cold-start (§4.4), split apply states and on-disk-version
recovery (§4.6), TOCTOU-to-LPE via elevated install (§4.5), unsigned manifest
trust boundary (§4.8), `version_comparator` as a negative requirement (§4.7),
S0 notify-first and the S4a/S4b split (§6), harness must not fake the coordinator
(§7.3), Windows CI install job (§7.5).

## §12.6 Consensus ledger

A second consult, run against the code before implementation, moved four things:
containment belongs upstream in `async-xpty` at process creation rather than as a
post-spawn assignment (the race makes the invariant unprovable, not merely
unlikely); `kill_tree()` is added instead of widening `kill()`; the daemon loop
owns teardown through a shutdown channel rather than sharing the manager under a
lock; and the Unix promise was **false as written** — a process group is not a
process tree, so §4.1/§4.2/§5/§7.4 now claim the group and nothing more. That
last one is the reason to run the consult against code rather than against the
document: every reviewer so far had read "every spawned process is gone" without
checking whether `killpg` can deliver it.

Adopted: Windows Job Object containment, two-phase shutdown acknowledgement,
TOCTOU hardening with re-verification before execution, monotonic anti-downgrade,
staged-update status surfaced beyond the desktop renderer. Rejected: a separate
updater helper process — with apply-at-cold-start there is no transaction that
must outlive the app.
