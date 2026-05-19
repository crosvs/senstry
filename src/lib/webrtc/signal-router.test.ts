import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Msg = {
	type: string;
	state?: string;
	isAnnounce?: boolean;
	sessionId?: string;
	sdp?: string;
	[k: string]: unknown;
};

// Capture the handler installed by startSignalRouter so tests can simulate
// incoming signals without a real relay.
let _capturedHandler: ((msg: Msg, fromPubkey: string, createdAt: number) => void) | null = null;

// vi.mock is hoisted above const declarations, so mock fn refs must be
// created via vi.hoisted() to avoid the temporal dead zone.
const { mockSendSignal, mockUpdatePeerStatus } = vi.hoisted(() => ({
	mockSendSignal: vi.fn(),
	mockUpdatePeerStatus: vi.fn(),
}));

vi.mock('./signaling', () => ({
	listenForSignals: vi.fn((_priv: unknown, _pub: unknown, handler: unknown) => {
		_capturedHandler = handler as typeof _capturedHandler;
		return { close: vi.fn() };
	}),
	sendSignal: mockSendSignal,
}));

vi.mock('$lib/store/peer-status', () => ({ updatePeerStatus: mockUpdatePeerStatus }));
vi.mock('$lib/store/debug', () => ({ dbg: vi.fn() }));

import { startSignalRouter, _resetForTest } from './signal-router';
import type { SignalHandler } from './signaling';

// ─────────────────────────────────────────────────────────────────────────────

const PRIV   = new Uint8Array(32).fill(1);
const PUB    = 'a'.repeat(64);
const PEER_A = 'b'.repeat(64);
const PEER_B = 'c'.repeat(64);

// Must match the constants in signal-router.ts
const STARTUP_GRACE_MS   = 20_000;
const AWARENESS_COOLDOWN = 60_000;
const FRESH_S            = 15;

let monitorHandler: ReturnType<typeof vi.fn>;
let viewerHandler:  ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
	_resetForTest();
	_capturedHandler = null;
	mockSendSignal.mockReset();
	mockSendSignal.mockResolvedValue(undefined);
	mockUpdatePeerStatus.mockReset();
	monitorHandler = vi.fn().mockResolvedValue(undefined);
	viewerHandler  = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

function startRouter(): void {
	startSignalRouter(
		PRIV, PUB,
		monitorHandler as unknown as SignalHandler,
		viewerHandler  as unknown as SignalHandler
	);
}

// ageOffsetS: negative = event created N seconds ago (stale); 0 = just now.
function dispatch(msg: Msg, fromPubkey: string, ageOffsetS = 0): void {
	const createdAt = Math.floor(Date.now() / 1000) + ageOffsetS;
	_capturedHandler!(msg, fromPubkey, createdAt);
}

// ── Awareness reply ───────────────────────────────────────────────────────────

describe('awareness reply', () => {
	it('fires after startup grace when announcement is fresh', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 'sid' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledTimes(1);
		expect(mockSendSignal).toHaveBeenCalledWith(
			PRIV, PUB, PEER_A,
			expect.objectContaining({ type: 'status', state: 'online' })
		);
	});

	it('is suppressed during the startup grace period', () => {
		startRouter();
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 'sid' }, PEER_A);
		expect(mockSendSignal).not.toHaveBeenCalled();
	});

	it('is suppressed when announcement is older than FRESH_S seconds', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 'sid' }, PEER_A, -(FRESH_S + 1));
		expect(mockSendSignal).not.toHaveBeenCalled();
	});

	it('is suppressed when isAnnounce is absent (awareness reply, not initial announcement)', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'online', sessionId: 'sid' }, PEER_A);
		expect(mockSendSignal).not.toHaveBeenCalled();
	});

	it('is suppressed for a repeated announcement within the per-peer cooldown', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 'sid' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledTimes(1);

		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 'sid' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledTimes(1); // no second call
	});

	it('fires again for the same peer after the per-peer cooldown expires', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 's1' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(AWARENESS_COOLDOWN + 1_000);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 's2' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledTimes(2);
	});

	it('maintains independent cooldowns per peer', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 's1' }, PEER_A);
		dispatch({ type: 'status', state: 'online', isAnnounce: true, sessionId: 's2' }, PEER_B);
		expect(mockSendSignal).toHaveBeenCalledTimes(2);
	});

	it('does not fire for offline status', () => {
		startRouter();
		vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
		dispatch({ type: 'status', state: 'offline', isAnnounce: true, sessionId: 'sid' }, PEER_A);
		expect(mockSendSignal).not.toHaveBeenCalled();
	});
});

// ── Status / presence ─────────────────────────────────────────────────────────

describe('status handling', () => {
	it('calls updatePeerStatus for every status message', () => {
		startRouter();
		dispatch({ type: 'status', state: 'online', sessionId: 'x' }, PEER_A, -1000);
		expect(mockUpdatePeerStatus).toHaveBeenCalledWith(PEER_A, 'online', expect.any(Number));
	});

	it('status-request triggers an online reply even inside startup grace', () => {
		startRouter();
		dispatch({ type: 'status-request', sessionId: 'req' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledWith(
			PRIV, PUB, PEER_A,
			expect.objectContaining({ type: 'status', state: 'online' })
		);
	});
});

// ── Signal routing ────────────────────────────────────────────────────────────

describe('signal routing', () => {
	it('offer-request goes to monitorHandler only', () => {
		startRouter();
		dispatch({ type: 'offer-request', sessionId: 'x' }, PEER_A);
		expect(monitorHandler).toHaveBeenCalledTimes(1);
		expect(viewerHandler).not.toHaveBeenCalled();
	});

	it('answer goes to monitorHandler only', () => {
		startRouter();
		dispatch({ type: 'answer', sessionId: 'x', sdp: 'sdp-data' }, PEER_A);
		expect(monitorHandler).toHaveBeenCalledTimes(1);
		expect(viewerHandler).not.toHaveBeenCalled();
	});

	it('offer goes to viewerHandler only', () => {
		startRouter();
		dispatch({ type: 'offer', sessionId: 'x', sdp: 'sdp-data' }, PEER_A);
		expect(viewerHandler).toHaveBeenCalledTimes(1);
		expect(monitorHandler).not.toHaveBeenCalled();
	});

	it('pong goes to viewerHandler only', () => {
		startRouter();
		dispatch({ type: 'pong', sessionId: 'x' }, PEER_A);
		expect(viewerHandler).toHaveBeenCalledTimes(1);
		expect(monitorHandler).not.toHaveBeenCalled();
	});

	it('hangup is dispatched to both handlers', () => {
		startRouter();
		dispatch({ type: 'hangup', sessionId: 'x' }, PEER_A);
		expect(monitorHandler).toHaveBeenCalledTimes(1);
		expect(viewerHandler).toHaveBeenCalledTimes(1);
	});

	it('ping sends a pong reply', () => {
		startRouter();
		dispatch({ type: 'ping', sessionId: 'ping-id' }, PEER_A);
		expect(mockSendSignal).toHaveBeenCalledWith(
			PRIV, PUB, PEER_A,
			expect.objectContaining({ type: 'pong', sessionId: 'ping-id' })
		);
	});

	it('handlers receive the correct fromPubkey and createdAt', () => {
		startRouter();
		const now = Math.floor(Date.now() / 1000);
		_capturedHandler!({ type: 'offer-request', sessionId: 'x' }, PEER_B, now);
		expect(monitorHandler).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'offer-request' }),
			PEER_B,
			now
		);
	});
});
