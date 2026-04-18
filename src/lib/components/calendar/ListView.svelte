<script lang="ts">
	import EventCard from './EventCard.svelte';
	import { fromUnix, isSameDay, formatTime } from '$lib/utils/time';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let { events, ownPubkey = undefined }: { events: StoredTriggerEvent[]; ownPubkey?: string } = $props();

	const CLUSTER_GAP_S = 300; // 5 minutes

	interface Cluster {
		events: StoredTriggerEvent[];
		expanded: boolean;
	}

	function groupByDay(evts: StoredTriggerEvent[]): { label: string; clusters: Cluster[] }[] {
		const dayGroups: Map<string, StoredTriggerEvent[]> = new Map();
		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);

		for (const e of evts) {
			const d = fromUnix(e.created_at);
			let label: string;
			if (isSameDay(d, today)) label = 'Today';
			else if (isSameDay(d, yesterday)) label = 'Yesterday';
			else label = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

			if (!dayGroups.has(label)) dayGroups.set(label, []);
			dayGroups.get(label)!.push(e);
		}

		return Array.from(dayGroups.entries()).map(([label, dayEvts]) => ({
			label,
			clusters: clusterByProximity(dayEvts)
		}));
	}

	function clusterByProximity(evts: StoredTriggerEvent[]): Cluster[] {
		if (evts.length === 0) return [];
		const sorted = [...evts].sort((a, b) => a.created_at - b.created_at);
		const clusters: Cluster[] = [];
		let current: StoredTriggerEvent[] = [sorted[0]];

		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1];
			const curr = sorted[i];
			if (curr.created_at - prev.created_at <= CLUSTER_GAP_S) {
				current.push(curr);
			} else {
				clusters.push({ events: current, expanded: false });
				current = [curr];
			}
		}
		clusters.push({ events: current, expanded: false });
		return clusters;
	}

	let days = $state(groupByDay(events));

	$effect(() => {
		days = groupByDay(events);
	});

	function toggleCluster(day: (typeof days)[number], cluster: Cluster) {
		cluster.expanded = !cluster.expanded;
		days = days; // trigger reactivity
	}

	function clusterSummary(cluster: Cluster): string {
		const counts: Record<string, number> = {};
		for (const e of cluster.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
		return Object.entries(counts)
			.map(([type, n]) => `${n} ${type}`)
			.join(', ');
	}

	function clusterTimeRange(cluster: Cluster): string {
		const first = cluster.events[0];
		const last = cluster.events[cluster.events.length - 1];
		if (first === last) return formatTime(first.created_at);
		return `${formatTime(first.created_at)} – ${formatTime(last.created_at)}`;
	}
</script>

<div class="flex-1 min-h-0 overflow-y-auto">
	{#if days.length === 0}
		<p class="text-sm text-center p-8" style="color:var(--color-muted)">No events yet.</p>
	{/if}
	{#each days as day}
		<div
			class="sticky top-0 px-4 py-2 text-xs font-semibold uppercase tracking-wide"
			style="background:var(--color-bg);color:var(--color-muted)"
		>
			{day.label}
		</div>
		<div class="flex flex-col gap-2 px-4 pb-2">
			{#each day.clusters as cluster}
				{#if cluster.events.length === 1}
					<EventCard event={cluster.events[0]} {ownPubkey} />
				{:else}
					<!-- Cluster group -->
					<div class="rounded-xl overflow-hidden" style="border:1px solid var(--color-border)">
						<button
							onclick={() => toggleCluster(day, cluster)}
							class="w-full flex items-center gap-3 px-4 py-3 text-left"
							style="background:var(--color-surface)"
						>
							<span
								class="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
								style="background:var(--color-accent);color:white"
							>
								{cluster.events.length}
							</span>
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium" style="color:var(--color-text)">{clusterSummary(cluster)}</p>
								<p class="text-xs" style="color:var(--color-muted)">{clusterTimeRange(cluster)}</p>
							</div>
							<span class="text-sm shrink-0" style="color:var(--color-muted)">
								{cluster.expanded ? '▲' : '▼'}
							</span>
						</button>
						{#if cluster.expanded}
							<div class="flex flex-col gap-2 p-2" style="background:var(--color-bg)">
								{#each cluster.events as event (event.id)}
									<EventCard {event} {ownPubkey} />
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/each}
</div>
