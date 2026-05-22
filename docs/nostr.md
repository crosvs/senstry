# Nostr

## Overview

Nostr is used exclusively as a **signaling and notification channel** — no media ever passes through a relay. The app uses two NIPs for privacy:

- **NIP-44** (ChaCha20-Poly1305) — encrypts event content between paired devices
- **NIP-59** (gift-wrap) — wraps signaling events with ephemeral one-time keys to hide sender/receiver identity from relay operators

## Event Kinds

| Kind | Name | Direction | Encryption | Description |
|------|------|-----------|------------|-------------|
| 1059 | Signal (gift-wrap) | Both | NIP-59 + NIP-44 | All WebRTC signaling (offer-request, offer, answer, hangup, ping, pong, status, status-request) |
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

## Nostr Online Gate (`store/nostr-online.ts`)

`nostrOnline` is a writable boolean store that gates all Nostr activity. No publish or signal is sent while it is `false`.

```typescript
export const nostrOnline = writable(false);
export const nostrOfflineReason = writable<string | null>(null);
```

### `goOnline()` / `goOffline()`

`goOnline()` sets `nostrOnline = true`. `SentrySection`'s `$effect` observes this and opens the signal router, then broadcasts an online announcement.

`goOffline()` must send the offline signal **before** setting `nostrOnline = false` so the signal can still publish:
1. Broadcasts `{ type: 'status', state: 'offline' }` to all paired devices
2. Calls `clearQueued()` — marks all pending outbox items as failed
3. Sets `nostrOnline = false`

### Auto-offline on relay errors

`reportPublishError(err)` is called by `client.ts` on every all-relay publish failure:
- Ignores `'rate-limited'` (local token bucket, not a relay error)
- Counts `'publish failed:'` and `'no relays configured'` errors
- After 3 consecutive failures: sets `nostrOfflineReason` and calls `goOffline()`
- `reportPublishSuccess()` resets the counter on any successful publish

## Presence / Status Protocol

Devices communicate Nostr online/offline status using `status` and `status-request` signal messages (kind 1059 gift-wrap, `STATUS_TTL_S = 3600` — accepted up to 1 hour after inner `created_at`).

### Announcement vs. awareness reply

| Field | Value | Meaning |
|-------|-------|---------|
| `isAnnounce: true` | present | "I just came online" broadcast to all paired devices |
| `isAnnounce` | absent | Awareness reply — "I see you, I'm also online" |

Only `isAnnounce: true` triggers an auto-reply. Awareness replies do not, preventing feedback loops.

### Protocol flow

```
Device A goes online
  → sends { type: 'status', state: 'online', isAnnounce: true } to all paired

Device B receives (if fresh ≤15s AND startup grace expired AND per-peer cooldown cleared)
  → calls updatePeerStatus('A', 'online', createdAt)
  → replies { type: 'status', state: 'online' }  (no isAnnounce)

Device A receives reply
  → calls updatePeerStatus('B', 'online', createdAt)
  → does NOT reply (no isAnnounce in received message)
```

**Rate-limit protection**: Three independent guards prevent awareness reply bursts on aggressive public relays (e.g. damus.io):

| Guard | Where | Value | Purpose |
|-------|-------|-------|---------|
| Startup grace | `signal-router.ts` | 20s after `startSignalRouter()` | Reserves rate-limit budget for WebRTC handshake at startup |
| Per-peer awareness cooldown | `signal-router.ts` | 60s per sender pubkey | Prevents reply bursts on relay replay/reconnect |
| Announcement cooldown | `SentrySection.startRouter()` | 60s per paired device | Prevents double announcements when relay URL changes |

`status-request` messages bypass the startup grace — they always get an immediate reply (used by the "Status?" button).

The `peerStatuses` store (`store/peer-status.ts`) holds the known state per pubkey. `updatePeerStatus` has a freshness guard using inner event `createdAt` — stale relay replays never overwrite a newer known state.

### Status request

The "Status?" button in DevicesSection sends `{ type: 'status-request' }`. The signal router auto-replies with the current online status without routing to application code.

## Client (`nostr/client.ts`)

Wraps `nostr-tools` `SimplePool` with:

### Rate Limiting

**Burst spacing**: Default 200 events/minute with minimum 300ms spacing between publishes. This ensures a burst of 200 events is spread evenly across exactly 1 minute, preventing relay rate-limit rejections.

- `setRateLimit(eventsPerMin)` — configure max events/minute (default 200)
- `getRateLimitAvailable()` — query current budget (floor of 60_000 / intervalMs)
- `getPublishRate()` — returns `{ last60s: number, max: number }` — publishes in the last 60 seconds and the configured max

Events that arrive while another publish is in-flight are queued and sent at the next available time slot. The queue is exposed as `publishQueue` store (see UI patterns below).

Per-semantic-key cooldown: prevents duplicate events being published for the same logical action within a short window (e.g. publishing the same arm-state twice).

### API

```typescript
subscribe(filter: Filter, handler: (event: NostrEvent) => void): { close: () => void }
publish(event: NostrEvent): Promise<void>
setRelayUrl(url: string): void
getRelayUrl(): string
```

Subscriptions are tracked. Calling `.close()` removes the subscription from the pool. On relay URL change, all active subscriptions are re-opened on the new relay.

### `publishQueue` Store

The `publishQueue` writable store tracks all pending publishes:

```typescript
export interface PendingPublish {
  id: string;       // nostr event id
  label: string;    // human description e.g. "signal:status"
  queuedAt: number; // Date.now() when enqueued
  estimatedAt: number; // best-guess epoch ms for actual send
}
```

Used by the `useNostrAction` hook to display queue position and ETA to the user.

## UI Pattern: `useNostrAction` Hook

**Core Rule: Every button that initiates a Nostr interaction must use `useNostrAction`.**

Nostr interactions fall into two categories with different UI patterns:

### 1. Publish (Rate-Limited Queue)
Events are queued and spaced apart. Show the queue position/ETA to the user.
- Button starts: "Send Email" / "Arm Monitor" / "Test Relay"
- While pending: "⏳ 2s" (shows queue ETA, updates in real-time)
- Click again to cancel: removes from queue before send

### 2. Subscribe/Listen (Active Subscription)
Subscriptions are active and waiting for events. User should see what's happening.
- Button starts: "Generate Invite QR" / "Request Status"
- While listening: "Cancel Invite" / "Stop Waiting" (clear what's being cancelled, NOT "⏳")
- Click to cancel: closes subscription immediately
- **DO NOT use "⏳ ETA" for listeners** — ETA only applies to publish queue

### Implementation Pattern

#### Single-Button Toggle (all interactions)

The button handling both action and cancel is **the only pattern allowed**. Never use separate cancel buttons.

```typescript
import { useNostrAction } from '$lib/nostr/use-nostr-action.svelte';

const statusAction = useNostrAction();

async function handleStatusClick() {
  await statusAction.run(onQueued =>
    sendSignal(privkey, pubkey, targetPubkey, { type: 'status-request' }, { onQueued })
  );
}
```

Template code (applies to both publish and subscribe/listen):

```svelte
<button onclick={statusAction.pending ? statusAction.cancel : handleStatusClick}>
  {statusAction.pending ? `⏳ ${statusAction.etaLabel}` : 'Status?'}
</button>
```

The same button changes both its onclick handler and text based on `pending` state. **Do not render separate cancel buttons.**

### Properties

- `pending` (boolean) — true while the publish is queued or in-flight
- `etaLabel` (string) — human-readable ETA (e.g. "2s", "sending…", empty when idle)
- `run(fn)` — execute async function; passes `onQueued(id, cancelFn)` callback for the publish helper to call
- `cancel()` — cancel the queued publish (no-op when not pending)

### Examples: Publish vs. Subscribe

**Publishing events** (arm state, test relay):
```typescript
// In component init
const armAction = useNostrAction();

// In handler
async function handleArmClick() {
  await armAction.run(onQueued =>
    publish(armEvent, { label: 'arm:armed', onQueued })
  );
}

// In template
<button onclick={armAction.pending ? armAction.cancel : handleArmClick}>
  {armAction.pending ? `⏳ ${armAction.etaLabel}` : 'Start Monitor'}
</button>
```

The button shows "⏳ 2s", "⏳ sending…" during queue/send, then reverts to "Start Monitor". Clicking while pending removes the event from queue.

**Subscriptions/listeners** (generate invite, request status):
```typescript
// In component init
const qrAction = useNostrAction();

// In handler
async function generateQR() {
  await qrAction.run(onQueued => {
    return new Promise<void>(async (resolve) => {
      const result = await createInviteQR(...);
      // Show QR
      
      let cancelled = false;
      const sub = listenForInviteAck(async (pk, relays) => {
        if (cancelled) return;
        // Pairing succeeded
        // Clean up: clear QR, close subscription, etc.
        resolve();
      });
      
      onQueued('invite-listen', () => {
        cancelled = true;
        sub.close();
        // Clean up: clear QR, etc.
        resolve();
      });
    });
  });
}

// In template
<button onclick={qrAction.pending ? qrAction.cancel : generateQR}>
  {qrAction.pending ? 'Cancel Invite' : 'Generate Invite QR'}
</button>
```

The button shows "Cancel Invite" while listening for the pairing response. Clicking cancels the subscription immediately (no queue involved). **Never show "⏳" on listener buttons.**

**Key difference:**
- Publish: button shows "⏳ ETA" (time-in-queue). Click to remove from queue.
- Listen: button shows clear action like "Cancel Invite" or "Stop Waiting" (no "⏳"). Click to close subscription.

### State Cleanup (Subscriptions)

When wrapping a subscription in a `new Promise<void>()`, clean up UI state in **three places**:
1. **Success callback** — when the subscription resolves (e.g., pairing complete)
2. **Cancel callback** — when user clicks the button to cancel
3. **Error handler** — when an error occurs

Example from `generateQR()`:

```typescript
await qrAction.run(onQueued => {
  return new Promise<void>(async (resolve) => {
    try {
      const result = await createInviteQR(...);
      qrSrc = result.qrDataUrl;  // Show QR
      
      const sub = listenForInviteAck(async (pk, relays) => {
        // 1. SUCCESS: pairing complete
        await addPairedDevice({ pubkey: pk, ... });
        // Cleanup
        qrSrc = '';
        qrUri = '';
        qrCountdown = '';
        sub.close();
        if (countdownInterval) clearInterval(countdownInterval);
        resolve();
      });
      
      onQueued('invite-listen', () => {
        // 2. CANCEL: user clicked button
        sub.close();
        qrSrc = '';
        qrUri = '';
        qrCountdown = '';
        if (countdownInterval) clearInterval(countdownInterval);
        resolve();
      });
    } catch (e) {
      // 3. ERROR: exception during setup
      qrSrc = '';
      qrUri = '';
      qrCountdown = '';
      if (countdownInterval) clearInterval(countdownInterval);
      throw e;
    }
  });
});
```

This ensures the UI always returns to a clean state regardless of how the subscription ends.

### Relay Query Optimization

For subscriptions, pass `since` to avoid querying the relay for old events:

```typescript
export function listenForInviteAck(
  privkey: Uint8Array,
  pubkey: string,
  handler: (scannerPubkey: string, relays: string[]) => void,
  opts?: { since?: number }
): { close: () => void } {
  return subscribe(
    { kinds: [5000], '#p': [pubkey], since: opts?.since ?? Math.floor(Date.now() / 1000) },
    handler
  );
}
```

When calling from a button handler, pass the current time:

```typescript
const sub = listenForInviteAck(privkey, pubkey, handler, { since: Math.floor(Date.now() / 1000) });
```

This prevents the relay from replaying old invites, keeping startup latency low and respecting rate limits.

### Passing callbacks to helpers

Any helper that performs Nostr operations (publish, subscribe, listen) should accept optional callbacks for tracking:

```typescript
export async function sendSignal(
  privkey: Uint8Array,
  pubkey: string,
  targetPubkey: string,
  msg: SignalMessage,
  opts?: { onQueued?: (id: string, cancel: () => void) => void }
): Promise<void> {
  const event = buildSignal(privkey, pubkey, targetPubkey, msg);
  const { cancel } = await client.publish(event);
  opts?.onQueued?.(event.id, cancel);
}
```

For publish: `cancel()` removes the event from the queue if it hasn't sent yet.

For subscribe: `cancel()` should close the subscription so the UI is no longer waiting.

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

The flusher is gated on `nostrOnline` — it returns early if Nostr is offline, preventing blind retries that would accumulate and burst on reconnect. `clearQueued()` marks all queued items as `failed` immediately when going offline.

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
