# Controller Architecture — Senstry System Design

## Table of Contents

1. [Philosophy](#philosophy)
2. [Architectural Overview](#architectural-overview)
3. [State Ownership Template](#state-ownership-template)
4. [Dumb Component Contracts](#dumb-component-contracts)
5. [Controller Interaction Patterns](#controller-interaction-patterns)
6. [Async/Await Contracts](#asyncawait-contracts)
7. [Error Handling Patterns](#error-handling-patterns)
8. [Store Access Rules](#store-access-rules)
9. [Testing Contracts](#testing-contracts)
10. [Forbidden Patterns](#forbidden-patterns)

---

## Philosophy

### The Core Pattern: Dumb Components + Smart Controllers

**Every Svelte component in Senstry is a passive display surface.** Components render props and fire callbacks when the user interacts. They own no state, make no decisions, validate nothing, and never read from sibling components.

**Every controller is a state machine.** Controllers own state, enforce invariants, orchestrate side effects, manage async operations, and decide when and how to update the UI. Controllers are plain TypeScript classes with no Svelte dependency — they can be tested without a browser.

This separation enables:
- **Testability** — controllers run in plain `vitest` with mock callbacks, no `happy-dom` needed
- **Reusability** — a controller can power multiple UIs (web, mobile, CLI) by swapping the view layer
- **Maintainability** — state ownership is explicit; tracing who writes what is trivial
- **Parallelism** — controllers can own disjoint state and communicate via a defined protocol, enabling safe concurrent work

### Why This Matters for Senstry

Senstry's pipeline is complex: detectors fire asynchronously, links evaluate non-deterministically, actions have post-roll timers and deactivation loops, recordings segment continuously, and clips accumulate. Without clear state ownership, this logic scatters across 20 components and becomes unmaintainable.

The pattern forces all this logic into controllers, leaving components to be "dumb but visible" — they know how to render `sensorStates` or `playerSegs` but not how those values came to be or what should happen next.

---

## Architectural Overview

### System Layers

```
┌──────────────────────────────────────────────────────────────────┐
│                    DevSection (top-level root)                   │
│  Instantiates all controllers, manages their lifecycle            │
└──────────────────────┬───────────────────────────────────────────┘
                       │
        ┌──────────────┴────────────────────┬──────────────────────┐
        │                                   │                      │
        ▼                                   ▼                      ▼
┌───────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌────────────┐
│  SentryController │ │ContentViewController│LiveViewController│etc.│
│ (orchestrates     │ │(timeline +player)│ (stream display) │    │
│  detector,action, │ │                 │                  │    │
│  recording loops) │ │                 │                  │    │
│                   │ │                 │                  │    │
│ Plain TS class,   │ │ Plain TS class  │ Plain TS class   │    │
│ @state/callback   │ │ @state/callback │ @state/callback  │    │
└─────────┬─────────┘ └────────┬────────┘ └────────┬────────┘ └────────┘
          │                    │                   │
          └────────┬───────────┴───────────────────┘
                   │
        ┌──────────▼────────────────┐
        │   Store Layer             │
        │ (identity, pipeline,      │
        │  nostr-online, settings)  │
        │                           │
        │ Writable by controllers  │
        │ via APIs (not direct set)│
        └──────────┬───────────────┘
                   │
        ┌──────────▼────────────────┐
        │  Data Layer               │
        │ (IDB segments.ts,         │
        │  WebRTC viewer-peer,      │
        │  Nostr client pub/sub)    │
        └───────────────────────────┘
```

### Controllers at a Glance

| Controller | Responsibility | Writable State |
|-----------|-----------------|-----------------|
| **SentrySection** (✅ extraction complete) | Arm/disarm UI; delegates to `DetectorController`, `ActionController`, `RecordingController`, `TriggerPublisher` | `sensorStates` (from DetectorController), `actionStates` (from ActionController) |
| **ContentViewerSection** | Timeline + Player state machine, fetch orchestration, coverage maps | `playerPosition`, `playerSegs`, `viewCenter`, `viewSpan`, `fetchedSegs` |
| **LiveViewSection** | WebRTC live stream setup, video/audio element binding | `remoteStream`, `streamState` |
| **SettingsSection** | Pipeline CRUD (sources, sensors, actions, links), persistence | `sources`, `sensors`, `actions`, `links`, `channels` (via `updatePipeline`) |
| **DevicesSection** | Paired device list, selection, presence status | `peerStatuses` (read-only), UI selection state |
| **SegmentStorageSection** | Storage quota display, eviction triggers, thinning stats | Reads only, triggers eviction via buttons |
| **AlertsSection** | Notification display, clip/footage UI | Reads `activeAlerts` (passed as prop) |
| **TimelineSection + TimelineScrubber** | Timeline UI surface, coverage rendering | `viewCenter`, `viewSpan`, `mode` (via `$bindable`) |

---

## Implementation Status

### SentrySection Controllers ✅
All four controllers have been extracted and integrated (as of 2026-05-25):

- **DetectorController** — `src/lib/controllers/detector.ts` — manages detector instances, reports `sensorStates` via callback
- **ActionController** — `src/lib/controllers/action.ts` — evaluates links, manages `actionStates`, fires `onActivate`/`onDeactivate` callbacks
- **RecordingController** — `src/lib/controllers/recording.ts` — manages MediaRecorder sessions, calls `onActiveSources` to update RTC compositor, saves segments
- **TriggerPublisher** — `src/lib/controllers/trigger-publisher.ts` — publishes kind 5010 events with cooldown, gates on `nostrOnline` store

See `CLAUDE.md` "Recent Changes (Phase 3-4 Complete)" section for integration summary and `docs/plans/sentry-controller.md` for full architectural details.

---

## State Ownership Template

Every controller must define these sections. Use this as a checklist:

### 1. **State Variables** — What the controller owns

```typescript
// List every @state variable.
// Format: variableName: type — purpose/invariant
```

**Example (ContentViewerSection):**
```typescript
playerPosition: number;         // unix seconds, range [playerRangeFrom, playerRangeTo]
playerSegs: PlayerSeg[];        // segments loaded for playback
playerPlaying: boolean;         // true if 100ms tick is running
viewCenter: number;             // timeline center, unix seconds; independent from playerPosition
fetchedSegs: FetchedSeg[];      // RTC-fetched or IDB-loaded segments awaiting player
_ctrlFetching: boolean;         // gate: true during all async fetch operations
```

### 2. **Authoritative Writer** — Who writes what

```typescript
// Enforce: one writer per variable. Cross-references to writer functions.
```

**Example:**
```typescript
playerPosition     ← playerSeekTo() and _playerTick() only
playerSegs        ← playerAddSegs() and playerSetRange() only
viewCenter        ← Timeline $bindable writes (user input)
fetchedSegs       ← pushSeg() only
_ctrlFetching     ← set true synchronously before await, false in finally
```

### 3. **Readers** — Who reads what

```typescript
// Function names that read each variable. Mark as "polled" (checked every tick) or "event-driven".
```

**Example:**
```typescript
playerPosition  ← _playerTick (polled), _ctrlCheckEndOfPlay (polled), coverage nav (event-driven)
fetchedSegs     ← _playerIdx derived, coverage maps derived, table display (polled)
viewCenter      ← scrub preview (polled), coverage nav (polled)
```

### 4. **Initialization** — How state is born

```typescript
// Where does each variable start? IDB load? Constructor param? Derived from props?
// Include default values and any async setup.
```

### 5. **Derived Values** — What is computed, not stored

```typescript
// Using Svelte's $derived for immutable views (never write these directly).
```

**Example:**
```typescript
$derived _playerIdx = _computePlayerIndex(playerSegs);
$derived _fetchedCovByType = _deriveTypeCoverage(fetchedSegs);
$derived _idbVideoCov = _idbCov.get('video/') ?? [];
```

### 6. **Invariants** — Must-be-true rules

```typescript
// Logic constraints that enable correctness. Violations are bugs.
```

**Example:**
```typescript
playerSegs.every(s => s.startTime >= playerRangeFrom && s.endTime <= playerRangeTo)
playerSegs.length === 0 || playerSegs[i].endTime <= playerSegs[i+1].startTime (sorted)
fetchedSegs = never cleared; only grown via pushSeg()
viewCenter is never assigned in response to playerPosition change
```

---

## Dumb Component Contracts

Each component is a view layer. It receives state via props, renders it, and fires callbacks when the user acts. It owns no state except private UI state (collapsed sections, hover flags, etc.).

### TimelineSection + TimelineScrubber

**What it owns:** Nothing. All display data is read-only props.

**Props** (all read-only except `$bindable`)
- `viewCenter: number $bindable` — timeline center (user edits via nav, scrubber drag)
- `viewSpan: number $bindable` — seconds wide (user zoom)
- `mode: 'live' | 'view' $bindable` — user clicks Live/View button
- `activeChannels: string[] $bindable` — user clicks channel chips
- `activeTypes: ('video/' | 'audio/' | 'image/')[] $bindable` — user clicks type chips
- `coverageByChannel: Record<string, [number, number][]>` — merged coverage map (IDB+RTC+fetched+loaded)
- `liveTime: number` — current wall clock (for live timeline indicator)
- `isLiveConnected: boolean`, `isOnline: boolean` — status flags

**Events fired** (user gestures only — never on prop changes)
- `onSeekChange(timestamp: number)` — pointer moves during scrub
- `onScrubStart()` — pointer down
- `onScrubEnd()` — pointer up
- `onChannelToggle(active: string[])` — channel chip click
- `onTypeToggle(active: ('video/'|'audio/'|'image/')[])` — type chip click
- `onFetchAllRtc()`, `onSaveRtcToIdb()` — action buttons

**$bindable clarification:**
`viewCenter`, `viewSpan`, `mode`, and channel/type filters are bindable because the Timeline is the user's _input device_ for these values. The timeline's zoom control doesn't ask the controller "can I zoom?"; it just sets `viewSpan` and the controller reacts. This is correct. The controller does NOT validate or intercept these writes — it trusts the timeline's constraints.

**Forbidden**
- Reading `playerPosition`, `playerSegs`, `playerPlaying`
- Triggering fetch or IDB queries
- Deriving computed state from props (that belongs in the controller)
- Firing callbacks when coverage data changes (only on explicit user interaction)

---

### Player (inline in ContentViewerSection controller)

The player is not a separate Svelte component but a logical subsystem within the controller.

**State it owns**
- `playerPosition: number` — current playback time
- `playerSegs: PlayerSeg[]` — loaded segments
- `playerRangeFrom/To: number` — valid playback window
- `playerPlaying: boolean` — true if tick running
- `playerVideoEl`, `playerAudioEl` — bound media element refs

**Interface functions** (the ONLY way to affect player state from outside)

| Function | Effect |
|----------|--------|
| `playerSeekTo(pos)` | Clamp, set `playerPosition`, sync media element `currentTime` |
| `playerPlay()` | Start 100ms tick, set `playerPlaying = true` |
| `playerPause()` | Stop tick, pause media |
| `playerStop()` | Pause + reset position |
| `playerSetRange(from, to)` | Evict segments outside range, set new range |
| `playerExpandRange(from, to)` | Extend range only (never evict); only call when content for the range exists |
| `playerAddSegs(segs)` | Add segments to loaded set, resort |

**Events** (polled by the 200ms controller tick)
- `playerPlaying` state change (just-stopped detection)
- `playerPosition >= playerRangeTo` (end-of-range)

**Forbidden**
- Direct assignment `playerPosition = x` outside `playerSeekTo` / `_playerTick`
- `playerExpandRange` before segments for that range exist
- Any read of `viewCenter`, `mode`, timeline state

---

### LiveViewSection

**What it owns**
- `remoteStream: MediaStream | null` — bound to video/audio elements
- `streamState: 'idle' | 'connecting' | 'live'` — connection status

**Props** (all read-only)
- `isLiveConnected: boolean` — WebRTC session active
- `selectedMonitorPubkey: string | null` — which monitor to view

**Events fired**
- `onConnect()` / `onDisconnect()` — user clicks connect/disconnect
- `onUpgrade()` — user clicks "Watch Live" (upgrade from data to live stream)

**Forbidden**
- Reading `playerSegs`, `fetchedSegs`, timeline state
- Triggering segment fetches
- Managing WebRTC sessions (that's `viewer-peer.ts`; this component just binds elements)

---

### SettingsSection

**What it owns**
- Nothing. All pipeline config is read-only props (sources, sensors, actions, links).
- Local UI state only: collapsed sections, selected item IDs, unsaved edits.

**Props** (read-only; passed by controller)
- `sources: SourceConfig[]` — all source definitions
- `sensors: SensorConfig[]` — all sensor definitions
- `actions: ActionConfig[]` — all actions
- `links: Link[]` — all links
- `sensorStates: Record<sensorId, SensorState>` — live sensor readings (read-only)
- `actionStates: Record<actionId, ActionState>` — live action states (read-only)

**Events fired**
- `onSourceCreate(config) / onSourceUpdate(id, config) / onSourceDelete(id)`
- `onSensorCreate(config) / onSensorUpdate(id, config) / onSensorDelete(id)`
- `onActionCreate(config) / onActionUpdate(id, config) / onActionDelete(id)`
- `onLinkCreate(config) / onLinkUpdate(id, config) / onLinkDelete(id)`
- `onChannelCreate(config) / onChannelUpdate(id, config) / onChannelDelete(id)`

**Constraint:** The UI never imports store setters directly. It fires events; the parent (SentrySection or DevSection) listens and calls the actual persistence API.

**Forbidden**
- Direct `sources.update(...)`, `actions.update(...)` calls
- Triggering sensor state changes
- Triggering recordings or actions
- Reading `monitorState`, `sensorStates` and then modifying actions based on them

---

### DevicesSection

**What it owns**
- `selectedDevicePubkey: string | null` — which device is selected (local UI state)
- Hover, expand, collapse states — all private

**Props** (read-only)
- `pairedDevices: PairedDevice[]` — list of paired monitors
- `peerStatuses: Record<pubkey, PeerStatus>` — online/offline/last-seen for each device
- `fetchedCountByMonitor: Record<pubkey, number>` — number of fetched segments per device

**Events fired**
- `onSelectDevice(pubkey: string | null)` — user clicks device row or clears selection
- `onStatusCheck(pubkey)` — user clicks "Status?" button
- `onUnpair(pubkey)` — user clicks unpair button

**Forbidden**
- Writing `peerStatuses` directly (it's read-only)
- Triggering unpair logic (fire event; parent handles it)
- Triggering segment fetches

---

### AlertsSection

**What it owns:** Nothing. Display-only.

**Props** (read-only)
- `activeAlerts: AlertSession[]` — list of active footage sessions

**Events fired**
- `onDismiss(actionId: string)` — user clicks dismiss button
- `onView(footageRefId: string)` — user clicks view button

**Forbidden**
- Triggering action deactivation
- Modifying footage refs

---

### SegmentStorageSection

**What it owns:** Nothing. Display-only.

**Props** (read-only)
- `quotaMb: number` — storage quota
- `usedMb: number` — current usage
- `segmentCount: number` — total segments in storage
- `thinningRules: ThinningRule[]` — configured rules

**Events fired**
- `onEvictUnpinned()` — user clicks manual eviction button
- `onClearAll()` — user clicks clear storage button
- `onUpdateQuota(newMb: number)` — user edits quota

**Forbidden**
- Triggering eviction directly (fire event; parent handles it)
- Modifying IDB directly

---

### IdentitySection, RelaySection, PairingSection

These are all display-only UI around stores. They read `$identity`, `$settings`, `$pairedDevices` directly and fire events to trigger actions (generate keypair, add relay, initiate pairing).

---

## Controller Interaction Patterns

Controllers live in separate namespaces and cannot directly call each other. They communicate via:

### 1. Shared Stores (Durable Cross-Controller State)

Stores are the **agreed-upon interface** between controllers. When one controller writes a store, all others see the change reactively.

```typescript
// pipeline.ts — shared config (both SentrySection and SettingsSection read this)
export const sources = writable<SourceConfig[]>([]);
export const sensors = writable<SensorConfig[]>([]);
export const actions = writable<ActionConfig[]>([]);

// Sentry reads + observes; Settings writes
sources.subscribe(s => { /* replan recorder slots */ });
sources.update(list => [...list, newSource]);
```

**Rules**
- Stores are the authority; never cache store values in controller state
- One controller is the "writer" for each store; others are readers
- Writers expose update functions in the store module (e.g., `updatePipeline()`) — they don't export setters
- Readers `subscribe()` reactively; they never call setters

**Pattern:**
```typescript
// Good: store module owns the logic
export function updateSource(id: string, patch: Partial<SourceConfig>) {
  sources.update(list => {
    const idx = list.findIndex(s => s.id === id);
    return idx >= 0 ? [...list.slice(0, idx), { ...list[idx], ...patch }, ...list.slice(idx + 1)] : list;
  });
}

// Bad: controller logic in component
function onSourceUpdate(id, patch) {
  sources.update(list => ...);  // ← logic scattered across UI
}
```

### 2. Callbacks (One-Way Event Flow)

Parent → Child: Parent fires callbacks; child listens and reacts.

```typescript
// Parent (DevSection) instantiates child, passes callbacks
<SentrySection
  onArm={() => sentry.arm()}
  onDisarm={() => sentry.disarm()}
  onSensorStateChange={(id, state) => sentry.handleSensorStateChange(id, state)}
/>

// Child (SentrySection) receives callbacks, stores them
export interface Props {
  onArm: () => void;
  onDisarm: () => void;
}
let { onArm, onDisarm }: Props = $props();
```

This is **one-way** — child never calls parent directly. Child fires events; parent decides if/how to react.

### 3. Props (Read-Only Downward Flow)

Parent → Child: All config and data flow downward via props.

```typescript
<SettingsSection
  sources={$sources}
  sensors={$sensors}
  sensorStates={sensorStates}
  onSourceCreate={...}
/>
```

Child reads props; parent provides them. If child needs to update, it fires an event; parent handles it.

### 4. The Async Handshake Pattern (Controller → Store → Component)

When a controller does async work and needs to surface the result:

```typescript
// 1. Controller does work asynchronously
async function fetchSegments() {
  _ctrlFetching = true;
  try {
    const segs = await requestSegmentsInRange(from, to);
    // Update store immediately
    fetchedSegs.set(segs);
  } finally {
    _ctrlFetching = false;
  }
}

// 2. Parent component subscribes and rerenders reactively
$effect(() => {
  const segs = $fetchedSegs;  // Reactive, updates when store changes
  // Component display updates automatically
});
```

**Never use callbacks for async results.** Use stores (reactive) or Promises (await in controller).

---

## Async/Await Contracts

### Controllers Must Be Synchronous at Entry Points

Every controller method that a component calls must be **synchronous or return a Promise**. A component can call a controller function and either:

1. Get a result immediately (sync)
2. Get a Promise it can `await` in an `$effect`
3. Not wait (fire-and-forget, e.g., `onArm()` may queue Nostr work)

```typescript
// Good: sync entry points
class SentryController {
  arm(): void { /* sync logic */ }
  evaluateLinks(states): void { /* sync */ }

  // Async work is internal, not triggered by props
  private async _recordSegment() { /* ... */ }
}

// Good: async method that returns a Promise
class ContentViewController {
  async loadLocalCoverage(): Promise<void> { /* ... */ }
}

// Bad: async method that the component doesn't await
class BadController {
  async fetchAndUpdate() { /* if component calls this without await, results are lost */ }
}
```

### The Synchronous Barrier Rule

**Principle:** Every `await` in a controller method must be guarded by a "pre-await" flag that's set synchronously.

```typescript
// Good: _ctrlFetching is set BEFORE the await
async function _ctrlFetchScrubPreview() {
  _scrubFetching = true;           // ← synchronous, before await
  try {
    const segs = await getSegmentsBefore(...);  // ← now we can await
    pushSeg(...segs);
  } finally {
    _scrubFetching = false;         // ← always cleared
  }
}

// Bad: no pre-await guard
async function _ctrlBadFetch() {
  // If component checks _ctrlFetching before this code, it's false
  // Race condition: component thinks fetch is done before it starts
  const segs = await requestSegments(...);
  // Now _ctrlFetching = true, but it's too late
}
```

**Use cases for the flag:**
- Gate UI loading spinners: `{#if _ctrlFetching} ⏳ {/if}`
- Prevent double-fetches: `if (_ctrlFetching) return;`
- Throttle updates: avoid state thrashing during async work

### Multiple Concurrent Async Operations

When multiple async operations can run in parallel (e.g., scrub preview while main fetch is in flight):

```typescript
// Use separate flags for each async operation
let _ctrlFetching = false;      // main buffer fetch
let _scrubFetching = false;     // scrub preview fetch
let _coverageFetching = false;  // coverage map fetch

// Each has its own guard
async function _ctrlFetchBuffer() {
  if (_ctrlFetching) return;  // Prevent double-fetch
  _ctrlFetching = true;
  try { /* ... */ } finally { _ctrlFetching = false; }
}

async function _ctrlFetchScrubPreview() {
  if (_scrubFetching) return;  // Independent gate
  _scrubFetching = true;
  try { /* ... */ } finally { _scrubFetching = false; }
}
```

### Race Condition Prevention

**Pattern:** Use a generation counter for abort semantics.

```typescript
let _fetchGeneration = 0;

async function _ctrlFetchBuffer() {
  const gen = ++_fetchGeneration;  // Snapshot the generation
  _ctrlFetching = true;
  try {
    const segs = await requestSegmentsInRange(...);
    if (_fetchGeneration !== gen) return;  // Obsolete, discard
    playerAddSegs(segs);  // Only if still current
  } finally {
    if (_fetchGeneration === gen) _ctrlFetching = false;
  }
}
```

When the user scrubs to a new position and triggers a new fetch, `_fetchGeneration` increments. The old fetch's callback checks and discards if obsolete.

### Synchronous Block Rule

At critical state sync points, multiple operations must run without `await` between them:

```typescript
// Scrub end sync point — both clocks must start at the same position
async function _ctrlAfterScrub(cursor) {
  const [bStart, bEnd] = [cursor - BUFFER_BACK_S, cursor + BUFFER_FWD_S];
  const segs = await getSegmentsInRange(bStart, bEnd);
  playerSetRange(bStart, bEnd);
  playerAddSegs(segs);

  // ← No await above this line. These must be synchronous:
  playerSeekTo(cursor);          // Player clock starts
  _tlSeekTo(cursor);             // Timeline clock starts
  playerPlay();                  // Both start ticking
  _tlPlay();                     // at the same instant
}
```

---

## Error Handling Patterns

### Rule 1: Controllers Don't Throw; They Catch and Surface

Controllers catch errors and surface them via state or callbacks. They never propagate exceptions to components.

```typescript
// Good: catch and surface
async function _ctrlFetchBuffer() {
  try {
    const segs = await requestSegmentsInRange(...);
    playerAddSegs(segs);
  } catch (err) {
    _ctrlError = `Failed to fetch: ${err.message}`;  // Component reads this
    dbg('error', 'fetch', err);
  }
}

// Bad: let exception escape
async function _ctrlBadFetch() {
  const segs = await requestSegmentsInRange(...);  // If this throws, component gets unhandled exception
  playerAddSegs(segs);
}
```

### Rule 2: Error State Variables

Each controller with async operations should own an error variable:

```typescript
let _ctrlError: string | null = null;

function clearError() { _ctrlError = null; }
```

Components read `_ctrlError` and display it; when the user acts, clear it.

### Rule 3: Nested Try/Finally (Cleanup)

Always clean up in `finally`, not in the catch:

```typescript
async function _ctrlFetchSegment(id: string) {
  _ctrlFetching = true;
  _ctrlError = null;
  try {
    const seg = await getSegmentById(id);
    playerAddSegs([seg]);
  } catch (err) {
    _ctrlError = `Segment ${id} not found`;
  } finally {
    _ctrlFetching = false;  // Always clears, even on error
  }
}
```

### Rule 4: Component-Level Error Boundaries

A parent component should wrap child component invocation in a try/catch if the child might error:

```typescript
// Not commonly needed in Senstry (controllers handle their errors)
// But if a controller's sync entry point can throw:

try {
  sentry.evaluateLinks(sensorStates);
} catch (err) {
  dbg('error', 'eval-links', err);
  // Optionally update UI state
}
```

### Rule 5: Network Errors (Nostr, RTC, IDB)

Data layer errors (IDB, RTC, Nostr) are caught by the controller and surface as timeouts or "not available" messages, not raw errors.

```typescript
// Don't surface: "QUOTA_EXCEEDED_ERR: QuotaExceededError"
// Do surface: "Storage full. Evicting old segments..."

try {
  await saveSegment(...);
} catch (err) {
  if (err.code === 'QuotaExceededError') {
    // Trigger eviction policy
    await evictUnpinned();
    _ctrlError = null;  // Resolved by eviction
  } else {
    _ctrlError = `Failed to save segment: ${err.message}`;
  }
}
```

---

## Store Access Rules

### Writable Stores (Who Can Write What)

| Store | Primary Writer | Readers | Rules |
|-------|-----------------|---------|-------|
| `sources`, `sensors`, `actions`, `links`, `channels` | `SettingsSection` (via `updatePipeline` API) | `SentrySection`, player, timeline | Don't directly `.set()` or `.update()`; use the store's public API functions |
| `sensorStates`, `actionStates` | `SentrySection` controller (via internal state updates) | UI (read-only, via props) | Never written by SettingsSection or anywhere else |
| `monitorState` | `SentrySection` (via `transitionMonitor()`) | UI, SentrySection logic | Must use the state machine function, not direct `.set()` |
| `identity` | `IdentitySection` | All sections (read-only) | Loaded once on startup; immutable after that |
| `pairedDevices` | `IdentitySection` | All sections (read-only) | Loaded from IDB; updated by pairing logic |
| `settings` | `SettingsSection` (UI) or Relay/Nostr sections | All sections (read-only) | Updated via store API, not direct `.set()` |
| `nostrOnline` | `SentrySection` and `nostr-online.ts` gates | All Nostr code | Gates all Nostr publishes; see `store/nostr-online.ts` |
| `remoteStream` | `viewer-peer.ts` | `LiveViewSection` | Data layer (WebRTC) updates this; component just binds it |
| `streamState` | `viewer-peer.ts` | UI | Read-only in components |
| `peerStatuses` | `signal-router.ts` (presence updates) | UI (read-only) | Updated by incoming Nostr presence messages |
| `fetchedSegs`, `playerSegs` | `ContentViewerSection` controller | UI (read-only), derived coverage maps | Controller updates these; component never writes |

### Forbidden Store Reads/Writes

```typescript
// Forbidden: component directly writing a controller's state store
<SettingsSection
  on:sourceCreate={(e) => {
    sources.update(list => [...list, e.detail]);  // ← Bad! Call the API instead.
  }}
/>

// Good: use the store API
import { updatePipeline } from '$lib/store/pipeline';
onSourceCreate={(config) => {
  updatePipeline({ sources: [...$sources, config] });
}}

// Forbidden: controller reading UI state from a component
function sentry_evaluateLinks() {
  const active = settingsSection.selectedSourceId;  // ← Bad! No cross-component reads.
}

// Good: pass values via props or callbacks
<SentrySection sensorStates={sensorStates} />  // ← Sentry reads props, not component state
```

### Store Module Patterns

Each writable store should expose a module API:

```typescript
// store/pipeline.ts
export const sources = writable<SourceConfig[]>([]);
export const sensors = writable<SensorConfig[]>([]);

export function updatePipeline(patch: Partial<Pipeline>) {
  // Validation, persistence, side effects
  sources.update(list => applySourcePatch(list, patch.sources));
  sensors.update(list => applySensorPatch(list, patch.sensors));
  // etc.
}

// ✓ Components import the API, not the store
import { updatePipeline } from '$lib/store/pipeline';
updatePipeline({ sources: [...] });

// ✗ Components never import setters
import { sources } from '$lib/store/pipeline';
sources.update(...);  // ← Should go through updatePipeline
```

---

## Testing Contracts

Controllers are pure TypeScript classes with no Svelte dependency. Test them with `vitest` + mock callbacks.

### 1. Structure Your Controller for Testability

```typescript
// Good: pass dependencies as constructor params, use plain callbacks
export class ContentViewController {
  constructor(
    private idb: IDBStorage,
    private rtc: RTCFetcher,
    onStateChange: (state: string) => void,
  ) {}

  async loadLocalCoverage(): Promise<void> { /* ... */ }
}

// Bad: import stores directly; can't mock
import { playerSegs } from '$lib/store/player-segs';
export class BadController {
  async load() {
    playerSegs.set(...);  // Can't mock this
  }
}
```

### 2. Mock Data Layer

```typescript
const mockIDB = {
  getSegmentById: vitest.fn(async (id) => mockSegment),
  getSegmentsInRange: vitest.fn(async (from, to) => [mockSegment]),
  saveSegment: vitest.fn(async () => {}),
};

const ctrl = new ContentViewController(mockIDB, mockRTC, stateCallback);
```

### 3. Assertion Patterns

```typescript
// Test state ownership: only the controller writes
expect(ctrl.playerPosition).toBe(123);
expect(stateCallback).toHaveBeenCalledWith('position', 123);

// Test async operations with flags
expect(ctrl._ctrlFetching).toBe(false);
const promise = ctrl.loadLocalCoverage();
expect(ctrl._ctrlFetching).toBe(true);
await promise;
expect(ctrl._ctrlFetching).toBe(false);

// Test invariants
const segments = ctrl.playerSegs;
for (let i = 0; i < segments.length - 1; i++) {
  expect(segments[i].endTime).toBeLessThanOrEqual(segments[i + 1].startTime);
}

// Test error handling
expect(ctrl._ctrlError).toBeNull();
mockIDB.getSegmentById.mockRejectedValueOnce(new Error('not found'));
await ctrl.loadSegment('missing-id');
expect(ctrl._ctrlError).toContain('not found');
expect(ctrl._ctrlFetching).toBe(false);  // Flag cleared despite error
```

### 4. Unit Test File Structure

```typescript
// src/lib/controller/content-viewer.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentViewController } from './content-viewer';

describe('ContentViewController', () => {
  let ctrl: ContentViewController;
  let stateChanges: Array<[key: string, value: any]> = [];

  beforeEach(() => {
    stateChanges = [];
    ctrl = new ContentViewController(
      mockIDB,
      mockRTC,
      (key, val) => stateChanges.push([key, val]),
    );
  });

  describe('playerSeekTo', () => {
    it('sets playerPosition within range', () => {
      ctrl.playerSetRange(0, 100);
      ctrl.playerSeekTo(50);
      expect(ctrl.playerPosition).toBe(50);
    });

    it('clamps out-of-range seeks', () => {
      ctrl.playerSetRange(0, 100);
      ctrl.playerSeekTo(200);
      expect(ctrl.playerPosition).toBe(100);
    });
  });

  describe('loadLocalCoverage', () => {
    it('sets _ctrlFetching before await', async () => {
      const promise = ctrl.loadLocalCoverage();
      expect(ctrl._ctrlFetching).toBe(true);
      await promise;
      expect(ctrl._ctrlFetching).toBe(false);
    });

    it('handles IDB errors gracefully', async () => {
      mockIDB.getCoverageByChannelSplit.mockRejectedValueOnce(new Error('quota exceeded'));
      await ctrl.loadLocalCoverage();
      expect(ctrl._ctrlError).toContain('quota exceeded');
    });
  });
});
```

### 5. Integration Tests (Component + Controller)

Use `happy-dom` or `jsdom` with your controller mounted in a test component:

```typescript
// src/lib/components/dev/ContentViewerSection.test.ts

import { render, screen } from '@testing-library/svelte';
import ContentViewerSection from './ContentViewerSection.svelte';

describe('ContentViewerSection integration', () => {
  it('fetches on scrub end and syncs both clocks', async () => {
    const { container } = render(ContentViewerSection);
    const timeline = container.querySelector('canvas');

    // Simulate scrub end
    timeline.dispatchEvent(new PointerEvent('pointerup', { clientX: 100 }));

    // Wait for fetch
    await vi.waitFor(() => {
      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });

    // Fetch completes
    await vi.waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });

    // Both clocks are in sync
    expect(playerPosition).toBe(viewCenter);
  });
});
```

---

## Forbidden Patterns

These are architectural violations. Violating any of these creates bugs or unmaintainability.

### 1. **Component Writing State It Doesn't Own**

```typescript
// Bad: component modifies controller state
function handleClick() {
  playerPosition = 50;  // ← Only playerSeekTo() can do this
}

// Good
function handleClick() {
  playerSeekTo(50);  // ← Go through the API
}
```

### 2. **Component Reading Sibling State**

```typescript
// Bad: Timeline reads Player state
let cursor = $derived(playerPosition);  // ← Forbidden
let coverage = $derived.by(() => {
  if (playerPosition > 100) ...  // ← Reading across the wall
});

// Good: Controller provides derived values via props
<TimelineSection {computedCoverage} />
```

### 3. **Controller Calling Component Methods**

```typescript
// Bad: controller reaches into component
function sentry_evaluateLinks() {
  settingsSection.refresh();  // ← Components don't have methods
}

// Good: controller updates store, component reacts
actionStates.update(map => ...);  // Component has effect that watches actionStates
```

### 4. **Async Operations Without Pre-Await Flags**

```typescript
// Bad: no guard flag
async function _ctrlFetchSegment() {
  const seg = await requestSegmentById(id);  // Component sees false before this starts
  playerAddSegs([seg]);
}

// Good: set flag synchronously
async function _ctrlFetchSegment() {
  _ctrlFetching = true;           // ← Synchronous barrier
  try {
    const seg = await requestSegmentById(id);
    playerAddSegs([seg]);
  } finally {
    _ctrlFetching = false;
  }
}
```

### 5. **Unguarded Double-Fetches**

```typescript
// Bad: no re-entrancy protection
function onScrubEnd(cursor) {
  _ctrlFetchBuffer(cursor);  // ← Twice in quick succession = two in-flight
  _ctrlFetchBuffer(cursor);
}

// Good: gate by flag
function onScrubEnd(cursor) {
  if (_ctrlFetching) return;  // ← Prevents double-fetch
  _ctrlFetchBuffer(cursor);
}
```

### 6. **Multiple Concurrent Async Operations Without Isolation**

```typescript
// Bad: shared flag for unrelated async ops
let _fetching = false;

async function _ctrlFetchBuffer() {
  _fetching = true;
  const segs = await requestSegmentsInRange(...);
  playerAddSegs(segs);
  _fetching = false;
}

async function _ctrlFetchCoverage() {
  // If buffer fetch is in flight, this is blocked even though coverage is independent
  _fetching = true;
  const cov = await requestCoverageMap(...);
  _coverageCov = cov;
  _fetching = false;
}

// Good: separate flags
async function _ctrlFetchBuffer() {
  _ctrlFetching = true;
  try { /* ... */ } finally { _ctrlFetching = false; }
}

async function _ctrlFetchCoverage() {
  _coverageFetching = true;
  try { /* ... */ } finally { _coverageFetching = false; }
}
```

### 7. **Race Conditions: Ignoring Generation Counters**

```typescript
// Bad: stale fetch results overwrite fresh ones
async function _ctrlFetchBuffer() {
  _ctrlFetching = true;
  const segs = await requestSegmentsInRange(from, to);
  _ctrlFetching = false;
  playerAddSegs(segs);  // ← If user scrubbed to new position, these are stale
}

// Good: check generation before applying result
let _fetchGen = 0;
async function _ctrlFetchBuffer() {
  const gen = ++_fetchGen;
  _ctrlFetching = true;
  try {
    const segs = await requestSegmentsInRange(from, to);
    if (_fetchGen !== gen) return;  // ← Discard if obsolete
    playerAddSegs(segs);
  } finally {
    if (_fetchGen === gen) _ctrlFetching = false;
  }
}
```

### 8. **Direct Store Setter Access**

```typescript
// Bad: bypass the store API
import { actions } from '$lib/store/pipeline';
actions.set([...]);  // ← Loses validation, persistence, side effects

// Good: use the store API
import { updatePipeline } from '$lib/store/pipeline';
updatePipeline({ actions: [...] });
```

### 9. **Mixing Timeline and Player Clocks**

```typescript
// Bad: derive player position from timeline
playerPosition = $derived(viewCenter);  // ← Forbidden; violates independence rule

// Good: sync at explicit sync points only
// Inside _ctrlAfterScrub:
playerSeekTo(cursor);  // Sync point
_tlSeekTo(cursor);     // Sync point
playerPlay();
_tlPlay();
// After this, they run independently
```

### 10. **Clearing Derived State Manually**

```typescript
// Bad: write to $derived vars
_fetchedCovByType = [];  // ← These are $derived; updates are automatic

// Good: update the source
pushSeg(...fetchedSegs);  // ← Coverage maps update automatically
```

### 11. **SentrySection Logic Scattered Across Methods**

```typescript
// Bad: detector/action/recording logic in multiple places
function sentry_armButtonClicked() {
  // ← Some logic here
  monitorState.set('recording');
}

function sentry_onSensorFire() {
  // ← Some logic here
  // ← Other action evaluation logic
}

// Good: centralize via controller methods (post-extraction)
// All detector, action, and recording logic lives in a single ActionController class
class ActionController {
  evaluateLinks(sensorStates): void { /* all link eval */ }
  _activateAction(action): void { /* all activation */ }
  _deactivateAction(action): void { /* all deactivation */ }
}
```

### 12. **Fetched Segments List Manipulation**

```typescript
// Bad: use array mutations
fetchedSegs.push(seg);      // ← Bypasses dedup key check
fetchedSegs[0] = newSeg;    // ← Direct mutation

// Good: go through the API
pushSeg(seg);  // ← Enforces dedup, handles originMonitor, etc.
```

### 13. **IDB Queries Without Channel Filter Validation**

```typescript
// Bad: pass user-editable channel filter without validation
const segs = await getSegmentsInRange(from, to, playerChannelFilter);
// If playerChannelFilter is corrupted or inconsistent with _ctrlActiveChannels, results are wrong

// Good: validate at the controller level
_ctrlApplyChannels();  // ← Must call first
const segs = await getSegmentsInRange(from, to, fetchChannelFilter);
```

### 14. **Calling playerExpandRange Before Content Exists**

```typescript
// Bad: create phantom range
playerExpandRange(from, to);  // ← No segments in this range yet
// End-of-play detection fires, sees range but no content, gets confused

// Good: only expand after fetching
const segs = await getSegmentsInRange(extFrom, extTo);
playerAddSegs(segs);           // ← Content must exist
playerExpandRange(...);        // ← Now safe to expand
```

### 15. **Resetting _ctrlActiveChannels on Coverage Refresh**

```typescript
// Bad: user toggles channel chips off, then loads coverage
onChannelToggle([]);  // ← User selected no channels
_ctrlActiveChannels = [];  // ← Correct, stored

// Later: coverage loading
loadLocalCoverage();  // ← This must NOT reset _ctrlActiveChannels
// But if it does:
_ctrlActiveChannels = [all channels];  // ← Wrong! Overwrites user's selection

// Good: never write _ctrlActiveChannels outside onChannelToggle and device switch
loadLocalCoverage() {
  // Load coverage, update _localCovByChannel, but DON'T touch _ctrlActiveChannels
}
```

### 16. **Nostr Events Sent When Offline**

```typescript
// Bad: no online check
async function _notifyAction() {
  const event = buildTriggerEvent(...);
  await publish(event);  // ← If nostrOnline is false, silently queued or fails
}

// Good: check gate before publishing
async function _notifyAction() {
  if (!get(nostrOnline)) return;  // ← Gate prevents send when offline
  const event = buildTriggerEvent(...);
  await publish(event);  // ← Only runs when online
}
```

---

## Quick Reference Checklist

When adding a new feature:

- [ ] Create a controller class in `src/lib/controller/*.ts` (or extend existing)
- [ ] Define state ownership template: variables, writers, readers, invariants
- [ ] Create a thin Svelte component in `src/lib/components/dev/*.svelte`
- [ ] Component receives state via props only; fires events for user actions
- [ ] Controller receives events via callbacks; updates state, triggers side effects
- [ ] All async operations have pre-await flags (`_flag = true; try { await ... } finally { _flag = false }`)
- [ ] All state updates go through controller methods, never direct assignment
- [ ] Store writes use the store API (module functions), never `.set()` or `.update()`
- [ ] Tests exist for the controller (vitest, no Svelte)
- [ ] Integration tests exist for the component (happy-dom)
- [ ] Read this doc again for forbidden patterns before merging
