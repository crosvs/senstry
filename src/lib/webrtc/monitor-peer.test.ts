import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── MediaStream polyfill (happy-dom doesn't implement getTracks) ───────────────

global.MediaStream = class {
	private _tracks: MediaStreamTrack[] = [];
	constructor(tracks?: MediaStreamTrack[]) { if (tracks) this._tracks = [...tracks]; }
	addTrack(t: MediaStreamTrack) { this._tracks.push(t); }
	getTracks() { return [...this._tracks]; }
	getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
	getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
} as unknown as typeof MediaStream;

// ── Mock infrastructure ────────────────────────────────────────────────────────

const { mockSendOffer, mockSendHangup } = vi.hoisted(() => ({
	mockSendOffer:  vi.fn().mockResolvedValue(undefined),
	mockSendHangup: vi.fn().mockResolvedValue(undefined),
}));

// All captured callbacks for the current test's PC instance.
const captured = {
	onIceChange: null as ((state: RTCIceConnectionState) => void) | null,
};

// Each test gets a fresh mock PC.  The `createPeer` mock reads _activePc.
let _activePc: ReturnType<typeof createMockPc>;

function createMockPc() {
	const dcs = new Map<string, ReturnType<typeof createMockDc>>();
	let _localDesc: { type: string; sdp: string } | null = null;
	const pc = {
		iceConnectionState: 'new' as RTCIceConnectionState,
		iceGatheringState: 'complete' as RTCIceGatheringState,
		close: vi.fn(),
		setRemoteDescription: vi.fn().mockResolvedValue(undefined),
		createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' }),
		setLocalDescription: vi.fn().mockImplementation(async (desc: { type: string; sdp: string }) => {
			_localDesc = desc;
		}),
		createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-offer-sdp' }),
		addTrack: vi.fn(),
		getReceivers: vi.fn().mockReturnValue([]),
		getSenders:   vi.fn().mockReturnValue([]),
		getStats: vi.fn().mockResolvedValue(new Map()),
		get localDescription() { return _localDesc; },
		// createDataChannel returns a fresh MockDc keyed by label.
		createDataChannel: vi.fn().mockImplementation((label: string) => {
			const dc = createMockDc(label);
			dcs.set(label, dc);
			return dc;
		}),
		// Accessor so tests can grab the DC without going through the monitor module.
		_getDc(label: string) { return dcs.get(label); },
	};
	return pc;
}

function createMockDc(label = 'control', readyState: RTCDataChannelState = 'open') {
	return {
		readyState,
		label,
		onmessage: null as ((e: { data: string }) => void) | null,
		onopen: null as (() => void) | null,
		send: vi.fn(),
		close: vi.fn(),
	};
}

vi.mock('./peer', () => ({
	createPeer: () => _activePc,
	onIceStateChange: (_pc: unknown, cb: (s: RTCIceConnectionState) => void) => { captured.onIceChange = cb; },
	waitForIceGathering: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./signaling', () => ({
	sendOffer:  mockSendOffer,
	sendHangup: mockSendHangup,
}));

vi.mock('$lib/db/segments', () => ({
	getCoverageMap:      vi.fn().mockResolvedValue([]),
	getCoverageByChannel: vi.fn().mockResolvedValue({}),
	getSegmentsInRange:  vi.fn().mockResolvedValue([]),
	getSegmentById:      vi.fn().mockResolvedValue(null),
	getSegmentsAfter:    vi.fn().mockResolvedValue([]),
	getSegmentsBefore:   vi.fn().mockResolvedValue([]),
	getDistinctChannels: vi.fn().mockResolvedValue([]),
}));

import { getSegmentsInRange } from '$lib/db/segments';

vi.mock('$lib/store/debug', () => ({ dbg: vi.fn() }));
vi.mock('$lib/store/pipeline', () => ({}));

import {
	handleOfferRequest, handleAnswer, handleHangup,
	setMonitorStreams, setMonitorChannels, setIdleTimeout,
	_resetForTest,
} from './monitor-peer';

// ── Test constants ─────────────────────────────────────────────────────────────

const PRIV        = new Uint8Array(32).fill(1);
const MONITOR_PUB = 'a'.repeat(64);
const VIEWER_PUB  = 'b'.repeat(64);
const SESSION_ID  = 'sess-001';

function makeSignal(overrides: Record<string, unknown> = {}) {
	return { type: 'offer-request', sessionId: SESSION_ID, mode: 'data', ...overrides } as Parameters<typeof handleOfferRequest>[2];
}

beforeEach(() => {
	_resetForTest();
	_activePc = createMockPc();
	captured.onIceChange = null;
	mockSendOffer.mockReset().mockResolvedValue(undefined);
	mockSendHangup.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

// ── handleOfferRequest ────────────────────────────────────────────────────────

describe('handleOfferRequest', () => {
	it('sends an offer after receiving an offer-request', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		expect(mockSendOffer).toHaveBeenCalledWith(PRIV, MONITOR_PUB, VIEWER_PUB, expect.any(String), SESSION_ID);
	});

	it('creates control and data channels on the peer', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		expect(_activePc.createDataChannel).toHaveBeenCalledWith('control');
		expect(_activePc.createDataChannel).toHaveBeenCalledWith('data');
	});

	it('creates offer SDP and sets it as local description', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		expect(_activePc.createOffer).toHaveBeenCalled();
		expect(_activePc.setLocalDescription).toHaveBeenCalled();
	});

	it('rate-limits data-mode offer-requests from the same viewer', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data', sessionId: 'S1' }), VIEWER_PUB);
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data', sessionId: 'S2' }), VIEWER_PUB);
		// Second data-mode request within the 5s cooldown is dropped → only one offer sent.
		expect(mockSendOffer).toHaveBeenCalledTimes(1);
	});

	it('allows live-mode offer-requests even within the rate-limit window', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data', sessionId: 'S1' }), VIEWER_PUB);
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'live', sessionId: 'S2' }), VIEWER_PUB);
		// Live request bypasses rate limit → two offers sent.
		expect(mockSendOffer).toHaveBeenCalledTimes(2);
	});

	it('ignores a duplicate offer-request with the same session ID as the active session', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		// Same session ID as the first call should be ignored.
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		expect(mockSendOffer).toHaveBeenCalledTimes(1);
	});

	it('does not add tracks for data-mode connections', async () => {
		const fakeStream = new MediaStream();
		setMonitorStreams(new Map([['src1', fakeStream]]));
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data' }), VIEWER_PUB);
		expect(_activePc.addTrack).not.toHaveBeenCalled();
	});

	it('adds tracks for live-mode connections when streams are available', async () => {
		const videoTrack = { kind: 'video' } as MediaStreamTrack;
		const fakeStream = { getVideoTracks: () => [videoTrack], getAudioTracks: () => [], getTracks: () => [videoTrack] } as unknown as MediaStream;
		setMonitorStreams(new Map([['src1', fakeStream]]));
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'live' }), VIEWER_PUB);
		expect(_activePc.addTrack).toHaveBeenCalled();
	});

	it('retries the offer on rate-limited error', async () => {
		vi.useFakeTimers();
		mockSendOffer
			.mockRejectedValueOnce(new Error('rate-limited'))
			.mockResolvedValue(undefined);
		const p = handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		await vi.advanceTimersByTimeAsync(8_001);
		await p;
		expect(mockSendOffer).toHaveBeenCalledTimes(2);
	});
});

// ── live-request data-channel handler ────────────────────────────────────────

describe('live-request data-channel message', () => {
	it('sends a renegotiation offer when live-request is received', async () => {
		const videoTrack = { kind: 'video' } as MediaStreamTrack;
		const fakeStream = { getVideoTracks: () => [videoTrack], getAudioTracks: () => [], getTracks: () => [videoTrack] } as unknown as MediaStream;
		setMonitorStreams(new Map([['src1', fakeStream]]));

		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data' }), VIEWER_PUB);
		mockSendOffer.mockClear();

		const controlDc = _activePc._getDc('control');
		expect(controlDc).toBeDefined();

		// Simulate viewer sending live-request over the control channel
		await controlDc!.onmessage?.({
			data: JSON.stringify({ type: 'live-request', channelId: 'ch1' }),
		});

		expect(_activePc.addTrack).toHaveBeenCalled();
		expect(_activePc.createOffer).toHaveBeenCalledTimes(2); // once for initial offer, once for renegotiation
		expect(mockSendOffer).toHaveBeenCalledWith(PRIV, MONITOR_PUB, VIEWER_PUB, expect.any(String), SESSION_ID);
	});

	it('does nothing for live-request when no streams are available', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data' }), VIEWER_PUB);
		mockSendOffer.mockClear();
		_activePc.createOffer.mockClear();

		const controlDc = _activePc._getDc('control');
		await controlDc!.onmessage?.({
			data: JSON.stringify({ type: 'live-request', channelId: 'ch1' }),
		});

		expect(mockSendOffer).not.toHaveBeenCalled();
		expect(_activePc.createOffer).not.toHaveBeenCalled();
	});

	it('routes unknown data-channel messages to handleDataMessage without crashing', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		const controlDc = _activePc._getDc('control');
		// Should not throw
		await expect(
			controlDc!.onmessage?.({ data: JSON.stringify({ type: 'unknown-message-type' }) })
		).resolves.toBeUndefined();
	});

	it('selects tracks from the named channel when channelId is provided', async () => {
		const videoTrack = { kind: 'video' } as MediaStreamTrack;
		const audioTrack = { kind: 'audio' } as MediaStreamTrack;
		const vidStream = { getVideoTracks: () => [videoTrack], getAudioTracks: () => [] } as unknown as MediaStream;
		const audStream = { getVideoTracks: () => [], getAudioTracks: () => [audioTrack] } as unknown as MediaStream;
		setMonitorStreams(new Map([['vid-src', vidStream], ['aud-src', audStream]]));
		setMonitorChannels([{
			id: 'ch1', name: 'Ch1', videoSourceId: 'vid-src', audioSourceId: 'aud-src',
		}]);

		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal({ mode: 'data' }), VIEWER_PUB);
		_activePc.addTrack.mockClear();
		mockSendOffer.mockClear();

		const controlDc = _activePc._getDc('control');
		await controlDc!.onmessage?.({ data: JSON.stringify({ type: 'live-request', channelId: 'ch1' }) });

		// Both video and audio tracks from the named channel should be added
		expect(_activePc.addTrack).toHaveBeenCalledTimes(2);
		expect(mockSendOffer).toHaveBeenCalled();
	});
});

// ── handleAnswer ──────────────────────────────────────────────────────────────

describe('handleAnswer', () => {
	it('sets the remote description on the peer connection', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		await handleAnswer({ type: 'answer', sdp: 'answer-sdp', sessionId: SESSION_ID }, VIEWER_PUB);
		expect(_activePc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' });
	});

	it('ignores answers for an unknown viewer', async () => {
		await handleAnswer({ type: 'answer', sdp: 'sdp', sessionId: SESSION_ID }, 'c'.repeat(64));
		expect(_activePc.setRemoteDescription).not.toHaveBeenCalled();
	});

	it('ignores answers with a mismatched session ID', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		await handleAnswer({ type: 'answer', sdp: 'sdp', sessionId: 'wrong' }, VIEWER_PUB);
		expect(_activePc.setRemoteDescription).not.toHaveBeenCalled();
	});
});

// ── handleHangup ──────────────────────────────────────────────────────────────

describe('handleHangup', () => {
	it('closes the session when a hangup arrives for an active session', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		handleHangup({ type: 'hangup', sessionId: SESSION_ID }, VIEWER_PUB);
		expect(_activePc.close).toHaveBeenCalled();
	});

	it('ignores hangups for unknown viewers', () => {
		handleHangup({ type: 'hangup', sessionId: SESSION_ID }, 'c'.repeat(64));
		expect(_activePc.close).not.toHaveBeenCalled();
	});

	it('ignores hangups with a mismatched session ID', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		handleHangup({ type: 'hangup', sessionId: 'wrong' }, VIEWER_PUB);
		expect(_activePc.close).not.toHaveBeenCalled();
	});
});

// ── segments-in-range-request handler ────────────────────────────────────────

function makeSeg(id: string, overrides: Record<string, unknown> = {}) {
	return {
		segmentId: id,
		backupOf: null,
		startTime: 1000,
		endTime: 1010,
		mimeType: 'video/webm',
		sizeBytes: 1000,
		...overrides,
	};
}

describe('segments-in-range-request handler', () => {
	let controlDc: ReturnType<typeof createMockDc>;

	beforeEach(async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([]);
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		controlDc = _activePc._getDc('control')!;
		controlDc.send.mockClear();
	});

	async function sendRequest(req: Record<string, unknown>) {
		await controlDc.onmessage?.({ data: JSON.stringify(req) });
	}

	it('returns an empty array when no segments exist', async () => {
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 10, order: 'asc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.type).toBe('segments-in-range');
		expect(sent.segments).toHaveLength(0);
	});

	it('returns segment metadata for segments in range', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([makeSeg('seg-1')] as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 10, order: 'asc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(1);
		expect(sent.segments[0].segmentId).toBe('seg-1');
	});

	it('excludes segments whose canonical ID is in knownIds', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([
			makeSeg('seg-1'),
			makeSeg('seg-2'),
		] as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 10, order: 'asc', knownIds: ['seg-1'] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(1);
		expect(sent.segments[0].segmentId).toBe('seg-2');
	});

	it('uses backupOf as the canonical ID for exclusion and in the response', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([
			makeSeg('local-copy', { backupOf: 'origin-id' }),
		] as never);
		// Viewer has the origin ID — local copy should be excluded
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 10, order: 'asc', knownIds: ['origin-id'] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(0);
	});

	it('reports canonical segmentId (backupOf) in the response', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([
			makeSeg('local-copy', { backupOf: 'origin-id' }),
		] as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 10, order: 'asc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments[0].segmentId).toBe('origin-id');
	});

	it('respects limit — asc returns first N by startTime', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([
			makeSeg('s1', { startTime: 1000, endTime: 1010 }),
			makeSeg('s2', { startTime: 1010, endTime: 1020 }),
			makeSeg('s3', { startTime: 1020, endTime: 1030 }),
		] as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 2, order: 'asc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(2);
		expect(sent.segments[0].segmentId).toBe('s1');
		expect(sent.segments[1].segmentId).toBe('s2');
	});

	it('desc order returns last N by startTime', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([
			makeSeg('s1', { startTime: 1000, endTime: 1010 }),
			makeSeg('s2', { startTime: 1010, endTime: 1020 }),
			makeSeg('s3', { startTime: 1020, endTime: 1030 }),
		] as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 2, order: 'desc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(2);
		expect(sent.segments[0].segmentId).toBe('s3'); // newest first
		expect(sent.segments[1].segmentId).toBe('s2');
	});

	it('filters by mimePrefix', async () => {
		vi.mocked(getSegmentsInRange).mockResolvedValue([
			makeSeg('vid', { mimeType: 'video/webm' }),
			makeSeg('aud', { mimeType: 'audio/webm' }),
		] as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 10, order: 'asc', knownIds: [], mimePrefix: 'video/' });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(1);
		expect(sent.segments[0].segmentId).toBe('vid');
	});

	it('caps limit at 50 even when a higher value is requested', async () => {
		const segs = Array.from({ length: 60 }, (_, i) =>
			makeSeg(`s${i}`, { startTime: 1000 + i * 10, endTime: 1010 + i * 10 })
		);
		vi.mocked(getSegmentsInRange).mockResolvedValue(segs as never);
		await sendRequest({ type: 'segments-in-range-request', from: 0, to: 9999, limit: 100, order: 'asc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.segments).toHaveLength(50);
	});

	it('echoes from/to in the response', async () => {
		await sendRequest({ type: 'segments-in-range-request', from: 1234, to: 5678, limit: 10, order: 'asc', knownIds: [] });
		const sent = JSON.parse(controlDc.send.mock.calls[0][0]);
		expect(sent.from).toBe(1234);
		expect(sent.to).toBe(5678);
	});
});

// ── ICE failure handling ──────────────────────────────────────────────────────

describe('ICE failure handling', () => {
	it('closes the monitor session when ICE fails after connection', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		captured.onIceChange?.('failed');
		expect(_activePc.close).toHaveBeenCalled();
	});

	it('closes the monitor session when ICE reports closed state', async () => {
		await handleOfferRequest(PRIV, MONITOR_PUB, makeSignal(), VIEWER_PUB);
		captured.onIceChange?.('closed');
		expect(_activePc.close).toHaveBeenCalled();
	});
});
