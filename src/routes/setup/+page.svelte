<script lang="ts">
  import { goto } from "$app/navigation";
  import { identity } from "$lib/store/identity";
  import { loadOrCreateIdentity, toNpub } from "$lib/nostr/keys";
  import { onMount } from "svelte";

  let npub = $state("");

  onMount(async () => {
    const id = await loadOrCreateIdentity();
    identity.set(id);
    npub = toNpub(id.pubkey);
  });
</script>

<svelte:head><title>Setup — Senstry</title></svelte:head>

<main
  class="flex-1 flex flex-col items-center justify-center gap-6 p-6"
  style="background:var(--color-bg)"
>
  <h1 class="text-2xl font-bold" style="color:var(--color-text)">
    Welcome to Senstry
  </h1>
  <p class="text-sm text-center max-w-xs" style="color:var(--color-muted)">
    Your device identity has been created. No account needed — your keypair is
    your identity.
  </p>
  {#if npub}
    <code
      class="text-xs break-all px-4 py-3 rounded-lg max-w-xs"
      style="background:var(--color-surface);color:var(--color-muted)"
      >{npub}</code
    >
  {/if}
  <button
    onclick={() => goto("/")}
    class="px-6 py-3 rounded-xl font-semibold text-white"
    style="background:var(--color-accent)"
  >
    Get Started
  </button>
</main>
