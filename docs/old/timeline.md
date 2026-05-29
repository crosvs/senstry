# Timeline Components

## Overview

Two dumb UI components render the timeline and expose user gestures upward via callbacks. They own no application state — all values are props provided by `ContentViewerSection`.

- **`TimelineSection.svelte`** — toolbar, mode buttons, zoom controls, channel filter chips, the canvas scrubber, time footer labels
- **`TimelineScrubber.svelte`** — canvas that draws coverage lanes, alert markers, and handles pointer/wheel input

---

## TimelineSection

### Props

```typescript
interface Props {
  selectedMonitorPubkey?: string | null;
  /** All coverage data — always unfiltered so every channel lane stays visible */
  coverageByChannel?: Record<string, [number, number][]>;
  /** Split coverage layers for alpha-differentiated rendering (passed through to scrubber) */
  rtcCoverageByChannel?: Record<string, [number, number][]>;
  idbCoverageByChannel?: Record<string, [number, number][]>;
  fetchedCoverageByChannel?: Record<string, [number, number][]>;
  loadedCoverageByChannel?: Record<string, [number, number][]>;
  viewCenter?: number;           // $bindable — unix seconds at center of view
  viewSpan?: number;             // $bindable — seconds wide
  mode?: 'live' | 'view';       // $bindable
  liveTime?: number;             // current wall-clock unix seconds (drives live mode)
  isLiveConnected?: boolean;
  isOnline?: boolean;            // whether WebRTC connection is live (gates Fetch View button)
  onSeekChange?: (t: number) => void;
  onScrubStart?: () => void;     // fired on pointer-down
  onScrubEnd?: () => void;       // fired on pointer-up
  /** Fired ONLY when the user clicks a chip — NOT on coverage-driven changes */
  onChannelToggle?: (active: string[]) => void;
  /** $bindable — controller pushes its remembered selection back here */
  activeChannels?: string[];
  /** RTC bulk-action callbacks — when provided, show the action button row */
  onFetchAllRtc?: () => void;    // fetch all segments in current view window via RTC
  onSaveRtcToIdb?: () => void;   // save all fetched RTC segments to local IDB
  fetchAllRtcLoading?: boolean;
  saveRtcLoading?: boolean;
  rtcUnsavedCount?: number;      // # unsaved RTC segs (Save button shows only when > 0)
}
```

### Chip row

The chip row has two groups: **type chips** (Video / Audio / Photo, always visible) and **channel chips** (one per key in `coverageByChannel`, separated by a `|` divider). Both groups use the same `ch-chip` CSS with per-chip `--c` color variables.

Type chips use fixed colors (video = purple, audio = blue, photo = orange). Channel chips use the `PALETTE` rotation from `TimelineSection`.

`onTypeToggle` and `onChannelToggle` fire only on explicit user clicks — never when coverage data changes. The controller owns sync; these are pure event callbacks. `activeTypes` and `activeChannels` are `$bindable` — the controller pushes its remembered state back here.

The scrubber always receives `activeChannels={channelKeys}` (all keys), so every coverage lane remains visible regardless of which channels are active in the controller's filter.

### Controls

| Control | Effect |
|---------|--------|
| Live / Now button | Jumps `viewCenter` to `liveTime`, sets `mode = 'live'` |
| View button | Sets `mode = 'view'` |
| + / − buttons (header) | `viewSpan ÷ 2` / `viewSpan × 2`, clamped `[60s, 7d]` |
| Date input | Jumps to midnight of selected date, sets span to 1 day |
| Range input (`start-end`) | Sets `viewCenter` and `viewSpan` from raw unix timestamps |
| ⎘ Cursor / ⎘ Range | Copies cursor timestamp or `start-end` string to clipboard |

### RTC bulk-action buttons

When `onFetchAllRtc` is wired up (always the case when used from `ContentViewerSection`), an action row appears between the chip filters and the canvas:

- **"↓ Fetch View (RTC)"** — calls `onFetchAllRtc`. Disabled when `!isOnline` or `!selectedMonitorPubkey`. Shows spinner label `"⟳ Fetching…"` while `fetchAllRtcLoading` is true.
- **"💾 Save to IDB (N)"** — calls `onSaveRtcToIdb`. Only rendered when `rtcUnsavedCount > 0`. Shows `"⟳ Saving…"` while `saveRtcLoading` is true.

The row is hidden entirely when `onFetchAllRtc` is `undefined` and no unsaved segments exist, so it does not appear in standalone / legacy usages.

---

## TimelineScrubber

### Layout modes

**Landscape** (default, `isPortrait = false`):
- Horizontal time axis — left = older, right = newer
- One coverage lane per channel, stacked vertically
- Alert ticks drawn above lanes
- Canvas height = `L_ALERT_H(22) + L_LABEL_H(28) + channels × L_LANE_H(16)`

**Portrait** (`isPortrait = true`, set by `window.matchMedia('(orientation: portrait)')`):
- Time axis rotates 90° — top = older, bottom = newer
- Channels rendered side by side left-to-right
- Fixed 280px height; width split by channel count

### Multi-channel rendering

Each channel in `activeChannels` gets its own lane. Bars are drawn in up to four stacked alpha layers using the channel's color from `channelColors`. Alert markers from `alerts` are rendered as small colored ticks above the coverage lanes, colored by `detectionType`.

### Coverage alpha layers

When the controller supplies the split coverage props, each lane renders 4 composited layers instead of the legacy single layer. This makes fetch / buffer / download progress visible directly on the timeline without any separate indicator:

| Layer | Prop | Alpha | Meaning |
|-------|------|-------|---------|
| 1 | `rtcCoverageByChannel` | 25% (`'40'`) | Remote RTC coverage — footage exists on monitor, not yet fetched |
| 2 | `idbCoverageByChannel` | 50% (`'80'`) | Locally stored in IDB |
| 3 | `fetchedCoverageByChannel` | +25% overlay | Downloaded this session (in `fetchedSegs`, source `'rtc'`) |
| 4 | `loadedCoverageByChannel` | +50% overlay | Buffered into the player (`playerSegs`) |

Layers 3 and 4 are drawn on top of layers 1/2, so composite brightness reflects the full state:
- Monitor-only: faint tint (layer 1 only)
- IDB: moderate (layer 2)
- Downloaded to session: brighter (layers 1+3 or 2+3)
- Player-buffered: brightest (any base + layer 4)

When `rtcCoverageByChannel` / `idbCoverageByChannel` are absent (legacy usage), the scrubber falls back to the single `coverageByChannel` layer at `'70'` alpha.

### Coordinate helpers

```typescript
tToLX(t)  // unix time → landscape X pixel
tToPY(t)  // unix time → portrait Y pixel
lxToT(x)  // landscape X → unix time
pyToT(y)  // portrait Y → unix time
```

### Pointer interaction

| Event | Behaviour |
|-------|-----------|
| Pointer down | `onScrubStart?.()`, seek to tapped position, begin drag |
| Pointer move (dragging) | Seek continuously, clamped at `liveTime` |
| Pointer up | `onScrubEnd?.()` |
| Wheel / pinch | `onZoomIn` / `onZoomOut` |

### Props

```typescript
{
  viewStart: number;
  viewEnd: number;
  currentTime: number;
  liveTime: number;
  coverage?: [number, number][];                           // legacy single-channel fallback
  events?: StoredTriggerEvent[];                           // legacy
  coverageByChannel?: Record<string, [number, number][]>; // merged (controls lane layout + hints)
  activeChannels?: string[];
  channelColors?: Record<string, string>;
  alerts?: AlertRecord[];
  mode?: 'live' | 'view';
  isPortrait?: boolean;
  isLiveConnected?: boolean;
  // Layered coverage — when present, replaces single-layer rendering with 4-alpha system
  rtcCoverageByChannel?: Record<string, [number, number][]>;
  idbCoverageByChannel?: Record<string, [number, number][]>;
  fetchedCoverageByChannel?: Record<string, [number, number][]>;
  loadedCoverageByChannel?: Record<string, [number, number][]>;
  onSeek: (t: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}
```

Legacy `coverage` + `events` props are still accepted for backward compatibility with any remaining `TimelineView`-style usage; if `coverageByChannel` is non-empty it takes precedence.

---

## Extending the scrubber

- **New canvas element**: draw in `drawCanvas()` using `tToLX` / `tToPY` for time→pixel conversion
- **New toolbar control**: add to the `TimelineSection` toolbar; bind to `viewCenter`/`viewSpan`/`mode` props
- **New channel color**: colors come from the `PALETTE` array in `TimelineSection`; the scrubber receives them pre-resolved via `channelColors`
