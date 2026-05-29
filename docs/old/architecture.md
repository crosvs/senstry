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

All WebRTC signaling travels over Nostr using **ECDH-derived channel keys** (kind 5001, Phase 3). Each paired device has its own pseudonymous channel keypair, derived from the ECDH shared secret of their real keys. Relay operators cannot correlate monitor and viewer real pubkeys — they only see the stable channel pubkeys.

```
Viewer                    Nostr Relay               Monitor
  │                           │                        │
  │── offer-request ─────────▶│───────────────────────▶│
  │   (kind 5001, channel-key)│                        │ creates offer
  │                           │◀── offer ──────────────│
  │◀── offer ─────────────────│   (kind 5001)          │
  │ sets remote description   │                        │
  │── answer ─────────────────▶───────────────────────▶│
  │                           │                        │ sets remote desc
  │           ┄┄ ICE (embedded in SDP, non-trickle) ┄┄│
  │                     P2P CONNECTED                  │
```

Non-trickle ICE is deliberate: `waitForIceGathering()` holds the SDP until all candidates are gathered, reducing relay events from ~15 to 3 per handshake. Channel-key encryption is one-layer NIP-44 (vs. gift-wrap's two layers), with honest timestamps that shrink the relay subscription window from ~1.6 h to ~1 h.

## Module Structure

```
src/lib/
├── webrtc/           WebRTC peer management and data channel protocol
├── nostr/            Nostr client, crypto (NIP-44/59), event builders
├── db/               IndexedDB schema, segment lifecycle, footage refs
├── store/            Svelte stores: pipeline, identity, settings, monitor state
├── detectors/        Pluggable sensor implementations
└── components/dev/   Dev panel UI sections
docs/
├── architecture.md         ← this file: system overview and cross-cutting concerns
├── webrtc.md               WebRTC protocol, signal flow, data channel message reference
├── nostr.md                Nostr event kinds, encryption, presence protocol, outbox, redesign direction
├── pipeline.md             Pipeline types, defaults, persistence
├── detectors.md            Sensor implementations and state machines
├── storage.md              IDB schema, OPFS layout, segment lifecycle, thinning
├── timeline.md             TimelineSection + TimelineScrubber UI components
├── content-viewer.md       ContentViewerSection controller state machine
├── controller-architecture.md  State ownership rules, dumb-component contracts
└── plans/                  Refactor and future-feature specs (separate from current-behaviour docs)
    ├── sentry-controller.md    SentrySection extraction plan (DetectorController etc.)
    ├── multi-view.md           Multi-device/multi-channel simultaneous viewing spec
    └── nostr-redesign.md       ECDH-derived channel key redesign spec
```

## Data Persistence

| What | Where | Format |
|------|-------|--------|
| Identity keypair | IDB `settings['identity']` | `{ privkey: Uint8Array, pubkey: string }` |
| Paired devices | IDB `pairedDevices` | `PairedDevice[]`, keyed by pubkey |
| App settings | IDB `settings['app.settings']` | `AppSettings` JSON |
| Pipeline config | IDB `settings['pipeline.*']` | Separate keys per section |
| Segment metadata | IDB `segments` | `SegmentMeta`, keyed by segmentId; `originMonitor` index for O(1) device-scoped queries |
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

## Nostr Online Gate

`nostrOnline` (`store/nostr-online.ts`) is the master switch for all Nostr activity. The monitor is **local-first** — it runs entirely without Nostr. Going online/offline does not affect the monitor state machine; it only controls whether signals and notifications are published.

When `nostrOnline` flips to `true`, `SentrySection` opens the signal router subscription and broadcasts an online announcement to all paired devices. When it flips to `false`, the router is closed.

Relay errors trigger auto-offline: 3 consecutive all-relay publish failures set `nostrOfflineReason` and call `goOffline()`.

## Monitor State Machine

```
idle ──startMonitor()──▶ starting ──streams open──▶ active
                                                       │
                         ◀──stopMonitor()─────────── stopping
```

The monitor can be in any state while `nostrOnline` is either `true` or `false` — they are independent dimensions. `isPublishing()` in `store/monitor.ts` reflects whether the monitor would normally publish, but actual publishing is additionally gated on `get(nostrOnline)`.

Helper predicates in `store/monitor.ts`:
- `isActive(state)` — detectors running
- `isStoring(state)` — MediaRecorder running
- `isPublishing(state)` — Nostr events being sent (also requires `nostrOnline`)

## SentrySection (Embedded Monitor Logic)

`SentrySection.svelte` currently embeds all detector and action orchestration in the same component that renders the arm/disarm UI. The key logic blocks are:

- `_evaluateLinks()` — evaluates pipeline links on each sensor state change
- `_activateAction()` / `_deactivateAction()` — manage `actionStates`, start/stop recording, clips, snapshots, notify
- `_updateChannelActiveSources()` — after a `RecordAction` activates, pushes capture source IDs to `monitor-peer.setChannelActiveSources()` for live RTC compositor override
- `_handleClipSession()` — pins segments when `ClipAction` fires
- `_handleSnapshotBurst()` — photo capture burst loop
- `_handleSensorStateForNotify()` — checks `NotifyAction.publishStates` on each sensor change

The planned extraction separates these into `DetectorController`, `ActionController`, `RecordingController`, `ClipController`, `SnapshotController`, and `TriggerPublisher` — all plain TypeScript classes with no Svelte dependency and full unit test coverage. See `docs/plans/sentry-controller.md`.

## Nostr Redesign (Phase 3: Complete)

Post-pairing WebRTC signaling now uses **ECDH-derived channel keys** (kind 5001) — both devices independently derive the same directional channel keypairs from the ECDH shared secret of their real keys. No key exchange or schema migration is needed; channel keys are derived from data already in `pairedDevices`.

Each device publishes signals (kind 5001) signed with its outbound channel key and subscribes to the peer's outbound channel key via `authors` filter. Content is NIP-44 encrypted (single layer). `created_at` is honest, enabling reliable relay `since` filters.

NIP-59 gift-wrap has been removed from signaling (Phase 3 complete). Device pairing now uses ephemeral ECDH keys with the same NIP-44 encryption. Nostr Actions (kind 5010 triggers, kind 5011 arm state, kind 30020 footage refs) are intentionally published to the monitor's real pubkey for asymmetric subscriptions.

See `docs/plans/nostr-communication-redesign.md` for the full architecture spec.

## Future Architecture

### Multi-Device / Multi-Channel Viewing

The data model already supports multiple monitors (`originMonitor`) and channels (`channelId`) on all segment queries and coverage maps. What is missing is a controller that runs multiple player instances simultaneously. See `docs/plans/multi-view.md`.

### Playback Speed and Jump Controls

Speed control: apply a multiplier to the 200ms player tick delta and set `videoEl.playbackRate`. Jump controls: call `playerSeekTo(playerPosition ± jumpSec)` then `_ctrlAfterScrub()`. Both are controller-only changes with no data model impact. See `docs/plans/multi-view.md` for implementation notes.

## Privacy Properties

| Threat | Mitigation |
|--------|------------|
| Relay operator sees who talks to whom | NIP-59 gift-wrap uses one-time ephemeral pubkeys |
| Relay operator reads event content | NIP-44 ChaCha20-Poly1305 encryption to recipient pubkey |
| Media exfiltration | Media never published to relay; only sent P2P over WebRTC to paired viewers |
| Identity theft | Private key in IDB, never exposed in URL/cookies/localStorage |
| Replay attacks | Signal TTL: inner rumor `created_at` checked; stale signals (>10s for RTC, >1h for status) dropped |
| Presence stale-replay | `updatePeerStatus` freshness guard: only newer `createdAt` updates the known state |
| Segment dedup across viewer chains | `backupOf` field tracks canonical origin segment ID |
