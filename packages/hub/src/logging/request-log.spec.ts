import { describe, expect, it } from "vitest";
import { redactUrl, withholdSecretsFromLine } from "./request-log.js";

describe("redactUrl", () => {
	it("keeps the path and the parameter names, and withholds every value", () => {
		expect(redactUrl("/public/fonts/a.woff2?asset_token=abc&force=1")).toBe(
			"/public/fonts/a.woff2?asset_token=[redacted]&force=[redacted]",
		);
		expect(redactUrl("/api/hosts")).toBe("/api/hosts");
	});

	it("withholds a bare value, or one whose name is not a name, whole", () => {
		expect(redactUrl("/api/logs?typed-secret&q=x")).toBe("/api/logs?[redacted]&q=[redacted]");
		expect(redactUrl("/x?a%20b=c")).toBe("/x?[redacted]");
	});
});

describe("withholdSecretsFromLine", () => {
	it("redacts an asset token wherever a line carries one, and leaves the line valid JSON", () => {
		const line = `${JSON.stringify({ msg: 'Reply already sent in "/x?a=1&asset_token=s3cr3t-_x" route' })}\n`;
		const withheld = withholdSecretsFromLine(line);
		expect(withheld).not.toContain("s3cr3t");
		expect(JSON.parse(withheld)).toEqual({
			msg: 'Reply already sent in "/x?a=1&asset_token=[redacted]" route',
		});
	});
});
