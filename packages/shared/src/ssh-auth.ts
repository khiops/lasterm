/**
 * Whether a key path names no file: absent, or only ASCII whitespace (tab, LF,
 * VT, FF, CR, space). The hub's migration 027 tests the same characters in SQL,
 * so a path reads alike whether the hub or the migration chose the method.
 */
export function isBlankKeyPath(keyPath: string | null | undefined): boolean {
	return keyPath == null || /^[\t\n\v\f\r ]*$/.test(keyPath);
}

/**
 * The default method of an SSH host given none (#917): the key it names, else
 * the agent, as a `~/.ssh/config` entry with or without an `IdentityFile` is
 * read. The hub stores it on POST, on the import, and on a PUT that turns a
 * local host with no method into an SSH one; migration 027 applied the same
 * rule to the SSH hosts stored without one before. The New Host dialog's
 * `~/.ssh/config` picker selects it too (#1009), so a picked entry gets the
 * method an imported one is stored with.
 */
export function sshAuthFor(keyPath: string | null | undefined): "agent" | "key" {
	return isBlankKeyPath(keyPath) ? "agent" : "key";
}
