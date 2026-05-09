import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DateRangeDetector } from './daterange';

describe('DateRangeDetector', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

	it('emits idle with nextFireAt before the start time', () => {
		vi.setSystemTime(new Date('2026-05-10T08:00'));
		const det = new DateRangeDetector({
			startIso: '2026-05-10T10:00',
			endIso:   '2026-05-10T12:00',
		});
		const states: any[] = [];
		det.onStateChange = (s) => states.push(s);
		det.start();
		expect(states[0].status).toBe('idle');
		expect(states[0].nextFireAt).toBeGreaterThan(Date.now());
		det.stop();
	});

	it('emits active and fires onDetection when in range', () => {
		vi.setSystemTime(new Date('2026-05-10T11:00'));
		const det = new DateRangeDetector({
			startIso: '2026-05-10T10:00',
			endIso:   '2026-05-10T12:00',
		});
		const states: string[] = [];
		let detections = 0;
		det.onStateChange = (s) => states.push(s.status);
		det.onDetection = () => detections++;
		det.start();
		expect(states[0]).toBe('active');
		expect(detections).toBe(1);
		det.stop();
	});

	it('emits inactive after the end time and stops polling', () => {
		vi.setSystemTime(new Date('2026-05-10T13:00'));
		const det = new DateRangeDetector({
			startIso: '2026-05-10T10:00',
			endIso:   '2026-05-10T12:00',
		});
		const states: string[] = [];
		det.onStateChange = (s) => states.push(s.status);
		det.start();
		expect(states[0]).toBe('inactive');
		// Advance time — no more state changes expected (timer should be cleared)
		vi.advanceTimersByTime(60_000);
		expect(states.length).toBe(1); // no additional emissions
		det.stop();
	});

	it('transitions idle → active → inactive over time', () => {
		vi.setSystemTime(new Date('2026-05-10T09:30'));
		const det = new DateRangeDetector({
			startIso: '2026-05-10T10:00',
			endIso:   '2026-05-10T10:02',
		});
		const states: string[] = [];
		det.onStateChange = (s) => states.push(s.status);
		det.start();
		expect(states).toContain('idle');

		// Advance to start time
		vi.setSystemTime(new Date('2026-05-10T10:01'));
		vi.advanceTimersByTime(30_000);
		expect(states).toContain('active');

		// Advance past end time
		vi.setSystemTime(new Date('2026-05-10T10:03'));
		vi.advanceTimersByTime(30_000);
		expect(states[states.length - 1]).toBe('inactive');
		det.stop();
	});

	it('onDetection fires only once on first activation', () => {
		vi.setSystemTime(new Date('2026-05-10T09:30'));
		const det = new DateRangeDetector({
			startIso: '2026-05-10T10:00',
			endIso:   '2026-05-10T11:00',
		});
		let count = 0;
		det.onDetection = () => count++;
		det.start();
		expect(count).toBe(0);

		vi.setSystemTime(new Date('2026-05-10T10:01'));
		vi.advanceTimersByTime(30_000);
		expect(count).toBe(1);

		// More ticks — no re-fire
		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(30_000);
		expect(count).toBe(1);
		det.stop();
	});
});
