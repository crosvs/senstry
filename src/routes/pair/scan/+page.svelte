<script lang="ts">
  import { goto } from "$app/navigation";
  import { identity, addPairedDevice } from "$lib/store/identity";
  import { decodePairingUri } from "$lib/utils/qr";
  import { publish } from "$lib/nostr/client";
  import { buildPairAck } from "$lib/nostr/events";
  import { setRelays } from "$lib/nostr/client";
  import { toNpub } from "$lib/nostr/keys";

  let manualUri = $state("");
  let error = $state("");
  let success = $state(false);

  async function handlePair(uri: string) {
    error = "";
    if (!$identity) return;
    try {
      const payload = decodePairingUri(uri.trim());
      setRelays([payload.relay]);
      const ack = buildPairAck(
        $identity.privkey,
        $identity.pubkey,
        payload.pk,
        "Viewer",
      );
      await publish(ack);
      await addPairedDevice({
        pubkey: payload.pk,
        label: payload.label,
        addedAt: Date.now(),
      });
      success = true;
      setTimeout(() => goto("/"), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : "Invalid pairing URI";
    }
  }
</script>

<svelte:head><title>Scan Pair — Senstry</title></svelte:head>

<main
  class="flex-1 flex flex-col items-center gap-6 p-6"
  style="background:var(--color-bg)"
>
  <a href="/pair" class="self-start text-sm" style="color:var(--color-accent)"
    >← Back</a
  >
  <h1 class="text-xl font-bold" style="color:var(--color-text)">
    Pair with a Monitor
  </h1>
  <p class="text-sm text-center max-w-xs" style="color:var(--color-muted)">
    Paste the pairing link from the monitor device.
  </p>

  <textarea
    bind:value={manualUri}
    placeholder="senstry:..."
    rows="3"
    class="w-full max-w-xs rounded-xl px-4 py-3 text-sm font-mono"
    style="background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border)"
  ></textarea>

  {#if error}
    <p class="text-sm" style="color:var(--color-danger)">{error}</p>
  {/if}
  {#if success}
    <p class="text-sm" style="color:var(--color-success)">
      Paired successfully!
    </p>
  {/if}

  <button
    onclick={() => handlePair(manualUri)}
    disabled={!manualUri.trim()}
    class="px-6 py-3 rounded-xl font-semibold text-white disabled:opacity-40"
    style="background:var(--color-accent)"
  >
    Pair
  </button>
</main>
