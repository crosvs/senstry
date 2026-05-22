<script lang="ts">
	import { publishQueue, cancelPublish } from '$lib/nostr/client';

	// Format ms until send as a human string
	function formatEta(estimatedAt: number): string {
		const ms = estimatedAt - Date.now();
		if (ms <= 0) return 'sending…';
		if (ms < 1000) return `<1s`;
		return `${Math.ceil(ms / 1000)}s`;
	}

	// Reactive tick so ETAs update each second
	let tick = $state(0);
	const _timer = setInterval(() => tick++, 500);
</script>

{#if $publishQueue.length > 0}
	<div class="queue-panel">
		<div class="queue-header">
			<span class="queue-title">Nostr queue ({$publishQueue.length})</span>
		</div>
		<ul class="queue-list">
			{#each $publishQueue as item (item.id)}
				{@const _ = tick}
				<li class="queue-item">
					<span class="queue-label">{item.label}</span>
					<span class="queue-eta">{formatEta(item.estimatedAt)}</span>
					<button
						class="queue-cancel"
						onclick={() => cancelPublish(item.id)}
						title="Cancel this publish"
					>✕</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.queue-panel {
		background: rgb(55 48 163 / 0.15);
		border: 1px solid rgb(99 102 241 / 0.4);
		border-radius: 6px;
		padding: 6px 8px;
		font-size: 11px;
	}

	.queue-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}

	.queue-title {
		color: rgb(165 180 252);
		font-weight: 600;
		font-size: 11px;
	}

	.queue-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.queue-item {
		display: flex;
		align-items: center;
		gap: 6px;
		color: rgb(199 210 254);
	}

	.queue-label {
		flex: 1;
		font-family: monospace;
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.queue-eta {
		color: rgb(251 191 36);
		font-size: 10px;
		min-width: 36px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.queue-cancel {
		background: none;
		border: none;
		color: rgb(148 163 184);
		cursor: pointer;
		font-size: 10px;
		padding: 0 2px;
		line-height: 1;
		transition: color 0.15s;
	}

	.queue-cancel:hover {
		color: rgb(248 113 113);
	}
</style>
