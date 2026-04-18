<script lang="ts">
	import { addDays, fromUnix, isSameDay } from '$lib/utils/time';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let { events, weekStart, onDayClick }: {
		events: StoredTriggerEvent[];
		weekStart: Date;
		onDayClick: (d: Date) => void;
	} = $props();

	const DAYS = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
	const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
	const today = new Date();

	function countForDay(d: Date): number {
		return events.filter((e) => isSameDay(fromUnix(e.created_at), d)).length;
	}
</script>

<div class="flex-1 overflow-y-auto p-4">
	<div class="grid grid-cols-7 gap-1">
		{#each DAYS as day, i}
			{@const count = countForDay(day)}
			{@const isToday = isSameDay(day, today)}
			<button
				onclick={() => onDayClick(day)}
				class="flex flex-col items-center gap-1 py-3 rounded-xl transition"
				style="background:{isToday ? 'var(--color-accent)' : 'var(--color-surface)'}"
			>
				<span class="text-xs" style="color:{isToday ? 'white' : 'var(--color-muted)'}">{DOW[i]}</span>
				<span class="text-lg font-bold" style="color:{isToday ? 'white' : 'var(--color-text)'}">{day.getDate()}</span>
				{#if count > 0}
					<span class="text-xs font-semibold px-2 py-0.5 rounded-full" style="background:{isToday ? 'rgba(255,255,255,0.3)' : 'var(--color-accent)'};color:white">{count}</span>
				{:else}
					<span class="h-5"></span>
				{/if}
			</button>
		{/each}
	</div>
</div>
