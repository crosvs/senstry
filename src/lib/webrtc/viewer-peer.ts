import { createPeer, onTrack, onIceStateChange, waitForIceGathering } from './peer';
import { sendOfferRequest, sendAnswer } from './signaling';
import { streamState, remoteStream } from '$lib/store/stream';
import { dbg } from '$lib/store/debug';
import type { SignalMessage } from './signaling';
import type { ChannelConfig } from '$lib/store/pipeline';
import { randomUUID } from '$lib/utils';
import { computeHash, getDistinctChannels } from '$lib/db/segments';
import { viewerConnection } from '$lib/store/viewer-connection';

interface ViewerSession {
	pc: RTCPeerConnection;
	monitorPubkey: string;
	sessionId: string;
	controlChannel: RTCDataChannel | null;  // metadata + queries
	dataChannel: RTCDataChannel | null;     // segment chunk payloads
	mode: 'live' | 'data';
}

interface PendingSegment {
	mimeType: string;
	startTime: number;
	endTime: number;
	originMonitor: string;
	segmentId: string;
	channelId?: string;
	contentHash: string;
	chunks: string[];
	total: number;
	resolve: (r: { mimeType: string; blob: Blob; startTime: number; endTime: number; originMonitor: string; segmentId: string; channelId?: string }) => void;
	reject: (reason: string) => void;
}

// One session per target monitor, keyed by monitorPubkey.
const sessions = new Map<string, ViewerSession>();
const connectPromises = new Map<string, Promise<void>>();
const lastConnectAttempts = new Map<string, number>();

let generation = 0;
const MIN_CONNECT_INTERVAL_MS = 4_000;

export interface RemoteSegmentMeta {
	segmentId: string;
	startTime: number;
	endTime: number;
	mimeType: string;
	sizeBytes: number;
	contentHash: string;
}

let pendingCoverage: ((segments: [number, number][]) => void) | null = null;
let pendingChannelCoverage: ((channels: Record<string, [number, number][]>) => void) | null = null;
let pendingSourceList: ((ids: string[]) => void) | null = null;
let pendingChannelList: ((channels: ChannelConfig[]) => void) | null = null;
let pendingSegmentChannels: ((channels: string[]) => void) | null = null;
let coverageRejectTimer: ReturnType<typeof setTimeout> | null = null;
let channelCoverageRejectTimer: ReturnType<typeof setTimeout> | null = null;
let channelListTimer: ReturnType<typeof setTimeout> | null = null;
let segmentChannelsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSegmentsAfter: ((segs: RemoteSegmentMeta[]) => void) | null = null;
let pendingSegmentsBefore: ((segs: RemoteSegmentMeta[]) => void) | null = null;
let segmentsAfterTimer: ReturnType<typeof setTimeout> | null = null;
let segmentsBeforeTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSegments = new Map<number, PendingSegment>();
const pendingSegmentsById = new Map<string, PendingSegment>();
const channelListCache = new Map<string, ChannelConfig[]>();
// Abort functions for in-flight ensureConnection promises, keyed by monitorPubkey.
const connectAborts = new Map<string, () => void>();

function closeSession(monitorPubkey: string): void {
	generation++;
	const s = sessions.get(monitorPubkey);
	if (s) { s.pc.close(); sessions.delete(monitorPubkey); }
	connectPromises.delete(monitorPubkey);
	const abort = connectAborts.get(monitorPubkey);
	if (abort) { connectAborts.delete(monitorPubkey); abort(); }
	remoteStream.set(null);
	streamState.set('idle');
	viewerConnection.update(st =>
		st.monitorPubkey === monitorPubkey
			? { ...st, status: 'offline', mode: null, error: null }
			: st
	);
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

	if (session.sessionId !== msg.sessionId && msg.type === 'offer' && !session.controlChannel) {
		// A prior timed-out attempt can leave a stale session in the map.  An offer is
		// always sent in direct response to an offer-request from this viewer, so if the
		// session has no open data channel yet, accept it and adopt the incoming session ID.
		dbg('warn', 'rtc', `viewer: stale session id ${session.sessionId.slice(0, 8)} → adopting offer session ${msg.sessionId.slice(0, 8)} from ${fromPubkey.slice(0, 8)}`);
		session.sessionId = msg.sessionId;
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
				// Retry with backoff — public relays (e.g. damus.io) allow ~1 kind:1059 per 10s.
				// Each retry re-signs a fresh inner event so the monitor's TTL check still passes.
				const ANSWER_RETRY_DELAYS_MS = [8_000, 15_000];
				for (let attempt = 0; attempt <= ANSWER_RETRY_DELAYS_MS.length; attempt++) {
					try {
						await sendAnswer(privkey, viewerPubkey, fromPubkey, sdp, msg.sessionId);
						dbg('info', 'rtc', `viewer: answer sent to ${fromPubkey.slice(0, 8)}`);
						break;
					} catch (e) {
						const msg2 = e instanceof Error ? e.message : String(e);
						const delay = ANSWER_RETRY_DELAYS_MS[attempt];
						if (delay !== undefined && (msg2.includes('rate-limited') || msg2.includes('publish failed'))) {
							dbg('warn', 'rtc', `viewer: answer rate-limited, retrying in ${delay / 1000}s…`);
							await new Promise(r => setTimeout(r, delay));
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

async function ensureConnection(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mode: 'live' | 'data' = 'data',
	sourceId?: string,
	channelId?: string
): Promise<void> {
	const existing = sessions.get(monitorPubkey);
	// Reuse any open control channel. If upgrading to live, requestLiveView closes first.
	if (existing?.controlChannel?.readyState === 'open') return;

	const inFlight = connectPromises.get(monitorPubkey);
	if (inFlight) return inFlight;

	const now = Date.now();
	const last = lastConnectAttempts.get(monitorPubkey) ?? 0;
	if (now - last < MIN_CONNECT_INTERVAL_MS) throw new Error('reconnect cooldown — wait a moment');
	lastConnectAttempts.set(monitorPubkey, now);

	const myGeneration = ++generation;
	_pendingAnswerContext = { privkey, viewerPubkey };

	const promise = new Promise<void>((resolve, reject) => {
		let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
		let settled = false;

		// Called by closeSession to immediately reject this promise when the session is force-closed.
		connectAborts.set(monitorPubkey, () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (disconnectGraceTimer !== null) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
			connectPromises.delete(monitorPubkey);
			reject(new Error('session closed'));
		});

		const fail = (err: Error) => {
			if (generation !== myGeneration) return;
			if (settled) return;
			settled = true;
			if (disconnectGraceTimer !== null) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
			clearTimeout(timeout);
			connectPromises.delete(monitorPubkey);
			connectAborts.delete(monitorPubkey);
			streamState.set('failed');
			closeSession(monitorPubkey);
			reject(err);
		};

		const timeout = setTimeout(() => {
			fail(new Error('Connection timed out — check that the monitor has "Accept viewer connections" enabled'));
		}, 60_000);

		const sessionId = randomUUID();
		const pc = createPeer();
		sessions.set(monitorPubkey, { pc, monitorPubkey, sessionId, controlChannel: null, dataChannel: null, mode });
		streamState.set('connecting');

		pc.ondatachannel = (e) => {
			if (generation !== myGeneration) return;
			const s = sessions.get(monitorPubkey);
			if (!s) return;

			if (e.channel.label === 'control') {
				s.controlChannel = e.channel;
				e.channel.onmessage = (ev) => handleControlMessage(ev.data);
				const open = () => {
					if (generation !== myGeneration) return;
					if (settled) return;
					settled = true;
					if (disconnectGraceTimer !== null) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
					clearTimeout(timeout);
					connectPromises.delete(monitorPubkey);
					connectAborts.delete(monitorPubkey);
					resolve();
				};
				if (e.channel.readyState === 'open') open();
				else e.channel.onopen = open;
			} else if (e.channel.label === 'data') {
				s.dataChannel = e.channel;
				e.channel.onmessage = (ev) => handleDataChannel(ev.data);
			}
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
				if (!settled) {
					fail(new Error('ICE connection failed — NAT traversal may require a TURN server'));
				} else {
					// Post-connection drop — clean up local state without touching the relay.
					closeSession(monitorPubkey);
				}
			} else if (state === 'disconnected') {
				// 'disconnected' is transient on flaky networks; give it 8 s to recover before acting.
				if (disconnectGraceTimer === null) {
					disconnectGraceTimer = setTimeout(() => {
						if (!settled) fail(new Error('ICE disconnected'));
						else closeSession(monitorPubkey);
					}, 8_000);
				}
			} else if (state === 'connected' || state === 'completed') {
				if (disconnectGraceTimer !== null) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
			}
		});

		// Catch relay errors immediately rather than waiting out the full 30 s timeout.
		sendOfferRequest(privkey, viewerPubkey, monitorPubkey, sessionId, mode, sourceId, channelId)
			.catch((e) => fail(new Error(`Relay error: ${e instanceof Error ? e.message : 'publish failed'}`)));
	});

	connectPromises.set(monitorPubkey, promise);
	return promise;
}

export async function requestSegmentChannels(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<string[]> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');
	return new Promise<string[]>((resolve, reject) => {
		if (segmentChannelsTimer !== null) { clearTimeout(segmentChannelsTimer); segmentChannelsTimer = null; pendingSegmentChannels = null; }
		segmentChannelsTimer = setTimeout(() => {
			segmentChannelsTimer = null; pendingSegmentChannels = null;
			reject(new Error('segment-channels timeout'));
		}, 5_000);
		pendingSegmentChannels = (channels) => {
			if (segmentChannelsTimer !== null) { clearTimeout(segmentChannelsTimer); segmentChannelsTimer = null; }
			resolve(channels);
		};
		session.controlChannel!.send(JSON.stringify({ type: 'segment-channels-request' }));
	});
}

export async function loadLocalChannels(monitorPubkey: string): Promise<void> {
	const ids = await getDistinctChannels(monitorPubkey);
	const localChannels: ChannelConfig[] = ids.map(id => ({
		id, name: '', videoSourceId: null, audioSourceId: null,
	}));
	viewerConnection.update(s => {
		if (s.monitorPubkey !== monitorPubkey) return s;
		const remoteIds = new Set(s.channels.map(c => c.id));
		const merged = [...s.channels, ...localChannels.filter(c => !remoteIds.has(c.id))];
		const firstId = merged[0]?.id ?? '';
		return {
			...s,
			channels: merged,
			channelId: merged.some(c => c.id === s.channelId) ? s.channelId : firstId,
		};
	});
}

export async function connectToMonitor(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<void> {
	const existing = sessions.get(monitorPubkey);
	if (existing?.controlChannel?.readyState === 'open') {
		viewerConnection.update(s => ({ ...s, status: 'online', mode: 'data', error: null }));
		return;
	}
	lastConnectAttempts.delete(monitorPubkey);
	viewerConnection.update(s => ({
		...s, monitorPubkey, status: 'connecting', mode: 'data', error: null,
	}));
	try {
		await ensureConnection(privkey, viewerPubkey, monitorPubkey, 'data');
		channelListCache.delete(monitorPubkey);
		const remoteChannels = await _fetchChannelList(monitorPubkey);
		viewerConnection.update(s => {
			if (s.monitorPubkey !== monitorPubkey) return s;
			const remoteIds = new Set(remoteChannels.map(c => c.id));
			const merged = [
				...remoteChannels,
				...s.channels.filter(c => !remoteIds.has(c.id)),
			];
			const channelId = merged.some(c => c.id === s.channelId)
				? s.channelId
				: (merged[0]?.id ?? '');
			return { ...s, status: 'online', mode: 'data', channels: merged, channelId, error: null };
		});
	} catch (e) {
		viewerConnection.update(s =>
			s.monitorPubkey === monitorPubkey
				? { ...s, status: 'failed', error: e instanceof Error ? e.message : 'Connection failed' }
				: s
		);
		throw e;
	}
}

export async function startLiveView(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	channelId: string
): Promise<void> {
	closeSession(monitorPubkey);
	lastConnectAttempts.delete(monitorPubkey);
	viewerConnection.update(s => ({
		...s, monitorPubkey, status: 'connecting', mode: 'live', error: null,
	}));
	try {
		await ensureConnection(privkey, viewerPubkey, monitorPubkey, 'live', undefined, channelId);
		viewerConnection.update(s =>
			s.monitorPubkey === monitorPubkey
				? { ...s, status: 'online', mode: 'live', error: null }
				: s
		);
	} catch (e) {
		viewerConnection.update(s =>
			s.monitorPubkey === monitorPubkey
				? { ...s, status: 'failed', error: e instanceof Error ? e.message : 'Live connection failed' }
				: s
		);
		throw e;
	}
}

export function cancelConnect(monitorPubkey: string): void {
	const abort = connectAborts.get(monitorPubkey);
	if (abort) { connectAborts.delete(monitorPubkey); abort(); }
	closeSession(monitorPubkey);
}

export async function requestSourceList(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<string[]> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

	return new Promise<string[]>((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSourceList = null;
			reject(new Error('source-list timeout'));
		}, 5_000);
		pendingSourceList = (ids) => {
			clearTimeout(timer);
			resolve(ids);
		};
		session.controlChannel!.send(JSON.stringify({ type: 'source-list-request' }));
	});
}

export async function requestCoverageMap(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mimePrefix?: string
): Promise<[number, number][]> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

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
		session.controlChannel!.send(JSON.stringify(msg));
	});
}

export async function requestChannelCoverage(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mimePrefix?: string
): Promise<Record<string, [number, number][]>> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

	if (channelCoverageRejectTimer !== null) { clearTimeout(channelCoverageRejectTimer); channelCoverageRejectTimer = null; pendingChannelCoverage = null; }

	return new Promise<Record<string, [number, number][]>>((resolve, reject) => {
		channelCoverageRejectTimer = setTimeout(() => {
			channelCoverageRejectTimer = null; pendingChannelCoverage = null;
			reject(new Error('channel coverage timeout'));
		}, 10_000);
		pendingChannelCoverage = (channels) => {
			if (channelCoverageRejectTimer !== null) { clearTimeout(channelCoverageRejectTimer); channelCoverageRejectTimer = null; }
			resolve(channels);
		};
		const msg: Record<string, unknown> = { type: 'coverage-channels-request' };
		if (mimePrefix) msg.mimePrefix = mimePrefix;
		session.controlChannel!.send(JSON.stringify(msg));
	});
}

export async function requestSegment(
	time: number,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string,
	mimePrefix?: string
): Promise<{ mimeType: string; blob: Blob; startTime: number; endTime: number; originMonitor: string; segmentId: string; channelId?: string }> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSegments.delete(time);
			reject(new Error('segment timeout'));
		}, 30_000);
		pendingSegments.set(time, {
			mimeType: '', startTime: 0, endTime: 0, originMonitor: '', segmentId: '', contentHash: '',
			chunks: [], total: 0,
			resolve: (r) => { clearTimeout(timer); resolve(r); },
			reject: (reason) => { clearTimeout(timer); pendingSegments.delete(time); reject(new Error(reason)); }
		});
		const msg: Record<string, unknown> = { type: 'segment-request', time };
		if (mimePrefix) msg.mimePrefix = mimePrefix;
		session.controlChannel!.send(JSON.stringify(msg));
	});
}

export async function requestSegmentById(
	segmentId: string,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<{ mimeType: string; blob: Blob; startTime: number; endTime: number; originMonitor: string; segmentId: string; channelId?: string }> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSegmentsById.delete(segmentId);
			reject(new Error('segment timeout'));
		}, 30_000);
		pendingSegmentsById.set(segmentId, {
			mimeType: '', startTime: 0, endTime: 0, originMonitor: '', segmentId: '', contentHash: '',
			chunks: [], total: 0,
			resolve: (r) => { clearTimeout(timer); resolve(r); },
			reject: (reason) => { clearTimeout(timer); pendingSegmentsById.delete(segmentId); reject(new Error(reason)); }
		});
		session.controlChannel!.send(JSON.stringify({ type: 'segment-request-by-id', segmentId }));
	});
}

export async function requestSegmentsAfter(
	after: number,
	count: number,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<RemoteSegmentMeta[]> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

	return new Promise<RemoteSegmentMeta[]>((resolve, reject) => {
		if (segmentsAfterTimer !== null) { clearTimeout(segmentsAfterTimer); segmentsAfterTimer = null; pendingSegmentsAfter = null; }
		segmentsAfterTimer = setTimeout(() => {
			segmentsAfterTimer = null; pendingSegmentsAfter = null;
			reject(new Error('segments-after timeout'));
		}, 10_000);
		pendingSegmentsAfter = (segs) => {
			if (segmentsAfterTimer !== null) { clearTimeout(segmentsAfterTimer); segmentsAfterTimer = null; }
			resolve(segs);
		};
		session.controlChannel!.send(JSON.stringify({ type: 'segments-after-request', after, count }));
	});
}

export async function requestSegmentsBefore(
	before: number,
	count: number,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<RemoteSegmentMeta[]> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') throw new Error('offline');

	return new Promise<RemoteSegmentMeta[]>((resolve, reject) => {
		if (segmentsBeforeTimer !== null) { clearTimeout(segmentsBeforeTimer); segmentsBeforeTimer = null; pendingSegmentsBefore = null; }
		segmentsBeforeTimer = setTimeout(() => {
			segmentsBeforeTimer = null; pendingSegmentsBefore = null;
			reject(new Error('segments-before timeout'));
		}, 10_000);
		pendingSegmentsBefore = (segs) => {
			if (segmentsBeforeTimer !== null) { clearTimeout(segmentsBeforeTimer); segmentsBeforeTimer = null; }
			resolve(segs);
		};
		session.controlChannel!.send(JSON.stringify({ type: 'segments-before-request', before, count }));
	});
}

function _fetchChannelList(monitorPubkey: string): Promise<ChannelConfig[]> {
	const session = sessions.get(monitorPubkey);
	if (!session?.controlChannel || session.controlChannel.readyState !== 'open') {
		return Promise.reject(new Error('offline'));
	}
	return new Promise<ChannelConfig[]>((resolve, reject) => {
		if (channelListTimer !== null) {
			clearTimeout(channelListTimer); channelListTimer = null; pendingChannelList = null;
		}
		channelListTimer = setTimeout(() => {
			channelListTimer = null; pendingChannelList = null;
			reject(new Error('channel-list timeout'));
		}, 5_000);
		pendingChannelList = (channels) => {
			if (channelListTimer !== null) { clearTimeout(channelListTimer); channelListTimer = null; }
			channelListCache.set(monitorPubkey, channels);
			resolve(channels);
		};
		session.controlChannel!.send(JSON.stringify({ type: 'channel-list-request' }));
	});
}

// Handles messages from the 'control' channel (metadata, queries, errors, segment-meta).
function handleControlMessage(raw: string): void {
	let msg: { type: string } & Record<string, unknown>;
	try { msg = JSON.parse(raw); } catch { return; }

	if (msg.type === 'source-list') {
		const cb = pendingSourceList; pendingSourceList = null;
		cb?.(msg.sourceIds as string[]);
		return;
	}

	if (msg.type === 'channel-list') {
		const cb = pendingChannelList; pendingChannelList = null;
		cb?.(msg.channels as ChannelConfig[]);
		return;
	}

	if (msg.type === 'segment-channels') {
		const cb = pendingSegmentChannels; pendingSegmentChannels = null;
		cb?.(msg.channels as string[]);
		return;
	}

	if (msg.type === 'coverage-map') {
		const cb = pendingCoverage; pendingCoverage = null;
		cb?.(msg.segments as [number, number][]);
		return;
	}

	if (msg.type === 'coverage-channels') {
		const cb = pendingChannelCoverage; pendingChannelCoverage = null;
		cb?.(msg.channels as Record<string, [number, number][]>);
		return;
	}

	if (msg.type === 'segments-after') {
		const cb = pendingSegmentsAfter; pendingSegmentsAfter = null;
		cb?.(msg.segments as RemoteSegmentMeta[]);
		return;
	}

	if (msg.type === 'segments-before') {
		const cb = pendingSegmentsBefore; pendingSegmentsBefore = null;
		cb?.(msg.segments as RemoteSegmentMeta[]);
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
			pending.channelId = msg.channelId as string | undefined;
			pending.contentHash = (msg.contentHash as string) ?? '';
			pending.total = Math.ceil((msg.sizeBytes as number) / (32 * 1024)) || 1;
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
			// a footage-ref ID to its canonical segment ID.
			pending.segmentId = (msg.segmentId as string) || segmentId;
			pending.channelId = msg.channelId as string | undefined;
			pending.contentHash = (msg.contentHash as string) ?? '';
			pending.total = Math.ceil((msg.sizeBytes as number) / (32 * 1024)) || 1;
		}
		return;
	}

	if (msg.type === 'segment-error-by-id') {
		const pending = pendingSegmentsById.get(segmentId);
		if (pending) pending.reject(msg.reason as string);
	}
}

// Handles messages from the 'data' channel (chunk payloads only).
async function handleDataChannel(raw: string): Promise<void> {
	let msg: { type: string } & Record<string, unknown>;
	try { msg = JSON.parse(raw); } catch { return; }

	const requestTime = msg.requestTime as number;

	if (msg.type === 'segment-chunk') {
		const pending = pendingSegments.get(requestTime);
		if (!pending) return;
		pending.chunks[msg.index as number] = msg.data as string;
		if (pending.chunks.filter(Boolean).length === (msg.total as number)) {
			pendingSegments.delete(requestTime);
			const binary = pending.chunks.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
			const blob = new Blob(binary, { type: pending.mimeType });
			if (pending.contentHash) {
				const actual = await computeHash(blob);
				if (actual !== pending.contentHash) {
					dbg('warn', 'rtc', `segment hash mismatch at t=${requestTime}: expected ${pending.contentHash.slice(0, 8)}, got ${actual.slice(0, 8)}`);
					pending.reject('hash-mismatch');
					return;
				}
			}
			pending.resolve({ mimeType: pending.mimeType, blob, startTime: pending.startTime, endTime: pending.endTime, originMonitor: pending.originMonitor, segmentId: pending.segmentId, channelId: pending.channelId });
		}
		return;
	}

	const segmentId = msg.segmentId as string;

	if (msg.type === 'segment-chunk-by-id') {
		const pending = pendingSegmentsById.get(segmentId);
		if (!pending) return;
		pending.chunks[msg.index as number] = msg.data as string;
		if (pending.chunks.filter(Boolean).length === (msg.total as number)) {
			pendingSegmentsById.delete(segmentId);
			const binary = pending.chunks.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
			const blob = new Blob(binary, { type: pending.mimeType });
			if (pending.contentHash) {
				const actual = await computeHash(blob);
				if (actual !== pending.contentHash) {
					dbg('warn', 'rtc', `segment hash mismatch for id=${segmentId.slice(0, 8)}: expected ${pending.contentHash.slice(0, 8)}, got ${actual.slice(0, 8)}`);
					pending.reject('hash-mismatch');
					return;
				}
			}
			pending.resolve({ mimeType: pending.mimeType, blob, startTime: pending.startTime, endTime: pending.endTime, originMonitor: pending.originMonitor, segmentId: pending.segmentId, channelId: pending.channelId });
		}
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
		dcState: s.controlChannel?.readyState ?? null,
		trackCount: s.pc.getReceivers().length,
	}));
}

export async function getViewerRTCStats(monitorPubkey: string): Promise<RTCStatsReport | null> {
	return sessions.get(monitorPubkey)?.pc.getStats() ?? null;
}

export function disconnectViewer(monitorPubkey?: string): void {
	if (monitorPubkey) {
		closeSession(monitorPubkey);
	} else {
		for (const pk of sessions.keys()) closeSession(pk);
	}
	_pendingAnswerContext = null;
	streamState.set('idle');
}

export function stopViewer(monitorPubkey?: string): void {
	disconnectViewer(monitorPubkey);
}
