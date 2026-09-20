import type { Scope } from "../../stores/settings.js";

export interface CategoryDef {
	id: string;
	label: string;
	scopes: Scope[];
	desktopOnly?: boolean;
}

export const ALL_CATEGORIES: CategoryDef[] = [
	{ id: "appearance", label: "Appearance", scopes: ["global", "host", "channel"] },
	{ id: "wallpaper", label: "Wallpaper", scopes: ["global", "host", "channel"] },
	{ id: "terminal", label: "Terminal", scopes: ["global", "host", "channel"] },
	{ id: "environment", label: "Environment", scopes: ["global", "host", "channel"] },
	{ id: "tabs", label: "Tabs", scopes: ["global"] },
	{ id: "confirmations", label: "Confirmations", scopes: ["global"] },
	{ id: "channels", label: "Channels", scopes: ["global"] },
	{ id: "panes", label: "Panes", scopes: ["global"] },
	{ id: "search", label: "Search", scopes: ["global"] },
	{ id: "startup", label: "Startup", scopes: ["global"] },
	{ id: "elevation", label: "Elevation", scopes: ["global"] },
	{ id: "desktop", label: "Desktop", scopes: ["global"], desktopOnly: true },
	{ id: "agents", label: "Agents", scopes: ["global"] },
	{ id: "profiles", label: "Profiles", scopes: ["global"] },
	{ id: "keybindings", label: "Keybindings", scopes: ["global"] },
];

export function getVisibleSettingsCategories(scope: Scope, showDesktop: boolean): CategoryDef[] {
	return ALL_CATEGORIES.filter(
		(cat) => cat.scopes.includes(scope) && (!cat.desktopOnly || showDesktop),
	);
}
