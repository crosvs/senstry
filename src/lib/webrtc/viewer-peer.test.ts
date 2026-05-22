import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock infrastructure ────────────────────────────────────────────────────────

const captured = {
	onTrack:    null as ((stream: MediaStream) => void) | null,
	onIceChange: null as ((state: RTCIceConnectionState) => void) | null,
};

const { mockSendOfferRequest, mockSendAnswer } = vi.hoisted(() => ({
	mockSendOfferRequest: vi.fn().mockResolvedValue(undefined),
	mockSendAnswer:       vi.fn().mockResolvedValue(undefined),
}));

let _activePc: ReturnType<typeof createMockPc>;

function createMockPc() {
	let _localDesc: { type: string; sdp: string } | null = null;
	return {
		ondatachannel: null as ((e: { channel: ReturnType<typeof createMockDc> }) => void) | null,
		iceConnectionState: 'new' as RTCIceConnectionState,
		iceGatheringState:  'complete' as RTCIceGatheringState,
		close:               vi.fn(),
		setRemoteDescription: vi.fn().mockResolvedValue(undefined),
		createAnswer:         vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' }),
		setLocalDescription:  vi.fn().mockImplementation(async (d: { type: string; sdp: string }) => { _localDesc = d; }),
		createOffer:          vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-offer-sdp' }),
		addTrack: vi.fn(),
		getReceivers: vi.fn().mockReturnValue([]),
		getSenders:   vi.fn().mockReturnValue([]),
		getStats:     vi.fn().mockResolvedValue(new Map()),
		get localDescription() { return _localDesc; },
	};
}

function createMockDc(label = 'control', readyState: RTCDataChannelState = 'open') {
	return {
		readyState,
		label,
		onmessage: null as ((e: { data: string }) => void) | null,
		onopen:    null as (() => void) | null,
		send:  vi.fn(),
		close: vi.fn(),
	};
}

vi.mock('./peer', () => ({
	createPeer: () => _activePc,
	onTrack:          (_pc: unknown, cb: (s: MediaStream) => void)           => { captured.onTrack    = cb; },
	onIceStateChange: (_pc: unknown, cb: (s: RTCIceConnectionState) => void) => { captured.onIceChange = cb; },
	waitForIceGathering: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./signaling', () => ({
	sendOfferRequest: mockSendOfferRequest,
	sendAnswer:       mockSendAnswer,
}));

vi.mock('$lib/store/stream', () => ({
	remoteStream: { set: vi.fn() },
	streamState:  { set: vi.fn() },
}));

vi.mock('$lib/store/viewer-connection', () => ({
	viewerConnection: { update: vi.fn(), subscribe: vi.fn(() => () => {}) },
	selectChannel:    vi.fn(),
}));

vi.mock('$lib/db/segments', () => ({
	computeHash:         vi.fn().mockResolvedValue('abc123'),
	getDistinctChannels: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/utils',          () => ({ randomUUID: vi.fn().mockReturnValue('test-session-id') }));
vi.mock('$lib/store/debug',    () => ({ dbg: vi.fn() }));
vi.mock('$lib/store/pipeline', () => ({}));

import {
	connectToMonitor, startLiveView, handleViewerSignal, disconnectViewer, cancelConnect,
	requestSegmentsInRange,
	_resetForTest, _setSessionForTest, _setPendingAnswerContextForTest,
	type RemoteSegmentMeta,
} from './viewer-peer';

// ── Constants ──────────────────────────────────────────────────────────────────

const PRIV        = new Uint8Array(32).fill(1);
const PUB         = 'a'.repeat(64);
const MONITOR_PUB = 'b'.repeat(64);
const SESSION_ID  = 'test-session-id';

beforeEach(() => {
	_resetForTest();
	_activePc = createMockPc();
	captured.onTrack    = null;
	captured.onIceChange = null;
	mockSendOfferRequest.mockReset().mockResolvedValue(undefined);
	mockSendAnswer.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

// Helper: fire ondatachannel with a control DC that auto-responds to channel-list-request.
function openControlChannel(readyState: RTCDataChannelState = 'open') {
	const dc = createMockDc('control', readyState);
	dc.send.mockImplementation((raw: string) => {
		const msg = JSON.parse(raw) as { type: string };
		if (msg.type === 'channel-list-request' && dc.onmessage) {
			dc.onmessage({ data: JSON.stringify({ type: 'channel-list', channels: [] }) });
		}
	});
	_activePc.ondatachannel?.({ channel: dc });
	if (readyState !== 'open') dc.onopen?.();
	return dc;
}

// ── connectToMonitor ──────────────────────────────────────────────────────────

describe('connectToMonitor', () => {
	it('sends a data-mode offer-request', async () => {
		const p = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		expect(mockSendOfferRequest).toHaveBeenCalledWith(PRIV, PUB, MONITOR_PUB, SESSION_ID, 'data', undefined, undefined);
		openControlChannel();
		await p;
	});

	it('resolves when the control channel opens', async () => {
		const p = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		openControlChannel();
		await expect(p).resolves.toBeUndefined();
	});

	it('rejects on relay publish error', async () => {
		mockSendOfferRequest.mockRejectedValueOnce(new Error('rate-limited'));
		await expect(connectToMonitor(PRIV, PUB, MONITOR_PUB)).rejects.toThrow('Relay error');
	});

	it('rejects when ICE fails before connecting', async () => {
		const p = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		await Promise.resolve();
		captured.onIceChange?.('failed');
		await expect(p).rejects.toThrow(/ICE/i);
	});

	it('does not send a second offer-request for a concurrent call to the same monitor', async () => {
		const p1 = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		const p2 = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		expect(mockSendOfferRequest).toHaveBeenCalledTimes(1);
		cancelConnect(MONITOR_PUB);
		await Promise.allSettled([p1, p2]);
	});
});

// ── startLiveView — upgrade path ──────────────────────────────────────────────

describe('startLiveView upgrade path (existing data connection)', () => {
	function injectDataSession() {
		const dc = createMockDc('control', 'open');
		_setSessionForTest(MONITOR_PUB, _activePc as unknown as RTCPeerConnection, dc as unknown as RTCDataChannel, SESSION_ID, 'data');
		return dc;
	}

	it('does NOT send a Nostr offer-request when a data session is open', async () => {
		const dc = injectDataSession();
		const p = startLiveView(PRIV, PUB, MONITOR_PUB, 'ch1');
		expect(mockSendOfferRequest).not.toHaveBeenCalled();
		expect(dc.send).toHaveBeenCalledWith(JSON.stringify({ type: 'live-request', channelId: 'ch1' }));
		cancelConnect(MONITOR_PUB);
		await p.catch(() => {});
	});

	it('sends live-request with the correct channelId over the control channel', async () => {
		const dc = injectDataSession();
		const p = startLiveView(PRIV, PUB, MONITOR_PUB, 'my-channel');
		expect(dc.send).toHaveBeenCalledWith(
			JSON.stringify({ type: 'live-request', channelId: 'my-channel' })
		);
		cancelConnect(MONITOR_PUB);
		await p.catch(() => {});
	});

	it('rejects the live-upgrade promise when cancelConnect is called', async () => {
		injectDataSession();
		const p = startLiveView(PRIV, PUB, MONITOR_PUB, 'ch1');
		cancelConnect(MONITOR_PUB);
		await expect(p).rejects.toThrow();
	});

	it('processes a renegotiation offer and sends an answer', async () => {
		injectDataSession();
		_setPendingAnswerContextForTest({ privkey: PRIV, viewerPubkey: PUB });
		await handleViewerSignal({ type: 'offer', sdp: 'renegotiation-sdp', sessionId: SESSION_ID }, MONITOR_PUB);
		expect(mockSendAnswer).toHaveBeenCalledWith(PRIV, PUB, MONITOR_PUB, expect.any(String), SESSION_ID);
	});
});

// ── startLiveView — full path (no existing connection) ────────────────────────

describe('startLiveView full path (no existing connection)', () => {
	it('sends a live-mode offer-request when no session exists', async () => {
		const p = startLiveView(PRIV, PUB, MONITOR_PUB, 'ch1');
		expect(mockSendOfferRequest).toHaveBeenCalledWith(PRIV, PUB, MONITOR_PUB, SESSION_ID, 'live', undefined, 'ch1');
		cancelConnect(MONITOR_PUB);
		await p.catch(() => {});
	});

	it('passes the channelId in the offer-request', async () => {
		const p = startLiveView(PRIV, PUB, MONITOR_PUB, 'specific-channel');
		const args = mockSendOfferRequest.mock.calls[0];
		expect(args[6]).toBe('specific-channel'); // channelId argument
		cancelConnect(MONITOR_PUB);
		await p.catch(() => {});
	});

	it('uses live mode (not data) in the offer-request', async () => {
		const p = startLiveView(PRIV, PUB, MONITOR_PUB, 'ch1');
		const args = mockSendOfferRequest.mock.calls[0];
		expect(args[4]).toBe('live'); // mode argument
		cancelConnect(MONITOR_PUB);
		await p.catch(() => {});
	});
});

// ── handleViewerSignal ────────────────────────────────────────────────────────

describe('handleViewerSignal', () => {
	beforeEach(() => {
		_setSessionForTest(MONITOR_PUB, _activePc as unknown as RTCPeerConnection, null, SESSION_ID);
		_setPendingAnswerContextForTest({ privkey: PRIV, viewerPubkey: PUB });
	});

	it('sets remote description on offer', async () => {
		await handleViewerSignal({ type: 'offer', sdp: 'offer-sdp', sessionId: SESSION_ID }, MONITOR_PUB);
		expect(_activePc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'offer-sdp' });
	});

	it('sends an answer after processing an offer', async () => {
		await handleViewerSignal({ type: 'offer', sdp: 'offer-sdp', sessionId: SESSION_ID }, MONITOR_PUB);
		expect(mockSendAnswer).toHaveBeenCalledWith(PRIV, PUB, MONITOR_PUB, expect.any(String), SESSION_ID);
	});

	it('drops an offer when session ID does not match', async () => {
		await handleViewerSignal({ type: 'offer', sdp: 'sdp', sessionId: 'wrong-session-id' }, MONITOR_PUB);
		expect(_activePc.setRemoteDescription).not.toHaveBeenCalled();
		expect(mockSendAnswer).not.toHaveBeenCalled();
	});

	it('drops a message when no session exists for the sender', async () => {
		await handleViewerSignal({ type: 'offer', sdp: 'sdp', sessionId: SESSION_ID }, 'c'.repeat(64));
		expect(_activePc.setRemoteDescription).not.toHaveBeenCalled();
	});

	it('closes the session on hangup', async () => {
		await handleViewerSignal({ type: 'hangup', sessionId: SESSION_ID }, MONITOR_PUB);
		expect(_activePc.close).toHaveBeenCalled();
	});

	it('retries the answer on rate-limited error', async () => {
		vi.useFakeTimers();
		mockSendAnswer
			.mockRejectedValueOnce(new Error('rate-limited'))
			.mockResolvedValue(undefined);
		const p = handleViewerSignal({ type: 'offer', sdp: 'sdp', sessionId: SESSION_ID }, MONITOR_PUB);
		await vi.advanceTimersByTimeAsync(8_001);
		await p;
		expect(mockSendAnswer).toHaveBeenCalledTimes(2);
	});

	it('does not retry the answer on non-rate-limit errors', async () => {
		mockSendAnswer.mockRejectedValueOnce(new Error('auth-required'));
		await handleViewerSignal({ type: 'offer', sdp: 'sdp', sessionId: SESSION_ID }, MONITOR_PUB).catch(() => {});
		expect(mockSendAnswer).toHaveBeenCalledTimes(1);
	});
});

// ── disconnectViewer ──────────────────────────────────────────────────────────

describe('disconnectViewer', () => {
	it('closes the PC for the specified monitor', () => {
		_setSessionForTest(MONITOR_PUB, _activePc as unknown as RTCPeerConnection, null, SESSION_ID);
		disconnectViewer(MONITOR_PUB);
		expect(_activePc.close).toHaveBeenCalled();
	});

	it('closes all sessions when called without argument', () => {
		const pc2 = createMockPc();
		const MONITOR2 = 'c'.repeat(64);
		_setSessionForTest(MONITOR_PUB, _activePc as unknown as RTCPeerConnection, null, SESSION_ID);
		_setSessionForTest(MONITOR2,    pc2 as unknown as RTCPeerConnection,       null, 'sess2');
		disconnectViewer();
		expect(_activePc.close).toHaveBeenCalled();
		expect(pc2.close).toHaveBeenCalled();
	});
});

// ── cancelConnect ─────────────────────────────────────────────────────────────

describe('cancelConnect', () => {
	it('rejects an in-flight ensureConnection promise', async () => {
		const p = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		cancelConnect(MONITOR_PUB);
		await expect(p).rejects.toThrow();
	});
});

// ── requestSegmentsInRange ────────────────────────────────────────────────────
// These tests use the full connectToMonitor + openControlChannel flow so that
// handleControlMessage is properly wired to dc.onmessage (the same path real
// code takes). _setSessionForTest bypasses ondatachannel and leaves onmessage=null.

describe('requestSegmentsInRange', () => {
	async function connectWithDc() {
		const p = connectToMonitor(PRIV, PUB, MONITOR_PUB);
		const dc = openControlChannel();
		await p;
		dc.send.mockClear(); // discard the channel-list-request recorded during connect
		return dc;
	}

	it('sends a segments-in-range-request over the control channel', async () => {
		const dc = await connectWithDc();
		requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB).catch(() => {});
		expect(dc.send).toHaveBeenCalledWith(JSON.stringify({
			type: 'segments-in-range-request',
			from: 1000, to: 2000, limit: 10, order: 'asc', knownIds: [],
		}));
	});

	it('includes mimePrefix and channelId when provided', async () => {
		const dc = await connectWithDc();
		requestSegmentsInRange(1000, 2000, 5, 'desc', ['known-id'], PRIV, PUB, MONITOR_PUB, 'video/', 'ch1').catch(() => {});
		expect(dc.send).toHaveBeenCalledWith(JSON.stringify({
			type: 'segments-in-range-request',
			from: 1000, to: 2000, limit: 5, order: 'desc', knownIds: ['known-id'],
			mimePrefix: 'video/', channelId: 'ch1',
		}));
	});

	it('resolves with the segment list from the monitor response', async () => {
		const segs: RemoteSegmentMeta[] = [{
			segmentId: 'seg-1', startTime: 1000, endTime: 1010,
			mimeType: 'video/webm', sizeBytes: 1000, contentHash: '',
		}];
		const dc = await connectWithDc();
		dc.send.mockImplementation((raw: string) => {
			const msg = JSON.parse(raw) as { type: string };
			if (msg.type === 'segments-in-range-request' && dc.onmessage) {
				dc.onmessage({ data: JSON.stringify({ type: 'segments-in-range', from: 1000, to: 2000, segments: segs }) });
			}
		});
		const result = await requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB);
		expect(result).toEqual(segs);
	});

	it('resolves with an empty array when the monitor has no matching segments', async () => {
		const dc = await connectWithDc();
		dc.send.mockImplementation((raw: string) => {
			const msg = JSON.parse(raw) as { type: string };
			if (msg.type === 'segments-in-range-request' && dc.onmessage) {
				dc.onmessage({ data: JSON.stringify({ type: 'segments-in-range', from: 1000, to: 2000, segments: [] }) });
			}
		});
		const result = await requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB);
		expect(result).toEqual([]);
	});

	it('throws "offline" when no open session exists', async () => {
		await expect(
			requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB)
		).rejects.toThrow('offline');
	});

	it('rejects with a timeout error when no response arrives', async () => {
		vi.useFakeTimers();
		const dc = await connectWithDc();
		// dc.send does nothing → no response comes back
		dc.send.mockImplementation(() => {});
		const p = requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB);
		p.catch(() => {}); // suppress unhandled rejection
		await vi.advanceTimersByTimeAsync(15_001);
		await expect(p).rejects.toThrow('segments-in-range timeout');
	});

	// ── First-N / Last-N semantics (used by the "First N" and "Last N" fetch buttons) ──

	it('order asc returns segments in ascending startTime order (First-N)', async () => {
		const segs: RemoteSegmentMeta[] = [
			{ segmentId: 's1', startTime: 1000, endTime: 1010, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' },
			{ segmentId: 's2', startTime: 1010, endTime: 1020, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' },
			{ segmentId: 's3', startTime: 1020, endTime: 1030, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' },
		];
		const dc = await connectWithDc();
		dc.send.mockImplementation((raw: string) => {
			const msg = JSON.parse(raw) as { type: string };
			if (msg.type === 'segments-in-range-request' && dc.onmessage) {
				dc.onmessage({ data: JSON.stringify({ type: 'segments-in-range', from: 1000, to: 2000, segments: segs }) });
			}
		});
		const result = await requestSegmentsInRange(1000, 2000, 3, 'asc', [], PRIV, PUB, MONITOR_PUB);
		expect(result).toHaveLength(3);
		expect(result[0].segmentId).toBe('s1');
		expect(result[2].segmentId).toBe('s3');
	});

	it('order desc returns segments in descending startTime order (Last-N)', async () => {
		const segs: RemoteSegmentMeta[] = [
			{ segmentId: 's3', startTime: 1020, endTime: 1030, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' },
			{ segmentId: 's2', startTime: 1010, endTime: 1020, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' },
		];
		const dc = await connectWithDc();
		dc.send.mockImplementation((raw: string) => {
			const msg = JSON.parse(raw) as { type: string };
			if (msg.type === 'segments-in-range-request' && dc.onmessage) {
				dc.onmessage({ data: JSON.stringify({ type: 'segments-in-range', from: 1000, to: 2000, segments: segs }) });
			}
		});
		const result = await requestSegmentsInRange(1000, 2000, 2, 'desc', [], PRIV, PUB, MONITOR_PUB);
		expect(result[0].segmentId).toBe('s3'); // most recent first
		expect(result[1].segmentId).toBe('s2');
	});

	it('knownIds prevents re-fetching already-loaded segments', async () => {
		// Simulate viewer already having s1; monitor should not return it
		const returned: RemoteSegmentMeta[] = [
			{ segmentId: 's2', startTime: 1010, endTime: 1020, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' },
		];
		const dc = await connectWithDc();
		dc.send.mockImplementation((raw: string) => {
			const msg = JSON.parse(raw) as { type: string; knownIds?: string[] };
			if (msg.type === 'segments-in-range-request') {
				// Verify knownIds was sent correctly
				expect(msg.knownIds).toContain('s1');
				if (dc.onmessage) {
					dc.onmessage({ data: JSON.stringify({ type: 'segments-in-range', from: 1000, to: 2000, segments: returned }) });
				}
			}
		});
		const result = await requestSegmentsInRange(1000, 2000, 5, 'asc', ['s1'], PRIV, PUB, MONITOR_PUB);
		expect(result).toHaveLength(1);
		expect(result[0].segmentId).toBe('s2');
	});

	it('a second call supersedes the first (single-slot callback)', async () => {
		const segs: RemoteSegmentMeta[] = [{ segmentId: 's1', startTime: 1000, endTime: 1010, mimeType: 'video/webm', sizeBytes: 100, contentHash: '' }];
		const dc = await connectWithDc();

		// First call — send does nothing, no response
		dc.send.mockImplementation(() => {});
		const p1 = requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB);
		p1.catch(() => {}); // suppress rejection when second call clears the slot

		// Second call — override send to immediately echo the response
		dc.send.mockImplementation((raw: string) => {
			const msg = JSON.parse(raw) as { type: string };
			if (msg.type === 'segments-in-range-request' && dc.onmessage) {
				dc.onmessage({ data: JSON.stringify({ type: 'segments-in-range', from: 1000, to: 2000, segments: segs }) });
			}
		});
		const result = await requestSegmentsInRange(1000, 2000, 10, 'asc', [], PRIV, PUB, MONITOR_PUB);
		expect(result).toEqual(segs);
	});
});
