<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { identity, pairedDevices } from '$lib/store/identity';
	import { streamState } from '$lib/store/stream';
	import { requestCoverageMap } from '$lib/webrtc/viewer-peer';
	import { getCoverageMap, getSegmentAt } from '$lib/db/segments';
	import TimelineScrubber from './TimelineScrubber.svelte';
	import TimelinePlayer from './TimelinePlayer.svelte';
	import type { StoredTriggerEvent } from '$lib/store/events';

	let {
		events = [],
		initialTime,
		seekTo,
		localMode = false,
		onNearLiveChange
	}: {
		events?: StoredTriggerEvent[];
		initialTime?: number;
		seekTo?: number;
		localMode?: boolean;
		onNearLiveChange?: (nearLive: boolean) => void;
	} = $props();

	async function localFetch(time: number) {
		const seg = await getSegmentAt(time);
		if (!seg) throw new Error('not-stored');
		return { mimeType: seg.mimeType, blob: seg.blob, startTime: seg.startTime, endTime: seg.endTime };
	}

	const DEFAULT_SPAN = 2 * 3600;
	const LIVE_EDGE_S = 30;
	const now = () => Math.floor(Date.now() / 1000);

	const initTime = untrack(() => initialTime ?? now());
	let currentTime = $state(initTime);
	let viewSpan = $state(DEFAULT_SPAN);
	let viewCenter = $state(initTime);
	let nearLive = $state((now() - initTime) < LIVE_EDGE_S);

	let lastSeekTo = $state<number | undefined>(undefined);
	$effect(() => {
		if (seekTo !== undefined && seekTo !== lastSeekTo) {
			lastSeekTo = seekTo;
			currentTime = seekTo;
			viewCenter = seekTo;
			setNearLive(seekTo);
		}
	});

	function setNearLive(t: number) {
		const nl = (now() - t) < LIVE_EDGE_S;
		if (nl !== nearLive) { nearLive = nl; onNearLiveChange?.(nl); }
	}
	let coverage = $state<[number, number][]>([]);
	let isPlaying = $state(false);
	let playbackRate = $state(1);
	let coverageError = $state(false);
	let fetchingCoverage = $state(false);

	let viewStart = $derived(viewCenter - viewSpan / 2);
	let viewEnd = $derived(viewCenter + viewSpan / 2);

	function onSeek(t: number) {
		currentTime = t;
		viewCenter = t;
		setNearLive(t);
	}

	function onZoomIn() {
		viewSpan = Math.max(60, viewSpan / 2);
	}

	function onZoomOut() {
		viewSpan = Math.min(7 * 86400, viewSpan * 2);
	}

	function onLive() {
		const t = now();
		isPlaying = false;
		currentTime = t;
		viewCenter = t;
		setNearLive(t);
	}

	function onTimeUpdate(t: number) {
		currentTime = t;
		if (t < viewStart + viewSpan * 0.1 || t > viewEnd - viewSpan * 0.1) {
			viewCenter = t;
		}
		setNearLive(t);
	}

	async function fetchCoverage() {
		if (fetchingCoverage) return;
		if (!localMode && (!$identity || !$pairedDevices[0])) return;
		fetchingCoverage = true;
		try {
			coverage = localMode
				? await getCoverageMap()
				: await requestCoverageMap($identity!.privkey, $identity!.pubkey, $pairedDevices[0]!.pubkey);
			coverageError = false;
		} catch {
			coverageError = true;
		} finally {
			fetchingCoverage = false;
		}
	}

	$effect(() => {
		if (localMode) fetchCoverage();
		else if ($streamState === 'connected') fetchCoverage();
	});

	onMount(() => {
		// $effect handles fetching when localMode=true or streamState becomes 'connected'.
		// Don't call fetchCoverage() unconditionally here — in non-local mode it would
		// call ensureConnection() and publish a Nostr offer-request before the user
		// has explicitly initiated a viewer connection.
		const interval = setInterval(fetchCoverage, 30_000);
		return () => clearInterval(interval);
	});
</script>

<div class="flex flex-col gap-2">
	<TimelineScrubber
		{viewStart}
		{viewEnd}
		{currentTime}
		{coverage}
		{events}
		{onSeek}
		{onZoomIn}
		{onZoomOut}
		{onLive}
	/>

	<TimelinePlayer
		{currentTime}
		{coverage}
		{isPlaying}
		{playbackRate}
		{onTimeUpdate}
		onPlayingChange={(p) => (isPlaying = p)}
		onRateChange={(r) => (playbackRate = r)}
		localFetch={localMode ? localFetch : undefined}
	/>

	{#if coverageError}
		<p class="text-xs text-center" style="color:var(--color-muted)">
			{localMode ? 'No local segments found' : 'Monitor offline — footage unavailable'}
		</p>
	{/if}

	{#if !localMode && $pairedDevices.length === 0}
		<p class="text-xs text-center" style="color:var(--color-warning)">
			No paired monitor — <a href="/pair/scan" style="color:var(--color-accent)">pair a device</a> to view footage.
		</p>
	{/if}
</div>
