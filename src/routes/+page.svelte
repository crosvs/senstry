<script lang="ts">
  import { identity, pairedDevices } from "$lib/store/identity";
  import { toNpub } from "$lib/nostr/keys";
</script>

<svelte:head><title>Senstry</title></svelte:head>

<main
  class="flex-1 flex flex-col items-center justify-center gap-8 p-6"
  style="background:var(--color-bg)"
>
  <div class="text-center">
    <h1 class="text-3xl font-bold mb-2" style="color:var(--color-text)">
      Senstry
    </h1>
    <p class="text-sm" style="color:var(--color-muted)">
      Decentralized home security monitor
    </p>
  </div>

  {#if $identity}
    <p
      class="text-xs font-mono px-3 py-1 rounded"
      style="background:var(--color-surface);color:var(--color-muted)"
    >
      {toNpub($identity.pubkey).slice(0, 20)}…
    </p>
  {/if}

  <div class="flex flex-col gap-4 w-full max-w-xs">
    <a
      href="/monitor"
      class="block text-center py-4 rounded-xl font-semibold text-white transition"
      style="background:var(--color-accent)"
    >
      Monitor Mode
    </a>
    <a
      href="/viewer"
      class="block text-center py-4 rounded-xl font-semibold transition"
      style="background:var(--color-surface);color:var(--color-text)"
    >
      Viewer Mode
    </a>
    <a
      href="/viewer/events"
      class="block text-center py-3 rounded-xl font-semibold text-sm transition"
      style="background:var(--color-surface);color:var(--color-muted)"
    >
      Event Log
    </a>
  </div>

  <div class="flex gap-4 text-sm" style="color:var(--color-muted)">
    <a href="/pair" style="color:var(--color-accent)">Pair Device</a>
    <span>·</span>
    <a href="/settings" style="color:var(--color-accent)">Settings</a>
    <span>·</span>
    <a href="/dev" style="color:var(--color-muted)">Dev</a>
  </div>

  {#if $pairedDevices.length > 0}
    <p class="text-xs" style="color:var(--color-muted)">
      {$pairedDevices.length} paired device{$pairedDevices.length > 1
        ? "s"
        : ""}
    </p>
  {/if}
</main>
