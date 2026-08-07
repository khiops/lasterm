// biome-ignore-all lint/suspicious/noTemplateCurlyInString: test data intentionally contains literal ${} to exercise the expansion-under-test
import { describe, expect, it } from "vitest";
import { expandVars } from "./var-expansion.js";

describe("expandVars", () => {
	// SC-13: Basic substitution
	it("SC-13: expands ${VAR_NAME} with the value from env", () => {
		expect(expandVars("${HOME}/projects", { HOME: "/home/user" })).toBe("/home/user/projects");
	});

	// SC-14: Escaped dollar — \${VAR} → literal "${VAR}"
	it("SC-14: \\${VAR} produces literal ${VAR} (backslash consumed)", () => {
		// Runtime string: \${HOME}   (one backslash + dollar-brace)
		expect(expandVars("\\${HOME}", { HOME: "/home/user" })).toBe("${HOME}");
	});

	// SC-15: Escaped backslash before var — \\${VAR} → "\" + expanded
	it("SC-15: \\\\${VAR} produces literal backslash + expanded value", () => {
		// Runtime string: \\${HOME}  (two backslashes + dollar-brace)
		// HOME = "home/user" (no leading slash) so result is \home/user
		expect(expandVars("\\\\${HOME}", { HOME: "home/user" })).toBe("\\home/user");
	});

	// SC-16: Unbraced $VAR is NOT expanded
	it("SC-16: $VAR (no braces) is not expanded", () => {
		expect(expandVars("$HOME/projects", { HOME: "/home/user" })).toBe("$HOME/projects");
	});

	// SC-17: Undefined var kept as literal
	it("SC-17: ${UNDEFINED_VAR} with missing key keeps literal", () => {
		expect(expandVars("${UNDEFINED_VAR}", {})).toBe("${UNDEFINED_VAR}");
	});

	// Case-insensitive lookup (Windows)
	it("case-insensitive lookup matches uppercase env key from lowercase ref", () => {
		// Pass a dedicated env so we don't rely on process.env
		expect(expandVars("${home}", { HOME: "/home" }, true)).toBe("/home");
	});

	it("case-insensitive lookup matches lowercase env key from uppercase ref", () => {
		expect(expandVars("${HOME}", { home: "/home" }, true)).toBe("/home");
	});

	// Multiple variables in one string
	it("expands multiple variables in one string", () => {
		const env = { USER: "alice", HOST: "dev-box" };
		expect(expandVars("${USER}@${HOST}", env)).toBe("alice@dev-box");
	});

	// No recursion: expanded value is NOT re-scanned
	it("does not recursively expand expanded values", () => {
		const env = { A: "${B}", B: "hello" };
		// ${A} → "${B}" — the resulting "${B}" must NOT be expanded further
		expect(expandVars("${A}", env)).toBe("${B}");
	});

	// Empty string
	it("returns empty string unchanged", () => {
		expect(expandVars("", { HOME: "/home" })).toBe("");
	});

	// No variables in string
	it("returns string unchanged when no ${} present", () => {
		expect(expandVars("hello world", { HOME: "/home" })).toBe("hello world");
	});

	// env undefined (no overrides — only process.env)
	it("handles undefined env (only process.env fallback)", () => {
		// Use a var that is NOT in process.env (extremely unlikely name)
		expect(expandVars("${__LASTERM_NONEXISTENT_VAR_XYZ__}")).toBe(
			"${__LASTERM_NONEXISTENT_VAR_XYZ__}",
		);
	});

	// Mixed escaped and plain in one string
	it("handles mixed escaped and plain expansions in same string", () => {
		const env = { A: "alpha", B: "beta" };
		expect(expandVars("${A} and \\${B}", env)).toBe("alpha and ${B}");
	});

	// Escaped backslash before undefined var — backslash emitted, var kept
	it("\\\\${UNDEFINED} produces backslash + literal ${UNDEFINED} when not found", () => {
		expect(expandVars("\\\\${UNDEFINED_XYZ}", {})).toBe("\\${UNDEFINED_XYZ}");
	});

	// VAR_NAME with underscores and digits
	it("expands VAR_NAME with underscores and digits", () => {
		const env = { MY_VAR_2: "hello" };
		expect(expandVars("${MY_VAR_2}", env)).toBe("hello");
	});

	// VAR_NAME starting with underscore
	it("expands VAR_NAME starting with underscore", () => {
		const env = { _PRIVATE: "secret" };
		expect(expandVars("${_PRIVATE}", env)).toBe("secret");
	});

	// Adjacent variables
	it("expands adjacent ${VAR} references", () => {
		const env = { FIRST: "foo", SECOND: "bar" };
		expect(expandVars("${FIRST}${SECOND}", env)).toBe("foobar");
	});

	// case-sensitive (default): same-name different case treated as different
	it("case-sensitive by default: ${HOME} matches HOME env key exactly", () => {
		// Confirming the positive case with exact match
		expect(expandVars("${HOME}", { HOME: "/home" })).toBe("/home");
	});
});
