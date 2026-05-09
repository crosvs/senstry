import type { Detector, DetectionEvent } from './types';
import type { SensorConfig, SensorState } from '$lib/store/pipeline';

// One-time activation between startIso and endIso datetimes.
// After endIso the sensor becomes permanently inactive.
export class DateRangeDetector implements Detector<Record<string, unknown>> {
	onDetection: ((event: DetectionEvent<Record<string, unknown>>) => void) | null = null;
	onFiringChange: ((firing: boolean) => void) | null = null;
	onStateChange: ((state: SensorState) => void) | null = null;

	private startMs: number;
	private endMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private phase: 'before' | 'active' | 'done' = 'before';

	constructor(config: Pick<SensorConfig, 'startIso' | 'endIso'>) {
		this.startMs = config.startIso ? new Date(config.startIso).getTime() : Date.now();
		this.endMs   = config.endIso   ? new Date(config.endIso).getTime()   : Date.now();
	}

	start(_stream?: MediaStream): void {
		this._tick();
		this.timer = setInterval(() => this._tick(), 30_000);
	}

	stop(): void {
		if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
		this.phase = 'before';
	}

	private _tick(): void {
		const now = Date.now();

		if (now >= this.endMs) {
			if (this.phase !== 'done') {
				this.phase = 'done';
				this.onFiringChange?.(false);
				this.onStateChange?.({ status: 'inactive' });
				if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
			}
			return;
		}

		if (now >= this.startMs) {
			if (this.phase !== 'active') {
				this.phase = 'active';
				this.onFiringChange?.(true);
				this.onStateChange?.({ status: 'active', startedAt: now });
				this.onDetection?.({ type: 'daterange', data: {}, timestamp: Math.floor(now / 1000) });
			}
			return;
		}

		// Before start
		if (this.phase !== 'before') return;
		this.onStateChange?.({ status: 'idle', nextFireAt: this.startMs });
	}
}
