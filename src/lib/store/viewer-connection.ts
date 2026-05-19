import { writable } from 'svelte/store';
import type { ChannelConfig } from '$lib/store/pipeline';

export type ViewerStatus = 'offline' | 'connecting' | 'online' | 'failed';

export interface ViewerConnectionState {
	monitorPubkey: string | null;
	status: ViewerStatus;
	mode: 'data' | 'live' | null;
	channels: ChannelConfig[];
	channelId: string;
	error: string | null;
}

export const viewerConnection = writable<ViewerConnectionState>({
	monitorPubkey: null,
	status: 'offline',
	mode: null,
	channels: [],
	channelId: '',
	error: null,
});

export function selectChannel(channelId: string): void {
	viewerConnection.update(s => ({ ...s, channelId }));
}
