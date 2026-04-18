import { createPeer, onTrack, onIceStateChange, waitForIceGathering } from './peer';
import { listenForSignals, sendOfferRequest, sendAnswer } from './signaling';
import { streamState, remoteStream } from '$lib/store/stream';

interface Session {
	pc: RTCPeerConnection;
	monitorPubkey: string;
	sessionId: string;
	dataChannel: RTCDataChannel | null;
}

interface PendingSegment {
	mimeType: string;
	startTime: number;
	endTime: number;
	chunks: string[];
	total: number;
	resolve: (r: { mimeType: string; blob: Blob; startTime: number; endTime: number }) => void;
	reject: (reason: string) => void;
}

let session: Session | null = null;
let signalSub: { close: () => void } | null = null;
let connectPromise: Promise<void> | null = null;

// Incremented on every closeSession() so stale callbacks from old PCs are ignored.
let generation = 0;

// Prevent rapid-fire reconnection storms that get the relay to rate-limit us.
let lastConnectAttemptAt = 0;
const MIN_CONNECT_INTERVAL_MS = 4_000;

let pendingCoverage: ((segments: [number, number][]) => void) | null = null;
let coverageRejectTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSegments = new Map<number, PendingSegment>();

function closeSession(): void {
	generation++;
	session?.pc.close();
	session = null;
	connectPromise = null;
	remoteStream.set(null);
}

export async function ensureConnection(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<void> {
	if (session?.dataChannel?.readyState === 'open' && session.monitorPubkey === monitorPubkey) return;
	if (connectPromise) return connectPromise;

	const now = Date.now();
	if (now - lastConnectAttemptAt < MIN_CONNECT_INTERVAL_MS) {
		throw new Error('reconnect cooldown — wait a moment');
	}
	lastConnectAttemptAt = now;

	const myGeneration = ++generation;

	connectPromise = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (generation !== myGeneration) return;
			connectPromise = null;
			reject(new Error('Connection timed out'));
		}, 30_000);

		const sessionId = crypto.randomUUID();

		signalSub?.close();
		signalSub = listenForSignals(privkey, viewerPubkey, async (msg, _fromPubkey) => {
			if (!session || msg.sessionId !== sessionId || generation !== myGeneration) return;

			if (msg.type === 'offer' && msg.sdp) {
				await session.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
				const answer = await session.pc.createAnswer();
				await session.pc.setLocalDescription(answer);
				await waitForIceGathering(session.pc); // embed all candidates — no trickle ICE
				await sendAnswer(privkey, viewerPubkey, monitorPubkey, session.pc.localDescription!.sdp!, sessionId);
			} else if (msg.type === 'hangup') {
				if (generation === myGeneration) closeSession();
			}
		});

		const pc = createPeer();

		pc.ondatachannel = (e) => {
			if (generation !== myGeneration) return;
			session!.dataChannel = e.channel;
			e.channel.onmessage = (ev) => handleDataMessage(ev.data);
			const open = () => {
				if (generation !== myGeneration) return;
				clearTimeout(timeout);
				connectPromise = null;
				resolve();
			};
			if (e.channel.readyState === 'open') {
				open();
			} else {
				e.channel.onopen = open;
			}
		};

		onTrack(pc, (stream) => {
			if (generation !== myGeneration) return;
			remoteStream.set(stream);
			streamState.set('connected');
		});

		onIceStateChange(pc, (state) => {
			if (generation !== myGeneration) return;
			if (state === 'failed' || state === 'closed') {
				clearTimeout(timeout);
				connectPromise = null;
				streamState.set('failed');
				reject(new Error('ICE failed'));
				closeSession();
			}
		});

		session = { pc, monitorPubkey, sessionId, dataChannel: null };
		streamState.set('connecting');
		sendOfferRequest(privkey, viewerPubkey, monitorPubkey, sessionId);
	});

	return connectPromise;
}

// Force-close the current session and reconnect. Use for explicit user retry only.
export async function requestLiveView(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<void> {
	closeSession();
	lastConnectAttemptAt = 0; // bypass cooldown for explicit user-initiated reconnect
	return ensureConnection(privkey, viewerPubkey, monitorPubkey);
}

export async function requestCoverageMap(
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<[number, number][]> {
	try {
		await ensureConnection(privkey, viewerPubkey, monitorPubkey);
	} catch {
		throw new Error('offline');
	}
	if (!session?.dataChannel) throw new Error('offline');

	// Cancel any previous pending coverage request
	if (coverageRejectTimer !== null) {
		clearTimeout(coverageRejectTimer);
		coverageRejectTimer = null;
		pendingCoverage = null;
	}

	return new Promise<[number, number][]>((resolve, reject) => {
		coverageRejectTimer = setTimeout(() => {
			coverageRejectTimer = null;
			pendingCoverage = null;
			reject(new Error('coverage timeout'));
		}, 10_000);

		pendingCoverage = (segments) => {
			if (coverageRejectTimer !== null) { clearTimeout(coverageRejectTimer); coverageRejectTimer = null; }
			resolve(segments);
		};
		session!.dataChannel!.send(JSON.stringify({ type: 'coverage-request' }));
	});
}

// Request the segment containing `time`. Returns blob + actual segment boundaries.
export async function requestSegment(
	time: number,
	privkey: Uint8Array,
	viewerPubkey: string,
	monitorPubkey: string
): Promise<{ mimeType: string; blob: Blob; startTime: number; endTime: number }> {
	try {
		await ensureConnection(privkey, viewerPubkey, monitorPubkey);
	} catch {
		throw new Error('offline');
	}
	if (!session?.dataChannel) throw new Error('offline');

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingSegments.delete(time);
			reject(new Error('segment timeout'));
		}, 30_000);

		pendingSegments.set(time, {
			mimeType: '',
			startTime: 0,
			endTime: 0,
			chunks: [],
			total: 0,
			resolve: (r) => { clearTimeout(timer); resolve(r); },
			reject: (reason) => { clearTimeout(timer); pendingSegments.delete(time); reject(new Error(reason)); }
		});
		session!.dataChannel!.send(JSON.stringify({ type: 'segment-request', time }));
	});
}

function handleDataMessage(raw: string): void {
	let msg: { type: string } & Record<string, unknown>;
	try { msg = JSON.parse(raw); } catch { return; }

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
			const binary = pending.chunks.map((b64) =>
				Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
			);
			const blob = new Blob(binary, { type: pending.mimeType });
			pending.resolve({
				mimeType: pending.mimeType,
				blob,
				startTime: pending.startTime,
				endTime: pending.endTime
			});
		}
		return;
	}

	if (msg.type === 'segment-error') {
		const pending = pendingSegments.get(requestTime);
		if (pending) pending.reject(msg.reason as string);
	}
}

export interface ViewerSessionInfo {
	sessionId: string | null;
	monitorPubkey: string | null;
	iceState: RTCIceConnectionState | null;
	dcState: RTCDataChannelState | null;
	trackCount: number;
}

export function getViewerSessionInfo(): ViewerSessionInfo {
	return {
		sessionId: session?.sessionId ?? null,
		monitorPubkey: session?.monitorPubkey ?? null,
		iceState: session?.pc?.iceConnectionState ?? null,
		dcState: session?.dataChannel?.readyState ?? null,
		trackCount: session?.pc
			? session.pc.getReceivers().length
			: 0
	};
}

export async function getViewerRTCStats(): Promise<RTCStatsReport | null> {
	if (!session?.pc) return null;
	return session.pc.getStats();
}

export function stopViewer(): void {
	signalSub?.close();
	signalSub = null;
	closeSession();
	streamState.set('idle');
}
