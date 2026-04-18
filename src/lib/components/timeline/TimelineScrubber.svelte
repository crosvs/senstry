<script lang="ts">
	import type { StoredTriggerEvent } from '$lib/store/events';

	let {
		viewStart,
		viewEnd,
		currentTime,
		coverage = [],
		events = [],
		onSeek,
		onZoomIn,
		onZoomOut,
		onLive
	}: {
		viewStart: number;
		viewEnd: number;
		currentTime: number;
		coverage: [number, number][];
		events: StoredTriggerEvent[];
		onSeek: (t: number) => void;
		onZoomIn: () => void;
		onZoomOut: () => void;
		onLive: () => void;
	} = $props();

	const HEIGHT = 72;

	const EVENT_COLORS: Record<string, string> = {
		audio: '#60a5fa',
		motion: '#fbbf24',
		camera: '#34d399',
		gyroscope: '#a78bfa'
	};

	let canvas: HTMLCanvasElement | undefined = $state();
	let containerEl: HTMLDivElement | undefined = $state();
	let width = $state(0);
	let dragging = $state(false);
	let dragStartX = $state(0);
	let dragStartCenter = $state(0);

	function timeToX(t: number): number {
		return ((t - viewStart) / (viewEnd - viewStart)) * width;
	}

	function labelInterval(span: number): number {
		if (span > 7 * 86400) return 86400;
		if (span > 86400) return 43200;
		if (span > 21600) return 7200;
		if (span > 3600) return 1800;
		if (span > 600) return 300;
		if (span > 120) return 60;
		return 15;
	}

	function draw() {
		if (!canvas || width === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = HEIGHT * dpr;
		ctx.scale(dpr, dpr);

		// Background
		ctx.fillStyle = '#111827';
		ctx.fillRect(0, 0, width, HEIGHT);

		// Coverage bar area (bottom 14px)
		const barY = HEIGHT - 18;
		const barH = 12;

		// No-footage track
		ctx.fillStyle = '#1f2937';
		ctx.fillRect(0, barY, width, barH);

		// Stored segment blocks
		ctx.fillStyle = '#1d4ed8';
		for (const [start, end] of coverage) {
			const x1 = Math.max(0, timeToX(start));
			const x2 = Math.min(width, timeToX(end));
			if (x2 > x1) ctx.fillRect(x1, barY, x2 - x1, barH);
		}

		// Coverage bar top border
		ctx.fillStyle = '#374151';
		ctx.fillRect(0, barY - 1, width, 1);

		// Time labels and tick marks
		const span = viewEnd - viewStart;
		const interval = labelInterval(span);
		const first = Math.ceil(viewStart / interval) * interval;

		ctx.font = '10px ui-monospace, monospace';
		ctx.textAlign = 'center';

		for (let t = first; t <= viewEnd; t += interval) {
			const x = timeToX(t);
			if (x < 0 || x > width) continue;

			// Tick mark
			ctx.fillStyle = '#374151';
			ctx.fillRect(Math.round(x), barY - 4, 1, barH + 4);

			// Label
			const d = new Date(t * 1000);
			const label = span > 86400
				? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
				: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
			ctx.fillStyle = '#6b7280';
			ctx.fillText(label, x, barY - 8);
		}

		// Event markers
		for (const evt of events) {
			const x = timeToX(evt.created_at);
			if (x < 2 || x > width - 2) continue;
			const color = EVENT_COLORS[evt.type] ?? '#9ca3af';
			ctx.fillStyle = color + 'cc';
			ctx.fillRect(Math.round(x) - 1, 18, 2, barY - 22);
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(x, 14, 5, 0, Math.PI * 2);
			ctx.fill();
		}

		// Cursor line
		const cx = timeToX(currentTime);
		if (cx >= 0 && cx <= width) {
			ctx.fillStyle = '#ef4444';
			ctx.fillRect(Math.round(cx) - 1, 0, 2, HEIGHT);
			ctx.beginPath();
			ctx.arc(cx, HEIGHT / 2, 5, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	$effect(() => {
		// Reactive draw whenever any display input changes
		viewStart; viewEnd; currentTime; coverage; events; width;
		draw();
	});

	function pointerX(e: PointerEvent): number {
		const rect = canvas!.getBoundingClientRect();
		return e.clientX - rect.left;
	}

	function handlePointerDown(e: PointerEvent) {
		dragging = true;
		dragStartX = pointerX(e);
		dragStartCenter = (viewStart + viewEnd) / 2;
		canvas?.setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = pointerX(e) - dragStartX;
		const span = viewEnd - viewStart;
		onSeek(dragStartCenter - (dx / width) * span);
	}

	function handlePointerUp() {
		dragging = false;
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		if (e.deltaY < 0) onZoomIn();
		else onZoomOut();
	}

	$effect(() => {
		if (!containerEl) return;
		const ro = new ResizeObserver((entries) => {
			width = entries[0].contentRect.width;
		});
		ro.observe(containerEl);
		return () => ro.disconnect();
	});
</script>

<div bind:this={containerEl} class="relative w-full select-none" style="height:{HEIGHT}px">
	<canvas
		bind:this={canvas}
		style="width:100%;height:{HEIGHT}px;display:block;cursor:{dragging ? 'grabbing' : 'grab'}"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onwheel={handleWheel}
	></canvas>
	<div class="absolute top-1 right-1 flex gap-1 pointer-events-auto">
		<button
			onclick={onZoomIn}
			class="text-xs w-6 h-6 flex items-center justify-center rounded font-mono leading-none"
			style="background:#1f2937;color:#d1d5db;border:1px solid #374151"
			title="Zoom in"
		>+</button>
		<button
			onclick={onZoomOut}
			class="text-xs w-6 h-6 flex items-center justify-center rounded font-mono leading-none"
			style="background:#1f2937;color:#d1d5db;border:1px solid #374151"
			title="Zoom out"
		>−</button>
		<button
			onclick={onLive}
			class="text-xs px-2 h-6 rounded font-semibold"
			style="background:#dc2626;color:white"
		>Live</button>
	</div>
</div>
