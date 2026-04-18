import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';

export function buildAuthEvent(
	privkey: Uint8Array,
	relayUrl: string,
	challenge: string
): NostrEvent {
	return finalizeEvent({
		kind: 22242,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			['relay', relayUrl],
			['challenge', challenge]
		],
		content: ''
	}, privkey);
}
