# Nostr Foundation: Core Concepts and Architecture

## 1. Overview

**Nostr** is a decentralized event protocol designed for censorship-resistant, open communication. It is not a blockchain, not a social network (though social apps use it), and not designed for media streaming.

In Senstry, Nostr serves a single, focused role: **signaling layer for P2P coordination**. All WebRTC handshakes (offer, answer, ICE candidates), sensor notifications, arm/disarm state, and metadata exchange flow through Nostr. **Media never touches Nostr.** All video, audio, and recordings travel point-to-point via WebRTC only.

### Core Principles
- **Immutable events:** once published, events cannot be modified or deleted
- **Signed by keypair:** every event is cryptographically signed; source is verifiable
- **Timestamped and queryable:** events have `created_at` and can be filtered by relay
- **No accounts or authentication:** identity is derived from keypair, not a server
- **Relay is stateless:** relays store and serve events, but do not validate content or enforce permissions

## 2. Event Model

Every Nostr event is a JSON object with the following structure:

```json
{
  "id": "sha256(canonical_json)",
  "pubkey": "secp256k1(privkey)",
  "created_at": 1700000000,
  "kind": 5001,
  "tags": [
    ["p", "recipient-pubkey"],
    ["relay", "https://relay.example.com"]
  ],
  "content": "encrypted content or plaintext",
  "sig": "secp256k1.sign(id, privkey)"
}
```

### Field Breakdown

| Field | Type | Meaning |
|-------|------|---------|
| `id` | hex string (64 chars) | SHA-256 of the canonical event JSON; immutable once signed |
| `pubkey` | hex string (64 chars) | Secp256k1 public key of the signer; derived from privkey |
| `created_at` | integer | Unix seconds; signer's wall clock at event creation |
| `kind` | integer | Event type discriminator (5001 = signal, 5010 = trigger, etc.) |
| `tags` | array of arrays | Metadata, links, and routing hints; can include `p` (recipient) tags |
| `content` | string | Plaintext or encrypted payload; meaning depends on kind |
| `sig` | hex string (128 chars) | Secp256k1 signature of the event ID with signer's privkey |

### Event Signing & Verification

**Signing (at creation):**
1. Serialize event to canonical JSON (NIP-01 field order: `[0, pubkey, created_at, kind, tags, content]`)
2. Compute `id = SHA-256(canonical_json)`
3. Compute `sig = secp256k1.sign(id, privkey)`

**Verification (on receipt):**
1. Compute `id = SHA-256(event.json)` (must match event's `id` field)
2. Verify `secp256k1.verify(id, sig, pubkey)` (signature valid for this pubkey and id)
3. If both checks pass, event is authentic and unmodified

### Immutability

Once an event is published and signed, its content cannot be changed. This is enforced by the signature: any modification would invalidate the `sig` or require resigning (which creates a new event with a new `id`).

Nostr events are immutable once signed.

## 3. Relay Protocol

A **relay** is a server that accepts, stores, and queries Nostr events. Relays implement a simple text protocol over WebSocket.

### Basic Commands

**EVENT (publish):**
```
["EVENT", <event-json>]
```
Relay receives event, validates signature, stores if new, and broadcasts to subscribers.

**REQ (subscribe / query):**
```
["REQ", "subscription-id", <filter-1>, <filter-2>, ...]
```
Relay returns all stored events matching any of the filters (OR logic), then sends:
```
["EOSE", "subscription-id"]
```
when no more historical events are available. After EOSE, relay sends new events matching the filter in real-time.

**CLOSE:**
```
["CLOSE", "subscription-id"]
```
Client unsubscribes from a filter.

### Relay Guarantees (and Non-Guarantees)

**What relays do:**
- Store received events persistently
- Validate event signatures (reject if invalid)
- Index by kind, author, tags, and timestamp
- Return filtered results quickly
- Broadcast new events to subscribers in real-time

**What relays do NOT do:**
- Enforce permissions or access control (no authentication)
- Validate event content or prevent spam
- Update or delete events (immutable)
- Compress or deduplicate events
- Transport media (Senstry media is P2P only)

## 4. NIPs (Nostr Improvement Proposals)

Nostr is extensible through NIPs. Senstry relies on a small, well-defined set:

### NIP-01: Core Protocol
Defines event format, signing, relay protocol, and canonical JSON serialization.
- **Status:** Stable, widely implemented
- **Used by:** All Senstry events

### NIP-33: Parameterized Replaceable Events
Events with kind ≥ 30000 are replaceable. Relay deduplicates by `(pubkey, kind, d-tag)`.
- **Status:** Stable
- **Used by:** Not currently used in Senstry. Footage metadata is exchanged over RTC data channels, not Nostr.

### NIP-44: Encrypted Payloads (ChaCha20-Poly1305)
Standard encryption for Nostr content.

```
ciphertext = encrypt(senderPrivkey, recipientPubkey, plaintext)
plaintext = decrypt(receiverPrivkey, senderPubkey, ciphertext)
```

**Key derivation:** ECDH (sender's privkey + recipient's pubkey) produces a shared secret; ChaCha20-Poly1305 derives a key from that secret.

**Properties:**
- Single encryption layer (not double-wrapped)
- Sender and recipient are visible on relay (pubkeys in plaintext)
- Content is opaque
- Requires both sender's privkey (to encrypt) and recipient's pubkey

**Used by:** All encrypted events in Senstry (signals, action signals, pairing acks, gift wraps).

### NIP-59: Gift Wrap

Three-layer wrapping scheme for obscuring sender, recipient, and content from relays:

1. **Rumor** — unsigned event carrying the actual payload (replyKey, replyRelays, instruction)
2. **Seal** (kind 13) — rumor encrypted with sender's real key to recipient's pubkey; signed by sender's real key; no `p` tag
3. **Gift Wrap** (kind 1059) — seal encrypted with a random one-time key; `p` tag = recipient pubkey for relay routing; signed by the random key

**Timestamps:** the seal and gift wrap layers use randomized timestamps (±30 minutes) to protect against time-analysis. Only the rumor's `created_at` is honest. Gift-wrapped events are found via `#p` tag filtering, not `since` filtering.

**Status in Senstry:**
- **Not used** for signals between paired devices — replaced by ECDH channel keys (more efficient, supports `since` filtering)
- **Used** for all non-paired communication: Nostr-delivered pairing invites, TOTP-secured instructions, and any contact initiation where no channel key exists yet
- After a gift wrap is received and decrypted, further communication uses the ephemeral reply key extracted from the rumor — functionally identical to a channel key for the duration of that interaction

## 5. Encryption in Senstry: Three Models

### Model 1: NIP-44 over ECDH Channel Keys – All Post-Pairing Events

Used for all events sent between paired devices: signals (5001–5005) and action signals (5010, 5011).

```
Event sender: Monitor (outbound channel privkey — not identity key)
Event recipient: Viewer (inbound channel pubkey)
Encryption: NIP-44 (channel privkey + channel pubkey)
Relay visibility: Channel pubkeys only — real identities are not visible
```

**Advantage:** Privacy-preserving. Relay operator cannot correlate events to real device identities. Channel pubkeys are pseudonymous — unrelated to real pubkeys without the ECDH shared secret.

### Model 2: Gift-Wrap – Non-Paired Communication Only

Previously used for WebRTC signaling (kind 5001).

**Why it was proposed:** Relay cannot see sender/recipient (ephemeral outer key). Offered sender deniability: "Anyone could have published this signal."

**Why it was removed:** Two critical flaws: (1) Expensive to query—relay cannot filter by `authors`, forcing full table scans over ~1.6 hour windows, burning rate limits; (2) Randomized timestamps break relay `since` filtering, defeating efficient subscription windows. These costs made it unsuitable for frequent WebRTC handshakes.

### Model 3: ECDH-Derived Channel Keys – How Channel Keys Work

**ECDH-derived channel keys are the mechanism behind Model 1.** Both paired devices independently derive identical directional keys from their shared ECDH secret.

#### Key Derivation

```
// Both devices compute independently; no key exchange
sharedSecret = ECDH(myPrivkey, pairedDevicePubkey)

// Directional derivation
outboundChannelPrivkey = deriveChannelKey(sharedSecret, myPubkey, pairedPubkey)
inboundChannelPrivkey = deriveChannelKey(sharedSecret, pairedPubkey, myPubkey)

// Relay sees only the channel pubkey
outboundChannelPubkey = deriveChannelPubkey(outboundChannelPrivkey)
```

#### Example: Monitor → Viewer Signal

**Monitor sends (offer):**
1. Computes `outboundChannelPrivkey = deriveChannelKey(sharedSecret, monitorPubkey, viewerPubkey)`
2. Creates kind 5001 event with:
   - `pubkey`: `outboundChannelPubkey` (derived, not real identity key)
   - `sig`: signs with `outboundChannelPrivkey`
   - `content`: NIP-44 encrypted using `outboundChannelPrivkey` (not real identity key)
3. Publishes to relay

**Viewer receives:**
1. Sees event with `pubkey = outboundChannelPubkey` (unknown, but subscribed to it)
2. Subscribed via `{ kinds: [5001, 5002, 5003, 5004, 5005], authors: [outboundChannelPubkey] }` — all signal kinds for this channel
3. Decrypts content using `inboundChannelPrivkey` (independently derived from shared secret — same key as monitor's `outboundChannelPrivkey`)

**Relay perspective:**
- Sees two channel pubkeys (outbound, inbound) that look like pseudonyms
- Cannot correlate to real identities without breaking ECDH (computationally infeasible)
- Can use `authors` filter (efficient)
- Honest timestamps enable 1-hour `since` filtering (instead of ~1.6 hours)

#### Why This Works

- **No key exchange needed:** Both devices have all inputs (shared secret, both pubkeys) to derive the same key independently
- **Pseudonymous on relay:** Channel pubkeys look unrelated to real pubkeys to an observer
- **Verifiable:** Monitor can still verify sender (channel pubkey is deterministic and known in advance)
- **Efficient:** Relay can use `authors` filter and honest timestamps

#### Non-Persisted

Channel keys are derived on-the-fly from the shared secret at pairing time. They are not persisted in IDB; recalculated each session.

## 6. Event Kinds Used by Senstry

### WebRTC Signaling

Each signal type has its own Nostr kind. Relays cannot filter by encrypted content, so a targeted fetch for a specific signal type requires a dedicated kind number. Within each kind, `isResponse` distinguishes the initiating party from the responding party.

| Kind | Name | Encrypted | Key Model | TTL | isResponse semantics |
|------|------|-----------|-----------|-----|---------------------|
| 5001 | RTC Session | NIP-44 | ECDH channel | ~10s | `false` = offer-request (viewer initiates), `true` = SDP offer (monitor responds) |
| 5002 | RTC Answer | NIP-44 | ECDH channel | ~10s | `false` = SDP answer (viewer completes handshake), `true` = ack (monitor, optional) |
| 5003 | RTC Hangup | NIP-44 | ECDH channel | ~10s | `false` = hangup initiation, `true` = ack (optional) |
| 5004 | Status | NIP-44 | ECDH channel | ~3600s | `false` = presence announcement, `true` = reply to announcement |
| 5005 | Relay Migration | NIP-44 | ECDH channel | ~300s | `false` = relay proposal, `true` = acknowledgement |

### Action Signals

Pipeline-driven notifications sent from monitor to specific paired viewers. Same NIP-44 over ECDH channel key mechanism as signal kinds 5001–5005. Flow through the signal router — received via `onSignal(contactId, kind, payload)`.

| Kind | Name | Encrypted | Key Model | TTL | Purpose |
|------|------|-----------|-----------|-----|---------|
| 5010 | Trigger | NIP-44 | ECDH channel | ~10s | Sensor fired — detection type, confidence, timestamp |
| 5011 | Arm State | NIP-44 | ECDH channel | ~10s | Monitor armed or disarmed |

Footage and segment data are never sent over Nostr. The kind 5010 payload carries only what happened and when; the viewer requests media over the RTC data channel.

### Pairing

These kinds handle device discovery and initial identity exchange. They are distinct from all post-pairing kinds (5001–5011) — the only layer where real pubkeys appear on Nostr.

| Kind | Name | Encrypted | Purpose |
|------|------|-----------|---------|
| 5100 | QR Acceptance | NIP-44 (temp channel key) | Acceptance event signed with ephemeral viewer key; monitor decrypts with invite privkey |
| 5200 | Nostr Invite | NIP-59 gift wrap | Nostr-delivered pairing invite; 3-layer gift wrap containing ephemeral reply key + TOTP credential |

**Note:** Kinds 5100 and 5200 are not signal kinds. They use different encryption models (temp channel key, gift wrap) and are fetched via `#p` tag filtering, not `since` filtering. They do not flow through the signal router.

## 7. Subscriptions and Filters

A **subscription** is a long-lived query that returns both historical events and new events as they arrive.

### Filter Format

```json
{
  "ids": ["event-id-1", "event-id-2"],
  "kinds": [5001, 5010],
  "authors": ["pubkey-1", "pubkey-2"],
  "#p": ["pubkey"],
  "#d": ["identifier"],
  "since": 1700000000,
  "until": 1700001000,
  "limit": 100,
  "search": "text"
}
```

### Filter Fields

| Field | Type | Meaning |
|-------|------|---------|
| `ids` | array of hex strings | Match event IDs (immutable once signed) |
| `kinds` | array of integers | Match event kinds |
| `authors` | array of pubkeys | Match event signer (pubkey) |
| `#<tag>` | array of values | Match tag values (e.g., `#p` for 'p' tags) |
| `since` | integer | Unix seconds; include events with `created_at ≥ since` |
| `until` | integer | Unix seconds; include events with `created_at ≤ until` |
| `limit` | integer | Max results to return (relay may honor or ignore) |
| `search` | string | Full-text search (optional, not all relays support) |

### Filter Logic

- Multiple filters in a REQ are **OR logic** (match any filter)
- Multiple fields within a filter are **AND logic** (match all fields)
- No built-in NOT logic (handled client-side)

### Common Senstry Subscriptions

**Signal subscription (all signal kinds, T+0 only):**
```json
{
  "kinds": [5001, 5002, 5003, 5004, 5005, 5010, 5011],
  "authors": ["inboundChannelPubkey"],
  "since": now
}
```
Subscribe to future signals and action signals from a specific contact (by channel pubkey). `since: now` is always used — no history replay. History for action signals (5010, 5011) is fetched via `fetchKindHistory(contactId, kind, { windowStart: lastOnline })` on reconnect.

**Action signal subscription (kinds 5010, 5011):**

Action signals flow through the signal router — no separate subscription needed. They arrive via `onSignal(contactId, kind, payload)` alongside all other post-pairing signals. History is fetched via `fetchKindHistory(contactId, 5010, opts)` using the same fan-fetch mechanism.

## 8. Keypairs and Derivation

### Identity Keypairs

Every device has one **identity keypair:**

- **Privkey:** 32-byte random value (Uint8Array), stored in IndexedDB (browser sandbox provides encryption at rest)
- **Pubkey:** 64-character hex string, derived via secp256k1 from privkey

This keypair is used only for pairing events (5100, 5200) and as input to ECDH shared secret derivation. It never appears as the `pubkey` field on any post-pairing Nostr event.

### ECDH Shared Secret

When pairing two devices, a **shared secret** is computed:

```
sharedSecret = ECDH(myPrivkey, pairedDevicePubkey)
```

- Computed once per pair, not persisted
- Only the paired devices can compute it (requires one privkey + other pubkey)
- Used as input to channel key derivation

### Channel Keys

Derived from the shared secret:

```
// Monitor → Viewer
outboundChannelPrivkey = deriveChannelKey(sharedSecret, monitorPubkey, viewerPubkey)
outboundChannelPubkey = secp256k1(outboundChannelPrivkey)

// Viewer → Monitor
inboundChannelPrivkey = deriveChannelKey(sharedSecret, viewerPubkey, monitorPubkey)
inboundChannelPubkey = secp256k1(inboundChannelPrivkey)
```

**Properties:**
- Deterministic: same inputs always produce same output
- Directional: `deriveChannelKey(s, A, B) ≠ deriveChannelKey(s, B, A)`
- Non-persisted: recomputed each session from pairing data
- Pseudonymous: relay sees channel pubkey, not identity

## 9. Event Tags and Conventions

Tags are optional metadata attached to events. Format is an array of arrays: `["tag-name", "value-1", "value-2"]`.

### Common Senstry Tags

| Tag | Format | Purpose |
|-----|--------|---------|
| `p` | `["p", "pubkey"]` | NIP-44 recipient; also marks a pubkey mention |
| `e` | `["e", "event-id"]` | Reference to another event |
| `relay` | `["relay", "url"]` | Relay hint (where to fetch related events) |
| `t` | `["t", "tag"]` | Hashtag (e.g., `["t", "motion-detection"]`) |

### Tag Examples

**QR acceptance (kind 5100):**
```json
{
  "tags": [
    ["p", "monitor-real-pubkey"],
    ["invite", "uuid-invite-id"],
    ["v", "2"]
  ]
}
```

**Trigger event (kind 5010):**
```json
{
  "tags": []
}
```

## 10. Timestamps and TTL

### created_at Field

Every event has a `created_at` field: unix seconds (not milliseconds) representing the signer's wall clock when the event was created.

**Timestamps are honest** (not randomized). This enables:
- Reliable relay `since` filtering (1-hour window for signals, instead of ~1.6 hours)
- Accurate event ordering
- Meaningful TTL enforcement

### TTL (Time-to-Live) Enforcement

The client discards received events if they are older than a threshold:

| Event Kind | TTL | Rationale |
|-------------|-----|-----------|
| 5001–5003 (RTC handshake) | ~10s | Stale offers and answers are unusable |
| 5004 (status) | ~3600s | Presence is meaningful for up to 1 hour |
| 5005 (relay migration) | ~300s | Stale proposals are ignored |
| 5010 (trigger) | ~10s | Notifications must be acted on promptly |
| 5011 (arm state) | ~10s | State changes must be recent |

**Calculation:**
```
if (now - event.created_at > TTL_SECONDS) {
  discard(event);  // too old
}
```

**Purpose:** Prevent replay of old events and maintain freshness guarantees.

## 11. Event Immutability and Replaceable Events

### Standard Events (Immutable)

All signal and action signal kinds (5001–5005, 5010, 5011) and pairing kinds (5100, 5200) are standard (non-replaceable) events:
- Once published, content cannot change
- Multiple events with the same `(pubkey, kind)` can coexist
- Relay returns all matching events unless further filtered

**No deletion mechanism:** Nostr does not support deleting events. Publishers can recommend deletion (NIP-09), but relays are not obligated to honor it.

### Replaceable Events (NIP-33)

Senstry does not use replaceable event kinds (kind ≥ 30000). Footage metadata, segment references, and coverage maps are exchanged over the RTC data channel, not over Nostr.

## 12. Privacy Model

### Public Information on Relay

Relays store all events. An observer with access to a relay (relay operator, network eavesdropper) can see:

- **Event metadata:** id, pubkey, kind, created_at, tags (unencrypted)
- **Event signature:** verifiable proof of signer
- **Unencrypted tags:** `p` tags (recipient pubkey), `e` tags (referenced event), `d` tags (dedup key), etc.

### Private Information (Encrypted)

- **Event content:** encrypted with NIP-44 (or other encryption)
- **Signal identities:** Channel pubkeys are pseudonymous; real pubkey is not visible in signal events

### Threat Model: Relay Operator

A relay operator can:
- **Correlate:** "Device X (pubkey A) sent to Device Y (pubkey B) at time Z"
- **Infer:** trigger patterns, arm/disarm times, message volume
- **Cannot see:** event content, WebRTC media, true identities of channel key users

**Mitigations:**
- Content encrypted with NIP-44
- Channel keys pseudonymous
- Media never on relay (P2P only)

### Media Privacy

**All video, audio, and segments travel P2P via WebRTC only.** They never appear on any relay.

Relays see only:
- Signaling events (WebRTC offer/answer SDP, ICE candidates)
- Action signal events (trigger notifications, arm state) — encrypted over channel keys, pseudonymous

Media content is unknown to relays.

## 13. Scalability Considerations

### Event Growth

Nostr relays by default retain all events indefinitely. This can lead to unbounded storage growth.

**Senstry mitigations:**
- **Kinds 5001–5005 (signals):** Short TTL and honest timestamps mean relays can prune old events; client subscriptions use a bounded `since` window
- **Kinds 5010, 5011 (action signals):** Accumulate on relay per contact's relay list; relay operators can prune based on retention policy

### Query Efficiency

**Relay indexing:** Indexes on kind, author, tags, created_at enable fast filtering.

**Client-side composition:** Complex filters (AND, OR, NOT combinations) are evaluated client-side. Relay returns union of results matching individual filters.

**Efficient querying:** Channel key `authors` filtering allows per-contact event retrieval without scanning the full relay.

### Rate Limiting

Relays may enforce rate limits to prevent spam:
- Events published per time window
- Connections per IP
- Bandwidth per client

**Senstry adaptation:**
- Outbox queuer: batches publishes and retries on rate-limit errors
- Subscription coalescing: multiple related queries are merged into single subscription
- Single-relay publish: each event goes to one relay (LRU-eligible, selected by RelayStateController); history fan-fetches from all relays to find it regardless of which one was used

## 14. Nostr Ecosystem Context

Nostr powers diverse applications:
- **Social networks:** Damus, Amethyst (Twitter clone with notes)
- **Blogging:** Habla, Write.as (long-form content via NIP-23)
- **Chat:** Nostrgram, Relaystr (encrypted messaging)
- **Markets:** Nostrmarket, n3xB (decentralized commerce)
- **Zaps:** Lightning-integrated tipping
- **Senstry:** Privacy-first monitoring (orthogonal use case)

**Senstry is independent:** Does not interact with social apps, does not use Nostr for media transport, focuses narrowly on signaling and notifications.

## 15. Event Lifecycle Example: Trigger Fired

Walk-through of a complete trigger event from sensor to viewer UI.

### Steps

1. **Monitor:** Audio sensor fires (RMS > threshold)
2. **Monitor → ActionController → TriggerPublisher:** Pipeline resolves which paired contacts should be notified
3. **Monitor:** `TriggerPublisher` calls `nostrClient.publishSignal(viewerContactId, 5010, payload)` once per target contact
4. **NostrClient internals:** Looks up `viewerContactId` in `ContactManager` → gets outbound channel key + relay list → builds kind 5010 event signed with the outbound channel privkey, NIP-44 encrypted
   ```json
   {
     "kind": 5010,
     "pubkey": "<monitor-outbound-channel-pubkey>",
     "created_at": 1700000000,
     "tags": [],
     "content": "<NIP-44 encrypted payload>"
   }
   ```
   - Payload (encrypted): `{ sensorType: "audio", level: 85, detectedAt: 1700000000 }`
   - Signed with outbound channel privkey — real identity never exposed
5. **RelayStateController:** Selects next available relay from contact's outbound relay list (LRU)
6. **Relay:** Receives event, validates signature, stores, notifies subscribers
7. **Viewer:** T+0 subscription matches `{ kinds: [5010, ...], authors: [monitor-outbound-channel-pubkey] }` — event delivered
8. **NostrClient (viewer):** Decrypts with inbound channel privkey, delivers `onSignal(monitorContactId, 5010, payload)`
9. **Viewer UI:** Receives `(monitorContactId, 5010, { sensorType, level, detectedAt })` — adds alert marker to timeline
10. **Viewer:** Requests pre/post-roll footage from monitor over the existing RTC data channel

### Privacy Perspective

- **Relay sees:** Channel pubkey (pseudonymous), kind, timestamp, encrypted content
- **Relay cannot see:** Real device identities, what triggered the event, audio level, media
- **Relay operator cannot infer:** Which devices are communicating (channel pubkeys are unlinkable to real pubkeys without the ECDH secret)
- **Media:** Never on relay — transferred P2P via WebRTC only

## 16. Architecture Principles

### Immutability First

Events are append-only. No updates, no deletes. Ordering is temporal (by `created_at`); state is eventual consistency of latest events.

### Distributed Trust

No central authority. Relays are interchangeable. Signature verification is client-side. Consequence: clients must validate all inputs; relays are stateless.

### Content Encryption Optional

Sender chooses what to encrypt. Signals are encrypted (NIP-44). Metadata is often plaintext (event kind is visible). Consequence: flexibility at cost of nuance (relay operator can infer from kind alone).

### Timestamp-First Ordering

All causality is through `created_at`. No logical clocks or vector clocks. Consequence: wall-clock synchronization is important; honest timestamps are more useful than randomized ones.

### Client-Side Intelligence

Filtering, dedup, verification, rate limiting all client-side. Relays are dumb. Consequence: clients are responsible for their own security and efficiency.

### Signature as Identity

Pubkey is derived from privkey via secp256k1. No usernames, no accounts, no servers. Consequence: identity is cryptographic; can be verified anywhere.

## 17. Summary: Why Nostr for Senstry

| Need | Nostr Feature | Benefit |
|------|---------------|---------|
| P2P signaling without central server | Relay is stateless, events are signed | No account creation, no server trust required |
| Scalable WebRTC handshake | Kinds 5001–5003 with ECDH channel keys | 3 events for initial connection, 2 for live upgrade |
| Targeted action notifications | Kinds 5010, 5011 over channel keys | Trigger and arm-state signals reach specific paired viewers; relay sees no real identities |
| Privacy from relay | NIP-44 + ECDH channel keys for all post-pairing events | Real pubkeys never appear after pairing; relay cannot correlate device identities |
| Media NOT on relay | P2P WebRTC only | Relays see only signaling; all footage stays on edge |

Nostr is a messaging layer optimized for **signed, queryable, immutable events with optional encryption.** It is not optimized for media streaming (hence WebRTC for media) or high-frequency state sync (hence WebRTC data channels for commands).

---

**See also:**
- `docs/new/nostr-communication-flow.md` — How signals, triggers, and metadata flow between devices
