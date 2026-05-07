import { finalizeEvent } from 'nostr-tools/pure';
import { encrypt } from './crypto';
import type { NostrEvent } from 'nostr-tools';

// ── Kind constants ──────────────────────────────────────────────────────────
export const KIND_INVITE_ACK      = 5000; // replaces v1 PAIR_ACK
export const KIND_SIGNAL          = 5001; // replaces v1 5001/5002/5003
export const KIND_TRIGGER         = 5010;
export const KIND_ARM_STATE       = 5011;
export const KIND_FOOTAGE_REF     = 5020; // NIP-33 addressable footage reference
export const KIND_FOOTAGE_DELETE  = 5021; // NIP-09-style delete for footage ref
export const KIND_BACKUP_REQUEST  = 5022; // viewer asks monitor to send footage for backup
export const KIND_BACKUP_ACK      = 5023; // monitor confirms backup stored
export const KIND_RESYNC_REQUEST  = 5024; // request monitor to re-publish all footage refs

// ── Pairing ─────────────────────────────────────────────────────────────────

export function buildInviteAck(
	privkey: Uint8Array,
	scannerPubkey: string,
	inviterPubkey: string,
	inviteId: string,
	secret: string,
	scannerRelays: string[]
): NostrEvent {
	const content = encrypt(privkey, inviterPubkey, JSON.stringify({
		type: 'invite-ack',
		inviteId,
		secret,
		scannerPubkey,
		scannerRelays,
		timestamp: Math.floor(Date.now() / 1000)
	}));
	return finalizeEvent({
		kind: KIND_INVITE_ACK,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', inviterPubkey], ['v', '2']],
		content
	}, privkey);
}

// ── Signaling ────────────────────────────────────────────────────────────────
// All signal types collapsed into a single kind (type in content payload).

export function buildSignalPayload(
	type: 'offer-request' | 'offer' | 'answer' | 'hangup',
	sessionId: string,
	sdp?: string
): object {
	return sdp ? { type, sessionId, sdp } : { type, sessionId };
}

// ── Triggers ─────────────────────────────────────────────────────────────────

export function buildTriggerEvent(
	privkey: Uint8Array,
	monitorPubkey: string,
	viewerPubkey: string,
	detectionType: string,
	monitorLabel: string,
	data: Record<string, unknown>,
	footageRefId: string | null = null
): NostrEvent {
	const content = encrypt(privkey, viewerPubkey, JSON.stringify({
		type: detectionType,
		monitorLabel,
		timestamp: Math.floor(Date.now() / 1000),
		data,
		footageRefId
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

// ── Footage references ────────────────────────────────────────────────────────

export function buildFootageRefEvent(
	privkey: Uint8Array,
	monitorPubkey: string,
	viewerPubkey: string,
	refId: string,
	type: 'video' | 'photo',
	startTime: number,
	endTime: number,
	encodingHint: string,
	triggerEventId: string | null,
	deleted = false
): NostrEvent {
	const durationSec = endTime - startTime;
	const content = encrypt(privkey, viewerPubkey, JSON.stringify({
		type,
		refId,
		originMonitor: monitorPubkey,
		startTime,
		endTime,
		durationSec,
		deleted,
		triggerEventId,
		encodingHint
	}));
	return finalizeEvent({
		kind: KIND_FOOTAGE_REF,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', viewerPubkey], ['d', refId], ['v', '2']],
		content
	}, privkey);
}

export function buildFootageDeleteEvent(
	privkey: Uint8Array,
	viewerPubkey: string,
	nostrEventId: string,
	refId: string
): NostrEvent {
	return finalizeEvent({
		kind: KIND_FOOTAGE_DELETE,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['e', nostrEventId], ['d', refId], ['p', viewerPubkey]],
		content: ''
	}, privkey);
}

// ── Backup ────────────────────────────────────────────────────────────────────

export function buildBackupRequest(
	privkey: Uint8Array,
	requesterPubkey: string,
	monitorPubkey: string,
	refId: string,
	originMonitor: string
): NostrEvent {
	const content = encrypt(privkey, monitorPubkey, JSON.stringify({
		type: 'backup-request',
		refId,
		originMonitor
	}));
	return finalizeEvent({
		kind: KIND_BACKUP_REQUEST,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', monitorPubkey]],
		content
	}, privkey);
}

export function buildBackupAck(
	privkey: Uint8Array,
	monitorPubkey: string,
	requesterPubkey: string,
	refId: string,
	status: 'stored' | 'unavailable'
): NostrEvent {
	const content = encrypt(privkey, requesterPubkey, JSON.stringify({
		type: 'backup-ack',
		refId,
		status,
		storedAt: Math.floor(Date.now() / 1000)
	}));
	return finalizeEvent({
		kind: KIND_BACKUP_ACK,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', requesterPubkey]],
		content
	}, privkey);
}

export function buildResyncRequest(
	privkey: Uint8Array,
	requesterPubkey: string,
	monitorPubkey: string,
	since: number
): NostrEvent {
	const content = encrypt(privkey, monitorPubkey, JSON.stringify({
		type: 'resync-request',
		since
	}));
	return finalizeEvent({
		kind: KIND_RESYNC_REQUEST,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['p', monitorPubkey]],
		content
	}, privkey);
}
