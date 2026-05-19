import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// Minimal store shim compatible with svelte/store `get()`.
// get() calls subscribe once synchronously to read the current value.
function makeStore<T>(initial: T) {
	let _val = initial;
	const subs = new Set<(v: T) => void>();
	return {
		subscribe: (fn: (v: T) => void) => { fn(_val); subs.add(fn); return () => subs.delete(fn); },
		set: (v: T) => { _val = v; subs.forEach(fn => fn(v)); },
	};
}

// vi.mock factories are hoisted above top-level declarations, so stores and
// mock fns must be created via vi.hoisted() to avoid the temporal dead zone.
const { fakeIdentityStore, fakePairedDevicesStore, mockSendSignal, mockClearQueued } = vi.hoisted(() => {
	function makeHoistedStore<T>(initial: T) {
		let _val = initial;
		const subs = new Set<(v: T) => void>();
		return {
			subscribe: (fn: (v: T) => void) => { fn(_val); subs.add(fn); return () => subs.delete(fn); },
			set: (v: T) => { _val = v; subs.forEach(fn => fn(v)); },
		};
	}
	return {
		fakeIdentityStore: makeHoistedStore<{ privkey: Uint8Array; pubkey: string } | null>(null),
		fakePairedDevicesStore: makeHoistedStore<{ pubkey: string }[]>([]),
		mockSendSignal: vi.fn(),
		mockClearQueued: vi.fn(),
	};
});

vi.mock('$lib/store/identity', () => ({
	identity: fakeIdentityStore,
	pairedDevices: fakePairedDevicesStore,
}));
vi.mock('$lib/webrtc/signaling', () => ({ sendSignal: mockSendSignal }));
vi.mock('$lib/db/outbox', () => ({ clearQueued: mockClearQueued }));
vi.mock('$lib/store/debug', () => ({ dbg: vi.fn() }));

import {
	nostrOnline, nostrOfflineReason,
	reportPublishError, reportPublishSuccess,
	goOnline, goOffline,
	_resetForTest,
} from './nostr-online';

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
	_resetForTest();
	mockSendSignal.mockReset();
	mockSendSignal.mockResolvedValue(undefined);
	mockClearQueued.mockReset();
	mockClearQueued.mockResolvedValue(undefined);
	fakeIdentityStore.set(null);
	fakePairedDevicesStore.set([]);
});

// Flush microtasks so the async chain inside goOffline() completes.
const flush = () => new Promise<void>(r => setTimeout(r, 0));

// ── reportPublishError ────────────────────────────────────────────────────────

describe('reportPublishError', () => {
	it('ignores local rate-limit errors (message exactly "rate-limited")', async () => {
		nostrOnline.set(true);
		reportPublishError(new Error('rate-limited'));
		reportPublishError(new Error('rate-limited'));
		reportPublishError(new Error('rate-limited'));
		await flush();
		expect(get(nostrOnline)).toBe(true);
		expect(get(nostrOfflineReason)).toBeNull();
	});

	it('does nothing when already offline', async () => {
		nostrOnline.set(false);
		reportPublishError(new Error('publish failed: down'));
		await flush();
		expect(get(nostrOfflineReason)).toBeNull();
	});

	it('tolerates up to two consecutive relay failures without going offline', async () => {
		nostrOnline.set(true);
		reportPublishError(new Error('publish failed: timeout'));
		reportPublishError(new Error('publish failed: timeout'));
		await flush();
		expect(get(nostrOnline)).toBe(true);
	});

	it('auto-goes offline after three consecutive relay failures', async () => {
		nostrOnline.set(true);
		reportPublishError(new Error('publish failed: timeout'));
		reportPublishError(new Error('publish failed: timeout'));
		reportPublishError(new Error('publish failed: timeout'));
		await flush();
		expect(get(nostrOnline)).toBe(false);
		expect(get(nostrOfflineReason)).toBeTruthy();
	});

	it('nostrOfflineReason contains the relay error message', async () => {
		nostrOnline.set(true);
		const msg = 'publish failed: rate-limited: you are noting too much';
		for (let i = 0; i < 3; i++) reportPublishError(new Error(msg));
		await flush();
		expect(get(nostrOfflineReason)).toContain('publish failed');
	});

	it('ignores unrecognised error formats', async () => {
		nostrOnline.set(true);
		for (let i = 0; i < 5; i++) reportPublishError(new Error('something unexpected'));
		await flush();
		expect(get(nostrOnline)).toBe(true);
	});
});

// ── reportPublishSuccess ──────────────────────────────────────────────────────

describe('reportPublishSuccess', () => {
	it('resets the failure counter so auto-offline requires three consecutive fails again', async () => {
		nostrOnline.set(true);
		reportPublishError(new Error('publish failed: down'));
		reportPublishError(new Error('publish failed: down'));
		reportPublishSuccess(); // resets streak to 0
		reportPublishError(new Error('publish failed: down'));
		reportPublishError(new Error('publish failed: down'));
		await flush();
		expect(get(nostrOnline)).toBe(true);
	});

	it('any interleaved success prevents auto-offline over many failures', async () => {
		nostrOnline.set(true);
		for (let i = 0; i < 3; i++) {
			reportPublishError(new Error('publish failed: down'));
			reportPublishError(new Error('publish failed: down'));
			reportPublishSuccess();
		}
		reportPublishError(new Error('publish failed: down'));
		await flush();
		expect(get(nostrOnline)).toBe(true);
	});
});

// ── goOnline / goOffline ──────────────────────────────────────────────────────

describe('goOnline', () => {
	it('sets nostrOnline to true', async () => {
		expect(get(nostrOnline)).toBe(false);
		await goOnline();
		expect(get(nostrOnline)).toBe(true);
	});
});

describe('goOffline', () => {
	it('sets nostrOnline to false', async () => {
		nostrOnline.set(true);
		await goOffline();
		expect(get(nostrOnline)).toBe(false);
	});

	it('does not set nostrOfflineReason (user-initiated, not auto-offline)', async () => {
		nostrOnline.set(true);
		await goOffline();
		expect(get(nostrOfflineReason)).toBeNull();
	});

	it('calls clearQueued', async () => {
		nostrOnline.set(true);
		await goOffline();
		expect(mockClearQueued).toHaveBeenCalled();
	});

	it('sends an offline status to each paired device before going offline', async () => {
		const priv = new Uint8Array(32).fill(2);
		const pub  = 'aa'.repeat(32);
		fakeIdentityStore.set({ privkey: priv, pubkey: pub });
		fakePairedDevicesStore.set([{ pubkey: 'bb'.repeat(32) }, { pubkey: 'cc'.repeat(32) }]);
		nostrOnline.set(true);
		await goOffline();
		expect(mockSendSignal).toHaveBeenCalledTimes(2);
		expect(mockSendSignal).toHaveBeenCalledWith(
			priv, pub, 'bb'.repeat(32),
			expect.objectContaining({ type: 'status', state: 'offline' })
		);
	});

	it('skips sendSignal when no identity is set', async () => {
		fakeIdentityStore.set(null);
		nostrOnline.set(true);
		await goOffline();
		expect(mockSendSignal).not.toHaveBeenCalled();
	});
});
