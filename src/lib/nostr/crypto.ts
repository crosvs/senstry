import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from 'nostr-tools/nip44';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools';

type Rumor = UnsignedEvent & { id: string };

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
	return wrapEvent(innerEvent, senderPrivkey, recipientPubkey);
}

export function giftUnwrap(
	wrappedEvent: NostrEvent,
	recipientPrivkey: Uint8Array
): Rumor {
	return unwrapEvent(wrappedEvent, recipientPrivkey);
}
