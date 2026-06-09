# WebRTC Data Channel Protocol

The application-level protocol running over the two RTCDataChannel instances that every WebRTC session creates. This document covers message types, the request/response pattern, segment transfer, and segment boundary navigation.

For session establishment, ICE, and SDP, see [webrtc-session.md](webrtc-session.md) and [webrtc-peer.md](webrtc-peer.md). For signal message format and encryption, see [webrtc-peer.md](webrtc-peer.md) and [signal-exchange.md](signal-exchange.md).

---

## Channel Architecture

Every session — data-only or live — creates two independent RTCDataChannels on the monitor side. Both are sent to the viewer via `ondatachannel` events.

| Channel | Label | Format | Purpose |
|---------|-------|--------|---------|
| Control | `'control'` | JSON strings | Requests, responses, metadata, live-upgrade trigger |
| Data | `'data'` | JSON strings (base64 payload) | Segment chunk streaming |

Splitting metadata and binary payloads across two channels prevents large segment transfers from blocking small control messages. WebRTC data channels share a single SCTP association; a large transfer on a single channel would queue behind all pending chunks before any response could arrive.

The viewer receives both channels via `pc.ondatachannel`. The control channel signals that the session is ready; the data channel carries incoming chunk messages.

---

## Request/Response Pattern

All viewer-initiated requests follow a single pattern:

1. Check that a session exists and the control channel is open; throw `'offline'` if not.
2. Register a pending callback keyed by correlation identifier (typically `requestTime` or `segmentId`).
3. Send a JSON request on the control channel.
4. Start a timeout; reject the pending callback on expiry.
5. When `handleControlMessage()` matches the response type, call the pending callback and clear the timeout.

Requests are independent. Multiple requests can be in flight simultaneously; each resolves when its response arrives.

**Request timeouts:**

| Request | Timeout |
|---------|---------|
| `coverage-request` | 10s |
| `coverage-channels-request` | 10s |
| `segment-request` / `segment-request-by-id` | 30s |
| `segments-after-request` / `segments-before-request` | 10s |
| `segments-in-range-request` | 15s |
| `source-list-request` | 5s |
| `segment-channels-request` | 5s |
| `channel-list-request` | 5s |

---

## Message Types — Complete Reference

All messages are JSON strings. Direction is V→M (viewer to monitor) or M→V (monitor to viewer).

### Control Channel: Metadata and List Requests

```ts
interface SegmentMeta {
  segmentId: string
  startTime: number      // ms epoch
  endTime: number        // ms epoch
  mimeType: string
  sizeBytes: number
  originMonitor: string  // device pubkey
  contentHash: string    // sha256 hex
  channelId: string      // ChannelConfig.id from sentry-pipeline.md
  isPinned: boolean      // pinnedUntil === 0 or a future timestamp
}
```

`channelId` is `ChannelConfig.id` (see [sentry-pipeline.md § Channels](sentry-pipeline.md)); the monitor resolves this from the stored segment. `isPinned` is derived from `pinnedUntil`: true when `pinnedUntil === 0` or a future timestamp, false otherwise.

| Request (V→M) | Response (M→V) | Notes |
|---|---|---|
| `{ type: 'source-list-request' }` | `{ type: 'source-list', sourceIds: string[] }` | Open source IDs on monitor |
| `{ type: 'channel-list-request' }` | `{ type: 'channel-list', channels: ChannelConfig[] }` | Monitor's live channel configurations |
| `{ type: 'segment-channels-request' }` | `{ type: 'segment-channels', channels: string[] }` | Distinct channel IDs that have stored segments |
| `{ type: 'coverage-request', mimePrefix?, channelId? }` | `{ type: 'coverage-map', coverage: [number, number][], mimePrefix? }` | Merged time intervals for stored segments |
| `{ type: 'coverage-channels-request', mimePrefix? }` | `{ type: 'coverage-channels', coverage: Record<string, [number, number][]> }` | Coverage broken down per channel (keyed by channelId) |
| `{ type: 'segments-after-request', after, count }` | `{ type: 'segments-after', segments: SegmentMeta[], hasMore }` | Up to 20 segment metadata entries starting after `after` |
| `{ type: 'segments-before-request', before, count }` | `{ type: 'segments-before', segments: SegmentMeta[], hasMore }` | Up to 20 segment metadata entries ending before `before` |
| `{ type: 'segments-in-range-request', from, to, limit, order, knownIds, mimePrefix?, channelId? }` | `{ type: 'segments-in-range', segments: SegmentMeta[] }` | Metadata for segments in range, excluding `knownIds`; up to `limit` results |

### Control Channel: Segment Requests

| Request (V→M) | Response (M→V) | Notes |
|---|---|---|
| `{ type: 'segment-request', time, mimePrefix?, channelId? }` | `segment-meta` + N×`segment-chunk` on data channel, or `segment-error` | Fetch segment at timestamp |
| `{ type: 'segment-request-by-id', segmentId }` | `segment-meta-by-id` + N×`segment-chunk-by-id` on data channel, or `segment-error-by-id` | Fetch segment by canonical ID |

Segment responses span both channels: metadata arrives on the control channel, chunks arrive on the data channel.

### Control Channel: Live-Request (Special Case)

| Message (V→M) | Response |
|---|---|
| `{ type: 'live-request', channelId }` | No control-channel response; triggers WebRTC renegotiation via Nostr |

`live-request` has no control-channel response. The monitor responds via Nostr renegotiation. See [webrtc-session.md](webrtc-session.md) for the full upgrade flow.

### Data Channel: Segment Chunks

Chunk messages arrive exclusively on the `'data'` channel. The monitor sends them after the corresponding `segment-meta` on the control channel.

| Message (M→V) | Fields |
|---|---|
| `segment-chunk` | `type`, `requestTime`, `startTime`, `index`, `total`, `data` (base64) |
| `segment-chunk-by-id` | `type`, `segmentId`, `startTime`, `index`, `total`, `data` (base64) |

`requestTime` (or `segmentId` for by-ID requests) correlates chunks back to the pending request. `index` and `total` allow ordering and completion detection.

---

## Segment Metadata Response

The monitor sends a `segment-meta` (or `segment-meta-by-id`) on the control channel before streaming any chunks.

```json
{
  "type": "segment-meta",
  "requestTime": 1700000000,
  "segmentId": "seg-abc123def",
  "startTime": 1699999995,
  "endTime": 1700000005,
  "mimeType": "video/webm; codecs=vp8",
  "sizeBytes": 245760,
  "originMonitor": "<monitor-device-pubkey>",
  "contentHash": "<sha256-hex>",
  "channelId": "camera-1"
}
```

**Field notes:**

- `segmentId`: Always the canonical ID (`segment.backupOf ?? segment.segmentId`). When a monitor is serving a segment it received from another device, it sends the original canonical ID so the viewer deduplicates correctly.
- `contentHash`: SHA-256 of the reassembled raw bytes. The viewer verifies this after reassembly and rejects the segment if it does not match.
- `originMonitor`: The device pubkey of the monitor that originally recorded the segment. Viewers use this to tag and filter segments in multi-device scenarios.
- `channelId`: Corresponds to `ChannelConfig.id` (see [sentry-pipeline.md § Channels](sentry-pipeline.md)). The `Segment` type stores `channelName`; the monitor resolves `ChannelConfig.id` from the stored name before transmitting.
- `requestTime`: Echoed from the request; used as the correlation key for matching chunks.

The by-ID variant uses `segmentId` as both identifier and correlation key:

```json
{
  "type": "segment-meta-by-id",
  "segmentId": "seg-abc123def",
  "originMonitor": "<monitor-device-pubkey>",
  "channelId": "camera-1",
  "startTime": 1699999995,
  "endTime": 1700000005,
  "mimeType": "video/webm; codecs=vp8",
  "contentHash": "<sha256-hex>",
  "sizeBytes": 245760,
  "chunkCount": 8,
  "isPinned": false
}
```

`segment-meta-by-id` omits `requestTime` and uses `segmentId` as both identifier and correlation key.

---

## Error Response Format

When the requested segment is not in monitor storage, the monitor sends an error instead of `segment-meta`.

```json
{
  "type": "segment-error",
  "requestTime": 1700000000,
  "reason": "not-stored"
}
```

Or for by-ID requests:

```json
{
  "type": "segment-error-by-id",
  "segmentId": "seg-abc123def",
  "reason": "blob-missing"
}
```

**Error codes:**

| Code | Meaning |
|------|---------|
| `not-stored` | No segment exists at the requested time or ID |
| `blob-missing` | Segment metadata exists in IDB but the blob is absent from OPFS |

The viewer rejects the pending Promise with the error reason on either code.

---

## Segment Transfer Flow

```
Viewer                                  Monitor
  │                                        │
  │── control: segment-request ───────────>│
  │            { time: 1700000000 }        │
  │                                        │  query IDB for segment at time
  │                                        │  retrieve blob from OPFS
  │<── control: segment-meta ──────────────│
  │            { segmentId, contentHash, sizeBytes, ... }
  │                                        │
  │<── data: segment-chunk[0] ─────────────│  { index: 0, total: 8, data: base64 }
  │<── data: segment-chunk[1] ─────────────│  { index: 1, total: 8, data: base64 }
  │       ...                              │
  │<── data: segment-chunk[7] ─────────────│  { index: 7, total: 8, data: base64 }
  │                                        │
  reassemble chunks[0..7]
  sha256(raw bytes) === contentHash?
  → resolve Promise with Blob
```

Steps in detail:

1. Viewer sends `segment-request` with `time` on the control channel. `time` becomes the correlation key (`requestTime`).
2. Monitor finds the segment whose time range contains `time`. If none, sends `segment-error` and stops.
3. Monitor sends `segment-meta` on the control channel with full metadata including `contentHash`.
4. Monitor reads the segment blob and splits it into ~32KB chunks. Each chunk is base64-encoded and sent as a JSON message on the data channel.
5. Viewer accumulates chunks into `pendingSegments.get(requestTime).chunks`, indexed by `chunk.index`.
6. When the number of accumulated chunks equals `total` (i.e., `chunks[requestTime].received === total`), all chunks are present regardless of arrival order. Viewer decodes base64, concatenates in order, computes SHA-256, compares against `contentHash`.
7. If hashes match, the Promise resolves with a `Blob`. If they do not match, the Promise rejects.

Multiple requests can be in flight simultaneously. Each uses a distinct `requestTime` (or `segmentId`) as a key into `pendingSegments`, so chunks from parallel transfers do not collide.

**Chunk size:** ~32KB per chunk. A 256KB segment produces 8 chunks. The exact chunk count is conveyed in `total` so the viewer knows when to reassemble.

---

## Segment Boundary Navigation

Boundary navigation lets the viewer locate segments at arbitrary timestamps without fetching blobs.

### Finding the Segment at a Timestamp

`segment-request` with a `time` value asks the monitor to find whichever segment's time range contains that timestamp. The monitor returns the segment that contains `time`, not necessarily one that starts exactly at `time`. This is the primary lookup path for timeline scrubbing.

### Paginating Segment Lists

To navigate the timeline without downloading blobs, the viewer requests metadata lists:

```
requestSegmentsAfter(after: number, count: number)
→ send: { type: 'segments-after-request', after, count }
← recv: { type: 'segments-after', segments: SegmentMeta[], hasMore: boolean }
```

```
requestSegmentsBefore(before: number, count: number)
→ send: { type: 'segments-before-request', before, count }
← recv: { type: 'segments-before', segments: SegmentMeta[], hasMore: boolean }
```

The monitor caps results at 20 entries per response regardless of `count`. `hasMore: true` indicates more segments exist in the requested direction. The viewer paginates by issuing further requests using the `endTime` of the last received segment as the next `after` (or `startTime` as `before`).

### Range Queries with Deduplication

`segments-in-range-request` is used when the viewer already knows some segment IDs in the range and only wants the ones it is missing:

```json
{
  "type": "segments-in-range-request",
  "from": 1700000000,
  "to": 1700003600,
  "limit": 50,
  "order": "asc",
  "knownIds": ["seg-abc", "seg-def"],
  "mimePrefix": "video/",
  "channelId": "camera-1"
}
```

The monitor excludes any segment whose ID is in `knownIds` before applying `limit`. This lets the viewer efficiently sync a range it partially has without re-downloading metadata it already holds.

---

## Segment Deduplication on the Viewer

When multiple monitors serve the same canonical segment (e.g., both a primary monitor and a backup device recorded the same event), the viewer deduplicates by the canonical segment ID.

The `segment-meta` response always contains `segmentId` set to the canonical ID: `segment.backupOf ?? segment.segmentId`. A monitor that is re-serving a segment it received from another device sends the original canonical ID, not its own local copy's ID.

The viewer's deduplication key is:

```
${originMonitor}-${channelId}-${segmentId}
```

`segmentId` in `segment-meta` is always the canonical ID — the monitor resolves `segment.backupOf ?? segment.segmentId` before sending, so no further resolution is needed on the viewer.

Segments stored with the same dedup key are the same recording. The viewer keeps whichever copy arrives first and discards subsequent duplicates. Quota accounting only counts canonical segments (`backupOf = null`); remote copies are metadata only.

This design means a viewer can fetch the same segment from two different monitors — for redundancy or because it switched monitors mid-session — and will not store duplicate blobs.

### Viewer Chain Support

When multiple viewers connect simultaneously to the same monitor, each viewer independently requests segment metadata and chunks via its own data channel. Each viewer maintains its own deduplication map keyed on `originMonitor + channelId + segmentId`. If the same segment arrives via multiple relay paths within a single viewer session, the dedup key prevents it from being counted or stored twice.

The viewer chain itself requires no special protocol handling. Deduplication keyed on `originMonitor + channelId + segmentId` is sufficient to guarantee each canonical segment is stored exactly once per viewer, regardless of how many relay paths delivered it.
