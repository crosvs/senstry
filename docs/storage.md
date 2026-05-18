# Storage

## Overview

Senstry uses two browser storage mechanisms in tandem:

- **IndexedDB** (`idb` v8 library) — metadata, settings, event cache, footage references
- **OPFS** (Origin Private File System) — segment blobs (audio/video/image binary data)

Segment blobs are written to OPFS for performance and to avoid IDB blob-size limits. IDB holds only metadata with a `segmentId` key used to look up the OPFS file.

## IndexedDB Schema (v7)

Database name: `senstry`

| Store | Key | Indexes | Contents |
|-------|-----|---------|----------|
| `settings` | string key | — | App settings, pipeline config, identity privkey; arbitrary JSON values via `getSetting` / `putSetting` |
| `pairedDevices` | `pubkey` | `addedAt` | `PairedDevice` records |
| `events` | `id` (Nostr event ID) | `created_at`, `kind` | Cached Nostr events (alerts, arm state, footage refs) |
| `pendingInvites` | `inviteId` | — | In-progress pairing invites |
| `footageRefs` | `refId` | `triggerTime`, `originMonitor` | Trigger window metadata (pre/post-roll bounds) |
| `photos` | `photoId` | `capturedAt`, `originMonitor` | Snapshot captures |
| `outbox` | `outboxId` | `status`, `createdAt` | Nostr event publish queue |
| `segments` | `segmentId` | `startTime`, `originMonitor`, `contentHash` | Segment metadata (no blob) |

## OPFS Layout

```
navigator.storage.getDirectory()
  └── recordings/
        ├── <segmentId-1>   (raw binary, e.g. video/webm or audio/webm or image/jpeg)
        ├── <segmentId-2>
        └── ...
```

Each file is named by the segment's UUID. There is no subdirectory structure. The `recordings/` directory is created lazily on first write.

## Segment Lifecycle

### Recording

`SentrySection` runs `MediaRecorder` for each `(channelId, captureType)` pair from enabled `RecordAction`s. Every ~10 seconds:
1. `ondataavailable` fires with a `Blob` chunk
2. `saveSegment(blob, mimeType, startTime, endTime, originMonitor, channelId, backupOf)` is called
3. SHA-256 hash of raw bytes is computed
4. Blob is written to OPFS as `recordings/<segmentId>`
5. Metadata is written to IDB `segments` store
6. Rolling buffer check runs: evict oldest unpinned segments if over quota

### Retrieval

`getSegmentById(segmentId)` → reads OPFS file → returns `SegmentWithBlob { ...meta, blob }`.

`getSegmentsInRange(from, to, originMonitor?, channelId?)` → IDB index query on `startTime`; filters by `originMonitor` and `channelId` if provided. Returns metadata only (no blobs).

`getSegmentsAfter(after, count, ...)` and `getSegmentsBefore(before, count, ...)` — boundary navigation, returns up to `count` metas (capped at 20 for remote requests).

`getCoverageMap(originMonitor?, mimePrefix?, channelId?)` — merges overlapping segments into continuous `[start, end]` intervals.

## Segment Pinning

The `pinnedUntil` field controls eviction eligibility:

| Value | Meaning |
|-------|---------|
| `null` | Not pinned — rolling buffer candidate, evictable |
| `-1` | Pin expired — excluded from rolling-buffer eviction but eligible for thinning |
| `0` | Pinned forever |
| `N > 0` | Pinned until unix timestamp N |

When a `ClipAction` triggers, it calls `pinSegmentsInRange(from, to, pinLifetimeSec)` which sets `pinnedUntil` on all matching segments.

## Rolling Buffer

On each `saveSegment` call:
1. Count total segments for this `originMonitor`
2. If count exceeds `HARD_CAP` (1080) or storage quota: evict oldest unpinned (`pinnedUntil === null`) segments until under the cap
3. If `RecordAction.rollingBufferSec` is set: additionally evict unpinned segments older than `now - rollingBufferSec`

Pinned segments (`pinnedUntil !== null`) are never touched by the rolling buffer.

## Thinning Rules

`StorageCleanupConfig.thinningRules` is an array of `ThinningRule`:

```typescript
interface ThinningRule {
  afterAgeSec: number;     // only apply to segments older than this
  keepOnePerSec: number;   // target: retain at most one segment per N seconds
  mimePrefix: string;      // 'video/', 'audio/', 'image/'
}
```

Thinning runs on a configurable interval (`autoCleanupIntervalSec`, default 300s). For each rule, segments older than `afterAgeSec` are scanned and surplus segments (more than one per `keepOnePerSec` window) are deleted. Pinned segments (`pinnedUntil !== null && pinnedUntil !== -1`) are skipped.

Default thinning schedule for video:

| After age | Keep one per |
|-----------|-------------|
| 1 hour | 30s |
| 6 hours | 60s |
| 12 hours | 5 min |
| 1 day | 15 min |
| 3 days | 1 hour |
| 7 days | 6 hours |

This gives high-resolution playback for recent footage and progressively sparser coverage for older footage, managing storage automatically over time.

## Footage References

A `FootageRef` is a named trigger window:

```typescript
interface FootageRef {
  refId: string;
  originMonitor: string;
  triggerType: string;
  channelId: string;
  startTime: number;     // pre-roll start
  endTime: number;       // post-roll end
  triggerTime: number;   // moment the sensor fired
  deleted: boolean;
}
```

Footage refs are published to Nostr as kind 30020 (NIP-33 parameterized-replaceable) so viewers can look them up even after a relay reconnect. The `d` tag is the `refId` — a new publish of the same `refId` replaces the old one on the relay.

## Outbox

Nostr events that fail to publish immediately are queued in the `outbox` IDB store. `outboxFlusher` (started in `+page.svelte` via `onMount`) polls the queue and retries. Status values: `queued`, `published`, `failed`.

## Quota Management

`StorageCleanupConfig.quotaMb` sets the maximum storage budget. The rolling buffer eviction checks `navigator.storage.estimate()` and evicts when usage exceeds the quota. The default is 500 MB.

Users can adjust the quota and thinning rules in `SegmentStorageSection.svelte`.

## `materializeBlob`

OPFS file handles return blobs that are backed by the OPFS file descriptor. If the file is later deleted, the blob becomes unreadable. `materializeBlob(blob, mimeType)` reads the full `ArrayBuffer` and creates a new in-memory `Blob` — safe to use after OPFS deletion:

```typescript
async function materializeBlob(blob: Blob, mimeType: string): Promise<Blob> {
  const buf = await blob.arrayBuffer();
  return new Blob([buf], { type: mimeType });
}
```

Always call `materializeBlob` before passing a segment blob to the player or storing it in component state.

## Content Hash Verification

Each segment is hashed (SHA-256) at write time. When a viewer receives a segment over WebRTC, it verifies the hash before resolving. Mismatches are logged and the segment is rejected. The hash is also indexed in IDB to detect duplicates at import time.
