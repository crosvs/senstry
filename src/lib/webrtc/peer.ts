export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export type IceCandidateHandler = (candidate: RTCIceCandidate) => void;
export type TrackHandler = (stream: MediaStream) => void;
export type StateChangeHandler = (state: RTCIceConnectionState) => void;
export type DataChannelHandler = (channel: RTCDataChannel) => void;

export function createPeer(options?: RTCConfiguration): RTCPeerConnection {
	return new RTCPeerConnection({
		iceServers: ICE_SERVERS,
		...options
	});
}

export function onTrack(pc: RTCPeerConnection, handler: TrackHandler): void {
	const streams = new Map<string, MediaStream>();
	pc.ontrack = (e) => {
		for (const stream of e.streams) {
			streams.set(stream.id, stream);
			handler(stream);
		}
	};
}

export function onIceCandidate(pc: RTCPeerConnection, handler: IceCandidateHandler): void {
	pc.onicecandidate = (e) => {
		if (e.candidate) handler(e.candidate);
	};
}

export function onIceStateChange(pc: RTCPeerConnection, handler: StateChangeHandler): void {
	pc.oniceconnectionstatechange = () => handler(pc.iceConnectionState);
}

// Wait for ICE gathering to complete so all candidates are embedded in the SDP.
// Using non-trickle ICE reduces Nostr relay events from ~15 to 3 per handshake.
// Falls back after timeoutMs so a missing STUN response doesn't block forever.
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
	return new Promise<void>((resolve) => {
		if (pc.iceGatheringState === 'complete') { resolve(); return; }
		let timer: ReturnType<typeof setTimeout> | null = null;
		const done = () => {
			if (timer !== null) { clearTimeout(timer); timer = null; }
			pc.removeEventListener('icegatheringstatechange', handler);
			resolve();
		};
		const handler = () => { if (pc.iceGatheringState === 'complete') done(); };
		timer = setTimeout(done, timeoutMs);
		pc.addEventListener('icegatheringstatechange', handler);
	});
}

export function onDataChannel(pc: RTCPeerConnection, handler: DataChannelHandler): void {
	pc.ondatachannel = (e) => handler(e.channel);
}
