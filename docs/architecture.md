# Architecture

## Overview

Senstry is a browser-only, peer-to-peer home security monitor. There is no backend. Two roles exist on any device at any time:

- **Monitor** — records continuously, runs detectors, publishes events, serves footage on demand
- **Viewer** — subscribes to events, requests live streams and historical footage, stores alerts

Both roles run in the same SvelteKit app; a device can be both simultaneously (useful for testing). The `/dev` route is the primary interface.

```
Monitor Device                       Viewer Device
─────────────────────                ─────────────────────
MediaRecorder                        Alert log
  │ 10s chunks                       Timeline player
  ▼                                  WebRTC data channel client
OPFS + IDB                           IDB (event cache)
  │                                    │
  ├── Nostr relay ──────────────────── Nostr subscribe
  │   (kind 5010 triggers,             (alerts, arm state,
  │    kind 5011 arm state,             footage refs)
  │    kind 30020 footage refs)
  │
  └── WebRTC P2P ────────────────────── WebRTC P2P
      (live stream)                      (live stream)
      (data channel: segment transfer)   (data channel: fetch)
```

## Signal Flow

All WebRTC signaling travels over Nostr using **NIP-59 gift-wrap** (kind 1059). This means relay operators cannot correlate monitor and viewer pubkeys — each gift-wrap uses a one-time ephemeral key.

```
Viewer                    Nostr Relay               Monitor
  │                           │                        │
  │── offer-request ─────────▶│───────────────────────▶│
  │   (kind 1059, gift-wrap)  │                        │ creates offer
  │                           │◀── offer ──────────────│
  │◀── offer ─────────────────│   (kind 1059)          │
  │ sets remote description   │                        │
  │── answer ─────────────────▶───────────────────────▶│
  │                           │                        │ sets remote desc
  │           ┄┄ ICE (embedded in SDP, non-trickle) ┄┄│
  │                     P2P CONNECTED                  │
```

Non-trickle ICE is deliberate: `waitForIceGathering()` holds the SDP until all candidates are gathered, reducing relay events from ~15 to 3 per handshake.

## Module Structure

```
src/lib/
├── webrtc/           WebRTC peer management and data channel protocol
├── nostr/            Nostr client, crypto (NIP-44/59), event builders
├── db/               IndexedDB schema, segment lifecycle, footage refs
├── store/            Svelte stores: pipeline, identity, settings, monitor state
├── detectors/        Pluggable sensor implementations
└── components/dev/   Dev panel UI sections
```

## Data Persistence

| What | Where | Format |
|------|-------|--------|
| Identity keypair | IDB `settings['identity']` | `{ privkey: Uint8Array, pubkey: string }` |
| Paired devices | IDB `pairedDevices` | `PairedDevice[]`, keyed by pubkey |
| App settings | IDB `settings['app.settings']` | `AppSettings` JSON |
| Pipeline config | IDB `settings['pipeline.*']` | Separate keys per section |
| Segment metadata | IDB `segments` | `SegmentMeta`, keyed by segmentId |
| Segment blobs | OPFS `recordings/<segmentId>` | Raw binary |
| Footage refs | IDB `footageRefs` | `FootageRef`, keyed by refId |
| Nostr event cache | IDB `events` | Raw `NostrEvent` JSON |

## Initialization Sequence

On page load, `+layout.svelte` runs in order:
1. `loadIdentity()` — load or generate keypair from IDB
2. `loadSettings()` — load app settings
3. `loadPipeline()` — load or migrate pipeline config
4. `loadStorageCleanup()` — load thinning/quota rules
5. `loadPairedDevices()` — populate devices store
6. Start Nostr subscriptions (alert listener if identity exists)

## Monitor State Machine

```
idle ──startMonitor()──▶ starting ──streams open──▶ active
                                                       │
                         ◀──stopMonitor()─────────── stopping
                                │
                         paused-nostr   (Nostr paused, still recording)
                         no-store       (recording off, Nostr on)
```

Helper predicates in `store/monitor.ts`:
- `isActive(state)` — detectors running
- `isStoring(state)` — MediaRecorder running
- `isPublishing(state)` — Nostr events being sent

## Privacy Properties

| Threat | Mitigation |
|--------|------------|
| Relay operator sees who talks to whom | NIP-59 gift-wrap uses one-time ephemeral pubkeys |
| Relay operator reads event content | NIP-44 ChaCha20-Poly1305 encryption to recipient pubkey |
| Media exfiltration | Media never published to relay; only sent P2P over WebRTC to paired viewers |
| Identity theft | Private key in IDB, never exposed in URL/cookies/localStorage |
| Replay attacks | Signal TTL: inner rumor `created_at` checked; stale signals (>60s) dropped |
| Segment dedup across viewer chains | `backupOf` field tracks canonical origin segment ID |
