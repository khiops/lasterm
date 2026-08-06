export type { LogConfig } from "@lasterm/shared";
export { ChannelLogger } from "./channel-logger.js";
export { HubLogger } from "./hub-logger.js";
export { LOG_SEVERITY, severityForLevel } from "./levels.js";
export { runLogGc } from "./log-gc.js";

export type LoggerRegistry = Map<string, import("./channel-logger.js").ChannelLogger>;
