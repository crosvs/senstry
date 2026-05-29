# State Ownership and Sync Protocol Guide

## Overview

This guide formalizes how to apply the "one authoritative writer per variable" principle across all controllers and components. It is the operational backbone of the refactor.

---

## Core Principle

**Every stateful variable has exactly one code path that may write to it.** If two code paths both assign to the same variable, one of them is wrong.

This prevents:
- Race conditions (two handlers updating state simultaneously)
- Silent overwrites (newer code doesn't know about older observer)
- Desynchronization (UI and data layer disagree on current state)
- Cache invalidation bugs (forgot to update derived state)

---

## Application: State Ownership Table

For every controller, create and maintain a table like this:

```
| Variable | Writer(s) | Readers | Notes |
|----------|-----------|---------|-------|
| property | fn1(), fn2() (list all) | consumer(s) | when/why it's read |
```

**Rules for filling it out:**

1. **Writers** — list every function that assigns to the variable, or every `$bindable` prop that receives user input
2. **Readers** — list every code path that reads the variable (can be many)
3. **Notes** — capture invariants, timing constraints, or conditions under which it's written

If you find a variable with two writers that are not in the same synchronous block, investigate. Usually one is wrong.

---

## Example: DetectorController

```
| Variable | Writer(s) | Readers | Notes |
|----------|-----------|---------|-------|
| sensorStates | _updateSensorState() | onStateChange callback; tests | called whenever sensor.onStateChange fires |
| detectors Map | start() on init, stop() on cleanup | sensorStates lookup; cleanup loop | added once per sensor, never mutated |
| activeDetectors | start(), stop() | lifecycle teardown | tracks running detectors so stop() can clean them all |
```

**Invariant:** `sensorStates` always reflects the latest value from each detector. If a detector fires `onStateChange` but `sensorStates` is not updated in the same synchronous block, the callback consumer sees stale state.

---

## Example: ActionController

```
| Variable | Writer(s) | Readers | Notes |
|----------|-----------|---------|-------|
| actionStates | _activateAction(), _deactivateAction() | onActivate/onDeactivate callbacks; tests | updated only when a link condition changes |
| postRollTimers Map | _deactivateAction() on schedule; _activateAction() on link re-trigger | clearInterval loop on cleanup | one timer per action; not cancelled across evaluations |
| _lastSensorStates | evaluateLinks() start | link condition evaluation | snapshot prevents false re-evaluations mid-tick |
```

**Invariant:** An action's `onActivate` callback fires once when its condition becomes true; `onDeactivate` fires once when it becomes false. Re-evaluating with the same sensor states must not re-fire.

---

## Example: ContentViewerSection (Reference)

This is the canonical multi-variable state ownership table from `docs/controller-architecture.md`. Study it before designing new controllers.

Key insight: **`playerPosition` and `viewCenter` are independent clocks that must be synchronized at specific sync points only.**

```
playerPosition  ← written by playerSeekTo() and _playerTick() ONLY
viewCenter      ← written by timeline $bindable and _tlSeekTo() ONLY
```

After a sync point (scrub end, end-of-play), both clocks are set to the same value in one synchronous block. Then they diverge until the next sync point. This is intentional — the player's internal timer and the timeline's UI updates can happen at different rates.

---

## Sync Protocol: When Multiple Variables Must Change Together

Sometimes several variables must change in strict synchronization to maintain invariants. Use this protocol:

### Pattern 1: Scrub End (User Stops Dragging)

```typescript
function onScrubEnd(cursorTime: number) {
  // 1. Set shared position synchronously
  playerSeekTo(cursorTime);
  _tlSeekTo(cursorTime);
  
  // 2. Start both clocks synchronously
  playerPlay();
  _tlPlay();
  
  // 3. Now async work (buffer fill, cover fetch, etc.)
  _ctrlAfterScrub();
}
```

**Why:** Both clocks must start from the same position at the same wall-clock moment. If `playerSeekTo` is awaited before `_tlSeekTo`, they start at different times and the timeline visually jumps.

### Pattern 2: End-of-Play Detection

```typescript
// In 200ms tick (synchronous gate):
if (playerPosition >= playerRangeTo && _tlPlaying) {
  // Both must stop together
  playerPause();
  _tlPause();
  
  // Then decide what to do next (async)
  _ctrlEndOfPlay();
}
```

### Pattern 3: Device Switch (Multi-View)

```typescript
function switchDevice(newMonitorPubkey: string) {
  // Pause both clocks
  playerPause();
  _tlPause();
  
  // Clear both windows synchronously
  playerSetRange(0, 0);
  playerSegs = [];
  _ctrlActiveChannels = new Set(); // reset selected channels
  
  // Load new device's data
  await _ctrlLoadDeviceData(newMonitorPubkey);
  
  // Sync and resume
  playerSeekTo(newTime);
  _tlSeekTo(newTime);
  playerPlay();
  _tlPlay();
}
```

---

## Forbidden Patterns

### 1. Deriving One Clock from the Other

**Wrong:**
```typescript
// In scrub tick:
playerPosition = viewCenter;  // NO — derives player position from timeline
```

**Right:**
```typescript
// In scrub tick:
// Don't touch playerPosition at all. Timeline fires onSeekChange callback.
// onSeekChange calls playerSeekTo (the only writer).
```

**Why:** Scrub tick happens continuously (every move event). If we derived player position from timeline, they would be coupled, and the player's internal tick would be fighting the UI. They must be independent after sync.

### 2. Writing State in Callbacks During Initialization

**Wrong:**
```typescript
const ctrl = new ActionController(links, actions, 
  (action) => { actionStates[action.id] = 'active'; },  // NO — callback mutates outside
  vi.fn()
);
```

**Right:**
```typescript
const ctrl = new ActionController(links, actions,
  (action) => { onActionActivated(action); },  // Callback is thin — real state update elsewhere
  vi.fn()
);
```

**Why:** Callbacks are event notifications, not state mutators. The controller owns the state (`actionStates`); the callback just signals to the consumer (SentrySection) that something changed.

### 3. Clearing Derived State on Data Changes

**Wrong:**
```typescript
function loadLocalCoverage() {
  _localCovByChannel = {...};
  _remoteCovByChannel = {};  // NO — clears unrelated state
}
```

**Right:**
```typescript
function loadLocalCoverage() {
  _localCovByChannel = {...};
  // Don't touch _remoteCovByChannel; it's managed by requestRemoteCoverage
}
```

**Why:** Two coverage sources should be written independently. `_remoteCovByChannel` is owned by the remote fetch path; local load must not clear it. They are merged for display.

### 4. Reading State from Sibling Components

**Wrong:**
```typescript
// In TimelineSection:
const playerPos = contentViewerController.playerPosition;  // NO — reading sibling state
```

**Right:**
```typescript
// Props from controller:
<TimelineSection playerPosition={playerPosition} ... />

// In TimelineSection:
let { playerPosition } = $props();  // Read from props, not siblings
```

**Why:** Sibling components create hidden dependencies. If player position changes, timeline doesn't know it should update. Props are the explicit contract.

---

## Checklist: Before Submitting a New Controller

- [ ] **State ownership table created** — every `$state` variable has one writer listed
- [ ] **No sibling reads** — controller doesn't import or read from other controllers
- [ ] **Callbacks are thin** — callbacks notify only; real state is owned by controller
- [ ] **Sync points identified** — if state groups must change together, document when they do
- [ ] **No store imports** (except `nostrOnline`) — controller is plain TS, no Svelte dependency
- [ ] **Initialization is synchronous** — constructor completes without `await`; start/stop methods may be async
- [ ] **Tests cover state transitions** — vitest tests verify state ownership invariants

---

## Anti-Pattern: Store Subscription Cascade

**Problem:**
```typescript
// In SentrySection.svelte
$effect(() => {
  const pipeCfg = get(pipeline);
  detectors.forEach(...);
  recordingStates.forEach(...);
  // 30+ lines of imperative updates
});
```

This pattern is:
- Hard to test (requires browser)
- Runs after every store change (re-initialization)
- Scattered logic (detectors, recording, links all mixed)

**Solution:**
```typescript
// In SentrySection.svelte
let ctrl: DetectorController | null = null;

function startMonitor() {
  const pipeCfg = get(pipeline);
  ctrl = new DetectorController(pipeCfg.sensors, streams, onStateChange);
  ctrl.start();
}

function onStateChange(sensorId, state) {
  // Thin callback — just propagate
  actionCtrl.evaluateLinks(ctrl.sensorStates);
}
```

This:
- Is testable in isolation
- Runs once on user action (arm button)
- Separates concerns (one controller per domain)

---

## Refactoring a Store-Based System into Controllers

**Step 1: Identify the state**
```typescript
// Old:
const sensorStates = derived(pipeline, () => { /* ... */ });
export const sensorStates;
```

**Step 2: Move to controller**
```typescript
// New:
class DetectorController {
  sensorStates: Record<string, SensorState> = {};
  start() { /* ... update sensorStates ... */ }
}
```

**Step 3: Expose via callback, not store subscription**
```typescript
// Old (consumer):
$effect(() => {
  const states = get(sensorStates);
  actionCtrl.evaluate(states);
});

// New (consumer):
detectorCtrl.onStateChange = (id, state) => {
  actionCtrl.evaluate(detectorCtrl.sensorStates);
};
```

**Step 4: Test without a browser**
```typescript
const ctrl = new DetectorController([...], new Map(), vi.fn());
ctrl.start();
expect(ctrl.sensorStates['sensor-a']).toBeDefined();
```

---

## Common Questions

**Q: Can I write state in a promise `.then()` handler?**

A: Only if that promise's resolution is part of a single logical operation. E.g., "save segment, then update count" is one operation. But "on relay publish success, maybe update state" is two separate events — use a callback, not `.then()`.

**Q: What if I have a Map that needs updates from two sources?**

A: Usually a sign of unclear ownership. Clarify: is the Map the authority, or is it a cache? If it's a cache, one source is the authority and updates the Map; the other queries it. If two sources both can update it, split the Map into two smaller ones, each with one writer.

**Q: Can I expose a setter function from a controller?**

A: Yes. E.g., `controller.setPlayerVolume(0.5)` is fine. The setter is the writer. But don't expose the state directly (`controller.playerVolume = 0.5`) — use methods so the controller can validate or trigger side effects.

**Q: Should controllers use `$state` or plain `#private` fields?**

A: Plain fields (or getters that compute lazily). Controllers are plain TS, not Svelte components. Expose read-only properties via getters or public fields.

---

## Next: Applying This to Your Controllers

For each controller you extract:

1. **Write the state ownership table** (see examples above)
2. **Mark all sync points** (where multiple variables change together)
3. **List forbidden patterns** specific to that controller's domain
4. **Write tests that verify invariants**, not just happy-path behavior

Post the table in the controller file's JSDoc or in a companion `.md`. This makes it clear to future maintainers which paths can write which state.
