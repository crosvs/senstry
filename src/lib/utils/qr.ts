import QRCode from 'qrcode';

export interface PairingPayload {
	v: number;
	pk: string;
	relay: string;
	label: string;
}

export function encodePairingUri(payload: PairingPayload): string {
	return 'senstry:' + btoa(JSON.stringify(payload)).replace(/=+$/, '');
}

export function decodePairingUri(uri: string): PairingPayload {
	if (!uri.startsWith('senstry:')) throw new Error('Invalid pairing URI');
	return JSON.parse(atob(uri.slice(8)));
}

export async function generateQRDataUrl(text: string): Promise<string> {
	return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', width: 300 });
}
