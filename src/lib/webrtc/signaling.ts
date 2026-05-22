import { subscribe, publish } from '$lib/nostr/client';
import { giftWrap, giftUnwrap } from '$lib/nostr/crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { KIND_SIGNAL } from '$lib/nostr/events';
import { dbg } from '$lib/store/debug';
import type { NostrEvent } from 'nostr-tools';

export interface SignalMessage {
	type: 'offer-request' | 'offer' | 'answer' | 'hangup' | 'ping' | 'pong' | 'status' | 'status-request';
	sessionId: string;
	sdp?: string;
	mode?: 'live' | 'data'; // live = viewer wants stream tracks; data = segment/coverage only
	sourceId?: string;      // live mode only — which source stream to receive (omit = all sources)
	channelId?: string;     // live mode only — which channel to receive (video+audio composite)
	state?: 'online' | 'offline'; // status messages only
	isAnnounce?: boolean;         // true = initial "I just came online" broadcast; absent = awareness reply
}

export type SignalHandler = (msg: SignalMessage, fromPubkey: string, createdAt: number) => void | Promise<void>;

// NIP-59 gift-wrap outer events have randomised created_at for privacy:
// nostr-tools sets outer.created_at = now - random * TWO_DAYS (up to 2 days in the past).
// This means a simple `since = now - N` relay filter is not reliable for tight windows,
// but a window large enough to cover (max_inner_TTL + TWO_DAYS) is safe.
// We still check the inner rumor's honest timestamp to enforce the per-type TTL.
const SIGNAL_TTL_S = 10;        // handshake signals are useless after 10 s
const STATUS_TTL_S = 3600;      // status presence signals are valid for 1 h

// Relay `since` filter: guarantees no valid event is skipped while avoiding
// the full historical replay.  Derived from:
//   max outer offset (TWO_DAYS = 172800 s)  +  max inner TTL (STATUS_TTL_S)  +  clock-drift buffer
// Any event older than this would be TTL-dropped by our inner-timestamp check anyway.
const TWO_DAYS_S = 172800;
const CLOCK_DRIFT_S = 300;
const SUBSCRIPTION_WINDOW_S = STATUS_TTL_S + TWO_DAYS_S + CLOCK_DRIFT_S; // ≈ 2.05 days

// Deduplicate events by outer event ID — relays may replay the same event
// on reconnect. Cleared every 60s (longer than SIGNAL_TTL_S) to prevent relay
// re-deliveries within the TTL window from being double-processed.
const seenEventIds = new Set<string>();
setInterval(() => seenEventIds.clear(), 60_000);

// Batch TTL-drop log entries — relay replay sends all old events in a burst.
// Accumulate for 300ms then emit a single summary line instead of one per event.
const _ttlDropBatch: string[] = [];
let _ttlDropTimer: ReturnType<typeof setTimeout> | null = null;

function _recordTtlDrop(type: string): void {
	_ttlDropBatch.push(type);
	if (_ttlDropTimer !== null) return;
	_ttlDropTimer = setTimeout(() => {
		_ttlDropTimer = null;
		const batch = _ttlDropBatch.splice(0);
		if (batch.length === 1) {
			dbg('info', 'rtc', `signal TTL drop: ${batch[0]}`);
		} else {
			const counts: Record<string, number> = {};
			for (const t of batch) counts[t] = (counts[t] ?? 0) + 1;
			const summary = Object.entries(counts).map(([t, n]) => `${n}×${t}`).join(' ');
			dbg('info', 'rtc', `relay replay: ${batch.length} stale signals dropped (${summary})`);
		}
	}, 300);
}

export function listenForSignals(
	privkey: Uint8Array,
	pubkey: string,
	handler: SignalHandler
): { close: () => void } {
	const since = Math.floor(Date.now() / 1000) - SUBSCRIPTION_WINDOW_S;
	return subscribe(
		{ kinds: [1059], '#p': [pubkey], since },
		(event: NostrEvent) => {
			if (seenEventIds.has(event.id)) return;
			seenEventIds.add(event.id);
			try {
				const inner = giftUnwrap(event, privkey);
				const msg = JSON.parse(inner.content) as SignalMessage;
				const ttl = (msg.type === 'status' || msg.type === 'status-request') ? STATUS_TTL_S : SIGNAL_TTL_S;
				const age = Math.floor(Date.now() / 1000) - inner.created_at;
				if (age > ttl) {
					_recordTtlDrop(msg.type);
					return;
				}
				dbg('in', 'rtc', `signal ${msg.type}${_signalDetail(msg)} sess:${msg.sessionId?.slice(0, 8)} from:${inner.pubkey.slice(0, 8)}`, msg);
				handler(msg, inner.pubkey, inner.created_at);
			} catch {
				// Undecryptable — not meant for this recipient
			}
		}
	);
}

function _signalDetail(msg: SignalMessage): string {
	const parts: string[] = [];
	if (msg.mode)       parts.push(`mode:${msg.mode}`);
	if (msg.channelId)  parts.push(`ch:${msg.channelId}`);
	if (msg.state)      parts.push(`state:${msg.state}`);
	if (msg.isAnnounce) parts.push('announce');
	return parts.length ? ` (${parts.join(' ')})` : '';
}

export async function sendSignal(
	privkey: Uint8Array,
	fromPubkey: string,
	toPubkey: string,
	msg: SignalMessage,
	opts?: { onQueued?: (id: string, cancel: () => void) => void }
): Promise<void> {
	dbg('out', 'rtc', `signal ${msg.type}${_signalDetail(msg)} sess:${msg.sessionId?.slice(0, 8)} to:${toPubkey.slice(0, 8)}`, msg);
	const inner = finalizeEvent({
		kind: KIND_SIGNAL,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', toPubkey]],
		content: JSON.stringify(msg)
	}, privkey);
	const wrapped = giftWrap(inner, privkey, toPubkey);
	await publish(wrapped, { label: `signal:${msg.type}`, onQueued: opts?.onQueued });
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
	mode: 'live' | 'data' = 'data',
	sourceId?: string,
	channelId?: string
): Promise<void> {
	return sendSignal(privkey, fromPubkey, toPubkey, {
		type: 'offer-request', sessionId, mode,
		...(sourceId && { sourceId }),
		...(channelId && { channelId }),
	});
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
