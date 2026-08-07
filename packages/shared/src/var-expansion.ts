/**
 * Variable expansion for lasterm launch profiles.
 *
 * Grammar (one-pass, left-to-right):
 *   ${VAR_NAME}   → replaced with env[VAR_NAME] (or process.env fallback)
 *                   VAR_NAME matches [A-Za-z_][A-Za-z0-9_]*
 *                   If not found → keep literal "${VAR_NAME}"
 *   \${VAR_NAME}  → literal "${VAR_NAME}" (backslash consumed)
 *   \\${VAR_NAME} → literal "\" + expanded value of VAR_NAME
 *   $VAR (unbraced) → NOT expanded
 *   No recursion: expanded values are not re-scanned
 *
 * Applied to: args[] items, cwd, env values (NOT env keys, NOT shell)
 *
 * @param input  - The string to expand
 * @param env    - Profile-level env overrides (looked up first)
 * @param caseInsensitive - When true, env key lookup is case-insensitive (Windows)
 */
export function expandVars(
	input: string,
	env?: Record<string, string>,
	caseInsensitive?: boolean,
): string {
	// Single-pass regex matching (highest priority first via ordering):
	//   Group 1: \\${VAR}  — literal backslash + expand VAR  (captured: varName in group 2)
	//   Group 3: \${VAR}   — literal "${VAR}" no expansion    (captured: varName in group 4)
	//   Group 5: ${VAR}    — normal expansion                  (captured: varName in group 5 — wait, reindex)
	//
	// Simpler: use a single alternation and inspect which branch matched.
	//
	// The regex below matches:
	//   (\\\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}   ← escaped backslash + var: emit "\" + expand
	//   (\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}     ← escaped dollar: emit "${varName}"
	//   \$\{([A-Za-z_][A-Za-z0-9_]*)\}         ← normal expansion
	//
	// Group indices:
	//   m[1] = "\\\\" prefix (backslash case)
	//   m[2] = varName for backslash case
	//   m[3] = "\\" prefix (escaped dollar case)
	//   m[4] = varName for escaped dollar case
	//   m[5] = varName for normal case
	const RE =
		/(\\\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

	return input.replace(
		RE,
		(
			_match,
			_bs: string | undefined,
			bsVar: string | undefined,
			_esc: string | undefined,
			escVar: string | undefined,
			plainVar: string | undefined,
		) => {
			if (bsVar !== undefined) {
				// \\${VAR} → literal "\" + expanded value of VAR
				const value = lookupEnv(bsVar, env, caseInsensitive);
				return value !== undefined ? `\\${value}` : `\\\${${bsVar}}`;
			}
			if (escVar !== undefined) {
				// \${VAR} → literal "${VAR}" (no expansion)
				return `\${${escVar}}`;
			}
			if (plainVar !== undefined) {
				// ${VAR} → expand or keep literal
				const value = lookupEnv(plainVar, env, caseInsensitive);
				return value !== undefined ? value : `\${${plainVar}}`;
			}
			return _match;
		},
	);
}

/**
 * Look up a variable name in the provided env map (first) then process.env (fallback).
 * On Windows (caseInsensitive=true) the lookup is done case-insensitively.
 */
function lookupEnv(
	name: string,
	env: Record<string, string> | undefined,
	caseInsensitive: boolean | undefined,
): string | undefined {
	if (env !== undefined) {
		if (caseInsensitive) {
			const lower = name.toLowerCase();
			for (const [k, v] of Object.entries(env)) {
				if (k.toLowerCase() === lower) return v;
			}
		} else {
			const v = env[name];
			if (v !== undefined) return v;
		}
	}

	// Fall back to process.env
	if (caseInsensitive) {
		const lower = name.toLowerCase();
		for (const [k, v] of Object.entries(process.env)) {
			if (k.toLowerCase() === lower && v !== undefined) return v;
		}
		return undefined;
	}
	return process.env[name];
}
