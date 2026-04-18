import { openDB as idbOpenDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'senstry';
export const DB_VERSION = 2;

let _db: IDBPDatabase | null = null;

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
				// Remove legacy clip stores if they exist
				if (db.objectStoreNames.contains('clips')) db.deleteObjectStore('clips');
				if (db.objectStoreNames.contains('clipIndex')) db.deleteObjectStore('clipIndex');
				// Continuous recording segments store
				const seg = db.createObjectStore('segments', { keyPath: 'segmentId' });
				seg.createIndex('startTime', 'startTime');
				seg.createIndex('pinned_start', ['pinned', 'startTime']);
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
