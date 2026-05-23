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
  viewCenter?: number;           // $bindable — unix seconds at center of view
  viewSpan?: number;             // $bindable — seconds wide
  mode?: 'live' | 'view';       // $bindable
  liveTime?: number;             // current wall-clock unix seconds (drives live mode)
  isLiveConnected?: boolean;
  onSeekChange?: (t: number) => void;
  onScrubStart?: () => void;     // fired on pointer-down
  onScrubEnd?: () => void;       // fired on pointer-up
  /** Fired ONLY when the user clicks a chip — NOT on coverage-driven changes */
  onChannelToggle?: (active: string[]) => void;
  /** $bindable — controller pushes its remembered selection back here */
  activeChannels?: string[];
}
```

### Channel chip invariant

The chip row shows one button per key in `coverageByChannel`. The scrubber always receives `activeChannels={channelKeys}` (all keys), so every coverage lane remains visible regardless of which channels are active in the controller. Chip appearance reflects `activeChannels`; visual rendering is always complete.

`onChannelToggle` fires only on explicit user clicks, never when coverage data changes. This separation prevents coverage refreshes from resetting the user's selection.

### Controls

| Control | Effect |
|---------|--------|
| Live / Now button | Jumps `viewCenter` to `liveTime`, sets `mode = 'live'` |
| View button | Sets `mode = 'view'` |
| + / − buttons (header) | `viewSpan ÷ 2` / `viewSpan × 2`, clamped `[60s, 7d]` |
| Date input | Jumps to midnight of selected date, sets span to 1 day |
| Range input (`start-end`) | Sets `viewCenter` and `viewSpan` from raw unix timestamps |
| ⎘ Cursor / ⎘ Range | Copies cursor timestamp or `start-end` string to clipboard |

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

Each channel in `activeChannels` gets its own lane. Bars are drawn from `coverageByChannel[ch]` using the channel's color from `channelColors`. Alert markers from `alerts` are rendered as small colored ticks above the coverage lanes, colored by `detectionType`.

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
  coverage?: [number, number][];           // legacy single-channel fallback
  events?: StoredTriggerEvent[];           // legacy
  coverageByChannel?: Record<string, [number, number][]>;
  activeChannels?: string[];
  channelColors?: Record<string, string>;
  alerts?: AlertRecord[];
  mode?: 'live' | 'view';
  isPortrait?: boolean;
  isLiveConnected?: boolean;
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
