# Signal Exchange

Signal kinds 5001–5006 and 5010–5011 are the universal mechanism for all device-to-device communication after contact establishment. This document is the canonical reference for their definitions, addressing, routing, and publishing. Other documents ([webrtc-session.md](webrtc-session.md), [pairing.md](pairing.md)) reference these kinds but do not redefine them.

---

## Signal Kind Reference

> This document is the canonical reference for all post-contact signal kinds (5001–5006, 5010–5011). Other documents that reference these kinds link here and do not redefine them.

Each signal type has its own Nostr kind. Relays cannot filter by encrypted content, so targeted fetching requires a dedicated kind per type. Within each kind, `isResponse` distinguishes the initiating party from the responding party — no paired type strings are needed.

| Kind | Name | Direction | TTL | isResponse semantics |
|------|------|-----------|-----|----------------------|
| 5001 | RTC Session | Viewer → Monitor (req), Monitor → Viewer (resp) | ~10s | `false` = offer-request (viewer declares mode); `true` = SDP offer (monitor responds) |
| 5002 | RTC Answer | Viewer → Monitor | ~10s | `false` = SDP answer (viewer completes handshake); `true` = ack (monitor, optional) |
| 5003 | RTC Hangup | Either direction | ~10s | `false` = session close; `true` = ack (optional) |
| 5004 | Status | Either direction | ~3600s | `false` = presence announcement; `true` = reply to announcement |
| 5005 | Relay Migration | Proposer → Acknowledger | ~300s | `false` = inbound relay proposal; `true` = acknowledgement (proof of delivery) |
| 5006 | Remote Command | Either direction | ~30s signal; `payload.ttl` per command | `false` = TOTP-authorized command; `true` = ack after TOTP validation |
| 5010 | Trigger | Monitor → Viewer | ~10s | Broadcast only — sensor fired notification |
| 5011 | Arm State | Monitor → Viewer | ~10s | Broadcast only — monitor armed or disarmed |

Kinds 5010 and 5011 are action signals (pipeline → Nostr). They share the same NIP-44 over ECDH channel key mechanism and flow through the signal router alongside 5001–5006.

### Kind Allocation

| Range | Purpose |
|-------|---------|
| 5001–5006 | Contact signals (RTC handshake, status, relay migration, remote command) |
| 5010–5011 | Action signals (trigger notifications, arm state) |
| 5100 | QR/Mailbox Acceptance (pairing — not a signal kind) |
| 5201 | TOTP Mailbox Delivery (pre-contact, one-shot — not a signal kind) |

Kinds 5100 and 5201 are not routed through the signal router and are not defined here.

### Payload Shapes

```typescript
interface RtcSessionPayload {
  sessionId: string;
  mode?: "live" | "data"; // isResponse=false only
  sdp?: string;           // isResponse=true only
  isResponse: boolean;
}

// channelId is sent as a separate live-request message on the data channel (not in the offer-request payload) — the monitor learns the channelId from the in-band live-request, not from the Nostr signal. See [webrtc-data-channel.md](webrtc-data-channel.md) § live-request.

interface RtcAnswerPayload {
  sessionId: string;
  sdp?: string;  // isResponse=false: the SDP answer
  isResponse: boolean;
}

interface RtcHangupPayload {
  sessionId: string;
  isResponse: boolean;
}

interface StatusPayload {
  state: "online" | "offline";
  isResponse: boolean;
}

interface RelayMigrationPayload {
  sessionId: string;
  newRelays?: string[]; // isResponse=false: proposed relay list
  timestamp: number;
  isResponse: boolean;
}

interface RemoteCommandPayload {
  commandId: string;
  credential: string;           // 6-digit TOTP code or base32 seed
  credential_type: "seed" | "code";
  ttl: number;                  // command validity window in seconds
  created_at: number;
  isResponse: boolean;
  accepted?: boolean;           // isResponse=true only
  payload?: {
    type: string;               // handler key: "relay-migrate-command", etc.
    [key: string]: unknown;
  };
}

interface TriggerPayload {
  detectionType: string;       // e.g. 'motion', 'audio', 'schedule'
  confidence: number;          // 0–1
  timestamp: number;           // ms since epoch, detection fire time
  sensorId: string;            // id of the sensor that fired
}

interface ArmStatePayload {
  armed: boolean;
  timestamp: number;           // ms since epoch
}
```

---

## Signal Addressing Modes

Post-contact signals support two addressing modes distinguished by the presence of the `#s` tag on the Nostr event.

**Broadcast (not filtered by `#s`):** Any active session on the channel receives and processes the event. Used when the target session is unknown or the signal is relevant regardless of which session is active. Kind 5004 events carry `#s` as a metadata tag for the sender's session UUID, but broadcast subscriptions do not filter by it.

**Session-directed (`#s: targetSessionUUID`):** Only the session whose UUID matches the tag acts on the event. All other sessions on the same channel ignore it. Used for stateful interactions requiring a specific live counterpart.

The session UUID is generated fresh on every startup. Peers learn the current session UUID from the most recent kind 5004 announcement, which carries `#s` as a plaintext tag on the event (not in the encrypted content). Session-directed signals sent to a stale UUID go unanswered; the sending peer waits for a new kind 5004 before retrying.

| Kind | Mode | Reason |
|------|------|--------|
| 5004 Status | Broadcast | Announces presence and current session UUID to all sessions |
| 5010 Trigger | Broadcast | Notification reaches any active session |
| 5011 Arm State | Broadcast | State change reaches any active session |
| 5001 RTC Session | Session-directed | Handshake requires a specific live session counterpart |
| 5002 RTC Answer | Session-directed | Completes handshake with the initiating session |
| 5003 RTC Hangup | Session-directed | Closes a specific session's RTC connection |
| 5005 Relay Migration | Session-directed | Session-stateful relay negotiation |
| 5006 Remote Command | Session-directed | Command targets a specific session |

---

## Signal Transmission

Every signal is published via `nostrClient.publishSignal(contactId, kind, payload)` or `nostrClient.publishSignalDirect(contactId, kind, payload)`. Relay selection, channel key lookup, and encryption are all internal.

```
Event structure on relay:
  pubkey:     sender's outboundChannelPubkey (ECDH-derived for paired; ephemeral for temp)
  kind:       5001–5006 or 5010–5011
  created_at: honest unix timestamp
  tags:       [["s", targetSessionUUID]]  — session-directed only; absent for broadcast
  content:    NIP-44 ciphertext (ChaCha20-Poly1305 over ECDH channel key)
```

No real pubkeys appear. No `#p` tags appear on post-contact signals. The relay sees only pseudonymous channel pubkeys and opaque ciphertext.

**`publishSignal` vs `publishSignalDirect`:**

- `publishSignal` — queued, rate-safe. Default for all post-contact communication.
- `publishSignalDirect` — immediate, bypasses the queue. Use only for time-sensitive signals where delay makes the signal useless: status announcements (5004), RTC handshake (5001, 5002), relay migration ack (5005).

Both accept `(contactId, kind, payload)`. Relay and key selection are identical.

---

## Signal Router

The signal router is a long-lived subscription set managed inside `NostrClient`. Modules start it once and receive decoded, decrypted signals via a callback — no relay or channel key management required.

```typescript
nostrClient.startSignalRouter((contactId, kind, payload) => {
  routeSignal(contactId, kind, payload);
});
```

```typescript
type SignalRouterCallback = (contactId: string, kind: number, payload: object) => void
```

The router maintains **two concurrent subscriptions per contact**, reflecting the two addressing modes. The subscription JSON blocks below are per-contact — the router opens one broadcast and one session-directed subscription for each registered contact, with the `"authors"` field set to that contact's `inboundChannelPubkey`.

**Broadcast subscription:**
```json
{
  "kinds": [5004, 5010, 5011],
  "authors": ["inboundChannelPubkey"],
  "since": now
}
```

**Session-directed subscription:**
```json
{
  "kinds": [5001, 5002, 5003, 5005, 5006],
  "authors": ["inboundChannelPubkey"],
  "#s": ["mySessionUUID"],
  "since": now
}
```

Both subscriptions are T+0 (`since: now`). Both span all relays in `ContactManager.allMyInboundRelays()`. Incoming events are decrypted before delivery to `onSignal`.

On receiving kind 5004, the router calls `ContactManager.updatePeerSession(contactId, sessionUUID)` using the plaintext `#s` tag — no decryption needed to extract the session UUID.

### Dispatch Table

The router delivers each decoded signal to the appropriate handler based on kind and `isResponse`:

| Kind | isResponse | Handler |
|------|------------|---------|
| 5001 | `false` | Monitor handler — `handleOfferRequest()` |
| 5001 | `true` | Viewer handler — `handleOffer()` |
| 5002 | `false` | Monitor handler — `handleAnswer()` |
| 5003 | `false` or `true` | Both viewer and monitor handlers — each checks its own session map and closes the matching session |
| 5004 | `false` | Router calls `notifyPresenceChange(contactId, 'online' \| 'offline')`, then replies with `isResponse=true` if conditions allow |
| 5004 | `true` | Router calls `notifyPresenceChange(contactId, 'online' \| 'offline')` — no reply sent |
| 5005 | `false` | Relay migration handler — `handleRelayMigrationProposal()` |
| 5005 | `true` | Relay migration handler — `handleRelayMigrationAck()` |
| 5006 | `false` | `RemoteCommandController` — validates TOTP and dispatches command |
| 5010 | — | Viewer handler — `handleTriggerSignal()` |
| 5011 | — | Viewer handler — `handleArmStateSignal()` |

`notifyPresenceChange` is a callback passed to the signal router at startup — it is not a `ContactManager` method. `ContactManager` does not store presence state; presence is consumer-managed state delivered via this callback. `ContactManager.updatePeerSession(contactId, sessionUUID)` is called separately on kind 5004 to record the peer's current session UUID from the plaintext `#s` tag (no decryption required).

When a contact is registered, updated (`updatePairedRelays`), or expired, the router re-subscribes using the transition lifecycle: a new relay REQ is opened and verified before the old one closes, ensuring no coverage gap.

Kind 5201 (TOTP Mailbox) is not routed through the signal router — it uses a separate one-shot subscription managed during pairing.

---

## Signal Fetching Strategy

### T+0 Subscriptions

All subscriptions open at T+0 (`since: now`) and deliver future events only. The signal router never replays history. History is always an intentional, separate operation.

### Progressive History Fetch

`fetchKindHistory(contactId, kind, opts)` is the only mechanism for retrieving past signals. It yields events newest-first, decrypts before delivery, and resolves relay lists and channel keys from `contactId` internally.

```typescript
async function* fetchKindHistory(
  contactId: string,
  kind: number,
  opts?: { windowStart?: number; windowEnd?: number }
): AsyncGenerator<NostrEvent>
```

Each `next()` call issues one fan-fetch round: every non-cooldown relay in the contact's outbound relay list receives a `limit: 1` REQ simultaneously. Results are deduplicated by event ID and yielded to the caller. The caller `break`s when it finds what it needs — no unnecessary fetching.

**Watermark:** Track the latest `created_at` seen per kind, per contact. Pass it as `windowStart` on fetch to avoid re-processing events already handled.

```typescript
interface SignalWatermark {
  [contactId: string]: {
    5004?: number;
    5005?: number;
    5006?: number;
    5010?: number;
    5011?: number;
  };
}
```

### Full-Range Catch-Up

When the goal is all events in a window rather than the most recent one, iterate without breaking:

```typescript
const missedActions: NostrEvent[] = [];
const lastOnlineSec = getLastOnlineTimestamp();

for await (const event of nostrClient.fetchKindHistory(contactId, 5010, {
  windowStart: lastOnlineSec,
})) {
  missedActions.push(event);
}

for (const event of missedActions.reverse()) {
  handleTriggerEvent(event);
}
```

The generator stops automatically when `windowStart` is reached or all relays return empty. Rate-limit pacing is automatic via `RelayStateController`.

### Per-Kind Fetch Strategies

| Kind | When to fetch | Goal | Stop condition |
|------|--------------|------|----------------|
| 5004 Status | After coming online | Last known peer state | First `isResponse=false` found |
| 5005 Relay Migration | Startup | Pending unacknowledged proposal | First `isResponse=false` without matching ack |
| 5006 Remote Command | Startup / reconnect | Pending unacknowledged commands | Newest unacknowledged command per contact |
| 5010/5011 Action Signals | After coming online | All missed actions | `windowStart` reached (full range) |

History fetch bypasses the `#s` session gate — all past events are retrieved regardless of session UUID.

---

## Publish Relay Selection

Each signal publish targets **one relay** chosen by `RelayStateController.selectRelay()` from the contact's outbound relay list. There is no broadcast or fanout on publish — the receiver's T+0 subscription spans all their inbound relays, so the event landing on any one is sufficient for delivery. For the full relay selection mechanics (LRU selection, cooldown recording, re-enqueue behavior), see [nostr-client.md § Pattern 3: Relay Selection for Publish](nostr-client.md#pattern-3-relay-selection-for-publish).

---

## Real-Time Signals

### Status (Kind 5004)

Status is broadcast — no `#s` filter. `publishSignalDirect` is always used because a delayed status announcement is useless.

**On device startup:**
```typescript
for (const contactId of nostrClient.allContactIds()) {
  await nostrClient.publishSignalDirect(contactId, 5004, {
    state: "online",
    isResponse: false,
  });
}
```

The signal router handles the reply side: on receiving kind 5004 with `isResponse=false`, the peer replies with its own `isResponse=true` announcement. This is the mechanism by which both devices confirm mutual presence.

**Startup grace period:** For 20 seconds after the router starts, auto-replies to kind 5004 announcements are suppressed. This prevents a flood of mutual-presence replies when multiple contacts come online simultaneously at startup. The router still calls `notifyPresenceChange` during the grace period — only the outbound reply is held.

**Manual solicitation:** Either device sends kind 5004 `isResponse=false` to request a reply from the other side. The receiving peer treats any `isResponse=false` as both an announcement and a reply solicitation.

### RTC Signaling (Kinds 5001–5003)

All three are session-directed. Full session lifecycle details are in [webrtc-session.md](webrtc-session.md). The signal kinds are defined here.

```
Viewer: publishSignalDirect(monitorId, 5001, { mode: 'data', sessionId, isResponse: false })
Monitor: publishSignalDirect(viewerId, 5001, { sdp, sessionId, isResponse: true })
Viewer: publishSignalDirect(monitorId, 5002, { sdp: answerSdp, sessionId, isResponse: false })
[RTC connection established over data channels]
```

Live upgrade (adding media tracks) reuses kinds 5001 and 5002. The trigger comes from within the RTC data channel; the Nostr round-trip is two events.

---

## Action Signals (Pipeline → Nostr)

Action signals are the Nostr output of the Senstry pipeline. When a sensor fires and the pipeline resolves a Nostr notification, `TriggerPublisher` sends a kind 5010 or 5011 signal to specific paired contacts. Footage is never sent over Nostr — the kind 5010 payload carries only metadata (detection type, confidence, timestamp). Viewers request actual segments over the RTC data channel.

### TriggerPublisher

`TriggerPublisher` resolves the target contact list and calls `nostrClient.publishSignal(contactId, kind, payload)` for each. The payload contracts (`TriggerPayload`, `ArmStatePayload`) are defined in the Payload Shapes section above. Constructor, `fire()`, and `setArmed()` signatures are in [sentry-controllers.md](sentry-controllers.md) § TriggerPublisher. `publishSignal` (queued) is used because trigger notifications are not time-sensitive at the Nostr layer — the viewer will catch up via history fetch if offline.

### Reception

Action signals arrive through the signal router alongside all other kinds:

```typescript
nostrClient.startSignalRouter((contactId, kind, payload) => {
  if (kind === 5010) handleTriggerSignal(contactId, payload as TriggerPayload);
  if (kind === 5011) handleArmStateSignal(contactId, payload as ArmStatePayload);
});
```

### Catching Up on Missed Actions

A viewer that was offline fetches missed actions on reconnect via full-range history fetch (see [Full-Range Catch-Up](#full-range-catch-up)):

```typescript
const lastOnlineSec = getLastOnlineTimestamp();

for (const contactId of nostrClient.allContactIds()) {
  for await (const event of nostrClient.fetchKindHistory(contactId, 5010, {
    windowStart: lastOnlineSec,
  })) {
    handleTriggerSignal(contactId, event.decryptedPayload as TriggerPayload);
  }

  for await (const event of nostrClient.fetchKindHistory(contactId, 5011, {
    windowStart: lastOnlineSec,
  })) {
    handleArmStateSignal(contactId, event.decryptedPayload as ArmStatePayload);
  }
}
```

Action signals accumulate on relay (no TTL enforcement for history fetch). The default history window is 2 days — see [nostr-client.md](nostr-client.md) for fetch semantics. Pass an explicit `windowStart` to limit cost.

---

## Relay Migration (Kind 5005)

Each device has independent inbound and outbound relay lists. A device that wants to change its listening relays proposes the change over Nostr; the peer acknowledges by proving it can reach the new relay. Communication never breaks because outbound (the direction toward the peer) remains stable until the peer has committed its new outbound relay.

### Migration Flow

**Step 1 — Proposer starts dual-listening and sends proposal:**

```typescript
nostrClient.requestRelayMigrationListening(
  contactId,
  newInbound,
  async (since) => {
    // onReady: confirmed active on new relays — safe to proceed
    contact.relayProposal = { sessionId, newInbound, proposedAt: since };
    await savePairedContact(contact);

    nostrClient.publishSignalDirect(contactId, 5005, {
      isResponse: false,
      sessionId,
      newRelays: newInbound,
      timestamp: since,
    });
  },
);
```

The `onReady` callback fires when the new relay subscription is confirmed active. This prevents the race where the proposer sends the proposal before being ready to receive the acknowledgement.

**Step 2 — Acknowledger updates outbound and sends proof:**

```typescript
nostrClient.startSignalRouter((contactId, kind, payload) => {
  if (kind === 5005 && !payload.isResponse) {
    const msg = payload as RelayMigrationPayload;
    nostrClient.updatePairedRelays(contactId, msg.newRelays);
    nostrClient.publishSignalDirect(contactId, 5005, {
      isResponse: true,
      sessionId: msg.sessionId,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
});
```

`updatePairedRelays` commits the new outbound relay list. The acknowledgement is sent to the new relay — proving the proposer's new inbound is reachable.

**Step 3 — Proposer receives ack and commits:**

```typescript
const ack = await nostrClient.waitForSignal(contactId, {
  kind: 5005,
  filter: (p) => p.isResponse && p.sessionId === sessionId,
  timeoutMs: 30_000,
});

if (ack) {
  contact.relayProposal = null;
  nostrClient.updatePairedRelays(contactId, newInbound);
  await savePairedContact(contact);
}
```

### Key Properties

- **Communications never break.** The proposer's outbound (toward the peer) is unchanged throughout. The peer's outbound is updated immediately on receiving the proposal — before sending the ack. The ack is sent to the new inbound relay, where the proposer is already dual-listening.
- **Multiple concurrent proposals are safe.** Each proposal has a unique `sessionId`. The proposer waits for an ack matching only its latest sessionId; earlier proposals are implicitly superseded.
- **Reload-resilient.** `relayProposal` is persisted to IDB before the proposal is sent. On startup, any pending relay migrations stored in IDB are resumed automatically — dual-listening is restored and the ack wait continues without re-sending the proposal.
- **Each device autonomously controls only its own inbound.** A device never proposes changes to the peer's inbound relay list — it only proposes changes to its own.

---

On `goOnline()`, a kind 5004 announcement is published to all paired contacts before the gate opens. On `goOffline()`, a kind 5004 offline announcement is published before the gate closes. See [nostr-client.md](nostr-client.md) for the gate implementation.

---

## Remote Command (Kind 5006)

Kind 5006 carries TOTP-authorized instructions. The payload shape is defined in the Signal Kind Reference above. Validation and dispatch are handled by `RemoteCommandController` (see [sentry-controllers.md](sentry-controllers.md)). The authorization model is described in [pairing.md](pairing.md).
