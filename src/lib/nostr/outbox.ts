import { publish } from './client';
import {
	KIND_INVITE_ACK, KIND_SIGNAL, KIND_TRIGGER, KIND_ARM_STATE,
	KIND_BACKUP_REQUEST, KIND_BACKUP_ACK, KIND_RESYNC_REQUEST,
	KIND_FOOTAGE_REF, KIND_FOOTAGE_DELETE
} from './events';
import { getQueued, markPublished, markFailed, incrementAttempt } from '$lib/db/outbox';
import { dbg } from '$lib/store/debug';

const MAX_ATTEMPTS = 5;
const FLUSH_INTERVAL_MS = 30_000;
const INTER_EVENT_DELAY_MS = 200;

// Maximum items published per flush cycle. Remaining items are picked up on
// the next cycle (30 s later), preventing a sudden burst when the outbox is large.
const MAX_PER_FLUSH = 20;

// Per-kind time-to-live. Events older than their TTL are silently expired
// instead of published — stale notifications are worse than no notification.
// Footage alerts (5020) expire after 48h: if the device was offline that long
// the viewer should use WebRTC coverage-request to discover footage instead.
const KIND_TTL_MS: Partial<Record<number, number>> = {
	1059:               60_000,  // gift-wrapped signal  — WebRTC sessions are ephemeral
	[KIND_INVITE_ACK]:  5 * 60_000,
	[KIND_SIGNAL]:      60_000,
	[KIND_TRIGGER]:    10 * 60_000,
	[KIND_ARM_STATE]:   5 * 60_000,
	[KIND_BACKUP_REQUEST]: 5 * 60_000,
	[KIND_BACKUP_ACK]:     5 * 60_000,
	[KIND_RESYNC_REQUEST]: 5 * 60_000,
	[KIND_FOOTAGE_REF]:  48 * 60 * 60_000,
	[KIND_FOOTAGE_DELETE]: 48 * 60 * 60_000,
};

export class OutboxFlusher {
	private timer: ReturnType<typeof setInterval> | null = null;
	private paused = false;

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	pause(): void { this.paused = true; }
	resume(): void { this.paused = false; }

	async flush(): Promise<void> {
		if (this.paused) return;

		// Sort oldest-first so early events aren't starved when the queue is large,
		// then cap the batch to avoid relay bursts after long offline periods.
		const all = await getQueued();
		const batch = all
			.sort((a, b) => a.createdAt - b.createdAt)
			.slice(0, MAX_PER_FLUSH);

		if (all.length > batch.length) {
			dbg('info', 'nostr', `outbox: ${all.length} queued, processing ${batch.length} this cycle`);
		}

		for (let i = 0; i < batch.length; i++) {
			const item = batch[i];
			const ageMs = Date.now() - item.createdAt;

			// Expire stale events — sending a 2-hour-old trigger notification is noise.
			const ttl = KIND_TTL_MS[item.kind];
			if (ttl !== undefined && ageMs > ttl) {
				await markFailed(item.outboxId);
				dbg('info', 'nostr', `outbox expired kind:${item.kind} age:${Math.round(ageMs / 1000)}s`);
				continue;
			}

			if (item.attempts >= MAX_ATTEMPTS) {
				await markFailed(item.outboxId);
				continue;
			}

			try {
				await incrementAttempt(item.outboxId);
				await publish(item.event);
				await markPublished(item.outboxId);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				dbg('warn', 'nostr', `outbox flush failed (attempt ${item.attempts + 1}) kind:${item.kind}`, e);
				// Relay permanently rejected — no point retrying.
				if (msg.startsWith('publish failed:')) {
					await markFailed(item.outboxId);
				}
			}

			// Pace events to avoid appearing as a burst to the relay.
			if (i < batch.length - 1) {
				await new Promise(r => setTimeout(r, INTER_EVENT_DELAY_MS));
			}
		}
	}
}

export const outboxFlusher = new OutboxFlusher();
