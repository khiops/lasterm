/**
 * The older-agent mark's motion (#1184): a ring that fades in and out, and
 * stays, still, for someone who asked their system for less motion. Computed
 * styles of a pseudo-element, which happy-dom does not give (HostRail.spec.ts
 * checks which dots carry the mark).
 */
/// <reference types="@vitest/browser-playwright" />
import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { useHostsStore } from "../stores/hosts.js";
import HostRail from "./HostRail.vue";

let app: App | null = null;

afterEach(async () => {
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

async function markedDot(): Promise<Element> {
	const pinia = createPinia();
	setActivePinia(pinia);
	const hostsStore = useHostsStore();
	const host: Host = {
		id: "pi",
		type: "ssh",
		label: "Pi",
		iconType: "auto",
		trustRemoteHints: "ask",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: "2026-11-24T00:00:00.000Z",
		updatedAt: "2026-11-24T00:00:00.000Z",
	};
	hostsStore.hosts = [host];
	vi.spyOn(hostsStore, "fetchHosts").mockResolvedValue();
	hostsStore.rememberOutdatedAgent("pi", { running: "0.15.2", expected: "0.22.1" });
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(HostRail, { recordingCount: 0 }) });
	app.use(pinia);
	app.mount(root);
	await nextTick();
	const dot = document.querySelector(".status-dot--older-agent");
	if (dot === null) throw new Error("no older-agent dot");
	return dot;
}

/** What runs on the dot's ring: the animation's target and how often it repeats. */
function ringAnimations(dot: Element): Array<[string | null, number | undefined]> {
	return dot.getAnimations({ subtree: true }).map((animation) => {
		const effect = animation.effect as KeyframeEffect;
		return [effect.pseudoElement, effect.getComputedTiming().iterations];
	});
}

describe("HostRail older-agent mark's motion (#1184)", () => {
	it("fades the ring, repeating, by default", async () => {
		expect(ringAnimations(await markedDot())).toEqual([["::after", Number.POSITIVE_INFINITY]]);
	});

	it("keeps the ring, without animating it, under reduced motion", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		const dot = await markedDot();
		expect(ringAnimations(dot)).toEqual([]);
		const ring = getComputedStyle(dot, "::after");
		expect([ring.borderTopWidth, ring.display]).toEqual(["2px", "block"]);
	});
});
