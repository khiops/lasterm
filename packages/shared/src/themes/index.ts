import type { LastermTheme } from "../theme.js";
import { catppuccinMocha } from "./catppuccin-mocha.js";
import { dracula } from "./dracula.js";
import { githubLight } from "./github-light.js";
import { gruvboxDark } from "./gruvbox-dark.js";
import { nord } from "./nord.js";
import { oneHalfDark } from "./one-half-dark.js";
import { oneHalfLight } from "./one-half-light.js";
import { solarizedLight } from "./solarized-light.js";
import { tokyoNight } from "./tokyo-night.js";

export const BUNDLED_THEMES: Record<string, LastermTheme> = {
	"one-half-dark": oneHalfDark,
	"catppuccin-mocha": catppuccinMocha,
	dracula: dracula,
	nord: nord,
	"tokyo-night": tokyoNight,
	"gruvbox-dark": gruvboxDark,
	"one-half-light": oneHalfLight,
	"solarized-light": solarizedLight,
	"github-light": githubLight,
};

export const BUNDLED_THEME_NAMES = new Set(Object.keys(BUNDLED_THEMES));

export const DEFAULT_THEME_NAME = "catppuccin-mocha";
