/**
 * What the desktop window says when the hub it was using has died (#143).
 * Local terminals live in the agent, not the hub, so they survive it and a
 * new hub reattaches them; the message says so rather than leaving the
 * terminals on "Reconnecting" for ever.
 */
export function hubExitMessage(code: number | null): string {
	const how = code === null ? "stopped" : `stopped with exit code ${code}`;
	return (
		`The Lasterm hub ${how}, so this window can no longer reach your terminals. ` +
		"Terminals on this computer keep running: restart the hub to reconnect to them."
	);
}
