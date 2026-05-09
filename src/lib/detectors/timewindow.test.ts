import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeWindowDetector } from './timewindow';

// Build an activeSlots array for given (day, hour) pairs
function slots(...pairs: [number, number][]): number[] {
	return pairs.map(([d, h]) => d * 24 + h).sort((a, b) => a - b);
}

// All 24 hours for given days
function daySlots(...days: number[]): number[] {
	const s: number[] = [];
	for (const d of days) for (let h = 0; h < 24; h++) s.push(d * 24 + h);
	return s.sort((a, b) => a - b);
}

describe('TimeWindowDetector', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

	it('fires active when current hour-slot is in activeSlots', () => {
		// Tuesday (2) 14:00
		vi.setSystemTime(new Date(2026, 4, 12, 14, 30)); // 2026-05-12 (Tue) 14:30
		const det = new TimeWindowDetector({ activeSlots: slots([2, 14]) });
		const states: string[] = [];
		det.onStateChange = (s) => states.push(s.status);

		det.start();
		expect(states).toContain('active');
		det.stop();
	});

	it('emits idle with nextFireAt when not in active slot', () => {
		// Tuesday (2) 10:00 — slot [2, 14] is not active at 10:00
		vi.setSystemTime(new Date(2026, 4, 12, 10, 0));
		const det = new TimeWindowDetector({ activeSlots: slots([2, 14]) });
		const states: { status: string; nextFireAt?: number }[] = [];
		det.onStateChange = (s) => states.push({ status: s.status, nextFireAt: (s as any).nextFireAt });

		det.start();
		expect(states[0].status).toBe('idle');
		expect(states[0].nextFireAt).toBeDefined();
		// nextFireAt should be in the future (4 hours from now, roughly)
		expect(states[0].nextFireAt!).toBeGreaterThan(Date.now());
		det.stop();
	});

	it('onDetection fires once on entering active slot, not on subsequent ticks', () => {
		// Start just before the active hour
		vi.setSystemTime(new Date(2026, 4, 12, 13, 59));
		const det = new TimeWindowDetector({ activeSlots: slots([2, 14]) });
		let detectionCount = 0;
		det.onDetection = () => detectionCount++;
		det.start();
		expect(detectionCount).toBe(0); // 13:59 is not in slot [2, 14]

		// Advance to 14:00 — now in the active slot
		vi.setSystemTime(new Date(2026, 4, 12, 14, 0));
		vi.advanceTimersByTime(60_000); // trigger the 60s poll
		expect(detectionCount).toBe(1);

		// Another tick — still in the same slot, no re-detection
		vi.advanceTimersByTime(60_000);
		expect(detectionCount).toBe(1);
		det.stop();
	});

	it('transitions back to idle when leaving the active slot', () => {
		// Start inside the active hour
		vi.setSystemTime(new Date(2026, 4, 12, 14, 0));
		const det = new TimeWindowDetector({ activeSlots: slots([2, 14]) });
		const states: string[] = [];
		det.onStateChange = (s) => states.push(s.status);
		det.start();
		expect(states).toContain('active');

		// Advance into the next hour (15:00) — slot [2, 15] not in activeSlots
		vi.setSystemTime(new Date(2026, 4, 12, 15, 0));
		vi.advanceTimersByTime(60_000);
		expect(states[states.length - 1]).toBe('idle');
		det.stop();
	});

	it('handles whole-day selection (all 24 slots for a day)', () => {
		vi.setSystemTime(new Date(2026, 4, 12, 3, 0)); // Tue 03:00
		const det = new TimeWindowDetector({ activeSlots: daySlots(2) }); // all of Tuesday
		const states: string[] = [];
		det.onStateChange = (s) => states.push(s.status);
		det.start();
		expect(states[0]).toBe('active');
		det.stop();
	});

	it('handles empty activeSlots — always idle', () => {
		vi.setSystemTime(new Date(2026, 4, 12, 14, 0));
		const det = new TimeWindowDetector({ activeSlots: [] });
		const states: string[] = [];
		det.onStateChange = (s) => states.push(s.status);
		det.start();
		// Should be idle (no slots active)
		expect(states[0]).toBe('idle');
		det.stop();
	});

	it('correctly detects midnight-crossing pattern (e.g. 22:00–02:00)', () => {
		// Slots for Mon evening (22,23) and Tue morning (0,1)
		const nightSlots = slots([1, 22], [1, 23], [2, 0], [2, 1]);

		// Mon 23:30 — should be active (Mon 23:00 slot)
		vi.setSystemTime(new Date(2026, 4, 11, 23, 30));
		const det1 = new TimeWindowDetector({ activeSlots: nightSlots });
		const st1: string[] = [];
		det1.onStateChange = (s) => st1.push(s.status);
		det1.start();
		expect(st1[0]).toBe('active');
		det1.stop();

		// Tue 01:30 — should be active (Tue 01:00 slot)
		vi.setSystemTime(new Date(2026, 4, 12, 1, 30));
		const det2 = new TimeWindowDetector({ activeSlots: nightSlots });
		const st2: string[] = [];
		det2.onStateChange = (s) => st2.push(s.status);
		det2.start();
		expect(st2[0]).toBe('active');
		det2.stop();

		// Tue 02:30 — should be idle (not in any slot)
		vi.setSystemTime(new Date(2026, 4, 12, 2, 30));
		const det3 = new TimeWindowDetector({ activeSlots: nightSlots });
		const st3: string[] = [];
		det3.onStateChange = (s) => st3.push(s.status);
		det3.start();
		expect(st3[0]).toBe('idle');
		det3.stop();
	});

	it('nextActivationMs points to the next slot boundary after the current time', () => {
		// Sun 00:30 — only slot is Mon 09:00 (slot 1*24+9 = 33)
		vi.setSystemTime(new Date(2026, 4, 10, 0, 30)); // 2026-05-10 Sun 00:30
		const det = new TimeWindowDetector({ activeSlots: slots([1, 9]) });
		const states: any[] = [];
		det.onStateChange = (s) => states.push(s);
		det.start();
		expect(states[0].status).toBe('idle');
		const next = states[0].nextFireAt as number;
		const nextDate = new Date(next);
		// Should be Monday 09:00
		expect(nextDate.getDay()).toBe(1); // Monday
		expect(nextDate.getHours()).toBe(9);
		det.stop();
	});
});
