import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent, Filter } from 'nostr-tools';
import { dbg } from '$lib/store/debug';

let pool: SimplePool | null = null;
let relayUrls: string[] = [];

// All currently open subscriptions — read by the dev panel to list active subs.
export interface ActiveSub {
	id: string;
	filter: Filter;
	openedAt: number;
	eventCount: number;
	close: () => void;
}
const _activeSubs = new Map<string, ActiveSub>();
export function getActiveSubs(): ActiveSub[] {
	return Array.from(_activeSubs.values());
}

let subSeq = 0;

export function getPool(): SimplePool {
	if (!pool) pool = new SimplePool();
	return pool;
}

export function setRelays(urls: string[]): void {
	relayUrls = urls;
	dbg('info', 'nostr', `relays set: ${urls.join(', ')}`);
}

export function getRelays(): string[] {
	return relayUrls;
}

export async function publish(event: NostrEvent): Promise<void> {
	dbg('out', 'nostr', `publish kind:${event.kind} id:${event.id.slice(0, 8)}`, event);
	const p = getPool();
	await Promise.allSettled(p.publish(relayUrls, event));
}

export function subscribe(
	filter: Filter,
	onEvent: (event: NostrEvent) => void,
	onEose?: () => void
): { close: () => void } {
	const subId = `sub-${++subSeq}`;
	const p = getPool();

	const sub = p.subscribeMany(relayUrls, filter, {
		onevent: (event: NostrEvent) => {
			dbg('in', 'nostr', `event kind:${event.kind} from:${event.pubkey.slice(0, 8)}`, event);
			if (_activeSubs.has(subId)) _activeSubs.get(subId)!.eventCount++;
			onEvent(event);
		},
		oneose: onEose
	});

	const entry: ActiveSub = {
		id: subId,
		filter,
		openedAt: Date.now(),
		eventCount: 0,
		close: () => {
			sub.close();
			_activeSubs.delete(subId);
			dbg('info', 'nostr', `subscription ${subId} closed`);
		}
	};
	_activeSubs.set(subId, entry);
	dbg('info', 'nostr', `subscribe ${subId} kinds:${JSON.stringify(filter.kinds)}`, filter);

	return { close: entry.close };
}
