// The build channel (#1084). Its rule lives in platform-dirs.ts, beside the
// names it picks, because that module imports only Node's builtins and scripts
// load it under plain Node (scripts/dev/ui/cdp.mjs).
export {
	type BuildChannel,
	buildChannel,
	CHANNEL_MARKER_PREFIX,
	channelBaseName,
	channelFromValue,
} from "./platform-dirs.js";
