import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
	createFootageRef, updateFootageRef, getFootageRef,
	getFootageRefsForDay, softDeleteFootageRef,
	clearFootageRefsForMonitor, getAllFootageRefs,
	getUnpublishedRefs, markRefPublished,
} from './footage';
import { _resetDbForTest } from './idb';

const MONITOR_A = 'a'.repeat(64);
const MONITOR_B = 'b'.repeat(64);

// A fixed day boundary for deterministic tests (2025-05-07 00:00 UTC)
const DAY_START = 1746576000;
const DAY_END = DAY_START + 86400;

beforeEach(() => {
	(globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
	_resetDbForTest();
});

const BASE = {
	originMonitor: MONITOR_A,
	type: 'video' as const,
	startTime: DAY_START + 100,
	endTime: DAY_START + 160,
	segmentIds: [] as string[],
	snapshotIds: [] as string[],
	pinned: false,
};

// ── createFootageRef ──────────────────────────────────────────────────────────

describe('createFootageRef', () => {
	it('generates a unique refId', async () => {
		const a = await createFootageRef(BASE);
		const b = await createFootageRef(BASE);
		expect(a.refId).not.toBe(b.refId);
	});

	it('sets expected default fields', async () => {
		const ref = await createFootageRef(BASE);
		expect(ref.deleted).toBe(false);
		expect(ref.nostrEventId).toBeNull();
		expect(ref.publishedAt).toBeNull();
		expect(ref.nostrDeleteEventId).toBeNull();
		expect(ref.backupSources).toEqual([]);
		expect(ref.updatedAt).toBeGreaterThan(0);
	});

	it('persists the ref to IDB', async () => {
		const ref = await createFootageRef(BASE);
		const fetched = await getFootageRef(ref.refId);
		expect(fetched).toBeDefined();
		expect(fetched!.refId).toBe(ref.refId);
		expect(fetched!.startTime).toBe(BASE.startTime);
	});
});

// ── updateFootageRef ──────────────────────────────────────────────────────────

describe('updateFootageRef', () => {
	it('updates segmentIds and persists', async () => {
		const ref = await createFootageRef(BASE);
		const segIds = ['seg-1', 'seg-2', 'seg-3'];
		const updated = await updateFootageRef(ref.refId, { segmentIds: segIds });
		expect(updated!.segmentIds).toEqual(segIds);

		const fetched = await getFootageRef(ref.refId);
		expect(fetched!.segmentIds).toEqual(segIds);
	});

	it('returns null for an unknown refId', async () => {
		const result = await updateFootageRef('nonexistent', { segmentIds: ['x'] });
		expect(result).toBeNull();
	});

	it('only patches specified fields, leaves others intact', async () => {
		const ref = await createFootageRef({ ...BASE, startTime: 9999 });
		await updateFootageRef(ref.refId, { segmentIds: ['x'] });
		const fetched = await getFootageRef(ref.refId);
		expect(fetched!.startTime).toBe(9999);
		expect(fetched!.segmentIds).toEqual(['x']);
	});

	it('bumps updatedAt on every patch', async () => {
		const ref = await createFootageRef(BASE);
		const before = ref.updatedAt;
		await new Promise(r => setTimeout(r, 5)); // ensure time advances
		const updated = await updateFootageRef(ref.refId, { segmentIds: ['x'] });
		expect(updated!.updatedAt).toBeGreaterThan(before);
	});
});

// ── getFootageRefsForDay ──────────────────────────────────────────────────────

describe('getFootageRefsForDay', () => {
	it('returns refs whose startTime falls within the day window', async () => {
		await createFootageRef(BASE); // in window
		await createFootageRef({ ...BASE, startTime: DAY_END + 100, endTime: DAY_END + 200 }); // next day

		const refs = await getFootageRefsForDay(DAY_START, DAY_END, MONITOR_A);
		expect(refs).toHaveLength(1);
	});

	it('filters by originMonitor when provided', async () => {
		await createFootageRef({ ...BASE, originMonitor: MONITOR_A });
		await createFootageRef({ ...BASE, originMonitor: MONITOR_B });

		const refs = await getFootageRefsForDay(DAY_START, DAY_END, MONITOR_A);
		expect(refs).toHaveLength(1);
		expect(refs[0].originMonitor).toBe(MONITOR_A);
	});

	it('returns all monitors when no filter provided', async () => {
		await createFootageRef({ ...BASE, originMonitor: MONITOR_A });
		await createFootageRef({ ...BASE, originMonitor: MONITOR_B });

		const refs = await getFootageRefsForDay(DAY_START, DAY_END);
		expect(refs).toHaveLength(2);
	});

	it('excludes soft-deleted refs', async () => {
		const ref = await createFootageRef(BASE);
		await softDeleteFootageRef(ref.refId);

		const refs = await getFootageRefsForDay(DAY_START, DAY_END);
		expect(refs).toHaveLength(0);
	});
});

// ── softDeleteFootageRef ──────────────────────────────────────────────────────

describe('softDeleteFootageRef', () => {
	it('marks deleted and clears segment/snapshot IDs', async () => {
		const ref = await createFootageRef({ ...BASE, segmentIds: ['s1', 's2'], snapshotIds: ['p1'] });
		const updated = await softDeleteFootageRef(ref.refId);
		expect(updated!.deleted).toBe(true);
		expect(updated!.segmentIds).toEqual([]);
		expect(updated!.snapshotIds).toEqual([]);
	});

	it('persists the deletion to IDB', async () => {
		const ref = await createFootageRef(BASE);
		await softDeleteFootageRef(ref.refId);
		const fetched = await getFootageRef(ref.refId);
		expect(fetched!.deleted).toBe(true);
	});
});

// ── clearFootageRefsForMonitor ────────────────────────────────────────────────

describe('clearFootageRefsForMonitor', () => {
	it('hard-deletes all refs for the specified monitor', async () => {
		await createFootageRef({ ...BASE, originMonitor: MONITOR_A });
		await createFootageRef({ ...BASE, originMonitor: MONITOR_A });
		await clearFootageRefsForMonitor(MONITOR_A);

		const all = await getAllFootageRefs();
		expect(all.filter(r => r.originMonitor === MONITOR_A)).toHaveLength(0);
	});

	it('does not touch refs for other monitors', async () => {
		await createFootageRef({ ...BASE, originMonitor: MONITOR_A });
		await createFootageRef({ ...BASE, originMonitor: MONITOR_B });
		await clearFootageRefsForMonitor(MONITOR_A);

		const all = await getAllFootageRefs();
		expect(all.filter(r => r.originMonitor === MONITOR_B)).toHaveLength(1);
	});

	it('removes pinned and deleted refs too', async () => {
		const ref = await createFootageRef({ ...BASE, pinned: true });
		await softDeleteFootageRef(ref.refId);
		await clearFootageRefsForMonitor(MONITOR_A);
		expect(await getFootageRef(ref.refId)).toBeUndefined();
	});
});

// ── getUnpublishedRefs / markRefPublished ────────────────────────────────────

describe('publish tracking', () => {
	it('getUnpublishedRefs returns refs with null publishedAt', async () => {
		await createFootageRef(BASE);
		const unpublished = await getUnpublishedRefs();
		expect(unpublished).toHaveLength(1);
	});

	it('markRefPublished removes the ref from unpublished list', async () => {
		const ref = await createFootageRef(BASE);
		await markRefPublished(ref.refId, 'nostr-event-id-123');

		const unpublished = await getUnpublishedRefs();
		expect(unpublished).toHaveLength(0);

		const fetched = await getFootageRef(ref.refId);
		expect(fetched!.nostrEventId).toBe('nostr-event-id-123');
		expect(fetched!.publishedAt).not.toBeNull();
	});

	it('re-queues ref when updatedAt > publishedAt', async () => {
		const ref = await createFootageRef(BASE);
		await markRefPublished(ref.refId, 'ev-1');
		await new Promise(r => setTimeout(r, 5));
		await updateFootageRef(ref.refId, { segmentIds: ['new-seg'] });

		const unpublished = await getUnpublishedRefs();
		expect(unpublished.map(r => r.refId)).toContain(ref.refId);
	});
});
