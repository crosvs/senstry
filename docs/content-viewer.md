# Content Viewer Controller

## Overview

`ContentViewerSection.svelte` is a controller component that manages three dumb UI components:

- **`TimelineSection`** — displays coverage, receives seek/scrub gestures
- **Player** (inline in ContentViewerSection) — renders video/audio/photo at the current playback position
- **Fetch Content section** (inline) — lets the user browse and fetch footage from IDB or WebRTC

The controller holds all state and drives the three UIs. The UIs expose user actions upward via callbacks; the controller decides what to do with them.

---

## Architecture: controller + dumb components

```
ContentViewerSection (controller)
  ├── TimelineSection         ← dumb: renders timeline, fires onSeekChange/onScrubStart/onScrubEnd/onChannelToggle
  ├── Player (inline)         ← dumb: renders current segment, driven by playerSegs/playerPosition
  └── Fetch Content (inline)  ← dumb: displays fetchedSegs table, fires fetch button actions
```

The controller is the only place that:
- Decides whether to fetch coverage, segments, or both
- Manages the channel filter state (`fetchChannelFilter`, `playerChannelFilter`)
- Remembers the user's channel selection across coverage refreshes
- Runs the scrub/play/end-of-play state transitions

---

## Controller state variables

### Channel state

| Variable | Type | Role |
|----------|------|------|
| `_ctrlActiveChannels` | `$state<string[]>` | User's remembered chip selection — written only by `_ctrlOnChannelToggle` |
| `_tlActiveChannels` | `$state<string[]>` | Pushed to `TimelineSection.activeChannels`; synced by `_ctrlApplyChannels()` |
| `fetchChannelFilter` | `$state<Set<string>>` | Empty = all channels; non-empty = IDB/RTC queries restricted to these channels |
| `playerChannelFilter` | `$state<Set<string>>` | Empty = all channels; non-empty = `playerAddSegs` rejects segments not in this set |

### Playback state

| Variable | Type | Role |
|----------|------|------|
| `_userWantsToPlay` | `boolean` | Plain var: tracks explicit play intent; survives scrubbing |
| `_isScrubbing` | `$state(boolean)` | True while pointer is held on scrubber |
| `_ctrlFetching` | `boolean` | Guard: prevents concurrent content-fetch operations |
| `_scrubFetching` | `boolean` | Guard: prevents concurrent scrub-preview fetches |

### Coverage vs. active channels

Coverage (`coverageByChannel`) is always fetched for all channels. The scrubber always shows every lane. `_ctrlInCoverage(pos)` checks only `_ctrlActiveChannels` channels when non-empty; if empty, it checks all coverage channels. This means the user sees all available coverage in the scrubber but the controller only acts on coverage from channels they've selected.

---

## `_ctrlApplyChannels()` — the sync point

Called at the start of every state transition. Asserts the controller's remembered selection into the fetch/player filters and pushes chip state to the timeline:

```typescript
function _ctrlApplyChannels() {
  if (!_ctrlEnabled) return;
  fetchChannelFilter  = new Set(_ctrlActiveChannels);
  playerChannelFilter = new Set(_ctrlActiveChannels);
  if (_ctrlActiveChannels.length > 0) {
    const available = new Set(Object.keys(coverageByChannel));
    const valid = _ctrlActiveChannels.filter(ch => available.has(ch));
    if (valid.length > 0) _tlActiveChannels = valid;
  }
}
```

The call pattern for every handler is:
1. `_ctrlApplyChannels()` first
2. Then perform state logic

---

## State machine transitions

### User clicks a channel chip → `_ctrlOnChannelToggle(active)`

1. `_ctrlActiveChannels = active`
2. `_ctrlApplyChannels()` — push to filters + timeline
3. Evict all player segments (they may be from wrong channels)
4. `_ctrlAfterScrub()` — re-fetch for the new filter

### Pointer down on scrubber → `_ctrlOnScrubStart()`

1. `_isScrubbing = true`
2. Pause player if playing
3. Save and narrow `playerTypeFilter` to `['video/', 'image/']` (video/photo preview only — no audio during scrub)
4. Start 300ms interval → `_ctrlScrubTick()`

### 300ms scrub tick → `_ctrlScrubTick()`

1. `_ctrlApplyChannels()`
2. Lock `playerPosition = viewCenter`
3. Expand player range (never evict during scrubbing)
4. If coverage exists at cursor and no nearby preview: fetch scrub preview via `_ctrlFetchScrubPreview(cursor)`

### Pointer up → `_ctrlOnScrubEnd()` → `_ctrlAfterScrub()`

1. `_isScrubbing = false`
2. Restore saved `playerTypeFilter`
3. `_ctrlApplyChannels()`
4. Fetch coverage (if not already in flight)
5. If cursor is outside active-channel coverage: set status "no coverage at cursor", return
6. If player already has content near cursor: seek + resume play if `_userWantsToPlay`
7. Otherwise: **sparse fetch** (see below)

### End-of-play → 200ms tick

The 200ms tick detects `playerPlaying` going true→false at `playerPosition === playerRangeTo`. It:
1. `_ctrlApplyChannels()`
2. Fetches the next buffer window forward
3. Extends the player range; resumes play if `_userWantsToPlay`

---

## Sparse fetch

When no content is loaded at the cursor, three anchor points are fetched: `cursor−30s`, `cursor`, `cursor+30s`. This populates the player with segments even when the cursor falls in a gap between saved segments.

Each anchor uses `getSegmentsInRange(t, t)` as primary (finds any segment with `startTime ≤ t ≤ endTime`), with `getSegmentsBefore(t+1, 1)` as fallback for gaps:

```typescript
async function _loadAnchor(t: number) {
  const covering = await getSegmentsInRange(t, t, pubkey, ch);
  const metas = covering.length > 0
    ? [covering[0]]
    : await getSegmentsBefore(t + 1, 1, pubkey, undefined, ch);
  // materialize and push to fetchedSegs...
}
await _loadAnchor(cursor - 30);
await _loadAnchor(cursor);
await _loadAnchor(cursor + 30);
```

`getSegmentsInRange(t, t)` is used rather than `getSegmentsBefore` as primary because long segments (e.g. 5-minute recordings) that straddle the cursor would be missed by an endTime-only filter.

---

## Channel filter conversion for DB calls

IDB query functions accept `string | string[] | undefined`. The controller converts its `Set<string>`:

```typescript
// Multi-channel IDB query
const ch = fetchChannelFilter.size > 0 ? [...fetchChannelFilter] : undefined;
await getSegmentsInRange(from, to, pubkey, ch);

// Single-channel RTC query (protocol limitation — pass undefined when multiple selected)
const rtcCh = fetchChannelFilter.size === 1 ? [...fetchChannelFilter][0] : undefined;
```

Coverage is always fetched without a channel filter — `loadLocalCoverage` calls `getCoverageByChannel` for all channels so the scrubber shows complete coverage even when the active filter is narrow.

---

## Player buffer primitives

Three functions manage `playerSegs`; they are called by the controller (never by user button presses directly):

| Function | Effect |
|----------|--------|
| `playerSetRange(from, to)` | Hard-sets range; evicts segments outside it |
| `playerExpandRange(from, to)` | Expands range without evicting — used during scrubbing |
| `playerAddSegs(candidates)` | Dedup + gate: admits candidates that pass range, type, device, and channel filters |

`playerAddSegs` uses the `playerChannelFilter` Set:

```typescript
(playerChannelFilter.size === 0 || playerChannelFilter.has(s.channelId ?? ''))
```

---

## Channel chip UI (multi-select)

Both the player filter row and the fetcher filter row have multi-select chip buttons. Empty Set = all channels; all chips appear active. Toggling logic normalizes back to empty Set when all channels are re-selected:

```typescript
function toggleFetchChannel(ch: string) {
  const allIds = knownChannelIds;
  const current = fetchChannelFilter.size === 0 ? new Set(allIds) : new Set(fetchChannelFilter);
  if (current.has(ch) && current.size > 1) current.delete(ch); else current.add(ch);
  fetchChannelFilter = allIds.length > 0 && allIds.every(id => current.has(id)) ? new Set() : current;
}
```
