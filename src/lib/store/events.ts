import { writable, type Writable } from 'svelte/store';
import { openDB } from '$lib/db/idb';
import type { NostrEvent } from 'nostr-tools';
import { decrypt } from '$lib/nostr/crypto';

export interface StoredTriggerEvent {
	id: string;
	kind: number;
	created_at: number;
	monitorPubkey: string;
	type: string;
	monitorLabel: string;
	data: Record<string, unknown>;
	raw: NostrEvent;
}

export const events: Writable<StoredTriggerEvent[]> = writable([]);

export async function upsertEvent(raw: NostrEvent, privkey: Uint8Array): Promise<void> {
	let decrypted: { type: string; monitorLabel: string; data: Record<string, unknown> } | null = null;
	try {
		const plain = decrypt(privkey, raw.pubkey, raw.content);
		decrypted = JSON.parse(plain);
	} catch {
		return;
	}

	const stored: StoredTriggerEvent = {
		id: raw.id,
		kind: raw.kind,
		created_at: raw.created_at,
		monitorPubkey: raw.pubkey,
		type: decrypted!.type,
		monitorLabel: decrypted!.monitorLabel,
		data: decrypted!.data,
		raw
	};

	const db = await openDB();
	await db.put('events', stored);
	events.update((list) => {
		const idx = list.findIndex((e) => e.id === stored.id);
		if (idx >= 0) list[idx] = stored;
		else list.push(stored);
		return [...list].sort((a, b) => b.created_at - a.created_at);
	});
}

export async function loadEventsInRange(from: number, to: number): Promise<StoredTriggerEvent[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('events', 'created_at') as StoredTriggerEvent[];
	return all.filter((e) => e.created_at >= from && e.created_at <= to);
}
