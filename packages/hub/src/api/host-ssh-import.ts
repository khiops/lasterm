import type { Host, SshConfigImport } from "@lasterm/shared";
import { jumpLinkFor, sshAuthFor, toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { ParseResult } from "../ssh/ssh-config-parser.js";
import { readSshConfig } from "../ssh/ssh-config-parser.js";
import type { MetaDAL } from "../storage/meta.js";
import type { AnnounceHostsChange } from "./hosts-changed.js";

type SshConfigImportValidation = { entries: SshConfigImport[] } | { error: string };
type SshConfigImportRequestBodyFromUntrustedJson = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Validate and narrow the JSON body before an import can create any host. */
export function validateSshConfigImportEntries(body: unknown): SshConfigImportValidation {
	if (!isRecord(body) || !Array.isArray(body.entries) || body.entries.length === 0) {
		return { error: "entries must be a non-empty array" };
	}

	const entries: SshConfigImport[] = [];
	for (const value of body.entries) {
		if (
			!isRecord(value) ||
			typeof value.name !== "string" ||
			value.name.length === 0 ||
			typeof value.label !== "string"
		) {
			return { error: "Each entry must have name and label" };
		}
		const trimmedLabel = value.label.trim();
		// SSH config aliases can contain +, @, and :, so imports intentionally skip create-host's character class.
		if (trimmedLabel.length === 0) {
			return { error: "Label is required" };
		}
		if (trimmedLabel.length > 64) {
			return { error: "Label must be 64 characters or fewer" };
		}
		const sshRemoteDaemon = value.sshRemoteDaemon;
		if (
			sshRemoteDaemon !== undefined &&
			sshRemoteDaemon !== null &&
			typeof sshRemoteDaemon !== "boolean"
		) {
			return { error: "sshRemoteDaemon must be a boolean or null when provided" };
		}
		entries.push({
			name: value.name,
			label: value.label,
			...(sshRemoteDaemon !== undefined && { sshRemoteDaemon }),
		});
	}

	return { entries };
}

/**
 * Link a host's `ProxyJump` to the saved bastion it names, when
 * `jumpLinkFor` finds one; otherwise the host keeps it as written (#1040).
 * `candidates` is the hub's hosts, read once by the caller for a whole import.
 */
export function linkHostToProxyJump(
	metaDal: MetaDAL,
	host: Host,
	candidates: readonly Host[],
): Host {
	if (!host.sshProxySpec) return host;
	const bastion = jumpLinkFor(host.sshProxySpec, candidates, host.id);
	if (!bastion) return host;
	return metaDal.updateHost(host.id, {
		sshProxyHostId: bastion.id,
		sshProxySpec: null,
	});
}

/**
 * @param announce Tells every client the hosts changed: once for the whole
 * import, however many hosts it adds (#783).
 */
export function registerHostSshImportRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	announce: AnnounceHostsChange = () => {},
): void {
	// GET /api/ssh-config — parse user's ~/.ssh/config
	server.get("/api/ssh-config", async (_request, reply) => {
		try {
			const result = readSshConfig();
			return { entries: toSnakeCase(result.entries), has_include: result.hasInclude };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return reply.code(404).send({
					error: {
						code: "NOT_FOUND",
						message: "No SSH config file found at ~/.ssh/config",
					},
				});
			}
			throw err;
		}
	});

	// POST /api/hosts/import — batch import hosts from SSH config
	server.post<{ Body: SshConfigImportRequestBodyFromUntrustedJson }>(
		"/api/hosts/import",
		async (request, reply) => {
			const validation = validateSshConfigImportEntries(request.body);
			if ("error" in validation) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: validation.error,
					},
				});
			}
			const { entries } = validation;

			// Parse SSH config to get full details
			let sshResult: ParseResult;
			try {
				sshResult = readSshConfig();
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return reply.code(404).send({
						error: {
							code: "NOT_FOUND",
							message: "No SSH config file found at ~/.ssh/config",
						},
					});
				}
				throw err;
			}

			// Build lookup map by name
			const entryMap = new Map(sshResult.entries.map((e) => [e.name, e]));

			// Validate all entries have matching SSH config entries
			for (const entry of entries) {
				if (!entryMap.has(entry.name)) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: `SSH config entry not found: ${entry.name}`,
						},
					});
				}
			}

			// Check ALL labels for conflicts before creating any
			const seenLabels = new Set<string>();
			const conflictingLabels = new Set<string>();
			for (const entry of entries) {
				const label = entry.label.trim();
				const existing = metaDal.getHostByLabel(label);
				if (seenLabels.has(label) || existing) {
					conflictingLabels.add(label);
				}
				seenLabels.add(label);
			}
			if (conflictingLabels.size > 0) {
				const labels = [...conflictingLabels];
				return reply.code(409).send({
					error: {
						code: "CONFLICT",
						message: `Labels already in use: ${labels.join(", ")}`,
						conflicting_labels: labels,
					},
				});
			}

			// Build host inputs and create in a transaction
			const inputs = entries.map((entry) => {
				// Safe: validated above that all entries exist in entryMap
				const sshEntry = entryMap.get(entry.name) as NonNullable<ReturnType<typeof entryMap.get>>;
				return {
					type: "ssh" as const,
					label: entry.label.trim(),
					sshHost: sshEntry.hostname ?? sshEntry.name,
					sshPort: sshEntry.port,
					...(sshEntry.user != null && { sshUser: sshEntry.user }),
					// An entry naming no IdentityFile is one `ssh` logs into with
					// whatever the agent holds, as these hosts already work from a
					// shell: stored as the agent whether or not one runs now (#436, #917).
					...(sshAuthFor(sshEntry.identityFile) === "key"
						? { sshKeyPath: sshEntry.identityFile as string, sshAuth: "key" as const }
						: { sshAuth: "agent" as const }),
					sshConfigHost: sshEntry.name,
					// Kept as written for now; the pass below links it to the saved
					// bastion it names, when the link reaches what ssh would.
					...(sshEntry.proxyJump != null ? { sshProxySpec: sshEntry.proxyJump } : {}),
					...(entry.sshRemoteDaemon !== undefined && {
						sshRemoteDaemon: entry.sshRemoteDaemon,
					}),
				};
			});

			const hosts = metaDal.importHosts(inputs);
			// Stored: said once for the whole list, the links below included.
			announce("hosts");

			// A bastion is usually a host of its own, imported earlier or in the
			// same breath. Linking to it is what lets it carry its own
			// authentication and its own pinned key; `jumpLinkFor` says when that
			// is the jump ssh would make. The hosts are read once for the whole list.
			// An import with no ProxyJump reads nothing more.
			const candidates = hosts.some((host) => host.sshProxySpec) ? metaDal.listHosts() : [];
			const linked = hosts.map((host) => linkHostToProxyJump(metaDal, host, candidates));

			return reply.code(201).send(toSnakeCase(linked));
		},
	);
}
