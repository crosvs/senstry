<script lang="ts">
  import { onMount } from "svelte";
  import { identity } from "$lib/store/identity";
  import { events, loadEventsInRange, upsertEvent } from "$lib/store/events";
  import { subscribe } from "$lib/nostr/client";
  import { KIND_TRIGGER, KIND_ARM_STATE } from "$lib/nostr/events";
  import CalendarRoot from "$lib/components/calendar/CalendarRoot.svelte";

  onMount(() => {
    if (!$identity) return;

    // Load cached events from IDB
    const now = Math.floor(Date.now() / 1000);
    loadEventsInRange(now - 30 * 86400, now).then((loaded) => {
      events.set(loaded.sort((a, b) => b.created_at - a.created_at));
    });

    // Subscribe to new events
    const sub = subscribe(
      { kinds: [KIND_TRIGGER, KIND_ARM_STATE], "#p": [$identity.pubkey] },
      (event) => {
        if ($identity) upsertEvent(event, $identity.privkey);
      },
    );
    return () => sub.close();
  });
</script>

<svelte:head><title>Event Log — Senstry</title></svelte:head>

<main class="flex-1 flex flex-col" style="background:var(--color-bg)">
  <div
    class="flex items-center gap-3 p-4 border-b"
    style="border-color:var(--color-border)"
  >
    <a href="/viewer" class="text-sm" style="color:var(--color-accent)"
      >← Viewer</a
    >
    <h1 class="text-lg font-bold" style="color:var(--color-text)">Event Log</h1>
  </div>
  <CalendarRoot allEvents={$events} ownPubkey={$identity?.pubkey} />
</main>
