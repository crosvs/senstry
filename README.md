# Senstry

A privacy-first home security monitor that runs entirely in the browser. No cloud account, no open ports, no server to maintain. Two devices pair over [Nostr](https://nostr.com) and stream video/audio directly to each other via WebRTC.

## How it works

Every device generates a Nostr keypair on first launch. This keypair is your identity — no registration required. You pair a **monitor** (the camera device) with a **viewer** (your phone) by scanning a QR code. After that:

- The monitor records continuously and listens for audio triggers
- When a trigger fires, a lightweight event is published to a Nostr relay (metadata only — no media)
- The viewer receives those events in real time and shows them in a timeline and event log
- Tapping an event opens a timeline player that fetches the audio clip directly from the monitor over a WebRTC data channel — the clip never touches any server

WebRTC signaling (the offer/answer/ICE exchange) is done entirely over Nostr using [NIP-59 gift-wrapped](https://github.com/nostr-protocol/nips/blob/master/59.md) direct messages, so relay operators cannot see which devices are communicating with each other.

```
Monitor ──Nostr relay (metadata only)──▶ Viewer
   │                                        │
   └──────── WebRTC P2P (video + audio) ────┘
                  (direct, no relay)
```

## Features

- **Live view** — P2P WebRTC video and audio stream from the monitor to the viewer
- **Audio triggers** — configurable threshold (dBFS), cooldown, and minimum duration; multiple named trigger presets run in parallel
- **Rolling buffer** — continuous audio recording in 10-second segments; 30 seconds before and after each trigger are pinned and protected from eviction
- **Timeline scrubber** — visual coverage bar showing which time ranges have stored footage, with event markers; click or drag to seek, scroll to zoom
- **Audio playback** — scrub and play back stored footage at 0.5×–4× speed; fetched on demand from the monitor over WebRTC
- **Event log** — calendar views (list / day / week / month); nearby events are grouped into collapsible clusters
- **Encrypted signaling** — all WebRTC signaling is NIP-59 gift-wrapped; no relay operator can link monitor and viewer pubkeys
- **No cloud** — events are stored in IndexedDB on each device; media never leaves the monitor except over direct P2P connections
- **PWA** — installable on Android and desktop; works offline (event log stays available without a relay connection)
- **Storage quota** — user-configurable; oldest unpinned footage is evicted automatically when full

## Getting started

### Requirements

- Node.js 18+
- Two devices on the same network (or reachable via STUN) — or two browser tabs for testing
- A public Nostr relay (default: `wss://relay.damus.io`) or your own

### Install and run

```bash
git clone https://github.com/Crosvs/Senstry
cd Senstry
npm install
npm run dev
```

Open the app on two separate devices (or two browser tabs).

### Pairing

1. On the **monitor device**, go to **Pair Device**
2. A QR code appears encoding the monitor's Nostr pubkey, relay URL, and label
3. On the **viewer device**, go to **Pair Device → Scan** and scan the QR
4. The viewer sends a pairing acknowledgement; both devices now know each other's pubkey

### Monitor mode

1. On the monitor device, tap **Monitor Mode**
2. Grant camera and microphone permissions
3. The audio meter and active triggers are shown
4. Tap **Arm** — triggers will fire and publish events when audio exceeds the configured threshold

### Viewer mode

1. On the viewer device, tap **Viewer Mode**
2. The app connects automatically to the monitor over WebRTC
3. The live video stream appears; the timeline scrubber below shows stored footage coverage and event markers
4. Browse past events in **Event Log** and tap **View in timeline** to jump to that moment in the recording

## Configuration

All settings are under **Settings**:

| Setting       | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| Relay URL     | Nostr WebSocket relay for signaling and event delivery                     |
| Monitor label | Human-readable name shown in event notifications                           |
| Triggers      | Named audio trigger presets — threshold (dBFS), cooldown, minimum duration |
| Storage quota | Maximum IndexedDB space for recorded audio segments                        |

## Architecture

| Layer          | Technology                         | Purpose                                        |
| -------------- | ---------------------------------- | ---------------------------------------------- |
| Identity       | Nostr keypairs (secp256k1)         | Cryptographic device identity, no registration |
| Signaling      | Nostr relays + NIP-59 gift wrap    | WebRTC offer/answer/ICE, metadata-private      |
| Streaming      | WebRTC (`RTCPeerConnection`)       | P2P live video/audio                           |
| Clip retrieval | WebRTC data channel                | On-demand audio segment transfer from monitor  |
| Detection      | Web Audio API (`AnalyserNode`)     | RMS threshold detection                        |
| Recording      | `MediaRecorder` (10-second chunks) | Continuous rolling audio buffer                |
| Storage        | IndexedDB (`idb`)                  | Events, segments, settings, keypairs           |
| UI             | SvelteKit 2 + Tailwind CSS v4      | PWA, static build                              |

### Nostr event kinds

| Kind | Description                   |
| ---- | ----------------------------- |
| 5000 | Pairing acknowledgement       |
| 5001 | WebRTC offer / offer-request  |
| 5002 | WebRTC answer                 |
| 5003 | WebRTC ICE candidate          |
| 5010 | Trigger event (metadata only) |
| 5011 | Arm/disarm state change       |

All signaling events (5001–5003) are NIP-59 gift-wrapped. Trigger events (5010) are NIP-44 encrypted to the viewer's pubkey.

### Data channel protocol

Clip retrieval and coverage queries happen over a WebRTC data channel (JSON messages):

```
Viewer → Monitor:  { type: "coverage-request" }
Monitor → Viewer:  { type: "coverage-map", segments: [[start, end], ...] }

Viewer → Monitor:  { type: "segment-request", time: <unix_seconds> }
Monitor → Viewer:  { type: "segment-meta", requestTime, startTime, endTime, mimeType, sizeBytes }
                   { type: "segment-chunk", requestTime, startTime, index, total, data: "<base64>" }
                OR { type: "segment-error", requestTime, reason: "not-stored" }
```

Media never touches a relay. All recordings stay on the monitor device under the configured storage quota with LRU eviction for unpinned segments.

## Building for production

```bash
npm run build
```

The output in `build/` is a fully static site. Deploy it anywhere — GitHub Pages, Netlify, a local file server, or directly on-device via a PWA wrapper.

## Privacy model

- **Keys** — private keys are stored in IndexedDB, never in `localStorage` or cookies
- **Signaling** — gift-wrapped with one-time pubkeys (NIP-59); relay operators see random pubkeys, not your real identity
- **Events** — encrypted with NIP-44 (ChaCha20-Poly1305); relay operators cannot read event content
- **Media** — never leaves the monitor device except through direct P2P connections to paired viewers
- No analytics, no telemetry, no accounts

## Roadmap

- [ ] Motion detection (video-based)
- [ ] Gyroscope trigger (device tamper/drop detection)
- [ ] ML-based video recognition
- [ ] Multi-relay support (NIP-01 relay hints)
- [ ] Private relay auth (NIP-42)
- [ ] Clip export off-device
- [ ] Multiple paired viewers
