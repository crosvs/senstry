import { subscribe, publish } from '$lib/nostr/client';
import { giftWrap, giftUnwrap } from '$lib/nostr/crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { KIND_SIGNAL } from '$lib/nostr/events';
import { dbg } from '$lib/store/debug';
import type { NostrEvent } from 'nostr-tools';

export interface SignalMessage {
	type: 'offer-request' | 'offer' | 'answer' | 'hangup' | 'ping' | 'pong';
	sessionId: string;
	sdp?: string;
	mode?: 'live' | 'data'; // live = viewer wants stream tracks; data = segment/coverage only
}

export type SignalHandler = (msg: SignalMessage, fromPubkey: string) => void | Promise<void>;

// NIP-59 gift-wrap outer events have randomised created_at for privacy,
// so `since` relay filters don't work. We check the inner rumor's honest
// timestamp and discard anything older than SIGNAL_TTL_S seconds.
const SIGNAL_TTL_S = 60;

// Deduplicate events by outer event ID — relays may replay the same event
// on reconnect. Cleared every TTL interval to bound memory growth.
const seenEventIds = new Set<string>();
setInterval(() => seenEventIds.clear(), SIGNAL_TTL_S * 1000);

export function listenForSignals(
	privkey: Uint8Array,
	pubkey: string,
	handler: SignalHandler
): { close: () => void } {
	return subscribe(
		{ kinds: [1059], '#p': [pubkey] },
		(event: NostrEvent) => {
			if (seenEventIds.has(event.id)) return;
			seenEventIds.add(event.id);
			try {
				const inner = giftUnwrap(event, privkey);
				const age = Math.floor(Date.now() / 1000) - inner.created_at;
				if (age > SIGNAL_TTL_S) return;
				const msg = JSON.parse(inner.content) as SignalMessage;
				dbg('in', 'rtc', `signal ${msg.type} sess:${msg.sessionId.slice(0, 8)} from:${inner.pubkey.slice(0, 8)}`, msg);
				handler(msg, inner.pubkey);
			} catch {
				// Undecryptable — not meant for this recipient
			}
		}
	);
}

export async function sendSignal(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	msg: SignalMessage
): Promise<void> {
	dbg('out', 'rtc', `signal ${msg.type} sess:${msg.sessionId.slice(0, 8)} to:${toPubkey.slice(0, 8)}`, msg);
	const inner = finalizeEvent({
		kind: KIND_SIGNAL,
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
	return sendSignal(privkey, fromPubkey, toPubkey, { type: 'offer', sdp, sessionId });
}

export async function sendOfferRequest(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sessionId: string,
	mode: 'live' | 'data' = 'data'
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, { type: 'offer-request', sessionId, mode });
}

export async function sendAnswer(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sdp: string,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, { type: 'answer', sdp, sessionId });
}

export async function sendHangup(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	sessionId: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, { type: 'hangup', sessionId });
}
