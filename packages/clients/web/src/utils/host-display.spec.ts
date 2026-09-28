import { describe, expect, it } from "vitest";
import { getHostSubtitle } from "./host-display.js";

// Minimal Host mock
function mockHost(overrides: Record<string, unknown> = {}) {
	return {
		id: "h1",
		label: "test",
		type: "ssh" as const,
		sshHost: "example.com",
		sshPort: 22,
		sshUser: "",
		sshAuth: "key" as const,
		sshKeyPath: "",
		iconType: "auto" as const,
		iconValue: "",
		color: "",
		hostGroup: "",
		defaultShell: "",
		historyRetentionDays: 30,
		trustRemoteHints: "apply" as const,
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("getHostSubtitle", () => {
	it("SC-26: shows full connection string with non-default port", () => {
		const host = mockHost({ sshUser: "deploy", sshHost: "web.io", sshPort: 2222 });
		expect(getHostSubtitle(host)).toBe("deploy@web.io:2222");
	});

	it("SC-27: omits port when it is 22", () => {
		const host = mockHost({ sshUser: "root", sshHost: "db.local", sshPort: 22 });
		expect(getHostSubtitle(host)).toBe("root@db.local");
	});

	it("SC-28: local host shows 'Local'", () => {
		const host = mockHost({ type: "local" });
		expect(getHostSubtitle(host)).toBe("Local");
	});

	it("shows host without user when sshUser is empty", () => {
		const host = mockHost({ sshUser: "", sshHost: "10.0.0.1", sshPort: 22 });
		expect(getHostSubtitle(host)).toBe("10.0.0.1");
	});

	it("shows host:port without user when sshUser is empty and port non-default", () => {
		const host = mockHost({ sshUser: "", sshHost: "10.0.0.1", sshPort: 3333 });
		expect(getHostSubtitle(host)).toBe("10.0.0.1:3333");
	});
});
