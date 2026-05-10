import { writable, derived } from 'svelte/store';
import { subscribe } from '$lib/nostr/client';
import { decrypt } from '$lib/nostr/crypto';
import { KIND_TRIGGER } from '$lib/nostr/events';
import { dbg } from '$lib/store/debug';

export interface AlertRecord {
	id: string;
	monitorPubkey: string;
	monitorLabel: string;
	detectionType: string;
	sourceId: string;
	timestamp: number;       // from event payload (monitor clock)
	receivedAt: number;      // local unix-sec when we got it
	data?: Record<string, unknown>;
	message?: string;
	footageRefId: string | null;
	read: boolean;
}

const MAX_ALERTS = 100;

export const alertLog      = writable<AlertRecord[]>([]);
export const listenerActive = writable(false);
export const notifPermission = writable<NotificationPermission>(
	typeof Notification !== 'undefined' ? Notification.permission : 'denied'
);
export const unreadCount = derived(alertLog, $log => $log.filter(a => !a.read).length);

let _sub: { close: () => void } | null = null;
// In-memory dedup set — survives relay re-delivery within a session.
const _seenIds = new Set<string>();

export async function requestNotifPermission(): Promise<NotificationPermission> {
	if (typeof Notification === 'undefined') {
		notifPermission.set('denied');
		return 'denied';
	}
	const perm = await Notification.requestPermission();
	notifPermission.set(perm);
	return perm;
}

// pairedPubkeys: Set of monitor pubkeys to accept. Empty set = accept all.
export function startAlertListener(
	privkey: Uint8Array,
	viewerPubkey: string,
	pairedPubkeys: Set<string>
): void {
	if (_sub) return; // already running
	listenerActive.set(true);

	_sub = subscribe(
		{
			kinds: [KIND_TRIGGER],
			'#p': [viewerPubkey],
			// Catch events from the last 5 minutes so fresh alerts are visible
			// immediately after opening the app, without replaying old history.
			since: Math.floor(Date.now() / 1000) - 300,
		},
		(event) => {
			if (_seenIds.has(event.id)) return;
			_seenIds.add(event.id);

			if (pairedPubkeys.size > 0 && !pairedPubkeys.has(event.pubkey)) return;

			let payload: Record<string, unknown>;
			try {
				const plain = decrypt(privkey, event.pubkey, event.content);
				payload = JSON.parse(plain);
			} catch (e) {
				dbg('warn', 'nostr', `alert: decrypt failed ${event.id.slice(0, 8)}: ${e}`);
				return;
			}

			const record: AlertRecord = {
				id: event.id,
				monitorPubkey: event.pubkey,
				monitorLabel: (payload.monitorLabel as string) || event.pubkey.slice(0, 8),
				detectionType: (payload.type as string) || 'unknown',
				sourceId: (payload.sourceId as string) || '',
				timestamp: (payload.timestamp as number) || event.created_at,
				receivedAt: Math.floor(Date.now() / 1000),
				data: payload.data as Record<string, unknown> | undefined,
				message: payload.message as string | undefined,
				footageRefId: (payload.footageRefId as string | null | undefined) ?? null,
				read: false,
			};

			alertLog.update(log => [record, ...log].slice(0, MAX_ALERTS));
			dbg('info', 'nostr', `alert: ${record.detectionType} from ${record.monitorLabel}`);
			_pushNotification(record);
		}
	);
}

export function stopAlertListener(): void {
	_sub?.close();
	_sub = null;
	listenerActive.set(false);
}

export function markAllRead(): void {
	alertLog.update(log => log.map(a => ({ ...a, read: true })));
}

export function markRead(id: string): void {
	alertLog.update(log => log.map(a => a.id === id ? { ...a, read: true } : a));
}

export function clearAlerts(): void {
	alertLog.set([]);
	_seenIds.clear();
}

function _pushNotification(record: AlertRecord): void {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
	const title = record.message || `${record.detectionType} detected`;
	const body  = `Monitor: ${record.monitorLabel}${record.sourceId ? ' · ' + record.sourceId : ''}`;
	try {
		const n = new Notification(title, {
			body,
			// One notification slot per monitor — new alert replaces previous one
			// in the OS tray so the tray doesn't fill up during a sustained event.
			tag: `senstry-${record.monitorPubkey}`,
			requireInteraction: false,
		});
		n.onclick = () => { window.focus(); n.close(); };
	} catch (e) {
		dbg('warn', 'nostr', `notification display failed: ${e}`);
	}
}
