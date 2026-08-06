---
doc-meta:
  status: canonical
  story_id: "43"
  scope: hub
  type: specification
  updated: 2026-06-09
  shipped_in: PR #49 (squash bd2cc04)
---
# Interactive prompt ownership & routing model (#43, prompt sub-system)

## Problem

The coalesced multi-client SSH connect issues interactive prompts (passphrase/password,
host-key TOFU/mismatch, agent-binary verify, elevation). The current handling keys prompts
by bare `hostId` with a transient owner `clientId`, which produced a long tail of edges
(≈10 gate rounds): cross-client TEST_CONNECT clobbering a session prompt; re-target on
owner-disconnect fixing only the FIRST prompt while subsequent prompts stay bound to the
disconnected leader; prompts surviving `closeSession` when a reconnect controller is
clobbered; stale owners answering after re-target. Root cause: a prompt's identity, owner,
route, and lifecycle are conflated onto `(hostId → {resolve, clientId})`, with no stable
owner and no persistent route across a multi-prompt sequence.

## Core principles

- **P1 — Owner is the ACQUISITION, not a client.** A prompt belongs to the host's
  `SessionAcquisition` (stable `acqId`) — or, for TEST_CONNECT/elevation outside an
  acquisition, to a distinct ephemeral prompt-context with its own id. A client is only a
  *route*, never the owner.
- **P2 — Route is mutable, owner is stable.** The owning context carries
  `routeClientId` = the single live client that currently receives this context's prompts.
  Re-target updates `routeClientId` ONCE on the context; EVERY prompt in the sequence
  (first and subsequent) routes to the current `routeClientId`.
- **P3 — Namespaced keys, no bare-hostId collisions.** Prompts are keyed by `promptId`
  (unique) and grouped by owning-context id. A session-acquisition context and a
  TEST_CONNECT context for the same host are DISTINCT contexts → never collide.
- **P4 — Lifecycle follows the owner.** A context's prompts are cleared exactly when the
  owner ends (acquisition commit/fail/close, or test-context completion/abort) — by
  owner-id, unconditionally (not via a clobber-prone reconnect controller).

## Model

```
PromptContext {
  id: string                      // stable: acqId for a session acquisition, or a fresh id for a test/elevation context
  kind: "session" | "test" | "elevation"
  hostId: string
  routeClientId: string           // the live client prompts are sent to NOW (mutable via re-target)
  prompts: Map<promptId, PendingPrompt>   // all in-flight prompts for this context
}
PendingPrompt { promptId, contextId, type, resolve, timer, resendPayload }
ctx.promptContexts: Map<contextId, PromptContext>
ctx.promptIndex:   Map<promptId, contextId>     // response routing
```

- `pendingAuthPrompts`/`pendingHostVerify`/`pendingAgentVerify` collapse into this
  per-context model (or keep the maps but key by `promptId` + carry `contextId`).
- The wire AUTH_PROMPT / HOST_VERIFY / AGENT_VERIFY message carries a `promptId`; the
  response carries it back, so routing/authorization is by `promptId` → `contextId`.

## Operations (all synchronous critical sections — no await between read and mutate)

| Op | Effect |
|---|---|
| **openContext(kind, hostId, acqId?, routeClientId)** | create a PromptContext (id = acqId for session, fresh id otherwise); store keyed by id |
| **prompt(contextId, type, payload)** | create promptId; store in context.prompts + promptIndex; SEND the request to `context.routeClientId` (the CURRENT route); return a promise |
| **respond(promptId, clientId, value)** | look up context via promptIndex; ACCEPT only if `clientId === context.routeClientId` (current route) — reject stale/rogue senders; resolve + clear that prompt |
| **retarget(contextId, newRouteClientId)** | set `context.routeClientId = newRouteClientId` (one place) → all current AND future prompts of this context now route to/authorize the new client. Re-SEND any in-flight prompt requests to the new route. |
| **clearContext(contextId)** | clear every prompt in the context (timers + resolve(null)) + delete from promptContexts + promptIndex. Unconditional. |
| **clientDisconnect(clientId)** | for each context whose `routeClientId === clientId`: if the owner is still live (acquisition has other live leases / a follower client), `retarget` to a live lease-holder; else `clearContext` (fail cleanly). |

## Invariants (each maps to a gate-round edge)

1. **Cross-context isolation** (TEST_CONNECT edge): a `test` context for host H never touches a `session` context for H — distinct ids. A 2nd client's TEST_CONNECT cannot clobber another's session prompt.
2. **Whole-sequence route** (subsequent-prompts-bound-to-leader edge): `prompt()` always sends to `context.routeClientId`; after `retarget`, the 2nd/3rd prompt go to the new route, not the original leader.
3. **Response authorization** (rogue/stale-owner edge): `respond` accepts only from the CURRENT `routeClientId`; an old owner after re-target is rejected.
4. **Owner-id lifecycle** (survives-close / controller-clobber edge): `clearContext` runs on acquisition close/fail and on closeSession by owner-id — never dependent on a reconnect AbortController being the "current" one.
5. **Same-client sequential replace**: a same-context re-prompt replaces cleanly (resolve old null); a DIFFERENT context/client does not.
6. **No bare-hostId clobber**: nothing keys or cancels prompts by bare hostId across contexts.
7. **Disconnect → retarget-or-fail**: prompt-owner disconnect re-targets to a live lease-holder for the WHOLE remaining sequence, or fails the context cleanly (followers retry) — never leaves prompts bound to a dead client.

## Implementation notes

- Add `routeClientId` to `SessionAcquisition` (the session-context's route) so the
  acquisition IS the session prompt-context; reconnect (`scheduleReconnect`/`onReconnectAgent`)
  and the initial connect all `prompt()` against the acquisition's route.
- TEST_CONNECT (`handleTestConnect`) and any out-of-acquisition elevation prompt open a
  fresh `test`/`elevation` context (own id, own route = the requesting client) — isolated.
- `removeClient` calls `clientDisconnect`; `closeSession`/`shutdown` call `clearContext`
  for the host's contexts by owner-id.
- Keep already-working behavior: passphrase cache (15min), 120s prompt timeout, host-key
  TOFU/mismatch/trust-once, SEC-003 (response authorized to current route).
- Wire change: AUTH_PROMPT/HOST_VERIFY/AGENT_VERIFY + their responses must carry `promptId`
  (host-key/agent-verify already do; passphrase AUTH_PROMPT currently keys by hostId — add
  `promptId`). This is the one protocol touch; keep `hostId` for display.
- Tests: one per invariant 1–7, deterministic (drive openContext/prompt/retarget/respond/
  clearContext + spies; no real timing), plus all existing prompt/coalescing tests green.

## Adversarial review hardening (codex + copilot, 2026-06-07)

Both engines confirmed the owner/route split is the right core but required these
implementation-time guards (each closes a specific interleaving):

- **A — store-before-send, in one critical section.** `prompt(contextId)` must, synchronously:
  re-read the context, reject if absent/`CLOSED`/closing, validate `routeClientId` is still
  connected, insert into `context.prompts` + `promptIndex`, THEN send. On send failure →
  retarget-or-clear immediately. (Closes: prompt sent before indexed → orphaned by a
  concurrent clear/retarget; prompt sent to a route that just disconnected.)
- **B — terminal CLOSED flag.** `clearContext` sets `context.state = CLOSED` SYNCHRONOUSLY
  before deleting; `prompt`/`respond`/send check it; post-close responses are logged + ignored;
  `prompt()` on a CLOSED context is refused. (Closes: late send/response after clear.)
- **C — deterministic route chooser.** A single helper picks the retarget candidate
  deterministically — oldest connected, non-released live lease with an open socket (prefer the
  active-view client if tracked); on send failure try the next candidate, else `clearContext`.
  (Closes: nondeterministic Map/Set-order route selection; picking a closing follower.)
- **D — deliveryEpoch per prompt.** Each prompt carries a monotonic `deliveryEpoch`
  (incremented on every (re)send/retarget); the client echoes it back; `respond` accepts only
  `(promptId, current routeClientId, current epoch)`. The UI replaces any prior render for the
  same `promptId`. (Closes: an old route's in-flight response arriving after retarget; duplicate
  UI dialogs.)
- **E — elevation owner.** An elevation/test prompt context's owner is the spawn/restart
  operation (not an acquisition): explicit candidate clients + clear hooks on spawn abort,
  channel close, session close, and timeout. Elevation/passphrase caches are scoped so a
  test/elevation context cannot populate unrelated session cache state.
- **F — AbortController is advisory only.** `clearContext(ownerId)` is idempotent and called
  from owner TERMINAL paths (acquisition commit/fail/close, spawn/channel/session close,
  timeout); it NEVER depends on `reconnectAbortControllers.get(hostId) === current`. The
  reconnect controller only aborts transport.

## Scope note — THIS IS A MULTI-PACKAGE CHANGE

Not hub-only. Mandatory coordinated changes across three packages:

- **`@lasterm/shared`** (`protocol.ts`): add required `promptId` (+ `deliveryEpoch`) to
  `AUTH_PROMPT` and `AUTH_PROMPT_RESPONSE`; add a `PROMPT_CANCEL { promptId }` message so the
  client dismisses a stale dialog on `clearContext`/old-route retarget. (Host-key/agent-verify
  already carry a prompt id — align them.)
- **`@lasterm/hub`** (`session/*`): the PromptContext model, the operations, owner/route
  lifecycle, response routing by `promptId`, retarget, deterministic chooser, the guards A–F.
- **`@lasterm/web`** (Vue stores `auth-prompt.ts`, `session.ts`, host-key/agent-verify stores +
  their components): echo `promptId`+`deliveryEpoch` back on responses; QUEUE prompts by
  `promptId` (today the store holds a single prompt — two contexts routed to one client would
  overwrite locally); handle `PROMPT_CANCEL` to drop a stale dialog.

Server-side rejects auth responses lacking a valid `promptId`. The bare-`hostId` collision is
only fully removed once every response path carries `promptId` end-to-end.
