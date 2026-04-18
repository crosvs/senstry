<script lang="ts">
	import { formatDetectionType, formatDb, formatDuration } from '$lib/utils/format';
	import { formatRelative, formatAbsolute, formatTime } from '$lib/utils/time';
	import { goto } from '$app/navigation';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let { event, ownPubkey = undefined }: { event: StoredTriggerEvent; ownPubkey?: string } = $props();

	let expanded = $state(false);

	const isLocal = $derived(!!ownPubkey && event.monitorPubkey === ownPubkey);

	const typeColors: Record<string, string> = {
		audio: 'var(--color-accent)',
		motion: 'var(--color-warning)',
		camera: 'var(--color-success)',
		gyroscope: 'var(--color-muted)',
		'arm-state': 'var(--color-muted)'
	};

	const hasFootage = $derived(['audio', 'motion', 'camera'].includes(event.type));

	function jumpToTimeline() {
		goto(isLocal ? `/viewer?t=${event.created_at}&local=true` : `/viewer?t=${event.created_at}`);
	}
</script>

<div
	class="rounded-xl overflow-hidden"
	style="background:var(--color-surface);border:1px solid var(--color-border)"
>
	<button
		onclick={() => expanded = !expanded}
		class="w-full flex items-start gap-3 p-4 text-left"
	>
		<span
			class="mt-0.5 text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
			style="background:{typeColors[event.type] ?? 'var(--color-muted)'};color:white"
		>
			{formatDetectionType(event.type)}
		</span>
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-1.5 flex-wrap">
				<p class="text-sm font-medium truncate" style="color:var(--color-text)">{event.monitorLabel}</p>
				{#if ownPubkey}
					<span
						class="text-xs px-1.5 py-0.5 rounded shrink-0"
						style="background:{isLocal ? 'rgba(52,211,153,0.15)' : 'rgba(96,165,250,0.15)'};color:{isLocal ? 'var(--color-success)' : 'var(--color-accent)'}"
					>
						{isLocal ? 'Local' : 'Remote'}
					</span>
				{/if}
			</div>
			{#if event.type === 'audio' && event.data.peakDb !== undefined}
				<p class="text-xs" style="color:var(--color-muted)">{formatDb(event.data.peakDb as number)} · {formatDuration(event.data.durationMs as number)}</p>
			{/if}
		</div>
		<div class="flex flex-col items-end shrink-0">
			<span class="text-xs" style="color:var(--color-muted)">{formatTime(event.created_at)}</span>
			<span class="text-xs" style="color:var(--color-muted)">{formatRelative(event.created_at)}</span>
		</div>
	</button>

	{#if expanded}
		<div class="px-4 pb-4 flex flex-col gap-3 border-t" style="border-color:var(--color-border)">
			<p class="text-xs pt-2" style="color:var(--color-muted)">{formatAbsolute(event.created_at)}</p>

			{#if event.type === 'audio' && event.data.triggerName}
				<p class="text-xs" style="color:var(--color-muted)">Trigger: {event.data.triggerName as string}</p>
			{/if}

			{#if hasFootage}
				<button
					onclick={jumpToTimeline}
					class="text-xs px-3 py-2 rounded-lg self-start"
					style="background:{isLocal ? 'var(--color-success)' : 'var(--color-accent)'};color:white"
				>
					{isLocal ? 'View local recording' : 'View in timeline'}
				</button>
			{:else if event.type === 'arm-state'}
				<p class="text-xs" style="color:var(--color-muted)">
					Monitor {(event.data as { armed?: boolean }).armed ? 'armed' : 'disarmed'}
				</p>
			{/if}
		</div>
	{/if}
</div>
