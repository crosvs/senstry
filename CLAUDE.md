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

## Document Index

| File                                     | What it covers                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docs/new/nostr-foundation.md`           | Core Nostr protocol concepts, event model, NIPs used                                               |
| `docs/new/nostr-redesign.md`             | ECDH channel key design rationale and relay management                                             |
| `docs/new/nostr-controller.md`           | NostrController architecture: RelayPool, PublishQueue, SubscriptionManager, RateLimiter            |
| `docs/new/nostr-communication-flow.md`   | Device pairing, signal exchange, relay migration, TOTP, Nostr actions                              |
| `docs/new/sentry-pipeline-foundation.md` | Sentry pipeline: sources, sensors, channels, links, actions, segments                              |
| `docs/new/sentry-controller.md`          | Controller extraction: DetectorController, ActionController, RecordingController, TriggerPublisher |
| `docs/new/webrtc-architecture.md`        | WebRTC session lifecycle, signal types, data channel protocol, encryption                          |
| `docs/new/webrtc-communication-flow.md`  | WebRTC connection flows, request API, segment transfer, signal router                              |
