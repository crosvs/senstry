/** Shifts the current range one full span earlier. */
export function covEarlierRange(start: number, end: number): [number, number] {
	const span = end - start;
	return [start - span, start];
}

/** Shifts the current range one full span later. */
export function covLaterRange(start: number, end: number): [number, number] {
	const span = end - start;
	return [end, end + span];
}

/** Returns a range of `span` seconds starting at `firstTime`. */
export function covFirstRange(firstTime: number, span: number): [number, number] {
	return [firstTime, firstTime + span];
}

/** Returns a range of `span` seconds ending at `lastTime` (clamped to t≥0). */
export function covLastRange(lastTime: number, span: number): [number, number] {
	return [Math.max(0, lastTime - span), lastTime];
}

/** Earliest start time across all channel intervals, or null if empty. */
export function covFirstTime(coverageByChannel: Record<string, [number, number][]>): number | null {
	let earliest: number | null = null;
	for (const intervals of Object.values(coverageByChannel)) {
		for (const [s] of intervals) {
			if (earliest === null || s < earliest) earliest = s;
		}
	}
	return earliest;
}

/** Latest end time across all channel intervals, or null if empty. */
export function covLastTime(coverageByChannel: Record<string, [number, number][]>): number | null {
	let latest: number | null = null;
	for (const intervals of Object.values(coverageByChannel)) {
		for (const [, e] of intervals) {
			if (latest === null || e > latest) latest = e;
		}
	}
	return latest;
}
