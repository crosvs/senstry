import { writable } from 'svelte/store';

export type StreamState = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

export const streamState = writable<StreamState>('idle');
export const remoteStream = writable<MediaStream | null>(null);
