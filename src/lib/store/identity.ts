import { writable, type Writable } from 'svelte/store';
import type { Identity } from '$lib/nostr/keys';
import { openDB } from '$lib/db/idb';

export const identity: Writable<Identity | null> = writable(null);

export interface PairedDevice {
	pubkey: string;
	label: string;
	addedAt: number;
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

export async function removePairedDevice(pubkey: string): Promise<void> {
	const db = await openDB();
	await db.delete('pairedDevices', pubkey);
	pairedDevices.update((d) => d.filter((x) => x.pubkey !== pubkey));
}
