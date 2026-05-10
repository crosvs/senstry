import { openDB } from './idb';
import { randomUUID } from '$lib/utils';

export interface FootageRef {
	refId: string;
	originMonitor: string;
	triggerType: string;
	sourceId: string;        // which input source produced this footage; legacy records default to 'default-mic'
	channelId?: string | null; // which channel this footage is tagged to; null/undefined = untagged
	startTime: number;       // unix seconds — pre-roll window start
	endTime: number;         // unix seconds — post-roll window end
	triggerTime: number;     // unix seconds — when the trigger actually fired
	nostrEventId: string | null;
	publishedAt: number | null;  // unix ms; null = not yet published
	deleted: boolean;
}

export async function createFootageRef(
	ref: Omit<FootageRef, 'refId' | 'nostrEventId' | 'publishedAt' | 'deleted'>
): Promise<FootageRef> {
	const record: FootageRef = {
		...ref,
		refId: randomUUID(),
		nostrEventId: null,
		publishedAt: null,
		deleted: false,
	};
	const db = await openDB();
	await db.put('footageRefs', record);
	return record;
}

export async function updateFootageRef(refId: string, patch: Partial<FootageRef>): Promise<FootageRef | null> {
	const db = await openDB();
	const existing = await db.get('footageRefs', refId) as FootageRef | undefined;
	if (!existing) return null;
	const updated = { ...existing, ...patch };
	await db.put('footageRefs', updated);
	return updated;
}

export async function getFootageRef(refId: string): Promise<FootageRef | undefined> {
	const db = await openDB();
	return db.get('footageRefs', refId) as Promise<FootageRef | undefined>;
}

export async function getFootageRefsForDay(
	dayStartUnix: number,
	dayEndUnix: number,
	originMonitor?: string,
	sourceId?: string
): Promise<FootageRef[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('footageRefs', 'startTime') as FootageRef[];
	return all.filter((r) =>
		r.startTime >= dayStartUnix &&
		r.startTime < dayEndUnix &&
		!r.deleted &&
		(originMonitor == null || r.originMonitor === originMonitor) &&
		(sourceId == null || (r.sourceId ?? 'default-mic') === sourceId)
	);
}

export async function getFootageRefsInRange(
	fromUnix: number,
	toUnix: number,
	originMonitor?: string,
	sourceId?: string
): Promise<FootageRef[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('footageRefs', 'startTime') as FootageRef[];
	return all.filter((r) =>
		r.endTime >= fromUnix &&
		r.startTime <= toUnix &&
		!r.deleted &&
		(originMonitor == null || r.originMonitor === originMonitor) &&
		(sourceId == null || (r.sourceId ?? 'default-mic') === sourceId)
	);
}

export async function softDeleteFootageRef(refId: string): Promise<FootageRef | null> {
	return updateFootageRef(refId, { deleted: true });
}

export async function getUnpublishedRefs(): Promise<FootageRef[]> {
	const db = await openDB();
	const all = await db.getAll('footageRefs') as FootageRef[];
	return all.filter((r) => !r.deleted && r.publishedAt == null);
}

export async function markRefPublished(refId: string, nostrEventId: string): Promise<void> {
	const db = await openDB();
	const ref = await db.get('footageRefs', refId) as FootageRef | undefined;
	if (ref) await db.put('footageRefs', { ...ref, nostrEventId, publishedAt: Date.now() });
}

export async function getAllFootageRefs(): Promise<FootageRef[]> {
	const db = await openDB();
	return db.getAll('footageRefs') as Promise<FootageRef[]>;
}

// Called on the viewer side when a FootageRef arrives via Nostr.
// Uses the monitor's original refId so WebRTC segment requests can use the same ID.
// Idempotent: if the ref already exists and is not deleted, returns it unchanged.
export async function receiveFootageRef(
	refId: string,
	ref: Omit<FootageRef, 'refId' | 'nostrEventId' | 'publishedAt' | 'deleted'>,
	nostrEventId: string
): Promise<{ ref: FootageRef; isNew: boolean }> {
	const db = await openDB();
	const existing = await db.get('footageRefs', refId) as FootageRef | undefined;
	if (existing && !existing.deleted) return { ref: existing, isNew: false };
	const record: FootageRef = {
		...ref,
		refId,
		nostrEventId,
		publishedAt: Date.now(),
		deleted: false,
	};
	await db.put('footageRefs', record);
	return { ref: record, isNew: true };
}

export async function clearFootageRefsForMonitor(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('footageRefs') as FootageRef[];
	for (const ref of all) {
		if (ref.originMonitor === originMonitor) await db.delete('footageRefs', ref.refId);
	}
}
