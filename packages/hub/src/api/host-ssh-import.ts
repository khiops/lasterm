import type { SshConfigImport } from "@lasterm/shared";
import { toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { parseJumpSpec } from "../session/proxy-jump.js";
import { sshAgentAddress, windowsAgentPipeExists } from "../session/ssh-agent-address.js";
import type { ParseResult } from "../ssh/ssh-config-parser.js";
import { readSshConfig } from "../ssh/ssh-config-parser.js";
import type { MetaDAL } from "../storage/meta.js";

export function registerHostSshImportRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
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
	server.post<{ Body: { entries: SshConfigImport[] } }>(
		"/api/hosts/import",
		async (request, reply) => {
			const { entries } = request.body;

			if (!Array.isArray(entries) || entries.length === 0) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "entries must be a non-empty array",
					},
				});
			}

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
				if (!entry.name || !entry.label) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: "Each entry must have name and label",
						},
					});
				}
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
			const conflictingLabels: string[] = [];
			for (const entry of entries) {
				const existing = metaDal.getHostByLabel(entry.label.trim());
				if (existing) {
					conflictingLabels.push(entry.label);
				}
			}
			if (conflictingLabels.length > 0) {
				return reply.code(409).send({
					error: {
						code: "CONFLICT",
						message: `Labels already in use: ${conflictingLabels.join(", ")}`,
						conflicting_labels: conflictingLabels,
					},
				});
			}

			// An entry naming no IdentityFile is one `ssh` logs into with whatever
			// the agent holds — that is how these very hosts already work from a
			// shell. Imported as "key" with no key, they could only ask for a
			// password (#436).
			const agentIsReachable =
				sshAgentAddress({
					env: process.env,
					platform: process.platform,
					pipeExists: windowsAgentPipeExists,
				}) !== null;

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
					...(sshEntry.identityFile != null
						? { sshKeyPath: sshEntry.identityFile, sshAuth: "key" as const }
						: agentIsReachable
							? { sshAuth: "agent" as const }
							: {}),
					sshConfigHost: sshEntry.name,
					// Kept as written for now; the pass below links it to a host of
					// this list when one turns out to be that bastion.
					...(sshEntry.proxyJump != null ? { sshProxySpec: sshEntry.proxyJump } : {}),
					...(entry.hostGroup !== undefined && { hostGroup: entry.hostGroup }),
				};
			});

			const hosts = metaDal.importHosts(inputs);

			// A bastion is usually a host of its own, imported in the same breath.
			// Linking to it rather than keeping its address twice is what lets it
			// carry its own authentication and its own pinned key.
			const linked = hosts.map((host) => {
				const spec = host.sshProxySpec;
				if (!spec) return host;
				const parsed = parseJumpSpec(spec);
				if (parsed.kind !== "spec") return host;
				const match = metaDal
					.listHosts()
					.find(
						(candidate) =>
							candidate.id !== host.id &&
							candidate.type === "ssh" &&
							(candidate.sshConfigHost === parsed.spec.host ||
								candidate.sshHost === parsed.spec.host),
					);
				if (!match) return host;
				return metaDal.updateHost(host.id, {
					sshProxyHostId: match.id,
					sshProxySpec: null,
				});
			});

			return reply.code(201).send(toSnakeCase(linked));
		},
	);
}
