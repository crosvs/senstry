import { createPeer, onTrack, onIceStateChange, waitForIceGathering } from './peer';
import { listenForSignals, sendOfferRequest, sendAnswer } from './signaling';
import { streamState, remoteStream } from '$lib/store/stream';
import { dbg } from '$lib/store/debug';
import type { SignalMessage } from './signaling';
import { randomUUID } from '$lib/utils';

interface ViewerSession {
	pc: RTCPeerConnection;
	monitorPubkey: string;
	sessionId: string;
	dataChannel: RTCDataChannel | null;
	mode: 'live' | 'data';
}

interface PendingSegment {
	mimeType: string;
	startTime: number;
	endTime: number;
	originMonitor: string;
	segmentId: string;
	chunks: string[];
	total: number;
	resolve: (r: { mimeType: string; blob: Blob; startTime: number; endTime: number; originMonitor: string; segmentId: string }) => void;
	reject: (reason: string) => void;
}

// One session per target monitor, keyed by monitorPubkey.
const sessions = new Map<string, ViewerSession>();
const connectPromises = new Map<string, Promise<void>>();
const lastConnectAttempts = new Map<string, number>();

let generation = 0;

// Self-contained signal listener for the viewer role.
// Started lazily on first ensureConnection call so the viewer doesn't depend on
// SentrySection's signal router toggle being active.
let _viewerSignalSub: { close: () => void } | null = null;

function ensureViewerSubscription(privkey: Uint8Array, pubkey: string): void {
	if (_viewerSignalSub) return;
	_viewerSignalSub = listenForSignals(privkey, pubkey, async (msg, fromPubkey) => {
		if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'hangup') {
			await handleViewerSignal(msg, fromPubkey);
		}
	});
	dbg('info', 'rtc', 'viewer signal listener started');
}
const MIN_CONNECT_INTERVAL_MS = 4_000;

let pendingCoverage: ((segments: [number, number][]) => void) | null = null;
let pendingSourceList: ((ids: string[]) => void) | null = null;
let coverageRejectTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSegments = new Map<number, PendingSegment>();
const pendingSegmentsById = new Map<string, PendingSegment>();

function closeSession(monitorPubkey: string): void {
	generation++;
	const s = sessions.get(monitorPubkey);
	if (s) { s.pc.close(); sessions.delete(monitorPubkey); }
	connectPromises.delete(monitorPubkey);
	remoteStream.set(null);
}

// Called by signal-router when an offer/answer/hangup arrives.
export async function handleViewerSignal(msg: SignalMessage, fromPubkey: string): Promise<void> {
	const session = sessions.get(fromPubkey);
	if (!session) {
		dbg('warn', 'rtc', `viewer: no session for ${fromPubkey.slice(0, 8)} — dropping ${msg.type}`);
		return;
	}
	if (session.sessionId !== msg.sessionId) {
		dbg('warn', 'rtc', `viewer: session id mismatch for ${msg.type} (expected ${session.sessionId.slice(0, 8)}, got ${msg.sessionId.slice(0, 8)})`);
		return;
	}

	if (msg.type === 'offer' && msg.sdp) {
		dbg('info', 'rtc', `viewer: processing offer from ${fromPubkey.slice(0, 8)}`);
		try {
			await session.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
			const answer = await session.pc.createAnswer();
			await session.pc.setLocalDescription(answer);
			await waitForIceGathering(session.pc);
			if (_pendingAnswerContext) {
				const { privkey, viewerPubkey } = _pendingAnswerContext;
				const sdp = session.pc.localDescription!.sdp!;
				// Retry once on rate-limit / transient relay rejection
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						await sendAnswer(privkey, viewerPubkey, fromPubkey, sdp, msg.sessionId);
						dbg('info', 'rtc', `viewer: answer sent to ${fromPubkey.slice(0, 8)}`);
						break;
					} catch (e) {
						const msg2 = e instanceof Error ? e.message : String(e);
						if (attempt === 0 && (msg2.includes('rate-limited') || msg2.includes('publish failed'))) {
							dbg('warn', 'rtc', `viewer: answer rate-limited, retrying in 3s…`);
							await new Promise(r => setTimeout(r, 3000));
						} else {
							throw e;
						}
					}
				}
			} else {
				dbg('warn', 'rtc', 'viewer: no answer context — cannot send answer');
			}
		} catch (e) {
			dbg('warn', 'rtc', `viewer: offer processing failed: ${e instanceof Error ? e.message : e}`);
		}
	} else if (msg.type === 'hangup') {
		dbg('info', 'rtc', `viewer: hangup from ${fromPubkey.slice(0, 8)}`);
		closeSession(fromPubkey);
	}
}

// Module-level context for sendAnswer — set during ensureConnection, cleared on close.
let _pendingAnswerContext: { privkey: Uint8Array; viewerPubkey: string } | null = null;

export async function ensureConnection(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mode: 'live' | 'data' = 'data',
	sourceId?: string,
	channelId?: string
): Promise<void> {
	const existing = sessions.get(monitorPubkey);
	// Reuse any open data channel. If upgrading to live, requestLiveView closes first.
	if (existing?.dataChannel?.readyState === 'open') return;

	const inFlight = connectPromises.get(monitorPubkey);
	if (inFlight) return inFlight;

	const now = Date.now();
	const last = lastConnectAttempts.get(monitorPubkey) ?? 0;
	if (now - last < MIN_CONNECT_INTERVAL_MS) throw new Error('reconnect cooldown — wait a moment');
	lastConnectAttempts.set(monitorPubkey, now);

	const myGeneration = ++generation;
	_pendingAnswerContext = { privkey, viewerPubkey };
	ensureViewerSubscription(privkey, viewerPubkey);

	const promise = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (generation !== myGeneration) return;
			connectPromises.delete(monitorPubkey);
			reject(new Error('Connection timed out'));
		}, 30_000);

		const sessionId = randomUUID();
		const pc = createPeer();
		sessions.set(monitorPubkey, { pc, monitorPubkey, sessionId, dataChannel: null, mode });
		streamState.set('connecting');

		pc.ondatachannel = (e) => {
			if (generation !== myGeneration) return;
			const s = sessions.get(monitorPubkey);
			if (s) s.dataChannel = e.channel;
			e.channel.onmessage = (ev) => handleDataMessage(ev.data);
			const open = () => {
				if (generation !== myGeneration) return;
				clearTimeout(timeout);
				connectPromises.delete(monitorPubkey);
				resolve();
			};
			if (e.channel.readyState === 'open') open();
			else e.channel.onopen = open;
		};

		onTrack(pc, (stream) => {
			if (generation !== myGeneration) return;
			// Only surface the remote stream for live-mode connections.
			if (mode === 'live') {
				remoteStream.set(stream);
				streamState.set('connected');
			}
		});

		onIceStateChange(pc, (state) => {
			if (generation !== myGeneration) return;
			if (state === 'failed' || state === 'closed') {
				clearTimeout(timeout);
				connectPromises.delete(monitorPubkey);
				streamState.set('failed');
				reject(new Error('ICE failed'));
				closeSession(monitorPubkey);
			}
		});

		sendOfferRequest(privkey, viewerPubkey, monitorPubkey, sessionId, mode, sourceId, channelId);
	});

	connectPromises.set(monitorPubkey, promise);
	return promise;
}

export async function requestLiveView(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	sourceId?: string,
	channelId?: string
): Promise<void> {
	closeSession(monitorPubkey);
	lastConnectAttempts.delete(monitorPubkey);
	return ensureConnection(privkey, viewerPubkey, monitorPubkey, 'live', sourceId, channelId);
}

export async function requestSourceList(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<string[]> {
	try { await ensureConnection(privkey, viewerPubkey, monitorPubkey); }
	catch { throw new Error('offline'); }
	const session = sessions.get(monitorPubkey);
	if (!session?.dataChannel) throw new Error('offline');

	return new Promise<string[]>((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSourceList = null;
			reject(new Error('source-list timeout'));
		}, 5_000);
		pendingSourceList = (ids) => {
			clearTimeout(timer);
			resolve(ids);
		};
		session.dataChannel!.send(JSON.stringify({ type: 'source-list-request' }));
	});
}

export async function requestCoverageMap(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mimePrefix?: string
): Promise<[number, number][]> {
	try { await ensureConnection(privkey, viewerPubkey, monitorPubkey); }
	catch { throw new Error('offline'); }
	const session = sessions.get(monitorPubkey);
	if (!session?.dataChannel) throw new Error('offline');

	if (coverageRejectTimer !== null) { clearTimeout(coverageRejectTimer); coverageRejectTimer = null; pendingCoverage = null; }

	return new Promise<[number, number][]>((resolve, reject) => {
		coverageRejectTimer = setTimeout(() => {
			coverageRejectTimer = null; pendingCoverage = null;
			reject(new Error('coverage timeout'));
		}, 10_000);
		pendingCoverage = (segments) => {
			if (coverageRejectTimer !== null) { clearTimeout(coverageRejectTimer); coverageRejectTimer = null; }
			resolve(segments);
		};
		const msg: Record<string, unknown> = { type: 'coverage-request' };
		if (mimePrefix) msg.mimePrefix = mimePrefix;
		session.dataChannel!.send(JSON.stringify(msg));
	});
}

export async function requestSegment(
	time: number,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mimePrefix?: string
): Promise<{ mimeType: string; blob: Blob; startTime: number; endTime: number; originMonitor: string; segmentId: string }> {
	try { await ensureConnection(privkey, viewerPubkey, monitorPubkey); }
	catch { throw new Error('offline'); }
	const session = sessions.get(monitorPubkey);
	if (!session?.dataChannel) throw new Error('offline');

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSegments.delete(time);
			reject(new Error('segment timeout'));
		}, 30_000);
		pendingSegments.set(time, {
			mimeType: '', startTime: 0, endTime: 0, originMonitor: '', segmentId: '',
			chunks: [], total: 0,
			resolve: (r) => { clearTimeout(timer); resolve(r); },
			reject: (reason) => { clearTimeout(timer); pendingSegments.delete(time); reject(new Error(reason)); }
		});
		const msg: Record<string, unknown> = { type: 'segment-request', time };
		if (mimePrefix) msg.mimePrefix = mimePrefix;
		session.dataChannel!.send(JSON.stringify(msg));
	});
}

export async function requestSegmentById(
	segmentId: string,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<{ mimeType: string; blob: Blob; startTime: number; endTime: number; originMonitor: string; segmentId: string }> {
	try { await ensureConnection(privkey, viewerPubkey, monitorPubkey); }
	catch { throw new Error('offline'); }
	const session = sessions.get(monitorPubkey);
	if (!session?.dataChannel) throw new Error('offline');

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSegmentsById.delete(segmentId);
			reject(new Error('segment timeout'));
		}, 30_000);
		pendingSegmentsById.set(segmentId, {
			mimeType: '', startTime: 0, endTime: 0, originMonitor: '', segmentId: '',
			chunks: [], total: 0,
			resolve: (r) => { clearTimeout(timer); resolve(r); },
			reject: (reason) => { clearTimeout(timer); pendingSegmentsById.delete(segmentId); reject(new Error(reason)); }
		});
		session.dataChannel!.send(JSON.stringify({ type: 'segment-request-by-id', segmentId }));
	});
}

function handleDataMessage(raw: string): void {
	let msg: { type: string } & Record<string, unknown>;
	try { msg = JSON.parse(raw); } catch { return; }

	if (msg.type === 'source-list') {
		const cb = pendingSourceList;
		pendingSourceList = null;
		cb?.(msg.sourceIds as string[]);
		return;
	}

	if (msg.type === 'coverage-map') {
		const cb = pendingCoverage;
		pendingCoverage = null;
		cb?.(msg.segments as [number, number][]);
		return;
	}

	const requestTime = msg.requestTime as number;

	if (msg.type === 'segment-meta') {
		const pending = pendingSegments.get(requestTime);
		if (pending) {
			pending.mimeType = msg.mimeType as string;
			pending.startTime = msg.startTime as number;
			pending.endTime = msg.endTime as number;
			pending.originMonitor = (msg.originMonitor as string) ?? '';
			pending.segmentId = (msg.segmentId as string) ?? '';
			pending.total = Math.ceil((msg.sizeBytes as number) / (32 * 1024)) || 1;
		}
		return;
	}

	if (msg.type === 'segment-chunk') {
		const pending = pendingSegments.get(requestTime);
		if (!pending) return;
		pending.chunks[msg.index as number] = msg.data as string;
		if (pending.chunks.filter(Boolean).length === (msg.total as number)) {
			pendingSegments.delete(requestTime);
			const binary = pending.chunks.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
			const blob = new Blob(binary, { type: pending.mimeType });
			pending.resolve({ mimeType: pending.mimeType, blob, startTime: pending.startTime, endTime: pending.endTime, originMonitor: pending.originMonitor, segmentId: pending.segmentId });
		}
		return;
	}

	if (msg.type === 'segment-error') {
		const pending = pendingSegments.get(requestTime);
		if (pending) pending.reject(msg.reason as string);
		return;
	}

	const segmentId = msg.segmentId as string;

	if (msg.type === 'segment-meta-by-id') {
		const pending = pendingSegmentsById.get(segmentId);
		if (pending) {
			pending.mimeType = msg.mimeType as string;
			pending.startTime = msg.startTime as number;
			pending.endTime = msg.endTime as number;
			pending.originMonitor = (msg.originMonitor as string) ?? '';
			// msg.segmentId may differ from the request key if the server resolved
			// a footage-ref ID to its canonical segment ID — capture whichever is sent.
			pending.segmentId = (msg.segmentId as string) || segmentId;
			pending.total = Math.ceil((msg.sizeBytes as number) / (32 * 1024)) || 1;
		}
		return;
	}

	if (msg.type === 'segment-chunk-by-id') {
		const pending = pendingSegmentsById.get(segmentId);
		if (!pending) return;
		pending.chunks[msg.index as number] = msg.data as string;
		if (pending.chunks.filter(Boolean).length === (msg.total as number)) {
			pendingSegmentsById.delete(segmentId);
			const binary = pending.chunks.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
			const blob = new Blob(binary, { type: pending.mimeType });
			pending.resolve({ mimeType: pending.mimeType, blob, startTime: pending.startTime, endTime: pending.endTime, originMonitor: pending.originMonitor, segmentId: pending.segmentId });
		}
		return;
	}

	if (msg.type === 'segment-error-by-id') {
		const pending = pendingSegmentsById.get(segmentId);
		if (pending) pending.reject(msg.reason as string);
	}
}

export interface ViewerSessionInfo {
	monitorPubkey: string;
	sessionId: string;
	mode: 'live' | 'data';
	iceState: RTCIceConnectionState;
	dcState: RTCDataChannelState | null;
	trackCount: number;
}

export function getViewerSessionInfos(): ViewerSessionInfo[] {
	return Array.from(sessions.values()).map((s) => ({
		monitorPubkey: s.monitorPubkey,
		sessionId: s.sessionId,
		mode: s.mode,
		iceState: s.pc.iceConnectionState,
		dcState: s.dataChannel?.readyState ?? null,
		trackCount: s.pc.getReceivers().length,
	}));
}

export async function getViewerRTCStats(monitorPubkey: string): Promise<RTCStatsReport | null> {
	return sessions.get(monitorPubkey)?.pc.getStats() ?? null;
}

export function stopViewer(monitorPubkey?: string): void {
	if (monitorPubkey) {
		closeSession(monitorPubkey);
	} else {
		for (const pk of sessions.keys()) closeSession(pk);
		_viewerSignalSub?.close();
		_viewerSignalSub = null;
		dbg('info', 'rtc', 'viewer signal listener stopped');
	}
	_pendingAnswerContext = null;
	streamState.set('idle');
}
