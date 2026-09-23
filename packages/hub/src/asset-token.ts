import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { tokensEqual } from "./auth.js";

export const ASSET_TOKEN_QUERY_PARAM = "asset_token";

export type PublicAssetKind = "fonts" | "system-fonts" | "sounds" | "wallpapers";

const bootAssetToken = randomBytes(32).toString("base64url");

export function getBootAssetToken(): string {
	return bootAssetToken;
}

export function buildSignedPublicAssetUrl(kind: PublicAssetKind, filename: string): string {
	const search = new URLSearchParams({
		[ASSET_TOKEN_QUERY_PARAM]: bootAssetToken,
	});
	return `/public/${kind}/${encodeURIComponent(filename)}?${search.toString()}`;
}

export function isValidAssetToken(candidate: string | null | undefined): boolean {
	if (!candidate) return false;
	return tokensEqual(candidate, bootAssetToken);
}

export function requestHasValidAssetToken(request: FastifyRequest): boolean {
	const url = new URL(request.url, "http://localhost");
	return isValidAssetToken(url.searchParams.get(ASSET_TOKEN_QUERY_PARAM));
}
