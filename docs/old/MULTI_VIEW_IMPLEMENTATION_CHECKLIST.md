# Multi-View Implementation Checklist

**Goal:** Enable simultaneous playback of multiple channels (same device) and multiple devices.

**Timeline:** 3–4 weeks (phased approach)  
**Prerequisites:** SentrySection controller extraction (Phase 1) recommended but not required  
**Testing:** Test monitor with 3+ channels; simulate multi-device setup

---

## Overview: Implementation Phases

Each phase is independent and shippable:

1. **Playback Speed** (20 lines, controller-only) — ~1 day
2. **Jump Controls** (10 lines, controller-only) — ~1 day
3. **Multi-Channel Layout** (200+ lines, UI + controller) — ~5 days
4. **Multi-Device Support** (coverage key refactor + device selection) — ~5 days
5. **Multi-Channel Live** (WebRTC multiplexing, deferred) — ~3 days (optional)

---

## Phase 1: Playback Speed Control

**Status:** Simplest feature. Controller-only. No data model or UI layout changes.

### 1.1: Add State to ContentViewerSection Controller

```typescript
let playbackSpeed = $state(1.0);  // 0.5x, 1.0x, 2.0x, 4.0x
```

### 1.2: Update Player Tick

Find `_playerTick()` and multiply the delta:

**Before:**
```typescript
// In 100ms tick (runs 10x per second)
const secondsPerTick = 0.1;
playerPosition = Math.min(playerPosition + secondsPerTick, playerRangeTo);
```

**After:**
```typescript
const secondsPerTick = 0.1 * playbackSpeed;
playerPosition = Math.min(playerPosition + secondsPerTick, playerRangeTo);
```

### 1.3: Sync with Media Element

For video/audio playback, also set playback rate:

```typescript
if (playerVideoEl) playerVideoEl.playbackRate = playbackSpeed;
if (playerAudioEl) playerAudioEl.playbackRate = playbackSpeed;
```

### 1.4: Add UI Controls

In the player inline UI, add speed buttons:

```svelte
<div class="controls">
  <button onclick={() => playbackSpeed = 0.5}>0.5x</button>
  <button onclick={() => playbackSpeed = 1.0}>1.0x</button>
  <button onclick={() => playbackSpeed = 2.0}>2.0x</button>
  <button onclick={() => playbackSpeed = 4.0}>4.0x</button>
</div>
```

### 1.5: Tests

```typescript
it('advances position by delta × speed', () => {
  playbackSpeed = 2.0;
  // Tick advances position by 0.2s instead of 0.1s
  _playerTick();
  expect(playerPosition).toBe(startPos + 0.2);
});
```

**Deliverable:** Speed buttons work; player advances at selected rate; video/audio sync.

---

## Phase 2: Jump Controls (±30s, ±5min)

**Status:** Controller-only. Two button clicks.

### 2.1: Add Jump Functions

```typescript
function jumpForward(seconds = 30) {
  playerSeekTo(Math.min(playerPosition + seconds, playerRangeTo));
  _ctrlAfterScrub();  // refill buffer at new position
}

function jumpBackward(seconds = 30) {
  playerSeekTo(Math.max(playerPosition - seconds, playerRangeFrom));
  _ctrlAfterScrub();
}
```

### 2.2: Add UI Buttons

```svelte
<button onclick={() => jumpBackward(5 * 60)}>⏮ 5m</button>
<button onclick={() => jumpBackward(30)}>⏪ 30s</button>
<button onclick={() => jumpForward(30)}>⏩ 30s</button>
<button onclick={() => jumpForward(5 * 60)}>⏭ 5m</button>
```

### 2.3: Tests

```typescript
it('jumps forward and refills buffer', async () => {
  const startPos = playerPosition;
  jumpForward(60);
  expect(playerPosition).toBe(startPos + 60);
  // _ctrlAfterScrub should be called (can verify via spy)
});
```

**Deliverable:** Jump buttons work; buffer refills at new position; no UI jump/stall.

---

## Phase 3: Multi-Channel Layout (Same Device)

**Status:** Requires refactoring player state and UI layout.

### 3.1: Refactor Player State

Replace single player with slot array:

**Before:**
```typescript
let playerSegs: Segment[] = $state([]);
let playerPosition: number = $state(0);
let playerRangeFrom: number = $state(0);
let playerRangeTo: number = $state(0);
let playerChannelFilter: Set<string> = $state(new Set());
```

**After:**
```typescript
interface PlayerSlot {
  channelId: string;
  segs: Segment[];
  rangeFrom: number;
  rangeTo: number;
}

let playerSlots: PlayerSlot[] = $state([]);
let playerPosition: number = $state(0);  // Shared clock — all slots advance together
let playerChannelFilter: Set<string> = $state(new Set());  // Gates which slots exist
```

### 3.2: Derive Active Slots from Channel Filter

```typescript
let activeSlots = $derived(
  playerSlots.filter(slot => playerChannelFilter.has(slot.channelId))
);
```

### 3.3: Update Buffer Management

Refactor existing `_ctrlAfterScrub()` to run per-slot:

**Before:**
```typescript
async function _ctrlAfterScrub() {
  const segs = await getSegmentsInRange(from, to, originMonitor, channelFilter);
  playerSegs.push(...segs);
}
```

**After:**
```typescript
async function _ctrlAfterScrub() {
  for (const slot of playerSlots) {
    const segs = await getSegmentsInRange(
      from, to, originMonitor, slot.channelId  // per-slot channel filter
    );
    slot.segs.push(...segs);
  }
}
```

Same for `_ctrlExtendBuffer()` — loop over slots instead of a single buffer.

### 3.4: Update Player Tick

```typescript
function _playerTick() {
  // Advance shared position
  playerPosition += 0.1 * playbackSpeed;

  // Check end-of-play for ALL slots
  const maxRangeTo = Math.max(...playerSlots.map(s => s.rangeTo));
  if (playerPosition >= maxRangeTo) {
    _ctrlEndOfPlay();
  }
}
```

### 3.5: Update Player UI

Replace single player element with layout:

**Before:**
```svelte
<div class="player">
  <video bind:this={playerVideoEl} src={...} />
  <audio bind:this={playerAudioEl} src={...} />
</div>
```

**After:**
```svelte
<div class="player-grid">
  {#each activeSlots as slot (slot.channelId)}
    <div class="player-column">
      <label>{slot.channelId}</label>
      <PlayerSlotView
        {slot}
        position={playerPosition}
        playing={playerPlaying}
      />
    </div>
  {/each}
</div>
```

**Styles:**
```css
.player-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1rem;
}

.player-column {
  border: 1px solid #ccc;
  border-radius: 4px;
  overflow: hidden;
}
```

### 3.6: Create PlayerSlotView Component

A dumb component that displays a single slot:

```svelte
<script lang="ts">
  import type { PlayerSlot } from '$lib/...';

  let { slot, position, playing } = $props();

  let videoEl: HTMLVideoElement | undefined;
  let audioEl: HTMLAudioElement | undefined;

  $effect(() => {
    if (videoEl) videoEl.currentTime = position;
    if (audioEl) audioEl.currentTime = position;
  });
</script>

<div class="slot-view">
  {#if hasVideoInSlot(slot)}
    <video bind:this={videoEl} {playing} />
  {/if}
  {#if hasAudioInSlot(slot)}
    <audio bind:this={audioEl} {playing} />
  {/if}
  {#if hasImageInSlot(slot)}
    <img src={getImageAtPosition(slot, position)} alt={slot.channelId} />
  {/if}
</div>

<style>
  video, audio, img {
    width: 100%;
    height: auto;
  }
</style>
```

### 3.7: Update Timeline

The timeline already supports multi-channel (coverage by channel). No changes needed for scrubber — it already draws multiple lanes.

**Channel chips** control which slots are displayed:

```svelte
<!-- Timeline channel chips are now the slot selector -->
{#each allChannels as ch}
  <button
    class:active={playerChannelFilter.has(ch)}
    onclick={() => {
      playerChannelFilter.has(ch)
        ? playerChannelFilter.delete(ch)
        : playerChannelFilter.add(ch);
      // This reactively updates activeSlots via $derived
    }}
  >
    {ch}
  </button>
{/each}
```

### 3.8: Tests

```typescript
it('creates player slot per active channel', () => {
  playerChannelFilter = new Set(['ch-1', 'ch-2']);
  expect(activeSlots).toHaveLength(2);
  expect(activeSlots.map(s => s.channelId)).toEqual(['ch-1', 'ch-2']);
});

it('shares playerPosition across all slots', () => {
  const initialPos = 100;
  playerPosition = initialPos;
  _playerTick();

  playerSlots.forEach(slot => {
    // Both slots' playerSlotView components should be at new position
  });
});

it('extends buffer per-slot', async () => {
  playerSlots[0].rangeTo = 200;
  playerSlots[1].rangeTo = 150;

  await playerExpandRange(300);

  expect(playerSlots[0].rangeTo).toBe(300);
  expect(playerSlots[1].rangeTo).toBe(300);
});
```

**Deliverable:** UI displays 2–4 channels side by side; player position is shared and synced; timeline scrubber controls all slots.

---

## Phase 4: Multi-Device Support

**Status:** Data layer already supports it. Requires coverage key changes and device selection UI.

### 4.1: Update Coverage Key Format

Currently: `coverageByChannel` is keyed by `channelId` alone.  
Change to: `${originMonitor}/${channelId}` for multi-device.

**Impact:** 
- Multi-device viewers will have overlapping channel IDs (e.g., both monitors have `default-channel`)
- Keys must be scoped by `originMonitor` to prevent coverage map collisions

**Implementation:**

In `ContentViewerSection`, update coverage map loading:

**Before:**
```typescript
async function loadLocalCoverage() {
  const cov = await getCoverageByChannel(originMonitor);
  _localCovByChannel = cov;  // keys: 'ch-1', 'ch-2', ...
}
```

**After:**
```typescript
async function loadLocalCoverage() {
  const cov = await getCoverageByChannel(originMonitor);
  // Re-key with originMonitor prefix
  _localCovByChannel = Object.entries(cov).reduce((acc, [ch, ranges]) => {
    acc[`${originMonitor}/${ch}`] = ranges;
    return acc;
  }, {});
}
```

### 4.2: Update Player Slots to Include originMonitor

```typescript
interface PlayerSlot {
  originMonitor: string;     // NEW: device pubkey
  channelId: string;
  segs: Segment[];
  rangeFrom: number;
  rangeTo: number;
}
```

### 4.3: Add Multi-Device Selection

In `DevicesSection`, change device selection from single to multi-select:

**Before:**
```svelte
<button
  onclick={() => selectedMonitorPubkey = device.pubkey}
  class:active={selectedMonitorPubkey === device.pubkey}
>
  {device.label}
</button>
```

**After:**
```svelte
<button
  onclick={() => {
    selectedMonitorPubkeys.has(device.pubkey)
      ? selectedMonitorPubkeys.delete(device.pubkey)
      : selectedMonitorPubkeys.add(device.pubkey);
  }}
  class:active={selectedMonitorPubkeys.has(device.pubkey)}
>
  {device.label}
</button>
```

### 4.4: Update Player Slot Creation

When device selection changes, create slots for `(device, channel)` pairs:

```typescript
function _updatePlayerSlots() {
  const newSlots: PlayerSlot[] = [];

  for (const device of selectedMonitors) {
    for (const channel of activeChannels) {
      newSlots.push({
        originMonitor: device.pubkey,
        channelId: channel,
        segs: [],
        rangeFrom: 0,
        rangeTo: 0,
      });
    }
  }

  playerSlots = newSlots;
}

// React to device or channel selection changes
$effect(() => {
  _updatePlayerSlots();
});
```

### 4.5: Update Segment Fetching

Route fetch requests to the correct device's WebRTC session:

**Before:**
```typescript
async function _ctrlAfterScrub() {
  for (const slot of playerSlots) {
    const segs = await getSegmentsInRange(from, to, originMonitor, slot.channelId);
    slot.segs.push(...segs);
  }
}
```

**After:**
```typescript
async function _ctrlAfterScrub() {
  for (const slot of playerSlots) {
    // Route to correct device's session
    const segs = await getSegmentsInRange(
      from, to,
      slot.originMonitor,  // device-specific
      slot.channelId
    );
    slot.segs.push(...segs);
  }
}
```

Ensure `getSegmentsInRange()` respects `originMonitor` when querying local IDB.

### 4.6: Update PlayerSlotView

Pass `originMonitor` to identify which device's stream we're playing:

```svelte
<script lang="ts">
  let { slot, position, playing } = $props();

  // If this slot is from a specific monitor, only show that monitor's segments
</script>
```

### 4.7: Update UI Labels

Show device + channel in player:

```svelte
<div class="player-column">
  <label>{slot.originMonitor.slice(0, 8)}... / {slot.channelId}</label>
  <PlayerSlotView {slot} {position} {playing} />
</div>
```

### 4.8: Tests

```typescript
it('creates player slots for all (device, channel) pairs', () => {
  selectedMonitors = [device1, device2];
  activeChannels = new Set(['ch-1', 'ch-2']);

  _updatePlayerSlots();

  expect(playerSlots).toHaveLength(4); // 2 devices × 2 channels
  expect(playerSlots[0]).toMatchObject({ originMonitor: device1.pubkey, channelId: 'ch-1' });
});

it('fetches segments for each device independently', async () => {
  const slot1 = playerSlots.find(s => s.originMonitor === device1.pubkey);
  const slot2 = playerSlots.find(s => s.originMonitor === device2.pubkey);

  await _ctrlAfterScrub();

  // slot1 and slot2 should have different segments (from different devices)
  expect(slot1.segs).not.toEqual(slot2.segs);
});
```

**Deliverable:** UI shows 2–4 devices simultaneously, each with their own channels; coverage is device-scoped; segment fetches are routed correctly.

---

## Phase 5: Multi-Channel Live View (Deferred)

**Status:** Adds complexity with minimal user value at MVP. Defer to v1.1 or later.

### 5.1: Per-Slot Live Streams

Each player slot would subscribe to its own live stream:

```typescript
// In viewer-peer.ts:
async function startLiveView(channelId: string): Promise<MediaStream> {
  const offer = buildLiveOffer(channelId);
  const answer = await signalAndWait(offer);
  const stream = getMediaStream(answer);
  return stream;
}
```

### 5.2: Challenge: Multiple RTC Connections

Opening one RTC connection per channel may exceed browser limits or relay rate limits. Two approaches:

**Option A: One connection per channel** (simple, higher overhead)
```typescript
for (const slot of playerSlots) {
  const stream = await viewer-peer.startLiveView(slot.channelId);
  slot.liveStream = stream;
}
```

**Option B: Multiplex channels over one connection** (complex, better efficiency)
- Send offer once, asking for all requested channels
- Monitor sends multiple tracks (one per channel) in single MediaStream
- Viewer demultiplexes tracks by channel ID tag

Option A is recommended for Phase 5. Option B can be explored in Phase 5b after real-world usage confirms the overhead is a problem.

**Deliverable:** (Defer to later) Live view works with multi-channel playback.

---

## Integration: Full Multi-View Checklist

After completing Phases 1–4, verify:

- [ ] **Speed control** — 0.5x to 4.0x works
- [ ] **Jump controls** — ±30s, ±5m buttons work
- [ ] **Multi-channel** — 3+ channels display side by side
- [ ] **Shared position** — scrubbing one channel scrubs all
- [ ] **Multi-device** — 2 devices + 2 channels each = 4 players work
- [ ] **Coverage maps** — device-scoped keys prevent collisions
- [ ] **Fetch routing** — segments from device A don't appear in device B's slot
- [ ] **Timeline** — coverage lanes show correctly for all channels
- [ ] **Buffer refill** — extending buffer refills all active slots
- [ ] **End-of-play** — stops when all slots reach their range end
- [ ] **UI layout** — responsive grid, no overlaps, labels clear
- [ ] **Tests** — unit tests for state ownership, integration tests for multi-slot flow
- [ ] **Perf** — no noticeable stall when viewing 4 channels simultaneously
- [ ] **Mobile** — layout works on portrait (stack columns vertically)

---

## Risk Mitigation

### Risk: Multi-slot buffer management becomes complex

**Mitigation:** Each slot is independent. Running `_ctrlAfterScrub()` N times (once per slot) is simpler than trying to batch. Trade a bit of efficiency for clarity.

### Risk: Timeline becomes crowded with 4+ channels

**Mitigation:** Phase 4 includes device selection UI. In practice, viewers will select 1–2 devices at a time. If they want all 4 channels, they're choosing to see them crowded — that's the trade-off.

### Risk: Multi-device live view adds too much overhead

**Mitigation:** Phase 5 is deferred. Start with multi-channel playback only (same device, one RTC connection). If live multi-channel is needed, prototype Option A first; optimize to Option B only if profiling shows it's necessary.

---

## Success Criteria

### Phase 1 (Speed)
- [ ] Speed buttons are visible and clickable
- [ ] Player advances at selected rate (0.5x, 2.0x, etc.)
- [ ] Video/audio playbackRate is synced

### Phase 2 (Jump)
- [ ] Jump buttons are visible
- [ ] Jumps advance/rewind and refill buffer
- [ ] No visual stall after jump

### Phase 3 (Multi-Channel)
- [ ] 3+ channels display side by side
- [ ] Player position is shared across all
- [ ] Channel chips control which slots are visible
- [ ] Timeline shows coverage for all channels

### Phase 4 (Multi-Device)
- [ ] Multiple devices can be selected
- [ ] Player has one slot per (device, channel) pair
- [ ] Coverage keys are device-scoped (no collisions)
- [ ] Segment fetches are routed to correct device

### Overall
- [ ] No regressions in existing single-channel, single-device view
- [ ] `npm run test` shows 100%+ of new tests passing
- [ ] `npm run check` shows 0 new errors

---

## File Structure After Completion

```
src/
  lib/
    webrtc/
      viewer-peer.ts       (unchanged — already supports multi-device)
    db/
      segments.ts          (unchanged — already device-scoped)
    components/
      dev/
        ContentViewerSection.svelte  (refactored: playerSlots array)
        PlayerSlotView.svelte        (NEW: dumb component, per-slot view)
        TimelineSection.svelte       (unchanged — already multi-channel)
        DevicesSection.svelte        (updated: multi-select device UI)

docs/
  multi-view-implementation-checklist.md  (this file)
  multi-view-detailed-spec.md             (architecture + state ownership)
```

---

## Next Steps

1. **Complete Phase 1** (speed control) — simplest; validates approach
2. **Test thoroughly** on single-channel setup; ensure no regressions
3. **Move to Phase 2** (jump controls)
4. **Tackle Phase 3** (multi-channel) once you're confident in state ownership
5. **Phase 4** (multi-device) is optional for MVP; include if time permits

Each phase is shippable independently. You can deploy Phase 1–2 to production without Phase 3–4.
