import { openDB } from './idb';
import { randomUUID } from '$lib/utils';

export const SEGMENT_DURATION_S = 10;
export const PRE_ROLL_S = 30;
export const POST_ROLL_S = 30;
export const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024;

// Rolling buffer for unpinned segments: covers 2× the full trigger window (pre+post roll)
export const MAX_ROLLING_SEGMENTS = Math.ceil(((PRE_ROLL_S + POST_ROLL_S) * 2) / SEGMENT_DURATION_S);
// Hard cap across all segments including pinned. Prevents trigger-pinned segments
// from accumulating indefinitely and exhausting OPFS quota.
export const HARD_CAP_SEGMENTS = MAX_ROLLING_SEGMENTS * 3;

export interface Segment {
	segmentId: string;
	startTime: number;
	endTime: number;
	mimeType: string;
	sizeBytes: number;
	pinned: boolean;
	// null = no expiry (manual pin or legacy record); 0 = pinned forever; unix sec = expires at
	pinnedUntil: number | null;
	originMonitor: string;
	backupOf: string | null;
}

export type SegmentWithBlob = Segment & { blob: Blob };

// ── OPFS helpers ─────────────────────────────────────────────────────────────

let _opfsDir: FileSystemDirectoryHandle | null = null;

// Tests can override blob storage with an in-memory map for isolation.
let _testBlobStore: Map<string, Blob> | null = null;

export function _setTestBlobStore(store: Map<string, Blob> | null): void {
	_testBlobStore = store;
}

export function _resetOpfsDirForTest(): void {
	_opfsDir = null;
}

async function getOpfsDir(): Promise<FileSystemDirectoryHandle> {
	if (_opfsDir) return _opfsDir;
	const root = await navigator.storage.getDirectory();
	_opfsDir = await root.getDirectoryHandle('recordings', { create: true });
	return _opfsDir;
}

async function writeSegmentBlob(segmentId: string, blob: Blob): Promise<void> {
	if (_testBlobStore) {
		_testBlobStore.set(segmentId, blob);
		return;
	}
	const dir = await getOpfsDir();
	const file = await dir.getFileHandle(segmentId, { create: true });
	const writable = await file.createWritable({ keepExistingData: false });
	try {
		await writable.write(blob);
		await writable.close();
	} catch (e) {
		try { await writable.abort(); } catch { /* ignore abort errors */ }
		throw e;
	}
}

// Removes OPFS files that have no corresponding IDB segment record.
// These accumulate when writes fail partway (the file handle is created before
// the write errors, leaving a 0-byte or partial file that counts against quota).
export async function cleanupOrphanedOpfsFiles(): Promise<number> {
	if (_testBlobStore) return 0;
	try {
		const dir = await getOpfsDir();
		const db = await openDB();
		const known = new Set((await db.getAll('segments') as Segment[]).map(s => s.segmentId));
		let removed = 0;
		for await (const name of dir.keys()) {
			if (!known.has(name)) {
				await dir.removeEntry(name).catch(() => {});
				removed++;
			}
		}
		return removed;
	} catch {
		return 0;
	}
}

async function readSegmentBlob(segmentId: string): Promise<Blob | null> {
	if (_testBlobStore) {
		return _testBlobStore.get(segmentId) ?? null;
	}
	try {
		const dir = await getOpfsDir();
		const file = await dir.getFileHandle(segmentId);
		return await file.getFile();
	} catch (e) {
		if (e instanceof DOMException && e.name === 'NotFoundError') return null;
		throw e;
	}
}

async function deleteSegmentBlob(segmentId: string): Promise<void> {
	if (_testBlobStore) {
		_testBlobStore.delete(segmentId);
		return;
	}
	try {
		const dir = await getOpfsDir();
		await dir.removeEntry(segmentId);
	} catch (e) {
		if (e instanceof DOMException && e.name === 'NotFoundError') return;
		throw e;
	}
}

// ── Rolling buffer ────────────────────────────────────────────────────────────

async function enforceRollingBuffer(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter(s => s.originMonitor === originMonitor)
		.sort((a, b) => a.startTime - b.startTime);

	// Step 1: rolling buffer — evict oldest unpinned first.
	const unpinned = all.filter(s => !s.pinned);
	const evicted = new Set<string>();
	const excessUnpinned = unpinned.length - (MAX_ROLLING_SEGMENTS - 1);
	for (let i = 0; i < excessUnpinned; i++) {
		await deleteSegmentBlob(unpinned[i].segmentId);
		await db.delete('segments', unpinned[i].segmentId);
		evicted.add(unpinned[i].segmentId);
	}

	// Step 2: hard cap — evict oldest segments (including pinned) if still over limit.
	// Pinned segments accumulate from trigger sessions; without this cap they exhaust quota.
	const remaining = all.filter(s => !evicted.has(s.segmentId));
	const excessTotal = remaining.length - (HARD_CAP_SEGMENTS - 1);
	for (let i = 0; i < excessTotal; i++) {
		await deleteSegmentBlob(remaining[i].segmentId);
		await db.delete('segments', remaining[i].segmentId);
	}
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function saveSegment(
	blob: Blob,
	mimeType: string,
	startTime: number,
	endTime: number,
	originMonitor: string,
	backupOf: string | null = null,
	existingId?: string
): Promise<string> {
	await enforceRollingBuffer(originMonitor);

	const segmentId = existingId ?? randomUUID();

	// Write blob to OPFS first — if this fails, no phantom IDB record is created.
	try {
		await writeSegmentBlob(segmentId, blob);
	} catch (e) {
		if (e instanceof DOMException && e.name === 'QuotaExceededError') {
			// Free space: remove orphaned OPFS files, then evict old/pinned segments.
			await cleanupOrphanedOpfsFiles();
			await evictUnpinned(originMonitor);
			// One retry — if quota is still exhausted the caller gets the real error.
			await writeSegmentBlob(segmentId, blob);
		} else {
			throw e;
		}
	}

	const record: Segment = {
		segmentId,
		mimeType,
		startTime,
		endTime,
		sizeBytes: blob.size,
		pinned: false,
		pinnedUntil: null,
		originMonitor,
		backupOf
	};
	const db = await openDB();
	await db.put('segments', record);
	return segmentId;
}

// ── Pin ───────────────────────────────────────────────────────────────────────

// Returns the longer-surviving pinnedUntil. 0 = forever (always wins).
// Never reduces an existing expiry to a shorter one.
function mergePinnedUntil(existing: number | null | undefined, next: number): number {
	if (existing === 0) return 0;
	if (next === 0) return 0;
	if (existing == null || existing === undefined) return next;
	return Math.max(existing, next);
}

// pinnedUntil: 0 = forever; unix-sec timestamp = expires at that time.
// mimeTypePrefix: optional filter, e.g. 'video/' or 'image/'.
// Existing pins are never shortened (mergePinnedUntil).
export async function pinRange(
	fromTime: number,
	toTime: number,
	pinnedUntil: number = 0,
	mimeTypePrefix?: string
): Promise<string[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	const toPin = all.filter((s) =>
		s.endTime >= fromTime &&
		s.startTime <= toTime &&
		(mimeTypePrefix == null || s.mimeType.startsWith(mimeTypePrefix))
	);
	const tx = db.transaction('segments', 'readwrite');
	await Promise.all(toPin.map((s) => tx.store.put({
		...s,
		pinned: true,
		pinnedUntil: mergePinnedUntil(s.pinnedUntil, pinnedUntil),
	})));
	await tx.done;
	return toPin.map((s) => s.segmentId);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getSegmentById(segmentId: string): Promise<SegmentWithBlob | undefined> {
	const db = await openDB();
	const meta = await db.get('segments', segmentId) as Segment | undefined;
	if (!meta) return undefined;
	const blob = await readSegmentBlob(segmentId);
	if (!blob) return undefined;
	return { ...meta, blob };
}

export async function getSegmentAt(time: number, originMonitor?: string): Promise<SegmentWithBlob | undefined> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	const meta = all.find((s) =>
		s.startTime <= time &&
		s.endTime > time &&
		(originMonitor == null || s.originMonitor === originMonitor)
	);
	if (!meta) return undefined;
	return getSegmentById(meta.segmentId);
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

export async function getCoverageMap(originMonitor?: string, mimePrefix?: string): Promise<[number, number][]> {
	const db = await openDB();
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter((s) =>
			(originMonitor == null || s.originMonitor === originMonitor) &&
			(mimePrefix == null || s.mimeType.startsWith(mimePrefix))
		)
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

// ── Quota / eviction ──────────────────────────────────────────────────────────

async function getQuota(): Promise<number> {
	const db = await openDB();
	return (await db.get('settings', 'segments.quotaBytes') as number | undefined) ?? DEFAULT_QUOTA_BYTES;
}

export async function setQuota(bytes: number): Promise<void> {
	const db = await openDB();
	await db.put('settings', bytes, 'segments.quotaBytes');
}

export async function evictUnpinned(ownMonitor?: string): Promise<void> {
	const db = await openDB();
	const quota = await getQuota();
	const now = Math.floor(Date.now() / 1000);
	const maxUnpinnedAge = PRE_ROLL_S * 2;

	let all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);

	for (const seg of all) {
		if (!seg.pinned && seg.backupOf == null && now - seg.endTime > maxUnpinnedAge) {
			if (ownMonitor == null || seg.originMonitor === ownMonitor) {
				await deleteSegmentBlob(seg.segmentId);
				await db.delete('segments', seg.segmentId);
			}
		}
	}

	all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);
	let total = all.reduce((s, c) => s + c.sizeBytes, 0);
	if (total <= quota) return;

	const ownUnpinned = all.filter((s) => !s.pinned && s.backupOf == null &&
		(ownMonitor == null || s.originMonitor === ownMonitor));
	for (const seg of ownUnpinned) {
		if (total <= quota) break;
		await deleteSegmentBlob(seg.segmentId);
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	const backupUnpinned = all.filter((s) => !s.pinned && s.backupOf != null);
	for (const seg of backupUnpinned) {
		if (total <= quota) break;
		await deleteSegmentBlob(seg.segmentId);
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	if (total > quota) {
		const pinned = all.filter((s) => s.pinned).sort((a, b) => a.startTime - b.startTime);
		for (const seg of pinned) {
			if (total <= quota) break;
			await deleteSegmentBlob(seg.segmentId);
			await db.delete('segments', seg.segmentId);
			total -= seg.sizeBytes;
		}
	}
}

export async function getDistinctOriginMonitors(): Promise<string[]> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	return [...new Set(all.map(s => s.originMonitor))];
}

export async function getStorageUsed(originMonitor?: string): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	return all
		.filter((s) => originMonitor == null || s.originMonitor === originMonitor)
		.reduce((s, c) => s + c.sizeBytes, 0);
}

// pinnedUntil: 0 = forever; unix-sec timestamp = expires at that time.
// Existing pins are never shortened.
export async function pinSegment(segmentId: string, pinnedUntil: number = 0): Promise<void> {
	const db = await openDB();
	const seg = await db.get('segments', segmentId) as Segment | undefined;
	if (seg) await db.put('segments', {
		...seg,
		pinned: true,
		pinnedUntil: mergePinnedUntil(seg.pinnedUntil, pinnedUntil),
	});
}

export async function unpinSegment(segmentId: string): Promise<void> {
	const db = await openDB();
	const seg = await db.get('segments', segmentId) as Segment | undefined;
	if (seg) await db.put('segments', { ...seg, pinned: false, pinnedUntil: null });
}

// Checks each segment's own pinnedUntil and unpins those past their expiry.
// pinnedUntil=null (no expiry tracking) and pinnedUntil=0 (forever) are never expired.
// Unpinned segments become eligible for rolling-buffer eviction on the next saveSegment.
export async function expirePinnedSegments(): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	const now = Math.floor(Date.now() / 1000);
	let count = 0;
	for (const seg of all) {
		const until = seg.pinnedUntil;
		if (seg.pinned && until != null && until !== 0 && now > until) {
			await db.put('segments', { ...seg, pinned: false, pinnedUntil: null });
			count++;
		}
	}
	return count;
}

export async function deleteSegment(segmentId: string): Promise<void> {
	await deleteSegmentBlob(segmentId);
	const db = await openDB();
	await db.delete('segments', segmentId);
}

export async function clearAll(): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	for (const seg of all) {
		await deleteSegmentBlob(seg.segmentId);
	}
	await db.clear('segments');
}

export async function clearForMonitor(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	for (const seg of all) {
		if (seg.originMonitor === originMonitor) {
			await deleteSegmentBlob(seg.segmentId);
			await db.delete('segments', seg.segmentId);
		}
	}
}
