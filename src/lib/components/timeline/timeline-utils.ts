/** Formats a duration (seconds) as a single rounded unit: 30s, 5m, 2h, 3d */
export function fmtDist(secs: number): string {
	if (secs >= 86400) return `${Math.round(secs / 86400)}d`;
	if (secs >= 3600)  return `${Math.round(secs / 3600)}h`;
	if (secs >= 60)    return `${Math.round(secs / 60)}m`;
	return `${Math.round(secs)}s`;
}

/** Returns view params for a 1-day window centred on noon of dateStr (YYYY-MM-DD). */
export function dateToView(dateStr: string): { center: number; span: number } | null {
	if (!dateStr) return null;
	const d = new Date(dateStr + 'T12:00:00');
	if (isNaN(d.getTime())) return null;
	return { center: Math.floor(d.getTime() / 1000), span: 86400 };
}

/** Returns view params (center + span) derived from an explicit unix timestamp range. */
export function rangeToView(start: number, end: number): { center: number; span: number } | null {
	if (!isFinite(start) || !isFinite(end) || end <= start) return null;
	return { center: Math.round((start + end) / 2), span: end - start };
}
