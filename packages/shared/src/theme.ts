// Theme type system and validation for lasterm

export interface LastermThemeColors {
	foreground: string;
	background: string;
	cursor: string;
	cursorAccent?: string;
	selectionBackground: string;
	selectionForeground?: string;
	black: string;
	red: string;
	green: string;
	yellow: string;
	blue: string;
	magenta: string;
	cyan: string;
	white: string;
	brightBlack: string;
	brightRed: string;
	brightGreen: string;
	brightYellow: string;
	brightBlue: string;
	brightMagenta: string;
	brightCyan: string;
	brightWhite: string;
}

export interface LastermThemeUi {
	tabBar: string;
	tabActive: string;
	tabInactive: string;
	tabHover: string;
	sidebar: string;
	sidebarText: string;
	sidebarActive: string;
	hostRail: string;
	border: string;
	accent: string;
	badge: string;
	scrollbarThumb: string;
	scrollbarTrack: string;
	searchHighlight: string;
	searchHighlightActive: string;
	badgeInfo?: string;
	badgeWarning?: string;
	badgeSuccess?: string;
	badgeDanger?: string;
}

export interface LastermTheme {
	name: string;
	author?: string;
	type: "dark" | "light";
	colors: LastermThemeColors;
	ui: LastermThemeUi;
}

export const THEME_NAME_REGEX = /^[a-z0-9-]+$/;

export const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const REQUIRED_COLOR_FIELDS = [
	"foreground",
	"background",
	"cursor",
	"selectionBackground",
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const;

export const REQUIRED_UI_FIELDS = [
	"tabBar",
	"tabActive",
	"tabInactive",
	"tabHover",
	"sidebar",
	"sidebarText",
	"sidebarActive",
	"hostRail",
	"border",
	"accent",
	"badge",
	"scrollbarThumb",
	"scrollbarTrack",
	"searchHighlight",
	"searchHighlightActive",
] as const;

/**
 * Validates a theme object. Returns specific error messages for each issue.
 */
export function validateTheme(input: unknown): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (input == null || typeof input !== "object" || Array.isArray(input)) {
		return { valid: false, errors: ["theme must be a non-null object"] };
	}

	const theme = input as Record<string, unknown>;

	// name
	if (typeof theme.name !== "string") {
		errors.push("name is required and must be a string");
	} else if (!THEME_NAME_REGEX.test(theme.name)) {
		errors.push("name must match /^[a-z0-9-]+$/ (lowercase alphanumeric and hyphens)");
	}

	// type
	if (typeof theme.type !== "string") {
		errors.push("type is required and must be a string");
	} else if (theme.type !== "dark" && theme.type !== "light") {
		errors.push('type must be "dark" or "light"');
	}

	// colors
	if (theme.colors == null || typeof theme.colors !== "object" || Array.isArray(theme.colors)) {
		errors.push("colors is required and must be an object");
	} else {
		const colors = theme.colors as Record<string, unknown>;
		for (const field of REQUIRED_COLOR_FIELDS) {
			if (typeof colors[field] !== "string") {
				errors.push(`colors.${field} is required and must be a string`);
			} else if (!HEX_COLOR_REGEX.test(colors[field])) {
				errors.push(`colors.${field} must be a valid hex color (#RRGGBB or #RRGGBBAA)`);
			}
		}
	}

	// ui
	if (theme.ui == null || typeof theme.ui !== "object" || Array.isArray(theme.ui)) {
		errors.push("ui is required and must be an object");
	} else {
		const ui = theme.ui as Record<string, unknown>;
		for (const field of REQUIRED_UI_FIELDS) {
			if (typeof ui[field] !== "string") {
				errors.push(`ui.${field} is required and must be a string`);
			} else if (!HEX_COLOR_REGEX.test(ui[field])) {
				errors.push(`ui.${field} must be a valid hex color (#RRGGBB or #RRGGBBAA)`);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}
