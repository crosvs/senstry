import { createPeer, onIceStateChange, waitForIceGathering } from './peer';
import { sendOffer, sendHangup } from './signaling';
import { getCoverageMap, getSegmentsInRange, getSegmentById, type SegmentWithBlob } from '$lib/db/segments';
import type { SignalMessage } from './signaling';

interface MonitorSession {
	pc: RTCPeerConnection;
	viewerPubkey: string;
	sessionId: string;
	dataChannel: RTCDataChannel | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	generation: number;
}

// One session per connected viewer, keyed by viewer pubkey.
const sessions = new Map<string, MonitorSession>();
let globalGeneration = 0;

// Stream provided when the monitor is armed. Set by the route before signals arrive.
let activeStream: MediaStream | null = null;
let idleTimeoutMs = 120_000;

export function setMonitorStream(stream: MediaStream | null): void {
	activeStream = stream;
}

export function setIdleTimeout(ms: number): void {
	idleTimeoutMs = ms;
}

function closeSession(viewerPubkey: string): void {
	const s = sessions.get(viewerPubkey);
	if (!s) return;
	if (s.idleTimer) clearTimeout(s.idleTimer);
	s.pc.close();
	sessions.delete(viewerPubkey);
}

function resetIdleTimer(
	privkey: Uint8Array,
	monitorPubkey: string,
	session: MonitorSession
): void {
	if (session.idleTimer) clearTimeout(session.idleTimer);
	session.idleTimer = setTimeout(async () => {
		await sendHangup(privkey, monitorPubkey, session.viewerPubkey, session.sessionId);
		closeSession(session.viewerPubkey);
	}, idleTimeoutMs);
}

export async function handleOfferRequest(
	privkey: Uint8Array,
	monitorPubkey: string,
	msg: SignalMessage,
	fromPubkey: string
): Promise<void> {
	// If an existing session for this viewer is still connected, don't replace it.
	const existing = sessions.get(fromPubkey);
	if (existing && existing.sessionId === msg.sessionId) return;

	closeSession(fromPubkey);
	const myGeneration = ++globalGeneration;

	const pc = createPeer();
	const session: MonitorSession = {
		pc,
		viewerPubkey: fromPubkey,
		sessionId: msg.sessionId,
		dataChannel: null,
		idleTimer: null,
		generation: myGeneration
	};
	sessions.set(fromPubkey, session);

	// Only add live stream tracks when the viewer explicitly requested live mode.
	// Data-mode connections (segment/coverage fetch) skip this to avoid
	// unintended live stream side-effects and unnecessary bandwidth.
	if (activeStream && msg.mode === 'live') {
		for (const track of activeStream.getTracks()) {
			pc.addTrack(track, activeStream);
		}
	}

	const dc = pc.createDataChannel('data');
	session.dataChannel = dc;
	dc.onmessage = (e) => {
		if (sessions.get(fromPubkey)?.generation !== myGeneration) return;
		resetIdleTimer(privkey, monitorPubkey, session);
		handleDataMessage(dc, e.data, monitorPubkey);
	};

	onIceStateChange(pc, (state) => {
		if (sessions.get(fromPubkey)?.generation !== myGeneration) return;
		if (state === 'failed' || state === 'closed') closeSession(fromPubkey);
	});

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	await waitForIceGathering(pc);
	try {
		await sendOffer(privkey, monitorPubkey, fromPubkey, pc.localDescription!.sdp!, msg.sessionId);
	} catch (e) {
		closeSession(fromPubkey);
		throw e;
	}

	resetIdleTimer(privkey, monitorPubkey, session);
}

export async function handleAnswer(
	msg: SignalMessage,
	fromPubkey: string
): Promise<void> {
	const session = sessions.get(fromPubkey);
	if (!session || session.sessionId !== msg.sessionId || !msg.sdp) return;
	await session.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
}

export function handleHangup(msg: SignalMessage, fromPubkey: string): void {
	const session = sessions.get(fromPubkey);
	if (session?.sessionId === msg.sessionId) closeSession(fromPubkey);
}

async function handleDataMessage(dc: RTCDataChannel, raw: string, originMonitor: string): Promise<void> {
	let req: { type: string } & Record<string, unknown>;
	try { req = JSON.parse(raw); } catch { return; }

	if (req.type === 'coverage-request') {
		const mimePrefix = req.mimePrefix as string | undefined;
		const segments = await getCoverageMap(originMonitor, mimePrefix);
		dc.send(JSON.stringify({ type: 'coverage-map', segments, mimePrefix: mimePrefix ?? null }));
		return;
	}

	if (req.type === 'segment-request') {
		const requestTime = req.time as number;
		const mimePrefix = req.mimePrefix as string | undefined;
		const candidates = await getSegmentsInRange(requestTime, requestTime, originMonitor);
		const meta = candidates.find((s) =>
			s.startTime <= requestTime && s.endTime > requestTime &&
			(mimePrefix == null || s.mimeType.startsWith(mimePrefix))
		);

		if (!meta) {
			dc.send(JSON.stringify({ type: 'segment-error', requestTime, reason: 'not-stored' }));
			return;
		}

		const segment = await getSegmentById(meta.segmentId);
		if (!segment) {
			dc.send(JSON.stringify({ type: 'segment-error', requestTime, reason: 'blob-missing' }));
			return;
		}

		await sendSegmentOverDc(dc, segment, { requestTime });
	}

	if (req.type === 'segment-request-by-id') {
		const id = req.segmentId as string;
		let segment = await getSegmentById(id);

		// Fallback: id may be a footage ref ID — scan its time range for segments.
		if (!segment) {
			const { getFootageRef } = await import('$lib/db/footage');
			const ref = await getFootageRef(id);
			if (ref) {
				const rangeSegs = await getSegmentsInRange(ref.startTime, ref.endTime, ref.originMonitor);
				for (const meta of rangeSegs) {
					const s = await getSegmentById(meta.segmentId);
					if (s) { segment = s; break; }
				}
			}
		}

		if (!segment) {
			dc.send(JSON.stringify({ type: 'segment-error-by-id', segmentId: id, reason: 'not-stored' }));
			return;
		}

		await sendSegmentOverDc(dc, segment, { segmentId: id });
	}
}

async function sendSegmentOverDc(
	dc: RTCDataChannel,
	segment: SegmentWithBlob,
	key: { requestTime: number } | { segmentId: string }
): Promise<void> {
	const CHUNK = 32 * 1024;
	const buf = await segment.blob.arrayBuffer();
	const bytes = new Uint8Array(buf);
	const total = Math.ceil(bytes.length / CHUNK) || 1;

	const byId = 'segmentId' in key;
	// Propagate the root monitor's ID through viewer chains (ViewerA re-serving to ViewerB)
	// so all downstream viewers deduplicate against the same canonical ID.
	const canonicalSegmentId = segment.backupOf ?? segment.segmentId;
	dc.send(JSON.stringify({
		type: byId ? 'segment-meta-by-id' : 'segment-meta',
		...key,
		segmentId: canonicalSegmentId,  // always included so viewer can set backupOf
		startTime: segment.startTime,
		endTime: segment.endTime,
		mimeType: segment.mimeType,
		sizeBytes: segment.sizeBytes,
		originMonitor: segment.originMonitor
	}));

	for (let i = 0; i < total; i++) {
		const slice = bytes.slice(i * CHUNK, (i + 1) * CHUNK);
		const b64 = btoa(String.fromCharCode(...slice));
		dc.send(JSON.stringify({
			type: byId ? 'segment-chunk-by-id' : 'segment-chunk',
			...key,
			startTime: segment.startTime,
			index: i,
			total,
			data: b64
		}));
	}
}

export function stopAllMonitorSessions(): void {
	for (const viewerPubkey of sessions.keys()) {
		closeSession(viewerPubkey);
	}
}

export interface MonitorSessionInfo {
	viewerPubkey: string;
	sessionId: string;
	iceState: RTCIceConnectionState;
	dcState: RTCDataChannelState | null;
	trackCount: number;
}

export function getMonitorSessionInfos(): MonitorSessionInfo[] {
	return Array.from(sessions.values()).map((s) => ({
		viewerPubkey: s.viewerPubkey,
		sessionId: s.sessionId,
		iceState: s.pc.iceConnectionState,
		dcState: s.dataChannel?.readyState ?? null,
		trackCount: s.pc.getSenders().length,
	}));
}

export async function getMonitorRTCStats(viewerPubkey: string): Promise<RTCStatsReport | null> {
	return sessions.get(viewerPubkey)?.pc.getStats() ?? null;
}
