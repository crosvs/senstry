<script lang="ts">
  import { settings, saveSettings, loadSettings } from '$lib/store/settings';
  import {
    sources, sensors, captures, nostrActions, links, loadPipeline, savePipeline,
    storageCleanup, loadStorageCleanup, saveStorageCleanup,
    newSource, newSensor, newCapture, newNostrAction, newLink,
    DEFAULT_SOURCES, DEFAULT_SENSORS, DEFAULT_CAPTURES, DEFAULT_NOSTR_ACTIONS, DEFAULT_LINKS,
    DEFAULT_STORAGE_CLEANUP,
    type SourceConfig, type SensorConfig, type CaptureMethod, type NostrAction, type Link,
    type SensorState, type LinkActivationState, type StorageCleanupConfig, type ThinningRule,
  } from '$lib/store/pipeline';
  import type { AlertSession } from './SentrySection.svelte';
  import DevSection from './DevSection.svelte';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';

  interface Props {
    sensorStates?: Record<string, SensorState>;
    linkStates?: Record<string, LinkActivationState>;
    activeAlerts?: AlertSession[];
  }
  let { sensorStates = {}, linkStates = {}, activeAlerts = [] }: Props = $props();

  let showRaw = $state(false);
  let saveFlash = $state(false);
  let saveError = $state('');

  // Pipeline local state
  let localSources      = $state<SourceConfig[]>([]);
  let localSensors      = $state<SensorConfig[]>([]);
  let localCaptures     = $state<CaptureMethod[]>([]);
  let localNostrActions = $state<NostrAction[]>([]);
  let localLinks        = $state<Link[]>([]);

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

  onMount(async () => {
    await Promise.all([loadPipeline(), loadSettings(), loadStorageCleanup()]);
    localSources      = get(sources).map(s => ({ ...s }));
    localSensors      = get(sensors).map(s => ({ ...s }));
    localCaptures     = get(captures).map(c => ({ ...c }));
    localNostrActions = get(nostrActions).map(n => ({ ...n }));
    localLinks        = get(links).map(l => ({ ...l }));
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
        sources:      localSources.map(s => ({ ...s })),
        sensors:      localSensors.map(s => ({ ...s })),
        captures:     localCaptures.map(c => ({ ...c })),
        nostrActions: localNostrActions.map(n => ({ ...n })),
        links:        localLinks.map(l => ({ ...l })),
      });
      await saveSettings({
        ...get(settings),
        relayUrl:        localRelayUrl,
        selfLabel:       localSelfLabel,
        pauseNostr:      localPauseNostr,
        nostrRateLimit:  localNostrRateLimit,
        rtcIdleTimeoutMs: localRtcIdleTimeoutS * 1000,
      });
      // Spread nested array items into plain objects so IDB structured-clone
      // doesn't trip on Svelte 5 Proxy wrappers around the thinningRules array.
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
    localSources      = DEFAULT_SOURCES.map(s => ({ ...s }));
    localSensors      = DEFAULT_SENSORS.map(s => ({ ...s }));
    localCaptures     = DEFAULT_CAPTURES.map(c => ({ ...c }));
    localNostrActions = DEFAULT_NOSTR_ACTIONS.map(n => ({ ...n }));
    localLinks        = DEFAULT_LINKS.map(l => ({ ...l }));
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

  // Changing capture type rebuilds the object with type-appropriate defaults
  function changeCaptureType(id: string, type: CaptureMethod['type']) {
    localCaptures = localCaptures.map(c => {
      if (c.id !== id || c.type === type) return c;
      // Pick a default source compatible with the new type
      const compatSources = compatibleSources(type);
      const sourceId = compatSources.find(s => s.id === c.sourceId)
        ? c.sourceId
        : (compatSources[0]?.id ?? c.sourceId);
      const base = { id: c.id, name: c.name, sourceId };
      const pri  = 'priority' in c ? c.priority : 10;
      if (type === 'video')
        return { ...base, type, priority: pri, videoWidth: 0, videoHeight: 0, videoBitsPerSec: 0, audioBitsPerSec: 64_000, videoCodec: '' } as CaptureMethod;
      if (type === 'audio')
        return { ...base, type, priority: pri, audioBitsPerSec: 64_000, mimeType: '' } as CaptureMethod;
      return { ...base, type, imageWidth: 640, imageHeight: 0, imageQuality: 0.85, imageFormat: 'image/jpeg' } as CaptureMethod;
    });
  }

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

  function linkBadge(id: string): { label: string; kind: string } {
    const s = linkStates[id];
    if (!s || s.status === 'inactive') return { label: 'INACTIVE', kind: 'inactive' };
    if (s.status === 'waiting') {
      const el = (now - s.startedAt) / 1000;
      const mn = s.minMs / 1000;
      return { label: `WAITING ${el.toFixed(1)}/${mn.toFixed(1)}s`, kind: 'waiting' };
    }
    return { label: `ACTIVE ${((now - s.startedAt) / 1000).toFixed(1)}s`, kind: 'active' };
  }

  function linkCaptureType(captureId: string | null): CaptureMethod['type'] | null {
    if (!captureId) return null;
    return localCaptures.find(c => c.id === captureId)?.type ?? null;
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

  // Per-link user-selected unit (persists across number edits within a session)
  let pinUnits = $state<Record<string, PinUnit>>({});

  function bestPinUnit(sec: number): PinUnit {
    for (const u of [...PIN_UNITS].toReversed()) {
      if (sec >= u.s && sec % u.s === 0) return u.label;
    }
    return 'minutes';
  }

  function pinUnit(linkId: string, sec: number | null): PinUnit {
    return pinUnits[linkId] ?? (sec != null && sec > 0 ? bestPinUnit(sec) : 'days');
  }

  function pinUnitSec(linkId: string, sec: number | null): number {
    return PIN_UNITS.find(u => u.label === pinUnit(linkId, sec))?.s ?? 86400;
  }

  function isNoop(link: Link): boolean {
    return link.captureId === null && link.nostrActionId === null;
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

  // Returns the effective sourceId for a capture — auto-corrects to first compatible source
  // if the stored id no longer points to a compatible source (e.g. source type was changed).
  function captureSourceId(cap: CaptureMethod): string {
    const compat = compatibleSources(cap.type);
    return compat.find(s => s.id === cap.sourceId) ? cap.sourceId : (compat[0]?.id ?? cap.sourceId);
  }

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function changeSensorType(id: string, type: SensorConfig['type']) {
    localSensors = localSensors.map(s => {
      if (s.id !== id || s.type === type) return s;
      if (type === 'schedule') {
        return { id: s.id, name: s.name, type: 'schedule', sourceId: 'none',
          enabled: s.enabled, thresholdDb: 0, minDurationMs: 0, settlingMs: 1000, intervalMs: 60_000 } as SensorConfig;
      }
      if (type === 'timewindow') {
        return { id: s.id, name: s.name, type: 'timewindow', sourceId: 'none',
          enabled: s.enabled, thresholdDb: 0, minDurationMs: 0, settlingMs: 0,
          startHHMM: '22:00', endHHMM: '06:00', daysOfWeek: [] } as SensorConfig;
      }
      if (type === 'daterange') {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const toIso = (d: Date) =>
          `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const end = new Date(now.getTime() + 24 * 3600_000);
        return { id: s.id, name: s.name, type: 'daterange', sourceId: 'none',
          enabled: s.enabled, thresholdDb: 0, minDurationMs: 0, settlingMs: 0,
          startIso: toIso(now), endIso: toIso(end) } as SensorConfig;
      }
      return { id: s.id, name: s.name, type: 'audio', sourceId: localSources[0]?.id ?? 'default-mic',
        enabled: s.enabled, thresholdDb: -45, releaseThresholdDb: -50, minDurationMs: 1500, settlingMs: 500 } as SensorConfig;
    });
  }

  function toggleDow(sensor: SensorConfig, day: number) {
    const current = sensor.daysOfWeek ?? [];
    sensor.daysOfWeek = current.includes(day) ? current.filter(d => d !== day) : [...current, day].sort();
    // Trigger reactivity: replace the sensor in the array
    localSensors = localSensors.map(s => s.id === sensor.id ? { ...sensor } : s);
  }
</script>

<DevSection title="Settings">
  {#snippet summary()}
    {#if Object.values(sensorStates).some(s => s.status === 'active')}
      ACTIVE · {Object.values(sensorStates).filter(s => s.status === 'active').length} sensor{Object.values(sensorStates).filter(s => s.status === 'active').length === 1 ? '' : 's'}
    {:else if activeAlerts.length > 0}
      ALERT · {activeAlerts.length} active
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
    <pre class="raw">{JSON.stringify({ settings: $settings, sources: localSources, sensors: localSensors, captures: localCaptures, nostrActions: localNostrActions, links: localLinks, storageCleanup: localStorageCleanup }, null, 2)}</pre>
  {/if}

  <!-- ── Sources ──────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Sources</span>
    <button class="add-btn" onclick={() => localSources = [...localSources, newSource()]}>+ Add</button>
  </div>
  {#each localSources as src (src.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge {src.type === 'camera' ? 'cam' : src.type === 'screen' ? 'screen' : 'mic'}">{src.type === 'camera' ? 'CAM' : src.type === 'screen' ? 'SCRN' : 'MIC'}</span>
        <input class="name-input" bind:value={src.name} placeholder="Source name" />
        <button class="rm-btn" onclick={() => localSources = localSources.filter(s => s.id !== src.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row">
          <span class="field-lbl">Type</span>
          <select class="field-select" value={src.type}
            onchange={(e) => { src.type = (e.target as HTMLSelectElement).value as SourceConfig['type']; }}>
            <option value="microphone">Microphone</option>
            <option value="camera">Camera</option>
            <option value="screen">Screen Share</option>
          </select>
        </label>
        {#if src.type !== 'screen'}
          <label class="field-row">
            <span class="field-lbl">Device</span>
            <select class="field-select" value={src.deviceId}
              onchange={(e) => { src.deviceId = (e.target as HTMLSelectElement).value; }}>
              <option value="">Default</option>
              {#each (src.type === 'camera' ? videoDevices : audioDevices) as dev}
                <option value={dev.deviceId}>{dev.label || dev.deviceId.slice(0, 14) + '…'}</option>
              {/each}
            </select>
          </label>
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
          <div class="field-hint">Browser picks screen/window/tab at capture time. Audio captured if browser supports it.</div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty">No sources.</div>
  {/each}

  <!-- ── Sensors ──────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Sensors</span>
    <button class="add-btn" onclick={() => localSensors = [...localSensors, newSensor(localSources[0]?.id ?? 'default-mic')]}>+ Add</button>
  </div>
  {#each localSensors as sen (sen.id)}
    {@const sb = sensorBadge(sen.id)}
    {@const typeBadgeClass = sen.type === 'audio' ? 'audio' : 'sched'}
    {@const typeBadgeLabel = sen.type === 'audio' ? 'AUDIO' : sen.type === 'schedule' ? 'SCHED' : sen.type === 'timewindow' ? 'TIME' : 'DATE'}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge {typeBadgeClass}">{typeBadgeLabel}</span>
        <input class="name-input" bind:value={sen.name} placeholder="Sensor name" />
        <span class="state-badge {sb.kind}">{sb.label}</span>
        <button class="toggle-pill" style="background:{sen.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => { sen.enabled = !sen.enabled; }}>
          <span class="pill-thumb" style="transform:translateX({sen.enabled ? '14px' : '2px'})"></span>
        </button>
        <button class="rm-btn" onclick={() => localSensors = localSensors.filter(s => s.id !== sen.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row">
          <span class="field-lbl">Type</span>
          <select class="field-select" value={sen.type}
            onchange={(e) => changeSensorType(sen.id, (e.target as HTMLSelectElement).value as SensorConfig['type'])}>
            <option value="audio">Audio</option>
            <option value="schedule">Schedule (interval)</option>
            <option value="timewindow">Time Window</option>
            <option value="daterange">Date Range</option>
          </select>
        </label>

        {#if sen.type === 'audio'}
          <label class="field-row">
            <span class="field-lbl">Source</span>
            <select class="field-select" value={sen.sourceId}
              onchange={(e) => { sen.sourceId = (e.target as HTMLSelectElement).value; }}>
              {#each localSources.filter(s => s.type === 'microphone') as src}
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
          <div class="field-row">
            <span class="field-lbl">Start</span>
            <input class="time-input" type="time" value={sen.startHHMM ?? '22:00'}
              onchange={(e) => { sen.startHHMM = (e.target as HTMLInputElement).value; }} />
          </div>
          <div class="field-row">
            <span class="field-lbl">End</span>
            <input class="time-input" type="time" value={sen.endHHMM ?? '06:00'}
              onchange={(e) => { sen.endHHMM = (e.target as HTMLInputElement).value; }} />
          </div>
          <div class="field-hint">If End is earlier than Start, the window crosses midnight.</div>
          <div class="field-row">
            <span class="field-lbl">Days</span>
            <div class="dow-pills">
              {#each DOW_LABELS as lbl, i}
                {@const active = (sen.daysOfWeek ?? []).includes(i)}
                <button class="dow-pill" class:active onclick={() => toggleDow(sen, i)}>{lbl}</button>
              {/each}
              <span class="field-hint-inline">{(sen.daysOfWeek ?? []).length === 0 ? 'all days' : ''}</span>
            </div>
          </div>

        {:else if sen.type === 'daterange'}
          <div class="field-row">
            <span class="field-lbl">Start</span>
            <input class="datetime-input" type="datetime-local" value={sen.startIso ?? ''}
              onchange={(e) => { sen.startIso = (e.target as HTMLInputElement).value; }} />
          </div>
          <div class="field-row">
            <span class="field-lbl">End</span>
            <input class="datetime-input" type="datetime-local" value={sen.endIso ?? ''}
              onchange={(e) => { sen.endIso = (e.target as HTMLInputElement).value; }} />
          </div>
          <div class="field-hint">One-time activation. Sensor becomes inactive after the end time.</div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="empty">No sensors.</div>
  {/each}

  <!-- ── Capture Methods ──────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Capture Methods</span>
    <button class="add-btn" onclick={() => localCaptures = [...localCaptures, newCapture(localSources[0]?.id ?? 'default-mic')]}>+ Add</button>
  </div>
  {#each localCaptures as cap (cap.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge {cap.type}">{cap.type.toUpperCase()}</span>
        <input class="name-input" bind:value={cap.name} placeholder="Capture name" />
        <button class="rm-btn" onclick={() => localCaptures = localCaptures.filter(c => c.id !== cap.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row">
          <span class="field-lbl">Type</span>
          <select class="field-select" value={cap.type}
            onchange={(e) => changeCaptureType(cap.id, (e.target as HTMLSelectElement).value as CaptureMethod['type'])}>
            <option value="audio">Audio</option>
            <option value="video">Video</option>
            <option value="photo">Photo</option>
          </select>
        </label>
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
            <span class="field-lbl">Priority</span>
            <input class="num-input" type="number" min="1" step="1" value={cap.priority}
              oninput={(e) => patchCapture(cap.id, { priority: +(e.target as HTMLInputElement).value })} />
          </label>
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
          <label class="field-row">
            <span class="field-lbl">Audio kbps</span>
            <input class="num-input" type="number" min="0" step="8" placeholder="auto"
              value={cap.audioBitsPerSec ? Math.round(cap.audioBitsPerSec / 1000) : ''}
              oninput={(e) => patchCapture(cap.id, { audioBitsPerSec: (+(e.target as HTMLInputElement).value || 0) * 1000 })} />
          </label>
        {:else if cap.type === 'audio'}
          <label class="field-row">
            <span class="field-lbl">Priority</span>
            <input class="num-input" type="number" min="1" step="1" value={cap.priority}
              oninput={(e) => patchCapture(cap.id, { priority: +(e.target as HTMLInputElement).value })} />
          </label>
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
            <input class="num-input" type="number" min="0" step="1" placeholder="auto"
              value={cap.imageHeight || ''}
              oninput={(e) => patchCapture(cap.id, { imageHeight: +(e.target as HTMLInputElement).value })} />
            <span class="field-hint-inline">0 = proportional</span>
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

  <!-- ── Nostr Actions ────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Nostr Actions</span>
    <button class="add-btn" onclick={() => localNostrActions = [...localNostrActions, newNostrAction()]}>+ Add</button>
  </div>
  {#each localNostrActions as na (na.id)}
    <div class="pipeline-card">
      <div class="card-header">
        <span class="type-badge nostr">NOSTR</span>
        <input class="name-input" bind:value={na.name} placeholder="Action name" />
        <button class="rm-btn" onclick={() => localNostrActions = localNostrActions.filter(a => a.id !== na.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row slider-row">
          <span class="field-lbl">Cooldown: {(na.cooldownMs / 1000).toFixed(0)}s</span>
          <input type="range" min="0" max="300000" step="5000" value={na.cooldownMs}
            oninput={(e) => { na.cooldownMs = +(e.target as HTMLInputElement).value; }} />
        </label>
        <label class="field-row">
          <span class="field-lbl">Include data</span>
          <button class="toggle-pill" style="background:{na.includeData ? 'var(--color-success)' : 'var(--color-border)'}"
            onclick={() => { na.includeData = !na.includeData; }}>
            <span class="pill-thumb" style="transform:translateX({na.includeData ? '14px' : '2px'})"></span>
          </button>
        </label>
        <label class="field-row full-row">
          <span class="field-lbl">Message</span>
          <input class="name-input flex1" type="text" placeholder="Optional message prefix…"
            value={na.messageTemplate ?? ''}
            oninput={(e) => { na.messageTemplate = (e.target as HTMLInputElement).value || undefined; }} />
        </label>
      </div>
    </div>
  {:else}
    <div class="empty">No Nostr actions.</div>
  {/each}

  <!-- ── Links ────────────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Links</span>
    <button class="add-btn" onclick={() => localLinks = [...localLinks, newLink(localSensors[0]?.id ?? 'default-audio')]}>+ Add</button>
  </div>
  {#each localLinks as lnk (lnk.id)}
    {@const lb = linkBadge(lnk.id)}
    {@const capType = linkCaptureType(lnk.captureId)}
    <div class="pipeline-card" class:noop-card={isNoop(lnk)}>
      <div class="card-header">
        <span class="type-badge link">LINK</span>
        <input class="name-input" bind:value={lnk.name} placeholder="Link name" />
        <span class="state-badge {lb.kind}">{lb.label}</span>
        <button class="toggle-pill" style="background:{lnk.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => { lnk.enabled = !lnk.enabled; }}>
          <span class="pill-thumb" style="transform:translateX({lnk.enabled ? '14px' : '2px'})"></span>
        </button>
        <button class="rm-btn" onclick={() => localLinks = localLinks.filter(l => l.id !== lnk.id)}>✕</button>
      </div>
      <div class="card-body">
        <label class="field-row">
          <span class="field-lbl">Sensor</span>
          <select class="field-select" value={lnk.sensorId}
            onchange={(e) => { lnk.sensorId = (e.target as HTMLSelectElement).value; }}>
            {#each localSensors as sen}
              <option value={sen.id}>{sen.name}</option>
            {/each}
          </select>
        </label>
        <label class="field-row">
          <span class="field-lbl">On state</span>
          <select class="field-select" value={lnk.onState}
            onchange={(e) => { lnk.onState = (e.target as HTMLSelectElement).value as 'sensing' | 'active'; }}>
            <option value="sensing">Sensing</option>
            <option value="active">Active</option>
          </select>
        </label>
        <label class="field-row">
          <span class="field-lbl">Min state ms</span>
          <input class="num-input" type="number" min="0" step="100" value={lnk.minStateDurationMs}
            oninput={(e) => { lnk.minStateDurationMs = +(e.target as HTMLInputElement).value; }} />
        </label>
        <label class="field-row">
          <span class="field-lbl">Capture</span>
          <select class="field-select" value={lnk.captureId ?? ''}
            onchange={(e) => { lnk.captureId = (e.target as HTMLSelectElement).value || null; }}>
            <option value="">None</option>
            {#each localCaptures as cap}
              <option value={cap.id}>{cap.name} ({cap.type})</option>
            {/each}
          </select>
        </label>
        <label class="field-row">
          <span class="field-lbl">Action</span>
          <select class="field-select" value={lnk.nostrActionId ?? ''}
            onchange={(e) => { lnk.nostrActionId = (e.target as HTMLSelectElement).value || null; }}>
            <option value="">None</option>
            {#each localNostrActions as na}
              <option value={na.id}>{na.name}</option>
            {/each}
          </select>
        </label>
        <label class="field-row">
          <span class="field-lbl">Pre-roll</span>
          <div class="num-with-unit">
            <input class="num-input" type="number" min="0" step="5" value={lnk.preRollSec}
              oninput={(e) => { lnk.preRollSec = +(e.target as HTMLInputElement).value; }} />
            <span class="unit">s</span>
          </div>
        </label>
        <label class="field-row">
          <span class="field-lbl">Post-roll</span>
          <div class="num-with-unit">
            <input class="num-input" type="number" min="0" step="5" value={lnk.postRollSec}
              oninput={(e) => { lnk.postRollSec = +(e.target as HTMLInputElement).value; }} />
            <span class="unit">s</span>
          </div>
        </label>
        <label class="field-row">
          <span class="field-lbl">Retrigger</span>
          <select class="field-select" value={lnk.onRetrigger}
            onchange={(e) => { lnk.onRetrigger = (e.target as HTMLSelectElement).value as 'extend' | 'ignore' | 'restart'; }}>
            <option value="extend">Extend</option>
            <option value="ignore">Ignore</option>
            <option value="restart">Restart</option>
          </select>
        </label>
        <label class="field-row pin-row">
          <span class="field-lbl">Pin</span>
          <button class="toggle-pill" style="background:{lnk.pinLifetimeSec !== null ? 'var(--color-success)' : 'var(--color-border)'}"
            onclick={() => { lnk.pinLifetimeSec = lnk.pinLifetimeSec !== null ? null : 7 * 86400; }}>
            <span class="pill-thumb" style="transform:translateX({lnk.pinLifetimeSec !== null ? '14px' : '2px'})"></span>
          </button>
          {#if lnk.pinLifetimeSec !== null}
            <input class="num-input" type="number" min="1" step="1"
              value={lnk.pinLifetimeSec === 0 ? '' : Math.round(lnk.pinLifetimeSec / pinUnitSec(lnk.id, lnk.pinLifetimeSec))}
              placeholder={lnk.pinLifetimeSec === 0 ? '∞' : ''}
              disabled={lnk.pinLifetimeSec === 0}
              oninput={(e) => {
                const v = +(e.target as HTMLInputElement).value;
                lnk.pinLifetimeSec = v > 0 ? v * pinUnitSec(lnk.id, lnk.pinLifetimeSec) : 0;
              }} />
            <select class="field-select pin-unit-select"
              value={pinUnit(lnk.id, lnk.pinLifetimeSec)}
              disabled={lnk.pinLifetimeSec === 0}
              onchange={(e) => {
                const newUnit = (e.target as HTMLSelectElement).value as PinUnit;
                pinUnits = { ...pinUnits, [lnk.id]: newUnit };
                const uSec = PIN_UNITS.find(u => u.label === newUnit)!.s;
                // Convert existing value to new unit, preserve duration
                if (lnk.pinLifetimeSec && lnk.pinLifetimeSec > 0) {
                  const count = Math.max(1, Math.round(lnk.pinLifetimeSec / uSec));
                  lnk.pinLifetimeSec = count * uSec;
                }
              }}>
              {#each PIN_UNITS as u}
                <option value={u.label}>{u.label}</option>
              {/each}
            </select>
            <label class="forever-label">
              <input type="checkbox" checked={lnk.pinLifetimeSec === 0}
                onchange={(e) => { lnk.pinLifetimeSec = (e.target as HTMLInputElement).checked ? 0 : 7 * 86400; }} />
              ∞
            </label>
          {/if}
        </label>
        {#if capType === 'photo'}
          <label class="field-row">
            <span class="field-lbl">Snapshots</span>
            <input class="num-input" type="number" min="1" step="1" value={lnk.snapshotCount}
              oninput={(e) => { lnk.snapshotCount = +(e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field-row">
            <span class="field-lbl">Interval</span>
            <div class="num-with-unit">
              <input class="num-input" type="number" min="0" step="0.5" value={lnk.intervalSec}
                oninput={(e) => { lnk.intervalSec = +(e.target as HTMLInputElement).value; }} />
              <span class="unit">s</span>
            </div>
          </label>
        {/if}
        {#if isNoop(lnk)}
          <div class="noop-warn">⚠ No capture or action — this link does nothing.</div>
        {/if}
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

      <!-- Thinning rules -->
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
  .noop-card { border-color: var(--color-warning); }
  .card-header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--color-surface); }
  .card-body { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; padding: 7px 8px; background: var(--color-bg); align-items: start; }

  .type-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; }
  .type-badge.mic    { background: #2563eb; color: white; }
  .type-badge.cam    { background: #7c3aed; color: white; }
  .type-badge.screen { background: #0e7490; color: white; }
  .type-badge.audio  { background: #2563eb; color: white; }
  .type-badge.sched  { background: #0891b2; color: white; }
  .type-badge.video { background: #7c3aed; color: white; }
  .type-badge.photo { background: #059669; color: white; }
  .type-badge.nostr { background: #9333ea; color: white; }
  .type-badge.link  { background: #d97706; color: white; }

  .state-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--color-border); color: var(--color-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .state-badge.idle     { background: var(--color-border); color: var(--color-muted); }
  .state-badge.inactive { background: var(--color-border); color: var(--color-muted); opacity: 0.6; }
  .state-badge.sensing  { background: #1d4ed8; color: white; }
  .state-badge.waiting  { background: #92400e; color: #fcd34d; }
  .state-badge.active   { background: var(--color-success); color: white; }
  .state-badge.settling { background: var(--color-warning); color: #1a1a1a; }

  .name-input {
    flex: 1; font-size: 12px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
    border: 1px solid transparent; background: transparent; color: var(--color-text); font-family: inherit;
  }
  .name-input:hover, .name-input:focus { border-color: var(--color-border); background: var(--color-bg); outline: none; }
  .name-input.flex1 { min-width: 0; }

  .field-row { display: flex; align-items: center; gap: 4px; }
  .field-lbl { font-size: 10px; color: var(--color-muted); white-space: nowrap; min-width: 68px; }
  .slider-row { flex-direction: column; align-items: stretch; gap: 2px; grid-column: 1 / -1; }
  .slider-row input[type="range"] { width: 100%; }
  .full-row { grid-column: 1 / -1; }
  .pin-row { flex-wrap: wrap; gap: 4px; grid-column: 1 / -1; }

  .field-select { font-size: 11px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; max-width: 160px; }
  .num-input { font-size: 11px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; width: 55px; }
  .num-with-unit { display: flex; align-items: center; gap: 2px; }
  .unit { font-size: 10px; color: var(--color-muted); }
  .forever-label { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--color-muted); cursor: pointer; }
  .pin-unit-select { max-width: 80px; }

  .toggle-pill { width: 28px; height: 16px; border-radius: 8px; border: none; padding: 0; cursor: pointer; position: relative; flex-shrink: 0; overflow: hidden; transition: background 0.15s; }
  .pill-thumb { position: absolute; top: 2px; left: 0; width: 12px; height: 12px; border-radius: 50%; background: white; transition: transform 0.15s; }
  .rm-btn { font-size: 11px; padding: 0 4px; border: none; background: none; color: var(--color-muted); cursor: pointer; flex-shrink: 0; }
  .rm-btn:hover { color: var(--color-danger); }

  .noop-warn { grid-column: 1 / -1; font-size: 10px; color: var(--color-warning); padding: 2px 0; }

  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .act-btn:hover { color: var(--color-text); }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .raw { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 10px; border-radius: 6px; overflow: auto; max-height: 300px; color: #a3e635; }
  .save-error { font-size: 11px; color: var(--color-danger); background: rgba(239,68,68,0.08); border: 1px solid var(--color-danger); border-radius: 4px; padding: 4px 8px; }
  .empty { font-size: 11px; color: var(--color-muted); padding: 4px 0; }
  .field-hint { font-size: 10px; color: var(--color-muted); font-style: italic; padding: 2px 0; grid-column: 1 / -1; }
  .field-hint-inline { font-size: 10px; color: var(--color-muted); font-style: italic; }

  .thin-rules-header { display: flex; align-items: center; justify-content: space-between; }
  .thin-rule-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .thin-select { font-size: 11px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; }
  .thin-select-type { min-width: 80px; }
  .remove-btn { font-size: 11px; padding: 0 5px; border: none; background: none; color: var(--color-muted); cursor: pointer; }
  .remove-btn:hover { color: var(--color-danger); }

  /* Time-window and date-range sensor inputs */
  .time-input { font-size: 11px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; }
  .datetime-input { font-size: 11px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; width: 100%; max-width: 200px; }
  .dow-pills { display: flex; gap: 3px; align-items: center; flex-wrap: wrap; }
  .dow-pill { font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; transition: background 0.12s, color 0.12s; }
  .dow-pill.active { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .dow-pill:hover:not(.active) { border-color: var(--color-accent); color: var(--color-accent); }
</style>
