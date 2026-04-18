import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode, decode } from 'nostr-tools/nip19';
import { openDB } from '$lib/db/idb';

const KEY_STORE = 'settings';
const PRIVKEY_KEY = 'identity.privkey';

export interface Identity {
	privkey: Uint8Array;
	pubkey: string;
}

export async function loadOrCreateIdentity(): Promise<Identity> {
	const db = await openDB();
	const stored = await db.get(KEY_STORE, PRIVKEY_KEY);
	if (stored) {
		const privkey = new Uint8Array(stored as ArrayBuffer);
		return { privkey, pubkey: getPublicKey(privkey) };
	}
	const privkey = generateSecretKey();
	await db.put(KEY_STORE, privkey.buffer, PRIVKEY_KEY);
	return { privkey, pubkey: getPublicKey(privkey) };
}

export async function importFromNsec(nsec: string): Promise<Identity> {
	const decoded = decode(nsec);
	if (decoded.type !== 'nsec') throw new Error('Not an nsec key');
	const privkey = decoded.data;
	const db = await openDB();
	await db.put(KEY_STORE, privkey.buffer, PRIVKEY_KEY);
	return { privkey, pubkey: getPublicKey(privkey) };
}

export function toNsec(privkey: Uint8Array): string {
	return nsecEncode(privkey);
}

export function toNpub(pubkey: string): string {
	return npubEncode(pubkey);
}

export function hexToPubkey(hex: string): string {
	return hex;
}
