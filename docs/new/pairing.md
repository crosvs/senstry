# Device Pairing

Pairing is the process by which two devices establish a `PairedContact` relationship — exchanging identity pubkeys, device pubkeys, and relay lists so they can derive shared ECDH channel keys and communicate without ever exposing real pubkeys on Nostr.

Three methods exist for establishing that relationship:

| Method | TOTP | When to use |
|---|---|---|
| QR-based | Optional | Physical co-location; most common |
| TOTP Mailbox | Required | Remote invite over Nostr (no physical proximity) |
| Programmatic | Required | API / headless automation |

TOTP is also used independently of pairing as an authorization layer for Remote Commands (kind 5006) sent over existing `PairedContact` channel keys. These two uses — pairing delivery and command authorization — share the same credential infrastructure but serve different purposes.

---

## QR-Based Pairing

### Overview

The monitor generates a QR containing an ephemeral invite key and its own identity information. The viewer scans locally, derives a temporary channel key, encrypts an acceptance message, and publishes it to the monitor's relays. No real pubkeys appear on Nostr until after the monitor decrypts the acceptance. The QR itself is public-safe; it contains no secrets.

```
Monitor                                        Viewer
  │                                              │
  │  1. Generate ephemeral invite keypair        │
  │     (ik_priv, ik_pub)                        │
  │                                              │
  │  2. Encode QR: { ik, pk, dpk, relays, ttl } │
  │  ─────────────── QR display ──────────────►  │
  │                                              │
  │                                3. Scan QR   │
  │                   4. tempKey = ECDH(viewer_priv, ik) │
  │                   5. Encrypt acceptance     │
  │                      { viewerPubkey, viewerDevicePubkey, viewerRelays }  │
  │                   6. Sign with ephemeral key │
  │  ◄───────── kind 5100 to monitor relays ──── │
  │                                              │
  │  7. Decrypt with ik_priv                     │
  │  8. Derive channel keys from device keys     │
  │  9. Store as PairedContact                   │
  │                                              │
  │  (Viewer derives identical channel keys)     │
```

### QR Payload

```typescript
interface QRPayload {
  v: 2;
  ik: string;       // ephemeral invite pubkey (hex, 64 chars)
  pk: string;       // monitor's real identity pubkey (hex, 64 chars)
  dpk: string;      // monitor's device pubkey — used for channel key derivation
  relays: string[]; // monitor's listening relays
  id: string;       // invite UUID
  ttl: number;      // unix timestamp of expiry (now + 300)
  label?: string;   // optional self-label ("Living Room Camera")
}
```

The payload encodes into a `senstry://pair?...` URI embedded in the QR image. The TTL is a unix expiry timestamp, not a duration — the viewer validates `now > ttl` locally without any network call.

### Viewer Acceptance (Scanner Side)

On scan, the viewer validates the payload, derives a temporary channel key for the acceptance only, encrypts the acceptance message, and signs with a fresh ephemeral key (hiding the viewer's real pubkey from the relay):

```typescript
// Derive temporary channel key — used only for this acceptance, then discarded
const tempChannelSecret = getConversationKey(viewerPrivkey, qrPayload.ik);

const acceptancePayload: QRAcceptancePayload = {
  type: "qr-acceptance",
  viewerPubkey: viewerRealPubkey,
  viewerDevicePubkey: viewerDevicePubkey,
  viewerRelays: viewerRelays,
  timestamp: Math.floor(Date.now() / 1000),
  inviteId: qrPayload.id,
};

const encryptedContent = nip44Encrypt(JSON.stringify(acceptancePayload), tempChannelSecret);
const ephemeralPrivkey = generateSecretKey();

const acceptanceEvent = finalizeEvent(
  {
    kind: 5100,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", qrPayload.pk],
      ["invite", qrPayload.id],
      ["v", "2"],
    ],
    content: encryptedContent,
  },
  ephemeralPrivkey,
);
```

The event is published to all relays in `qrPayload.relays`. At least one successful delivery is sufficient; the viewer retries on failure.

After publishing, the viewer derives post-pairing channel keys using device keys and stores a `PairedContact`:

```typescript
const sharedSecret = getConversationKey(viewerDevicePrivkey, qrPayload.dpk);
const inboundChannelKey = deriveChannelKey(sharedSecret, qrPayload.dpk, viewerDevicePubkey);
const outboundChannelKey = deriveChannelKey(sharedSecret, viewerDevicePubkey, qrPayload.dpk);
```

### Monitor Reception

The monitor opens a kind 5100 subscription immediately after generating the QR. For each received event, it attempts decryption using the ephemeral invite privkey. Successful decryption proves the sender scanned this specific QR — each active invite has a distinct ephemeral key:

```typescript
const decrypted = nip44Decrypt(
  event.content,
  getConversationKey(ephemeralInvitePrivkey, event.pubkey),
);
const acceptance = JSON.parse(decrypted);

if (acceptance.type !== "qr-acceptance") return;
if (acceptance.inviteId !== qrPayload.id) return;   // secondary correlation check
if (acceptanceHandlers.has(event.id)) return;        // deduplication

const acceptanceAgeSec = Math.floor(Date.now() / 1000) - acceptance.timestamp;
if (acceptanceAgeSec > 60) return;
```

On success, the monitor derives identical channel keys from its own device keys:

```typescript
const sharedSecret = getConversationKey(monitorDevicePrivkey, acceptance.viewerDevicePubkey);
const inboundChannelKey = deriveChannelKey(sharedSecret, acceptance.viewerDevicePubkey, monitorDevicePubkey);
const outboundChannelKey = deriveChannelKey(sharedSecret, monitorDevicePubkey, acceptance.viewerDevicePubkey);
```

### Key Derivation

Channel keys are derived from both device keypairs using the ECDH derivation defined in [contact-model.md](contact-model.md) — the monitor and viewer independently arrive at the same directional key pair.

### Post-Contact Transition

After pairing completes, both devices discard the ephemeral and temporary keys. All subsequent signals (kind 5001–5006, 5010–5011) are signed with channel keypubkeys and NIP-44 encrypted over the shared channel key. Neither identity pubkeys nor device pubkeys appear on Nostr again.

### Acceptance Message Format (Kind 5100)

```typescript
interface QRAcceptancePayload {
  type: "qr-acceptance";
  viewerPubkey: string;       // viewer's real identity pubkey
  viewerDevicePubkey: string; // viewer's device pubkey (channel key derivation input)
  viewerRelays: string[];     // where monitor sends signals to viewer
  timestamp: number;          // unix seconds
  inviteId: string;           // echoed from QR payload
}
```

The kind 5100 event is signed with a fresh ephemeral key per acceptance — the viewer's real pubkey is inside the encrypted payload, invisible to the relay.

### Security Considerations

**QR interception** — An attacker who scans the QR before the intended viewer can send their own acceptance. The monitor would pair with the attacker's pubkey. Mitigation: display QR in a physically controlled context; TTL limits the window; the user confirms the paired device name on both sides.

**Relay eavesdropping** — The acceptance event is encrypted with the temporary channel key. The relay sees only an ephemeral pubkey and opaque ciphertext.

**Acceptance forgery** — A forger can encrypt a valid-looking acceptance payload and publish it. However, Nostr signature validation ensures the event is signed consistently. The monitor's decryption succeeds only with the specific ephemeral invite privkey. A successful forgery would pair the monitor with the forger's own pubkey (not someone else's), so the forger gains only a pairing to themselves.

**Relay censorship** — Fanout to all relays in the QR payload; at least one must succeed. The viewer retries by rescanning the QR.

**Replay** — The monitor deduplicates by event ID and checks `acceptance.timestamp` is within 60 seconds of now. Stale replays are rejected.

---

## TOTP Mailbox Pairing

### Overview

TOTP Mailbox pairing delivers an invite over Nostr without exposing either device's real pubkey on any relay. Both devices derive a shared mailbox keypair from a TOTP seed exchanged out-of-band. The sender addresses the event to the mailbox pubkey; the recipient subscribes to it. No real pubkeys are used for routing. The result is a `TempContact` that transitions to a `PairedContact` after the acceptance flow completes.

The mailbox is one-shot: once the recipient processes a valid event, the subscription closes and the keypair is discarded.

### Mailbox Keypair Derivation

Both sender and recipient derive the same mailbox keypair from the TOTP seed using the derivation defined in [contact-model.md](contact-model.md).

The TOTP seed plays two roles simultaneously: it derives the routing keypair (which Nostr pubkey the recipient subscribes to), and it is the credential source for the TOTP code embedded in the delivery event. These roles operate on different derived values at different stages; they do not conflict.

### Sender Behavior

The sender generates a fresh ephemeral keypair per delivery. This ephemeral pubkey becomes the return address (`replyKey`) — the recipient uses it as the outbound channel pubkey for the resulting `TempContact`:

```typescript
async function publishMailboxDelivery(
  totpSeed: Uint8Array,
  invitePayload: object,
  publishRelays: string[],
): Promise<void> {
  const { mailboxPubkey } = deriveMailboxKeypair(totpSeed);

  const ephemeralPrivkey = generateSecretKey();
  const ephemeralPubkey = getPublicKey(ephemeralPrivkey);
  const totpCode = generateCurrentTOTPCode(totpSeed);

  const content = JSON.stringify({
    ...invitePayload,
    replyKey: ephemeralPubkey,
    credential: totpCode,
    created_at: Math.floor(Date.now() / 1000),
  });

  const conversationKey = getConversationKey(ephemeralPrivkey, mailboxPubkey);
  const encryptedContent = nip44Encrypt(content, conversationKey);

  const event = finalizeEvent(
    {
      kind: 5201,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", mailboxPubkey]],
      content: encryptedContent,
    },
    ephemeralPrivkey,
  );

  for (const relay of publishRelays) {
    await publish(event, { relay, timeout: 5000 });
  }
}
```

The sender's real identity key never touches the event. The relay sees: ephemeral pubkey, kind 5201, a `#p` tag pointing to the mailbox pubkey, opaque ciphertext.

### Recipient Behavior

The recipient derives the same mailbox keypair and opens a subscription filtered by `#p: mailboxPubkey` (see [nostr-client.md](nostr-client.md) for the `subscribeToTOTPMailbox` API). On receiving a kind 5201 event, it decrypts, validates the TOTP credential, and creates a `TempContact`:

```typescript
async function onMailboxDelivery(
  event: NostrEvent,
  mailboxPrivkey: Uint8Array,
  totpSeed: Uint8Array,
  listenRelays: string[],
  onDelivery: (tempContactId: string) => void,
): Promise<void> {
  try {
    const conversationKey = getConversationKey(mailboxPrivkey, event.pubkey);
    const plaintext = nip44Decrypt(event.content, conversationKey);
    const payload = JSON.parse(plaintext);

    const age = Math.floor(Date.now() / 1000) - payload.created_at;
    if (age > (payload.ttl ?? 3600)) return;

    const credentialValid = verifyTOTPCode(totpSeed, payload.credential);
    const credentialId = await lookupCredentialIdBySeed(totpSeed);
    await recordTOTPAttempt(credentialId, credentialValid);

    if (!credentialValid) return;

    // A TempContact is registered from the validated delivery, using the sender's
    // ephemeral pubkey as the outbound channel key (see contact-model.md).
    // The mailbox subscription closes immediately after registration.
    const tempContactId = registerTempContact({
      senderEphemeralPubkey: payload.replyKey,
      senderRelays: payload.replyRelays,
      myListenRelays: listenRelays,
      expiresAt: Date.now() + (payload.ttl ?? 3600) * 1000,
    });

    onDelivery(tempContactId);
  } catch {
    // Decryption failure or parse error — not for us; skip silently
  }
}
```

### Nostr-Delivered Invite Flow

1. Monitor and viewer share a TOTP seed out-of-band (verbal, QR of seed only, secure message).
2. Monitor calls `publishMailboxDelivery(totpSeed, invitePayload, relays)` → kind 5201 event addressed to `mailboxPubkey`.
3. Viewer calls `subscribeToTOTPMailbox(totpSeed, relays, onDelivery)` → subscribes to `#p: mailboxPubkey`.
4. Viewer receives kind 5201, decrypts, validates TOTP credential → creates `TempContact` with ephemeral channel keypair.
5. Viewer sends kind 5100 acceptance over the `TempContact` channel keys — same acceptance format as QR pairing.
6. Monitor receives kind 5100, derives ECDH channel keys, stores as `PairedContact`.
7. Both sides now have a `PairedContact`. The `TempContact` on the viewer side is replaced.

### Security Properties

| Property | Kind 5201 (TOTP Mailbox) |
|---|---|
| Relay sees recipient identity | No — mailbox pubkey is HKDF-derived from seed, not real pubkey |
| Relay sees sender identity | No — sender signs with ephemeral key |
| Credential bound to delivery | Yes — TOTP code in payload, validated before TempContact is created |
| Replay protection | Yes — TOTP window (30s); payload TTL enforced |
| Real pubkeys on relay | No — first real pubkey appears inside encrypted kind 5100 acceptance |
| One-shot | Yes — subscription closes after first valid delivery |

**Recovery:** If the kind 5201 event is lost in transit, the sender republishes with a fresh TOTP code. The recipient's mailbox subscription remains open until TTL elapses. If the recipient was offline when the event arrived, it is delivered from relay storage on reconnect — as long as the event's `created_at` is within TTL.

---

## Programmatic Pairing

Programmatic pairing follows the TOTP Mailbox flow but the TOTP seed acts as a bearer token rather than a human-entered code. The monitor generates a pairing secret and derives a TOTP seed; the client includes the seed (or a current TOTP code) directly in its pairing API request. The monitor validates via `verifyRawSeed` or `verifyTOTPCode` before completing the pairing exchange.

TOTP is required because API calls are stateless — there is no session context to verify the caller's intent. The seed is the shared secret.

---

## TOTP: Credential Infrastructure

### Architectural Clarity

TOTP is an authorization layer, not a pairing method. It validates that a remote party knows a shared secret at a specific moment. The pairing protocol — ephemeral key generation, temporary channel derivation, acceptance message, ECDH channel key derivation — is independent of TOTP. TOTP adds a credential check on top of an already-encrypted channel or delivery mechanism.

| Aspect | Pairing Protocol | TOTP Layer |
|---|---|---|
| Scope | Identity exchange, key derivation | Credential validation only |
| Required | Yes (core pairing mechanism) | Depends on delivery method |
| Reusable | No | Yes — login, re-auth, remote commands |
| Affects pairing format | Yes | No |

### Seed Generation

```typescript
import { randomBytes } from "crypto";
import { base32 } from "rfc4648";

function generateTOTPSeed(): string {
  const seed = randomBytes(20);
  return base32.stringify(seed).replace(/=/g, "").toLowerCase();
}
```

Produces a 32-character base32 string representing 160 bits of entropy.

### Storage

```typescript
interface TOTPCredential {
  credentialId: string;
  seed: Uint8Array;       // raw 20 bytes, not base32
  createdAt: number;
  lastUsedAt?: number;
  label?: string;
  expiresAt?: number;     // null = no expiry
  maxAttempts?: number;
  failedAttempts: number;
  lockedUntil?: number;   // unix ms; cleared when now > lockedUntil
}
```

Stored in the `totp` IDB object store (keyPath: `credentialId`).

### 6-Digit Code Validation

RFC 6238 TOTP: 30-second time windows, ±1 window tolerance (covers 90 seconds total), SHA-1 HMAC, constant-time comparison:

```typescript
function verifyTOTPCode(seed: Uint8Array, code: string, window: number = 1): boolean {
  const cleanCode = code.replace(/\D/g, "");
  if (cleanCode.length !== 6) return false;

  const currentCounter = Math.floor(Date.now() / 1000 / 30);

  for (let offset = -window; offset <= window; offset++) {
    const expected = generateTOTPCodeForCounter(seed, currentCounter + offset);
    if (constantTimeEqual(cleanCode, expected)) return true;
  }

  return false;
}
```

### Raw Seed Validation

For programmatic access where the full seed is presented as a bearer token:

```typescript
function verifyRawSeed(storedSeed: Uint8Array, submittedSeed: string): boolean {
  const submitted = base32.parse(submittedSeed.toUpperCase().padEnd(40, "="));

  if (storedSeed.length !== submitted.length) return false;

  let result = 0;
  for (let i = 0; i < storedSeed.length; i++) {
    result |= storedSeed[i] ^ submitted[i];
  }

  return result === 0;
}
```

### Rate Limiting and Account Lockout

```typescript
async function recordTOTPAttempt(
  credentialId: string,
  codeValid: boolean,
): Promise<{ allowed: boolean; lockoutMs?: number }> {
  const db = await openDB();
  const cred = await db.get("totp", credentialId);
  if (!cred) return { allowed: false };

  const now = Date.now();

  if (cred.lockedUntil && now < cred.lockedUntil) {
    return { allowed: false, lockoutMs: cred.lockedUntil - now };
  }

  if (cred.lockedUntil && now >= cred.lockedUntil) {
    cred.failedAttempts = 0;
    cred.lockedUntil = undefined;
  }

  if (codeValid) {
    cred.failedAttempts = 0;
    cred.lockedUntil = undefined;
    cred.lastUsedAt = now;
  } else {
    cred.failedAttempts++;
    if (cred.maxAttempts && cred.failedAttempts >= cred.maxAttempts) {
      const backoffMs = Math.min(5000 * Math.pow(2, cred.failedAttempts - cred.maxAttempts), 3_600_000);
      cred.lockedUntil = now + backoffMs;
    }
  }

  await db.put("totp", cred);
  return { allowed: codeValid, lockoutMs: cred.lockedUntil ? cred.lockedUntil - now : undefined };
}
```

Exponential backoff starts at 5 seconds after `maxAttempts` failures, capped at 1 hour. The lockout window resets after it elapses.

### Credential Expiration and Cleanup

```typescript
function isTOTPCredentialValid(cred: TOTPCredential): boolean {
  if (cred.expiresAt && Date.now() > cred.expiresAt) return false;
  return true;
}

async function cleanupExpiredTOTPCredentials(): Promise<number> {
  const db = await openDB();
  const all = await db.getAll("totp");
  let deleted = 0;
  for (const cred of all) {
    if (!isTOTPCredentialValid(cred)) {
      await db.delete("totp", cred.credentialId);
      deleted++;
    }
  }
  return deleted;
}
```

Cleanup runs on app startup. Credentials with `expiresAt: null` (no expiry) are permanent unless explicitly deleted.

### TOTP as Authorization for Remote Commands

Kind 5006 carries TOTP-authorized instructions over established contact channels. The channel key proves identity (only the paired device can encrypt a message decryptable with the shared key); the TOTP credential proves authorization (the sender knows the shared seed at this exact moment). These two factors are delivered through different mechanisms at different times, so intercepting channel traffic alone is insufficient to forge a valid command. See [signal-exchange.md](signal-exchange.md) for the full `RemoteCommandController` specification and flow.

---

## Event Kind Reference

| Kind | Name | Direction |
|---|---|---|
| 5100 | QR/Mailbox Acceptance | Viewer → Monitor relays (during pairing) |
| 5201 | TOTP Mailbox Delivery | Monitor → mailbox pubkey (pre-contact) |
| 5006 | Remote Command | Either paired device → peer (post-contact) |

Kind 5201 is handled by a one-shot mailbox subscription (`{ kinds: [5201], "#p": [mailboxPubkey] }`), not by the signal router. Kind 5006 flows through the signal router. Kinds 5100 and 5201 do not — they use dedicated subscriptions opened during the pairing flow and are closed once the flow completes. See [signal-exchange.md](signal-exchange.md) for the router's kind allocation.
