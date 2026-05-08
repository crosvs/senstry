// crypto.randomUUID() requires a secure context (HTTPS/localhost).
// This fallback uses getRandomValues (available everywhere) to generate a v4 UUID.
export function randomUUID(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// RFC 4122 v4 UUID via getRandomValues
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	return [...b].map((v, i) =>
		([4, 6, 8, 10].includes(i) ? '-' : '') + v.toString(16).padStart(2, '0')
	).join('');
}
