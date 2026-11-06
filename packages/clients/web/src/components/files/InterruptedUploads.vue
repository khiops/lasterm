<template>
	<!-- Interrupted uploads (#837): what a crash, a restart or a window that left stopped, offered
	     at the next start for a resume with one click, and kept until the hub's 7-day expiry.
	     Nothing resumes by itself: Resume is the click that lets this window read the files again. -->
	<section v-if="uploads.length > 0" class="interrupted" aria-label="Interrupted uploads" data-interrupted-uploads>
		<p v-if="transfers.interruptedFolded" class="interrupted__folded">
			<button
				type="button"
				class="interrupted__link interrupted__show"
				aria-expanded="false"
				data-interrupted-show
				@click="transfers.showInterrupted()"
			>
				{{ foldedLine }}
			</button>
			<template v-if="resumable.length > 0">
				<span aria-hidden="true">·</span>
				<button type="button" class="interrupted__link" data-interrupted-resume-all @click="resumeAll">Resume</button>
			</template>
		</p>
		<template v-else>
			<div class="interrupted__head">
				<h4 class="interrupted__title">Interrupted uploads</h4>
				<span v-if="until !== null" class="interrupted__until">kept until {{ until }}</span>
			</div>
			<div v-if="controllable.length > 0" class="interrupted__all">
				<button
					v-if="resumable.length > 0"
					type="button"
					class="files-btn files-btn--primary"
					data-interrupted-resume-all
					@click="resumeAll"
				>
					Resume all
				</button>
				<button type="button" class="files-btn" data-interrupted-not-now @click="transfers.notNow()">Not now</button>
				<button
					v-if="discardable.length > 0"
					type="button"
					class="files-btn"
					data-interrupted-discard-all
					@click="transfers.discardUploads(discardable.map((upload) => upload.id))"
				>
					Discard all
				</button>
			</div>
			<ul class="interrupted__list">
				<li v-for="upload in uploads" :key="upload.id" class="interrupted__row" data-interrupted-row>
					<div class="interrupted__line">
						<HostBadge v-if="hostOf(upload.hostId)" :host="hostOf(upload.hostId)!" :size="14" />
						<span class="interrupted__name" :title="`${upload.label} → ${hostLabel(upload.hostId)} › ${upload.dir}`">
							{{ upload.label }}
						</span>
						<span class="interrupted__dest" :title="upload.dir">→ {{ hostLabel(upload.hostId) }} › {{ upload.dir }}</span>
					</div>
					<p class="interrupted__placed">{{ placedText(upload.totals) }}</p>
					<p
						v-if="noteOf(upload) !== null"
						class="interrupted__note"
						:class="{ 'interrupted__note--warn': warns(upload) }"
						:role="busy(upload) ? 'status' : undefined"
						data-interrupted-note
					>
						{{ noteOf(upload) }}
					</p>
					<div
						v-if="upload.resume?.phase === 'changed' && mayControl(upload)"
						class="files-card interrupted__changed"
						role="group"
						:aria-label="`Files of ${upload.label} that changed since they were sent`"
						data-interrupted-changed
					>
						<p class="files-card__text">
							{{
								upload.resume.files.length === 1
									? "Changed since it was sent: send it again from the start, or skip it"
									: `${upload.resume.files.length.toLocaleString("en-US")} files changed since they were sent: send each again from the start, or skip it`
							}}
						</p>
						<ul class="interrupted__files">
							<li v-for="file in upload.resume.files.slice(0, ROWS_SHOWN)" :key="file.itemId" class="interrupted__file">
								<span class="interrupted__file-name">{{ changedText(file) }}</span>
								<span v-if="file.answer === null" class="interrupted__file-actions">
									<button type="button" class="files-btn" @click="transfers.answerChanged(upload.id, file.itemId, 'restart')">
										Send again from the start
									</button>
									<button type="button" class="files-btn" @click="transfers.answerChanged(upload.id, file.itemId, 'skip')">
										Skip
									</button>
								</span>
								<span v-else class="interrupted__file-answer">
									{{ file.answer === "restart" ? "sent again from the start" : "skipped" }}
								</span>
							</li>
						</ul>
						<div class="files-card__actions interrupted__changed-all">
							<template v-if="upload.resume.files.filter((file) => file.answer === null).length > 1">
								<button type="button" class="files-btn" @click="transfers.answerChanged(upload.id, 'all', 'restart')">
									Send all again from the start
								</button>
								<button type="button" class="files-btn" @click="transfers.answerChanged(upload.id, 'all', 'skip')">
									Skip all
								</button>
							</template>
							<button type="button" class="files-link" @click="transfers.cancelResume(upload.id)">Cancel</button>
						</div>
					</div>
					<div v-if="mayControl(upload) && (canResume(upload) || canDiscard(upload))" class="interrupted__actions">
						<button
							v-if="canResume(upload)"
							type="button"
							class="files-btn"
							:disabled="upload.kept === 'reading'"
							data-interrupted-resume
							@click="transfers.resumeUploads([upload.id])"
						>
							Resume
						</button>
						<button
							v-if="canDiscard(upload)"
							type="button"
							class="files-btn"
							data-interrupted-discard
							@click="transfers.discardUploads([upload.id])"
						>
							Discard
						</button>
					</div>
				</li>
			</ul>
		</template>
	</section>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { computed } from "vue";
import { useHostsStore } from "../../stores/hosts.js";
import { useTransfersStore } from "../../stores/transfers.js";
import {
	changedText,
	dayText,
	deviceText,
	foldedText,
	keptUntil,
	notResumedText,
	placedText,
	resumeText,
	type UploadView,
} from "../../utils/transfers-view.js";
import HostBadge from "../HostBadge.vue";

const props = defineProps<{
	/** Resume and Discard: not for a reader of the upload's terminal. */
	mayControl: (upload: UploadView) => boolean;
}>();

/** The most changed files a card lists. */
const ROWS_SHOWN = 200;

const transfers = useTransfersStore();
const hostsStore = useHostsStore();

const uploads = computed(() => transfers.interrupted);
const untilDate = computed(() => keptUntil(uploads.value.map((upload) => upload.updatedAt)));
const until = computed(() => (untilDate.value === null ? null : dayText(untilDate.value)));
const foldedLine = computed(() => foldedText(uploads.value.length, untilDate.value));

const controllable = computed(() => uploads.value.filter((upload) => props.mayControl(upload)));
const resumable = computed(() =>
	controllable.value.filter((upload) => canResume(upload) && upload.kept === "kept"),
);
const discardable = computed(() => controllable.value.filter(canDiscard));

function hostOf(hostId: string): Host | undefined {
	return hostsStore.hosts.find((host) => host.id === hostId);
}

function hostLabel(hostId: string): string {
	return hostOf(hostId)?.label ?? "Unknown host";
}

/**
 * Resume: only this device's uploads whose handles were kept, and not under way. One that fell
 * back to a drop because access was refused, or never answered, may be asked again.
 */
function canResume(upload: UploadView): boolean {
	if (upload.fromThisDevice !== true || (upload.kept !== "kept" && upload.kept !== "reading"))
		return false;
	const resume = upload.resume ?? null;
	return resume === null || (resume.phase === "redrop" && (resume.why === "denied" || resume.why === "timeout"));
}

function canDiscard(upload: UploadView): boolean {
	const phase = upload.resume?.phase;
	return phase === undefined || phase === "redrop" || phase === "changed";
}

function busy(upload: UploadView): boolean {
	const phase = upload.resume?.phase;
	return phase === "asking" || phase === "checking" || phase === "resuming" || phase === "discarding";
}

/** What the row says under its count: where its resume is, why it did not resume, or why it cannot. */
function noteOf(upload: UploadView): string | null {
	const phase = resumeText(upload.resume);
	if (phase !== null) return phase;
	if (upload.fromThisDevice !== true) {
		return `Interrupted · resumable from ${deviceText(upload.deviceLabel)}`;
	}
	if (upload.reason !== undefined) return notResumedText(upload.reason, hostLabel(upload.hostId));
	if (upload.kept === "none") return "Can't be resumed after a restart: drop it again";
	return null;
}

function warns(upload: UploadView): boolean {
	return upload.reason !== undefined || upload.resume?.phase === "redrop";
}

/** Resume all: inside the click, every upload asks its files' access at once. */
function resumeAll(): void {
	transfers.resumeUploads(resumable.value.map((upload) => upload.id));
}
</script>

<style scoped>
.interrupted {
	margin: 0 0 8px;
	padding: 6px 8px;
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	font-size: 12px;
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.interrupted__folded {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 4px;
	margin: 0;
}

.interrupted__head {
	display: flex;
	align-items: baseline;
	gap: 8px;
}

.interrupted__title {
	margin: 0;
	font-size: 12px;
	font-weight: 600;
}

.interrupted__until {
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.interrupted__all,
.interrupted__actions {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 6px 0 2px;
}

.interrupted__actions {
	margin: 4px 0 0 20px;
}

.interrupted__list {
	margin: 4px 0 0;
	padding: 0;
	list-style: none;
}

.interrupted__row {
	padding: 6px 0;
}

.interrupted__row + .interrupted__row {
	border-top: 1px dashed var(--nt-border);
}

.interrupted__line {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}

.interrupted__name {
	flex-shrink: 0;
	max-width: 50%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 600;
}

.interrupted__dest {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.interrupted__placed,
.interrupted__note {
	margin: 2px 0 0 20px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.interrupted__note--warn {
	color: var(--nt-badge-warning, var(--nt-badge));
	font-weight: 600;
}

.interrupted__link,
.files-link {
	padding: 0;
	border: none;
	background: none;
	color: var(--nt-accent);
	font: inherit;
	font-size: 11px;
	font-weight: 600;
	cursor: pointer;
}

.interrupted__show {
	color: inherit;
	font-size: 12px;
}

.files-card {
	margin: 6px 0 2px 20px;
	padding: 8px 10px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
}

.files-card__text {
	margin: 0 0 6px;
	font-size: 12px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.files-card__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	margin-top: 6px;
}

.files-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 8px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

.files-btn--primary {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.files-btn:disabled {
	opacity: 0.5;
	cursor: default;
}

.files-btn:focus-visible,
.files-link:focus-visible,
.interrupted__link:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.interrupted__files {
	margin: 0;
	padding: 0;
	list-style: none;
	max-height: 160px;
	overflow-y: auto;
}

.interrupted__file {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 2px 8px;
	padding: 2px 0;
	font-size: 11px;
}

.interrupted__file-name {
	font-weight: 600;
	overflow-wrap: anywhere;
}

.interrupted__file-actions {
	display: inline-flex;
	gap: 4px;
	margin-left: auto;
}

.interrupted__file-answer {
	margin-left: auto;
	color: var(--nt-text-secondary);
}
</style>
