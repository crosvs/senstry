import { openDB } from './idb';

const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB

export interface ClipRecord {
	clipId: string;
	blob: Blob;
	mimeType: string;
	durationMs: number;
	created_at: number;
	sizeBytes: number;
}

export async function saveClip(
	triggerId: string,
	blob: Blob,
	mimeType: string,
	durationMs: number
): Promise<string> {
	const clipId = crypto.randomUUID();
	const db = await openDB();
	const quota = await getQuota();

	const record: ClipRecord = {
		clipId,
		blob,
		mimeType,
		durationMs,
		created_at: Math.floor(Date.now() / 1000),
		sizeBytes: blob.size
	};

	await db.put('clips', record);
	await db.put('clipIndex', clipId, triggerId);

	await evictIfNeeded(quota);
	return clipId;
}

export async function getClipByTriggerId(triggerId: string): Promise<ClipRecord | undefined> {
	const db = await openDB();
	const clipId = await db.get('clipIndex', triggerId) as string | undefined;
	if (!clipId) return undefined;
	return db.get('clips', clipId) as Promise<ClipRecord | undefined>;
}

export async function deleteClip(clipId: string, triggerId?: string): Promise<void> {
	const db = await openDB();
	await db.delete('clips', clipId);
	if (triggerId) await db.delete('clipIndex', triggerId);
}

async function evictIfNeeded(quotaBytes: number): Promise<void> {
	const db = await openDB();
	let allClips = await db.getAllFromIndex('clips', 'created_at') as ClipRecord[];
	let totalBytes = allClips.reduce((s, c) => s + c.sizeBytes, 0);

	while (totalBytes > quotaBytes && allClips.length > 0) {
		const oldest = allClips.shift()!;
		await db.delete('clips', oldest.clipId);
		totalBytes -= oldest.sizeBytes;

		const tx = db.transaction('clipIndex', 'readwrite');
		const keys = await tx.store.getAllKeys();
		for (const key of keys) {
			if (await tx.store.get(key) === oldest.clipId) {
				await tx.store.delete(key);
				break;
			}
		}
		await tx.done;
	}
}

export async function getQuota(): Promise<number> {
	const db = await openDB();
	const stored = await db.get('settings', 'clips.quotaBytes') as number | undefined;
	return stored ?? DEFAULT_QUOTA_BYTES;
}

export async function setQuota(bytes: number): Promise<void> {
	const db = await openDB();
	await db.put('settings', bytes, 'clips.quotaBytes');
}

export async function getStorageUsed(): Promise<number> {
	const db = await openDB();
	const all = await db.getAll('clips') as ClipRecord[];
	return all.reduce((s, c) => s + c.sizeBytes, 0);
}
