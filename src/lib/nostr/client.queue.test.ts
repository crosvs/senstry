/**
 * Publish queue behaviour tests.
 *
 * Key pattern notes for future queue tests:
 *
 *   vi.useFakeTimers();
 *   vi.setSystemTime(new Date('2026-07-01T00:00:00Z')); // must be well past epoch
 *   _resetForTest(); setRelays([RELAY]); setRateLimit(200);
 *
 *   // First publish() always starts draining immediately (wait=0 when _lastSentAt=0
 *   // and now >> 300). It shifts the item off the queue synchronously, so the store
 *   // shows N-1 items right after N concurrent publish() calls.
 *   //
 *   // Use flushMicrotasks() to let the first item finish sending (resolves allSettled).
 *   // Use drainNext() to advance the 300ms spacing timer for subsequent items.
 *   //
 *   // Attach .catch(() => {}) to promises you intend to cancel before calling cancelPublish(),
 *   // to avoid unhandled-rejection warnings.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { get } from 'svelte/store';

const mockPublish = vi.fn();
const mockSubscribeMany = vi.fn();

vi.mock('nostr-tools/pool', () => ({
	SimplePool: class {
		publish = mockPublish;
		subscribeMany = mockSubscribeMany;
	},
}));

import {
	setRelays, publish, setRateLimit, cancelPublish, publishQueue,
	_resetForTest,
} from './client';
import type { NostrEvent } from 'nostr-tools';

const RELAY = 'wss://relay.test/';
let _idSeq = 0;

function makeEvent(kind = 1): NostrEvent {
	const id = (_idSeq++).toString(16).padStart(64, '0');
	return { kind, id, pubkey: 'b'.repeat(64), created_at: 0, tags: [], content: '', sig: 'c'.repeat(128) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
	_idSeq = 0;
	_resetForTest();
	mockPublish.mockReset();
	mockSubscribeMany.mockReset();
	mockPublish.mockReturnValue([Promise.resolve('ok')]);
	mockSubscribeMany.mockReturnValue({ close: vi.fn() });
	setRelays([RELAY]);
	setRateLimit(200); // _intervalMs() = max(300, ceil(60000/200)) = 300ms
});

afterEach(() => {
	vi.useRealTimers();
});

// Advance fake time past one drain interval and flush async microtasks.
async function drainNext(ms = 300) {
	await vi.advanceTimersByTimeAsync(ms);
}

// Let the current microtask queue flush (for the first event, which has wait=0).
async function flushMicrotasks() {
	await vi.advanceTimersByTimeAsync(0);
}

// Send one event and fully wait for it — primes _lastSentAt so subsequent
// events will have a 300ms wait. Useful as test setup.
async function sendOneAndWait(): Promise<void> {
	const p = publish(makeEvent());
	await flushMicrotasks();
	await p;
}

// ── immediate drain ───────────────────────────────────────────────────────────

describe('first event drains immediately', () => {
	it('calls relay and resolves without any timer advancement', async () => {
		const ev = makeEvent();
		const p = publish(ev);
		await flushMicrotasks();
		expect(mockPublish).toHaveBeenCalledWith([RELAY], ev);
		await expect(p).resolves.toBeUndefined();
	});

	it('publishQueue is empty once the only event has drained', async () => {
		const p = publish(makeEvent());
		await flushMicrotasks();
		await p;
		expect(get(publishQueue)).toHaveLength(0);
	});
});

// ── queue spacing ─────────────────────────────────────────────────────────────

describe('queue spacing', () => {
	it('second event waits one interval before sending', async () => {
		const ev1 = makeEvent();
		const ev2 = makeEvent();
		const p1 = publish(ev1);
		const p2 = publish(ev2);

		await flushMicrotasks();
		// ev1 drained; ev2 is waiting for 300ms timer
		expect(mockPublish).toHaveBeenCalledTimes(1);
		expect(mockPublish).toHaveBeenLastCalledWith([RELAY], ev1);

		await drainNext();
		expect(mockPublish).toHaveBeenCalledTimes(2);
		expect(mockPublish).toHaveBeenLastCalledWith([RELAY], ev2);

		await p1; await p2;
	});

	it('three events send at t=0, t=300, t=600', async () => {
		const evs = [makeEvent(), makeEvent(), makeEvent()];
		const ps = evs.map(ev => publish(ev));

		await flushMicrotasks();
		expect(mockPublish).toHaveBeenCalledTimes(1);

		await drainNext();
		expect(mockPublish).toHaveBeenCalledTimes(2);

		await drainNext();
		expect(mockPublish).toHaveBeenCalledTimes(3);

		await Promise.all(ps);
	});

	it('publishQueue length decrements as events drain', async () => {
		const ps = [publish(makeEvent()), publish(makeEvent()), publish(makeEvent())];
		// First event starts draining immediately (shifted off before publish(ev2) call),
		// so store shows only 2 items right after all three publish() calls.
		expect(get(publishQueue)).toHaveLength(2);

		await flushMicrotasks(); // ev1 finishes; ev2 waits for 300ms
		expect(get(publishQueue)).toHaveLength(2);

		await drainNext(); // ev2 drains
		expect(get(publishQueue)).toHaveLength(1);

		await drainNext(); // ev3 drains
		expect(get(publishQueue)).toHaveLength(0);

		await Promise.all(ps);
	});

	it('respects setRateLimit: lower rate → longer interval', async () => {
		setRateLimit(60); // interval = max(300, ceil(60000/60)) = 1000ms
		const p1 = publish(makeEvent());
		const p2 = publish(makeEvent());

		await flushMicrotasks();
		expect(mockPublish).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(mockPublish).toHaveBeenCalledTimes(1); // not yet

		await vi.advanceTimersByTimeAsync(500); // now at t=1000
		expect(mockPublish).toHaveBeenCalledTimes(2);

		await p1; await p2;
	});
});

// ── cancel ────────────────────────────────────────────────────────────────────

describe('cancelPublish', () => {
	it('cancelling a waiting event rejects its promise', async () => {
		await sendOneAndWait(); // prime _lastSentAt
		mockPublish.mockClear();

		const ev = makeEvent();
		const p = publish(ev);
		p.catch(() => {}); // prevent unhandled rejection
		expect(get(publishQueue)).toHaveLength(1);

		const cancelled = cancelPublish(ev.id);
		expect(cancelled).toBe(true);
		await expect(p).rejects.toThrow('cancelled');
		expect(get(publishQueue)).toHaveLength(0);

		// Relay never called after cancel
		await vi.advanceTimersByTimeAsync(600);
		expect(mockPublish).not.toHaveBeenCalled();
	});

	it('cancelling one queued event does not affect others', async () => {
		await sendOneAndWait(); // prime _lastSentAt so all three queue
		mockPublish.mockClear();

		const ev1 = makeEvent();
		const ev2 = makeEvent();
		const ev3 = makeEvent();
		const p1 = publish(ev1);
		const p2 = publish(ev2);
		const p3 = publish(ev3);
		p2.catch(() => {}); // suppress unhandled rejection before cancel
		expect(get(publishQueue)).toHaveLength(3);

		cancelPublish(ev2.id);
		expect(get(publishQueue)).toHaveLength(2);

		await drainNext();
		await drainNext();

		// ev1 and ev3 sent; ev2 skipped
		const calledIds = mockPublish.mock.calls.map((args: unknown[]) => (args[1] as NostrEvent).id);
		expect(calledIds).toContain(ev1.id);
		expect(calledIds).toContain(ev3.id);
		expect(calledIds).not.toContain(ev2.id);

		await p1;
		await expect(p2).rejects.toThrow('cancelled');
		await p3;
	});

	it('cancelPublish returns false for an unknown id', () => {
		expect(cancelPublish('unknown-id')).toBe(false);
	});
});

// ── onQueued callback ─────────────────────────────────────────────────────────

describe('onQueued callback', () => {
	it('fires synchronously before the event drains', async () => {
		let capturedId: string | null = null;
		let capturedCancel: (() => void) | null = null;

		const ev = makeEvent();
		const p = publish(ev, {
			onQueued: (id, cancel) => {
				capturedId = id;
				capturedCancel = cancel;
			},
		});

		// Callback must have fired before any await
		expect(capturedId).toBe(ev.id);
		expect(typeof capturedCancel).toBe('function');

		await flushMicrotasks();
		await p;
	});

	it('cancel fn from onQueued rejects the promise', async () => {
		await sendOneAndWait(); // prime _lastSentAt
		mockPublish.mockClear();

		let cancel!: () => void;
		const ev = makeEvent();
		const p = publish(ev, {
			label: 'test-signal',
			onQueued: (_, c) => { cancel = c; },
		});
		p.catch(() => {}); // suppress unhandled rejection

		cancel(); // before any timers advance
		await expect(p).rejects.toThrow('cancelled');
		await vi.advanceTimersByTimeAsync(600);
		expect(mockPublish).not.toHaveBeenCalled();
	});
});

// ── publishQueue store ────────────────────────────────────────────────────────

describe('publishQueue store', () => {
	it('contains the label passed via opts', async () => {
		await sendOneAndWait(); // fill _lastSentAt

		const p = publish(makeEvent(), { label: 'signal:status' });
		const q = get(publishQueue);
		expect(q[0].label).toBe('signal:status');

		await drainNext();
		await p;
	});

	it('estimatedAt is in the future for queued (waiting) items', async () => {
		await sendOneAndWait(); // fill _lastSentAt

		const p = publish(makeEvent());
		const q = get(publishQueue);
		expect(q[0].estimatedAt).toBeGreaterThan(Date.now());

		await drainNext();
		await p;
	});

	it('is empty after reset', () => {
		expect(get(publishQueue)).toHaveLength(0);
	});

	it('defaults label to "kind:N" when not provided', async () => {
		await sendOneAndWait();
		const p = publish(makeEvent(1059));
		expect(get(publishQueue)[0].label).toBe('kind:1059');
		await drainNext();
		await p;
	});
});

// ── relay errors ──────────────────────────────────────────────────────────────

describe('relay errors', () => {
	it('rejects publish promise when all relays reject', async () => {
		mockPublish.mockImplementation(() => [Promise.reject(new Error('auth-required'))]);
		await expect(publish(makeEvent())).rejects.toThrow('publish failed');
	});

	it('resolves when at least one relay succeeds', async () => {
		setRelays([RELAY, 'wss://second.test/']);
		mockPublish.mockImplementation(() => [
			Promise.resolve('ok'),
			Promise.reject(new Error('relay-2-down')),
		]);
		await expect(publish(makeEvent())).resolves.toBeUndefined();
	});
});
