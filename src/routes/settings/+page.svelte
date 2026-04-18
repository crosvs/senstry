<script lang="ts">
  import { onMount } from "svelte";
  import { settings, saveSettings } from "$lib/store/settings";
  import { identity } from "$lib/store/identity";
  import { toNsec, toNpub, importFromNsec } from "$lib/nostr/keys";
  import { setRelays } from "$lib/nostr/client";
  import {
    triggers,
    saveTriggers,
    newTrigger,
    loadTriggers,
  } from "$lib/store/triggers";
  import {
    getStorageUsed,
    setQuota,
    DEFAULT_QUOTA_BYTES,
  } from "$lib/db/segments";
  import type { TriggerConfig } from "$lib/store/triggers";

  let form = $state({ ...$settings });
  let saved = $state(false);
  let nsecExport = $state("");
  let nsecImport = $state("");
  let importError = $state("");

  // Triggers: local editable copy
  let localTriggers = $state<TriggerConfig[]>([...$triggers]);
  let expandedTrigger = $state<string | null>(null);

  // Storage
  let quotaMb = $state(Math.round(DEFAULT_QUOTA_BYTES / (1024 * 1024)));
  let usedMb = $state(0);

  async function save() {
    await saveSettings(form);
    setRelays([form.relayUrl]);
    await saveTriggers(localTriggers);
    await setQuota(quotaMb * 1024 * 1024);
    saved = true;
    setTimeout(() => (saved = false), 2000);
  }

  function exportKey() {
    if ($identity) nsecExport = toNsec($identity.privkey);
  }

  async function importKey() {
    importError = "";
    try {
      const id = await importFromNsec(nsecImport.trim());
      identity.set(id);
      nsecImport = "";
    } catch (e) {
      importError = e instanceof Error ? e.message : "Invalid key";
    }
  }

  function addTrigger() {
    const t = newTrigger();
    localTriggers = [...localTriggers, t];
    expandedTrigger = t.id;
  }

  function removeTrigger(id: string) {
    localTriggers = localTriggers.filter((t) => t.id !== id);
    if (expandedTrigger === id) expandedTrigger = null;
  }

  function updateTrigger(id: string, patch: Partial<TriggerConfig>) {
    localTriggers = localTriggers.map((t) =>
      t.id === id ? { ...t, ...patch } : t,
    );
  }

  onMount(async () => {
    await loadTriggers();
    localTriggers = [...$triggers];
    usedMb = Math.round((await getStorageUsed()) / (1024 * 1024));
  });
</script>

<svelte:head><title>Settings — Senstry</title></svelte:head>

<main
  class="flex-1 flex flex-col gap-6 p-6 max-w-lg mx-auto"
  style="background:var(--color-bg)"
>
  <div class="flex items-center gap-3">
    <a href="/" class="text-sm" style="color:var(--color-accent)">← Home</a>
    <h1 class="text-xl font-bold" style="color:var(--color-text)">Settings</h1>
  </div>

  <!-- Relay -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-sm font-semibold uppercase tracking-wide"
      style="color:var(--color-muted)"
    >
      Relay
    </h2>
    <input
      bind:value={form.relayUrl}
      placeholder="wss://relay.example.com"
      class="px-4 py-2 rounded-lg text-sm"
      style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)"
    />
  </section>

  <!-- Monitor -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-sm font-semibold uppercase tracking-wide"
      style="color:var(--color-muted)"
    >
      Monitor
    </h2>
    <input
      bind:value={form.monitorLabel}
      placeholder="Monitor label"
      class="px-4 py-2 rounded-lg text-sm"
      style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)"
    />
    <label class="flex items-center gap-3">
      <button
        onclick={() => (form.recordVideo = !form.recordVideo)}
        class="w-10 h-6 rounded-full relative shrink-0 transition-colors"
        style="background:{form.recordVideo
          ? 'var(--color-success)'
          : 'var(--color-border)'}"
        aria-label="Record video"
      >
        <span
          class="absolute top-1 left-0 w-4 h-4 rounded-full transition-transform"
          style="background:white;transform:translateX({form.recordVideo
            ? '22px'
            : '4px'})"
        ></span>
      </button>
      <span class="text-sm" style="color:var(--color-text)">Record video</span>
    </label>
    <p class="text-xs" style="color:var(--color-muted)">
      When enabled, segments include video+audio. Requires more storage. Restart
      monitor after changing.
    </p>
  </section>

  <!-- Triggers -->
  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <h2
        class="text-sm font-semibold uppercase tracking-wide"
        style="color:var(--color-muted)"
      >
        Triggers
      </h2>
      <button
        onclick={addTrigger}
        class="text-xs px-3 py-1 rounded-lg font-semibold"
        style="background:var(--color-accent);color:white">+ Add</button
      >
    </div>

    {#each localTriggers as trigger (trigger.id)}
      <div
        class="rounded-xl overflow-hidden"
        style="border:1px solid var(--color-border)"
      >
        <!-- Trigger header row -->
        <div
          class="flex items-center gap-3 px-4 py-3"
          style="background:var(--color-surface)"
        >
          <!-- Enabled toggle -->
          <button
            onclick={() =>
              updateTrigger(trigger.id, { enabled: !trigger.enabled })}
            class="w-8 h-5 rounded-full relative shrink-0 transition-colors"
            style="background:{trigger.enabled
              ? 'var(--color-success)'
              : 'var(--color-border)'}"
            title={trigger.enabled ? "Disable" : "Enable"}
          >
            <span
              class="absolute top-0.5 left-0 w-4 h-4 rounded-full transition-transform"
              style="background:white;transform:translateX({trigger.enabled
                ? '14px'
                : '2px'})"
            ></span>
          </button>

          <button
            onclick={() =>
              (expandedTrigger =
                expandedTrigger === trigger.id ? null : trigger.id)}
            class="flex-1 text-left text-sm font-medium"
            style="color:var(--color-text)"
          >
            {trigger.name}
          </button>
          <span class="text-xs font-mono" style="color:var(--color-muted)"
            >{trigger.thresholdDb} dB</span
          >
          <button
            onclick={() => removeTrigger(trigger.id)}
            class="text-xs px-2 py-1 rounded"
            style="color:var(--color-danger)"
            title="Delete trigger">✕</button
          >
        </div>

        {#if expandedTrigger === trigger.id}
          <div
            class="flex flex-col gap-4 px-4 py-4 border-t"
            style="background:var(--color-bg);border-color:var(--color-border)"
          >
            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color:var(--color-muted)">Name</span>
              <input
                value={trigger.name}
                oninput={(e) =>
                  updateTrigger(trigger.id, {
                    name: (e.target as HTMLInputElement).value,
                  })}
                class="px-3 py-2 rounded-lg text-sm"
                style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)"
              />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color:var(--color-muted)">
                Threshold: {trigger.thresholdDb} dBFS
              </span>
              <input
                type="range"
                min="-70"
                max="-10"
                step="1"
                value={trigger.thresholdDb}
                oninput={(e) =>
                  updateTrigger(trigger.id, {
                    thresholdDb: +(e.target as HTMLInputElement).value,
                  })}
                class="w-full"
              />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color:var(--color-muted)">
                Cooldown: {trigger.cooldownMs / 1000}s (silence before event is
                written)
              </span>
              <input
                type="range"
                min="500"
                max="10000"
                step="500"
                value={trigger.cooldownMs}
                oninput={(e) =>
                  updateTrigger(trigger.id, {
                    cooldownMs: +(e.target as HTMLInputElement).value,
                  })}
                class="w-full"
              />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color:var(--color-muted)">
                Minimum duration: {trigger.minDurationMs / 1000}s (ignore
                shorter events)
              </span>
              <input
                type="range"
                min="0"
                max="5000"
                step="250"
                value={trigger.minDurationMs}
                oninput={(e) =>
                  updateTrigger(trigger.id, {
                    minDurationMs: +(e.target as HTMLInputElement).value,
                  })}
                class="w-full"
              />
            </label>
          </div>
        {/if}
      </div>
    {/each}

    {#if localTriggers.length === 0}
      <p class="text-xs text-center py-3" style="color:var(--color-muted)">
        No triggers — tap + Add to create one.
      </p>
    {/if}
  </section>

  <!-- Storage -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-sm font-semibold uppercase tracking-wide"
      style="color:var(--color-muted)"
    >
      Storage
    </h2>
    <label class="flex flex-col gap-1">
      <span class="text-xs" style="color:var(--color-muted)">
        Quota: {quotaMb} MB{usedMb > 0 ? ` · ${usedMb} MB used` : ""}
      </span>
      <input
        type="range"
        min="100"
        max="5000"
        step="100"
        bind:value={quotaMb}
        class="w-full"
      />
    </label>
    <p class="text-xs" style="color:var(--color-muted)">
      Keeps 30s before + after each trigger. Oldest footage deleted first when
      full.
    </p>
  </section>

  <button
    onclick={save}
    class="py-3 rounded-xl font-semibold text-white"
    style="background:var(--color-accent)"
  >
    {saved ? "Saved!" : "Save Settings"}
  </button>

  <!-- Identity -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-sm font-semibold uppercase tracking-wide"
      style="color:var(--color-muted)"
    >
      Identity
    </h2>
    {#if $identity}
      <p class="text-xs font-mono break-all" style="color:var(--color-muted)">
        {toNpub($identity.pubkey)}
      </p>
    {/if}
    <button
      onclick={exportKey}
      class="text-sm px-4 py-2 rounded-lg self-start"
      style="background:var(--color-surface);color:var(--color-text)"
    >
      Export Private Key
    </button>
    {#if nsecExport}
      <code
        class="text-xs break-all p-3 rounded-lg"
        style="background:var(--color-surface);color:var(--color-danger)"
        >{nsecExport}</code
      >
      <p class="text-xs" style="color:var(--color-muted)">
        Keep this secret — it gives full control of your identity.
      </p>
    {/if}
    <input
      bind:value={nsecImport}
      placeholder="nsec1… (import key)"
      class="px-4 py-2 rounded-lg text-sm font-mono"
      style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)"
    />
    {#if importError}<p class="text-xs" style="color:var(--color-danger)">
        {importError}
      </p>{/if}
    <button
      onclick={importKey}
      disabled={!nsecImport}
      class="text-sm px-4 py-2 rounded-lg self-start disabled:opacity-40"
      style="background:var(--color-surface);color:var(--color-text)"
    >
      Import Key
    </button>
  </section>
</main>
