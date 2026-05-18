# Senstry

A privacy-first home security monitor that runs entirely in the browser. No cloud account, no open ports, no server to maintain. Two devices pair over [Nostr](https://nostr.com) and communicate directly via WebRTC.

## How it works

Every device generates a Nostr keypair on first launch. This keypair is your identity — no registration required. You pair a **monitor** (the camera device) with a **viewer** (your phone) by scanning a QR code. After that:

- The monitor records video, audio, and photos continuously based on a configurable pipeline of sensors, links, and actions
- When a sensor fires, a lightweight trigger event is published to a Nostr relay (metadata only — no media)
- The viewer receives those events in real time and shows them in a timeline and event log
- Tapping an event opens a timeline player that fetches the recording directly from the monitor over a WebRTC data channel — media never touches any server

WebRTC signaling is done entirely over Nostr using [NIP-59 gift-wrapped](https://github.com/nostr-protocol/nips/blob/master/59.md) direct messages, so relay operators cannot see which devices are communicating with each other.

```
Monitor ──Nostr relay (metadata + encrypted events)──▶ Viewer
   │                                                      │
   └────────────── WebRTC P2P (video + audio) ────────────┘
                        (direct, no relay)
```

## Features

- **Live view** — P2P WebRTC video and audio stream from the monitor to the viewer, channel-based with source compositing
- **Video recording** — continuous rolling buffer in 10-second segments; configurable bitrate and resolution
- **Audio recording** — simultaneous audio-only capture alongside video
- **Photo snapshots** — burst or interval-based photo capture on trigger
- **Pipeline** — flexible sensor → link → action system: wire multiple sensors (audio levels, schedules, time windows, date ranges, Nostr triggers) to actions (record, clip, snapshot, notify) via stateless links
- **Audio detection** — configurable threshold (dBFS), hysteresis, minimum duration, and settling time; multiple named sensor presets run in parallel
- **Channels** — named groups of sources for live RTC and footage tagging; support multiple simultaneous camera/mic setups
- **Rolling buffer** — unpinned segments are evicted when the buffer is full; triggered clips are pinned with a configurable lifetime
- **Timeline scrubber** — visual coverage bar showing which time ranges have stored footage, with event markers; click or drag to seek, scroll to zoom
- **Footage playback** — scrub and play back stored video and audio at 0.5×–4× speed; fetched on demand from the monitor over WebRTC
- **Event log** — calendar views (list / day / week / month); nearby events are grouped into collapsible clusters
- **Browser notifications** — alert listener fires OS notifications when the viewer tab is backgrounded
- **Encrypted signaling** — all WebRTC signaling is NIP-59 gift-wrapped; no relay operator can link monitor and viewer pubkeys
- **No cloud** — events are stored in IndexedDB on each device; media is stored in OPFS on the monitor and never leaves except over direct P2P connections
- **PWA** — installable on Android and desktop; works offline (event log stays available without a relay connection)
- **Storage quota + thinning** — user-configurable quota; oldest unpinned footage is evicted automatically; progressive thinning rules reduce resolution of older footage to reclaim space over time

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
3. Configure sources, sensors, channels, and actions under **Settings → Pipeline**
4. Tap **Arm** — the pipeline activates; sensors fire and publish events when conditions are met

### Viewer mode

1. On the viewer device, tap **Viewer Mode**
2. Select a paired monitor; the live video stream appears
3. The timeline scrubber below shows stored footage coverage and event markers
4. Browse past events in **Event Log** and tap **View in timeline** to jump to that moment

## Configuration

All settings are under **Settings**:

| Setting | Description |
|---------|-------------|
| Relay URL | Nostr WebSocket relay for signaling and event delivery |
| Monitor label | Human-readable name shown in notifications |
| Sources | Camera, microphone, and screen capture inputs |
| Sensors | Audio threshold detectors, schedules, time windows, date ranges, Nostr triggers |
| Channels | Named source groups for live RTC and footage tagging |
| Captures | Encoding presets — video resolution/bitrate, audio bitrate, photo quality |
| Actions | Record, clip, snapshot, and notify actions with timing and retrigger behaviour |
| Links | Stateless wires connecting sensor conditions to actions |
| Storage | Quota, thinning rules, rolling buffer size |

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Identity | Nostr keypairs (secp256k1) | Cryptographic device identity, no registration |
| Signaling | Nostr relays + NIP-59 gift-wrap | WebRTC offer/answer exchange, metadata-private |
| Streaming | WebRTC (`RTCPeerConnection`) | P2P live video/audio |
| Footage transfer | WebRTC data channel | On-demand video/audio/photo segment transfer |
| Detection | Web Audio API (`AnalyserNode`) | Rolling RMS threshold detection with hysteresis |
| Recording | `MediaRecorder` (10-second chunks) | Continuous rolling video, audio, and photo buffer |
| Storage | IndexedDB (`idb`) + OPFS | Metadata + settings in IDB; segment blobs in OPFS |
| UI | SvelteKit 2 + Tailwind CSS v4 | PWA, static build |

For detailed technical documentation see [`docs/`](docs/).

### Nostr event kinds

| Kind | Direction | Encryption | Description |
|------|-----------|------------|-------------|
| 1059 | Both | NIP-59 | All WebRTC signaling (offer-request, offer, answer, hangup, ping, pong) |
| 5000 | Viewer → Monitor | NIP-44 | Pairing acknowledgement with scanner pubkey + relay list |
| 5010 | Monitor → Viewer | NIP-44 | Trigger event (sensor fired, with metadata and footage ref) |
| 5011 | Monitor → Viewer | NIP-44 | Arm/disarm state change |
| 5022 | Viewer → Monitor | NIP-44 | Backup request — ask monitor to send footage for local backup |
| 5023 | Monitor → Viewer | NIP-44 | Backup acknowledgement |
| 5024 | Viewer → Monitor | NIP-44 | Resync request — re-publish all footage refs since timestamp |
| 30020 | Monitor → Viewer | NIP-44 | Footage ref — trigger window metadata (NIP-33 replaceable, `d`=refId) |
| 30021 | Monitor → Viewer | None | Footage delete — signals a footage ref has been removed |

Kind 1059 is a NIP-59 gift-wrap outer event. All signaling travels inside it as a kind 5001 inner rumor, keeping sender and receiver identity hidden from relay operators.

Kind 30020 uses the NIP-33 parameterized-replaceable range so viewers that reconnect after being offline can request all footage refs since a given timestamp and receive only the latest version of each (de-duplicated by `d` tag).

### Data channel protocol

Footage retrieval and coverage queries happen over a WebRTC data channel (JSON messages):

```
Viewer → Monitor:  { type: "coverage-request", mimePrefix? }
Monitor → Viewer:  { type: "coverage-map", ranges: [[start, end], ...] }

Viewer → Monitor:  { type: "segment-request", time, mimePrefix? }
Monitor → Viewer:  { type: "segment-meta", requestTime, segmentId, startTime, endTime,
                                           mimeType, sizeBytes, contentHash }
                   { type: "segment-chunk", requestTime, startTime, index, total, data: "<base64>" }
                OR { type: "segment-error", requestTime, reason }

Viewer → Monitor:  { type: "segment-request-by-id", segmentId }
Monitor → Viewer:  { type: "segment-meta-by-id", ... } + chunks
                OR { type: "segment-error-by-id", segmentId, reason }

Viewer → Monitor:  { type: "segments-after-request", after, count, mimePrefix?, channelId? }
Monitor → Viewer:  { type: "segments-after", segments: [SegmentMeta, ...] }

Viewer → Monitor:  { type: "segments-before-request", before, count, mimePrefix?, channelId? }
Monitor → Viewer:  { type: "segments-before", segments: [SegmentMeta, ...] }

Viewer → Monitor:  { type: "source-list-request" }
Monitor → Viewer:  { type: "source-list", sourceIds: [...] }
```

Segments are split into 32 KB base64-encoded chunks. The viewer verifies the SHA-256 `contentHash` before resolving. Media never touches a relay.

## Building for production

```bash
npm run build
```

The output in `build/` is a fully static site. Deploy it anywhere — GitHub Pages, Netlify, a local file server, or directly on-device via a PWA wrapper.

## Privacy model

- **Keys** — private keys are stored in IndexedDB only, never in `localStorage` or cookies; never held in component state
- **Signaling** — gift-wrapped with one-time ephemeral pubkeys (NIP-59) and randomised `created_at` timestamps; relay operators see random pubkeys and cannot reconstruct timing
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
