import { writable, type Writable } from 'svelte/store';
import { getSetting, putSetting } from '$lib/db/idb';
import { randomUUID } from '$lib/utils';

export interface TriggerConfig {
	id: string;
	name: string;
	type: 'audio';
	action: 'video' | 'photo' | 'both';
	enabled: boolean;
	thresholdDb: number;
	cooldownMs: number;       // detector suppression: ignore re-detections within this window
	minDurationMs: number;
	notifyCooldownMs: number; // minimum ms between Nostr kind:5010 notification publishes per viewer
	// legacy field — migrated to notifyCooldownMs on load
	publishCooldownMs?: number;
}

export const DEFAULT_TRIGGERS: TriggerConfig[] = [
	{
		id: 'default',
		name: 'Audio',
		type: 'audio',
		action: 'video',
		enabled: true,
		thresholdDb: -40,
		cooldownMs: 2000,
		minDurationMs: 500,
		notifyCooldownMs: 30_000,
	}
];

export const triggers: Writable<TriggerConfig[]> = writable(DEFAULT_TRIGGERS);

export async function loadTriggers(): Promise<void> {
	const stored = await getSetting<TriggerConfig[]>('triggers');
	if (stored?.length) {
		triggers.set(stored.map((t) => ({
			...t,
			action: t.action ?? ('video' as const),
			notifyCooldownMs: t.notifyCooldownMs ?? t.publishCooldownMs ?? 30_000,
		})));
	}
}

export async function saveTriggers(configs: TriggerConfig[]): Promise<void> {
	await putSetting('triggers', configs);
	triggers.set(configs);
}

export function newTrigger(): TriggerConfig {
	return {
		id: randomUUID(),
		name: 'New trigger',
		type: 'audio',
		action: 'video',
		enabled: true,
		thresholdDb: -40,
		cooldownMs: 2000,
		minDurationMs: 500,
		notifyCooldownMs: 30_000,
	};
}
