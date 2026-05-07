import { openDB } from './idb';

export const SEGMENT_DURATION_S = 10;
export const PRE_ROLL_S = 30;
export const POST_ROLL_S = 30;
export const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024;

// Rolling buffer for unpinned segments: covers 2× the full trigger window (pre+post roll)
// so there's always enough history before a trigger fires.
export const MAX_ROLLING_SEGMENTS = Math.ceil(((PRE_ROLL_S + POST_ROLL_S) * 2) / SEGMENT_DURATION_S);

export interface Segment {
	segmentId: string;
	startTime: number;     // unix seconds
	endTime: number;       // unix seconds
	blob: Blob;
	mimeType: string;
	sizeBytes: number;
	pinned: boolean;
	originMonitor: string; // own pubkey for local recordings; source pubkey for received backups
	backupOf: string | null; // footageRef.refId this segment was received to back up
}

async function enforceRollingBuffer(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter(s => !s.pinned && s.originMonitor === originMonitor)
		.sort((a, b) => a.startTime - b.startTime);
	// Delete oldest segments beyond the rolling window (keep MAX-1 so the new one fits)
	const excess = all.length - (MAX_ROLLING_SEGMENTS - 1);
	for (let i = 0; i < excess; i++) {
		await db.delete('segments', all[i].segmentId);
	}
}

export async function saveSegment(
	blob: Blob,
	mimeType: string,
	startTime: number,
	endTime: number,
	originMonitor: string,
	backupOf: string | null = null
): Promise<string> {
	// Proactively cap unpinned rolling buffer so we never hit browser quota
	await enforceRollingBuffer(originMonitor);

	const segmentId = crypto.randomUUID();
	const record: Segment = {
		segmentId, blob, mimeType,
		startTime, endTime,
		sizeBytes: blob.size,
		pinned: false,
		originMonitor,
		backupOf
	};
	const db = await openDB();
	try {
		await db.put('segments', record);
	} catch (e) {
		// Fallback: any write failure → emergency clear all unpinned and retry once
		const errName = (e as { name?: string })?.name ?? '';
		if (errName === 'QuotaExceededError' || errName === 'AbortError') {
			const all = (await db.getAll('segments') as Segment[]).filter(s => !s.pinned);
			for (const seg of all) await db.delete('segments', seg.segmentId);
			try {
				await db.put('segments', record);
			} catch {
				// Storage unavailable — skip this segment, keep the monitor running
				return segmentId;
			}
		} else {
			throw e;
		}
	}
	return segmentId;
}

export async function pinRange(fromTime: number, toTime: number): Promise<string[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	const toPin = all.filter((s) => s.endTime >= fromTime && s.startTime <= toTime);
	const tx = db.transaction('segments', 'readwrite');
	await Promise.all(toPin.map((s) => tx.store.put({ ...s, pinned: true })));
	await tx.done;
	return toPin.map((s) => s.segmentId);
}

export async function getSegmentById(segmentId: string): Promise<Segment | undefined> {
	const db = await openDB();
	return db.get('segments', segmentId) as Promise<Segment | undefined>;
}

export async function getSegmentAt(time: number, originMonitor?: string): Promise<Segment | undefined> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all.find((s) =>
		s.startTime <= time &&
		s.endTime > time &&
		(originMonitor == null || s.originMonitor === originMonitor)
	);
}

export async function getSegmentsInRange(from: number, to: number, originMonitor?: string): Promise<Segment[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all
		.filter((s) =>
			s.endTime >= from &&
			s.startTime <= to &&
			(originMonitor == null || s.originMonitor === originMonitor)
		)
		.sort((a, b) => a.startTime - b.startTime);
}

export async function getCoverageMap(originMonitor?: string): Promise<[number, number][]> {
	const db = await openDB();
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter((s) => originMonitor == null || s.originMonitor === originMonitor)
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

// Eviction order per plan:
// 1. Unpinned own segments older than max pre-roll age
// 2. Unpinned own segments (oldest first)
// 3. Unpinned backup segments (oldest first)
// 4. Pinned segments (last resort)
export async function evictUnpinned(ownMonitor?: string): Promise<void> {
	const db = await openDB();
	const quota = await getQuota();
	const now = Math.floor(Date.now() / 1000);
	const maxUnpinnedAge = PRE_ROLL_S * 2;

	let all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);

	// Auto-delete own unpinned segments too old to ever be a pre-roll
	for (const seg of all) {
		if (!seg.pinned && seg.backupOf == null && now - seg.endTime > maxUnpinnedAge) {
			if (ownMonitor == null || seg.originMonitor === ownMonitor) {
				await db.delete('segments', seg.segmentId);
			}
		}
	}

	all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);
	let total = all.reduce((s, c) => s + c.sizeBytes, 0);
	if (total <= quota) return;

	// Own unpinned first
	const ownUnpinned = all.filter((s) => !s.pinned && s.backupOf == null &&
		(ownMonitor == null || s.originMonitor === ownMonitor));
	for (const seg of ownUnpinned) {
		if (total <= quota) break;
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	// Backup unpinned next
	const backupUnpinned = all.filter((s) => !s.pinned && s.backupOf != null);
	for (const seg of backupUnpinned) {
		if (total <= quota) break;
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	// Pinned as last resort
	if (total > quota) {
		const pinned = all.filter((s) => s.pinned).sort((a, b) => a.startTime - b.startTime);
		for (const seg of pinned) {
			if (total <= quota) break;
			await db.delete('segments', seg.segmentId);
			total -= seg.sizeBytes;
		}
	}
}

export async function getStorageUsed(originMonitor?: string): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	return all
		.filter((s) => originMonitor == null || s.originMonitor === originMonitor)
		.reduce((s, c) => s + c.sizeBytes, 0);
}

export async function clearAll(): Promise<void> {
	const db = await openDB();
	await db.clear('segments');
}

export async function clearForMonitor(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	for (const seg of all) {
		if (seg.originMonitor === originMonitor) await db.delete('segments', seg.segmentId);
	}
}
