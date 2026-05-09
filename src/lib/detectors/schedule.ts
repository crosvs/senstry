import type { Detector, DetectionEvent } from './types';
import type { SensorConfig, SensorState } from '$lib/store/pipeline';

export class ScheduleDetector implements Detector<Record<string, unknown>> {
	onDetection: ((event: DetectionEvent<Record<string, unknown>>) => void) | null = null;
	onFiringChange: ((firing: boolean) => void) | null = null;
	onStateChange: ((state: SensorState) => void) | null = null;

	private intervalMs: number;
	private settlingMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private settlingTimer: ReturnType<typeof setTimeout> | null = null;
	private startedAt = 0;

	constructor(config?: Pick<SensorConfig, 'intervalMs' | 'settlingMs'>) {
		this.intervalMs = config?.intervalMs ?? 60_000;
		this.settlingMs = config?.settlingMs ?? 1000;
	}

	// ScheduleDetector does not need a MediaStream
	start(_stream?: MediaStream): void {
		this.startedAt = Date.now();
		this.onStateChange?.({ status: 'idle', nextFireAt: this.startedAt + this.intervalMs });
		this.timer = setInterval(() => this._fire(), this.intervalMs);
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		if (this.settlingTimer !== null) clearTimeout(this.settlingTimer);
		this.timer = null;
		this.settlingTimer = null;
	}

	private _fire(): void {
		const now = Date.now();
		this.onFiringChange?.(true);
		this.onStateChange?.({ status: 'active', startedAt: now });
		this.onDetection?.({
			type: 'schedule',
			data: {},
			timestamp: Math.floor(now / 1000),
		});
		this.settlingTimer = setTimeout(() => {
			this.settlingTimer = null;
			this.onFiringChange?.(false);
			this.onStateChange?.({ status: 'idle', nextFireAt: now + this.intervalMs });
		}, this.settlingMs);
	}
}
