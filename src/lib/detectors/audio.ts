import type { Detector, DetectionEvent, AudioDetectionData } from './types';
import type { SensorConfig, SensorState } from '$lib/store/pipeline';

export class AudioDetector implements Detector<AudioDetectionData> {
	onDetection: ((event: DetectionEvent<AudioDetectionData>) => void) | null = null;
	onFiringChange: ((firing: boolean) => void) | null = null;
	onStateChange: ((state: SensorState) => void) | null = null;

	private ctx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private rafId: number | null = null;
	private buf: Float32Array<ArrayBuffer> | null = null;

	private thresholdDb: number;
	private releaseThresholdDb: number;
	private settlingMs: number;
	private minDurationMs: number;

	// Rolling RMS history for computing average dB over minDurationMs window
	private rmsHistory: { rms: number; time: number }[] = [];

	// Event tracking
	private eventStart = 0;
	private lastAbove = 0;
	private peakDb = -Infinity;

	// State
	private currentStatus: 'idle' | 'sensing' | 'active' | 'settling' = 'idle';
	private wasActive = false;
	private minDurationTimer: ReturnType<typeof setTimeout> | null = null;
	private settlingTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config?: Pick<SensorConfig, 'thresholdDb' | 'releaseThresholdDb' | 'settlingMs' | 'minDurationMs'>) {
		this.thresholdDb = config?.thresholdDb ?? -40;
		// Default release threshold = activation threshold (no hysteresis zone)
		this.releaseThresholdDb = config?.releaseThresholdDb ?? this.thresholdDb;
		this.settlingMs = config?.settlingMs ?? 2000;
		this.minDurationMs = config?.minDurationMs ?? 500;
	}

	start(stream?: MediaStream): void {
		if (!stream) return;
		this.ctx = new AudioContext();
		this.analyser = this.ctx.createAnalyser();
		this.analyser.fftSize = 2048;
		this.buf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
		this.ctx.createMediaStreamSource(stream).connect(this.analyser);
		this.loop();
	}

	stop(): void {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		if (this.minDurationTimer !== null) clearTimeout(this.minDurationTimer);
		if (this.settlingTimer !== null) clearTimeout(this.settlingTimer);
		this.ctx?.close();
		this.ctx = null;
		this.analyser = null;
		this.buf = null;
		this.rmsHistory = [];
		this.currentStatus = 'idle';
		this.wasActive = false;
		this.eventStart = 0;
		this.peakDb = -Infinity;
	}

	private _avgDb(): number {
		const n = this.rmsHistory.length;
		if (n === 0) return -Infinity;
		const avgPower = this.rmsHistory.reduce((s, h) => s + h.rms * h.rms, 0) / n;
		return avgPower > 0 ? 10 * Math.log10(avgPower) : -Infinity;
	}

	private loop(): void {
		if (!this.analyser || !this.buf) return;
		this.rafId = requestAnimationFrame(() => this.loop());

		this.analyser.getFloatTimeDomainData(this.buf);
		const rms = Math.sqrt(this.buf.reduce((s, v) => s + v * v, 0) / this.buf.length);
		const instantDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
		const now = Date.now();

		// Update rolling history, keep only the last minDurationMs worth of samples
		this.rmsHistory.push({ rms, time: now });
		const cutoff = now - this.minDurationMs;
		while (this.rmsHistory.length > 1 && this.rmsHistory[0].time < cutoff) {
			this.rmsHistory.shift();
		}

		const avgDb = this._avgDb();
		// peakDb tracks instant peaks for reporting
		this.peakDb = Math.max(this.peakDb, instantDb);

		// aboveThreshold: rolling average crosses activation threshold
		// belowRelease: rolling average drops below release threshold (hysteresis lower bound)
		const aboveThreshold = avgDb >= this.thresholdDb;
		const belowRelease = avgDb < this.releaseThresholdDb;

		if (aboveThreshold) {
			this.lastAbove = now;
			if (this.currentStatus === 'idle') {
				this.eventStart = now;
				this.peakDb = instantDb;
				this.wasActive = false;
				this._toSensing();
			} else if (this.currentStatus === 'settling') {
				if (this.settlingTimer !== null) {
					clearTimeout(this.settlingTimer);
					this.settlingTimer = null;
				}
				if (this.wasActive) {
					this._toActive();
				} else {
					this._toSensing();
				}
			}
			// sensing or active: peakDb / lastAbove already updated above
		} else if (belowRelease) {
			if ((this.currentStatus === 'sensing' || this.currentStatus === 'active') && this.settlingTimer === null) {
				this._toSettling();
			}
		}
		// else: avgDb is in hysteresis zone [releaseThresholdDb, thresholdDb) — maintain current state
	}

	private _toSensing(): void {
		this.currentStatus = 'sensing';
		this.onFiringChange?.(true);
		this.onStateChange?.({ status: 'sensing', startedAt: this.eventStart, minDurationMs: this.minDurationMs });
		if (this.minDurationTimer !== null) clearTimeout(this.minDurationTimer);
		this.minDurationTimer = setTimeout(() => {
			this.minDurationTimer = null;
			if (this.currentStatus !== 'sensing') return;
			// Re-verify rolling average still meets threshold before transitioning to active
			if (this._avgDb() >= this.thresholdDb) {
				this._toActive();
			} else {
				this._toIdle();
			}
		}, this.minDurationMs);
	}

	private _toActive(): void {
		if (this.minDurationTimer !== null) {
			clearTimeout(this.minDurationTimer);
			this.minDurationTimer = null;
		}
		this.currentStatus = 'active';
		this.wasActive = true;
		this.onStateChange?.({ status: 'active', startedAt: this.eventStart });
	}

	private _toSettling(): void {
		if (this.minDurationTimer !== null) {
			clearTimeout(this.minDurationTimer);
			this.minDurationTimer = null;
		}
		const endsAt = Date.now() + this.settlingMs;
		this.currentStatus = 'settling';
		this.onStateChange?.({ status: 'settling', endsAt });
		this.settlingTimer = setTimeout(() => {
			this.settlingTimer = null;
			const durationMs = this.lastAbove - this.eventStart;
			if (this.wasActive) {
				this.onDetection?.({
					type: 'audio',
					data: { peakDb: Math.round(this.peakDb * 10) / 10, durationMs },
					timestamp: Math.floor(this.eventStart / 1000),
				});
			}
			this._toIdle();
		}, this.settlingMs);
	}

	private _toIdle(): void {
		this.currentStatus = 'idle';
		this.onFiringChange?.(false);
		this.onStateChange?.({ status: 'idle' });
		this.eventStart = 0;
		this.peakDb = -Infinity;
		this.wasActive = false;
	}
}
