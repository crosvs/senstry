import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent, Filter } from 'nostr-tools';
import { dbg } from '$lib/store/debug';

let pool: SimplePool | null = null;
let relayUrls: string[] = [];


// ── Per-key publish cooldown ──────────────────────────────────────────────
// Prevents the same semantic event (identified by a caller-supplied key)
// from being published again before its cooldown expires.
// Each key has its own independent timer — unrelated keys don't share budget.

const _cooldowns = new Map<string, number>(); // key → expiresAt (ms)

export function getCooldownRemaining(key: string): number {
	const exp = _cooldowns.get(key);
	if (exp === undefined) return 0;
	const rem = exp - Date.now();
	return rem > 0 ? rem : 0;
}

export function clearCooldown(key: string): void {
	_cooldowns.delete(key);
}

export function _resetCooldownsForTest(): void {
	_cooldowns.clear();
}

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

export async function publish(
	event: NostrEvent,
	opts?: { cooldownKey?: string; cooldownMs?: number }
): Promise<void> {
	if (relayUrls.length === 0) {
		dbg('warn', 'nostr', `publish skipped — no relays configured`);
		throw new Error('no relays configured');
	}

	if (opts?.cooldownKey) {
		const remaining = getCooldownRemaining(opts.cooldownKey);
		if (remaining > 0) {
			dbg('info', 'nostr', `cooldown kind:${event.kind} key:${opts.cooldownKey} (${(remaining / 1000).toFixed(1)}s remaining)`);
			throw new Error('cooldown');
		}
	}

	if (!rateLimiter.consume()) {
		dbg('warn', 'nostr', `rate-limited kind:${event.kind} id:${event.id.slice(0, 8)}`);
		throw new Error('rate-limited');
	}
	recordPublish();
	dbg('out', 'nostr', `publish kind:${event.kind} id:${event.id.slice(0, 8)}`, event);
	const results = await Promise.allSettled(getPool().publish(relayUrls, event));
	const failed = results.filter((r) => r.status === 'rejected');
	const ok = results.length - failed.length;
	if (ok > 0) {
		dbg('info', 'nostr', `relay accepted kind:${event.kind} id:${event.id.slice(0, 8)} (${ok}/${results.length})`);
	}
	if (failed.length === results.length) {
		const raw = (failed[0] as PromiseRejectedResult).reason;
		const msg = raw instanceof Error ? raw.message : String(raw);
		dbg('error', 'nostr', `all relays rejected kind:${event.kind} id:${event.id.slice(0, 8)}: ${msg}`);
		throw new Error(`publish failed: ${msg}`);
	}
	if (failed.length > 0) {
		const raw = (failed[0] as PromiseRejectedResult).reason;
		const msg = raw instanceof Error ? raw.message : String(raw);
		dbg('warn', 'nostr', `partial publish failure ${failed.length}/${results.length}: ${msg}`);
	}

	if (opts?.cooldownKey && opts.cooldownMs) {
		_cooldowns.set(opts.cooldownKey, Date.now() + opts.cooldownMs);
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
	dbg('info', 'nostr', `subscribe ${subId} kinds:${JSON.stringify(filter.kinds)} filter:${JSON.stringify(filter)}`);

	return { close: entry.close };
}

export function _resetForTest(): void {
	pool = null;
	relayUrls = [];
	_publishTimes.length = 0;
	_activeSubs.clear();
	subSeq = 0;
	rateLimiter.reset(200);
	_cooldowns.clear();
}
