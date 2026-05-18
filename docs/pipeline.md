# Pipeline

The pipeline is the core configuration system that controls what the monitor records, when it records, and who it notifies. All pipeline state lives in `src/lib/store/pipeline.ts` and is persisted to IndexedDB under `pipeline.*` keys.

## Conceptual Model

```
Sources  ──feeds──▶  Sensors  ──(state changes)──▶  Links  ──▶  Actions
(camera,              (audio,                        (condition    (record,
 mic,                  schedule,                      wires)        clip,
 screen)               timewindow,                                  snapshot,
                       daterange,                                   notify)
                       nostr-trigger)
```

Links are **stateless wires** — they evaluate sensor states and fire actions. Actions **own their runtime state** (idle / active / cooldown) and all timing configuration. This separation means one action can be triggered by multiple links, and one link can target multiple actions.

## Types

### SourceConfig

Represents a hardware input.

```typescript
interface SourceConfig {
  id: string;
  name: string;
  type: 'camera' | 'microphone' | 'screen';
  deviceId: string;          // '' = browser default
  videoWidth?: number;
  videoHeight?: number;
  frameRate?: number;        // ideal fps constraint
  audioSampleRate?: number;  // ideal Hz constraint
}
```

Default sources: `default-cam` (camera) and `default-mic` (microphone) with fixed IDs so they survive across resets.

### SensorConfig

Defines a detector instance and its parameters.

```typescript
interface SensorConfig {
  id: string;
  name: string;
  type: 'audio' | 'schedule' | 'timewindow' | 'daterange' | 'nostr-trigger';
  sourceId: string;          // 'none' for non-audio sensors
  enabled: boolean;
  // audio
  thresholdDb: number;
  releaseThresholdDb?: number;  // hysteresis lower bound
  minDurationMs: number;
  settlingMs: number;
  // schedule
  intervalMs?: number;
  // timewindow
  activeSlots?: number[];    // (dayOfWeek * 24 + hour), 0=Sun00 … 167=Sat23
  // daterange
  startIso?: string;
  endIso?: string;
  // nostr-trigger
  monitorPubkey?: string;
  nostrChannelId?: string | null;
  detectionTypes?: string[];
}
```

### SensorState (runtime, not stored)

```typescript
type SensorState =
  | { status: 'inactive' }
  | { status: 'idle'; nextFireAt?: number }
  | { status: 'sensing'; startedAt: number; minDurationMs: number }
  | { status: 'active'; startedAt: number }
  | { status: 'settling'; endsAt: number };
```

`sensing` → average dB has crossed the threshold but `minDurationMs` hasn't elapsed yet.
`active` → sensor has been above threshold for the full `minDurationMs`.
`settling` → average dB dropped below `releaseThresholdDb`; waiting `settlingMs` before declaring idle.

### CaptureMethod

Describes how to encode a source for recording.

```typescript
type CaptureMethod =
  | { id: string; name: string; type: 'video';  sourceId: string;
      videoWidth: number; videoHeight: number;
      videoBitsPerSec: number; videoCodec: string; }
  | { id: string; name: string; type: 'audio';  sourceId: string;
      audioBitsPerSec: number; mimeType: string; }
  | { id: string; name: string; type: 'photo';  sourceId: string;
      imageWidth: number; imageHeight: number;
      imageQuality: number; imageFormat: string; };
```

### ChannelConfig

Groups sources into a named unit for Live RTC and footage tagging.

```typescript
interface ChannelConfig {
  id: string;
  name: string;
  videoSourceId: string | null;  // default/fallback video source for live RTC
  audioSourceId: string | null;  // default/fallback audio source for live RTC
}
```

**Important:** `videoSourceId`/`audioSourceId` are **fallback defaults** used when no `RecordAction` is actively recording on the channel. When a `RecordAction` activates, `SentrySection._updateChannelActiveSources()` pushes overrides to `monitor-peer.setChannelActiveSources()`, which takes priority for the live stream compositor.

### Link (stateless)

```typescript
interface Link {
  id: string;
  name: string;
  enabled: boolean;
  sensorIds: string[];           // sensors to evaluate
  condition: 'any' | 'all';     // any sensor in onState, or all of them
  onState: 'sensing' | 'active'; // which level counts as "on"
  actionIds: string[];           // actions to fire when condition met
}
```

Links have no runtime state. Evaluation happens in `SentrySection._evaluateLinks()` on every sensor state change.

### Actions

#### RecordAction

Keeps a channel recording at a specific quality while triggered.

```typescript
interface RecordAction {
  id: string; name: string; type: 'record';
  channelId: string;
  captureIds: string[];           // video and/or audio CaptureMethod IDs
  priority: number;               // highest priority wins when multiple compete for a slot
  postRollSec: number;            // keep recording after trigger clears
  rollingBufferSec: number | null; // null = infinite; evict older than this
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

#### ClipAction

Protects a footage window from eviction (pins it).

```typescript
interface ClipAction {
  id: string; name: string; type: 'clip';
  channelId: string;
  captureTypes: ('video' | 'audio' | 'photo')[];
  preRollSec: number;
  postRollSec: number;
  pinLifetimeSec: number;   // 0 = forever
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

#### SnapshotAction

Takes a photo burst on trigger.

```typescript
interface SnapshotAction {
  id: string; name: string; type: 'snapshot';
  channelId: string;
  captureId: string;            // must be a photo CaptureMethod
  snapshotCount: number;        // 0 = unlimited while triggered
  intervalSec: number;
  pinLifetimeSec: number | null;
}
```

#### NotifyAction

Publishes a Nostr `KIND_TRIGGER` event (kind 5010) to a viewer.

```typescript
interface NotifyAction {
  id: string; name: string; type: 'notify';
  cooldownMs: number;
  onRetrigger: 'ignore' | 'extend' | 'restart';
  includeData: boolean;
  messageTemplate?: string;
  viewerPubkey: string | null;  // null = broadcast to all paired devices
  publishStates: ('sensing' | 'active' | 'idle')[];
}
```

`publishStates` controls which sensor state transitions trigger a notification. Setting `['sensing', 'active', 'idle']` sends three events per trigger cycle.

### ActionState (runtime, not stored)

```typescript
type ActionState =
  | { status: 'idle' }
  | { status: 'active'; startedAt: number }
  | { status: 'cooldown'; endsAt: number };
```

## Defaults

On a fresh install (no IDB data, no legacy keys), `loadPipeline()` writes `DEFAULT_*` constants directly. These are also what **Reset to defaults** applies. Both paths write identical state.

| Constant | Contents |
|----------|----------|
| `DEFAULT_SOURCES` | `default-cam` (camera), `default-mic` (microphone) |
| `DEFAULT_SENSORS` | Background noise (−56 dB), Medium noise (−45 dB, 5s), Loud noise (−24 dB, 1s), Schedule (10s interval) |
| `DEFAULT_CAPTURES` | Low-quality video (720p 800kbps), High-quality video (2400kbps), Audio clip (64kbps), Photo (JPEG 85%) |
| `DEFAULT_CHANNELS` | `default-channel` → `default-cam` + `default-mic` |
| `DEFAULT_ACTIONS` | Two RecordActions (lo/hi priority), two SnapshotActions (burst + tick), ClipAction, NotifyAction |
| `DEFAULT_LINKS` | Background→lo record, Medium→hi record, Schedule→snapshot, Loud→clip+burst+notify |

## Persistence

`savePipeline(parts)` accepts any subset of keys and atomically writes to IDB + updates stores.

`loadPipeline()` handles three scenarios:
1. **Fresh install, no legacy** → write `DEFAULT_*` directly
2. **Fresh install, legacy data** (`triggers`, `app.settings` keys found) → run `_migrateFromLegacy()`
3. **Existing pipeline** → load each key; run in-place migrations (old typed links → new Links + Actions, `nostrActions` → `NotifyAction`)

## Auto-naming

Every config type has an `autoName*` function that generates a human-readable label when `name` is blank:
- `autoNameSensor(s, sources)` — e.g. "Audio on Mic (−45 dB, avg 5.0s, settle 10.0s)"
- `autoNameCapture(c, sources)` — e.g. "720p Video from Camera (800 kbps)"
- `autoNameChannel(c, sources)` — e.g. "Camera + Mic"
- `autoNameAction(a, captures, channels, sources)` — e.g. "Record Low quality CAM + Audio from MIC [Main channel]"
- `autoNameLink(l, sensors, actions, sources)` — e.g. "Background noise → Record …"
