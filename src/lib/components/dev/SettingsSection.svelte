<script lang="ts">
  import { settings, saveSettings } from '$lib/store/settings';
  import { triggers, saveTriggers, newTrigger, loadTriggers } from '$lib/store/triggers';
  import type { TriggerConfig } from '$lib/store/triggers';
  import DevSection from './DevSection.svelte';
  import { onMount } from 'svelte';

  interface Props {
    activeTriggerIds?: string[];  // from SentrySection: currently firing triggers
  }
  let { activeTriggerIds = [] }: Props = $props();

  let showRaw = $state(false);
  let saveFlash = $state(false);
  let localTriggers = $state<TriggerConfig[]>([]);

  onMount(async () => {
    await loadTriggers();
    localTriggers = [...$triggers];
  });

  function updateTrigger(id: string, patch: Partial<TriggerConfig>) {
    localTriggers = localTriggers.map(t => t.id === id ? { ...t, ...patch } : t);
  }

  async function save() {
    await saveTriggers(localTriggers);
    const s = $settings;
    await saveSettings(s);
    saveFlash = true;
    setTimeout(() => (saveFlash = false), 1500);
  }

  function add() {
    const t = newTrigger();
    localTriggers = [...localTriggers, t];
  }

  function remove(id: string) {
    localTriggers = localTriggers.filter(t => t.id !== id);
  }

  async function resetDefault() {
    if (!confirm('Reset all settings and triggers to defaults?')) return;
    const { DEFAULT_RELAY, saveSettings: save } = await import('$lib/store/settings');
    await save({ ...$settings, relayUrl: DEFAULT_RELAY, pauseNostr: false, storeEvents: true, nostrRateLimit: 200 });
    localTriggers = [newTrigger()];
    await saveTriggers(localTriggers);
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
    <div class="trigger-card">
      <div class="trigger-header">
        <span class="type-badge">Audio</span>
        <input
          class="name-input"
          value={t.name}
          oninput={(e) => updateTrigger(t.id, { name: (e.target as HTMLInputElement).value })}
          placeholder="Trigger name"
        />
        <span class="active-badge" class:active={activeTriggerIds.includes(t.id)}>
          {activeTriggerIds.includes(t.id) ? 'ACTIVE' : 'IDLE'}
        </span>
        <button
          class="toggle-pill"
          style="background:{t.enabled ? 'var(--color-success)' : 'var(--color-border)'}"
          onclick={() => updateTrigger(t.id, { enabled: !t.enabled })}
        >
          <span class="pill-thumb" style="transform:translateX({t.enabled ? '14px' : '2px'})"></span>
        </button>
        <button class="rm-btn" onclick={() => remove(t.id)}>✕</button>
      </div>
      <div class="trigger-sliders">
        <label class="slider-row">
          <span class="slider-lbl">Threshold: {t.thresholdDb} dBFS</span>
          <input type="range" min="-70" max="-10" step="1" value={t.thresholdDb}
            oninput={(e) => updateTrigger(t.id, { thresholdDb: +(e.target as HTMLInputElement).value })} />
        </label>
        <label class="slider-row">
          <span class="slider-lbl">Cooldown: {(t.cooldownMs / 1000).toFixed(1)}s</span>
          <input type="range" min="500" max="10000" step="500" value={t.cooldownMs}
            oninput={(e) => updateTrigger(t.id, { cooldownMs: +(e.target as HTMLInputElement).value })} />
        </label>
        <label class="slider-row">
          <span class="slider-lbl">Min duration: {(t.minDurationMs / 1000).toFixed(2)}s</span>
          <input type="range" min="0" max="5000" step="250" value={t.minDurationMs}
            oninput={(e) => updateTrigger(t.id, { minDurationMs: +(e.target as HTMLInputElement).value })} />
        </label>
      </div>
    </div>
  {:else}
    <div class="empty">No triggers — add one below.</div>
  {/each}
  <button class="act-btn accent" onclick={add}>+ Add Trigger</button>

  <!-- Segment settings -->
  <div class="subsec-title">Segment Settings</div>

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
  .active-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--color-border); color: var(--color-muted); }
  .active-badge.active { background: var(--color-success); color: white; }
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
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .act-btn:hover { color: var(--color-text); }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .raw { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 10px; border-radius: 6px; overflow: auto; max-height: 300px; color: #a3e635; }
  .empty { font-size: 11px; color: var(--color-muted); padding: 6px 0; }
</style>
