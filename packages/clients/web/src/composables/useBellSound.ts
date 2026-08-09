import type { BellSound } from "@lasterm/shared";
import { domNamedPublicAssetUrl } from "../utils/hub-url.js";

let audioContext: AudioContext | null = null;
let userInteracted = false;

/**
 * Lazily create AudioContext on first user interaction.
 * Browsers block AudioContext creation before user gesture.
 */
function ensureAudioContext(): AudioContext | null {
	if (audioContext) return audioContext;
	if (!userInteracted) return null;
	try {
		audioContext = new AudioContext();
		return audioContext;
	} catch {
		return null;
	}
}

// Track user interaction for AudioContext creation
if (typeof window !== "undefined") {
	const markInteracted = (): void => {
		userInteracted = true;
		window.removeEventListener("click", markInteracted);
		window.removeEventListener("keydown", markInteracted);
	};
	window.addEventListener("click", markInteracted);
	window.addEventListener("keydown", markInteracted);
}

/**
 * Play bell sound based on configuration.
 *
 * - "system": sine wave 800Hz, 100ms via Web Audio API
 * - "custom": play an audio file from the hub's signed public sound URL
 * - "mute": no-op
 */
export function playBellSound(config: { sound: BellSound; customSoundFile?: string }): void {
	if (config.sound === "mute") return;

	if (config.sound === "system") {
		_playSystemBell();
		return;
	}

	if (config.sound === "custom" && config.customSoundFile) {
		_playCustomSound(config.customSoundFile);
		return;
	}
}

function _playSystemBell(): void {
	const ctx = ensureAudioContext();
	if (!ctx) return;

	try {
		const oscillator = ctx.createOscillator();
		const gain = ctx.createGain();

		oscillator.type = "sine";
		oscillator.frequency.setValueAtTime(800, ctx.currentTime);

		gain.gain.setValueAtTime(0.3, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

		oscillator.connect(gain);
		gain.connect(ctx.destination);

		oscillator.start(ctx.currentTime);
		oscillator.stop(ctx.currentTime + 0.1);
	} catch {
		// AudioContext may be in a bad state
	}
}

function _playCustomSound(filename: string): void {
	// Validate filename — no path separators allowed
	if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
		return;
	}

	// Validate audio file extension
	const VALID_AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg", ".m4a"];
	const lower = filename.toLowerCase();
	if (!VALID_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
		console.warn(
			`[useBellSound] Invalid audio extension for custom bell sound: "${filename}". ` +
				`Supported formats: ${VALID_AUDIO_EXTENSIONS.join(", ")}. Falling back to system bell.`,
		);
		_playSystemBell();
		return;
	}

	try {
		void domNamedPublicAssetUrl("sounds", filename)
			.then((url) => {
				const audio = new Audio(url);
				audio.volume = 0.5;
				return audio.play();
			})
			.catch(() => {
				// Loading through the relay or autoplay may fail.
			});
	} catch {
		// Audio creation may fail
	}
}
