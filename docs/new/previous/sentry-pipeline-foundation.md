# Senstry Sentry Pipeline Foundation

## 1. Overview

Senstry's "Sentry" pipeline is a **manually-wired, composable automation system** for capture, storage, and retention. It splits into two independent flows:

**Data Flow: sources → channels → actions → capture methods → segments**
- **Sources** provide media streams (cameras, microphones, screens)
- **Channels** select which sources feed into the rolling buffer (e.g., "Front Camera + Built-in Mic")
- **Actions** decide whether the rolling buffer data should be encoded and stored (gating by activation state and priority)
- **Capture Methods** encode the (action) gated data (resolution, bitrate, codec)
- **Segments** are encoded media stored in OPFS/IDB with metadata (timestamps, channel ID, source device, pinning state)

**Control Flow: sensors → links → actions**
- **Sensors** monitor external conditions (audio level, timer, time-of-day, date range)
- **Links** wire sensors to actions (if motion detected, then trigger recording)
- **Actions** modify channel configuration (which sources/capture methods are active) and control storage decisions (pin, evict, delete segments)

**Key principle: Everything is explicit.** No auto-wiring. Selecting a video source does not auto-add audio; creating a channel does not auto-create actions; a sensor firing does not automatically record — only if a link connects it to a recording action.

### State Ownership

| Component | Owns | Does Not Own |
|-----------|------|--------------|
| **Channel** | Sources (which camera, mic) + Rolling buffer | Capture methods, Storage decisions, When to record |
| **Capture Method** | Encoding (resolution, bitrate, codec) | Sources, Storage, Recording timing |
| **Action** | Recording timing + Storage decisions + Channel reconfigurations (source/method selection) | Media encoding, Rolling buffer |
| **Link** | Sensor→Action wiring | Conditions, Actions themselves |


## 2. Sources

A **Source** is a media stream provider: a camera, microphone, screen, or virtual input device. Each source has a type, optional device ID, and optional media constraints (resolution, frame rate, sample rate).

### Source Types

| Type | Provides | Device ID | Constraints | Use Case |
|------|----------|-----------|-------------|----------|
| **camera** | video + audio tracks | Required ('' = default) | videoWidth, videoHeight, frameRate | Primary monitoring device with onboard mic |
| **microphone** | audio track only | Required ('' = default) | audioSampleRate | Standalone audio monitoring (fallback when camera unavailable) |
| **screen** | video + audio tracks | N/A (always default) | videoWidth, videoHeight, frameRate | Device screen monitoring; includes app audio |
| **virtual** | user-defined tracks | N/A | Custom per implementation | Placeholder video with current time or for synthetic audio (e.g., alert tones) for testing purposes |

### Key Finding: Sources Are Not Separable

When a source provides multiple tracks (camera video + audio, screen video + audio), **both are bundled together**. You cannot extract video from a camera and audio from a different source within the same source instance. Use separate capture methods and channels to mix sources (e.g., camera video + microphone audio).

### Source Configuration Structure

```typescript
interface SourceConfig {
  id: string;                    // unique identifier
  name: string;                  // human-readable label
  type: 'camera' | 'microphone' | 'screen' | 'virtual';
  deviceId: string;              // browser's enumerateDevices ID ('' = default)
  videoWidth?: number;           // ideal resolution (0 = let browser decide)
  videoHeight?: number;
  frameRate?: number;            // ideal fps
  audioSampleRate?: number;      // ideal sample rate in Hz
}
```

## 3. Sensors

A **Sensor** is a state machine that monitors an external condition (audio level, timer interval, time-of-day, date range) and transitions through idle → sensing → active → settling states. Each sensor owns its runtime state but has no persistence; state is transient and derived from the detector's current observation.

### Detector Interface

All sensors implement the `Detector` interface:

```typescript
interface Detector<T = Record<string, unknown>> {
  start(stream?: MediaStream): void;           // begin monitoring
  stop(): void;                                // halt and reset state
  onDetection: ((event: DetectionEvent<T>) => void) | null;
  onFiringChange: ((firing: boolean) => void) | null;
  onStateChange: ((state: SensorState) => void) | null;
}

type SensorState =
  | { status: 'inactive' }                              // detector is off or permanently inactive
  | { status: 'idle'; nextFireAt?: number }             // idle and waiting; nextFireAt for UI countdown
  | { status: 'sensing';  startedAt: number; minDurationMs: number }
  | { status: 'active';   startedAt: number }
  | { status: 'settling'; endsAt: number };             // debouncing before returning to idle
```

### Sensor State Transitions

1. **idle** → **sensing**: detector observes initial condition met
2. **sensing** → **active**: minimum duration (`minDurationMs`) elapsed with condition still met
3. **sensing** → **idle**: condition dropped before minimum duration; event canceled
4. **active** → **settling**: condition dropped; enter debounce window (`settlingMs`)
5. **settling** → **active**: condition re-detected before settling completes; stay active
6. **settling** → **idle**: settling timer expires; return to idle

### Sensor Types

#### AudioDetector

Monitors RMS dB level on a microphone source using Web Audio API.

**Configuration fields:**
- `thresholdDb` — crossing this level (rolling average) triggers sensing
- `releaseThresholdDb` — hysteresis lower bound; must drop below this to release the sensor (default: same as threshold)
- `minDurationMs` — time above threshold before sensor declares `active`
- `settlingMs` — debounce time after dropping below release threshold before returning to idle

**Algorithm:**
1. Compute rolling average RMS dB over `minDurationMs` window
2. If rolling average ≥ `thresholdDb` → enter sensing, start `minDurationMs` timer
3. When timer fires, re-verify rolling average still ≥ `thresholdDb`; if yes → active, if no → idle
4. If rolling average drops below `releaseThresholdDb` while active → enter settling
5. If condition re-triggers while settling → cancel timer and stay active
6. If settling timer expires → return to idle

**Hysteresis semantics:**
- `releaseThresholdDb < thresholdDb`: sensor stays active in the hysteresis zone, reducing jitter
- `releaseThresholdDb = thresholdDb`: no hysteresis; release at the exact threshold

Example: sensor activates at -24 dB, but releases only when average drops to -45 dB. Noise in the -24 to -45 dB band does not cause chattering.

#### ScheduleDetector

Fires at fixed intervals. No stream needed.

**Configuration:**
- `intervalMs` — time between fires (e.g., 60,000 = every minute)
- `settlingMs` — debounce duration (how long to stay active per fire)

**Behavior:**
- Enters active state for `settlingMs` on each interval boundary
- Does not re-trigger if already active
- Next fire time is published in `nextFireAt` for UI countdown

#### TimeWindowDetector

Activates during selected hour-slots in a weekly schedule. No stream needed.

**Configuration:**
- `activeSlots` — array of slot indices: `dayOfWeek * 24 + hour` (0 = Sunday 00:00, 167 = Saturday 23:00)

**Behavior:**
- Polls every 60 seconds for slot changes (accurate to ±1 minute)
- Transitions idle ↔ active at slot boundaries only
- On startup, emits initial state immediately
- Publishes next activation time in `nextFireAt`

Example: `activeSlots: [24..47, 120..143]` = Monday–Friday 00:00–23:00 (night shift).

#### DateRangeDetector

One-time activation between ISO 8601 datetime boundaries. No stream needed.

**Configuration:**
- `startIso` — ISO 8601 datetime when sensor becomes active
- `endIso` — ISO 8601 datetime when sensor becomes permanently inactive

**Behavior:**
- Transitions idle → active at `startIso`
- Transitions active → inactive at `endIso`; stays inactive (does not cycle)
- Polls every 30 seconds; accurate to ±30s

## 4. Capture Methods

A **Capture Method** specifies encoding parameters for a single media track type: resolution, bitrate, codec, and output MIME type. Capture methods do not specify which source to use; the source is determined by the **Channel** configuration. Multiple capture methods of the same type (e.g., video at different resolutions) can coexist; the active one is determined by the active RecordSegmentsAction or the channel's default.

### Capture Types

| Type | Track | Output | Use |
|------|-------|--------|-----|
| **video** | video track | video/webm (or codec-specific) | Record video at specified bitrate and resolution |
| **audio** | audio track | audio/webm, audio/mp4 (or codec) | Record audio at specified bitrate |
| **photo** | video frame → JPEG/PNG | image/jpeg, image/png | Capture snapshots at specified resolution |

### Key Finding: Encoding-Only Configuration

Capture methods specify **encoding only**, not source selection. The source for a channel's video and audio tracks is fixed at the **Channel** level (`videoSourceId`, `audioSourceId`). This separation ensures that:
- Creating multiple video capture methods with different parameters does not require re-specifying which camera to use
- Source changes (e.g., via SourceOverrideAction to switch to a backup camera) affect all recording on that channel automatically
- To record different encoding variants (e.g., low-res and hi-res video) from the same source, simply create multiple video capture methods; the active one is chosen by RecordSegmentsAction or the channel default

### Capture Configuration

```typescript
type CaptureMethod =
  | { id: string; name: string; type: 'video';
      videoWidth: number; videoHeight: number;  // 0 = native
      videoBitsPerSec: number;                  // 0 = auto
      videoCodec: string; }                     // '' = browser default
  | { id: string; name: string; type: 'audio';
      audioBitsPerSec: number;                  // 0 = auto
      mimeType: string; }                       // 'audio/webm', 'audio/mp4', etc.
  | { id: string; name: string; type: 'photo';
      imageWidth: number; imageHeight: number;  // 0 = native
      imageQuality: number;                     // 0–1 (JPEG quality)
      imageFormat: string; };                   // 'image/jpeg', 'image/png', etc.
```

## 5. Channels

A **Channel** is a named monitoring unit (e.g., "front-door") that owns **source selection and a rolling buffer**. Each channel has fixed video and audio sources, a default set of capture methods for the rolling buffer, and manages one or more recording actions that may record with different encoding parameters.

**Channel responsibilities:**
1. **Own source selection**: `videoSourceId` and `audioSourceId` are fixed per channel (these specify which camera/mic to use)
2. **Manage rolling buffer**: always record with `defaultCaptureMethods` to maintain pre-roll history in memory/OPFS
3. **Label segments**: all segments created on the channel are tagged with the channel name for organization

**Note:** Per-track arbitration of which action records (priority-based selection of capture methods) is handled by RecordingController, not Channel. Source overrides are handled by RecordingController as well.

### Channel Configuration

```typescript
interface ChannelConfig {
  id: string;
  name: string;
  videoSourceId: string;          // which camera/source to use for video
  audioSourceId: string;          // which mic/source to use for audio
  defaultCaptureMethods: {
    video?: string;               // capture method ID for rolling buffer video
    audio?: string;               // capture method ID for rolling buffer audio
  };
}
```

**Source resolution (by RecordingController):**
1. Start with `videoSourceId` and `audioSourceId` from channel config
2. If a SourceOverrideAction is active on a track: use its override source instead
3. Use the resolved source when creating MediaRecorder and RTC stream

## 6. Links

A **Link** is a **stateless wiring rule** that connects sensors to actions. A link defines the condition under which a set of actions should activate.

### Link Configuration

```typescript
interface Link {
  id: string;
  name: string;
  enabled: boolean;
  sensorIds: string[];             // which sensors to monitor
  condition: 'any' | 'all';        // any sensor in onState, or all of them
  onState: 'sensing' | 'active';   // which sensor state level counts as "on"
  actionIds: string[];             // actions to fire when condition is met
}
```

### Link Semantics

**Condition evaluation:**
- `condition: 'any'` — link fires if **at least one** sensor in `sensorIds` is in `onState`
- `condition: 'all'` — link fires if **all** sensors in `sensorIds` are in `onState`

**State matching:**
- `onState: 'active'` — only the `active` state counts as "on"
- `onState: 'sensing'` — both `sensing` and `active` states count as "on" (shorthand for "sensor is firing")

### Multi-Action Triggering

One link can fire multiple actions simultaneously:
```typescript
actionIds: ['record-hi', 'clip', 'snapshot', 'notify']
```
All four actions activate independently when the link's condition is met. There is no ordering or synchronization between them.

### State Ownership

**Links own no state.** They are evaluated on every sensor state change. The ActionController maintains action runtime state (idle/active/cooldown), not the links themselves.

## 7. Actions

An **Action** owns configuration and runtime state. When a link fires, the action transitions from idle → active → cooldown → idle. Each action type has distinct behavior.

### ActionState Runtime

```typescript
type ActionState =
  | { status: 'idle' }
  | { status: 'active'; startedAt: number }
  | { status: 'cooldown'; endsAt: number };
```

**State machine (by trigger/condition):**
- **idle** → **active**: link condition met
- **active** → **cooldown**: link condition failed; enter post-roll delay
- **cooldown** → **idle**: post-roll timer expires
- **active** → **idle** (immediate): on disarm or manual stop

**Note on per-channel arbitration:** Multiple RecordSegmentsActions or SourceOverrideActions that target the same channel may compete when activated. This state conflict is resolved by ActionController and RecordingController together via priority arbitration with different tiebreakers:

- **RecordSegmentsAction per-track arbitration** (recording decisions): Higher priority wins; if priorities are equal, **insertion order into `ActionController.recordingActions` determines precedence** (first action added to config wins). This applies only to recording decisions.
- **SourceOverrideAction per-track arbitration** (configuration overrides): Higher priority wins; if priorities are equal, **earliest activation timestamp determines precedence** (independent of insertion order). This applies to non-recording configuration overrides.

Both rules ensure deterministic resolution even when actions activate simultaneously.

### RecordSegmentsAction

**Purpose:** request that a channel store its rolling buffer to IDB using specified capture methods, with optional pre-roll, post-roll, and priority-based arbitration.

**Configuration:**
```typescript
interface RecordSegmentsAction {
  id: string;
  name: string;
  type: 'record-segments';
  channelId: string;                // which channel to request recording on
  captureMethodIds: string[];       // which capture methods to use (source comes from channel)
  priority: number;                 // higher wins when multiple requests compete for same track
  preRollSec: number;               // grab pre-roll from channel's rolling buffer
  postRollSec: number;              // extend recording this long after trigger ends
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

**How it works:**
1. Channel is **always** recording to rolling buffer with `defaultCaptureMethods`
2. When RecordSegmentsAction activates:
   - Channel **switches** from rolling buffer captures to this request's `captureMethodIds`
   - RecordingController starts storing segments to IDB (not just memory)
   - Pre-roll segments (from rolling buffer) are available for splicing before the request's segments
3. When RecordSegmentsAction deactivates:
   - Channel **reverts** to rolling buffer captures
   - Segments stop being stored to IDB

**Activation behavior:**
1. ActionController transitions the action to `active` and fires `onActivate` callback
2. RecordingController's `startRecording()` method evaluates which tracks (video/audio) this request provides
3. For each track:
   - Check if a higher-priority request is already active on that track (via per-track arbitration logic)
   - If yes: **skip** this track (continue using the blocker's capture methods)
   - If no: **activate** on that track (start using this request's capture methods)
4. RecordingController begins storing to IDB using the resolved (arbitrated) capture methods per track
5. Report active sources to monitor-peer for live RTC

**Per-track arbitration (handled by RecordingController):**
- Video and audio are independently arbitrated
- A request can be **active for video but blocked for audio** (using blocker's audio capture methods while using request's video methods)
- When a higher-priority request deactivates on a track, RecordingController checks if any lower-priority requests are pending and awakens the highest-priority one on that track

**Example:**
```
Request A: priority 100, captureMethodIds: ['hires-video', 'sensitive-audio']
Request B: priority 50,  captureMethodIds: ['lowres-video']

When both are linked-active on channel:
  activeRecordSegmentRequests.video: A (100 > 50)
  activeRecordSegmentRequests.audio: A (100 vs none)
  blockedRecordSegmentRequests.video: [B]
  blockedRecordSegmentRequests.audio: [none]
  
Channel records with: hires-video (from A), sensitive-audio (from A)

When A deactivates:
  activeRecordSegmentRequests.video: B (awakens)
  activeRecordSegmentRequests.audio: undefined (no audio request)
  
Channel records with: lowres-video (from B), rolling-buffer-audio (fallback)
```

**Pre-roll semantics:**
- RecordSegmentsAction specifies `preRollSec: 30`
- Channel's rolling buffer already has 30s of pre-roll (from `defaultCaptureMethods`)
- RecordingController retrieves pre-roll segments and concatenates them with new recorded segments
- Pre-roll segments use rolling buffer capture methods; main segments use request's capture methods

**Post-roll semantics:** after the link condition fails:
1. Action enters cooldown state for `postRollSec` seconds
2. RecordingController continues storing to IDB during post-roll (captures continuation)
3. If a linked sensor re-triggers during post-roll and `onRetrigger: 'extend'`, cancel cooldown and extend recording window
4. If cooldown expires, transition to idle and stop storing to IDB

**Output:** segments tagged with `channelName` for readability; `originMonitor` set to the device's pubkey for multi-device filtering.

### SourceOverrideAction

**Purpose:** temporarily override a channel's source selection (e.g., switch to backup camera, switch to external microphone). A general-purpose config-change action that can affect downstream pipeline nodes that read from the channel's active source.

**Configuration:**
```typescript
interface SourceOverrideAction {
  id: string;
  name: string;
  type: 'source-override';
  channelId: string;                // which channel to override
  trackType: 'video' | 'audio';     // which track to override
  sourceId: string;                 // which source to use instead
  priority: number;                 // higher priority wins if multiple overrides compete
  postRollSec: number;              // extend override this long after trigger ends
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

**How it works:**
1. Channel normally uses `videoSourceId` and `audioSourceId`
2. When SourceOverrideAction activates:
   - ActionController fires `onActivate` callback
   - RecordingController applies the override: use `sourceId` instead of the channel's configured source for that track
   - All recording (rolling buffer and IDB) uses the override source
3. When SourceOverrideAction deactivates (post-roll expires):
   - ActionController fires `onDeactivate` callback
   - RecordingController clears the override: revert to channel's default source (or next-highest-priority override if any)

**Activation behavior (per-track arbitration by RecordingController):**
1. When `onActivate` fires: RecordingController checks if a higher-priority override is already active on the same track
   - If yes: **skip** applying this override (continue using the blocker's source)
   - If no: **apply** this override (use this source)
2. Report resolved sources to RTC via `onActiveSources` callback

**Example:**
```
Channel 'front-door':
  videoSourceId: 'camera-1'
  audioSourceId: 'mic-1'

Override A: priority 100, trackType: 'video', sourceId: 'camera-2'
Override B: priority 50,  trackType: 'video', sourceId: 'camera-3'

When both are linked-active:
  Active on video: A
  Blocked on video: [B]
  Recording uses: camera-2 (from A)
  
When A deactivates:
  Active on video: B (awakens from blocked queue)
  Recording uses: camera-3 (from B)
  
When B deactivates:
  Active on video: (none)
  Recording uses: camera-1 (back to channel default)
```

**Post-roll semantics:** after trigger ends, action enters cooldown with post-roll window. RecordingController continues applying the override source during post-roll. On post-roll expiry, override is cleared and reverts to default.

### PinSegmentsAction

**Purpose:** protect segments of selected types within a time window from rolling buffer eviction.

**Configuration:**
```typescript
interface PinSegmentsAction {
  id: string;
  name: string;
  type: 'pin-segments';
  channelId: string;               // which channel's segments to pin
  mimePrefix?: string;             // 'video/', 'audio/', 'image/' (omit = all types)
  preRollSec: number;              // include segments this many seconds before trigger time
  postRollSec: number;             // extend pin window this long after trigger ends
  pinLifetimeSec: number | null;   // seconds to keep pinned (null = pin forever)
  onRetrigger: 'extend' | 'ignore' | 'restart';
}
```

No per-track arbitration. Multiple PinSegmentsActions on the same channel coexist independently — each pins its own window without blocking the other.

#### Example: Motion-Triggered Hi-Res Recording

```
MotionDetector (via timewindow 9am–6pm)
  ↓ (condition: 'all' motion AND timewindow)
RecordSegmentsAction (priority 10)
  captureMethodIds: ['hires-video', 'hires-audio']
  preRollSec: 5
  postRollSec: 30
  onRetrigger: 'extend'
```

When motion is detected during business hours:
1. Channel's rolling buffer already has 5s of pre-roll from default capture methods
2. RecordSegmentsAction activates, switches to hires capture methods
3. RecordingController stores segments to IDB (pre-roll + main recording)
4. When motion stops, recording continues for 30 more seconds
5. If motion re-triggers during the 30s post-roll, the timer resets

#### Example: Per-Track Arbitration with Independent Video/Audio

Setup: Same channel, two RecordSegmentsActions with different track priorities.

```
Channel: 'front-door'
  videoSourceId: 'camera-1'
  audioSourceId: 'mic-1'
  defaultCaptureMethods: { video: 'rolling-video', audio: 'rolling-audio' }

RecordSegmentsAction A:  priority 100, captureMethodIds: ['hires-video', 'sensitive-audio']
RecordSegmentsAction B:  priority 50,  captureMethodIds: ['lowres-video']
Link A:  MotionSensor → RecordSegmentsAction A
Link B:  AudioSensor  → RecordSegmentsAction B
```

**Timeline:**

```
T=0s:   MotionSensor triggers
        - Link A evaluates: active
        - RecordSegmentsAction A: idle → active
        - activeRecordSegmentRequests.video: A (priority 100)
        - activeRecordSegmentRequests.audio: A (priority 100)
        - Channel records with: hires-video, sensitive-audio

T=5s:   AudioSensor triggers
        - Link B evaluates: active
        - RecordSegmentsAction B: idle → ?
        - Video track: idle → blocked (A's priority 100 > B's 50 for video)
        - Audio track: idle (B has no audio, so no competition)
        - RecordSegmentsAction B: active for [no audio specified]

T=10s:  MotionSensor stops
        - Link A evaluates: false
        - RecordSegmentsAction A: active → cooldown (10s post-roll)
        - activeRecordSegmentRequests.video: B (awakens)
        - activeRecordSegmentRequests.audio: undefined
        - Channel records with: lowres-video (from B), rolling-audio (fallback)

T=15s:  AudioSensor stops
        - Link B evaluates: false
        - RecordSegmentsAction B: active → cooldown

T=20s:  RecordSegmentsAction A post-roll expires
        - RecordSegmentsAction A: cooldown → idle

T=25s:  RecordSegmentsAction B post-roll expires
        - RecordSegmentsAction B: cooldown → idle
        - Channel reverts to: rolling-video, rolling-audio

Final state: Both actions idle, both links false.
```

**Key insight:** Video and audio are independently arbitrated. RecordSegmentsAction B was blocked on video (A had higher priority) but active on audio (B was the only audio request). When A deactivated, B awakened for video while continuing audio.

#### Diagram: Per-Track Arbitration with Independent Video/Audio

Video and audio tracks are **completely independent** in arbitration. An action can be **active on one track but blocked on another**, and the two tracks awaken blocked actions separately when their current active request deactivates.

**Scenario A: Simple Blocking (Both Compete for Same Track)**

```
RecordSegmentsAction A (priority 100, captureMethodIds: ['hires-video', 'sensitive-audio'])
RecordSegmentsAction B (priority 50,  captureMethodIds: ['lowres-video'])

When both are linked-active on the same channel:

  VIDEO TRACK ARBITRATION:
  ├─ Active: A (priority 100)
  ├─ Blocked: [B (priority 50)]
  └─ A wins: uses 'hires-video' from A's captures
  
  AUDIO TRACK ARBITRATION:
  ├─ Active: A (priority 100)
  ├─ Blocked: []  (B has no audio in its captureMethodIds)
  └─ A wins: uses 'sensitive-audio' from A's captures
  
RESULT:
  activeRecordSegmentRequests.video: A
  activeRecordSegmentRequests.audio: A
  blockedRecordSegmentRequests.video: [B]
  blockedRecordSegmentRequests.audio: []
  
  Channel records: hires-video (from A), sensitive-audio (from A)
  B's lowres-video is blocked; B has no audio so does not compete for audio.
```

**Scenario B: Per-Track Independence (Different Actions on Different Tracks)**

```
RecordSegmentsAction P (priority 100, captureMethodIds: ['hires-video', 'standard-audio'])
RecordSegmentsAction Q (priority 80,  captureMethodIds: ['lowres-video', 'premium-audio'])

When both are linked-active on the same channel:

  VIDEO TRACK ARBITRATION:
  ├─ Active: P (priority 100)
  ├─ Blocked: [Q (priority 80)]
  └─ P wins: hires-video
  
  AUDIO TRACK ARBITRATION:
  ├─ Active: Q (priority 80)  ← Different winner!
  ├─ Blocked: []
  └─ Q wins: premium-audio
  
RESULT:
  activeRecordSegmentRequests.video: P
  activeRecordSegmentRequests.audio: Q  ← Q is active on audio
  blockedRecordSegmentRequests.video: [Q]  ← but blocked on video
  blockedRecordSegmentRequests.audio: []
  
  Channel records: hires-video (from P), premium-audio (from Q)
  Q is ACTIVE for audio but BLOCKED for video!
  P is ACTIVE for video but has standard-audio (lower quality than Q's premium)
```

**Scenario C: Awakening on Deactivation (Per-Track Unblocking)**

Continuing from Scenario B: P's trigger ends while Q is still active.

```
AT T=10s: P's trigger expires (link condition false)
  ├─ P: active → cooldown (enters post-roll)
  └─ Q: video blocked (100 > 80) → video active (P cleared!)
  
AWAKENING EVENT:
  ├─ Channel asks: "Who should record video now that P is gone?"
  ├─ Answer: Check blocked queue for video
  ├─ Q is highest priority on video blocked queue
  └─ Q: idle (video) → active (video)
  
RESULT:
  activeRecordSegmentRequests.video: Q  ← Q awakens on video
  activeRecordSegmentRequests.audio: Q  ← Q already active on audio
  blockedRecordSegmentRequests.video: []
  
  Channel records: lowres-video (from Q), premium-audio (from Q)
  
AT T=15s: P's post-roll expires
  ├─ P: cooldown → idle
  └─ No effect (already cleared)
  
AT T=20s: Q's trigger expires (link condition false)
  ├─ Q: active → cooldown
  └─ No blocked requests on either track
  
AT T=25s: Q's post-roll expires
  ├─ Q: cooldown → idle
  ├─ activeRecordSegmentRequests.video: undefined
  ├─ activeRecordSegmentRequests.audio: undefined
  └─ Channel reverts to rolling buffer captures
```

**Visual Diagram: Multi-Track Arbitration**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CHANNEL: 'front-door'                                              T=0–5s  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  VIDEO TRACK (independent arbitration)  │  AUDIO TRACK (independent queue) │
│  ────────────────────────────────────────────────────────────────────────   │
│                                          │                                  │
│  Active: RecordSegmentsAction A          │  Active: RecordSegmentsAction A  │
│  ├─ Priority: 100                        │  ├─ Priority: 100               │
│  ├─ Capture: hires-video                 │  ├─ Capture: sensitive-audio    │
│  └─ Status: [ACTIVE]                     │  └─ Status: [ACTIVE]            │
│                                          │                                  │
│  Blocked: [Action B (priority 50)]       │  Blocked: []                     │
│  ├─ Capture: lowres-video                │  (B not requesting audio)        │
│  └─ Status: BLOCKED (A: 100 > B: 50)     │                                  │
│                                          │                                  │
│  ┌─ VIDEO RESULT ────────────────────┐   │  ┌─ AUDIO RESULT ─────────────┐ │
│  │ Using: hires-video (from A)        │   │  │ Using: sensitive-audio     │ │
│  │ (B awaits A's deactivation)        │   │  │ (only requester)           │ │
│  └────────────────────────────────────┘   │  └────────────────────────────┘ │
│                                          │                                  │
└─────────────────────────────────────────────────────────────────────────────┘

               AWAKENING ON DEACTIVATION (T=20s when A stops)

┌─────────────────────────────────────────────────────────────────────────────┐
│  CHANNEL: 'front-door'                                             T=20+s   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  VIDEO TRACK                            │  AUDIO TRACK                      │
│  ────────────────────────────────────────────────────────────────────────   │
│                                          │                                  │
│  Active: RecordSegmentsAction B          │  Active: (none; not requested)   │
│  ├─ Priority: 50                         │                                  │
│  ├─ Capture: lowres-video                │  Reverted to: rolling-audio      │
│  └─ Status: [ACTIVE] ← AWAKENED          │  Status: [DEFAULT CAPTURES]      │
│     when A deactivated                   │                                  │
│                                          │                                  │
│  Blocked: []                             │  Blocked: []                     │
│                                          │                                  │
│  ┌─ VIDEO RESULT ────────────────────┐   │  ┌─ AUDIO RESULT ─────────────┐ │
│  │ Using: lowres-video (from B)       │   │  │ Using: rolling-audio       │ │
│  │ (B awakened from blocked state)    │   │  │ (no active request)        │ │
│  └────────────────────────────────────┘   │  └────────────────────────────┘ │
│                                          │                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key principles:**

1. **Independence**: Video and audio arbitration queues are separate. The highest-priority request on video may differ from the highest-priority request on audio.

2. **Blocking is per-track**: An action can be blocked on one track (video) while active on another (audio), or active on both, or blocked on both.

3. **Awakening is per-track**: When the active request on video deactivates, the channel checks the video blocked queue to awaken the next highest-priority request. Audio's blocked queue is checked independently.

4. **No cross-track dependencies**: Deactivating on video does not affect audio's state. Audio continues with its active request (or falls back to rolling buffer) regardless of video changes.

5. **Same action in different states**: A single RecordSegmentsAction can be in different states on different tracks:
   - Active on audio (was the only audio request)
   - Blocked on video (lower priority than another request)

**Example: Mixed Audio Priorities**

Three actions competing on a single channel:

```typescript
RecordSegmentsAction Premium (priority 100, captures: ['hires-video', 'premium-audio'])
RecordSegmentsAction Standard (priority 75,  captures: ['standard-video'])
RecordSegmentsAction Archive (priority 50,   captures: ['archive-video', 'archive-audio'])

When all three fire simultaneously:

VIDEO ARBITRATION:
  Active: Premium (100)
  Blocked: [Standard (75), Archive (50)]

AUDIO ARBITRATION:
  Active: Premium (100)
  Blocked: [Archive (50)]
  (Standard not requesting audio)

RESULT: Channel records
  ├─ Video: hires-video (from Premium)
  ├─ Audio: premium-audio (from Premium)
  └─ (Standard's video blocked; Archive's audio blocked)

When Premium's trigger ends:
  ├─ Video awakens: Standard (75) becomes active
  ├─ Audio awakens: Archive (50) becomes active
  └─ Channel switches to: standard-video + archive-audio
```

### CapturePhotosAction

**Purpose:** fire photo snapshots at intervals while triggered.

**Configuration:**
```typescript
interface CapturePhotosAction {
  id: string;
  name: string;
  type: 'capture-photos';
  channelId: string;
  captureId: string;               // must reference a photo CaptureMethod
  snapshotCount: number;           // 0 = unlimited; N > 0 = stop after N photos
  intervalSec: number;             // time between snapshots
  pinLifetimeSec: number | null;   // optional pinning duration
}
```

**Activation behavior:**
1. Start `intervalSec` timer
2. On each tick, call `MediaStream.getVideoTracks()[0].getSettings()` (or similar) to extract current frame
3. Encode frame as JPEG/PNG using canvas or native encoder
4. Save as a photo segment to IDB/OPFS
5. Increment snapshot counter; if counter reaches `snapshotCount` (and `snapshotCount > 0`), deactivate
6. If `pinLifetimeSec` is set, mark saved photos as pinned with expiry

**Output:** photo segments with `mimeType: 'image/jpeg'` (or configured format); independent timeline from video/audio.

## 8. Segments

A **Segment** is an immutable record of a 10-second recording chunk stored in IDB (metadata) + OPFS (blob).

### Segment Structure

```typescript
interface Segment {
  segmentId: string;               // UUID; used as OPFS blob filename
  startTime: number;               // unix timestamp (seconds)
  endTime: number;                 // unix timestamp (seconds)
  mimeType: string;                // 'video/webm', 'audio/webm', 'image/jpeg', etc.
  sizeBytes: number;               // blob size for quota enforcement
  pinned: boolean;                 // legacy field; use pinnedUntil for state
  pinnedUntil: number | null;      // pinning state (see semantics below)
  originMonitor: string;           // pubkey of source device (for multi-device filtering)
  channelName: string;             // human-readable label
  backupOf: string | null;         // dedup key: null = canonical (originated here); <id> = remote copy
  contentHash: string;             // SHA-256 hex of blob ('' for pre-v6 records)
}
```

**backupOf semantics (segment deduplication):**
- **Layer 1 (Canonical)**: `backupOf = null` — segment originated on this device (recorded locally or fetched from peer and saved)
- **Layer 2 (Remote Copy)**: `backupOf = "<segmentId>"` — this is a copy of a remote segment; canonical origin is the value in `backupOf`
- **Quota accounting**: Only canonical segments (those with `backupOf = null`) count toward device storage quota; copies are metadata overhead only
- **Dedup key format** (multi-device): `${originMonitor}-${channelId}-${backupOf ?? segmentId}` prevents ID collisions and identifies the canonical segment across device boundaries
```

### Segment Boundaries

All segments are exactly 10 seconds (`SEGMENT_DURATION_S = 10`). Boundaries are fixed, not aligned to trigger times:
- Segment 0: 0–10s
- Segment 1: 10–20s
- Segment 2: 20–30s

When a RecordSegmentsAction starts at T=7s, the first segment covers [10–20s] (boundary alignment is automatic by MediaRecorder chunk boundaries).

### Capture Method Independence

Different capture types produce independent timelines:
- Video segments: [0–10s], [10–20s], [20–30s], …
- Audio segments: [0–10s], [10–20s], [20–30s], …
- Photo segments: [T1], [T2], [T3], … (not bound to 10s boundaries)

If you switch from recording video to recording only audio, the video timeline stops advancing; the audio timeline continues independently.

### Pinning Semantics

`pinnedUntil` state machine:

| Value | Meaning | Evictable | Thinnable |
|-------|---------|-----------|-----------|
| `null` | Never pinned | Yes (rolling buffer) | No (rolled away) |
| `-1` | Pin expired | No | Yes (thin to policy) |
| `0` | Pin forever | No | No |
| `N > 0` | Pin until timestamp N | No | No (while `now <= N`) |

**Rolling buffer eviction:** when unpinned segment count exceeds rolling buffer limit, oldest segments with `pinnedUntil === null` are deleted. Segments with `pinnedUntil === -1` (expired pins) are **not** evicted; they are kept for thinning rules.

**Quota eviction priority (when OPFS quota exceeded):**
1. Own device's unpinned segments (pinnedUntil === null)
2. Remote device's unpinned segments
3. Own device's pinned segments (last resort)
4. Remote device's pinned segments (last resort)

## 9. Segment Lifecycle & Cleanup

### Rolling Buffer Enforcement

On every `saveSegment()` call:

1. Count unpinned segments (`pinnedUntil === null`) for the monitor
2. If count exceeds `maxRollingSegments = ceil(rollingBufferSec / 10)`, delete oldest unpinned segments
3. If `rollingBufferSec === null` (infinite), skip rolling buffer step; rely on hard cap and thinning

### Hard Cap

Even with infinite rolling buffer, a hard cap applies:

```typescript
const HARD_CAP_SEGMENTS = MAX_ROLLING_SEGMENTS * 3;  // ~360 segments (1 hour) as fallback
const INFINITE_HARD_CAP_SEGMENTS = 360;              // when rollingBufferSec is null
```

Hard cap prevents runaway accumulation when thinning rules are not configured.

### Quota-Based Eviction

When OPFS quota is exceeded:

1. Calculate total size of all segments
2. Evict in priority order: own unpinned → remote unpinned → own pinned → remote pinned
3. Continue until quota is below limit

### Thinning Rules

Scheduled background job (every 5 minutes) applies thinning rules to segments older than `afterAgeSec`:

```typescript
interface ThinningRule {
  afterAgeSec: number;        // apply rule to segments older than this
  keepOnePerSec: number;      // keep 1 segment per this many seconds
  mimePrefix: string;         // 'video/', 'audio/', 'image/'
}
```

**Default policy:**
```
Video (recent):
  1–60m old: keep 1 per 30s (2 per minute)
  1–6h old: keep 1 per 60s (1 per minute)
  6–12h old: keep 1 per 5m
  12–24h old: keep 1 per 15m
  1–7d old: keep 1 per hour

Images:
  1–7d old: keep 1 per 60s
  >7d old: keep 1 per hour

Audio:
  Similar to images
```

Thinning **does not** apply to pinned segments (`pinnedUntil !== null` and not expired).

## 10. Multi-Action Triggering

When a single link fires multiple actions:

```typescript
const link: Link = {
  sensorIds: ['audio-loud'],
  condition: 'any',
  onState: 'active',
  actionIds: ['record-hi', 'clip', 'snapshot-burst']  // all three activate together
};
```

All actions activate immediately when the link condition is met:
- **RecordSegmentsAction 'record-hi'** starts recording
- **PinSegmentsAction 'clip'** pins existing segments in a window
- **CapturePhotosAction 'snapshot-burst'** starts firing photos

Actions are **independent**; no synchronization, no ordering. Each owns its own state transitions and post-roll timers.

## 11. Priority & Preemption

### RecordSegmentsAction Priority

RecordSegmentsActions have a numeric `priority` field. Priority arbitration is **per-track**: video and audio compete independently. A lower-priority action is **blocked** on a track (not stopped) when a higher-priority action is also active on that track. Blocking is silent — the blocked action never fires `onActivate` for that track.

- If RecordSegmentsAction A (priority 10) and B (priority 5) are both linked-active on the same channel:
  - On each track, A wins; B is blocked on that track
  - If B requests a track that A does not (e.g. B has audio, A has none), B is active on that track uncontested
- When A deactivates, RecordingController awakens the highest-priority blocked request on each affected track independently

See sections 7 and 15 for full per-track arbitration detail and examples.

### PinSegmentsAction & CapturePhotosAction

No preemption. Multiple PinSegmentsActions and CapturePhotosActions can coexist on the same channel:
- PinSegmentsAction A pins segments while active
- PinSegmentsAction B pins a different window while active
- Both coexist; segments pinned by A are still pinned even if B pins different segments

## 12. Architecture Principles

### Manual Wiring
All pipeline components are explicitly created and connected. No auto-discovery, no implicit defaults. Creating a source does not create captures; creating a channel does not create actions.

### No Auto-Magic
- Selecting video from camera does not auto-add audio from camera
- Creating a RecordSegmentsAction does not create its segments; segments are created on 10s boundaries during recording
- Selecting a photo capture in a RecordSegmentsAction does not auto-enable CapturePhotosAction

### State Ownership
- **Sensors** own their runtime state (SensorState)
- **Actions** own their runtime state (ActionState)
- **Links** own nothing (stateless evaluators)
- **Channels** own no runtime state; source selection and rolling buffer are static configuration
- **Segments** are immutable once saved

### Immutable Events
Once a segment is saved to IDB/OPFS, it is never modified; only the `pinnedUntil` metadata can change (via PinSegmentsAction pinning or expiry checks). No update semantics; only create/delete.

### Multi-Timeline Principle
Different capture types produce independent timelines. Video, audio, and photo segments do not synchronize with each other. A viewer must manually align them based on `startTime`/`endTime` overlap.

## 13. Example Workflows

### Workflow 1: Schedule-Based Snapshot Capture

**Setup:**
- `ScheduleDetector`: fires every 10 minutes
- `Link`: schedule-active → `CapturePhotosAction`
- `CapturePhotosAction`: capture 1 photo every 10 minutes, no pinning

**Execution:**
1. Every 10 minutes, schedule detector fires
2. Link condition is met; CapturePhotosAction activates
3. CapturePhotosAction takes 1 photo and saves to IDB
4. After settling delay (1s), CapturePhotosAction deactivates
5. Repeat every 10 minutes

**Segments:** 6 photo segments per hour, rolling buffer (never pinned, evicted after 30 days via thinning).

### Workflow 2: Loud Noise → Record + Clip + Snapshot

**Setup:**
- `AudioDetector`: threshold -24 dB, minDuration 1s, settlingMs 5s
- `TimeWindowDetector`: active 9am–6pm weekdays
- `Link 1`: audio-active AND timewindow-active → RecordSegmentsAction (priority 10)
- `Link 2`: audio-active AND timewindow-active → PinSegmentsAction
- `Link 3`: audio-active AND timewindow-active → CapturePhotosAction

**Execution at T=100s (loud noise detected during business hours):**
1. Audio detector transitions idle → sensing (avgDb -10)
2. After 1s, transition sensing → active
3. Both links' conditions are met (audio-active AND timewindow-active)
4. **RecordSegmentsAction**: start recording video + audio; segment at [100–110s]
5. **PinSegmentsAction**: pin all segments in range [90s, 130s] (preroll 10s, postroll 30s)
6. **CapturePhotosAction**: fire 5 photos at 2s intervals (T=100, 102, 104, 106, 108)

**At T=120s (noise stops, audio detector settling):**
1. Audio detector transitions active → settling (avgDb drops below release threshold)
2. Link conditions still met? Audio sensor is in settling state; if link's `onState` is 'sensing', yes; if 'active', no.
3. Assume `onState: 'active'` — link condition fails
4. **RecordSegmentsAction**: enter post-roll for 30s (total recording [100–150s])
5. **PinSegmentsAction**: enter post-roll for 30s (final pin window [90–150s])
6. **CapturePhotosAction**: post-roll for 30s (no additional photos)

**At T=150s (post-roll expires):**
1. All actions deactivate
2. Recorded video/audio segments: [100–110], [110–120], [120–130], [130–140], [140–150]
3. Pinned segments: all in range [90–150] for 7 days (PinSegmentsAction pinLifetimeSec)
4. Photos: 5 segments, no pinning (rolling buffer eviction after ~30 days)

### Workflow 3: Screen Recording with Audio Priority

**Setup:**
- `ScreenSource`: provides screen video + system audio
- `MicrophoneSource`: provides user microphone
- `VideoCapture`: screen video at 1920x1080
- `AudioCapture 1`: screen audio (system sounds)
- `AudioCapture 2`: microphone audio (user voice)
- `Channel`: video=screen, audio=microphone (fallback)
- `RecordSegmentsAction A` (priority 10): captureIds=[VideoCapture, AudioCapture2]; postRoll 10s
- `RecordSegmentsAction B` (priority 5): captureIds=[VideoCapture, AudioCapture1]; postRoll 20s
- `Link 1`: schedule-active (business hours) → RecordSegmentsAction A
- `Link 2`: timewindow-active (after-hours) → RecordSegmentsAction B

**During business hours:**
- RecordSegmentsAction A (user voice + screen) records at priority 10
- RecordSegmentsAction B is blocked
- Result: screen + user voice

**After hours:**
- RecordSegmentsAction B (system audio + screen) records at priority 5
- Result: screen + system sounds

**If both links fire simultaneously:**
- Priority 10 (A) wins
- B is skipped while A is active
- If A's link deactivates and B's link is still active, B starts recording

### Workflow 4: Camera Failover via Source Override

**Scenario:**
- Primary camera on front door (high-quality) serves as the default source
- Backup camera (lower quality, always available) is connected as failover
- A sensor detects when the primary camera fails (loss of signal, network timeout)
- SourceOverrideAction A switches recording to the backup camera immediately
- When primary recovers, a recovery action attempts to restore it
- Post-roll delays allow the operator time to visually confirm the switch was successful

**Configuration:**

```typescript
// Channel always defaults to primary camera
const frontDoorChannel: ChannelConfig = {
  id: 'front-door-ch',
  name: 'Front Door',
  videoSourceId: 'camera-1',       // primary camera
  audioSourceId: 'mic-1',          // primary mic
  defaultCaptureMethods: {
    video: 'rolling-std-video',
    audio: 'rolling-audio'
  }
};

// Two source overrides with different priorities
const failoverAction: SourceOverrideAction = {
  id: 'failover-action',
  name: 'Switch to Backup Camera',
  type: 'source-override',
  channelId: 'front-door-ch',
  trackType: 'video',              // video only; audio unaffected
  sourceId: 'camera-2',            // backup camera
  priority: 100,                   // higher priority
  postRollSec: 5,                  // keep using backup for 5s after trigger ends
  onRetrigger: 'extend'
};

const recoveryAction: SourceOverrideAction = {
  id: 'recovery-action',
  name: 'Restore Primary Camera',
  type: 'source-override',
  channelId: 'front-door-ch',
  trackType: 'video',
  sourceId: 'camera-1',            // back to primary
  priority: 50,                    // lower priority; blocked by failover
  postRollSec: 5,
  onRetrigger: 'extend'
};

// Links fire on sensor state
const failoverLink: Link = {
  id: 'failover-link',
  sensorIds: ['camera-1-lost'],    // loses signal
  condition: 'any',
  onState: 'active',               // when loss is confirmed
  actionIds: ['failover-action']
};

const recoveryLink: Link = {
  id: 'recovery-link',
  sensorIds: ['camera-1-restored'],  // signal returns
  condition: 'any',
  onState: 'active',
  actionIds: ['recovery-action']
};
```

**Timeline walkthrough:**

```
T=0s:    Normal operation
         • Failover action: idle
         • Recovery action: idle
         • activeSourceOverrides.video: undefined
         • Channel recording video with: camera-1 (primary)
         • Audio: mic-1 (always from primary; not overridden)

T=5s:    Primary camera loses signal (network timeout)
         • Failover sensor: idle → sensing → active
         • Failover link condition: met
         • Failover action: idle → active (priority 100, no blocker)
         • activeSourceOverrides.video: failover-action
         • Channel recording video with: camera-2 (backup)
         • Audio: continues from mic-1 (unaffected)

T=8s:    Primary camera recovers (signal returns)
         • Recovery sensor: idle → sensing → active
         • Recovery link condition: met
         • Recovery action: idle → blocked (failover priority 100 > recovery 50)
         • activeSourceOverrides.video: still failover-action
         • blockedSourceOverrides.video: [recovery-action (priority 50)]
         • Channel continues video with: camera-2 (failover still active)

T=20s:   Operator reviews video feed; confirms failover is working
         • Manual intervention: disable failover action via UI
         • Failover action: active → cooldown (5s post-roll)
         • activeSourceOverrides.video: still failover-action (post-roll)
         • Channel video source: still camera-2 (during post-roll window)

T=25s:   Failover post-roll expires
         • Failover action: cooldown → idle
         • activeSourceOverrides.video: undefined (failover cleared)
         • Recovery action: blocked → active (awakens; now highest priority)
         • activeSourceOverrides.video: recovery-action
         • Channel video source: camera-1 (back to primary)

T=30s:   Recovery action is now active; let it post-roll
         • Recovery sensor still sensing/active (primary is confirmed good)
         • Recovery action continues for 5s post-roll window
         • activeSourceOverrides.video: recovery-action

T=35s:   Recovery post-roll expires
         • Recovery action: active → cooldown (5s post-roll)
         • activeSourceOverrides.video: recovery-action

T=40s:   Recovery post-roll finishes
         • Recovery action: cooldown → idle
         • activeSourceOverrides.video: undefined
         • Channel reverts to: camera-1 (default, no overrides active)
         • State: normal operation restored, primary camera in use
```

**Key insights:**

1. **Per-track override**: Failover and recovery actions both specify `trackType: 'video'` only. Audio (`mic-1`) is never overridden; it continues unaffected throughout the failover cycle. The primary mic is always recording.

2. **Priority-based blocking**: When the recovery action fires (T=8s), it is blocked because the failover action has higher priority (100 > 50) on the video track. The recovery action cannot activate until the failover deactivates.

3. **Awakening on deactivation**: When the failover action is manually disabled (T=20s), it enters post-roll. At T=25s when post-roll expires, the recovery action **automatically awakens** without any re-trigger. It was waiting in the blocked state; no new sensor event is needed.

4. **Post-roll for overrides**: The 5-second post-roll delay allows the operator time to verify that the fallback camera is working. If the switch had failed (backup camera also unavailable), the operator has a window to react before the action clears.

5. **Difference from RecordSegmentsAction**: Unlike record actions which change *what is captured* (hi-res vs. low-res encoding), overrides only change *which source provides the media*. The channel's capture methods remain the same; only the source input changes.

**State machine summary:**

| Action | State | Condition |
|--------|-------|-----------|
| Failover | idle | No camera loss detected |
| Failover | **active** | Loss detected; priority 100 wins |
| Recovery | **blocked** | Failover active (100 > 50) |
| Recovery | **active** | Failover cleared; recovery awakens |

## 14. Key Design Decisions

### Why Explicit Source Pairing?
Cameras often provide both video and audio, but users may want to mix sources (screen video + microphone audio) or record only one track. Explicit capture methods avoid hidden audio or video surprises.

### Why 10-Second Segments?
10 seconds balances granularity (fine control for pinning/clipping) with I/O efficiency (fewer IDB writes, fewer OPFS files). Short segments enable precise clip windows; longer segments reduce overhead.

### Why Pinning Instead of Manual Selection?
Pinning is deterministic: PinSegmentsAction pins based on the trigger time. Manual selection is error-prone (users forget to mark segments). Pinning ensures important clips are never rolled away by accident.

### Why Two-Level Cleanup (Rolling Buffer + Hard Cap)?
Rolling buffer enforces a fixed-size window based on the trigger configuration. Hard cap prevents runaway growth if rolling buffer is disabled. Thinning rules let older segments thin out gracefully, preserving space for recent footage.

### Why Post-Roll?
Many triggers are instantaneous (audio spike, motion detection). Post-roll captures context after the trigger ends (e.g., what happened after the noise stopped?). Extendable post-roll (onRetrigger='extend') handles chattering triggers.

## 15. State Management: Per-Track Arbitration

Per-track arbitration and awakening for RecordSegmentsActions and SourceOverrideActions is managed by **RecordingController** (see `docs/new/sentry-controller.md` § RecordingController).

Key responsibilities:

- **Per-track state storage** (internal to RecordingController):
  - `activeRecordSegmentRequests: { video?: Request, audio?: Request }`
  - `blockedRecordSegmentRequests: { video: Request[], audio: Request[] }`
  - Separate queues for each track type
  - Identical structure for source overrides
  
- **On `startRecording(action)`** — decides which capture methods to use for each track:
  - For each track (video/audio) that the action requests
  - Check if any higher-priority request is already active on that track
  - If yes: skip this action on that track (continue using blocker's captures)
  - If no: activate this action's captures on that track
  - Update arbitration state and report resolved captures/sources to RTC
  
- **On `stopRecording(action)` or override deactivation** — triggers per-track awakening:
  - For each track the action was active on
  - Check blocked queue for that track; awaken highest-priority request
  - Does not affect other tracks
  
- **SourceOverrideAction uses identical logic**:
  - Per-track priority arbitration
  - When active, override source is applied to that track
  - On deactivation, revert to channel default or next-highest-priority override
  - Same independent-track arbitration as RecordSegmentsAction

Example of RecordingController arbitration in action:

```typescript
// RecordingController maintains independent queues
activeRecordRequests: { video: ActionA, audio: ActionA }
blockedRecordRequests: { video: [ActionB], audio: [] }

// When ActionA deactivates on video:
activeRecordRequests: { video: ActionB, audio: ActionA }  // B awakens on video only
blockedRecordRequests: { video: [], audio: [] }

// When ActionA deactivates on audio:
activeRecordRequests: { video: ActionB, audio: undefined }  // audio reverts to rolling buffer
```

This decoupling ensures that action state (ActionController) is independent of recording/capture logic (RecordingController), making the system composable and testable.
