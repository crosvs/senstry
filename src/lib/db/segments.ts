import { openDB } from './idb';

export const SEGMENT_DURATION_S = 10;  // each recording chunk
export const PRE_ROLL_S = 30;          // keep this many seconds before a trigger
export const POST_ROLL_S = 30;         // keep this many seconds after a trigger
export const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024;

export interface Segment {
	segmentId: string;
	startTime: number;  // unix seconds
	endTime: number;    // unix seconds
	blob: Blob;
	mimeType: string;
	sizeBytes: number;
	pinned: boolean;
}

export async function saveSegment(
	blob: Blob,
	mimeType: string,
	startTime: number,
	endTime: number
): Promise<string> {
	const segmentId = crypto.randomUUID();
	const record: Segment = {
		segmentId, blob, mimeType,
		startTime, endTime,
		sizeBytes: blob.size,
		pinned: false
	};
	const db = await openDB();
	await db.put('segments', record);
	await evictUnpinned();
	return segmentId;
}

// Pin all segments whose time range overlaps [fromTime, toTime]
export async function pinRange(fromTime: number, toTime: number): Promise<void> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	const toPin = all.filter((s) => s.endTime >= fromTime && s.startTime <= toTime);
	const tx = db.transaction('segments', 'readwrite');
	await Promise.all(toPin.map((s) => tx.store.put({ ...s, pinned: true })));
	await tx.done;
}

export async function getSegmentAt(time: number): Promise<Segment | undefined> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all.find((s) => s.startTime <= time && s.endTime > time);
}

export async function getSegmentsInRange(from: number, to: number): Promise<Segment[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all.filter((s) => s.endTime >= from && s.startTime <= to);
}

// Returns merged [start, end] pairs covering stored segments
export async function getCoverageMap(): Promise<[number, number][]> {
	const db = await openDB();
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);

	const merged: [number, number][] = [];
	for (const seg of all) {
		if (merged.length === 0) {
			merged.push([seg.startTime, seg.endTime]);
		} else {
			const last = merged[merged.length - 1];
			if (seg.startTime <= last[1] + 1) {
				last[1] = Math.max(last[1], seg.endTime);
			} else {
				merged.push([seg.startTime, seg.endTime]);
			}
		}
	}
	return merged;
}

async function getQuota(): Promise<number> {
	const db = await openDB();
	return (await db.get('settings', 'segments.quotaBytes') as number | undefined) ?? DEFAULT_QUOTA_BYTES;
}

export async function setQuota(bytes: number): Promise<void> {
	const db = await openDB();
	await db.put('settings', bytes, 'segments.quotaBytes');
}

// Evict oldest unpinned segments first, then oldest pinned if still over quota.
// Also immediately remove unpinned segments older than PRE_ROLL_S * 2 seconds
// (they'd never be pinnable for a future event anyway).
export async function evictUnpinned(): Promise<void> {
	const db = await openDB();
	const quota = await getQuota();
	const now = Math.floor(Date.now() / 1000);
	const maxUnpinnedAge = PRE_ROLL_S * 2;

	let all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);

	// Auto-delete unpinned segments too old to ever be a pre-roll
	for (const seg of all) {
		if (!seg.pinned && now - seg.endTime > maxUnpinnedAge) {
			await db.delete('segments', seg.segmentId);
		}
	}

	// Re-read and check quota
	all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);
	let total = all.reduce((s, c) => s + c.sizeBytes, 0);

	const unpinned = all.filter((s) => !s.pinned);
	for (const seg of unpinned) {
		if (total <= quota) break;
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	if (total > quota) {
		const pinned = all.filter((s) => s.pinned).sort((a, b) => a.startTime - b.startTime);
		for (const seg of pinned) {
			if (total <= quota) break;
			await db.delete('segments', seg.segmentId);
			total -= seg.sizeBytes;
		}
	}
}

export async function getStorageUsed(): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	return all.reduce((s, c) => s + c.sizeBytes, 0);
}

export async function clearAll(): Promise<void> {
	const db = await openDB();
	await db.clear('segments');
}
