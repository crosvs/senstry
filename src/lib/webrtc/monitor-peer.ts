import { createPeer, onIceStateChange, waitForIceGathering } from './peer';
import { listenForSignals, sendOffer, sendAnswer } from './signaling';
import { getCoverageMap, getSegmentsInRange } from '$lib/db/segments';
import { streamState } from '$lib/store/stream';
import { subscribe } from '$lib/nostr/client';
import { decrypt } from '$lib/nostr/crypto';
import { addPairedDevice } from '$lib/store/identity';
import { KIND_PAIR_ACK } from '$lib/nostr/events';
import type { NostrEvent } from 'nostr-tools';

interface Session {
	pc: RTCPeerConnection;
	viewerPubkey: string;
	sessionId: string;
	dataChannel: RTCDataChannel | null;
}

let session: Session | null = null;
let signalSub: { close: () => void } | null = null;
let pairSub: { close: () => void } | null = null;

// Incremented on every closeSession() so stale ICE/data callbacks from old PCs are ignored.
let generation = 0;

function closeSession(): void {
	generation++;
	session?.pc.close();
	session = null;
}

export function startMonitorSignaling(
	privkey: Uint8Array,
	monitorPubkey: string,
	stream: MediaStream
): void {
	signalSub?.close();
	startPairListener(privkey, monitorPubkey);
	signalSub = listenForSignals(privkey, monitorPubkey, async (msg, fromPubkey) => {
		if (msg.type === 'offer-request') {
			// Ignore if we already have an active session for this sessionId
			if (session?.sessionId === msg.sessionId) return;
			await handleOfferRequest(privkey, monitorPubkey, fromPubkey, msg.sessionId, stream);
		} else if (session && msg.sessionId === session.sessionId) {
			if (msg.type === 'answer' && msg.sdp) {
				await session.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
			} else if (msg.type === 'hangup') {
				closeSession();
			}
		}
	});
}

async function handleOfferRequest(
	privkey: Uint8Array,
	monitorPubkey: string,
	viewerPubkey: string,
	sessionId: string,
	stream: MediaStream
): Promise<void> {
	closeSession();
	const myGeneration = generation; // snapshot after closeSession incremented it
	const pc = createPeer();
	session = { pc, viewerPubkey, sessionId, dataChannel: null };
	streamState.set('connecting');

	for (const track of stream.getTracks()) {
		pc.addTrack(track, stream);
	}

	const dc = pc.createDataChannel('data');
	session.dataChannel = dc;
	dc.onmessage = (e) => {
		if (generation !== myGeneration) return;
		handleDataMessage(dc, e.data);
	};

	onIceStateChange(pc, (state) => {
		if (generation !== myGeneration) return;
		if (state === 'connected') streamState.set('connected');
		if (state === 'failed' || state === 'closed') {
			streamState.set('failed');
			closeSession();
		}
	});

	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	await waitForIceGathering(pc); // embed all candidates in SDP — no trickle ICE events
	await sendOffer(privkey, monitorPubkey, viewerPubkey, pc.localDescription!.sdp!, sessionId);
}

async function handleDataMessage(dc: RTCDataChannel, raw: string): Promise<void> {
	let req: { type: string } & Record<string, unknown>;
	try { req = JSON.parse(raw); } catch { return; }

	if (req.type === 'coverage-request') {
		const segments = await getCoverageMap();
		dc.send(JSON.stringify({ type: 'coverage-map', segments }));
		return;
	}

	if (req.type === 'segment-request') {
		const requestTime = req.time as number;
		const candidates = await getSegmentsInRange(requestTime, requestTime);
		const segment = candidates.find((s) => s.startTime <= requestTime && s.endTime > requestTime);

		if (!segment) {
			dc.send(JSON.stringify({ type: 'segment-error', requestTime, reason: 'not-stored' }));
			return;
		}

		const CHUNK = 32 * 1024;
		const buf = await segment.blob.arrayBuffer();
		const bytes = new Uint8Array(buf);
		const total = Math.ceil(bytes.length / CHUNK) || 1;

		dc.send(JSON.stringify({
			type: 'segment-meta',
			requestTime,
			startTime: segment.startTime,
			endTime: segment.endTime,
			mimeType: segment.mimeType,
			sizeBytes: segment.sizeBytes
		}));

		for (let i = 0; i < total; i++) {
			const slice = bytes.slice(i * CHUNK, (i + 1) * CHUNK);
			const b64 = btoa(String.fromCharCode(...slice));
			dc.send(JSON.stringify({
				type: 'segment-chunk',
				requestTime,
				startTime: segment.startTime,
				index: i,
				total,
				data: b64
			}));
		}
	}
}

export interface MonitorSessionInfo {
	sessionId: string | null;
	viewerPubkey: string | null;
	iceState: RTCIceConnectionState | null;
	dcState: RTCDataChannelState | null;
	trackCount: number;
}

export function getMonitorSessionInfo(): MonitorSessionInfo {
	return {
		sessionId: session?.sessionId ?? null,
		viewerPubkey: session?.viewerPubkey ?? null,
		iceState: session?.pc?.iceConnectionState ?? null,
		dcState: session?.dataChannel?.readyState ?? null,
		trackCount: session?.pc
			? session.pc.getSenders().filter((s) => s.track).length
			: 0
	};
}

export async function getMonitorRTCStats(): Promise<RTCStatsReport | null> {
	if (!session?.pc) return null;
	return session.pc.getStats();
}

export function startPairListener(privkey: Uint8Array, monitorPubkey: string): void {
	pairSub?.close();
	pairSub = subscribe(
		{ kinds: [KIND_PAIR_ACK], '#p': [monitorPubkey] },
		async (event: NostrEvent) => {
			try {
				const payload = JSON.parse(decrypt(privkey, event.pubkey, event.content)) as {
					type: string; senderPubkey: string; label: string; timestamp: number
				};
				if (payload.type !== 'pair-ack') return;
				await addPairedDevice({ pubkey: payload.senderPubkey, label: payload.label, addedAt: Date.now() });
			} catch {
				// ignore undecryptable events (not meant for this monitor)
			}
		}
	);
}

export function stopPairListener(): void {
	pairSub?.close();
	pairSub = null;
}

export function stopMonitorSignaling(): void {
	signalSub?.close();
	signalSub = null;
	stopPairListener();
	closeSession();
	streamState.set('idle');
}
