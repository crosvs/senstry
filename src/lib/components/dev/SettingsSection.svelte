<script lang="ts">
  import { settings, saveSettings, loadSettings } from '$lib/store/settings';
  import {
    sources, sensors, captures, actions, channels, links, loadPipeline, savePipeline,
    storageCleanup, loadStorageCleanup, saveStorageCleanup,
    newSource, newSensor, newCapture, newChannel,
    newLink, newRecordAction, newClipAction, newSnapshotAction, newNotifyAction,
    DEFAULT_SOURCES, DEFAULT_SENSORS, DEFAULT_CAPTURES, DEFAULT_CHANNELS, DEFAULT_ACTIONS, DEFAULT_LINKS,
    DEFAULT_STORAGE_CLEANUP,
    autoNameSensor, autoNameCapture, autoNameAction, autoNameChannel, autoNameLink,
    type SourceConfig, type SensorConfig, type CaptureMethod, type ChannelConfig,
    type Action, type RecordAction, type ClipAction, type SnapshotAction, type NotifyAction,
    type Link, type SensorState, type ActionState, type StorageCleanupConfig, type ThinningRule,
  } from '$lib/store/pipeline';
  import type { AlertSession } from './SentrySection.svelte';
  import { pairedDevices } from '$lib/store/identity';
  import DevSection from './DevSection.svelte';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';

  interface Props {
    sensorStates?: Record<string, SensorState>;
    actionStates?: Record<string, ActionState>;
    activeAlerts?: AlertSession[];
  }
  let { sensorStates = {}, actionStates = {}, activeAlerts = [] }: Props = $props();

  let showRaw = $state(false);
  let saveFlash = $state(false);
  let saveError = $state('');

  // Pipeline local state
  let localSources  = $state<SourceConfig[]>([]);
  let localSensors  = $state<SensorConfig[]>([]);
  let localCaptures = $state<CaptureMethod[]>([]);
  let localChannels = $state<ChannelConfig[]>([]);
  let localActions  = $state<Action[]>([]);
  let localLinks    = $state<Link[]>([]);

  // General settings local state
  let localRelayUrl        = $state('');
  let localSelfLabel       = $state('Monitor');
  let localPauseNostr      = $state(false);
  let localNostrRateLimit  = $state(200);
  let localRtcIdleTimeoutS = $state(120);

  // Storage cleanup local state
  let localStorageCleanup = $state<StorageCleanupConfig>({ ...DEFAULT_STORAGE_CLEANUP });

  const THIN_AGE_PRESETS = [
    { label: '30 min', s: 1800 }, { label: '1 hour', s: 3600 }, { label: '6 hours', s: 21600 },
    { label: '12 hours', s: 43200 }, { label: '1 day', s: 86400 }, { label: '3 days', s: 259200 },
    { label: '1 week', s: 604800 },
  ] as const;

  const THIN_RATE_PRESETS = [
    { label: '1 per 30s', s: 30 }, { label: '1 per min', s: 60 },
    { label: '1 per 5min', s: 300 }, { label: '1 per 15min', s: 900 },
    { label: '1 per hour', s: 3600 }, { label: '1 per 6h', s: 21600 },
  ] as const;

  const THIN_TYPE_PRESETS = [
    { label: 'All types', prefix: '' },
    { label: 'Photos',    prefix: 'image/' },
    { label: 'Video',     prefix: 'video/' },
    { label: 'Audio',     prefix: 'audio/' },
  ] as const;

  function addThinningRule() {
    localStorageCleanup = {
      ...localStorageCleanup,
      thinningRules: [...localStorageCleanup.thinningRules, { afterAgeSec: 3600, keepOnePerSec: 60, mimePrefix: '' }],
    };
  }

  function removeThinningRule(i: number) {
    localStorageCleanup = {
      ...localStorageCleanup,
      thinningRules: localStorageCleanup.thinningRules.filter((_, idx) => idx !== i),
    };
  }

  function updateThinningRule(i: number, patch: Partial<ThinningRule>) {
    localStorageCleanup = {
      ...localStorageCleanup,
      thinningRules: localStorageCleanup.thinningRules.map((r, idx) => idx === i ? { ...r, ...patch } : r),
    };
  }

  // Device picker
  let audioDevices = $state<MediaDeviceInfo[]>([]);
  let videoDevices = $state<MediaDeviceInfo[]>([]);
  let loadingDevices = $state(false);

  async function loadDevices(mediaType: 'audio' | 'video') {
    loadingDevices = true;
    try {
      // Request permission so enumerateDevices returns real labels
      const stream = await navigator.mediaDevices.getUserMedia(
        mediaType === 'audio' ? { audio: true } : { video: true }
      );
      stream.getTracks().forEach(t => t.stop());
    } catch { /* permission denied — still re-enumerate what we can */ }
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      audioDevices = devs.filter(d => d.kind === 'audioinput');
      videoDevices = devs.filter(d => d.kind === 'videoinput');
    } catch { /* ignore */ }
    loadingDevices = false;
  }

  onMount(async () => {
    await Promise.all([loadPipeline(), loadSettings(), loadStorageCleanup()]);
    localSources  = get(sources).map(s => ({ ...s }));
    localSensors  = get(sensors).map(s => ({ ...s }));
    localCaptures = get(captures).map(c => ({ ...c }));
    localChannels = get(channels).map(c => ({ ...c }));
    localActions  = get(actions).map(a => ({ ...a }));
    localLinks    = get(links).map(l => ({ ...l }));
    const s = get(settings);
    localRelayUrl        = s.relayUrl;
    localSelfLabel       = s.selfLabel;
    localPauseNostr      = s.pauseNostr;
    localNostrRateLimit  = s.nostrRateLimit;
    localRtcIdleTimeoutS = Math.round(s.rtcIdleTimeoutMs / 1000);
    localStorageCleanup = { ...get(storageCleanup) };
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      audioDevices = devs.filter(d => d.kind === 'audioinput');
      videoDevices = devs.filter(d => d.kind === 'videoinput');
    } catch { /* permissions not yet granted */ }
  });

  async function save() {
    saveError = '';
    try {
      await savePipeline({
        sources:  $state.snapshot(localSources),
        sensors:  $state.snapshot(localSensors),
        captures: $state.snapshot(localCaptures),
        channels: $state.snapshot(localChannels),
        actions:  $state.snapshot(localActions),
        links:    $state.snapshot(localLinks),
      });
      await saveSettings({
        ...get(settings),
        relayUrl:         localRelayUrl,
        selfLabel:        localSelfLabel,
        pauseNostr:       localPauseNostr,
        nostrRateLimit:   localNostrRateLimit,
        rtcIdleTimeoutMs: localRtcIdleTimeoutS * 1000,
      });
      await saveStorageCleanup({
        ...localStorageCleanup,
        thinningRules: localStorageCleanup.thinningRules.map(r => ({ ...r })),
      });
      saveFlash = true;
      setTimeout(() => (saveFlash = false), 1500);
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    }
  }

  async function resetDefault() {
    if (!confirm('Reset pipeline and general settings to defaults?')) return;
    localSources  = DEFAULT_SOURCES.map(s => ({ ...s }));
    localSensors  = DEFAULT_SENSORS.map(s => ({ ...s }));
    localCaptures = DEFAULT_CAPTURES.map(c => ({ ...c }));
    localChannels = DEFAULT_CHANNELS.map(c => ({ ...c }));
    localActions  = DEFAULT_ACTIONS.map(a => ({ ...a }));
    localLinks    = DEFAULT_LINKS.map(l => ({ ...l }));
    const { DEFAULT_RELAY } = await import('$lib/store/settings');
    localRelayUrl        = DEFAULT_RELAY;
    localPauseNostr      = false;
    localNostrRateLimit  = 200;
    localRtcIdleTimeoutS = 120;
    localStorageCleanup  = {
      ...DEFAULT_STORAGE_CLEANUP,
      thinningRules: DEFAULT_STORAGE_CLEANUP.thinningRules.map(r => ({ ...r })),
    };
    await save();
  }

  const TYPE_COLORS: Record<string, string> = {
    microphone: '#2563eb', camera: '#7c3aed', screen: '#0e7490',
    audio: '#2563eb', schedule: '#0891b2', timewindow: '#0891b2', daterange: '#0891b2', 'nostr-trigger': '#9333ea',
    video: '#7c3aed', photo: '#059669',
    record: '#d97706', clip: '#0f766e', snapshot: '#059669', notify: '#9333ea',
  };
  const TYPE_LABELS: Record<string, string> = {
    microphone: 'MIC', camera: 'CAM', screen: 'SCRN',
    audio: 'AUDIO', schedule: 'TIMER', timewindow: 'TIME', daterange: 'DATE', 'nostr-trigger': 'NOSTR',
    video: 'VIDEO', photo: 'PHOTO',
    record: 'RECORD', clip: 'CLIP', snapshot: 'SNAP', notify: 'NOTIFY',
  };

  // Live state polling
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 150);
    return () => clearInterval(id);
  });

  function sensorBadge(id: string): { label: string; kind: string } {
    const s = sensorStates[id];
    if (!s || s.status === 'inactive') return { label: 'INACTIVE', kind: 'inactive' };
    if (s.status === 'idle') {
      if (s.nextFireAt != null) {
        const rem = Math.max(0, (s.nextFireAt - now) / 1000);
        return { label: `NEXT ${rem.toFixed(0)}s`, kind: 'idle' };
      }
      return { label: 'IDLE', kind: 'idle' };
    }
    if (s.status === 'sensing') {
      const el = (now - s.startedAt) / 1000;
      const mn = s.minDurationMs / 1000;
      return { label: `SENSING ${el.toFixed(1)}/${mn.toFixed(1)}s`, kind: 'sensing' };
    }
    if (s.status === 'active')
      return { label: `ACTIVE ${((now - s.startedAt) / 1000).toFixed(1)}s`, kind: 'active' };
    const rem = Math.max(0, (s.endsAt - now) / 1000);
    return { label: `SETTLING ${rem.toFixed(1)}s`, kind: 'settling' };
  }

  function actionBadge(id: string): { label: string; kind: string } {
    const s = actionStates[id];
    if (!s || s.status === 'idle') return { label: 'IDLE', kind: 'idle' };
    if (s.status === 'active')
      return { label: `ACTIVE ${((now - s.startedAt) / 1000).toFixed(1)}s`, kind: 'active' };
    const rem = Math.max(0, (s.endsAt - now) / 1000);
    return { label: `COOLDOWN ${rem.toFixed(1)}s`, kind: 'cooldown' };
  }

  const PIN_UNITS = [
    { label: 'minutes', s: 60 },
    { label: 'hours',   s: 3600 },
    { label: 'days',    s: 86400 },
    { label: 'weeks',   s: 604800 },
    { label: 'months',  s: 2592000 },
    { label: 'years',   s: 31536000 },
  ] as const;
  type PinUnit = typeof PIN_UNITS[number]['label'];

  let pinUnits = $state<Record<string, PinUnit>>({});

  function bestPinUnit(sec: number): PinUnit {
    for (const u of [...PIN_UNITS].toReversed()) {
      if (sec >= u.s && sec % u.s === 0) return u.label;
    }
    return 'minutes';
  }

  function pinUnit(id: string, sec: number | null): PinUnit {
    return pinUnits[id] ?? (sec != null && sec > 0 ? bestPinUnit(sec) : 'days');
  }

  function pinUnitSec(id: string, sec: number | null): number {
    return PIN_UNITS.find(u => u.label === pinUnit(id, sec))?.s ?? 86400;
  }

  function patchCapture(id: string, patch: Record<string, unknown>) {
    localCaptures = localCaptures.map(c => c.id === id ? { ...c, ...patch } as CaptureMethod : c);
  }

  function compatibleSources(captureType: CaptureMethod['type']): SourceConfig[] {
    if (captureType === 'audio') return localSources.filter(s => s.type === 'microphone');
    return localSources.filter(s => s.type === 'camera' || s.type === 'screen');
  }

  function sourceOptionLabel(src: SourceConfig): string {
    const tag = src.type === 'microphone' ? 'MIC' : src.type === 'camera' ? 'CAM' : 'SCRN';
    return `[${tag}] ${src.name}`;
  }

  function captureSourceId(cap: CaptureMethod): string {
    const compat = compatibleSources(cap.type);
    return compat.find(s => s.id === cap.sourceId) ? cap.sourceId : (compat[0]?.id ?? cap.sourceId);
  }

  const _an = {
    sensor:  (s: SensorConfig)  => autoNameSensor(s, localSources),
    capture: (c: CaptureMethod) => autoNameCapture(c, localSources),
    action:  (a: Action)        => autoNameAction(a, localCaptures, localChannels, localSources),
    channel: (c: ChannelConfig) => autoNameChannel(c, localSources),
    link:    (l: Link)          => autoNameLink(l, localSensors, localActions, localSources),
  };

  // ── Availability grid (time-window sensor) ─────────────────────────────────
  const GRID_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let gridDrag: { sensorId: string; turnOn: boolean } | null = null;

  function gridSlotActive(sen: SensorConfig, slot: number): boolean {
    return (sen.activeSlots ?? []).includes(slot);
  }

  function gridSetSlot(sen: SensorConfig, slot: number, on: boolean) {
    const current = sen.activeSlots ?? [];
    const has = current.includes(slot);
    if (on === has) return;
    sen.activeSlots = on
      ? [...current, slot].sort((a, b) => a - b)
      : current.filter(s => s !== slot);
    localSensors = localSensors.map(s => s.id === sen.id ? { ...sen, activeSlots: [...(sen.activeSlots ?? [])] } : s);
  }

  function gridPointerDown(e: PointerEvent, sen: SensorConfig, slot: number) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const on = !gridSlotActive(sen, slot);
    gridDrag = { sensorId: sen.id, turnOn: on };
    gridSetSlot(sen, slot, on);
  }

  function gridPointerEnter(sen: SensorConfig, slot: number) {
    if (!gridDrag || gridDrag.sensorId !== sen.id) return;
    gridSetSlot(sen, slot, gridDrag.turnOn);
  }

  function gridPointerUp() { gridDrag = null; }

  function gridSelectAll(sen: SensorConfig) {
    sen.activeSlots = Array.from({ length: 168 }, (_, i) => i);
    localSensors = localSensors.map(s => s.id === sen.id ? { ...sen, activeSlots: [...(sen.activeSlots ?? [])] } : s);
  }
  function gridClear(sen: SensorConfig) {
    sen.activeSlots = [];
    localSensors = localSensors.map(s => s.id === sen.id ? { ...sen, activeSlots: [] } : s);
  }
</script>

<DevSection title="Settings">
  {#snippet summary()}
    {#if Object.values(sensorStates).some(s => s.status === 'active')}
      ACTIVE · {Object.values(sensorStates).filter(s => s.status === 'active').length} sensor{Object.values(sensorStates).filter(s => s.status === 'active').length === 1 ? '' : 's'}
    {:else if activeAlerts.length > 0}
      CLIP · {activeAlerts.length} active
    {:else}
      {localSensors.length} sensor{localSensors.length === 1 ? '' : 's'} · {localLinks.length} link{localLinks.length === 1 ? '' : 's'}
    {/if}
  {/snippet}
  {#snippet actions()}
    <button class="act-btn" onclick={() => (showRaw = !showRaw)}>{showRaw ? 'Hide' : 'View'} Raw</button>
    <button class="act-btn danger" onclick={resetDefault}>Reset</button>
    <button class="act-btn accent" onclick={save}>{saveFlash ? '✓ Saved' : 'Save'}</button>
  {/snippet}

  {#if saveError}
    <div class="save-error">Save failed: {saveError}</div>
  {/if}

  {#if showRaw}
    <pre class="raw">{JSON.stringify({ settings: $settings, sources: localSources, sensors: localSensors, captures: localCaptures, actions: localActions, channels: localChannels, links: localLinks, storageCleanup: localStorageCleanup }, null, 2)}</pre>
  {/if}

  <!-- ── Sources ──────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Sources</span>
    <div class="add-btn-group">
      <button class="add-btn" onclick={() => localSources = [...localSources, newSource('microphone')]}>+ Microphone</button>
      <button class="add-btn" onclick={() => localSources = [...localSources, newSource('camera')]}>+ Camera</button>
      <button class="add-btn" onclick={() => localSources = [...localSources, newSource('screen')]}>+ Screen</button>
    </div>
  </div>
  {#each localSources as src (src.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge" style="background:{TYPE_COLORS[src.type] ?? '#64748b'}">{TYPE_LABELS[src.type] ?? src.type}</span>
        <input class="name-input" bind:value={src.name} placeholder="Source name" />
        <button class="rm-btn" onclick={() => localSources = localSources.filter(s => s.id !== src.id)}>✕</button>
      </div>
      <div class="card-body">
        {#if src.type !== 'screen'}
          <div class="field-row">
            <span class="field-lbl">Device</span>
            <select class="field-select" value={src.deviceId}
              onchange={(e) => { src.deviceId = (e.target as HTMLSelectElement).value; }}>
              <option value="">Default</option>
              {#each (src.type === 'camera' ? videoDevices : audioDevices) as dev}
                <option value={dev.deviceId}>{dev.label || dev.deviceId.slice(0, 14) + '…'}</option>
              {/each}
            </select>
            <button
              class="load-devs-btn"
              onclick={() => loadDevices(src.type === 'camera' ? 'video' : 'audio')}
              disabled={loadingDevices}
              title="Enumerate available devices (grants permission if needed)"
            >{loadingDevices ? '…' : '⟳'}</button>
          </div>
        {/if}
        {#if src.type === 'camera'}
          <label class="field-row">
            <span class="field-lbl">Width</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="auto"
              value={src.videoWidth ?? ''}
              oninput={(e) => { src.videoWidth = +(e.target as HTMLInputElement).value || undefined; }} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Height</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="auto"
              value={src.videoHeight ?? ''}
              oninput={(e) => { src.videoHeight = +(e.target as HTMLInputElement).value || undefined; }} />
          </label>
          <label class="field-row">
            <span class="field-lbl">FPS</span>
            <input class="num-input" type="number" min="1" max="120" step="1" placeholder="auto"
              value={src.frameRate ?? ''}
              oninput={(e) => { src.frameRate = +(e.target as HTMLInputElement).value || undefined; }} />
          </label>
        {:else if src.type === 'microphone'}
          <label class="field-row">
            <span class="field-lbl">Sample rate</span>
            <select class="field-select" value={src.audioSampleRate ?? 0}
              onchange={(e) => { src.audioSampleRate = +(e.target as HTMLSelectElement).value || undefined; }}>
              <option value={0}>Auto</option>
              <option value={8000}>8 kHz</option>
              <option value={16000}>16 kHz</option>
              <option value={22050}>22.05 kHz</option>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
            </select>
          </label>
        {:else if src.type === 'screen'}
          <label class="field-row">
            <span class="field-lbl">FPS</span>
            <input class="num-input" type="number" min="1" max="60" step="1" placeholder="auto"
              value={src.frameRate ?? ''}
              oninput={(e) => { src.frameRate = +(e.target as HTMLInputElement).value || undefined; }} />
          </label>
          <div class="field-hint full-row">Browser picks screen/window/tab at capture time. Audio captured if browser supports it.</div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty">No sources.</div>
  {/each}

  <!-- ── Sensors ──────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Sensors</span>
    <div class="add-btn-group">
      <button class="add-btn" onclick={() => localSensors = [...localSensors, newSensor(localSources[0]?.id ?? 'default-mic', 'audio')]}>+ Audio</button>
      <button class="add-btn" onclick={() => localSensors = [...localSensors, newSensor('none', 'schedule')]}>+ Timer</button>
      <button class="add-btn" onclick={() => localSensors = [...localSensors, newSensor('none', 'timewindow')]}>+ Time Window</button>
      <button class="add-btn" onclick={() => localSensors = [...localSensors, newSensor('none', 'daterange')]}>+ Date Range</button>
      <button class="add-btn" onclick={() => localSensors = [...localSensors, newSensor('none', 'nostr-trigger')]}>+ Nostr</button>
    </div>
  </div>
  {#each localSensors as sen (sen.id)}
    {@const sb = sensorBadge(sen.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge" style="background:{TYPE_COLORS[sen.type] ?? '#64748b'}">{TYPE_LABELS[sen.type] ?? sen.type}</span>
        <input class="name-input" bind:value={sen.name} placeholder={_an.sensor(sen)} />
        <span class="state-badge {sb.kind}">{sb.label}</span>
        <button class="toggle-pill" style="background:{sen.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => { sen.enabled = !sen.enabled; }}>
          <span class="pill-thumb" style="transform:translateX({sen.enabled ? '14px' : '2px'})"></span>
        </button>
        <button class="rm-btn" onclick={() => localSensors = localSensors.filter(s => s.id !== sen.id)}>✕</button>
      </div>
      <div class="card-body">
        {#if sen.type === 'audio'}
          <label class="field-row">
            <span class="field-lbl">Source</span>
            <select class="field-select" value={sen.sourceId}
              onchange={(e) => { sen.sourceId = (e.target as HTMLSelectElement).value; }}>
              {#each localSources.filter(s => s.type === 'microphone' || s.type === 'screen') as src}
                <option value={src.id}>{sourceOptionLabel(src)}</option>
              {/each}
            </select>
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Threshold: {sen.thresholdDb} dBFS</span>
            <input type="range" min="-70" max="-10" step="1" value={sen.thresholdDb}
              oninput={(e) => { sen.thresholdDb = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Release: {sen.releaseThresholdDb ?? sen.thresholdDb} dBFS</span>
            <input type="range" min="-70" max="-10" step="1" value={sen.releaseThresholdDb ?? sen.thresholdDb}
              oninput={(e) => { sen.releaseThresholdDb = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Avg window: {(sen.minDurationMs / 1000).toFixed(2)}s</span>
            <input type="range" min="0" max="5000" step="250" value={sen.minDurationMs}
              oninput={(e) => { sen.minDurationMs = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Settling: {(sen.settlingMs / 1000).toFixed(1)}s</span>
            <input type="range" min="100" max="10000" step="100" value={sen.settlingMs}
              oninput={(e) => { sen.settlingMs = +(e.target as HTMLInputElement).value; }} />
          </label>

        {:else if sen.type === 'schedule'}
          <label class="field-row">
            <span class="field-lbl">Interval</span>
            <div class="num-with-unit">
              <input class="num-input" type="number" min="1" step="1"
                value={Math.round((sen.intervalMs ?? 60_000) / 1000)}
                oninput={(e) => { sen.intervalMs = +(e.target as HTMLInputElement).value * 1000; }} />
              <span class="unit">s</span>
            </div>
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Active duration: {(sen.settlingMs / 1000).toFixed(1)}s</span>
            <input type="range" min="100" max="5000" step="100" value={sen.settlingMs}
              oninput={(e) => { sen.settlingMs = +(e.target as HTMLInputElement).value; }} />
          </label>

        {:else if sen.type === 'timewindow'}
          <div class="avail-wrap full-row">
            <div class="avail-header-row">
              <div class="avail-day-stub"></div>
              {#each Array.from({ length: 24 }, (_, h) => h) as h}
                <div class="avail-hr-lbl">{h % 6 === 0 ? String(h).padStart(2, '0') : ''}</div>
              {/each}
            </div>
            {#each GRID_DAYS as dayName, d}
              <div class="avail-row">
                <div class="avail-day-lbl">{dayName}</div>
                {#each Array.from({ length: 24 }, (_, h) => h) as h}
                  {@const slot = d * 24 + h}
                  {@const active = gridSlotActive(sen, slot)}
                  <div class="avail-cell" class:active
                    role="checkbox" aria-checked={active} tabindex="-1"
                    onpointerdown={(e) => gridPointerDown(e, sen, slot)}
                    onpointerenter={() => gridPointerEnter(sen, slot)}
                    onpointerup={gridPointerUp}></div>
                {/each}
              </div>
            {/each}
            <div class="avail-footer">
              <span class="field-hint-inline">{(sen.activeSlots ?? []).length} active hour-slot{(sen.activeSlots ?? []).length !== 1 ? 's' : ''}</span>
              <button class="link-btn" onclick={() => gridSelectAll(sen)}>All</button>
              <button class="link-btn" onclick={() => gridClear(sen)}>None</button>
              <button class="link-btn" onclick={() => {
                const weekdays = [1,2,3,4,5]; const s: number[] = [];
                for (const d of weekdays) for (let h = 0; h < 24; h++) s.push(d * 24 + h);
                sen.activeSlots = s;
                localSensors = localSensors.map(x => x.id === sen.id ? { ...sen, activeSlots: [...s] } : x);
              }}>Weekdays</button>
              <button class="link-btn" onclick={() => {
                const nights = [0,1,2,3,4,5,6]; const s: number[] = [];
                for (const d of nights) for (const h of [22,23,0,1,2,3,4,5]) {
                  const effectiveD = h < 6 ? (d + 1) % 7 : d;
                  s.push(effectiveD * 24 + h);
                }
                const uniq = [...new Set(s)].sort((a, b) => a - b);
                sen.activeSlots = uniq;
                localSensors = localSensors.map(x => x.id === sen.id ? { ...sen, activeSlots: [...uniq] } : x);
              }}>Nights</button>
            </div>
          </div>

        {:else if sen.type === 'daterange'}
          <div class="field-row full-row">
            <span class="field-lbl">Start</span>
            <input class="datetime-input" type="datetime-local" value={sen.startIso ?? ''}
              onchange={(e) => { sen.startIso = (e.target as HTMLInputElement).value; }} />
          </div>
          <div class="field-row full-row">
            <span class="field-lbl">End</span>
            <input class="datetime-input" type="datetime-local" value={sen.endIso ?? ''}
              onchange={(e) => { sen.endIso = (e.target as HTMLInputElement).value; }} />
          </div>
          <div class="field-hint full-row">One-time activation between these datetimes. Becomes permanently inactive after the end.</div>

        {:else if sen.type === 'nostr-trigger'}
          <label class="field-row full-row">
            <span class="field-lbl">Listen to</span>
            <select class="field-select" value={sen.monitorPubkey ?? ''}
              onchange={(e) => { sen.monitorPubkey = (e.target as HTMLSelectElement).value; }}>
              <option value="">— select device —</option>
              {#each $pairedDevices as dev}
                <option value={dev.pubkey}>{dev.nickname || dev.pubkey.slice(0, 16) + '…'}</option>
              {/each}
            </select>
          </label>
          {#if sen.monitorPubkey && !$pairedDevices.find(d => d.pubkey === sen.monitorPubkey)}
            <div class="field-hint full-row warn">Pubkey not in paired devices — enter manually below.</div>
            <label class="field-row full-row">
              <span class="field-lbl">Pubkey</span>
              <input class="name-input flex1" type="text" placeholder="npub or hex pubkey"
                value={sen.monitorPubkey}
                oninput={(e) => { sen.monitorPubkey = (e.target as HTMLInputElement).value.trim(); }} />
            </label>
          {/if}
          <label class="field-row full-row">
            <span class="field-lbl">Channel filter</span>
            <input class="name-input flex1" type="text" placeholder="Any channel"
              value={sen.nostrChannelId ?? ''}
              oninput={(e) => { sen.nostrChannelId = (e.target as HTMLInputElement).value.trim() || null; }} />
          </label>
          <label class="field-row full-row">
            <span class="field-lbl">Detection types</span>
            <input class="name-input flex1" type="text" placeholder="Any (comma-separated to filter)"
              value={(sen.detectionTypes ?? []).join(', ')}
              oninput={(e) => {
                const v = (e.target as HTMLInputElement).value.trim();
                sen.detectionTypes = v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
              }} />
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Hold: {(sen.minDurationMs / 1000).toFixed(1)}s</span>
            <input type="range" min="0" max="10000" step="100" value={sen.minDurationMs}
              oninput={(e) => { sen.minDurationMs = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Settle: {(sen.settlingMs / 1000).toFixed(1)}s</span>
            <input type="range" min="0" max="30000" step="500" value={sen.settlingMs}
              oninput={(e) => { sen.settlingMs = +(e.target as HTMLInputElement).value; }} />
          </label>
          <div class="field-hint full-row">Receives Nostr trigger events from the selected device. Hold waits before going active; settle keeps the sensor active after the remote goes idle, preventing flicker.</div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty">No sensors.</div>
  {/each}

  <!-- ── Capture Methods ──────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Capture Methods</span>
    <div class="add-btn-group">
      <button class="add-btn" onclick={() => localCaptures = [...localCaptures, newCapture(localSources.find(s => s.type === 'microphone')?.id ?? 'default-mic', 'audio')]}>+ Audio</button>
      <button class="add-btn" onclick={() => localCaptures = [...localCaptures, newCapture(localSources.find(s => s.type === 'camera')?.id ?? 'default-cam', 'video')]}>+ Video</button>
      <button class="add-btn" onclick={() => localCaptures = [...localCaptures, newCapture(localSources.find(s => s.type === 'camera')?.id ?? 'default-cam', 'photo')]}>+ Photo</button>
    </div>
  </div>
  {#each localCaptures as cap (cap.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge" style="background:{TYPE_COLORS[cap.type] ?? '#64748b'}">{TYPE_LABELS[cap.type] ?? cap.type}</span>
        <input class="name-input" bind:value={cap.name} placeholder={_an.capture(cap)} />
        <button class="rm-btn" onclick={() => localCaptures = localCaptures.filter(c => c.id !== cap.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row">
          <span class="field-lbl">Source</span>
          <select class="field-select" value={captureSourceId(cap)}
            onchange={(e) => patchCapture(cap.id, { sourceId: (e.target as HTMLSelectElement).value })}>
            {#each compatibleSources(cap.type) as src}
              <option value={src.id}>{sourceOptionLabel(src)}</option>
            {/each}
          </select>
        </label>
        {#if cap.type === 'video'}
          <label class="field-row">
            <span class="field-lbl">Codec</span>
            <select class="field-select" value={cap.videoCodec}
              onchange={(e) => patchCapture(cap.id, { videoCodec: (e.target as HTMLSelectElement).value })}>
              <option value="">Auto</option>
              <option value="video/webm;codecs=vp9,opus">VP9 + Opus</option>
              <option value="video/webm;codecs=vp8,opus">VP8 + Opus</option>
              <option value="video/webm">WebM auto</option>
            </select>
          </label>
          <label class="field-row">
            <span class="field-lbl">Width</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="auto"
              value={cap.videoWidth || ''}
              oninput={(e) => patchCapture(cap.id, { videoWidth: +(e.target as HTMLInputElement).value })} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Height</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="auto"
              value={cap.videoHeight || ''}
              oninput={(e) => patchCapture(cap.id, { videoHeight: +(e.target as HTMLInputElement).value })} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Video kbps</span>
            <input class="num-input" type="number" min="0" step="100" placeholder="auto"
              value={cap.videoBitsPerSec ? Math.round(cap.videoBitsPerSec / 1000) : ''}
              oninput={(e) => patchCapture(cap.id, { videoBitsPerSec: (+(e.target as HTMLInputElement).value || 0) * 1000 })} />
          </label>
        {:else if cap.type === 'audio'}
          <label class="field-row">
            <span class="field-lbl">Audio kbps</span>
            <input class="num-input" type="number" min="0" step="8"
              value={cap.audioBitsPerSec ? Math.round(cap.audioBitsPerSec / 1000) : ''}
              oninput={(e) => patchCapture(cap.id, { audioBitsPerSec: (+(e.target as HTMLInputElement).value || 0) * 1000 })} />
          </label>
          <label class="field-row">
            <span class="field-lbl">MIME type</span>
            <input class="name-input" type="text" placeholder="auto" value={cap.mimeType}
              oninput={(e) => patchCapture(cap.id, { mimeType: (e.target as HTMLInputElement).value })} />
          </label>
        {:else}
          <label class="field-row">
            <span class="field-lbl">Width (px)</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="native"
              value={cap.imageWidth || ''}
              oninput={(e) => patchCapture(cap.id, { imageWidth: +(e.target as HTMLInputElement).value })} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Height (px)</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="native"
              value={cap.imageHeight || ''}
              oninput={(e) => patchCapture(cap.id, { imageHeight: +(e.target as HTMLInputElement).value })} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Quality</span>
            <input class="num-input" type="number" min="0.05" max="1" step="0.05" value={cap.imageQuality}
              oninput={(e) => patchCapture(cap.id, { imageQuality: +(e.target as HTMLInputElement).value })} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Format</span>
            <select class="field-select" value={cap.imageFormat}
              onchange={(e) => patchCapture(cap.id, { imageFormat: (e.target as HTMLSelectElement).value })}>
              <option value="image/jpeg">JPEG</option>
              <option value="image/webp">WebP</option>
              <option value="image/png">PNG</option>
            </select>
          </label>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty">No capture methods.</div>
  {/each}

  <!-- ── Channels ──────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Channels</span>
    <button class="add-btn" onclick={() => localChannels = [...localChannels, newChannel()]}>+ Add</button>
  </div>
  <div class="field-hint full-row" style="margin-bottom:4px">A channel groups sources for Live RTC and footage tagging. The default sources below are used as a live fallback when no recording link is active for the channel.</div>
  {#each localChannels as ch (ch.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge channel">CH</span>
        <input class="name-input" bind:value={ch.name} placeholder={_an.channel(ch)} />
        <button class="rm-btn" onclick={() => localChannels = localChannels.filter(c => c.id !== ch.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row">
          <span class="field-lbl">Default video</span>
          <select class="field-select" value={ch.videoSourceId ?? ''}
            onchange={(e) => { ch.videoSourceId = (e.target as HTMLSelectElement).value || null; }}>
            <option value="">None</option>
            {#each localSources.filter(s => s.type === 'camera' || s.type === 'screen') as src}
              <option value={src.id}>{sourceOptionLabel(src)}</option>
            {/each}
          </select>
        </label>
        <label class="field-row">
          <span class="field-lbl">Default audio</span>
          <select class="field-select" value={ch.audioSourceId ?? ''}
            onchange={(e) => { ch.audioSourceId = (e.target as HTMLSelectElement).value || null; }}>
            <option value="">None</option>
            {#each localSources.filter(s => s.type === 'microphone' || s.type === 'screen') as src}
              <option value={src.id}>{sourceOptionLabel(src)}</option>
            {/each}
          </select>
        </label>
      </div>
    </div>
  {:else}
    <div class="empty">No channels. Add one to enable channel-based Live RTC.</div>
  {/each}

  <!-- ── Actions ──────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Actions</span>
    <div class="add-btn-group">
      <button class="add-btn" onclick={() => localActions = [...localActions, newRecordAction(localChannels[0]?.id ?? 'default-channel')]}>+ Record</button>
      <button class="add-btn" onclick={() => localActions = [...localActions, newClipAction(localChannels[0]?.id ?? 'default-channel')]}>+ Clip</button>
      <button class="add-btn" onclick={() => localActions = [...localActions, newSnapshotAction(localChannels[0]?.id ?? 'default-channel')]}>+ Snapshot</button>
      <button class="add-btn" onclick={() => localActions = [...localActions, newNotifyAction()]}>+ Notify</button>
    </div>
  </div>
  {#each localActions as act (act.id)}
    {@const ab = actionBadge(act.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge" style="background:{TYPE_COLORS[act.type] ?? '#64748b'}">{TYPE_LABELS[act.type] ?? act.type}</span>
        <input class="name-input" bind:value={act.name} placeholder={_an.action(act)} />
        {#if act.type !== 'notify'}
          <span class="state-badge {ab.kind}">{ab.label}</span>
        {/if}
        <button class="rm-btn" onclick={() => localActions = localActions.filter(a => a.id !== act.id)}>✕</button>
      </div>
      <div class="card-body">

        {#if act.type === 'record'}
          <!-- ── RecordAction ── -->
          <label class="field-row">
            <span class="field-lbl">Channel</span>
            <select class="field-select" value={act.channelId}
              onchange={(e) => { if (act.type === 'record') act.channelId = (e.target as HTMLSelectElement).value; }}>
              {#each localChannels as ch}
                <option value={ch.id}>{ch.name || _an.channel(ch)}</option>
              {/each}
            </select>
          </label>
          <div class="field-row field-row--captures full-row">
            <span class="field-lbl">Captures</span>
            <div class="captures-checks">
              {#each localCaptures.filter(c => c.type !== 'photo') as cap}
                {@const checked = act.captureIds.includes(cap.id)}
                <label class="check-label">
                  <input type="checkbox" {checked}
                    onchange={() => {
                      if (act.type === 'record') act.captureIds = checked
                        ? act.captureIds.filter(id => id !== cap.id)
                        : [...act.captureIds, cap.id];
                    }} />
                  <span class="check-type-badge" style="background:{TYPE_COLORS[cap.type]}">{TYPE_LABELS[cap.type]}</span>
                  {cap.name || _an.capture(cap)}
                </label>
              {/each}
              {#if localCaptures.filter(c => c.type !== 'photo').length === 0}
                <span class="muted-hint">No audio/video captures defined</span>
              {/if}
            </div>
          </div>
          <label class="field-row">
            <span class="field-lbl">Priority</span>
            <input class="num-input" type="number" min="1" step="1" value={act.priority}
              oninput={(e) => { if (act.type === 'record') act.priority = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Post-roll</span>
            <div class="num-with-unit">
              <input class="num-input" type="number" min="0" step="5" value={act.postRollSec}
                oninput={(e) => { if (act.type === 'record') act.postRollSec = +(e.target as HTMLInputElement).value; }} />
              <span class="unit">s</span>
            </div>
          </label>
          <label class="field-row">
            <span class="field-lbl">Rolling buffer</span>
            {#if act.rollingBufferSec === null}
              <span class="inf-text">∞ infinite</span>
              <button class="link-btn" onclick={() => { if (act.type === 'record') act.rollingBufferSec = Math.max(act.postRollSec || 30, 30); }}>Limit</button>
            {:else}
              <div class="num-with-unit">
                <input class="num-input" type="number" min="0" step="5" value={act.rollingBufferSec}
                  oninput={(e) => { if (act.type === 'record') act.rollingBufferSec = +(e.target as HTMLInputElement).value; }} />
                <span class="unit">s</span>
              </div>
              <button class="link-btn" onclick={() => { if (act.type === 'record') act.rollingBufferSec = null; }}>∞</button>
            {/if}
          </label>
          <label class="field-row">
            <span class="field-lbl">Retrigger</span>
            <select class="field-select" value={act.onRetrigger}
              onchange={(e) => { if (act.type === 'record') act.onRetrigger = (e.target as HTMLSelectElement).value as 'extend' | 'ignore' | 'restart'; }}>
              <option value="extend">Extend window</option>
              <option value="ignore">Ignore</option>
              <option value="restart">Restart</option>
            </select>
          </label>

        {:else if act.type === 'clip'}
          <!-- ── ClipAction ── -->
          <label class="field-row">
            <span class="field-lbl">Channel</span>
            <select class="field-select" value={act.channelId}
              onchange={(e) => { if (act.type === 'clip') act.channelId = (e.target as HTMLSelectElement).value; }}>
              {#each localChannels as ch}
                <option value={ch.id}>{ch.name || _an.channel(ch)}</option>
              {/each}
            </select>
          </label>
          <div class="field-row field-row--captures">
            <span class="field-lbl">Types</span>
            <div class="captures-checks">
              {#each ['video', 'audio', 'photo'] as captureType}
                {@const checked = act.captureTypes.includes(captureType as 'video' | 'audio' | 'photo')}
                <label class="check-label">
                  <input type="checkbox" {checked}
                    onchange={() => {
                      if (act.type === 'clip') act.captureTypes = checked
                        ? act.captureTypes.filter(t => t !== captureType)
                        : [...act.captureTypes, captureType as 'video' | 'audio' | 'photo'];
                    }} />
                  <span class="check-type-badge" style="background:{TYPE_COLORS[captureType] ?? '#64748b'}">{TYPE_LABELS[captureType] ?? captureType}</span>
                </label>
              {/each}
            </div>
          </div>
          <label class="field-row">
            <span class="field-lbl">Pre-roll</span>
            <div class="num-with-unit">
              <input class="num-input" type="number" min="0" step="5" value={act.preRollSec}
                oninput={(e) => { if (act.type === 'clip') act.preRollSec = +(e.target as HTMLInputElement).value; }} />
              <span class="unit">s</span>
            </div>
          </label>
          <label class="field-row">
            <span class="field-lbl">Post-roll</span>
            <div class="num-with-unit">
              <input class="num-input" type="number" min="0" step="5" value={act.postRollSec}
                oninput={(e) => { if (act.type === 'clip') act.postRollSec = +(e.target as HTMLInputElement).value; }} />
              <span class="unit">s</span>
            </div>
          </label>
          <label class="field-row pin-row full-row">
            <span class="field-lbl">Keep for</span>
            <input class="num-input" type="number" min="1" step="1"
              value={act.pinLifetimeSec === 0 ? '' : Math.round(act.pinLifetimeSec / pinUnitSec(act.id, act.pinLifetimeSec))}
              placeholder={act.pinLifetimeSec === 0 ? '∞' : ''}
              disabled={act.pinLifetimeSec === 0}
              oninput={(e) => {
                const v = +(e.target as HTMLInputElement).value;
                if (act.type === 'clip') act.pinLifetimeSec = v > 0 ? v * pinUnitSec(act.id, act.pinLifetimeSec) : 0;
              }} />
            <select class="field-select pin-unit-select"
              value={pinUnit(act.id, act.pinLifetimeSec)}
              disabled={act.pinLifetimeSec === 0}
              onchange={(e) => {
                const newUnit = (e.target as HTMLSelectElement).value as PinUnit;
                pinUnits = { ...pinUnits, [act.id]: newUnit };
                const uSec = PIN_UNITS.find(u => u.label === newUnit)!.s;
                if (act.type === 'clip' && act.pinLifetimeSec && act.pinLifetimeSec > 0) {
                  const count = Math.max(1, Math.round(act.pinLifetimeSec / uSec));
                  act.pinLifetimeSec = count * uSec;
                }
              }}>
              {#each PIN_UNITS as u}
                <option value={u.label}>{u.label}</option>
              {/each}
            </select>
            <label class="forever-label">
              <input type="checkbox" checked={act.pinLifetimeSec === 0}
                onchange={(e) => { if (act.type === 'clip') act.pinLifetimeSec = (e.target as HTMLInputElement).checked ? 0 : 7 * 86400; }} />
              ∞
            </label>
          </label>
          <label class="field-row">
            <span class="field-lbl">Retrigger</span>
            <select class="field-select" value={act.onRetrigger}
              onchange={(e) => { if (act.type === 'clip') act.onRetrigger = (e.target as HTMLSelectElement).value as 'extend' | 'ignore' | 'restart'; }}>
              <option value="extend">Extend window</option>
              <option value="ignore">Ignore</option>
              <option value="restart">Restart</option>
            </select>
          </label>

        {:else if act.type === 'snapshot'}
          <!-- ── SnapshotAction ── -->
          <label class="field-row">
            <span class="field-lbl">Channel</span>
            <select class="field-select" value={act.channelId}
              onchange={(e) => { if (act.type === 'snapshot') act.channelId = (e.target as HTMLSelectElement).value; }}>
              {#each localChannels as ch}
                <option value={ch.id}>{ch.name || _an.channel(ch)}</option>
              {/each}
            </select>
          </label>
          <label class="field-row">
            <span class="field-lbl">Capture</span>
            <select class="field-select" value={act.captureId ?? ''}
              onchange={(e) => { if (act.type === 'snapshot') act.captureId = (e.target as HTMLSelectElement).value; }}>
              <option value="">None</option>
              {#each localCaptures.filter(c => c.type === 'photo') as cap}
                <option value={cap.id}>{cap.name || _an.capture(cap)}</option>
              {/each}
            </select>
          </label>
          <label class="field-row">
            <span class="field-lbl">Count</span>
            <input class="num-input" type="number" min="0" step="1" placeholder="0=∞" value={act.snapshotCount}
              oninput={(e) => { if (act.type === 'snapshot') act.snapshotCount = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Interval</span>
            <div class="num-with-unit">
              <input class="num-input" type="number" min="0" step="0.5" value={act.intervalSec}
                oninput={(e) => { if (act.type === 'snapshot') act.intervalSec = +(e.target as HTMLInputElement).value; }} />
              <span class="unit">s</span>
            </div>
          </label>
          <label class="field-row">
            <span class="field-lbl">Pin forever</span>
            <button class="toggle-pill" style="background:{act.pinLifetimeSec !== null ? 'var(--color-success)' : 'var(--color-border)'}"
              onclick={() => { if (act.type === 'snapshot') act.pinLifetimeSec = act.pinLifetimeSec !== null ? null : 0; }}>
              <span class="pill-thumb" style="transform:translateX({act.pinLifetimeSec !== null ? '14px' : '2px'})"></span>
            </button>
          </label>

        {:else if act.type === 'notify'}
          <!-- ── NotifyAction ── -->
          <label class="field-row full-row">
            <span class="field-lbl">Send to</span>
            <select class="field-select" value={act.viewerPubkey ?? ''}
              onchange={(e) => { if (act.type === 'notify') act.viewerPubkey = (e.target as HTMLSelectElement).value || null; }}>
              <option value="">All paired devices</option>
              {#each $pairedDevices as dev}
                <option value={dev.pubkey}>{dev.nickname || dev.pubkey.slice(0, 16) + '…'}</option>
              {/each}
            </select>
          </label>
          <label class="field-row slider-row">
            <span class="field-lbl">Cooldown: {(act.cooldownMs / 1000).toFixed(0)}s</span>
            <input type="range" min="0" max="300000" step="5000" value={act.cooldownMs}
              oninput={(e) => { if (act.type === 'notify') act.cooldownMs = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Retrigger</span>
            <select class="field-select" value={act.onRetrigger}
              onchange={(e) => { if (act.type === 'notify') act.onRetrigger = (e.target as HTMLSelectElement).value as 'ignore' | 'extend' | 'restart'; }}>
              <option value="ignore">Ignore (drop during cooldown)</option>
              <option value="extend">Extend (push cooldown window)</option>
              <option value="restart">Restart (send again, reset cooldown)</option>
            </select>
          </label>
          <label class="field-row">
            <span class="field-lbl">Include data</span>
            <button class="toggle-pill" style="background:{act.includeData ? 'var(--color-success)' : 'var(--color-border)'}"
              onclick={() => { if (act.type === 'notify') act.includeData = !act.includeData; }}>
              <span class="pill-thumb" style="transform:translateX({act.includeData ? '14px' : '2px'})"></span>
            </button>
          </label>
          <label class="field-row full-row">
            <span class="field-lbl">Message</span>
            <input class="name-input flex1" type="text" placeholder="Optional message prefix…"
              value={act.messageTemplate ?? ''}
              oninput={(e) => { if (act.type === 'notify') act.messageTemplate = (e.target as HTMLInputElement).value || undefined; }} />
          </label>
          <div class="field-row full-row">
            <span class="field-lbl">Publish on</span>
            <div class="checkbox-group">
              {#each ['sensing', 'active', 'idle'] as st}
                <label class="check-label">
                  <input type="checkbox"
                    checked={act.publishStates?.includes(st as 'sensing' | 'active' | 'idle')}
                    onchange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      if (act.type === 'notify') {
                        const cur = act.publishStates ?? [];
                        act.publishStates = checked
                          ? [...cur, st as 'sensing' | 'active' | 'idle']
                          : cur.filter(s => s !== st);
                      }
                    }} />
                  {st}
                </label>
              {/each}
            </div>
          </div>
        {/if}

      </div>
    </div>
  {:else}
    <div class="empty">No actions.</div>
  {/each}

  <!-- ── Links ────────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Links</span>
    <button class="add-btn" onclick={() => localLinks = [...localLinks, newLink()]}>+ Link</button>
  </div>
  {#each localLinks as lnk (lnk.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge link-type">LNK</span>
        <input class="name-input" bind:value={lnk.name} placeholder={_an.link(lnk)} />
        <button class="toggle-pill" style="background:{lnk.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => { lnk.enabled = !lnk.enabled; }}>
          <span class="pill-thumb" style="transform:translateX({lnk.enabled ? '14px' : '2px'})"></span>
        </button>
        <button class="rm-btn" onclick={() => localLinks = localLinks.filter(l => l.id !== lnk.id)}>✕</button>
      </div>
      <div class="card-body">
        <!-- Multi-sensor checkboxes -->
        <div class="field-row field-row--captures full-row">
          <span class="field-lbl">Sensors</span>
          <div class="captures-checks">
            {#each localSensors as sen}
              {@const checked = lnk.sensorIds.includes(sen.id)}
              <label class="check-label">
                <input type="checkbox" {checked}
                  onchange={() => {
                    lnk.sensorIds = checked
                      ? lnk.sensorIds.filter(id => id !== sen.id)
                      : [...lnk.sensorIds, sen.id];
                  }} />
                {sen.name || _an.sensor(sen)}
              </label>
            {/each}
            {#if localSensors.length === 0}
              <span class="muted-hint">No sensors defined</span>
            {/if}
          </div>
        </div>
        <!-- Condition -->
        <label class="field-row">
          <span class="field-lbl">Condition</span>
          <select class="field-select" value={lnk.condition}
            onchange={(e) => { lnk.condition = (e.target as HTMLSelectElement).value as 'any' | 'all'; }}>
            <option value="any">Any sensor</option>
            <option value="all">All sensors</option>
          </select>
        </label>
        <!-- On state -->
        <label class="field-row">
          <span class="field-lbl">On state</span>
          <select class="field-select" value={lnk.onState}
            onchange={(e) => { lnk.onState = (e.target as HTMLSelectElement).value as 'sensing' | 'active'; }}>
            <option value="sensing">Sensing</option>
            <option value="active">Active</option>
          </select>
        </label>
        <!-- Actions multi-select -->
        <div class="field-row field-row--captures full-row">
          <span class="field-lbl">Actions</span>
          <div class="captures-checks">
            {#each localActions as act}
              {@const checked = lnk.actionIds.includes(act.id)}
              <label class="check-label">
                <input type="checkbox" {checked}
                  onchange={() => {
                    lnk.actionIds = checked
                      ? lnk.actionIds.filter(id => id !== act.id)
                      : [...lnk.actionIds, act.id];
                  }} />
                <span class="check-type-badge" style="background:{TYPE_COLORS[act.type] ?? '#64748b'}">
                  {TYPE_LABELS[act.type] ?? act.type}
                </span>
                <span class="check-act-name">{act.name || _an.action(act)}</span>
              </label>
            {/each}
            {#if localActions.length === 0}
              <span class="muted-hint">No actions defined</span>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="empty">No links.</div>
  {/each}

  <!-- ── General ───────────────────────────────────────────────────────────── -->
  <div class="subsec-title" style="margin-top:8px">General</div>
  <div class="pipeline-card">
    <div class="card-body">
      <label class="field-row full-row">
        <span class="field-lbl">Relay URL</span>
        <input class="name-input flex1" type="url" bind:value={localRelayUrl} />
      </label>
      <label class="field-row full-row">
        <span class="field-lbl">Self label</span>
        <input class="name-input flex1" type="text" bind:value={localSelfLabel} />
      </label>
      <label class="field-row">
        <span class="field-lbl">Pause Nostr</span>
        <button class="toggle-pill" style="background:{localPauseNostr ? 'var(--color-warning)' : 'var(--color-border)'}"
          onclick={() => { localPauseNostr = !localPauseNostr; }}>
          <span class="pill-thumb" style="transform:translateX({localPauseNostr ? '14px' : '2px'})"></span>
        </button>
      </label>
      <label class="field-row">
        <span class="field-lbl">Rate limit</span>
        <div class="num-with-unit">
          <input class="num-input" type="number" min="1" step="10" bind:value={localNostrRateLimit} />
          <span class="unit">ev/min</span>
        </div>
      </label>
      <label class="field-row">
        <span class="field-lbl">RTC idle</span>
        <div class="num-with-unit">
          <input class="num-input" type="number" min="0" step="10" bind:value={localRtcIdleTimeoutS} />
          <span class="unit">s</span>
        </div>
      </label>
    </div>
  </div>

  <!-- ── Storage ───────────────────────────────────────────────────────────── -->
  <div class="subsec-title" style="margin-top:8px">Storage</div>
  <div class="pipeline-card">
    <div class="card-body">
      <label class="field-row">
        <span class="field-lbl">Quota</span>
        <div class="num-with-unit">
          <input class="num-input" type="number" min="50" step="50"
            value={localStorageCleanup.quotaMb}
            oninput={e => localStorageCleanup = { ...localStorageCleanup, quotaMb: parseInt((e.target as HTMLInputElement).value) || 500 }} />
          <span class="unit">MB</span>
        </div>
      </label>
      <label class="field-row">
        <span class="field-lbl">Auto-cleanup</span>
        <button class="toggle-pill"
          style="background:{localStorageCleanup.autoCleanupEnabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => localStorageCleanup = { ...localStorageCleanup, autoCleanupEnabled: !localStorageCleanup.autoCleanupEnabled }}>
          <span class="pill-thumb" style="transform:translateX({localStorageCleanup.autoCleanupEnabled ? '14px' : '2px'})"></span>
        </button>
      </label>
      {#if localStorageCleanup.autoCleanupEnabled}
      <label class="field-row">
        <span class="field-lbl">Run every</span>
        <div class="num-with-unit">
          <input class="num-input" type="number" min="60" step="60"
            value={Math.round(localStorageCleanup.autoCleanupIntervalSec / 60)}
            oninput={e => localStorageCleanup = { ...localStorageCleanup, autoCleanupIntervalSec: (parseInt((e.target as HTMLInputElement).value) || 5) * 60 }} />
          <span class="unit">min</span>
        </div>
      </label>
      {/if}

      <div class="full-row thin-rules-header">
        <span class="field-lbl" style="font-weight:600">Thinning rules</span>
        <button class="add-btn" onclick={addThinningRule}>+ Add rule</button>
      </div>
      <div class="field-hint full-row" style="margin-top:-2px">
        Older unpinned segments are thinned to one per time bucket. Pinned segments are never thinned.
        Rules are sorted by age — the oldest threshold takes priority.
      </div>
      {#each localStorageCleanup.thinningRules as rule, i}
      <div class="full-row thin-rule-row">
        <select class="thin-select thin-select-type"
          value={rule.mimePrefix ?? ''}
          onchange={e => updateThinningRule(i, { mimePrefix: (e.target as HTMLSelectElement).value })}>
          {#each THIN_TYPE_PRESETS as p}
            <option value={p.prefix}>{p.label}</option>
          {/each}
        </select>
        <span class="field-lbl">after</span>
        <select class="thin-select"
          value={rule.afterAgeSec}
          onchange={e => updateThinningRule(i, { afterAgeSec: parseInt((e.target as HTMLSelectElement).value) })}>
          {#each THIN_AGE_PRESETS as p}
            <option value={p.s}>{p.label}</option>
          {/each}
        </select>
        <span class="field-lbl">keep</span>
        <select class="thin-select"
          value={rule.keepOnePerSec}
          onchange={e => updateThinningRule(i, { keepOnePerSec: parseInt((e.target as HTMLSelectElement).value) })}>
          {#each THIN_RATE_PRESETS as p}
            <option value={p.s}>{p.label}</option>
          {/each}
        </select>
        <button class="remove-btn" onclick={() => removeThinningRule(i)}>×</button>
      </div>
      {/each}
      {#if localStorageCleanup.thinningRules.length === 0}
        <div class="field-hint full-row">No thinning rules — only quota-based eviction applies.</div>
      {/if}
    </div>
  </div>
</DevSection>

<style>
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 4px; }
  .subsec-header { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; margin-bottom: 2px; }
  .subsec-header .subsec-title { margin-top: 0; }
  .add-btn { font-size: 9px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--color-accent); background: rgba(139,92,246,0.1); color: var(--color-accent); cursor: pointer; font-family: inherit; font-weight: 600; }
  .add-btn:hover { background: var(--color-accent); color: white; }

  .pipeline-card { border: 1px solid var(--color-border); border-radius: 6px; overflow: hidden; margin-bottom: 4px; }
  .card-header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--color-surface); }
  .card-body { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; padding: 7px 8px; background: var(--color-bg); align-items: start; }

  .type-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; color: white; }
  .type-badge.channel  { background: #0f766e; }
  .type-badge.link-type { background: #475569; }
  .add-btn-group { display: flex; gap: 4px; }
  .checkbox-group { display: flex; gap: 10px; align-items: center; }
  .check-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--color-text); cursor: pointer; text-transform: capitalize; }
  .check-act-name { font-size: 10px; color: var(--color-muted); text-transform: none; }
  .check-type-badge { font-size: 8px; font-weight: 700; padding: 1px 4px; border-radius: 3px; color: white; letter-spacing: 0.04em; }

  .state-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--color-border); color: var(--color-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .state-badge.idle     { background: var(--color-border); color: var(--color-muted); }
  .state-badge.inactive { background: var(--color-border); color: var(--color-muted); opacity: 0.6; }
  .state-badge.sensing  { background: #1d4ed8; color: white; }
  .state-badge.active   { background: var(--color-success); color: white; }
  .state-badge.settling { background: var(--color-warning); color: #1a1a1a; }
  .state-badge.cooldown { background: #7c3aed; color: white; }

  .name-input {
    flex: 1; font-size: 12px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
    border: 1px solid transparent; background: transparent; color: var(--color-text); font-family: inherit;
  }
  .name-input:hover, .name-input:focus { border-color: var(--color-border); background: var(--color-bg); outline: none; }
  .name-input.flex1 { min-width: 0; }

  .field-row { display: flex; align-items: center; gap: 4px; }
  .field-row--captures { align-items: flex-start; }
  .captures-checks { display: flex; flex-direction: column; gap: 4px; }
  .muted-hint { font-size: 10px; color: var(--color-muted); font-style: italic; }
  .field-lbl { font-size: 10px; color: var(--color-muted); white-space: nowrap; min-width: 68px; }
  .slider-row { flex-direction: column; align-items: stretch; gap: 2px; grid-column: 1 / -1; }
  .slider-row input[type="range"] { width: 100%; }
  .full-row { grid-column: 1 / -1; }
  .pin-row { flex-wrap: wrap; gap: 4px; grid-column: 1 / -1; }
  .flex1 { flex: 1; min-width: 0; }

  .field-select { font-size: 11px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; max-width: 160px; }
  .load-devs-btn { font-size: 11px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; flex-shrink: 0; }
  .load-devs-btn:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-accent); }
  .load-devs-btn:disabled { opacity: 0.4; cursor: default; }
  .num-input { font-size: 11px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; width: 55px; }
  .num-with-unit { display: flex; align-items: center; gap: 2px; }
  .unit { font-size: 10px; color: var(--color-muted); }
  .forever-label { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--color-muted); cursor: pointer; }
  .pin-unit-select { max-width: 80px; }

  .toggle-pill { width: 28px; height: 16px; border-radius: 8px; border: none; padding: 0; cursor: pointer; position: relative; flex-shrink: 0; overflow: hidden; transition: background 0.15s; }
  .pill-thumb { position: absolute; top: 2px; left: 0; width: 12px; height: 12px; border-radius: 50%; background: white; transition: transform 0.15s; }
  .rm-btn { font-size: 11px; padding: 0 4px; border: none; background: none; color: var(--color-muted); cursor: pointer; flex-shrink: 0; }
  .rm-btn:hover { color: var(--color-danger); }

  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .act-btn:hover { color: var(--color-text); }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .raw { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 10px; border-radius: 6px; overflow: auto; max-height: 300px; color: #a3e635; }
  .save-error { font-size: 11px; color: var(--color-danger); background: rgba(239,68,68,0.08); border: 1px solid var(--color-danger); border-radius: 4px; padding: 4px 8px; }
  .empty { font-size: 11px; color: var(--color-muted); padding: 4px 0; }
  .field-hint { font-size: 10px; color: var(--color-muted); font-style: italic; padding: 2px 0; grid-column: 1 / -1; }
  .field-hint-inline { font-size: 10px; color: var(--color-muted); font-style: italic; }
  .field-hint.warn { color: var(--color-warning); }

  .thin-rules-header { display: flex; align-items: center; justify-content: space-between; }
  .thin-rule-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .thin-select { font-size: 11px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; }
  .thin-select-type { min-width: 80px; }
  .remove-btn { font-size: 11px; padding: 0 5px; border: none; background: none; color: var(--color-muted); cursor: pointer; }
  .remove-btn:hover { color: var(--color-danger); }

  .datetime-input { font-size: 11px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; flex: 1; }

  .avail-wrap { user-select: none; touch-action: none; }
  .avail-header-row { display: grid; grid-template-columns: 28px repeat(24, 1fr); gap: 1px; margin-bottom: 1px; }
  .avail-row { display: grid; grid-template-columns: 28px repeat(24, 1fr); gap: 1px; }
  .avail-day-stub { }
  .avail-hr-lbl { font-size: 8px; color: var(--color-muted); text-align: center; line-height: 1; }
  .avail-day-lbl { font-size: 9px; color: var(--color-muted); font-weight: 600; display: flex; align-items: center; }
  .avail-cell { height: 14px; border-radius: 2px; background: var(--color-surface); cursor: crosshair; transition: background 0.06s; }
  .avail-cell.active { background: var(--color-accent); }
  .avail-cell:hover { opacity: 0.75; }
  .avail-footer { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .link-btn { font-size: 9px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--color-border); background: none; color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .link-btn:hover { color: var(--color-text); border-color: var(--color-text); }
  .inf-text { font-size: 11px; color: var(--color-muted); font-style: italic; flex: 1; }
</style>
