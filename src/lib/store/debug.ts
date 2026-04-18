import { writable } from 'svelte/store';

export type LogDir = 'in' | 'out' | 'info' | 'warn' | 'error';
export type LogSource = 'nostr' | 'rtc' | 'idb' | 'detector' | 'app';

export interface LogEntry {
	id: number;
	ts: number;         // Date.now()
	dir: LogDir;
	source: LogSource;
	label: string;      // short human description
	raw?: string;       // JSON payload — shown in dev mode
	bytes?: number;     // estimated payload size
}

let seq = 0;
const MAX_ENTRIES = 400;

export const debugLog = writable<LogEntry[]>([]);

export function dbg(
	dir: LogDir,
	source: LogSource,
	label: string,
	payload?: unknown
): void {
	const raw = payload !== undefined ? JSON.stringify(payload, null, 2) : undefined;
	const bytes = raw ? new Blob([raw]).size : undefined;
	debugLog.update((log) => {
		const entry: LogEntry = { id: seq++, ts: Date.now(), dir, source, label, raw, bytes };
		const next = [entry, ...log];
		return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
	});
}

export function clearLog(): void {
	debugLog.set([]);
}
