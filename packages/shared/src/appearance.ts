// Appearance configuration for lasterm UI chrome

export interface AppearanceConfig {
	theme: string;
	autoSwitch: {
		enabled: boolean;
		darkTheme: string;
		lightTheme: string;
	};
	opacity: {
		terminal: number; // 0-100
		sidebar: number;
		hostRail: number;
		tabBar: number;
	};
	/** What the window itself does with what is behind it. */
	window: {
		/**
		 * How much to darken what shows through a see-through window, 0-100.
		 *
		 * Distinct from `wallpaper.dim`, which veils a wallpaper image and does
		 * nothing without one. This one veils whatever is behind the window —
		 * another window, the desktop — and so has something to do only when the
		 * window is see-through. Nothing here can *blur* what is behind: that is
		 * the compositor's to do, and it is called acrylic.
		 */
		dim: number;
	};
	scrollbar: {
		style: "thin" | "wide" | "hidden";
		thumbColor: string; // empty = from theme
		trackColor: string; // empty = from theme
		widthThin: number; // px
		widthWide: number; // px
	};
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
	theme: "catppuccin-mocha",
	autoSwitch: {
		enabled: false,
		darkTheme: "catppuccin-mocha",
		lightTheme: "one-half-light",
	},
	opacity: {
		terminal: 100,
		sidebar: 100,
		hostRail: 100,
		tabBar: 100,
	},
	window: {
		dim: 0,
	},
	scrollbar: {
		style: "thin",
		thumbColor: "",
		trackColor: "",
		widthThin: 6,
		widthWide: 14,
	},
};
