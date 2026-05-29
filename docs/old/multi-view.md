# Multi-View Architecture

## What Is Multi-View

Multi-view means running two or more simultaneous player instances in the content viewer — for example, watching the front-door camera and the garden camera side by side, or watching video and audio channels from the same device simultaneously.

There are two orthogonal dimensions:

| Dimension | Example | Current support |
|-----------|---------|-----------------|
| Multi-channel | Front door + garden on same monitor | Data model: yes. UI: no (single player) |
| Multi-device | Monitor A + Monitor B simultaneously | Data model: yes. UI: no |

Both use the same underlying mechanism: `channelId` separates streams within a device; `originMonitor` separates streams across devices.

---

## Data Model (Already Supports It)

Every segment in IDB carries both fields:

```typescript
interface SegmentMeta {
  segmentId: string;
  channelId: string;         // which recording channel produced this
  originMonitor: string;     // pubkey of the monitor that recorded it
  // ...
}
```

All query functions already accept both filters:

```typescript
getSegmentsInRange(from, to, originMonitor?, channelId?: string | string[])
getSegmentsBefore(before, count, originMonitor?, channelId?: string | string[])
getCoverageByChannel(originMonitor?, typeFilter?)   // returns per-channel map
```

The WebRTC data channel protocol also supports channel-scoped requests:

```typescript
requestCoverageMap(privkey, myPubkey, monitorPubkey, mimePrefix?)
requestSegment(time, privkey, myPubkey, monitorPubkey, mimePrefix?, channelId?)
```

No data model changes are required for multi-view.

---

## Current Controller Architecture

The current `ContentViewerSection` controller holds **one** player instance:

```
ContentViewerSection
  playerSegs: Segment[]          ← all segments for current playback
  playerPosition: number         ← single playback cursor
  playerRangeFrom/To: number     ← single buffer window
  playerChannelFilter: Set<string>   ← channel gates
  playerTypeFilter: Set<MimePrefix>  ← type gates
```

`playerChannelFilter` allows filtering to a subset of channels, but the player renders only the highest-priority segment at `playerPosition` — it doesn't display multiple channels side by side.

---

## Multi-Channel View (Same Device)

### Controller Changes

Replace the single player state with an array of player slots, each scoped to one channel:

```typescript
interface PlayerSlot {
  channelId: string;
  segs: Segment[];
  rangeFrom: number;
  rangeTo: number;
}

let playerSlots: PlayerSlot[] = $state([]);
let playerPosition: number = $state(0);   // shared clock — synchronized across all slots
```

The shared `playerPosition` means all channels play in sync — advancing one frame advances all. This matches the most common use case (watching multiple cameras covering the same time window).

For independent player clocks (each channel at a different time), each slot would carry its own `position`. This is a more complex UI and is deferred.

### Buffer Management

Each slot maintains its own buffer window and segment list. Buffer fetch, proactive extension, and end-of-play all need to operate per-slot. The simplest approach: run the existing `_ctrlAfterScrub` / `_ctrlExtendBuffer` / `_ctrlEndOfPlay` logic once per slot, with the slot's `channelId` passed as the channel filter.

### Player UI

The player area splits into N columns (or rows on portrait), one per slot. Each column renders video/audio/photo for its `channelId` at the shared `playerPosition`. The existing `PlayerView` component can be reused per slot.

```
┌─────────────────┬─────────────────┐
│  Front Door     │  Garden         │
│  [video frame]  │  [video frame]  │
└─────────────────┴─────────────────┘
```

### Timeline

The timeline already draws one coverage lane per `channelId` key in `coverageByChannel`. No scrubber changes are needed. The channel chip row selects which slots are displayed.

Active channel chips map directly to active player slots:
- Chip selected → slot exists → player renders that column
- Chip deselected → slot removed → column disappears

---

## Multi-Device View (Multiple Monitors)

Multi-device view adds a second dimension: `originMonitor`. The user pairs multiple monitors; the viewer needs a player slot per `(monitor, channel)` pair.

### Device Selection

Currently the viewer selects one device via `selectedMonitorPubkey`. Multi-device view would allow selecting multiple devices from the `DevicesSection` device list.

### Coverage Aggregation

`coverageByChannel` is currently keyed by `channelId` alone. With multiple devices, two monitors might use the same channel IDs (e.g., both have a `default-channel`). The key needs to become `${originMonitor}/${channelId}` — or coverage maps are kept per-device and merged with prefixed keys in the controller.

### WebRTC Connections

Multi-device live view requires concurrent WebRTC connections to each selected monitor. `viewer-peer.ts` already supports this via the `sessions` Map keyed by `monitorPubkey` — no changes needed.

### Data Channel Requests

Each device's segments must be fetched from that device's WebRTC data channel. `requestSegment` already takes `monitorPubkey` as an argument. The controller routes fetch requests to the correct session based on `slot.originMonitor`.

---

## Live View in Multi-Channel Mode

In live mode, each player slot subscribes to the live stream for its channel:

```
startLiveView(channelId: 'front-door')  →  WebRTC stream tagged with channelId
startLiveView(channelId: 'garden')      →  second WebRTC stream
```

The monitor's `buildCompositeStream(channelId)` already selects tracks per-channel. Each viewer slot adds one `<video>` element pointed at its own `MediaStream`.

This requires opening two live connections to the same monitor (one per channel), or extending the data channel protocol to multiplex multiple live streams over a single connection. The simpler path is one WebRTC connection per channel for now.

---

## Playback Speed and Jump Controls

These are independent of multi-view and work at the `playerPosition` level:

### Speed Control

The player advances `playerPosition` on the 200ms tick. Speed multiplier is applied to the tick delta:

```typescript
let playbackSpeed = $state(1.0);  // 0.5, 1.0, 2.0, 4.0

// In _playerTick:
const delta = 0.2 * playbackSpeed;
playerPosition = _playerSeekTo(playerPosition + delta);
```

For `<video>` elements, set `videoEl.playbackRate = playbackSpeed` in sync with the tick multiplier.

Speed control is a controller-only change — no data model or component changes needed.

### Jump Controls

Forward/backward jumps call `playerSeekTo(playerPosition ± jumpSec)` then trigger `_ctrlAfterScrub()` to refill the buffer at the new position:

```typescript
function jumpForward(jumpSec = 30) {
  playerSeekTo(playerPosition + jumpSec);
  _ctrlAfterScrub();
}
function jumpBackward(jumpSec = 30) {
  playerSeekTo(Math.max(playerRangeFrom, playerPosition - jumpSec));
  _ctrlAfterScrub();
}
```

Jump controls are controller-only changes.

---

## Implementation Priority

1. **Playback speed** — simplest, no new UI components, no data changes
2. **Jump controls** — two button clicks, controller-only
3. **Multi-channel (same device)** — requires player slot array, UI layout split
4. **Multi-device** — requires coverage key changes, device selection UI
5. **Multi-channel live** — requires one WebRTC connection per channel or multiplexing
