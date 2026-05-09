import type { Detector, DetectionEvent } from './types';
import type { SensorConfig, SensorState } from '$lib/store/pipeline';

// Activates during a recurring HH:MM–HH:MM window on selected days of week.
// Handles midnight crossover (e.g. 22:00–05:30).
// Day-of-week check is applied to the *start* of the window, not the end.
export class TimeWindowDetector implements Detector<Record<string, unknown>> {
	onDetection: ((event: DetectionEvent<Record<string, unknown>>) => void) | null = null;
	onFiringChange: ((firing: boolean) => void) | null = null;
	onStateChange: ((state: SensorState) => void) | null = null;

	private startH: number;
	private startM: number;
	private endH: number;
	private endM: number;
	private daysOfWeek: number[];  // 0=Sun … 6=Sat; empty = all days
	private crossesMidnight: boolean;
	private timer: ReturnType<typeof setInterval> | null = null;
	private isInWindow = false;

	constructor(config: Pick<SensorConfig, 'startHHMM' | 'endHHMM' | 'daysOfWeek'>) {
		const [sh, sm] = this._parseHHMM(config.startHHMM ?? '00:00');
		const [eh, em] = this._parseHHMM(config.endHHMM ?? '00:00');
		this.startH = sh; this.startM = sm;
		this.endH   = eh; this.endM   = em;
		this.daysOfWeek = config.daysOfWeek ?? [];
		const startMins = sh * 60 + sm;
		const endMins   = eh * 60 + em;
		this.crossesMidnight = endMins <= startMins;
	}

	start(_stream?: MediaStream): void {
		this._tick();
		this.timer = setInterval(() => this._tick(), 30_000);
	}

	stop(): void {
		if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
		this.isInWindow = false;
	}

	private _parseHHMM(s: string): [number, number] {
		const parts = s.split(':');
		return [parseInt(parts[0] ?? '0', 10), parseInt(parts[1] ?? '0', 10)];
	}

	private _tick(): void {
		const now = new Date();
		const inWindow = this._isInWindow(now);
		if (inWindow === this.isInWindow) {
			// No transition — still update nextFireAt when outside the window
			if (!inWindow) {
				const nextMs = this._nextActivationMs(now);
				this.onStateChange?.({ status: 'idle', nextFireAt: nextMs });
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
			const nextMs = this._nextActivationMs(now);
			this.onStateChange?.({ status: 'idle', nextFireAt: nextMs });
		}
	}

	private _isInWindow(now: Date): boolean {
		const nowMs = now.getTime();
		// Check windows that could have started today (d=0) or yesterday (d=1, for midnight-crossing windows)
		for (let d = 0; d <= 1; d++) {
			const startCandidate = new Date(now);
			startCandidate.setDate(startCandidate.getDate() - d);
			startCandidate.setHours(this.startH, this.startM, 0, 0);
			if (startCandidate.getTime() > nowMs) continue; // start hasn't happened yet

			const endCandidate = new Date(startCandidate);
			if (this.crossesMidnight) endCandidate.setDate(endCandidate.getDate() + 1);
			endCandidate.setHours(this.endH, this.endM, 0, 0);

			if (nowMs < endCandidate.getTime()) {
				// Now is between start and end — check if the start day is allowed
				const startDay = startCandidate.getDay();
				if (this.daysOfWeek.length === 0 || this.daysOfWeek.includes(startDay)) return true;
			}
		}
		return false;
	}

	private _nextActivationMs(now: Date): number {
		for (let d = 0; d <= 7; d++) {
			const candidate = new Date(now);
			candidate.setDate(candidate.getDate() + d);
			candidate.setHours(this.startH, this.startM, 0, 0);
			if (candidate.getTime() <= now.getTime()) continue;
			if (this.daysOfWeek.length === 0 || this.daysOfWeek.includes(candidate.getDay())) {
				return candidate.getTime();
			}
		}
		return now.getTime() + 7 * 24 * 3600_000;
	}
}
