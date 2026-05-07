import { openDB } from './idb';

export interface PhotoRecord {
	photoId: string;
	blob: Blob;
	mimeType: string;
	width: number;
	height: number;
	capturedAt: number;   // unix seconds
	sizeBytes: number;
	pinned: boolean;
	originMonitor: string;
}

export async function savePhoto(
	blob: Blob,
	mimeType: string,
	width: number,
	height: number,
	capturedAt: number,
	originMonitor: string
): Promise<string> {
	const photoId = crypto.randomUUID();
	const record: PhotoRecord = {
		photoId, blob, mimeType, width, height,
		capturedAt,
		sizeBytes: blob.size,
		pinned: false,
		originMonitor
	};
	const db = await openDB();
	await db.put('photos', record);
	return photoId;
}

export async function getPhoto(photoId: string): Promise<PhotoRecord | undefined> {
	const db = await openDB();
	return db.get('photos', photoId) as Promise<PhotoRecord | undefined>;
}

export async function getPhotosInRange(fromUnix: number, toUnix: number, originMonitor?: string): Promise<PhotoRecord[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('photos', 'capturedAt') as PhotoRecord[];
	return all.filter((p) =>
		p.capturedAt >= fromUnix &&
		p.capturedAt <= toUnix &&
		(originMonitor == null || p.originMonitor === originMonitor)
	);
}

export async function pinPhoto(photoId: string, pinned: boolean): Promise<void> {
	const db = await openDB();
	const photo = await db.get('photos', photoId) as PhotoRecord | undefined;
	if (photo) await db.put('photos', { ...photo, pinned });
}

export async function deletePhoto(photoId: string): Promise<void> {
	const db = await openDB();
	await db.delete('photos', photoId);
}

export async function deletePhotos(photoIds: string[]): Promise<void> {
	const db = await openDB();
	const tx = db.transaction('photos', 'readwrite');
	await Promise.all(photoIds.map((id) => tx.store.delete(id)));
	await tx.done;
}

export async function getPhotosStorageUsed(originMonitor?: string): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('photos') as PhotoRecord[];
	return all
		.filter((p) => originMonitor == null || p.originMonitor === originMonitor)
		.reduce((s, p) => s + p.sizeBytes, 0);
}
