import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent, Filter } from 'nostr-tools';
import { writable, get } from 'svelte/store';
import { dbg } from '$lib/store/debug';
import { reportPublishError, reportPublishSuccess } from '$lib/store/nostr-online';

let pool: SimplePool | null = null;
let relayUrls: string[] = [];

// ── Per-relay rate-limit tracking ─────────────────────────────────────────
// When a relay rejects with a rate-limit reason, we honour its cooldown by
// skipping it for future publishes until `until` expires.
export interface RelayRateLimit {
	relay: string;   // hostname
	reason: string;  // raw relay rejection string
	until: number;   // Date.now() + cooldown ms
}

export const relayRateLimits = writable<RelayRateLimit[]>([]);

// Parse a retry-after duration from a relay rejection string.
// Returns milliseconds, defaulting to 60 s when no hint is present.
function parseRetryMs(reason: string): number {
	const patterns: [RegExp, number][] = [
		[/retry\s+(?:after|in)\s+(\d+)\s*s(?:ec(?:onds?)?)?/i, 1000],
		[/retry\s+(?:after|in)\s+(\d+)\s*min/i, 60_000],
		[/retry\s+(?:after|in)\s+(\d+)/i, 1000],
		[/try\s+again\s+in\s+(\d+)\s*s/i, 1000],
		[/try\s+again\s+in\s+(\d+)/i, 1000],
		[/wait\s+(\d+)\s*s/i, 1000],
		[/(\d+)\s+second/i, 1000],
	];
	for (const [re, mul] of patterns) {
		const m = reason.match(re);
		if (m) return parseInt(m[1]) * mul;
	}
	return 60_000;
}

function _relayHost(url: string): string {
	try { return new URL(url).hostname; } catch { return url; }
}

function markRelayRateLimited(relayUrl: string, reason: string): void {
	const ms = parseRetryMs(reason);
	const host = _relayHost(relayUrl);
	relayRateLimits.update(current => [
		...current.filter(r => r.relay !== host),
		{ relay: host, reason, until: Date.now() + ms },
	]);
	dbg('warn', 'nostr', `rate-limited by ${host} — backing off ${(ms / 1000).toFixed(0)}s`, { reason, retryAfterMs: ms });
}

export function clearExpiredRateLimits(): void {
	const now = Date.now();
	relayRateLimits.update(current => current.filter(r => r.until > now));
}


// ── Per-key publish cooldown ──────────────────────────────────────────────
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

// ── Smooth publish queue ───────────────────────────────────────────────────
// Events are spaced at least _intervalMs() apart rather than burst-and-reject.
// This prevents relay rate-limit rejections at startup when many signals fire.

export interface PendingPublish {
	id: string;          // nostr event id
	label: string;       // human description e.g. "signal:status"
	queuedAt: number;    // Date.now() when enqueued
	estimatedAt: number; // best-guess epoch ms for actual send
}

export const publishQueue = writable<PendingPublish[]>([]);

// Rate: configurable events per minute; minimum spacing 300 ms to avoid
// hammering even at high rates.
let _eventsPerMin = 200;

function _intervalMs(): number {
	return Math.max(300, Math.ceil(60_000 / _eventsPerMin));
}

export function setRateLimit(eventsPerMin: number): void {
	_eventsPerMin = eventsPerMin;
}

export function getRateLimitAvailable(): number {
	// Approximate: how many events could fire in the next minute given current spacing
	return Math.floor(60_000 / _intervalMs());
}

interface _QueueItem {
	event: NostrEvent;
	label: string;
	cooldownKey?: string;
	cooldownMs?: number;
	estimatedAt: number;
	queuedAt: number;
	resolve: () => void;
	reject: (err: Error) => void;
	cancelled: boolean;
}

const _queue: _QueueItem[] = [];
let _draining = false;
let _lastSentAt = 0;

// Rolling 60-second publish counter
const _publishTimes: number[] = [];

function _recordPublish(): void {
	const now = Date.now();
	_publishTimes.push(now);
	const cutoff = now - 60_000;
	while (_publishTimes.length > 0 && _publishTimes[0] < cutoff) _publishTimes.shift();
}

export function getPublishRate(): { last60s: number; max: number } {
	const cutoff = Date.now() - 60_000;
	let i = 0;
	while (i < _publishTimes.length && _publishTimes[i] < cutoff) i++;
	return { last60s: _publishTimes.length - i, max: _eventsPerMin };
}

function _syncQueueStore(): void {
	publishQueue.set(_queue.map(item => ({
		id: item.event.id,
		label: item.label,
		queuedAt: item.queuedAt,
		estimatedAt: item.estimatedAt,
	})));
}

function _recomputeEstimates(): void {
	// Space remaining items starting from max(now, _lastSentAt) + interval
	const interval = _intervalMs();
	let t = Math.max(Date.now(), _lastSentAt + interval);
	for (const item of _queue) {
		item.estimatedAt = t;
		t += interval;
	}
}

export function cancelPublish(eventId: string): boolean {
	const idx = _queue.findIndex(item => item.event.id === eventId);
	if (idx === -1) return false;
	const item = _queue[idx];
	item.cancelled = true;
	_queue.splice(idx, 1);
	_recomputeEstimates();
	_syncQueueStore();
	item.reject(new Error('cancelled'));
	return true;
}

async function _sendNow(item: _QueueItem): Promise<void> {
	if (item.cancelled) return;

	if (relayUrls.length === 0) {
		const err = new Error('no relays configured');
		reportPublishError(err);
		item.reject(err);
		return;
	}

	clearExpiredRateLimits();
	const limited = get(relayRateLimits);
	const activeUrls = relayUrls.filter(u => !limited.find(r => r.relay === _relayHost(u)));
	const publishTo = activeUrls.length > 0 ? activeUrls : relayUrls;
	if (activeUrls.length < relayUrls.length) {
		const skipped = relayUrls.filter(u => !activeUrls.includes(u)).map(_relayHost);
		dbg('info', 'nostr', `skipping rate-limited relays: ${skipped.join(', ')}`);
	}

	_recordPublish();
	dbg('out', 'nostr', `publish kind:${item.event.kind} id:${item.event.id.slice(0, 8)} label:${item.label}`, item.event);
	const publishPromises = getPool().publish(publishTo, item.event);
	const results = await Promise.allSettled(publishPromises);

	const relayResults: Record<string, string> = {};
	let okCount = 0;
	for (let i = 0; i < results.length; i++) {
		const host = _relayHost(publishTo[i]);
		const r = results[i];
		if (r.status === 'fulfilled') {
			const successReason = typeof r.value === 'string' && r.value ? r.value : 'ok';
			relayResults[host] = successReason;
			okCount++;
		} else {
			const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
			relayResults[host] = reason;
			if (reason.toLowerCase().startsWith('rate-limited')) {
				markRelayRateLimited(publishTo[i], reason);
			}
		}
	}
	const relayStr = Object.entries(relayResults).map(([h, s]) => `${h}: ${s}`).join(' | ');

	if (okCount === 0) {
		dbg('error', 'nostr', `all relays rejected kind:${item.event.kind} id:${item.event.id.slice(0, 8)} — ${relayStr}`, relayResults);
		const firstReason = (results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason;
		const msg = firstReason instanceof Error ? firstReason.message : String(firstReason);
		const err = new Error(`publish failed: ${msg}`);
		reportPublishError(err);
		item.reject(err);
		return;
	}

	reportPublishSuccess();
	if (okCount < results.length) {
		dbg('warn', 'nostr', `partial publish ${okCount}/${results.length} kind:${item.event.kind} — ${relayStr}`, relayResults);
	} else {
		dbg('info', 'nostr', `published kind:${item.event.kind} id:${item.event.id.slice(0, 8)} — ${relayStr}`);
	}

	if (item.cooldownKey && item.cooldownMs) {
		_cooldowns.set(item.cooldownKey, Date.now() + item.cooldownMs);
	}
	item.resolve();
}

async function _drain(): Promise<void> {
	if (_draining) return;
	_draining = true;
	while (_queue.length > 0) {
		const wait = Math.max(0, _lastSentAt + _intervalMs() - Date.now());
		if (wait > 0) await new Promise<void>(r => setTimeout(r, wait));
		const item = _queue.shift();
		if (!item) break;
		if (item.cancelled) {
			_syncQueueStore();
			continue;
		}
		_lastSentAt = Date.now();
		_syncQueueStore();
		await _sendNow(item);
	}
	_draining = false;
	_syncQueueStore();
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
	opts?: {
		cooldownKey?: string;
		cooldownMs?: number;
		label?: string;
		onQueued?: (id: string, cancel: () => void) => void;
	}
): Promise<void> {
	if (opts?.cooldownKey) {
		const remaining = getCooldownRemaining(opts.cooldownKey);
		if (remaining > 0) {
			dbg('info', 'nostr', `cooldown kind:${event.kind} key:${opts.cooldownKey} (${(remaining / 1000).toFixed(1)}s remaining)`);
			throw new Error('cooldown');
		}
	}

	const interval = _intervalMs();
	const queuedAt = Date.now();
	const queueLen = _queue.length;
	// Estimate when this item will actually send: after all queued items plus spacing from last send
	const baseTime = Math.max(queuedAt, _lastSentAt + interval);
	const estimatedAt = baseTime + queueLen * interval;

	return new Promise<void>((resolve, reject) => {
		const item: _QueueItem = {
			event,
			label: opts?.label ?? `kind:${event.kind}`,
			cooldownKey: opts?.cooldownKey,
			cooldownMs: opts?.cooldownMs,
			estimatedAt,
			queuedAt,
			resolve,
			reject,
			cancelled: false,
		};
		_queue.push(item);
		_syncQueueStore();
		opts?.onQueued?.(event.id, () => cancelPublish(event.id));
		_drain();
	});
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
	_eventsPerMin = 200;
	_queue.length = 0;
	_draining = false;
	_lastSentAt = 0;
	_cooldowns.clear();
	relayRateLimits.set([]);
	publishQueue.set([]);
}
