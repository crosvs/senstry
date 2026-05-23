import { describe, it, expect } from 'vitest';
import {
	covEarlierRange, covLaterRange,
	covFirstRange, covLastRange,
	covFirstTime, covLastTime,
} from './coverage-utils';

describe('covEarlierRange', () => {
	it('shifts left by the same span', () => {
		expect(covEarlierRange(3600, 7200)).toEqual([0, 3600]);
		expect(covEarlierRange(10000, 13600)).toEqual([6400, 10000]);
	});

	it('can produce negative start times (callers clamp if needed)', () => {
		// span = 300 - 100 = 200; new start = 100 - 200 = -100
		expect(covEarlierRange(100, 300)).toEqual([-100, 100]);
	});
});

describe('covLaterRange', () => {
	it('shifts right by the same span', () => {
		expect(covLaterRange(3600, 7200)).toEqual([7200, 10800]);
		expect(covLaterRange(0, 3600)).toEqual([3600, 7200]);
	});
});

describe('covFirstRange', () => {
	it('starts at firstTime and extends by span', () => {
		expect(covFirstRange(1000, 3600)).toEqual([1000, 4600]);
		expect(covFirstRange(0, 86400)).toEqual([0, 86400]);
	});
});

describe('covLastRange', () => {
	it('ends at lastTime and starts span seconds before', () => {
		expect(covLastRange(10000, 3600)).toEqual([6400, 10000]);
	});

	it('clamps start to 0 when span exceeds lastTime', () => {
		expect(covLastRange(100, 3600)).toEqual([0, 100]);
		expect(covLastRange(0, 3600)).toEqual([0, 0]);
	});
});

describe('covFirstTime', () => {
	it('returns null for empty map', () => {
		expect(covFirstTime({})).toBeNull();
	});

	it('returns null for channels with no intervals', () => {
		expect(covFirstTime({ ch1: [] })).toBeNull();
	});

	it('returns the earliest start across all channels', () => {
		expect(covFirstTime({
			ch1: [[1000, 2000], [5000, 6000]],
			ch2: [[500, 1500]],
		})).toBe(500);
	});

	it('handles single channel single interval', () => {
		expect(covFirstTime({ cam: [[9999, 10001]] })).toBe(9999);
	});
});

describe('covLastTime', () => {
	it('returns null for empty map', () => {
		expect(covLastTime({})).toBeNull();
	});

	it('returns null for channels with no intervals', () => {
		expect(covLastTime({ ch1: [] })).toBeNull();
	});

	it('returns the latest end across all channels', () => {
		expect(covLastTime({
			ch1: [[1000, 2000]],
			ch2: [[500, 8000]],
			ch3: [[3000, 7999]],
		})).toBe(8000);
	});

	it('handles single channel single interval', () => {
		expect(covLastTime({ cam: [[9999, 10001]] })).toBe(10001);
	});
});
