import { writable } from 'svelte/store';

export type PeerOnlineState = 'online' | 'offline';

export interface PeerStatus {
	state: PeerOnlineState;
	updatedAt: number; // inner event unix seconds (signed by sender)
}

export const peerStatuses = writable<Record<string, PeerStatus>>({});

// Freshness guard: only update if the incoming event is newer than the last
// processed one for that peer. Prevents relay replays and out-of-order delivery
// from overwriting a newer known state with a stale one.
const lastSeenAt = new Map<string, number>();

export function updatePeerStatus(pubkey: string, state: PeerOnlineState, createdAt: number): void {
	const last = lastSeenAt.get(pubkey) ?? 0;
	if (createdAt <= last) return;
	lastSeenAt.set(pubkey, createdAt);
	peerStatuses.update(s => ({ ...s, [pubkey]: { state, updatedAt: createdAt } }));
}
