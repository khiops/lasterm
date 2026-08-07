# Font Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain text font family input with a modal font picker featuring live preview, drag & drop upload, and font deletion.

**Architecture:** Two new API endpoints (POST upload, DELETE) in `fonts.ts` following the wallpapers.ts pattern. Three new Vue components (FontPicker modal, FontCard, useFontDrop composable) integrated via a new `'font'` type in the settings schema.

**Tech Stack:** Fastify multipart (already registered), file-type (already a dep), Vue 3 Composition API, Teleport modal pattern.

**Spec:** `docs/superpowers/specs/2026-03-23-font-picker-design.md`

**Review fixes applied (from plan review):**
- Task 1: Add `mkdirSync` to test imports. `writeFile`/`unlink` from `node:fs/promises` (separate from existing `node:fs` import). Size check is defense-in-depth (plugin limit fires first).
- Task 2: Remove `decodeURIComponent()` — Fastify auto-decodes URL params. DELETE test must use `"Test Font"` (with space) as family name since `parseFontFile` applies camelCase split on `TestFont-Regular.ttf`.
- Task 3: Rename `onDragOver` to `onDragEnter` for the counter pattern. Expose a separate `onDragOver` that only calls `e.preventDefault()` (required for drop to work). Bind both in template: `@dragenter="onDragEnter" @dragover="onDragOver"`.
- Task 5: Replace `useNotificationStore().error()` with inline `uploadError`/`deleteError` ref (the notification store handles terminal bells, not toast messages). Move drag handlers from `.dialog-overlay` to `.font-picker-dialog`. Add `.dialog-overlay` styles to scoped CSS (copy from HostModal pattern).
- Task 6: Also add `| "font"` to SettingControl.vue's `defineProps` type prop union. Keep description as `"Font family for terminal rendering"`.

---

### Task 1: Hub — POST /api/fonts upload endpoint

**Files:**
- Modify: `packages/hub/src/api/fonts.ts` (add POST route inside `registerFontRoutes`)
- Test: `packages/hub/src/api/fonts.spec.ts`

**Context:** Follow the wallpapers.ts POST handler pattern exactly: `request.file()` → `sanitizeFilename()` → extension check → `file.toBuffer()` → `fileTypeFromBuffer()` MIME check → containment check → `writeFile()`. The `@fastify/multipart` plugin is already registered globally in server.ts.

- [ ] **Step 1: Write the failing test for font upload**

Add to `fonts.spec.ts` (create if needed). Use Fastify inject with multipart payload. Test: valid .ttf upload returns 200 + `FontFamily[]`. Use a minimal valid TTF buffer (OpenType signature `0x00010000` + minimal tables).

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { registerFontRoutes } from "./fonts.js";

describe("POST /api/fonts", () => {
	let app: ReturnType<typeof Fastify>;
	let fontsDir: string;
	let configDir: string;

	beforeEach(async () => {
		configDir = mkdtempSync(join(tmpdir(), "lasterm-font-test-"));
		fontsDir = join(configDir, "fonts");
		mkdirSync(fontsDir, { recursive: true });
		app = Fastify();
		await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });
		registerFontRoutes(app, configDir);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	it("uploads a valid font file and returns updated font list", async () => {
		// Minimal TTF-like file (real OpenType signature)
		const ttfBuffer = Buffer.alloc(64);
		ttfBuffer.writeUInt32BE(0x00010000, 0); // OpenType signature
		const boundary = "----formdata";
		const body = Buffer.concat([
			Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="TestFont-Regular.ttf"\r\nContent-Type: font/sfnt\r\n\r\n`),
			ttfBuffer,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]);

		const res = await app.inject({
			method: "POST",
			url: "/api/fonts",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
			payload: body,
		});

		expect(res.statusCode).toBe(200);
		const result = res.json();
		expect(Array.isArray(result)).toBe(true);
	});

	it("rejects a file with invalid extension", async () => {
		const boundary = "----formdata";
		const body = Buffer.concat([
			Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="malware.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`),
			Buffer.from("notafont"),
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]);

		const res = await app.inject({
			method: "POST",
			url: "/api/fonts",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
			payload: body,
		});

		expect(res.statusCode).toBe(400);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @lasterm/hub exec vitest run src/api/fonts.spec.ts`
Expected: FAIL — POST route not defined

- [ ] **Step 3: Implement POST /api/fonts**

In `fonts.ts`, add imports at top:

```typescript
import { writeFile, unlink } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
import { fileTypeFromBuffer } from "file-type";
```

Add constants:

```typescript
const MAX_FONT_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_FONT_MIMES = new Set([
	"font/sfnt",       // TTF
	"font/otf",        // OTF
	"font/woff",       // WOFF
	"font/woff2",      // WOFF2
	"application/font-woff",
	"application/font-woff2",
]);
```

Add `sanitizeFilename` helper (same as wallpapers.ts):

```typescript
function sanitizeFilename(raw: string): string | null {
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

Add POST route inside `registerFontRoutes`, after the GET route:

```typescript
server.post("/api/fonts", async (request, reply) => {
	const file = await request.file();
	if (!file) {
		return reply.code(400).send({
			error: { code: "NO_FILE", message: "No file uploaded" },
		});
	}

	const sanitized = sanitizeFilename(file.filename);
	if (!sanitized) {
		return reply.code(400).send({
			error: { code: "INVALID_FILENAME", message: "Invalid filename" },
		});
	}

	const ext = extname(sanitized).toLowerCase();
	if (!FONT_EXTENSIONS.has(ext)) {
		return reply.code(400).send({
			error: { code: "UNSUPPORTED_TYPE", message: `Unsupported file type: ${ext}` },
		});
	}

	const buffer = await file.toBuffer();

	if (buffer.byteLength > MAX_FONT_SIZE) {
		return reply.code(400).send({
			error: { code: "FILE_TOO_LARGE", message: "Font file too large (max 10 MB)" },
		});
	}

	// Magic-byte MIME validation
	const detected = await fileTypeFromBuffer(buffer);
	if (!detected || !ALLOWED_FONT_MIMES.has(detected.mime)) {
		// TTF fallback: file-type may not detect all TTF variants, check OpenType signature
		const sig = buffer.byteLength >= 4 ? buffer.readUInt32BE(0) : 0;
		const isOpenType = sig === 0x00010000 || sig === 0x4F54544F; // \0\1\0\0 or OTTO
		if (!isOpenType) {
			return reply.code(400).send({
				error: {
					code: "INVALID_FILE_TYPE",
					message: `File content does not match an allowed font type (detected: ${detected?.mime ?? "unknown"})`,
				},
			});
		}
	}

	const target = join(fontsDir, sanitized);
	if (!resolve(target).startsWith(resolve(fontsDir))) {
		return reply.code(400).send({
			error: { code: "INVALID_PATH", message: "Invalid filename" },
		});
	}

	// Check duplicate
	if (existsSync(target)) {
		return reply.code(409).send({
			error: { code: "DUPLICATE", message: `Font file already exists: ${sanitized}` },
		});
	}

	await writeFile(target, buffer);
	return scanFonts(fontsDir);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @lasterm/hub exec vitest run src/api/fonts.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/api/fonts.ts packages/hub/src/api/fonts.spec.ts
git commit -m "feat(hub): POST /api/fonts — font upload with MIME validation"
```

---

### Task 2: Hub — DELETE /api/fonts/:family

**Files:**
- Modify: `packages/hub/src/api/fonts.ts` (add DELETE route)
- Test: `packages/hub/src/api/fonts.spec.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

```typescript
describe("DELETE /api/fonts/:family", () => {
	it("deletes all files of a font family", async () => {
		// Pre-populate with a font file
		writeFileSync(join(fontsDir, "TestFont-Regular.ttf"), Buffer.alloc(64));

		const res = await app.inject({
			method: "DELETE",
			url: `/api/fonts/${encodeURIComponent("TestFont")}`,
		});

		expect(res.statusCode).toBe(204);
	});

	it("returns 404 for unknown family", async () => {
		const res = await app.inject({
			method: "DELETE",
			url: `/api/fonts/${encodeURIComponent("NonExistent")}`,
		});

		expect(res.statusCode).toBe(404);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @lasterm/hub exec vitest run src/api/fonts.spec.ts`
Expected: FAIL — DELETE route not defined

- [ ] **Step 3: Implement DELETE /api/fonts/:family**

Add DELETE route inside `registerFontRoutes`:

```typescript
server.delete<{ Params: { family: string } }>(
	"/api/fonts/:family",
	async (request, reply) => {
		const familyName = decodeURIComponent(request.params.family);
		const families = scanFonts(fontsDir);
		const match = families.find((f) => f.family === familyName);

		if (!match) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: `Font family not found: ${familyName}` },
			});
		}

		// Delete all files belonging to this family
		for (const file of match.files) {
			const filename = file.url.replace("/public/fonts/", "");
			const target = join(fontsDir, filename);
			// Containment check
			if (!resolve(target).startsWith(resolve(fontsDir))) continue;
			try {
				await unlink(target);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}

		return reply.code(204).send();
	},
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @lasterm/hub exec vitest run src/api/fonts.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/api/fonts.ts packages/hub/src/api/fonts.spec.ts
git commit -m "feat(hub): DELETE /api/fonts/:family — delete font by family name"
```

---

### Task 3: Web — useFontDrop composable

**Files:**
- Create: `packages/clients/web/src/composables/useFontDrop.ts`
- Test: `packages/clients/web/src/composables/useFontDrop.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { useFontDrop } from "./useFontDrop.js";

const ACCEPTED_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];

function makeFile(name: string): File {
	return new File(["data"], name, { type: "application/octet-stream" });
}

function makeDragEvent(files: File[]): DragEvent {
	const dt = { files, types: ["Files"] } as unknown as DataTransfer;
	return { preventDefault: vi.fn(), dataTransfer: dt } as unknown as DragEvent;
}

describe("useFontDrop", () => {
	it("filters dropped files by accepted extensions", () => {
		const onFiles = vi.fn();
		const { onDrop } = useFontDrop(onFiles);

		onDrop(makeDragEvent([
			makeFile("font.ttf"),
			makeFile("image.png"),
			makeFile("font.woff2"),
		]));

		expect(onFiles).toHaveBeenCalledOnce();
		const accepted = onFiles.mock.calls[0][0] as File[];
		expect(accepted).toHaveLength(2);
		expect(accepted[0].name).toBe("font.ttf");
		expect(accepted[1].name).toBe("font.woff2");
	});

	it("tracks isDragging state", () => {
		const { isDragging, onDragOver, onDragLeave } = useFontDrop(vi.fn());

		expect(isDragging.value).toBe(false);
		onDragOver({ preventDefault: vi.fn(), dataTransfer: { types: ["Files"] } } as unknown as DragEvent);
		expect(isDragging.value).toBe(true);
		onDragLeave({} as DragEvent);
		expect(isDragging.value).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @lasterm/web exec vitest run src/composables/useFontDrop.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement useFontDrop**

```typescript
import { ref, type Ref } from "vue";

const ACCEPTED_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2"]);

export function useFontDrop(onFiles: (files: File[]) => void): {
	isDragging: Ref<boolean>;
	onDragOver: (e: DragEvent) => void;
	onDragLeave: (e: DragEvent) => void;
	onDrop: (e: DragEvent) => void;
} {
	const isDragging = ref(false);
	let enterCount = 0;

	function onDragOver(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer?.types.includes("Files")) {
			enterCount++;
			isDragging.value = true;
		}
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
		const accepted = files.filter((f) => {
			const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
			return ACCEPTED_EXTENSIONS.has(ext);
		});

		if (accepted.length > 0) {
			onFiles(accepted);
		}
	}

	return { isDragging, onDragOver, onDragLeave, onDrop };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @lasterm/web exec vitest run src/composables/useFontDrop.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/clients/web/src/composables/useFontDrop.ts packages/clients/web/src/composables/useFontDrop.spec.ts
git commit -m "feat(web): useFontDrop composable for drag & drop font upload"
```

---

### Task 4: Web — FontCard.vue component

**Files:**
- Create: `packages/clients/web/src/components/settings/FontCard.vue`

No unit test — visual component, tested via integration in FontPicker.

- [ ] **Step 1: Create FontCard.vue**

```vue
<script setup lang="ts">
import { ref } from "vue";
import type { FontFamily } from "@lasterm/shared";

const props = withDefaults(
	defineProps<{
		family: FontFamily;
		selected: boolean;
		previewText?: string;
	}>(),
	{ previewText: "$ ls -la ~/.config 0123456789" },
);

defineEmits<{
	select: [];
	delete: [];
}>();

const confirming = ref(false);

function cancelDelete(): void {
	confirming.value = false;
}
</script>

<template>
	<div
		class="font-card"
		:class="{ 'font-card--selected': selected }"
		@click="!confirming && $emit('select')"
	>
		<template v-if="!confirming">
			<div class="font-card__header">
				<span
					class="font-card__name"
					:style="{ fontFamily: `'${family.family}'` }"
				>
					{{ family.family }}
				</span>
				<div class="font-card__actions">
					<span class="font-card__weights">
						{{ family.files.length }} weight{{ family.files.length > 1 ? "s" : "" }}
					</span>
					<button
						class="font-card__delete"
						title="Delete font"
						@click.stop="confirming = true"
					>
						🗑
					</button>
				</div>
			</div>
			<div
				class="font-card__preview"
				:style="{ fontFamily: `'${family.family}'` }"
			>
				{{ previewText }}
			</div>
		</template>
		<template v-else>
			<div class="font-card__confirm">
				<span>Delete "{{ family.family }}"?</span>
				<div class="font-card__confirm-actions">
					<button class="btn-confirm" @click.stop="$emit('delete')">
						Delete
					</button>
					<button class="btn-cancel" @click.stop="cancelDelete">
						Cancel
					</button>
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.font-card {
	background: var(--nt-bg-surface, #181825);
	border: 1px solid var(--nt-border, #313244);
	border-radius: 6px;
	padding: 10px 12px;
	cursor: pointer;
	transition: border-color 0.15s, background 0.15s;
}

.font-card:hover {
	background: var(--nt-bg-raised, #1e1e2e);
}

.font-card--selected {
	border-color: var(--nt-accent, #89b4fa);
	border-width: 2px;
	padding: 9px 11px; /* compensate for thicker border */
	background: var(--nt-bg-raised, #1e1e2e);
}

.font-card__header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 4px;
}

.font-card__name {
	font-size: 15px;
	font-weight: 600;
}

.font-card__actions {
	display: flex;
	align-items: center;
	gap: 6px;
}

.font-card__weights {
	color: var(--nt-fg-muted, #6c7086);
	font-size: 10px;
}

.font-card__delete {
	background: none;
	border: none;
	cursor: pointer;
	font-size: 12px;
	opacity: 0.4;
	padding: 2px;
	transition: opacity 0.15s;
}

.font-card__delete:hover {
	opacity: 1;
}

.font-card__preview {
	font-size: 12px;
	color: var(--nt-fg-muted, #a6adc8);
}

.font-card__confirm {
	display: flex;
	justify-content: space-between;
	align-items: center;
	min-height: 40px;
}

.font-card__confirm-actions {
	display: flex;
	gap: 8px;
}

.btn-confirm {
	background: var(--nt-danger, #f38ba8);
	color: var(--nt-bg, #1e1e2e);
	border: none;
	border-radius: 4px;
	padding: 4px 12px;
	cursor: pointer;
	font-size: 12px;
}

.btn-cancel {
	background: var(--nt-bg-surface, #313244);
	color: var(--nt-fg, #cdd6f4);
	border: none;
	border-radius: 4px;
	padding: 4px 12px;
	cursor: pointer;
	font-size: 12px;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add packages/clients/web/src/components/settings/FontCard.vue
git commit -m "feat(web): FontCard component with preview and inline delete"
```

---

### Task 5: Web — FontPicker.vue modal

**Files:**
- Create: `packages/clients/web/src/components/settings/FontPicker.vue`

- [ ] **Step 1: Create FontPicker.vue**

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import type { FontFamily } from "@lasterm/shared";
import { useConfigStore } from "../../stores/config.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useFontDrop } from "../../composables/useFontDrop.js";
import { hubBaseUrl } from "../../utils/hub-url.js";
import FontCard from "./FontCard.vue";

const props = defineProps<{
	modelValue: string | undefined;
	show: boolean;
}>();

const emit = defineEmits<{
	"update:modelValue": [family: string | undefined];
	close: [];
}>();

const configStore = useConfigStore();
const notifications = useNotificationStore();
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const fonts = computed<FontFamily[]>(() => configStore.fonts);

async function uploadFiles(files: File[]): Promise<void> {
	uploading.value = true;
	const token = localStorage.getItem("lasterm-token") ?? "";

	for (const file of files) {
		const form = new FormData();
		form.append("file", file);

		try {
			const res = await fetch(`${hubBaseUrl()}/api/fonts`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: form,
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
				notifications.error(err.error?.message ?? "Upload failed");
			}
		} catch {
			notifications.error(`Failed to upload ${file.name}`);
		}
	}

	await configStore.loadFonts();
	uploading.value = false;
}

async function deleteFamily(family: string): Promise<void> {
	const token = localStorage.getItem("lasterm-token") ?? "";

	try {
		const res = await fetch(`${hubBaseUrl()}/api/fonts/${encodeURIComponent(family)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
			notifications.error(err.error?.message ?? "Delete failed");
			return;
		}
	} catch {
		notifications.error("Failed to delete font");
		return;
	}

	// If deleted font was selected, reset to default
	if (props.modelValue === family) {
		emit("update:modelValue", undefined);
	}

	await configStore.loadFonts();
}

function selectFont(family: string): void {
	emit("update:modelValue", family);
	emit("close");
}

function triggerFileInput(): void {
	fileInput.value?.click();
}

function onFileInputChange(e: Event): void {
	const input = e.target as HTMLInputElement;
	if (input.files?.length) {
		uploadFiles(Array.from(input.files));
		input.value = "";
	}
}

const { isDragging, onDragOver, onDragLeave, onDrop } = useFontDrop(uploadFiles);
</script>

<template>
	<Teleport to="body">
		<div
			v-if="show"
			class="dialog-overlay"
			@click.self="$emit('close')"
			@dragover="onDragOver"
			@dragleave="onDragLeave"
			@drop="onDrop"
		>
			<div class="font-picker-dialog">
				<div class="font-picker-header">
					<div class="font-picker-title">
						<span>Font Selection</span>
						<span class="font-picker-count">{{ fonts.length }}</span>
					</div>
					<div class="font-picker-actions">
						<button class="font-picker-add" @click="triggerFileInput">
							+ Add font
						</button>
						<button class="dialog-close" @click="$emit('close')">
							✕
						</button>
					</div>
				</div>

				<div class="font-picker-list">
					<template v-if="fonts.length > 0">
						<FontCard
							v-for="family in fonts"
							:key="family.family"
							:family="family"
							:selected="modelValue === family.family"
							@select="selectFont(family.family)"
							@delete="deleteFamily(family.family)"
						/>
					</template>
					<div v-else class="font-picker-empty">
						No fonts installed. Drop font files here or click + Add font.
					</div>
				</div>

				<div class="font-picker-footer">
					Drop .ttf, .otf, .woff2 files anywhere to add
				</div>

				<div v-if="isDragging" class="font-picker-drop-overlay">
					<div class="font-picker-drop-content">
						<div class="font-picker-drop-icon">📁</div>
						<div class="font-picker-drop-text">Drop font files here</div>
						<div class="font-picker-drop-hint">.ttf, .otf, .woff, .woff2</div>
					</div>
				</div>

				<div v-if="uploading" class="font-picker-uploading">
					Uploading…
				</div>
			</div>

			<input
				ref="fileInput"
				type="file"
				multiple
				accept=".ttf,.otf,.woff,.woff2"
				style="display: none"
				@change="onFileInputChange"
			/>
		</div>
	</Teleport>
</template>

<style scoped>
.font-picker-dialog {
	background: var(--nt-bg, #1e1e2e);
	border-radius: 12px;
	width: 480px;
	max-width: 90vw;
	max-height: 80vh;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	position: relative;
	box-shadow: 0 24px 48px rgba(0, 0, 0, 0.4);
}

.font-picker-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px 16px;
	border-bottom: 1px solid var(--nt-border, #313244);
}

.font-picker-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 14px;
	font-weight: 600;
}

.font-picker-count {
	font-size: 11px;
	color: var(--nt-fg-muted, #6c7086);
	background: var(--nt-bg-surface, #313244);
	padding: 1px 6px;
	border-radius: 3px;
}

.font-picker-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}

.font-picker-add {
	background: var(--nt-bg-surface, #313244);
	border: none;
	border-radius: 5px;
	padding: 4px 10px;
	color: var(--nt-fg-muted, #a6adc8);
	font-size: 12px;
	cursor: pointer;
	transition: background 0.15s;
}

.font-picker-add:hover {
	background: var(--nt-bg-raised, #45475a);
}

.font-picker-list {
	padding: 8px 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	max-height: 360px;
	overflow-y: auto;
}

.font-picker-empty {
	color: var(--nt-fg-muted, #6c7086);
	text-align: center;
	padding: 40px 16px;
	font-size: 13px;
}

.font-picker-footer {
	padding: 8px 16px 10px;
	border-top: 1px solid var(--nt-border, #313244);
	text-align: center;
	color: var(--nt-fg-muted, #6c7086);
	font-size: 11px;
}

.font-picker-drop-overlay {
	position: absolute;
	inset: 0;
	background: rgba(137, 180, 250, 0.08);
	border: 2px dashed var(--nt-accent, #89b4fa);
	border-radius: 12px;
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10;
}

.font-picker-drop-content {
	text-align: center;
}

.font-picker-drop-icon {
	font-size: 32px;
	margin-bottom: 8px;
}

.font-picker-drop-text {
	font-size: 16px;
	font-weight: 600;
	color: var(--nt-accent, #89b4fa);
}

.font-picker-drop-hint {
	font-size: 13px;
	color: var(--nt-fg-muted, #6c7086);
	margin-top: 4px;
}

.font-picker-uploading {
	position: absolute;
	inset: 0;
	background: rgba(0, 0, 0, 0.5);
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--nt-fg, #cdd6f4);
	font-size: 14px;
	z-index: 11;
	border-radius: 12px;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add packages/clients/web/src/components/settings/FontPicker.vue
git commit -m "feat(web): FontPicker modal with upload, delete, and drag & drop"
```

---

### Task 6: Web — Settings integration

**Files:**
- Modify: `packages/clients/web/src/components/settings/settingsSchema.ts` (type union + fontFamily entry)
- Modify: `packages/clients/web/src/components/settings/SettingControl.vue` (add font case)

- [ ] **Step 1: Update SettingDefinition type union**

In `settingsSchema.ts`, line 6, change:

```typescript
type: "text" | "number" | "select" | "toggle" | "range" | "color";
```

to:

```typescript
type: "text" | "number" | "select" | "toggle" | "range" | "color" | "font";
```

- [ ] **Step 2: Change fontFamily entry type**

In `settingsSchema.ts`, change the fontFamily entry (around line 49-57):

```typescript
{
	key: "fontFamily",
	label: "Font Family",
	type: "font",
	category: "terminal",
	section: "terminal",
	scopes: ["global", "host", "channel"],
	description: "Terminal font",
},
```

- [ ] **Step 3: Add font case to SettingControl.vue**

In the template, after the last `v-else-if` (color), add before the closing tag:

```vue
<div v-else-if="type === 'font'" class="control-font">
	<button
		class="control-font-trigger"
		:disabled="disabled"
		@click="showFontPicker = true"
	>
		{{ modelValue || 'Default' }}
	</button>
	<FontPicker
		:show="showFontPicker"
		:model-value="modelValue as string | undefined"
		@update:model-value="onFontSelect"
		@close="showFontPicker = false"
	/>
</div>
```

In the script section, add imports and state:

```typescript
import { ref } from "vue";
import FontPicker from "./FontPicker.vue";

const showFontPicker = ref(false);

function onFontSelect(family: string | undefined): void {
	emit("update:modelValue", family ?? "");
	showFontPicker.value = false;
}
```

Add CSS for the trigger button:

```css
.control-font-trigger {
	background: var(--nt-bg-surface, #313244);
	border: 1px solid var(--nt-border, #45475a);
	border-radius: 4px;
	padding: 6px 12px;
	color: var(--nt-fg, #cdd6f4);
	font-size: 13px;
	cursor: pointer;
	text-align: left;
	min-width: 180px;
	transition: border-color 0.15s;
}

.control-font-trigger:hover {
	border-color: var(--nt-accent, #89b4fa);
}

.control-font-trigger:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
```

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: PASS (no errors)

- [ ] **Step 5: Commit**

```bash
git add packages/clients/web/src/components/settings/settingsSchema.ts packages/clients/web/src/components/settings/SettingControl.vue
git commit -m "feat(web): integrate FontPicker into settings via 'font' control type"
```

---

### Task 7: Manual verification

- [ ] **Step 1: Sync to Windows and test**

```bash
rsync -av --exclude='node_modules' --exclude='target' --exclude='.git' --exclude='dist' /mnt/wsl/shared/dev/lasterm/ /mnt/c/Temp/lasterm-build/
```

- [ ] **Step 2: Open Settings in browser, verify font picker**

1. Navigate to Settings → Terminal
2. Click the font family trigger button → modal opens
3. Verify existing fonts are shown with preview
4. Click a font → modal closes, setting updates, terminal re-renders
5. Open modal again, drag a .ttf file → upload succeeds, new font appears
6. Click 🗑 on a font → inline confirm → delete succeeds
7. Test at host and channel scope levels

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass
