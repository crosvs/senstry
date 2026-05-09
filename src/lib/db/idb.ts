import { openDB as idbOpenDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'senstry';
export const DB_VERSION = 5;

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
				// segments store created in v4 block (OPFS-compatible schema, no blob field)
			}
			if (oldVersion < 3) {
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
			}
			if (oldVersion < 4) {
				// Migrate segments to OPFS-backed schema: drop blob field from IDB.
				// Existing segment data is cleared (blobs can't be migrated synchronously).
				if (db.objectStoreNames.contains('segments')) db.deleteObjectStore('segments');
				const seg = db.createObjectStore('segments', { keyPath: 'segmentId' });
				seg.createIndex('startTime', 'startTime');
				seg.createIndex('pinned_start', ['pinned', 'startTime']);
			}
			if (oldVersion < 5) {
				// v5 adds sourceId to segments and footageRefs.
				// Schema is unchanged (no new indexes); existing records without sourceId
				// are treated as 'default-mic' lazily at read time via `?? 'default-mic'`.
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

// Deletes the database entirely (forcing LevelDB compaction) while preserving all
// blob-free stores. The events store is dropped (legacy, may hold old blobs).
// The caller should reload the page immediately after this returns.
export async function compactDatabase(): Promise<void> {
	const db = await openDB();

	// Snapshot every store that holds no inline blobs.
	const settingKeys = await db.getAllKeys('settings') as IDBValidKey[];
	const settingVals = await db.getAll('settings');
	const devices = await db.getAll('pairedDevices');
	const invites = await db.getAll('pendingInvites');
	const refs = await db.getAll('footageRefs');
	const segments = await db.getAll('segments');
	const outboxItems = await db.getAll('outbox');

	db.close();
	_db = null;

	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(DB_NAME);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error('Database is blocked; close other tabs and retry'));
	});

	const fresh = await openDB();
	const tx = fresh.transaction(
		['settings', 'pairedDevices', 'pendingInvites', 'footageRefs', 'segments', 'outbox'],
		'readwrite'
	);
	for (let i = 0; i < settingKeys.length; i++) tx.objectStore('settings').put(settingVals[i], settingKeys[i]);
	for (const r of devices) tx.objectStore('pairedDevices').put(r);
	for (const r of invites) tx.objectStore('pendingInvites').put(r);
	for (const r of refs) tx.objectStore('footageRefs').put(r);
	for (const r of segments) tx.objectStore('segments').put(r);
	for (const r of outboxItems) tx.objectStore('outbox').put(r);
	await tx.done;
}
