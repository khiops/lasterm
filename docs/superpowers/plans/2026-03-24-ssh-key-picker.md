# SSH Key Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SSH key path text input with a Browse button + modal picker that lists keys in `~/.ssh/` with metadata, supports subdirectory navigation, drag & drop upload, and deletion.

**Architecture:** New hub API (`ssh-keys.ts`) scans `~/.ssh/` for private keys via `ssh2.utils.parseKey()`. New Vue components (SshKeyPicker, SshKeyCard) follow the FontPicker pattern. Shared `sanitizeFilename` extracted to DRY utility. `useFontDrop` renamed to generic `useFileDrop`. Theme system extended with 4 semantic badge color variables.

**Tech Stack:** Fastify multipart (already registered), ssh2 (already a dep), Vue 3 Composition API, Teleport modal pattern.

**Spec:** `docs/superpowers/specs/2026-03-24-ssh-key-picker-design.md`

**Review fixes applied (spec review):**
- DELETE uses query params (not path param) to avoid URL encoding issues
- Symlinks skipped via `lstatSync`, file size guard 1 MB on listing
- `fs.chmod(0o600)` for permissions (Windows icacls deferred — fs.chmod sufficient on NTFS for MVP)
- API `path` field always relative to `~/.ssh/`
- `sanitizeFilename` extracted to shared `upload-utils.ts`
- Modal 560px max-width for metadata density

**Plan review fixes applied:**
- Task 2: CSS path corrected to `styles/base.css` (not `assets/`). Theme badge vars go in `LastermThemeUi` (`theme.ui.badgeInfo`, not `theme.badgeInfo`). Type defined in `packages/shared/src/theme.ts`. ThemeEditor UI_FIELDS updated. Bundled themes rely on fallback defaults for MVP.
- Task 4: `registerSshKeyRoutes(server, sshDir?)` accepts optional `sshDir` param for test DI (defaults to `homedir()/.ssh`). Must be registered inside `dbManager` block (after multipart). `ssh2.utils.parseKey` API: `parsed.type` for algorithm, fingerprint computed via `crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64')` prefixed `SHA256:`. Bits derived from algorithm type. Windows `execFileNoThrow` deferred — `fs.chmod(0o600)` for MVP.
- Task 5-6: SshKeyPicker.vue and SshKeyCard.vue placed in root `components/` (used by HostModal, not settings panel).

---

### Task 1: Extract sanitizeFilename to shared utility

**Files:**
- Create: `packages/hub/src/api/upload-utils.ts`
- Modify: `packages/hub/src/api/fonts.ts` (remove local `sanitizeFilename`, import from utils)
- Modify: `packages/hub/src/api/wallpapers.ts` (remove local `sanitizeFilename`, import from utils)
- Test: `packages/hub/src/api/upload-utils.spec.ts`

- [ ] **Step 1: Create upload-utils.ts with sanitizeFilename**

```typescript
import { basename } from "node:path";

/**
 * Strip directory components and reject names with traversal sequences.
 * Returns null for any invalid filename.
 */
export function sanitizeFilename(raw: string): string | null {
	const name = basename(raw);
	if (name !== raw || name.includes("..") || name.includes("/") || name.includes("\\")) {
		return null;
	}
	if (!name || name === "." || name === "..") {
		return null;
	}
	return name;
}
```

- [ ] **Step 2: Write tests for sanitizeFilename**

```typescript
import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "./upload-utils.js";

describe("sanitizeFilename", () => {
	it("returns valid filename as-is", () => {
		expect(sanitizeFilename("id_ed25519")).toBe("id_ed25519");
	});
	it("rejects path traversal", () => {
		expect(sanitizeFilename("../etc/passwd")).toBeNull();
		expect(sanitizeFilename("foo/bar")).toBeNull();
		expect(sanitizeFilename("foo\\bar")).toBeNull();
	});
	it("rejects dot names", () => {
		expect(sanitizeFilename(".")).toBeNull();
		expect(sanitizeFilename("..")).toBeNull();
	});
	it("rejects empty string", () => {
		expect(sanitizeFilename("")).toBeNull();
	});
	it("handles filenames with dots", () => {
		expect(sanitizeFilename("key.pem")).toBe("key.pem");
	});
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project hub -- upload-utils`

- [ ] **Step 4: Update fonts.ts — remove local sanitizeFilename, import from utils**

Replace the local function definition (lines 28-37) with:
```typescript
import { sanitizeFilename } from "./upload-utils.js";
```

- [ ] **Step 5: Update wallpapers.ts — same migration**

Replace the local function definition (lines 21-30) with:
```typescript
import { sanitizeFilename } from "./upload-utils.js";
```

- [ ] **Step 6: Run full hub tests to verify no regression**

Run: `pnpm vitest run --project hub`

- [ ] **Step 7: Commit**

`refactor(hub): extract sanitizeFilename to shared upload-utils`

---

### Task 2: Theme system — semantic badge colors

**Files:**
- Modify: `packages/clients/web/src/assets/base.css` (add 4 CSS vars)
- Modify: `packages/clients/web/src/stores/theme.ts` (add badge vars to applyTheme)
- Modify: `packages/shared/src/entities.ts` (add badge fields to ThemeDefinition if typed)

- [ ] **Step 1: Add CSS vars to base.css**

Find the `:root` or `html` CSS variable block in `base.css`. Add the 4 badge vars in the UI chrome section:

```css
--nt-badge-info: #89b4fa;
--nt-badge-warning: #f9e2af;
--nt-badge-success: #a6e3a1;
--nt-badge-danger: #f38ba8;
```

- [ ] **Step 2: Add badge vars to applyTheme in theme.ts**

In the `applyTheme` function (around line 84-161), add `setProperty` calls for the badge vars. Use the theme definition values if present, with catppuccin-mocha defaults as fallback:

```typescript
root.setProperty("--nt-badge-info", theme.badgeInfo ?? "#89b4fa");
root.setProperty("--nt-badge-warning", theme.badgeWarning ?? "#f9e2af");
root.setProperty("--nt-badge-success", theme.badgeSuccess ?? "#a6e3a1");
root.setProperty("--nt-badge-danger", theme.badgeDanger ?? "#f38ba8");
```

- [ ] **Step 3: Add optional badge fields to theme type if needed**

Check if `ThemeDefinition` (in entities.ts or theme store) is typed. If so, add optional fields: `badgeInfo?: string`, `badgeWarning?: string`, `badgeSuccess?: string`, `badgeDanger?: string`.

- [ ] **Step 4: Run lint**

Run: `pnpm exec biome check --write .`

- [ ] **Step 5: Commit**

`feat(web): add semantic badge color CSS vars to theme system`

---

### Task 3: Rename useFontDrop → useFileDrop (parameterized)

**Files:**
- Rename: `packages/clients/web/src/composables/useFontDrop.ts` → `useFileDrop.ts`
- Rename: `packages/clients/web/src/composables/useFontDrop.spec.ts` → `useFileDrop.spec.ts`
- Modify: `packages/clients/web/src/components/settings/FontPicker.vue` (update import)

- [ ] **Step 1: Rename files**

```bash
git mv packages/clients/web/src/composables/useFontDrop.ts packages/clients/web/src/composables/useFileDrop.ts
git mv packages/clients/web/src/composables/useFontDrop.spec.ts packages/clients/web/src/composables/useFileDrop.spec.ts
```

- [ ] **Step 2: Update useFileDrop.ts — parameterize extensions**

Change the function to accept optional extensions parameter. Remove the hardcoded `ACCEPTED_EXTENSIONS` constant:

```typescript
import { ref, type Ref } from "vue";

export function useFileDrop(
	onFiles: (files: File[]) => void,
	acceptedExtensions?: Set<string>,
): {
	isDragging: Ref<boolean>;
	onDragEnter: (e: DragEvent) => void;
	onDragOver: (e: DragEvent) => void;
	onDragLeave: (e: DragEvent) => void;
	onDrop: (e: DragEvent) => void;
} {
	const isDragging = ref(false);
	let enterCount = 0;

	function onDragEnter(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer?.types.includes("Files")) {
			enterCount++;
			isDragging.value = true;
		}
	}

	function onDragOver(e: DragEvent): void {
		e.preventDefault();
	}

	function onDragLeave(_e: DragEvent): void {
		enterCount = Math.max(0, enterCount - 1);
		if (enterCount === 0) {
			isDragging.value = false;
		}
	}

	function onDrop(e: DragEvent): void {
		e.preventDefault();
		enterCount = 0;
		isDragging.value = false;

		const files = Array.from(e.dataTransfer?.files ?? []);
		const accepted = acceptedExtensions
			? files.filter((f) => {
					const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
					return acceptedExtensions.has(ext);
				})
			: files;

		if (accepted.length > 0) {
			onFiles(accepted);
		}
	}

	return { isDragging, onDragEnter, onDragOver, onDragLeave, onDrop };
}
```

- [ ] **Step 3: Update spec file — rename references**

In `useFileDrop.spec.ts`, update import and function name references from `useFontDrop` to `useFileDrop`. Add a test for "accept all" mode (no extensions param).

- [ ] **Step 4: Update FontPicker.vue import**

Change:
```typescript
import { useFontDrop } from "../../composables/useFontDrop.js";
```
To:
```typescript
import { useFileDrop } from "../../composables/useFileDrop.js";
```

And the call site:
```typescript
const { isDragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop(
	uploadFiles,
	new Set([".ttf", ".otf", ".woff", ".woff2"]),
);
```

- [ ] **Step 5: Run tests + lint**

Run: `pnpm vitest run --project web` then `pnpm exec biome check --write .`

- [ ] **Step 6: Commit**

`refactor(web): rename useFontDrop → useFileDrop with configurable extensions`

---

### Task 4: Hub — SSH keys API (GET + POST + DELETE)

**Files:**
- Create: `packages/hub/src/api/ssh-keys.ts`
- Create: `packages/hub/src/api/ssh-keys.spec.ts`
- Modify: `packages/hub/src/server.ts` (register routes)
- Modify: `packages/shared/src/entities.ts` (add SshKeyEntry type)

**Context:** Unlike fonts/wallpapers which use `configDir` (`~/.config/lasterm/`), SSH keys use `homedir()/.ssh`. The route function signature is `registerSshKeyRoutes(server: FastifyInstance)` — no configDir param needed, resolves `~/.ssh` internally.

- [ ] **Step 1: Add SshKeyEntry type to entities.ts**

After the FontFamily interface (~line 230):

```typescript
export interface SshKeyEntry {
	name: string;
	type: "directory" | "key";
	items?: number;
	algorithm?: string;
	bits?: number;
	fingerprint?: string;
	encrypted?: boolean;
	mtime?: string;
}
```

- [ ] **Step 2: Write tests for GET /api/ssh-keys**

Create `ssh-keys.spec.ts` with Fastify inject tests. Use a temp dir as mock `~/.ssh`. Tests:
- Returns empty when dir has no keys
- Lists valid private key with metadata (algorithm, bits, fingerprint)
- Lists subdirectories with item count
- Skips non-key files (known_hosts, config, .pub)
- Skips symlinks
- Skips files > 1 MB
- Rejects traversal (`?dir=../../etc`)
- Supports subdirectory navigation (`?dir=deploy-keys`)
- Auth required (401 without token)

Important: need to generate a minimal valid SSH key for tests. Use `ssh2.utils.generateKeyPairSync("ed25519")` or write a minimal PEM-formatted key buffer.

- [ ] **Step 3: Implement GET /api/ssh-keys**

In `ssh-keys.ts`:

```typescript
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SshKeyEntry } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import ssh2 from "ssh2";
import { sanitizeFilename } from "./upload-utils.js";

const MAX_KEY_FILE_SIZE = 1 * 1024 * 1024; // 1 MB — no key exceeds this
const MAX_UPLOAD_SIZE = 100 * 1024; // 100 KB

function getSshDir(): string {
	return join(homedir(), ".ssh");
}

export function registerSshKeyRoutes(server: FastifyInstance): void {
	server.get<{ Querystring: { dir?: string } }>(
		"/api/ssh-keys",
		async (request, reply) => { /* scan dir, parseKey each file, return entries */ },
	);

	server.post("/api/ssh-keys", async (request, reply) => {
		/* multipart upload, validate key, chmod 600 */
	});

	server.delete<{ Querystring: { name: string; dir?: string } }>(
		"/api/ssh-keys",
		async (request, reply) => { /* sanitize, containment, unlink */ },
	);
}
```

Implementation details:
- GET: `lstatSync` each entry, skip symlinks, skip files > 1 MB, `readFileSync` + `ssh2.utils.parseKey()` in try-catch, extract algorithm/bits/fingerprint from parsed key
- POST: `request.file()` + `sanitizeFilename` + containment + `parseKey` validation + `writeFile` + `chmod(0o600)`
- DELETE: `sanitizeFilename(name)` + containment + `unlink`
- mkdir: create `~/.ssh` with mode `0o700` if not exists on GET

- [ ] **Step 4: Write tests for POST and DELETE**

- POST: upload valid key → 200 with metadata, upload non-key → 400, upload too large → 400, duplicate → 409
- DELETE: delete existing key → 204, delete nonexistent → 404, traversal attempt → 400

- [ ] **Step 5: Register route in server.ts**

After `registerWallpaperRoutes(server, configDir)` (line ~307), add:

```typescript
import { registerSshKeyRoutes } from "./api/ssh-keys.js";
// ...
registerSshKeyRoutes(server);
```

No `configDir` param — SSH keys are in `homedir()/.ssh`, not configDir.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run --project hub -- ssh-keys`

- [ ] **Step 7: Commit**

`feat(hub): SSH key browse API — list, upload, delete keys in ~/.ssh`

---

### Task 5: Web — SshKeyCard.vue component

**Files:**
- Create: `packages/clients/web/src/components/SshKeyCard.vue`

- [ ] **Step 1: Create SshKeyCard.vue**

Follow FontCard.vue pattern. Two rendering modes:
- **Directory**: folder icon (SVG, not emoji) + name + item count badge
- **Key**: key icon + name + colored algorithm badge (using `--nt-badge-*` vars) + bits + mtime + encrypted badge + truncated fingerprint (`title` attr for full) + delete with inline confirm

Use `--nt-badge-info` for ED25519, `--nt-badge-success` for ECDSA, `--nt-badge-warning` for RSA, `--nt-badge-danger` for DSA and "encrypted".

Per ui-ux-pro-max: no emoji icons (use SVG), cursor-pointer on clickable, 44px min touch target, 150-300ms hover transitions, visible focus states.

- [ ] **Step 2: Commit**

`feat(web): SshKeyCard component with metadata badges and inline delete`

---

### Task 6: Web — SshKeyPicker.vue modal

**Files:**
- Create: `packages/clients/web/src/components/SshKeyPicker.vue`

- [ ] **Step 1: Create SshKeyPicker.vue**

Follow FontPicker.vue structure. Key differences:
- 560px max-width (wider than FontPicker due to metadata density)
- Breadcrumb nav showing `~/.ssh / subdir /` with clickable segments
- Fetches `GET /api/ssh-keys?dir=<currentDir>` on mount and on directory navigation
- Uses `useFileDrop(uploadFiles)` — no extension filter (keys have no standard extension)
- Upload: `POST /api/ssh-keys` with `dir` field in FormData
- Delete: `DELETE /api/ssh-keys?name=<name>&dir=<currentDir>`
- On key select: constructs `~/.ssh/<path>/<name>` tilde path, emits `update:modelValue`
- Error display: use `useToastStore().show("error", message)`
- Include `.dialog-overlay` styles in scoped CSS (copy from FontPicker/HostModal pattern)

- [ ] **Step 2: Commit**

`feat(web): SshKeyPicker modal with browse, upload, and breadcrumb navigation`

---

### Task 7: Web — HostModal integration

**Files:**
- Modify: `packages/clients/web/src/components/HostModal.vue`

- [ ] **Step 1: Add Browse button and SshKeyPicker to HostModal**

In the SSH key auth section (lines 257-265), replace the plain text input with input + Browse button:

```html
<div v-if="form.sshAuth === 'key'" class="field">
	<label class="field-label">Key Path</label>
	<div class="key-path-row">
		<input
			v-model="form.sshKeyPath"
			type="text"
			class="field-input"
			placeholder="~/.ssh/id_ed25519"
		/>
		<button class="browse-button" type="button" @click="showKeyPicker = true">
			Browse
		</button>
	</div>
	<SshKeyPicker
		:show="showKeyPicker"
		:model-value="form.sshKeyPath"
		@update:model-value="form.sshKeyPath = $event"
		@close="showKeyPicker = false"
	/>
</div>
```

Add in script:
```typescript
import SshKeyPicker from "./SshKeyPicker.vue";
const showKeyPicker = ref(false);
```

Add CSS for `.key-path-row` (flex with gap) and `.browse-button`.

- [ ] **Step 2: Run lint**

Run: `pnpm exec biome check --write .`

- [ ] **Step 3: Commit**

`feat(web): integrate SshKeyPicker Browse button in HostModal`

---

### Task 8: Manual verification

- [ ] **Step 1: Sync to Windows and test**

```bash
rsync -av --exclude='node_modules' --exclude='target' --exclude='.git' --exclude='dist' /mnt/wsl/shared/dev/lasterm/ /mnt/c/Temp/lasterm-build/
pnpm -F @lasterm/shared build  # on Windows
```

- [ ] **Step 2: Test SSH key picker**

1. Open HostModal → select Key auth → verify Browse button appears next to text input
2. Click Browse → modal opens listing `~/.ssh/` keys with metadata
3. Verify key badges (algorithm, bits, date, encrypted, fingerprint)
4. Navigate into subdirectory → breadcrumb updates → click breadcrumb to go back
5. Select a key → modal closes, path fills the input
6. Drag & drop a .pem file → upload succeeds, permissions set correctly
7. Delete a key → inline confirm → key removed
8. Type a custom path in the text input → verify it's accepted (free-form)

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass
