import type { Detector, DetectionEvent, AudioDetectionData } from './types';
import type { TriggerConfig } from '$lib/store/triggers';

export class AudioDetector implements Detector<AudioDetectionData> {
	onDetection: ((event: DetectionEvent<AudioDetectionData>) => void) | null = null;

	private ctx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private rafId: number | null = null;
	private buf: Float32Array<ArrayBuffer> | null = null;

	private thresholdDb: number;
	private cooldownMs: number;
	private minDurationMs: number;

	// Event lifecycle
	private eventStart = 0;
	private lastAbove = 0;
	private peakDb = -Infinity;
	private isOpen = false;
	private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config?: Pick<TriggerConfig, 'thresholdDb' | 'cooldownMs' | 'minDurationMs'>) {
		this.thresholdDb = config?.thresholdDb ?? -40;
		this.cooldownMs = config?.cooldownMs ?? 2000;
		this.minDurationMs = config?.minDurationMs ?? 500;
	}

	start(stream: MediaStream): void {
		this.ctx = new AudioContext();
		this.analyser = this.ctx.createAnalyser();
		this.analyser.fftSize = 2048;
		this.buf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
		this.ctx.createMediaStreamSource(stream).connect(this.analyser);
		this.loop();
	}

	stop(): void {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		if (this.cooldownTimer !== null) clearTimeout(this.cooldownTimer);
		this.ctx?.close();
		this.ctx = null;
		this.analyser = null;
		this.buf = null;
		this.isOpen = false;
		this.eventStart = 0;
	}

	private loop(): void {
		if (!this.analyser || !this.buf) return;
		this.rafId = requestAnimationFrame(() => this.loop());

		this.analyser.getFloatTimeDomainData(this.buf);
		const rms = Math.sqrt(this.buf.reduce((s, v) => s + v * v, 0) / this.buf.length);
		const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
		const now = Date.now();

		if (db >= this.thresholdDb) {
			if (!this.isOpen) {
				this.isOpen = true;
				this.eventStart = now;
				this.peakDb = db;
			} else {
				this.peakDb = Math.max(this.peakDb, db);
			}
			this.lastAbove = now;

			if (this.cooldownTimer !== null) {
				clearTimeout(this.cooldownTimer);
				this.cooldownTimer = null;
			}
		} else if (this.isOpen && this.cooldownTimer === null) {
			// Audio fell below threshold — start cooldown before closing event
			this.cooldownTimer = setTimeout(() => {
				this.cooldownTimer = null;
				const durationMs = this.lastAbove - this.eventStart;
				if (durationMs >= this.minDurationMs) {
					this.onDetection?.({
						type: 'audio',
						data: { peakDb: Math.round(this.peakDb * 10) / 10, durationMs },
						timestamp: Math.floor(this.eventStart / 1000)
					});
				}
				this.isOpen = false;
				this.eventStart = 0;
				this.peakDb = -Infinity;
			}, this.cooldownMs);
		}
	}
}
