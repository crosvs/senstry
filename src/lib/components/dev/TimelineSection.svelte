<script lang="ts">
	import { untrack } from 'svelte';
	import { alertLog } from '$lib/store/notification-listener';
	import TimelineScrubber from '$lib/components/timeline/TimelineScrubber.svelte';
	import DevSection from './DevSection.svelte';
	import { dateToView, rangeToView } from '$lib/components/timeline/timeline-utils';

	interface Props {
		selectedMonitorPubkey?: string | null;
		/** Coverage data owned by ContentViewerSection */
		coverageByChannel?: Record<string, [number, number][]>;
		/** Lifted view state — bind these from the parent controller */
		viewCenter?: number;
		viewSpan?: number;
		mode?: 'live' | 'view';
		/** Current live wall-clock time in unix seconds — provided by parent */
		liveTime?: number;
		/** Whether there is an active live RTC connection — provided by parent */
		isLiveConnected?: boolean;
		/** Called when the user seeks the timeline — use to drive the player */
		onSeekChange?: (t: number) => void;
		/** Called when the user starts dragging the scrubber (pointer down) */
		onScrubStart?: () => void;
		/** Called when the user releases the scrubber (pointer up) */
		onScrubEnd?: () => void;
		/** Called when the user manually toggles a channel chip — NOT fired on coverage-driven changes */
		onChannelToggle?: (active: string[]) => void;
		/** Bindable chip state — controller can push its remembered selection back to the timeline */
		activeChannels?: string[];
	}
	let {
		selectedMonitorPubkey = null,
		coverageByChannel = {},
		viewCenter = $bindable(Math.floor(Date.now() / 1000)),
		viewSpan = $bindable(2 * 3600),
		mode = $bindable<'live' | 'view'>('live'),
		liveTime = Math.floor(Date.now() / 1000),
		isLiveConnected = false,
		onSeekChange,
		onScrubStart,
		onScrubEnd,
		onChannelToggle,
		activeChannels = $bindable<string[]>([]),
	}: Props = $props();

	const PALETTE = [
		'#3b82f6', '#10b981', '#f59e0b', '#ef4444',
		'#8b5cf6', '#06b6d4', '#f97316', '#ec4899',
	];
	const LIVE_EDGE_S = 20;

	let isPortrait = $state(false);

	let channelKeys = $derived(Object.keys(coverageByChannel));
	let channelColors = $derived(
		Object.fromEntries(channelKeys.map((id, i) => [id, PALETTE[i % PALETTE.length]]))
	);
	let viewStart = $derived(viewCenter - viewSpan / 2);
	let viewEnd = $derived(viewCenter + viewSpan / 2);

	// Filter alerts to selected monitor
	let timelineAlerts = $derived(
		$alertLog.filter((a) => !selectedMonitorPubkey || a.monitorPubkey === selectedMonitorPubkey)
	);

	// Sync activeChannels whenever coverageByChannel keys change
	$effect(() => {
		const keys = Object.keys(coverageByChannel); // tracked dep
		untrack(() => {
			// Add new channels
			for (const ch of keys) {
				if (!activeChannels.includes(ch)) activeChannels = [...activeChannels, ch];
			}
			// Drop stale channels
			if (activeChannels.some((ch) => !keys.includes(ch))) {
				activeChannels = activeChannels.filter((ch) => keys.includes(ch));
			}
		});
	});

	// Orientation detection
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mql = window.matchMedia('(orientation: portrait)');
		isPortrait = mql.matches;
		const handler = (e: MediaQueryListEvent) => { isPortrait = e.matches; };
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	});

	// ── Controls ──────────────────────────────────────────────────────────────

	function toggleChannel(id: string) {
		activeChannels = activeChannels.includes(id)
			? activeChannels.filter((c) => c !== id)
			: [...activeChannels, id];
		onChannelToggle?.(activeChannels);
	}

	function setMode(m: 'live' | 'view') {
		mode = m;
		if (m === 'live') viewCenter = liveTime;
	}

	function onSeek(t: number) {
		const clamped = Math.min(t, liveTime);
		viewCenter = clamped;
		const newMode = Math.abs(liveTime - clamped) <= LIVE_EDGE_S ? 'live' : 'view';
		mode = newMode;
		onSeekChange?.(clamped);
	}

	function onZoomIn() { viewSpan = Math.max(60, viewSpan / 2); }
	function onZoomOut() { viewSpan = Math.min(7 * 86400, viewSpan * 2); }
	function onLive() {
		viewCenter = liveTime;
		mode = 'live';
		onSeekChange?.(liveTime);
	}

	// ── Date jump + manual range ──────────────────────────────────────────────
	let jumpDate = $state('');
	let manualRangeStr = $state('');
	let rangeEditing = $state(false);

	$effect(() => {
		if (!rangeEditing) manualRangeStr = `${Math.round(viewStart)}-${Math.round(viewEnd)}`;
	});

	function onJumpDate() {
		const v = dateToView(jumpDate);
		if (!v) return;
		viewCenter = v.center;
		viewSpan   = v.span;
		mode = 'view';
	}

	function parseRangeStr(s: string): [number, number] | null {
		const t = s.trim();
		const dash = t.lastIndexOf('-');
		if (dash > 0) {
			const f = parseInt(t.slice(0, dash));
			const e = parseInt(t.slice(dash + 1));
			if (!isNaN(f) && !isNaN(e)) return [f, e];
		}
		return null;
	}

	function applyManualRange() {
		const r = parseRangeStr(manualRangeStr);
		if (!r) return;
		const v = rangeToView(r[0], r[1]);
		if (!v) return;
		viewCenter = v.center;
		viewSpan   = v.span;
		mode = 'view';
	}

	async function copyText(text: string) {
		try { await navigator.clipboard.writeText(text); } catch {}
	}
	function copyCursor() { void copyText(String(Math.round(viewCenter))); }
	function copyRange()  { void copyText(`${Math.round(viewStart)}-${Math.round(viewEnd)}`); }

	function fmtRange(t: number): string {
		const d = new Date(t * 1000);
		if (viewEnd - viewStart > 12 * 3600) {
			return d.toLocaleString(undefined, {
				month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
			});
		}
		return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function fmtSpan(s: number): string {
		if (s >= 86400) return `${(s / 86400).toFixed(s % 86400 === 0 ? 0 : 1)}d`;
		if (s >= 3600) return `${(s / 3600).toFixed(s % 3600 === 0 ? 0 : 1)}h`;
		if (s >= 60) return `${Math.round(s / 60)}m`;
		return `${s}s`;
	}
</script>

<DevSection title="Timeline">
	{#snippet actions()}
		<div class="hdr-actions">
			{#if mode === 'live'}
				<span class="live-dot" class:live-connected={isLiveConnected}>
					{isLiveConnected ? '● LIVE' : '● Now'}
				</span>
			{/if}
			<button class="icon-btn" onclick={onZoomIn} title="Zoom in">+</button>
			<button class="icon-btn" onclick={onZoomOut} title="Zoom out">−</button>
		</div>
	{/snippet}

	<!-- Mode toggle + span + Date jump + copy -->
	<div class="toolbar">
		<!-- Mode toggle + span -->
		<div class="mode-group">
			<button
				class="mode-btn"
				class:mode-live={mode === 'live' && isLiveConnected}
				class:mode-now={mode === 'live' && !isLiveConnected}
				onclick={onLive}
			>
				● {isLiveConnected ? 'Live' : 'Now'}
			</button>
			<button class="mode-btn {mode === 'view' ? 'mode-view' : ''}" onclick={() => setMode('view')}>
				⊡ View
			</button>
		</div>
		<span class="span-pill">{fmtSpan(viewSpan)}</span>
		
		<!-- Date jump + copy -->
		<div class="mode-group" style="gap:4px; margin-top:2px;">
			<input type="date" class="tl-date-input" bind:value={jumpDate} onchange={onJumpDate} title="Jump to date (1-day view)" />
			<input class="tl-ts-input tl-ts-range"
				bind:value={manualRangeStr}
				onfocus={() => rangeEditing = true}
				onblur={() => { rangeEditing = false; applyManualRange(); }}
				onkeydown={(e) => { if (e.key === 'Enter') applyManualRange(); }}
				placeholder="start-end (unix)" />
			<button class="tl-copy-btn" onclick={copyCursor} title="Copy cursor timestamp to clipboard">⎘ Cursor</button>
			<button class="tl-copy-btn" onclick={copyRange}  title="Copy start–end range to clipboard">⎘ Range</button>
		</div>
	</div>

	<!-- Channel filter chips -->
	{#if channelKeys.length > 0}
		<div class="ch-filters">
			{#each channelKeys as ch}
				<button
					class="ch-chip {activeChannels.includes(ch) ? 'chip-on' : 'chip-off'}"
					style="--c:{channelColors[ch]}"
					onclick={() => toggleChannel(ch)}
				>
					{ch || 'default'}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Manual timerange (stays in sync with view) -->
	<div class="toolbar" style="gap:4px; margin-top:2px;">
	</div>

	<!-- Canvas scrubber -->
	<TimelineScrubber
		{viewStart}
		{viewEnd}
		currentTime={viewCenter}
		{liveTime}
		{coverageByChannel}
		activeChannels={channelKeys}
		{channelColors}
		alerts={timelineAlerts}
		{mode}
		{isPortrait}
		{isLiveConnected}
		{onSeek}
		{onZoomIn}
		{onZoomOut}
		{onScrubStart}
		{onScrubEnd}
	/>

	<!-- Time range footer -->
	<div class="time-footer">
		<span class="range-edge">{fmtRange(viewStart)}</span>
		<span class="range-center">
			{#if mode === 'live'}
				<span class="live-label" class:live-connected={isLiveConnected}>
					{isLiveConnected ? '● LIVE' : '● Now'}
				</span>
			{:else}
				{fmtRange(viewCenter)}
			{/if}
		</span>
		<span class="range-edge">{fmtRange(viewEnd)}</span>
	</div>
</DevSection>

<style>
	.hdr-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.live-dot {
		font-size: 9px;
		font-weight: 700;
		font-family: ui-monospace, monospace;
		color: var(--color-muted);
	}
	.live-dot.live-connected { color: #ef4444; }
	.icon-btn {
		font-size: 11px;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-muted);
		cursor: pointer;
		font-family: ui-monospace, monospace;
		font-weight: 700;
	}
	.icon-btn:hover { color: var(--color-text); }

	.toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.mode-group { display: flex; gap: 2px; }
	.mode-btn {
		font-size: 10px;
		padding: 3px 9px;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		background: none;
		color: var(--color-muted);
		cursor: pointer;
		font-family: inherit;
		font-weight: 600;
		line-height: 1.3;
	}
	.mode-btn:hover { color: var(--color-text); }
	.mode-btn.mode-live { background: #7f1d1d; color: #fca5a5; border-color: #991b1b; }
	.mode-btn.mode-now { background: var(--color-surface); color: var(--color-text); border-color: var(--color-muted); }
	.mode-btn.mode-view { background: var(--color-accent); color: white; border-color: var(--color-accent); }

	.span-pill {
		font-size: 10px;
		font-family: ui-monospace, monospace;
		color: var(--color-muted);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 2px 7px;
		min-width: 32px;
		text-align: center;
	}

	.ch-filters { display: flex; flex-wrap: wrap; gap: 4px; }
	.ch-chip {
		font-size: 10px;
		padding: 2px 9px;
		border-radius: 10px;
		border: 1.5px solid var(--c);
		cursor: pointer;
		font-family: inherit;
		font-weight: 600;
		line-height: 1.4;
		transition: background 0.1s, color 0.1s;
	}
	.ch-chip.chip-on { background: var(--c); color: #fff; }
	.ch-chip.chip-off { background: none; color: var(--c); }

	.time-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 2px 0;
	}
	.range-edge {
		font-size: 9px;
		font-family: ui-monospace, monospace;
		color: var(--color-muted);
	}
	.range-center {
		font-size: 9px;
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: var(--color-text);
	}
	.live-label { color: var(--color-muted); font-weight: 700; }
	.live-label.live-connected { color: #ef4444; }

	.tl-date-input {
		font-size: 10px;
		padding: 2px 5px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text);
		font-family: inherit;
		cursor: pointer;
	}
	.tl-ts-input {
		font-size: 10px;
		padding: 2px 5px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		color: var(--color-text);
		font-family: ui-monospace, monospace;
		width: 110px;
	}
	.tl-ts-range { width: 220px; }
	.tl-ts-input:focus, .tl-date-input:focus { outline: 1px solid var(--color-accent); }
	.tl-copy-btn {
		font-size: 10px;
		padding: 2px 7px;
		border-radius: 4px;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-muted);
		cursor: pointer;
		font-family: inherit;
		font-weight: 600;
	}
	.tl-copy-btn:hover { color: var(--color-text); }
</style>
