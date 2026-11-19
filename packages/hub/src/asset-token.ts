import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { tokensEqual } from "./auth.js";

export const ASSET_TOKEN_QUERY_PARAM = "asset_token";

export type PublicAssetKind = "fonts" | "system-fonts" | "sounds" | "wallpapers";

const bootAssetToken = randomBytes(32).toString("base64url");

export function getBootAssetToken(): string {
	return bootAssetToken;
}

/**
 * The path a listing hands out for a served file. It carries no credential: a
 * browser client adds the asset token itself, and the desktop relays the path
 * with its bearer, so the desktop never receives the asset token (#194).
 */
export function publicAssetPath(kind: PublicAssetKind, filename: string): string {
	return `/public/${kind}/${encodeURIComponent(filename)}`;
}

export function isValidAssetToken(candidate: string | null | undefined): boolean {
	if (!candidate) return false;
	return tokensEqual(candidate, bootAssetToken);
}

export function requestHasValidAssetToken(request: FastifyRequest): boolean {
	const url = new URL(request.url, "http://localhost");
	return isValidAssetToken(url.searchParams.get(ASSET_TOKEN_QUERY_PARAM));
}
