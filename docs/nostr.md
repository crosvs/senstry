# Nostr

## Overview

Nostr is used exclusively as a **signaling and notification channel** — no media ever passes through a relay. The app uses two NIPs for privacy:

- **NIP-44** (ChaCha20-Poly1305) — encrypts event content between paired devices
- **NIP-59** (gift-wrap) — wraps signaling events with ephemeral one-time keys to hide sender/receiver identity from relay operators

## Event Kinds

| Kind | Name | Direction | Encryption | Description |
|------|------|-----------|------------|-------------|
| 1059 | Signal (gift-wrap) | Both | NIP-59 + NIP-44 | All WebRTC signaling (offer-request, offer, answer, hangup, ping, pong) |
| 5000 | Invite Ack | Viewer → Monitor | NIP-44 | Pairing acknowledgement with scanner pubkey + relay list |
| 5010 | Trigger | Monitor → Viewer | NIP-44 | Detection event (sensor fired, with metadata) |
| 5011 | Arm State | Monitor → Viewer | NIP-44 | Monitor armed or disarmed |
| 5022 | Backup Request | Viewer → Monitor | NIP-44 | Ask monitor to send footage for local backup |
| 5023 | Backup Ack | Monitor → Viewer | NIP-44 | Confirm backup received |
| 5024 | Resync Request | Viewer → Monitor | NIP-44 | Ask monitor to re-publish all footage refs since timestamp |
| 30020 | Footage Ref | Monitor → Viewer | NIP-44 | Trigger window metadata (NIP-33 replaceable, `d`=refId) |
| 30021 | Footage Delete | Monitor → Viewer | None | Signals a footage ref has been deleted (`e` tag = original event ID) |

### Why NIP-33 for Footage Refs (30020)?

Kind 30020 is in the NIP-33 parameterized-replaceable range. Relays index these events by `(pubkey, kind, d-tag)` and return them on `REQ` with `#d` tag filters. This means a viewer that comes online after being offline can request all footage refs published since a given timestamp and the relay returns only the latest version of each ref (de-duplicated by `d` tag). Kind 5020 (NIP-90 DVM range) was considered but is not reliably returned on tag-filtered `REQ` queries.

## Encryption

### NIP-44 (`crypto.ts:encrypt` / `decrypt`)

Used for all non-signal event content. Encrypts a plaintext string to a specific recipient pubkey using a shared secret derived from ECDH (sender privkey + recipient pubkey).

```typescript
encrypt(senderPrivkey: Uint8Array, recipientPubkey: string, plaintext: string): string
decrypt(receiverPrivkey: Uint8Array, senderPubkey: string, ciphertext: string): string
```

Failure to decrypt (wrong key, tampered content) throws — callers catch and discard.

### NIP-59 Gift-wrap (`crypto.ts:giftWrap` / `giftUnwrap`)

Used exclusively for signaling. Wraps an inner "rumor" event with:
1. An ephemeral one-time key (discarded after use)
2. A random `created_at` offset (±2 days) to hide timing
3. The outer event published as kind 1059

The inner rumor is a real signed event (kind 5001) that includes:
- The actual signal payload as JSON in `content`
- `tags: [['p', recipientPubkey]]`
- Honest `created_at` (checked for TTL on receive)

```typescript
giftWrap(inner: NostrEvent, senderPrivkey: Uint8Array, recipientPubkey: string): NostrEvent
giftUnwrap(outer: NostrEvent, receiverPrivkey: Uint8Array): NostrEvent  // returns inner rumor
```

## Client (`nostr/client.ts`)

Wraps `nostr-tools` `SimplePool` with:

### Rate Limiting

Token bucket: default 200 events/minute. Refills at `nostrRateLimit / 60` tokens/second. When the bucket is empty, `publish()` is queued (not dropped).

Per-semantic-key cooldown: prevents duplicate events being published for the same logical action within a short window (e.g. publishing the same arm-state twice).

### API

```typescript
subscribe(filter: Filter, handler: (event: NostrEvent) => void): { close: () => void }
publish(event: NostrEvent): Promise<void>
setRelayUrl(url: string): void
getRelayUrl(): string
```

Subscriptions are tracked. Calling `.close()` removes the subscription from the pool. On relay URL change, all active subscriptions are re-opened on the new relay.

## Trigger Event Content

The payload of a kind 5010 event (NIP-44 encrypted):

```json
{
  "type": "audio",
  "sensorState": "active",
  "channelId": "default-channel",
  "sensorTiming": { "minDurationMs": 1000, "settlingMs": 5000 },
  "monitorLabel": "Front door",
  "timestamp": 1700000000,
  "data": { "peakDb": -22.4, "durationMs": 3200 },
  "message": "Loud noise detected",
  "footageRefId": "abc123..."
}
```

`footageRefId` links to a kind 30020 footage ref that the viewer can use to request the clip. If no footage ref has been published yet (trigger before recording started), this is `null`.

Tags on the outer kind 5010 event:
- `['p', viewerPubkey]` — for relay `#p` filter on subscriber
- `['d', monitorPubkey]` — monitor identifier
- `['t', detectionType]` — e.g. `'audio'`
- `['s', channelId]` — optional, for channel-scoped subscriptions

## Outbox

Events that fail to publish (relay offline, rate limit, network error) are queued in IDB `outbox` store. `outboxFlusher` runs in `+page.svelte` and retries queued events. This ensures no triggers are lost during transient relay outages.

## Keys (`nostr/keys.ts`)

Identity is a secp256k1 keypair:
- **Private key**: 32-byte `Uint8Array`, stored in IDB `settings['identity']`
- **Public key**: hex string, derived from privkey via `nostr-tools`

Helper functions:
- `encodeNsec(privkey)` / `decodeNsec(nsec)` — bech32 nsec encoding for export/import
- `encodeNpub(pubkey)` — bech32 npub for display

Keys are never stored in `localStorage`, query strings, or cookies. The private key is only loaded into memory during active use and is passed directly to crypto functions — never stored in component `$state`.

## Pairing Flow

1. Monitor generates a pairing invite: QR code encodes `{ pubkey, relay, label, inviteId, secret }`
2. Viewer scans QR, adds monitor to `pairedDevices`, sends kind 5000 `invite-ack` encrypted to monitor pubkey
3. Monitor receives ack, validates secret, adds viewer to `pairedDevices`
4. Both devices now have each other's pubkeys; all subsequent communication is encrypted to the counterpart's pubkey
