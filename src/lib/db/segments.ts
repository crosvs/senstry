import { openDB } from './idb';
import { randomUUID } from '$lib/utils';
import { dbg } from '$lib/store/debug';

function _fmtTs(unix: number): string {
	const d = new Date(unix * 1000);
	return d.toLocaleTimeString('en-GB', { hour12: false });
}

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
	// null = never been pinned (rolling buffer candidate, evicted to maintain buffer size)
	// -1   = was pinned but pin expired (not a rolling buffer candidate; left for thinning rules)
	// 0    = pinned forever
	// N>0  = pinned until unix timestamp N
	pinnedUntil: number | null;
	originMonitor: string;
	sourceId: string;   // which input device produced this segment; legacy records default to 'default-mic'
	backupOf: string | null;
	contentHash: string; // SHA-256 hex of blob content; '' for pre-v6 records (hash unavailable)
}

export async function computeHash(blob: Blob): Promise<string> {
	const buf = await blob.arrayBuffer();
	const hashBuf = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hashBuf))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
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

// Effective rolling buffer set by SentrySection when the monitor starts.
// null = infinite (skip rolling eviction; rely on thinning + quota for cleanup).
// Computed as max(all enabled links' rollingBufferSec); any null → null.
let _maxRollingBufferSec: number | null = null;

export function setMonitorRollingBuffer(sec: number | null): void {
	_maxRollingBufferSec = sec;
}

// Segments accumulated before hard cap when rolling buffer is infinite.
// Acts as safety net for sessions without thinning rules configured.
// 360 segments ≈ 1 hour of 10-second rolling footage per monitor.
const INFINITE_HARD_CAP_SEGMENTS = 360;

function _isActivePinned(s: Segment): boolean {
	if (!s.pinned) return false;
	const until = s.pinnedUntil;
	// null = no expiry (legacy manual pin), 0 = forever — both are permanently pinned
	if (until === null || until === 0) return true;
	return Math.floor(Date.now() / 1000) <= until;
}

async function enforceRollingBuffer(originMonitor: string): Promise<void> {
	const rollingBufferSec = _maxRollingBufferSec;
	const db = await openDB();

	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter(s => s.originMonitor === originMonitor)
		.sort((a, b) => a.startTime - b.startTime);

	// Step 1: rolling buffer — evict oldest never-pinned segments to stay within the buffer size.
	// Segments with pinnedUntil === -1 had their pin expire; they are excluded here so they
	// survive until thinning rules clean them up.
	// Skipped entirely when rollingBufferSec is null (infinite): cleanup manages deletion instead.
	const evicted = new Set<string>();
	if (rollingBufferSec !== null) {
		const maxRollingSegments = Math.max(1, Math.ceil(rollingBufferSec / SEGMENT_DURATION_S));
		const rollingUnpinned = all.filter(s => !s.pinned && s.pinnedUntil === null);
		const excessRolling = rollingUnpinned.length - (maxRollingSegments - 1);
		for (let i = 0; i < excessRolling; i++) {
			const s = rollingUnpinned[i];
			dbg('info', 'idb', `rolling-buf evict: ${s.segmentId.slice(0, 8)} [${_fmtTs(s.startTime)}–${_fmtTs(s.endTime)}] ${s.mimeType}`);
			await deleteSegmentBlob(s.segmentId);
			await db.delete('segments', s.segmentId);
			evicted.add(s.segmentId);
		}
	}

	// Step 2: hard cap — evict oldest non-pinned-active segments if still over limit.
	// Uses generous cap when rolling buffer is infinite so thinning + quota manage cleanup,
	// but an absolute floor still prevents runaway accumulation with no cleanup configured.
	const hardCapSegments = rollingBufferSec !== null
		? Math.max(1, Math.ceil(rollingBufferSec / SEGMENT_DURATION_S)) * 3
		: INFINITE_HARD_CAP_SEGMENTS;
	const remaining = all.filter(s => !evicted.has(s.segmentId));
	const unpinnedRemaining = remaining.filter(s => !_isActivePinned(s));
	const excessTotal = unpinnedRemaining.length - (hardCapSegments - 1);
	for (let i = 0; i < excessTotal; i++) {
		const s = unpinnedRemaining[i];
		dbg('warn', 'idb', `hard-cap evict: ${s.segmentId.slice(0, 8)} [${_fmtTs(s.startTime)}–${_fmtTs(s.endTime)}] ${s.mimeType}`);
		await deleteSegmentBlob(s.segmentId);
		await db.delete('segments', s.segmentId);
	}
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function saveSegment(
	blob: Blob,
	mimeType: string,
	startTime: number,
	endTime: number,
	originMonitor: string,
	sourceId: string,
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

	const contentHash = await computeHash(blob);

	const record: Segment = {
		segmentId,
		mimeType,
		startTime,
		endTime,
		sizeBytes: blob.size,
		pinned: false,
		pinnedUntil: null,
		originMonitor,
		sourceId,
		backupOf,
		contentHash,
	};
	const db = await openDB();
	await db.put('segments', record);
	return segmentId;
}

// ── Pin ───────────────────────────────────────────────────────────────────────

// Returns the longer-surviving pinnedUntil. 0 = forever (always wins).
// Never reduces an existing expiry to a shorter one.
// -1 (expired sentinel) is treated as unset — the new pin timestamp always wins.
function mergePinnedUntil(existing: number | null | undefined, next: number): number {
	if (existing === 0) return 0;
	if (next === 0) return 0;
	if (existing == null || existing === undefined || existing === -1) return next;
	return Math.max(existing, next);
}

// pinnedUntil: 0 = forever; unix-sec timestamp = expires at that time.
// mimeTypePrefix: optional filter, e.g. 'video/' or 'image/'.
// Existing pins are never shortened (mergePinnedUntil).
export async function pinRange(
	fromTime: number,
	toTime: number,
	pinnedUntil: number = 0,
	mimeTypePrefix?: string,
	sourceId?: string
): Promise<string[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	const toPin = all.filter((s) =>
		s.endTime >= fromTime &&
		s.startTime <= toTime &&
		(mimeTypePrefix == null || s.mimeType.startsWith(mimeTypePrefix)) &&
		(sourceId == null || (s.sourceId ?? 'default-mic') === sourceId)
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

export async function getSegmentByHash(hash: string): Promise<Segment | undefined> {
	if (!hash) return undefined;
	const db = await openDB();
	return db.getFromIndex('segments', 'contentHash', hash) as Promise<Segment | undefined>;
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

export async function getSegmentsAfter(after: number, count: number, originMonitor?: string, mimePrefix?: string): Promise<Segment[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all
		.filter(s =>
			s.startTime >= after &&
			(originMonitor == null || s.originMonitor === originMonitor) &&
			(mimePrefix == null || s.mimeType.startsWith(mimePrefix))
		)
		.sort((a, b) => a.startTime - b.startTime)
		.slice(0, count);
}

export async function getSegmentsBefore(before: number, count: number, originMonitor?: string, mimePrefix?: string): Promise<Segment[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all
		.filter(s =>
			s.endTime <= before &&
			(originMonitor == null || s.originMonitor === originMonitor) &&
			(mimePrefix == null || s.mimeType.startsWith(mimePrefix))
		)
		.sort((a, b) => b.startTime - a.startTime) // newest first
		.slice(0, count);
}

export async function getSegmentsInRange(from: number, to: number, originMonitor?: string, sourceId?: string): Promise<Segment[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('segments', 'startTime') as Segment[];
	return all
		.filter((s) =>
			s.endTime >= from &&
			s.startTime <= to &&
			(originMonitor == null || s.originMonitor === originMonitor) &&
			(sourceId == null || (s.sourceId ?? 'default-mic') === sourceId)
		)
		.sort((a, b) => a.startTime - b.startTime);
}

export async function getCoverageMap(originMonitor?: string, mimePrefix?: string, sourceId?: string): Promise<[number, number][]> {
	const db = await openDB();
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter((s) =>
			(originMonitor == null || s.originMonitor === originMonitor) &&
			(mimePrefix == null || s.mimeType.startsWith(mimePrefix)) &&
			(sourceId == null || (s.sourceId ?? 'default-mic') === sourceId)
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

	// Note: age-based deletion has been removed. Segments are evicted by:
	// - enforceRollingBuffer() — keeps the rolling window trimmed on every saveSegment()
	// - thinSegments() — runs on a schedule to thin out older footage per configured rules
	// - quota-based eviction below — frees space when OPFS quota is exceeded

	let all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.sort((a, b) => a.startTime - b.startTime);
	let total = all.reduce((s, c) => s + c.sizeBytes, 0);
	if (total <= quota) return;

	dbg('warn', 'idb', `quota exceeded (${(total / 1024 / 1024).toFixed(1)} MB / ${(quota / 1024 / 1024).toFixed(1)} MB) — evicting`);

	const ownUnpinned = all.filter((s) => !s.pinned && s.backupOf == null &&
		(ownMonitor == null || s.originMonitor === ownMonitor));
	for (const seg of ownUnpinned) {
		if (total <= quota) break;
		dbg('info', 'idb', `quota-evict unpinned: ${seg.segmentId.slice(0, 8)} [${_fmtTs(seg.startTime)}] ${seg.mimeType}`);
		await deleteSegmentBlob(seg.segmentId);
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	const backupUnpinned = all.filter((s) => !s.pinned && s.backupOf != null);
	for (const seg of backupUnpinned) {
		if (total <= quota) break;
		dbg('info', 'idb', `quota-evict backup: ${seg.segmentId.slice(0, 8)} [${_fmtTs(seg.startTime)}] ${seg.mimeType}`);
		await deleteSegmentBlob(seg.segmentId);
		await db.delete('segments', seg.segmentId);
		total -= seg.sizeBytes;
	}

	if (total > quota) {
		const pinned = all.filter((s) => s.pinned).sort((a, b) => a.startTime - b.startTime);
		for (const seg of pinned) {
			if (total <= quota) break;
			dbg('warn', 'idb', `quota-evict PINNED (last resort): ${seg.segmentId.slice(0, 8)} [${_fmtTs(seg.startTime)}] ${seg.mimeType}`);
			await deleteSegmentBlob(seg.segmentId);
			await db.delete('segments', seg.segmentId);
			total -= seg.sizeBytes;
		}
	}
}

// ── Thinning ──────────────────────────────────────────────────────────────────

// ThinningRule is imported from pipeline.ts at runtime; redeclared here to avoid a circular dep.
export interface ThinningRule {
	afterAgeSec: number;
	keepOnePerSec: number;
	mimePrefix: string;  // '' = all types; 'image/' | 'video/' | 'audio/' = specific type
}

// Thins out older unpinned segments according to the supplied rules.
// Each rule: segments older than afterAgeSec (matching mimePrefix) are bucketed into
// keepOnePerSec-wide windows; only the oldest in each bucket is kept, the rest deleted.
// Actively-pinned segments are always exempt.
// Rules sorted by afterAgeSec desc so the most-aggressive pass runs first — a segment
// kept by a coarser rule is never then deleted by a finer one.
export async function thinSegments(rules: ThinningRule[], originMonitor?: string): Promise<number> {
	if (!rules.length) return 0;
	const db = await openDB();
	const now = Math.floor(Date.now() / 1000);
	const all = (await db.getAllFromIndex('segments', 'startTime') as Segment[])
		.filter(s =>
			(originMonitor == null || s.originMonitor === originMonitor) &&
			!_isActivePinned(s)
		)
		.sort((a, b) => a.startTime - b.startTime);

	// Apply rules from most-aggressive (largest afterAgeSec) to least, so outer thinning
	// doesn't interfere with inner thinning decisions.
	const sorted = [...rules].sort((a, b) => b.afterAgeSec - a.afterAgeSec);
	const toDelete = new Set<string>();
	const kept = new Set<string>();

	for (const rule of sorted) {
		const eligible = all.filter(s =>
			!toDelete.has(s.segmentId) &&
			now - s.endTime >= rule.afterAgeSec &&
			(!rule.mimePrefix || s.mimeType.startsWith(rule.mimePrefix))
		);
		// Group eligible into keepOnePerSec buckets; keep the first in each bucket
		const buckets = new Map<number, Segment[]>();
		for (const seg of eligible) {
			const bucket = Math.floor(seg.startTime / rule.keepOnePerSec);
			if (!buckets.has(bucket)) buckets.set(bucket, []);
			buckets.get(bucket)!.push(seg);
		}
		for (const segsInBucket of buckets.values()) {
			segsInBucket.sort((a, b) => a.startTime - b.startTime);
			const keepId = segsInBucket[0].segmentId;
			if (!kept.has(keepId)) kept.add(keepId);
			for (let i = 1; i < segsInBucket.length; i++) {
				const s = segsInBucket[i];
				if (!kept.has(s.segmentId)) toDelete.add(s.segmentId);
			}
		}
	}

	const segById = new Map(all.map(s => [s.segmentId, s]));
	for (const segId of toDelete) {
		const s = segById.get(segId);
		if (s) dbg('info', 'idb', `thin: ${segId.slice(0, 8)} [${_fmtTs(s.startTime)}] ${s.mimeType}`);
		await deleteSegmentBlob(segId);
		await db.delete('segments', segId);
	}

	if (toDelete.size > 0) dbg('info', 'idb', `thinning complete: removed ${toDelete.size} segment(s)`);
	return toDelete.size;
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
// pinnedUntil=null (never pinned) and pinnedUntil=0 (forever) are never expired.
// Sets pinnedUntil to -1 (expired sentinel) so the rolling buffer knows NOT to evict
// these segments immediately — they survive until thinning rules clean them up.
export async function expirePinnedSegments(): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	const now = Math.floor(Date.now() / 1000);
	let count = 0;
	for (const seg of all) {
		const until = seg.pinnedUntil;
		if (seg.pinned && until != null && until !== 0 && until !== -1 && now > until) {
			// Use -1 as "expired" sentinel rather than null ("never pinned"), so rolling
			// buffer eviction skips these and lets thinning rules handle them.
			await db.put('segments', { ...seg, pinned: false, pinnedUntil: -1 });
			count++;
		}
	}
	return count;
}

export async function deleteSegment(segmentId: string): Promise<void> {
	const db = await openDB();
	const seg = await db.get('segments', segmentId) as Segment | undefined;
	if (seg) dbg('info', 'idb', `delete segment: ${segmentId.slice(0, 8)} [${_fmtTs(seg.startTime)}–${_fmtTs(seg.endTime)}] ${seg.mimeType}${seg.pinned ? ' (was pinned)' : ''}`);
	await deleteSegmentBlob(segmentId);
	await db.delete('segments', segmentId);
}

export async function clearAll(): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	dbg('warn', 'idb', `clear all: deleting ${all.length} segment(s)`);
	for (const seg of all) {
		await deleteSegmentBlob(seg.segmentId);
	}
	await db.clear('segments');
}

export async function clearForMonitor(originMonitor: string): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('segments') as Segment[];
	const toDelete = all.filter(s => s.originMonitor === originMonitor);
	dbg('warn', 'idb', `clear monitor ${originMonitor.slice(0, 8)}: deleting ${toDelete.length} segment(s)`);
	for (const seg of toDelete) {
		await deleteSegmentBlob(seg.segmentId);
		await db.delete('segments', seg.segmentId);
	}
}
