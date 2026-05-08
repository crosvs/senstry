import { openDB } from './idb';
import { randomUUID } from '$lib/utils';
import type { NostrEvent } from 'nostr-tools';

export interface OutboxItem {
	outboxId: string;
	event: NostrEvent;
	createdAt: number;    // unix ms
	kind: number;
	attempts: number;
	lastAttemptAt: number | null;
	status: 'queued' | 'published' | 'failed';
	relays: string[];
}

export async function enqueue(event: NostrEvent, relays: string[]): Promise<OutboxItem> {
	const item: OutboxItem = {
		outboxId: randomUUID(),
		event,
		createdAt: Date.now(),
		kind: event.kind,
		attempts: 0,
		lastAttemptAt: null,
		status: 'queued',
		relays
	};
	const db = await openDB();
	await db.put('outbox', item);
	return item;
}

export async function getQueued(): Promise<OutboxItem[]> {
	const db = await openDB();
	return db.getAllFromIndex('outbox', 'status', 'queued') as Promise<OutboxItem[]>;
}

export async function markPublished(outboxId: string): Promise<void> {
	const db = await openDB();
	const item = await db.get('outbox', outboxId) as OutboxItem | undefined;
	if (item) await db.put('outbox', { ...item, status: 'published' });
}

export async function markFailed(outboxId: string): Promise<void> {
	const db = await openDB();
	const item = await db.get('outbox', outboxId) as OutboxItem | undefined;
	if (item) await db.put('outbox', {
		...item,
		status: 'failed',
		attempts: item.attempts + 1,
		lastAttemptAt: Date.now()
	});
}

export async function requeueFailed(): Promise<void> {
	const db = await openDB();
	const failed = await db.getAllFromIndex('outbox', 'status', 'failed') as OutboxItem[];
	for (const item of failed) {
		await db.put('outbox', { ...item, status: 'queued' });
	}
}

export async function incrementAttempt(outboxId: string): Promise<void> {
	const db = await openDB();
	const item = await db.get('outbox', outboxId) as OutboxItem | undefined;
	if (item) await db.put('outbox', { ...item, attempts: item.attempts + 1, lastAttemptAt: Date.now() });
}
