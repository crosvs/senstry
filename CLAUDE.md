# Senstry — Claude Code Reference

## What This Project Is

Senstry is a **privacy-first, browser-based home security monitor**. A monitor device (phone/laptop with camera+mic) pairs with a viewer device over Nostr. After pairing, all communication is P2P WebRTC — media never touches any server. No accounts, no cloud, no open ports.

The dev panel at `/dev` is the primary UI. It is a single-page dashboard split into sections covering identity, relay config, pairing, live view, content browsing, storage, and the full pipeline/settings.

## Commands

```bash
npm run dev        # start dev server (port 5173)
npm run build      # static production build → build/
npm run check      # svelte-check + tsc — run this after every change
npm run test       # vitest run (unit tests, no browser)
```

**Always run `npm run check` after edits.** 0 errors is the bar; the ~9 existing warnings are pre-existing and unrelated to any current work.

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | SvelteKit 2 + **Svelte 5 runes** (`$state`, `$derived`, `$effect`) |
| Styling | Tailwind CSS v4 |
| P2P streaming | WebRTC (`RTCPeerConnection`, `MediaRecorder`, `RTCDataChannel`) |
| Signaling | Nostr (kind 1059 NIP-59 gift-wrap) |
| Storage | IndexedDB (`idb` v8) + OPFS for segment blobs |
| Crypto | `nostr-tools` (secp256k1, NIP-44 ChaCha20-Poly1305) |
| Build | Vite 8 |
| Tests | Vitest + happy-dom |

## Project Layout

```
src/
  routes/
    dev/+page.svelte          ← main dev dashboard
  lib/
    webrtc/
      peer.ts                 ← RTCPeerConnection helpers, non-trickle ICE
      signaling.ts            ← NIP-59 gift-wrap send/receive
      signal-router.ts        ← single global kind-1059 subscription
      viewer-peer.ts          ← viewer session management, live upgrade, data channel client
      viewer-peer.test.ts     ← unit tests for viewer-peer
      monitor-peer.ts         ← monitor session management, live renegotiation, data channel server
      monitor-peer.test.ts    ← unit tests for monitor-peer
    nostr/
      client.ts               ← SimplePool wrapper, rate limiter, publish/subscribe
      crypto.ts               ← NIP-44 encrypt/decrypt, NIP-59 gift-wrap/unwrap
      events.ts               ← event builder functions, kind constants
      keys.ts                 ← keypair load/create/import
    db/
      idb.ts                  ← IDB schema (v8), openDB
      segments.ts             ← segment save/query/evict/thin/pin; OPFS blob storage
      footage.ts              ← footage ref CRUD
    store/
      pipeline.ts             ← all pipeline types + stores + persistence + migration
      identity.ts             ← keypair + paired devices
      settings.ts             ← app settings (relay, label, rate limit, idle timeout)
      nostr-online.ts         ← nostrOnline gate + relay error auto-offline
      peer-status.ts          ← peerStatuses store + updatePeerStatus (presence)
      monitor.ts              ← monitor runtime state enum
      debug.ts                ← dbg() logger with category filter
    detectors/
      audio.ts                ← AudioDetector (Web Audio API, RMS + hysteresis)
      schedule.ts             ← interval timer sensor
      timewindow.ts           ← hour-slot schedule sensor
      daterange.ts            ← date-bounded sensor
      nostr-trigger.ts        ← fires on incoming Nostr trigger events
      photo.ts                ← photo capture helper
    components/dev/
      SentrySection.svelte    ← arm/disarm, detector loop, action state machine, signal router lifecycle
      SettingsSection.svelte  ← full pipeline UI (sources, sensors, captures, channels, links, actions)
      LiveViewSection.svelte  ← WebRTC live stream viewer
      ContentViewerSection.svelte ← segment player + fetch UI
      SegmentStorageSection.svelte ← quota/eviction stats
      AlertsSection.svelte    ← incoming trigger notifications
      DevicesSection.svelte   ← paired device list
docs/
  architecture.md
  pipeline.md
  webrtc.md
  storage.md
  nostr.md
  detectors.md
```

## Key Architectural Decisions

### Svelte 5 Runes
The codebase uses Svelte 5 runes throughout. Use `$state`, `$derived`, `$effect`, `untrack()`. Do not use Svelte 4 syntax (`$:`, `let x = ...` as reactive).

### Non-trickle ICE
`peer.ts:waitForIceGathering()` waits for all ICE candidates before sending SDP. This compresses signaling from ~15 Nostr events to 3 (offer-request → offer → answer) for a fresh connection, and to 2 (renegotiation offer + answer) for a live upgrade. The 5s timeout guards against STUN failure.

### Live Upgrade Path (data → live, in-band)
When a viewer already has an open data connection, "Watch Live" sends `{ type: 'live-request', channelId }` over the existing `controlChannel` instead of closing and reopening. The monitor adds media tracks and sends a renegotiation offer (1 Nostr event); the viewer answers (1 Nostr event). This avoids the full 3-event handshake and stays within relay rate limits when both devices recently connected.

`pendingLiveUpgrades` in `viewer-peer.ts` tracks the in-flight upgrade promise. `closeSession` rejects it on disconnect. The `onTrack` handler in `ensureConnection` reads `session.mode` dynamically so it resolves the upgrade when the renegotiated stream arrives.

### Pipeline: Links + Actions (not the old per-type links)
The pipeline uses a two-layer model:
- **Links** are stateless condition wires: `sensorIds[]` + `condition: any|all` + `onState: sensing|active` → `actionIds[]`
- **Actions** own their config and runtime state: `RecordAction`, `ClipAction`, `SnapshotAction`, `NotifyAction`

Do not conflate them. `SentrySection` manages `actionStates` (the runtime `Record<actionId, ActionState>`). `SettingsSection` manages the persisted config.

### Nostr Online Gate

`nostrOnline` (in `store/nostr-online.ts`) is the master on/off switch for all Nostr activity. No Nostr event is sent while it is `false`.

- `goOnline()` — sets `nostrOnline = true`; SentrySection's `$effect` opens the signal router and announces `status: online, isAnnounce: true` to all paired devices
- `goOffline()` — announces `status: offline` to all paired devices FIRST (so the signal can still publish), then calls `clearQueued()` to discard pending outbox items, then sets `nostrOnline = false`
- Relay errors auto-offline: `reportPublishError` in `client.ts` increments a failure counter; after 3 consecutive all-relay failures it sets `nostrOfflineReason` and calls `goOffline()`. Rate-limit errors (local token bucket) are ignored.
- The outbox flusher (`nostr/outbox.ts`) is also gated on `nostrOnline` — it returns early if offline.
- **Monitor continues running when offline.** Going offline/online does not affect monitor state.

### Presence / Status Protocol

Devices announce their Nostr online status to paired devices via `status` signal messages. The protocol avoids feedback loops:

- On `goOnline()`: broadcast `{ type: 'status', state: 'online', isAnnounce: true }` to all paired devices
- On `goOffline()`: broadcast `{ type: 'status', state: 'offline' }` before disconnecting
- On receiving `{ isAnnounce: true }` from a fresh event (≤15s old): reply once with `{ type: 'status', state: 'online' }` (no `isAnnounce`) — this is an awareness reply, not a re-announcement
- Awareness replies do NOT trigger another reply — only `isAnnounce: true` messages do
- **Startup grace** (`AWARENESS_STARTUP_GRACE_MS = 20_000`): awareness replies are suppressed for the first 20 seconds after `startSignalRouter()` runs. This reserves relay rate-limit budget for the WebRTC handshake (offer-request + answer) when both devices come online simultaneously.
- **Per-peer awareness cooldown** (`AWARENESS_COOLDOWN_MS = 60_000` in `signal-router.ts`): don't reply to the same peer more than once per minute — prevents reply bursts on relay reconnect/replay
- **Announcement cooldown** (`ANNOUNCE_COOLDOWN_MS = 60_000` in `SentrySection.startRouter()`): don't re-announce to the same paired device within 60 seconds — prevents double announcements when the signal router restarts due to a relay URL change
- `status-request` messages get an immediate online status reply regardless of startup grace (used by the "Status?" button)
- `STATUS_TTL_S = 3600`: status signals are accepted up to 1 hour after their inner `created_at`
- `peerStatuses` store tracks known online/offline states. `updatePeerStatus` has a freshness guard: newer `createdAt` only, preventing stale relay replays from overwriting a known-good state

### Channel Active Sources
When a `RecordAction` activates, `SentrySection._updateChannelActiveSources()` pushes the recording captures' source IDs to `monitor-peer.setChannelActiveSources()`. The live RTC compositor uses these as overrides; `ChannelConfig.videoSourceId`/`audioSourceId` are fallback defaults only.

### Segment Pinning
`pinnedUntil` semantics in `segments.ts`:
- `null` — never pinned (rolling buffer candidate, evictable)
- `-1` — pin expired (left for thinning rules, not rolling-buffer eviction)
- `0` — pinned forever
- `N > 0` — pinned until unix timestamp N

### Device-Scoped Segment Filtering
Fetched segments and stored segments are tagged with `originMonitor: string` (source device pubkey) to support multi-device viewers. In `ContentViewerSection`:
- **Player and Fetcher are independent UIs**: the player has its own time range, type filters, channel filters, and loads from local IDB; the fetcher has separate controls for RTC/remote fetching
- **Fetched segments list**—shown as a browsable table below the player—filters automatically by `selectedMonitorPubkey` (set in `DevicesSection`). When no device is selected, all fetched segments appear; when a device is selected, only that device's segments show
- **Dedup key format**: `${source}-${originMonitor}-${segmentId}` prevents cross-device ID collisions
- **Player segment index** (`_playerIdx` derived): pre-splits `playerSegs` into `videoByChannel`, `audioByChannel`, `photos`, `allVideo`, `allAudio` for O(1) access; updated only when `playerSegs` changes, not per tick
- **Mobile perf**: player tick uses binary search O(log n) to find segment at playback time; IDB queries use `originMonitor` index for O(1) device-scoped lookups

### IDB Schema (v8)
Stores: `settings`, `pairedDevices`, `events`, `pendingInvites`, `footageRefs`, `photos`, `outbox`, `segments`. Segment blobs live in OPFS (`recordings/<segmentId>`), only metadata in IDB.

**v8 migration**: added `originMonitor` index on segments store for device-scoped queries (`getAllFromIndex('segments', 'originMonitor', pubkey)`), enabling O(1) lookup instead of full-table scan when filtering by source device.

## Common Patterns

### Adding a new data channel message type
1. Add the request handler in `monitor-peer.ts:handleDataMessage()`
2. Add the sender + response handler in `viewer-peer.ts` (look at existing `requestCoverageMap` / `requestSegment` for the Promise pattern)

### Adding a new Nostr event kind
1. Define `KIND_*` constant in `nostr/events.ts`
2. Add builder function there
3. Subscribe in the appropriate store or component using `subscribe()` from `nostr/client.ts`

### Adding a new sensor type
1. Implement `Detector` interface from `detectors/types.ts`
2. Add `type` discriminant to `SensorConfig` in `pipeline.ts`
3. Wire it in `SentrySection.svelte` where other detectors are started

### Fresh-install defaults
`loadPipeline()` in `pipeline.ts` checks for legacy IDB keys first; if truly fresh, it writes `DEFAULT_*` constants directly. Reset from SettingsSection also uses these constants. Keep them in sync.

### Adding a Nostr action button
Any button that publishes a Nostr event must use the `useNostrAction` hook to handle rate-limiting queue display and cancellation:

1. Import and create at component init: `const myAction = useNostrAction();`
2. Wrap the publish call: `await myAction.run(onQueued => publishMyEvent(..., { onQueued }))`
3. Update button state: show `⏳ ${myAction.etaLabel}` while pending, disable button
4. Show cancel button: `{#if myAction.pending}<button onclick={myAction.cancel}>✕</button>{/if}`

This surfaces rate-limit queue position to the user and allows cancellation before send. See `docs/nostr.md` for full API and example usage.

## Things to Avoid

- **Never store raw privkey in component state** — only pass `$identity.privkey` directly into function calls
- **Never call `saveSegment` with a blob still backed by OPFS** — call `materializeBlob()` first to copy into a pure ArrayBuffer-backed Blob
- **Don't trickle ICE** — always go through `waitForIceGathering` before sending SDP
- **Don't use Svelte 4 reactivity** — no `$:`, no `export let` for bindable state (use `$props()` with `$bindable()`)
- **Don't add the same segment twice** — use `backupOf` to track canonical origin IDs across viewer chains; also check `originMonitor` to prevent cross-device ID collisions
- **Never send Nostr events when `nostrOnline` is false** — check `get(nostrOnline)` before any `publish()` call not already inside `outboxFlusher`
- **Every Nostr button must use `useNostrAction`** — direct publish calls without the hook skip rate-limit queue feedback and cancel support; use the hook to show ETA and allow cancellation
- **RecordAction source selection uses `cap.sourceId`** — not `ChannelConfig.videoSourceId`/`audioSourceId` (those are live-RTC fallbacks only)
- **Fetched segments list filters by `selectedMonitorPubkey` automatically** — don't add manual filtering; `ContentViewerSection.svelte` derives `browsedSegsWithIdx` from `$props.selectedMonitorPubkey`
