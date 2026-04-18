<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { identity, pairedDevices } from "$lib/store/identity";
  import {
    ensureConnection,
    requestLiveView,
    stopViewer,
  } from "$lib/webrtc/viewer-peer";
  import { streamState, remoteStream } from "$lib/store/stream";
  import { events, loadEventsInRange, upsertEvent } from "$lib/store/events";
  import { subscribe } from "$lib/nostr/client";
  import { KIND_TRIGGER, KIND_ARM_STATE } from "$lib/nostr/events";
  import TimelineView from "$lib/components/timeline/TimelineView.svelte";
  import CalendarRoot from "$lib/components/calendar/CalendarRoot.svelte";

  let videoEl: HTMLVideoElement | undefined = $state();
  let nearLive = $state(true);

  const isLocalMode = $derived(page.url.searchParams.get("local") === "true");

  const seekTo = $derived.by(() => {
    const t = page.url.searchParams.get("t");
    return t ? parseInt(t, 10) : undefined;
  });

  // Only show events matching the current mode
  const modeEvents = $derived(
    !$identity
      ? $events
      : isLocalMode
        ? $events.filter((e) => e.monitorPubkey === $identity!.pubkey)
        : $events.filter((e) => e.monitorPubkey !== $identity!.pubkey),
  );

  $effect(() => {
    if (videoEl && $remoteStream) videoEl.srcObject = $remoteStream;
  });

  $effect(() => {
    if (videoEl) videoEl.muted = !nearLive;
  });

  async function autoConnect() {
    if (isLocalMode || !$identity || $pairedDevices.length === 0) return;
    try {
      await ensureConnection(
        $identity.privkey,
        $identity.pubkey,
        $pairedDevices[0].pubkey,
      );
    } catch {
      // Will show Retry button via streamState = 'failed'
    }
  }

  async function reconnect() {
    if (!$identity || $pairedDevices.length === 0) return;
    await requestLiveView(
      $identity.privkey,
      $identity.pubkey,
      $pairedDevices[0].pubkey,
    );
  }

  onMount(() => {
    if (!$identity) return;

    const n = Math.floor(Date.now() / 1000);
    loadEventsInRange(n - 7 * 86400, n).then((loaded) => {
      events.set(loaded.sort((a, b) => b.created_at - a.created_at));
    });

    const sub = subscribe(
      { kinds: [KIND_TRIGGER, KIND_ARM_STATE], "#p": [$identity.pubkey] },
      (event) => {
        if ($identity) upsertEvent(event, $identity.privkey);
      },
    );

    autoConnect();

    return () => sub.close();
  });

  onDestroy(() => stopViewer());
</script>

<svelte:head
  ><title>{isLocalMode ? "Local Recordings" : "Live View"} — Senstry</title
  ></svelte:head
>

<main class="flex-1 flex flex-col gap-4 p-4" style="background:var(--color-bg)">
  <div class="flex items-center justify-between">
    <a href="/" class="text-sm" style="color:var(--color-accent)">← Home</a>
    <h1 class="text-lg font-bold" style="color:var(--color-text)">
      {isLocalMode ? "Local Recordings" : "Viewer"}
    </h1>
    {#if !isLocalMode}
      <span
        class="text-xs px-2 py-1 rounded"
        style="background:var(--color-surface);color:{$streamState ===
        'connected'
          ? 'var(--color-success)'
          : $streamState === 'connecting'
            ? 'var(--color-warning)'
            : 'var(--color-muted)'}"
      >
        {$streamState}
      </span>
    {:else}
      <span
        class="text-xs px-2 py-1 rounded"
        style="background:var(--color-surface);color:var(--color-success)"
        >local</span
      >
    {/if}
  </div>

  {#if !isLocalMode}
    <div class="relative w-full">
      <video
        bind:this={videoEl}
        autoplay
        playsinline
        class="w-full rounded-xl"
        style="background:#000;min-height:160px;max-height:35vh"
      ></video>
      {#if !nearLive}
        <div
          class="absolute inset-0 flex items-center justify-center rounded-xl text-sm text-center"
          style="background:rgba(0,0,0,0.75);color:#9ca3af"
        >
          Historical playback<br />Live stream muted
        </div>
      {/if}
    </div>

    {#if $pairedDevices.length === 0}
      <p class="text-sm text-center" style="color:var(--color-warning)">
        No paired monitor — <a
          href="/pair/scan"
          style="color:var(--color-accent)">pair a device first</a
        >.
      </p>
    {:else if $streamState === "failed"}
      <button
        onclick={reconnect}
        class="py-3 rounded-xl font-semibold text-white"
        style="background:var(--color-accent)"
      >
        Retry Connection
      </button>
    {:else if $streamState === "connecting"}
      <p class="text-sm text-center" style="color:var(--color-muted)">
        Connecting…
      </p>
    {/if}
  {/if}

  <TimelineView
    events={modeEvents}
    localMode={isLocalMode}
    initialTime={seekTo}
    {seekTo}
    onNearLiveChange={(nl) => (nearLive = nl)}
  />

  <!-- Inline event log, filtered to the current mode -->
  <div
    class="flex flex-col rounded-xl overflow-hidden border"
    style="border-color:var(--color-border);min-height:200px;max-height:55vh"
  >
    <div
      class="px-4 py-2 border-b shrink-0"
      style="border-color:var(--color-border);background:var(--color-surface)"
    >
      <h2 class="text-sm font-semibold" style="color:var(--color-text)">
        {isLocalMode ? "Local Events" : "Monitor Events"}
      </h2>
    </div>
    <div class="flex flex-col flex-1 overflow-hidden">
      <CalendarRoot allEvents={modeEvents} ownPubkey={$identity?.pubkey} />
    </div>
  </div>
</main>
