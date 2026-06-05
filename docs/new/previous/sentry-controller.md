# Sentry Pipeline Controllers

## Architecture

```
SentrySection.svelte  (thin UI layer)
  │  reads pipeline config + identity stores
  │  renders arm/disarm button, status, sensor readings
  │  forwards user gestures (arm, disarm) to controllers
  │
  ├── DetectorController         manages detector instances + sensorStates
  ├── ActionController           manages actionStates, evaluates links
  ├── RecordingController        manages MediaRecorder sessions
  ├── PinSegmentsController      manages footage window pinning for PinSegmentsActions
  ├── CapturePhotosController    manages photo burst sessions for CapturePhotosActions
  ├── TriggerPublisher           sends action signals (kind 5010/5011) to targeted paired contacts via channel keys
  └── RemoteCommandController    receives kind 5006 from signal router, validates TOTP, dispatches to handlers
```

Each controller is a plain TypeScript class (no Svelte dependency). SentrySection instantiates them and passes config/identity as plain values — no store references inside controllers.

---

## DetectorController

Manages the lifecycle of all `Detector` instances for the active sensor config.

```typescript
class DetectorController {
  constructor(
    sensors: SensorConfig[],
    streams: Map<sourceId, MediaStream>,
    onStateChange: (sensorId: string, state: SensorState) => void,
  ) {}

  start(): void   // instantiate + start all enabled sensors
  stop(): void    // stop + destroy all sensors
  handleRemoteTrigger(event: TriggerEvent): void  // for NostrTriggerDetector

  readonly sensorStates: Record<string, SensorState>
}
```

**Responsibilities:**
- Detector instantiation loop
- `sensorStates` `$state` record
- `detectors` Map management
- The `onStateChange` wiring to `_evaluateLinks`

**Rules:**
- No Svelte imports; use plain callback pattern for state changes
- Does not know about links or actions — only reports sensor state
- `streams` are passed in; DetectorController does not open MediaStreams

---

## ActionController

Evaluates pipeline links on sensor state changes and manages action runtime state.

```typescript
class ActionController {
  constructor(
    links: Link[],
    actions: ActionConfig[],
    onActivate: (action: ActionConfig) => void,
    onDeactivate: (action: ActionConfig) => void,
  ) {}

  evaluateLinks(sensorStates: Record<string, SensorState>): void
  forceDeactivateAll(): void   // called on disarm

  readonly actionStates: Record<string, ActionState>
}
```

**Responsibilities:**
- `_evaluateLinks()`
- `_activateAction()` / `_deactivateAction()`
- `actionStates` `$state` record
- Retrigger logic (`'extend' | 'ignore' | 'restart'`)
- `postRollSec` timers

**Core behavior:**

1. **Link evaluation**: On sensor state change, re-evaluate all links to determine which actions should be active
2. **Action activation**: When a link becomes true, transition the action from `idle` to `active`
   - RecordSegmentsAction: activate and fire `onActivate` callback
   - SourceOverrideAction: activate and fire `onActivate` callback
   - PinSegmentsAction/CapturePhotosAction: activate immediately and fire `onActivate` callback
3. **Action deactivation**: When a link becomes false:
   - Enter `cooldown` state with post-roll timer
   - On post-roll expiry: transition to `idle` and fire `onDeactivate` callback
4. **Retrigger handling**:
   - `extend`: cancel post-roll timer if already active/cooldown, restarting the post-roll window
   - `ignore`: post-roll runs uninterrupted; retrigger does not affect it
   - `restart`: immediate transition to idle, then re-evaluate link to transition to active

**Rules:**
- `onActivate` callback fires when an action transitions to `active` (from `idle`)
- `onDeactivate` callback fires when an action transitions to `idle` (from `cooldown`)
- Post-roll timers are owned by ActionController — callbacks only fire at true state transitions
- Does not touch MediaRecorder, segment pinning, photo capture, channel sources, or per-track arbitration directly
- Per-track arbitration for RecordSegmentsAction and SourceOverrideAction is handled by RecordingController and ActionController together (see RecordingController section below)

---

## SourceOverrideAction

A general-purpose action that temporarily changes pipeline configuration during an active window. Most commonly used to override channel source selection, but the pattern extends to other pipeline configuration changes.

**Core behavior:**
- When active, applies a configuration change (e.g., `overrideVideoSourceId` switches the channel's video source to a backup camera)
- RecordingController and other downstream components read the active configuration override and apply it
- Multiple SourceOverrideActions on the same channel can compete for the same track via priority arbitration
- ActionController manages state transitions; RecordingController implements per-track arbitration logic

**Rules:**
- Does not directly touch MediaStream or MediaRecorder
- Does not own the underlying channel configuration — only requests an override
- Per-track independent arbitration: video and audio can have different active overrides (handled by RecordingController)
- Fires `onActivate` callback when transitioning to `active`; fires `onDeactivate` when post-roll expires
- Post-roll semantics identical to RecordSegmentsAction: extends active window for configurable duration after trigger ends
- **Tiebreaker (equal priority):** If two SourceOverrideActions target the same track with identical priority, the action with the earliest activation timestamp wins. This differs from RecordSegmentsAction tiebreaker, which uses insertion order into config (first action added to config wins) rather than activation timestamp. Both rules ensure deterministic resolution even when actions activate simultaneously.

---

## RecordingController

Manages `MediaRecorder` sessions per `(channelId, captureId)` pair, handles per-track arbitration for RecordSegmentsActions and SourceOverrideActions, and reports active sources to `monitor-peer`.

```typescript
class RecordingController {
  constructor(
    captures: CaptureMethod[],
    channels: ChannelConfig[],
    streams: Map<sourceId, MediaStream>,
    originMonitor: string,
    onSegmentSaved: (meta: SegmentMeta) => void,
    onActiveSources: (channelId: string, sourceIds: string[]) => void,
  ) {}

  startRecording(action: RecordSegmentsAction): void
  stopRecording(action: RecordSegmentsAction): void
  activateSourceOverride(action: SourceOverrideAction): void
  deactivateSourceOverride(action: SourceOverrideAction): void
  stopAll(): void

  readonly activeRecorders: Map<string, MediaRecorder>
}
```

**Responsibilities:**
- `_updateChannelActiveSources()`
- `_updateChannelRecorder()`
- `mediaRecorders` Map management
- `ondataavailable` → `saveSegment` wiring
- Rolling buffer eviction trigger on each chunk save
- Per-track arbitration logic for RecordSegmentsActions (which capture methods to use per track when multiple actions compete)
- Per-track arbitration logic for SourceOverrideActions (which source to use per track)

**Core behavior:**

1. **Per-track arbitration for RecordSegmentsAction:**
   - When `onActivate(RecordSegmentsAction)` fires: check if a higher-priority action is already active for each track
   - If blocked on a track: continue using the blocker's capture methods on that track
   - If active on a track: switch to this action's capture methods on that track
   - Maintain independent active/blocked queues per track type

2. **Per-track arbitration for SourceOverrideAction:**
   - When active: apply source override to the requested track
   - Multiple overrides on the same track compete by priority; highest-priority wins
   - When deactivated: revert to channel's default source (or next-highest-priority override if any)

3. **Recording workflow:**
   - Call `startRecording(action)` when action activates
   - Determine which capture methods are active per track (accounting for arbitration)
   - Create MediaRecorder with appropriate codec/resolution
   - On each data chunk: save segment via `saveSegment()`, trigger rolling buffer cleanup
   - Call `stopRecording(action)` when action deactivates

4. **Source resolution:**
   - Resolved source = channel's default source, unless a SourceOverrideAction is active on that track
   - After determining which capture methods are active per track, look up their source IDs from the channel config
   - Apply source overrides on top (track-by-track)
   - Report final resolved sources to RTC via `onActiveSources` callback

**Rules:**
- Calls `monitor-peer.setChannelActiveSources()` via the `onActiveSources` callback — does not import `monitor-peer` directly
- Calls `saveSegment` internally; never exposes raw blobs
- Gets channel source selection from `ChannelConfig.videoSourceId` / `audioSourceId` (never from CaptureMethod, which only owns encoding)
- Applies SourceOverrideAction changes on top of channel default sources
- Per-track independence is strict: deactivating one action on video does not affect audio state

---

## PinSegmentsController

Manages footage window pinning for `PinSegmentsAction`s.

```typescript
class PinSegmentsController {
  constructor(actions: PinSegmentsAction[]) {}

  activate(action: PinSegmentsAction, triggerTime: number): Promise<void>
  deactivate(action: PinSegmentsAction): void
}
```

Calls `pinSegmentsInRange(from, to, pinLifetimeSec)` internally. No external dependencies beyond `segments.ts`.

---

## CapturePhotosController

Manages photo burst sessions for `CapturePhotosAction`s.

```typescript
class CapturePhotosController {
  constructor(
    captures: CaptureMethod[],
    streams: Map<sourceId, MediaStream>,
    originMonitor: string,
  ) {}

  activate(action: CapturePhotosAction): void
  deactivate(action: CapturePhotosAction): void
  stopAll(): void
}
```

Calls `capturePhoto(stream, options)` and `saveSegment(blob, 'image/...', ...)` internally.

---

## RemoteCommandController

Receives kind 5006 (Remote Command) events from the signal router, validates the TOTP credential, and dispatches to the registered handler by `payload.payload.type`. Sends an ack over the same `contactId` before handler execution.

```typescript
class RemoteCommandController {
  constructor(
    nostrClient: NostrClient,
    totpStore: TOTPCredentialStore,
    onSignal: SignalRouterCallback,
  ) {}

  registerHandler(type: string, handler: RemoteCommandHandler): void
  start(): void
  stop(): void
}

interface RemoteCommandHandler {
  handle(contactId: string, payload: unknown): Promise<void>;
}
```

**Constructor arguments:**
- `nostrClient` — used to publish ack signals via `publishSignal`
- `totpStore` — provides credential lookup and rate limiting per contact
- `onSignal` — `SignalRouterCallback` that delivers kind 5006 events from the signal router. The application's top-level `onSignal` handler fans out by kind — kind 5006 events are delivered to `RemoteCommandController` via this callback; other kinds go to their respective handlers.

**Responsibilities:**
- Subscribes to the signal router for kind 5006 events via `onSignal`
- Validates freshness: if `now - payload.created_at > payload.ttl`, discard silently
- Looks up the TOTP credential for `contactId` from `totpStore`
- Validates via `verifyRawSeed` or `verifyTOTPCode` depending on `payload.credential_type`
- Records every attempt via `recordTOTPAttempt` (both success and failure)
- If invalid: discard silently, no ack sent, rate limiting applied
- If valid: `publishSignal(contactId, 5006, { isResponse: true, commandId, accepted: true, created_at: now })`, then call the registered handler
- Dispatches by `payload.payload.type` — one registered handler per type
- Ack confirms credential validity only; handler execution result is not part of the ack

**Rules:**
- No Svelte imports
- Does not validate command semantics — only credential and freshness
- Does not own TOTP seeds — receives `totpStore` at construction
- Handler registration is explicit — no auto-discovery
- One instance per app; shared across all contacts
- Works with any contact type — does not distinguish `TempContact` from `PairedContact`; the TOTP credential in the payload is always the authorization mechanism regardless of how the contact was established

**Handler registration example:**

```typescript
remoteCommandController.registerHandler("relay-migrate-command", {
  handle: async (contactId, payload) => {
    const { newRelays } = payload;
    nostrClient.requestRelayMigrationListening(contactId, newRelays, async () => {
      // onReady: dual-listen confirmed active — kind 5005 migration proceeds from here
      await proposeInboundMigration(contactId, newRelays);
    });
  },
});
```

---

## SentrySection.svelte

After extraction, `SentrySection.svelte` becomes:

```svelte
<script lang="ts">
  // Props: identity, pipeline, streams, pairings, monitor state

  // Controller instances
  let detectorCtrl: DetectorController | null = null;
  let actionCtrl: ActionController | null = null;
  let recordingCtrl: RecordingController | null = null;
  let publishCtrl: TriggerPublisher | null = null;
  let remoteCommandCtrl: RemoteCommandController | null = null;

  // Arm / disarm
  // startMonitor: opens streams, instantiates all controllers (including remoteCommandCtrl), calls start() on each
  // stopMonitor: calls stop() on all controllers (including remoteCommandCtrl.stop()), closes streams
  function startMonitor() { /* open streams, instantiate controllers, start all */ }
  function stopMonitor()  { /* stop all controllers, close streams */ }

  // Pass-through state for SettingsSection display
  let sensorStates = $derived(detectorCtrl?.sensorStates ?? {});
  let actionStates = $derived(actionCtrl?.actionStates ?? {});
</script>
```

No `_evaluateLinks`, no `ondataavailable`, no `cooldownTimer` scattered through 100 lines of imperative state.

---

## Testing

Controllers have no Svelte or browser dependencies — they can be unit-tested with `vitest` using fake streams and mock callbacks.

```typescript
// Example: ActionController test with per-track arbitration
const states = { 'sensor-a': { status: 'active' } };
const onActivate = vi.fn();
const ctrl = new ActionController(links, actions, onActivate, vi.fn());
ctrl.evaluateLinks(states);
expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ type: 'record-segments' }));

// Example: Per-track blocking test
// Two RecordSegmentsActions on the same channel with different priorities
// When higher-priority action activates:
// - Its video and audio requests are accepted
// - Lower-priority action enters 'blocked' state (does not fire onActivate)
// When higher-priority action deactivates:
// - Lower-priority action awakens and fires onActivate (for video on that track, audio on that track)
// Video and audio tracks can have different blockers independently
```

Each controller has no Svelte or browser dependencies and can be unit-tested in isolation.

