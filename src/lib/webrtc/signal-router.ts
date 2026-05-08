import { listenForSignals, sendSignal, type SignalHandler, type SignalMessage } from './signaling';
import { dbg } from '$lib/store/debug';

// Single kind-1059 subscription that routes incoming signals to the correct handler.
// - 'offer-request' → monitorHandler (this device acts as monitor)
// - 'offer' / 'answer' / 'hangup' → viewerHandler (this device acts as viewer)
// - 'ping' → auto-reply with 'pong' (no handler needed)
// - 'pong' → viewerHandler (caller listens for its own ping replies)

export function startSignalRouter(
	privkey: Uint8Array,
	pubkey: string,
	monitorHandler: SignalHandler,
	viewerHandler: SignalHandler
): { close: () => void } {
	return listenForSignals(privkey, pubkey, (msg: SignalMessage, fromPubkey: string) => {
		if (msg.type === 'ping') {
			sendSignal(privkey, pubkey, fromPubkey, { type: 'pong', sessionId: msg.sessionId }).catch(
				() => {}
			);
		} else if (msg.type === 'offer-request' || msg.type === 'answer') {
			// Monitor-bound: offer-request initiates a session; answer completes the handshake.
			Promise.resolve(monitorHandler(msg, fromPubkey)).catch((e) =>
				dbg('warn', 'rtc', `monitorHandler error: ${e instanceof Error ? e.message : e}`)
			);
		} else if (msg.type === 'hangup') {
			// Hangup can come from either direction — dispatch to both; each checks its own session map.
			Promise.resolve(monitorHandler(msg, fromPubkey)).catch((e) =>
				dbg('warn', 'rtc', `monitorHandler hangup error: ${e instanceof Error ? e.message : e}`)
			);
			Promise.resolve(viewerHandler(msg, fromPubkey)).catch((e) =>
				dbg('warn', 'rtc', `viewerHandler hangup error: ${e instanceof Error ? e.message : e}`)
			);
		} else {
			// offer, pong — viewer-bound.
			Promise.resolve(viewerHandler(msg, fromPubkey)).catch((e) =>
				dbg('warn', 'rtc', `viewerHandler error: ${e instanceof Error ? e.message : e}`)
			);
		}
	});
}
