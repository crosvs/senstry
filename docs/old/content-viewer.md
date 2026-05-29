# Content Viewer Controller

## Overview

`ContentViewerSection.svelte` is a controller component that manages three dumb UI components. For the authoritative state ownership rules, single-writer constraints, and component contracts see **`docs/controller-architecture.md`**. This document covers the runtime state machine and data flow.

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

## Tunable parameters

All buffer parameters are `$state` variables exposed as number inputs in the **Timeline Controller** panel. Changes take effect immediately on the next 200ms tick or fetch.

| Variable | Default | Description |
|----------|---------|-------------|
| `BUFFER_BACK_S` | 0 | Seconds behind cursor to load on initial buffer fetch after scrubbing |
| `BUFFER_FWD_S` | 20 | Seconds ahead of cursor to load on initial fetch and per proactive extension step |
| `REFILL_TRIGGER_S` | 10 | Extend buffer when fewer than this many seconds of range remain ahead |
| `SCRUB_PREVIEW_LOOKBACK_S` | 300 | How far back (seconds) to search IDB for a scrub preview segment |
| `SCRUB_NEIGHBOR_RADIUS_S` | 30 | ±radius around cursor when populating neighbor preview pictures |
| `RTC_SCRUB_INTERVAL_MS` | 2000 | Minimum milliseconds between RTC requests during scrubbing |

`BUFFER_FWD_S` serves double duty: it sets both the initial forward buffer size (after scrub) and the extension step size during proactive playback. There is no separate lookahead variable — extension step = forward buffer size.

---

## Controller state variables

### Channel + type state

| Variable | Type | Role |
|----------|------|------|
| `_ctrlActiveChannels` | `$state<string[]>` | User's remembered channel chip selection — written only by `_ctrlOnChannelToggle` |
| `_ctrlActiveTypes` | `$state<Set<MimePrefix>>` | User's remembered type chip selection — written only by `_ctrlOnTypeToggle` |
| `_tlActiveChannels` | `$state<string[]>` | Pushed to `TimelineSection.activeChannels` |
| `_tlActiveTypes` | `$state<string[]>` | Pushed to `TimelineSection.activeTypes` |
| `fetchChannelFilter` | `$state<Set<string>>` | Empty = all channels; non-empty = IDB/RTC queries restricted to these channels |
| `playerChannelFilter` | `$state<Set<string>>` | Empty = all channels; non-empty = `playerAddSegs` rejects segments not in this set |
| `fetchTypeFilter` | `$state<Set<MimePrefix>>` | Asserted from `_ctrlActiveTypes`; also directly editable via Fetch Content chips |
| `playerTypeFilter` | `$state<Set<MimePrefix>>` | Asserted from `_ctrlActiveTypes`; narrowed to `['video/', 'image/']` during scrubbing |

### Playback state

| Variable | Type | Role |
|----------|------|------|
| `_userWantsToPlay` | `boolean` | Plain var: tracks explicit play intent; survives scrubbing |
| `_isScrubbing` | `$state(boolean)` | True while pointer is held on scrubber |
| `_ctrlFetching` | `boolean` | Guard: prevents concurrent content-fetch operations |
| `_scrubFetching` | `boolean` | Guard: prevents concurrent scrub-preview fetches |
| `_lastFrameTicks` | `number` | Consecutive 200ms ticks spent stuck in last-frame-while-playing; resets to 0 on any non-stall tick |
| `_lastRtcScrubAt` | `number` | `Date.now()` of the last RTC scrub-preview request; enforces 2s minimum interval between RTC calls during scrubbing |

### Coverage vs. active channels/types

Coverage is fetched **type-filtered**: `loadLocalCoverage` passes `[..._ctrlActiveTypes]` to both `getCoverageMap` and `getCoverageByChannel` so the scrubber only shows ranges where the selected types exist. When all types are selected the filter is omitted (`undefined`) for efficiency.

`_ctrlInCoverage(pos)` checks only `_ctrlActiveChannels` channels when non-empty; if empty, it checks all coverage channels.

### Type-split coverage maps

Beyond the channel-keyed coverage maps used for the timeline, the controller maintains **type-split** coverage maps for fast O(ranges) pre-checks inside the state machine. These avoid redundant IDB queries when the controller already knows coverage exists.

**IDB-sourced (loaded once per `loadLocalCoverage` call):**

| Variable | Type | Contents |
|----------|------|----------|
| `_idbVideoCov` | `$state<Record<channel, [start,end][]>>` | IDB coverage for `video/` segments |
| `_idbAudioCov` | `$state<Record<channel, [start,end][]>>` | IDB coverage for `audio/` segments |
| `_idbImageCov` | `$state<Record<channel, [start,end][]>>` | IDB coverage for `image/` segments |

Populated in a single IDB pass via `getCoverageByChannelSplit(originMonitor, typeFilter)`, which returns `{ merged, video, audio, image }` maps. The `merged` result goes to `_localCovByChannel`; the typed results go to the three split maps.

**In-memory derived (updated automatically as segments change):**

| Variable | Source | Structure |
|----------|--------|-----------|
| `_fetchedCovByType` | `$derived` from `fetchedSegs` | `Record<'video/'|'audio/'|'image/', Record<channel, [start,end][]>>` |
| `_loadedCovByType` | `$derived` from `playerSegs` | Same structure |

Built by `_buildTypeSplitCov(segs)` — a single pass that buckets each segment into the correct MIME type map.

**`_hasCovInRange(from, to, mimePrefix, src)`** — the unified coverage gate:

```typescript
function _hasCovInRange(
  from: number, to: number,
  mimePrefix: 'video/' | 'audio/' | 'image/',
  src: 'idb' | 'rtc' | 'fetched' | 'loaded'
): boolean
```

Selects the right map based on `src` and `mimePrefix`, then checks whether any range in any active channel overlaps `[from, to]`. Used by scrub preview to avoid IDB queries when coverage is already absent in memory. `src = 'rtc'` uses the merged `_remoteCovByChannel` (RTC does not expose type-split coverage).

### Coverage overlay deriveds

Two additional `$derived` values are computed from in-memory segment lists and passed to `TimelineSection` as overlay layers. They update live as segments are fetched or loaded, so the timeline brightens in real time to show progress:

| Variable | Source | Alpha layer |
|----------|--------|-------------|
| `_fetchedRtcCovByChannel` | `fetchedSegs` where `source === 'rtc'` | fetched overlay (+25%) |
| `_playerCovByChannel` | `playerSegs` | loaded overlay (+50%) |

These are purely derived — never written directly. They are grouped by `channelId ?? ''` and contain raw (non-merged) `[startTime, endTime]` ranges. The scrubber composites them on top of the base RTC/IDB layers.

The IDB split maps (`_idbVideoCov` etc.) feed the fourth timeline layer (`idbCoverageByChannel`) via `_localCovByChannel` (merged). Pass-through to the scrubber is: `rtcCoverageByChannel={_remoteCovByChannel}` `idbCoverageByChannel={_localCovByChannel}` `fetchedCoverageByChannel={_fetchedRtcCovByChannel}` `loadedCoverageByChannel={_playerCovByChannel}`.

### Timeline RTC bulk-action functions

| Function | Description |
|----------|-------------|
| `_tlFetchAllRtcFn()` | Fetches up to 200 segments from the monitor within `[viewStart, viewEnd]` via `requestSegmentsInRange` + `requestSegmentById`. Adds each to `fetchedSegs` incrementally (timeline overlay updates segment-by-segment). Guards `_tlFetchAllRtcLoading`. |
| `_tlSaveAllRtcFn()` | Iterates `fetchedSegs` and calls `saveSeg(i)` for every entry where `source === 'rtc'` and not already in `savedKeys`. Guards `_tlSaveAllRtcLoading`. |

State variables:

| Variable | Type | Role |
|----------|------|------|
| `_tlFetchAllRtcLoading` | `$state(boolean)` | Passed to `TimelineSection.fetchAllRtcLoading` |
| `_tlSaveAllRtcLoading` | `$state(boolean)` | Passed to `TimelineSection.saveRtcLoading` |
| `_tlRtcUnsavedCount` | `$derived(number)` | Count of `fetchedSegs` with `source === 'rtc'` and key not in `savedKeys` |

---

## Sync functions

### `_ctrlApplyChannels()` — channel sync point

Asserts `_ctrlActiveChannels` into `fetchChannelFilter`, `playerChannelFilter`, and `_tlActiveChannels`. Empty selection = all channels active; pushes all coverage keys so every chip shows "on".

Called at the start of state transitions that involve channels (scrub tick, after-scrub, channel toggle, end-of-play).

### `_ctrlApplyTypes()` — type sync point

Asserts `_ctrlActiveTypes` into `fetchTypeFilter`, `playerTypeFilter`, and `_tlActiveTypes`.

Called after scrubbing ends (to restore from the scrub-preview narrowing) and when the user toggles a type chip.

### Coverage `$effect` — channel chip display

```typescript
$effect(() => {
  const keys = Object.keys(coverageByChannel); // reactive dep
  untrack(() => {
    // Prune stale channels from controller selection
    if (_ctrlActiveChannels.some(ch => !keys.includes(ch)))
      _ctrlActiveChannels = _ctrlActiveChannels.filter(ch => keys.includes(ch));
    // Push display: empty selection = all "on"
    const visible = _ctrlActiveChannels.length > 0
      ? _ctrlActiveChannels.filter(ch => keys.includes(ch))
      : keys;
    _tlActiveChannels = visible.length > 0 ? visible : keys;
  });
});
```

This replaced the old auto-sync `$effect` that was in `TimelineSection`, which caused the channel-reset bug: every coverage refresh re-added all channels to `activeChannels`, overriding the controller's selection.

### Coverage race fix

`coverageByChannel` is a `$derived` merge of two independent sources:

```typescript
const coverageByChannel = $derived({ ..._remoteCovByChannel, ..._localCovByChannel });
```

`loadLocalCoverage` and `requestRemoteCoverage` run concurrently (via `fetchCoverage`). To prevent a transient gap where both sources are empty mid-cycle — which would prune `_ctrlActiveChannels` — the sources are kept independent:

- `loadLocalCoverage` only writes `_localCovByChannel`; it never touches `_remoteCovByChannel`
- `requestRemoteCoverage` does a full replacement of `_remoteCovByChannel` (not an incremental merge) so a stale previous result is never combined with a partial new result
- `fetchCoverage` clears `_remoteCovByChannel` only when RTC is disabled (`fetchSourceRtc = false`), not inside `loadLocalCoverage`

### `_ctrlPlayerHasContent`

```typescript
function _ctrlPlayerHasContent(pos: number): boolean {
  return playerSegs.some(s => s.startTime <= pos + 30 && s.endTime > pos);
}
```

The `s.endTime > pos` check is intentional and strict. A segment whose `endTime === pos` or `endTime < pos` has already ended — it cannot play at `pos` and must not suppress the sparse fetch. The earlier looser check (`endTime >= pos - 30`) allowed ended segments to satisfy this gate, causing the player to stall in last-frame with no content actually covering the cursor.

---

## State machine transitions

### User clicks a channel chip → `_ctrlOnChannelToggle(active)`

1. `_ctrlActiveChannels = active`
2. `_ctrlApplyChannels()` — push to filters + timeline
3. Evict all player segments (they may be from wrong channels)
4. `_ctrlAfterScrub()` — re-fetch for the new filter

### User clicks a type chip → `_ctrlOnTypeToggle(active)`

1. `_ctrlActiveTypes = new Set(active)`
2. `_ctrlApplyTypes()` — push to filters + timeline
3. Evict all player segments (they may be from wrong types)
4. `_ctrlAfterScrub()` — re-fetch for the new filter

### Pointer down on scrubber → `_ctrlOnScrubStart()`

1. `_isScrubbing = true`
2. Pause player if playing
3. Narrow `playerTypeFilter` to `['video/', 'image/']` (fast preview only — `_ctrlActiveTypes` preserves user intent)
4. Start 300ms interval → `_ctrlScrubTick()`

### 300ms scrub tick → `_ctrlScrubTick()`

1. `_ctrlApplyChannels()`
2. Read cursor from `Math.round(viewCenter)` (rounded to avoid float drift)
3. Expand player range (never evict during scrubbing) via `playerExpandRange`
4. If coverage exists at cursor and neighbor pictures are not already populated: call `_ctrlFetchScrubPreview(cursor)`

The scrub tick **does not write `playerPosition`**. Timeline scrubbing drives `viewCenter`; the player position is updated only via `playerSeekTo` (called from the `onSeekChange` callback that fires on every `viewCenter` change). This preserves the single-writer rule: `viewCenter` ↔ `playerPosition` are never cross-derived.

See `docs/controller-architecture.md` for the full single-writer rules.

`_ctrlFetchScrubPreview` fetches a lightweight visual preview in two phases:

**Phase 1 — cursor preview (image > video priority)**

1. Check `_hasCovInRange(cursor - SCRUB_PREVIEW_LOOKBACK_S, cursor, 'image/', 'idb')` — if IDB image coverage exists near cursor, query `getSegmentsBefore(cursor, 1, pubkey, ch, 'image/')` and load the result
2. If no IDB image found, check `_hasCovInRange(cursor - SCRUB_PREVIEW_LOOKBACK_S, cursor, 'video/', 'idb')` — if IDB video coverage exists, query `getSegmentsBefore(cursor, 1, pubkey, ch, 'video/')` and load the result
3. If nothing found in IDB and `fetchSourceRtc` enabled (rate-limited by `RTC_SCRUB_INTERVAL_MS`): try `requestSegment(cursor, ..., 'image/')` then `requestSegment(cursor, ..., 'video/')` as RTC fallback

Each found segment is added to a `skip` Set to prevent Phase 2 re-fetching the same segment.

**Phase 2 — neighbor picture population**

Runs after Phase 1 regardless of whether Phase 1 succeeded. Populates preview pictures on either side of the cursor:

1. `_hasCovInRange(cursor - SCRUB_NEIGHBOR_RADIUS_S, cursor, 'image/', 'idb')` → `getSegmentsBefore(cursor, 2, ..., 'image/')` (last 2 before cursor)
2. `_hasCovInRange(cursor, cursor + SCRUB_NEIGHBOR_RADIUS_S, 'image/', 'idb')` → `getSegmentsAfter(cursor, 1, ..., 'image/')` (first 1 after cursor)

Segments already in `skip` are not re-fetched. Each result is added to `fetchedSegs`.

The picture-first priority is intentional: photos are smaller payloads and the player's `playerShowLastFrame` capability means a loaded video segment from earlier in the scrub session continues to provide a visual still without refetching. Phase 2 ensures both a "before" and "after" preview picture exist so scrubbing feels responsive even in sparse footage.

`_ctrlHasPictureNear(pos)` — the gate for skipping Phase 2: returns true only when at least one photo exists BOTH before AND after `pos` within `±SCRUB_NEIGHBOR_RADIUS_S`. Video segments nearby do **not** suppress picture fetching.

### Pointer up → `_ctrlOnScrubEnd()` → `_ctrlAfterScrub()`

1. `_isScrubbing = false`
2. `_ctrlApplyTypes()` — restores `playerTypeFilter` from `_ctrlActiveTypes` (undoes scrub narrowing)
3. `_ctrlApplyChannels()`
4. Fetch coverage (if not already in flight)
5. If cursor is outside active-channel coverage: set status "no coverage at cursor", return
6. If player already has content near cursor: seek + resume play if `_userWantsToPlay`
7. Otherwise: **buffer fetch** (see below)

### Proactive buffer extension → 200ms tick

Every 200ms, while the player is playing and not scrubbing, the tick checks:

```
playerPosition + REFILL_TRIGGER_S > playerRangeTo
```

When this condition is true — fewer than `REFILL_TRIGGER_S` seconds of range remain — `_ctrlExtendBuffer()` is called. It sets `_ctrlFetching = true` synchronously before its first `await`, so the stall and end-of-play checks in the same tick see the guard and stay idle.

`_ctrlExtendBuffer()`:
1. Queries `getSegmentsInRange(playerRangeTo, playerRangeTo + BUFFER_FWD_S)` for all active types
2. Pushes new segments to `fetchedSegs`; tracks which types had IDB results
3. RTC anchor fallback (midpoint) for types absent from IDB
4. If anything was added: `playerExpandRange(playerRangeFrom, playerRangeTo + BUFFER_FWD_S)` + `playerAddSegs`
5. Logs `extend buffer: +N → range [from–to]` or `nothing found`

### End-of-play → 200ms tick (fallback)

The end-of-play transition fires when proactive extension could not keep the buffer topped up — i.e., there was genuinely nothing to load ahead.

**Normal stop**: `playerPlaying` goes true→false at `playerPosition >= playerRangeTo`.

**Last-frame stall** (`_lastFrameTicks`): the player is running (`playerPlaying = true`) but stuck showing the last video frame — no upcoming video segment exists within the loaded range. After 3 consecutive ticks (~600ms) in this state, the stall is treated as end-of-play. The jump-from point is `lastContentEnd` (the latest `endTime` of any loaded video segment) rather than `playerRangeTo`, since the range may have been over-expanded during scrubbing.

Both paths use `getSegmentsInRange` directly (same approach as the buffer fetch and `_ctrlExtendBuffer` — no `fetchCount` limit):
1. `_ctrlApplyChannels()`
2. Compute new window `[jumpFrom - BUFFER_BACK_S, jumpFrom + BUFFER_FWD_S]`
3. Range-query IDB for the new window; `playerSetRange` (evicts old content) + `playerAddSegs`
4. Resume play from `jumpFrom` if `_userWantsToPlay`

---

## Buffer fetch (after scrub)

When no content is loaded at the cursor, the controller loads the buffer window `[cursor − BUFFER_BACK_S, cursor + BUFFER_FWD_S]` from IDB, then falls back to RTC anchors for any types not found locally. The cursor is always `Math.round(viewCenter)` to avoid float values missing IDB range comparisons by a fraction of a second.

### Phase 1 — IDB full range load

`getSegmentsInRange(bStart, bEnd)` returns every segment that overlaps the buffer window, filtered to active types. All matching segments are loaded — this avoids the gaps that the previous 3-anchor approach produced (anchors were spaced 30s apart but segments can be 10s each, leaving segments between anchors unfetched).

Type priority after scrub: video and audio are loaded first because they're primary playback content; photos are loaded too since `getSegmentsInRange` returns them and the player already suppresses photos when video covers the same position.

### Phase 2 — RTC anchor fallback

For each active `MimePrefix` that had **no** IDB segments in the window, `_loadAnchorRtc` is called at `cursor−30s`, `cursor`, and `cursor+30s`. This covers the case where local IDB has no recording but the monitor is online.

`_loadAnchorRtc(t, mimePrefix)` calls `requestSegment(t, ...)` over WebRTC. Tries each active channel in turn; stops on first success. Logs `RTC [S-E]` or `RTC fail` via `_ctrlDbg`.

```typescript
// Phase 1: load all IDB segments in the buffer window
const rangeMetas = (await getSegmentsInRange(bStart, bEnd, pubkey, ch))
  .filter(m => [..._ctrlActiveTypes].some(p => m.mimeType.startsWith(p)));
// track which types had IDB results
for (const meta of rangeMetas) { /* load, mark idbFoundTypes */ }

// Phase 2: RTC anchors only for types not found in IDB
for (const mimePrefix of _ctrlActiveTypes) {
  if (idbFoundTypes.has(mimePrefix)) continue;
  await _loadAnchorRtc(cursor - 30, mimePrefix);
  await _loadAnchorRtc(cursor, mimePrefix);
  await _loadAnchorRtc(cursor + 30, mimePrefix);
}
```

Each IDB load is logged as `range IDB [S-E] type ch=...` and each RTC outcome as `anchor T type: RTC [S-E]` or `RTC fail` via `_ctrlDbg`.

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

---

## Logging

Controller events are logged via two thin wrappers around `dbg()` from `$lib/store/debug`:

```typescript
function _ctrlLog1(msg: string, payload?: unknown) { dbg('info', 'app', `[ctrl] ${msg}`, payload); }
function _ctrlDbg(msg: string, payload?: unknown)  { dbg('info', 'app', `[ctrl] ${msg}`, payload); }
```

`_ctrlLog1` is for key state-machine events (coverage fetch, sparse fetch start/done, end-of-play, no coverage). `_ctrlDbg` is for verbose per-call traces (`after-scrub cursor=...`, per-anchor IDB/RTC outcomes, `_ctrlPlayerHasContent` result).

All `[ctrl]` entries appear in the **Timeline Controller** section on the dev page — a collapsible `DevSection` containing a `LogPanel` filtered to `label.startsWith('[ctrl]')`. The Clear button in that panel clears the entire `debugLog` store (shared with all other log sources).
