# Sentry Pipeline Controllers

## Architecture

Controllers sit between the [sentry pipeline](sentry-pipeline.md) and the Svelte UI layer. They own all orchestration, state management, and business logic. The frontend renders controller state and forwards user gestures — nothing more.

```
SentrySection.svelte  (thin UI layer)
  │  reads controller state for rendering
  │  forwards arm/disarm gestures to controllers
  │
  ├── SessionController          owns session connection lifecycle, kind 5004 state machine
  ├── DetectorController         manages detector instances and sensorStates
  ├── ActionController           evaluates links, manages actionStates
  ├── RecordingController        manages MediaRecorder sessions, per-track arbitration
  ├── PinSegmentsController      manages footage window pinning for PinSegmentsActions
  ├── CapturePhotosController    manages photo burst sessions for CapturePhotosActions
  ├── TriggerPublisher           sends action signals (kind 5010/5011) to paired contacts
  └── RemoteCommandController    receives kind 5006, validates TOTP, dispatches to handlers
```

Every controller is a plain TypeScript class with no Svelte dependency. `SentrySection` instantiates them with plain values — no store references pass into controllers.

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

  start(): void
  stop(): void
  handleRemoteTrigger(event: TriggerEvent): void

  readonly sensorStates: Record<string, SensorState>
}
```

**Responsibilities:**

- Instantiate and start all enabled sensors on `start()`
- Maintain the `sensorStates` record and fire `onStateChange` on every transition
- Manage the internal `detectors` Map — create on start, destroy on stop
- Route remote trigger events to `NostrTriggerDetector` instances via `handleRemoteTrigger` — `NostrTriggerDetector` is a sensor that fires when a kind 5010 Trigger signal is received from a paired contact (see [signal-exchange.md § Action Signals](signal-exchange.md))

`TriggerEvent` is the decrypted payload of a kind 5010 signal — it is the `TriggerPayload` shape defined in [signal-exchange.md § Payload Shapes](signal-exchange.md), wrapped with the sending contact: `{ contactId: string } & TriggerPayload`.

`MediaStream` objects are passed in at construction. DetectorController does not open or close streams. It does not know about links or actions — it only observes sensor state and reports it upward via the callback.

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
  forceDeactivateAll(): void

  readonly actionStates: Record<string, ActionState>
}
```

**Responsibilities:**

- Re-evaluate all links whenever sensor state changes
- Transition actions between `idle`, `active`, and `cooldown` states
- Own all post-roll timers
- Handle retrigger semantics per action config

```typescript
type ActionState =
  | { status: 'idle' }
  | { status: 'active'; startedAt: number }
  | { status: 'cooldown'; endsAt: number };
```

- **idle → active**: link condition met
- **active → cooldown**: link condition fails; enter post-roll delay
- **cooldown → idle**: post-roll timer expires
- **active → idle**: immediate on disarm or manual stop

**State transition rules (callbacks):**

| Transition | Callback fired |
|---|---|
| `idle` → `active` | `onActivate` |
| `cooldown` → `idle` (post-roll expires) | `onDeactivate` |
| `active` → `cooldown` (link becomes false) | none |

**Retrigger behavior** (when a link becomes true while an action is already in `active` or `cooldown`):

| Mode | Behavior |
|---|---|
| `extend` | Cancel and restart the post-roll timer |
| `ignore` | Post-roll runs uninterrupted |
| `restart` | Immediately transition to `idle`, then re-evaluate to transition back to `active` |

ActionController does not touch MediaRecorder, segment pinning, photo capture, or channel sources directly. Those responsibilities belong to the specialized controllers that receive `onActivate` / `onDeactivate` callbacks.

---

## RecordingController

Manages `MediaRecorder` sessions per `(channelId, captureId)` pair, handles per-track arbitration for `RecordSegmentsAction` and `SourceOverrideAction`, and reports active sources to `monitor-peer`.

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

- Create and tear down `MediaRecorder` instances per active action
- Wire `ondataavailable` → `saveSegment`, triggering rolling buffer eviction on each chunk
- Apply per-track arbitration for RecordSegmentsActions
- Apply per-track source arbitration for SourceOverrideActions
- Report resolved source IDs to `monitor-peer` via `onActiveSources`

**Per-track arbitration for RecordSegmentsAction:**

When `onActivate(RecordSegmentsAction)` fires, RecordingController checks each track independently:

- If a higher-priority action already holds the track: the new action is marked blocked on that track and does not start a recorder for it
- If no higher-priority action holds the track: the new action becomes active on that track
- When the higher-priority action deactivates, blocked actions are re-evaluated and may awaken

**Source resolution for SourceOverrideAction:**

Resolved source = channel's default source (`ChannelConfig.videoSourceId` / `audioSourceId`), unless a `SourceOverrideAction` is active on that track. Multiple overrides compete by priority; the highest-priority active override wins. When an override deactivates, the channel reverts to its default or the next-highest active override.

After resolving sources, RecordingController reports the final set to `monitor-peer` via `onActiveSources`. It calls `saveSegment` internally and never exposes raw blobs. It does not import `monitor-peer` directly — the callback boundary is enforced at construction.

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

Calls `pinSegmentsInRange(from, to, pinLifetimeSec)` internally. The `triggerTime` parameter anchors the pre-roll window. No external dependencies beyond the segments storage layer.

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

Calls `capturePhoto(stream, options)` per burst interval and `saveSegment(blob, 'image/...', ...)` for each captured frame. Burst timing and interval are owned by the controller; the action config provides the parameters.

---

## SessionController

`SessionController` owns the session connection lifecycle for all contacts. It is the exclusive owner of session state — other controllers consult it for active session UUIDs and receive callbacks when sessions open or close. It drives `NostrClient`'s session subscriptions via `openSessionSubscription`/`closeSessionSubscription` and owns the kind 5004 state machine. It has no Svelte dependency.

```typescript
class SessionController {
  constructor(
    mySessionUUID: string,
    nostrClient: NostrClient,
    onSessionOpened: (contactId: string, peerSessionUUID: string) => void,
    onSessionClosed: (contactId: string, peerSessionUUID: string) => void,
    opts?: {
      startupGraceMs?: number; // default: 20_000
    }
  ) {}

  // Called by the top-level signal router fan-out for every kind 5004 event
  handlePresenceSignal(
    contactId: string,
    payload: StatusPayload,
    senderSessionUUID: string,
  ): void;

  // Returns the active peer session UUIDs for a contact.
  // Other controllers call this before publishSignal to obtain a valid sessionId.
  getActiveSessions(contactId: string): string[];

  // Explicitly closes a session (e.g. after RTC hangup, after peer offline).
  closeSession(contactId: string, peerSessionUUID: string): void;

  start(): void;  // begins accepting 5004 signals; starts startup grace timer
  stop(): void;   // closes all session subscriptions; does not publish offline
}
```

**Constructor arguments:**

| Argument | Role |
|---|---|
| `mySessionUUID` | This app instance's session UUID, generated once at startup and passed identically to `NostrClient`. |
| `nostrClient` | Used to call `publishSignalDirect` (for `isResponse=true` 5004 session connect) and `openSessionSubscription`/`closeSessionSubscription`. |
| `onSessionOpened(contactId, peerSessionUUID)` | Fired when a session is fully established (after both sides complete the 5004 exchange). Signals RTC and other controllers that this peer session is ready to receive directed signals. |
| `onSessionClosed(contactId, peerSessionUUID)` | Fired when a session ends — peer announced offline with a matching session UUID, or `closeSession` was called explicitly. |
| `opts.startupGraceMs` | During this window after `start()`, `SessionController` does not send an unsolicited `isResponse=true` in response to a peer's `isResponse=false` announcement. If a peer sends `isResponse=true` directed at this session (because it received this device's own startup broadcast first), the session is accepted regardless of the grace window. This prevents a reply flood when many contacts come online simultaneously. |

**`handlePresenceSignal` behavior:**

1. `payload.state === 'offline'`: close any active session for `(contactId, senderSessionUUID)` — call `nostrClient.closeSessionSubscription(contactId, senderSessionUUID)`, remove from the session map, fire `onSessionClosed`.

2. `payload.state === 'online'`, `isResponse=false` (announcement):
   - Session already active for `senderSessionUUID`: no-op.
   - Startup grace has not expired: record the announcement as pending; do not reply yet. When grace expires, all pending announcements are processed: for each, open `nostrClient.openSessionSubscription(contactId, senderSessionUUID)`, then `publishSignalDirect(contactId, 5004, { state: 'online', isResponse: true }, senderSessionUUID)`, and fire `onSessionOpened`. If a peer sends `isResponse=true` directed at this session UUID before grace expires, that handshake is accepted immediately (step 3 below) — the pending entry is removed and no deferred reply is sent.
   - Startup grace expired: open `nostrClient.openSessionSubscription(contactId, senderSessionUUID)`, then `publishSignalDirect(contactId, 5004, { state: 'online', isResponse: true }, senderSessionUUID)`. Fire `onSessionOpened`. The session subscription is opened before the reply is sent so the session is ready to receive directed traffic by the time the peer processes the ack.

3. `payload.state === 'online'`, `isResponse=true` (session connect directed at this session):
   - Open `nostrClient.openSessionSubscription(contactId, senderSessionUUID)` if not already open.
   - Fire `onSessionOpened(contactId, senderSessionUUID)`.

**`getActiveSessions(contactId)`** returns the UUIDs of all currently active peer sessions for the contact. Returns `[]` if none. Callers use this to obtain a `sessionId` before calling `publishSignal`.

**What `SessionController` does NOT do:**
- Does not call `ContactManager.updatePeerSession()` directly — the app layer may wire that via the `onSessionOpened` callback if the convenience field is desired.
- Does not handle any signal kind other than 5004 via `handlePresenceSignal`.
- Does not own RTC state, relay migration state, or remote command state.
- Does not validate session UUIDs passed by callers — it is the source of truth for valid UUIDs.

---

## RemoteCommandController

Kind 5006 (Remote Command) is defined in [signal-exchange.md](signal-exchange.md) § Remote Command.

Receives kind 5006 events from the signal router, validates the TOTP credential, and dispatches to registered handlers by command type. An ack is sent over the same `contactId` before handler execution.

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

| Argument | Role |
|---|---|
| `nostrClient` | Publishes ack signals via `publishSignal` |
| `totpStore` | Credential lookup and rate limiting per contact |
| `onSignal` | `(contactId: string, kind: number, payload: object, senderSessionUUID?: string) => void` delivering kind 5006 events from the signal router — `senderSessionUUID` is the `#fs` tag value and is passed to the ack publish as `sessionId`. See [signal-exchange.md](signal-exchange.md) § Signal Router for the `SignalRouterCallback` type alias. |

`TOTPCredentialStore` is the subset of `ContactManager` used by `RemoteCommandController`:

```typescript
interface TOTPCredentialStore {
  // Returns the TOTP seed for a contact, or null if not paired
  getSeed(contactId: string): Uint8Array | null
  // Records a verification attempt; throws RateLimitError if limit exceeded
  recordAttempt(contactId: string, success: boolean): void
  // Returns true if the contact is currently locked out
  isLockedOut(contactId: string): boolean
}
```

`TOTPCredentialStore` is a plain object injected into `RemoteCommandController`, wrapping the standalone TOTP functions from [pairing.md](pairing.md). `ContactManager` does not implement it. The interface boundary ensures `RemoteCommandController` receives only the credential operations it needs.

The application's top-level `onSignal` handler fans out by kind: kind 5006 events are delivered to `RemoteCommandController`; other kinds go to their respective handlers.

**Processing a received command:**

1. Check freshness: if `now - payload.created_at > payload.ttl`, discard silently
2. Look up the TOTP credential for `contactId` from `totpStore`
3. Validate via `verifyRawSeed` or `verifyTOTPCode` depending on `payload.credential_type`
4. Record the attempt via `totpStore.recordAttempt(contactId, success)` regardless of outcome
5. If invalid: discard silently, no ack, rate limiting applied
6. If valid: publish ack via `publishSignal(contactId, 5006, { isResponse: true, commandId, accepted: true }, senderSessionUUID)`, then call the registered handler

The ack confirms credential validity only. Handler execution result is not part of the ack. Dispatch is by `payload.payload.type` — one registered handler per type.

**Handler registration example:**

```typescript
remoteCommandController.registerHandler("relay-migrate-command", {
  handle: async (contactId, payload) => {
    const { newRelays } = payload;
    nostrClient.requestRelayMigrationListening(contactId, newRelays, async () => {
      await proposeInboundMigration(contactId, newRelays);
    });
  },
});
```

**Rules:**

- No Svelte imports
- Does not validate command semantics — only credential and freshness
- Does not own TOTP seeds — receives `totpStore` at construction
- Handler registration is explicit; no auto-discovery
- One instance per app, shared across all contacts
- Does not distinguish `TempContact` from `PairedContact` — the TOTP credential in the payload is always the authorization mechanism

---

## TriggerPublisher

Wraps `NostrClient` to publish kind 5010 (trigger) and kind 5011 (arm-state) signals to all paired contacts when pipeline actions activate or the arm state changes. It is instantiated and wired by `SentrySection` alongside the other controllers.

```typescript
class TriggerPublisher {
  constructor(
    nostrClient: NostrClient,
    contactManager: ContactManager,
  ) {}

  fire(payload: TriggerPayload): void
  setArmed(armed: boolean): void
}
```

**Constructor arguments:**

| Argument | Role |
|---|---|
| `nostrClient` | Publishes signals via `publishSignal` |
| `contactManager` | Provides the full list of paired contact IDs to address each publish |

**Methods:**

- `fire(payload)` — iterates `contactManager.allContactIds()` and calls `nostrClient.publishSignal(contactId, 5010, payload)` for each. Temp contacts have no outbound channel key and are skipped silently. `publishSignal` (queued) is used because trigger notifications are not time-sensitive at the Nostr layer — the viewer catches up via history fetch if offline.
- `setArmed(armed)` — iterates the same contact list and publishes a kind 5011 signal with an `ArmStatePayload` for each.

Payload shapes (`TriggerPayload`, `ArmStatePayload`) are defined in [signal-exchange.md](signal-exchange.md) § Payload Shapes.

---

## SentrySection.svelte Integration

`SentrySection.svelte` is a thin coordination layer. It instantiates controllers, arms and disarms them as a unit, and exposes derived state for rendering.

```svelte
<script lang="ts">
  let sessionCtrl: SessionController | null = null;
  let detectorCtrl: DetectorController | null = null;
  let actionCtrl: ActionController | null = null;
  let recordingCtrl: RecordingController | null = null;
  let publishCtrl: TriggerPublisher | null = null;
  let remoteCommandCtrl: RemoteCommandController | null = null;

  function startMonitor() {
    // Open streams, instantiate all controllers with callbacks wired, call start() on each
  }

  function stopMonitor() {
    // Call stop() on all controllers, close streams
  }

  let sensorStates = $derived(detectorCtrl?.sensorStates ?? {});
  let actionStates = $derived(actionCtrl?.actionStates ?? {});
</script>
```

The component contains no link evaluation, no `ondataavailable`, no cooldown timers, and no arbitration logic. All imperative state management lives in the controllers.

---

## Testing

Controllers have no Svelte or browser dependencies. They are unit-tested with `vitest` using fake streams and mock callbacks.

```typescript
const onActivate = vi.fn();
const ctrl = new ActionController(links, actions, onActivate, vi.fn());
ctrl.evaluateLinks({ 'sensor-a': { status: 'active' } });
expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ type: 'record-segments' }));
```

Per-track arbitration is testable without a real `MediaRecorder`:

```typescript
// Two RecordSegmentsActions on the same channel, different priorities.
// When higher-priority action activates, lower-priority enters blocked state.
// When higher-priority deactivates, lower-priority awakens and fires onActivate.
// Video and audio tracks can have different blockers independently.
```

`RemoteCommandController` is tested by injecting a fake `totpStore` and asserting that handlers are called only after credential validation passes.
