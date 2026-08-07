import { MAX_WALLPAPER_SIZE, WALLPAPER_EXTENSIONS } from "@lasterm/shared";
import { hubBaseUrl } from "../../../utils/hub-url.js";

export const WALLPAPER_ACCEPTED_EXTENSIONS = new Set(WALLPAPER_EXTENSIONS.map((ext) => `.${ext}`));

export interface WallpaperUploadOptions {
	token: string | null;
	loadWallpapers: () => Promise<void>;
	selectWallpaper: (filename: string) => Promise<void>;
	setUploadError: (message: string) => void;
}

export async function uploadWallpaperFiles(
	files: File[],
	options: WallpaperUploadOptions,
): Promise<void> {
	if (files.length === 0) return;

	options.setUploadError("");

	let latestFilename: string | null = null;
	let failed = false;

	for (const file of files) {
		if (file.size > MAX_WALLPAPER_SIZE) {
			options.setUploadError("File too large (max 10 MB)");
			failed = true;
			break;
		}

		const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
		if (!WALLPAPER_EXTENSIONS.includes(ext)) {
			options.setUploadError(`Unsupported format. Use: ${WALLPAPER_EXTENSIONS.join(", ")}`);
			failed = true;
			break;
		}

		const formData = new FormData();
		formData.append("image", file);

		try {
			const resp = await fetch(`${hubBaseUrl()}/api/wallpapers`, {
				method: "POST",
				headers: { Authorization: `Bearer ${options.token ?? ""}` },
				body: formData,
			});

			if (!resp.ok) {
				const data = await resp.json().catch(() => ({}));
				options.setUploadError(
					(data as { message?: string }).message ?? `Upload failed (${resp.status})`,
				);
				failed = true;
				break;
			}

			const { filename } = (await resp.json()) as { filename: string };
			latestFilename = filename;
		} catch {
			options.setUploadError("Upload failed");
			failed = true;
			break;
		}
	}

	if (!latestFilename) return;

	try {
		await options.loadWallpapers();
		await options.selectWallpaper(latestFilename);
		if (!failed) {
			options.setUploadError("");
		}
	} catch {
		options.setUploadError("Upload failed");
	}
}
