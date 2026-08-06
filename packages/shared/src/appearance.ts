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
	scrollbar: {
		style: "thin",
		thumbColor: "",
		trackColor: "",
		widthThin: 6,
		widthWide: 14,
	},
};
