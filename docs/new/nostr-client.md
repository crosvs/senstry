# NostrClient Architecture

## Overview

**NostrClient** is the single entry point for all Nostr interactions. Modules communicate through contactIds — they never handle relay lists, channel keys, raw events, or rate-limit state directly. All of that resolution is internal. `NostrClient` requires a `mySessionUUID` at construction — a per-app-instance UUID generated once at startup and shared with `SessionController`. It is used to populate the `#fs` sender tag on all outbound session-directed events.

```
Module
  │  "publish kind 5010 to contactId X"
  │  "fetch kind 5004 history from contactId X"
  ▼
NostrClient (peer-centric API)
  │
  ├── ContactManager          ← relay + key registry for all contacts (paired + temp)
  ├── RelayStateController    ← relay URL state: cooldown, health, rate limits
  ├── PublishQueue            ← rate-safe outbox; re-enqueues on cooldown
  ├── SubscriptionManager     ← subscription lifecycle, kind multiplexing, T+0 enforced
  ├── RelayPool (SimplePool)  ← actual WebSocket connections
  └── NostrGate               ← on/off switch ($nostrOnline)
```

Each subsystem is independently testable. `NostrClient` composes them and enforces the peer-centric API contract.

---

## NostrClient API

```typescript
class NostrClient {
  constructor(
    privkey: Uint8Array,
    pubkey: string,
    mySessionUUID: string,
    onOnlineStateChange: (isOnline: boolean) => void,
  ) {}

  // Contact registration — see contact-model.md for PairedContactEntry shape
  registerPaired(contact: PairedContactEntry): string;
  unregisterPaired(contactId: string): void;
  updatePairedRelays(contactId: string, newRelays: string[]): void;

  registerTempFromMailbox(opts: {
    senderEphemeralPubkey: string;
    senderRelays: string[];
    myListenRelays: string[];
    expiresAt: number;
    pubkey?: string;
  }): string;
  expireTemp(contactId: string): void;
  findContactsByPubkey(pubkey: string): ContactEntry[];
  allContactIds(): string[];

  // Publishing — relay selection, key lookup, and encryption are internal
  // sessionId: target peer session UUID; when provided, adds ["s", sessionId] and ["fs", mySessionUUID] tags
  publishSignal(contactId: string, kind: number, payload: object, sessionId?: string): void;
  publishSignalDirect(contactId: string, kind: number, payload: object, sessionId?: string): Promise<void>;

  // TOTP mailbox — pre-contact delivery, separate from the signal router
  subscribeToTOTPMailbox(
    mailboxPrivkey: Uint8Array,
    mailboxPubkey: string,
    relays: string[],
    onMessage: (decryptedPayload: object, senderEphemeralPubkey: string) => void,
  ): () => void;

  // Signal router — T+0 broadcast subscriptions per contact; decrypts before delivery
  // senderSessionUUID: from #s tag (5004) or #fs tag (session-directed kinds); absent for broadcast 5010/5011
  startSignalRouter(
    onSignal: (contactId: string, kind: number, payload: object, senderSessionUUID?: string) => void,
  ): void;
  stopSignalRouter(): void;

  // Session subscriptions — opened/closed by SessionController; events delivered via the same onSignal callback
  openSessionSubscription(contactId: string, peerSessionUUID: string): void;
  closeSessionSubscription(contactId: string, peerSessionUUID: string): void;

  // One-off subscription — for pre-pairing flows with no contactId
  requestSubscription(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onReady: (since: number) => void,
  ): SubscriptionHandle;

  // Resolves when a matching signal from contactId arrives, or null on timeout
  waitForSignal(
    contactId: string,
    opts: { kind: number; filter: (payload: object) => boolean; timeoutMs: number },
  ): Promise<object | null>;

  // Temporarily extends the contact's inbound relay list for dual-listening while
  // a relay migration proposal is in flight. onReady fires when the new relay
  // subscription is confirmed active. See signal-exchange.md for the full relay migration flow.
  requestRelayMigrationListening(contactId: string, newRelays: string[], onReady: (since: number) => void): void;

  // History — relay list and channel key resolved from ContactManager internally
  fetchKindHistory(
    contactId: string,
    kind: number,
    opts?: { windowStart?: number; windowEnd?: number },
  ): AsyncGenerator<NostrEvent>;

  // State
  get isOnline(): boolean;
  get queueDepth(): number;

  // Lifecycle
  goOnline(): void;
  goOffline(reason?: string): void;
  destroy(): void;
}
```

**Publishing:**
- `publishSignal` — queued, rate-safe. Default for all post-contact communication.
- `publishSignalDirect` — immediate, bypasses queue. Use only for time-sensitive signals (status announcements, RTC handshake).

**Signal routing:**
- `startSignalRouter(onSignal)` — maintains T+0 broadcast subscriptions (kinds 5004, 5010, 5011) per contact. `onSignal` receives `(contactId, kind, payload, senderSessionUUID?)` already decrypted. Session subscriptions (kinds 5001–5006) are managed separately via `openSessionSubscription`/`closeSessionSubscription` and also deliver through `onSignal`.
- Router re-subscribes automatically when contacts are added, updated, or expired.

---

## RelayPool (SimplePool Wrapper)

Low-level relay connections. Exposed as a module-internal primitive — modules never use it directly.

```typescript
export async function getPool(): Promise<SimplePool>;

export async function publish(event: NostrEvent, relays?: string[]): Promise<void>;

export async function subscribe(filters: Filter[], relays: string[]): Promise<Subscription>;
```

**Rules:**
- Pool is a singleton (one per app instance).
- All publishes and subscriptions go through the pool — no direct relay writes.
- `subscribe()` is an internal primitive used only by `SubscriptionManager`. Callers use `nostrClient.requestSubscription()`.

---

## PublishQueue + Outbox Flusher

Events destined for Nostr are queued and flushed on a timer, respecting relay rate limits.

```typescript
interface QueuedEvent {
  event: NostrEvent;
  label: string;
  createdAt: number;
  onQueued?: (estimatedEtaMs: number) => void;
  onPublished?: () => void;
  onError?: (reason: string) => void;
}

export function publishQueued(event: NostrEvent, label: string, opts?: PublishOptions): void;
export async function flushQueue(): Promise<void>;
```

The outbox flusher runs while the queue has items and `$nostrOnline` is true:

```typescript
export async function outboxFlusher(): Promise<void> {
  while (queue.length > 0 && $nostrOnline) {
    const batch = queue.splice(0, batchSize);
    for (const item of batch) {
      await publish(item.event);
      item.onPublished?.();
    }
    await delay(msPerEvent);
  }
}
```

**Rules:**
- `publishQueued()` is the default for all non-time-sensitive events.
- The flusher returns immediately if `$nostrOnline` is false.
- Queue is cleared on `goOffline()` to discard stale events.
- All queue operations are non-blocking — `publishSignal` returns immediately.

---

## SubscriptionManager

Manages the lifecycle of active subscriptions. Modules never open relay REQs directly — they request subscriptions and receive event callbacks. The manager handles relay REQ lifecycle and groups compatible subscriptions to stay within per-connection limits.

```typescript
interface SubscriptionHandle {
  unsubscribe(): void;
}

interface LogicalSubscription {
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
  onReady: (since: number) => void;
  dedup: Set<string>; // event IDs already delivered; reset every 60s
}

interface RelaySubscription {
  relays: string[];
  kinds: number[]; // union of all grouped logical subscriptions
  sub: Subscription;
}

export class SubscriptionManager {
  requestSubscription(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onReady: (since: number) => void,
  ): SubscriptionHandle;

  unsubscribe(handle: SubscriptionHandle): void;
  get active(): LogicalSubscription[];
}
```

**Rules:**
- All relay REQs use `since: Math.floor(Date.now() / 1000)` (T+0). Any caller-supplied `since` in the past is clamped to now.
- Dedup is per logical subscription, reset every 60s to prevent memory leaks.
- Long-lived subscriptions (signal router) never close autonomously. One-shots close at EOSE or timeout.

### Kind Multiplexing

When a new logical subscription arrives, the manager checks whether an existing relay REQ covers the same filter shape — same relay set, same tag anchors (e.g. `#p`), same time constraints — differing only in `kinds`. If one exists, the new kinds are merged into it rather than opening a separate relay REQ.

**Merge key:** relay set + tag anchors + time constraints. The `kinds` array is excluded — it is the dimension being merged.

Incoming events are dispatched by kind: a logical subscription for kind 5001 receives no callbacks when a kind 5010 event arrives.

### Transition Lifecycle

When a new logical subscription joins an existing relay REQ group, the manager opens the updated REQ before closing the old one. This prevents any gap in coverage.

```
1. LogicalSub A requests [5001]
   → Manager opens relay REQ for [5001]
   → onReady(since) fires for A

2. LogicalSub B requests [5010] (same merge key)
   → Manager opens a NEW relay REQ for [5001, 5010]
   → Waits for relay acknowledgment (REQ accepted, not rate-limited)
   → onReady(since) fires for B
   → Old [5001] REQ is closed

3. Event kind 5010 arrives → dispatched to B only; A sees nothing

4. LogicalSub B unsubscribes
   → Manager opens a NEW relay REQ for [5001]
   → Old [5001, 5010] REQ is closed after acknowledgment
   → A continues uninterrupted
```

During overlap, the same event can arrive from both the old and new REQ. Dedup is per logical subscription — both deliveries check the same dedup set, so the callback fires once.

"Relay acknowledgment" means the relay accepted the new REQ without a rate-limit rejection. It does not mean EOSE was signaled or an event was received.

### `onReady` Callback

`onReady(since: number)` fires once per logical subscription when its backing relay REQ is confirmed active. `since` is `Math.floor(Date.now() / 1000)` at acknowledgment time.

Modules use `since` as the `until` ceiling for a history fetch immediately after subscribing — ensuring no gap between the end of historical coverage and the start of live delivery.

```typescript
const handle = subscriptionManager.requestSubscription(
  [{ kinds: [5010], authors: [myInboundChannelPubkey] }],
  (event) => handleTrigger(event),
  (since) => {
    nostrClient.fetchKindHistory(contactId, 5010, { windowEnd: since });
  },
);
```

Without `onReady`, a module that fetches history up to "now" and then subscribes risks a gap if the relay REQ is delayed by a cooldown or rate limit.

---

## RelayStateController

Central authority on relay availability. Tracks every relay's rate-limit state, cooldown, and health keyed by relay URL — no concept of peer identity. All subsystems (publish, fetch, subscribe) consult the same controller. A relay cooled down by a publish to peer A is equally unavailable for a fetch involving peer B sharing that relay.

```typescript
interface RelayState {
  url: string;
  limitPerMinute: number;
  cooldownUntil: number;       // unix ms; eligible when now >= cooldownUntil
  consecutiveFailures: number;
  lastUsedAt: number;          // unix ms; for LRU selection
}

export class RelayStateController {
  selectRelay(desiredRelays: string[]): string | null;
  nextAvailableAt(desiredRelays: string[]): number;

  recordUse(relay: string): void;
  recordError(relay: string, resetAfterSec?: number): void;
  recordSuccess(relay: string): void;

  isEligible(relay: string): boolean;
  eligibleFrom(desiredRelays: string[]): string[];
}
```

**Behavior:**
- `cooldownUntil` after each use: `now + (60_000 / limitPerMinute)` ms.
- `selectRelay(list)` returns the eligible relay in `list` with the lowest `lastUsedAt` (LRU among non-cooled relays). Returns `null` if all relays are in cooldown.
- Received events during a fetch consume a token — each received event delays the next request by `1 / ratePerMinute` minutes.
- Rate-limit error from relay (NOTICE, 429): `recordError()` sets `cooldownUntil = now + resetAfterSec * 1000`. Without a relay hint, doubles the standard cooldown as backoff.
- After 3 consecutive all-relay failures: auto-offline.

**Rules:**
- Relay state is global and keyed by URL — two peers sharing a relay share its cooldown budget.
- Callers pass a desired list; the controller decides which relay to use.
- A cooled relay is skipped immediately, never waited on inline. If all relays are in cooldown, the publish is re-queued with delay = `nextAvailableAt()`.

---

## ContactBookController

ContactBookController fetches, persists, and publishes the encrypted contact book (kind 30078 replaceable event). Full fetch/merge/publish behavior, encryption details, and merge conflict rules are in [contact-model.md](contact-model.md) § ContactBookController.

---

## NostrGate ($nostrOnline)

Master on/off switch for all Nostr activity.

```typescript
export const nostrOnline = $state(false);
export const nostrOfflineReason = $state<string | null>(null);
```

On `goOnline()`, status kind 5004 is broadcast to all contacts before the gate opens. On `goOffline()`, offline status is broadcast and the queue is cleared before the gate closes. See [signal-exchange.md](signal-exchange.md) for the kind 5004 status protocol.

**Rules:**
- Check `$nostrOnline` before any `publish()` not inside `outboxFlusher`.
- Offline is announced BEFORE the gate is set to false — the last outbound events are the status announcements.
- The only events permitted when `nostrOnline = false` are the offline status announcements themselves.
- Offline is triggered by: user toggle, relay error auto-offline (3 consecutive all-relay failures), or manual test override.

---

## Patterns for Common Interactions

### Pattern 1: Fire-and-Forget

```typescript
await nostrClient.publishSignalDirect(contactId, 5004, {
  state: "online",
  isResponse: false,
});
```

Use for status announcements, RTC handshake signals, or anything irrelevant if delayed more than a second.

---

### Pattern 2: Queued Publish

```typescript
nostrClient.publishSignal(contactId, 5010, {
  actionId,
  footageRefId,
  detectedAt,
});
```

Use for trigger notifications, arm/disarm announcements, and all other non-urgent events. Returns immediately; the event is flushed asynchronously.

---

### Pattern 3: Relay Selection for Publish

Every publish targets one relay — the next available relay from the peer's outbound list, selected by `RelayStateController.selectRelay()`. There is no broadcast or fanout on publish.

**Why single-relay publish:** the receiver subscribes T+0 on all their inbound relays, so the event landing on any one of them is sufficient for live delivery. For history, `fetchKindHistory` fan-fetches from all relays and finds the event regardless of where it was published. Broadcasting to N relays multiplies rate-limit cost by N with no functional benefit.

**Selection flow inside `publishSignal`:**
1. `relayController.selectRelay(peer.outboundRelays)` — LRU among eligible relays.
2. Send to that relay; call `relayController.recordUse(relay)`.
3. Success: `relayController.recordSuccess(relay)`.
4. Rate-limit error: `relayController.recordError(relay, resetAfterSec)` — relay enters extended cooldown; `selectRelay()` called again for the next available.
5. `selectRelay()` returns `null` (all cooled): re-enqueue publish with delay = `relayController.nextAvailableAt(peer.outboundRelays)`.

**Invariants:**
- One relay per publish, always — chosen by the controller, never by the caller.
- Cooldown is per relay URL, global across all peers and all operation types.
- A cooled relay is never waited on inline — the publish is re-queued with an explicit delay.

---

### Pattern 4: T+0 Subscription + Progressive History Fetch

Subscriptions open at T+0 and never replay historical events. When a module needs history, it calls `fetchKindHistory()` explicitly.

```typescript
interface HistoryFetchOptions {
  windowStart?: number; // default: now - 2 days
  windowEnd?: number;   // default: now
}

async function* fetchKindHistory(
  contactId: string,
  kind: number,
  opts?: HistoryFetchOptions,
): AsyncGenerator<NostrEvent>
```

The relay list and channel key are resolved internally from ContactManager. Each `next()` call issues one fan-fetch round. Results are yielded newest-first, decrypted before delivery.

**Fan-fetch round mechanics:**

```
initial:  cursor = windowEnd
          floor  = windowStart
          relays = ContactManager.get(contactId).outboundRelayList

Each round:
  1. For each eligible relay (RelayStateController.eligibleFrom):
       send REQ { kinds: [kind], authors: [inboundChannelPubkey],
                  since: floor, until: cursor, limit: 1 }
     All eligible relays queried simultaneously.

  2. Collect responses. Deduplicate by event ID. Yield to caller.

  3. If events returned:
       cursor = min(event.created_at) - 1
     If no events returned from any relay:
       stop (window exhausted).

  4. Wait for shortest remaining cooldown among pool relays.
     Stop if cursor <= floor.
```

Each relay that participates consumes one token. Received events count toward rate-limit cost:

```
delayMs = receivedCount × (60_000 / relayRatePerMinute)
```

At 30 events/minute: 1 event received → 2-second delay before the next round.

Callers apply kind-specific stop conditions based on the signal semantics defined in [signal-exchange.md](signal-exchange.md).

**Caller examples:**

```typescript
// Find the most recent relay migration proposal (kind definitions in signal-exchange.md)
for await (const event of nostrClient.fetchKindHistory(contactId, 5005)) {
  const msg = event.decryptedPayload as RelayMigrationPayload;
  if (!msg.isResponse) {
    applyPendingRelayMigration(msg);
    break;
  }
}

// Get last known peer status since last online (kind definitions in signal-exchange.md)
for await (const event of nostrClient.fetchKindHistory(contactId, 5004, {
  windowStart: lastOnlineSec,
})) {
  setLastKnownStatus(contactId, event.decryptedPayload.state, event.created_at);
  break;
}

// Catch up on all missed trigger events — full range, no break (kind definitions in signal-exchange.md)
const missedActions: NostrEvent[] = [];
for await (const event of nostrClient.fetchKindHistory(monitorContactId, 5010, {
  windowStart: lastOnlineSec,
})) {
  missedActions.push(event);
}
for (const event of missedActions.reverse()) {
  handleTriggerEvent(event);
}
```

---

### Pattern 5: Signal Router (Long-Lived Subscription)

```typescript
nostrClient.startSignalRouter((contactId, kind, payload, senderSessionUUID) => {
  routeSignal(contactId, kind, payload, senderSessionUUID);
});

onDestroy(() => nostrClient.stopSignalRouter());
```

`startSignalRouter` establishes broadcast subscriptions (kinds 5004, 5010, 5011) per contact. Session subscriptions (kinds 5001–5006) are opened and closed by `SessionController` via `openSessionSubscription`/`closeSessionSubscription` — events from both subscription types are delivered through the same `onSignal` callback. For subscription structure, kind assignments, and tag semantics, see [signal-exchange.md](signal-exchange.md).

Kind 5201 (TOTP Mailbox) is not routed here — it uses the separate `subscribeToTOTPMailbox` subscription.

When a peer is registered or its relay list updated, the router re-subscribes using the transition lifecycle: new REQ opened and relay-verified before the old one closes.

---

### Pattern 6: Full-Range History Fetch

Iterate the full generator without breaking to collect all events in a window.

```typescript
const missed: NostrEvent[] = [];
for await (const event of nostrClient.fetchKindHistory(contactId, 5010, {
  windowStart: lastOnlineSec,
})) {
  missed.push(event);
}
for (const event of missed.reverse()) {
  handleTriggerEvent(event);
}
```

The generator stops automatically when `windowStart` is reached or all relays return empty. Events arrive newest-first; reverse for chronological processing.

---

## Key Invariants

- **Modules interact with contactId only** — no relay lists, channel keys, or raw Nostr events cross the `NostrClient` boundary.
- **T+0 subscriptions, explicit history** — `requestSubscription()` and the signal router always open with `since: now`. History is fetched via `fetchKindHistory()` intentionally, with a defined goal and stop condition.
- **Single-relay writes, fan-fetch reads** — publish goes to one relay (LRU-eligible, chosen by `RelayStateController`); `fetchKindHistory` fan-fetches `limit: 1` from all non-cooled relays per round, deduplicates, yields one at a time.
- **`publishSignal` is the default** — `publishSignalDirect` only for time-sensitive signals.
- **Cooldown is global per relay URL** — `RelayStateController` is shared across all peers and all operation types.
- **Received events consume rate-limit tokens** — each event received during a fetch sets `cooldownUntil` identically to a publish on that relay.
- **New REQ before old REQ closes** — `SubscriptionManager` never creates a coverage gap during subscription transitions.
- **`limit: 1` per relay per round, always** — not caller-configurable; keeps rate-limit cost predictable.
- **Default history window is 2 days** — `fetchKindHistory` never looks beyond `now - 2 days` unless `windowStart` is set explicitly.
- **Never publish when `nostrOnline = false`** — gate checked before every outbound operation; the only exception is the offline status announcement itself.
- **Signal routing is by kind number** — callbacks dispatched by kind, never by decrypted payload content. `SubscriptionManager` may group multiple kinds into one relay REQ for efficiency; this is invisible to callers.
- **Session subscriptions are caller-managed** — `NostrClient` never opens a session subscription autonomously. `openSessionSubscription`/`closeSessionSubscription` are called exclusively by `SessionController`. `NostrClient` does not validate session UUIDs; it uses them mechanically for tags and relay filters.
- **Each active peer session is one relay REQ** — session subscriptions for different peer sessions on the same contact have distinct `#fs` tag anchors and do not merge in `SubscriptionManager`.

---

## Testing Patterns

### Unit Test: PublishQueue

```typescript
describe("PublishQueue", () => {
  it("respects rate limits", async () => {
    const published: string[] = [];

    publishQueued({ ...mockEvent, content: "msg-0" }, "test", {
      onPublished: () => published.push("msg-0"),
    });
    publishQueued({ ...mockEvent, content: "msg-1" }, "test", {
      onPublished: () => published.push("msg-1"),
    });

    const startTime = Date.now();
    await flushQueue();
    const elapsed = Date.now() - startTime;

    expect(published).toHaveLength(2);
    expect(elapsed).toBeGreaterThan(rateLimitMsPerEvent);
  });

  it("clears queue when going offline", () => {
    publishQueued(mockEvent, "test");
    publishQueued(mockEvent, "test");

    goOffline("test");
    expect(queueDepth()).toBe(0);
  });
});
```

### Unit Test: SubscriptionManager

```typescript
describe("SubscriptionManager", () => {
  it("dedupes by event ID", () => {
    const received: string[] = [];
    const handle = mgr.requestSubscription(
      [{ kinds: [5001] }],
      (event) => received.push(event.id),
      (_since) => {},
    );

    mgr._simulateEvent(mockEvent);
    mgr._simulateEvent(mockEvent);

    expect(received).toHaveLength(1);
  });

  it("removes subscription on unsubscribe", () => {
    const handle = mgr.requestSubscription(
      [{ kinds: [999] }],
      (_event) => {},
      (_since) => {},
    );
    handle.unsubscribe();
    expect(mgr.active).toHaveLength(0);
  });
});
```

### Integration Test: Publish + Subscribe

```typescript
describe("NostrClient (integration)", () => {
  it("publishes and subscriber receives", async () => {
    const client = new NostrClient(privkey, pubkey, mySessionUUID, vi.fn());
    const received: string[] = [];

    client.startSignalRouter((contactId, kind, payload, senderSessionUUID) => {
      received.push(JSON.stringify(payload));
    });

    await client.publishSignalDirect(contactId, 5004, {
      state: "online",
      isResponse: false,
    });

    await waitFor(() => received.length > 0);
    expect(received[0]).toContain("online");
  });
});
```
