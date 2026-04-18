<script lang="ts">
	import { identity, pairedDevices } from '$lib/store/identity';
	import { requestSegment } from '$lib/webrtc/viewer-peer';

	let {
		currentTime,
		coverage,
		isPlaying,
		playbackRate,
		onTimeUpdate,
		onPlayingChange,
		onRateChange,
		localFetch = undefined,
		coverage: _coverage = []
	}: {
		currentTime: number;
		coverage: [number, number][];
		isPlaying: boolean;
		playbackRate: number;
		onTimeUpdate: (t: number) => void;
		onPlayingChange: (p: boolean) => void;
		onRateChange: (r: number) => void;
		localFetch?: (time: number) => Promise<{ mimeType: string; blob: Blob; startTime: number; endTime: number }>;
	} = $props();

	type PlayStatus = 'idle' | 'loading' | 'playing' | 'no-footage' | 'offline' | 'error';

	let playStatus = $state<PlayStatus>('idle');
	let isVideoMode = $state(false);

	// Non-reactive flags (like sourceNode) so the isPlaying $effect doesn't loop
	let audioCtx: AudioContext | null = null;
	let sourceNode: AudioBufferSourceNode | null = null;
	let isVideoActive = false;
	let rafId: number | null = null;
	let playbackId = 0;

	let videoEl: HTMLVideoElement | undefined = $state();
	let activeVideoUrl: string | null = null;

	let lastSeekTime = 0; // 0 ensures first play always triggers startPlayback (currentTime is a unix timestamp)
	let playFromTime = 0;
	let playContextStart = 0;

	type CachedSeg = { mimeType: string; endTime: number } &
		({ kind: 'audio'; audioBuffer: AudioBuffer } | { kind: 'video'; blob: Blob });
	const segmentCache = new Map<number, CachedSeg>();

	function stopPlayback() {
		if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
		if (sourceNode) {
			try { sourceNode.onended = null; sourceNode.stop(); } catch { /* already stopped */ }
			sourceNode = null;
		}
		if (videoEl) {
			videoEl.onended = null;
			videoEl.pause();
		}
		isVideoActive = false;
	}

	async function startPlayback(fromTime: number) {
		stopPlayback();
		playbackId++;
		const myId = playbackId;
		lastSeekTime = fromTime;

		if (!localFetch && (!$identity || !$pairedDevices[0])) {
			playStatus = 'offline';
			onPlayingChange(false);
			return;
		}

		playStatus = 'loading';

		let actualStartTime = 0;
		let actualEndTime = 0;
		let cached: CachedSeg | undefined;

		for (const [segStart, c] of segmentCache) {
			if (segStart <= fromTime && c.endTime > fromTime) {
				cached = c;
				actualStartTime = segStart;
				actualEndTime = c.endTime;
				break;
			}
		}

		if (!cached) {
			try {
				const result = localFetch
					? await localFetch(fromTime)
					: await requestSegment(fromTime, $identity!.privkey, $identity!.pubkey, $pairedDevices[0]!.pubkey);
				if (myId !== playbackId) return;
				actualStartTime = result.startTime;
				actualEndTime = result.endTime;

				if (result.mimeType.startsWith('video/')) {
					cached = { kind: 'video', blob: result.blob, mimeType: result.mimeType, endTime: result.endTime };
				} else {
					if (!audioCtx) audioCtx = new AudioContext();
					const ab = await audioCtx.decodeAudioData(await result.blob.arrayBuffer());
					if (myId !== playbackId) return;
					cached = { kind: 'audio', audioBuffer: ab, mimeType: result.mimeType, endTime: result.endTime };
				}
				segmentCache.set(result.startTime, cached);
			} catch (e) {
				if (myId !== playbackId) return;
				const reason = e instanceof Error ? e.message : String(e);
				playStatus = reason === 'not-stored' || reason === 'segment timeout' ? 'no-footage'
					: reason === 'offline' ? 'offline' : 'error';
				onPlayingChange(false);
				return;
			}
		}

		if (myId !== playbackId) return;

		const segDuration = actualEndTime - actualStartTime;
		const offsetWithinSeg = Math.max(0, Math.min(fromTime - actualStartTime, segDuration - 0.1));
		playFromTime = fromTime;
		playStatus = 'playing';

		if (cached!.kind === 'video') {
			isVideoMode = true;
			if (!videoEl) return;

			if (activeVideoUrl) { URL.revokeObjectURL(activeVideoUrl); activeVideoUrl = null; }
			activeVideoUrl = URL.createObjectURL(cached.blob);
			videoEl.src = activeVideoUrl;
			videoEl.playbackRate = playbackRate;

			await new Promise<void>((res) => {
				if (!videoEl) { res(); return; }
				if (videoEl.readyState >= 1) { res(); return; }
				const onReady = () => { videoEl!.removeEventListener('loadedmetadata', onReady); res(); };
				videoEl.addEventListener('loadedmetadata', onReady);
			});
			if (myId !== playbackId || !videoEl) return;

			videoEl.currentTime = offsetWithinSeg;
			isVideoActive = true;
			try { await videoEl.play(); } catch { /* interrupted by next seek */ }
			if (myId !== playbackId) { videoEl.pause(); isVideoActive = false; return; }

			videoEl.onended = () => {
				if (myId !== playbackId) return;
				isVideoActive = false;
				startPlayback(actualEndTime);
			};

			const tick = () => {
				if (myId !== playbackId || !videoEl) return;
				const t = actualStartTime + videoEl.currentTime;
				lastSeekTime = t;
				onTimeUpdate(t);
				rafId = requestAnimationFrame(tick);
			};
			rafId = requestAnimationFrame(tick);
		} else {
			isVideoMode = false;
			if (!audioCtx) audioCtx = new AudioContext();
			const source = audioCtx.createBufferSource();
			source.buffer = cached!.audioBuffer;
			source.playbackRate.value = playbackRate;
			source.connect(audioCtx.destination);
			sourceNode = source;

			playContextStart = audioCtx.currentTime;
			source.start(0, offsetWithinSeg);

			source.onended = () => {
				if (myId !== playbackId) return;
				startPlayback(actualEndTime);
			};

			const tick = () => {
				if (myId !== playbackId || !audioCtx) return;
				const elapsed = (audioCtx.currentTime - playContextStart) * playbackRate;
				const t = playFromTime + elapsed;
				lastSeekTime = t;
				onTimeUpdate(t);
				rafId = requestAnimationFrame(tick);
			};
			rafId = requestAnimationFrame(tick);
		}
	}

	$effect(() => {
		if (isPlaying) {
			const seeked = Math.abs(currentTime - lastSeekTime) > 1.5;
			if (seeked || (!sourceNode && !isVideoActive)) {
				startPlayback(currentTime);
			}
		} else {
			stopPlayback();
			if (playStatus === 'playing' || playStatus === 'loading') {
				playStatus = 'idle';
			}
		}
	});

	$effect(() => {
		if (sourceNode) sourceNode.playbackRate.value = playbackRate;
		if (videoEl && isVideoActive) videoEl.playbackRate = playbackRate;
	});

	const RATES = [0.5, 1, 1.5, 2, 4];

	function formatTime(unix: number): string {
		return new Date(unix * 1000).toLocaleTimeString(undefined, {
			hour: '2-digit', minute: '2-digit', second: '2-digit'
		});
	}
</script>

<div class="flex flex-col gap-2">
	<!-- Video element always in DOM so bind:this is stable; hidden when not in video mode -->
	<video
		bind:this={videoEl}
		playsinline
		style="display:{isVideoMode && playStatus === 'playing' ? 'block' : 'none'};width:100%;border-radius:12px;background:#000;max-height:35vh"
	></video>

	<div class="flex items-center gap-3 px-2 py-2 rounded-xl" style="background:var(--color-surface)">
		<button
			onclick={() => onPlayingChange(!isPlaying)}
			class="w-9 h-9 flex items-center justify-center rounded-full shrink-0 font-bold text-sm"
			style="background:{isPlaying ? 'var(--color-danger)' : 'var(--color-accent)'};color:white"
			title={isPlaying ? 'Pause' : 'Play'}
		>
			{#if isPlaying}
				&#9646;&#9646;
			{:else}
				&#9654;
			{/if}
		</button>

		<div class="flex-1 min-w-0">
			{#if playStatus === 'loading'}
				<p class="text-xs" style="color:var(--color-muted)">Fetching from monitor…</p>
			{:else if playStatus === 'no-footage'}
				<p class="text-xs" style="color:var(--color-muted)">No footage at this time</p>
			{:else if playStatus === 'offline'}
				<p class="text-xs" style="color:var(--color-muted)">Monitor offline</p>
			{:else if playStatus === 'error'}
				<p class="text-xs" style="color:var(--color-danger)">Failed to load segment</p>
			{:else}
				<p class="text-xs font-mono" style="color:var(--color-text)">{formatTime(currentTime)}</p>
			{/if}
		</div>

		<div class="flex gap-1 shrink-0">
			{#each RATES as r}
				<button
					onclick={() => onRateChange(r)}
					class="text-xs px-1.5 py-0.5 rounded"
					style="background:{playbackRate === r ? 'var(--color-accent)' : 'var(--color-surface)'};color:{playbackRate === r ? 'white' : 'var(--color-muted)'};border:1px solid {playbackRate === r ? 'transparent' : 'var(--color-border)'}"
				>{r}×</button>
			{/each}
		</div>
	</div>
</div>
