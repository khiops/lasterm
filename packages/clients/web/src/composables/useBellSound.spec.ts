import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { useAuthStore } from "../stores/auth.js";
import { resetAssetHolderForTests } from "../utils/asset-holder.js";
import { setAssetTokenForTests, setHubPortForTests } from "../utils/hub-url.js";
import { playBellSound } from "./useBellSound.js";

/** An Audio double that fires the events a real one fires. */
function fakeAudio(
	play: () => Promise<void>,
): EventTarget & { play: MockInstance; volume: number } {
	return Object.assign(new EventTarget(), { play: vi.fn(play), volume: 0 });
}

describe("playBellSound", () => {
	describe("mute mode", () => {
		it("does nothing when sound is mute", () => {
			// Should not throw
			expect(() => playBellSound({ sound: "mute" })).not.toThrow();
		});
	});

	describe("custom sound — extension validation", () => {
		let mockAudio: EventTarget & { play: MockInstance; volume: number };
		let AudioSpy: MockInstance;
		let warnSpy: MockInstance;

		beforeEach(() => {
			setAssetTokenForTests("sound-token");
			mockAudio = fakeAudio(async () => undefined);
			AudioSpy = vi
				// biome-ignore lint/suspicious/noExplicitAny: spying on the global Audio constructor with a partial test double; the real HTMLAudioElement ctor type does not match the mock and MockInstance<any> is needed to assign the spy
				.spyOn(globalThis, "Audio" as any)
				.mockReturnValue(mockAudio as never);
			warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		});

		afterEach(() => {
			setAssetTokenForTests(null);
			setHubPortForTests(null);
			Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
			AudioSpy.mockRestore();
			warnSpy.mockRestore();
		});

		it.each([".wav", ".mp3", ".ogg", ".m4a"])("accepts valid extension %s", async (ext) => {
			playBellSound({ sound: "custom", customSoundFile: `bell${ext}` });
			await vi.waitFor(() =>
				expect(AudioSpy).toHaveBeenCalledWith(`/public/sounds/bell${ext}?asset_token=sound-token`),
			);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("rejects invalid extension and logs a warning", () => {
			playBellSound({ sound: "custom", customSoundFile: "bell.exe" });
			expect(AudioSpy).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid audio extension"));
		});

		it("rejects extension-less filename and logs a warning", () => {
			playBellSound({ sound: "custom", customSoundFile: "bellfile" });
			expect(AudioSpy).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid audio extension"));
		});

		it("rejects path traversal filename and does not play", () => {
			playBellSound({ sound: "custom", customSoundFile: "../sounds/bell.mp3" });
			// Path traversal guard fires before extension check — no Audio, no warn
			expect(AudioSpy).not.toHaveBeenCalled();
		});

		it("is case-insensitive for extension check", async () => {
			playBellSound({ sound: "custom", customSoundFile: "BELL.MP3" });
			await vi.waitFor(() =>
				expect(AudioSpy).toHaveBeenCalledWith("/public/sounds/BELL.MP3?asset_token=sound-token"),
			);
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe("on the desktop, the sound's blob is given back once it is done (#194)", () => {
		let revoked: string[];

		beforeEach(() => {
			setActivePinia(createPinia());
			useAuthStore().setToken("bearer-1");
			Object.defineProperty(window, "__TAURI_INTERNALS__", {
				value: { invoke: () => undefined },
				configurable: true,
			});
			setHubPortForTests(4100);
			revoked = [];
			vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bell");
			vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
				revoked.push(url);
			});
			mocks.hubFetch.mockReset();
			mocks.hubFetch.mockImplementation(async () => new Response("RIFF", { status: 200 }));
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			resetAssetHolderForTests();
			setHubPortForTests(null);
			Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
			vi.restoreAllMocks();
		});

		/** Replaces the global Audio with one that records what it was made with. */
		function stubAudio(play: () => Promise<void>): Array<EventTarget & { src: string }> {
			const made: Array<EventTarget & { src: string }> = [];
			vi.stubGlobal(
				"Audio",
				class FakeAudio extends EventTarget {
					volume = 0;
					src: string;
					constructor(src: string) {
						super();
						this.src = src;
						made.push(this);
					}
					play(): Promise<void> {
						return play();
					}
				},
			);
			return made;
		}

		it.each(["ended", "error"])("revokes it once after the %s event", async (event) => {
			const made = stubAudio(async () => undefined);

			playBellSound({ sound: "custom", customSoundFile: "bell.mp3" });
			await vi.waitFor(() => expect(made[0]?.src).toBe("blob:bell"));
			expect(revoked).toEqual([]);
			made[0]?.dispatchEvent(new Event(event));
			made[0]?.dispatchEvent(new Event(event));

			expect(revoked).toEqual(["blob:bell"]);
		});

		it("revokes it once when playing is refused", async () => {
			stubAudio(() => Promise.reject(new DOMException("autoplay", "NotAllowedError")));

			playBellSound({ sound: "custom", customSoundFile: "bell.mp3" });

			await vi.waitFor(() => expect(revoked).toEqual(["blob:bell"]));
		});

		it("revokes it once when the Audio element cannot be made", async () => {
			// biome-ignore lint/suspicious/noExplicitAny: the global Audio constructor, replaced by a failing double
			vi.spyOn(globalThis, "Audio" as any).mockImplementation(() => {
				throw new Error("no audio");
			});

			playBellSound({ sound: "custom", customSoundFile: "bell.mp3" });

			await vi.waitFor(() => expect(revoked).toEqual(["blob:bell"]));
		});
	});
});
