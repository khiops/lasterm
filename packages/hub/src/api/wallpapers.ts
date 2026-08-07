import { readdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { WALLPAPER_EXTENSIONS } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { sanitizeFilename } from "./upload-utils.js";

const ALLOWED_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/bmp",
]);

function isValidExtension(filename: string): boolean {
	const ext = extname(filename).toLowerCase().slice(1);
	return WALLPAPER_EXTENSIONS.includes(ext);
}

export function registerWallpaperRoutes(server: FastifyInstance, configDir: string): void {
	const wallpapersDir = join(configDir, "wallpapers");

	// GET /api/wallpapers — lists filenames; public asset URLs are signed client-side.
	server.get("/api/wallpapers", async () => {
		let entries: string[];
		try {
			entries = await readdir(wallpapersDir);
		} catch {
			return { wallpapers: [] };
		}
		const wallpapers = entries.filter((f) => isValidExtension(f)).sort();
		return { wallpapers };
	});

	// POST /api/wallpapers — upload a wallpaper image
	server.post("/api/wallpapers", async (request: FastifyRequest, reply: FastifyReply) => {
		const file = await request.file();
		if (!file) {
			return reply.code(400).send({ error: { code: "NO_FILE", message: "No file uploaded" } });
		}

		const sanitized = sanitizeFilename(file.filename);
		if (!sanitized) {
			return reply
				.code(400)
				.send({ error: { code: "INVALID_FILENAME", message: "Invalid filename" } });
		}

		if (!isValidExtension(sanitized)) {
			return reply
				.code(400)
				.send({ error: { code: "UNSUPPORTED_TYPE", message: "Unsupported file type" } });
		}

		const buffer = await file.toBuffer();

		// Magic-byte MIME validation (defense-in-depth, before writing to disk)
		const ext = extname(sanitized).toLowerCase().slice(1);
		if (ext === "svg") {
			// SVG is text-based — file-type cannot detect it; validate content heuristically
			const head = buffer.slice(0, 512).toString("utf8");
			if (!head.includes("<svg") && !head.includes("<?xml")) {
				return reply.code(400).send({
					error: {
						code: "INVALID_FILE_TYPE",
						message: "File content does not match an allowed image type (detected: unknown)",
					},
				});
			}
		} else {
			const detectedType = await fileTypeFromBuffer(buffer);
			if (!detectedType || !ALLOWED_MIMES.has(detectedType.mime)) {
				return reply.code(400).send({
					error: {
						code: "INVALID_FILE_TYPE",
						message: `File content does not match an allowed image type (detected: ${detectedType?.mime ?? "unknown"})`,
					},
				});
			}
		}

		const target = join(wallpapersDir, sanitized);

		// Directory containment check
		if (!resolve(target).startsWith(resolve(wallpapersDir))) {
			return reply.code(400).send({ error: { code: "INVALID_PATH", message: "Invalid filename" } });
		}

		await writeFile(target, buffer);
		return { filename: sanitized };
	});

	// DELETE /api/wallpapers/:filename
	server.delete<{ Params: { filename: string } }>(
		"/api/wallpapers/:filename",
		async (request, reply) => {
			const sanitized = sanitizeFilename(request.params.filename);
			if (!sanitized) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_FILENAME", message: "Invalid filename" } });
			}

			const target = join(wallpapersDir, sanitized);

			// Directory containment check
			if (!resolve(target).startsWith(resolve(wallpapersDir))) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_PATH", message: "Invalid filename" } });
			}

			try {
				await unlink(target);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return reply
						.code(404)
						.send({ error: { code: "NOT_FOUND", message: "Wallpaper not found" } });
				}
				throw err;
			}

			return { ok: true };
		},
	);
}
