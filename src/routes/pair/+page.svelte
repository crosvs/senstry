<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { identity } from "$lib/store/identity";
  import { settings } from "$lib/store/settings";
  import { generateQRDataUrl, encodePairingUri } from "$lib/utils/qr";
  import {
    startPairListener,
    stopPairListener,
  } from "$lib/webrtc/monitor-peer";

  let qrSrc = $state("");
  let uri = $state("");

  onMount(async () => {
    if (!$identity) return;
    const payload = {
      v: 1,
      pk: $identity.pubkey,
      relay: $settings.relayUrl,
      label: $settings.monitorLabel,
    };
    uri = encodePairingUri(payload);
    qrSrc = await generateQRDataUrl(uri);
    startPairListener($identity.privkey, $identity.pubkey);
  });

  onDestroy(() => stopPairListener());
</script>

<svelte:head><title>Pair Device — Senstry</title></svelte:head>

<main
  class="flex-1 flex flex-col items-center gap-6 p-6"
  style="background:var(--color-bg)"
>
  <a href="/" class="self-start text-sm" style="color:var(--color-accent)"
    >← Back</a
  >
  <h1 class="text-xl font-bold" style="color:var(--color-text)">
    Pair a Viewer
  </h1>
  <p class="text-sm text-center max-w-xs" style="color:var(--color-muted)">
    Show this QR code to the viewer device, or share the pairing link.
  </p>

  {#if qrSrc}
    <img
      src={qrSrc}
      alt="Pairing QR"
      class="rounded-xl"
      style="background:white;padding:12px"
    />
  {:else}
    <div
      class="w-64 h-64 rounded-xl"
      style="background:var(--color-surface)"
    ></div>
  {/if}

  {#if uri}
    <button
      onclick={() => navigator.clipboard.writeText(uri)}
      class="text-xs px-4 py-2 rounded-lg"
      style="background:var(--color-surface);color:var(--color-muted)"
    >
      Copy pairing link
    </button>
  {/if}

  <a href="/pair/scan" class="text-sm" style="color:var(--color-accent)"
    >Scan a pairing QR instead →</a
  >
</main>
