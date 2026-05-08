<script lang="ts">
  import { settings, saveSettings } from '$lib/store/settings';
  import { triggers, saveTriggers, newTrigger, loadTriggers } from '$lib/store/triggers';
  import type { TriggerConfig } from '$lib/store/triggers';
  import type { DetectorTriggerState } from '$lib/detectors/audio';
  import type { AlertSession } from './SentrySection.svelte';
  import DevSection from './DevSection.svelte';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';

  interface Props {
    triggerStates?: Record<string, DetectorTriggerState>;
    activeAlerts?: AlertSession[];
  }
  let { triggerStates = {}, activeAlerts = [] }: Props = $props();

  let showRaw = $state(false);
  let saveFlash = $state(false);
  let localTriggers = $state<TriggerConfig[]>([]);

  onMount(async () => {
    await loadTriggers();
    // Use get() — reading $triggers after an await in Svelte 5 can yield a stale value
    localTriggers = get(triggers).map(t => ({ ...t }));
  });

  // Plain-object snapshot: strips Svelte 5 reactive proxies before IDB serialization.
  // Structured clone silently produces empty objects when given a Proxy.
  function plainTriggers(): TriggerConfig[] {
    return localTriggers.map(t => ({ ...t }));
  }

  async function save() {
    const plain = plainTriggers();
    await saveTriggers(plain);
    localTriggers = plain;  // re-sync so $state reflects the saved plain objects
    await saveSettings({ ...$settings });
    saveFlash = true;
    setTimeout(() => (saveFlash = false), 1500);
  }

  function add() {
    localTriggers = [...plainTriggers(), newTrigger()];
  }

  function remove(id: string) {
    localTriggers = plainTriggers().filter(t => t.id !== id);
  }

  async function resetDefault() {
    if (!confirm('Reset all settings and triggers to defaults?')) return;
    const { DEFAULT_RELAY, saveSettings: save } = await import('$lib/store/settings');
    await save({ ...$settings, relayUrl: DEFAULT_RELAY, pauseNostr: false, storeEvents: true, nostrRateLimit: 200 });
    const plain = [newTrigger()];
    localTriggers = plain;
    await saveTriggers(plain);
  }

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 150);
    return () => clearInterval(id);
  });

  function triggerBadge(id: string): { label: string; kind: 'idle' | 'active' | 'settling' } {
    const s = triggerStates[id];
    if (!s || s.status === 'idle') return { label: 'IDLE', kind: 'idle' };
    if (s.status === 'active') {
      const elapsed = (now - s.startedAt) / 1000;
      const minSec = s.minDurationMs / 1000;
      const label = minSec > 0 && elapsed < minSec
        ? `ACTIVE ${elapsed.toFixed(1)}/${minSec.toFixed(1)}s`
        : 'ACTIVE';
      return { label, kind: 'active' };
    }
    const remaining = Math.max(0, (s.endsAt - now) / 1000);
    return { label: `SETTLING ${remaining.toFixed(1)}s`, kind: 'settling' };
  }

  let videoForm = $derived({ ...$settings.videoConfig });
  let photoForm = $derived({ ...$settings.photoConfig });

  async function updateVideoConfig(patch: Partial<typeof videoForm>) {
    await saveSettings({ ...$settings, videoConfig: { ...$settings.videoConfig, ...patch } });
  }

  async function updatePhotoConfig(patch: Partial<typeof photoForm>) {
    await saveSettings({ ...$settings, photoConfig: { ...$settings.photoConfig, ...patch } });
  }
</script>

<DevSection title="Settings">
  {#snippet summary()}
    {#if activeAlerts.length > 0}
      ALERT · {activeAlerts.map(a => a.triggerType).join(', ')} · {localTriggers.length} trigger{localTriggers.length === 1 ? '' : 's'}
    {:else if Object.values(triggerStates).some(s => s.status === 'active')}
      ACTIVE · {localTriggers.filter(t => triggerStates[t.id]?.status === 'active').map(t => t.name).join(', ')}
    {:else if Object.values(triggerStates).some(s => s.status === 'settling')}
      SETTLING · {localTriggers.length} trigger{localTriggers.length === 1 ? '' : 's'}
    {:else}
      {localTriggers.length} trigger{localTriggers.length === 1 ? '' : 's'} · IDLE
    {/if}
  {/snippet}
  {#snippet actions()}
    <button class="act-btn" onclick={() => (showRaw = !showRaw)}>{showRaw ? 'Hide' : 'View'} Raw</button>
    <button class="act-btn danger" onclick={resetDefault}>Reset Default</button>
    <button class="act-btn accent" onclick={save}>{saveFlash ? '✓ Saved' : 'Save'}</button>
  {/snippet}

  {#if showRaw}
    <pre class="raw">{JSON.stringify({ settings: $settings, triggers: localTriggers }, null, 2)}</pre>
  {/if}

  <!-- Triggers -->
  <div class="subsec-title">Triggers</div>
  {#each localTriggers as t (t.id)}
    {@const tb = triggerBadge(t.id)}
    <div class="trigger-card">
      <div class="trigger-header">
        <span class="type-badge">Audio</span>
        <input
          class="name-input"
          bind:value={t.name}
          placeholder="Trigger name"
        />
        <span class="active-badge" class:active={tb.kind === 'active'} class:settling={tb.kind === 'settling'}>
          {tb.label}
        </span>
        <button
          class="toggle-pill"
          style="background:{t.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => { t.enabled = !t.enabled; }}
        >
          <span class="pill-thumb" style="transform:translateX({t.enabled ? '14px' : '2px'})"></span>
        </button>
        <button class="rm-btn" onclick={() => remove(t.id)}>✕</button>
      </div>
      <div class="trigger-sliders">
        <label class="slider-row">
          <span class="slider-lbl">Threshold: {t.thresholdDb} dBFS</span>
          <input type="range" min="-70" max="-10" step="1" value={t.thresholdDb}
            oninput={(e) => { t.thresholdDb = +(e.target as HTMLInputElement).value; }} />
        </label>
        <label class="slider-row">
          <span class="slider-lbl">Cooldown: {(t.cooldownMs / 1000).toFixed(1)}s</span>
          <input type="range" min="500" max="10000" step="500" value={t.cooldownMs}
            oninput={(e) => { t.cooldownMs = +(e.target as HTMLInputElement).value; }} />
        </label>
        <label class="slider-row">
          <span class="slider-lbl">Min duration: {(t.minDurationMs / 1000).toFixed(2)}s</span>
          <input type="range" min="0" max="5000" step="250" value={t.minDurationMs}
            oninput={(e) => { t.minDurationMs = +(e.target as HTMLInputElement).value; }} />
        </label>
      </div>
    </div>
  {:else}
    <div class="empty">No triggers — add one below.</div>
  {/each}

  {#if activeAlerts.length > 0}
    <div class="subsec-title">Active Alerts</div>
    {#each activeAlerts as alert (alert.triggerType)}
      <div class="alert-live-row">
        <span class="alert-live-dot"></span>
        <span class="alert-live-type">{alert.triggerType}</span>
        <span class="alert-live-label">Recording</span>
        <span class="alert-live-media">{alert.mimeType.startsWith('video/') ? 'Video' : alert.mimeType.startsWith('image/') ? 'Photo' : 'Audio'}</span>
        <span class="alert-live-time">{new Date(alert.startTime * 1000).toLocaleTimeString()} – {new Date(alert.endTime * 1000).toLocaleTimeString()}</span>
        <span class="alert-live-dur">{alert.endTime - alert.startTime}s</span>
      </div>
    {/each}
  {/if}

  <button class="act-btn accent" onclick={add}>+ Add Trigger</button>

  <!-- Alert settings -->
  <div class="subsec-title">Alert Settings</div>

  <div class="seg-card">
    <span class="seg-type-badge video">Video</span>
    <div class="seg-fields">
      <label class="seg-field">
        <span class="seg-lbl">Trigger</span>
        <select class="seg-select" value={$settings.videoConfig.triggerId}
          onchange={(e) => updateVideoConfig({ triggerId: (e.target as HTMLSelectElement).value })}>
          {#each localTriggers as t}
            <option value={t.id}>{t.name}</option>
          {/each}
          <option value="default">All triggers</option>
        </select>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Pre-roll</span>
        <div class="num-with-unit">
          <input type="number" class="num-input" value={$settings.videoConfig.preRollSec}
            oninput={(e) => updateVideoConfig({ preRollSec: +(e.target as HTMLInputElement).value })} />
          <span class="unit">s</span>
        </div>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Post-roll</span>
        <div class="num-with-unit">
          <input type="number" class="num-input" value={$settings.videoConfig.postRollSec}
            oninput={(e) => updateVideoConfig({ postRollSec: +(e.target as HTMLInputElement).value })} />
          <span class="unit">s</span>
        </div>
      </label>
      <label class="seg-field toggle-field">
        <span class="seg-lbl">Record video</span>
        <button
          class="toggle-pill"
          style="background:{$settings.videoConfig.recordVideo ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => updateVideoConfig({ recordVideo: !$settings.videoConfig.recordVideo })}
        >
          <span class="pill-thumb" style="transform:translateX({$settings.videoConfig.recordVideo ? '14px' : '2px'})"></span>
        </button>
      </label>
      <label class="seg-field toggle-field">
        <span class="seg-lbl">Pin on alert</span>
        <button
          class="toggle-pill"
          style="background:{$settings.videoConfig.pinLifetimeSec !== null ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => updateVideoConfig({ pinLifetimeSec: $settings.videoConfig.pinLifetimeSec !== null ? null : 7 * 86400 })}
        >
          <span class="pill-thumb" style="transform:translateX({$settings.videoConfig.pinLifetimeSec !== null ? '14px' : '2px'})"></span>
        </button>
      </label>
      {#if $settings.videoConfig.pinLifetimeSec !== null}
        <label class="seg-field lifetime-field">
          <span class="seg-lbl">Pin lifetime</span>
          <input type="number" class="num-input" min="0" step="1"
            value={$settings.videoConfig.pinLifetimeSec === 0 ? '' : Math.round($settings.videoConfig.pinLifetimeSec / 86400)}
            placeholder={$settings.videoConfig.pinLifetimeSec === 0 ? '∞' : ''}
            disabled={$settings.videoConfig.pinLifetimeSec === 0}
            oninput={(e) => { const d = +(e.target as HTMLInputElement).value; updateVideoConfig({ pinLifetimeSec: d <= 0 ? 0 : d * 86400 }); }}
          />
          <span class="unit">days</span>
          <label class="forever-label">
            <input type="checkbox"
              checked={$settings.videoConfig.pinLifetimeSec === 0}
              onchange={(e) => updateVideoConfig({ pinLifetimeSec: (e.target as HTMLInputElement).checked ? 0 : 7 * 86400 })}
            /> Forever
          </label>
        </label>
      {/if}
      <label class="seg-field">
        <span class="seg-lbl">Codec</span>
        <select class="seg-select" value={$settings.videoConfig.videoCodec}
          onchange={(e) => updateVideoConfig({ videoCodec: (e.target as HTMLSelectElement).value })}>
          <option value="">Auto</option>
          <option value="video/webm;codecs=vp9,opus">VP9 + Opus</option>
          <option value="video/webm;codecs=vp8,opus">VP8 + Opus</option>
          <option value="video/webm">WebM (auto codec)</option>
        </select>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Resolution</span>
        <div class="num-with-unit">
          <input type="number" class="num-input" min="0" step="1" placeholder="auto"
            value={$settings.videoConfig.videoWidth || ''}
            oninput={(e) => updateVideoConfig({ videoWidth: +(e.target as HTMLInputElement).value || 0 })} />
          <span class="unit">×</span>
          <input type="number" class="num-input" min="0" step="1" placeholder="auto"
            value={$settings.videoConfig.videoHeight || ''}
            oninput={(e) => updateVideoConfig({ videoHeight: +(e.target as HTMLInputElement).value || 0 })} />
        </div>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Video kbps</span>
        <div class="num-with-unit">
          <input type="number" class="num-input" min="0" step="100" placeholder="auto"
            value={$settings.videoConfig.videoBitsPerSec ? Math.round($settings.videoConfig.videoBitsPerSec / 1000) : ''}
            oninput={(e) => updateVideoConfig({ videoBitsPerSec: ((e.target as HTMLInputElement).valueAsNumber || 0) * 1000 })} />
          <span class="unit">kbps</span>
        </div>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Audio kbps</span>
        <div class="num-with-unit">
          <input type="number" class="num-input" min="0" step="8" placeholder="auto"
            value={$settings.videoConfig.audioBitsPerSec ? Math.round($settings.videoConfig.audioBitsPerSec / 1000) : ''}
            oninput={(e) => updateVideoConfig({ audioBitsPerSec: ((e.target as HTMLInputElement).valueAsNumber || 0) * 1000 })} />
          <span class="unit">kbps</span>
        </div>
      </label>
    </div>
  </div>

  <div class="seg-card">
    <span class="seg-type-badge photo">Photo</span>
    <div class="seg-fields">
      <label class="seg-field">
        <span class="seg-lbl">Trigger</span>
        <select class="seg-select" value={$settings.photoConfig.triggerId}
          onchange={(e) => updatePhotoConfig({ triggerId: (e.target as HTMLSelectElement).value })}>
          {#each localTriggers as t}
            <option value={t.id}>{t.name}</option>
          {/each}
          <option value="default">All triggers</option>
        </select>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Count</span>
        <input type="number" class="num-input" value={$settings.photoConfig.snapshotCount}
          oninput={(e) => updatePhotoConfig({ snapshotCount: +(e.target as HTMLInputElement).value })} />
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Interval</span>
        <div class="num-with-unit">
          <input type="number" class="num-input" value={$settings.photoConfig.intervalSec}
            oninput={(e) => updatePhotoConfig({ intervalSec: +(e.target as HTMLInputElement).value })} />
          <span class="unit">s</span>
        </div>
      </label>
      <label class="seg-field">
        <span class="seg-lbl">Format</span>
        <select class="seg-select" value={$settings.photoConfig.imageFormat ?? 'image/jpeg'}
          onchange={(e) => updatePhotoConfig({ imageFormat: (e.target as HTMLSelectElement).value })}>
          <option value="image/jpeg">JPEG</option>
          <option value="image/webp">WebP</option>
          <option value="image/png">PNG</option>
        </select>
      </label>
      <label class="seg-field toggle-field">
        <span class="seg-lbl">Enabled</span>
        <button
          class="toggle-pill"
          style="background:{$settings.photoConfig.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => updatePhotoConfig({ enabled: !$settings.photoConfig.enabled })}
        >
          <span class="pill-thumb" style="transform:translateX({$settings.photoConfig.enabled ? '14px' : '2px'})"></span>
        </button>
      </label>
      <label class="seg-field toggle-field">
        <span class="seg-lbl">Pin on alert</span>
        <button
          class="toggle-pill"
          style="background:{$settings.photoConfig.pinLifetimeSec !== null ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => updatePhotoConfig({ pinLifetimeSec: $settings.photoConfig.pinLifetimeSec !== null ? null : 30 * 86400 })}
        >
          <span class="pill-thumb" style="transform:translateX({$settings.photoConfig.pinLifetimeSec !== null ? '14px' : '2px'})"></span>
        </button>
      </label>
      {#if $settings.photoConfig.pinLifetimeSec !== null}
        <label class="seg-field lifetime-field">
          <span class="seg-lbl">Pin lifetime</span>
          <input type="number" class="num-input" min="0" step="1"
            value={$settings.photoConfig.pinLifetimeSec === 0 ? '' : Math.round($settings.photoConfig.pinLifetimeSec / 86400)}
            placeholder={$settings.photoConfig.pinLifetimeSec === 0 ? '∞' : ''}
            disabled={$settings.photoConfig.pinLifetimeSec === 0}
            oninput={(e) => { const d = +(e.target as HTMLInputElement).value; updatePhotoConfig({ pinLifetimeSec: d <= 0 ? 0 : d * 86400 }); }}
          />
          <span class="unit">days</span>
          <label class="forever-label">
            <input type="checkbox"
              checked={$settings.photoConfig.pinLifetimeSec === 0}
              onchange={(e) => updatePhotoConfig({ pinLifetimeSec: (e.target as HTMLInputElement).checked ? 0 : 30 * 86400 })}
            /> Forever
          </label>
        </label>
      {/if}
    </div>
  </div>
</DevSection>

<style>
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 4px; }
  .trigger-card { border: 1px solid var(--color-border); border-radius: 6px; overflow: hidden; }
  .trigger-header {
    display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    background: var(--color-surface);
  }
  .type-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: #3b82f6; color: white; text-transform: uppercase; }
  .name-input {
    flex: 1; font-size: 12px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
    border: 1px solid transparent; background: transparent; color: var(--color-text); font-family: inherit;
  }
  .name-input:hover, .name-input:focus { border-color: var(--color-border); background: var(--color-bg); outline: none; }
  .active-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--color-border); color: var(--color-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .active-badge.active { background: var(--color-success); color: white; }
  .active-badge.settling { background: var(--color-warning); color: #1a1a1a; }
  .alert-live-row {
    display: flex; align-items: center; gap: 7px; padding: 5px 8px;
    border-radius: 5px; background: rgba(239,68,68,0.07); border: 1px solid rgba(239,68,68,0.18);
    font-size: 11px;
  }
  .alert-live-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--color-danger);
    animation: pulse 1.2s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .alert-live-type { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--color-danger); color: white; text-transform: uppercase; flex-shrink: 0; }
  .alert-live-label { color: var(--color-muted); font-size: 10px; }
  .alert-live-media { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border); }
  .alert-live-time { font-family: ui-monospace, monospace; font-size: 10px; color: var(--color-muted); flex: 1; }
  .alert-live-dur { font-size: 10px; color: var(--color-muted); font-family: ui-monospace, monospace; }
  .toggle-pill { width: 28px; height: 16px; border-radius: 8px; border: none; padding: 0; cursor: pointer; position: relative; flex-shrink: 0; overflow: hidden; transition: background 0.15s; }
  .pill-thumb { position: absolute; top: 2px; left: 0; width: 12px; height: 12px; border-radius: 50%; background: white; transition: transform 0.15s; }
  .rm-btn { font-size: 11px; padding: 0 4px; border: none; background: none; color: var(--color-muted); cursor: pointer; }
  .rm-btn:hover { color: var(--color-danger); }
  .trigger-sliders { display: flex; flex-direction: column; gap: 4px; padding: 8px; background: var(--color-bg); }
  .slider-row { display: flex; flex-direction: column; gap: 2px; }
  .slider-lbl { font-size: 10px; color: var(--color-muted); }
  .slider-row input[type="range"] { width: 100%; }
  .seg-card { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); }
  .seg-type-badge { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; margin-top: 2px; }
  .seg-type-badge.video { background: #7c3aed; color: white; }
  .seg-type-badge.photo { background: #059669; color: white; }
  .seg-fields { display: flex; flex-wrap: wrap; gap: 8px; flex: 1; }
  .seg-field { display: flex; align-items: center; gap: 4px; }
  .seg-lbl { font-size: 10px; color: var(--color-muted); white-space: nowrap; }
  .seg-select { font-size: 11px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; }
  .num-input { font-size: 11px; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: inherit; width: 55px; }
  .num-with-unit { display: flex; align-items: center; gap: 2px; }
  .unit { font-size: 10px; color: var(--color-muted); }
  .toggle-field { gap: 6px; }
  .lifetime-field { gap: 5px; }
  .forever-label { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--color-muted); cursor: pointer; }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .act-btn:hover { color: var(--color-text); }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .raw { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 10px; border-radius: 6px; overflow: auto; max-height: 300px; color: #a3e635; }
  .empty { font-size: 11px; color: var(--color-muted); padding: 6px 0; }
</style>
