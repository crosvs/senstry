import { writable, type Writable } from 'svelte/store';
import { getSetting, putSetting } from '$lib/db/idb';

export const DEFAULT_RELAY = 'wss://relay.damus.io';

export interface AppSettings {
	relayUrl: string;
	monitorLabel: string;
	recordVideo: boolean;
}

const defaults: AppSettings = {
	relayUrl: DEFAULT_RELAY,
	monitorLabel: 'Monitor',
	recordVideo: false
};

export const settings: Writable<AppSettings> = writable(defaults);

export async function loadSettings(): Promise<void> {
	const stored = await getSetting<AppSettings>('app.settings');
	if (stored) settings.set({ ...defaults, ...stored });
}

export async function saveSettings(s: AppSettings): Promise<void> {
	await putSetting('app.settings', s);
	settings.set(s);
}
