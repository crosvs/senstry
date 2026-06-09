# WebRTC Peer & Signaling

This document covers the low-level WebRTC configuration and signal wire format: ICE gathering strategy, the `RTCPeerConnection` factory, STUN/TURN setup, the Nostr signal envelope, ECDH channel key encryption on signals, TTL enforcement, deduplication, and a brief module map.

Session lifecycle and connection flows are in [webrtc-session.md](webrtc-session.md). Data channel message types and the segment transfer protocol are in [webrtc-data-channel.md](webrtc-data-channel.md). Signal kind definitions (5001–5006, 5010–5011) are in [signal-exchange.md](signal-exchange.md).

---

## Module Responsibilities

| Module | Role | Perspective |
|---|---|---|
| `peer` | `RTCPeerConnection` factory, ICE server config, `waitForIceGathering` | Symmetric |
| `signaling` | Signal send/receive, ECDH channel key derivation, NIP-44 encryption, TTL, dedup | Symmetric |
| `viewer-peer` | Viewer session management, Promise-based request API | Viewer side |
| `monitor-peer` | Monitor session management, data channel message server, offer creation | Monitor side |

Signal routing (kind → handler dispatch) is a Nostr-layer concern; see [signal-exchange.md](signal-exchange.md) § Signal Router.

---

## Session State

`viewer-peer` and `monitor-peer` maintain runtime session maps:

Viewer side:

```typescript
interface ViewerSession {
  pc: RTCPeerConnection
  controlChannel: RTCDataChannel
  state: 'connecting' | 'connected' | 'live' | 'closed'
}
// Internal maps
sessions: Map<contactId, ViewerSession>
connectPromises: Map<contactId, { resolve, reject }>
pendingLiveUpgrades: Map<contactId, { resolve, reject }>
connectAborts: Map<contactId, AbortController>
```

Monitor side:

```typescript
interface MonitorSession {
  pc: RTCPeerConnection
  controlChannel: RTCDataChannel
  dataChannel: RTCDataChannel   // fixed label 'data'
  state: 'connected' | 'live' | 'closing'
  generation: number  // incremented on every closeSession(); async callbacks check stale generation and bail out
}
// Internal map
sessions: Map<viewerContactId, MonitorSession>
```

Session maps are keyed by `contactId`. Sessions are created on first connection and removed on close or error. `contactId` is the UUID from `ContactEntry` (not `monitorPubkey` or `viewerPubkey`) and serves as the canonical session key for consistency with the signal layer.

---

## ICE Configuration

### STUN Server

```typescript
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
```

No TURN server is configured. Connections behind symmetric NAT (e.g., carrier-grade NAT, home routers with UPnP disabled) may fail at ICE negotiation. Adding TURN is straightforward:

```typescript
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-turn-server.example.com:3478?transport=udp',
    username: '...',
    credential: '...'
  }
];
```

When ICE fails due to NAT traversal, the user sees: `"ICE connection failed — NAT traversal may require a TURN server"`.

### RTCPeerConnection Factory

`createPeer()` in `peer` is the single creation point for all `RTCPeerConnection` instances. Both monitor and viewer use it.

```typescript
export function createPeer(options?: RTCConfiguration): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    ...options
  });
}
```

---

## Non-Trickle ICE Gathering

### Why Non-Trickle

Trickle ICE sends the SDP offer immediately, then emits candidate events separately — roughly 1 offer + N candidates from each side, totalling ~15 Nostr relay events per handshake. Senstry waits for ICE gathering to complete before sending SDP, so all candidates are embedded in the SDP body. This compresses the handshake to 3 Nostr events total (offer-request + offer + answer), fitting comfortably within relay rate limits.

### Implementation

`waitForIceGathering(pc, timeoutMs=5000)` in `peer`:

```typescript
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (timer !== null) clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', handler);
      resolve();
    };
    const handler = () => { if (pc.iceGatheringState === 'complete') done(); };
    timer = setTimeout(done, timeoutMs); // proceed after 5s even if STUN fails
    pc.addEventListener('icegatheringstatechange', handler);
  });
}
```

The 5-second timeout is a safety valve: if the STUN server is unreachable or address enumeration is slow, the code proceeds with whatever candidates were gathered rather than blocking indefinitely. A partial candidate set still allows direct LAN connections.

### Call Sites

`waitForIceGathering` is called in three places, always after `setLocalDescription` and always before sending the SDP over Nostr:

1. Monitor in `handleOfferRequest` — after creating the initial offer
2. Viewer in `handleViewerSignal` — after creating the answer
3. Monitor during live-upgrade renegotiation — after creating the renegotiation offer

The pattern is always:

```typescript
await pc.setLocalDescription(sdp);
await waitForIceGathering(pc);
await sendSdp(pc.localDescription!.sdp); // single Nostr event, all candidates embedded
```

---

## Signal Message Format

All WebRTC signals travel as Nostr events. Each signal type has its own kind number; within a kind, `isResponse` distinguishes the initiating from the responding party.

### Nostr Event Properties

| Property | Value |
|---|---|
| `kind` | 5001–5006, 5010, 5011 |
| `pubkey` | ECDH-derived channel key (never the real identity key) |
| `content` | NIP-44 ChaCha20-Poly1305 ciphertext over the JSON payload |
| `created_at` | Honest wall-clock timestamp (not randomized) |
| `tags` | Empty for most kinds; session-directed kinds include `#s` tag with session UUID |

Gift wrap (NIP-59) is not used. All signals use single-layer NIP-44 encryption over ECDH-derived channel keys. Signal kind semantics (5001–5006, 5010, 5011) are defined in [signal-exchange.md](signal-exchange.md).

### Subscription Window

The signal router opens T+0 subscriptions (`since: Math.floor(Date.now() / 1000)`). No history is replayed on subscribe. Honest `created_at` timestamps make this window reliable — events cannot be backdated to slip through a future subscription.

---

## ECDH-Derived Channel Keys

### Derivation

Both devices independently derive the same directional channel keypairs from their ECDH shared secret. No key exchange is required beyond what already happened during pairing.

Channel keys derive from **device keys**, not identity keys. Each device installation has a unique device keypair, so two devices sharing an identity key still have fully isolated signal channels.

```typescript
// Both sides compute independently:
const sharedSecret = getConversationKey(devicePrivkey, peerDevicePubkey);

// Monitor → Viewer direction
const monitorOutbound = deriveChannelKey(sharedSecret, monitorDevicePubkey, viewerDevicePubkey);

// Viewer → Monitor direction
const viewerOutbound = deriveChannelKey(sharedSecret, viewerDevicePubkey, monitorDevicePubkey);

// Invariant (both sides):
// monitorOutbound === viewerInbound  ✓
// viewerOutbound  === monitorInbound ✓
```

`deriveChannelKey` is deterministic and directional: swapping the pubkey arguments produces a different key. Channel keys are not persisted — they are re-derived from the stable device keypair at startup.

### Transmission

`sendSignal()` in `signaling` signs and publishes each event under the sender's outbound channel key:

```typescript
const sharedSecret = getConversationKey(devicePrivkey, peerDevicePubkey);
const outboundChannelPrivkey = deriveChannelKey(sharedSecret, ownDevicePubkey, peerDevicePubkey);
const outboundChannelPubkey = getPublicKey(outboundChannelPrivkey);

const content = encryptSignalContent(JSON.stringify(payload), outboundChannelPrivkey, outboundChannelPubkey); // nip44.encrypt(plaintext, channelPrivkey, channelPubkey) — see nostr-protocol.md § Encryption Models

const event = finalizeEvent({
  kind,
  created_at: Math.floor(Date.now() / 1000),
  tags: sessionId ? [['s', sessionId]] : [], // session-directed kinds include ["s", sessionId]; broadcast kinds pass []
  content
}, outboundChannelPrivkey);
```

### Reception

The signal router derives each paired device's inbound channel pubkey, subscribes to events authored by that pubkey, and verifies it before decrypting. Real device pubkeys never appear as the Nostr `pubkey` field on any signal event.

### Benefits

- **No key exchange:** Channel keys derive from the already-established ECDH shared secret.
- **Honest timestamps:** Because channel pubkeys are not real identity keys, `created_at` does not need randomization for metadata privacy. Reliable timestamps make `since` filters precise.
- **Single encryption layer:** One NIP-44 envelope — no nested gift wrapping.
- **Direction isolation:** Each direction uses a distinct key, so a compromised inbound key does not expose outbound traffic.

---

## Signal TTL

TTL is checked against the event's honest `created_at` timestamp. Events older than the per-kind TTL are discarded on receipt. Per-kind TTL values are defined in [signal-exchange.md](signal-exchange.md).

The 10-second TTL on kind 5001 (offer-request) also serves as stale-event protection: because the signal router opens T+0 subscriptions, relayed buffer replays cannot reach the monitor. The TTL discards any event that arrives outside that window regardless of the relay's buffering behavior.

---

## Signal Deduplication

`signaling` maintains a module-level `seenEventIds: Set<string>` that is cleared every 60 seconds.

Two mechanisms combine to eliminate duplicate processing:

1. **Subscription window (`since: now`)** — T+0 subscriptions exclude events published before the subscription opened. The `seenEventIds` set guards against multi-relay duplicate delivery of the same event within the subscription window — not against relay replay across different session starts.

2. **Event ID set** — Catches the narrow window where the same event is delivered twice within the 60-second rolling window (e.g., the same event received from two relays simultaneously).

Per-relay deduplication ensures that a signal delivered through multiple relay connections is processed exactly once.

Signal routing — kind dispatch, subscription management, and the startup grace period — is defined in [signal-exchange.md](signal-exchange.md).
