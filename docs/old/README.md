# Senstry Documentation Index

Welcome to the Senstry project documentation. This guide helps you navigate the architecture, refactor plans, and implementation guides.

---

## Quick Links by Use Case

### I'm new to the project
1. Start here: [architecture.md](architecture.md) — 10 min overview of system components
2. Read: [controller-architecture.md](controller-architecture.md) — how components talk to controllers
3. Understand: [CLAUDE.md](../CLAUDE.md) — coding rules and patterns for this project

### I'm implementing a controller
1. Reference: [docs/plans/sentry-controller.md](plans/sentry-controller.md) — architecture template
2. Guide: [STATE_OWNERSHIP_GUIDE.md](STATE_OWNERSHIP_GUIDE.md) — how to own state correctly
3. Strategy: [CONTROLLER_TESTING_STRATEGY.md](CONTROLLER_TESTING_STRATEGY.md) — testing patterns
4. Example: [controller-architecture.md](controller-architecture.md) — ContentViewerSection as reference

### I'm working on the Nostr redesign
1. Plan: [docs/plans/nostr-redesign.md](plans/nostr-redesign.md) — concise design (5 min read)
2. Detailed: [nostr-redesign-detailed-spec.md](nostr-redesign-detailed-spec.md) — wire format, migration
3. Checklist: [NOSTR_TRANSITION_CHECKLIST.md](NOSTR_TRANSITION_CHECKLIST.md) — step-by-step tasks
4. Current state: [nostr.md](nostr.md) — event kinds, crypto, protocols

### I'm implementing multi-view
1. Plan: [docs/plans/multi-view.md](plans/multi-view.md) — quick overview (phased approach)
2. Detailed: [multi-view-detailed-spec.md](multi-view-detailed-spec.md) — state ownership, coverage maps
3. Checklist: [MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md](MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md) — 5 phases with code examples

### I need to coordinate the refactors
1. Roadmap: [REFACTOR_ROADMAP.md](REFACTOR_ROADMAP.md) — master plan, phases, dependencies, risk mitigation
2. State ownership: [STATE_OWNERSHIP_GUIDE.md](STATE_OWNERSHIP_GUIDE.md) — rules that apply everywhere
3. Testing: [CONTROLLER_TESTING_STRATEGY.md](CONTROLLER_TESTING_STRATEGY.md) — unified test approach

---

## Refactor Overview

Senstry is undergoing three major refactors to establish a unified architecture pattern, improve Nostr efficiency, and enable multi-device viewing.

### 1. SentrySection Controller Extraction
**Status:** ✅ COMPLETE (2026-05-25)  
**Goal:** Break apart 1200+ line component into testable, reusable controllers  
**Result:** DetectorController, ActionController, RecordingController, TriggerPublisher extracted and integrated  
**Impact:** SentrySection now ~300 lines (down from 1200+); all controllers unit-tested with vitest  
**Docs:**
- [docs/plans/sentry-controller.md](plans/sentry-controller.md) — architecture and interface specs
- [CLAUDE.md](../CLAUDE.md) — "Recent Changes" and "SentrySection Extraction" sections
- [CONTROLLER_TESTING_STRATEGY.md](CONTROLLER_TESTING_STRATEGY.md) — test patterns for controllers

### 2. Nostr Redesign: ECDH-Derived Channel Keys
**Status:** ✅ COMPLETE (Phase 3, 2026-05-25)  
**Goal:** Replace NIP-59 gift-wrap with ECDH channel keys (1 layer encryption, honest timestamps, ~40% fewer events)  
**Result:** Gift-wrap removed; channel-key signaling is now sole post-pairing path  
**Impact:** No re-pairing needed; reduces relay load; 1h subscription window (was 1.6h)  
**Docs:**
- [docs/plans/nostr-redesign.md](plans/nostr-redesign.md) — concise design overview
- [nostr-redesign-detailed-spec.md](nostr-redesign-detailed-spec.md) — wire format, crypto, derivation details
- [CLAUDE.md](../CLAUDE.md) — "Nostr Redesign Direction" updated with completion status
- [nostr.md](nostr.md) — event kinds, crypto, and protocols

### 3. Multi-View: Multi-Channel and Multi-Device Playback
**Status:** Phase 3 Foundation Complete (2026-05-25)  
**Completed:** Speed control, jump controls, PlayerSlots refactor, multi-channel data layer  
**Goal:** Enable 2–4 channels or devices playing simultaneously at shared playback position  
**Next:** Phase 4 multi-device UI + coverage key restructuring  
**Impact:** Speed/jump controls now integrated; PlayerSlots array ready for multi-channel UI  
**Docs:**
- [docs/plans/multi-view.md](plans/multi-view.md) — quick overview and phased approach
- [multi-view-detailed-spec.md](multi-view-detailed-spec.md) — state ownership, coverage aggregation, detailed design
- [MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md](MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md) — 5 phases with code examples

---

## Foundation: Design Principles

### Dumb Components + Smart Controllers
- **Components:** Pure renderers/previewers with event callbacks. Own no state. Never read sibling components.
- **Controllers:** Single source of truth. Own all state machines, data fetching, business logic.
- **Reference implementation:** ContentViewerSection + TimelineSection

See [controller-architecture.md](controller-architecture.md) for the canonical pattern.

### One Authoritative Writer Per Variable
Every stateful variable has exactly one code path that may write to it. This prevents race conditions, silent overwrites, and desynchronization.

See [STATE_OWNERSHIP_GUIDE.md](STATE_OWNERSHIP_GUIDE.md) for the framework and how to apply it.

### Sync Protocol
When multiple state variables must change together, do so synchronously in one block (no `await` between steps). After sync, state variables run independently until the next sync point.

Example: `playerSeekTo(t) → _tlSeekTo(t) → playerPlay() + _tlPlay()` — all in one sync block.

---

## Architecture Reference

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│  UI Components (dumb renderers + event callbacks)           │
│  - SentrySection.svelte                                     │
│  - TimelineSection.svelte                                   │
│  - SettingsSection.svelte                                   │
│  - DevicesSection.svelte                                    │
│  - ContentViewerSection.svelte (controller, not component)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│  Controllers (state machines, business logic)               │
│  - DetectorController (planned)                             │
│  - ActionController (planned)                               │
│  - RecordingController (planned)                            │
│  - TriggerPublisher (planned)                               │
│  - ContentViewerSection (reference implementation)          │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│  Data & Stores                                              │
│  - store/pipeline.ts (config)                               │
│  - store/identity.ts (keys)                                 │
│  - db/segments.ts (IDB + OPFS)                              │
│  - webrtc/viewer-peer.ts (data channel client)              │
│  - webrtc/monitor-peer.ts (data channel server)             │
│  - nostr/client.ts (publish/subscribe)                      │
└─────────────────────────────────────────────────────────────┘
```

### Key Constraints

**From CLAUDE.md:**
- No Svelte inside controllers (plain TypeScript)
- No sibling component reads (use props)
- Never store raw privkey in component state
- Always check `nostrOnline` before publishing
- Use `useNostrAction` hook for all Nostr buttons
- RTC ice gathering is non-trickle (wait for all candidates)
- Live upgrade: send renegotiation over existing data channel (1 event each way)

---

## Common Workflows

### Adding a New Detector Type
1. Implement `Detector` interface from `detectors/types.ts`
2. Add `type` discriminant to `SensorConfig`
3. Wire it in `DetectorController` (after extraction)

See [detectors.md](detectors.md) for existing detector types.

### Adding a New Nostr Event Kind
1. Define `KIND_*` constant in `nostr/events.ts`
2. Add builder function
3. Subscribe in appropriate store or controller using `subscribe()` from `nostr/client.ts`

See [nostr.md](nostr.md) for current kinds and crypto.

### Adding a Pipeline Link or Action
1. Add `type` discriminant to `LinkConfig` or `ActionConfig` in `store/pipeline.ts`
2. Update `ActionController` (after extraction) to handle new action type
3. Update `SettingsSection.svelte` UI to configure it

See [pipeline.md](pipeline.md) for data model.

---

## Documentation Files

### Quick References (5–10 min reads)
- [architecture.md](architecture.md) — system overview
- [docs/plans/sentry-controller.md](plans/sentry-controller.md) — SentrySection extraction
- [docs/plans/nostr-redesign.md](plans/nostr-redesign.md) — channel key design
- [docs/plans/multi-view.md](plans/multi-view.md) — multi-channel/multi-device approach

### Detailed Specs (20–40 min reads)
- [controller-architecture.md](controller-architecture.md) — ContentViewerSection pattern (authoritative)
- [component-contracts.md](component-contracts.md) — component prop/callback contracts
- [nostr-redesign-detailed-spec.md](nostr-redesign-detailed-spec.md) — wire format, derivation, migration
- [multi-view-detailed-spec.md](multi-view-detailed-spec.md) — state ownership, coverage aggregation, UI layout

### Implementation Guides (step-by-step checklists)
- [STATE_OWNERSHIP_GUIDE.md](STATE_OWNERSHIP_GUIDE.md) — how to apply "one writer" principle
- [CONTROLLER_TESTING_STRATEGY.md](CONTROLLER_TESTING_STRATEGY.md) — testing controllers with vitest
- [NOSTR_TRANSITION_CHECKLIST.md](NOSTR_TRANSITION_CHECKLIST.md) — 7-phase Nostr redesign
- [MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md](MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md) — 5-phase multi-view

### Domain-Specific References
- [nostr.md](nostr.md) — event kinds, NIP-59, NIP-44, presence protocol
- [storage.md](storage.md) — IDB schema (v8), OPFS blob storage, eviction policies
- [pipeline.md](pipeline.md) — sensor/link/action data model
- [detectors.md](detectors.md) — detector types (audio, schedule, time window, date range, Nostr trigger, photo)
- [webrtc.md](webrtc.md) — RTC peer connection, data channels, live stream protocol
- [timeline.md](timeline.md) — scrubber UI, coverage lanes, segment display
- [content-viewer.md](content-viewer.md) — fetch state machine, buffer management, sync protocol

### Master Roadmap
- [REFACTOR_ROADMAP.md](REFACTOR_ROADMAP.md) — coordinates all three refactors, phases, dependencies, risk mitigation

---

## Design Decisions (Record)

### Why ECDH-Derived Channel Keys Instead of Gift-Wrap?
- **2 layers → 1 layer:** Half the encryption overhead per message
- **Randomized timestamps → honest:** Relay `since` filters become reliable (shrinks 1.6h window to 1h)
- **Ephemeral keys per message → stable channel keys:** No per-message ECDH computation
- **No key exchange needed:** Both devices derive the same keys independently from existing ECDH shared secret
- **No re-pairing:** All existing paired devices get the optimization for free

See [nostr-redesign-detailed-spec.md](nostr-redesign-detailed-spec.md#problem-with-gift-wrap) for full comparison.

### Why Non-Trickle ICE?
- **Compression:** 15 Nostr events → 3 (offer-request → offer → answer) for fresh connection
- **Reliability:** Collecting all candidates before sending avoids STUN timeout surprises
- **5s timeout guard:** Reasonable upper bound; STUN is usually 2s

See [webrtc.md](webrtc.md) for ICE details.

### Why Controllers Are Plain TypeScript (No Svelte)?
- **Testable:** `vitest` + mocks, no browser needed
- **Reusable:** Can be used in other frontends (CLI, mobile, etc.)
- **Dependency injection:** No store imports except `nostrOnline`; all dependencies are constructor args
- **Simpler reasoning:** No Svelte reactivity rules, just pure functions and callbacks

---

## Getting Help

### Questions About Architecture?
1. Check the relevant doc above (e.g., controller-architecture for state ownership)
2. Search [CLAUDE.md](../CLAUDE.md) "Things to Avoid" section
3. Look at ContentViewerSection in `src/components/dev/` for a working example

### Bug or Unexpected Behavior?
1. Check git log for recent changes: `git log --oneline -10`
2. Check if there's a known issue in `docs/plans/` (edge cases section)
3. Run tests: `npm run test`
4. Run type checks: `npm run check`

### Want to Propose a Change?
1. Read relevant architectural doc (e.g., STATE_OWNERSHIP_GUIDE for state changes)
2. Create a minimal reproduction or example
3. Propose the change and risk analysis
4. Implement, test, and get review

---

## Files by Role

### DevOps / Release
- [REFACTOR_ROADMAP.md](REFACTOR_ROADMAP.md) — master timeline and dependencies

### Frontend Engineers
- [controller-architecture.md](controller-architecture.md) — canonical pattern
- [STATE_OWNERSHIP_GUIDE.md](STATE_OWNERSHIP_GUIDE.md) — state rules
- [CONTROLLER_TESTING_STRATEGY.md](CONTROLLER_TESTING_STRATEGY.md) — test patterns

### Nostr Specialists
- [NOSTR_TRANSITION_CHECKLIST.md](NOSTR_TRANSITION_CHECKLIST.md) — implementation steps
- [nostr-redesign-detailed-spec.md](nostr-redesign-detailed-spec.md) — crypto & wire format

### UI / UX for Multi-View
- [MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md](MULTI_VIEW_IMPLEMENTATION_CHECKLIST.md) — phased rollout
- [multi-view-detailed-spec.md](multi-view-detailed-spec.md) — state ownership

### System Architects / Tech Leads
- [architecture.md](architecture.md) — system overview
- [REFACTOR_ROADMAP.md](REFACTOR_ROADMAP.md) — full coordination
- [controller-architecture.md](controller-architecture.md) — pattern reference

---

## Key Stats

- **Project:** Senstry (privacy-first P2P home security)
- **Tech stack:** SvelteKit 2 + Svelte 5 runes, WebRTC, Nostr (channel keys), IndexedDB + OPFS, Tailwind CSS
- **Current state:** Pre-alpha (Phase 3-4 implementation complete; Phase 4 multi-device UI pending)
- **Completed:** SentrySection controllers extracted + tested; Nostr channel-key redesign; multi-channel player foundation
- **Test suite:** vitest (full controller unit tests; component integration tests in dev UI)
- **Build:** Vite 8, SvelteKit static build → dev panel at `/dev`
- **Documentation:** This index + 8+ detailed specs + implementation checklists + architecture reference

---

## Version History

- **v0.1 (Design phase):** ✅ COMPLETE — Architecture docs, refactor plans, implementation guides
- **v0.2 (SentrySection extraction):** ✅ COMPLETE — Controllers extracted + unit tested, SentrySection thin UI (~300 lines)
- **v0.3 (Nostr redesign):** ✅ COMPLETE (Phase 3) — Channel key signaling live, gift-wrap removed, ~40% fewer events
- **v0.4 (Multi-view Phase 3):** ✅ COMPLETE — Speed/jump controls, PlayerSlots refactor, multi-channel foundation
- **v0.5 (Multi-view Phase 4 - pending):** Multi-device UI + coverage key restructuring
- **v1.0 (alpha launch):** All refactors complete, feature-ready

---

Last updated: 2026-05-25  
Status: Phase 3-4 complete. Controllers extracted, Nostr redesigned, UI synchronized. Ready for Phase 5 and manual testing.
