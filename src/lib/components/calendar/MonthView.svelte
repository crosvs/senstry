<script lang="ts">
	import { fromUnix, isSameDay, getDaysInMonth } from '$lib/utils/time';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let { events, year, month, onDayClick }: {
		events: StoredTriggerEvent[];
		year: number;
		month: number;
		onDayClick: (d: Date) => void;
	} = $props();

	const today = new Date();
	const DOW = ['Mo','Tu','We','Th','Fr','Sa','Su'];

	function getCells(): (Date | null)[] {
		const first = new Date(year, month, 1);
		const startDow = (first.getDay() + 6) % 7; // Mon=0
		const daysInMonth = getDaysInMonth(year, month);
		const cells: (Date | null)[] = [];
		for (let i = 0; i < startDow; i++) cells.push(null);
		for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
		while (cells.length % 7 !== 0) cells.push(null);
		return cells;
	}

	function eventsForDay(d: Date): StoredTriggerEvent[] {
		return events.filter((e) => isSameDay(fromUnix(e.created_at), d));
	}

	const typeColors: Record<string, string> = {
		audio: 'var(--color-accent)',
		motion: 'var(--color-warning)',
		camera: 'var(--color-success)',
		gyroscope: 'var(--color-muted)',
		'arm-state': 'var(--color-border)'
	};

	let cells = $derived(getCells());
</script>

<div class="flex-1 overflow-y-auto p-4">
	<div class="grid grid-cols-7 gap-px mb-2">
		{#each DOW as d}
			<span class="text-center text-xs py-1" style="color:var(--color-muted)">{d}</span>
		{/each}
	</div>
	<div class="grid grid-cols-7 gap-1">
		{#each cells as cell}
			{#if cell}
				{@const dayEvents = eventsForDay(cell)}
				{@const isToday = isSameDay(cell, today)}
				<button
					onclick={() => onDayClick(cell!)}
					class="flex flex-col items-center gap-0.5 py-2 rounded-lg min-h-14 transition"
					style="background:{isToday ? 'var(--color-accent)' : 'var(--color-surface)'}"
				>
					<span class="text-sm font-medium" style="color:{isToday ? 'white' : 'var(--color-text)'}">{cell.getDate()}</span>
					<div class="flex flex-wrap gap-0.5 justify-center px-1">
						{#each dayEvents.slice(0,4) as evt}
							<span class="w-2 h-2 rounded-full" style="background:{typeColors[evt.type] ?? 'var(--color-muted)'}"></span>
						{/each}
					</div>
				</button>
			{:else}
				<div></div>
			{/if}
		{/each}
	</div>
</div>
