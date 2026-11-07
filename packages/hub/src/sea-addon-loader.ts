/**
 * sea-addon-loader.ts — hub
 *
 * Whether the hub runs as its Node Single Executable Application (SEA).
 *
 * The executable embeds no native addon any more. SQLite is node:sqlite, built
 * into the Node the executable embeds (#893), and the hub lock and the TLS
 * identity are installed beside the executable and loaded from there, checked
 * against the digests it embeds (@lasterm/shared's installed-addon, #889).
 */

export { detectSea } from "@lasterm/shared/dist/sea-addon-loader.js";
