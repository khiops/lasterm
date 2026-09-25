/**
 * Which build of the UI this page runs, and how two builds compare (#560, #561).
 *
 * Shared by the hub update watcher and the service worker's page side, which
 * both ask whether something the hub offers is what this page already runs.
 */

/** The build of a side that was built with nothing to identify it. */
export const DEV_BUILD = "dev";

/**
 * This page's build. The Vite dev server replaces modules in place and reloads
 * the page itself. Its hash is the checkout's, which a hub run from the same
 * checkout can disagree with after a commit, without anything having been
 * upgraded, so it counts as `dev`.
 */
export function pageBuild(): string {
	if (import.meta.env.DEV) return DEV_BUILD;
	return import.meta.env.VITE_BUILD_HASH ?? DEV_BUILD;
}

/**
 * Both builds are a commit hash cut to 7 characters, but a build made without
 * `LASTERM_BUILD_HASH` takes `git rev-parse --short` as it comes, which can be longer.
 */
export function sameBuild(a: string, b: string): boolean {
	return a.slice(0, 7) === b.slice(0, 7);
}
