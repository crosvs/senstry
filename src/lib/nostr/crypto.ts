import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from 'nostr-tools/nip44';
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools';

type Rumor = UnsignedEvent & { id: string };

// NIP-59 default outer timestamp offset is 2 days, which forces a ~2-day relay subscription
// window and causes a large backlog dump on every session start. For a private two-device
// setup there is no anonymity requirement, so we use 30 minutes — reducing the window to ~1.6 h.
export const WRAP_MAX_OFFSET_S = 30 * 60;

export function encrypt(senderPrivkey: Uint8Array, recipientPubkey: string, plaintext: string): string {
	const key = getConversationKey(senderPrivkey, recipientPubkey);
	return nip44Encrypt(plaintext, key);
}

export function decrypt(recipientPrivkey: Uint8Array, senderPubkey: string, ciphertext: string): string {
	const key = getConversationKey(recipientPrivkey, senderPubkey);
	return nip44Decrypt(ciphertext, key);
}

export function giftWrap(
	innerEvent: Partial<UnsignedEvent>,
	senderPrivkey: Uint8Array,
	recipientPubkey: string
): NostrEvent {
	const rumor = createRumor(innerEvent, senderPrivkey);
	const seal = createSeal(rumor, senderPrivkey, recipientPubkey);
	const ephemeralKey = generateSecretKey();
	const convKey = getConversationKey(ephemeralKey, recipientPubkey);
	const offsetS = Math.floor(Math.random() * WRAP_MAX_OFFSET_S);
	return finalizeEvent({
		kind: 1059,
		created_at: Math.floor(Date.now() / 1000) - offsetS,
		tags: [['p', recipientPubkey]],
		content: nip44Encrypt(JSON.stringify(seal), convKey),
	}, ephemeralKey);
}

export function giftUnwrap(
	wrappedEvent: NostrEvent,
	recipientPrivkey: Uint8Array
): Rumor {
	return unwrapEvent(wrappedEvent, recipientPrivkey);
}
