# Detectors

## Interface

All detectors implement `Detector<T>` from `detectors/types.ts`:

```typescript
interface Detector<T = Record<string, unknown>> {
  start(stream?: MediaStream): void;
  stop(): void;
  onDetection: ((event: DetectionEvent<T>) => void) | null;
  onFiringChange: ((firing: boolean) => void) | null;
}

interface DetectionEvent<T> {
  type: string;
  data: T;
  timestamp: number;   // unix seconds
}
```

`AudioDetector` extends this with `onStateChange` to expose the full sensor state machine.

Detectors are instantiated and managed by `SentrySection.svelte`. Each enabled `SensorConfig` gets one detector instance. Detectors are started when the monitor arms and stopped when it disarms.

## AudioDetector (`detectors/audio.ts`)

The most complex detector. Uses `Web Audio API` (`AudioContext` + `AnalyserNode`) to measure audio levels in real time.

### State Machine

```
idle ──avg crosses thresholdDb──▶ sensing
        │                            │
        │                     minDurationMs timer fires
        │                     (re-verify avg still ≥ threshold)
        │                            │
        │                          active ──avg drops below releaseThresholdDb──▶ settling
        │                                                                              │
        └─────────────────────────────── settlingMs timer fires ────────────────────▶ idle
                                         (fires onDetection if wasActive)
```

State is exposed via `onStateChange(SensorState)`:
- `sensing` — threshold crossed, waiting for duration
- `active` — sustained above threshold, links may fire
- `settling` — audio dropped, debounce before declaring idle
- `idle` — quiet

### Parameters

| Parameter | Source field | Description |
|-----------|-------------|-------------|
| `thresholdDb` | `SensorConfig.thresholdDb` | Activation level (rolling avg dBFS) |
| `releaseThresholdDb` | `SensorConfig.releaseThresholdDb` | Deactivation level (hysteresis lower bound). Defaults to `thresholdDb` for no hysteresis. |
| `minDurationMs` | `SensorConfig.minDurationMs` | How long avg must stay above threshold before transitioning to `active` |
| `settlingMs` | `SensorConfig.settlingMs` | How long avg must stay below `releaseThresholdDb` before declaring idle |

### Signal Processing

- FFT size: 2048 samples
- Each animation frame: compute instantaneous RMS → convert to dBFS (`20 * log10(rms)`)
- Rolling RMS history kept for `minDurationMs` window → compute average dBFS
- Threshold comparisons use the **rolling average**, not instantaneous peaks
- `peakDb` tracks instantaneous peak for reporting in `onDetection`

### Hysteresis

Setting `releaseThresholdDb < thresholdDb` creates a dead zone. Example:
- `thresholdDb = -24 dB`, `releaseThresholdDb = -45 dB`
- Sensor activates when avg ≥ −24 dB
- Sensor deactivates only when avg < −45 dB (not merely below −24 dB)
- Prevents rapid flapping near the activation threshold

### Detection Event Data

```typescript
interface AudioDetectionData {
  peakDb: number;    // instantaneous peak dBFS during the event
  durationMs: number; // total time from eventStart to lastAbove
}
```

## ScheduleDetector (`detectors/schedule.ts`)

Fires at a fixed interval. Used for periodic snapshots (e.g. timelapse).

- `intervalMs` — how often to fire
- Always in `active` state while monitor is armed (one-shot fire per interval)
- `onDetection` called on each interval; `onFiringChange(true)` briefly, then `(false)`

## TimeWindowDetector (`detectors/timewindow.ts`)

Active during specified hour slots of the week.

- `activeSlots: number[]` — each slot is `(dayOfWeek * 24 + hour)`, 0=Sunday 00:00 … 167=Saturday 23:00
- State is `active` during an active slot, `idle` outside
- Checks current time on an internal 1-minute interval
- `onStateChange` fires when transitioning between in-slot and out-of-slot

Useful for arming the monitor only at night or during specific hours.

## DateRangeDetector (`detectors/daterange.ts`)

Active between two ISO datetime strings.

- `startIso`, `endIso` — inclusive range
- State is `active` within range, `idle` outside
- Checks current time on a 1-minute interval

Useful for temporary monitoring (vacation, event window).

## NostrTriggerDetector (`detectors/nostr-trigger.ts`)

Fires when a kind 5010 trigger event is received from a specific monitor pubkey.

- `monitorPubkey` — which monitor to listen to
- `nostrChannelId` — optional channel filter
- `detectionTypes` — optional array of detection type strings to filter on

This allows chaining: a viewer device acts as a monitor that fires on events from another monitor — forwarding or escalating alerts.

## Photo Capture (`detectors/photo.ts`)

Not a sensor — a helper for `SnapshotAction`. Captures a frame from a `MediaStream` video track using `ImageCapture` (or canvas fallback) and returns it as a `Blob`.

```typescript
capturePhoto(stream: MediaStream, options: PhotoOptions): Promise<Blob>
```

Used by `SentrySection` when a `SnapshotAction` is active. The resulting blob is saved via `saveSegment` with `mimeType: 'image/jpeg'` (or whichever format is configured).

## Wiring in SentrySection

Each sensor gets a detector instance based on `SensorConfig.type`. Detectors are started against the appropriate `MediaStream` from `openStreams` (keyed by `sourceId`).

When `onStateChange` fires:
1. `sensorStates[sensor.id]` is updated
2. `_evaluateLinks()` runs to check if any link conditions are now met
3. `_handleSensorStateForNotify()` runs to check `NotifyAction.publishStates`
4. `_updateChannelActiveSources()` runs if a `RecordAction` changed state

The `SentrySection` is the single source of truth for runtime detector and action state. All state (`sensorStates`, `actionStates`) flows up to `+page.svelte` via `$bindable` props and is passed down to `SettingsSection` for display.
