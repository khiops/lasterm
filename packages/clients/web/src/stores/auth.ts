import { defineStore } from "pinia";
import { computed, ref } from "vue";

const TOKEN_KEY = "lasterm_token";

/**
 * Auth store — holds authentication state for the current WS session.
 * Token is persisted in localStorage so it survives page reloads.
 */
export const useAuthStore = defineStore("auth", () => {
	const token = ref<string | null>(localStorage.getItem(TOKEN_KEY));
	const clientId = ref<string | null>(null);

	const isAuthenticated = computed(() => token.value !== null && clientId.value !== null);

	function setToken(newToken: string): void {
		token.value = newToken;
		localStorage.setItem(TOKEN_KEY, newToken);
	}

	function clearToken(): void {
		token.value = null;
		clientId.value = null;
		localStorage.removeItem(TOKEN_KEY);
	}

	function setClientId(id: string): void {
		clientId.value = id;
	}

	return {
		token,
		clientId,
		isAuthenticated,
		setToken,
		clearToken,
		setClientId,
	};
});
