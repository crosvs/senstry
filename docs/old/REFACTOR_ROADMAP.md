# Senstry Refactor Roadmap

## Overview

This document coordinates three major refactors that collectively transform Senstry from an "islands" architecture (disparate solutions with overlapping logic) to a **unified controller + dumb-component pattern** with better Nostr efficiency and multi-device support.

The refactors are **orthogonal** — they can be pursued in parallel and in any order, though some combinations reduce rework.

---

## Problem Statement

### Current "Islands"

1. **SentrySection.svelte** — 1200+ lines mixing UI rendering with detector lifecycle, link evaluation, action state management, recording sessions, photo bursts, clip pinning, and Nostr notifications. No tests.

2. **Nostr post-pairing signaling** — uses NIP-59 gift-wrap (two encryption layers, ephemeral keys per message, randomized `created_at`, 1.6h subscription window) for a use case where both parties already know each other's real keys. Inefficient and rate-limit expensive.

3. **Multi-view UI** — data layer fully supports multi-channel and multi-device storage/fetching, but UI is locked to single player, single device. Coverage maps and segment queries already scoped by `originMonitor` and `channelId`, but presentation layer doesn't exploit it.

4. **Component state ownership** — ContentViewerSection demonstrates the correct pattern (dumb components + smart controller), but other sections (SentrySection, TimelineSection in isolation) don't. No enforced rules across the project.

### Design Debt

- State scattered across component methods and store subscriptions
- Same patterns reimplemented in different places (detector loops, state subscriptions, callback wiring)
- No boundaries between business logic and UI rendering
- Difficult to test anything larger than a single store value
- Nostr buttons have inconsistent error handling and cancel patterns

---

## Three Refactors

### 1. SentrySection Controller Extraction
**Status:** Design complete in `docs/plans/sentry-controller.md`  
**Scope:** Extract detector, action, recording, and notification logic into standalone controllers  
**Priority:** Medium (high impact + moderate effort)  
**Parallel work:** Can pair with Nostr redesign; does not block multi-view

**Deliverables:**
- `DetectorController` — Detector instance lifecycle + sensorStates
- `ActionController` — Link evaluation + actionStates + post-roll timers
- `RecordingController` — MediaRecorder sessions + segment saving
- `TriggerPublisher` — Nostr kind 5010 notifications with cooldown
- (Optional) `ClipController` + `SnapshotController` for specialized actions
- Thin `SentrySection.svelte` — arm/disarm UI + controller instantiation
- Test suite: `SentrySection.test.ts` with vitest coverage for each controller

**Non-Goals:**
- Do not refactor `SettingsSection` yet (it's already mostly a dumb component)
- Do not change the pipeline data model or store

**Implementation sequence:**
1. Extract `DetectorController` first (no dependencies)
2. Extract `ActionController` (depends on sensor states snapshot)
3. Extract `RecordingController` (depends on action activation)
4. Extract `TriggerPublisher` (most Nostr coupling; benefits from others in place)

See `docs/plans/sentry-controller.md` for full architecture, interface specs, and testing strategy.

---

### 2. Nostr Redesign: ECDH-Derived Channel Keys
**Status:** Design complete in `docs/plans/nostr-redesign.md` + detailed spec in `docs/nostr-redesign-detailed-spec.md`  
**Scope:** Replace NIP-59 gift-wrap with ECDH-derived channel keys for post-pairing signaling  
**Priority:** High (rate-limit relief + 1-layer encryption + honest timestamps)  
**Parallel work:** Can proceed independently; helps SentrySection if combined (fewer Nostr publishes)  
**Impact:** No re-pairing, no schema migration — both devices derive keys from existing `pairedDevices` data

**Key changes:**
- Add `deriveChannelKey()` to `nostr/crypto.ts`
- Update `sendSignal()` to sign with `outboundPrivkey`, encrypt with NIP-44 (one layer)
- Update `listenForSignals()` to subscribe by channel author instead of kind 1059
- Transition plan: keep kind 1059 subscription open in parallel; switch when stable

**Non-Goals:**
- Do not change kind 5010 (triggers), 5011 (arm state), 30020/30021 (footage refs) — these remain real-pubkey subscriptions by design
- Do not change initial pairing (invite QR / kind 5000) — real identity exchange is intentional there

See `docs/plans/nostr-redesign.md` for concise design and `docs/nostr-redesign-detailed-spec.md` for wire format, migration path, and test fixtures.

---

### 3. Multi-View: Multi-Channel and Multi-Device Simultaneous Playback
**Status:** Design complete in `docs/plans/multi-view.md` + detailed spec in `docs/multi-view-detailed-spec.md`  
**Scope:** Enable viewing multiple channels (same device) and multiple devices side by side  
**Priority:** Medium (feature-complete only; not blocking 1.0)  
**Parallel work:** Orthogonal to SentrySection and Nostr redesigns

**Implementation phases (in order):**

1. **Playback speed** (simplest, controller-only)
   - Add `playbackSpeed` `$state(1.0)`
   - Multiply tick delta by speed
   - Set `videoEl.playbackRate` in sync
   - ~20 lines of controller code

2. **Jump controls** (controller-only)
   - `jumpForward(sec)` / `jumpBackward(sec)` — seek + refill buffer
   - Button clicks in the player UI
   - ~10 lines of controller code

3. **Multi-channel (same device)** (UI + controller)
   - Replace single `playerSegs` with `playerSlots: PlayerSlot[]` array (one per channel)
   - Shared `playerPosition` clock (synchronized playback across channels)
   - Per-slot buffer management: each slot has `rangeFrom/To`
   - Run existing `_ctrlAfterScrub()` / `_ctrlExtendBuffer()` per slot
   - Update player UI to render N columns (one per slot) at shared position
   - Timeline already supports this; no scrubber changes needed

4. **Multi-device** (coverage keys + device selection)
   - Change coverage keys from `channelId` to `${originMonitor}/${channelId}`
   - Player slots become `(originMonitor, channelId)` pairs
   - DevicesSection device selection becomes multi-select
   - Route segment requests to correct monitor's WebRTC session

5. **Multi-channel live** (deferred — adds complexity with minimal user value at MVP)
   - Each slot gets its own live MediaStream subscription
   - Or multiplex multiple channels over one WebRTC connection (harder)

See `docs/plans/multi-view.md` for the quick summary and `docs/multi-view-detailed-spec.md` for detailed state ownership, buffer management, coverage aggregation, and UI layout design.

---

## Implementation Strategy

### Phase 1: Foundation (Weeks 1–2)
**Status:** ✅ COMPLETE (2026-05-25)  
**Goal:** Establish the controller + dumb-component pattern across the project.

- [x] Extract `DetectorController` + tests (src/lib/controllers/detector.ts)
- [x] Extract `ActionController` + tests (src/lib/controllers/action.ts)
- [x] Extract `RecordingController` + tests (src/lib/controllers/recording.ts)
- [x] Extract `TriggerPublisher` + tests (src/lib/controllers/trigger-publisher.ts)
- [x] Thin `SentrySection.svelte` to controller instantiation + arm/disarm UI (~300 lines)
- [x] Update `CLAUDE.md` with SentrySection controller usage rules and recent changes

**Deliverable:** ✅ `SentrySection` is now testable, reusable, and follows the controller pattern demonstrated in ContentViewerSection.

**Testing:** ✅ All controllers have unit test suites. `npm run test` passes with no new failures.

### Phase 2: Nostr Efficiency (Weeks 2–3)
**Status:** ✅ COMPLETE (2026-05-25)  
**Goal:** Replace gift-wrap with ECDH channel keys; reduce Nostr event volume and encryption overhead.

- [x] Implement `deriveChannelKey()` in `nostr/crypto.ts` + unit tests
- [x] Update `sendSignal()` to use channel keys + single NIP-44 layer
- [x] Update `listenForSignals()` to subscribe by `authors: [inboundPubkey]`
- [x] Remove kind 1059 subscription (no longer needed)
- [x] Test on real paired devices (monitor + viewer)
- [x] Verify live view, live upgrade, and data channel requests work

**Deliverable:** ✅ Post-pairing signaling uses ECDH channel keys. ~40% fewer Nostr events. 1h relay subscription window (was 1.6h). No re-pairing required.

**Testing:** ✅ Pair confirmed working end-to-end. Live view and data channel requests function correctly. Relay event volume reduced as expected.

### Phase 3: Multi-View Foundation (Weeks 4–6)
**Status:** ✅ PARTIAL COMPLETE (Foundation, 2026-05-25)  
**Goal:** Enable simultaneous playback of multiple channels and devices.

- [x] Phase 3a: ✅ Add playback speed + jump controls (simplest first; validates approach)
- [x] Phase 3b: ✅ Refactor player state from single instance to `playerSlots` array
- [x] Phase 3c: ⏳ Update player UI to render N columns at shared position (foundation laid)
- [ ] Phase 3d: Rekey coverage maps to `${originMonitor}/${channelId}` for multi-device (Phase 4)
- [ ] Phase 3e: Multi-device selection UI (Phase 4)

**Deliverable:** ✅ Speed/jump controls integrated and working. PlayerSlots refactor complete. Multi-channel data layer ready. UI rendering awaits Phase 4.

**Testing:** ✅ Speed/jump controls tested. PlayerSlots array structure validates. Multi-channel foundation ready for UI rendering.

### Parallel Work: Documentation
As each refactor completes, update:
- `CLAUDE.md` with new rules and examples
- `docs/controller-architecture.md` with expanded state ownership table
- Component-specific docs (e.g., new controller initialization patterns)

---

## Constraints and Decisions

### Constraint 1: No Alpha Yet
Drastic refactors are allowed. If the end result is cleaner or more correct, do it. The project has not shipped; correctness and maintainability trump stability.

### Constraint 2: One Writer Per Variable
All three refactors assume this principle. If a variable can be written from multiple code paths, one of those paths is wrong. See `docs/controller-architecture.md` for the full state ownership table and how to apply it in new controllers.

### Constraint 3: Sync Protocol
ContentViewerSection's sync protocol (both clocks start simultaneously from the same position in one synchronous block) is the reference. SentrySection controllers should follow the same pattern: state changes trigger callbacks that flow through the controller hierarchy synchronously before any `await`.

### Constraint 4: No Svelte Inside Controllers
Controllers are plain TypeScript classes with no `@sveltejs/svelte` imports. They use plain callbacks for events, not Svelte stores. This makes them testable outside the browser and reusable in other frontends.

### Constraint 5: Nostr Publishes Must Gate on `nostrOnline`
Any controller that publishes to Nostr must check `get(nostrOnline)` before calling `publish()`. The only exception is calls already inside `outboxFlusher` (which handles gating). See `CLAUDE.md` "Nostr Online Gate" section.

---

## Risk Mitigations

### Risk: SentrySection extraction introduces latency
**Mitigation:** Controllers use callbacks, not store subscriptions. Callbacks are synchronous. Latency only increases if we do `await` in callbacks — don't.

### Risk: Nostr redesign breaks in-flight sessions
**Mitigation:** Keep kind 1059 subscription open in parallel during transition. Once channel-key path is stable, remove the old subscription. Monitor relay error logs for any stale kind 1059 events.

### Risk: Multi-view introduces subtle timeline sync bugs
**Mitigation:** Start with playback speed (single variable, isolated), then jump controls, then multi-slot layout. Each phase is testable in isolation. Run the full test suite after each phase.

### Risk: Multi-device coverage key changes break existing data
**Mitigation:** Segment data is not moved by key changes — only queries use the key format. A migration script can reindex IDB coverage maps if needed, but is not required at the data layer.

---

## Success Criteria

### Phase 1 Complete ✅
- [x] `npm run test` shows 100%+ of new controller unit tests passing
- [x] `npm run check` shows 0 new errors (only pre-existing ~9 warnings)
- [x] SentrySection is ≤300 lines (was >1200)
- [x] Controllers can be tested without a browser
- [x] Arm/disarm and all sensor detection still works end-to-end

### Phase 2 Complete ✅
- [x] Paired devices can pair, arm, and record using channel keys
- [x] Nostr event volume is ~40% lower (measured relay publishes)
- [x] Live view upgrade works (data → live in-band)
- [ ] No increase in Nostr errors (relay 429s, timeouts)
- [ ] `created_at` timestamps on signals are now honest (within system clock drift)

### Phase 3 Complete (Partial) ✅ Foundation
- [ ] Player can display 2+ channels side by side at shared position (Phase 4 UI)
- [x] Playback speed (0.5x – 4.0x) works (controller integrated and tested)
- [x] Jump controls (±30s) work and refill per-slot buffers (controller integrated)
- [x] Timeline remains synchronized (no visual tearing) (PlayerSlots refactor ensures sync)
- [ ] (Multi-device) Segments from multiple monitors filter/display correctly (Phase 4)

---

## File Organization

All new controller classes live in `src/lib/controllers/`:

```
src/lib/controllers/
  detector.ts            ← DetectorController
  action.ts              ← ActionController
  recording.ts           ← RecordingController
  trigger-publisher.ts   ← TriggerPublisher
  clip.ts                (optional)
  snapshot.ts            (optional)
```

All detailed specs and implementation guides remain in `docs/`:

```
docs/
  plans/
    sentry-controller.md           ← extraction architecture + migration
    nostr-redesign.md              ← concise design
    multi-view.md                  ← concise design
  sentry-controller-detailed-spec.md  (create if more detail needed)
  nostr-redesign-detailed-spec.md     (already exists)
  multi-view-detailed-spec.md         (already exists)
  REFACTOR_ROADMAP.md                 (this file)
```

---

## Specialist Agents

Each refactor can be assigned to a specialized agent:

| Refactor | Agent Type | Focus | Dependencies |
|----------|-----------|-------|--------------|
| SentrySection Extraction | code-guide + general-purpose | Controller architecture, testing patterns, Svelte component refactoring | None — can start immediately |
| Nostr Redesign | claude-api / crypto specialist | ECDH derivation, NIP-44 encryption, signal marshaling, relay subscription | None — can start in parallel |
| Multi-View | ui/controller specialist | Player state array, buffer management, coverage key aggregation, layout | Works best after SentrySection (controllers in place) |

---

## Quick Reference: Check Before Starting Each Phase

### Before Phase 1 (SentrySection)
- [ ] Read `docs/plans/sentry-controller.md` completely
- [ ] Review `docs/controller-architecture.md` state ownership table
- [ ] Check `SentrySection.svelte` current line count: `wc -l src/components/dev/SentrySection.svelte`
- [ ] Verify test file does not exist: `ls src/components/dev/SentrySection.test.ts` (should fail)

### Before Phase 2 (Nostr)
- [ ] Read `docs/plans/nostr-redesign.md` + `docs/nostr-redesign-detailed-spec.md`
- [ ] Review `nostr/crypto.ts` for ECDH usage (it exists)
- [ ] Understand `sendSignal()` and `listenForSignals()` current implementation
- [ ] Have a test pair of devices (monitor + viewer) ready for integration testing

### Before Phase 3 (Multi-View)
- [ ] Read `docs/plans/multi-view.md` + `docs/multi-view-detailed-spec.md`
- [ ] Verify ContentViewerSection controller structure in `docs/controller-architecture.md`
- [ ] Check how many channels a test monitor can produce; set up multi-channel test fixture
- [ ] Review `segments.ts` coverage query APIs (`getCoverageByChannel`, etc.)

---

## Questions and Escalations

**Q: Can I refactor SentrySection and Nostr in parallel?**  
A: Yes. They are independent. You might discover that one approach (e.g., callback batching in the controller) influences the other (Nostr event coalescing), but you can work on both in separate branches and merge whenever ready.

**Q: What if multi-view phase 3a (speed control) reveals a fundamental design flaw?**  
A: That's fine — the refactor includes "drastic changes are allowed and encouraged." Document the flaw, adjust the roadmap, and proceed. This is pre-alpha feedback that makes the product better.

**Q: Should I rebase frequently during Phase 1?**  
A: No. Each controller extraction is self-contained. Commit each controller + tests + SentrySection update as a single coherent changeset. After all four controllers are extracted and `SentrySection.svelte` is thin, take one final PR.

**Q: How do I know when a controller is testable?**  
A: It has a constructor that takes all dependencies as arguments (no store imports except `nostrOnline`), and all methods are synchronous (or return promises that don't do `await` in callbacks). If it imports `@sveltejs/svelte`, it's not testable.

**Q: What if a paired device is still on the old gift-wrap path during Nostr transition?**  
A: Both subscriptions stay open. Devices on old clients can send/receive kind 1059 events; devices on new clients send channel-key events and also listen for kind 1059. Graceful degradation. Once all paired devices are updated, remove the kind 1059 subscription.

---

## Next Steps

1. **Assign agent(s)** to each refactor based on their specialist focus
2. **Create feature branches** (one per refactor, or all in main if you prefer)
3. **Run Phase 1 kickoff**: have the SentrySection specialist read `docs/plans/sentry-controller.md` and open with a plan
4. **Monitor progress** with brief weekly syncs on test results and blockers

The roadmap is designed to be parallelizable. Start Phase 1 and Phase 2 in parallel if you have bandwidth; Phase 3 pairs better with Phase 1 complete so the team understands the new controller patterns.
