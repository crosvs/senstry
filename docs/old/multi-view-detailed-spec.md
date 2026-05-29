# Multi-View Detailed Implementation Spec

> **Reference**: See `docs/plans/multi-view.md` for architectural overview. This document is the complete, state-machine-based implementation guide.

## Table of Contents

1. [Core Architecture](#core-architecture)
2. [Phase 1: Playback Speed Control](#phase-1-playback-speed-control)
3. [Phase 2: Jump Controls](#phase-2-jump-controls)
4. [Phase 3: Multi-Channel View](#phase-3-multi-channel-view)
5. [Phase 4: Multi-Device View](#phase-4-multi-device-view)
6. [Coverage Key Migration](#coverage-key-migration)
7. [Component Integration](#component-integration)
8. [Testing Strategy](#testing-strategy)
9. [UI Layout Patterns](#ui-layout-patterns)
10. [Future Extensions](#future-extensions)

---

## Core Architecture

### Current Single-View State (Baseline)

The current `ContentViewerSection` controller holds one active player:

```typescript
// Current state
let playerSegs: PlayerSeg[] = $state([]);
let playerPosition: number = $state(0);    // shared clock
let playerRangeFrom: number = $state(0);   // buffer window start
let playerRangeTo: number = $state(0);     // buffer window end
let playerPlaying: boolean = $state(false);
let playerChannelFilter: Set<string> = $state(new Set());
let playerVideoEl: HTMLVideoElement | undefined;
let playerAudioEl: HTMLAudioElement | undefined;
```

**Single-writer rules** (from `docs/controller-architecture.md`):
- `playerPosition` — written **only** by `playerSeekTo()` and `_playerTick()`
- `playerSegs` — written only by `playerAddSegs()`, `playerSetRange()`
- `playerRangeFrom/To` — written only by `playerSetRange()`, `playerExpandRange()`
- `playerPlaying` — written only by `playerPlay()`, `playerPause()`, `playerStop()`

### Multi-View Architecture: PlayerSlots

Replace the single player with an array of independent player slots, each scoped to one channel on one device:

```typescript
interface PlayerSlot {
  // Identity
  channelId: string;
  originMonitor: string;       // device pubkey; for Phase 3 (multi-channel), always same value
  
  // Segment data
  segs: PlayerSeg[];           // segments for this slot's channel
  
  // Buffer window (per-slot, independent)
  rangeFrom: number;
  rangeTo: number;
  
  // Playback state (optional — deferred to Phase 3.5)
  // playing?: boolean;         // per-slot play/pause; for now, all slots sync to global playerPlaying
}

let playerSlots: PlayerSlot[] = $state([]);
let playerPosition: number = $state(0);    // **shared** — synchronized across all slots
let playerPlaying: boolean = $state(false); // **shared** — all slots advance together
let playbackSpeed: number = $state(1.0);   // **global** — same speed for all
```

**Key invariant**: `playerPosition` is a **shared clock**. All slots advance together. This simplifies the UI (single scrubber, single timeline) and matches the primary use case (multiple cameras covering the same moment in time).

**Derived state** (computed from `playerSlots`):

```typescript
// Active channel IDs
const activeChannels = $derived(playerSlots.map(s => s.channelId));

// Active device pubkeys
const activeMonitors = $derived([...new Set(playerSlots.map(s => s.originMonitor))]);

// Per-slot segment index for O(1) lookup
const playerIdx = $derived.by(() => {
  const idx: Record<string, PlayerSeg[]> = {};
  for (const slot of playerSlots) {
    idx[`${slot.originMonitor}/${slot.channelId}`] = slot.segs;
  }
  return idx;
});

// Merged coverage from all slots
const playerCovByKey = $derived.by(() => {
  const cov: Record<string, [number, number][]> = {};
  for (const slot of playerSlots) {
    const key = `${slot.originMonitor}/${slot.channelId}`;
    const ranges: [number, number][] = [];
    for (const seg of slot.segs) {
      ranges.push([seg.startTime, seg.endTime]);
    }
    if (ranges.length > 0) cov[key] = ranges;
  }
  return cov;
});
```

### State Ownership — Multi-View Update

| Variable | Authoritative writer(s) | Readers |
|----------|------------------------|---------|
| `playerSlots` | Channel toggle callback; device selection callback; buffer refill logic | Player render loop; `activeChannels` / `activeMonitors` derived |
| `playerPosition` | `playerSeekTo()` and `_playerTick()` **only** (same as Phase 0) | All slots' playback; timeline scrubber |
| `playerPlaying` | `playerPlay()`, `playerPause()`, `playerStop()` **only** (same as Phase 0) | Tick gate; all slots |
| `playbackSpeed` | Speed control UI callback | `_playerTick()` delta calculation |
| `activeChannels` | `$derived` — never write | Chip display; coverage gates |
| `activeMonitors` | `$derived` — never write | Coverage aggregation |
| Each `slot.rangeFrom/To` | Buffer refill logic (per-slot) | Extension trigger; end-of-play detection |
| Each `slot.segs` | `playerAddSegs()` (per-slot); `playerSetRange()` (per-slot) | Player render loop for that slot |

---

## Phase 1: Playback Speed Control

**Scope**: Controller-only change. No new UI components, no data model changes, no multi-view yet.

**Goal**: Allow playback at 0.5x, 1x, 2x, 4x speed.

### State Changes

Add one `$state` variable:

```typescript
let playbackSpeed: number = $state(1.0);  // 0.5, 1.0, 1.5, 2.0, 4.0
```

Optionally expose as tunable in the "Timeline Controller" panel (like `BUFFER_FWD_S`).

### Speed Control UI

Add a button group or slider in the player control area:

```svelte
<div class="speed-control">
  <button onclick={() => playbackSpeed = 0.5} class:active={playbackSpeed === 0.5}>0.5x</button>
  <button onclick={() => playbackSpeed = 1.0} class:active={playbackSpeed === 1.0}>1x</button>
  <button onclick={() => playbackSpeed = 2.0} class:active={playbackSpeed === 2.0}>2x</button>
  <button onclick={() => playbackSpeed = 4.0} class:active={playbackSpeed === 4.0}>4x</button>
</div>
```

### Player Tick Modification

In `_playerTick()`, multiply the delta by `playbackSpeed`:

**Before:**
```typescript
function _playerTick() {
  const delta = 0.2;  // 200ms tick
  playerPosition = _playerSeekTo(playerPosition + delta);
  // ... rest of tick
}
```

**After:**
```typescript
function _playerTick() {
  const delta = 0.2 * playbackSpeed;  // multiply by speed factor
  playerPosition = _playerSeekTo(playerPosition + delta);
  // ... rest of tick
}
```

### Media Element Synchronization

Bind `playbackRate` on `<video>` and `<audio>` elements to stay in sync:

```svelte
<video bind:this={playerVideoEl} playbackRate={playbackSpeed} />
<audio bind:this={playerAudioEl} playbackRate={playbackSpeed} />
```

### Invariants

- No changes to `playerSeekTo()`, `playerPlay()`, `playerPause()`, `playerStop()`.
- No changes to buffer management, fetch logic, or end-of-play detection.
- Speed does not affect segment loading — the same buffer windows apply, just traversed faster.
- At 4x speed, a 20-second buffer is traversed in 5 seconds; extension logic still fires the same way.

### Phase 1 Test Checklist

- [ ] Speed buttons appear and toggle active state
- [ ] Play at 0.5x, observe `playerPosition` advances 0.1s per tick (vs 0.2s at 1x)
- [ ] Play at 2x, observe `playerPosition` advances 0.4s per tick
- [ ] Video `playbackRate` matches UI button (verify with dev tools)
- [ ] Seek/jump while at 2x, then resume — speed persists
- [ ] Scrubbing resets speed to 1x (optional: persist speed across scrub)
- [ ] Extension and end-of-play timing is unaffected (buffer still triggers at `REFILL_TRIGGER_S`)

---

## Phase 2: Jump Controls

**Scope**: Controller functions + button UI. No new state, no multi-view.

**Goal**: Add forward/backward jump buttons (±30s, configurable).

### State Changes

No new `$state` variables. Optionally expose jump distance as tunable:

```typescript
let JUMP_FWD_S = $state(30);
let JUMP_BACK_S = $state(30);
```

### Jump Functions

Add two controller functions:

```typescript
function jumpForward(jumpSec = JUMP_FWD_S) {
  playerSeekTo(playerPosition + jumpSec);
  _ctrlAfterScrub();  // refill buffer at new position
}

function jumpBackward(jumpSec = JUMP_BACK_S) {
  const newPos = Math.max(playerRangeFrom, playerPosition - jumpSec);
  playerSeekTo(newPos);
  _ctrlAfterScrub();  // refill buffer at new position
}
```

**Why `_ctrlAfterScrub()`**: Jump is logically equivalent to scrubbing to a new position, so it reuses the same buffer-refill logic. No additional state machine needed.

### UI Buttons

```svelte
<div class="jump-controls">
  <button onclick={() => jumpBackward()}>← 30s</button>
  <span>{fmtTs(playerPosition)}</span>
  <button onclick={() => jumpForward()}>30s →</button>
</div>
```

### Invariants

- `playerRangeFrom` acts as a lower bound; `jumpBackward()` never seeks before the buffer start.
- Jumping while playing does not pause — playback resumes at the new position.
- Jumping while scrubbing is disabled (or maps to the scrub-end behavior).

### Phase 2 Test Checklist

- [ ] Jump forward button visible and clickable
- [ ] Jump backward button visible and clickable
- [ ] Jump forward: `playerPosition` increases by 30s, segments load for new position
- [ ] Jump backward: `playerPosition` decreases by 30s, segments load for new position
- [ ] Jump backward near buffer start: clamped to `playerRangeFrom`, not before
- [ ] Jump while playing: playback resumes (no pause/resume flickering)
- [ ] Jump while scrubbing: deferred until scrub ends (implementation detail)
- [ ] Tunable `JUMP_FWD_S` and `JUMP_BACK_S` take effect immediately

---

## Phase 3: Multi-Channel View (Same Device)

**Scope**: Refactor player state to support multiple channels from the same device. Shared `playerPosition` clock.

**Goal**: Display 2–4 channels side by side, all playing in sync.

### State Refactor

**Replace:**
```typescript
let playerSegs: PlayerSeg[] = $state([]);
let playerRangeFrom: number = $state(0);
let playerRangeTo: number = $state(0);
```

**With:**
```typescript
interface PlayerSlot {
  channelId: string;
  originMonitor: string;     // always same as selectedMonitorPubkey in Phase 3
  segs: PlayerSeg[];
  rangeFrom: number;
  rangeTo: number;
}

let playerSlots: PlayerSlot[] = $state([]);
let playerPosition: number = $state(0);    // shared clock — unchanged
let playerPlaying: boolean = $state(false); // shared — unchanged
```

**Keep unchanged:**
- `playerPosition`, `playerPlaying`, `playerStartedAt`, `playerPosAtStart` — these remain global and shared.
- Timeline UI, scrubber, time display — they all use the single `playerPosition`.
- Channel chip row — now maps to slot creation/destruction.

### Slot Management

#### Creating/destroying slots on channel toggle

The existing `_ctrlOnChannelToggle(active)` callback is called when the user clicks channel chips:

**Before (Phase 0):**
```typescript
function _ctrlOnChannelToggle(active: string[]) {
  _ctrlActiveChannels = active;
  _ctrlApplyChannels();
  playerSegs = [];  // evict old segments
  playerChannelFilter = new Set(active.length === 0 ? [] : active);
  _ctrlAfterScrub();
}
```

**After (Phase 3):**
```typescript
function _ctrlOnChannelToggle(active: string[]) {
  _ctrlActiveChannels = active;
  _ctrlApplyChannels();
  
  // Rebuild playerSlots to match selected channels
  const pubkey = selectedMonitorPubkey || '';
  const newSlots = active.map(ch => ({
    channelId: ch,
    originMonitor: pubkey,
    segs: [],
    rangeFrom: playerRangeFrom,
    rangeTo: playerRangeTo,
  }));
  playerSlots = newSlots;
  
  // Refill buffer at current position for new slots
  _ctrlAfterScrub();
}
```

#### Buffer Management Per-Slot

Extract buffer refill logic into a per-slot function:

```typescript
async function _updateSlotBuffer(slot: PlayerSlot) {
  const bStart = playerPosition - BUFFER_BACK_S;
  const bEnd = playerPosition + BUFFER_FWD_S;
  
  // Fetch IDB and RTC for this slot's channel
  const segs = await getSegmentsInRange(bStart, bEnd, slot.originMonitor, slot.channelId);
  slot.segs = segs.map(m => /* build PlayerSeg */);
  slot.rangeFrom = bStart;
  slot.rangeTo = bEnd;
}
```

Modify `_ctrlAfterScrub()` to call this for each slot:

```typescript
async function _ctrlAfterScrub() {
  _ctrlFetching = true;
  try {
    for (const slot of playerSlots) {
      await _updateSlotBuffer(slot);
    }
    playerPosition = Math.round(viewCenter);
    playerPlay();
  } finally {
    _ctrlFetching = false;
  }
}
```

#### Extension Logic Per-Slot

Modify `_ctrlExtendBuffer()` (the proactive extension during playback):

**Before:**
```typescript
async function _ctrlExtendBuffer() {
  const segs = await getSegmentsInRange(playerRangeTo, playerRangeTo + BUFFER_FWD_S, ...);
  playerAddSegs(segs);
  if (segs.length > 0) {
    playerExpandRange(playerRangeFrom, playerRangeTo + BUFFER_FWD_S);
  }
}
```

**After:**
```typescript
async function _ctrlExtendBuffer() {
  let anyAdded = false;
  for (const slot of playerSlots) {
    const segs = await getSegmentsInRange(
      slot.rangeTo,
      slot.rangeTo + BUFFER_FWD_S,
      slot.originMonitor,
      slot.channelId
    );
    if (segs.length > 0) {
      slot.segs.push(...segs);
      slot.rangeTo += BUFFER_FWD_S;
      anyAdded = true;
    }
  }
  if (anyAdded) {
    // No playerExpandRange needed; slots manage their own ranges
    _ctrlDbg(`extend buffer: slots [${playerSlots.map(s => s.channelId).join(', ')}]`);
  }
}
```

#### End-of-Play Detection

Check whether **any** slot has reached its buffer end; if so, trigger jump-to-next:

```typescript
function _ctrlCheckEndOfPlay(): boolean {
  if (playerSlots.length === 0) return false;  // no slots → nothing to play
  
  // Any slot at its end?
  const anyAtEnd = playerSlots.some(s => playerPosition >= s.rangeTo);
  // Any stalled in last frame?
  const anyStalled = playerSlots.some(s => {
    const lastSeg = s.segs[s.segs.length - 1];
    return lastSeg && playerPosition >= lastSeg.endTime && playerPlaying;
  });
  
  return anyAtEnd || anyStalled;
}

// In 200ms tick:
if (_ctrlCheckEndOfPlay()) {
  _ctrlEndOfPlay();
}
```

### Player Render Loop — Grid Layout

Replace the current single `<video>` render with a grid:

**Before:**
```svelte
{#if playerSeg}
  <video bind:this={playerVideoEl} src={playerSeg.url} />
{/if}
```

**After:**
```svelte
<div class="player-grid" class:multi-channel={playerSlots.length > 1}>
  {#each playerSlots as slot (slot.channelId)}
    <div class="slot" data-channel={slot.channelId}>
      <h3>{slot.channelId}</h3>
      {@const seg = _findSegAtPos(slot, playerPosition)}
      {#if seg?.mimeType.startsWith('video/')}
        <video src={seg.url} />
      {:else if seg?.mimeType.startsWith('audio/')}
        <div class="audio-placeholder">
          <audio src={seg.url} />
          {seg.channelId}
        </div>
      {:else if seg?.mimeType.startsWith('image/')}
        <img src={seg.url} alt="snapshot" />
      {:else}
        <div class="no-content">No content</div>
      {/if}
    </div>
  {/each}
</div>

<script>
  function _findSegAtPos(slot: PlayerSlot, pos: number): PlayerSeg | undefined {
    return slot.segs.find(s => s.startTime <= pos && s.endTime > pos);
  }
</script>
```

**CSS (Tailwind v4):**
```css
.player-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
  
  &.multi-channel {
    @media (min-width: 768px) {
      grid-template-columns: repeat(2, 1fr);
    }
  }
}

.slot {
  border: 1px solid #ccc;
  border-radius: 0.5rem;
  overflow: hidden;
  background: #000;
  
  h3 { padding: 0.5rem; margin: 0; color: #fff; }
  video, img { width: 100%; aspect-ratio: 16/9; object-fit: contain; }
}
```

### Per-Slot Media Elements

In Phase 3, all slots can share the first video/audio element (since they play the same content by channel). Or, create one `<video>` per slot for full independence. For simplicity, use shared media with slot-based source switching:

```svelte
<video
  bind:this={playerVideoEl}
  playbackRate={playbackSpeed}
  src={_findSegAtPos(playerSlots[0], playerPosition)?.url}
/>
```

### Derived: Active Channels

```typescript
const activeChannels = $derived(playerSlots.map(s => s.channelId));
```

This is passed to `TimelineSection` so channel chips show "on" for active slots and "off" for inactive ones.

### Invariants (Phase 3)

- `playerPosition` is **always** shared and synchronized across all slots.
- Each slot is independent: different `segs`, different `rangeFrom/To`.
- Device is always the same (`originMonitor = selectedMonitorPubkey`); Phase 4 lifts this.
- No per-slot `playing` state in Phase 3; `playerPlaying` gates all slots.
- Scrubber and timeline remain single — no per-channel scrubber.

### Phase 3 Test Checklist

- [ ] Select two channels via chip buttons; two slots created
- [ ] Both slots render (video columns side-by-side on desktop)
- [ ] Both slots advance `playerPosition` together at same timestamp
- [ ] Play button starts both slots; they stay in sync
- [ ] Jump forward: both slots seek, both load segments for new range
- [ ] Scrub: both slots' segments load preview at cursor
- [ ] Deselect one channel: that slot disappears
- [ ] Select new channel: new slot created, segments loaded
- [ ] Speed control affects both slots equally
- [ ] End-of-play triggers when any slot reaches its buffer end
- [ ] Extension trigger fires for both slots
- [ ] Regression: single-channel mode (one chip selected) still works identically to Phase 0

---

## Phase 4: Multi-Device View

**Scope**: Extend player slots to span multiple devices. Coverage aggregation. Device selection UI.

**Goal**: Select 2+ devices; view their channels simultaneously in a grid.

### Coverage Key Migration

**Current (Phase 0-3):**
```typescript
coverageByChannel: Record<channelId, RangeSet>
// e.g. { 'camera-1': [[100,150], [200,250]], 'camera-2': [[120,180]] }
```

**With multiple devices (Phase 4):**
```typescript
coverageByChannel: Record<`${originMonitor}/${channelId}`, RangeSet>
// e.g. { 'pubkey1/camera-1': [...], 'pubkey2/camera-1': [...] }
```

**Backward compatibility**: During Phase 3 (single device), continue using bare `channelId` keys. When multi-device mode is enabled, rebuild with `${originMonitor}/` prefix. This avoids migration trauma.

#### Gradual Migration Strategy

1. **Phase 3 end state**: All coverage maps still use bare `channelId`.
2. **Phase 4 start**: When `selectedMonitorPubkeys.size > 1`, derive coverage keys with `${pubkey}/` prefix.
3. **Single-device fallback**: If only one device is selected, optionally keep keys bare (or prefix for consistency).

```typescript
// Phase 4 helper
function _getCoverageKey(originMonitor: string, channelId: string): string {
  if (playerSlots.length > 0 && new Set(playerSlots.map(s => s.originMonitor)).size > 1) {
    return `${originMonitor}/${channelId}`;
  }
  return channelId;  // Phase 3 compatibility
}
```

### Device Selection UI

Update `DevicesSection` to allow multi-select:

**Before:**
```svelte
<label>
  <input type="radio" bind:group={selectedMonitorPubkey} value={device.pubkey} />
  {device.label}
</label>
```

**After:**
```svelte
<label>
  <input
    type="checkbox"
    checked={selectedMonitorPubkeys.has(device.pubkey)}
    onchange={(e) => {
      if (e.currentTarget.checked) {
        selectedMonitorPubkeys.add(device.pubkey);
      } else {
        selectedMonitorPubkeys.delete(device.pubkey);
      }
      selectedMonitorPubkeys = selectedMonitorPubkeys;  // trigger reactivity
    }}
  />
  {device.label}
</label>
```

Store `selectedMonitorPubkeys` as a `Set<string>` in a new store or as a bound prop:

```typescript
let selectedMonitorPubkeys = $state(new Set<string>());
```

For backward compatibility with existing code that uses `selectedMonitorPubkey` (singular):

```typescript
// Phase 4 transition: derive singular from set
let selectedMonitorPubkey = $derived(
  selectedMonitorPubkeys.size === 1
    ? [...selectedMonitorPubkeys][0]
    : selectedMonitorPubkeys.values().next().value || null
);
```

### Slot Creation from Device × Channel Cross-Product

When devices are selected, rebuild `playerSlots` from the cross-product:

```typescript
function _rebuildPlayerSlots() {
  const newSlots: PlayerSlot[] = [];
  
  for (const pubkey of selectedMonitorPubkeys) {
    // Get channels for this device
    const channels = _getChannelsForDevice(pubkey);  // query IDB or coverage map
    
    for (const ch of channels) {
      // Skip if already in slots (shouldn't happen in rebuild, but safe)
      if (playerSlots.some(s => s.originMonitor === pubkey && s.channelId === ch)) {
        newSlots.push(playerSlots.find(s => s.originMonitor === pubkey && s.channelId === ch)!);
      } else {
        newSlots.push({
          originMonitor: pubkey,
          channelId: ch,
          segs: [],
          rangeFrom: playerRangeFrom,
          rangeTo: playerRangeTo,
        });
      }
    }
  }
  
  playerSlots = newSlots;
  _ctrlAfterScrub();  // load content for new slots
}

// Call on device selection change
$effect(() => {
  selectedMonitorPubkeys;  // reactive dependency
  _rebuildPlayerSlots();
});
```

### Channel Discovery Per-Device

Query IDB for channels recorded by each device:

```typescript
async function _getChannelsForDevice(pubkey: string): Promise<string[]> {
  return getDistinctChannels(pubkey);  // IDB query filtered by originMonitor
}
```

Or extract from coverage maps if already loaded:

```typescript
function _getChannelsForDevice(pubkey: string): string[] {
  const channels = new Set<string>();
  for (const [key] of Object.entries(_localCovByChannel)) {
    const match = key.match(/^(.+)\/(.+)$/);  // "pubkey/channel" format
    if (match?.[1] === pubkey) channels.add(match[2]);
  }
  return [...channels];
}
```

### Data Channel Requests to Correct Device

Modify fetch logic to route requests to the correct WebRTC session per slot:

```typescript
async function _updateSlotBuffer(slot: PlayerSlot) {
  const bStart = playerPosition - BUFFER_BACK_S;
  const bEnd = playerPosition + BUFFER_FWD_S;
  
  // IDB query — always local
  const idbSegs = await getSegmentsInRange(bStart, bEnd, slot.originMonitor, slot.channelId);
  
  // RTC request — routed to correct peer session
  let rtcSegs: PlayerSeg[] = [];
  if (idbSegs.length === 0 && fetchSourceRtc) {
    rtcSegs = await requestSegmentsInRange(
      bStart, bEnd,
      $identity.privkey, $identity.pubkey,
      slot.originMonitor,  // target device pubkey
      undefined,           // mimePrefix — any type
      slot.channelId       // channel filter
    );
  }
  
  slot.segs = [...idbSegs, ...rtcSegs];
  slot.rangeFrom = bStart;
  slot.rangeTo = bEnd;
}
```

The `requestSegmentsInRange` function (and other RTC requests in `viewer-peer.ts`) already accept `monitorPubkey` to route to the correct session. No changes needed to the WebRTC layer.

### Coverage Aggregation

Merge coverage maps from all selected devices:

```typescript
let _localCovByChannelMultiDev = $derived.by(() => {
  const merged: Record<string, [number, number][]> = {};
  
  for (const pubkey of selectedMonitorPubkeys) {
    // Load coverage for this device
    const devCov = _localCovByChannelPerDev[pubkey] || {};  // separate store per device
    
    for (const [ch, ranges] of Object.entries(devCov)) {
      const key = _getCoverageKey(pubkey, ch);
      merged[key] = ranges;
    }
  }
  
  return merged;
});
```

Or, if coverage is already loaded with `originMonitor` in the key:

```typescript
// If _localCovByChannel is already keyed as "pubkey/channel"
const coverageByChannel = $derived({
  ..._remoteCovByChannel,
  ..._localCovByChannel,
  // Both already use prefixed keys in Phase 4
});
```

### Timeline Scrubber — Multi-Device Lanes

The scrubber already iterates over all keys in `coverageByChannel` and renders each as a lane. If keys are prefixed with `originMonitor/`, each device's channels will appear as separate lanes automatically.

```svelte
<!-- In TimelineSection scrubber -->
{#each Object.entries(coverageByChannel) as [key, ranges]}
  <div class="lane" data-key={key}>
    <!-- render ranges -->
  </div>
{/each}
```

**Result**: Scrubber shows all device/channel combinations as separate lanes. Clicking a lane position seeks to that content.

### Live View in Multi-Device Mode

Each device's live stream is independent. Opening "Watch Live" for a selected device establishes a WebRTC connection to that device:

```typescript
// In LiveViewSection or player
async function startLiveView(originMonitor: string, channelId: string) {
  const stream = await requestLiveStream(
    $identity.privkey, $identity.pubkey,
    originMonitor,
    channelId
  );
  // Display stream in a <video> element
}
```

If multiple devices are selected, open one live connection per device (or per channel, depending on monitor implementation). This is a parallel to Phase 3 multi-channel live: one stream per logical unit (device/channel pair).

### Invariants (Phase 4)

- `selectedMonitorPubkeys` is a `Set<string>`; can be empty (nothing selected) or contain multiple pubkeys.
- `playerSlots` is a cross-product of selected devices and their channels.
- Each slot has a unique `(originMonitor, channelId)` pair.
- Coverage keys are formatted as `${originMonitor}/${channelId}` (or bare `channelId` in single-device mode for backward compat).
- `playerPosition` remains shared across all slots (no per-device/per-channel time offset).
- Data channel requests are routed to the correct `originMonitor` via the RTC session map in `viewer-peer.ts`.

### Phase 4 Test Checklist

- [ ] Device selection UI: checkboxes appear for each paired device
- [ ] Select 1 device: behavior identical to Phase 3 (backward compat)
- [ ] Select 2 devices: `playerSlots` contains (pubkey1/ch1, pubkey1/ch2, ..., pubkey2/ch1, ...) combinations
- [ ] Slots render in grid, labeled with device + channel
- [ ] Both devices' channels advance `playerPosition` together
- [ ] Coverage lanes for both devices appear on scrubber (separate lanes per device/channel)
- [ ] Jump forward: both devices' slots load segments
- [ ] Scrub: preview loads from both devices
- [ ] Deselect one device: all slots for that device disappear
- [ ] Coverage map keys use `${pubkey}/channel` format
- [ ] RTC fallback requests go to correct device (inspect Network tab or logs)
- [ ] End-of-play triggers when any device reaches buffer end
- [ ] Regression: single-device view still works as Phase 3

---

## Coverage Key Migration

### Timeline (Critical for Multi-Device)

**Problem**: If two monitors record channels with the same ID (e.g., both have `default-channel`), bare `channelId` keys collide:

```typescript
// Before Phase 4:
_localCovByChannel = {
  'camera-1': [[100,200], [300,400]],  // monitor A
  'camera-2': [[150,250]],             // monitor B
};

// Device B's 'camera-1' silently overwrites Device A's!
```

**Solution**: Use two-part keys during multi-device mode:

```typescript
_localCovByChannel = {
  'pubkeyA/camera-1': [[100,200], [300,400]],
  'pubkeyB/camera-1': [[150,250]],
  'pubkeyB/camera-2': [[180,280]],
};
```

### Implementation Path

1. **Phase 3 (single device)**: Keep keys bare. No migration.
2. **Phase 4 alpha (multi-device detection)**: When `selectedMonitorPubkeys.size > 1`, rebuild coverage maps with prefixed keys on-the-fly using `_getCoverageKey()` helper.
3. **Phase 4 stable**: If multi-device becomes the norm, restructure coverage storage:
   ```typescript
   // Per-device coverage maps
   _localCovPerDevice: Record<pubkey, Record<channelId, RangeSet>> = $state({});
   
   // Derived: flattened for timeline
   const _localCovByChannel = $derived.by(() => {
     const merged: Record<string, [number, number][]> = {};
     for (const [pubkey, cov] of Object.entries(_localCovPerDevice)) {
       for (const [ch, ranges] of Object.entries(cov)) {
         merged[`${pubkey}/${ch}`] = ranges;
       }
     }
     return merged;
   });
   ```

### Scrubber Update

The `TimelineSection` scrubber already renders all keys in `coverageByChannel`. No changes needed. Just ensure keys are consistent (all prefixed or all bare depending on mode).

---

## Component Integration

### ContentViewerSection (Main Controller)

**Changes for Phase 3+:**

1. Replace `playerSegs`, `playerRangeFrom/To` with `playerSlots` array.
2. Add `playbackSpeed: number` (Phase 1).
3. Add jump functions (Phase 2).
4. Add `selectedMonitorPubkeys: Set<string>` (Phase 4).
5. Update `_ctrlOnChannelToggle()` to rebuild `playerSlots`.
6. Update `_ctrlAfterScrub()`, `_ctrlExtendBuffer()`, `_ctrlEndOfPlay()` to loop over slots.
7. Update player render loop to grid layout.
8. Update `_playerIdx` derived to index per-slot.

**No changes to:**
- TimelineSection contract or props.
- `playerPosition`, `playerPlaying` — these remain global.
- Scrubber logic or sync protocol.
- Channel chip row behavior (just maps to slots now).

### TimelineSection

**No changes**. It already receives:
- `coverageByChannel` — will have prefixed keys in Phase 4, but scrubber doesn't care.
- `activeChannels` — derived from `playerSlots.map(s => s.channelId)` (or unique channels if multi-device).
- `onChannelToggle(active)` callback — still called; controller still rebuilds `playerSlots`.

### DevicesSection

**Phase 4 changes**:
- Replace radio buttons with checkboxes.
- Update `selectedMonitorPubkey` (singular) to `selectedMonitorPubkeys` (plural).
- Emit device selection change → controller triggers `_rebuildPlayerSlots()`.

### LiveViewSection

**Phase 3 changes**: 
- Extend to support multi-channel selection.
- Render one `<video>` per active channel.

**Phase 4 changes**:
- Further extend to support multi-device.
- One live connection per device (or per channel, depending on implementation).

---

## Testing Strategy

### Unit Tests

**Phase 1 (Speed):**
```typescript
// test: speed multiplier
const delta = 0.2 * playbackSpeed;
assert(delta === 0.1 when playbackSpeed === 0.5);
assert(delta === 0.4 when playbackSpeed === 2.0);
```

**Phase 2 (Jump):**
```typescript
// test: jump forward clamping
jumpForward(30);
assert(playerPosition === start + 30);

// test: jump backward clamping
jumpBackward(100);  // beyond buffer start
assert(playerPosition >= playerRangeFrom);
```

**Phase 3 (Multi-Channel):**
```typescript
// test: slot creation on channel toggle
_ctrlOnChannelToggle(['ch1', 'ch2']);
assert(playerSlots.length === 2);
assert(playerSlots.map(s => s.channelId).includes('ch1'));
assert(playerSlots.map(s => s.channelId).includes('ch2'));

// test: active channels derived
const active = activeChannels;
assert(active.includes('ch1') && active.includes('ch2'));

// test: slot destruction on toggle
_ctrlOnChannelToggle(['ch1']);
assert(playerSlots.length === 1);
assert(playerSlots[0].channelId === 'ch1');
```

**Phase 4 (Multi-Device):**
```typescript
// test: coverage key format
const key = _getCoverageKey('pubkeyA', 'camera-1');
assert(key === 'pubkeyA/camera-1' when multiple devices selected);
assert(key === 'camera-1' when single device selected);

// test: slot cross-product
selectedMonitorPubkeys.add('pubkeyA');
selectedMonitorPubkeys.add('pubkeyB');
_rebuildPlayerSlots();
const pubkeys = new Set(playerSlots.map(s => s.originMonitor));
assert(pubkeys.size === 2);
```

### Integration Tests

**Phase 1+:**
```
1. Play at 1x for 2s → playerPosition advances ~0.4s (two 200ms ticks)
2. Change to 2x → playerPosition advances ~0.8s (two ticks)
3. Change to 0.5x → playerPosition advances ~0.2s (two ticks)
```

**Phase 2+:**
```
1. Play at position 100s
2. Click jump +30s → playerPosition = 130s
3. Segments load for [100s, 150s] range
4. Play resumes immediately (no stall)
```

**Phase 3+:**
```
1. Select channels ch1 and ch2
2. Both slots render
3. Play → both advance playerPosition together
4. Pause ch1 (future: per-slot pause) → ch2 continues (or both pause if shared)
5. Deselect ch1 → slot disappears, ch2 continues (if using auto-refocus)
6. Regression: one channel → renders as before (single column, no grid)
```

**Phase 4+:**
```
1. Select devices pubkey1 and pubkey2
2. Load coverage for both → each device's channels appear as separate lanes
3. Jump forward → both devices' slots load segments
4. Scrub → preview loads from both devices concurrently
5. Watch Live for each device → independent WebRTC connections
6. Deselect pubkey1 → all slots for pubkey1 disappear, pubkey2 remains
7. Regression: single device → behavior matches Phase 3
```

### Coverage Tests

**Phase 3+:**
```
// Verify coverage lanes appear for all selected channels
// Verify coverage is merged from IDB and RTC correctly
// Verify scrubber shows all lanes (no missing channels)
```

**Phase 4+:**
```
// Verify prefixed keys don't collide (pubkeyA/ch1 vs pubkeyB/ch1)
// Verify coverage lanes are labeled by device (if UI shows it)
// Verify multi-device lanes refresh together on RTC fetch
```

### Performance Tests

**Phase 3+:**
```
// Measure frame rate with 4 channels playing simultaneously
// Measure buffer refill latency for 4 slots vs 1
// Measure memory usage (segments × slots)
```

**Phase 4+:**
```
// Measure WebRTC connection time for 2 devices
// Measure data channel throughput (simultaneous requests to 2 devices)
// Measure IDB query time with prefixed keys (no regression vs non-prefixed)
```

---

## UI Layout Patterns

### Player Grid (Phase 3+)

**Desktop (2+ columns):**
```
┌─────────────────┬─────────────────┐
│  Camera 1       │  Camera 2       │
│  [video 16:9]   │  [video 16:9]   │
├─────────────────┼─────────────────┤
│  Camera 3       │  Camera 4       │
│  [video 16:9]   │  [video 16:9]   │
└─────────────────┴─────────────────┘
```

**Tablet (1 column auto-scroll):**
```
┌───────────────────┐
│ Camera 1          │
│ [video]           │
├───────────────────┤
│ Camera 2          │
│ [video]           │  ← scroll
├───────────────────┤
│ Camera 3          │
│ [video]           │
└───────────────────┘
```

**Mobile (1 column, tab switch):**
```
┌─────────────────┐
│ Camera 1 | Camera 2
│ [video] │
└─────────────────┘
```

**Responsive Grid CSS:**
```css
.player-grid {
  display: grid;
  gap: 1rem;
  
  /* Mobile: 1 column */
  grid-template-columns: 1fr;
  
  /* Tablet 768px+: 2 columns */
  @media (min-width: 768px) {
    grid-template-columns: repeat(2, 1fr);
  }
  
  /* Desktop 1024px+: 2+ columns (or 4) */
  @media (min-width: 1024px) {
    grid-template-columns: repeat(2, 1fr);
  }
  
  /* Ultra-wide: 4 columns */
  @media (min-width: 1440px) {
    grid-template-columns: repeat(4, 1fr);
  }
}
```

### Speed Control UI

**Option A: Button Group (Recommended for simplicity)**
```
[0.5x] [1x] [2x] [4x]
```

**Option B: Slider**
```
0.5x ──●──── 4x
```

**Button group is recommended** because:
- Discrete steps are more useful than continuous
- Fewer accidental speeds (slider can land on 1.37x)
- Space-efficient
- Matches common video player patterns

### Jump Control UI

**Option A: Dual Buttons**
```
[← 30s] [00:45:30] [30s →]
```

**Option B: Single Dual-Button with Timestamp**
```
[← 30s] [30s →]
  Timestamp: 00:45:30
```

**Option A is recommended**: Timestamp in the middle makes it a self-contained playback control, reducing visual clutter.

### Device Selection UI

**Phase 4 only.**

**Desktop (Checkboxes):**
```
☐ Device A (Camera-1, Camera-2)
☐ Device B (Camera-1, Camera-3)
☐ Device C (Mic)
```

**With channel counts:**
```
☐ Device A (2 channels)
  ☑ Camera-1
  ☑ Camera-2
☐ Device B (3 channels)
  ☐ Camera-1
  ☐ Camera-3
  ☐ Mic
```

The second option allows per-device channel selection, but is more complex. For Phase 4 MVP, stick with per-device checkboxes (all channels of a device selected/deselected together).

### Timeline Scrubber (Phase 4+)

The existing scrubber already shows multiple lanes (one per coverage key). In Phase 4, if keys are prefixed with `${originMonitor}/`, lanes will naturally group by device. Optionally add visual separation:

```
Device A
  ├─ Camera-1  [════    ════  ]
  └─ Camera-2  [  ════════    ]
Device B
  ├─ Camera-1  [  ══════      ]
  └─ Audio     [    ════════  ]
```

This requires grouping lanes by device in the scrubber render loop (future improvement).

---

## Future Extensions

### Per-Slot Independent Clocks (Phase 3.5, Deferred)

Currently all slots share `playerPosition`. Future: allow each slot to have its own `position`, `playing`, `speed`. Challenges:

- Timeline scrubber would need to show multiple cursors
- "End-of-play" becomes ambiguous (end of which slot?)
- UI becomes significantly more complex

**Recommendation**: Defer until there's a strong use case (e.g., multi-angle slow-mo review).

### Per-Slot Speed Control (Phase 3.5, Deferred)

Allow a user to slow down one camera while keeping another at 1x speed. Requires per-slot `playbackSpeed` and separate `<video>` `playbackRate` binding per slot.

### Synced + Independent Toggle

Add a "Sync" button to switch between:
- **Synced mode** (current): all slots at same `playerPosition`, same `playbackSpeed`
- **Independent mode** (future): each slot can have different position and speed

### Recording Multi-View State

Save which channels/devices were selected, at what time, in what layout. Allow playback of a saved multi-view session.

### Multi-Channel Live Streaming

If the monitor supports multiplexing multiple live streams over a single WebRTC connection, implement protocol improvements:
- One `MediaRecorder` per channel
- Multiplex tracks via data channel or separate `RTCDataChannel` per channel
- Reduces connection count from O(devices × channels) to O(devices)

### Configurable Grid Layout

Allow users to customize slot order, aspect ratio per slot, and grid dimensions.

---

## Appendix: Code Snippets

### PlayerSlot Interface (Full Definition)

```typescript
interface PlayerSlot {
  // Identity
  channelId: string;        // e.g., 'camera-1', 'audio'
  originMonitor: string;    // device pubkey
  
  // Segment data
  segs: PlayerSeg[];
  
  // Buffer window
  rangeFrom: number;        // unix seconds
  rangeTo: number;          // unix seconds
  
  // (Optional in Phase 3.5+)
  // position?: number;
  // playing?: boolean;
  // speed?: number;
}

interface PlayerSeg {
  key: string;              // unique identifier
  mimeType: string;         // e.g., 'video/mp4'
  startTime: number;        // unix seconds
  endTime: number;          // unix seconds
  blob: Blob;
  url: string;              // blob URL
  channelId?: string;
  originMonitor: string;    // source device pubkey
}
```

### Coverage Key Helper

```typescript
function _getCoverageKey(originMonitor: string, channelId: string): string {
  // Use prefixed keys if multiple devices are selected
  const hasMultiDevice = new Set(playerSlots.map(s => s.originMonitor)).size > 1;
  return hasMultiDevice ? `${originMonitor}/${channelId}` : channelId;
}
```

### State Machine: Channel Toggle

```typescript
async function _ctrlOnChannelToggle(active: string[]) {
  _ctrlActiveChannels = active;
  _ctrlApplyChannels();
  
  // Rebuild playerSlots
  const pubkey = selectedMonitorPubkey || '';
  playerSlots = active.map(ch => ({
    channelId: ch,
    originMonitor: pubkey,
    segs: [],
    rangeFrom: playerRangeFrom,
    rangeTo: playerRangeTo,
  }));
  
  // Refill buffer
  await _ctrlAfterScrub();
}
```

### End-of-Play Detection (Multi-Slot)

```typescript
function _ctrlCheckEndOfPlay(): boolean {
  if (playerSlots.length === 0) return false;
  
  // Check if any slot is at its buffer end
  const anyAtBufferEnd = playerSlots.some(s => playerPosition >= s.rangeTo);
  
  // Check if any slot is stalled in last frame
  const anyStalled = playerSlots.some(s => {
    if (s.segs.length === 0) return false;
    const lastSeg = s.segs[s.segs.length - 1];
    return lastSeg && playerPosition >= lastSeg.endTime && playerPlaying;
  });
  
  return anyAtBufferEnd || anyStalled;
}
```

### Derived: Active Channels and Monitors

```typescript
const activeChannels = $derived(playerSlots.map(s => s.channelId));

const activeMonitors = $derived([
  ...new Set(playerSlots.map(s => s.originMonitor))
]);

const playerCovByKey = $derived.by(() => {
  const cov: Record<string, [number, number][]> = {};
  for (const slot of playerSlots) {
    const key = _getCoverageKey(slot.originMonitor, slot.channelId);
    const ranges: [number, number][] = [];
    for (const seg of slot.segs) {
      // Merge overlapping ranges (optional, for cleaner display)
      ranges.push([seg.startTime, seg.endTime]);
    }
    if (ranges.length > 0) cov[key] = ranges;
  }
  return cov;
});
```

---

## Summary

| Phase | Feature | Complexity | Timeline | State Changes |
|-------|---------|------------|----------|---------------|
| **1** | Speed control | Minimal | 1–2 days | `playbackSpeed` var; `_playerTick()` multiplier |
| **2** | Jump controls | Minimal | 1 day | `jumpForward()`, `jumpBackward()` functions |
| **3** | Multi-channel | Medium | 3–5 days | `playerSlots` array; per-slot buffer logic |
| **4** | Multi-device | Complex | 5–7 days | Device selection UI; coverage prefixing; RTC routing |

Each phase is independently testable and backward-compatible with single-view mode.

**Start with Phase 1** (speed) to validate the architecture, then proceed to Phase 2 (jump), Phase 3 (multi-channel), and finally Phase 4 (multi-device) as time and testing allow.

