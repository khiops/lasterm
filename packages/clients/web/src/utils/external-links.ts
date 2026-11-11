/**
 * The pages outside the app that the web client links to. A component links
 * out only to a page named here.
 *
 * In the desktop, the shell plugin opens these links itself, and only those its
 * scope accepts: `plugins.shell.open` in tauri.conf.json. It refuses any other
 * link without a word. packages/clients/desktop/tauri-config.spec.ts checks
 * each page here against that scope.
 */
export const EXTERNAL_LINKS = {
	website: "https://o2csi.com",
	repository: "https://github.com/khiops/lasterm",
	issues: "https://github.com/khiops/lasterm/issues",
	latestRelease: "https://github.com/khiops/lasterm/releases/latest",
	keepingTheAgentRunning:
		"https://github.com/khiops/lasterm/blob/main/docs/SSH_SERVER.md#keeping-the-agent-running-79",
	updatePathIssue: "https://github.com/khiops/lasterm/issues/94",
} as const;
