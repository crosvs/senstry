import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
	createFootageRef, updateFootageRef, getFootageRef,
	getFootageRefsForDay, softDeleteFootageRef,
	clearFootageRefsForMonitor, getAllFootageRefs,
	getUnpublishedRefs, markRefPublished, receiveFootageRef,
} from './footage';
import { _resetDbForTest } from './idb';

const MONITOR_A = 'a'.repeat(64);
const MONITOR_B = 'b'.repeat(64);

const DAY_START = 1746576000;
const DAY_END = DAY_START + 86400;

beforeEach(() => {
	(globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
	_resetDbForTest();
});

const BASE = {
	originMonitor: MONITOR_A,
	triggerType: 'audio',
	startTime: DAY_START + 100,
	endTime: DAY_START + 160,
	triggerTime: DAY_START + 130,
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
	it('updates endTime and persists', async () => {
		const ref = await createFootageRef(BASE);
		const updated = await updateFootageRef(ref.refId, { endTime: BASE.endTime + 60 });
		expect(updated!.endTime).toBe(BASE.endTime + 60);

		const fetched = await getFootageRef(ref.refId);
		expect(fetched!.endTime).toBe(BASE.endTime + 60);
	});

	it('returns null for an unknown refId', async () => {
		const result = await updateFootageRef('nonexistent', { endTime: 9999 });
		expect(result).toBeNull();
	});

	it('only patches specified fields, leaves others intact', async () => {
		const ref = await createFootageRef({ ...BASE, startTime: 9999 });
		await updateFootageRef(ref.refId, { endTime: 99999 });
		const fetched = await getFootageRef(ref.refId);
		expect(fetched!.startTime).toBe(9999);
		expect(fetched!.triggerType).toBe('audio');
	});
});

// ── getFootageRefsForDay ──────────────────────────────────────────────────────

describe('getFootageRefsForDay', () => {
	it('returns refs whose startTime falls within the day window', async () => {
		await createFootageRef(BASE); // in window
		await createFootageRef({ ...BASE, startTime: DAY_END + 100, endTime: DAY_END + 200, triggerTime: DAY_END + 130 }); // next day

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
	it('marks deleted', async () => {
		const ref = await createFootageRef(BASE);
		const updated = await softDeleteFootageRef(ref.refId);
		expect(updated!.deleted).toBe(true);
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

	it('removes deleted refs too', async () => {
		const ref = await createFootageRef(BASE);
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
});

// ── receiveFootageRef ─────────────────────────────────────────────────────────

describe('receiveFootageRef', () => {
	const REMOTE_ID = 'remote-ref-id-from-monitor';
	const NOSTR_EVENT_ID = 'nostr-event-' + 'a'.repeat(54);

	it('creates a new ref with the given refId', async () => {
		const { ref, isNew } = await receiveFootageRef(REMOTE_ID, BASE, NOSTR_EVENT_ID);
		expect(isNew).toBe(true);
		expect(ref.refId).toBe(REMOTE_ID);
		expect(ref.originMonitor).toBe(BASE.originMonitor);
		expect(ref.triggerType).toBe(BASE.triggerType);
		expect(ref.startTime).toBe(BASE.startTime);
		expect(ref.endTime).toBe(BASE.endTime);
		expect(ref.triggerTime).toBe(BASE.triggerTime);
	});

	it('persists to IDB with nostrEventId set', async () => {
		await receiveFootageRef(REMOTE_ID, BASE, NOSTR_EVENT_ID);
		const fetched = await getFootageRef(REMOTE_ID);
		expect(fetched).toBeDefined();
		expect(fetched!.nostrEventId).toBe(NOSTR_EVENT_ID);
		expect(fetched!.publishedAt).not.toBeNull();
		expect(fetched!.deleted).toBe(false);
	});

	it('is idempotent — second call returns existing ref with isNew=false', async () => {
		await receiveFootageRef(REMOTE_ID, BASE, NOSTR_EVENT_ID);
		const { ref: ref2, isNew } = await receiveFootageRef(REMOTE_ID, BASE, 'different-event-id');
		expect(isNew).toBe(false);
		expect(ref2.nostrEventId).toBe(NOSTR_EVENT_ID); // original event ID preserved
	});

	it('re-receives if the existing ref was soft-deleted', async () => {
		await receiveFootageRef(REMOTE_ID, BASE, NOSTR_EVENT_ID);
		await softDeleteFootageRef(REMOTE_ID);
		const { ref, isNew } = await receiveFootageRef(REMOTE_ID, BASE, 'newer-event');
		expect(isNew).toBe(true);
		expect(ref.deleted).toBe(false);
	});
});
