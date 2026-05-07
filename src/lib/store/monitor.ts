import { writable, type Writable } from 'svelte/store';

export type MonitorState = 'idle' | 'starting' | 'active' | 'paused-nostr' | 'no-store' | 'stopping';

export const monitorState: Writable<MonitorState> = writable('idle');

export function transitionMonitor(next: MonitorState): void {
	monitorState.set(next);
}

// Whether the monitor is currently storing footage
export function isStoring(state: MonitorState): boolean {
	return state === 'active' || state === 'paused-nostr';
}

// Whether the monitor is currently publishing to Nostr
export function isPublishing(state: MonitorState): boolean {
	return state === 'active' || state === 'no-store';
}

// Whether the monitor is actively running detectors
export function isActive(state: MonitorState): boolean {
	return state === 'active' || state === 'paused-nostr' || state === 'no-store';
}
