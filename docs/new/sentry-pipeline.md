# Sentry Pipeline

The Sentry pipeline is a manually-wired, composable automation system for capture, storage, and retention. It splits into two independent flows that share the Action layer:

**Data flow:** sources → channels → capture methods → segments

**Control flow:** sensors → links → actions → (recording and storage decisions)

Everything is explicit. Selecting a video source does not auto-add audio; creating a channel does not create actions; a sensor firing does not automatically record — only if a link connects it to a recording action.

## Pipeline Components

| Component | Responsibility |
|-----------|---------------|
| **Source** | Provide a media stream (camera, mic, screen, virtual) |
| **Sensor** | Monitor an external condition; emit state transitions |
| **Channel** | Own source selection and the rolling buffer |
| **Capture Method** | Define encoding parameters for one track type |
| **Link** | Wire sensors to actions (stateless rule) |
| **Action** | Own runtime state; decide what to record, pin, or override |
| **Segment** | Immutable 10-second encoded chunk stored in IDB + OPFS |

### State Ownership

| Component | Owns | Does Not Own |
|-----------|------|--------------|
| **Channel** | Source selection, rolling buffer | Capture methods, recording timing, storage decisions |
| **Capture Method** | Encoding (resolution, bitrate, codec) | Sources, storage, recording timing |
| **Action** | Recording timing, storage decisions, channel source overrides | Media encoding, rolling buffer |
| **Link** | Nothing — stateless evaluator | Conditions, actions |

---

## Sources

A **Source** is a media stream provider: a camera, microphone, screen, or virtual input.

| Type | Provides | Device ID | Use Case |
|------|----------|-----------|----------|
| **camera** | video + audio tracks | Required (`''` = default) | Primary monitoring device |
| **microphone** | audio track only | Required (`''` = default) | Standalone audio monitoring |
| **screen** | video + audio tracks | N/A | Screen + app audio capture |
| **virtual** | user-defined tracks | N/A | Synthetic inputs for testing |

**Sources are not separable.** When a source provides multiple tracks (camera video + audio), both are bundled. To mix sources (camera video + microphone audio), use separate channels with separate capture methods — not a single source.

```typescript
interface SourceConfig {
  id: string;
  name: string;
  type: 'camera' | 'microphone' | 'screen' | 'virtual';
  deviceId: string;          // browser enumerateDevices ID; '' = default
  videoWidth?: number;       // 0 = browser decides
  videoHeight?: number;
  frameRate?: number;
  audioSampleRate?: number;
}
```

---

## Sensors

A **Sensor** is a state machine that monitors an external condition and transitions through defined states. Each sensor owns its runtime state; state is transient and resets on stop.

### Detector Interface

All sensors implement `Detector`:

```typescript
interface Detector<T = Record<string, unknown>> {
  start(stream?: MediaStream): void;
  stop(): void;
  onDetection: ((event: DetectionEvent<T>) => void) | null;
  onFiringChange: ((firing: boolean) => void) | null;
  onStateChange: ((state: SensorState) => void) | null;
}

type SensorState =
  | { status: 'inactive' }
  | { status: 'idle'; nextFireAt?: number }
  | { status: 'sensing'; startedAt: number; minDurationMs: number }
  | { status: 'active'; startedAt: number }
  | { status: 'settling'; endsAt: number };
```

### State Transitions

1. **idle → sensing**: condition initially met
2. **sensing → active**: condition held for `minDurationMs`
3. **sensing → idle**: condition dropped before `minDurationMs` elapsed; event canceled
4. **active → settling**: condition dropped; enter debounce window (`settlingMs`)
5. **settling → active**: condition re-detected before settling completes
6. **settling → idle**: settling timer expires

### Sensor Types

#### AudioDetector

Monitors RMS dB level on a microphone source using the Web Audio API.

- `thresholdDb` — rolling average must reach this level to trigger sensing
- `releaseThresholdDb` — must drop below this to release (default: same as threshold; set lower for hysteresis)
- `minDurationMs` — time above threshold before `active`
- `settlingMs` — debounce window after dropping below release threshold

**Hysteresis:** set `releaseThresholdDb < thresholdDb` so noise in the zone between the two thresholds does not cause chattering. Example: activates at -24 dB, releases only at -45 dB.

#### ScheduleDetector

Fires at fixed intervals. No stream needed.

- `intervalMs` — time between fires
- `settlingMs` — how long to stay active per fire
- Publishes `nextFireAt` in idle state for UI countdown

#### TimeWindowDetector

Activates during selected hour-slots in a weekly schedule. No stream needed.

- `activeSlots` — array of slot indices: `dayOfWeek * 24 + hour` (0 = Sunday 00:00, 167 = Saturday 23:00)
- Polls every 60 seconds; transitions idle ↔ active at slot boundaries
- Emits initial state immediately on start
- Publishes next activation time in `nextFireAt`

Example: `activeSlots: [24..47]` = Monday 00:00–23:00.

#### DateRangeDetector

One-time activation between ISO 8601 datetime boundaries. No stream needed.

- `startIso` — when sensor becomes active
- `endIso` — when sensor becomes permanently inactive (does not cycle)
- Polls every 30 seconds; accurate to ±30s

#### NostrTriggerDetector

Fires when a kind 5010 Trigger signal is received from a paired contact via the signal router. Behaves identically to other sensors on activation (idle → active transition); the signal router calls `handleRemoteTrigger()` on DetectorController, which drives the transition. Does not have its own polling or timer — it is event-driven.

```typescript
type SensorConfig = AudioDetectorConfig | ScheduleDetectorConfig | TimeWindowDetectorConfig | DateRangeDetectorConfig | NostrTriggerDetectorConfig
```

---

## Capture Methods

A **Capture Method** specifies encoding parameters for a single media track type. It does not specify which source to use; the source is determined by the Channel.

| Type | Track | Output |
|------|-------|--------|
| **video** | video track | `video/webm` or codec-specific |
| **audio** | audio track | `audio/webm`, `audio/mp4`, etc. |
| **photo** | video frame → JPEG/PNG | `image/jpeg`, `image/png` |

Capture methods are encoding-only. Source changes (e.g., via SourceOverrideAction) affect all recording on that channel automatically, without touching capture method configuration. Multiple video capture methods with different parameters can coexist; the active one is chosen by RecordSegmentsAction or the channel default.

```typescript
type CaptureMethod =
  | { id: string; name: string; type: 'video';
      videoWidth: number; videoHeight: number;  // 0 = native
      videoBitsPerSec: number;                  // 0 = auto
      videoCodec: string; }                     // '' = browser default
  | { id: string; name: string; type: 'audio';
      audioBitsPerSec: number;
      mimeType: string; }
  | { id: string; name: string; type: 'photo';
      imageWidth: number; imageHeight: number;  // 0 = native
      imageQuality: number;                     // 0–1 (JPEG quality)
      imageFormat: string; };
```

---

## Channels

A **Channel** is a named monitoring unit that owns source selection and the rolling buffer.

1. **Own source selection** — `videoSourceId` and `audioSourceId` are fixed per channel
2. **Manage rolling buffer** — always record with `defaultCaptureMethods` to maintain pre-roll history
3. **Label segments** — all segments created on the channel carry `channelName`

Per-track arbitration (which action records, which source override applies) is handled by RecordingController, not Channel. See [sentry-controllers.md](sentry-controllers.md).

```typescript
interface ChannelConfig {
  id: string;
  name: string;
  videoSourceId: string;
  audioSourceId: string;
  defaultCaptureMethods: {
    video?: string;   // capture method ID for rolling buffer video
    audio?: string;   // capture method ID for rolling buffer audio
  };
}
```

RecordingController resolves the active source per track at runtime; see [sentry-controllers.md](sentry-controllers.md).

---

## Links

A **Link** is a stateless wiring rule that connects sensors to actions.

```typescript
interface Link {
  id: string;
  name: string;
  enabled: boolean;
  sensorIds: string[];
  condition: 'any' | 'all';       // any or all sensors must be in onState
  onState: 'sensing' | 'active';  // 'sensing' counts both sensing and active
  actionIds: string[];
}
```

**Condition evaluation:**
- `'any'` — at least one sensor in `sensorIds` is in `onState`
- `'all'` — all sensors in `sensorIds` are in `onState`
- `onState: 'sensing'` — `sensing` and `active` both count as on
- `onState: 'active'` — only `active` counts

**Multi-action triggering:** one link can fire multiple actions simultaneously. All activate independently with no ordering or synchronization between them:

```typescript
// Action IDs are user-assigned names; the action type is determined by the action object.
// 'record-hi', 'clip', 'snapshot', 'notify' are example IDs that may reference
// any defined action type (RecordSegmentsAction, PinSegmentsAction, CapturePhotosAction, etc.).
actionIds: ['record-hi', 'clip', 'snapshot', 'notify']
```

Links own no state. ActionController maintains action runtime state; links are re-evaluated on every sensor state change.

---

## Actions

An **Action** owns configuration and runtime state. When a link fires, the action transitions through its state machine.

Actions transition between `idle`, `active`, and `cooldown` states — see [sentry-controllers.md](sentry-controllers.md) for the `ActionState` type definition and transition rules.

### RecordSegmentsAction

Requests that a channel store its rolling buffer to IDB using specified capture methods.

```typescript
interface RecordSegmentsAction {
  id: string;
  name: string;
  type: 'record-segments';
  channelId: string;
  captureMethodIds: string[];
  priority: number;
  preRollSec: number;
  postRollSec: number;
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

The channel always records to the rolling buffer via `defaultCaptureMethods`. When the action activates, it requests per-track recording using `captureMethodIds` and prepends `preRollSec` of rolling buffer segments. After the link condition fails, the action enters cooldown and continues storing for `postRollSec`. If `onRetrigger: 'extend'` and the sensor re-fires during post-roll, cooldown is canceled and recording extends.

Higher-priority actions take precedence per track; see [sentry-controllers.md](sentry-controllers.md) for per-track arbitration diagrams and execution details. When two RecordSegmentsActions have equal priority on a track, the action listed first in the pipeline config wins.

### SourceOverrideAction

Temporarily overrides a channel's source selection for one track.

```typescript
interface SourceOverrideAction {
  id: string;
  name: string;
  type: 'source-override';
  channelId: string;
  trackType: 'video' | 'audio';
  sourceId: string;
  priority: number;
  postRollSec: number;
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

When active, the channel's configured source for the specified track is replaced by `sourceId` for all recording. Multiple overrides on the same track compete by `priority`; the highest-priority active override wins. The earliest activation timestamp breaks ties between overrides of equal priority. See [sentry-controllers.md](sentry-controllers.md) for revert and awakening mechanics.

### PinSegmentsAction

Protects segments within a time window from rolling buffer eviction.

```typescript
interface PinSegmentsAction {
  id: string;
  name: string;
  type: 'pin-segments';
  channelId: string;
  mimePrefix?: string;           // 'video/', 'audio/', 'image/' (omit = all)
  preRollSec: number;
  postRollSec: number;
  pinLifetimeSec: number | null; // null = pin forever
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

No per-track arbitration. Multiple PinSegmentsActions on the same channel coexist independently — each pins its own window without blocking the other.

### CapturePhotosAction

Fires photo snapshots at intervals while triggered.

```typescript
interface CapturePhotosAction {
  id: string;
  name: string;
  type: 'capture-photos';
  channelId: string;
  captureId: string;               // must reference a photo CaptureMethod
  snapshotCount: number;           // 0 = unlimited; N = stop after N photos
  intervalSec: number;
  pinLifetimeSec: number | null;
}
```

On each interval tick, the current video frame is extracted and encoded as JPEG/PNG, then saved as a photo segment to IDB/OPFS. If `pinLifetimeSec` is set, photos are saved already pinned. When `snapshotCount > 0`, the action deactivates after reaching the limit.

```typescript
type ActionConfig = RecordSegmentsAction | SourceOverrideAction | PinSegmentsAction | CapturePhotosAction
```

---

## Segments

A **Segment** is an immutable record of a 10-second chunk stored in IDB (metadata) + OPFS (blob).

```typescript
interface Segment {
  segmentId: string;             // UUID; used as OPFS blob filename
  startTime: number;             // unix timestamp (seconds)
  endTime: number;
  mimeType: string;
  sizeBytes: number;
  pinnedUntil: number | null;
  originMonitor: string;         // pubkey of source device
  channelName: string;
  backupOf: string | null;       // null = canonical; <id> = remote copy
  contentHash: string;           // SHA-256 hex; '' when hash was not computed at save time
}
```

**backupOf and deduplication:**
- `backupOf = null` — segment originated on this device (canonical)
- `backupOf = "<segmentId>"` — copy of a remote segment
- Only canonical segments count toward device storage quota

### Segment Boundaries

All segments are exactly 10 seconds (`SEGMENT_DURATION_S = 10`). Boundaries are fixed grid-aligned, not aligned to trigger times. A RecordSegmentsAction starting at T=7s produces its first segment at [10–20s] (MediaRecorder chunk boundaries align automatically).

### Capture Method Independence

Different capture types produce independent timelines. Video and audio timelines advance at their own pace; photo segments are not bound to 10-second boundaries. If video recording stops while audio continues, the video timeline stops advancing while audio proceeds normally. A viewer aligns timelines by `startTime`/`endTime` overlap.

### Pinning Semantics

| `pinnedUntil` | Meaning | Evictable by rolling buffer | Thinnable |
|---------------|---------|----------------------------|-----------|
| `null` | Never pinned | Yes | No (rolled away) |
| `-1` | Pin expired | No | Yes |
| `0` | Pinned forever | No | No |
| `N > 0` | Pinned until timestamp N | No | No (while `now <= N`) |

Segments with `pinnedUntil === null` are eligible for rolling buffer eviction. Segments with expired pins (`pinnedUntil === -1`) are kept and subject to thinning rules only.

---

## Segment Lifecycle & Cleanup

### Rolling Buffer Enforcement

On every `saveSegment()` call:

1. Count unpinned segments (`pinnedUntil === null`) for the monitor
2. If count exceeds `ceil(rollingBufferSec / 10)`, delete the oldest unpinned segments
3. If `rollingBufferSec === null` (infinite), skip this step and rely on hard cap and thinning

### Hard Cap

```typescript
const MAX_ROLLING_SEGMENTS = 120  // rollingBufferSec ÷ segmentDuration (e.g. 1200 ÷ 10)
const HARD_CAP_SEGMENTS = MAX_ROLLING_SEGMENTS * 3;  // ~360 segments (~1 hour)
const INFINITE_HARD_CAP_SEGMENTS = 360;              // when rollingBufferSec is null
```

Prevents runaway accumulation when thinning rules are not configured.

### Quota-Based Eviction

When OPFS quota is exceeded, segments are evicted in priority order:

1. Own device, unpinned (`pinnedUntil === null`)
2. Remote device, unpinned
3. Own device, pinned (last resort)
4. Remote device, pinned (last resort)

### Thinning Rules

A background job runs every 5 minutes and applies thinning rules to segments older than `afterAgeSec`:

```typescript
interface ThinningRule {
  afterAgeSec: number;     // apply to segments older than this
  keepOnePerSec: number;   // keep 1 segment per this many seconds
  mimePrefix: string;      // 'video/', 'audio/', 'image/'
}
```

**Default video policy:**

| Age range | Retention |
|-----------|-----------|
| 1–60 min | 1 per 30s |
| 1–6 hr | 1 per 60s |
| 6–12 hr | 1 per 5 min |
| 12–24 hr | 1 per 15 min |
| 1–7 days | 1 per hour |

Images and audio follow similar rules starting at 1–7 days (1 per 60s), then >7 days (1 per hour).

Thinning does not apply to pinned segments (`pinnedUntil !== null` and not expired).

---

## Priority & Preemption

RecordSegmentsActions use numeric `priority` for per-track arbitration. PinSegmentsActions and CapturePhotosActions have no preemption — multiple instances coexist independently on the same channel. See [sentry-controllers.md](sentry-controllers.md) for full arbitration semantics.

---

## Architecture Principles

**Manual wiring.** No component auto-creates or auto-connects to another. Every source, channel, capture method, sensor, link, and action is explicitly configured and wired.

**No auto-magic.** Selecting video from a camera does not add audio. Creating a RecordSegmentsAction does not create segments; segments are created on 10-second boundaries during active recording. A photo capture method in a RecordSegmentsAction does not enable CapturePhotosAction.

**State ownership is strict.** Sensors own SensorState. Actions own ActionState. Links own nothing. Channels hold configuration only. Segments are immutable once saved; only `pinnedUntil` changes after creation.

**Immutable events.** No update semantics for segment blobs. Only create and delete.

**Multi-timeline.** Video, audio, and photo segments form independent timelines. Switching from video-only to audio-only recording stops the video timeline while audio continues. Alignment is done by timestamp overlap, not by pipeline coupling.

---

## Example Workflows

### Workflow 1: Schedule-Based Snapshot Capture

- `ScheduleDetector`: fires every 10 minutes
- `Link`: schedule-active → `CapturePhotosAction`
- `CapturePhotosAction`: 1 photo per trigger, no pinning

Every 10 minutes: detector fires → link condition met → action activates → 1 photo saved to IDB → action deactivates. Result: 6 photo segments per hour, subject to thinning after 7 days.

### Workflow 2: Loud Noise → Record + Clip + Snapshot

- `AudioDetector`: threshold -24 dB, minDuration 1s, settlingMs 5s
- `TimeWindowDetector`: active 9am–6pm weekdays
- Three links all gated on `audio-active AND timewindow-active`:
  - Link 1 → `RecordSegmentsAction` (priority 10, preRoll 10s, postRoll 30s)
  - Link 2 → `PinSegmentsAction` (preRoll 10s, postRoll 30s, pinLifetimeSec: 604800)
  - Link 3 → `CapturePhotosAction` (5 photos, 2s interval)

**T=100s** (loud noise detected during business hours):
1. AudioDetector: idle → sensing → active (after 1s)
2. All three link conditions met
3. RecordSegmentsAction starts recording; pre-roll retrieves [90–100s] from rolling buffer
4. PinSegmentsAction activates; will pin from preRollSec before trigger through postRollSec after deactivation
5. CapturePhotosAction fires photos at T=100, 102, 104, 106, 108

**T=120s** (noise stops; `onState: 'active'` so link fails when sensor settles):
- RecordSegmentsAction and PinSegmentsAction enter post-roll (30s). CapturePhotosAction already completed at T=110s (snapshotCount reached).

**T=150s** (post-roll expires):
- Recorded segments: [100–110], [110–120], [120–130], [130–140], [140–150]
- Pinned range: [90–150] for 7 days
- Photos: 5 segments, unpinned, subject to thinning

### Workflow 3: Screen Recording with Audio Priority

- `ScreenSource` provides screen video + system audio
- `MicrophoneSource` provides user voice
- `Channel A`: video=screen, audio=microphone
- `Channel B`: video=screen, audio=screen (system audio)
- `RecordSegmentsAction A` (priority 10, channelId: channel-a): `[screen-video, mic-audio]`; postRoll 10s
- `RecordSegmentsAction B` (priority 5, channelId: channel-b): `[screen-video, system-audio]`; postRoll 20s
- Link 1: timewindow-active (business hours) → Action A
- Link 2: timewindow-active (after-hours) → Action B

During business hours: Action A records from Channel A (screen + microphone). Action B's link is inactive.

After hours: Action B records from Channel B (screen + system audio). Action A's link is inactive.

Each action records from its own channel with the correct audio source. Source selection is fixed per channel; capture methods specify encoding only.

### Workflow 4: Camera Failover via Source Override

**Configuration:**

```typescript
const frontDoorChannel: ChannelConfig = {
  id: 'front-door-ch',
  name: 'Front Door',
  videoSourceId: 'camera-1',
  audioSourceId: 'mic-1',
  defaultCaptureMethods: { video: 'rolling-std-video', audio: 'rolling-audio' }
};

const failoverAction: SourceOverrideAction = {
  id: 'failover-action', type: 'source-override',
  channelId: 'front-door-ch', trackType: 'video',
  sourceId: 'camera-2',
  priority: 100, postRollSec: 5, onRetrigger: 'extend'
};

const recoveryAction: SourceOverrideAction = {
  id: 'recovery-action', type: 'source-override',
  channelId: 'front-door-ch', trackType: 'video',
  sourceId: 'camera-1',
  priority: 50, postRollSec: 5, onRetrigger: 'extend'
};
```

Links: `camera-1-lost` → failoverAction; `camera-1-restored` → recoveryAction.

**Timeline:**

```
T=0s:   Normal operation. Video: camera-1. Audio: mic-1.

T=5s:   Primary camera loses signal.
        failoverAction: idle → active (priority 100, no blocker)
        Video switches to: camera-2. Audio: mic-1 (unaffected).

T=8s:   Primary camera recovers.
        recoveryAction: idle → active (active but suppressed by higher-priority action — RecordingController preemption, not a distinct ActionState)
        Video stays: camera-2. recoveryAction waits in blocked queue.

T=20s:  Operator disables failover via UI.
        failoverAction: active → cooldown (5s post-roll)
        Video stays: camera-2 during post-roll.

T=25s:  Failover post-roll expires.
        failoverAction: cooldown → idle
        recoveryAction: awakens (RecordingController preemption resolved → active)
        Video switches to: camera-1.

T=40s:  Recovery post-roll expires.
        recoveryAction: cooldown → idle
        Video: camera-1 (default, no overrides active).
```

Key points:
- Audio (`mic-1`) is never overridden; both actions specify `trackType: 'video'` only
- recoveryAction awakens at T=25s with no new sensor event — it was waiting in the blocked queue
- Post-roll allows the operator time to verify the switch before the override clears
- Overrides change *which source provides media*; capture methods remain unchanged

---

## Key Design Decisions

**Why explicit source pairing?** Cameras often provide both video and audio, but the user may want screen video + microphone audio, or only one track. Explicit source selection per channel avoids hidden audio or video being silently included.

**Why 10-second segments?** 10 seconds balances granularity (precise clip windows for pinning) with I/O efficiency (fewer IDB writes, fewer OPFS files). Shorter segments increase overhead; longer segments reduce pinning precision.

**Why pinning instead of manual selection?** Pinning is deterministic: PinSegmentsAction marks segments based on trigger time and configured window. Manual selection is error-prone — users forget to mark segments before the rolling buffer evicts them.

**Why two-level cleanup (rolling buffer + hard cap)?** Rolling buffer enforces the configured retention window. Hard cap prevents runaway growth if rolling buffer is disabled or misconfigured. Thinning rules let older segments thin out gracefully, preserving quota for recent footage while retaining sparse historical coverage.

**Why post-roll?** Most triggers are instantaneous (audio spike, motion). Post-roll captures context after the trigger ends — what happened after the noise stopped. `onRetrigger: 'extend'` handles chattering triggers by resetting the post-roll timer on re-activation.
