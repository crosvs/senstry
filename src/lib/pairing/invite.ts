import { subscribe, getRelays } from '$lib/nostr/client';
import { decrypt } from '$lib/nostr/crypto';
import { createInvite, consumeInvite, expireStalePendingInvites } from '$lib/db/invites';
import { addPairedDevice } from '$lib/store/identity';
import { generateNickname } from '$lib/utils/nickname';
import { encodeInviteUri, generateQRDataUrl, type InvitePayload } from '$lib/utils/qr';
import { KIND_INVITE_ACK } from '$lib/nostr/events';
import { dbg } from '$lib/store/debug';
import type { NostrEvent } from 'nostr-tools';

export interface InviteAckPayload {
	type: 'invite-ack';
	inviteId: string;
	secret: string;
	scannerPubkey: string;
	scannerRelays: string[];
	timestamp: number;
}

// Creates a one-time invite, returns the QR data URL and the URI for copy-paste.
export async function createInviteQR(
	privkey: Uint8Array,
	inviterPubkey: string,
	selfLabel: string,
	ttlMs = 5 * 60 * 1000
): Promise<{ uri: string; qrDataUrl: string; inviteId: string }> {
	await expireStalePendingInvites();
	const invite = await createInvite(ttlMs);
	const relays = getRelays();
	const payload: InvitePayload = {
		v: 2,
		pk: inviterPubkey,
		relays,
		inviteId: invite.inviteId,
		secret: invite.secret,
		expiresAt: Math.floor(invite.expiresAt / 1000),
		label: selfLabel
	};
	const uri = encodeInviteUri(payload);
	const qrDataUrl = await generateQRDataUrl(uri);
	return { uri, qrDataUrl, inviteId: invite.inviteId };
}

// Listen for a single valid ack for any of our pending invites.
// Calls onPaired when a valid ack is received, passes the scanner's pubkey.
// Returns a close function to stop listening.
export function listenForInviteAck(
	privkey: Uint8Array,
	inviterPubkey: string,
	onPaired: (scannerPubkey: string, scannerRelays: string[], scannerLabel: string) => void
): { close: () => void } {
	const sub = subscribe(
		{ kinds: [KIND_INVITE_ACK], '#p': [inviterPubkey] },
		async (event: NostrEvent) => {
			try {
				const payload = JSON.parse(
					decrypt(privkey, event.pubkey, event.content)
				) as InviteAckPayload;

				if (payload.type !== 'invite-ack') return;

				const consumed = await consumeInvite(payload.inviteId, payload.scannerPubkey);
				if (!consumed) {
					dbg('warn', 'nostr', `invite-ack rejected: inviteId=${payload.inviteId} already consumed or expired`);
					return;
				}

				dbg('info', 'nostr', `invite-ack accepted from ${payload.scannerPubkey.slice(0, 8)}`);
				onPaired(payload.scannerPubkey, payload.scannerRelays, payload.scannerPubkey.slice(0, 8));
			} catch {
				// Undecryptable — not meant for us or malformed
			}
		}
	);
	return sub;
}

// Called on the scanner side after decoding the QR.
// Validates expiry, stores the paired device, and returns the ack event to publish.
export async function acceptInvite(
	privkey: Uint8Array,
	scannerPubkey: string,
	payload: InvitePayload
): Promise<{ valid: boolean; reason?: string }> {
	const nowSec = Math.floor(Date.now() / 1000);
	if (nowSec > payload.expiresAt) {
		return { valid: false, reason: 'Invite has expired' };
	}

	await addPairedDevice({
		pubkey: payload.pk,
		nickname: generateNickname(),
		addedAt: Date.now(),
		relays: payload.relays,
		capabilities: [],
		lastSeenAt: null
	});

	return { valid: true };
}
