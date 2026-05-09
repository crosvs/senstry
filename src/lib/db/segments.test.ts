import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
	saveSegment, pinRange, getSegmentById, getSegmentsInRange,
	getCoverageMap, clearForMonitor, getStorageUsed,
	MAX_ROLLING_SEGMENTS, _setTestBlobStore, _resetOpfsDirForTest,
} from './segments';
import { _resetDbForTest } from './idb';

const MONITOR_A = 'a'.repeat(64);
const MONITOR_B = 'b'.repeat(64);

beforeEach(() => {
	(globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
	_resetDbForTest();
	_resetOpfsDirForTest();
	_setTestBlobStore(new Map<string, Blob>());
});

function blob(content = 'x') {
	return new Blob([content], { type: 'audio/webm' });
}

// ── saveSegment ──────────────────────────────────────────────────────────────

describe('saveSegment', () => {
	it('saves and retrieves a segment by id', async () => {
		const id = await saveSegment(blob(), 'audio/webm', 1000, 1010, MONITOR_A, 'default-mic');
		const seg = await getSegmentById(id);
		expect(seg).toBeDefined();
		expect(seg!.startTime).toBe(1000);
		expect(seg!.endTime).toBe(1010);
		expect(seg!.originMonitor).toBe(MONITOR_A);
		expect(seg!.pinned).toBe(false);
		expect(seg!.sizeBytes).toBeGreaterThan(0);
	});

	it('enforces rolling buffer: total unpinned per monitor stays ≤ MAX_ROLLING_SEGMENTS', async () => {
		for (let i = 0; i < MAX_ROLLING_SEGMENTS + 3; i++) {
			await saveSegment(blob(), 'audio/webm', i * 10, (i + 1) * 10, MONITOR_A, 'default-mic');
		}
		const { openDB } = await import('./idb');
		const db = await openDB();
		const all = (await db.getAll('segments') as { pinned: boolean; originMonitor: string }[])
			.filter(s => !s.pinned && s.originMonitor === MONITOR_A);
		expect(all.length).toBeLessThanOrEqual(MAX_ROLLING_SEGMENTS);
	});

	it('evicts oldest segments first', async () => {
		for (let i = 0; i < MAX_ROLLING_SEGMENTS + 3; i++) {
			await saveSegment(blob(), 'audio/webm', i * 10, (i + 1) * 10, MONITOR_A, 'default-mic');
		}
		// The last MAX_ROLLING_SEGMENTS segments should be retained
		const segs = await getSegmentsInRange(0, (MAX_ROLLING_SEGMENTS + 3) * 10, MONITOR_A);
		const minStart = Math.min(...segs.map(s => s.startTime));
		// At least 3 oldest segments have been evicted
		expect(minStart).toBeGreaterThan(0);
	});

	it('does not evict segments from other monitors', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_B, 'default-mic');
		for (let i = 1; i < MAX_ROLLING_SEGMENTS + 3; i++) {
			await saveSegment(blob(), 'audio/webm', i * 10, (i + 1) * 10, MONITOR_A, 'default-mic');
		}
		const bSegs = await getSegmentsInRange(0, 10, MONITOR_B);
		expect(bSegs).toHaveLength(1);
	});

	it('does not evict pinned segments', async () => {
		// Save and pin 2 segments
		const id1 = await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		const id2 = await saveSegment(blob(), 'audio/webm', 10, 20, MONITOR_A, 'default-mic');
		await pinRange(0, 20);

		// Flood with new unpinned segments
		for (let i = 3; i < MAX_ROLLING_SEGMENTS + 5; i++) {
			await saveSegment(blob(), 'audio/webm', i * 100, (i + 1) * 100, MONITOR_A, 'default-mic');
		}

		// Pinned segments must still be there
		expect(await getSegmentById(id1)).toBeDefined();
		expect(await getSegmentById(id2)).toBeDefined();
	});
});

// ── pinRange ─────────────────────────────────────────────────────────────────

describe('pinRange', () => {
	it('returns empty array when no segments exist (startup race condition)', async () => {
		const ids = await pinRange(1000, 1060);
		expect(ids).toHaveLength(0);
	});

	it('returns all segments overlapping the range', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');   // overlaps [5,25]
		await saveSegment(blob(), 'audio/webm', 10, 20, MONITOR_A, 'default-mic');  // overlaps
		await saveSegment(blob(), 'audio/webm', 20, 30, MONITOR_A, 'default-mic');  // overlaps (endTime=30 > from=5, startTime=20 <= to=25)
		await saveSegment(blob(), 'audio/webm', 50, 60, MONITOR_A, 'default-mic');  // outside

		const ids = await pinRange(5, 25);
		expect(ids).toHaveLength(3);
	});

	it('marks matched segments as pinned in IDB', async () => {
		const id = await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await pinRange(0, 10);
		const seg = await getSegmentById(id);
		expect(seg!.pinned).toBe(true);
	});

	it('does not pin segments outside the range', async () => {
		const id = await saveSegment(blob(), 'audio/webm', 100, 110, MONITOR_A, 'default-mic');
		await pinRange(0, 50);
		const seg = await getSegmentById(id);
		expect(seg!.pinned).toBe(false);
	});
});

// ── getSegmentsInRange ────────────────────────────────────────────────────────

describe('getSegmentsInRange', () => {
	it('returns segments whose time window overlaps the query range', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 10, 20, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 50, 60, MONITOR_A, 'default-mic');

		const segs = await getSegmentsInRange(5, 15, MONITOR_A);
		expect(segs).toHaveLength(2);
	});

	it('returns results sorted by startTime', async () => {
		await saveSegment(blob(), 'audio/webm', 20, 30, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 10, 20, MONITOR_A, 'default-mic');

		const segs = await getSegmentsInRange(0, 30);
		expect(segs.map(s => s.startTime)).toEqual([0, 10, 20]);
	});

	it('filters by originMonitor when provided', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_B, 'default-mic');

		const segs = await getSegmentsInRange(0, 10, MONITOR_A);
		expect(segs).toHaveLength(1);
		expect(segs[0].originMonitor).toBe(MONITOR_A);
	});

	it('returns all monitors when no filter provided', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_B, 'default-mic');
		const segs = await getSegmentsInRange(0, 10);
		expect(segs).toHaveLength(2);
	});
});

// ── getCoverageMap ────────────────────────────────────────────────────────────

describe('getCoverageMap', () => {
	it('returns empty array when no segments', async () => {
		expect(await getCoverageMap()).toHaveLength(0);
	});

	it('merges contiguous segments into one range', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 10, 20, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 20, 30, MONITOR_A, 'default-mic');

		const map = await getCoverageMap(MONITOR_A);
		expect(map).toHaveLength(1);
		expect(map[0]).toEqual([0, 30]);
	});

	it('produces separate ranges when there is a gap', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 20, 30, MONITOR_A, 'default-mic'); // gap at [10,20]

		const map = await getCoverageMap(MONITOR_A);
		expect(map).toHaveLength(2);
		expect(map[0]).toEqual([0, 10]);
		expect(map[1]).toEqual([20, 30]);
	});

	it('filters by originMonitor', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_B, 'default-mic');

		const map = await getCoverageMap(MONITOR_A);
		expect(map).toHaveLength(1);
	});
});

// ── clearForMonitor ───────────────────────────────────────────────────────────

describe('clearForMonitor', () => {
	it('removes all segments for the specified monitor', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 10, 20, MONITOR_A, 'default-mic');
		await clearForMonitor(MONITOR_A);
		expect(await getSegmentsInRange(0, 20, MONITOR_A)).toHaveLength(0);
	});

	it('does not touch segments for other monitors', async () => {
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_B, 'default-mic');
		await clearForMonitor(MONITOR_A);
		expect(await getSegmentsInRange(0, 10, MONITOR_B)).toHaveLength(1);
	});

	it('removes pinned segments too', async () => {
		const id = await saveSegment(blob(), 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await pinRange(0, 10);
		await clearForMonitor(MONITOR_A);
		expect(await getSegmentById(id)).toBeUndefined();
	});
});

// ── getStorageUsed ────────────────────────────────────────────────────────────

describe('getStorageUsed', () => {
	it('returns 0 when empty', async () => {
		expect(await getStorageUsed()).toBe(0);
	});

	it('returns sum of sizeBytes for matching segments', async () => {
		const b1 = new Blob(['hello'], { type: 'audio/webm' }); // 5 bytes
		const b2 = new Blob(['world!'], { type: 'audio/webm' }); // 6 bytes
		await saveSegment(b1, 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(b2, 'audio/webm', 10, 20, MONITOR_A, 'default-mic');
		expect(await getStorageUsed(MONITOR_A)).toBe(11);
	});

	it('filters by monitor when provided', async () => {
		const b = new Blob(['abc'], { type: 'audio/webm' });
		await saveSegment(b, 'audio/webm', 0, 10, MONITOR_A, 'default-mic');
		await saveSegment(b, 'audio/webm', 0, 10, MONITOR_B, 'default-mic');
		expect(await getStorageUsed(MONITOR_A)).toBe(3);
	});
});
