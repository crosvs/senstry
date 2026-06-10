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

**Broadcast (no session tags):** Any active session on the channel receives and processes the event. Broadcast kinds (5004, 5010, 5011) carry no `#s` or `#fs` tags, with one exception: kind 5004 `isResponse=false` carries `["s", senderSessionUUID]` as an informational tag announcing the sender's identity. This is not a relay routing filter — broadcast subscriptions for 5004 do not filter by `#s`.

**Session-directed (`#s` + `#fs` tags):** Only the matching session receives and processes the event. Two plaintext tags are required:
- `["s", recipientSessionUUID]` — anchors delivery to the recipient's session at the relay level
- `["fs", senderSessionUUID]` — identifies the sender's session, enabling the recipient to filter out traffic from peer sessions it has not chosen to connect to

Session connections are established via the 5004 handshake — see [Status (Kind 5004)](#status-kind-5004). Session UUIDs are generated fresh on every app startup. Session-directed signals sent to a stale UUID go unanswered; the sending peer waits for a new kind 5004 before retrying.

| Kind | Mode | Reason |
|------|------|--------|
| 5004 Status (`isResponse=false`) | Broadcast | Announces presence and session UUID; `#s` tag is informational only |
| 5004 Status (`isResponse=true`) | Session-directed | Session connect — establishes a session with the announcer |
| 5010 Trigger | Broadcast | Notification reaches any active session |
| 5011 Arm State | Broadcast | State change reaches any active session |
| 5001 RTC Session | Session-directed | Handshake requires a specific live session counterpart |
| 5002 RTC Answer | Session-directed | Completes handshake with the initiating session |
| 5003 RTC Hangup | Session-directed | Closes a specific session's RTC connection |
| 5005 Relay Migration | Session-directed | Session-stateful relay negotiation |
| 5006 Remote Command | Session-directed | Command targets a specific session |

---

## Signal Transmission

Every signal is published via `nostrClient.publishSignal(contactId, kind, payload, sessionId?)` or `nostrClient.publishSignalDirect(contactId, kind, payload, sessionId?)`. Relay selection, channel key lookup, and encryption are all internal. The optional `sessionId` is the target peer session UUID — when provided, NostrClient adds `["s", sessionId]` and `["fs", mySessionUUID]` to the event. When absent, no session tags are added.

```
Event structure on relay:
  pubkey:     sender's outboundChannelPubkey (ECDH-derived for paired; ephemeral for temp)
  kind:       5001–5006 or 5010–5011
  created_at: honest unix timestamp
  tags (broadcast 5010, 5011):              []
  tags (5004 isResponse=false):             [["s", senderSessionUUID]]            — informational only, not a routing filter
  tags (5004 isResponse=true):              [["s", recipientSessionUUID], ["fs", senderSessionUUID]]
  tags (session-directed 5001–5003, 5005–5006): [["s", recipientSessionUUID], ["fs", senderSessionUUID]]
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
nostrClient.startSignalRouter((contactId, kind, payload, senderSessionUUID) => {
  routeSignal(contactId, kind, payload, senderSessionUUID);
});
```

```typescript
type SignalRouterCallback = (contactId: string, kind: number, payload: object, senderSessionUUID?: string) => void
```

`startSignalRouter` establishes **one broadcast subscription per contact**. Session subscriptions are opened and closed separately by `SessionController` (see [sentry-controllers.md](sentry-controllers.md) § SessionController) via `nostrClient.openSessionSubscription()` / `nostrClient.closeSessionSubscription()`. Events from both subscription types are delivered through the same `onSignal` callback.

**Broadcast subscription (one per contact, established by `startSignalRouter`):**
```json
{
  "kinds": [5004, 5010, 5011],
  "authors": ["inboundChannelPubkey"],
  "since": now
}
```

**Session subscription (one per active peer session, managed by `SessionController`):**
```json
{
  "kinds": [5001, 5002, 5003, 5005, 5006],
  "authors": ["inboundChannelPubkey"],
  "#s": ["mySessionUUID"],
  "#fs": ["peerSessionUUID"],
  "since": now
}
```

All subscriptions are T+0 (`since: now`), spanning all relays in `ContactManager.allMyInboundRelays()`. Incoming events are decrypted before delivery to `onSignal`. For kind 5004 `isResponse=false`, `senderSessionUUID` is extracted from the plaintext `#s` tag without decryption (no `#s` filter is applied on the broadcast subscription, so the tag is read purely as metadata). For kinds 5010 and 5011, no session tags are present and `senderSessionUUID` is absent in the callback. For session-directed kinds (5001–5003, 5004 `isResponse=true`, 5005–5006), `senderSessionUUID` is extracted from the `#fs` tag.

### Dispatch Table

The router delivers each decoded signal to the appropriate handler based on kind and `isResponse`:

| Kind | isResponse | Handler |
|------|------------|---------|
| 5001 | `false` | Monitor handler — `handleOfferRequest()` |
| 5001 | `true` | Viewer handler — `handleOffer()` |
| 5002 | `false` | Monitor handler — `handleAnswer()` |
| 5003 | `false` or `true` | Both viewer and monitor handlers — each checks its own session map and closes the matching session |
| 5004 | `false` | Delivered to callback — `senderSessionUUID` extracted from plaintext `#s` tag (no decryption needed) and passed as fourth argument |
| 5004 | `true` | Delivered to callback — `senderSessionUUID` extracted from `#fs` tag |
| 5005 | `false` | Relay migration handler — `handleRelayMigrationProposal()` |
| 5005 | `true` | Relay migration handler — `handleRelayMigrationAck()` |
| 5006 | `false` | `RemoteCommandController` — validates TOTP and dispatches command |
| 5010 | — | Viewer handler — `handleTriggerSignal()` |
| 5011 | — | Viewer handler — `handleArmStateSignal()` |

Presence state and session management are consumer-managed. The `senderSessionUUID` fourth argument gives every handler the sender's session UUID without any additional lookup. `SessionController` (see [sentry-controllers.md](sentry-controllers.md)) handles kind 5004 to manage session connections; other handlers receive the session UUID so they can reply to the correct session via `publishSignal`.

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

Kind 5004 has two sub-types serving distinct roles:

**Announcement (`isResponse=false`):** Broadcast — carries `["s", senderSessionUUID]` as an informational tag (not a routing filter). Any session on the channel receives it. `SessionController` receives the announcement via the signal router callback and decides whether to establish a session connection with the announcing session.

**Session connect (`isResponse=true`):** Session-directed — carries `["s", announcerSessionUUID]` (the session UUID from the received announcement, used as the relay routing target) and `["fs", mySessionUUID]` (this device's session UUID, identifying the sender). Published by `SessionController` to establish a session with the peer. On receiving an `isResponse=true` targeted at its own session UUID, `SessionController` opens a session subscription for the sender. The handshake is complete when both sides have opened session subscriptions for each other.

The timing of `SessionController`'s response to an announcement — including any startup anti-flood behavior — is determined by `SessionController`'s own state machine.

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
nostrClient.startSignalRouter((contactId, kind, payload, senderSessionUUID) => {
  if (kind === 5010) handleTriggerSignal(contactId, payload as TriggerPayload);
  if (kind === 5011) handleArmStateSignal(contactId, payload as ArmStatePayload);
  // senderSessionUUID is absent for broadcast kinds 5010/5011
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
