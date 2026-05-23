import { describe, it, expect } from 'vitest';
import { fmtDist, dateToView, rangeToView } from './timeline-utils';

describe('fmtDist', () => {
	it('formats sub-minute as seconds', () => {
		expect(fmtDist(0)).toBe('0s');
		expect(fmtDist(30)).toBe('30s');
		expect(fmtDist(59)).toBe('59s');
	});

	it('rounds to minutes', () => {
		expect(fmtDist(60)).toBe('1m');
		expect(fmtDist(90)).toBe('2m');   // 1.5 → rounds up
		expect(fmtDist(89)).toBe('1m');   // 1.48 → rounds down
		expect(fmtDist(3570)).toBe('60m'); // 59.5 → rounds up
	});

	it('rounds to hours', () => {
		expect(fmtDist(3600)).toBe('1h');
		expect(fmtDist(5400)).toBe('2h');  // 1.5h → rounds up
		expect(fmtDist(5399)).toBe('1h');  // just under 1.5h → rounds down
		expect(fmtDist(86399)).toBe('24h');
	});

	it('rounds to days', () => {
		expect(fmtDist(86400)).toBe('1d');
		expect(fmtDist(129600)).toBe('2d'); // 1.5d → rounds up
		expect(fmtDist(172800)).toBe('2d');
	});
});

describe('dateToView', () => {
	it('returns null for empty string', () => {
		expect(dateToView('')).toBeNull();
	});

	it('returns null for invalid date string', () => {
		expect(dateToView('not-a-date')).toBeNull();
		expect(dateToView('2024-99-99')).toBeNull();
	});

	it('returns span of 86400 for any valid date', () => {
		const r = dateToView('2024-01-15');
		expect(r).not.toBeNull();
		expect(r!.span).toBe(86400);
	});

	it('center is a positive unix timestamp', () => {
		const r = dateToView('2024-06-01');
		expect(r!.center).toBeGreaterThan(0);
		// Should correspond to noon of that day — within ±14h of midnight UTC
		const midnight = Math.floor(new Date('2024-06-01T00:00:00Z').getTime() / 1000);
		expect(r!.center).toBeGreaterThanOrEqual(midnight - 14 * 3600);
		expect(r!.center).toBeLessThanOrEqual(midnight + 24 * 3600);
	});
});

describe('rangeToView', () => {
	it('returns correct center and span', () => {
		expect(rangeToView(1000, 5000)).toEqual({ center: 3000, span: 4000 });
		expect(rangeToView(0, 3600)).toEqual({ center: 1800, span: 3600 });
	});

	it('rounds center to nearest second', () => {
		// (1000 + 2001) / 2 = 1500.5 → rounds to 1501
		expect(rangeToView(1000, 2001)).toEqual({ center: 1501, span: 1001 });
	});

	it('returns null when end <= start', () => {
		expect(rangeToView(5000, 1000)).toBeNull();
		expect(rangeToView(1000, 1000)).toBeNull();
	});

	it('returns null for non-finite values', () => {
		expect(rangeToView(NaN, 1000)).toBeNull();
		expect(rangeToView(1000, NaN)).toBeNull();
		expect(rangeToView(Infinity, 2000)).toBeNull();
	});
});
