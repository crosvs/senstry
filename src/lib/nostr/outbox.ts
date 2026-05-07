import { publish } from './client';
import { getQueued, markPublished, markFailed, incrementAttempt } from '$lib/db/outbox';
import { dbg } from '$lib/store/debug';

const MAX_ATTEMPTS = 5;
const FLUSH_INTERVAL_MS = 30_000;

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

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	async flush(): Promise<void> {
		if (this.paused) return;
		const queued = await getQueued();
		for (const item of queued) {
			if (item.attempts >= MAX_ATTEMPTS) {
				await markFailed(item.outboxId);
				continue;
			}
			try {
				await incrementAttempt(item.outboxId);
				await publish(item.event);
				await markPublished(item.outboxId);
			} catch (e) {
				dbg('warn', 'nostr', `outbox flush failed (attempt ${item.attempts + 1}) kind:${item.kind}`, e);
			}
		}
	}
}

export const outboxFlusher = new OutboxFlusher();
