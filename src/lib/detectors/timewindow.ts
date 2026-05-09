import type { Detector, DetectionEvent } from './types';
import type { SensorConfig, SensorState } from '$lib/store/pipeline';

// Activates during selected hour-slots in the weekly schedule.
// activeSlots: array of (dayOfWeek * 24 + hour) values, 0 = Sunday 00:00, 167 = Saturday 23:00.
// Transitions from idle to active at the start of an active slot (hour boundary).
// Transitions from active to idle when leaving an active slot.
// Polls every 60 seconds; accurate to the nearest minute within a slot.
export class TimeWindowDetector implements Detector<Record<string, unknown>> {
	onDetection: ((event: DetectionEvent<Record<string, unknown>>) => void) | null = null;
	onFiringChange: ((firing: boolean) => void) | null = null;
	onStateChange: ((state: SensorState) => void) | null = null;

	private activeSet: Set<number>;
	private timer: ReturnType<typeof setInterval> | null = null;
	private isInWindow = false;

	constructor(config: Pick<SensorConfig, 'activeSlots'>) {
		this.activeSet = new Set(config.activeSlots ?? []);
	}

	start(_stream?: MediaStream): void {
		this._tick();
		this.timer = setInterval(() => this._tick(), 60_000);
	}

	stop(): void {
		if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
		this.isInWindow = false;
	}

	private _currentSlot(now = new Date()): number {
		return now.getDay() * 24 + now.getHours();
	}

	private _tick(): void {
		const now = new Date();
		const inWindow = this.activeSet.has(this._currentSlot(now));

		if (inWindow === this.isInWindow) {
			if (!inWindow) {
				// Still outside — keep updating the countdown
				this.onStateChange?.({ status: 'idle', nextFireAt: this._nextActivationMs(now) });
			}
			return;
		}

		this.isInWindow = inWindow;
		if (inWindow) {
			this.onFiringChange?.(true);
			this.onStateChange?.({ status: 'active', startedAt: Date.now() });
			this.onDetection?.({ type: 'timewindow', data: {}, timestamp: Math.floor(Date.now() / 1000) });
		} else {
			this.onFiringChange?.(false);
			this.onStateChange?.({ status: 'idle', nextFireAt: this._nextActivationMs(now) });
		}
	}

	private _nextActivationMs(now: Date): number {
		// Walk forward up to 7 days × 24 hours looking for a slot that follows a non-active slot
		// (i.e. the start of an active window, not the continuation of one).
		const nowMs = now.getTime();
		for (let offset = 1; offset <= 7 * 24; offset++) {
			const candidate = new Date(nowMs + offset * 3_600_000);
			candidate.setMinutes(0, 0, 0);
			const slot = this._currentSlot(candidate);
			const prevSlot = (slot + 167) % 168; // slot one hour earlier in the week cycle
			if (this.activeSet.has(slot) && !this.activeSet.has(prevSlot)) {
				return candidate.getTime();
			}
		}
		// Fallback: next active slot regardless of transition
		for (let offset = 1; offset <= 7 * 24; offset++) {
			const candidate = new Date(nowMs + offset * 3_600_000);
			candidate.setMinutes(0, 0, 0);
			if (this.activeSet.has(this._currentSlot(candidate))) return candidate.getTime();
		}
		return nowMs + 7 * 24 * 3_600_000;
	}
}
