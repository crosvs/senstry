# WebRTC Communication Architecture

This document specifies Senstry's WebRTC architecture for peer-to-peer media streaming and data channel messaging.

---

## 1. Overview

WebRTC provides low-latency peer-to-peer communication between paired monitor and viewer devices. Two use cases:

1. **Live Media Stream** — monitor sends video+audio tracks to viewer in real time
2. **Data Channel Requests** — viewer requests segment blobs, coverage maps, metadata, and segment lists on demand

Both use the same `RTCPeerConnection` infrastructure. The mode (`'live'` or `'data'`) is declared in the initial `offer-request` signal. A data-only connection skips media tracks entirely, reducing unnecessary bandwidth.

**Key Properties:**
- Signaling occurs over Nostr (kinds 5001–5006, 5010, 5011) using ECDH-derived channel keys and NIP-44 encryption
- All media travels P2P; relays carry only tiny JSON control messages
- Non-trickle ICE reduces handshake from ~15 relay events to 3 (offer-request, offer, answer)
- Live upgrade path: existing data session → send `live-request` on control channel → 2 Nostr events total for renegotiation
- Data channels are stateless request/response handlers on monitor side; Promise-based API on viewer side

---

## 2. Peer Connection Setup (`peer.ts`)

### ICE Configuration

All connections use a single public STUN server:

```
stun:stun.l.google.com:19302
```

No TURN server is configured. Cross-network connections behind symmetric NAT may fail; if NAT traversal is required, add a TURN entry to `ICE_SERVERS`.

### Non-Trickle ICE

`waitForIceGathering(pc, timeoutMs=5000)` delays sending SDP until `pc.iceGatheringState === 'complete'`. All ICE candidates are embedded in the SDP body before sending.

**Benefits:**
- Reduces Nostr relay events from ~15 (trickle: 1 offer + 1 answer + N candidates each) to 3 (offer-request + offer + answer)
- Compresses WebRTC handshake into minimal relay traffic
- 5s timeout guards against STUN failure; proceeds with partial candidates if STUN is unreachable

**Example (monitor creating initial offer; same pattern for viewer creating answer):**
```typescript
const pc = createPeer();
const sdp = await pc.createOffer();   // pc.createAnswer() on the viewer side
await pc.setLocalDescription(sdp);
await waitForIceGathering(pc);  // All candidates are now embedded in pc.localDescription.sdp
await sendSdp(pc.localDescription.sdp);  // Single Nostr event with complete SDP
```

### RTCPeerConnection Factory

```typescript
export function createPeer(options?: RTCConfiguration): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    ...options
  });
}
```

---

## 3. Signaling Protocol (`signaling.ts`)

### Signal Message Format

Signals use dedicated Nostr kinds — one per signal type. `isResponse` distinguishes the initiating from the responding party within each kind. Payloads are NIP-44 encrypted over ECDH-derived channel keys.

| Kind | Signal | isResponse=false | isResponse=true |
|------|--------|-----------------|----------------|
| 5001 | RTC Session | Offer-request (viewer, includes mode) | SDP offer (monitor) |
| 5002 | RTC Answer | SDP answer (viewer) | Ack (optional) |
| 5003 | RTC Hangup | Hangup initiation | Ack (optional) |
| 5004 | Status | Announcement or solicitation | Reply |
| 5005 | Relay Migration | Proposal | Acknowledgement |
| 5006 | Remote Command | TOTP-authorized instruction | Ack (credential accepted) |

### Signal Transmission

```
Kinds: 5001–5006, 5010, 5011 (one per signal type)
Pubkey: ECDH-derived channel key (not real identity)
Content: NIP-44 encrypted kind-specific payload
created_at: honest timestamp (not randomized)
Subscription: T+0 only (since: now) — no history replay in subscribe
```

### ECDH-Derived Channel Keys

Both devices independently derive the same directional channel keypairs from their ECDH shared secret. No key exchange required.

```typescript
// Both sides compute independently:
const sharedSecret = getConversationKey(privkey, peerRealPubkey);

// Monitor → Viewer (monitor's outbound / viewer's inbound)
const monitorOutbound = deriveChannelKey(sharedSecret, monitorPubkey, viewerPubkey);

// Viewer → Monitor (viewer's outbound / monitor's inbound)
const viewerOutbound = deriveChannelKey(sharedSecret, viewerPubkey, monitorPubkey);

// Assertion (both sides):
// monitorOutbound === viewerInbound  ✓
// viewerOutbound === monitorInbound  ✓
```

**Key Properties:**
- Deterministic: same inputs always produce same output
- Directional: swapping sender/recipient produces a different key
- Ephemeral: not stored; re-derived on app restart from real pubkeys in `pairedContacts`

### Signal TTL

**TTL per kind:**
- RTC handshake (kinds 5001, 5002, 5003): `SIGNAL_TTL_S = 10` — stale offers, answers, hangups are discarded
- Presence (kind 5004): `STATUS_TTL_S = 3600` (1 hour) — status is meaningful for up to 1 hour
- Relay migration (kind 5005): ~300s — proposals stay valid while the migration negotiation completes
- Remote command (kind 5006): ~30s signal TTL (live delivery filter); `RemoteCommandController` additionally validates `payload.ttl` per command (e.g. 300s) — governs both live and history-fetched commands
- Action signals (kinds 5010, 5011): ~10s — trigger and arm-state signals are discarded if stale

Kind 5004 with `isResponse: false` acts as both announcement and solicitation — there is no separate status-request kind. `ping`/`pong` are not signal kinds; connectivity checks happen at the WebRTC or relay-connection layer, not via Nostr signals.

TTL is checked against the event's honest `created_at` timestamp.

### Deduplication

`seenEventIds: Set<string>` (module-level) is cleared every 60s. Handles relay replay:
- Old replayed events excluded by subscription `since` window (~1 hour)
- Recent replays deduped by event ID within 60s window
- Per-relay dedup ensures no duplicate processing across multiple subscriptions

---

## 4. Viewer-Side Connection Flow (`viewer-peer.ts`)

### Session Management

One session per monitor device:

```typescript
interface ViewerSession {
  pc: RTCPeerConnection;
  monitorPubkey: string;
  sessionId: string;                    // UUID per connection attempt
  controlChannel: RTCDataChannel | null; // JSON: requests, metadata, small responses
  dataChannel: RTCDataChannel | null;    // binary/base64: segment chunk payloads
  mode: 'live' | 'data';
}

const sessions = new Map<monitorPubkey, ViewerSession>();
const connectPromises = new Map<monitorPubkey, Promise<void>>();  // prevents concurrent duplicates
const pendingLiveUpgrades = new Map<monitorPubkey, { resolve, reject }>();  // in-flight renegotiation
```

### Connection Flow

```
ensureConnection(privkey, viewerPubkey, monitorPubkey, mode)
  │
  ├─ check sessions.has(monitorPubkey) → already connected? return
  ├─ check connectPromises.has(monitorPubkey) → in progress? return same Promise
  │
  └─ new Promise:
       ├─ sendOfferRequest(mode)     → monitor receives; triggers handleOfferRequest()
       ├─ wait for pc.ondatachannel  → monitor sends 'control' channel
       ├─ controlChannel.onopen      → resolve (data channel also arrives)
       ├─ timeout: 60s               → fail() + closeSession
       ├─ ICE 'failed'               → fail()
       ├─ ICE 'disconnected' → 8s grace → fail()
       └─ onTrack fires (live mode)  → media stream available
```

**Key State Transitions:**
- `connecting` → `connected` (control channel open) or `failed` (timeout/ICE error)
- Once `connected`, can request segments, coverage maps, or upgrade to live
- Live upgrade uses renegotiation on existing `pc` (no new offer-request)

### Live Upgrade Path (Data → Live, In-Band)

When a viewer already has an open data connection and clicks "Watch Live", sending a new `offer-request` would cost 4 Nostr events (offer-request + offer + answer + hangup of old session). Instead, use in-band renegotiation:

```
viewer already connected (data mode)
  │
  ├─ set session.mode = 'live'
  ├─ send { type: 'live-request', channelId } on controlChannel
  │     ↓ monitor receives on control channel
  │     monitor builds composite stream
  │     monitor adds tracks → createOffer() → sendOffer() [1 Nostr event]
  │
  ├─ viewer receives 'offer' signal
  │     ├─ setRemoteDescription(offer)
  │     ├─ createAnswer()
  │     ├─ sendAnswer() [1 Nostr event]
  │
  └─ onTrack fires (from renegotiation) → resolve pendingLiveUpgrades
```

**Total Nostr events:**
- Initial data connection: 3 (offer-request, offer, answer)
- Live upgrade: 2 additional (renegotiation offer, answer)
- Total from start: 5 events (vs 7 if reconnected fresh)

### Request API Pattern

All data requests follow a Promise pattern with correlation IDs:

```typescript
requestCoverageMap(privkey, viewerPubkey, monitorPubkey, mimePrefix?)
  → ensureConnection(...)
  → dc.send(JSON.stringify({ type: 'coverage-request', mimePrefix }))
  → register Promise in pendingCoverage map
  → await Promise resolution
  → on message: match type, resolve with data

requestSegment(time, privkey, viewerPubkey, monitorPubkey, mimePrefix?)
  → ensureConnection(...)
  → dc.send(JSON.stringify({ type: 'segment-request', time, mimePrefix }))
  → accumulate chunks in pendingSegments[requestTime]
  → on final chunk (index === total - 1): reassemble + verify contentHash
  → resolve with { blob, mimeType, startTime, endTime, originMonitor, segmentId, contentHash }
```

**Key Request Functions:**
- `requestCoverageMap(time?, mimePrefix?): Promise<[start, end][]>`
- `requestSegment(time, ...): Promise<{blob, mimeType, startTime, endTime, ...}>`
- `requestSegmentById(segmentId, ...): Promise<{blob, ...}>`
- `requestSegmentsAfter(after: number, count: number, ...): Promise<SegmentMeta[]>`
- `requestSegmentsBefore(before: number, count: number, ...): Promise<SegmentMeta[]>`
- `requestSegmentChannels(...): Promise<string[]>` — distinct channel IDs in monitor storage
- `requestCoverageChannels(mimePrefix?, ...): Promise<Record<channelId, CoverageMap>>`
- `requestChannelList(...): Promise<ChannelConfig[]>` — monitor's live channel config

### Segment Deduplication (Multi-Device Viewers)

When a viewer connects to multiple monitors and re-serves a segment:

```typescript
// Fetch from Monitor A on channel "front-door"
const seg = await requestSegment(time, ..., monitorAKey);
// → stored with originMonitor: pubkeyA, channelId: "front-door", segmentId: "seg-2024-05-28T100000Z", backupOf: null

// Re-serve same segment from Monitor B (different monitoring perspective, same channel name)
const seg2 = await requestSegment(time, ..., monitorBKey);
// Monitor B independently derives the same canonical segmentId (timestamp-based)
// but stores it as a remote copy:
// → stored with originMonitor: pubkeyB, channelId: "front-door", segmentId: "seg-2024-05-28T100000Z", backupOf: 'pubkeyA-front-door-seg-2024-05-28T100000Z'

// Canonical invariant: segmentId is canonical across all devices
// Dedup key format: ${originMonitor}-${channelId}-${backupOf ?? segmentId}
// Examples:
//   Canonical from A: pubkeyA-front-door-seg-2024-05-28T100000Z
//   Backup from B:    pubkeyB-front-door-pubkeyA-front-door-seg-2024-05-28T100000Z
```

**Key invariant: Multi-device coverage overwrites prevented by three-part key**
- Each segment is uniquely identified by `originMonitor` (source device) + `channelId` (which source was recorded) + dedup key (`backupOf ?? segmentId`)
- **Canonical segment ID is consistent across devices**: the segmentId is derived from recording time/position (e.g., timestamp-based or UUID), not device-local. This ensures cross-device dedup works: ContactA's canonical segment `seg-2024-05-28T100000Z` is stored with the same ID on ContactB's remote copy.
- **Remote copies preserve canonical reference**: when ContactB stores a copy, `backupOf` points to the full canonical key `${originMonitor}-${channelId}-${canonicalSegmentId}`, unambiguously tracking the canonical segment even if channel names differ between devices
- Segments from different devices are never mixed even if they have the same `channelId` name, because `originMonitor` differs
- Quota accounting: only canonical segments (`backupOf = null`) count; remote copies (`backupOf = <key>`) are metadata-only
- See `docs/new/sentry-pipeline-foundation.md` for full segment structure and quota semantics

---

## 5. Monitor-Side Connection Flow (`monitor-peer.ts`)

### Session Management

One session per viewer:

```typescript
interface MonitorSession {
  pc: RTCPeerConnection;
  viewerPubkey: string;
  sessionId: string;
  controlChannel: RTCDataChannel | null;
  dataChannel: RTCDataChannel | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  generation: number;  // increment on close; guards against race conditions
}

const sessions = new Map<viewerPubkey, MonitorSession>();
```

**Idle Timeout:** 120s (default). Any data channel message resets timer. Expiry sends `hangup` signal and closes session.

### Connection Flow

```
handleOfferRequest(privkey, monitorPubkey, msg, fromViewerPubkey)
  │
  ├─ close any existing session for this viewer
  ├─ createPeer()
  ├─ if mode === 'live' AND activeStreams.size > 0:
  │     └─ add tracks from buildCompositeStream(channelId or all sources)
  ├─ createDataChannel('control')  ← JSON messages, requests
  ├─ createDataChannel('data')     ← segment chunk payloads
  ├─ controlDc.onmessage = handleDataMessage (+ live-request inline)
  ├─ onIceStateChange → 'failed'/'closed' → closeSession()
  ├─ createOffer() → setLocalDescription()
  ├─ waitForIceGathering()
  └─ sendOffer(...) [1 Nostr event]
```

### Live Stream Track Selection (Priority Order)

When building the composite `MediaStream`:

1. **Channel active sources** — sources from `RecordingController` via `onActiveSources` callback
   ```typescript
   const override = channelActiveSources.get(channelId);
   if (override?.videoSourceId) { /* use this */ }
   ```

2. **Channel defaults** — channel's configured `videoSourceId`/`audioSourceId`
   ```typescript
   const config = activeChannels.get(channelId);
   if (config.videoSourceId) { /* fallback */ }
   ```

3. **All open sources** — if no channel specified
   ```typescript
   for (const stream of activeStreams.values()) {
     for (const track of stream.getTracks()) composite.addTrack(track);
   }
   ```

**Example:** When a `RecordingController` activates for "front-door":
```typescript
setChannelActiveSources(new Map([
  ['front-door', { videoSourceId: 'camera-id', audioSourceId: 'mic-id' }]
]));
// Live RTC viewers now see camera+mic instead of channel defaults
// When action stops: clear overrides → fall back to ChannelConfig defaults
```

### Live Renegotiation (In-Band Upgrade)

When monitor receives `{ type: 'live-request', channelId }` on control channel:

```typescript
if (req.type === 'live-request') {
  if (activeStreams.size > 0) {
    const composite = buildCompositeStream(req.channelId);
    for (const track of composite.getTracks()) pc.addTrack(track, composite);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    await sendOffer(privkey, monitorPubkey, fromPubkey, sdp, sessionId);
    // Viewer receives 'offer', sends 'answer', ontrack fires
  }
}
```

---

## 6. Data Channel Protocol

Two channels per connection:

- **Control channel** (`'control'`, JSON): requests, metadata, small responses, live-upgrade negotiation
- **Data channel** (`'data'`, binary/base64): segment chunk payloads

### Message Types (Complete Reference Table)

| Message Type | Direction | Payload | Purpose |
|---|---|---|---|
| `live-request` | V→M | `{ type, channelId }` | Upgrade data session to live; monitor adds tracks |
| `source-list-request` | V→M | `{ type }` | List open source IDs |
| `source-list` | M→V | `{ type, sourceIds: [string] }` | Response: available source IDs |
| `coverage-request` | V→M | `{ type, mimePrefix? }` | Coverage map for all segments |
| `coverage-map` | M→V | `{ type, coverage: [[start, end], ...], mimePrefix? }` | Merged intervals by mime type |
| `segment-request` | V→M | `{ type, time, mimePrefix? }` | Fetch segment at timestamp |
| `segment-meta` | M→V | `{ type, requestTime, segmentId, startTime, endTime, mimeType, sizeBytes, originMonitor, contentHash }` | Segment header (sent first) |
| `segment-chunk` | M→V | `{ type, requestTime, startTime, index, total, data: base64 }` | 32KB chunk (N chunks per segment) |
| `segment-error` | M→V | `{ type, requestTime, error }` | Segment not found / error |
| `segment-request-by-id` | V→M | `{ type, segmentId, mimePrefix? }` | Fetch specific segment by ID |
| `segment-meta-by-id` | M→V | Same as `segment-meta` | Response for by-id request |
| `segment-chunk-by-id` | M→V | Same as `segment-chunk` | Chunks for by-id request |
| `segment-error-by-id` | M→V | Same as `segment-error` | Error for by-id request |
| `segments-after-request` | V→M | `{ type, after, count, mimePrefix? }` | List up to 20 metas after timestamp |
| `segments-after` | M→V | `{ type, after, segments: [SegmentMeta], hasMore }` | Response: metadata array |
| `segments-before-request` | V→M | `{ type, before, count, mimePrefix? }` | List up to 20 metas before timestamp |
| `segments-before` | M→V | `{ type, before, segments: [SegmentMeta], hasMore }` | Response: metadata array |
| `segment-channels-request` | V→M | `{ type }` | List distinct channel IDs |
| `segment-channels` | M→V | `{ type, channels: [string] }` | Array of channel names |
| `coverage-channels-request` | V→M | `{ type, mimePrefix? }` | Per-channel coverage |
| `coverage-channels` | M→V | `{ type, coverage: {[channelId]: [[start, end], ...]} }` | Coverage by channel |
| `segments-in-range-request` | V→M | `{ type, from, to, limit, order, knownIds, mimePrefix?, channelId? }` | Metadata for segments in a time range, excluding known IDs |
| `segments-in-range` | M→V | `{ type, segments: [SegmentMeta] }` | Response: metadata array (up to limit) |
| `channel-list-request` | V→M | `{ type }` | Monitor's live ChannelConfig list |
| `channel-list` | M→V | `{ type, channels: [ChannelConfig] }` | Response with config array |

### Segment Transfer Protocol

Segments split into 32KB chunks (base64-encoded JSON) to respect WebRTC buffer limits.

**Flow:**

1. Viewer sends `segment-request` with timestamp or `segment-request-by-id` with ID
2. Monitor queries IDB/OPFS for segment
3. Monitor sends `segment-meta` (header with metadata + contentHash)
4. Monitor sends N `segment-chunk` messages (index 0..total-1), ~32KB each
5. Viewer accumulates chunks in order
6. When final chunk arrives (index === total - 1):
   - Reassemble bytes in order
   - Compute SHA-256 hash of raw reassembled bytes
   - Verify hash matches `contentHash` from metadata
   - Resolve Promise with Blob

**If segment not found:** send `segment-error` instead of `segment-meta`.

**Example segment-meta:**
```json
{
  "type": "segment-meta",
  "requestTime": 1700000000,
  "segmentId": "seg-abc123def",
  "startTime": 1699999995,
  "endTime": 1700000005,
  "mimeType": "video/webm; codecs=vp8",
  "sizeBytes": 245760,
  "originMonitor": "pubkey...",
  "contentHash": "sha256-hex..."
}
```

**Example segment-chunk:**
```json
{
  "type": "segment-chunk",
  "requestTime": 1700000000,
  "startTime": 1699999995,
  "index": 0,
  "total": 8,
  "data": "base64-encoded-32kb..."
}
```

---

## 7. Segment Boundary Navigation

For efficient timeline scrubbing without fetching entire segments:

```typescript
// Request metadata only (no blobs) for segments after a timestamp
requestSegmentsAfter(after: number, count: number)
  → send { type: 'segments-after-request', after, count }
  → receive { type: 'segments-after', segments: [SegmentMeta], hasMore }
  → return array of up to count SegmentMeta (capped at 20 for remote)

// Request metadata for segments before a timestamp
requestSegmentsBefore(before: number, count: number)
  → send { type: 'segments-before-request', before, count }
  → receive { type: 'segments-before', segments: [SegmentMeta], hasMore }
```

Enable pagination without loading segment blobs.

---

## 8. Error Handling & Timeouts

| Scenario | Timeout | Recovery |
|----------|---------|----------|
| Connection handshake | 60s | Reject Promise, close session, allow retry (rate-limited: 4s cooldown) |
| ICE connection | Implicit (browser) | `ice-failed` → close immediately; `ice-disconnected` → 8s grace → close |
| Data channel message | Request-specific (e.g., 30s) | Reject Promise, clear pending timer, allow next request |
| Monitor idle (no data messages) | 120s | Send hangup signal, close session |
| SDP gathering (non-trickle) | 5s | Proceed with partial candidates; no candidates abandons after timeout |
| Offer/answer publish | Implicit (Nostr outbox) | Rate-limit retries: 8s, then 15s delays |

**Rate-Limit Handling (Viewer):**
```typescript
const ANSWER_RETRY_DELAYS_MS = [8_000, 15_000];  // two retries
for (let attempt = 0; attempt <= ANSWER_RETRY_DELAYS_MS.length; attempt++) {
  try {
    await sendAnswer(...);
    break;
  } catch (e) {
    if (e.message.includes('rate-limited')) {
      const delay = ANSWER_RETRY_DELAYS_MS[attempt];
      if (delay) await new Promise(r => setTimeout(r, delay));
      else throw e;  // exhausted retries
    } else {
      throw e;  // non-rate-limit error
    }
  }
}
```

---

## 9. Signal Router (`signal-router.ts`)

A single global subscription to all signal kinds (5001–5006, 5010, 5011) handles incoming signals and routes them by kind:

| Kind | isResponse | Handler |
|------|-----------|---------|
| 5001 | false (offer-request) | `monitorHandler` |
| 5001 | true (offer + SDP) | `viewerHandler` |
| 5002 | false (answer SDP) | `monitorHandler` |
| 5003 | either (hangup) | Both handlers (each checks its own session map) |
| 5004 | false (announcement) | `updatePeerStatus()`; if age ≤ 15s and startup grace expired → auto-reply with kind 5004 isResponse=true |
| 5004 | true (reply) | `updatePeerStatus()` only (no further reply — prevents loops) |
| 5005 | false (relay proposal) | `handleRelayMigrationProposal()` |
| 5005 | true (relay ack) | `handleRelayMigrationAck()` |
| 5006 | — | Delivered to `RemoteCommandController` for TOTP validation and dispatch |
| 5010 | — | Delivered to caller via `onSignal(contactId, 5010, payload)` — viewer handles as trigger notification |
| 5011 | — | Delivered to caller via `onSignal(contactId, 5011, payload)` — viewer handles as arm state update |

**Startup Grace Period** (`AWARENESS_STARTUP_GRACE_MS = 20_000`): After the signal router starts, awareness replies are suppressed for 20s. This prevents relay rate-limit budget from being consumed by awareness reply bursts when both devices come online simultaneously. Allows WebRTC handshake (offer-request + answer) to complete without relay rate-limit pressure.

**Critical:** Signal routing is exclusively through the single global router. `viewer-peer.ts` and `monitor-peer.ts` do NOT open their own subscriptions — doing so would create duplicate subscriptions and trigger full relay replay on every connection attempt.

---

## 10. Example Workflows

### Workflow 1: Viewer Connects for Data-Only Access

```
User clicks "Connect to Monitor"
  │
  1. Viewer: ensureConnection(privkey, myPubkey, monitorPubkey, mode='data')
  2. Viewer: createPeer()
  3. Viewer: sendOfferRequest(mode='data') [Nostr event 1]
  4. Monitor: receives on signal router → handleOfferRequest()
  5. Monitor: createPeer() [NO media tracks for data mode]
  6. Monitor: createDataChannels('control', 'data')
  7. Monitor: createOffer() → setLocalDescription() → waitForIceGathering() [~100-500ms]
  8. Monitor: sendOffer() [Nostr event 2]
  9. Viewer: receives 'offer' signal → setRemoteDescription() → createAnswer() → setLocalDescription()
  10. Viewer: waitForIceGathering() [~100-500ms]
  11. Viewer: sendAnswer() [Nostr event 3]
  12. Monitor: receives 'answer' signal → setRemoteDescription()
  13. Both: data channels open, control channel fires onopen → connection ready
  
Result: 3 Nostr events, ~2-5 seconds elapsed
Viewer can now: request coverage maps, segment lists, download archived segments
```

### Workflow 2: Viewer Upgrades to Live View (From Data Session)

```
Data session already open (from Workflow 1)
User clicks "Watch Live"
  │
  1. Viewer: set session.mode = 'live'
  2. Viewer: send { type: 'live-request', channelId: 'front-door' } on controlChannel
  3. Monitor: receives on control channel → live-request handler
  4. Monitor: buildCompositeStream('front-door') → selects camera+mic tracks
  5. Monitor: pc.addTrack(...) for each track
  6. Monitor: createOffer() → waitForIceGathering() → sendOffer() [Nostr event 4]
  7. Viewer: receives 'offer' signal → setRemoteDescription()
  8. Viewer: createAnswer() → sendAnswer() [Nostr event 5]
  9. Monitor: receives 'answer' signal → setRemoteDescription()
  10. Both: ontrack fires → media stream available → UI displays live view
  
Result: 2 additional Nostr events
Total from start: 3 + 2 = 5 events (~1-2 seconds for upgrade)
(vs 7 if connection was closed and reopened as 'live' from scratch)
```

### Workflow 3: Fetch Segment at Specific Timestamp

```
Viewer scrubs timeline to t=1700000000
  │
  1. Viewer: requestSegment(1700000000, privkey, ...)
  2. Viewer: ensureConnection(...) [reuses existing session]
  3. Viewer: send { type: 'segment-request', time: 1700000000 } on controlChannel
  4. Viewer: register Promise in pendingSegments[1700000000]
  
  5. Monitor: receives 'segment-request'
  6. Monitor: query IDB for segment containing t=1700000000
  7. Monitor: send { type: 'segment-meta', segmentId: 'seg-abc', ... }
  8. Monitor: stream to dataDc: { type: 'segment-chunk', index: 0, total: 8, data: base64 }
  9. Monitor: stream: { type: 'segment-chunk', index: 1, total: 8, data: base64 }
  10. ... (6 more chunks)
  
  11. Viewer: collect chunks in pendingSegments[1700000000].chunks[]
  12. Viewer: on index === 7 (total-1): reassemble, verify contentHash
  13. Viewer: resolve Promise with Blob
  
Result: 1 controlChannel message + 8 dataChannel messages
Data transfer: ~256KB segment in ~32KB chunks
Latency: ~50-500ms depending on segment size and WebRTC buffer availability
```

### Workflow 4: Fetch Segment Metadata for Timeline (Boundary Navigation)

```
Viewer clicks "Next" in timeline UI (pagination)
  │
  1. Viewer: requestSegmentsAfter(lastSegmentEndTime, count=5)
  2. Viewer: send { type: 'segments-after-request', after: 1700000020, count: 5 } on controlChannel
  
  3. Monitor: query IDB for segments starting after 1700000020
  4. Monitor: limit to 20 segments (for remote)
  5. Monitor: send { type: 'segments-after', segments: [{startTime, endTime, ...}, ...], hasMore: true }
  
  6. Viewer: resolve Promise with array of 5 SegmentMeta
  7. Viewer: render in timeline UI (no blobs yet)
  
Result: 1 controlChannel message, metadata only
Enables pagination without fetching blobs until user clicks a specific segment
```

---

## 11. Architecture Principles

1. **Stateless handlers** — Each data channel request is independent; no multi-step state machine on monitor side
2. **Promise-based API** — All viewer-side requests return Promises, enabling async/await patterns
3. **Chunk-based transfer** — Segments split into ~32KB chunks to respect WebRTC buffer limits
4. **Reusable patterns** — `requestX()` and `handleX()` functions enable clean, testable code
5. **No media in relay** — All media travels P2P; relay carries only tiny JSON control messages
6. **Graceful degradation** — Data channels work without media tracks; media can upgrade later (in-band)
7. **Non-trickle ICE** — Reduces relay traffic by embedding all candidates in SDP before sending
8. **Channel-key privacy** — Real pubkeys never appear on Nostr post-pairing; all signals use ECDH-derived channel keys

---

