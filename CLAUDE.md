# Senstry — Claude Working Instructions

## Repository Status: Documentation Phase

**This repository contains no implementation code. Do not write code.**

The project is in a documentation-first phase. All architecture decisions must be captured in `docs/new/` before any implementation begins. Code is written only after the human explicitly declares the documentation complete and ready.

When asked to implement something, respond with documentation changes or additions instead, unless the human has explicitly said to start coding.

---

## Documentation Standards

All files in `docs/new/` describe the architecture as it **is** — not as it was, not as it will be. Every doc is a specification, not a plan.

**Never write:**

- "Currently..." / "current implementation"
- "Planned:" / "Future:" / "will be"
- "Deprecated" / "legacy" / "old approach"
- Phase migration sections, implementation checklists, or task lists
- References to `src/` file paths that don't exist yet
- "Proposed" headings (decisions already made in the docs are decisions, not proposals)

**Write as if the architecture already exists and you are describing how it works.**

If a design decision has been made, state it. If something was considered and rejected, explain it briefly and move on. No transitional language.

---

## Architecture Principles

### Frontend is Presentation Only

The frontend (Svelte components) has exactly two responsibilities:

1. **Render and visualize** — display data and state from controllers
2. **Call functions** — forward user input to controller functions

No control logic lives in the frontend. This means:

- No state machines in components
- No orchestration logic in components
- No business rules evaluated in components
- No direct store subscriptions that drive side effects
- No `onMount` logic that manages resources or coordinates multiple systems

If a Svelte component is doing anything other than rendering derived state or calling a function, that logic belongs in a controller.

### Controllers Own Everything Else

All orchestration, state management, lifecycle control, and business logic lives in plain TypeScript controller classes. Controllers:

- Have no Svelte imports
- Accept plain values as constructor arguments (no store references)
- Expose state via readonly properties
- Communicate back to Svelte via callbacks passed at construction time
- Are independently unit-testable with vitest and fake inputs

### Explicit Wiring, No Auto-Magic

Nothing is auto-discovered or implicitly connected. Every pipeline component is explicitly created and wired. Sources don't auto-create captures; sensors don't auto-trigger actions; channels don't auto-start recording. If a connection isn't configured, it doesn't exist.

---

## Source Material

`docs/new/previous/` contains the original documentation these files were derived from. Those docs were built incrementally through task sessions — never fully reviewed end-to-end — and were summarized and adjusted post-creation. They contain known coherence issues and should be treated as reference-only. The canonical documentation is exclusively in `docs/new/`.

---

## Document Index

| File                                  | What it covers                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `docs/new/nostr-protocol.md`          | Core Nostr protocol concepts, event model, NIPs used, ECDH channel key design, relay model                  |
| `docs/new/contact-model.md`           | TempContact and PairedContact types, ContactManager, channel key derivation, contact lifecycle               |
| `docs/new/pairing.md`                 | Device pairing flows: QR-based, TOTP mailbox, and programmatic; invite delivery and PairedContact creation  |
| `docs/new/signal-exchange.md`         | Signal kinds 5001–5006: definitions, addressing, routing, TTL, publishing, and isResponse semantics          |
| `docs/new/nostr-client.md`            | NostrClient architecture: RelayPool, PublishQueue, SubscriptionManager, RelayStateController, NostrGate      |
| `docs/new/webrtc-peer.md`             | RTCPeerConnection factory, ICE/STUN/TURN config, signal wire format, ECDH encryption, TTL, deduplication    |
| `docs/new/webrtc-session.md`          | WebRTC session lifecycle: viewer and monitor connection flows, signal router, session teardown               |
| `docs/new/webrtc-data-channel.md`     | Data channel protocol: control and data channels, request/response pattern, segment transfer                 |
| `docs/new/sentry-pipeline.md`         | Sentry pipeline: sources, sensors, channels, capture methods, links, actions, segments                       |
| `docs/new/sentry-controllers.md`      | Controller layer: DetectorController, ActionController, RecordingController, TriggerPublisher, and peers     |
