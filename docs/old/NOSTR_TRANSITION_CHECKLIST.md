# Nostr Redesign Transition Checklist

**Goal:** Replace NIP-59 gift-wrap with ECDH-derived channel keys for post-pairing signaling.

**Timeline:** 1–2 weeks  
**Testing:** Real paired devices (monitor + viewer)  
**Rollback Plan:** Keep kind 1059 subscription live during transition; remove after stable

---

## Phase 0: Pre-Implementation (Code Review)

- [ ] Read `docs/plans/nostr-redesign.md` completely (5 min overview)
- [ ] Read `docs/nostr-redesign-detailed-spec.md` for wire format and key derivation (20 min)
- [ ] Review current `nostr/crypto.ts` for ECDH usage: `getConversationKey(privkey, pubkey)`
- [ ] Review current `sendSignal()` in `nostr/client.ts` or `signal-router.ts`
- [ ] Review current `listenForSignals()` subscription pattern
- [ ] Identify test relays and test device pair for integration testing

**Deliverable:** Clear understanding of current gift-wrap flow and where changes need to happen.

---

## Phase 1: Implement Channel Key Derivation

### 1.1: Add `deriveChannelKey()` to `nostr/crypto.ts`

```typescript
import { sha256 } from '@noble/hashes/sha256';

export function deriveChannelKey(
  sharedSecret: Uint8Array,
  senderPubkey: string,
  recipientPubkey: string
): Uint8Array {
  const domain = utf8Encode('senstry-channel-v1');
  const senderBytes = hexToBytes(senderPubkey);
  const recipientBytes = hexToBytes(recipientPubkey);
  return sha256(concat(sharedSecret, domain, senderBytes, recipientBytes));
}
```

**Tests:**
- [ ] Same `(sender, recipient)` pair derives same key on both sides
- [ ] Swapped pairs (recipient → sender) derive different keys
- [ ] Key is deterministic (same inputs = same output)

### 1.2: Add unit tests to `nostr/crypto.test.ts`

```typescript
it('derives same channel key on both sides', () => {
  const secret = getConversationKey(alicePrivkey, bobPubkey);
  const aliceOutbound = deriveChannelKey(secret, alicePubkey, bobPubkey);
  const bobInbound = deriveChannelKey(secret, alicePubkey, bobPubkey);
  expect(aliceOutbound).toEqual(bobInbound);
});

it('reverses direction with swapped pubkeys', () => {
  const secret = getConversationKey(alicePrivkey, bobPubkey);
  const aliceOutbound = deriveChannelKey(secret, alicePubkey, bobPubkey);
  const aliceInbound = deriveChannelKey(secret, bobPubkey, alicePubkey);
  expect(aliceOutbound).not.toEqual(aliceInbound);
});
```

**Deliverable:** `deriveChannelKey()` is tested and working; both sides independently produce the same keys.

---

## Phase 2: Update Sending Path (sendSignal)

### 2.1: Locate `sendSignal()` implementation

Find where signals are currently sent (likely in `nostr/client.ts`, `webrtc/signaling.ts`, or `signal-router.ts`).

### 2.2: Update to use channel keys

**Before:**
```typescript
async function sendSignal(
  signal: SignalMessage,
  recipientPubkey: string,
  privkey: Uint8Array,
) {
  const wrapped = await wrapGiftWrap(signal, recipientPubkey, privkey);
  await publish(wrapped, { label: 'signal' });
}
```

**After:**
```typescript
async function sendSignal(
  signal: SignalMessage,
  recipientPubkey: string,
  privkey: Uint8Array,
  pairedDevice: PairedDevice,  // includes sharedSecret
) {
  const myPubkey = getPublicKey(privkey);
  const channelPrivkey = deriveChannelKey(pairedDevice.sharedSecret, myPubkey, recipientPubkey);
  const channelPubkey = getPublicKey(channelPrivkey);

  const event: Event = {
    kind: KIND_SIGNAL,  // 5001
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', channelPubkey]],
    content: await nip44Encrypt(
      JSON.stringify(signal),
      channelPrivkey,
      channelPubkey
    ),
  };

  await publish(event, { label: 'signal' });
}
```

**Rules:**
- Use honest `created_at` (system time, not randomized)
- Encrypt content once (NIP-44 between channel keys), not twice
- Sign with `channelPrivkey` (derived, not stored)
- Tag with `[['p', channelPubkey]]` (pseudonymous, not real pubkey)

### 2.3: Update all call sites

Find all places that call `sendSignal()` and ensure they pass `pairedDevice`:

```typescript
// In signal-router.ts or wherever signals are sent:
for (const device of pairedDevices) {
  await sendSignal(signal, device.pubkey, privkey, device);
}
```

- [ ] Offer request sends to paired device
- [ ] Offer sends to paired device
- [ ] Answer sends to paired device
- [ ] Live upgrade offer sends to paired device
- [ ] Live upgrade answer sends to paired device
- [ ] Status messages send to all paired devices

**Deliverable:** All signals use channel keys instead of gift-wrap.

---

## Phase 3: Update Receiving Path (listenForSignals)

### 3.1: Locate `listenForSignals()` implementation

Find where the kind 1059 subscription is currently opened (likely in `signal-router.ts`).

### 3.2: Update to subscribe by channel author

**Before:**
```typescript
const sub = subscribe(
  {
    kinds: [KIND_SIGNAL_WRAP],  // 1059 (kind)
    '#p': [myPubkey],           // recipient's real pubkey
  },
  relays,
  { onEvent: handleSignal },
);
```

**After:**
```typescript
// One subscription per paired device (or combine into single sub with authors array)
const subscriptions = pairedDevices.map(device => {
  const myPubkey = getPublicKey(privkey);
  const inboundChannelPubkey = deriveChannelKey(
    device.sharedSecret,
    device.pubkey,        // sender (paired device)
    myPubkey              // recipient (me)
  );

  return subscribe(
    {
      kinds: [KIND_SIGNAL],  // 5001
      authors: [inboundChannelPubkey],
      since: Math.floor(Date.now() / 1000) - 3600,  // 1 hour window
    },
    relays,
    { onEvent: handleSignal },
  );
});
```

**Rules:**
- Use `authors` filter (subscript by the peer's channel pubkey)
- Use 1-hour `since` window (from honest `created_at`)
- Keep a subscription per paired device (or combine into one with `authors: [key1, key2, ...]`)

### 3.3: Update signal decryption

**Before:**
```typescript
function handleSignal(event: Event) {
  const sealed = unwrapGiftWrap(event, privkey);  // two layers
  const signal = JSON.parse(sealed.content);
  // ...
}
```

**After:**
```typescript
function handleSignal(event: Event, pairedDevice: PairedDevice) {
  const myPubkey = getPublicKey(privkey);
  const inboundChannelPrivkey = deriveChannelKey(
    pairedDevice.sharedSecret,
    pairedDevice.pubkey,
    myPubkey
  );

  const decrypted = await nip44Decrypt(
    event.content,
    inboundChannelPrivkey,
    event.pubkey  // sender's channel pubkey
  );
  const signal = JSON.parse(decrypted);
  // ...
}
```

**Deliverable:** Signal router receives and decrypts channel-key signals correctly.

---

## Phase 4: Dual-Path Transition (Keep Both Live)

### 4.1: Open Both Subscriptions

During transition, keep the old gift-wrap subscription open alongside the new channel-key one:

```typescript
// Open new channel-key subscription (Phase 3)
const channelKeySubs = listenForChannelKeySignals(pairedDevices, privkey);

// Keep old gift-wrap subscription open
const giftWrapSub = subscribe(
  {
    kinds: [KIND_SIGNAL_WRAP],
    '#p': [getPublicKey(privkey)],
  },
  relays,
  { onEvent: (e) => handleSignal(e, 'old-path') },  // tag for debugging
);
```

### 4.2: Route Signals Based on Kind

```typescript
function handleSignal(event: Event, source: 'old-path' | 'new-path') {
  if (event.kind === KIND_SIGNAL_WRAP) {
    // Old path
    const sealed = unwrapGiftWrap(event, privkey);
    const signal = JSON.parse(sealed.content);
    // ...
    dbg('signal', `received via gift-wrap (${event.id.slice(0, 8)})`);
  } else if (event.kind === KIND_SIGNAL) {
    // New path
    const inboundPrivkey = deriveChannelKey(...);
    const decrypted = await nip44Decrypt(event.content, ...);
    const signal = JSON.parse(decrypted);
    // ...
    dbg('signal', `received via channel-key (${event.id.slice(0, 8)})`);
  }
}
```

- [ ] Logs distinguish old vs. new path
- [ ] Both paths decode signals identically
- [ ] No errors when receiving from either path
- [ ] Relay errors are monitored for both subscriptions

**Deliverable:** Both old and new signal paths work simultaneously. Devices on different versions can still communicate.

---

## Phase 5: Integration Testing

### 5.1: Test with Real Device Pair

Set up two test devices:

1. **Device A (monitor):** Run current main branch (gift-wrap)
2. **Device B (viewer):** Run with new code (channel keys + dual-path)

### 5.2: Test Scenarios

- [ ] **Pair**: A and B complete pairing flow
- [ ] **Live view**: B watches live stream from A → verify RTC handshake (offer/answer exchanges)
- [ ] **Data channel**: B requests coverage map from A
- [ ] **Segment fetch**: B fetches a segment from A
- [ ] **Live upgrade**: B requests live upgrade from data to live
- [ ] **Logging**: Logs show signals received via new channel-key path

### 5.3: Monitor Relay Activity

```bash
# On test relay logs:
# - Count kind 1059 events (old path)
# - Count kind 5001 events (new path)
# - Verify no errors from subscription filters
```

**Deliverable:** All core flows work with new channel-key path. Relay performs as expected.

---

## Phase 6: Swap Defaults and Remove Old Path

### 6.1: Make Channel Keys the Default

Once Phase 5 testing is stable (24–48 hours on real devices):

```typescript
// signal-router.ts
const preferChannelKeys = true;  // Feature flag

if (preferChannelKeys) {
  subscriptions = listenForChannelKeySignals(pairedDevices, privkey);
  sendSignal = sendSignalChannelKey;
} else {
  subscriptions = listenForGiftWrapSignals(myPubkey, privkey);
  sendSignal = sendSignalGiftWrap;
}
```

### 6.2: Remove Gift-Wrap Path

Once all paired devices are updated (at least 1 week in production):

```typescript
// Delete old functions:
// - sendSignalGiftWrap()
// - listenForGiftWrapSignals()
// - unwrapGiftWrap() [keep for reference, remove from hot path]

// Simplify sendSignal():
async function sendSignal(
  signal: SignalMessage,
  recipientPubkey: string,
  privkey: Uint8Array,
  pairedDevice: PairedDevice,
) {
  // Channel-key path only, no fallback
}
```

- [ ] Feature flag removed
- [ ] Old gift-wrap functions deleted
- [ ] No dead code paths

**Deliverable:** Channel-key signaling is the only path. ~40% reduction in Nostr events.

---

## Phase 7: Documentation Update

### 7.1: Update `CLAUDE.md`

Add under "Nostr Redesign Direction":

```
✅ POST-PAIRING SIGNALING: Switched to ECDH-derived channel keys (v1).
   - Wire format: NIP-44 encrypted (single layer) signed with derived channel privkey
   - Subscription: authors:[inboundChannelPubkey]
   - No re-pairing required; keys derived from existing pairedDevices
```

### 7.2: Update `docs/nostr.md`

- Update "Signal Event Format" section
- Remove gift-wrap details (keep for reference only)
- Add key derivation algorithm

- [ ] CLAUDE.md updated
- [ ] docs/nostr.md updated
- [ ] No stale references to gift-wrap in active code

**Deliverable:** Documentation reflects new signal path.

---

## Monitoring and Rollback

### Metrics to Watch (Phase 4 and Beyond)

1. **Relay request volume**: Should drop ~40% (fewer events)
2. **Signal latency**: Should be similar or faster (fewer encryptions)
3. **Relay errors**: Should not increase (filter changes are valid)
4. **Paired device compatibility**: Can old-client devices still connect?

### Rollback Plan

If issues arise during Phase 4–5:

1. **Revert `sendSignal()` to gift-wrap only** (one line: comment out channel-key path)
2. **Keep `listenForSignals()` dual-path** (accepting both kinds 1059 and 5001)
3. **Investigate root cause** (is filter wrong? Is key derivation off? Is relay filtering?)
4. **Fix and retry** when confident

**Rollback is safe:** Dual-path subscription means no messages are lost.

---

## Checklist: Ready for Production

- [ ] All tests pass (`npm run test`)
- [ ] Both paths work on real devices (24+ hours)
- [ ] Relay errors are 0 or expected
- [ ] Logs show signals coming from new path
- [ ] Documentation is updated
- [ ] Feature flag can be removed cleanly
- [ ] Old gift-wrap code is marked for deletion
- [ ] No performance regression
- [ ] Replay from relay does not cause re-processing issues (thanks to `created_at`)

---

## Key Differences from Current Implementation

| Aspect | Old (Gift-Wrap) | New (Channel Keys) |
|--------|-----------------|-------------------|
| Signal encryption | 2 layers (seal + wrap) | 1 layer |
| Sender identity (on relay) | Anonymous ephemeral key | Pseudonymous channel key |
| `created_at` | Randomized ±30 min | Honest timestamp |
| Subscription window | 1.6 hours | 1 hour |
| Key exchange at pairing | Implicit (wrapped in outer event) | None needed (ECDH-derived) |
| Re-pairing required | No | No |
| Events per message | 2 (offer + wrapper) | 1 |

---

## Questions

**Q: What if a relay doesn't support `authors` filtering?**

A: Some old relays might not. Use `until` filters or a `limit` as backup. In Phase 4, keep gift-wrap sub open so those relays still work.

**Q: Can I test this without a real paired device?**

A: Partially — you can unit test key derivation and encryption. But you need a real pair to test the signal flow (offer/answer exchange). Recommend using test relays for Phase 5.

**Q: Why honest `created_at` instead of randomized?**

A: Randomized timestamps were needed to hide correlation between sender and message (sender anonymity). With channel keys, both parties already know each other; honest timestamps enable relay `since` filters to work correctly and reduce the subscription window.

**Q: What about the initial pairing QR (kind 5000)?**

A: Unchanged. Real identity must be exchanged once; gift-wrap for anonymity during pairing remains appropriate.
