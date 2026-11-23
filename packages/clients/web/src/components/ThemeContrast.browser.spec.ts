/**
 * Text on the chrome's filled controls, in every bundled theme (#1173).
 * The components are mounted with their own styles so the browser resolves the
 * theme tokens and the actual foreground/background pair.
 */
import { BUNDLED_THEMES, type Channel, type Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

const whiteWallpaper = vi.hoisted(
	() =>
		`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="white"/></svg>')}`,
);

vi.mock("../services/ws-client.js", () =>
	import("../App.doubles.fixture.js").then((m) => m.wsClientModule),
);
vi.mock("@xterm/xterm", () => import("../App.doubles.fixture.js").then((m) => m.xtermModule));
vi.mock("@xterm/addon-fit", () =>
	import("../App.doubles.fixture.js").then((m) => m.fitAddonModule),
);
vi.mock("@xterm/addon-unicode11", () =>
	import("../App.doubles.fixture.js").then((m) => m.unicodeAddonModule),
);
vi.mock("@xterm/addon-search", () =>
	import("../App.doubles.fixture.js").then((m) => m.searchAddonModule),
);
vi.mock("../composables/terminal-font.js", () => ({ awaitTerminalFont: () => Promise.resolve() }));
vi.mock("../composables/useBellSound.js", () => ({ playBellSound: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isMaximized: async () => false,
		onResized: async () => () => {},
	}),
}));
vi.mock("../utils/asset-holder.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils/asset-holder.js")>()),
	acquireAsset: async () => ({ url: whiteWallpaper, release() {} }),
}));

import { type App, createApp, h, nextTick, ref } from "vue";
import { mountWindow, unmountWindow } from "../App.fixture.js";
import { getColorFromLabel } from "../composables/useHostIcon.js";
import "../styles/base.css";
import { useAgentVerifyStore } from "../stores/agent-verify.js";
import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useConfigStore } from "../stores/config.js";
import { useHostVerifyStore } from "../stores/host-verify.js";
import { useHostsStore } from "../stores/hosts.js";
import { useNotificationStore } from "../stores/notifications.js";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import { useWriteLockStore } from "../stores/writelock.js";
import { setAssetTokenForTests } from "../utils/hub-url.js";
import AgentBinaryVerify from "./AgentBinaryVerify.vue";
import AgentDeployFailed from "./AgentDeployFailed.vue";
import BatchImportModal from "./BatchImportModal.vue";
import ChannelItem from "./ChannelItem.vue";
import ChannelSidebar from "./ChannelSidebar.vue";
import CloseModal from "./CloseModal.vue";
import ConfigureCommandDialog from "./ConfigureCommandDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import DeleteHostModal from "./DeleteHostModal.vue";
import GroupActionDialog from "./GroupActionDialog.vue";
import HostBadge from "./HostBadge.vue";
import HostKeyWarning from "./HostKeyWarning.vue";
import HostModal from "./HostModal.vue";
import HostRail from "./HostRail.vue";
import HubExitedModal from "./HubExitedModal.vue";
import PairingCodeGenerator from "./PairingCodeGenerator.vue";
import WallpaperCategory from "./settings/categories/WallpaperCategory.vue";
import TabBar from "./TabBar.vue";
import TitleBar from "./TitleBar.vue";
import UnreadLinesBar from "./UnreadLinesBar.vue";
import WriteLockIndicator from "./WriteLockIndicator.vue";

let app: App | null = null;
let windowMounted = false;

afterEach(async () => {
	await userEvent.unhover(document.body);
	if (windowMounted) {
		await unmountWindow();
		windowMounted = false;
	}
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
	setAssetTokenForTests(null);
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

/** Text on a control's translucent fill over a known, loaded image's colour. */
function textOnImage(el: Element, image: [number, number, number], what: string): number {
	const style = getComputedStyle(el);
	const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(
		style.backgroundColor,
	);
	if (match === null) throw new Error(`cannot read the translucent fill of ${what}`);
	const alpha = Number(match[4] ?? 1);
	const ground: [number, number, number] = [
		Number(match[1]) * alpha + image[0] * (1 - alpha),
		Number(match[2]) * alpha + image[1] * (1 - alpha),
		Number(match[3]) * alpha + image[2] * (1 - alpha),
	];
	return contrastRatio(solid(style.color, `${what} text`), ground);
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

async function mountBatchImport(): Promise<void> {
	app?.unmount();
	document.body.replaceChildren();
	const pinia = createPinia();
	setActivePinia(pinia);
	const show = ref(false);
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(BatchImportModal, { show: show.value }) });
	app.use(pinia);
	app.mount(root);
	show.value = true;
	await nextTick();
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

async function expectFilledButton(selector: string, what: string, text: string): Promise<void> {
	const button = document.querySelector<HTMLButtonElement>(selector);
	if (button === null) throw new Error(`no ${what}`);
	expect(button.disabled, `${what} is enabled`).toBe(false);
	expect(button.textContent?.trim()).toBe(text);
	const ratio = textOnFill(button, what);
	expect(ratio, `${what}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
	await expectHoverContrast(button, what);
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

		it(`reads the empty window's open-terminal action in ${name}`, async () => {
			windowMounted = true;
			const { root } = await mountWindow({
				hosts: [{ id: "host-alpha", label: "alpha", type: "ssh", connected: true }],
				layout: { tabs: [] },
			});
			useThemeStore().applyTheme(theme);
			await nextTick();
			const button = root.querySelector(".pane-empty-action");
			if (button === null) throw new Error("no empty-window open-terminal action");
			expect(button.textContent?.trim()).toBe("Open a terminal on alpha");
			const ratio = textOnFill(button, "empty-window open-terminal action");
			expect(ratio, `empty-window open-terminal: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectHoverContrast(button, "empty-window open-terminal action");
		});

		it(`reads the configure-and-restart button in ${name}`, async () => {
			mount(ConfigureCommandDialog, { visible: true, channelId: "channel-1" });
			useThemeStore().applyTheme(theme);
			const program = document.querySelector(".field-input");
			if (program === null) throw new Error("no command program field");
			await userEvent.fill(program, "/bin/bash");
			await nextTick();
			const button = document.querySelector<HTMLButtonElement>(".dialog-actions .btn-accent");
			if (button === null) throw new Error("no configure-and-restart button");
			expect(button.disabled).toBe(false);
			expect(button.textContent?.trim()).toBe("Apply & Restart");
			const ratio = textOnFill(button, "configure-and-restart button");
			expect(ratio, `configure-and-restart: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectHoverContrast(button, "configure-and-restart button");
		});

		it(`reads the title bar's hovered close control in ${name}`, async () => {
			mount(TitleBar);
			useThemeStore().applyTheme(theme);
			const button = await vi.waitFor(() => {
				const close = document.querySelector('button[aria-label="Close"]');
				if (close === null) throw new Error("no title-bar close control");
				return close;
			});
			await userEvent.hover(button);
			expect(button.matches(":hover")).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const ratio = textOnFill(button, "hovered title-bar close control");
			expect(ratio, `title-bar close hover: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
		});

		it(`reads the host-key accept button in ${name}`, async () => {
			mount(HostKeyWarning, undefined, () => {
				useHostVerifyStore().handleHostVerify(
					"host-1",
					"build.example",
					"SHA256:new",
					"ssh-ed25519",
					"SHA256:old",
					"prompt-1",
				);
			});
			useThemeStore().applyTheme(theme);
			await nextTick();
			const button = document.querySelector(".hkw-accept");
			if (button === null) throw new Error("no host-key accept button");
			expect(button.textContent?.trim()).toBe("Accept New Key");
			const ratio = textOnFill(button, "host-key accept button");
			expect(ratio, `host-key accept: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectHoverContrast(button, "host-key accept button");
		});

		it(`reads the unread-lines jump button in ${name}`, async () => {
			mount(UnreadLinesBar, { lineCount: 12, show: true });
			useThemeStore().applyTheme(theme);
			await nextTick();
			const button = document.querySelector(".unread-lines-btn--jump");
			if (button === null) throw new Error("no unread-lines jump button");
			expect(button.textContent?.trim()).toBe("Jump ↓");
			const ratio = textOnFill(button, "unread-lines jump button");
			expect(ratio, `unread-lines jump: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectHoverContrast(button, "unread-lines jump button");
		});

		it(`reads a channel's bell badge in ${name}`, async () => {
			const channel: Channel = {
				id: "channel-1",
				sessionId: "session-1",
				cols: 80,
				rows: 24,
				status: "live",
				createdAt: "2026-11-23T00:00:00.000Z",
				updatedAt: "2026-11-23T00:00:00.000Z",
			};
			mount(
				ChannelItem,
				{
					channel,
					index: 1,
					isSelected: false,
					isUnread: false,
					availableGroups: [],
				},
				() => useNotificationStore().incrementBellCount(channel.id),
			);
			useThemeStore().applyTheme(theme);
			await nextTick();
			const badge = document.querySelector(".channel-item__bell-badge");
			if (badge === null) throw new Error("no channel bell badge");
			expect(badge.textContent?.trim()).toBe("1");
			const ratio = textOnFill(badge, "channel bell badge");
			expect(ratio, `channel bell badge: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
		});

		it(`reads a tab's filled badges in ${name}`, async () => {
			mount(
				TabBar,
				{
					tabs: [{ id: "tab-1" }],
					activeTabIndex: 0,
					getTabLabel: () => "Build terminal",
					getActiveChannelId: () => "channel-1",
					getTabChannelIds: () => ["channel-1"],
					visibleTabIds: null,
				},
				() => {
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
					useHostsStore().hosts = [host];
					const channelsStore = useChannelsStore();
					channelsStore.activeHostId = "local";
					channelsStore.registerChannelHost("channel-1", host.id);
					useNotificationStore().incrementBellCount("channel-1");
					const configStore = useConfigStore();
					configStore.uiConfig = {
						...configStore.uiConfig,
						tabs: { ...configStore.uiConfig.tabs, hostMarker: "initials" },
					};
				},
			);
			useThemeStore().applyTheme(theme);
			await nextTick();

			const initials = document.querySelector(".tab__host-initials");
			if (initials === null) throw new Error("no tab host initials");
			expect(initials.textContent?.trim()).toBe("BU");
			const hostRatio = textOnFill(initials, "tab host initials");
			expect(hostRatio, `tab host initials: ${hostRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);

			const badge = document.querySelector(".tab__bell-badge");
			if (badge === null) throw new Error("no tab bell badge");
			expect(badge.textContent?.trim()).toBe("1");
			const badgeRatio = textOnFill(badge, "tab bell badge");
			expect(badgeRatio, `tab bell badge: ${badgeRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
		});

		it(`reads the Add Host preview against its own colour in ${name}`, async () => {
			mount(HostModal, { visible: true, editHost: null });
			useThemeStore().applyTheme(theme);
			const label = document.querySelector('input[placeholder="prod-server"]');
			if (label === null) throw new Error("no host label field");
			await userEvent.fill(label, "prod");
			await nextTick();
			const preview = document.querySelector(".preview-badge");
			if (preview === null) throw new Error("no Add Host preview badge");
			expect(preview.textContent?.trim()).toBe("PR");
			expect(getComputedStyle(preview).backgroundColor).toBe("rgb(53, 53, 212)");
			const ratio = textOnFill(preview, "Add Host preview badge");
			expect(ratio, `Add Host preview: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);
			await expectFilledButton(".source-tab.active", "Add Host active source tab", "Manual");
		});

		it(`reads every remaining changed dialog control in ${name}`, async () => {
			const apply = async () => {
				useThemeStore().applyTheme(theme);
				await nextTick();
			};
			const host: Host = {
				id: "local",
				type: "local",
				label: "local",
				iconType: "auto",
				trustRemoteHints: "apply",
				sortOrder: 0,
				os: "linux",
				arch: "x64",
				createdAt: "2026-11-23T00:00:00.000Z",
				updatedAt: "2026-11-23T00:00:00.000Z",
			};

			mount(ConfirmDialog, {
				visible: true,
				title: "Delete",
				message: "Delete this item",
				confirmLabel: "Delete",
			});
			await apply();
			await expectFilledButton(".confirm-actions .btn-danger", "ConfirmDialog danger", "Delete");

			mount(CloseModal, { visible: true, busy: false });
			await apply();
			await expectFilledButton(
				".close-actions .btn-danger",
				"CloseModal danger",
				"Quit completely",
			);

			mount(DeleteHostModal, { visible: true, hostId: host.id }, () => {
				useHostsStore().hosts = [host];
			});
			await apply();
			await expectFilledButton(
				".delete-host-modal .btn-danger",
				"DeleteHostModal danger",
				"Delete",
			);

			mount(HostModal, { visible: true, editHost: host }, () => {
				useHostsStore().hosts = [host];
			});
			await apply();
			await expectFilledButton(".host-modal .btn-primary", "HostModal save", "Save");

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					entries: [
						{
							name: "app",
							hostname: "10.0.0.8",
							port: 22,
							user: null,
							identity_file: null,
							proxy_jump: null,
							is_git_host: false,
						},
					],
					has_include: false,
				}),
			);
			await mountBatchImport();
			await apply();
			await vi.waitFor(() => {
				const button = document.querySelector<HTMLButtonElement>(
					".batch-import-modal .btn-primary",
				);
				if (button === null || button.disabled) throw new Error("batch import is not ready");
			});
			await expectFilledButton(
				".batch-import-modal .btn-primary",
				"BatchImportModal import",
				"Import 1 host",
			);

			mount(PairingCodeGenerator);
			await apply();
			await expectFilledButton(
				".gen-btn",
				"PairingCodeGenerator generate",
				"Generate Pairing Code",
			);

			mount(AgentBinaryVerify, undefined, () => {
				useAgentVerifyStore().handleAgentVerify({
					type: "AGENT_BINARY_VERIFY",
					promptId: "prompt-1",
					hostId: "host-1",
					hostname: "build.example",
					remotePath: "/usr/bin/lasterm-agent",
					remoteSha256: "abc123",
					os: "linux",
					arch: "x64",
					mismatch: false,
				});
			});
			await apply();
			await expectFilledButton(".abv-accept", "AgentBinaryVerify accept", "Trust Permanently");

			mount(AgentDeployFailed, undefined, () => {
				useAgentVerifyStore().handleDeployError(
					"Agent binary not found in cache: /tmp/lasterm-agent-linux-x64. Download it.",
					"host-1",
				);
			});
			await apply();
			await expectFilledButton(".adf-retry", "AgentDeployFailed retry", "Try Again");
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

		it(`reads light and fallback host initials in ${name}`, async () => {
			for (const [variant, color] of [
				["light", "#ffe066"],
				["fallback", undefined],
			] as const) {
				const host: Host = {
					id: "build",
					type: "ssh",
					label: "Build",
					iconType: "auto",
					...(color === undefined ? {} : { color }),
					trustRemoteHints: "ask",
					sortOrder: 0,
					os: null,
					arch: null,
					createdAt: "2026-11-23T00:00:00.000Z",
					updatedAt: "2026-11-23T00:00:00.000Z",
				};
				const expectedGround = color ?? getColorFromLabel(host.label);
				const groundProbe = document.createElement("span");
				groundProbe.style.backgroundColor = expectedGround;
				const expectedCssGround = groundProbe.style.backgroundColor;

				mount(HostRail, { recordingCount: 0 }, () => {
					const hostsStore = useHostsStore();
					hostsStore.hosts = [host];
					vi.spyOn(hostsStore, "fetchHosts").mockResolvedValue();
				});
				useThemeStore().applyTheme(theme);
				await nextTick();
				const railInitials = document.querySelector(".badge-initials");
				if (railInitials === null) throw new Error(`no ${variant} host-rail initials`);
				expect(railInitials.parentElement?.style.backgroundColor).toBe(expectedCssGround);
				const railRatio = textOnParentFill(railInitials, `${variant} host-rail initials`);
				expect(railRatio, `${variant} host-rail: ${railRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);

				mount(HostBadge, { host });
				useThemeStore().applyTheme(theme);
				await nextTick();
				const sharedInitials = document.querySelector(".host-badge__text");
				if (sharedInitials === null) throw new Error(`no ${variant} shared-host initials`);
				expect(sharedInitials.parentElement?.style.backgroundColor).toBe(expectedCssGround);
				const sharedRatio = textOnParentFill(sharedInitials, `${variant} shared-host initials`);
				expect(
					sharedRatio,
					`${variant} shared-host: ${sharedRatio.toFixed(2)}`,
				).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);

				mount(
					TabBar,
					{
						tabs: [{ id: "tab-1" }],
						activeTabIndex: 0,
						getTabLabel: () => "Build terminal",
						getActiveChannelId: () => "channel-1",
						getTabChannelIds: () => ["channel-1"],
						visibleTabIds: null,
					},
					() => {
						useHostsStore().hosts = [host];
						const channelsStore = useChannelsStore();
						channelsStore.activeHostId = "local";
						channelsStore.registerChannelHost("channel-1", host.id);
						const configStore = useConfigStore();
						configStore.uiConfig = {
							...configStore.uiConfig,
							tabs: { ...configStore.uiConfig.tabs, hostMarker: "initials" },
						};
					},
				);
				useThemeStore().applyTheme(theme);
				await nextTick();
				const tabInitials = document.querySelector(".tab__host-initials");
				if (tabInitials === null) throw new Error(`no ${variant} tab-host initials`);
				const tab = tabInitials.closest<HTMLElement>(".tab");
				expect(tab?.style.getPropertyValue("--tab-host-color")).toBe(expectedGround);
				const tabRatio = textOnFill(tabInitials, `${variant} tab-host initials`);
				expect(tabRatio, `${variant} tab-host: ${tabRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);
			}
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

		it(`reads the visible wallpaper delete control over a white image in ${name}`, async () => {
			mount(WallpaperCategory, { scope: "global" }, () => {
				useAuthStore().setToken("a".repeat(64));
				setAssetTokenForTests("asset-token");
				vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
					const url = new URL(
						input instanceof Request ? input.url : input.toString(),
						window.location.href,
					);
					if (url.pathname === "/api/wallpapers") {
						return Response.json({ wallpapers: ["white.svg"] });
					}
					return new Response("not found", { status: 404 });
				});
			});
			useThemeStore().applyTheme(theme);
			const button = await vi.waitFor(() => {
				const control = document.querySelector<HTMLButtonElement>(
					'[aria-label="Delete wallpaper white.svg"]',
				);
				if (control === null) throw new Error("no wallpaper delete control");
				return control;
			});
			const wrapper = button.closest(".wallpaper-thumb-wrapper");
			const image = wrapper?.querySelector("img");
			if (wrapper === null || image == null) throw new Error("no wallpaper thumbnail");
			await vi.waitFor(() => {
				if (!image.complete || image.naturalWidth === 0) throw new Error("wallpaper did not load");
			});

			await userEvent.hover(wrapper);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(Number(getComputedStyle(button).opacity)).toBe(1);
			const hovered = textOnImage(button, [255, 255, 255], "wallpaper delete on white image");
			expect(hovered, `wallpaper delete hover: ${hovered.toFixed(2)}`).toBeGreaterThanOrEqual(
				TEXT_CONTRAST_AA,
			);

			await userEvent.unhover(document.body);
			button.focus();
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(Number(getComputedStyle(button).opacity)).toBe(1);
			const focused = textOnImage(button, [255, 255, 255], "focused wallpaper delete");
			expect(focused, `wallpaper delete focus: ${focused.toFixed(2)}`).toBeGreaterThanOrEqual(
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
