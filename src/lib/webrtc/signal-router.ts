import { listenForSignals, sendSignal, type SignalHandler, type SignalMessage } from './signaling';
import { updatePeerStatus } from '$lib/store/peer-status';
import { dbg } from '$lib/store/debug';

// Single kind-1059 subscription that routes incoming signals to the correct handler.
// - 'offer-request' → monitorHandler (this device acts as monitor)
// - 'offer' / 'answer' / 'hangup' → viewerHandler (this device acts as viewer)
// - 'ping' → auto-reply with 'pong' (no handler needed)
// - 'pong' → viewerHandler (caller listens for its own ping replies)
// - 'status' → updatePeerStatus; auto-reply to fresh online events (presence protocol)
// - 'status-request' → auto-reply with current online status

// When a peer's fresh "online" ANNOUNCEMENT arrives (isAnnounce: true), we reply once
// with our own awareness status so they know we're listening too. We only auto-reply
// to announcements, not to awareness replies, to avoid a feedback loop where both
// devices endlessly notify each other.
const AUTO_REPLY_FRESH_S = 15;  // only auto-reply to announcements newer than this
const AWARENESS_COOLDOWN_MS = 60_000; // don't reply to the same peer more than once per minute
// After going online, skip awareness replies for this long so WebRTC signaling
// gets priority over the relay rate-limit budget. The viewer already announced
// itself to the monitor via startSignalRouter(), so the monitor knows it's online.
const AWARENESS_STARTUP_GRACE_MS = 20_000;

// Per-pubkey timestamp of last awareness reply sent.
// Prevents bursts when a peer re-announces due to relay restart or relay replay.
const _lastAwarenessReply = new Map<string, number>();
let _lastOnlineAt = 0;

export function _resetForTest(): void {
	_lastAwarenessReply.clear();
	_lastOnlineAt = 0;
}

export function startSignalRouter(
	privkey: Uint8Array,
	pubkey: string,
	monitorHandler: SignalHandler,
	viewerHandler: SignalHandler
): { close: () => void } {
	_lastOnlineAt = Date.now();
	return listenForSignals(privkey, pubkey, (msg: SignalMessage, fromPubkey: string, createdAt: number) => {
		if (msg.type === 'status') {
			if (msg.state) {
				updatePeerStatus(fromPubkey, msg.state, createdAt);
				// Auto-reply only to fresh initial announcements (isAnnounce: true).
				// Awareness replies (isAnnounce absent) do not trigger another reply.
				if (msg.state === 'online' && msg.isAnnounce) {
					const age = Math.floor(Date.now() / 1000) - createdAt;
					const lastReplied = _lastAwarenessReply.get(fromPubkey) ?? 0;
					const inStartupGrace = Date.now() - _lastOnlineAt < AWARENESS_STARTUP_GRACE_MS;
					if (!inStartupGrace && age <= AUTO_REPLY_FRESH_S && Date.now() - lastReplied >= AWARENESS_COOLDOWN_MS) {
						_lastAwarenessReply.set(fromPubkey, Date.now());
						sendSignal(privkey, pubkey, fromPubkey, {
							type: 'status', state: 'online', sessionId: msg.sessionId,
						}).catch(() => {});
					}
				}
			}
		} else if (msg.type === 'status-request') {
			sendSignal(privkey, pubkey, fromPubkey, {
				type: 'status', state: 'online', sessionId: msg.sessionId,
			}).catch(() => {});
		} else if (msg.type === 'ping') {
			sendSignal(privkey, pubkey, fromPubkey, { type: 'pong', sessionId: msg.sessionId }).catch(
				() => {}
			);
		} else if (msg.type === 'offer-request' || msg.type === 'answer') {
			// Monitor-bound: offer-request initiates a session; answer completes the handshake.
			Promise.resolve(monitorHandler(msg, fromPubkey, createdAt)).catch((e) =>
				dbg('warn', 'rtc', `monitorHandler ${msg.type} error sess:${msg.sessionId?.slice(0, 8)} from:${fromPubkey.slice(0, 8)}: ${e instanceof Error ? e.message : e}`)
			);
		} else if (msg.type === 'hangup') {
			// Hangup can come from either direction — dispatch to both; each checks its own session map.
			Promise.resolve(monitorHandler(msg, fromPubkey, createdAt)).catch((e) =>
				dbg('warn', 'rtc', `monitorHandler hangup error sess:${msg.sessionId?.slice(0, 8)} from:${fromPubkey.slice(0, 8)}: ${e instanceof Error ? e.message : e}`)
			);
			Promise.resolve(viewerHandler(msg, fromPubkey, createdAt)).catch((e) =>
				dbg('warn', 'rtc', `viewerHandler hangup error sess:${msg.sessionId?.slice(0, 8)} from:${fromPubkey.slice(0, 8)}: ${e instanceof Error ? e.message : e}`)
			);
		} else {
			// offer, pong — viewer-bound.
			Promise.resolve(viewerHandler(msg, fromPubkey, createdAt)).catch((e) =>
				dbg('warn', 'rtc', `viewerHandler ${msg.type} error sess:${msg.sessionId?.slice(0, 8)} from:${fromPubkey.slice(0, 8)}: ${e instanceof Error ? e.message : e}`)
			);
		}
	});
}
