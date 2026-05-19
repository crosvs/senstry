import { writable, get } from 'svelte/store';
import { identity, pairedDevices } from '$lib/store/identity';
import { sendSignal } from '$lib/webrtc/signaling';
import { clearQueued } from '$lib/db/outbox';
import { dbg } from '$lib/store/debug';

export const nostrOnline = writable(false);

// Reason the device went offline, shown in the UI when nostrOnline flips to false
// due to a relay error rather than an explicit user action.
export const nostrOfflineReason = writable<string | null>(null);

// Consecutive relay-level publish failures. A single failure (relay hiccup) is
// tolerated; repeated failures indicate a block or ban and trigger auto-offline.
let _consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3;

export function reportPublishError(err: Error): void {
	if (!get(nostrOnline)) return;
	const msg = err.message ?? '';
	// Token-bucket rate-limiting is local throttling, not a relay error — ignore.
	if (msg === 'rate-limited') return;
	if (msg.startsWith('publish failed:') || msg === 'no relays configured') {
		_consecutiveFailures++;
		if (_consecutiveFailures >= FAILURE_THRESHOLD) {
			dbg('warn', 'nostr', `auto-offline after ${_consecutiveFailures} consecutive publish failures: ${msg}`);
			nostrOfflineReason.set(`Relay unreachable — went offline automatically (${msg})`);
			goOffline().catch(() => {});
		}
	}
}

export function reportPublishSuccess(): void {
	_consecutiveFailures = 0;
}

export async function goOnline(): Promise<void> {
	nostrOnline.set(true);
	// Signal router + online announcement are handled by SentrySection's $effect on nostrOnline.
}

export function _resetForTest(): void {
	_consecutiveFailures = 0;
	nostrOnline.set(false);
	nostrOfflineReason.set(null);
}

export async function goOffline(): Promise<void> {
	// Announce offline BEFORE setting nostrOnline = false so the signal can go out.
	const id = get(identity);
	if (id) {
		const sessionId = crypto.randomUUID();
		for (const device of get(pairedDevices)) {
			sendSignal(id.privkey, id.pubkey, device.pubkey, {
				type: 'status', state: 'offline', sessionId,
			}).catch(() => {});
		}
	}
	await clearQueued();
	nostrOnline.set(false);
}
