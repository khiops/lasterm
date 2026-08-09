import { DEFAULT_CHANNEL_NAME, DEFAULT_NOTIFICATION_CONFIG, generateId } from "@lasterm/shared";
import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import { showSimpleNotification } from "../composables/useDesktopNotifications.js";
import { createWsClient } from "../services/ws-client.js";
import { hubWsUrl } from "../utils/hub-url.js";
import { useAgentManagerStore } from "./agent-manager.js";
import { useAgentVerifyStore } from "./agent-verify.js";
import { useAuthStore } from "./auth.js";
import { useAuthPromptStore } from "./auth-prompt.js";
import { useChannelsStore } from "./channels.js";
import { useConfigStore } from "./config.js";
import { useHostVerifyStore } from "./host-verify.js";
import { useHostsStore } from "./hosts.js";
import { useNotificationStore } from "./notifications.js";
import { useToastStore } from "./toast.js";
import { useWriteLockStore } from "./writelock.js";

export const useSessionStore = defineStore("session", () => {
	// markRaw: prevent Pinia/Vue from making the client reactive,
	// which would strip private class members and break the class methods.
	const wsClient = markRaw(createWsClient());
	const connected = ref(false);
	const currentChannelId = ref<string | null>(null);
	/** Set to true after AUTH_OK is received (not just WS open). */
	const authenticated = ref(false);
	/** Set to true when AUTH_FAIL is received — triggers pairing screen. */
	const authFailed = ref(false);
	/** Incremented each time the WS reconnects and re-authenticates successfully. */
	const reconnectCount = ref(0);
	/** Lifecycle unsubscribers — called in disconnect() to clean up. */
	const _unsubs: { disconnect: (() => void) | null; reconnect: (() => void) | null } = {
		disconnect: null,
		reconnect: null,
	};
	/** Guard against multiple concurrent connect() calls from parallel pane mounts. */
	let _connectPromise: Promise<void> | null = null;

	/**
	 * Connect to hub WebSocket, send AUTH, then wait for AUTH_OK or AUTH_FAIL.
	 * On AUTH_OK: stores clientId and resolves.
	 * On AUTH_FAIL: sets authFailed flag and rejects.
	 */
	async function connect(): Promise<void> {
		if (wsClient.isConnected) return;
		if (_connectPromise) return _connectPromise;
		_connectPromise = _doConnect();
		try {
			await _connectPromise;
		} finally {
			_connectPromise = null;
		}
	}

	async function _doConnect(): Promise<void> {
		const wsUrl = `${hubWsUrl()}/ws`;
		await wsClient.connect(wsUrl);
		connected.value = true;

		// Register write-lock message routing before authenticating
		const writeLockStore = useWriteLockStore();
		writeLockStore.setWsClient(wsClient);
		_registerWriteLockHandlers(writeLockStore);

		// Register per-domain message routing
		const authPromptStore = useAuthPromptStore();
		authPromptStore.setWsClient(wsClient);
		_registerAuthPromptHandlers(authPromptStore);

		const hostVerifyStore = useHostVerifyStore();
		hostVerifyStore.setWsClient(wsClient);
		_registerHostVerifyHandlers(hostVerifyStore);

		const agentVerifyStore = useAgentVerifyStore();
		agentVerifyStore.setWsClient(wsClient);
		_registerAgentVerifyHandlers(agentVerifyStore);

		const agentManagerStore = useAgentManagerStore();
		_registerAgentFetchHandlers(agentManagerStore);

		_registerPromptCancelHandlers(authPromptStore, hostVerifyStore, agentVerifyStore);

		const hostsStore = useHostsStore();
		_registerSessionHandlers(hostsStore);

		const channelsStore = useChannelsStore();
		_registerChannelHandlers(channelsStore);

		const notificationStore = useNotificationStore();
		const configStore = useConfigStore();
		_registerNotificationHandlers(notificationStore, configStore, channelsStore);

		_registerStateSyncHandler(hostsStore, channelsStore);

		// Authenticate immediately after connecting
		await _authenticate();

		// Track WS disconnection so UI can show reconnecting overlay
		_unsubs.disconnect = wsClient.onDisconnect(() => {
			connected.value = false;
		});

		// Re-authenticate and refresh state after each WS auto-reconnect
		_unsubs.reconnect = wsClient.onReconnect(async () => {
			try {
				connected.value = true;
				await _authenticate();
				// Re-fetch state after reconnect
				const hostsStore2 = useHostsStore();
				await hostsStore2.fetchHosts();
				const channelsStore2 = useChannelsStore();
				if (channelsStore2.activeHostId) {
					await channelsStore2.fetchChannels(channelsStore2.activeHostId);
				}
				// Reload resolved profile (font, cursor, scrollback settings)
				await useConfigStore().loadProfile();
				// Mark background channels with activity (SC-30/ERR-04)
				const notifStore = useNotificationStore();
				for (const ch of channelsStore2.channels) {
					if (ch.id !== channelsStore2.selectedChannelId) {
						notifStore.setActivity(ch.id);
					}
				}
				reconnectCount.value++;
			} catch (err) {
				console.error("[session] Reconnect auth failed:", err);
			}
		});
	}

	/**
	 * Send AUTH and wait for AUTH_OK or AUTH_FAIL.
	 * Resolves on success, rejects on failure.
	 */
	function _authenticate(): Promise<void> {
		const authStore = useAuthStore();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubOk();
				unsubFail();
				reject(new Error("AUTH timeout — no response after 10s"));
			}, 10_000);

			const unsubOk = wsClient.on("AUTH_OK", (msg) => {
				if (msg.type === "AUTH_OK") {
					clearTimeout(timer);
					unsubOk();
					unsubFail();
					authStore.setClientId(msg.clientId);
					authenticated.value = true;
					authFailed.value = false;
					resolve();
				}
			});

			const unsubFail = wsClient.on("AUTH_FAIL", (msg) => {
				if (msg.type === "AUTH_FAIL") {
					clearTimeout(timer);
					unsubOk();
					unsubFail();
					authenticated.value = false;
					authFailed.value = true;
					reject(new Error(`AUTH_FAIL: ${msg.message}`));
				}
			});

			wsClient.send({
				type: "AUTH",
				token: authStore.token ?? "",
			});
		});
	}

	/**
	 * Wire up write-lock protocol message handlers to the write-lock store.
	 */
	function _registerWriteLockHandlers(writeLockStore: ReturnType<typeof useWriteLockStore>): void {
		wsClient.on("WRITE_LOCK", (msg) => {
			if (msg.type === "WRITE_LOCK") {
				writeLockStore.handleWriteLock(msg.channelId, msg.holder);
			}
		});
		wsClient.on("WRITE_REQUEST", (msg) => {
			if (msg.type === "WRITE_REQUEST") {
				writeLockStore.handleWriteRequest(msg.channelId, msg.fromClientId);
			}
		});
		wsClient.on("WRITE_REVOKED", (msg) => {
			if (msg.type === "WRITE_REVOKED") {
				writeLockStore.handleWriteRevoked(msg.channelId);
			}
		});
		wsClient.on("WRITE_DENY", (msg) => {
			if (msg.type === "WRITE_DENY") {
				writeLockStore.handleWriteDeny(msg.channelId);
			}
		});
	}

	/**
	 * Wire up AUTH_PROMPT message handler to the auth-prompt store.
	 */
	function _registerAuthPromptHandlers(
		authPromptStore: ReturnType<typeof useAuthPromptStore>,
	): void {
		wsClient.on("AUTH_PROMPT", (msg) => {
			if (msg.type === "AUTH_PROMPT") {
				authPromptStore.handleAuthPrompt(
					msg.hostId,
					msg.promptType,
					msg.message,
					msg.promptId,
					msg.deliveryEpoch,
				);
			}
		});
	}

	/**
	 * Wire up HOST_VERIFY message handler for SSH key-mismatch prompts.
	 */
	function _registerHostVerifyHandlers(
		hostVerifyStore: ReturnType<typeof useHostVerifyStore>,
	): void {
		wsClient.on("HOST_VERIFY", (msg) => {
			if (msg.type === "HOST_VERIFY" && msg.promptId) {
				// Surface dialog for both TOFU (firstConnect) and mismatch (oldFingerprint) prompts
				const hostname = msg.hostId; // best-effort; hub doesn't send hostname yet
				hostVerifyStore.handleHostVerify(
					msg.hostId,
					hostname,
					msg.fingerprint,
					msg.algorithm,
					msg.oldFingerprint ?? "",
					msg.promptId,
					msg.firstConnect ?? false,
				);
			}
		});
	}

	/**
	 * Wire up agent verification, sync, and deploy error handlers.
	 */
	function _registerAgentVerifyHandlers(
		agentVerifyStore: ReturnType<typeof useAgentVerifyStore>,
	): void {
		wsClient.on("AGENT_BINARY_VERIFY", (msg) => {
			if (msg.type === "AGENT_BINARY_VERIFY") {
				agentVerifyStore.handleAgentVerify(msg);
			}
		});

		wsClient.on("AGENT_SYNCED", (msg) => {
			if (msg.type === "AGENT_SYNCED") {
				const toastStore = useToastStore();
				toastStore.show("info", msg.message);
			}
		});

		wsClient.on("ERROR", (msg) => {
			if (msg.type === "ERROR") {
				if (msg.code === "AGENT_NOT_AVAILABLE") {
					agentVerifyStore.handleDeployError(msg.message, msg.hostId);
					return;
				}
				if (msg.code === "AGENT_UPDATED") {
					// Legacy hub frame. Modern hubs send AGENT_SYNCED on a non-error channel.
					return;
				}
				if (msg.code === "AGENT_BINARY_REJECTED") {
					// User chose to reject the binary — no toast needed.
					return;
				}
				// All other error codes (SSH_CONNECT_FAILED, SPAWN_FAILED,
				// SSH_HOST_KEY_REJECTED, etc.) are surfaced as error toasts.
				const toastStore = useToastStore();
				toastStore.show("error", msg.message, 10_000);
			}
		});
	}

	/**
	 * Wire up agent fetch progress messages to the agent manager cache panel.
	 */
	function _registerAgentFetchHandlers(
		agentManagerStore: ReturnType<typeof useAgentManagerStore>,
	): void {
		wsClient.on("AGENT_FETCH_PROGRESS", (msg) => {
			if (msg.type === "AGENT_FETCH_PROGRESS") {
				agentManagerStore.handleAgentFetchProgress(msg);
			}
		});

		wsClient.on("AGENT_FETCH_DONE", (msg) => {
			if (msg.type === "AGENT_FETCH_DONE") {
				agentManagerStore.handleAgentFetchDone(msg);
			}
		});

		wsClient.on("AGENT_FETCH_ERROR", (msg) => {
			if (msg.type === "AGENT_FETCH_ERROR") {
				agentManagerStore.handleAgentFetchError(msg);
			}
		});
	}

	/**
	 * Wire up PROMPT_CANCEL messages — dispatches the cancelled promptId to all
	 * three prompt stores so whichever holds it dismisses that dialog.
	 */
	function _registerPromptCancelHandlers(
		authPromptStore: ReturnType<typeof useAuthPromptStore>,
		hostVerifyStore: ReturnType<typeof useHostVerifyStore>,
		agentVerifyStore: ReturnType<typeof useAgentVerifyStore>,
	): void {
		wsClient.on("PROMPT_CANCEL", (msg) => {
			if (msg.type === "PROMPT_CANCEL") {
				authPromptStore.handlePromptCancel(msg.promptId);
				hostVerifyStore.handlePromptCancel(msg.promptId);
				agentVerifyStore.handlePromptCancel(msg.promptId);
			}
		});
	}

	/**
	 * Wire up SESSION_STATE messages to the hosts store for rail status dots.
	 */
	function _registerSessionHandlers(hostsStore: ReturnType<typeof useHostsStore>): void {
		wsClient.on("SESSION_STATE", (msg) => {
			if (msg.type === "SESSION_STATE") {
				hostsStore.updateSessionStatus(msg.hostId, msg.status);
			}
		});
	}

	/**
	 * Wire up CHANNEL_STATE, CHANNEL_CREATED, TITLE_CHANGE, and PROCESS_TITLE
	 * messages to the channels store.
	 */
	function _registerChannelHandlers(channelsStore: ReturnType<typeof useChannelsStore>): void {
		wsClient.on("CHANNEL_STATE", (msg) => {
			if (msg.type === "CHANNEL_STATE") {
				channelsStore.updateChannelStatus(msg.channelId, msg.status, msg.exitCode);
			}
		});

		wsClient.on("CHANNEL_CREATED", (msg) => {
			if (msg.type === "CHANNEL_CREATED") {
				channelsStore.handleChannelCreated(msg);
			}
		});

		wsClient.on("TITLE_CHANGE", (msg) => {
			if (msg.type === "TITLE_CHANGE") {
				channelsStore.setDynamicTitle(msg.channelId, msg.title);
				if (msg.displayTitle) {
					channelsStore.setDisplayTitle(msg.channelId, msg.displayTitle);
				}
			}
		});

		wsClient.on("PROCESS_TITLE", (msg) => {
			if (msg.type === "PROCESS_TITLE") {
				channelsStore.updateProcessTitle(msg.channelId, msg.title);
				if (msg.displayTitle) {
					channelsStore.setDisplayTitle(msg.channelId, msg.displayTitle);
				}
			}
		});
	}

	/**
	 * Wire up BELL and NOTIFICATION messages:
	 * badge counters, bell sound playback, and desktop notifications.
	 */
	function _registerNotificationHandlers(
		notificationStore: ReturnType<typeof useNotificationStore>,
		configStore: ReturnType<typeof useConfigStore>,
		channelsStore: ReturnType<typeof useChannelsStore>,
	): void {
		wsClient.on("BELL", (msg) => {
			if (msg.type === "BELL") {
				const bellCfg =
					configStore.uiConfig.notifications?.bell ?? DEFAULT_NOTIFICATION_CONFIG.bell;
				// Note: bell badge + sound are BOTH handled by TerminalPane's xterm.js
				// onBell handler (per-channel profile). The WS BELL message is kept
				// only for desktop notifications (below) — do NOT increment the badge
				// here to avoid double-counting with onBell.
				// Desktop notification when document is hidden
				if (bellCfg.desktopNotification !== false && document.hidden) {
					const ch = channelsStore.channels.find((c) => c.id === msg.channelId);
					const name = ch?.displayTitle ?? DEFAULT_CHANNEL_NAME;
					showSimpleNotification(`Bell in ${name}`, "", msg.channelId);
				}
			}
		});

		wsClient.on("NOTIFICATION", (msg) => {
			if (msg.type === "NOTIFICATION") {
				const osc9Cfg =
					configStore.uiConfig.notifications?.osc9 ?? DEFAULT_NOTIFICATION_CONFIG.osc9;
				// Always show badge (brief flash on active tab, persistent on background)
				notificationStore.incrementBellCount(msg.channelId);
				if (msg.channelId === channelsStore.selectedChannelId) {
					setTimeout(() => {
						if (msg.channelId === channelsStore.selectedChannelId) {
							notificationStore.clearBellAndActivity(msg.channelId);
						}
					}, 1000);
				}
				// Desktop notification when document is hidden
				if (osc9Cfg.desktopNotification !== false && document.hidden) {
					showSimpleNotification("Terminal Notification", msg.message, msg.channelId);
				}
			}
		});
	}

	/**
	 * Wire up STATE_SYNC — full state snapshot sent after AUTH_OK.
	 * Populates session status, channel-host mappings, and display titles.
	 */
	function _registerStateSyncHandler(
		hostsStore: ReturnType<typeof useHostsStore>,
		channelsStore: ReturnType<typeof useChannelsStore>,
	): void {
		wsClient.on("STATE_SYNC", (msg) => {
			if (msg.type === "STATE_SYNC") {
				// Build sessionId → hostId lookup for channel-host mapping
				const sessionHostMap = new Map<string, string>();
				for (const s of msg.sessions) {
					hostsStore.updateSessionStatus(s.hostId, s.status);
					sessionHostMap.set(s.sessionId, s.hostId);
				}
				// Populate channelId → hostId map from STATE_SYNC data
				for (const ch of msg.channels) {
					const hostId = sessionHostMap.get(ch.sessionId);
					if (hostId) {
						channelsStore.registerChannelHost(ch.channelId, hostId);
					}
					if (ch.displayTitle) {
						channelsStore.setDisplayTitle(ch.channelId, ch.displayTitle);
					}
				}
				channelsStore.applyStateSync(msg.channels);
			}
		});
	}

	/**
	 * Send SPAWN for the built-in local host.
	 * Returns the channelId once SPAWN_OK is received.
	 */
	function spawnTerminal(): Promise<string> {
		// generateId is used for the request correlation — not strictly required
		// by the hub protocol but useful for future multi-spawn tracking.
		const _requestId = generateId();

		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error("SPAWN timeout — no SPAWN_OK after 10s"));
			}, 10_000);

			const unsub = wsClient.on("SPAWN_OK", (msg) => {
				if (msg.type === "SPAWN_OK") {
					clearTimeout(timer);
					unsub();
					currentChannelId.value = msg.channelId;
					resolve(msg.channelId);
				}
			});

			wsClient.send({
				type: "SPAWN",
				hostId: "local",
			});
		});
	}

	function disconnect(): void {
		_unsubs.disconnect?.();
		_unsubs.disconnect = null;
		_unsubs.reconnect?.();
		_unsubs.reconnect = null;
		wsClient.close();
		connected.value = false;
		authenticated.value = false;
		currentChannelId.value = null;
	}

	return {
		wsClient,
		connected,
		authenticated,
		authFailed,
		currentChannelId,
		reconnectCount,
		connect,
		spawnTerminal,
		disconnect,
	};
});
