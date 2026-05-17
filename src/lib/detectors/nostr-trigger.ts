import type { SensorState } from '$lib/store/pipeline';
import type { DetectionEvent } from './types';

export interface NostrTriggerData {
	monitorPubkey: string;
	channelId: string | null;
	detectionType: string;
	durationMs: number;
}

/**
 * State machine driven by incoming Nostr trigger events from a remote monitor.
 * SentrySection owns the Nostr subscription and calls handleRemoteState() when a
 * matching event arrives. This class manages only its own timers and state transitions.
 *
 * Timing synchronization:
 * - On remote 'sensing': uses sender's minDurationMs as the hold timer, so the receiver
 *   stays in sync with the sender's confirmation threshold.
 * - On remote 'idle': uses max(localSettlingMs, sender's settlingMs) to ensure the
 *   receiver stays settled at least as long as the sender, preventing premature idle
 *   before the sender's settling window closes.
 */
export class NostrTriggerDetector {
	onStateChange: ((state: SensorState) => void) | null = null;
	onDetection: ((event: DetectionEvent<NostrTriggerData>) => void) | null = null;
	onFiringChange: ((firing: boolean) => void) | null = null;

	private readonly _localSettlingMs: number;

	private _status: 'idle' | 'sensing' | 'active' | 'settling' = 'idle';
	private _activeStartedAt = 0;
	private _lastMeta: { monitorPubkey: string; channelId: string | null; detectionType: string } = {
		monitorPubkey: '', channelId: null, detectionType: 'nostr-trigger',
	};

	private _holdTimer: ReturnType<typeof setTimeout> | null = null;
	private _settleTimer: ReturnType<typeof setTimeout> | null = null;
	private _remoteSettlingMs = 0;

	constructor(config: { minDurationMs?: number; settlingMs: number }) {
		this._localSettlingMs = config.settlingMs;
	}

	handleRemoteState(
		remoteState: 'sensing' | 'active' | 'idle',
		meta: { monitorPubkey: string; channelId: string | null; detectionType: string },
		timing: { minDurationMs: number; settlingMs: number }
	): void {
		this._lastMeta = meta;

		if (remoteState === 'sensing') {
			this._cancelTimers();
			if (this._status === 'idle' || this._status === 'settling') {
				this._setStatus({ status: 'sensing', startedAt: Date.now(), minDurationMs: timing.minDurationMs });
				this.onFiringChange?.(true);
				// Start hold timer using sender's minDurationMs.
				// If it elapses without an 'active' event, escalate ourselves.
				if (timing.minDurationMs > 0) {
					this._holdTimer = setTimeout(() => {
						if (this._status === 'sensing') this._enterActive(meta);
					}, timing.minDurationMs);
				} else {
					// No hold required — go active immediately
					this._enterActive(meta);
				}
			}
			// If already sensing/active, ignore (sender is continuing the same event)
		} else if (remoteState === 'active') {
			this._cancelTimers();
			if (this._status !== 'active') {
				this._enterActive(meta);
			}
		} else if (remoteState === 'idle') {
			this._remoteSettlingMs = timing.settlingMs;
			if (this._status === 'active' || this._status === 'sensing') {
				this._cancelTimers();
				this._enterSettling();
			}
			// If already settling/idle, ignore
		}
	}

	stop(): void {
		this._cancelTimers();
		if (this._status !== 'idle') {
			this._status = 'idle';
			this.onFiringChange?.(false);
			this.onStateChange?.({ status: 'idle' });
		}
	}

	private _enterActive(meta: { monitorPubkey: string; channelId: string | null; detectionType: string }): void {
		const wasAlreadyActive = this._status === 'active';
		this._status = 'active';
		this._activeStartedAt = Date.now();
		this._setStatus({ status: 'active', startedAt: this._activeStartedAt });
		if (!wasAlreadyActive) {
			this.onFiringChange?.(true);
			this.onDetection?.({
				type: meta.detectionType || 'nostr-trigger',
				data: { monitorPubkey: meta.monitorPubkey, channelId: meta.channelId, detectionType: meta.detectionType, durationMs: 0 },
				timestamp: Math.floor(Date.now() / 1000),
			});
		}
	}

	private _enterSettling(): void {
		const effectiveSettlingMs = Math.max(this._localSettlingMs, this._remoteSettlingMs);
		const endsAt = Date.now() + effectiveSettlingMs;
		this._status = 'settling';
		this._setStatus({ status: 'settling', endsAt });
		this._settleTimer = setTimeout(() => {
			this._settleTimer = null;
			const durationMs = this._activeStartedAt ? Date.now() - this._activeStartedAt : 0;
			this._status = 'idle';
			this.onFiringChange?.(false);
			this._setStatus({ status: 'idle' });
			const m = this._lastMeta;
			this.onDetection?.({
				type: m.detectionType || 'nostr-trigger',
				data: { monitorPubkey: m.monitorPubkey, channelId: m.channelId, detectionType: m.detectionType, durationMs },
				timestamp: Math.floor(Date.now() / 1000),
			});
		}, effectiveSettlingMs);
	}

	private _setStatus(state: SensorState): void {
		this.onStateChange?.(state);
	}

	private _cancelTimers(): void {
		if (this._holdTimer !== null) { clearTimeout(this._holdTimer); this._holdTimer = null; }
		if (this._settleTimer !== null) { clearTimeout(this._settleTimer); this._settleTimer = null; }
	}
}
