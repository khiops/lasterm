/**
 * Text on the chrome's filled controls, in every bundled theme (#1173).
 * The components are mounted with their own styles so the browser resolves the
 * theme tokens and the actual foreground/background pair.
 */
import { BUNDLED_THEMES, type Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useNotificationStore } from "../stores/notifications.js";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import { useWriteLockStore } from "../stores/writelock.js";
import ChannelSidebar from "./ChannelSidebar.vue";
import GroupActionDialog from "./GroupActionDialog.vue";
import HostBadge from "./HostBadge.vue";
import HostRail from "./HostRail.vue";
import HubExitedModal from "./HubExitedModal.vue";
import WriteLockIndicator from "./WriteLockIndicator.vue";

let app: App | null = null;

afterEach(async () => {
	await userEvent.unhover(document.body);
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
	vi.restoreAllMocks();
});

/** A colour as the browser computes it, which must be opaque. */
function solid(css: string, what: string): [number, number, number] {
	const m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(css);
	if (m === null) {
		const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(css);
		if (srgb === null) throw new Error(`cannot read the colour ${css} of ${what}`);
		expect(Number(srgb[4] ?? 1), `${what} (${css}) is see-through`).toBe(1);
		return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
	}
	expect(Number(m[4] ?? 1), `${what} (${css}) is see-through`).toBe(1);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The contrast of `el`'s text on its own background. */
function textOnFill(el: Element, what: string): number {
	const style = getComputedStyle(el);
	return contrastRatio(solid(style.color, `${what} text`), solid(style.backgroundColor, what));
}

/** The contrast of text on its parent's solid fill. */
function textOnParentFill(el: Element, what: string): number {
	if (el.parentElement === null) throw new Error(`no parent under ${what}`);
	return contrastRatio(
		solid(getComputedStyle(el).color, `${what} text`),
		solid(getComputedStyle(el.parentElement).backgroundColor, what),
	);
}

/** What `el` is drawn on: its own background over each ancestor's, down to the first opaque one. */
function groundOf(el: Element): [number, number, number] {
	const layers: Array<[number, number, number, number]> = [];
	for (let at: Element | null = el; at !== null; at = at.parentElement) {
		const m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(
			getComputedStyle(at).backgroundColor,
		);
		if (m === null) throw new Error("cannot read a background");
		const layer: [number, number, number, number] = [
			Number(m[1]),
			Number(m[2]),
			Number(m[3]),
			Number(m[4] ?? 1),
		];
		if (layer[3] > 0) layers.push(layer);
		if (layer[3] === 1) break;
	}
	const base = layers.pop();
	if (base === undefined || base[3] !== 1) throw new Error("no opaque ground under the element");
	let ground: [number, number, number] = [base[0], base[1], base[2]];
	for (const [r, g, b, a] of layers.reverse()) {
		ground = [
			r * a + ground[0] * (1 - a),
			g * a + ground[1] * (1 - a),
			b * a + ground[2] * (1 - a),
		];
	}
	return ground;
}

/** The contrast of `el`'s text on what it is drawn on. */
function textOnGround(el: Element, what: string): number {
	return contrastRatio(solid(getComputedStyle(el).color, `${what} text`), groundOf(el));
}

function mount(
	component: Parameters<typeof h>[0],
	props?: Record<string, unknown>,
	setup?: () => void,
	parentStyle?: Record<string, string>,
): void {
	app?.unmount();
	document.body.replaceChildren();
	const pinia = createPinia();
	setActivePinia(pinia);
	setup?.();
	const root = document.createElement("div");
	Object.assign(root.style, parentStyle);
	document.body.appendChild(root);
	app = createApp({ render: () => h(component, props) });
	app.use(pinia);
	app.mount(root);
}

async function expectHoverContrast(el: Element, what: string): Promise<void> {
	await userEvent.hover(el);
	expect(el.matches(":hover")).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(Number(getComputedStyle(el).opacity), `hovered ${what} opacity`).toBe(1);
	const ratio = textOnGround(el, `hovered ${what}`);
	expect(ratio, `hovered ${what}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
	await userEvent.unhover(document.body);
}

describe("filled controls' contrast (#1173)", () => {
	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		it(`reads the dialog buttons in ${name}`, async () => {
			mount(HubExitedModal, { code: 1 });
			useThemeStore().applyTheme(theme);
			await nextTick();
			const button = document.querySelector(".hub-exit-actions .btn-primary");
			if (button === null) throw new Error("no hub restart button");
			const ratio = textOnFill(button, "hub restart button");
			expect(ratio, `hub restart: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
			await expectHoverContrast(button, "hub restart button");

			mount(GroupActionDialog, { visible: true, title: "Rename", message: "Rename this group" });
			await nextTick();
			const confirm = document.querySelector(".group-action-dialog .btn-primary");
			if (confirm === null) throw new Error("no group confirmation button");
			const confirmed = textOnFill(confirm, "group confirmation button");
			expect(confirmed, `group confirmation: ${confirmed.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectHoverContrast(confirm, "group confirmation button");

			mount(GroupActionDialog, {
				visible: true,
				title: "Delete",
				message: "Delete this group",
				confirmDanger: true,
			});
			await nextTick();
			const dangerButton = document.querySelector(".group-action-dialog .btn-danger");
			if (dangerButton === null) throw new Error("no danger confirmation button");
			const danger = textOnFill(dangerButton, "danger confirmation button");
			expect(danger, `danger confirmation: ${danger.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectHoverContrast(dangerButton, "danger confirmation button");
		});

		it(`reads the host rail's filled badges in ${name}`, async () => {
			mount(HostRail, { recordingCount: 3 }, () => {
				const hostsStore = useHostsStore();
				const host: Host = {
					id: "build",
					type: "ssh",
					label: "Build",
					iconType: "auto",
					color: "#d43535",
					trustRemoteHints: "ask",
					sortOrder: 0,
					os: null,
					arch: null,
					createdAt: "2026-11-23T00:00:00.000Z",
					updatedAt: "2026-11-23T00:00:00.000Z",
				};
				hostsStore.hosts = [host];
				vi.spyOn(hostsStore, "fetchHosts").mockResolvedValue();
				useChannelsStore().registerChannelHost("channel-1", host.id);
				useNotificationStore().incrementBellCount("channel-1");
			});
			useThemeStore().applyTheme(theme);
			await nextTick();

			const initials = document.querySelector(".badge-initials");
			if (initials === null) throw new Error("no host initials");
			expect(initials.textContent?.trim()).toBe("BU");
			const hostRatio = textOnParentFill(initials, "host initials");
			expect(hostRatio, `host initials: ${hostRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);

			for (const [selector, what] of [
				[".host-bell-badge", "host notification"],
				[".rail-rec-badge", "recording count"],
			] as const) {
				const badge = document.querySelector(selector);
				if (badge === null) throw new Error(`no ${what} badge`);
				const ratio = textOnFill(badge, what);
				expect(ratio, `${what}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
			}

			mount(HostBadge, {
				host: {
					id: "build",
					type: "ssh",
					label: "Build",
					iconType: "auto",
					color: "#d43535",
					trustRemoteHints: "ask",
					sortOrder: 0,
					os: null,
					arch: null,
					createdAt: "2026-11-23T00:00:00.000Z",
					updatedAt: "2026-11-23T00:00:00.000Z",
				} satisfies Host,
			});
			useThemeStore().applyTheme(theme);
			await nextTick();
			const sharedInitials = document.querySelector(".host-badge__text");
			if (sharedInitials === null) throw new Error("no shared host initials");
			const sharedRatio = textOnParentFill(sharedInitials, "shared host initials");
			expect(sharedRatio, `shared host initials: ${sharedRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
		});

		it(`reads the sidebar's empty state in ${name}`, async () => {
			mount(
				ChannelSidebar,
				{
					style: {
						background: "rgba(var(--nt-sidebar-rgb), var(--nt-sidebar-alpha))",
					},
				},
				() => {
					const channelsStore = useChannelsStore();
					channelsStore.activeHostId = "host-1";
					channelsStore.channels = [];
					channelsStore.groups = [];
				},
			);
			useThemeStore().applyTheme(theme);
			await nextTick();
			const state = document.querySelector(".sidebar-state-text");
			if (state === null) throw new Error("no sidebar empty state");
			expect(state.textContent?.trim()).toBe("No terminals yet on this host.");
			const ratio = textOnGround(state, "sidebar empty state");
			expect(ratio, `sidebar empty state: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
		});

		it(`reads the pane's reader lock controls in ${name}`, async () => {
			mount(
				WriteLockIndicator,
				{ channelId: "channel-1" },
				() => {
					useAuthStore().setClientId("this-client");
					useWriteLockStore().handleWriteLock("channel-1", "another-client");
				},
				{ background: "var(--nt-tab-bar)" },
			);
			useThemeStore().applyTheme(theme);
			await nextTick();
			const label = document.querySelector(".wl-label");
			if (label === null) throw new Error("no write-lock label");
			expect(label.textContent?.trim()).toBe("Reader");
			const labelRatio = textOnGround(label, "reader lock label");
			expect(labelRatio, `reader lock label: ${labelRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			const buttons = [...document.querySelectorAll(".wl-action-btn")];
			expect(buttons.map((button) => button.textContent?.trim())).toEqual([
				"Request Write",
				"Force Take",
			]);
			for (const button of buttons) {
				const what = button.textContent?.trim() ?? "lock action";
				const ratio = textOnFill(button, what);
				expect(ratio, `${what}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
				await userEvent.hover(button);
				expect(button.matches(":hover")).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 200));
				const hovered = textOnGround(button, `hovered ${what}`);
				expect(hovered, `hovered ${what}: ${hovered.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);
				await userEvent.unhover(document.body);
			}

			const lockStore = useWriteLockStore();
			for (const [holder, reserved, expected] of [
				["this-client", false, "Writer"],
				[null, false, "No lock"],
				[null, true, "Writer reconnecting"],
			] as const) {
				lockStore.handleWriteLock("channel-1", holder, reserved);
				await nextTick();
				const stateLabel = document.querySelector(".wl-label");
				if (stateLabel === null) throw new Error(`no ${expected} label`);
				expect(stateLabel.textContent?.trim()).toBe(expected);
				const ratio = textOnGround(stateLabel, `${expected} lock label`);
				expect(ratio, `${expected} lock label: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);
				const release = document.querySelector(".wl-release");
				if (holder === "this-client") {
					if (release === null) throw new Error("no write-lock release button");
					const releaseRatio = textOnFill(release, "Release");
					expect(releaseRatio, `Release: ${releaseRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
						TEXT_CONTRAST_AA,
					);
				}
			}
		});
	}
});
