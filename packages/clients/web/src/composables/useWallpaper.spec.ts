import type { TerminalProfile } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { setAssetTokenForTests, setHubPortForTests } from "../utils/hub-url.js";
import { useWallpaper } from "./useWallpaper.js";

function makeProfile(overrides: Partial<TerminalProfile> = {}): TerminalProfile {
	return {
		fontFamily: "monospace",
		fontSize: 14,
		theme: "dark",
		cursorStyle: "block",
		scrollback: 5000,
		bellSound: false,
		scrollbarMarkers: true,
		wallpaper: "",
		wallpaperBlur: 0,
		wallpaperDim: 0,
		...overrides,
	};
}

describe("useWallpaper", () => {
	afterEach(() => {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		setAssetTokenForTests(null);
		setHubPortForTests(null);
		vi.restoreAllMocks();
	});

	describe("wallpaperStyle", () => {
		it("should return null when wallpaper is empty", () => {
			// Arrange
			const profile = ref(makeProfile());

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value).toBeNull();
		});

		it("should return style with background-image when wallpaper is set", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "mountains.jpg" }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value).not.toBeNull();
			expect(wallpaperStyle.value?.backgroundImage).toContain("mountains.jpg");
			expect(wallpaperStyle.value?.backgroundSize).toBe("cover");
			expect(wallpaperStyle.value?.backgroundPosition).toBe("center");
		});

		it("should encode special characters in wallpaper filename", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "my image (1).jpg" }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value?.backgroundImage).toContain(
				encodeURIComponent("my image (1).jpg"),
			);
		});

		it("should include blur filter when wallpaperBlur > 0", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperBlur: 10 }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value?.filter).toBe("blur(10px)");
			expect(wallpaperStyle.value?.willChange).toBe("filter");
		});

		it("should not include blur filter when wallpaperBlur is 0", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperBlur: 0 }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value?.filter).toBeUndefined();
			expect(wallpaperStyle.value?.willChange).toBeUndefined();
		});

		it("should include cache-busting query parameter", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png" }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value?.backgroundImage).toMatch(/[?&]t=\d+/);
		});

		it("should include the asset token query parameter when initialized", () => {
			// Arrange
			setAssetTokenForTests("asset-test-token");
			const profile = ref(makeProfile({ wallpaper: "bg.png" }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert
			expect(wallpaperStyle.value?.backgroundImage).toContain("asset_token=asset-test-token");
		});

		it("should re-run and include asset_token when token arrives after first render (pairing path)", async () => {
			// Arrange — token NOT yet set (simulates pairing path: token arrives after boot)
			const profile = ref(makeProfile({ wallpaper: "bg.png" }));
			const { wallpaperStyle } = useWallpaper(profile);

			// Assert — first render: no token in URL
			expect(wallpaperStyle.value?.backgroundImage).not.toContain("asset_token=");

			// Act — token arrives (e.g. after pairing flow completes)
			setAssetTokenForTests("late-token");
			await nextTick();

			// Assert — computed must have re-run and now includes the token
			expect(wallpaperStyle.value?.backgroundImage).toContain("asset_token=late-token");
		});

		it("loads desktop wallpaper through a blob URL rather than a plaintext hub URL", async () => {
			// Arrange
			Object.defineProperty(window, "__TAURI_INTERNALS__", {
				value: {
					invoke: async (command: string) =>
						command === "relay_hub_request"
							? { id: 1, status: 204, statusText: "No Content", headers: [] }
							: undefined,
					transformCallback: () => 1,
				},
				configurable: true,
			});
			vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:lasterm-wallpaper");
			// The desktop shell resolves the port before any URL is built; there is no
			// default to fall back on, so a test that builds one must resolve it too.
			setHubPortForTests(4100);
			const profile = ref(makeProfile({ wallpaper: "desktop image.jpg" }));

			// Act
			const { wallpaperStyle } = useWallpaper(profile);
			await vi.waitFor(() => {
				expect(wallpaperStyle.value?.backgroundImage).toBe("url(blob:lasterm-wallpaper)");
			});

			// Assert
			expect(wallpaperStyle.value?.backgroundImage).toBe("url(blob:lasterm-wallpaper)");
			expect(wallpaperStyle.value?.backgroundImage).not.toContain("http://");
		});
	});

	describe("dimStyle", () => {
		it("should return null when wallpaper is empty", () => {
			// Arrange
			const profile = ref(makeProfile());

			// Act
			const { dimStyle } = useWallpaper(profile);

			// Assert
			expect(dimStyle.value).toBeNull();
		});

		it("should return null when wallpaperDim is 0", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperDim: 0 }));

			// Act
			const { dimStyle } = useWallpaper(profile);

			// Assert
			expect(dimStyle.value).toBeNull();
		});

		it("should return rgba overlay when wallpaperDim > 0", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperDim: 40 }));

			// Act
			const { dimStyle } = useWallpaper(profile);

			// Assert
			expect(dimStyle.value).not.toBeNull();
			expect(dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.4)");
		});

		it("should return full opacity at 100%", () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperDim: 100 }));

			// Act
			const { dimStyle } = useWallpaper(profile);

			// Assert
			expect(dimStyle.value?.background).toBe("rgba(0, 0, 0, 1)");
		});
	});

	describe("refreshCache", () => {
		it("should change cache-busting parameter", async () => {
			// Arrange
			const profile = ref(makeProfile({ wallpaper: "bg.png" }));
			const { wallpaperStyle, refreshCache } = useWallpaper(profile);
			const urlBefore = wallpaperStyle.value?.backgroundImage;

			// Act — wait a bit so Date.now() changes
			await new Promise((r) => setTimeout(r, 5));
			refreshCache();

			// Assert
			const urlAfter = wallpaperStyle.value?.backgroundImage;
			expect(urlAfter).not.toBe(urlBefore);
		});
	});
});
