import QRCode from 'qrcode';

export interface InvitePayload {
	v: 2;
	pk: string;        // inviter pubkey (hex)
	relays: string[];
	inviteId: string;  // UUID — references pendingInvites store
	secret: string;    // 32-byte hex — must be verified on ack
	expiresAt: number; // unix seconds
	label: string;     // inviter self-label — UI hint only, not stored as authoritative
}

export function encodeInviteUri(payload: InvitePayload): string {
	const json = JSON.stringify(payload);
	// btoa expects a binary string; use encodeURIComponent to handle unicode safely
	return 'senstry:' + btoa(unescape(encodeURIComponent(json))).replace(/=+$/, '');
}

export function decodeInviteUri(uri: string): InvitePayload {
	if (!uri.startsWith('senstry:')) throw new Error('Invalid pairing URI');
	const json = decodeURIComponent(escape(atob(uri.slice(8))));
	const payload = JSON.parse(json);
	if (payload.v !== 2) throw new Error(`Unsupported invite version: ${payload.v}`);
	return payload as InvitePayload;
}

export async function generateQRDataUrl(text: string): Promise<string> {
	return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', width: 300 });
}
