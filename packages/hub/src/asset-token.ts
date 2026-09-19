import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

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
	const expected = Buffer.from(bootAssetToken);
	const actual = Buffer.from(candidate);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requestHasValidAssetToken(request: FastifyRequest): boolean {
	const url = new URL(request.url, "http://localhost");
	return isValidAssetToken(url.searchParams.get(ASSET_TOKEN_QUERY_PARAM));
}
