# Remote Agent Auto-Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable remote terminals by wiring the existing auto-deploy code, adding SHA256 integrity verification with per-host TOFU pinning, UX error modals, and aarch64 CI target.

**Architecture:** Mirrors the existing SSH host-key TOFU pattern (HOST_VERIFY / HOST_VERIFY_RESPONSE) for binary verification. SHA256 comparison between local cache and remote binary. Per-host pinning in meta.db. Two new Vue modals (deploy-failed + binary TOFU). Cross-compile aarch64 agent in CI.

**Tech Stack:** TypeScript (hub + shared + web), Vue 3 + Pinia (web), better-sqlite3 (migration), ssh2 SFTP (deploy), Rust cross-compile (CI), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-03-24-remote-agent-deploy-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/protocol.ts` | Modify | Add `AgentBinaryVerifyMessage`, `AgentBinaryVerifyResponseMessage` interfaces + error codes |
| `packages/shared/src/entities.ts` | Modify | Add `agentSha256` field to `Host` interface |
| `packages/hub/src/storage/migrations/meta/016-host-agent-sha256.sql` | Create | Add `agent_sha256` column to hosts table |
| `packages/hub/src/storage/hosts-dal.ts` | Modify | Add `updateHostAgentSha256()`, `getHostAgentSha256()` |
| `packages/hub/src/session/session-context.ts` | Modify | Add `trustedAgentSha256` + `pendingAgentVerify` Maps |
| `packages/hub/src/session/agent-deployer.ts` | Modify | Add `getRemoteSha256()`, `getLocalSha256()`, SHA256 verification in `deployAgentIfNeeded` |
| `packages/hub/src/session/ssh-agent.ts` | Modify | Extend `SshAgentDeployOptions`, error classification in `start()` catch |
| `packages/hub/src/session/ssh-connection-manager.ts` | Modify | Add `buildBinaryVerifyPrompt()` |
| `packages/hub/src/session/session-manager.ts` | Modify | Wire `deployOptions` in `handleSpawn()` |
| `packages/hub/src/ws/ws-handler.ts` | Modify | Register `AGENT_BINARY_VERIFY_RESPONSE` case |
| `packages/hub/src/ws/handlers/agent-binary-verify-response.ts` | Create | Handle AGENT_BINARY_VERIFY_RESPONSE WS message |
| `packages/clients/web/src/stores/agent-verify.ts` | Create | Pinia store for AGENT_BINARY_VERIFY state |
| `packages/clients/web/src/components/AgentBinaryVerify.vue` | Create | Binary TOFU modal |
| `packages/clients/web/src/components/AgentDeployFailed.vue` | Create | Deploy-failed error modal with Retry |
| `packages/clients/web/src/composables/useWebSocket.ts` | Modify | Route new WS messages to agent-verify store |
| `.github/build-matrix.json` | Modify | Add `aarch64-unknown-linux-gnu` target |
| `packages/hub/src/session/agent-deployer.spec.ts` | Modify | Tests for SHA256 verify + TOFU flow |

---

## Task 1: Protocol types + Host entity

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/entities.ts`

- [ ] **Step 1: Add AgentBinaryVerifyMessage interface to protocol.ts**

Add after `HostVerifyResponseMessage` (line ~409). Mirror the HOST_VERIFY pattern:

```typescript
/** Hub → Client: prompt user to verify an unknown remote agent binary. */
export interface AgentBinaryVerifyMessage {
	type: "AGENT_BINARY_VERIFY";
	promptId: string;
	hostId: string;
	hostname: string;
	remotePath: string;
	remoteSha256: string;
	os: HostOs;
	arch: HostArch;
	/** true if SHA256 changed vs previously pinned value */
	mismatch: boolean;
	/** Previous pinned SHA256 (only when mismatch=true) */
	pinnedSha256?: string;
}

/** Client → Hub: user's trust decision for an unknown remote agent binary. */
export interface AgentBinaryVerifyResponseMessage {
	type: "AGENT_BINARY_VERIFY_RESPONSE";
	promptId: string;
	action: "trust_permanent" | "trust_once" | "reject";
}
```

- [ ] **Step 2: Add message types to the HubToUiMessage and UiMessage unions**

Find the `HubToUiMessage` union type and add `| AgentBinaryVerifyMessage`.
Find the `UiMessage` union type (client-to-hub) and add `| AgentBinaryVerifyResponseMessage`.

- [ ] **Step 3: Add agentSha256 to Host entity**

In `packages/shared/src/entities.ts`, add to the `Host` interface:

```typescript
/** SHA256 of the pinned remote agent binary (null = not yet verified). */
agentSha256?: string | null;
```

- [ ] **Step 4: Build shared to verify types compile**

Run: `pnpm -F @lasterm/shared build`
Expected: Clean build, no type errors.

- [ ] **Step 5: Commit**

```
feat(shared): add AGENT_BINARY_VERIFY protocol messages + agentSha256 entity field
```

---

## Task 2: Migration + DAL

**Files:**
- Create: `packages/hub/src/storage/migrations/meta/016-host-agent-sha256.sql`
- Modify: `packages/hub/src/storage/hosts-dal.ts`

- [ ] **Step 1: Create migration 016**

```sql
ALTER TABLE hosts ADD COLUMN agent_sha256 TEXT DEFAULT NULL;
```

- [ ] **Step 2: Add DAL methods to hosts-dal.ts**

Follow the `updateHostOsArch` pattern (line ~268):

```typescript
updateHostAgentSha256(id: string, sha256: string | null): void {
	const now = new Date().toISOString();
	this.db
		.prepare("UPDATE hosts SET agent_sha256 = ?, updated_at = ? WHERE id = ?")
		.run(sha256, now, id);
}

getHostAgentSha256(id: string): string | null {
	const row = this.db
		.prepare("SELECT agent_sha256 FROM hosts WHERE id = ?")
		.get(id) as { agent_sha256: string | null } | undefined;
	return row?.agent_sha256 ?? null;
}
```

- [ ] **Step 3: Add agentSha256 to the SELECT in getHost / mapHostRow**

Find `mapHostRow` or the SELECT query that loads Host records. Add `agent_sha256` to the column list and map it to `agentSha256` in the resulting object.

- [ ] **Step 4: Write test for new DAL methods**

In `packages/hub/src/storage/hosts-dal.spec.ts`, add:

```typescript
describe("agent SHA256 pinning", () => {
	it("stores and retrieves agent SHA256", () => {
		const host = createTestHost(dal); // use existing helper
		dal.updateHostAgentSha256(host.id, "abc123def456");
		expect(dal.getHostAgentSha256(host.id)).toBe("abc123def456");
	});

	it("returns null when no SHA256 pinned", () => {
		const host = createTestHost(dal);
		expect(dal.getHostAgentSha256(host.id)).toBeNull();
	});

	it("clears SHA256 with null", () => {
		const host = createTestHost(dal);
		dal.updateHostAgentSha256(host.id, "abc123");
		dal.updateHostAgentSha256(host.id, null);
		expect(dal.getHostAgentSha256(host.id)).toBeNull();
	});
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm -F @lasterm/hub test -- --run src/storage/hosts-dal.spec.ts`
Expected: All pass including new tests.

- [ ] **Step 6: Commit**

```
feat(hub): migration 016 — agent_sha256 column + DAL methods
```

---

## Task 3: SHA256 verification functions

**Files:**
- Modify: `packages/hub/src/session/agent-deployer.ts`
- Modify: `packages/hub/src/session/agent-deployer.spec.ts`

- [ ] **Step 1: Write failing tests for getRemoteSha256**

```typescript
import { getRemoteSha256 } from "./agent-deployer.js";

describe("getRemoteSha256", () => {
	it("parses sha256sum output on Linux", async () => {
		const mockClient = createMockSshClient({
			"sha256sum /usr/local/bin/lasterm-agent": {
				stdout: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /usr/local/bin/lasterm-agent\n",
				exitCode: 0,
			},
		});
		const result = await getRemoteSha256(mockClient, "/usr/local/bin/lasterm-agent", "linux");
		expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("parses PowerShell Get-FileHash output on Windows", async () => {
		const mockClient = createMockSshClient({
			'powershell -c "(Get-FileHash \'C:\\lasterm\\lasterm-agent.exe\' -Algorithm SHA256).Hash.ToLower()"': {
				stdout: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n",
				exitCode: 0,
			},
		});
		const result = await getRemoteSha256(mockClient, "C:\\lasterm\\lasterm-agent.exe", "windows");
		expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("returns null when command fails", async () => {
		const mockClient = createMockSshClient({
			"sha256sum /missing": { stdout: "", exitCode: 1 },
		});
		const result = await getRemoteSha256(mockClient, "/missing", "linux");
		expect(result).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @lasterm/hub test -- --run src/session/agent-deployer.spec.ts`
Expected: FAIL — `getRemoteSha256` not exported.

- [ ] **Step 3: Implement getRemoteSha256**

```typescript
export async function getRemoteSha256(
	client: SshClient,
	remotePath: string,
	os: HostOs,
): Promise<string | null> {
	try {
		// Escape single quotes in path for PowerShell (replace ' with '')
		const escapedPath = os === "windows" ? remotePath.replace(/'/g, "''") : remotePath;
		const cmd =
			os === "windows"
				? `powershell -c "(Get-FileHash '${escapedPath}' -Algorithm SHA256).Hash.ToLower()"`
				: `sha256sum ${remotePath}`;
		const { stdout, exitCode } = await sshExec(client, cmd);
		if (exitCode !== 0) return null;
		const trimmed = stdout.trim();
		// sha256sum: "hash  filename" — take first 64 hex chars
		// PowerShell: just the hash on one line
		const match = trimmed.match(/^([a-f0-9]{64})/i);
		return match ? match[1].toLowerCase() : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Implement getLocalSha256**

```typescript
export function getLocalSha256(localPath: string): string | null {
	try {
		const data = readFileSync(localPath);
		return createHash("sha256").update(data).digest("hex");
	} catch {
		return null;
	}
}
```

Add a test:

```typescript
describe("getLocalSha256", () => {
	it("computes SHA256 of a file", () => {
		const tmpFile = join(tmpdir(), "lasterm-test-binary");
		writeFileSync(tmpFile, "test-binary-content");
		const hash = getLocalSha256(tmpFile);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		unlinkSync(tmpFile);
	});

	it("returns null for missing file", () => {
		expect(getLocalSha256("/nonexistent/path")).toBeNull();
	});
});
```

- [ ] **Step 5: Run all tests**

Run: `pnpm -F @lasterm/hub test -- --run src/session/agent-deployer.spec.ts`
Expected: All pass.

- [ ] **Step 6: Commit**

```
feat(hub): SHA256 verification functions — getRemoteSha256 + getLocalSha256
```

---

## Task 4: Update deployAgentIfNeeded with SHA256 verification

**Files:**
- Modify: `packages/hub/src/session/agent-deployer.ts`
- Modify: `packages/hub/src/session/agent-deployer.spec.ts`

- [ ] **Step 1: Define BinaryVerifyPromptFn type and update DeployResult**

In `agent-deployer.ts`:

```typescript
/** Callback to prompt user for binary trust decision (mirrors promptHostKeyVerify pattern). */
export type BinaryVerifyPromptFn = (
	hostId: string,
	hostname: string,
	remotePath: string,
	remoteSha256: string,
	os: HostOs,
	arch: HostArch,
	mismatch: boolean,
	pinnedSha256?: string,
) => Promise<"trust_permanent" | "trust_once" | "reject">;

export interface DeployResult {
	/** true if a binary was uploaded (false = agent was already present) */
	deployed: boolean;
	remotePath: string;
	os: HostOs | null;
	arch: HostArch | null;
	/** SHA256 to pin in host record (only when user chose trust_permanent) */
	pinSha256?: string;
	/** true if user chose trust_once (store in session map) */
	trustOnce?: boolean;
	/** SHA256 of the agent binary now on remote (for AGENT_UPDATED notification) */
	agentUpdated?: boolean;
}
```

- [ ] **Step 2: No separate DeployVerifyOptions needed**

`deployAgentIfNeeded` will accept `SshAgentDeployOptions` directly (defined in Task 5). This avoids a duplicate options type and the mapping code between them.

- [ ] **Step 3: Write failing tests for the updated flow**

Test the key paths:
1. Agent found + SHA256 match (local cache) → skip
2. Agent found + SHA256 mismatch (local cache) → re-upload
3. Agent found + no local binary + no pin → prompt TOFU
4. Agent found + no local binary + pin match → skip
5. Agent found + no local binary + pin mismatch → prompt (mismatch=true)
6. Agent found + no local binary + trust_permanent → pinSha256 in result
7. Agent found + no local binary + reject → throws AGENT_BINARY_REJECTED
8. Agent not found + local binary → upload
9. Agent not found + no local binary → throws AGENT_NOT_AVAILABLE
10. Agent found + remoteSha null + local binary → re-upload (precaution)
11. No prompt function + unverified → throws AGENT_BINARY_UNTRUSTED

Write each as a separate test case. Use the existing mock SSH client pattern from the file.

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm -F @lasterm/hub test -- --run src/session/agent-deployer.spec.ts`
Expected: Multiple failures — old signature doesn't match.

- [ ] **Step 5: Implement the updated deployAgentIfNeeded**

Refactor the function to accept `DeployVerifyOptions` and implement the full flow from the spec (section 5 pseudocode). Keep the existing function signature as a thin wrapper for backward compatibility in tests.

Key logic:
- If agent found: `getRemoteSha256` → compare with local SHA256 or pinned SHA256
- If local binary exists and mismatch: re-upload + set `agentUpdated: true`
- If no local binary: check pinned SHA256 → if no pin or mismatch → prompt user
- Session-trusted SHA256 (trust_once from earlier) bypasses prompt
- If no prompt function: throw `AGENT_BINARY_UNTRUSTED`
- If agent not found: existing flow (detect OS/arch, upload or throw)

- [ ] **Step 6: Run tests**

Run: `pnpm -F @lasterm/hub test -- --run src/session/agent-deployer.spec.ts`
Expected: All pass.

- [ ] **Step 7: Commit**

```
feat(hub): SHA256 verification + binary TOFU in deployAgentIfNeeded
```

---

## Task 5: SharedSessionContext + SshAgentDeployOptions + SshConnectionManager

**Files:**
- Modify: `packages/hub/src/session/session-context.ts`
- Modify: `packages/hub/src/session/ssh-agent.ts`
- Modify: `packages/hub/src/session/ssh-connection-manager.ts`

- [ ] **Step 1: Add Maps to SharedSessionContext**

In `session-context.ts`, add to the interface and constructor:

```typescript
/** Per-host SHA256 of agent binary trusted for this session only (trust_once). */
trustedAgentSha256: Map<string, string>;
/** Pending agent binary verification prompts, keyed by promptId. */
pendingAgentVerify: Map<string, { resolve: (action: "trust_permanent" | "trust_once" | "reject") => void; timer: ReturnType<typeof setTimeout> }>;
```

Initialize both as `new Map()` in the constructor.

- [ ] **Step 2: Extend SshAgentDeployOptions**

In `ssh-agent.ts`, update the interface:

```typescript
export interface SshAgentDeployOptions {
	/** Path to the local binary cache directory. */
	binaryCache: string;
	/** Hostname for display in prompts. */
	hostname?: string;
	/** Pinned SHA256 from host record (null = no pin). */
	pinnedSha256?: string | null;
	/** Session-trusted SHA256 (trust_once from earlier connect). */
	sessionTrustedSha256?: string | null;
	/** Called when OS/arch is detected on the remote host. */
	onOsDetected?: (hostId: string, os: HostOs, arch: HostArch) => void;
	/** Called to prompt user for binary trust decision. */
	promptBinaryVerify?: BinaryVerifyPromptFn;
	/** Called when user chose trust_permanent — persist SHA256 to DB. */
	onAgentPinned?: (hostId: string, sha256: string) => void;
	/** Called when user chose trust_once — store in session map. */
	onAgentTrustOnce?: (hostId: string, sha256: string) => void;
	/** Called when remote agent was re-uploaded (SHA256 mismatch). */
	onAgentUpdated?: (hostId: string) => void;
}
```

- [ ] **Step 3: Add buildBinaryVerifyPrompt to SshConnectionManager**

Mirror `promptHostKeyVerify` pattern (line 67-99 of ssh-connection-manager.ts):

```typescript
buildBinaryVerifyPrompt(client: WsClient): BinaryVerifyPromptFn {
	return async (
		hostId: string,
		hostname: string,
		remotePath: string,
		remoteSha256: string,
		os: HostOs,
		arch: HostArch,
		mismatch: boolean,
		pinnedSha256?: string,
	): Promise<"trust_permanent" | "trust_once" | "reject"> => {
		const promptId = generateId();
		const msg: AgentBinaryVerifyMessage = {
			type: "AGENT_BINARY_VERIFY",
			promptId,
			hostId,
			hostname,
			remotePath,
			remoteSha256,
			os,
			arch,
			mismatch,
			...(pinnedSha256 ? { pinnedSha256 } : {}),
		};
		client.send(msg);

		return new Promise<"trust_permanent" | "trust_once" | "reject">((resolve) => {
			const timer = setTimeout(() => {
				this.ctx.pendingAgentVerify.delete(promptId);
				this.ctx.hubLogger?.log("warn", "ssh-connection: AGENT_BINARY_VERIFY timeout, rejecting", {
					hostname,
				});
				resolve("reject");
			}, 30_000);

			this.ctx.pendingAgentVerify.set(promptId, { resolve, timer });
		});
	};
}
```

- [ ] **Step 4: Add handleAgentVerifyResponse to SshConnectionManager**

```typescript
handleAgentVerifyResponse(promptId: string, action: "trust_permanent" | "trust_once" | "reject"): void {
	const pending = this.ctx.pendingAgentVerify.get(promptId);
	if (!pending) return;
	clearTimeout(pending.timer);
	this.ctx.pendingAgentVerify.delete(promptId);
	pending.resolve(action);
}
```

- [ ] **Step 5: Build hub to verify types compile**

Run: `pnpm -F @lasterm/hub build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```
feat(hub): binary TOFU infrastructure — context, deploy options, prompt builder
```

---

## Task 6: SshAgent.start() error classification

**Files:**
- Modify: `packages/hub/src/session/ssh-agent.ts`

- [ ] **Step 1: Write failing test for error propagation**

In `ssh-agent.spec.ts`, add test that user-rejection errors propagate (not swallowed by catch):

```typescript
it("propagates AGENT_BINARY_REJECTED without fallback", async () => {
	// Setup: deploy rejects with AGENT_BINARY_REJECTED
	// Expect: start() rejects with the same error, does NOT fall back to lasterm-agent --stdio
});
```

- [ ] **Step 2: Classify errors in the deploy catch block**

First, add a `DeployError` class in `agent-deployer.ts` (more robust than string matching):

```typescript
export class DeployError extends Error {
	constructor(
		public readonly code: "AGENT_BINARY_REJECTED" | "AGENT_BINARY_UNTRUSTED" | "AGENT_NOT_AVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "DeployError";
	}
}
```

Use `throw new DeployError("AGENT_NOT_AVAILABLE", "...")` instead of `throw new Error("AGENT_NOT_AVAILABLE")` in `deployAgentIfNeeded`.

Then in `SshAgent.start()`, replace the generic catch (line ~338-342):

```typescript
.catch((deployErr: unknown) => {
	// User-initiated rejections must propagate — no fallback
	if (deployErr instanceof DeployError) {
		rejectOnce(deployErr);
		return;
	}
	// Infrastructure failures: fall back to lasterm-agent --stdio
	const msg = deployErr instanceof Error ? deployErr.message : String(deployErr);
	process.stderr.write(
		`[ssh-agent] auto-deploy failed for host ${this.host.id}: ${msg}. Trying lasterm-agent --stdio anyway.\n`,
	);
	runAgent("lasterm-agent --stdio");
});
```

- [ ] **Step 3: Pass deploy options through to deployAgentIfNeeded**

Update the `deployAgentIfNeeded` call in `start()` to pass the new options:

```typescript
deployAgentIfNeeded(client, this.host, this.deployOptions.binaryCache)
```

becomes:

```typescript
deployAgentIfNeeded(client, this.host, this.deployOptions)
```

`deployAgentIfNeeded` now accepts `SshAgentDeployOptions` directly (no separate type).

- [ ] **Step 4: Run tests**

Run: `pnpm -F @lasterm/hub test -- --run src/session/ssh-agent.spec.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```
feat(hub): error classification in SshAgent.start() — propagate user rejections
```

---

## Task 7: Wire deployOptions in SessionManager.handleSpawn()

**Files:**
- Modify: `packages/hub/src/session/session-manager.ts`

- [ ] **Step 1: Import dependencies**

```typescript
import { getBinaryCacheDir } from "./agent-deployer.js";
import type { BinaryVerifyPromptFn } from "./agent-deployer.js";
```

- [ ] **Step 2: Build deployOptions before SshAgent creation**

In `handleSpawn`, find the SSH branch (line ~288-290 where `new SshAgent(host, promptAuth)` is called). Replace with:

```typescript
const binaryCache = getBinaryCacheDir();
const pinnedSha256 = this.ctx.metaDal.getHostAgentSha256(hostId);
const sshHostname = host.sshHost?.includes("@")
	? (host.sshHost.split("@")[1] ?? host.sshHost)
	: (host.sshHost ?? host.label);
const sessionTrustedAgentSha = this.ctx.trustedAgentSha256.get(hostId);

const deployOpts: SshAgentDeployOptions = {
	binaryCache,
	hostname: sshHostname,
	pinnedSha256,
	sessionTrustedSha256: sessionTrustedAgentSha ?? null,
	onOsDetected: (hid, os, arch) => {
		this.ctx.metaDal.updateHostOsArch(hid, os, arch);
	},
	promptBinaryVerify: this.sshMgr.buildBinaryVerifyPrompt(client),
};

const sshAgent = new SshAgent(host, promptAuth, deployOpts);
```

- [ ] **Step 3: Handle deploy result (pin SHA256 / trust_once)**

After `sshAgent.start()` succeeds, check if the deploy result contains pinning info. This requires `start()` to return the deploy result. Extend the return type or use an event.

Simpler approach: use callbacks in `SshAgentDeployOptions`:

```typescript
onAgentPinned: (hostId: string, sha256: string) => {
	this.ctx.metaDal.updateHostAgentSha256(hostId, sha256);
},
onAgentTrustOnce: (hostId: string, sha256: string) => {
	this.ctx.trustedAgentSha256.set(hostId, sha256);
},
```

Add these callbacks to the interface and call them from `deployAgentIfNeeded` when appropriate.

- [ ] **Step 4: Apply same changes to the TOFU-retry SshAgent (line ~328)**

The retry `new SshAgent(host, promptAuth)` must also receive `deployOpts`.

- [ ] **Step 5: Handle AGENT_NOT_AVAILABLE in the catch block**

In the catch around `sshAgent.start()`, detect `AGENT_NOT_AVAILABLE` and send the specific error to the client:

```typescript
} catch (err) {
	const kv = sshAgent.lastKeyVerification;
	const errMsg = err instanceof Error ? err.message : String(err);

	if (err instanceof DeployError) {
		client.send({
			type: "ERROR",
			code: err.code,
			message: err.code === "AGENT_NOT_AVAILABLE"
				? `Remote agent not available on ${host.sshHost ?? host.label}`
				: err.message,
		} satisfies ErrorMessage);
		this.broadcaster.updateSessionStatus(hostId, session.id, "closed");
		return null;
	}

	// ... existing TOFU/mismatch handling ...
}
```

- [ ] **Step 6: Send AGENT_UPDATED notification on re-upload**

Add an `onAgentUpdated` callback in `SshAgentDeployOptions`:

```typescript
onAgentUpdated: (hostId: string) => {
	this.broadcaster.broadcastToAll({
		type: "ERROR",  // reuse ERROR type with info-level code
		code: "AGENT_UPDATED",
		message: `Remote agent on ${host.sshHost ?? host.label} was updated`,
	} satisfies ErrorMessage);
},
```

- [ ] **Step 7: Build hub to verify**

Run: `pnpm -F @lasterm/hub build`
Expected: Clean build.

- [ ] **Step 8: Commit**

```
feat(hub): wire deployOptions in handleSpawn — auto-deploy is now active for SSH hosts
```

---

## Task 8: WS handler for AGENT_BINARY_VERIFY_RESPONSE

**Files:**
- Create: `packages/hub/src/ws/handlers/agent-binary-verify-response.ts`
- Modify: `packages/hub/src/ws/ws-handler.ts`

- [ ] **Step 1: Create handler file**

Mirror `host-verify-response.ts`:

```typescript
import type { AgentBinaryVerifyResponseMessage } from "@lasterm/shared";
import type { WsHandlerContext } from "../ws-handler.js";

export function handleAgentBinaryVerifyResponse(
	msg: AgentBinaryVerifyResponseMessage,
	ctx: WsHandlerContext,
): void {
	ctx.sessionManager.sshMgr.handleAgentVerifyResponse(msg.promptId, msg.action);
}
```

- [ ] **Step 2: Register in ws-handler.ts switch**

Find the `HOST_VERIFY_RESPONSE` case (line ~208). Add after it:

```typescript
case "AGENT_BINARY_VERIFY_RESPONSE":
	handleAgentBinaryVerifyResponse(msg as AgentBinaryVerifyResponseMessage, ctx);
	break;
```

Import the handler and type at the top of the file.

- [ ] **Step 3: Export from barrel**

Add to `packages/hub/src/ws/handlers/index.ts`:
```typescript
export { handleAgentBinaryVerifyResponse } from "./agent-binary-verify-response.js";
```

- [ ] **Step 4: Build and verify**

Run: `pnpm -F @lasterm/hub build`
Expected: Clean build.

- [ ] **Step 5: Commit**

```
feat(hub): WS handler for AGENT_BINARY_VERIFY_RESPONSE
```

---

## Task 9: Web — Pinia store + WS routing

**Files:**
- Create: `packages/clients/web/src/stores/agent-verify.ts`
- Modify: `packages/clients/web/src/composables/useWebSocket.ts`

- [ ] **Step 1: Create agent-verify store**

Mirror `stores/host-verify.ts`:

```typescript
import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentBinaryVerifyMessage } from "@lasterm/shared";
import type { IWsClient } from "../composables/useWebSocket";

export interface AgentVerifyRequest extends AgentBinaryVerifyMessage {
	// extends protocol message — no extra fields needed
}

export const useAgentVerifyStore = defineStore("agentVerify", () => {
	const pendingPrompt = ref<AgentVerifyRequest | null>(null);
	let _wsClient: IWsClient | null = null;

	function setWsClient(client: IWsClient): void {
		_wsClient = client;
	}

	function handleAgentVerify(msg: AgentBinaryVerifyMessage): void {
		pendingPrompt.value = { ...msg };
	}

	function respond(action: "trust_permanent" | "trust_once" | "reject"): void {
		const req = pendingPrompt.value;
		if (!req) return;
		_wsClient?.send({
			type: "AGENT_BINARY_VERIFY_RESPONSE",
			promptId: req.promptId,
			action,
		});
		pendingPrompt.value = null;
	}

	function trustPermanently(): void { respond("trust_permanent"); }
	function trustOnce(): void { respond("trust_once"); }
	function reject(): void { respond("reject"); }
	function dismiss(): void { pendingPrompt.value = null; }

	return {
		pendingPrompt,
		setWsClient,
		handleAgentVerify,
		respond,
		trustPermanently,
		trustOnce,
		reject,
		dismiss,
	};
});
```

- [ ] **Step 2: Create deploy-failed store (or extend notification store)**

For the AGENT_NOT_AVAILABLE error, create a simple reactive state:

```typescript
// In agent-verify.ts, add:
const deployError = ref<{ hostname: string; message: string } | null>(null);

function handleDeployError(hostname: string, message: string): void {
	deployError.value = { hostname, message };
}

function clearDeployError(): void {
	deployError.value = null;
}

// Export deployError, handleDeployError, clearDeployError
```

- [ ] **Step 3: Route WS messages in useWebSocket**

Find where `HOST_VERIFY` is routed (search for `HOST_VERIFY` in `useWebSocket.ts`). Add after it:

```typescript
case "AGENT_BINARY_VERIFY": {
	const agentVerifyStore = useAgentVerifyStore();
	agentVerifyStore.handleAgentVerify(msg as AgentBinaryVerifyMessage);
	break;
}
```

For `AGENT_NOT_AVAILABLE` error code, route to the deploy-failed state. The hostname is embedded in `errMsg.message` (format: "Remote agent not available on {hostname}"):

```typescript
// In the ERROR case handler, add specific code checks:
case "ERROR": {
	const errMsg = msg as ErrorMessage;
	if (errMsg.code === "AGENT_NOT_AVAILABLE") {
		const agentVerifyStore = useAgentVerifyStore();
		agentVerifyStore.handleDeployError(errMsg.message);
		break;
	}
	if (errMsg.code === "AGENT_UPDATED") {
		// Show info notification
		notifications.info(errMsg.message);
		break;
	}
	// ... existing error handling ...
}
```

- [ ] **Step 4: Pass WS client to agent-verify store**

Find where `hostVerifyStore.setWsClient(ws)` is called. Add:

```typescript
const agentVerifyStore = useAgentVerifyStore();
agentVerifyStore.setWsClient(ws);
```

- [ ] **Step 5: Verify types compile**

Run: `pnpm -F @lasterm/web build`
Expected: Clean build (modals not yet created, but stores compile).

- [ ] **Step 6: Commit**

```
feat(web): agent verify store + WS message routing
```

---

## Task 10: Web — AgentBinaryVerify.vue modal

**Files:**
- Create: `packages/clients/web/src/components/AgentBinaryVerify.vue`

- [ ] **Step 1: Create the modal component**

Mirror `HostKeyWarning.vue` structure (Teleport, backdrop, card, actions). Two modes based on `mismatch` prop:

**First use (mismatch=false):**
- Shield icon, title: "Verify Remote Agent"
- Body text explaining unknown binary
- SHA256 fingerprint in monospace (copyable)
- OS/Arch badge
- 3 buttons: Reject / Trust Once / Trust Permanently

**SHA256 changed (mismatch=true):**
- Warning icon (orange), title: "Remote Agent Changed"
- Body warning the binary has changed
- Old SHA256 vs New SHA256 (stacked, monospace, copyable)
- Same 3 buttons

Use the same z-index (10200), backdrop, animation, and styling patterns as HostKeyWarning.vue.

Add a 30-second countdown timer:
```typescript
const remaining = ref(30);
let interval: ReturnType<typeof setInterval> | null = null;

watch(() => store.pendingPrompt, (prompt) => {
	if (prompt) {
		remaining.value = 30;
		interval = setInterval(() => {
			remaining.value--;
			if (remaining.value <= 0) {
				clearInterval(interval!);
				store.reject();
			}
		}, 1000);
	} else if (interval) {
		clearInterval(interval);
	}
});
```

Display `remaining` seconds near the action buttons (e.g., "Auto-reject in {remaining}s").

- [ ] **Step 2: Mount in App.vue (or main layout)**

Find where `<HostKeyWarning />` is mounted. Add `<AgentBinaryVerify />` next to it:

```vue
<HostKeyWarning />
<AgentBinaryVerify />
```

- [ ] **Step 3: Verify renders**

Run: `pnpm -F @lasterm/web dev`
Manually verify: store has no pending prompt → modal not visible. Good.

- [ ] **Step 4: Commit**

```
feat(web): AgentBinaryVerify.vue — binary TOFU modal
```

---

## Task 11: Web — AgentDeployFailed.vue modal

**Files:**
- Create: `packages/clients/web/src/components/AgentDeployFailed.vue`

- [ ] **Step 1: Create the modal component**

Simpler than TOFU modal. Single mode:
- Warning icon, title: "Remote Agent Not Available"
- Body: "The lasterm agent was not found on **{hostname}** and could not be deployed automatically."
- Help text with instructions (install manually or place in cache)
- 2 buttons: Close / Retry

**Retry** triggers a new SPAWN message for the same host (re-invoke the connect flow). Use the session store or emit an event.

- [ ] **Step 2: Mount in App.vue**

Add `<AgentDeployFailed />` next to the other modals.

- [ ] **Step 3: Commit**

```
feat(web): AgentDeployFailed.vue — deploy error modal with retry
```

---

## Task 12: CI — aarch64-unknown-linux-gnu target

**Files:**
- Modify: `.github/build-matrix.json`
- Modify: `.github/workflows/build.yml` (if needed for cross-compile setup)

- [ ] **Step 1: Add target to build-matrix.json**

```json
{
	"triple": "aarch64-unknown-linux-gnu",
	"runner": "ubuntu-latest",
	"os": "linux",
	"arch": "arm64",
	"shell_sh": true,
	"agent": true,
	"hub": false,
	"desktop": false,
	"enabled": true
}
```

- [ ] **Step 2: Ensure CI workflow installs cross-compile toolchain**

In `build.yml` (or `rust-agent.yml`), add conditional step for aarch64:

```yaml
- name: Install aarch64 cross-compile tools
  if: matrix.triple == 'aarch64-unknown-linux-gnu'
  run: |
    sudo apt-get update
    sudo apt-get install -y gcc-aarch64-linux-gnu
    rustup target add aarch64-unknown-linux-gnu

- name: Build agent
  env:
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: aarch64-linux-gnu-gcc
  run: scripts/build-agent.sh
```

- [ ] **Step 3: Verify build script handles --target**

Check `scripts/build-agent.sh` passes the target triple from the matrix. It should already do this.

- [ ] **Step 4: Commit**

```
ci: add aarch64-unknown-linux-gnu target for Raspberry Pi agent builds
```

---

## Task 13: Integration test — full deploy flow

**Files:**
- Modify: `packages/hub/src/session/agent-deployer.spec.ts`

- [ ] **Step 1: Write integration test for the full deploy→verify→pin flow**

```typescript
describe("deploy + verify integration", () => {
	it("deploys from cache, pins SHA256, skips on next connect", async () => {
		// 1. Create mock SSH client that reports no agent
		// 2. Place a fake binary in the local cache
		// 3. Call deployAgentIfNeeded — should upload
		// 4. Verify deployed: true, remotePath set
		// 5. Mock SSH client now reports agent at remotePath
		// 6. Call deployAgentIfNeeded again with same local binary
		// 7. SHA256 should match → deployed: false, no upload
	});

	it("prompts user when no local binary and no pin", async () => {
		// 1. Mock SSH client reports agent exists at /usr/local/bin/lasterm-agent
		// 2. No local binary in cache, no pinned SHA256
		// 3. Provide promptBinaryVerify that returns "trust_permanent"
		// 4. Verify pinSha256 is set in result
	});

	it("re-uploads on SHA256 mismatch with local cache", async () => {
		// 1. Place binary A in local cache
		// 2. Mock SSH client reports agent with SHA256 of binary B (different)
		// 3. Call deployAgentIfNeeded
		// 4. Verify upload was called (deployed: true) + agentUpdated: true
	});
});
```

- [ ] **Step 2: Run all tests**

Run: `pnpm -F @lasterm/hub test -- --run src/session/agent-deployer.spec.ts`
Expected: All pass.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All existing + new tests pass.

- [ ] **Step 4: Commit**

```
test(hub): integration tests for deploy + SHA256 verify + TOFU flow
```

---

## Summary

| Task | Scope | Package | Depends on |
|------|-------|---------|------------|
| 1. Protocol types + entity | Types | shared | — |
| 2. Migration + DAL | DB | hub | 1 |
| 3. SHA256 functions | Logic | hub | — |
| 4. deployAgentIfNeeded update | Logic | hub | 1, 3 |
| 5. Context + Options + SshConnectionManager | Infra | hub | 1, 4 |
| 6. SshAgent.start() error classification | Logic | hub | 4, 5 |
| 7. Wire handleSpawn() | Integration | hub | 2, 5, 6 |
| 8. WS handler | WS | hub | 1, 5 |
| 9. Pinia store + WS routing | State | web | 1 |
| 10. AgentBinaryVerify.vue | UI | web | 9 |
| 11. AgentDeployFailed.vue | UI | web | 9 |
| 12. CI aarch64 target | CI | ci | — |
| 13. Integration tests | Test | hub | 4, 7 |

**Parallelizable:** Tasks 1+3+12 can run in parallel. Tasks 9-11 (web) can run in parallel with tasks 5-8 (hub) once task 1 is done.
