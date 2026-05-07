import { openDB as idbOpenDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'senstry';
export const DB_VERSION = 3;

let _db: IDBPDatabase | null = null;

export function _resetDbForTest(): void {
	_db = null;
}

export async function openDB(): Promise<IDBPDatabase> {
	if (_db) return _db;
	_db = await idbOpenDB(DB_NAME, DB_VERSION, {
		upgrade(db, oldVersion) {
			if (oldVersion < 1) {
				db.createObjectStore('settings');
				const devices = db.createObjectStore('pairedDevices', { keyPath: 'pubkey' });
				devices.createIndex('addedAt', 'addedAt');
				const events = db.createObjectStore('events', { keyPath: 'id' });
				events.createIndex('created_at', 'created_at');
				events.createIndex('type', 'type');
			}
			if (oldVersion < 2) {
				if (db.objectStoreNames.contains('clips')) db.deleteObjectStore('clips');
				if (db.objectStoreNames.contains('clipIndex')) db.deleteObjectStore('clipIndex');
				const seg = db.createObjectStore('segments', { keyPath: 'segmentId' });
				seg.createIndex('startTime', 'startTime');
				seg.createIndex('pinned_start', ['pinned', 'startTime']);
			}
			if (oldVersion < 3) {
				// New stores
				const invites = db.createObjectStore('pendingInvites', { keyPath: 'inviteId' });
				invites.createIndex('expiresAt', 'expiresAt');
				invites.createIndex('status', 'status');

				const refs = db.createObjectStore('footageRefs', { keyPath: 'refId' });
				refs.createIndex('originMonitor', 'originMonitor');
				refs.createIndex('startTime', 'startTime');
				refs.createIndex('type', 'type');
				refs.createIndex('pinned_start', ['pinned', 'startTime']);

				const photos = db.createObjectStore('photos', { keyPath: 'photoId' });
				photos.createIndex('capturedAt', 'capturedAt');
				photos.createIndex('originMonitor', 'originMonitor');

				const outbox = db.createObjectStore('outbox', { keyPath: 'outboxId' });
				outbox.createIndex('status', 'status');
				outbox.createIndex('kind', 'kind');
				outbox.createIndex('createdAt', 'createdAt');

				// Add new indexes to events store
				// (existing store — only add indexes not present from older migrations)
				// originMonitor and publishedAt are new fields; we can't add indexes without
				// recreating the store, so we rely on the field being present on new records.
			}
		}
	});
	return _db;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
	const db = await openDB();
	return db.get('settings', key) as Promise<T | undefined>;
}

export async function putSetting<T>(key: string, value: T): Promise<void> {
	const db = await openDB();
	await db.put('settings', value, key);
}
