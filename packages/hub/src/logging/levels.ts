import type { LogConfig } from "@lasterm/shared";

export const LOG_SEVERITY: Record<LogConfig["level"], number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

export function severityForLevel(level: string): number | undefined {
	return LOG_SEVERITY[level as LogConfig["level"]];
}
