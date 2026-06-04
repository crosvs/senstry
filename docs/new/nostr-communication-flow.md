# Nostr Communication Architecture

---

## Overview

Senstry uses Nostr for two purposes:

1. **Device Pairing** — QR-based initial device discovery and TOTP-mailbox-based invite delivery for Nostr-delivered invites (ephemeral keys, temp contacts). Real pubkeys are used only at this layer.
2. **Peer-to-Peer Signals** — All post-contact communication, including connection setup, presence, relay migration, and action notifications. Every event is NIP-44 encrypted over ECDH channel keys. Real pubkeys never appear.

All post-contact Nostr events — whether TempContact or PairedContact — are signed with a contact's channel key, not their identity key. This applies to RTC handshake signals, status, relay migration proposals, and sensor-triggered action notifications alike.

---

## Contact Model

### TempContact vs PairedContact

Every communication peer in Senstry is represented as a contact. There are two contact types:

**TempContact** — created via TOTP mailbox (kind 5201). The contact uses a fresh ephemeral channel keypair generated at creation time, is held in memory only (not persisted to IDB), and expires once the TTL elapses or the pairing flow completes. TempContacts are one-shot: each TOTP mailbox interaction creates exactly one TempContact, and the mailbox subscription is closed immediately after.

**PairedContact** — created by completing an invite flow (QR, URI, or Nostr-delivered). The contact uses ECDH-derived channel keys (deterministic from both real pubkeys), is persisted to IDB, and has no expiry. PairedContacts survive app restarts; their channel keys are re-derived from stored identity pubkeys on load.

Both types expose an identical API. Callers never inspect the contact type — they pass a `contactId` and the contact manager resolves the correct keys and relays internally.

### Unified publishSignal API

```typescript
// The same call works for any contact — TempContact or PairedContact.
// Relay selection and key lookup are internal to ContactManager.
await nostrClient.publishSignal(contactId, kind, payload);
```

`publishSignal` resolves the contact's outbound channel keypair and relay list, NIP-44 encrypts the payload, signs the event with the channel key, and delivers to the selected relay. The kind number determines the signal type; the contactId determines routing.

`publishSignalDirect` has the same `(contactId, kind, payload)` signature but bypasses the queue and publishes immediately. Use it for time-sensitive signals — status announcements (kind 5004) and RTC handshake (kinds 5001, 5002) — where delay makes the signal useless. `publishSignal` is the default for everything else: trigger notifications, arm state, remote commands, relay migration proposals. All relay selection and encryption are internal regardless of which variant is used.

### What the Relay Sees

For any post-contact signal — whether from a TempContact or PairedContact — the relay sees only:

| Field     | Value                                                                   |
| --------- | ----------------------------------------------------------------------- |
| `pubkey`  | Pseudonymous channel pubkey (ECDH-derived or ephemeral; not real pubkey) |
| `kind`    | Signal kind number (5001–5006, 5010–5011)                               |
| `created_at` | Honest timestamp                                                     |
| `tags`    | Empty array                                                             |
| `content` | NIP-44 ciphertext (opaque to relay)                                     |

No real pubkeys appear. No p-tags appear in post-contact signals. The relay cannot determine who is communicating, in which direction, or what the content contains.

---

## Security Layer: Time-Based One-Time Passwords (TOTP)

### Overview

**TOTP** is a separate security layer for credential validation (not a pairing method). It can be used to securely over Nostr deliver an instruction with a payload, such as "Accept this invite QR/URI request", or other contexts requiring credential validation.

TOTP is an **optional credential validation layer** that is **independent of the pairing protocol**. It:

- Generates time-based seeds (20-byte random values)
- Validates 6-digit codes (RFC 6238, 30-second windows)
- Supports raw seed matching for programmatic access
- Applies rate limiting to prevent brute-force attacks
- Can be used with any pairing or authentication flow

**Key property:** TOTP validates credentials; it does **not** manage the pairing process. The same TOTP credential can be used with QR-based invites, Nostr-based delivery, or non-pairing contexts (login, re-authentication, etc.).

### TOTP Seed Generation and Storage

#### Generating a TOTP Seed

```typescript
import { randomBytes } from "crypto";
import { base32 } from "rfc4648";

/**
 * Generate a random TOTP seed for a new credential.
 *
 * @returns 20-byte seed as base32-encoded string (readable QR code)
 */
export function generateTOTPSeed(): string {
  const seed = randomBytes(20); // 160 bits (base32-encoded = 32 characters)
  return base32.stringify(seed).replace(/=/g, "").toLowerCase(); // 32-char alphanumeric
}

// Example output: "jbswy3dpeblw64tmmq4qy27kfq4qye4"
```

#### Storing TOTP Seeds in IDB

```typescript
interface TOTPCredential {
  credentialId: string; // UUID or internal identifier
  seed: Uint8Array; // Raw 20-byte seed (NOT base32)
  createdAt: number; // unix timestamp
  lastUsedAt?: number; // track usage
  label?: string; // "Pairing Code", "Login", etc.
  expiresAt?: number; // optional expiration (null = no expiry)
  maxAttempts?: number; // rate limit: max failed attempts
  failedAttempts: number; // counter for current lockout window
  lockedUntil?: number; // unix ms; clear when now > lockedUntil
}

// IDB schema: "totp" store (keyPath: 'credentialId')
async function storeTOTPSeed(seed: Uint8Array, label: string): Promise<string> {
  const credentialId = crypto.randomUUID();
  const credential: TOTPCredential = {
    credentialId,
    seed,
    createdAt: Date.now(),
    label,
    maxAttempts: 5,
    failedAttempts: 0,
  };

  // Store in IDB
  const db = await openDB();
  await db.put("totp", credential);

  return credentialId;
}
```

### TOTP Code Validation

#### Verifying a 6-Digit Code

```typescript
import { totp } from "speakeasy"; // or equivalent RFC 6238 implementation

/**
 * Verify a 6-digit TOTP code against a stored seed.
 * Implements 30-second time windows with ±1 window tolerance.
 *
 * @param seed Raw 20-byte seed (Uint8Array)
 * @param code 6-digit code entered by user
 * @param window Time window tolerance (default: ±1, covers 90 seconds total)
 * @returns true if code is valid
 */
export function verifyTOTPCode(
  seed: Uint8Array,
  code: string,
  window: number = 1,
): boolean {
  // Strip non-digits
  const cleanCode = code.replace(/\D/g, "");
  if (cleanCode.length !== 6) return false;

  // RFC 6238: time-step is 30 seconds, UNIX epoch 0
  const now = Math.floor(Date.now() / 1000);
  const timeStep = 30;
  const currentCounter = Math.floor(now / timeStep);

  // Check current window and ±N adjacent windows
  for (let offset = -window; offset <= window; offset++) {
    const counter = currentCounter + offset;
    const expectedCode = generateTOTPCodeForCounter(seed, counter);

    // Constant-time comparison to prevent timing attacks
    if (constantTimeEqual(cleanCode, expectedCode)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate TOTP code for a specific time counter.
 * Implements RFC 6238 HOTP with SHA-1 digest.
 */
function generateTOTPCodeForCounter(seed: Uint8Array, counter: number): string {
  const hmac = createHmac("sha1", seed);

  // Counter as big-endian 64-bit value
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  hmac.update(buffer);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226)
  const offset = digest[digest.length - 1] & 0x0f;
  const dyn =
    (digest[offset] << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  const code = (dyn & 0x7fffffff) % 1000000;

  return code.toString().padStart(6, "0");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
```

#### Verifying Raw Seeds (Programmatic Access)

When a device needs to validate a seed directly (e.g., bearer token, API credential):

```typescript
/**
 * Verify a raw seed value matches a stored seed.
 * Used for programmatic credential exchange (not TOTP codes).
 *
 * @param storedSeed Stored seed (Uint8Array, raw 20 bytes)
 * @param submittedSeed Seed as base32-encoded string (32 alphanumeric characters, no padding)
 * @returns true if seeds match
 */
export function verifyRawSeed(
  storedSeed: Uint8Array,
  submittedSeed: string, // Must be base32-encoded 32-character string
): boolean {
  let submitted: Uint8Array;

  if (typeof submittedSeed === "string") {
    // Decode base32 to bytes
    submitted = base32.parse(submittedSeed.toUpperCase().padEnd(40, "="));
  } else {
    submitted = submittedSeed;
  }

  // Constant-time comparison
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
/**
 * Track failed TOTP code attempts with exponential backoff lockout.
 */
export async function recordTOTPAttempt(
  credentialId: string,
  codeValid: boolean,
): Promise<{ allowed: boolean; lockoutMs?: number }> {
  const db = await openDB();
  const cred = await db.get("totp", credentialId);

  if (!cred) {
    return { allowed: false }; // Credential not found
  }

  const now = Date.now();

  // Check if currently locked
  if (cred.lockedUntil && now < cred.lockedUntil) {
    const lockoutMs = cred.lockedUntil - now;
    return { allowed: false, lockoutMs };
  }

  // Reset failed attempts if lockout window has passed
  if (cred.lockedUntil && now >= cred.lockedUntil) {
    cred.failedAttempts = 0;
    cred.lockedUntil = undefined;
  }

  if (codeValid) {
    // Valid code: reset counter, update lastUsedAt
    cred.failedAttempts = 0;
    cred.lockedUntil = undefined;
    cred.lastUsedAt = now;
  } else {
    // Invalid code: increment counter, apply lockout if threshold hit
    cred.failedAttempts++;

    if (cred.maxAttempts && cred.failedAttempts >= cred.maxAttempts) {
      // Exponential backoff: 2^failedAttempts * 5 seconds
      const baseMs = 5000;
      const backoffFactor = Math.pow(2, cred.failedAttempts - cred.maxAttempts);
      cred.lockedUntil = now + baseMs * backoffFactor;

      // Cap at 1 hour
      if (cred.lockedUntil - now > 3600000) {
        cred.lockedUntil = now + 3600000;
      }
    }
  }

  await db.put("totp", cred);

  return {
    allowed: codeValid && (!cred.lockedUntil || now >= cred.lockedUntil),
    lockoutMs: cred.lockedUntil ? cred.lockedUntil - now : undefined,
  };
}
```

### Credential Expiration and Cleanup

```typescript
/**
 * Validate a TOTP credential's freshness.
 *
 * @param cred TOTP credential
 * @returns true if credential is still valid (not expired)
 */
export function isTOTPCredentialValid(cred: TOTPCredential): boolean {
  const now = Date.now();

  if (cred.expiresAt && now > cred.expiresAt) {
    return false; // Credential has expired
  }

  return true;
}

/**
 * Clean up expired TOTP credentials.
 * Run periodically (e.g., on app startup).
 */
export async function cleanupExpiredTOTPCredentials(): Promise<number> {
  const db = await openDB();
  const allCredentials = await db.getAll("totp");

  let deleted = 0;
  for (const cred of allCredentials) {
    if (!isTOTPCredentialValid(cred)) {
      await db.delete("totp", cred.credentialId);
      deleted++;
    }
  }

  return deleted;
}
```

---

## QR-Based Device Pairing

### Overview

The **QR method** is a manual, one-time pairing mechanism designed for **initial device discovery**. It is **entirely local** until acceptance; Nostr is used only for sending the acceptance acknowledgment and subsequent communication setup. The method is secure, efficient, and requires no prior knowledge between devices.

**Key properties:**

- ✅ No gift-wrap needed (real pubkeys stay offline until acceptance)
- ✅ Ephemeral invite keys — never reused
- ✅ Direct ECDH + NIP-44 encryption (single layer)
- ✅ Consistent with post-contact channel key architecture
- ✅ QR encodes public data only (no secrets)
- ✅ Offline-tolerant (acceptance can be retried)

**Flow diagram:**

```
┌─────────────┐                                           ┌─────────────┐
│   Monitor   │                                           │   Viewer    │
└──────┬──────┘                                           └──────┬──────┘
       │                                                         │
       │ 1. Generate ephemeral invite key & QR                   │
       │    (contains: ephemeral_pubkey, monitor_pubkey,         │
       │     relay list)                                         │
       │                                                         │
       │ 2. Display QR (out-of-band: screen, print, etc.)        │
       │ ───────────────────────────────────────────────────►    │
       │                                                         │
       │     3. Scan QR locally (learns ephemeral_pubkey,        │
       │        monitor_pubkey, relays)                          │
       │                                                         │
       │     4. Derive temporary channel key                     │
       │        ECDH(viewer_privkey, ephemeral_invite_pubkey)    │
       │                                                         │
       │     5. Create acceptance message with:                  │
       │        viewer's real pubkey + relays                    │
       │     6. Encrypt with temporary key (NIP-44)              │
       │     7. Sign with ephemeral key                          │
       │     8. Publish to monitor's relays                      │
       │     ◄───────────────────────────────────────────────────┤
       │                                                         │
       │ 9.  Monitor receives on relays (listening)              │
       │ 10. Decrypt with ephemeral_invite_privkey               │
       │ 11. Extract viewer's real pubkey + relays               │
       │ 12. Store as pairedContacts[viewer_pubkey]               │
       │                                                         │
       │ 13. Derive channel keys (ECDH)                          │
       │ 14. Both derive identical keys (independent)            │
       │     - Monitor → Viewer: ECDH(monitor_privkey,           │
       │                              viewer_pubkey)             │
       │     - Viewer → Monitor: ECDH(viewer_privkey,            │
       │                              monitor_pubkey)            │
       │                                                         │
       │ 15. Post-pairing: All signals via channel keys          │
       │     (kind 5001) (no real pubkeys on Nostr)              │
       └──────────────────────────────────────────────────►      │
             ◄───────────────────────────────────────────────────┤
```

### QR Payload Data Structure

The QR encodes a **JSON-serializable payload** that is **public and safe to scan**:

```typescript
interface QRPayload {
  v: 2;           // Version (for future upgrades)
  ik: string;     // Invite key: ephemeral pubkey (hex, 64 chars)
  pk: string;     // Monitor's real identity pubkey (hex, 64 chars)
  dpk: string;    // Monitor's device pubkey (hex, 64 chars) — used for channel key derivation
  relays: string[]; // Monitor's listening relays
  id: string;     // Invite ID (UUID, opaque to scanner)
  ttl: number;    // Unix timestamp when QR expires (e.g., now + 300)
  label?: string; // Optional: monitor's self-label ("Living Room Camera", "Hallway", etc.)
}
```

**Encoding:**

```typescript
const payload: QRPayload = {
  v: 2,
  ik: ephemeralPubkey,      // ephemeral invite key's pubkey
  pk: monitorRealPubkey,    // monitor's identity pubkey
  dpk: monitorDevicePubkey, // monitor's device pubkey (used for channel key derivation)
  relays: ["wss://relay1.com", "wss://relay2.com"],
  id: crypto.randomUUID(),
  ttl: Math.floor(Date.now() / 1000) + 300, // unix expiry timestamp (now + 5 min)
  label: "Living Room Camera",
};

// Serialize to a compact URI string
const uri = `senstry://pair?${new URLSearchParams({
  v: payload.v.toString(),
  ik: payload.ik,
  pk: payload.pk,
  dpk: payload.dpk,
  relays: JSON.stringify(payload.relays),
  id: payload.id,
  ttl: payload.ttl.toString(),
  ...(payload.label && { label: payload.label }),
}).toString()}`;

// Encode into QR code (using qrcode library)
const qrDataUrl = await QRCode.toDataURL(uri);
```

**Why QR and not a link?**

- **QR is offline-safe**: Scanner doesn't need internet until acceptance
- **Expiration is local**: TTL is part of payload; scanner can validate without calling home
- **No network state leakage**: Scanning a QR doesn't ping any server
- **Familiar pattern**: Users expect QR for pairing (WiFi, Bluetooth, etc.)

### Viewer Acceptance (Scanner Side)

When a viewer scans the QR, they decode the payload locally and **derive a temporary channel key** for acceptance:

```typescript
async function acceptInviteFromQR(
  viewerPrivkey: Uint8Array,
  viewerDevicePrivkey: Uint8Array,
  viewerRealPubkey: string,
  viewerDevicePubkey: string,
  viewerRelays: string[],
  qrPayload: QRPayload,
): Promise<{ success: boolean; pairedMonitorPubkey?: string; error?: string }> {
  // ─── Step 1: Validate payload ───────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);

  // Check version
  if (qrPayload.v !== 2) {
    return { success: false, error: "Unsupported QR version" };
  }

  // ttl is a unix timestamp of expiry (set by monitor as now + 300)
  if (nowSec > qrPayload.ttl) {
    return { success: false, error: "QR code has expired" };
  }

  // Verify pubkey formats
  if (qrPayload.ik.length !== 64 || qrPayload.pk.length !== 64) {
    return { success: false, error: "Invalid pubkey format in QR" };
  }

  // ─── Step 2: Derive temporary channel key ───────────────────────────────
  // This key is derived from:
  //   - Viewer's privkey (known only to viewer)
  //   - Ephemeral invite pubkey (from QR)
  // The monitor independently derives the same key using:
  //   - Ephemeral invite privkey
  //   - Viewer's real pubkey (in the acceptance message)

  const tempChannelSecret = getConversationKey(viewerPrivkey, qrPayload.ik);

  // Verify it's a 32-byte key
  if (tempChannelSecret.length !== 32) {
    return { success: false, error: "Channel key derivation failed" };
  }

  // ─── Step 3: Create acceptance message ──────────────────────────────────
  // This message contains the viewer's real identity, device pubkey, and relays.
  // The monitor will use viewerDevicePubkey to derive post-pairing channel keys.

  const acceptancePayload = {
    type: "qr-acceptance",
    viewerPubkey: viewerRealPubkey,         // viewer's long-term identity pubkey
    viewerDevicePubkey: viewerDevicePubkey, // viewer's device pubkey — used for channel key derivation
    viewerRelays: viewerRelays,             // where to send signals to viewer
    timestamp: Math.floor(Date.now() / 1000),
    inviteId: qrPayload.id, // echo back the invite ID
  };

  // ─── Step 4: Encrypt acceptance with temporary channel key ──────────────
  // Single-layer NIP-44 encryption (not gift-wrap)

  const encryptedContent = nip44Encrypt(
    JSON.stringify(acceptancePayload),
    tempChannelSecret,
  );

  // ─── Step 5: Sign with ephemeral key (not real identity) ────────────────
  // This hides viewer's real pubkey on the relay until monitor decrypts
  // Monitor knows to expect an ephemeral signature because it's from the
  // ephemeral invite key's perspective

  const ephemeralPrivkey = generateSecretKey(); // New ephemeral key per acceptance

  const acceptanceEvent: NostrEvent = finalizeEvent(
    {
      kind: KIND_QR_ACCEPTANCE, // 5100 (custom kind for QR acceptances)
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", qrPayload.pk], // tag the monitor's real pubkey
        ["invite", qrPayload.id], // tag the invite ID
        ["v", "2"], // version tag
      ],
      content: encryptedContent,
    },
    ephemeralPrivkey,
  );

  // ─── Step 6: Publish acceptance to monitor's relays ────────────────────
  // Fanout to all relays listed in QR

  const publishResults: Array<{
    relay: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const relay of qrPayload.relays) {
    try {
      await publish(acceptanceEvent, { relay, timeout: 5000 });
      publishResults.push({ relay, success: true });
    } catch (err) {
      publishResults.push({
        relay,
        success: false,
        error: String(err),
      });
    }
  }

  // Check if at least one relay succeeded
  const anySuccess = publishResults.some((r) => r.success);
  if (!anySuccess) {
    return {
      success: false,
      error: `Failed to publish to all relays: ${publishResults.map((r) => r.error).join(", ")}`,
    };
  }

  // ─── Step 7: Store paired device locally ────────────────────────────────
  // Derive post-pairing channel keys using DEVICE keys (not identity keys)

  const sharedSecret = getConversationKey(viewerDevicePrivkey, qrPayload.dpk);
  const inboundChannelKey = deriveChannelKey(
    sharedSecret,
    qrPayload.dpk,       // monitor's device pubkey
    viewerDevicePubkey,  // viewer's device pubkey
  );
  const outboundChannelKey = deriveChannelKey(
    sharedSecret,
    viewerDevicePubkey,  // viewer's device pubkey
    qrPayload.dpk,       // monitor's device pubkey
  );

  await addPairedContact({
    identityPubkey: qrPayload.pk,   // monitor's real identity pubkey
    devicePubkey: qrPayload.dpk,    // monitor's device pubkey
    nickname: qrPayload.label || generateNickname(),
    relays: qrPayload.relays, // monitor's relays
    capabilities: [],
    lastSeenAt: null,
    channelKeys: {
      inbound: inboundChannelKey, // listen on monitor's channel outbound
      outbound: outboundChannelKey, // publish on viewer's channel outbound
    },
    addedAt: Date.now(),
  });

  dbg("info", "pairing", `QR acceptance sent to ${qrPayload.pk.slice(0, 8)}`);

  return { success: true, pairedMonitorPubkey: qrPayload.pk };
}
```

### Monitor Reception (Acceptance Listening)

The monitor, after generating a QR, listens for acceptances on its relays. It **decrypts with the ephemeral invite privkey** to verify the acceptance came from someone who scanned the specific QR:

```typescript
// Monitor generates QR and starts listening
export async function generateQRAndListenForAcceptance(
  monitorPrivkey: Uint8Array,
  monitorPubkey: string,
  monitorRelays: string[],
  onAccepted: (
    viewerPubkey: string,
    viewerRelays: string[],
    label: string,
  ) => void,
): Promise<{ qrDataUrl: string; uri: string; cleanup: () => void }> {
  // ─── Step 1: Generate ephemeral invite key ──────────────────────────────
  // This key is ephemeral and never reused

  const ephemeralInvitePrivkey = generateSecretKey();
  const ephemeralInvitePubkey = getPublicKey(ephemeralInvitePrivkey);

  // ─── Step 2: Create QR payload ──────────────────────────────────────────

  const qrPayload: QRPayload = {
    v: 2,
    ik: ephemeralInvitePubkey,
    pk: monitorPubkey,
    dpk: monitorDevicePubkey,
    relays: monitorRelays,
    id: crypto.randomUUID(),
    ttl: Math.floor(Date.now() / 1000) + 300, // 5 minutes
    label: "Monitor Device",
  };

  // ─── Step 3: Encode and display QR ─────────────────────────────────────

  const uri = encodeInviteUri(qrPayload);
  const qrDataUrl = await generateQRDataUrl(uri);

  // ─── Step 4: Start listening for acceptances ────────────────────────────
  // Listen on all monitor relays for KIND_QR_ACCEPTANCE (5100) events
  // that we can decrypt with ephemeralInvitePrivkey

  const acceptanceHandlers = new Map<string, NostrEvent>();

  // Request T+0 subscription for QR acceptance events on monitor's own relays
  const acceptanceHandle = nostrClient.requestSubscription(
    [{ kinds: [KIND_QR_ACCEPTANCE] }],
    async (event: NostrEvent) => {
      try {
        // ─ Attempt decryption with ephemeral invite key
        const decrypted = nip44Decrypt(
          event.content,
          getConversationKey(ephemeralInvitePrivkey, event.pubkey),
        );

        const acceptance = JSON.parse(decrypted) as {
          type: string;
          viewerPubkey: string;
          viewerDevicePubkey: string;
          viewerRelays: string[];
          timestamp: number;
          inviteId: string;
        };

        // ─ Validate acceptance format
        if (acceptance.type !== "qr-acceptance") return;
        if (acceptance.inviteId !== qrPayload.id) return; // Not for this invite

        // ─ Skip if we've already processed this acceptance
        if (acceptanceHandlers.has(event.id)) return;
        acceptanceHandlers.set(event.id, event);

        // ─ Validate timestamp (acceptance is fresh, within 1 minute)
        const acceptanceAgeS =
          Math.floor(Date.now() / 1000) - acceptance.timestamp;
        if (acceptanceAgeS > 60) {
          dbg("warn", "pairing", `QR acceptance too old: ${acceptanceAgeS}s`);
          return;
        }

        // ─ Validate viewer pubkey formats
        if (acceptance.viewerPubkey.length !== 64 || acceptance.viewerDevicePubkey.length !== 64) {
          dbg("warn", "pairing", "Invalid viewer pubkey in QR acceptance");
          return;
        }

        // ─ Store paired device and derive post-pairing channel keys using DEVICE keys
        const sharedSecret = getConversationKey(
          monitorDevicePrivkey,
          acceptance.viewerDevicePubkey, // viewer's device pubkey, not identity pubkey
        );
        const inboundChannelKey = deriveChannelKey(
          sharedSecret,
          acceptance.viewerDevicePubkey, // viewer's device pubkey
          monitorDevicePubkey,
        );
        const outboundChannelKey = deriveChannelKey(
          sharedSecret,
          monitorDevicePubkey,
          acceptance.viewerDevicePubkey, // viewer's device pubkey
        );

        await addPairedContact({
          identityPubkey: acceptance.viewerPubkey,       // viewer's long-term identity
          devicePubkey: acceptance.viewerDevicePubkey,   // viewer's device pubkey
          nickname: generateNickname(),
          relays: acceptance.viewerRelays,
          channelKeys: {
            inbound: inboundChannelKey,
            outbound: outboundChannelKey,
          },
          addedAt: Date.now(),
        });

        dbg(
          "info",
          "pairing",
          `QR acceptance received from ${acceptance.viewerPubkey.slice(0, 8)}`,
        );

        // Call the callback (triggers onAccepted handler)
        onAccepted(acceptance.viewerPubkey, acceptance.viewerRelays, "Viewer");
      } catch (err) {
        // Not decryptable — either not for us or corrupt data
        // Silently skip; this is normal
      }
    },
    (_since) => {}, // long-lived until QR is cancelled; no history fetch needed
  );

  return { qrDataUrl, uri, cleanup: () => acceptanceHandle.unsubscribe() };
}
```

### Key Derivation Details

Both monitor and viewer independently derive **identical channel keys** from the same ECDH shared secret:

```typescript
/**
 * Derivation formula (both sides compute independently):
 *
 * 1. Compute shared ECDH secret from DEVICE keys (not identity keys):
 *    sharedSecret = getConversationKey(own_devicePrivkey, peer_devicePubkey)
 *
 * 2. Derive directional channel keys:
 *    inbound = deriveChannelKey(sharedSecret, peer_devicePubkey, own_devicePubkey)
 *    outbound = deriveChannelKey(sharedSecret, own_devicePubkey, peer_devicePubkey)
 *
 * 3. Use derived keys as channel pubkeys in post-pairing signals
 */

// Example: Monitor's perspective (using device keys)
const monitorSharedSecret = getConversationKey(monitorDevicePrivkey, viewerDevicePubkey);
const monitorInbound = deriveChannelKey(
  monitorSharedSecret,
  viewerDevicePubkey,
  monitorDevicePubkey,
);
const monitorOutbound = deriveChannelKey(
  monitorSharedSecret,
  monitorDevicePubkey,
  viewerDevicePubkey,
);

// Example: Viewer's perspective (identical keys, different perspective)
const viewerSharedSecret = getConversationKey(viewerDevicePrivkey, monitorDevicePubkey);
const viewerInbound = deriveChannelKey(
  viewerSharedSecret,
  monitorDevicePubkey,
  viewerDevicePubkey,
);
const viewerOutbound = deriveChannelKey(
  viewerSharedSecret,
  viewerDevicePubkey,
  monitorDevicePubkey,
);

// Assertion (both sides):
// monitorOutbound === viewerInbound  (monitor sends on this channel)
// viewerOutbound === monitorInbound  (viewer sends on this channel)
```

**Why this is safe:**

- The derivation function is **deterministic** — same device key inputs always produce the same output
- The derivation is **directional** — swapping sender/recipient produces a different key
- Device keys ensure channel isolation — two devices sharing the same identity key still have distinct channels
- The temporary channel key for acceptance is **ephemeral** — only used once, then discarded
- The post-pairing keys are **derived from device keypairs**, not identity keys — re-derived on session start

### Acceptance Message Format

The acceptance payload (encrypted and published by viewer) contains all information needed for the monitor to complete pairing:

```typescript
interface QRAcceptancePayload {
  type: "qr-acceptance";
  viewerPubkey: string;       // viewer's real identity pubkey (hex, 64 chars)
  viewerDevicePubkey: string; // viewer's device pubkey (hex, 64 chars) — used for channel key derivation
  viewerRelays: string[];     // where monitor should send signals to viewer
  timestamp: number;          // unix seconds (creation time)
  inviteId: string;           // echoed from QR payload; secondary correlation check
}
```

**Correlation:** Successful decryption with the `ephemeral_invite_privkey` already identifies which QR the acceptance belongs to — each active QR has a distinct ephemeral key and only that key can decrypt. The `inviteId` field provides an additional explicit check (`acceptance.inviteId !== qrPayload.id → reject`) so the monitor never accidentally processes an acceptance from a different concurrent invite.

**Encryption and signing:**

```
┌─────────────────────────────────────────────┐
│ QR Acceptance Event (Kind 5100)             │
├─────────────────────────────────────────────┤
│ pubkey: ephemeralViewerPubkey               │
│ (random key, never reused)                  │
│                                             │
│ tags:                                       │
│   ['p', monitor_real_pubkey]                │
│   ['v', '2']                                │
│                                             │
│ content: (encrypted with temporary key)     │
│   NIP-44 ChaCha20-Poly1305 {                │
│     type: 'qr-acceptance',                  │
│     viewerPubkey,                           │
│     viewerRelays,                           │
│     timestamp,                              │
│     inviteId                                │
│   }                                         │
│                                             │
│ created_at: honest unix timestamp           │
│ sig: ephemeralViewerPrivkey signature       │
└─────────────────────────────────────────────┘
```

### Recovery & Error Scenarios

**Scenario 1: Acceptance event lost to relay**

- Viewer published acceptance to all relays in QR
- If some/all relays lose the event, monitor never receives it
- **Recovery:** Viewer can rescan QR and retry. Since inviteId is echoed, retries are safe (idempotent).
- **Timeout:** Monitor's listening window is typically 5 minutes (QR TTL). After that, it stops listening for that invite.

**Scenario 2: Network lag (late acceptance)**

- Viewer publishes acceptance but it reaches relay after QR TTL expires
- Monitor already stopped listening
- **Recovery:** Viewer should rescan QR or ask monitor to generate a fresh invite. TTL validation on viewer side prevents accepting stale QRs.

**Scenario 3: Duplicated acceptance event**

- Relay redelivers the same acceptance event (replay)
- Monitor receives it twice (same event ID)
- **Recovery:** Monitor deduplicates by event ID: `if (acceptanceHandlers.has(event.id)) return;`

**Scenario 4: Acceptance signed with wrong key**

- Event signature doesn't match the pubkey
- **Recovery:** Nostr clients validate signatures automatically. Invalid events are rejected before reaching decryption logic.

**Scenario 5: Viewer loses QR before acceptance**

- Viewer scanned QR but app crashed before publishing acceptance
- **Recovery:** Viewer needs to rescan (or ask monitor to regenerate). There's no state to recover; just redo the scan and accept.

**Scenario 6: Monitor loses invite privkey**

- Monitor generated QR, then app crashed before storing ephemeralInvitePrivkey
- Monitor can no longer decrypt acceptances for that QR
- **Recovery:** Monitor stops listening for that QR after TTL expires. Viewer will notice pairing didn't complete and should ask monitor to generate a new invite.

### Post-Contact Transition to Channel Keys

After successful invite acceptance (whether QR or Nostr delivery), both devices have:

- Each other's **identity pubkeys** and **device pubkeys** (from QR payload and acceptance message)
- **Relay lists** (from QR and acceptance)
- **Shared ECDH secret** (computed from their device privkeys)

Now they can **independently derive post-pairing channel keys** using their device keys:

```typescript
// Monitor's computation (using device keys):
const monitorSharedSecret = getConversationKey(monitorDevicePrivkey, viewerDevicePubkey);
const monitorInbound = deriveChannelKey(
  monitorSharedSecret,
  viewerDevicePubkey,
  monitorDevicePubkey,
);
const monitorOutbound = deriveChannelKey(
  monitorSharedSecret,
  monitorDevicePubkey,
  viewerDevicePubkey,
);

// Viewer's computation (using device keys):
const viewerSharedSecret = getConversationKey(viewerDevicePrivkey, monitorDevicePubkey);
const viewerInbound = deriveChannelKey(
  viewerSharedSecret,
  monitorDevicePubkey,
  viewerDevicePubkey,
);
const viewerOutbound = deriveChannelKey(
  viewerSharedSecret,
  viewerDevicePubkey,
  monitorDevicePubkey,
);

// Both derive identical keys:
// monitorOutbound === viewerInbound  ✓
// monitorInbound === viewerOutbound  ✓
```

All subsequent signals (status, RTC handshake, relay updates, etc.) are published with these **channel key pubkeys** and **single-layer NIP-44 encryption**. Neither real identity pubkeys nor device pubkeys ever appear on Nostr again.

### Security Considerations

**Threat 1: QR Code Interception**

- **Risk:** Attacker sees QR on screen and scans it before intended viewer
- **Mitigation:** QR should be displayed in a physically secure context (locked room, private screen). Same as WiFi QR — user responsibility.
- **Expiration:** TTL (e.g., 5 minutes) means old screenshots are useless

**Threat 2: Relay Eavesdropping**

- **Risk:** Relay operator sees acceptance event on relay and tries to decrypt
- **Mitigation:** Acceptance is encrypted with temporary channel key; relay can't decrypt it. Even if they somehow decrypt it, they only see viewer's real pubkey + relays — can't act on it without the invite privkey.

**Threat 3: Acceptance Forgery**

- **Risk:** Attacker publishes a fake acceptance event claiming to be a different viewer
- **Mitigation:** Acceptance is signed (Nostr signature) and encrypted. Forger would need:
  1. Know the ephemeral invite pubkey (from QR) ✓ (attacker can scan)
  2. Derive the temporary channel key ✓ (same ECDH derivation)
  3. Encrypt valid acceptance JSON ✓ (encrypt())
  4. But... signature is wrong (doesn't match ephemeral pubkey) — **Nostr rejects invalid signatures**
  5. Even if signature is valid, monitor checks `inviteId` in acceptance payload — must match the specific QR
  6. Attacker can only accept on behalf of the ephemeral key they sign with, not claim to be someone else

  **Result:** Forged acceptance either has invalid signature (rejected) or creates a pairing with a wrong viewer pubkey (attacker's, not the intended viewer's). Monitor would need to trust the acceptance content; but acceptance contains an explicit `viewerPubkey` field, so attacker can't trick monitor into pairing with someone else.

**Threat 4: Private Key Theft**

- **Risk:** Attacker steals monitor's or viewer's privkey, then generates new QRs or acceptances
- **Mitigation:** Same as any key-based system. Private keys must be protected by the device's OS (Keychain, Android Keystore, etc.). Out of scope for Nostr protocol.

**Threat 5: Relay Censorship**

- **Risk:** Relay blocks acceptance event (DOSes pairing)
- **Mitigation:** Fanout to multiple relays. If at least one relay accepts, acceptance succeeds. Monitor listens on all relays listed in QR.

**Why real pubkeys are safe in acceptance payload:**

- Acceptance is **encrypted** — relay can't see it
- Acceptance is **ephemeral** — lives only on relays for ~5 minutes
- Acceptance includes **inviteId** — only valid for this specific QR
- Acceptance is **idempotent** — retrying doesn't cause problems
- After pairing, real pubkeys are **never used on Nostr** — all signals use channel keys

### Nostr Event Kind: QR Acceptance (Kind 5100)

A new event kind is used for QR acceptance events to distinguish them from other pairing/signaling events:

```typescript
export const KIND_QR_ACCEPTANCE = 5100;

// Example event structure
{
  kind: 5100,
  pubkey: ephemeralViewerPubkey,    // temporary key, never reused
  content: nip44Encrypt({
    type: 'qr-acceptance',
    viewerPubkey: '...',            // viewer's real identity pubkey
    viewerDevicePubkey: '...',      // viewer's device pubkey (for channel key derivation)
    viewerRelays: ['wss://...'],
    timestamp: 1234567890,
    inviteId: 'uuid-...'
  }, temporaryChannelKey),
  tags: [
    ['p', monitorRealPubkey],
    ['invite', inviteId],
    ['v', '2']
  ],
  created_at: 1234567890,
  sig: '...'  // signed with ephemeralViewerPrivkey
}
```

### Architectural Clarity: TOTP is NOT a Pairing Method

**Critical distinction:**

- **Pairing protocol** = ephemeral key generation → temporary channel derivation → acceptance message → post-pairing channel keys (deriveChannelKey)
- **TOTP** = credential validation layer that can optionally secure the pairing delivery

**TOTP's role:**

- Does NOT define how devices exchange identity (that's ECDH)
- Does NOT define the acceptance flow (that's the invite protocol)
- Does NOT replace ephemeral keys or channel key derivation
- **Only** validates that the accepting device knows a shared credential

**Why they are separate:**

| Aspect              | Pairing Protocol                          | TOTP Layer                                            |
| ------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Scope               | Identity exchange, key derivation         | Credential validation only                            |
| Reusable            | No, specific to Senstry pairing           | Yes, can be used for login, re-auth, API access, etc. |
| Required            | Yes (core pairing mechanism)              | No (optional security enhancement)                    |
| Backward compatible | Must preserve invite format               | Doesn't affect pairing protocol                       |
| Delivery            | QR code or Nostr (independent of pairing) | Works with any delivery mechanism                     |

**Example:** A login flow uses the same TOTP infrastructure (generate seed, validate code, rate limit attempts) without touching the pairing protocol at all. Conversely, QR-based pairing does not require TOTP; viewers can accept invites without credentials.

**Dual-role exception — TOTP Mailbox:** In the TOTP Mailbox delivery mechanism (kind 5201), the TOTP seed serves two distinct roles simultaneously. First, it is the routing keypair source: `mailboxPrivkey = HKDF(totpSeed, "senstry-v1-mailbox")` determines which Nostr pubkey the recipient subscribes to. Second, it is the credential source: the sender includes a TOTP code derived from the same seed in the payload, and the recipient validates it before creating a TempContact. These two roles do not conflict — routing and credential validation use the same seed but operate on different derived values and at different stages of the flow.

---

## Contact Creation: TOTP Mailbox

### Overview

The TOTP Mailbox is the mechanism for Nostr-delivered contact creation when two parties share only a TOTP seed out-of-band. It replaces any need for gift wrap: instead of routing to a recipient's real Nostr pubkey (which would expose identity on the relay), the sender derives a one-time mailbox pubkey from the shared TOTP seed and publishes there. The relay sees only a pseudonymous pubkey and an encrypted blob. No real pubkeys appear anywhere in the delivery event.

The mailbox is one-shot: once the recipient decrypts and validates the event, the mailbox subscription closes and the keypair is discarded. The result is a TempContact with an ephemeral channel keypair, valid for communication until the TTL expires or pairing completes.

### Mailbox Keypair Derivation

Both sender and recipient independently derive the same mailbox keypair from the shared TOTP seed using HKDF:

```typescript
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1";

/**
 * Derive the mailbox keypair from a TOTP seed.
 * Both sender (to address the event) and recipient (to subscribe) derive the same keypair.
 *
 * @param totpSeed  Raw 20-byte TOTP seed
 * @returns { mailboxPrivkey: Uint8Array, mailboxPubkey: string }
 */
function deriveMailboxKeypair(totpSeed: Uint8Array): {
  mailboxPrivkey: Uint8Array;
  mailboxPubkey: string;
} {
  // HKDF-SHA256: expand seed into 32-byte privkey material
  const mailboxPrivkey = hkdf(sha256, totpSeed, undefined, "senstry-v1-mailbox", 32);
  // Derive the corresponding secp256k1 pubkey (Schnorr / x-only, 32 bytes → 64-char hex)
  const mailboxPubkey = secp256k1.getPublicKey(mailboxPrivkey, true).slice(1);
  return {
    mailboxPrivkey,
    mailboxPubkey: Buffer.from(mailboxPubkey).toString("hex"),
  };
}
```

### Sender Behavior

The sender (e.g., a monitor publishing an invite) creates a fresh ephemeral keypair for each delivery. This ephemeral pubkey becomes the return address — the `replyKey` — that the recipient will use as their outbound channel pubkey to reach the sender:

```typescript
/**
 * Publish a TOTP mailbox delivery event (kind 5201).
 *
 * @param totpSeed       Shared TOTP seed (20 bytes)
 * @param invitePayload  Invite data to deliver (type, relays, ttl, etc.)
 * @param publishRelays  Relays where the recipient is expected to subscribe
 */
async function publishMailboxDelivery(
  totpSeed: Uint8Array,
  invitePayload: object,
  publishRelays: string[],
): Promise<void> {
  // Derive mailbox pubkey (recipient subscribes to this)
  const { mailboxPubkey } = deriveMailboxKeypair(totpSeed);

  // Generate a fresh ephemeral keypair — this is the sender's return address
  const ephemeralPrivkey = generateSecretKey();
  const ephemeralPubkey = getPublicKey(ephemeralPrivkey);

  // Generate a TOTP code from the seed for this delivery
  const totpCode = generateCurrentTOTPCode(totpSeed); // 6-digit RFC 6238 code

  const content = JSON.stringify({
    ...invitePayload,
    replyKey: ephemeralPubkey, // sender's return address (recipient sends back here)
    credential: totpCode,     // TOTP code for validation at recipient
    created_at: Math.floor(Date.now() / 1000),
  });

  // NIP-44 encrypt content to the mailbox pubkey (recipient derives decryption key)
  const conversationKey = getConversationKey(ephemeralPrivkey, mailboxPubkey);
  const encryptedContent = nip44Encrypt(content, conversationKey);

  // Sign with the ephemeral key (not the sender's real key)
  const event = finalizeEvent(
    {
      kind: 5201,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", mailboxPubkey]], // routing tag — recipient subscribes to this pubkey
      content: encryptedContent,
    },
    ephemeralPrivkey,
  );

  for (const relay of publishRelays) {
    await publish(event, { relay, timeout: 5000 });
  }
}
```

The sender's real identity key never touches this event. The relay sees: ephemeral pubkey, kind 5201, a `#p` tag pointing to the mailbox pubkey, and opaque ciphertext.

### Recipient Behavior

The recipient derives the same mailbox keypair and opens a one-shot subscription. On receiving a kind 5201 event, it decrypts, validates the TOTP credential, and creates a TempContact:

```typescript
/**
 * Subscribe to the TOTP mailbox and handle the first valid delivery.
 * The subscription closes immediately after a valid event is processed.
 *
 * @param totpSeed      Shared TOTP seed (20 bytes)
 * @param listenRelays  Relays to subscribe on
 * @param onDelivery    Called with TempContact once validated
 */
async function subscribeToTOTPMailbox(
  totpSeed: Uint8Array,
  listenRelays: string[],
  onDelivery: (tempContactId: string) => void,
): Promise<{ unsubscribe: () => void }> {
  const { mailboxPrivkey, mailboxPubkey } = deriveMailboxKeypair(totpSeed);

  const handle = nostrClient.requestSubscription(
    [{ kinds: [5201], "#p": [mailboxPubkey] }],
    async (event) => {
      try {
        // Decrypt: sender used ephemeral key; we decrypt with mailboxPrivkey
        const conversationKey = getConversationKey(mailboxPrivkey, event.pubkey);
        const plaintext = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(plaintext);

        // Validate freshness (reject events older than TTL)
        const age = Math.floor(Date.now() / 1000) - payload.created_at;
        if (age > (payload.ttl ?? 3600)) {
          dbg("warn", "mailbox", "kind 5201 event expired, ignoring");
          return;
        }

        // Validate TOTP credential
        const credentialValid = verifyTOTPCode(totpSeed, payload.credential);
        // credentialId is looked up from the stored TOTP seed registry
        const credentialId = await lookupCredentialIdBySeed(totpSeed);
        await recordTOTPAttempt(credentialId, credentialValid);

        if (!credentialValid) {
          dbg("warn", "mailbox", "kind 5201 TOTP validation failed");
          return;
        }

        // Create TempContact — registerTempFromMailbox generates the inbound channel keypair internally
        const tempContactId = nostrClient.registerTempFromMailbox({
          senderEphemeralPubkey: payload.replyKey, // sender's return address = our outbound
          senderRelays: payload.replyRelays,
          myListenRelays: listenRelays,
          expiresAt: Date.now() + (payload.ttl ?? 3600) * 1000,
        });

        // Close mailbox subscription — one-shot; done
        handle.unsubscribe();

        onDelivery(tempContactId);
      } catch {
        // Decryption failure or parse error — not for us, or corrupt; skip silently
      }
    },
    (_since) => {},
  );

  return { unsubscribe: () => handle.unsubscribe() };
}
```

### Nostr-Delivered Invite Flow

When a monitor wants to send a pairing invite over Nostr (rather than via QR), the flow uses the TOTP mailbox for delivery:

1. Monitor and viewer share a TOTP seed out-of-band (e.g., verbal exchange, QR of just the seed, secure messaging app).
2. Monitor calls `publishMailboxDelivery(totpSeed, invitePayload, relays)` — publishes kind 5201 addressed to `mailboxPubkey`.
3. Viewer calls `subscribeToTOTPMailbox(totpSeed, relays, onDelivery)` — subscribes to `#p: mailboxPubkey`.
4. Viewer receives kind 5201, decrypts, validates TOTP credential → creates TempContact.
5. Viewer sends kind 5100 (QR/Mailbox Acceptance) over the TempContact channel keys — same acceptance format as QR pairing, same `publishSignal(tempContactId, 5100, acceptancePayload)` call.
6. Monitor receives kind 5100 over the TempContact's inbound channel, validates, derives ECDH channel keys, stores as PairedContact.
7. Both sides now have a PairedContact. The TempContact on the viewer side is replaced by the PairedContact entry.

### Security Properties

| Property | TOTP Mailbox (Kind 5201) |
| -------- | ------------------------ |
| Relay sees recipient identity | No — mailbox pubkey is derived from seed, not real pubkey |
| Relay sees sender identity | No — sender signs with ephemeral key |
| Delivery routable without real pubkey | Yes — `#p: mailboxPubkey` is the routing tag |
| Credential bound to delivery | Yes — TOTP code in payload, validated before TempContact is created |
| Replay protection | Yes — TOTP code expires (30s window); payload TTL enforced |
| Real pubkeys on relay | No — first real pubkey exposure is in kind 5100 acceptance (signed with ephemeral key) |
| One-shot | Yes — mailbox subscription closes after first valid delivery |

### Recovery Scenarios

**Event lost in transit:** Sender republishes kind 5201 with a fresh TOTP code. The recipient's mailbox subscription is still open (until TTL elapses). As long as the TOTP seed is the same, the new event routes to the same mailbox pubkey.

**TOTP code expired:** If the recipient processes the event after the 30-second code window, validation fails. The sender republishes a new kind 5201 event with the current TOTP code. No state needs to be reset — each kind 5201 event is self-contained.

**Recipient offline:** The kind 5201 event sits on the relay. When the recipient comes online and opens the mailbox subscription, the relay delivers the stored event. If the event's `created_at` is within TTL, it is processed normally. If the TTL has elapsed, the recipient ignores it and the sender must republish.

**Relay does not support #p tag filtering:** The mailbox mechanism requires relay support for `#p` tag queries. If a relay does not support it, the kind 5201 event is not delivered via subscription. The fallback is to use a different relay that supports tag filtering, or to fall back to QR-based pairing.

---

## TOTP Integration with Pairing Methods

### QR-Based Pairing

- **TOTP is optional**
- **Rationale:** QR codes are ephemeral (5-minute TTL) and inherently local (air-gapped until acceptance). The 5-minute window is sufficient security for pairing. TOTP adds a second authentication factor if the monitor operator wants extra security (e.g., for high-security deployments), but is not required for basic pairing.
- **Flow variant with TOTP:**
  1. Monitor generates QR → shows QR + a TOTP code (6 digits, time-based)
  2. Viewer scans QR, sees prompt for TOTP code
  3. Viewer enters TOTP code (or leaves blank if monitor didn't require it)
  4. Acceptance message includes TOTP validation result (`totpValid: true | false`)
  5. Monitor receives acceptance: if TOTP was embedded in QR, validates code before storing pairing

### Nostr-Based Pairing

- **TOTP is required**
- **Rationale:** Nostr-delivered invites travel on public relays. The TOTP seed serves dual roles: it derives the mailbox keypair used to route the invite to the correct recipient, and it provides the credential that proves the accepting device is authorized. No real pubkeys appear on the relay.
- **Flow:**
  1. Monitor derives mailbox keypair from TOTP seed via HKDF
  2. Monitor publishes kind 5201 event to mailboxPubkey with TOTP credential in payload
  3. Viewer subscribes to `#p: mailboxPubkey`, receives and decrypts event
  4. Viewer validates TOTP credential → creates TempContact
  5. Viewer sends acceptance (kind 5100) over TempContact channel keys
  6. Monitor validates acceptance and promotes to PairedContact

### Programmatic Pairing (API / Headless Access)

- **TOTP is required as bearer token**
- **Rationale:** API calls are stateless; no session context to verify the caller's intent. TOTP seed acts as a shared secret for credential exchange.
- **Flow:**
  1. Monitor generates pairing secret → derives TOTP seed
  2. Monitor displays TOTP seed (or embeds in URI for automation)
  3. Programmatic client (CI/CD, custom app) includes TOTP code in pairing API request
  4. Monitor validates TOTP before issuing session token or completing pairing

**Summary:**
| Pairing Method | TOTP | Reason |
|---|---|---|
| QR-based | Optional | Ephemeral + air-gapped + short TTL |
| Nostr-delivered | Required | TOTP seed derives mailbox keypair for delivery; credential in payload authorizes the action |
| Programmatic API | Required | Stateless; TOTP is the shared secret |

## TOTP: Remote Instruction Authorization

### Overview

TOTP is a general-purpose credential layer for **authorizing any remote instruction** that requires validation — not just pairing. The same implementation described in the "Security Layer" section above applies here: 20-byte seeds, RFC 6238 time-based codes, constant-time comparison, rate limiting. TOTP validates credentials; it does not define the action being authorized.

Use cases include pairing acceptance, relay migration commands, login, credential reset, and API access. The action payload is orthogonal to the TOTP credential; TOTP only verifies that the remote party knows the shared secret at this moment.

### Pattern: Authorizing Remote Instructions

The general pattern for using TOTP to authorize any remote instruction:

```typescript
/**
 * Generic remote instruction with TOTP authorization.
 *
 * Sender has:
 *   - A TOTP seed (shared with recipient via QR, manual entry, etc.)
 *   - An instruction to send to recipient (invite, request, proposal, etc.)
 *
 * Sender publishes:
 *   - Nostr event (kind X, encrypted with NIP-44)
 *   - Payload: { type: 'instruction-type', credential: '...', ...otherFields }
 *   - Credential is either TOTP seed (base32) or freshly-generated 6-digit code
 *
 * Recipient receives and validates:
 *   1. Decrypt event content (NIP-44)
 *   2. Check freshness (created_at must be recent)
 *   3. Extract credential from payload
 *   4. If seed: compare against stored seed (verifyRawSeed)
 *   5. If code: validate against stored seed (verifyTOTPCode)
 *   6. If valid: authorize the instruction
 *   7. If invalid: reject and apply rate limiting (recordTOTPAttempt)
 */

interface RemoteInstructionPayload {
  type: string; // 'pairing-accept', 'login', 'api-token', etc.
  credential: string; // TOTP seed (base32, 32 chars) or code (6 digits)
  credential_type: "seed" | "code"; // which validation mode to use
  ttl: number; // seconds (credential validity window)
  // ... other instruction-specific fields (action, relays, etc.)
  created_at: number; // unix timestamp (for freshness check)
}
```

### Example: Pairing Acceptance with TOTP

Pairing invite authorization is **one use case** of the TOTP protocol. For Nostr-delivered invite delivery via the TOTP mailbox, see "Contact Creation: TOTP Mailbox" above. The credential validation pattern — derive seed, validate freshness, call `verifyRawSeed` or `verifyTOTPCode`, record attempt — applies to any TOTP-secured instruction.

---

### Use Cases: When to Use TOTP for Remote Instructions

**Use TOTP when:**

- Remote action requires confirmation from a party with a **shared secret**
- Action is **sensitive** (pairing, account unlock, credential reset, API token generation)
- **Rate limiting** is needed to prevent brute-force attacks
- **Expiration** should limit validity window (don't authorize old instructions)
- Instruction is **already encrypted** over ECDH (TOTP adds a second auth layer)

**Don't use TOTP when:**

- No shared secret between parties (first-time discovery — use QR instead)
- Action is **non-sensitive** (status queries, read-only requests)
- Real-time **human verification** is needed (use UI-based confirmation instead)
- Instruction is **not encrypted** (TOTP credential would be exposed on relay)

---

## Remote Command (Kind 5006)

### Overview

A Remote Command is a TOTP-authorized instruction delivered over an existing contact's channel keys. It travels as a kind 5006 signal — encrypted and routed identically to any other post-contact signal — but carries its own TOTP credential in the payload. TOTP authorizes the specific action; the channel keys establish the encrypted channel.

Remote Commands work for both TempContacts and PairedContacts. The contact type determines the encryption channel; the TOTP credential determines whether the instruction is authorized.

### Why TOTP Is Required Even on PairedContacts

An established PairedContact proves that both devices completed the pairing flow and share ECDH-derived channel keys. It does not prove that a message arriving over that channel authorizes a sensitive action. A Remote Command carries additional risk: it instructs the receiving device to take a concrete action (e.g., migrate relays, modify configuration). TOTP provides a second authorization layer:

- The channel keys establish **identity**: only the paired device could send an encrypted message decryptable with the shared channel key.
- The TOTP credential establishes **authorization**: only someone who knows the shared TOTP seed at this specific moment can produce a valid credential.
- The credential is delivered at a different time and through a different out-of-band channel than the channel keys — an attacker who intercepts channel traffic cannot replay a valid command without also knowing the current TOTP code.

### Sending a Remote Command

```typescript
// ContactA sends a Remote Command to ContactB.
// The command travels over the existing PairedContact channel — no gift wrap.
await nostrClient.publishSignal(contactBId, 5006, {
  commandId: crypto.randomUUID(),
  credential: generateCurrentTOTPCode(sharedSeed), // current 6-digit code
  credential_type: "code",
  ttl: 300, // 5-minute validity window
  created_at: Math.floor(Date.now() / 1000),
  isResponse: false,
  payload: {
    type: "relay-migrate-command",
    newRelays: ["wss://relay-b-2.com"],
  },
});
```

The same `publishSignal` API used for every other signal kind. ContactA holds a PairedContact (or TempContact) for ContactB; the contact resolves the channel key and relay internally.

### Receiving via RemoteCommandController

`RemoteCommandController` handles all incoming kind 5006 events from the signal router. Handlers are registered explicitly — one handler per `payload.type`. The controller:

1. **Checks freshness** — rejects events where `now - created_at > ttl`. No ack sent.
2. **Validates TOTP credential** — calls `verifyTOTPCode` or `verifyRawSeed` against the stored seed for the contact. Calls `recordTOTPAttempt` regardless of result (rate limiting).
3. **On failure** — discards silently. No ack. No error signal. Attacker learns nothing.
4. **On success** — sends ack immediately via `publishSignal(contactId, 5006, { isResponse: true, commandId, accepted: true })`.
5. **Dispatches** — calls the registered handler for `payload.payload.type`. If no handler is registered for that type, discards after ack.

### Relay Migration Command Example

Handler registration at startup:

```typescript
remoteCommandController.registerHandler("relay-migrate-command", {
  handle: async (contactId, payload) => {
    const { newRelays } = payload as { newRelays: string[] };
    // Initiate dual-channel migration — ContactB becomes the kind 5005 proposer
    await proposeInboundMigration(contactId, newRelays);
  },
});
```

End-to-end sequence:

```
ContactA: publishSignal(contactBId, 5006, { type: "relay-migrate-command", newRelays, credential, ... })
  → kind 5006 (isResponse=false) over ContactB's inbound channel
  ↓
ContactB: RemoteCommandController receives kind 5006
  → validates freshness, validates TOTP
  → publishSignal(contactAId, 5006, { isResponse: true, commandId, accepted: true })
  → dispatches to "relay-migrate-command" handler
  → proposeInboundMigration(contactAId, newRelays)
  → kind 5005 (isResponse=false) to ContactA
  ↓
ContactA: receives kind 5005 proposal → normal dual-channel migration ack flow
  → kind 5005 (isResponse=true) to newRelays (proof of listening)
  ↓
ContactB: receives kind 5005 ack → commits migration
```

**Role inversion:** In a self-initiated migration, the device that wants to change its relays sends kind 5005 (isResponse=false). Here, ContactB is instructed to migrate, so ContactB becomes the kind 5005 initiator. The Remote Command is the trigger; everything after follows the existing migration protocol.

---

## Signal Exchange Patterns

Signal kinds 5001–5006 are the universal mechanism for device-to-device communication. They work identically for any `contactId` — PairedContacts use ECDH-derived channel keys; TempContacts use ephemeral keys. The caller never handles keys or relay lists directly; those are internal to `ContactManager`.

### Signal Kinds (5001–5006)

Signals use dedicated Nostr kinds — one per signal type. Relays cannot filter by encrypted content, so each signal type requires its own kind for targeted fetching. All signals are NIP-44 encrypted over the contact's channel keys. Signals handle **connection setup and presence only** — data requests flow over RTC data channels.

Within each kind, `isResponse` distinguishes the initiating party from the responding party, eliminating paired type strings (e.g. `offer-request` + `offer` collapse into kind 5001 with `isResponse: false | true`).

```typescript
// Kind 5001 — RTC Session
// isResponse=false: viewer asks monitor for an SDP offer (declares desired mode)
// isResponse=true: monitor responds with SDP offer
interface RtcSessionPayload {
  sessionId: string;
  mode?: "live" | "data"; // isResponse=false only
  sdp?: string; // isResponse=true only
  isResponse: boolean;
}

// Kind 5002 — RTC Answer
// isResponse=false: viewer sends SDP answer to complete the WebRTC handshake
// isResponse=true: monitor acknowledges (optional)
interface RtcAnswerPayload {
  sessionId: string;
  sdp?: string; // isResponse=false: the SDP answer
  isResponse: boolean;
}

// Kind 5003 — RTC Hangup
// isResponse=false: either side closes the session
// isResponse=true: acknowledgement (optional)
interface RtcHangupPayload {
  sessionId: string;
  isResponse: boolean;
}

// Kind 5004 — Status
// isResponse=false: device announces presence (online/offline)
// isResponse=true: peer replies to a received announcement
// #s tag (plaintext on event): carries the sender's current sessionUUID.
// Peers read the #s tag to update their known session UUID without decrypting the payload.
// Session-directed signals (5001-5003, 5005, 5006) use the peer's last-seen #s value.
interface StatusPayload {
  state: "online" | "offline";
  isResponse: boolean;
}

// Kind 5005 — Relay Migration
// isResponse=false: device proposes new inbound relays
// isResponse=true: peer acknowledges (confirms it reached the new relay)
interface RelayMigrationPayload {
  sessionId: string;
  newRelays?: string[]; // isResponse=false: proposed relay list
  timestamp: number;
  isResponse: boolean;
}

// Kind 5006 — Remote Command (TOTP-authorized instruction)
// isResponse=false: command with TOTP credential + typed payload
// isResponse=true: ack after TOTP validation (no ack sent if validation fails)
interface RemoteCommandPayload {
  commandId: string;           // UUID — echoed in ack for correlation
  credential: string;          // TOTP code (6 digits) or seed (base32, 32 chars)
  credential_type: "seed" | "code";
  ttl: number;                 // seconds — command validity window
  created_at: number;          // unix timestamp (freshness check)
  isResponse: boolean;
  accepted?: boolean;          // isResponse=true only
  payload?: {                  // isResponse=false only
    type: string;              // handler key: "relay-migrate-command", etc.
    [key: string]: unknown;    // type-specific fields
  };
}
```

**Transmission (all signal kinds):**

```
Kind: 5001–5006, 5010–5011 (one per signal type)
Pubkey: sender's outboundChannelPubkey (= contact's inboundChannelPubkey; ECDH-derived for paired, ephemeral for temp)
Content: NIP-44 encrypted kind-specific payload
created_at: honest timestamp (not randomized)
Relay: selected by RelayStateController from contact's outboundRelayList
```

**Kind allocation:**

| Range     | Purpose                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| 5001–5005 | Contact signals (RTC, status, relay migration)                                       |
| 5006      | Remote Command (TOTP-authorized instruction)                                         |
| 5007–5009 | Reserved                                                                             |
| 5010–5011 | Action signals (trigger notifications, arm state)                                    |
| 5100      | QR/Mailbox Acceptance (pairing)                                                      |
| 5201      | TOTP Mailbox Delivery (pre-contact, one-shot)                                        |

Kinds 5001–5006 and 5010–5011 are delivered through the signal router. Kind 5201 is handled by a separate one-shot mailbox subscription (`{ kinds: [5201], "#p": [mailboxPubkey] }`), not by the signal router.

Callers use `nostrClient.publishSignal(contactId, kind, payload)` — relay and key selection is internal.

**Important:** Data requests (segments, coverage maps, etc.) are **never sent over Nostr**. They flow over RTC data channels (see RTC Connection & Control section).

### Signal Fetching Strategy

Subscriptions open at T+0 (since: now) and deliver future events only. When a module needs to look back — recovering from a reload, checking for a pending relay migration, getting the last known peer status — it calls `fetchKindHistory()` on the specific kind it cares about.

Because each signal type has its own kind, a fetch for kind 5005 (relay migration) returns only relay migration events. There is no need to filter or decrypt a pile of unrelated events to find the one being sought.

**Watermark:** Track the latest `created_at` seen per kind, per peer. Use this as `windowStart` when calling `fetchKindHistory()` to avoid re-fetching events already processed.

```typescript
interface SignalWatermark {
  // Per contactId, per kind — latest created_at seen
  [contactId: string]: {
    5001?: number; // RTC Session
    5002?: number; // RTC Answer
    5003?: number; // RTC Hangup
    5004?: number; // Status
    5005?: number; // Relay Migration
    5006?: number; // Remote Command
  };
}

// On startup: for each contact, fetch from last known watermark
// Relay list and channel key resolved internally from contactId — caller passes neither
async function resumeSignalFetches() {
  for (const contactId of nostrClient.allContactIds()) {
    const wm = getWatermark(contactId);

    // Check for pending relay migration proposals
    for await (const event of nostrClient.fetchKindHistory(contactId, 5005, {
      windowStart: wm[5005] ?? now() - 86400,
    })) {
      const msg = event.decryptedPayload as RelayMigrationPayload;
      updateWatermark(contactId, 5005, event.created_at);
      if (!msg.isResponse) {
        handleRelayMigrationProposal(contactId, msg);
        break; // newest unacknowledged proposal found
      }
    }

    // Get last known status
    for await (const event of nostrClient.fetchKindHistory(contactId, 5004, {
      windowStart: wm[5004] ?? now() - 3600,
    })) {
      const msg = event.decryptedPayload as StatusPayload;
      if (!msg.isResponse) {
        updateContactStatus(contactId, msg.state, event.created_at);
        updateWatermark(contactId, 5004, event.created_at);
        break; // newest announcement found
      }
    }
  }
}
```

**Key properties:**

- Each `fetchKindHistory()` call issues one relay request at a time, yielding the newest matching event first
- Rate-limit cost is per received event: each event delays the next request by `1 / relayRatePerMinute` minutes
- The caller `break`s when it finds what it needs — no unnecessary fetching
- Watermarks advance only when events are processed; a crash before processing leaves the watermark unchanged so the event is re-fetched on next startup

**Note on QR acceptance fetching:** QR-based pairing uses honest timestamps, so the same watermark pattern applies. The monitor tracks the last processed acceptance `created_at` and passes it as `windowStart` when re-subscribing.

---

### Real-Time Signals (Status & RTC)

All calls use `contactId` — relay and key selection is internal.

**Status Announcement** (on device startup):

```typescript
// Monitor comes online — announces to all contacts
for (const contactId of nostrClient.allContactIds()) {
  await nostrClient.publishSignalDirect(contactId, 5004, {
    state: "online",
    isResponse: false,
  });
}

// Viewer receives via signal router and replies
nostrClient.startSignalRouter((contactId, kind, payload) => {
  if (kind === 5004 && !payload.isResponse) {
    nostrClient.publishSignalDirect(contactId, 5004, {
      state: "online",
      isResponse: true,
    });
  }
});
```

**Status solicitation** (manual "Status?" button):

```typescript
// Viewer sends kind 5004 isResponse=false — monitor treats any isResponse=false as both
// announcement and reply solicitation
await nostrClient.publishSignalDirect(monitorContactId, 5004, {
  state: "online",
  isResponse: false,
});
```

**RTC Handshake** (initiating connection):

```
Viewer: publishSignalDirect(monitorContactId, 5001, { mode: 'data', sessionId, isResponse: false })
Monitor: publishSignalDirect(viewerContactId, 5001, { sdp, sessionId, isResponse: true })
Viewer:  publishSignalDirect(monitorContactId, 5002, { sdp: answerSdp, sessionId, isResponse: false })
[RTC connection established]
```

---

## Relay Naming Convention (Concrete Examples)

Using naming that encodes device and version for clarity:

```
ContactA relays:
  inbound (current) = [wss://relay-a-1.com]     (where ContactA listens)
  inbound (proposed) = [wss://relay-a-2.com]    (where ContactA wants to listen)
  outbound = [wss://relay-b-1.com]              (where ContactB listens)

ContactB relays:
  inbound (current) = [wss://relay-b-1.com]     (where ContactB listens)
  outbound = [wss://relay-a-1.com]              (where ContactA listens; updates when ContactA proposes)

Naming scheme: relay-X-Y where X=device (a/b) and Y=version number
```

## Relay Migration & Dual-Channel

Each device has **independent inbound and outbound relay lists**:

- **Inbound**: your listening relays (you can propose changes)
- **Outbound**: peer's inbound relays (you never change this; peer does via proposal)

When a device wants to migrate its listening relays:

1. Propose new inbound over peer's current inbound (outbound)
2. Dual-listen to old + new inbound during negotiation
3. Peer acknowledges by sending to the new inbound (proving it's listening)
4. Commit migration after acknowledgement

**Communications never break** because outbound (to peer) remains stable until peer acknowledges migration.

### Migration Flow (ContactA: relay-a-1 → relay-a-2)

**Step 1: ContactA proposes and dual-listens**

```
ContactA:
  ├─ Starts dual-listening to: [relay-a-1.com] + [relay-a-2.com]
  ├─ Sends proposal to: [relay-b-1.com]
  │  Message: "I'm migrating from relay-a-1 to relay-a-2"
  │  (kind 5005, isResponse=false, sessionId: UUID, newRelays: [relay-a-2])
  └─ State: waiting-for-acknowledgement
```

**Step 2: ContactB receives and acknowledges**

```
ContactB receives on [relay-b-1.com]:
  ├─ Learns: ContactA wants to listen on [relay-a-2.com]
  ├─ Updates: outbound = [relay-a-2.com] (where to send to ContactA now)
  └─ Sends acknowledgement to: [relay-a-2.com]
     Message: "I see you on relay-a-2, acknowledging your migration"
     (kind 5005, isResponse=true, sessionId: UUID)
```

**Step 3: ContactA receives acknowledgement and commits**

```
ContactA receives ack on [relay-a-2.com]:
  ├─ Sees: ContactB is listening to relay-a-2
  ├─ Commits: inbound = [relay-a-2.com]
  ├─ Stops listening to: [relay-a-1.com]
  └─ State: committed

Result:
  ContactA: inbound = [relay-a-2.com], outbound = [relay-b-1.com]
  ContactB: inbound = [relay-b-1.com], outbound = [relay-a-2.com]
  ✓ Communication over: [relay-b-1.com] ↔ [relay-a-2.com]
```

**Why communications never break:**

- ContactA always sends to [relay-b-1.com] ✓ (unchanged throughout)
- ContactB always listens to [relay-b-1.com] ✓ (unchanged throughout)
- Acknowledgement sent to ContactA's new inbound relay where ContactA is already dual-listening
- ContactB starts sending to new relay **immediately** upon receiving proposal

**Code: ContactA proposes migration**

```typescript
async function proposeInboundMigration(contact, newInbound) {
  // Example: ContactA proposing relay-a-1 → relay-a-2
  // contact.relays = [wss://relay-a-1.com]
  // newInbound = [wss://relay-a-2.com]
  // contact.outbound = [wss://relay-b-1.com]  (ContactB's inbound)

  const sessionId = crypto.randomUUID();

  // Step 1a: Request dual-listening on new inbound relays before sending proposal.
  // Temporarily extends the contact's inbound relay list to cover newInbound.
  // onReady fires when the relay confirms the subscription is active — no setTimeout guesswork.
  nostrClient.requestRelayMigrationListening(
    contactId,
    newInbound,
    async (since) => {
      // onReady: confirmed active on new relays — safe to proceed, won't miss the ack

      // Step 1b: Store proposal to IDB (survives reload)
      contact.relayProposal = {
        sessionId,
        newInbound,
        proposedAt: since,
      };
      await savePairedContact(contact);

      // Step 1c: Send proposal — relay selection and encryption are internal
      nostrClient.publishSignalDirect(contactId, 5005, {
        isResponse: false,
        sessionId,
        newRelays: newInbound,
        timestamp: since,
      });
    },
  );
}
```

**Step 3: ContactA waits for acknowledgement on dual-listened relays**

```typescript
async function waitForInboundMigrationAck(contact) {
  const { sessionId, newInbound, proposedAt } = contact.relayProposal;

  // Listen on both old and new relays for acknowledgement
  // ContactA is dual-listening: [relay-a-1.com] + [relay-a-2.com]
  // Acknowledgement will come from ContactB on [relay-a-2.com] (where they just learned to send)

  try {
    // Ack arrives via signal router — dual-listening on old + new inbound is already active.
    // Filter by sessionId; timeout after 30 seconds.
    const ack = await nostrClient.waitForSignal(contactId, {
      kind: 5005,
      filter: (payload) =>
        payload.isResponse && payload.sessionId === sessionId,
      timeoutMs: 30_000,
    });

    if (ack) {
      // Acknowledgement received for CURRENT proposal — commit migration
      contact.relayProposal = null;

      // Commit migration — ContactManager updates relay list; signal router re-subscribes to new inbound only
      nostrClient.updatePairedRelays(contactId, newInbound);

      await savePairedContact(contact);
      return true;
    }
  } catch (err) {
    // Ack timeout — peer may be offline or ack lost
    // Relays keep old acks, but they don't match current sessionId so won't confuse retry
    dbg(
      "warn",
      "relay-migration",
      `ack timeout for ${contact.pubkey} after ${Date.now() - proposedAt}ms`,
    );

    // Will retry on next startup via resumePendingRelayMigrations()
    return false;
  }
}
```

**Step 4: ContactB receives proposal and immediately acknowledges**

```typescript
// Signal router delivers: (contactId, kind, payload)
// kind 5005 = Relay Migration; isResponse=false = proposal
nostrClient.startSignalRouter((contactId, kind, payload) => {
  if (kind === 5005 && !payload.isResponse) {
    const msg = payload as RelayMigrationPayload;
    // contactId identifies ContactA — relay/key lookup is internal to NostrClient

    // Example scenario:
    // ContactB receives on [relay-b-1.com] (where we're listening):
    //   msg.newRelays = [relay-a-2.com]
    //   msg.sessionId = UUID
    // ContactA's proposal: "I'm moving to relay-a-2, start sending to me there"

    // Step 4a: Update where WE send to ContactA (our outbound = ContactA's new inbound)
    // ContactManager commits the new relay list; dual-listening on ContactA's side resolves after receiving this ack
    nostrClient.updatePairedRelays(contactId, msg.newRelays);

    // Step 4b: Send acknowledgement — NostrClient routes to the updated relay list
    // Sending to [relay-a-2.com] proves ContactB can reach ContactA on the new relay
    await nostrClient.publishSignalDirect(contactId, 5005, {
      isResponse: true,
      sessionId: msg.sessionId,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
});
```

**Step 5: Recovery on reload (resume dual-listening)**

```typescript
async function resumePendingRelayMigrations() {
  const contacts = await getAllPairedContacts();

  for (const contact of contacts) {
    // Check if migration was in-flight (proposal stored)
    if (!contact.relayProposal) continue;

    const { sessionId, newInbound, proposedAt } = contact.relayProposal;

    // Example scenario on reload:
    // contact.relays = [relay-a-1.com]  (old established inbound)
    // contact.relayProposal.newInbound = [relay-a-2.com]  (proposed new inbound)
    // We were proposing before the app crashed; resume waiting for ack

    // Use watermark-based fetching (see "Signal Fetching Strategy" section)
    // Only fetch events newer than last known created_at to avoid relay rate limit burn

    // Step 5a: The stored relayProposal IS the source of truth — we proposed this before the reload.
    // sessionId uniqueness guarantees there is no duplicate to resolve: same sessionId = same migration attempt.
    // Just resume waiting for the ack without re-fetching history or re-sending the proposal.
    dbg(
      "info",
      "relay-migration",
      `resuming pending migration for ${contact.pubkey} (session ${sessionId})`,
    );

    // Step 5b/5c: Re-request dual-listening, then wait for ack once confirmed active.
    // onReady ensures we don't start waiting before the relay subscription is live.
    nostrClient.requestRelayMigrationListening(
      contactId,
      newInbound,
      async () => {
        const ackReceived = await waitForInboundMigrationAck(contact);

        if (ackReceived) {
          dbg(
            "info",
            "relay-migration",
            `resumed and completed for ${contact.pubkey}`,
          );
        } else {
          dbg(
            "info",
            "relay-migration",
            `resumed but still waiting for ack from ${contact.pubkey}`,
          );
          // relayProposal stays in IDB; next startup will retry again
        }
      },
    );
  }
}
```

### Key Properties of Dual-Channel Migration

**Communications never break:**

- **ContactA always sends to `[relay-b-1.com]`** (ContactB's inbound) throughout migration — never changes
- **ContactB always listens to `[relay-b-1.com]`** (unchanged throughout; ContactA dual-listens to old+new inbound until ack received)
- All proposals reach ContactB; all acks reach ContactA on its dual-listened new inbound

**Multiple concurrent proposals are safe:**

- Each proposal has unique `sessionId`
- Initiator waits for ack matching its **LATEST** proposal's `sessionId`
- Latest proposal implicitly wins; no explicit conflict resolution needed
- Both devices can independently propose inbound changes without coordination

**Cleanup happens only after acknowledgement:**

- **Initiator** (e.g., ContactA): dual-listens to `[relay-a-1.com, relay-a-2.com]` until ack received
- **Acknowledger** (e.g., ContactB): starts sending to new inbound `[relay-a-2.com]` immediately upon receiving proposal, sends ack as proof
- After ack, initiator commits and stops dual-listening

**Each device autonomously controls only its own inbound:**

- **ContactA** can propose A→A2→A3→... without waiting for previous proposals to complete
- **ContactB** acknowledges **ONE** (latest with highest sessionId) and updates where it sends to ContactA
- No "agreement phase"—just proposal + proof of listening via acknowledgement
- Example: ContactA proposes A2, then proposes A3 before A2 ack arrives → ContactB will eventually acknowledge A3 and ignore A2

---

## PairedContact Data Model

```typescript
interface PairedContact {
  pubkey: string;

  // Relay lists (independent per device)
  relays: string[]; // MY inbound relays (where I listen for signals)
  outbound: string[]; // PEER's inbound relays (where I send signals to them)

  // Relay migration state
  relayProposal?: {
    sessionId: string;
    newInbound: string[]; // my proposed new listening relays
    proposedAt: number;
  };

  // ... other fields ...
}
```

### Relay List for Signals

**Semantics:**

- `relays`: Your listening relays. You control this; peer updates it when you propose via `relayProposal`
- `outbound`: Peer's listening relays (cached copy). You never write this directly; peer updates it by proposing changes to you

**Publishing:** Each signal goes to **one relay** selected from `contact.outbound` (peer's listening relays) by `RelayStateController.selectRelay()` — the least-recently-used eligible relay. The receiver subscribes T+0 on all their inbound relays, so the event arriving on any one is sufficient. History fan-fetches from all relays to locate events regardless of which one was used to publish.

**Subscription:** `nostrClient.startSignalRouter(onSignal)` maintains T+0 subscriptions across all relays in `ContactManager.allMyInboundRelays()`, filtering by all registered inbound channel pubkeys. The signal router re-subscribes automatically when contacts are added, updated, or expired.

**Integration with Relay Migration:**

- **Post-pairing signals:** `ContactManager` resolves the current outbound relay list per contact; `RelayStateController` selects the eligible relay; `NostrClient` handles key lookup and delivery
- **Relay migration:** `updatePairedRelays(contactId, newInbound)` in `ContactManager` updates the relay list; subsequent publishes and subscriptions pick up the new list automatically

---

## Senstry Action Signals (Pipeline → Nostr)

Action signals are the Nostr layer of the Senstry pipeline. When a sensor fires and the pipeline resolves an action that includes a Nostr notification, `TriggerPublisher` sends a targeted channel-key signal to specific paired contacts. There are no real pubkeys, no open subscriptions, no public broadcasts. Action signals use the same encryption and routing as all other post-contact signals.

**Pipeline flow:**

```
Monitor Device:
  Sensor fires
    → Detector reports state change
      → ActionController evaluates links
        → TriggerPublisher fires for each target contact:
            nostrClient.publishSignal(contactId, 5010, payload)

Viewer Device:
  Signal router receives via T+0 subscription
    → onSignal(monitorContactId, 5010, payload)
      → UI notified — viewer requests footage over RTC data channel
```

Footage itself is never sent over Nostr. The kind 5010 signal carries only the metadata needed to identify what happened and when. The viewer requests the actual segments over the existing RTC data channel.

### Signal Kinds

| Kind | Name      | Purpose                                              |
| ---- | --------- | ---------------------------------------------------- |
| 5010 | Trigger   | Sensor fired — detection type, timestamp, confidence |
| 5011 | Arm State | Monitor armed or disarmed                            |

Both use NIP-44 over ECDH channel keys, same as kinds 5001–5005. Both flow through the signal router.

### Publishing (Monitor Side)

`TriggerPublisher` resolves the target contacts and calls `publishSignal` once per target:

```typescript
class TriggerPublisher {
  constructor(
    private nostrClient: NostrClient,
    private contactManager: ContactManager,
  ) {}

  fire(kind: 5010 | 5011, payload: object, config: ActionSignalConfig) {
    const targets = this.resolveTargets(config);
    for (const contactId of targets) {
      this.nostrClient.publishSignal(contactId, kind, payload);
    }
  }

  private resolveTargets(config: ActionSignalConfig): string[] {
    const all = this.contactManager
      .allContactIds()
      .filter((id) => !this.contactManager.get(id).expiresAt); // paired only

    switch (config.recipients) {
      case "all":
        return all;
      case "specific":
        return all.filter((id) => config.contactIds.includes(id));
    }
  }
}
```

**Target filtering is caller-configurable:**

- `recipients: 'all'` — all paired contacts
- `recipients: 'specific'` — listed contactIds only
- Further filtering (online-only, not-on-rtc) is applied by the pipeline before calling `fire()`

### Reception (Viewer Side)

Action signals arrive through the same signal router as all other kinds:

```typescript
nostrClient.startSignalRouter((contactId, kind, payload) => {
  if (kind === 5010) {
    handleTriggerSignal(contactId, payload as TriggerPayload);
  }
  if (kind === 5011) {
    handleArmStateSignal(contactId, payload as ArmStatePayload);
  }
});
```

### Catching Up on Missed Actions

Action signals differ from RTC signals in one way: a viewer that was offline may have missed triggers while away. These need to be retrieved on reconnect via `fetchKindHistory`.

```typescript
// On reconnect: fetch missed trigger and arm state signals per paired contact
const lastOnlineSec = getLastOnlineTimestamp();

for (const contactId of nostrClient.allContactIds()) {
  for await (const event of nostrClient.fetchKindHistory(contactId, 5010, {
    windowStart: lastOnlineSec,
  })) {
    handleTriggerSignal(contactId, event.decryptedPayload as TriggerPayload);
  }

  for await (const event of nostrClient.fetchKindHistory(contactId, 5011, {
    windowStart: lastOnlineSec,
  })) {
    handleArmStateSignal(contactId, event.decryptedPayload as ArmStatePayload);
  }
}
```

This uses the same fan-fetch mechanism as all other history fetches — relay selection and channel key decryption are internal.

---

## RTC Connection & Control

### Empty Start

RTC connection begins with **data channels only** (no media):

```typescript
// Viewer initiates
await connectToMonitor(privkey, viewerPubkey, monitorPubkey);

// This sends offer-request with mode: 'data'
// Both sides establish empty connection
```

### In-band Control (RTC Data Channel)

Once RTC is open, all data and control requests flow over the data channel. The monitor hosts a stateless request/response server on the control channel. Request types include coverage maps, segment metadata, segment blob chunks, channel lists, and live-upgrade negotiation. Full message types and protocol are specified in `docs/new/webrtc-communication-flow.md`.

**Live upgrade renegotiation** (in-band):

```
Viewer sends: { type: 'live-request', channelId: 'video-1' } over RTC control channel
Monitor responds: sends renegotiation offer via kind 5001 (isResponse=true, SDP with media tracks)
Viewer sends: answer via kind 5002 (isResponse=false, SDP answer)
[media tracks added to existing RTC connection — 2 Nostr events total]
```

**Note:** All data requests happen AFTER RTC connection is established. No data is ever requested over Nostr.

---

## Nostr Online State

The Nostr stack is online only when there is something to do. `NostrClient.goOnline()` is called by the system (monitor arm, invite listener start) when at least one paired device exists or an active invite listener is open. `NostrClient.goOffline()` is called on disarm, on explicit user disconnect, or automatically after three consecutive all-relay failures.

- **Online:** armed + at least one paired device, OR an active invite listener
- **Offline:** disarmed, relay failure threshold reached, or all paired devices removed and no invite listeners

`goOnline()` announces presence to all registered contacts via kind 5004 and starts the signal router. `goOffline()` announces offline to all contacts before shutting down, then clears the publish queue. Signal router start/stop is managed internally by `NostrClient`.

---

## Summary: Communication Flows

### Pairing (Pre-connection)

```
Monitor generates invite (relays included)
  ↓
Viewer scans QR
  ↓
Viewer accepts → derives channel keys, stores relays
  ↓
Both online → peer-to-peer signals possible
```

### Real-time Status

```
Monitor comes online → broadcasts status (isResponse: false)
  ↓
Viewers receive, reply with status (isResponse: true)
  ↓
Both sides know: device is online
```

### RTC Handshake (Initiating Live View)

```
Viewer sends kind 5001 isResponse=false (declares mode: 'data' or 'live')
  ↓
Monitor sends kind 5001 isResponse=true (SDP offer)
  ↓
Viewer sends kind 5002 isResponse=false (SDP answer)
  ↓
RTC connection open (data-only)
  ↓
Viewer requests live → renegotiation over RTC data channel
  ↓
Monitor sends kind 5001 isResponse=true (new SDP offer with media)
  ↓
Viewer sends kind 5002 isResponse=false (SDP answer)
  ↓
Media tracks added in-band
```

### Senstry Action Signal

```
Trigger fires (pipeline: Sensor → Link → TriggerPublisher)
  ↓
Resolve target contacts (all paired / specific / filtered by state)
  ↓
publishSignal(contactId, 5010, payload) per target — channel key, not real pubkey
  ↓
Online targets receive immediately via T+0 signal router subscription
  ↓
Offline targets fetch on reconnect via fetchKindHistory(contactId, 5010, { windowStart: lastOnline })
```

### Remote Command (Kind 5006, TOTP-Authorized)

```
ContactA: publishSignal(contactBId, 5006, { relay-migrate-command, TOTP credential, newRelays })
  → kind 5006 (isResponse=false) over ContactB's contact channel
  ↓
ContactB: RemoteCommandController validates freshness + TOTP credential
  ↓
ContactB: publishSignal(contactAId, 5006, { isResponse=true, commandId, accepted=true })
  ↓
ContactB: dispatches to "relay-migrate-command" handler
  → proposeInboundMigration(contactAId, newRelays)
  → kind 5005 (isResponse=false) to ContactA's inbound
  ↓
ContactA: receives kind 5005 proposal → normal dual-channel migration ack flow
  → updates outbound = ContactB's newRelays
  → kind 5005 (isResponse=true) to newRelays (proof of listening)
  ↓
ContactB: receives kind 5005 ack → commits migration, stops dual-listening
```

### Relay Migration (Dual-Listening, Autonomous Inbound)

```
ContactA wants to migrate from [relay-a-1] to [relay-a-2]
  ↓
ContactA stores relayProposal in IDB (survive reload)
  ├─ relayProposal.sessionId = UUID
  ├─ relayProposal.newInbound = [relay-a-2]
  └─ relayProposal.proposedAt = now
  ↓
ContactA starts dual-listening: [relay-a-1] + [relay-a-2]
  ↓
ContactA sends proposal over [relay-b-1] (ContactB's inbound):
  "I'm moving to [relay-a-2], please start sending there"
  ↓
ContactB receives on [relay-b-1]
  ├─ Updates outbound = [relay-a-2] (where to send to ContactA now)
  └─ Sends acknowledgement to [relay-a-2] (proves ContactA's new relay is reachable)
  ↓
ContactA receives ack on [relay-a-2]
  ├─ Commits: relays = [relay-a-2]
  ├─ Clears: relayProposal = null
  ├─ Stops dual-listening, keeps only [relay-a-2]
  └─ Updates signal subscriptions
  ↓
Both now communicating over new relays
  [ContactA.outbound = [relay-b-1], ContactB.outbound = [relay-a-2]]
  ↓
If either device offline: relayProposal survives reload, retry on next startup
```

---

## Key Principles

✅ **All post-contact communication uses channel keys** — real pubkeys never appear on Nostr after contact establishment; this applies to RTC signals, status, relay migration, remote commands, and action notifications alike  
✅ **Encrypted** — NIP-44 ChaCha20-Poly1305 over ECDH channel keys for all post-contact events  
✅ **Targeted action signals** — TriggerPublisher sends kind 5010/5011 via `publishSignal(contactId, ...)` to specific paired contacts; no open subscriptions  
✅ **Relay-agnostic** — Each contact entry has its own relay lists; `RelayStateController` handles selection  
✅ **Offline-resilient** — Missed action signals retrieved via `fetchKindHistory` on reconnect  
✅ **Efficient** — Minimal Nostr events (handshake + presence + notifications); all footage data over RTC  
✅ **Flexible** — Action recipients configurable per pipeline action (all / specific / filtered by online state)
