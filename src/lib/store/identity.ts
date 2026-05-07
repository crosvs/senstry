import { writable, type Writable } from 'svelte/store';
import type { Identity } from '$lib/nostr/keys';
import { openDB } from '$lib/db/idb';

export const identity: Writable<Identity | null> = writable(null);

export interface PairedDevice {
	pubkey: string;
	nickname: string;
	addedAt: number;
	relays: string[];
	capabilities: ('monitor' | 'viewer')[];
	lastSeenAt: number | null;
}

export const pairedDevices: Writable<PairedDevice[]> = writable([]);

export async function loadPairedDevices(): Promise<void> {
	const db = await openDB();
	const devices = await db.getAll('pairedDevices') as PairedDevice[];
	pairedDevices.set(devices);
}

export async function addPairedDevice(device: PairedDevice): Promise<void> {
	const db = await openDB();
	await db.put('pairedDevices', device);
	pairedDevices.update((d) => {
		const idx = d.findIndex((x) => x.pubkey === device.pubkey);
		if (idx >= 0) d[idx] = device;
		else d.push(device);
		return [...d];
	});
}

export async function updatePairedDevice(pubkey: string, patch: Partial<PairedDevice>): Promise<void> {
	const db = await openDB();
	const existing = await db.get('pairedDevices', pubkey) as PairedDevice | undefined;
	if (!existing) return;
	const updated = { ...existing, ...patch };
	await db.put('pairedDevices', updated);
	pairedDevices.update((d) => d.map((x) => (x.pubkey === pubkey ? updated : x)));
}

export async function removePairedDevice(pubkey: string): Promise<void> {
	const db = await openDB();
	await db.delete('pairedDevices', pubkey);
	pairedDevices.update((d) => d.filter((x) => x.pubkey !== pubkey));
}

// Returns nickname for a pubkey, falling back to shortened pubkey.
export function getNickname(pubkey: string, devices: PairedDevice[]): string {
	return devices.find((d) => d.pubkey === pubkey)?.nickname ?? pubkey.slice(0, 8);
}
