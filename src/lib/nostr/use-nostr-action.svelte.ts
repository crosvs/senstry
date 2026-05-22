/**
 * useNostrAction — reactive binding between a Nostr publish and UI state.
 *
 * Usage in a Svelte 5 component:
 *
 *   import { useNostrAction } from '$lib/nostr/use-nostr-action.svelte';
 *
 *   const action = useNostrAction();
 *
 *   async function handleClick() {
 *     await action.run(onQueued =>
 *       sendSignal(privkey, pubkey, target, { type: 'status-request', sessionId }, { onQueued })
 *     );
 *   }
 *
 * Then in the template:
 *
 *   <button onclick={handleClick} disabled={action.pending}>
 *     {action.pending ? `⏳ ${action.etaLabel}` : 'Status?'}
 *   </button>
 *   {#if action.pending}
 *     <button onclick={action.cancel} title="Cancel">✕</button>
 *   {/if}
 */

import { publishQueue, type PendingPublish } from './client';

export interface NostrAction {
	/** True while the publish is queued or in-flight. */
	readonly pending: boolean;
	/** Human-readable ETA string while pending, e.g. "2s". Empty when idle. */
	readonly etaLabel: string;
	/** Cancel the queued publish. No-op when not pending. */
	cancel: () => void;
	/**
	 * Run an async function that calls publish (or a helper like sendSignal).
	 * Pass the `onQueued` callback into whichever helper accepts it so the
	 * action can track its queue position.
	 *
	 * Example:
	 *   await action.run(onQueued =>
	 *     sendSignal(pk, pub, tgt, msg, { onQueued })
	 *   );
	 */
	run: (fn: (onQueued: (id: string, cancel: () => void) => void) => Promise<void>) => Promise<void>;
}

/**
 * Create a reactive nostr action handle. Must be called at component
 * initialisation (not inside an event handler) so Svelte 5 runes work.
 */
export function useNostrAction(): NostrAction {
	let _pendingId = $state<string | null>(null);
	let _cancelFn: (() => void) | null = null;
	let _queueItem = $state<PendingPublish | null>(null);

	// Subscribe to publishQueue and update _queueItem whenever the tracked id changes.
	const _unsubscribe = publishQueue.subscribe(queue => {
		if (_pendingId !== null) {
			_queueItem = queue.find(q => q.id === _pendingId) ?? null;
		}
	});

	// In Svelte 5, $effect cleanup is automatic; but since this is a .svelte.ts file,
	// we expose a cleanup method the component should call in onDestroy if needed.
	// For most usage the subscription is lightweight and harmless to leave open.

	const etaLabel = $derived((() => {
		if (!_queueItem) return '';
		const ms = _queueItem.estimatedAt - Date.now();
		if (ms <= 0) return 'sending…';
		if (ms < 1000) return '<1s';
		return `${Math.ceil(ms / 1000)}s`;
	})());

	const pending = $derived(_pendingId !== null);

	function cancel() {
		_cancelFn?.();
	}

	async function run(
		fn: (onQueued: (id: string, cancelFn: () => void) => void) => Promise<void>
	): Promise<void> {
		_pendingId = null;
		_cancelFn = null;
		_queueItem = null;

		try {
			await fn((id, cancelFn) => {
				_pendingId = id;
				_cancelFn = cancelFn;
			});
		} finally {
			_pendingId = null;
			_cancelFn = null;
			_queueItem = null;
		}
	}

	return {
		get pending() { return pending; },
		get etaLabel() { return etaLabel; },
		cancel,
		run,
		/** Call in component onDestroy to clean up the store subscription. */
		destroy: _unsubscribe,
	} as NostrAction & { destroy: () => void };
}
