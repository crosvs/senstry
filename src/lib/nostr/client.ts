import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent, Filter } from 'nostr-tools';
import { dbg } from '$lib/store/debug';

let pool: SimplePool | null = null;
let relayUrls: string[] = [];


// ── Token bucket rate limiter ──────────────────────────────────────────────
class TokenBucket {
	private tokens: number;
	private lastRefill = Date.now();

	constructor(private max: number, private ratePerMs: number) {
		this.tokens = max;
	}

	consume(): boolean {
		this._refill();
		if (this.tokens < 1) return false;
		this.tokens--;
		return true;
	}

	get available(): number {
		this._refill();
		return Math.floor(this.tokens);
	}

	setRate(eventsPerMin: number): void {
		this.max = eventsPerMin;
		this.ratePerMs = eventsPerMin / 60_000;
		this.tokens = Math.min(this.tokens, eventsPerMin);
	}

	reset(eventsPerMin?: number): void {
		if (eventsPerMin !== undefined) {
			this.max = eventsPerMin;
			this.ratePerMs = eventsPerMin / 60_000;
		}
		this.tokens = this.max;
		this.lastRefill = Date.now();
	}

	private _refill(): void {
		const now = Date.now();
		this.tokens = Math.min(this.max, this.tokens + (now - this.lastRefill) * this.ratePerMs);
		this.lastRefill = now;
	}
}

const rateLimiter = new TokenBucket(200, 200 / 60_000);

export function setRateLimit(eventsPerMin: number): void {
	rateLimiter.setRate(eventsPerMin);
}

export function getRateLimitAvailable(): number {
	return rateLimiter.available;
}

// Rolling 60-second publish counter
const _publishTimes: number[] = [];

function recordPublish(): void {
	const now = Date.now();
	_publishTimes.push(now);
	// Evict entries older than 60s
	const cutoff = now - 60_000;
	while (_publishTimes.length > 0 && _publishTimes[0] < cutoff) _publishTimes.shift();
}

export function getPublishRate(): { last60s: number; max: number } {
	const cutoff = Date.now() - 60_000;
	// Trim stale entries without modifying the array (read-only)
	let i = 0;
	while (i < _publishTimes.length && _publishTimes[i] < cutoff) i++;
	return { last60s: _publishTimes.length - i, max: Math.round(rateLimiter.available + (_publishTimes.length - i)) };
}

// ── Active subscriptions (dev panel) ──────────────────────────────────────
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
	if (relayUrls.length === 0) {
		dbg('warn', 'nostr', `publish skipped — no relays configured`);
		throw new Error('no relays configured');
	}
	if (!rateLimiter.consume()) {
		dbg('warn', 'nostr', `rate-limited kind:${event.kind} id:${event.id.slice(0, 8)}`);
		throw new Error('rate-limited');
	}
	recordPublish();
	dbg('out', 'nostr', `publish kind:${event.kind} id:${event.id.slice(0, 8)}`, event);
	const results = await Promise.allSettled(getPool().publish(relayUrls, event));
	const failed = results.filter((r) => r.status === 'rejected');
	if (failed.length === results.length) {
		const reason = (failed[0] as PromiseRejectedResult).reason;
		dbg('error', 'nostr', `all relays rejected kind:${event.kind}`, { reason });
		throw new Error(`publish failed: ${reason}`);
	}
	if (failed.length > 0) {
		dbg('warn', 'nostr', `partial publish failure ${failed.length}/${results.length} relays`);
	}
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

export function _resetForTest(): void {
	pool = null;
	relayUrls = [];
	_publishTimes.length = 0;
	_activeSubs.clear();
	subSeq = 0;
	rateLimiter.reset(200);
}
