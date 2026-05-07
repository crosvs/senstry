import { writable, type Writable } from 'svelte/store';
import { getSetting, putSetting } from '$lib/db/idb';

export interface TriggerConfig {
	id: string;
	name: string;
	type: 'audio';
	action: 'video' | 'photo' | 'both';
	enabled: boolean;
	thresholdDb: number;
	cooldownMs: number;
	minDurationMs: number;
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
		minDurationMs: 500
	}
];

export const triggers: Writable<TriggerConfig[]> = writable(DEFAULT_TRIGGERS);

export async function loadTriggers(): Promise<void> {
	const stored = await getSetting<TriggerConfig[]>('triggers');
	if (stored?.length) {
		// Migrate stored triggers that predate the action field
		triggers.set(stored.map((t) => ({ ...t, action: t.action ?? ('video' as const) })));
	}
}

export async function saveTriggers(configs: TriggerConfig[]): Promise<void> {
	await putSetting('triggers', configs);
	triggers.set(configs);
}

export function newTrigger(): TriggerConfig {
	return {
		id: crypto.randomUUID(),
		name: 'New trigger',
		type: 'audio',
		action: 'video',
		enabled: true,
		thresholdDb: -40,
		cooldownMs: 2000,
		minDurationMs: 500
	};
}
