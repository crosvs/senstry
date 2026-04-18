<script lang="ts">
	import EventCard from './EventCard.svelte';
	import { fromUnix } from '$lib/utils/time';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let { events, date, ownPubkey = undefined }: { events: StoredTriggerEvent[]; date: Date; ownPubkey?: string } = $props();

	const HOURS = Array.from({ length: 24 }, (_, i) => i);

	function eventsForHour(h: number): StoredTriggerEvent[] {
		return events.filter((e) => {
			const d = fromUnix(e.created_at);
			return d.getHours() === h;
		});
	}
</script>

<div class="flex-1 overflow-y-auto">
	{#each HOURS as h}
		{@const hourEvents = eventsForHour(h)}
		<div class="flex gap-3 px-4 border-b min-h-12" style="border-color:var(--color-border)">
			<span class="text-xs w-10 shrink-0 pt-3 text-right" style="color:var(--color-muted)">{h.toString().padStart(2,'0')}:00</span>
			<div class="flex-1 flex flex-col gap-1 py-1">
				{#each hourEvents as event (event.id)}
					<EventCard {event} {ownPubkey} />
				{/each}
			</div>
		</div>
	{/each}
</div>
