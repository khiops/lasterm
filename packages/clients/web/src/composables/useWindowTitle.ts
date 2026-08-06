import { onScopeDispose, type Ref, watch } from "vue";

const DEFAULT_TITLE = "lasterm";

/**
 * Replace {prefix}, {host}, {title}, {channel}, {shell} tokens in a format string.
 *
 * When a variable is empty/undefined, replaces with empty string.
 * Trailing separator (` - ` or ` \u2014 `) is trimmed from the result.
 * Leading separator is also trimmed.
 * Consecutive separators from missing tokens are collapsed.
 */
export function formatWindowTitle(
	format: string,
	vars: {
		prefix?: string;
		host?: string;
		title?: string;
		channel?: string;
		shell?: string;
	},
): string {
	let result = format
		.replace(/\{prefix\}/g, vars.prefix ?? "")
		.replace(/\{host\}/g, vars.host ?? "")
		.replace(/\{title\}/g, vars.title ?? "")
		.replace(/\{channel\}/g, vars.channel ?? "")
		.replace(/\{shell\}/g, vars.shell ?? "");

	// Trim trailing separators (` - ` or ` — `)
	result = result.replace(/(?:\s[-\u2014]\s)+$/, "");
	// Trim leading separators
	result = result.replace(/^(?:\s[-\u2014]\s)+/, "");
	// Collapse duplicate separators caused by adjacent missing tokens
	result = result.replace(/(\s[-\u2014]\s){2,}/g, "$1");
	// Trim any trailing/leading whitespace
	result = result.trim();

	return result || DEFAULT_TITLE;
}

/**
 * Reactively update `document.title` based on the currently active terminal.
 *
 * When `enabled` is false, resets to "lasterm".
 * Debounces updates by 100ms to avoid excessive reflow from rapid title changes.
 * Cleans up on scope disposal (restores default title).
 */
export function useWindowTitle(options: {
	enabled: Ref<boolean>;
	format: Ref<string>;
	activeTitle: Ref<string>;
	activeHost: Ref<string>;
	activePrefix: Ref<string>;
}): void {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function update(): void {
		if (!options.enabled.value) {
			document.title = DEFAULT_TITLE;
			return;
		}

		const formatted = formatWindowTitle(options.format.value, {
			prefix: options.activePrefix.value,
			host: options.activeHost.value,
			title: options.activeTitle.value,
		});
		document.title = formatted;
	}

	function debouncedUpdate(): void {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			update();
		}, 100);
	}

	// Watch all reactive inputs
	watch(
		[
			options.enabled,
			options.format,
			options.activeTitle,
			options.activeHost,
			options.activePrefix,
		],
		() => {
			if (!options.enabled.value) {
				// Disable immediately (no debounce)
				if (debounceTimer !== null) {
					clearTimeout(debounceTimer);
					debounceTimer = null;
				}
				document.title = DEFAULT_TITLE;
			} else {
				debouncedUpdate();
			}
		},
		{ immediate: true },
	);

	onScopeDispose(() => {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		document.title = DEFAULT_TITLE;
	});
}
