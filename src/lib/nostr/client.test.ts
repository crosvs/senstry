import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Module-level mock fns so individual tests can override return values.
const mockPublish = vi.fn();
const mockSubscribeMany = vi.fn();

// Use a real class so `new SimplePool()` works as a constructor.
// This prevents the "not a constructor" error from using arrow-fn mocks.
vi.mock('nostr-tools/pool', () => ({
	SimplePool: class {
		publish = mockPublish;
		subscribeMany = mockSubscribeMany;
	},
}));

import {
	setRelays, getRelays, publish, subscribe,
	setRateLimit, getRateLimitAvailable, getPublishRate,
	_resetForTest,
} from './client';
import type { NostrEvent } from 'nostr-tools';

const RELAY = 'wss://fake-relay.test/';

function makeEvent(kind = 1): NostrEvent {
	return {
		kind,
		id: 'a'.repeat(64),
		pubkey: 'b'.repeat(64),
		created_at: Math.floor(Date.now() / 1000),
		tags: [],
		content: 'test',
		sig: 'c'.repeat(128),
	};
}

beforeEach(() => {
	_resetForTest();
	mockPublish.mockReset();
	mockSubscribeMany.mockReset();
	// Default: relay accepts the event
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

// ── rate limiter ──────────────────────────────────────────────────────────────

describe('rate limiter', () => {
	it('getRateLimitAvailable returns ~max right after setRateLimit', () => {
		setRateLimit(50);
		expect(getRateLimitAvailable()).toBeCloseTo(50, 0);
	});

	it('available tokens decrease after each publish', async () => {
		setRateLimit(10);
		const before = getRateLimitAvailable();
		await publish(makeEvent());
		await publish(makeEvent());
		expect(getRateLimitAvailable()).toBeLessThan(before);
	});

	it('throws rate-limited when bucket is empty', async () => {
		// Set max to a tiny value so the bucket empties immediately
		setRateLimit(0.001);
		await expect(publish(makeEvent())).rejects.toThrow('rate-limited');
	});

	it('does not call SimplePool.publish when rate-limited', async () => {
		setRateLimit(0.001);
		await publish(makeEvent()).catch(() => {});
		expect(mockPublish).not.toHaveBeenCalled();
	});
});

// ── publish error handling ────────────────────────────────────────────────────

describe('publish error handling', () => {
	it('throws when all relays reject', async () => {
		// Use mockImplementation (lazy) so the rejected promise is created when
		// publish() calls mockPublish — avoiding unhandled rejection warnings.
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

	it('last60s increments after each successful publish', async () => {
		await publish(makeEvent());
		await publish(makeEvent());
		await publish(makeEvent());
		expect(getPublishRate().last60s).toBe(3);
	});

	it('last60s does not increment when rate-limited', async () => {
		setRateLimit(0.001);
		await publish(makeEvent()).catch(() => {});
		expect(getPublishRate().last60s).toBe(0);
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

		// Grab the onevent callback that was passed to subscribeMany
		const [, , { onevent }] = mockSubscribeMany.mock.calls[0];
		const ev = makeEvent();
		onevent(ev);

		expect(handler).toHaveBeenCalledWith(ev);
	});
});
