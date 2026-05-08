import { openDB } from './idb';
import { randomUUID } from '$lib/utils';

export interface PendingInvite {
	inviteId: string;
	secret: string;       // 32-byte hex random, embedded in QR — verified on ack
	createdAt: number;    // unix ms
	expiresAt: number;    // unix ms
	status: 'pending' | 'consumed' | 'expired';
	consumedBy: string | null;
}

export async function createInvite(ttlMs = 5 * 60 * 1000): Promise<PendingInvite> {
	const now = Date.now();
	const secretBytes = crypto.getRandomValues(new Uint8Array(32));
	const secret = Array.from(secretBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
	const invite: PendingInvite = {
		inviteId: randomUUID(),
		secret,
		createdAt: now,
		expiresAt: now + ttlMs,
		status: 'pending',
		consumedBy: null
	};
	const db = await openDB();
	await db.put('pendingInvites', invite);
	return invite;
}

export async function getInvite(inviteId: string): Promise<PendingInvite | undefined> {
	const db = await openDB();
	return db.get('pendingInvites', inviteId) as Promise<PendingInvite | undefined>;
}

export async function consumeInvite(inviteId: string, consumedBy: string): Promise<boolean> {
	const db = await openDB();
	const invite = await db.get('pendingInvites', inviteId) as PendingInvite | undefined;
	if (!invite) return false;
	if (invite.status !== 'pending') return false;
	if (Date.now() > invite.expiresAt) {
		await db.put('pendingInvites', { ...invite, status: 'expired' });
		return false;
	}
	await db.put('pendingInvites', { ...invite, status: 'consumed', consumedBy });
	return true;
}

// Mark all past-expiry pending invites as expired. Call on app start and periodically.
export async function expireStalePendingInvites(): Promise<void> {
	const db = await openDB();
	const all = await db.getAll('pendingInvites') as PendingInvite[];
	const now = Date.now();
	for (const invite of all) {
		if (invite.status === 'pending' && now > invite.expiresAt) {
			await db.put('pendingInvites', { ...invite, status: 'expired' });
		}
	}
}

export async function getPendingInvites(): Promise<PendingInvite[]> {
	const db = await openDB();
	const all = await db.getAllFromIndex('pendingInvites', 'status', 'pending') as PendingInvite[];
	return all.filter((i) => Date.now() <= i.expiresAt);
}
