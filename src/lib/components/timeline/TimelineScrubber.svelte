<script lang="ts">
	import type { AlertRecord } from '$lib/store/notification-listener';
	import type { StoredTriggerEvent } from '$lib/store/events';
	import { fmtDist } from './timeline-utils';

	const ALERT_COLORS: Record<string, string> = {
		audio: '#60a5fa',
		motion: '#fbbf24',
		camera: '#34d399',
		gyroscope: '#a78bfa',
		schedule: '#f97316',
		nostr: '#ec4899',
	};

	let {
		viewStart,
		viewEnd,
		currentTime,
		liveTime,                  // the actual now() — right boundary, never seekable past
		// Legacy single-channel (backward compat with TimelineView)
		coverage = [],
		events = [],
		// Multi-channel
		coverageByChannel = {},
		activeChannels = [],
		channelColors = {},
		alerts = [],
		mode = 'view',
		isPortrait = false,
		onSeek,
		onScrubStart,
		onScrubEnd,
		onZoomIn,
		onZoomOut,
		isLiveConnected = false,
	}: {
		viewStart: number;
		viewEnd: number;
		currentTime: number;
		liveTime: number;
		coverage?: [number, number][];
		events?: StoredTriggerEvent[];
		coverageByChannel?: Record<string, [number, number][]>;
		activeChannels?: string[];
		channelColors?: Record<string, string>;
		alerts?: AlertRecord[];
		mode?: 'live' | 'view';
		isPortrait?: boolean;
		isLiveConnected?: boolean;
		onSeek: (t: number) => void;
		onScrubStart?: () => void;
		onScrubEnd?: () => void;
		onZoomIn: () => void;
		onZoomOut: () => void;
	} = $props();

	// Normalize: if coverageByChannel is empty, fall back to legacy coverage as "_all"
	let _effCov = $derived(
		Object.keys(coverageByChannel).length > 0
			? coverageByChannel
			: coverage.length > 0
				? { _all: coverage }
				: {}
	);

	let _visCh = $derived(
		activeChannels.length > 0
			? activeChannels.filter((c) => c in _effCov)
			: Object.keys(_effCov)
	);

	// Layout constants
	const L_ALERT_H = 22;
	const L_LABEL_H = 28;
	const L_LANE_H = 16;
	const P_LABEL_W = 50;
	const P_ALERT_W = 22;
	const P_HEIGHT = 280;

	let _laneCount = $derived(Math.max(1, _visCh.length));
	let _landscapeH = $derived(L_ALERT_H + L_LABEL_H + _laneCount * L_LANE_H);

	let canvas: HTMLCanvasElement | undefined = $state();
	let containerEl: HTMLDivElement | undefined = $state();
	let cw = $state(300);
	let dragging = $state(false);
	let dragStart = $state(0);
	let dragStartCenter = $state(0);

	let cssH = $derived(isPortrait ? P_HEIGHT : _landscapeH);

	// ── Coordinate helpers ──────────────────────────────────────────────────────

	function tToLX(t: number): number {
		return ((t - viewStart) / (viewEnd - viewStart)) * cw;
	}
	function tToPY(t: number): number {
		return ((t - viewStart) / (viewEnd - viewStart)) * P_HEIGHT;
	}
	function lxToT(x: number): number {
		return viewStart + (x / cw) * (viewEnd - viewStart);
	}
	function pyToT(y: number): number {
		return viewStart + (y / P_HEIGHT) * (viewEnd - viewStart);
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

	function fmtLabel(t: number, span: number): string {
		const d = new Date(t * 1000);
		return span > 86400
			? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
			: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
	}


	// Returns how far (in seconds) off-screen coverage lies in each direction.
	// null means no off-screen coverage on that side, or visible coverage already
	// touches that edge.
	function computeEdgeHints(): { leftDist: number | null; rightDist: number | null } {
		let nearestLeft = -Infinity;
		let nearestRight = Infinity;
		let touchesLeft = false;
		let touchesRight = false;
		for (const ch of _visCh) {
			for (const [s, e] of _effCov[ch] ?? []) {
				if (s <= viewStart && e > viewStart) { touchesLeft = true; continue; }
				if (s < viewEnd && e >= viewEnd) { touchesRight = true; continue; }
				if (e <= viewStart && e > nearestLeft) nearestLeft = e;
				if (s >= viewEnd && s < nearestRight) nearestRight = s;
			}
		}
		return {
			leftDist:  !touchesLeft  && nearestLeft  > -Infinity ? viewStart - nearestLeft  : null,
			rightDist: !touchesRight && nearestRight <  Infinity ? nearestRight - viewEnd    : null,
		};
	}

	// ── Draw ────────────────────────────────────────────────────────────────────

	function draw() {
		if (!canvas || cw === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const W = cw;
		const H = cssH;
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		ctx.scale(dpr, dpr);

		ctx.fillStyle = '#0f172a';
		ctx.fillRect(0, 0, W, H);

		if (isPortrait) drawPortrait(ctx, W, H);
		else drawLandscape(ctx, W, H);
	}

	function drawLandscape(ctx: CanvasRenderingContext2D, W: number, H: number) {
		const span = viewEnd - viewStart;
		const lanesTop = L_ALERT_H + L_LABEL_H;

		// ── Channel lanes ──
		for (let i = 0; i < _visCh.length; i++) {
			const chId = _visCh[i];
			const y0 = lanesTop + i * L_LANE_H;
			if (y0 >= H) break;
			const lh = Math.min(L_LANE_H, H - y0);

			ctx.fillStyle = '#1e293b';
			ctx.fillRect(0, y0, W, lh);

			const color = channelColors[chId] ?? '#3b82f6';
			ctx.fillStyle = color + '70';
			for (const [s, e] of _effCov[chId] ?? []) {
				const x1 = Math.max(0, tToLX(s));
				const x2 = Math.min(W, tToLX(e));
				if (x2 > x1) ctx.fillRect(x1, y0 + 1, x2 - x1, lh - 2);
			}

			if (chId !== '_all') {
				// Per-channel off-screen hints
				let nearestLeft = -Infinity, nearestRight = Infinity;
				let touchesLeft = false, touchesRight = false;
				for (const [s, e] of _effCov[chId] ?? []) {
					if (s <= viewStart && e > viewStart) touchesLeft = true;
					else if (s < viewEnd && e >= viewEnd) touchesRight = true;
					else if (e <= viewStart && e > nearestLeft) nearestLeft = e;
					else if (s >= viewEnd && s < nearestRight) nearestRight = s;
				}
				const chLeftDist  = !touchesLeft  && nearestLeft  > -Infinity ? viewStart - nearestLeft  : null;
				const chRightDist = !touchesRight && nearestRight <  Infinity ? nearestRight - viewEnd    : null;

				const labelY = y0 + lh - 3;
				ctx.font = '8px ui-monospace, monospace';
				ctx.fillStyle = color + 'cc';

				// Left: optional hint then channel name
				let nameX = 3;
				if (chLeftDist !== null) {
					const hintTxt = `← ${fmtDist(chLeftDist)}  `;
					ctx.textAlign = 'left';
					ctx.fillText(hintTxt, 3, labelY);
					nameX = 3 + ctx.measureText(hintTxt).width;
				}
				ctx.textAlign = 'left';
				ctx.fillText(chId.slice(0, 12), nameX, labelY);

				// Right: optional hint
				if (chRightDist !== null) {
					ctx.textAlign = 'right';
					ctx.fillText(`${fmtDist(chRightDist)} →`, W - 3, labelY);
				}
			}

			if (i > 0) {
				ctx.fillStyle = '#334155';
				ctx.fillRect(0, y0, W, 1);
			}
		}

		ctx.fillStyle = '#334155';
		ctx.fillRect(0, lanesTop, W, 1);

		// ── Time tick marks + labels ──
		const interval = labelInterval(span);
		const first = Math.ceil(viewStart / interval) * interval;
		ctx.font = '10px ui-monospace, monospace';
		ctx.textAlign = 'center';

		for (let t = first; t <= viewEnd; t += interval) {
			const x = tToLX(t);
			if (x < 0 || x > W) continue;
			ctx.fillStyle = '#1e293b';
			ctx.fillRect(Math.round(x), L_ALERT_H, 1, H - L_ALERT_H);
			ctx.fillStyle = '#64748b';
			ctx.fillText(fmtLabel(t, span), x, L_ALERT_H + 16);
		}

		// ── Alert / event markers ──
		const allMarkers: Array<{ t: number; color: string }> = [
			...events.map((e) => ({ t: e.created_at, color: ALERT_COLORS[e.type] ?? '#9ca3af' })),
			...alerts.map((a) => ({ t: a.timestamp, color: ALERT_COLORS[a.detectionType] ?? '#9ca3af' })),
		];
		for (const { t, color } of allMarkers) {
			const x = tToLX(t);
			if (x < 2 || x > W - 2) continue;
			ctx.fillStyle = color + '55';
			ctx.fillRect(Math.round(x) - 1, L_ALERT_H, 2, H - L_ALERT_H);
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(x, 11, 4.5, 0, Math.PI * 2);
			ctx.fill();
		}

		// ── Now/LIVE line (right boundary — always drawn) ──
		{
			const lx = tToLX(liveTime);
			if (lx >= 0 && lx <= W) {
				ctx.fillStyle = isLiveConnected ? '#ef4444' : '#6b7280';
				ctx.fillRect(Math.round(lx) - 1, 0, 2, H);
			}
		}

		// ── View cursor (currentTime) — only show separately in view mode ──
		// In live mode the cursor coincides with liveTime so we skip it.
		if (mode === 'view') {
			const cx = tToLX(currentTime);
			if (cx >= 0 && cx <= W) {
				ctx.fillStyle = '#60a5fa55';
				ctx.fillRect(Math.round(cx) - 1, 0, 2, H);
				ctx.fillStyle = '#60a5fa';
				ctx.beginPath();
				ctx.arc(cx, lanesTop + (_laneCount * L_LANE_H) / 2, 4, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	function drawPortrait(ctx: CanvasRenderingContext2D, W: number, H: number) {
		const span = viewEnd - viewStart;
		const colAreaW = W - P_LABEL_W - P_ALERT_W;
		const numCh = _visCh.length || 1;
		const colW = Math.max(4, colAreaW / numCh);

		// ── Channel columns ──
		for (let i = 0; i < _visCh.length; i++) {
			const chId = _visCh[i];
			const x0 = P_LABEL_W + i * colW;
			const cw2 = Math.min(colW, P_LABEL_W + colAreaW - x0);
			if (cw2 <= 0) break;

			ctx.fillStyle = '#1e293b';
			ctx.fillRect(x0, 0, cw2, H);

			const color = channelColors[chId] ?? '#3b82f6';
			ctx.fillStyle = color + '70';
			for (const [s, e] of _effCov[chId] ?? []) {
				const y1 = Math.max(0, tToPY(s));
				const y2 = Math.min(H, tToPY(e));
				if (y2 > y1) ctx.fillRect(x0 + 1, y1, cw2 - 2, y2 - y1);
			}

			if (chId !== '_all') {
				// Per-channel off-screen hints
				let nearestLeft = -Infinity, nearestRight = Infinity;
				let touchesLeft = false, touchesRight = false;
				for (const [s, e] of _effCov[chId] ?? []) {
					if (s <= viewStart && e > viewStart) touchesLeft = true;
					else if (s < viewEnd && e >= viewEnd) touchesRight = true;
					else if (e <= viewStart && e > nearestLeft) nearestLeft = e;
					else if (s >= viewEnd && s < nearestRight) nearestRight = s;
				}
				const chLeftDist  = !touchesLeft  && nearestLeft  > -Infinity ? viewStart - nearestLeft  : null;
				const chRightDist = !touchesRight && nearestRight <  Infinity ? nearestRight - viewEnd    : null;

				const cx = x0 + cw2 / 2;
				ctx.fillStyle = color + 'cc';
				ctx.font = '8px ui-monospace, monospace';
				ctx.textAlign = 'center';
				// If ↑ hint present, it takes the top slot and pushes the name down
				const nameY = chLeftDist !== null ? 20 : 10;
				if (chLeftDist !== null)  ctx.fillText(`↑ ${fmtDist(chLeftDist)}`,  cx, 10);
				ctx.fillText(chId.slice(0, 6), cx, nameY);
				if (chRightDist !== null) ctx.fillText(`↓ ${fmtDist(chRightDist)}`, cx, H - 6);
			}

			if (i > 0) {
				ctx.fillStyle = '#334155';
				ctx.fillRect(x0, 0, 1, H);
			}
		}

		ctx.fillStyle = '#334155';
		ctx.fillRect(P_LABEL_W, 0, 1, H);

		// ── Time labels ──
		const interval = labelInterval(span);
		const first = Math.ceil(viewStart / interval) * interval;
		ctx.font = '9px ui-monospace, monospace';
		ctx.textAlign = 'right';

		for (let t = first; t <= viewEnd; t += interval) {
			const y = tToPY(t);
			if (y < 8 || y > H - 4) continue;
			ctx.fillStyle = '#1e293b';
			ctx.fillRect(P_LABEL_W, Math.round(y), W - P_LABEL_W, 1);
			ctx.fillStyle = '#64748b';
			ctx.fillText(fmtLabel(t, span), P_LABEL_W - 3, y + 3);
		}

		// ── Alert / event markers ──
		const alertDotX = W - P_ALERT_W / 2;
		const allMarkers: Array<{ t: number; color: string }> = [
			...events.map((e) => ({ t: e.created_at, color: ALERT_COLORS[e.type] ?? '#9ca3af' })),
			...alerts.map((a) => ({ t: a.timestamp, color: ALERT_COLORS[a.detectionType] ?? '#9ca3af' })),
		];
		for (const { t, color } of allMarkers) {
			const y = tToPY(t);
			if (y < 4 || y > H - 4) continue;
			ctx.fillStyle = color + '55';
			ctx.fillRect(P_LABEL_W, Math.round(y) - 1, W - P_LABEL_W, 2);
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.arc(alertDotX, y, 5, 0, Math.PI * 2);
			ctx.fill();
		}

		// ── Now/LIVE line (bottom boundary in portrait — always drawn) ──
		{
			const ly = tToPY(liveTime);
			if (ly >= 0 && ly <= H) {
				ctx.fillStyle = isLiveConnected ? '#ef4444' : '#6b7280';
				ctx.fillRect(0, Math.round(ly) - 1, W, 2);
			}
		}

		// ── View cursor (only in view mode) ──
		if (mode === 'view') {
			const cy = tToPY(currentTime);
			if (cy >= 0 && cy <= H) {
				ctx.fillStyle = '#60a5fa55';
				ctx.fillRect(0, Math.round(cy) - 1, W, 2);
				ctx.fillStyle = '#60a5fa';
				ctx.beginPath();
				ctx.arc(W / 2, cy, 4, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	$effect(() => {
		viewStart; viewEnd; currentTime; liveTime;
		coverage; events; coverageByChannel; activeChannels; channelColors; alerts;
		mode; isPortrait; cw; cssH;
		draw();
	});

	// ── Pointer interaction ─────────────────────────────────────────────────────

	function clampToLive(t: number): number {
		return Math.min(t, liveTime);
	}

	function pointerPos(e: PointerEvent): number {
		const rect = canvas!.getBoundingClientRect();
		return isPortrait ? e.clientY - rect.top : e.clientX - rect.left;
	}

	function handlePointerDown(e: PointerEvent) {
		dragging = true;
		dragStart = pointerPos(e);
		dragStartCenter = (viewStart + viewEnd) / 2;
		canvas?.setPointerCapture(e.pointerId);
		onScrubStart?.();
	}

	function handlePointerMove(e: PointerEvent) {
		if (!dragging) return;
		const delta = pointerPos(e) - dragStart;
		const span = viewEnd - viewStart;
		const dim = isPortrait ? P_HEIGHT : cw;
		onSeek(clampToLive(dragStartCenter - (delta / dim) * span));
	}

	function handlePointerUp(e: PointerEvent) {
		if (Math.abs(pointerPos(e) - dragStart) < 5) {
			const pos = pointerPos(e);
			onSeek(clampToLive(isPortrait ? pyToT(pos) : lxToT(pos)));
		}
		dragging = false;
		onScrubEnd?.();
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		if (e.deltaY < 0) onZoomIn();
		else onZoomOut();
	}

	$effect(() => {
		if (!containerEl) return;
		const ro = new ResizeObserver((entries) => {
			cw = entries[0].contentRect.width;
		});
		ro.observe(containerEl);
		return () => ro.disconnect();
	});
</script>

<div bind:this={containerEl} class="relative w-full select-none" style="height:{cssH}px">
	<canvas
		bind:this={canvas}
		style="width:100%;height:{cssH}px;display:block;cursor:{dragging ? 'grabbing' : 'grab'}"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onwheel={handleWheel}
	></canvas>

	<div
		class="ctrl-group"
		style="{isPortrait
			? 'bottom:8px;right:4px;flex-direction:column;align-items:flex-end'
			: 'top:4px;right:4px;flex-direction:row'}"
	>
		<button onclick={onZoomIn} class="ctrl-btn" title="Zoom in">+</button>
		<button onclick={onZoomOut} class="ctrl-btn" title="Zoom out">−</button>
	</div>
</div>

<style>
	.ctrl-group {
		position: absolute;
		display: flex;
		gap: 3px;
		pointer-events: auto;
	}
	.ctrl-btn {
		font-size: 11px;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		font-family: ui-monospace, monospace;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		background: #1e293b;
		color: #94a3b8;
		border: 1px solid #334155;
	}
	.ctrl-btn:hover {
		background: #334155;
		color: #e2e8f0;
	}
</style>
