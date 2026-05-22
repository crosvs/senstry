import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Module-level mock fns so individual tests can override return values.
const mockPublish = vi.fn();
const mockSubscribeMany = vi.fn();

// Use a real class so `new SimplePool()` works as a constructor.
vi.mock('nostr-tools/pool', () => ({
	SimplePool: class {
		publish = mockPublish;
		subscribeMany = mockSubscribeMany;
	},
}));

import {
	setRelays, getRelays, publish, subscribe,
	setRateLimit, getRateLimitAvailable, getPublishRate,
	getCooldownRemaining, clearCooldown,
	_resetForTest,
} from './client';
import type { NostrEvent } from 'nostr-tools';

const RELAY = 'wss://fake-relay.test/';

let _idSeq = 0;
function makeEvent(kind = 1): NostrEvent {
	const id = (_idSeq++).toString(16).padStart(64, '0');
	return {
		kind,
		id,
		pubkey: 'b'.repeat(64),
		created_at: Math.floor(Date.now() / 1000),
		tags: [],
		content: 'test',
		sig: 'c'.repeat(128),
	};
}

beforeEach(() => {
	_idSeq = 0;
	_resetForTest();
	mockPublish.mockReset();
	mockSubscribeMany.mockReset();
	mockPublish.mockReturnValue([Promise.resolve('ok')]);
	mockSubscribeMany.mockReturnValue({ close: vi.fn() });
	setRelays([RELAY]);
	setRateLimit(200);
});

// ── relay configuration ───────────────────────────────────────────────────────

describe('relay config', () => {
	it('getRelays returns what was set', () => {
		setRelays(['wss://a.test/', 'wss://b.test/']);
		expect(getRelays()).toEqual(['wss://a.test/', 'wss://b.test/']);
	});

	it('publish throws when no relays configured', async () => {
		setRelays([]);
		await expect(publish(makeEvent())).rejects.toThrow('no relays configured');
	});

	it('publish calls SimplePool.publish with correct relay and event', async () => {
		const ev = makeEvent();
		await publish(ev);
		expect(mockPublish).toHaveBeenCalledWith([RELAY], ev);
	});
});

// ── rate limit configuration ──────────────────────────────────────────────────

describe('rate limiter', () => {
	it('getRateLimitAvailable returns configured rate', () => {
		setRateLimit(50);
		expect(getRateLimitAvailable()).toBe(50);
	});

	it('getRateLimitAvailable reflects updated rate after setRateLimit', () => {
		setRateLimit(30);
		expect(getRateLimitAvailable()).toBe(30);
		setRateLimit(120);
		expect(getRateLimitAvailable()).toBe(120);
	});
});

// ── publish error handling ────────────────────────────────────────────────────

describe('publish error handling', () => {
	it('throws when all relays reject', async () => {
		mockPublish.mockImplementation(() => [Promise.reject(new Error('auth-required'))]);
		await expect(publish(makeEvent())).rejects.toThrow('publish failed');
	});

	it('resolves when at least one relay accepts', async () => {
		mockPublish.mockImplementation(() => [
			Promise.resolve('ok'),
			Promise.reject(new Error('relay-2-down')),
		]);
		setRelays([RELAY, 'wss://second.test/']);
		await expect(publish(makeEvent())).resolves.toBeUndefined();
	});
});

// ── getPublishRate ────────────────────────────────────────────────────────────

describe('getPublishRate', () => {
	it('last60s is 0 before any publishes', () => {
		expect(getPublishRate().last60s).toBe(0);
	});

	it('max reflects the configured rate', () => {
		setRateLimit(42);
		expect(getPublishRate().max).toBe(42);
	});

	it('last60s increments after a successful publish', async () => {
		await publish(makeEvent());
		expect(getPublishRate().last60s).toBe(1);
	});
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('subscribe', () => {
	it('calls SimplePool.subscribeMany with the relay and filter', () => {
		const filter = { kinds: [1059] };
		subscribe(filter, () => {});
		expect(mockSubscribeMany).toHaveBeenCalledWith([RELAY], filter, expect.any(Object));
	});

	it('close() calls the underlying pool subscription close', () => {
		const poolClose = vi.fn();
		mockSubscribeMany.mockReturnValue({ close: poolClose });
		const sub = subscribe({ kinds: [1] }, () => {});
		sub.close();
		expect(poolClose).toHaveBeenCalled();
	});

	it('delivers events to the onEvent callback', () => {
		const handler = vi.fn();
		subscribe({ kinds: [1] }, handler);
		const [, , { onevent }] = mockSubscribeMany.mock.calls[0];
		const ev = makeEvent();
		onevent(ev);
		expect(handler).toHaveBeenCalledWith(ev);
	});
});

// ── publish cooldownKey ───────────────────────────────────────────────────────

describe('publish cooldownKey', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
		_resetForTest();
		_idSeq = 0;
		setRelays([RELAY]);
		setRateLimit(200); // interval = 300ms
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Helper: publish and flush microtasks (first event always sends immediately
	// since _lastSentAt=0 → wait=max(0, 300 - large_now)=0)
	async function publishNow(opts?: Parameters<typeof publish>[1]) {
		const p = publish(makeEvent(), opts);
		await vi.advanceTimersByTimeAsync(0);
		return p;
	}

	// Helper: advance past the drain interval so a queued item can send
	async function drainNext() {
		await vi.advanceTimersByTimeAsync(300);
	}

	it('getCooldownRemaining returns 0 when no cooldown is active', () => {
		expect(getCooldownRemaining('key-a')).toBe(0);
	});

	it('first publish with cooldownKey succeeds and sets cooldown', async () => {
		await publishNow({ cooldownKey: 'k', cooldownMs: 10_000 });
		expect(getCooldownRemaining('k')).toBeGreaterThan(0);
	});

	it('second publish within cooldown throws "cooldown" and does not call relay', async () => {
		await publishNow({ cooldownKey: 'k', cooldownMs: 10_000 });
		mockPublish.mockClear();
		// Cooldown rejection happens synchronously (before drain), no timer needed
		await expect(publish(makeEvent(), { cooldownKey: 'k', cooldownMs: 10_000 })).rejects.toThrow('cooldown');
		expect(mockPublish).not.toHaveBeenCalled();
	});

	it('publish succeeds again after cooldown expires', async () => {
		await publishNow({ cooldownKey: 'k', cooldownMs: 10_000 });
		vi.advanceTimersByTime(10_001);
		// Need to drain interval too since _lastSentAt was just set
		const p = publish(makeEvent(), { cooldownKey: 'k', cooldownMs: 10_000 });
		await drainNext();
		await expect(p).resolves.toBeUndefined();
	});

	it('clearCooldown removes an active cooldown', async () => {
		await publishNow({ cooldownKey: 'k', cooldownMs: 60_000 });
		clearCooldown('k');
		expect(getCooldownRemaining('k')).toBe(0);
		const p = publish(makeEvent(), { cooldownKey: 'k', cooldownMs: 60_000 });
		await drainNext();
		await expect(p).resolves.toBeUndefined();
	});

	it('cooldownMs=0 / undefined does not set a cooldown after publish', async () => {
		await publishNow({ cooldownKey: 'k' }); // no cooldownMs
		expect(getCooldownRemaining('k')).toBe(0);
	});

	it('independent cooldown keys do not interfere', async () => {
		await publishNow({ cooldownKey: 'a', cooldownMs: 10_000 });
		// 'b' has no cooldown — should publish fine after interval elapses
		const p = publish(makeEvent(), { cooldownKey: 'b', cooldownMs: 10_000 });
		await drainNext();
		await expect(p).resolves.toBeUndefined();
	});
});
