import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
	buildFootageRefEvent,
	buildFootageDigestEvent,
	KIND_FOOTAGE_REF,
} from './events';
import { decrypt } from './crypto';

// ── Keypair helpers ──────────────────────────────────────────────────────────

function makeKeypair() {
	const priv = generateSecretKey();
	return { priv, pub: getPublicKey(priv) };
}

const monitor = makeKeypair();
const viewer  = makeKeypair();

// ── buildFootageRefEvent ─────────────────────────────────────────────────────

describe('buildFootageRefEvent', () => {
	const ref = buildFootageRefEvent(
		monitor.priv, monitor.pub, viewer.pub,
		'ref-id-abc', 'audio', 1_000_000, 1_000_060, 1_000_030
	);

	it('uses kind 30020 (NIP-33 parameterized replaceable)', () => {
		expect(ref.kind).toBe(30020);
		expect(ref.kind).toBe(KIND_FOOTAGE_REF);
	});

	it('has p tag addressed to viewer', () => {
		const p = ref.tags.find(t => t[0] === 'p');
		expect(p).toBeDefined();
		expect(p![1]).toBe(viewer.pub);
	});

	it('has d tag matching refId', () => {
		const d = ref.tags.find(t => t[0] === 'd');
		expect(d?.[1]).toBe('ref-id-abc');
	});

	it('has version tag', () => {
		expect(ref.tags.some(t => t[0] === 'v' && t[1] === '2')).toBe(true);
	});

	it('is authored by the monitor', () => {
		expect(ref.pubkey).toBe(monitor.pub);
	});

	it('has a valid signature', () => {
		expect(verifyEvent(ref)).toBe(true);
	});

	it('content decrypts correctly with viewer key (NIP-44)', () => {
		const plain = decrypt(viewer.priv, monitor.pub, ref.content);
		const payload = JSON.parse(plain);
		expect(payload.refId).toBe('ref-id-abc');
		expect(payload.triggerType).toBe('audio');
		expect(payload.startTime).toBe(1_000_000);
		expect(payload.endTime).toBe(1_000_060);
		expect(payload.triggerTime).toBe(1_000_030);
		expect(payload.originMonitor).toBe(monitor.pub);
		expect(payload.deleted).toBe(false);
	});

	it('content cannot be decrypted with a random key', () => {
		const other = makeKeypair();
		expect(() => decrypt(other.priv, monitor.pub, ref.content)).toThrow();
	});
});

// ── buildFootageDigestEvent ──────────────────────────────────────────────────

const REFS = [
	{ refId: 'ref-1', triggerType: 'audio', startTime: 1_000, endTime: 1_060, triggerTime: 1_030 },
	{ refId: 'ref-2', triggerType: 'motion', startTime: 2_000, endTime: 2_060, triggerTime: 2_030 },
];

describe('buildFootageDigestEvent', () => {
	const digest = buildFootageDigestEvent(monitor.priv, monitor.pub, viewer.pub, REFS);

	it('uses kind 30020', () => {
		expect(digest.kind).toBe(KIND_FOOTAGE_REF);
	});

	it('has p tag addressed to viewer', () => {
		const p = digest.tags.find(t => t[0] === 'p');
		expect(p?.[1]).toBe(viewer.pub);
	});

	it('has a d tag starting with "digest-"', () => {
		const d = digest.tags.find(t => t[0] === 'd');
		expect(d?.[1]).toMatch(/^digest-\d+$/);
	});

	it('is authored by the monitor', () => {
		expect(digest.pubkey).toBe(monitor.pub);
	});

	it('has a valid signature', () => {
		expect(verifyEvent(digest)).toBe(true);
	});

	it('content decrypts to a digest payload with all refs', () => {
		const plain = decrypt(viewer.priv, monitor.pub, digest.content);
		const payload = JSON.parse(plain);
		expect(payload.type).toBe('digest');
		expect(payload.originMonitor).toBe(monitor.pub);
		expect(payload.refs).toHaveLength(2);
		expect(payload.refs[0].refId).toBe('ref-1');
		expect(payload.refs[1].refId).toBe('ref-2');
	});

	it('content cannot be decrypted with the wrong key', () => {
		const other = makeKeypair();
		expect(() => decrypt(other.priv, monitor.pub, digest.content)).toThrow();
	});
});

// ── Filter matching ──────────────────────────────────────────────────────────
// Simulates what the viewer's REQ filter does. If the relay correctly indexes
// #p tags and authors for kind 30020, this is the match logic it should use.

describe('subscription filter matching', () => {
	const digest = buildFootageDigestEvent(monitor.priv, monitor.pub, viewer.pub, REFS);

	function eventMatchesFilter(event: typeof digest, filter: {
		kinds?: number[];
		authors?: string[];
		'#p'?: string[];
	}): boolean {
		if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
		if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
		if (filter['#p']) {
			const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1]);
			if (!filter['#p'].some(v => pTags.includes(v))) return false;
		}
		return true;
	}

	it('matches viewer filter with authors + #p + kinds', () => {
		const filter = {
			kinds: [KIND_FOOTAGE_REF],
			authors: [monitor.pub],
			'#p': [viewer.pub],
		};
		expect(eventMatchesFilter(digest, filter)).toBe(true);
	});

	it('matches viewer filter with only authors + kinds (no #p)', () => {
		const filter = { kinds: [KIND_FOOTAGE_REF], authors: [monitor.pub] };
		expect(eventMatchesFilter(digest, filter)).toBe(true);
	});

	it('does NOT match a different viewer pubkey in #p filter', () => {
		const other = makeKeypair();
		const filter = { kinds: [KIND_FOOTAGE_REF], authors: [monitor.pub], '#p': [other.pub] };
		expect(eventMatchesFilter(digest, filter)).toBe(false);
	});

	it('does NOT match a different author', () => {
		const other = makeKeypair();
		const filter = { kinds: [KIND_FOOTAGE_REF], authors: [other.pub] };
		expect(eventMatchesFilter(digest, filter)).toBe(false);
	});

	it('does NOT match a different kind', () => {
		const filter = { kinds: [1], authors: [monitor.pub] };
		expect(eventMatchesFilter(digest, filter)).toBe(false);
	});
});
