import { createPeer, onIceStateChange, waitForIceGathering } from './peer';
import { sendOffer, sendHangup } from './signaling';
import { getCoverageMap, getSegmentsInRange, getSegmentById, getSegmentsAfter, getSegmentsBefore, type SegmentWithBlob } from '$lib/db/segments';
import type { SignalMessage } from './signaling';
import type { ChannelConfig } from '$lib/store/pipeline';

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

// Streams provided when the monitor is armed — one per open source, keyed by sourceId.
const activeStreams = new Map<string, MediaStream>();
// Channel configs — keyed by channelId.
const activeChannels = new Map<string, ChannelConfig>();
// Active source overrides per channel — pushed by SentrySection when RecordActions change state.
// Takes priority over the channel's default videoSourceId/audioSourceId.
const channelActiveSources = new Map<string, { videoSourceId?: string | null; audioSourceId?: string | null }>();
let idleTimeoutMs = 120_000;

// Pass all open source streams so any source can be served to viewers.
export function setMonitorStreams(streams: Map<string, MediaStream>): void {
	activeStreams.clear();
	for (const [id, stream] of streams) activeStreams.set(id, stream);
}

// Register channel configs so viewers can request video+audio from named channels.
export function setMonitorChannels(channels: ChannelConfig[]): void {
	activeChannels.clear();
	for (const ch of channels) activeChannels.set(ch.id, ch);
}

// Push which sources are actively recording per channel.
// Called by SentrySection when RecordAction states change.
// Overrides the channel's default videoSourceId/audioSourceId for live RTC.
export function setChannelActiveSources(
	overrides: Map<string, { videoSourceId?: string | null; audioSourceId?: string | null }>
): void {
	channelActiveSources.clear();
	for (const [k, v] of overrides) channelActiveSources.set(k, v);
}

// Compat shim — used by stopMonitor to clear, and for single-stream callers.
export function setMonitorStream(stream: MediaStream | null): void {
	activeStreams.clear();
	if (stream) activeStreams.set('default', stream);
}

export function getAvailableMonitorSourceIds(): string[] {
	return Array.from(activeStreams.keys());
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
	if (activeStreams.size > 0 && msg.mode === 'live') {
		const requestedChannel = msg.channelId as string | undefined;
		const requestedSource  = msg.sourceId  as string | undefined;
		// Combine selected tracks into a single composite MediaStream.
		// Using separate per-source streams causes the viewer's ontrack events to fire
		// once per source, each overwriting remoteStream — last one wins, dropping prior tracks.
		const composite = new MediaStream();
		if (requestedChannel && activeChannels.has(requestedChannel)) {
			// Channel-based compositing.
			// Active RecordAction sources (pushed by SentrySection) take priority over
			// the channel's default videoSourceId/audioSourceId fallbacks.
			const ch = activeChannels.get(requestedChannel)!;
			const override = channelActiveSources.get(requestedChannel);
			const videoSrcId = override?.videoSourceId !== undefined ? override.videoSourceId : ch.videoSourceId;
			const audioSrcId = override?.audioSourceId !== undefined ? override.audioSourceId : ch.audioSourceId;
			if (videoSrcId) {
				const vStream = activeStreams.get(videoSrcId);
				if (vStream) for (const t of vStream.getVideoTracks()) composite.addTrack(t);
			}
			if (audioSrcId) {
				const aStream = activeStreams.get(audioSrcId);
				if (aStream) for (const t of aStream.getAudioTracks()) composite.addTrack(t);
			}
		} else if (requestedSource && activeStreams.has(requestedSource)) {
			// Legacy sourceId path — all tracks from one source.
			for (const t of activeStreams.get(requestedSource)!.getTracks()) composite.addTrack(t);
		} else {
			// No filter — composite all open sources.
			for (const stream of activeStreams.values()) {
				for (const t of stream.getTracks()) composite.addTrack(t);
			}
		}
		for (const track of composite.getTracks()) pc.addTrack(track, composite);
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

	if (req.type === 'source-list-request') {
		dc.send(JSON.stringify({ type: 'source-list', sourceIds: Array.from(activeStreams.keys()) }));
		return;
	}

	if (req.type === 'coverage-request') {
		const mimePrefix = req.mimePrefix as string | undefined;
		const segments = await getCoverageMap(originMonitor, mimePrefix);
		dc.send(JSON.stringify({ type: 'coverage-map', segments, mimePrefix: mimePrefix ?? null }));
		return;
	}

	if (req.type === 'segments-after-request') {
		const after = req.after as number;
		const count = Math.min((req.count as number | undefined) ?? 5, 20);
		const segs = await getSegmentsAfter(after, count, originMonitor);
		dc.send(JSON.stringify({
			type: 'segments-after',
			after,
			segments: segs.map(s => ({
				segmentId: s.backupOf ?? s.segmentId,
				startTime: s.startTime,
				endTime: s.endTime,
				mimeType: s.mimeType,
				sizeBytes: s.sizeBytes,
				contentHash: (s as { contentHash?: string }).contentHash ?? '',
			})),
		}));
		return;
	}

	if (req.type === 'segments-before-request') {
		const before = req.before as number;
		const count = Math.min((req.count as number | undefined) ?? 5, 20);
		const segs = await getSegmentsBefore(before, count, originMonitor);
		dc.send(JSON.stringify({
			type: 'segments-before',
			before,
			segments: segs.map(s => ({
				segmentId: s.backupOf ?? s.segmentId,
				startTime: s.startTime,
				endTime: s.endTime,
				mimeType: s.mimeType,
				sizeBytes: s.sizeBytes,
				contentHash: (s as { contentHash?: string }).contentHash ?? '',
			})),
		}));
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
		originMonitor: segment.originMonitor,
		contentHash: (segment as { contentHash?: string }).contentHash ?? '',
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
