import { subscribe, publish } from '$lib/nostr/client';
import { giftWrap, giftUnwrap } from '$lib/nostr/crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { KIND_SIGNAL_OFFER, KIND_SIGNAL_ANSWER, KIND_SIGNAL_ICE } from '$lib/nostr/events';
import { dbg } from '$lib/store/debug';
import type { NostrEvent } from 'nostr-tools';

export interface SignalMessage {
	type: string;
	sdp?: string;
	candidate?: string;
	sdpMid?: string | null;
	sdpMLineIndex?: number | null;
	sessionId: string;
}

type SignalHandler = (msg: SignalMessage, fromPubkey: string) => void;

// NIP-59 gift-wrap outer events have randomised created_at for privacy,
// so `since` relay filters don't work. Instead we check the inner rumor's
// honest timestamp and discard anything older than SIGNAL_TTL_S seconds.
const SIGNAL_TTL_S = 60;

export function listenForSignals(
	privkey: Uint8Array,
	pubkey: string,
	handler: SignalHandler
): { close: () => void } {
	return subscribe(
		{ kinds: [1059], '#p': [pubkey] },
		(event: NostrEvent) => {
			try {
				const inner = giftUnwrap(event, privkey);
				const age = Math.floor(Date.now() / 1000) - inner.created_at;
				if (age > SIGNAL_TTL_S) return; // stale relay replay — discard
				const msg: SignalMessage = JSON.parse(inner.content);
				dbg('in', 'rtc', `signal ${msg.type} sess:${msg.sessionId.slice(0, 8)} from:${inner.pubkey.slice(0, 8)}`, msg);
				handler(msg, inner.pubkey);
			} catch {
				// ignore undecryptable events (gift-wrapped for other recipients)
			}
		}
	);
}

export async function sendSignal(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	kind: number,
	msg: SignalMessage
): Promise<void> {
	dbg('out', 'rtc', `signal ${msg.type} sess:${msg.sessionId.slice(0, 8)} to:${toPubkey.slice(0, 8)}`, msg);
	const inner = finalizeEvent({
		kind,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', toPubkey]],
		content: JSON.stringify(msg)
	}, privkey);

	const wrapped = giftWrap(inner, privkey, toPubkey);
	await publish(wrapped);
}

export async function sendOffer(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sdp: string,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, KIND_SIGNAL_OFFER, {
		type: 'offer', sdp, sessionId
	});
}

export async function sendOfferRequest(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, KIND_SIGNAL_OFFER, {
		type: 'offer-request', sessionId
	});
}

export async function sendAnswer(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sdp: string,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, KIND_SIGNAL_ANSWER, {
		type: 'answer', sdp, sessionId
	});
}

export async function sendIce(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	candidate: RTCIceCandidate,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, KIND_SIGNAL_ICE, {
		type: 'ice',
		candidate: candidate.candidate,
		sdpMid: candidate.sdpMid,
		sdpMLineIndex: candidate.sdpMLineIndex,
		sessionId
	});
}

export async function sendHangup(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, KIND_SIGNAL_ICE, {
		type: 'hangup', sessionId
	});
}
