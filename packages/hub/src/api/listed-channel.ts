import type { Channel } from "@lasterm/shared";

/**
 * A channel as the REST routes give it: without its end id, which the hub
 * sends only with the end (CHANNEL_STATE) and with the refusal of an attach
 * (CHANNEL_DEAD) (#932).
 */
export function listedChannel(channel: Channel): Omit<Channel, "endId"> {
	const { endId: _end, ...listed } = channel;
	return listed;
}
