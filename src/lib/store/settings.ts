import { writable, type Writable } from 'svelte/store';
import { getSetting, putSetting } from '$lib/db/idb';

export const DEFAULT_RELAY = 'wss://relay.damus.io';

export interface VideoEventConfig {
	triggerId: string;
	preRollSec: number;
	postRollSec: number;
	recordVideo: boolean;
	videoWidth: number;       // 0 = unconstrained
	videoHeight: number;
	videoBitsPerSec: number;  // 0 = browser default
	audioBitsPerSec: number;
	videoCodec: string;
	enabled: boolean;
	pinLifetimeSec: number | null;  // null = don't pin; 0 = forever; positive = seconds
}

export interface PhotoEventConfig {
	triggerId: string;
	snapshotCount: number;
	intervalSec: number;
	imageWidth: number;
	imageQuality: number;  // 0.0–1.0
	imageFormat: string;
	enabled: boolean;
	pinLifetimeSec: number | null;  // null = don't pin; 0 = forever; positive = seconds
}

export interface AppSettings {
	relayUrl: string;
	selfLabel: string;
	pauseNostr: boolean;
	storeEvents: boolean;
	rtcIdleTimeoutMs: number;
	nostrRateLimit: number;       // events per minute, default 200
	videoConfig: VideoEventConfig;
	photoConfig: PhotoEventConfig;
}

const defaultVideoConfig: VideoEventConfig = {
	triggerId: 'default',
	preRollSec: 30,
	postRollSec: 30,
	recordVideo: false,
	videoWidth: 0,
	videoHeight: 0,
	videoBitsPerSec: 0,
	audioBitsPerSec: 0,
	videoCodec: '',
	enabled: true,
	pinLifetimeSec: 7 * 24 * 3600,   // 7 days
};

const defaultPhotoConfig: PhotoEventConfig = {
	triggerId: 'default',
	snapshotCount: 3,
	intervalSec: 2,
	imageWidth: 1280,
	imageQuality: 0.85,
	imageFormat: 'image/jpeg',
	enabled: false,
	pinLifetimeSec: 30 * 24 * 3600,  // 30 days
};

const defaults: AppSettings = {
	relayUrl: DEFAULT_RELAY,
	selfLabel: 'Monitor',
	pauseNostr: false,
	storeEvents: true,
	rtcIdleTimeoutMs: 120_000,
	nostrRateLimit: 200,
	videoConfig: defaultVideoConfig,
	photoConfig: defaultPhotoConfig
};

export const settings: Writable<AppSettings> = writable(defaults);

export async function loadSettings(): Promise<void> {
	const stored = await getSetting<AppSettings>('app.settings');
	if (stored) {
		settings.set({
			...defaults,
			...stored,
			videoConfig: { ...defaultVideoConfig, ...stored.videoConfig },
			photoConfig: { ...defaultPhotoConfig, ...stored.photoConfig }
		});
	}
}

export async function saveSettings(s: AppSettings): Promise<void> {
	await putSetting('app.settings', s);
	settings.set(s);
}
