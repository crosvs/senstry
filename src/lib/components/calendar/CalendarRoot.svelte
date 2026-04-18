<script lang="ts">
	import { addDays, startOfWeek, startOfMonth, toUnix, endOfDay, endOfWeek, endOfMonth } from '$lib/utils/time';
	import ListView from './ListView.svelte';
	import DayView from './DayView.svelte';
	import WeekView from './WeekView.svelte';
	import MonthView from './MonthView.svelte';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let { allEvents, ownPubkey = undefined }: { allEvents: StoredTriggerEvent[]; ownPubkey?: string } = $props();

	type View = 'list' | 'day' | 'week' | 'month';
	let activeView = $state<View>('list');
	let focusedDate = $state(new Date());
	let sourceFilter = $state<'all' | 'local' | 'remote'>('all');

	const hasLocal = $derived(!!ownPubkey && allEvents.some(e => e.monitorPubkey === ownPubkey));
	const hasRemote = $derived(!!ownPubkey && allEvents.some(e => e.monitorPubkey !== ownPubkey));
	const showSourceFilter = $derived(hasLocal && hasRemote);

	const sourceFiltered = $derived.by(() => {
		if (!showSourceFilter || sourceFilter === 'all') return allEvents;
		if (sourceFilter === 'local') return allEvents.filter(e => e.monitorPubkey === ownPubkey);
		return allEvents.filter(e => e.monitorPubkey !== ownPubkey);
	});

	function visibleEvents(): StoredTriggerEvent[] {
		if (activeView === 'list') return sourceFiltered;
		let from: number, to: number;
		if (activeView === 'day') {
			from = toUnix(new Date(focusedDate.getFullYear(), focusedDate.getMonth(), focusedDate.getDate(), 0, 0, 0));
			to = toUnix(endOfDay(focusedDate));
		} else if (activeView === 'week') {
			from = toUnix(startOfWeek(focusedDate));
			to = toUnix(endOfWeek(focusedDate));
		} else {
			from = toUnix(startOfMonth(focusedDate));
			to = toUnix(endOfMonth(focusedDate));
		}
		return sourceFiltered.filter((e) => e.created_at >= from && e.created_at <= to);
	}

	function navigate(dir: -1 | 1) {
		const d = new Date(focusedDate);
		if (activeView === 'day') d.setDate(d.getDate() + dir);
		else if (activeView === 'week') d.setDate(d.getDate() + dir * 7);
		else if (activeView === 'month') d.setMonth(d.getMonth() + dir);
		focusedDate = d;
	}

	function formatPeriod(): string {
		if (activeView === 'list') return 'All events';
		if (activeView === 'day') return focusedDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
		if (activeView === 'week') {
			const s = startOfWeek(focusedDate);
			const e = addDays(s, 6);
			return `${s.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
		}
		return focusedDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
	}
</script>

<div class="flex flex-col flex-1 min-h-0">
	<div class="flex flex-wrap items-center gap-2 px-4 py-2 border-b" style="border-color:var(--color-border)">
		<div class="flex rounded-lg overflow-hidden border" style="border-color:var(--color-border)">
			{#each ['list','day','week','month'] as v}
				<button
					onclick={() => activeView = v as View}
					class="px-3 py-1 text-xs font-medium capitalize"
					style="background:{activeView === v ? 'var(--color-accent)' : 'var(--color-surface)'};color:{activeView === v ? 'white' : 'var(--color-muted)'}"
				>{v}</button>
			{/each}
		</div>

		{#if showSourceFilter}
			<div class="flex rounded-lg overflow-hidden border" style="border-color:var(--color-border)">
				{#each [['all','All'],['local','Local'],['remote','Remote']] as [val, label]}
					<button
						onclick={() => sourceFilter = val as 'all' | 'local' | 'remote'}
						class="px-3 py-1 text-xs font-medium"
						style="background:{sourceFilter === val ? 'var(--color-surface)' : 'transparent'};color:{sourceFilter === val ? 'var(--color-text)' : 'var(--color-muted)'}"
					>{label}</button>
				{/each}
			</div>
		{/if}

		{#if activeView !== 'list'}
			<button onclick={() => navigate(-1)} class="px-2 text-sm" style="color:var(--color-muted)">‹</button>
			<span class="flex-1 text-xs text-center" style="color:var(--color-text)">{formatPeriod()}</span>
			<button onclick={() => navigate(1)} class="px-2 text-sm" style="color:var(--color-muted)">›</button>
			<button onclick={() => focusedDate = new Date()} class="text-xs px-2 py-1 rounded" style="background:var(--color-surface);color:var(--color-muted)">Today</button>
		{:else}
			<span class="flex-1 text-xs" style="color:var(--color-muted)">{sourceFiltered.length} events</span>
		{/if}
	</div>

	{#if activeView === 'list'}
		<ListView events={visibleEvents()} {ownPubkey} />
	{:else if activeView === 'day'}
		<DayView events={visibleEvents()} date={focusedDate} {ownPubkey} />
	{:else if activeView === 'week'}
		<WeekView events={visibleEvents()} weekStart={startOfWeek(focusedDate)} onDayClick={(d) => { focusedDate = d; activeView = 'day'; }} />
	{:else}
		<MonthView events={sourceFiltered} year={focusedDate.getFullYear()} month={focusedDate.getMonth()} onDayClick={(d) => { focusedDate = d; activeView = 'day'; }} />
	{/if}
</div>
