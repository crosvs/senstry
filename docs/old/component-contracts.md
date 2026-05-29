# Component Contracts

This document specifies the contracts for all dumb components in Senstry. A **dumb component** is a passive display surface that owns no state, makes no decisions, and renders what it is told. It fires callbacks when users interact with it, never on data changes.

All components follow Svelte 5 rune syntax (`$state`, `$derived`, `$props`, `$bindable`).

---

## Architecture Principle

Controllers own all state and logic. Components are pure rendering surfaces that:
- Receive props (read-only or `$bindable`)
- Fire callbacks on user gestures only
- Never read sibling component state
- Never perform side effects (IDB queries, Nostr publishes, WebRTC actions)
- Never mutate props directly unless they are `$bindable`

Violating these boundaries makes the system hard to test, reason about, and evolve.

---

## SettingsSection

**Role**: Editor UI for the entire capture pipeline and app settings (sources, sensors, captures, channels, actions, links, relay config, storage cleanup).

**Props received** (all read-only):
- `activeAlerts?: AlertSession[]` — alert sessions from SentrySection, used only in the summary snippet to show active clip count

**State it owns** (all local, never persisted):
- `localSources`, `localSensors`, `localCaptures`, `localChannels`, `localActions`, `localLinks` — in-memory copies of pipeline config
- `localRelayUrl`, `localSelfLabel`, `localNostrRateLimit`, `localRtcIdleTimeoutS` — in-memory copies of settings
- `localStorageCleanup` — in-memory copy of storage cleanup config
- `audioDevices`, `videoDevices` — enumerated media devices
- `showRaw`, `saveFlash`, `saveError` — transient UI state
- `gridDrag` — in-progress grid drag state for timewindow sensor
- `loadingDevices`, `pinUnits` — ephemeral UI state

**Lifecycle**:
- On mount: loads all pipeline config, general settings, storage cleanup config, and enumerates media devices
- No automatic saves — user must click "Save" to persist changes
- Reset button offers one-click reset to defaults

**Events fired** (none — all mutations go through onMount + user clicks):
- User edits are purely local until "Save" is clicked
- "Save" button calls `savePipeline()`, `saveSettings()`, `saveStorageCleanup()` directly
- "Reset" button calls those save functions with default values

**Forbidden**:
- Never read `$sensorStates` or `$actionStates` directly (those are for the summary badge calculation, which is allowed)
- Never subscribe to stores other than the four passed-in stores (settings, pairedDevices via sources editor)
- Never call Nostr functions
- Never manage WebRTC connections
- Never call detector or action lifecycle functions
- Never perform IDB queries or OPFS operations
- Defer all pipeline instantiation logic to `SentrySection`

**Example**:
```svelte
<!-- Read props, local state, and fire events -->
<script>
  let { activeAlerts = [] }: Props = $props();
  let localSources = $state([]);
  
  // On mount, load from stores
  onMount(async () => {
    localSources = (await loadPipeline()).sources;
  });
  
  // User click triggers save
  async function save() {
    await savePipeline({ sources: localSources, ... });
  }
</script>

<button onclick={save}>Save</button>
```

---

## LiveViewSection

**Role**: WebRTC live video viewer with channel selection and live/stop controls.

**Props received** (all read-only):
- `selectedMonitorPubkey?: string | null` — currently selected device for live view; if not set, "Connect via Devices first" message shown

**State it owns**:
- `liveVideoEl` — ref to `<video>` element
- `liveStatus`, `liveLoading` — transient state for "Going live…", "✓ Live", "✗ Failed" messages

**Effects**:
- Syncs `$remoteStream` to video element's `srcObject` when video element exists

**Events fired** (user gestures only):
- User clicks "Watch Live" → calls `startLiveView()` (passes identity, pubkey, monitor pubkey, channel ID)
- User clicks "Stop Live" → calls `disconnectViewer(selectedMonitorPubkey)`
- User clicks "Cancel" during connection → calls `cancelConnect(selectedMonitorPubkey)`
- User clicks fullscreen icon → calls `liveVideoEl.requestFullscreen()`
- User selects channel from dropdown → calls `selectChannel(channelId)`

**Forbidden**:
- Never manage the WebRTC connection directly — only call the three functions above
- Never write to `$viewerConnection` — read it to display status, but don't mutate it
- Never make async calls that don't follow the pattern shown (check identity before calling)
- Never fetch segments or coverage data

**Data sources**:
- `$identity` — own keypair (checked before starting connection)
- `$viewerConnection` — read-only connection status (status, mode, channelId, channels list, error)
- `$remoteStream` — incoming MediaStream from WebRTC peer
- Props: `selectedMonitorPubkey`

**Example**:
```svelte
<script>
  async function handleGoLive() {
    if (!$identity || !selectedMonitorPubkey || !vc.channelId) return;
    liveLoading = true;
    try {
      await startLiveView($identity.privkey, $identity.pubkey, selectedMonitorPubkey, vc.channelId);
      liveStatus = '✓ Live';
    } catch (e) {
      liveStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally {
      liveLoading = false;
    }
  }
</script>

<video bind:this={liveVideoEl} autoplay playsinline></video>
<button onclick={handleGoLive} disabled={liveLoading || !vc.channelId}>
  {liveLoading ? 'Connecting…' : 'Watch Live'}
</button>
```

---

## AlertsSection

**Role**: Display all received alerts (Nostr trigger events) from paired monitors in a scrollable list.

**Props received** (all read-only):
- None — all data comes from stores

**State it owns**:
- `requestingPerm` — transient UI state for permission request button

**Subscriptions** (read-only):
- `$identity` — own keypair (checked before starting listener)
- `$pairedDevices` — device list (used to extract pubkeys for listener)
- `$listenerActive` — whether listener is running
- `$notifPermission` — browser notification permission state
- `$alertLog` — array of all received alerts
- `$unreadCount` — count of unread alerts

**Events fired**:
- User clicks "Start Listening" / "Stop Listening" → calls `startAlertListener()` or `stopAlertListener()`
- User clicks "Enable Notifications" → calls `requestNotifPermission()`
- User clicks "Mark read" → calls `markAllRead()`
- User clicks alert row → calls `markRead(alert.id)`
- User clicks "Clear" → calls `clearAlerts()`
- User clicks "⟲ Footage" chip on alert → calls `navigator.clipboard.writeText(alert.footageRefId)`

**Forbidden**:
- Never manage the listener directly — only call the two functions above
- Never publish Nostr events
- Never fetch segments or coverage
- Never mutate `$alertLog` directly
- Never call WebRTC functions
- Never make decisions based on alert content (that's ContentViewerSection's job if they click "View Footage")

**Example**:
```svelte
<script>
  function toggleListener() {
    if ($listenerActive) {
      stopAlertListener();
    } else {
      startAlertListener($identity.privkey, $identity.pubkey, new Set($pairedDevices.map(d => d.pubkey)));
    }
  }
</script>

<button onclick={toggleListener}>
  {$listenerActive ? 'Stop Listening' : 'Start Listening'}
</button>

{#each $alertLog as alert (alert.id)}
  <div class="alert-row" onclick={() => markRead(alert.id)}>
    {fmtTs(alert.timestamp)} · {alert.detectionType}
  </div>
{/each}
```

---

## DevicesSection

**Role**: Display paired devices, own device, orphaned devices (with stored data). Manage connection, selection, unpair, clear data, request status.

**Props received**:
- `selectedMonitorPubkey?: string | null` — `$bindable` — currently selected device for viewing
- `fetchedCountByMonitor?: Record<string, number>` — in-memory count of fetched-but-not-saved segments per device (passed to clear handlers)
- `onClearFetchedForMonitor?: (pubkey: string) => void` — callback to clear in-memory fetched segments for a device

**State it owns**:
- `stats` — computed per-device stats (storage bytes, segment count, alert count) — computed once on mount and on pairedDevices/identity changes
- `orphanedPubkeys` — device pubkeys with stored data but no pairing record
- `loading` — transient state for stats refresh
- `rtcTick` — timer tick for RTC session polling and rate-limit countdown
- `statusActions` — map of `useNostrAction` instances, one per device, for status-request buttons

**Subscriptions** (read-only):
- `$identity` — own keypair
- `$pairedDevices` — paired devices (used to build device list, determine orphans)
- `$nostrOnline`, `$nostrOfflineReason` — Nostr connection status
- `$peerStatuses` — peer online/offline state (received via Nostr signals)
- `$viewerConnection` — RTC connection state for selected device (status, error, mode, channels)
- `$relayRateLimits` — active rate limits (displayed on own device card)
- `$settings` — relay URL (used to enable/disable "Go Online" button)

**Events fired**:
- User clicks "Refresh" → calls `loadAllStats()` (IDB queries allowed for display purposes)
- User clicks "Go Online" or "● Online" button → calls `goOnline()` or `goOffline()`
- User clicks "Status?" → fires `useNostrAction` with `sendSignal()` (status-request message)
- User clicks "Connect" → calls `connectToMonitor()`
- User clicks "Cancel" during connection → calls `cancelConnect()`
- User clicks "Disconnect" → calls `disconnectViewer()`
- User clicks "Unpair" → asks confirmation, calls `removePairedDevice()`
- User clicks "Clear" data → asks confirmation, calls `clearForMonitor()`, `clearFootageRefsForMonitor()`, `cleanupOrphanedOpfsFiles()`
- User clicks "Clear Fetched" → calls `onClearFetchedForMonitor?.(pubkey)`
- User clicks "View" / "▶ Viewing" → sets `selectedMonitorPubkey` via $bindable

**Forbidden**:
- Never read ContentViewerSection state
- Never manage WebRTC connections beyond calling the three functions (connect/cancel/disconnect)
- Never call IDB functions beyond `loadAllStats()` for display
- Never publish Nostr events other than via `useNostrAction` (which is allowed)
- Never mutate `selectedMonitorPubkey` except via the $bindable binding
- Never call OPFS functions directly — only via `cleanupOrphanedOpfsFiles()`

**Example**:
```svelte
<script>
  let { selectedMonitorPubkey = $bindable(null) }: Props = $props();

  async function unpair(pubkey: string) {
    const dev = $pairedDevices.find(d => d.pubkey === pubkey);
    if (!confirm(`Unpair "${dev?.nickname}"?`)) return;
    await removePairedDevice(pubkey);
    if (selectedMonitorPubkey === pubkey) selectedMonitorPubkey = null;
  }

  async function handleConnect(pk: string) {
    try { await connectToMonitor($identity.privkey, $identity.pubkey, pk); }
    catch { /* status written to store */ }
  }
</script>

{#each $pairedDevices as dev (dev.pubkey)}
  <button onclick={() => (selectedMonitorPubkey = dev.pubkey)}>
    {selectedMonitorPubkey === dev.pubkey ? '▶ Viewing' : 'View'}
  </button>
  <button onclick={() => handleConnect(dev.pubkey)}>Connect</button>
  <button onclick={() => unpair(dev.pubkey)}>Unpair</button>
{/each}
```

---

## SegmentStorageSection

**Role**: Display storage usage, segment explorer, alerts/footage refs browser, manual eviction/pinning controls.

**Props received**:
- `selectedMonitorPubkey?: string | null` — device to scope storage view to; if null, shows own device

**State it owns**:
- `usedMb`, `totalSegments`, `quotaUsedMb`, `quotaTotalMb` — storage stats
- `segGroups` — grouped segments by date for explorer
- `segLoading`, `segChannelFilter`, `segDate`, `segRangeTs` — segment explorer UI state
- `fetchedAlerts`, `alertsLoading`, `alertsStatus`, `alertsDate`, `alertsRangeTs` — alerts browser state
- `nostrSub` — Nostr subscription handle (held to allow cleanup; see onDestroy)
- `coverageRaw`, `showCoverage`, `rawSegIds`, `rawAlertIds` — debug/raw data state
- `sendingKeys`, `savingKeys` — UI state for manual segment operations

**Subscriptions** (read-only):
- `$identity` — own pubkey
- `$pairedDevices` — list of paired devices (used to display device-specific data)

**Events fired** (user gestures only):
- User clicks "Refresh" → calls `refreshStats()`, `loadSegments()`
- User clicks segment → calls `togglePin()` (which calls `pinSegment()` or `unpinSegment()`)
- User clicks delete icon on segment → asks confirmation, calls `deleteSegment()`
- User enters date range and clicks load → calls `loadSegments()` (IDB query)
- User clicks channel filter → updates local `segChannelFilter`, re-runs `loadSegments()`
- User clicks load alerts → calls `loadAlertsIdb()`, optionally `subscribe()` for Nostr footage refs
- Nostr subscription fires → updates `fetchedAlerts` with new refs
- User clicks delete on alert → asks confirmation, calls `softDeleteFootageRef()`
- User clicks send on alert → calls `sendSignal()` to notify monitor (if implemented)

**Forbidden**:
- Never call ContentViewerSection functions
- Never manage WebRTC connections
- Never mutate `$pairedDevices`
- Never read player state or timeline state
- IDB queries are allowed (segment explorer, stats) but must respect `effectivePubkey` (selectedMonitorPubkey ?? identity.pubkey)
- Nostr subscriptions are allowed for pull-based alert listing, but must be closed on mount/unmount or when selectedMonitorPubkey changes

**Example**:
```svelte
<script>
  const effectivePubkey = $derived(selectedMonitorPubkey ?? $identity?.pubkey ?? null);

  async function refreshStats() {
    const bytes = await getStorageUsed(effectivePubkey ?? undefined);
    usedMb = Math.round(bytes / (1024 * 1024));
  }

  async function loadSegments() {
    const [from, to] = parseRange(segRangeTs);
    const segs = await getSegmentsInRange(from, to, effectivePubkey ?? undefined, segChannelFilter || undefined);
    // ... group and display
  }

  async function togglePin(seg: Segment) {
    if (seg.pinned) {
      await unpinSegment(seg.segmentId);
    } else {
      await pinSegment(seg.segmentId);
    }
  }
</script>
```

---

## ContentViewerSection (Controller, not a dumb component)

**Role**: Master state machine for content playback (timeline + player). Owns all fetch logic, state transitions, coverage maps, scrub preview fetching. Drives both the Timeline and Player as passive surfaces.

This is **NOT a dumb component** — it is the controller. It owns state and logic.

**Key invariants** (enforced by design):
- Player state (`playerPosition`, `playerSegs`, `playerPlaying`) is **never** read by TimelineSection
- Timeline state (`viewCenter`, `viewSpan`, `mode`) is **never** read by Player or scrub logic
- Both clocks start from the same position at the same moment and run independently afterward
- No `await` between sync points when starting both clocks
- `playerPosition` is only written by `playerSeekTo()` and `_playerTick`
- Coverage maps are built from independent sources (IDB, RTC, fetched, loaded) and never overwrite each other
- `_ctrlApplyChannels()` is called synchronously at the top of every state handler

**See `docs/controller-architecture.md` for full state machine, sync protocol, and forbidden patterns.**

---

## TimelineSection

**Role**: UI layer for timeline navigation (scrubber, channel chips, type chips, mode toggle, zoom controls, fetch buttons). Owns view window and display mode, drives player through callbacks.

**Props received** (all read-only except `$bindable`):
- `selectedMonitorPubkey?: string | null` — used only to filter displayed alerts
- `coverageByChannel?: Record<string, [number, number][]>` — merged coverage (IDB + RTC)
- `rtcCoverageByChannel?: Record<string, [number, number][]>` — RTC-only coverage (layer 1, lowest alpha)
- `idbCoverageByChannel?: Record<string, [number, number][]>` — IDB-only coverage (layer 2, mid alpha)
- `fetchedCoverageByChannel?: Record<string, [number, number][]>` — fetched RTC segments not yet saved (layer 3, higher alpha)
- `loadedCoverageByChannel?: Record<string, [number, number][]>` — segments currently loaded in player (layer 4, highest alpha)
- `viewCenter?: number` — `$bindable` — timeline center position (unix seconds)
- `viewSpan?: number` — `$bindable` — timeline width in seconds
- `mode?: 'live' | 'view'` — `$bindable` — 'live' = always at liveTime, 'view' = user seeking
- `liveTime?: number` — wall-clock now (unix seconds), updated by controller's 200ms timer
- `isLiveConnected?: boolean` — whether RTC stream is active (used for visual indicator)
- `isOnline?: boolean` — whether viewer is connected (used to disable fetch buttons)
- `onSeekChange?: (t: number) => void` — fired when user drags scrubber; receives exact cursor position
- `onScrubStart?: () => void` — fired when user presses down on scrubber
- `onScrubEnd?: () => void` — fired when user releases scrubber
- `activeChannels?: string[]` — `$bindable` — chip state for channel toggles
- `onChannelToggle?: (active: string[]) => void` — fired when user clicks channel chip
- `activeTypes?: string[]` — `$bindable` — chip state for type toggles ('video/', 'audio/', 'image/')
- `onTypeToggle?: (active: string[]) => void` — fired when user clicks type chip
- `onFetchAllRtc?: () => void` — fetch all segments in current view window via RTC
- `onSaveRtcToIdb?: () => void` — save fetched RTC segments to IDB
- `fetchAllRtcLoading?: boolean`, `saveRtcLoading?: boolean` — loading state for those buttons
- `rtcUnsavedCount?: number` — number of fetched RTC segments waiting to be saved

**State it owns**:
- `isPortrait` — orientation detection
- No other persistent state; all display values are derived from props

**Events fired** (user gestures only, never on prop changes):
- `onSeekChange(t)` — on pointer move during scrub drag or when user clicks a specific time
- `onScrubStart()` — on pointer down
- `onScrubEnd()` — on pointer up
- `onChannelToggle(activeChannels)` — on channel chip click
- `onTypeToggle(activeTypes)` — on type chip click
- `onFetchAllRtc()` — on fetch button click
- `onSaveRtcToIdb()` — on save button click

**Forbidden**:
- Never read `playerPosition`, `playerSegs`, `playerPlaying`, or any player state
- Never call player functions directly (only fire callbacks)
- Never mutate props except through $bindable bindings
- Never perform IDB queries
- Never trigger RTC operations beyond calling callback functions
- Never derive state from coverage data changes (only fire callbacks on explicit user interaction)
- Never reset `activeChannels` on coverage refresh (only `onChannelToggle` and device switch write it)

**Scrubber interactions**:
- Pointer down (inside scrubber track) → `onScrubStart()`, then start firing `onSeekChange()` on every pointer move, then `onScrubEnd()` on pointer up
- Click on track (not on thumb) → instant `onSeekChange()` to that position
- Scrubber thumb drag → continuous `onSeekChange()` events

**Example**:
```svelte
<script lang="ts">
  interface Props {
    viewCenter?: number;
    viewSpan?: number;
    mode?: 'live' | 'view';
    activeChannels?: string[];
    onSeekChange?: (t: number) => void;
    onChannelToggle?: (active: string[]) => void;
  }
  let {
    viewCenter = $bindable(Math.floor(Date.now() / 1000)),
    viewSpan = $bindable(2 * 3600),
    mode = $bindable('live'),
    activeChannels = $bindable([]),
    onSeekChange,
    onChannelToggle,
  }: Props = $props();

  function toggleChannel(id: string) {
    activeChannels = activeChannels.includes(id)
      ? activeChannels.filter((c) => c !== id)
      : [...activeChannels, id];
    onChannelToggle?.(activeChannels);
  }

  function onSeek(t: number) {
    viewCenter = t;
    onSeekChange?.(t);
  }
</script>

<button onclick={() => toggleChannel('ch-1')}>
  {activeChannels.includes('ch-1') ? '✓' : '○'} Channel 1
</button>
<TimelineScrubber {viewCenter} {viewSpan} {liveTime} {onSeek} {onScrubStart} {onScrubEnd} />
```

---

## TimelineScrubber

**Role**: Canvas-based scrubber widget. Displays coverage lanes (one per channel), alert markers, and a draggable cursor. Converts pointer events into seek callbacks.

**Props received** (all read-only):
- `viewStart: number` — timeline window start (unix seconds)
- `viewEnd: number` — timeline window end
- `currentTime: number` — playhead position (for cursor line)
- `liveTime: number` — wall-clock now (right edge, never seekable past)
- `mode?: 'live' | 'view'` — 'live' = cursor line at right edge; 'view' = cursor at currentTime
- `isLiveConnected?: boolean` — visual indicator on cursor line
- `coverageByChannel?: Record<string, [number, number][]>` — coverage intervals per channel
- `activeChannels?: string[]` — which channels to render (lanes)
- `channelColors?: Record<string, string>` — color per channel
- `rtcCoverageByChannel`, `idbCoverageByChannel`, `fetchedCoverageByChannel`, `loadedCoverageByChannel` — layered coverage (rendered with different alpha)
- `alerts?: AlertRecord[]` — alert markers to display on timeline
- `isPortrait?: boolean` — portrait mode uses smaller layout
- `onSeek: (t: number) => void` — fired on pointer move or click
- `onScrubStart?: () => void` — fired on pointer down
- `onScrubEnd?: () => void` — fired on pointer up

**State it owns**:
- `canvas` — ref to canvas element
- `containerEl` — ref to container div (for size measurement)
- `cw` — canvas width (measured from container on mount/resize)
- `dragging` — whether pointer is down and dragging
- `dragStart`, `dragStartCenter` — used for drag delta calculation

**Effects**:
- On mount and on container resize: measure width, set canvas size, trigger redraw
- Pointer move during drag: call `onSeek()` with mapped cursor position
- Pointer up: set `dragging = false`, call `onScrubEnd()`
- Click on canvas (not drag): call `onSeek()` with click position

**Events fired**:
- `onSeek(t)` — on pointer move during drag or click (receives exact unix time)
- `onScrubStart()` — on pointer down
- `onScrubEnd()` — on pointer up

**Rendering**:
- Canvas is redrawn whenever props change (via `$effect(() => { redraw(); [deps] })`)
- Four layers: RTC coverage, IDB coverage, fetched coverage, loaded coverage (from lowest to highest alpha/importance)
- One lane per active channel
- Alert markers at top
- Cursor line (vertical) at `currentTime` position
- Connection indicator (dot) on cursor in live mode

**Forbidden**:
- Never call player functions
- Never perform IDB queries
- Never call WebRTC functions
- Never mutate props
- Never read TimelineSection state (pure canvas component)

**Example**:
```svelte
<script>
  let {
    viewStart,
    viewEnd,
    currentTime,
    liveTime,
    coverageByChannel = {},
    onSeek,
    onScrubStart,
    onScrubEnd,
  }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let dragging = $state(false);

  function redraw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    // Draw coverage lanes, alerts, cursor
  }

  $effect(() => {
    redraw();
  });

  function handlePointerDown(e: PointerEvent) {
    dragging = true;
    onScrubStart?.();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragging) return;
    const x = e.clientX - canvas!.getBoundingClientRect().left;
    const t = viewStart + (x / canvas!.width) * (viewEnd - viewStart);
    onSeek(Math.round(t));
  }

  function handlePointerUp() {
    dragging = false;
    onScrubEnd?.();
  }
</script>

<canvas bind:this={canvas} onpointerdown={handlePointerDown} onpointermove={handlePointerMove} onpointerup={handlePointerUp} />
```

---

## FetchPanel (inline in ContentViewerSection, not a separate component)

The content fetch controls (time range inputs, channel/type filters, coverage buttons) are inline UI in the ContentViewerSection template. They are **not a separate dumb component** — they are part of the controller and bind directly to controller state.

**Why inline**:
- Tightly coupled to controller state transitions (fetch requests mutate `_ctrlFetching`, coverage maps)
- No boundary needed; they are pure UI extensions of the controller

**What they display**:
- Time range inputs: fetch start/end (unix seconds or ISO date)
- Channel filter toggles: restrict RTC fetch to specific channels (if multi-device viewers are implemented)
- Coverage request buttons: "Fetch all (RTC)" and "Save to IDB"
- Loading indicators: show while RTC fetch is in progress

---

## Summary Table: State Ownership

| Variable | Owned by | Read by | Notes |
|----------|----------|---------|-------|
| `viewCenter`, `viewSpan`, `mode` | TimelineSection (user drags/mode button) | ContentViewerSection (reads to derive layout) | `$bindable` to controller |
| `activeChannels`, `activeTypes` | TimelineSection (chip clicks) | ContentViewerSection (applies via `_ctrlApplyChannels`) | `$bindable` |
| `playerPosition`, `playerSegs`, `playerPlaying` | ContentViewerSection | Player rendering only; never read by TimelineSection | Sealed subsystem |
| `liveTime` | ContentViewerSection 200ms timer | TimelineSection (display + sync) | Read-only in components |
| `playerRangeFrom`, `playerRangeTo` | ContentViewerSection | Player end-of-range detection | Sealed subsystem |
| `coverageByChannel` (all 5 variants) | ContentViewerSection (IDB, RTC, fetch, load queries) | TimelineSection for display; scrub logic for gates | Derived from sources |
| `selectedMonitorPubkey` | DevicesSection (user click View button) | DevicesSection (select), SegmentStorageSection (scope), TimelineSection (alert filter) | `$bindable` |
| `fetchedCountByMonitor` | ContentViewerSection (tracks in-memory count) | DevicesSection (display + clear), passed from parent | `$bindable` |

---

## Testing Strategy

Dumb components can be unit tested with happy-dom (no browser):

```typescript
// SettingsSection.test.ts
test('should save pipeline when Save button clicked', async () => {
  const { getByText } = render(SettingsSection, {
    props: { activeAlerts: [] },
  });
  
  // User edits input
  const input = document.querySelector('input[placeholder="Source name"]');
  input.value = 'New Name';
  
  // User clicks Save
  getByText('Save').click();
  
  // Assert savePipeline was called (mock it at the test level)
});

// TimelineSection.test.ts
test('should call onSeekChange when user drags scrubber', async () => {
  const onSeekChange = vi.fn();
  const { container } = render(TimelineSection, {
    props: {
      viewCenter: 1000,
      viewSpan: 3600,
      onSeekChange,
    },
  });
  
  const scrubber = container.querySelector('.scrubber');
  // Simulate drag
  scrubber.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100 }));
  scrubber.dispatchEvent(new PointerEvent('pointermove', { clientX: 150 }));
  scrubber.dispatchEvent(new PointerEvent('pointerup'));
  
  // Assert onSeekChange was called with calculated time
  expect(onSeekChange).toHaveBeenCalled();
});
```

Controllers (like ContentViewerSection) are tested in integration tests with full browser context, including real IDB and WebRTC mock.

---

## Refactoring Opportunities

1. **Extract Player as a component**: Currently inline in ContentViewerSection. Could become a dumb component with an interface function instead of a state object. Benefit: clearer testing, easier to refactor.

2. **Extract FetchPanel as a component**: Currently inline. Could fire callbacks instead of mutating controller state directly. Benefit: separation of concerns.

3. **Extract SentrySection controller**: Currently 1200+ lines with no unit tests. Should extract `DetectorController`, `ActionController`, `RecordingController` as pure TS classes. See `docs/plans/sentry-controller.md`.

4. **Multi-view mode**: Split ContentViewerSection into two independent instances (one per device) with their own state. Requires careful boundary between shared UI (alert listener) and device-scoped playback.
