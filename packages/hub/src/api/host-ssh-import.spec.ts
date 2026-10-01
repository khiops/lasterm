import { describe, expect, it } from "vitest";
import { validateSshConfigImportEntries } from "./host-ssh-import.js";

describe("validateSshConfigImportEntries", () => {
	it("accepts true for an explicit daemon choice", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: "a", sshRemoteDaemon: true }],
			}),
		).toEqual({
			entries: [{ name: "a", label: "a", sshRemoteDaemon: true }],
		});
	});

	it("accepts false for an explicit no", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: "a", sshRemoteDaemon: false }],
			}),
		).toEqual({
			entries: [{ name: "a", label: "a", sshRemoteDaemon: false }],
		});
	});

	it("accepts explicit null", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: "a", sshRemoteDaemon: null }],
			}),
		).toEqual({
			entries: [{ name: "a", label: "a", sshRemoteDaemon: null }],
		});
	});

	it("accepts an absent choice for older clients", () => {
		expect(validateSshConfigImportEntries({ entries: [{ name: "a", label: "a" }] })).toEqual({
			entries: [{ name: "a", label: "a" }],
		});
	});

	it.each(["yes", 1, {}])("refuses a non-boolean, non-null choice: %j", (sshRemoteDaemon) => {
		expect(
			validateSshConfigImportEntries({ entries: [{ name: "a", label: "a", sshRemoteDaemon }] }),
		).toEqual({ error: "sshRemoteDaemon must be a boolean or null when provided" });
	});

	it("refuses a non-string host group", () => {
		expect(
			validateSshConfigImportEntries({ entries: [{ name: "a", label: "a", hostGroup: 42 }] }),
		).toEqual({ error: "hostGroup must be a string when provided" });
	});
});
