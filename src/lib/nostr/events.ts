import { finalizeEvent } from 'nostr-tools/pure';
import { encrypt } from './crypto';
import type { NostrEvent } from 'nostr-tools';

export const KIND_PAIR_ACK = 5000;
export const KIND_SIGNAL_OFFER = 5001;
export const KIND_SIGNAL_ANSWER = 5002;
export const KIND_SIGNAL_ICE = 5003;
export const KIND_TRIGGER = 5010;
export const KIND_ARM_STATE = 5011;

export function buildPairAck(
	privkey: Uint8Array,
	senderPubkey: string,
	recipientPubkey: string,
	label: string
): NostrEvent {
	const content = encrypt(privkey, recipientPubkey, JSON.stringify({
		type: 'pair-ack',
		senderPubkey,
		label,
		timestamp: Math.floor(Date.now() / 1000)
	}));
	return finalizeEvent({
		kind: KIND_PAIR_ACK,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', recipientPubkey], ['v', '1']],
		content
	}, privkey);
}

export function buildSignalOffer(sdp: string, sessionId: string): object {
	return { type: 'offer', sdp, sessionId };
}

export function buildSignalOfferRequest(sessionId: string): object {
	return { type: 'offer-request', sessionId };
}

export function buildSignalAnswer(sdp: string, sessionId: string): object {
	return { type: 'answer', sdp, sessionId };
}

export function buildSignalICE(
	candidate: string,
	sdpMid: string | null,
	sdpMLineIndex: number | null,
	sessionId: string
): object {
	return { type: 'ice', candidate, sdpMid, sdpMLineIndex, sessionId };
}

export function buildSignalHangup(sessionId: string): object {
	return { type: 'hangup', sessionId };
}

export function buildTriggerEvent(
	privkey: Uint8Array,
	monitorPubkey: string,
	viewerPubkey: string,
	detectionType: string,
	monitorLabel: string,
	data: Record<string, unknown>
): NostrEvent {
	const content = encrypt(privkey, viewerPubkey, JSON.stringify({
		type: detectionType,
		monitorLabel,
		timestamp: Math.floor(Date.now() / 1000),
		data
	}));
	return finalizeEvent({
		kind: KIND_TRIGGER,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			['p', viewerPubkey],
			['d', monitorPubkey],
			['t', detectionType]
		],
		content
	}, privkey);
}

export function buildArmState(
	privkey: Uint8Array,
	monitorPubkey: string,
	viewerPubkey: string,
	armed: boolean
): NostrEvent {
	const content = encrypt(privkey, viewerPubkey, JSON.stringify({
		type: 'arm-state',
		armed,
		timestamp: Math.floor(Date.now() / 1000)
	}));
	return finalizeEvent({
		kind: KIND_ARM_STATE,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', viewerPubkey], ['d', monitorPubkey]],
		content
	}, privkey);
}
