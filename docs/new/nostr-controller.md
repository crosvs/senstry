# Nostr Communication Controller Architecture

## Architecture

**NostrController** exposes a peer-centric API to modules. Modules know only about paired devices — they never handle relay lists, channel keys, or rate-limit state directly. Two internal layers handle the translation.

```
Module
  │  "publish kind 5004 to peer X"
  │  "fetch kind 5005 history from peer X"
  ▼
NostrController (peer-centric API)
  │
  ├── ContactManager                   ← paired devices + temp (giftwrap-derived) contacts
  │     paired: IDB-backed, ECDH keys, permanent
  │     temp:   memory-only, ephemeral keys, TTL
  │     never queried by modules directly
  │
  ├── RelayStateController             ← relay URL state: cooldown, health, rate limits
  │     selectRelay(), recordUse(), fan-fetch eligibility
  │     global — shared across all peers and all operation types
  │
  ├── PublishQueue                     ← rate-safe outbox; re-enqueues when all relays cooled
  ├── SubscriptionManager              ← subscription lifecycle + dedup, T+0 enforced
  ├── RelayPool (SimplePool)           ← actual WebSocket connections
  └── NostrGate ($nostrOnline)         ← on/off switch
```

Each subsystem is independently testable:

- **ContactManager** — unified registry for paired devices (permanent, ECDH keys, IDB) and temp contacts (ephemeral keys, memory-only TTL, giftwrap-derived). Source of truth for all relay and key lookups.
- **RelayStateController** — per relay URL: cooldown, rate limit, failure count. Selects relay for publish; provides eligible set for fan-fetch.
- **PublishQueue** — queue events with relay-safe re-enqueue on cooldown
- **SubscriptionManager** — manage active subscriptions with auto-cleanup, dedup, T+0 enforced
- **RelayPool** — low-level relay connections (SimplePool)
- **NostrGate** — guard all Nostr activity on online/offline state

---

## Core Responsibilities

### NostrClient

Main entry point for all Nostr interactions. Coordinates the subsystems above.

```typescript
class NostrClient {
  constructor(
    privkey: Uint8Array,
    pubkey: string,
    onOnlineStateChange: (isOnline: boolean) => void,
  ) {}

  // Contact registry — both paired and temp use the same UUID-based contactId
  registerPaired(device: PairedDevice): string           // returns UUID contactId
  unregisterPaired(contactId: string): void
  updatePairedRelays(contactId: string, newRelays: string[]): void  // relay migration commit

  registerTempContact(rumor: GiftwrapRumor, ttlSeconds: number): string  // returns UUID contactId
  expireTemp(contactId: string): void                    // immediately discard a temp contact
  findContactsByPubkey(pubkey: string): ContactEntry[]   // check for existing contacts; used during pairing
  allContactIds(): string[]                              // all registered contact UUIDs (paired + temp)

  // Signals — contactId only; relay selection, key lookup, and encryption are all internal
  publishSignal(contactId: string, kind: number, payload: object): void           // queued, rate-safe
  publishSignalDirect(contactId: string, kind: number, payload: object): Promise<void>  // time-sensitive
  sendGiftWrap(contactId: string, payload: object): Promise<void>  // NIP-59 wrap; for temp contacts

  // Signal router — T+0 across all contacts; decrypts before delivery
  startSignalRouter(onSignal: (contactId: string, kind: number, payload: object) => void): void
  stopSignalRouter(): void

  // History — contactId only; relay list and keys resolved internally
  fetchKindHistory(
    contactId: string,
    kind: number,
    opts?: { windowStart?: number; windowEnd?: number }
  ): AsyncGenerator<NostrEvent>

  // State
  get isOnline(): boolean
  get queueDepth(): number

  // Lifecycle
  goOnline(): void
  goOffline(reason?: string): void
  destroy(): void
}
```

**Publishing patterns:**
- `publishSignal(contactId, kind, payload)` — queued; relay selected by `RelayStateController` (LRU-eligible)
- `publishSignalDirect(contactId, kind, payload)` — immediate; for time-sensitive signals
- `sendGiftWrap(contactId, payload)` — NIP-59 layers; uses `outboundChannelPubkey` if set, else addresses to `pubkey`
- Relay selection, key lookup, and encryption are always internal

**Subscribing:**
- `startSignalRouter(onSignal)` — T+0 subscriptions across all contacts; `onSignal` receives `(contactId, kind, payload)`
- Signal router re-subscribes automatically when contacts are added, updated, or expired

**History:**
- `fetchKindHistory(contactId, kind, opts)` — fan-fetches `limit:1` per round; relay list and keys resolved internally

**Pairing with existing temp contact:**
```typescript
const existing = nostrClient.findContactsByPubkey(incomingPubkey);
// existing may include a temp contact from an in-progress TOTP session
// controller decides: expire temp entry, carry over state, or let both coexist until TTL
const pairedId = nostrClient.registerPaired(device);
existing.filter(e => e.expiresAt).forEach(e => nostrClient.expireTemp(e.contactId));
```

---

## Subsystems

### ContactManager

Internal registry for all contacts — both permanent paired devices and temporary ephemeral contacts derived from gift wraps. No module accesses this directly; `NostrClient` methods look up what they need here.

```typescript
// Shared interface — NostrClient sees no difference between paired and temp contacts
interface ContactEntry {
  contactId: string;                     // UUID — generated at creation, stable for lifetime of contact

  pubkey: string;                        // real identity; used to detect duplicates across paired/temp

  inboundChannelPubkey: string;          // paired: ECDH-derived; temp: freshly generated ephemeral
  inboundChannelPrivkey: Uint8Array;     // held in memory; used to decrypt incoming events
  outboundChannelPubkey: string | null;  // null → address to pubkey directly (initial contact)

  inboundRelayList: string[];            // relays WE listen on for this contact
  outboundRelayList: string[];           // relays WE send to in order to reach this contact

  addedAt: number;
  expiresAt?: number;                    // absent = permanent (paired); set = temp (giftwrap-derived)
}

class ContactManager {
  // Paired device management (persistent, IDB-backed)
  registerPaired(device: PairedDevice): string      // returns new UUID contactId
  unregisterPaired(contactId: string): void
  updatePairedRelays(contactId: string, newInboundRelays: string[]): void  // relay migration commit

  // Temp contact management (memory-only, TTL)
  registerTemp(entry: Omit<ContactEntry, 'contactId'>): string  // returns new UUID contactId
  expireTemp(contactId: string): void
  purgeExpired(): void                                           // called periodically

  // Lookup
  get(contactId: string): ContactEntry
  findByPubkey(pubkey: string): ContactEntry[]         // find all contacts (paired or temp) for a real identity
  findByInboundKey(inboundChannelPubkey: string): ContactEntry | null  // for signal routing
  allMyInboundRelays(): string[]                       // union of inboundRelayList across all contacts
}
```

**Paired entries:**
- Registered from `PairedDevice` records on startup; each gets a UUID `contactId`
- ECDH-derived channel keys, cached on register
- No `expiresAt` — permanent until unpaired
- Relay migration → `updatePairedRelays(contactId, ...)` → next operation picks up new list automatically

**Temp entries (gift-wrap-derived):**
- Created when a gift wrap is received and decrypted; each gets a UUID `contactId`
- `inboundChannelPubkey/Privkey` freshly generated at creation
- `outboundChannelPubkey` = `replyKey` from the gift wrap rumor; `null` if initiating without prior wrap
- Memory-only; discarded when `expiresAt` passes
- Multiple temp entries may share the same `pubkey` — each has its own UUID

**Pairing handshake — duplicate detection:**
When pairing completes, `ContactManager.findByPubkey(pubkey)` checks whether a temp contact already exists for that real identity (e.g. a TOTP session was in progress before pairing finished). The controller decides whether to expire the temp entry, carry over its relay/key state, or let both coexist until the temp expires naturally.

**Signal routing:**
Incoming events carry either an `authors` pubkey (paired signals) or a `#p` tag (gift wraps) that matches an `inboundChannelPubkey`. `findByInboundKey()` maps that back to a `contactId`, which is what the signal router delivers to `onSignal`.

**Signal router coverage:**
- `allMyInboundRelays()` includes relay lists from all contacts (paired and temp)
- Signal router subscribes across all of them, filtering by all active `inboundChannelPubkey` values
- Re-subscribes automatically when any contact is registered, updated, or expired

---

### RelayPool (SimplePool wrapper)

Low-level relay connections managed by `SimplePool`. Exposed via `client.ts`:

```typescript
export async function getPool(): Promise<SimplePool> {
  // returns singleton SimplePool
}

export async function publish(event: NostrEvent, relays?: string[]): Promise<void>

export async function subscribe(
  filters: Filter[],
  options?: SubscriptionOptions
): Promise<Subscription>
```

**Rules:**
- Pool is a singleton (one per app)
- All publishes go through the pool (no direct relay writes)
- All subscriptions go through the pool (enables dedup + filtering)

---

### PublishQueue + Outbox Flusher

Events destined for Nostr are queued and flushed on a timer, respecting rate limits.

```typescript
interface QueuedEvent {
  event: NostrEvent;
  label: string;                    // e.g. "signal-offer", "trigger-notify"
  createdAt: number;
  onQueued?: (estimatedEtaMs: number) => void;
  onPublished?: () => void;
  onError?: (reason: string) => void;
}

export function publishQueued(event: NostrEvent, label: string, opts?: PublishOptions): void
export async function flushQueue(): Promise<void>
```

```typescript
export async function outboxFlusher(): Promise<void> {
  while (queue.length > 0 && $nostrOnline) {
    const batch = queue.splice(0, batchSize);
    for (const item of batch) {
      await publish(item.event);
      item.onPublished?.();
    }
    await delay(msPerEvent);  // paced by rate limit
  }
}
```

**Rules:**
- `publishQueued()` is the default for everything (not time-sensitive)
- Only `publish()` for responses or time-critical signals
- Flusher returns immediately if `$nostrOnline` is false
- Queue is cleared on `goOffline()` to avoid stale events

---

### SubscriptionManager

Manages the lifecycle of active subscriptions with dedup and cleanup.

```typescript
interface ManagedSubscription {
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
  onEose: () => void;
  dedup: Set<string>;        // event IDs seen, cleared every 60s
  createdAt: number;
  lastEventAt: number;
}

export class SubscriptionManager {
  subscribe(filters: Filter[], opts?: SubscriptionOptions): Subscription
  unsubscribe(sub: Subscription): void
  get active(): ManagedSubscription[]
}
```

**Lifecycle:**
1. `subscribe(filters)` opens a relay subscription and returns a handle
2. Incoming events are deduped by ID (same ID within 60s is dropped)
3. `onEose` fires when relay signals end-of-stored-events
4. `close()` on subscription → sends `CLOSE` frame to relay
5. Auto-cleanup: subscriptions without listeners after 30s are closed

**Rules:**
- All subscriptions use `since: Math.floor(Date.now() / 1000)` (T+0). Historical replay is never performed inside `subscribe()`. Any caller-supplied `since` value in the past is silently clamped to now.
- One `Filter` array per subscription (not multiple filters in one sub)
- Dedup is per-subscription, reset every 60s (prevents memory leaks)
- Long-lived subscriptions (signal router) never close; one-shots close at EOSE or timeout

---

### RelayStateController

The central authority on relay availability. Tracks every relay's rate-limit state, cooldown, and health keyed by relay URL only — no concept of peer identity. All subsystems (publish, fetch, subscribe) consult the same controller, so a relay cooled down by a publish to peer A is equally unavailable for a fetch involving peer B who shares that relay.

```typescript
interface RelayState {
  url: string;
  limitPerMinute: number;   // relay's declared rate limit (updated from relay hints)
  cooldownUntil: number;    // unix ms; relay is eligible when now >= cooldownUntil
  consecutiveFailures: number;
  lastUsedAt: number;       // unix ms; used for least-recently-used selection
}

export class RelayStateController {
  // Selection — caller provides desired list, controller picks from it
  selectRelay(desiredRelays: string[]): string | null   // next available (LRU among eligible); null = all in cooldown
  nextAvailableAt(desiredRelays: string[]): number      // ms until soonest relay in list becomes eligible

  // State updates — called after each interaction
  recordUse(relay: string): void                        // consume 1 token, update lastUsedAt + cooldownUntil
  recordError(relay: string, resetAfterSec?: number): void  // extend cooldown from relay hint or default backoff
  recordSuccess(relay: string): void                    // reset consecutiveFailures

  // Inspection
  isEligible(relay: string): boolean                    // now >= cooldownUntil
  eligibleFrom(desiredRelays: string[]): string[]       // all currently eligible relays in a list
}
```

**Behavior:**
- `cooldownUntil` after each use: `now + (60_000 / limitPerMinute)` ms — one token per minute budget
- Each interaction (publish send, fetch REQ, fetch event received) calls `recordUse()` on the relay that handled it
- **Received events during a fetch also consume a token.** Receiving 1 event from a relay sets `cooldownUntil` the same as if that relay had received a publish.
- `selectRelay(list)` returns the relay in `list` with the earliest `cooldownUntil` that is currently eligible (`now >= cooldownUntil`). Among multiple eligible relays, it picks the least recently used (`lastUsedAt` lowest). Returns `null` if all relays in the list are in cooldown.
- Rate-limit errors from relay (NOTICE, 429): `recordError()` sets `cooldownUntil = now + resetAfterSec * 1000`. If no hint provided, doubles the standard cooldown as backoff.
- After 3 consecutive failures across all relays → auto-offline

**Rules:**
- Relay state is global and keyed by URL — two peers sharing a relay share its cooldown budget
- Callers never select relays directly; they pass a desired list and the controller decides
- A relay in cooldown is skipped immediately, never waited on by the caller
- `nextAvailableAt(list)` is used when a publish must wait (all relays in cooldown) — caller waits that duration then retries

---

### NostrGate ($nostrOnline store)

Master on/off switch for all Nostr activity.

```typescript
export const nostrOnline = $state(false);
export const nostrOfflineReason = $state<string | null>(null);

export function goOnline(): void {
  nostrOnline = true;
  nostrOfflineReason = null;
  // Announce presence to all registered peers — relay selection is internal
  for (const contactId of nostrClient.allContactIds()) {
    nostrClient.publishSignalDirect(contactId, 5004, { state: 'online', isResponse: false });
  }
}

export function goOffline(reason?: string): void {
  // Announce offline BEFORE gating
  for (const contactId of nostrClient.allContactIds()) {
    nostrClient.publishSignalDirect(contactId, 5004, { state: 'offline', isResponse: false });
  }
  nostrClient.clearQueue();
  nostrOnline = false;
  nostrOfflineReason = reason ?? 'manual';
}
```

**Rules:**
- Check `get(nostrOnline)` before any `publish()` not inside `outboxFlusher`
- Never send events when `nostrOnline = false` except:
  - Last `status: offline` announcement (broadcast BEFORE setting false)
  - Responses to subscriptions already open (received before gate closed)
- Offline state is set by:
  - User toggle (goOnline/goOffline)
  - Relay error auto-offline: 3 consecutive all-relay failures → goOffline()
  - Manually for testing

---

## Patterns for Common Interactions

### Pattern 1: Fire-and-Forget (e.g., status announcement)

```typescript
// Direct publish for time-sensitive signals — contactId only, internals handled by NostrClient
await nostrController.publishSignalDirect(contactId, 5004, { state: 'online', isResponse: false });
```

**Use cases:**
- Status announcements (must go immediately)
- Response to time-sensitive requests
- Anything that's irrelevant if delayed >1s

---

### Pattern 2: Queued Publish (e.g., trigger event)

```typescript
// Queued publish — relay selection handled internally
nostrController.publishSignal(contactId, 5010, {
  actionId,
  footageRefId,
  detectedAt,
});
```

**Use cases:**
- Trigger notifications
- Arm/disarm announcements
- Any non-urgent event

---

### Pattern 2.5: Publish Relay Selection

Every publish targets **one relay** — the next available relay from the peer's desired list, selected by `RelayStateController.selectRelay()`. There is no broadcast or fanout on publish.

**Why single-relay publish:**
- The receiver subscribes T+0 on all their inbound relays. The event landing on any one of them is sufficient for delivery.
- For history, `fetchKindHistory` fan-fetches from all relays — it finds the event regardless of which one the sender used.
- Broadcasting to N relays multiplies rate-limit cost by N with no functional benefit.

**Selection logic inside `publish()`:**
1. Call `relayController.selectRelay(peer.relays)` — returns the eligible relay with the lowest `lastUsedAt` (LRU among relays not currently in cooldown)
2. Send to that relay; call `relayController.recordUse(relay)` on attempt
3. On success: `relayController.recordSuccess(relay)`
4. On rate-limit error: `relayController.recordError(relay, resetAfterSec)` — relay enters extended cooldown; call `selectRelay()` again for next available
5. If `selectRelay()` returns `null` (all in cooldown): re-enqueue publish with delay = `relayController.nextAvailableAt(peer.relays)`

**Shared global state — overlapping relay lists across peers:**
If peer A and peer B both list `wss://relay-x.com`, a publish to peer A that consumes a token on relay-x means relay-x's `cooldownUntil` is set. When selecting a relay for peer B's next publish, `selectRelay(peerB.relays)` sees relay-x as cooled and picks a different relay from peer B's list (if available). The controller has no concept of peer identity — only relay URL state.

**Recovery:**
- One relay in cooldown → `selectRelay()` picks another from the list
- All relays in cooldown → publish re-enqueued; fired when `nextAvailableAt()` elapses
- Relay hard-failure → `consecutiveFailures` increments; after threshold, relay excluded from selection until reset

**Invariants:**
- One relay per publish, always — chosen by the controller, never by the caller
- Cooldown is per relay URL, global across all peers and all operation types (publish, fetch, subscribe REQ)
- A cooled relay is never waited on inline — the publish is re-queued with an explicit delay

---

### Pattern 3: T+0 Subscriptions and Progressive History Fetch

Subscriptions open at T+0 — `since: Math.floor(Date.now() / 1000)` — and never replay historical events. When a module needs to look back in time, it calls `fetchKindHistory()` explicitly with a specific goal, iterates until it finds what it needs, then stops.

This is the **only** model for consuming Nostr events in Senstry. No module implements its own fetch loop or time-window strategy. All of that logic lives in `NostrController`.

**Why T+0 only subscriptions:**
- A subscription's job is to deliver future events in real time. Historical replay is a separate concern with different semantics and cost.
- Fetching history on every subscription burns relay rate limits and causes unpredictable startup latency under rapid reconnects.
- Modules that need history call `fetchKindHistory()` intentionally with a defined goal and stop when they find it.

**Why per-kind history fetching:**
- Relays cannot filter by encrypted content. Without per-kind allocation, fetching "status events" for a peer means receiving all kind 5001 events and filtering client-side — wasting rate-limit tokens on irrelevant events.
- With dedicated kinds (5001–5011), a fetch for kind 5004 returns only status events; a fetch for kind 5010 returns only trigger notifications. One request returns exactly what was sought.

---

#### `NostrController.fetchKindHistory()` — Progressive, Caller-Controlled

```typescript
interface HistoryFetchOptions {
  windowStart?: number;  // Unix seconds. Default: now - 2 days
  windowEnd?: number;    // Unix seconds. Default: now
}

async function* fetchKindHistory(
  contactId: string,
  kind: number,
  opts?: HistoryFetchOptions
): AsyncGenerator<NostrEvent>
```

`contactId` is a UUID identifying the paired or temp contact. The relay list and channel key are resolved internally from `ContactManager` — the caller never handles either. Each `next()` call issues one fan-fetch round. Results are yielded newest-first, decrypted before delivery.

**Relay selection — internal, fan-fetch pool:**

`ContactManager.get(contactId).outboundRelayList` is the fan-fetch pool — the relays where the contact publishes. Every non-cooldown relay in the pool receives a `limit: 1` REQ simultaneously per round. Responses are deduplicated by event ID. A relay in cooldown is skipped for that round and re-evaluated next round.

**How each round works:**

```
initial:  cursor = windowEnd (now)
          floor  = windowStart (now - 2 days)
          relays = ContactManager.get(contactId).outboundRelayList

Round:
  1. For each relay in relays not in cooldown (RelayStateController.eligibleFrom):
       send REQ { kinds: [kind], authors: [inboundChannelPubkey], since: floor, until: cursor, limit: 1 }
     All eligible relays queried simultaneously.

  2. Collect responses. Deduplicate by event ID.
     Each relay records 1 token consumed and sets its own cooldown:
       relay.cooldownUntil = now + (60_000 / relay.limit)

  3. Yield each unique event to caller (newest-first).
     Caller breaks if done; otherwise calls next().

  4. If any events were returned:
       cursor = min(event.created_at) - 1   (oldest seen → move backward)
     If no events returned from any relay:
       stop (window exhausted)

  5. Before next round: wait for the shortest remaining cooldown
     among all relays in the pool. Then re-evaluate which are eligible.
     Stop if cursor ≤ floor.
```

**Rate-limit accounting per round:** each relay that participates consumes 1 token from its own bucket. Relays with shorter cooldowns re-enter the pool sooner. A relay that returns a rate-limit error sets a longer `cooldownUntil` (from the relay's `resetAfterSec` hint); other relays in the pool are unaffected.

**Rate-limit cost model for received events:**

Each event received from a history fetch consumes one relay rate-limit token — the same cost as any other event (published or received). The inter-request delay is:

```
delayMs = receivedCount × (60_000 / relayRatePerMinute)
```

At 30 events/minute: receiving 1 event → 2 second delay. Receiving 5 events → 10 seconds. This means `limit: 1` (the default) paces history fetches at the relay's natural rhythm — no burst, no special-casing.

---

#### Caller Usage Examples

**Example 1: Find the most recent relay migration proposal**

```typescript
// Caller knows the contactId only — relay list and channel key are internal
for await (const event of nostrController.fetchKindHistory(contactId, 5005)) {
  const msg = event.decryptedPayload as RelayMigrationPayload;
  if (!msg.isResponse) {
    applyPendingRelayMigration(msg);
    break;
  }
}
```

**Example 2: Get last known peer status since last online**

```typescript
const lastOnlineSec = getLastOnlineTimestamp();

for await (const event of nostrController.fetchKindHistory(contactId, 5004,
  { windowStart: lastOnlineSec }
)) {
  const msg = event.decryptedPayload as StatusPayload;
  if (!msg.isResponse) {
    setLastKnownStatus(contactId, msg.state, event.created_at);
    break;
  }
}
```

**Example 3: Scan a range until a session is found**

```typescript
for await (const event of nostrController.fetchKindHistory(contactId, 5001,
  { windowStart: now() - 2 * 86400 }
)) {
  const msg = event.decryptedPayload as RtcSessionPayload;
  if (msg.sessionId === activeSessionId) {
    restoreSession(msg);
    break;
  }
}
```

---

#### Per-Kind Fetch Strategies

| Kind | When to call fetchKindHistory | Goal | Stop condition |
|------|------------------------------|------|----------------|
| 5001 (RTC Session) | Reconnecting mid-session | Find active session offer | Found matching `sessionId` |
| 5004 (Status) | Came online after absence | Last known peer state | First announcement (`isResponse=false`) found |
| 5005 (Relay Migration) | Startup check | Pending relay migration | First unacknowledged proposal found |
| 5010/5011 (Actions) | Came online after absence | All missed actions | `windowStart` reached (full range) |

Modules that need "the most recent X" break on first match. Modules that need "all events in a range" iterate the full generator to `windowStart`. In both cases the fan-fetch behavior is invisible to the caller — events arrive one at a time, deduplicated.

---

#### Key Invariants

- **Subscriptions are T+0 only** — `subscribe()` never replays history. `since: now` is always enforced.
- **One request per `next()` call** — `fetchKindHistory()` issues exactly one relay request per generator step. No parallel in-flight requests per kind.
- **Received events consume rate-limit tokens** — Each received event delays the next request by `1 / ratePerMinute` minutes. Rate limits are shared between publishing and history fetching.
- **Caller controls continuation** — `break` stops the generator immediately; no further requests are issued.
- **Newest first** — Results within each request are yielded newest-first. A caller needing "the most recent" breaks on the first yield without seeing stale events.
- **Default window is 2 days** — History never goes beyond `now - 2 days` unless explicitly extended via `windowStart`.
- **`limit: 1` per relay per round, always** — Each relay in the fan-fetch pool receives a single-event REQ per round. This is not caller-configurable; it keeps rate-limit cost predictable and prevents any one relay from being asked to do bulk work.

---

### Pattern 4: Request-Response over Nostr (e.g., viewer requests segment from monitor)

```typescript
// Viewer side: send request, wait for response via signal router
const requestEvent = buildSegmentRequestSignal({ segmentId });
const responsePromise = listenForResponse('segment-meta', requestId, timeoutMs);

publish(requestEvent);  // via signal-router subscription

const response = await responsePromise;
```

**Rules:**
- Use request-response ONLY for critical queries (coverage maps, segment metadata)
- Always have a timeout (don't wait forever)
- Include `requestTime` or `requestId` in request for correlation
- Response handler filters by ID/timestamp to match request

---

### Pattern 5: Signal Router (Long-Lived Subscription)

The signal router is managed entirely inside `NostrClient`. Modules start it with a callback and receive decoded, decrypted signals — no relay or channel key management required.

```typescript
// Start the signal router — all relay subscriptions managed internally
nostrController.startSignalRouter((contactId, kind, payload) => {
  // contactId: UUID identifying which contact sent this (paired or temp)
  // kind: 5001–5005
  // payload: already decrypted and parsed
  routeSignal(contactId, kind, payload);
});

// Stop on app shutdown
onDestroy(() => nostrController.stopSignalRouter());
```

**What the router does internally:**
- Subscribes T+0 on all relays in `ContactManager.allMyInboundRelays()` — covers both paired and temp contacts
- Filters for all registered peers' inbound channel keys
- Deduplicates by event ID
- Decrypts and delivers to `onSignal` callback
- When a peer is registered or updated (`updatePeerRelays`), the router re-subscribes automatically

**Rules:**
- Modules never manage subscriptions, relay lists, or channel keys
- History catch-up happens via `fetchKindHistory()` — the router handles only T+0

---

### Pattern 6: Full-Range History Fetch (e.g., catch up on missed actions)

For collecting all events in a window rather than stopping at the first match, iterate the full generator without breaking. The contact's relay list and channel key are resolved internally — the caller only passes `contactId` and `kind`.

```typescript
// Catch up on all missed trigger events from a paired monitor since last online
const missedActions: NostrEvent[] = [];
const lastOnlineSec = getLastOnlineTimestamp();

for await (const event of nostrController.fetchKindHistory(monitorContactId, 5010,
  { windowStart: lastOnlineSec }
)) {
  missedActions.push(event);
  // No break — collect everything in the window
}

// Events arrive newest-first; reverse for chronological processing
for (const event of missedActions.reverse()) {
  handleTriggerEvent(event);
}
```

**Rules:**
- Generator stops automatically when `windowStart` is reached or all relays return empty
- Rate-limit cost and relay pacing are automatic via `RelayStateController`
- Events arrive newest-first; reverse if chronological processing is needed

---

## Integration Patterns

### TriggerPublisher

`TriggerPublisher` is the pipeline component that sends action signals (kinds 5010, 5011) to specific paired contacts. It uses the same `publishSignal(contactId, kind, payload)` path as all other post-pairing communication — channel keys and relay selection are internal to `NostrClient`.

```typescript
class TriggerPublisher {
  constructor(
    private nostrClient: NostrClient,
    private contactManager: ContactManager,
  ) {}

  fire(kind: 5010 | 5011, payload: object, config: ActionSignalConfig) {
    const targets = this.resolveTargets(config);
    for (const contactId of targets) {
      // publishSignal queues and rate-paces; relay + key selection is internal
      this.nostrClient.publishSignal(contactId, kind, payload);
    }
  }

  private resolveTargets(config: ActionSignalConfig): string[] {
    const paired = this.contactManager.allContactIds()
      .filter(id => !this.contactManager.get(id).expiresAt);

    if (config.recipients === 'specific') {
      return paired.filter(id => config.contactIds.includes(id));
    }
    return paired; // 'all'
  }
}
```

---

### Signal Publishing

```typescript
// Status announcement — time-sensitive, direct
await nostrController.publishSignalDirect(contactId, 5004, { state: 'online', isResponse: false });

// Trigger notification — queued, rate-safe
nostrController.publishSignal(contactId, 5010, { actionId, detectedAt });
```

---

### RTC Signaling

```typescript
// Viewer initiates — kind 5001, offer-request
await nostrController.publishSignalDirect(monitorId, 5001, { mode: 'data', sessionId, isResponse: false });

// Monitor responds via signal router callback — kind 5001 isResponse=true (SDP offer)
// arrives in onSignal(monitorId, 5001, { sdp, sessionId, isResponse: true })

// Viewer answers — kind 5002
await nostrController.publishSignalDirect(monitorId, 5002, { sdp: answerSdp, isResponse: false });
```

---

## Testing Patterns

### Unit Test: PublishQueue

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PublishQueue } from '$lib/nostr/client';

describe('PublishQueue', () => {
  it('respects rate limits', async () => {
    const queue = new PublishQueue(relayUrls, rateLimitMsPerEvent);
    const published: string[] = [];
    
    queue.on('published', (event) => published.push(event.id));
    
    // Queue 10 events
    for (let i = 0; i < 10; i++) {
      queue.add({ ...mockEvent, content: `msg-${i}` });
    }
    
    // Flush should space them out
    const startTime = Date.now();
    await queue.flush();
    const elapsed = Date.now() - startTime;
    
    expect(published).toHaveLength(10);
    expect(elapsed).toBeGreaterThan(rateLimitMsPerEvent * 9);
  });

  it('clears queue on goOffline', () => {
    const queue = new PublishQueue(relayUrls);
    queue.add(mockEvent);
    queue.add(mockEvent);
    
    queue.clear();
    expect(queue.pending).toHaveLength(0);
  });
});
```

---

### Unit Test: SubscriptionManager

```typescript
describe('SubscriptionManager', () => {
  it('dedupes by event ID', () => {
    const received: string[] = [];
    const sub = mgr.subscribe([{ kinds: [5001] }]);
    sub.on('event', (e) => received.push(e.id));
    
    // Emit same event twice
    sub._handleEvent(mockEvent);
    sub._handleEvent(mockEvent);  // same ID
    
    expect(received).toHaveLength(1);
  });

  it('closes subscription after no activity', async () => {
    const sub = mgr.subscribe([{ kinds: [999] }]);
    // auto-cleanup fires after 30s idle; simulate by calling unsubscribe
    mgr.unsubscribe(sub);
    expect(mgr.active).toHaveLength(0);
  });
});
```

---

### Integration Test: Publish + Subscribe

```typescript
describe('NostrClient (integration)', () => {
  it('publishes event and subscriber receives it', async () => {
    const client = new NostrClient(relayUrls, privkey, pubkey);
    
    const received: string[] = [];
    const sub = client.subscribe([{ kinds: [5001] }]);
    sub.on('event', (e) => received.push(e.content));
    
    const event = buildTestEvent({ kinds: [5001], content: 'hello' });
    await client.publish(event);
    
    await waitFor(() => received.includes('hello'));
    expect(received).toContain('hello');
  });
});
```


---

## Key Invariants

- **Modules interact with contact identity only** — no relay lists, channel keys, NIP-59 layers, or raw Nostr events outside `NostrClient`. `ContactManager` holds all relay and key state internally.
- **`ContactManager` is the single source of truth** — covers paired devices (permanent, ECDH keys, IDB) and temp contacts (ephemeral keys, memory-only, giftwrap-derived). Relay migration flows through `updatePairedRelays()`; temp contact expiry is automatic. All operations resolve through it.
- **Gift wrap and channel-key contacts are unified** — `sendGiftWrap(contactId, payload)` and `publishSignalDirect(contactId, kind, payload)` use the same routing. Null `outboundChannelKey` means address to real pubkey (initial contact); non-null means address to channel key (paired or gift-wrap reply).
- **Never publish when `nostrOnline = false`** — gate checked before any outbound operation
- **`publishSignal` is the default** — `publishSignalDirect` only for time-sensitive signals (status, RTC handshake)
- **Subscriptions are T+0 only** — signal router always opens with `since: now`; no history replay
- **History via `fetchKindHistory(contactId, kind)`** — relay and channel key resolved internally; caller passes contactId and kind only
- **Single-relay writes, fan-fetch reads** — publish goes to one relay (LRU-eligible from peer's list via `RelayStateController`); `fetchKindHistory` fan-fetches `limit:1` from all non-cooldown relays per round, deduplicates, yields one at a time
- **Cooldown is global per relay URL** — `RelayStateController` is shared across all peers and all operation types; one peer's rate-limit hit affects relay availability for all other peers on that relay
- **Signal kinds are never multiplexed** — each signal type has its own kind (5001–5005 for connection/presence, 5010–5011 for action notifications); route on kind number, not decrypted payload. The signal router subscribes to all of these.
- **`isResponse` replaces request/response type pairs** — `false` = initiating party, `true` = responding party
- **All queue operations are non-blocking** — `publishSignal` returns immediately; events flow out on timer with cooldown-aware relay selection
