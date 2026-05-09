import { writable, type Writable } from 'svelte/store';
import { getSetting, putSetting } from '$lib/db/idb';

export const DEFAULT_RELAY = 'wss://relay.damus.io';

export interface AppSettings {
	relayUrl: string;
	selfLabel: string;
	pauseNostr: boolean;
	storeEvents: boolean;
	rtcIdleTimeoutMs: number;
	nostrRateLimit: number;  // events per minute, default 200
}

const defaults: AppSettings = {
	relayUrl: DEFAULT_RELAY,
	selfLabel: 'Monitor',
	pauseNostr: false,
	storeEvents: true,
	rtcIdleTimeoutMs: 120_000,
	nostrRateLimit: 200,
};

export const settings: Writable<AppSettings> = writable(defaults);

export async function loadSettings(): Promise<void> {
	const stored = await getSetting<AppSettings>('app.settings');
	if (stored) {
		settings.set({ ...defaults, ...stored });
	}
}

export async function saveSettings(s: AppSettings): Promise<void> {
	await putSetting('app.settings', s);
	settings.set(s);
}
