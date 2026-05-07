import { openDB } from './idb';

export interface FootageRef {
	refId: string;
	nostrEventId: string | null;
	originMonitor: string;
	type: 'video' | 'photo';
	startTime: number;            // unix seconds
	endTime: number;              // unix seconds
	segmentIds: string[];         // IDs in local segments store; empty on viewer side
	snapshotIds: string[];        // IDs in local photos store (photo events only)
	pinned: boolean;
	deleted: boolean;
	nostrDeleteEventId: string | null;
	publishedAt: number | null;   // unix ms; null = queued/unpublished
	updatedAt: number;            // unix ms; used for resync detection
	backupSources: string[];      // pubkeys of peers holding a backup copy
}

export async function createFootageRef(
	ref: Omit<FootageRef, 'refId' | 'nostrEventId' | 'deleted' | 'nostrDeleteEventId' | 'publishedAt' | 'updatedAt' | 'backupSources'>
): Promise<FootageRef> {
	const record: FootageRef = {
		...ref,
		refId: crypto.randomUUID(),
		nostrEventId: null,
		deleted: false,
		nostrDeleteEventId: null,
		publishedAt: null,
		updatedAt: Date.now(),
		backupSources: []
	};
	const db = await openDB();
	await db.put('footageRefs', record);
	return record;
}

export async function updateFootageRef(refId: string, patch: Partial<FootageRef>): Promise<FootageRef | null> {
	const db = await openDB();
	const existing = await db.get('footageRefs', refId) as FootageRef | undefined;
	if (!existing) return null;
	const updated = { ...existing, ...patch, updatedAt: Date.now() };
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
	originMonitor?: string
): Promise<FootageRef[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('footageRefs', 'startTime') as FootageRef[];
	return all.filter((r) =>
		r.startTime >= dayStartUnix &&
		r.startTime < dayEndUnix &&
		!r.deleted &&
		(originMonitor == null || r.originMonitor === originMonitor)
	);
}

export async function getFootageRefsInRange(
	fromUnix: number,
	toUnix: number,
	originMonitor?: string
): Promise<FootageRef[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('footageRefs', 'startTime') as FootageRef[];
	return all.filter((r) =>
		r.endTime >= fromUnix &&
		r.startTime <= toUnix &&
		!r.deleted &&
		(originMonitor == null || r.originMonitor === originMonitor)
	);
}

// Soft-delete: marks deleted, clears segment/snapshot links (caller deletes actual blobs).
export async function softDeleteFootageRef(refId: string): Promise<FootageRef | null> {
	return updateFootageRef(refId, { deleted: true, segmentIds: [], snapshotIds: [] });
}

// Returns all refs where updatedAt > publishedAt (or publishedAt is null) — needs re-publish.
export async function getUnpublishedRefs(): Promise<FootageRef[]> {
	const db = await openDB();
	const all = await db.getAll('footageRefs') as FootageRef[];
	return all.filter((r) => !r.deleted && (r.publishedAt == null || r.updatedAt > r.publishedAt));
}

export async function markRefPublished(refId: string, nostrEventId: string): Promise<void> {
	const db = await openDB();
	const ref = await db.get('footageRefs', refId) as FootageRef | undefined;
	if (ref) await db.put('footageRefs', { ...ref, nostrEventId, publishedAt: Date.now() });
}

export async function addBackupSource(refId: string, pubkey: string): Promise<void> {
	const db = await openDB();
	const ref = await db.get('footageRefs', refId) as FootageRef | undefined;
	if (!ref) return;
	if (ref.backupSources.includes(pubkey)) return;
	await db.put('footageRefs', { ...ref, backupSources: [...ref.backupSources, pubkey], updatedAt: Date.now() });
}

export async function getAllFootageRefs(): Promise<FootageRef[]> {
	const db = await openDB();
	return db.getAll('footageRefs') as Promise<FootageRef[]>;
}

export async function clearFootageRefsForMonitor(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('footageRefs') as FootageRef[];
	for (const ref of all) {
		if (ref.originMonitor === originMonitor) await db.delete('footageRefs', ref.refId);
	}
}
