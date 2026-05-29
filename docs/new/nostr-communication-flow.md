# Nostr Communication Architecture


---

## Overview

Senstry uses Nostr for two purposes:

1. **Device Pairing** — QR-based initial device discovery and gift-wrap-based invite delivery (ephemeral keys, temp contacts). Real pubkeys are used only at this layer.
2. **Peer-to-Peer Signals** — All post-pairing communication, including connection setup, presence, relay migration, and action notifications. Every event is NIP-44 encrypted over ECDH channel keys. Real pubkeys never appear.

All post-pairing Nostr events — without exception — are signed with a contact's channel key, not their identity key. This applies to RTC handshake signals, status, relay migration proposals, and sensor-triggered action notifications alike.

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
import { randomBytes } from 'crypto';
import { base32 } from 'rfc4648';

/**
 * Generate a random TOTP seed for a new credential.
 * 
 * @returns 20-byte seed as base32-encoded string (readable QR code)
 */
export function generateTOTPSeed(): string {
  const seed = randomBytes(20);  // 160 bits (base32-encoded = 32 characters)
  return base32.stringify(seed).replace(/=/g, '').toLowerCase();  // 32-char alphanumeric
}

// Example output: "jbswy3dpeblw64tmmq4qy27kfq4qye4"
```

#### Storing TOTP Seeds in IDB

```typescript
interface TOTPCredential {
  credentialId: string;         // UUID or internal identifier
  seed: Uint8Array;             // Raw 20-byte seed (NOT base32)
  createdAt: number;            // unix timestamp
  lastUsedAt?: number;          // track usage
  label?: string;               // "Pairing Code", "Login", etc.
  expiresAt?: number;           // optional expiration (null = no expiry)
  maxAttempts?: number;         // rate limit: max failed attempts
  failedAttempts: number;       // counter for current lockout window
  lockedUntil?: number;         // unix ms; clear when now > lockedUntil
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
    failedAttempts: 0
  };
  
  // Store in IDB
  const db = await openDB();
  await db.put('totp', credential);
  
  return credentialId;
}
```

### TOTP Code Validation

#### Verifying a 6-Digit Code

```typescript
import { totp } from 'speakeasy';  // or equivalent RFC 6238 implementation

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
  window: number = 1
): boolean {
  // Strip non-digits
  const cleanCode = code.replace(/\D/g, '');
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
  const hmac = createHmac('sha1', seed);
  
  // Counter as big-endian 64-bit value
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  
  hmac.update(buffer);
  const digest = hmac.digest();
  
  // Dynamic truncation (RFC 4226)
  const offset = digest[digest.length - 1] & 0x0f;
  const dyn = (digest[offset] << 24) | (digest[offset + 1] << 16) | 
              (digest[offset + 2] << 8) | digest[offset + 3];
  const code = (dyn & 0x7fffffff) % 1000000;
  
  return code.toString().padStart(6, '0');
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
  submittedSeed: string  // Must be base32-encoded 32-character string
): boolean {
  let submitted: Uint8Array;
  
  if (typeof submittedSeed === 'string') {
    // Decode base32 to bytes
    submitted = base32.parse(submittedSeed.toUpperCase().padEnd(40, '='));
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
  codeValid: boolean
): Promise<{ allowed: boolean; lockoutMs?: number }> {
  const db = await openDB();
  const cred = await db.get('totp', credentialId);
  
  if (!cred) {
    return { allowed: false };  // Credential not found
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
      cred.lockedUntil = now + (baseMs * backoffFactor);
      
      // Cap at 1 hour
      if (cred.lockedUntil - now > 3600000) {
        cred.lockedUntil = now + 3600000;
      }
    }
  }
  
  await db.put('totp', cred);
  
  return {
    allowed: codeValid && (!cred.lockedUntil || now >= cred.lockedUntil),
    lockoutMs: cred.lockedUntil ? cred.lockedUntil - now : undefined
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
    return false;  // Credential has expired
  }
  
  return true;
}

/**
 * Clean up expired TOTP credentials.
 * Run periodically (e.g., on app startup).
 */
export async function cleanupExpiredTOTPCredentials(): Promise<number> {
  const db = await openDB();
  const allCredentials = await db.getAll('totp');
  
  let deleted = 0;
  for (const cred of allCredentials) {
    if (!isTOTPCredentialValid(cred)) {
      await db.delete('totp', cred.credentialId);
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
- ✅ Consistent with post-pairing channel key architecture
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
       │ 12. Store as pairedDevices[viewer_pubkey]               │
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
  v: 2;                              // Version (for future upgrades)
  ik: string;                         // Invite key: ephemeral pubkey (hex, 64 chars)
  pk: string;                         // Monitor's real pubkey (hex, 64 chars)
  relays: string[];                   // Monitor's listening relays
  id: string;                         // Invite ID (UUID, opaque to scanner)
  ttl: number;                        // Unix timestamp when QR expires (e.g., now + 300)
  label?: string;                     // Optional: monitor's self-label ("Living Room Camera", "Hallway", etc.)
}
```

**Encoding:**
```typescript
const payload: QRPayload = {
  v: 2,
  ik: ephemeralPubkey,     // ephemeral invite key's pubkey
  pk: monitorRealPubkey,   // monitor's identity
  relays: ['wss://relay1.com', 'wss://relay2.com'],
  id: crypto.randomUUID(),
  ttl: 300,                // 5 minutes
  label: 'Living Room Camera'
};

// Serialize to a compact URI string
const uri = `senstry://pair?${new URLSearchParams({
  v: payload.v.toString(),
  ik: payload.ik,
  pk: payload.pk,
  relays: JSON.stringify(payload.relays),
  id: payload.id,
  ttl: payload.ttl.toString(),
  ...(payload.label && { label: payload.label })
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
  viewerRealPubkey: string,
  viewerRelays: string[],
  qrPayload: QRPayload
): Promise<{ success: boolean; pairedMonitorPubkey?: string; error?: string }> {
  // ─── Step 1: Validate payload ───────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  
  // Check version
  if (qrPayload.v !== 2) {
    return { success: false, error: 'Unsupported QR version' };
  }
  
  // ttl is a unix timestamp of expiry (set by monitor as now + 300)
  if (nowSec > qrPayload.ttl) {
    return { success: false, error: 'QR code has expired' };
  }
  
  // Verify pubkey formats
  if (qrPayload.ik.length !== 64 || qrPayload.pk.length !== 64) {
    return { success: false, error: 'Invalid pubkey format in QR' };
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
    return { success: false, error: 'Channel key derivation failed' };
  }
  
  // ─── Step 3: Create acceptance message ──────────────────────────────────
  // This message contains the viewer's real identity + relays
  // The monitor will use this to derive post-pairing channel keys
  
  const acceptancePayload = {
    type: 'qr-acceptance',
    viewerPubkey: viewerRealPubkey,        // viewer's identity
    viewerRelays: viewerRelays,             // where to send signals to viewer
    timestamp: Math.floor(Date.now() / 1000),
    inviteId: qrPayload.id                 // echo back the invite ID
  };
  
  // ─── Step 4: Encrypt acceptance with temporary channel key ──────────────
  // Single-layer NIP-44 encryption (not gift-wrap)
  
  const encryptedContent = nip44Encrypt(
    JSON.stringify(acceptancePayload),
    tempChannelSecret
  );
  
  // ─── Step 5: Sign with ephemeral key (not real identity) ────────────────
  // This hides viewer's real pubkey on the relay until monitor decrypts
  // Monitor knows to expect an ephemeral signature because it's from the
  // ephemeral invite key's perspective
  
  const ephemeralPrivkey = generateSecretKey();  // New ephemeral key per acceptance
  
  const acceptanceEvent: NostrEvent = finalizeEvent({
    kind: KIND_QR_ACCEPTANCE,  // 5100 (custom kind for QR acceptances)
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', qrPayload.pk],           // tag the monitor's real pubkey
      ['invite', qrPayload.id],      // tag the invite ID
      ['v', '2']                     // version tag
    ],
    content: encryptedContent
  }, ephemeralPrivkey);
  
  // ─── Step 6: Publish acceptance to monitor's relays ────────────────────
  // Fanout to all relays listed in QR
  
  const publishResults: Array<{ relay: string; success: boolean; error?: string }> = [];
  
  for (const relay of qrPayload.relays) {
    try {
      await publish(acceptanceEvent, { relay, timeout: 5000 });
      publishResults.push({ relay, success: true });
    } catch (err) {
      publishResults.push({
        relay,
        success: false,
        error: String(err)
      });
    }
  }
  
  // Check if at least one relay succeeded
  const anySuccess = publishResults.some(r => r.success);
  if (!anySuccess) {
    return {
      success: false,
      error: `Failed to publish to all relays: ${publishResults.map(r => r.error).join(', ')}`
    };
  }
  
  // ─── Step 7: Store paired device locally ────────────────────────────────
  // Derive post-pairing channel keys so we can communicate
  
  const sharedSecret = getConversationKey(viewerPrivkey, qrPayload.pk);
  const inboundChannelKey = deriveChannelKey(sharedSecret, qrPayload.pk, viewerRealPubkey);
  const outboundChannelKey = deriveChannelKey(sharedSecret, viewerRealPubkey, qrPayload.pk);
  
  await addPairedDevice({
    pubkey: qrPayload.pk,                    // monitor's real pubkey
    nickname: qrPayload.label || generateNickname(),
    relays: qrPayload.relays,                // monitor's relays
    capabilities: [],
    lastSeenAt: null,
    channelKeys: {
      inbound: inboundChannelKey,            // listen on monitor's channel outbound
      outbound: outboundChannelKey           // publish on viewer's channel outbound
    },
    addedAt: Date.now()
  });
  
  dbg('info', 'pairing', `QR acceptance sent to ${qrPayload.pk.slice(0, 8)}`);
  
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
  onAccepted: (viewerPubkey: string, viewerRelays: string[], label: string) => void
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
    relays: monitorRelays,
    id: crypto.randomUUID(),
    ttl: Math.floor(Date.now() / 1000) + 300,  // 5 minutes
    label: 'Monitor Device'
  };
  
  // ─── Step 3: Encode and display QR ─────────────────────────────────────
  
  const uri = encodeInviteUri(qrPayload);
  const qrDataUrl = await generateQRDataUrl(uri);
  
  // ─── Step 4: Start listening for acceptances ────────────────────────────
  // Listen on all monitor relays for KIND_QR_ACCEPTANCE (5100) events
  // that we can decrypt with ephemeralInvitePrivkey
  
  const acceptanceHandlers = new Map<string, NostrEvent>();
  
  const cleanup = subscribeToRelays(
    {
      relayUrls: monitorRelays,
      filters: [
        {
          kinds: [KIND_QR_ACCEPTANCE],
          since: Math.floor(Date.now() / 1000) - 10,  // ~10s ago (clock skew buffer)
          limit: 100
        }
      ]
    },
    async (event: NostrEvent) => {
      try {
        // ─ Attempt decryption with ephemeral invite key
        const decrypted = nip44Decrypt(event.content, 
          getConversationKey(ephemeralInvitePrivkey, event.pubkey)
        );
        
        const acceptance = JSON.parse(decrypted) as {
          type: string;
          viewerPubkey: string;
          viewerRelays: string[];
          timestamp: number;
          inviteId: string;
        };
        
        // ─ Validate acceptance format
        if (acceptance.type !== 'qr-acceptance') return;
        if (acceptance.inviteId !== qrPayload.id) return;  // Not for this invite
        
        // ─ Skip if we've already processed this acceptance
        if (acceptanceHandlers.has(event.id)) return;
        acceptanceHandlers.set(event.id, event);
        
        // ─ Validate timestamp (acceptance is fresh, within 1 minute)
        const acceptanceAgeS = Math.floor(Date.now() / 1000) - acceptance.timestamp;
        if (acceptanceAgeS > 60) {
          dbg('warn', 'pairing', `QR acceptance too old: ${acceptanceAgeS}s`);
          return;
        }
        
        // ─ Validate viewer pubkey format
        if (acceptance.viewerPubkey.length !== 64) {
          dbg('warn', 'pairing', 'Invalid viewer pubkey in QR acceptance');
          return;
        }
        
        // ─ Store paired device and derive post-pairing channel keys
        const sharedSecret = getConversationKey(monitorPrivkey, acceptance.viewerPubkey);
        const inboundChannelKey = deriveChannelKey(sharedSecret, acceptance.viewerPubkey, monitorPubkey);
        const outboundChannelKey = deriveChannelKey(sharedSecret, monitorPubkey, acceptance.viewerPubkey);
        
        await addPairedDevice({
          pubkey: acceptance.viewerPubkey,
          nickname: generateNickname(),
          relays: acceptance.viewerRelays,
          capabilities: [],
          lastSeenAt: null,
          channelKeys: {
            inbound: inboundChannelKey,
            outbound: outboundChannelKey
          },
          addedAt: Date.now()
        });
        
        dbg('info', 'pairing', `QR acceptance received from ${acceptance.viewerPubkey.slice(0, 8)}`);
        
        // Call the callback (triggers onAccepted handler)
        onAccepted(acceptance.viewerPubkey, acceptance.viewerRelays, 'Viewer');
        
      } catch (err) {
        // Not decryptable — either not for us or corrupt data
        // Silently skip; this is normal
      }
    }
  );
  
  return { qrDataUrl, uri, cleanup };
}
```

### Key Derivation Details

Both monitor and viewer independently derive **identical channel keys** from the same ECDH shared secret:

```typescript
/**
 * Derivation formula (both sides compute independently):
 *
 * 1. Compute shared ECDH secret:
 *    sharedSecret = getConversationKey(own_privkey, peer_pubkey)
 *
 * 2. Derive directional channel keys:
 *    inbound = deriveChannelKey(sharedSecret, peer_pubkey, own_pubkey)
 *    outbound = deriveChannelKey(sharedSecret, own_pubkey, peer_pubkey)
 *
 * 3. Use derived keys as channel pubkeys in post-pairing signals
 */

// Example: Monitor's perspective
const monitorSharedSecret = getConversationKey(monitorPrivkey, viewerPubkey);
const monitorInbound = deriveChannelKey(monitorSharedSecret, viewerPubkey, monitorPubkey);
const monitorOutbound = deriveChannelKey(monitorSharedSecret, monitorPubkey, viewerPubkey);

// Example: Viewer's perspective (identical keys, different perspective)
const viewerSharedSecret = getConversationKey(viewerPrivkey, monitorPubkey);
const viewerInbound = deriveChannelKey(viewerSharedSecret, monitorPubkey, viewerPubkey);
const viewerOutbound = deriveChannelKey(viewerSharedSecret, viewerPubkey, monitorPubkey);

// Assertion (both sides):
// monitorOutbound === viewerInbound  (monitor sends on this channel)
// viewerOutbound === monitorInbound  (viewer sends on this channel)
```

**Why this is safe:**
- The derivation function is **deterministic** — same inputs always produce same output
- The derivation is **directional** — swapping sender/recipient produces a different key
- No key exchange is needed — both sides compute from existing identities
- The temporary channel key for acceptance is **ephemeral** — only used once, then discarded
- The post-pairing keys are **derived from real identities**, not stored — re-derived on app restart

### Gift Wrap Structure for Non-Paired Communication

Nostr-delivered invites, TOTP-secured instructions, and any other communication with a non-paired device use NIP-59 gift wrap. This is the only mechanism in Senstry that uses gift wrap — signals between paired devices never use it.

**Three-layer structure:**

```
Gift Wrap (kind 1059)
  pubkey: random one-time key         ← relay sees nothing about sender identity
  p tag: recipient's real pubkey      ← routing only; relay delivers to this pubkey's subscribers
  content: NIP-44(random key → recipient pubkey, Seal)

  └── Seal (kind 13)
        pubkey: sender's real pubkey  ← recipient learns sender identity after decryption
        content: NIP-44(sender privkey → recipient pubkey, Rumor)
        created_at: randomized ±2 days

        └── Rumor (unsigned kind 5200 or similar)
              pubkey: sender's real pubkey
              created_at: honest timestamp
              content: {
                type: 'pairing-invite' | 'totp-instruction' | ...
                replyKey: <sender's ephemeral pubkey>,   ← recipient's outboundChannelKey
                replyRelays: [...],                       ← recipient's outboundRelayList
                ttl: 3600,
                credential?: '...',                       // TOTP code/seed if secured
                ...payload
              }
```

**Timestamp handling:** the seal and gift wrap layers use randomized `created_at` (within ±2 days) to protect against time-analysis. The rumor's `created_at` is honest. Gift-wrapped events are found via `#p` tag filtering, not `since` filtering.

### Temp Contact Creation on Gift Wrap Receipt

When a device receives and decrypts a gift wrap, it creates a temp contact entry in `ContactManager`:

```typescript
// After decrypting the gift wrap and seal:
const rumor = decryptGiftwrap(giftWrapEvent, myPrivkey);

const tempContactId = nostrClient.registerTempContact({
  pubkey: seal.pubkey,                    // sender's real pubkey (from decrypted seal)

  inboundChannelKey: generateKeypair(),   // fresh ephemeral key; privkey held in memory
                                          // pubkey included in our response as return address

  outboundChannelKey: rumor.content.replyKey,   // sender's ephemeral key from rumor
                                                 // null if sender didn't include one
  inboundRelayList: [myRelay],            // where WE listen for their response
  outboundRelayList: rumor.content.replyRelays, // where WE send our response

  addedAt: Date.now(),
  expiresAt: Date.now() + rumor.content.ttl * 1000,
});

// Now respond using the same API as a paired device:
await nostrClient.sendGiftWrap(tempContactId, {
  type: 'totp-response',
  replyKey: tempContact.inboundChannelKey.pubkey,  // included automatically by sendGiftWrap
  replyRelays: tempContact.inboundRelayList,        // included automatically
  result: 'accepted',
  // ...
});
```

**When the sender receives the response:**
The response gift wrap is addressed to `replyKey` (the sender's original ephemeral key). The sender creates their own temp contact entry pointing back at the responder's `inboundChannelKey`:

```typescript
// Sender receives response addressed to their ephemeral reply key
// seal.pubkey = responder's real pubkey
// rumor.content.replyKey = responder's inboundChannelKey.pubkey
const tempContactId = nostrClient.registerTempContact({
  pubkey: seal.pubkey,
  inboundChannelKey: myOriginalEphemeralKey,  // sender already holds this privkey
  outboundChannelKey: rumor.content.replyKey, // responder's return address
  inboundRelayList: [myRelay],
  outboundRelayList: rumor.content.replyRelays,
  addedAt: Date.now(),
  expiresAt: ...,
});
```

Both sides now have symmetric temp contact entries pointing at each other's ephemeral keys. Subsequent messages use `sendGiftWrap(contactId, payload)` — identical to communicating with a paired device.

**Multiple temp contacts with the same pubkey:** each gift wrap interaction generates a unique `inboundChannelKey`, so each has a distinct `contactId`. Multiple parallel TOTP sessions with the same real identity are tracked separately.

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

| Aspect | Pairing Protocol | TOTP Layer |
|--------|------------------|-----------|
| Scope | Identity exchange, key derivation | Credential validation only |
| Reusable | No, specific to Senstry pairing | Yes, can be used for login, re-auth, API access, etc. |
| Required | Yes (core pairing mechanism) | No (optional security enhancement) |
| Backward compatible | Must preserve invite format | Doesn't affect pairing protocol |
| Delivery | QR code or Nostr (independent of pairing) | Works with any delivery mechanism |

**Example:** A login flow uses the same TOTP infrastructure (generate seed, validate code, rate limit attempts) without touching the pairing protocol at all. Conversely, QR-based pairing does not require TOTP; viewers can accept invites without credentials.

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
- **Rationale:** Nostr-delivered invites travel on public relays. TOTP validates that the acceptance came from someone who knows the shared secret (the viewer who is authorized to pair), not from relay surveillance.
- **Flow:**
  1. Monitor publishes gift-wrap invite → derives TOTP seed from ephemeral invite key
  2. Monitor embeds TOTP code (6 digits) in invite payload
  3. Viewer receives gift-wrap → extracts invite + TOTP code
  4. Viewer enters TOTP code in app (or app auto-fills if from QR/direct URI)
  5. Acceptance message includes TOTP code as proof of authorization
  6. Monitor validates TOTP before storing pairing

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
| Nostr-delivered | Required | Relays are public; TOTP validates recipient authorization |
| Programmatic API | Required | Stateless; TOTP is the shared secret |

### Acceptance Message Format

The acceptance payload (encrypted and published by viewer) contains all information needed for the monitor to complete pairing:

```typescript
interface QRAcceptancePayload {
  type: 'qr-acceptance';
  viewerPubkey: string;          // viewer's real pubkey (hex, 64 chars)
  viewerRelays: string[];        // where monitor should send signals to viewer
  timestamp: number;             // unix seconds (creation time)
  inviteId: string;              // echoed from QR payload; secondary correlation check
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

### Why No Gift-Wrap

Gift-wrap (NIP-59) is **not needed** for QR-based pairing:

| Aspect | Gift-wrap | QR Method |
|--------|-----------|-----------|
| **Purpose** | Hide recipient and content from relays | Hide acceptance content from relays |
| **Overhead** | ~20% larger (double-encrypted, sealed, wrapped) | Single NIP-44 layer |
| **Relay cost** | Expensive: must return all gift-wraps meant for recipient | Cheap: filter by kind (5100) + tag query |
| **Decryption complexity** | 3-layer: unwrap → unseal → decrypt | 1-layer: decrypt |
| **Real pubkey exposure** | Hidden until after unwrap | Signed with ephemeral key; revealed in encrypted content |
| **Scalability** | Grows with pairing count (each pairing adds subscriptions) | Ephemeral per-invite (single listening window) |

**Why QR method is simpler:**
1. Monitor generates ephemeral key **for this specific invite only**
2. Viewer derives temporary channel key from ephemeral pubkey
3. Viewer publishes acceptance encrypted with that temporary key
4. Monitor decrypts with ephemeral privkey
5. Once acceptance is received, ephemeral key is discarded

No need for the full NIP-59 machinery because we're not building a long-term encrypted channel yet — we're just bridging the gap between QR scanning and deriving the real channel keys.

## TOTP: Remote Instruction Authorization

### Overview

**TOTP** is a general-purpose credential validation protocol (RFC 6238 time-based one-time passwords) for **authorizing ANY remote instruction** that requires credential validation. It is **independent of any specific action** (pairing, login, relay migration, etc.) and can be used whenever a device needs to validate that a remote action is authorized by someone who knows a shared secret.

TOTP is **not a protocol for specific actions** — it is a **generic credential layer** that can wrap any remote instruction:

- Device pairing acceptance (example: "Accept this invite from Device X")
- Login to account (example: "Unlock my account with my password + TOTP code")
- Credential reset (example: "Change my recovery passphrase")
- API access authorization (example: "Generate an API token")
- Relay migration (example: "Approve relay change to new server")

**Key property:** TOTP validates credentials; it does **not** define the action being authorized. The action payload (pairing invite, login request, etc.) is orthogonal to TOTP; TOTP only verifies that the remote party knows the shared secret.

### Credential Validation: Time-Based One-Time Passwords (TOTP)

The TOTP implementation is fully detailed in the "Security Layer" section at the beginning of this document. This section summarizes key concepts:

**TOTP operates in two modes:**

1. **Interactive Mode** (user-facing): Validate 6-digit codes
   - User reads code from authenticator app (e.g., Google Authenticator, Authy)
   - User enters code on recipient device
   - Recipient validates code against stored seed (RFC 6238, ±1 window)

2. **Programmatic Mode** (API/automation): Validate raw seeds
   - Sender includes TOTP seed (base32-encoded) in the remote instruction
   - Recipient compares sent seed against stored seed (constant-time comparison)
   - No user entry required; seed = bearer token for programmatic access

**Both modes use the same 20-byte seed** (160 bits, base32-encoded = 32 alphanumeric characters).

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
  type: string;                    // 'pairing-accept', 'login', 'api-token', etc.
  credential: string;              // TOTP seed (base32, 32 chars) or code (6 digits)
  credential_type: 'seed' | 'code'; // which validation mode to use
  ttl: number;                      // seconds (credential validity window)
  // ... other instruction-specific fields (action, relays, etc.)
  created_at: number;              // unix timestamp (for freshness check)
}
```

### Example: Pairing Acceptance with TOTP

Pairing invite authorization is **one use case** of the TOTP protocol. Here's how it applies:

**Monitor side (sender):**
```typescript
// Monitor generates invite + TOTP seed
const { ephemeralPrivkey, ephemeralPubkey } = genKeyPair();
const totpSeed = generateTOTPSeed();  // base32 string (32 chars)

// Build pairing invite payload with credential
const payload: RemoteInstructionPayload = {
  type: 'pairing-accept',
  ephemeral_pubkey: ephemeralPubkey,
  client_pubkey: monitorPubkey,
  client_relays: monitorRelays,
  sessionUUID: crypto.randomUUID(),
  credential: totpSeed,
  credential_type: 'seed',
  ttl: 3600,  // 1 hour validity window
  created_at: Math.floor(Date.now() / 1000)
};

// Pre-pairing: encrypt with real identity keys (no channel keys exist yet)
const sharedSecret = getConversationKey(monitorPrivkey, viewerPubkey);
const encrypted = nip44Encrypt(JSON.stringify(payload), sharedSecret);

// Publish as Nostr event (kind 5200 for pairing invites)
await publish({
  kind: 5200,
  content: encrypted,
  tags: [['p', viewerPubkey]],
  created_at: payload.created_at
});
```

**Viewer side (recipient):**
```typescript
// Viewer receives event and decrypts payload
const sharedSecret = getConversationKey(viewerPrivkey, monitorPubkey);
const payload = JSON.parse(nip44Decrypt(event.content, sharedSecret));

// Validate freshness
const payloadAge = Math.floor(Date.now() / 1000) - payload.created_at;
if (payloadAge > payload.ttl) {
  throw new Error('Instruction has expired');
}

// Validate TOTP credential
let credentialValid = false;
if (payload.credential_type === 'seed') {
  // Compare seed against stored TOTP credential
  const storedSeed = await retrieveStoredTOTPSeed();  // from IDB
  credentialValid = verifyRawSeed(storedSeed, payload.credential);
} else if (payload.credential_type === 'code') {
  // Validate 6-digit code against stored seed
  const storedSeed = await retrieveStoredTOTPSeed();
  credentialValid = verifyTOTPCode(storedSeed, payload.credential);
}

if (!credentialValid) {
  // Record failed attempt + apply rate limiting
  await recordTOTPAttempt(credentialId, false);
  throw new Error('Credential invalid');
}

// Credential valid — proceed with instruction
await recordTOTPAttempt(credentialId, true);
await acceptPairingInvite(payload);  // Pairing-specific logic
```

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

### Security Considerations

**TOTP validates credentials, not identity:**
- TOTP proves "you know the shared secret", not "you are Device X"
- Always verify the **instruction payload** in addition to credential (wrong payload + right credential = still wrong)
- Use TOTP as a **second factor** (with ECDH encryption and real pubkey verification)

**TOTP does not prevent relay eavesdropping:**
- Event itself is encrypted (NIP-44), but relay can see recipient pubkey and timestamp
- Attacker cannot forge instruction (wrong credential fails validation)
- Attacker can replay old instructions if **freshness check fails** — always validate `created_at` against `ttl`

**Rate limiting prevents brute-force:**
- Failed attempts increment counter; after N attempts, credential locks for exponential backoff
- Even if attacker knows the TOTP seed, they cannot bypass rate limiting
- See `recordTOTPAttempt()` in Security Layer for implementation

**Credential expiration prevents replay:**
- TOTP code expires after 30 seconds (RFC 6238)
- Instruction payload expires after `ttl` (typically 1 hour for pairing, 5 minutes for sensitive operations)
- Never accept instructions with `created_at > now + clock_skew`

---

### Post-Pairing Transition to Channel Keys

After successful invite acceptance (whether QR or Nostr delivery), both devices have:
- Each other's **real pubkeys** (from QR payload and acceptance message)
- **Relay lists** (from QR and acceptance)
- **Shared ECDH secret** (computed from their privkeys)

Now they can **independently derive post-pairing channel keys**:

```typescript
// Monitor's computation:
const monitorSharedSecret = getConversationKey(monitorPrivkey, viewerPubkey);
const monitorInbound = deriveChannelKey(monitorSharedSecret, viewerPubkey, monitorPubkey);
const monitorOutbound = deriveChannelKey(monitorSharedSecret, monitorPubkey, viewerPubkey);

// Viewer's computation:
const viewerSharedSecret = getConversationKey(viewerPrivkey, monitorPubkey);
const viewerInbound = deriveChannelKey(viewerSharedSecret, monitorPubkey, viewerPubkey);
const viewerOutbound = deriveChannelKey(viewerSharedSecret, viewerPubkey, monitorPubkey);

// Both derive identical keys:
// monitorOutbound === viewerInbound  ✓
// monitorInbound === viewerOutbound  ✓
```

All subsequent signals (status, RTC handshake, relay updates, etc.) are published with these **channel key pubkeys** and **single-layer NIP-44 encryption**. Real pubkeys never appear on Nostr again.

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
    viewerPubkey: '...',            // viewer's real pubkey
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

---

## Signal Exchange Patterns

Signal kinds 5001–5005 are the universal mechanism for device-to-device communication. They work identically for any `contactId` — paired devices use ECDH-derived channel keys; temp (gift-wrap) contacts use ephemeral keys. The caller never handles keys or relay lists directly; those are internal to `ContactManager`.

### Signal Kinds (5001–5005)

Signals use dedicated Nostr kinds — one per signal type. Relays cannot filter by encrypted content, so each signal type requires its own kind for targeted fetching. All signals are NIP-44 encrypted over the contact's channel keys. Signals handle **connection setup and presence only** — data requests flow over RTC data channels.

Within each kind, `isResponse` distinguishes the initiating party from the responding party, eliminating paired type strings (e.g. `offer-request` + `offer` collapse into kind 5001 with `isResponse: false | true`).

```typescript
// Kind 5001 — RTC Session
// isResponse=false: viewer asks monitor for an SDP offer (declares desired mode)
// isResponse=true: monitor responds with SDP offer
interface RtcSessionPayload {
  sessionId: string;
  mode?: 'live' | 'data';  // isResponse=false only
  sdp?: string;            // isResponse=true only
  isResponse: boolean;
}

// Kind 5002 — RTC Answer
// isResponse=false: viewer sends SDP answer to complete the WebRTC handshake
// isResponse=true: monitor acknowledges (optional)
interface RtcAnswerPayload {
  sessionId: string;
  sdp?: string;   // isResponse=false: the SDP answer
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
interface StatusPayload {
  state: 'online' | 'offline';
  isResponse: boolean;
}

// Kind 5005 — Relay Migration
// isResponse=false: device proposes new inbound relays
// isResponse=true: peer acknowledges (confirms it reached the new relay)
interface RelayMigrationPayload {
  sessionId: string;
  newRelays?: string[];  // isResponse=false: proposed relay list
  timestamp: number;
  isResponse: boolean;
}
```

**Transmission (all signal kinds):**
```
Kind: 5001–5005 (one per signal type)
Pubkey: contact's inboundChannelPubkey (paired: ECDH-derived; temp: ephemeral)
Content: NIP-44 encrypted kind-specific payload
created_at: honest timestamp (not randomized)
Relay: selected by RelayStateController from contact's outboundRelayList
```
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
    5001?: number;  // RTC Session
    5002?: number;  // RTC Answer
    5003?: number;  // RTC Hangup
    5004?: number;  // Status
    5005?: number;  // Relay Migration
  };
}

// On startup: for each contact, fetch from last known watermark
// Relay list and channel key resolved internally from contactId — caller passes neither
async function resumeSignalFetches() {
  for (const contactId of nostrClient.allContactIds()) {
    const wm = getWatermark(contactId);

    // Check for pending relay migration proposals
    for await (const event of nostrClient.fetchKindHistory(contactId, 5005,
      { windowStart: wm[5005] ?? (now() - 86400) }
    )) {
      const msg = event.decryptedPayload as RelayMigrationPayload;
      updateWatermark(contactId, 5005, event.created_at);
      if (!msg.isResponse) {
        handleRelayMigrationProposal(contactId, msg);
        break;  // newest unacknowledged proposal found
      }
    }

    // Get last known status
    for await (const event of nostrClient.fetchKindHistory(contactId, 5004,
      { windowStart: wm[5004] ?? (now() - 3600) }
    )) {
      const msg = event.decryptedPayload as StatusPayload;
      if (!msg.isResponse) {
        updateContactStatus(contactId, msg.state, event.created_at);
        updateWatermark(contactId, 5004, event.created_at);
        break;  // newest announcement found
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
  await nostrClient.publishSignalDirect(contactId, 5004, { state: 'online', isResponse: false });
}

// Viewer receives via signal router and replies
nostrClient.startSignalRouter((contactId, kind, payload) => {
  if (kind === 5004 && !payload.isResponse) {
    nostrClient.publishSignalDirect(contactId, 5004, { state: 'online', isResponse: true });
  }
});
```

**Status solicitation** (manual "Status?" button):
```typescript
// Viewer sends kind 5004 isResponse=false — monitor treats any isResponse=false as both
// announcement and reply solicitation
await nostrClient.publishSignalDirect(monitorContactId, 5004, { state: 'online', isResponse: false });
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
DeviceA relays:
  inbound (current) = [wss://relay-a-1.com]     (where DeviceA listens)
  inbound (proposed) = [wss://relay-a-2.com]    (where DeviceA wants to listen)
  outbound = [wss://relay-b-1.com]              (where DeviceB listens)

DeviceB relays:
  inbound (current) = [wss://relay-b-1.com]     (where DeviceB listens)
  outbound = [wss://relay-a-1.com]              (where DeviceA listens; updates when DeviceA proposes)

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

### Migration Flow (DeviceA: relay-a-1 → relay-a-2)

**Step 1: DeviceA proposes and dual-listens**
```
DeviceA:
  ├─ Starts dual-listening to: [relay-a-1.com] + [relay-a-2.com]
  ├─ Sends proposal to: [relay-b-1.com]
  │  Message: "I'm migrating from relay-a-1 to relay-a-2"
  │  (kind 5005, isResponse=false, sessionId: UUID, newRelays: [relay-a-2])
  └─ State: waiting-for-acknowledgement
```

**Step 2: DeviceB receives and acknowledges**
```
DeviceB receives on [relay-b-1.com]:
  ├─ Learns: DeviceA wants to listen on [relay-a-2.com]
  ├─ Updates: outbound = [relay-a-2.com] (where to send to DeviceA now)
  ├─ Starts listening to: [relay-a-2.com]
  └─ Sends acknowledgement to: [relay-a-2.com]
     Message: "I see you on relay-a-2, acknowledging your migration"
     (kind 5005, isResponse=true, sessionId: UUID)
```

**Step 3: DeviceA receives acknowledgement and commits**
```
DeviceA receives ack on [relay-a-2.com]:
  ├─ Sees: DeviceB is listening to relay-a-2
  ├─ Commits: inbound = [relay-a-2.com]
  ├─ Stops listening to: [relay-a-1.com]
  └─ State: committed

Result:
  DeviceA: inbound = [relay-a-2.com], outbound = [relay-b-1.com]
  DeviceB: inbound = [relay-b-1.com], outbound = [relay-a-2.com]
  ✓ Communication over: [relay-b-1.com] ↔ [relay-a-2.com]
```

**Why communications never break:**
- DeviceA always sends to [relay-b-1.com] ✓ (unchanged throughout)
- DeviceB always listens to [relay-b-1.com] ✓ (unchanged throughout)
- Acknowledgement sent to new relay where both are already dual-listening
- DeviceB starts sending to new relay **immediately** upon receiving proposal

**Code: DeviceA proposes migration**
```typescript
async function proposeInboundMigration(contact, newInbound) {
  // Example: DeviceA proposing relay-a-1 → relay-a-2
  // contact.relays = [wss://relay-a-1.com]
  // newInbound = [wss://relay-a-2.com]
  // contact.outbound = [wss://relay-b-1.com]  (DeviceB's inbound)
  
  const sessionId = crypto.randomUUID();
  
  // Step 1: Add subscriptions to new relays BEFORE sending proposal
  // CRITICAL: Verify subscriptions are established before proposal, so we can receive ack
  // If we send proposal but aren't listening to newInbound relays, we'll miss DeviceB's ack
  addRelaySubscription(newInbound, {
    kinds: [5005],  // Relay Migration only
    authors: [contact.inboundChannelKey],
    since: Math.floor(Date.now() / 1000),  // T+0
    label: 'relay-proposal'
  });
  
  // Wait briefly for subscriptions to establish (relays need time to connect)
  // In practice, this happens quickly (~100ms), but we want certainty before sending proposal
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Step 2: Store proposal to IDB (survives reload)
  contact.relayProposal = {
    sessionId,
    newInbound,  // [wss://relay-a-2.com, ...]
    proposedAt: Date.now()
  };
  await savePairedDevice(contact);
  
  // Step 3: NOW send proposal over peer's inbound relays (our outbound)
  // Dual-listening is ready; we're listening on both old and new inbound relays
  // Sends proposal to [wss://relay-b-1.com] where DeviceB is listening
  await sendSignal(privkey, myPubkey, contact.pubkey, {
    // kind 5005 (Relay Migration), isResponse=false = proposal
    isResponse: false,
    sessionId,
    newRelays: newInbound,  // "I want to use [relay-a-2]"
    timestamp: Math.floor(Date.now() / 1000)
  }, { relays: contact.outbound, kind: 5005 });
}
```

**Step 3: DeviceA waits for acknowledgement on dual-listened relays**
```typescript
async function waitForInboundMigrationAck(contact) {
  const { sessionId, newInbound, proposedAt } = contact.relayProposal;
  
  // Listen on both old and new relays for acknowledgement
  // DeviceA is dual-listening: [relay-a-1.com] + [relay-a-2.com]
  // Acknowledgement will come from DeviceB on [relay-a-2.com] (where they just learned to send)
  
  const allListenRelays = [...new Set([...contact.relays, ...newInbound])];
  
  try {
    // Wait for ack signal on either old or new inbound
    // Timeout: 30 seconds (relay propagation + peer processing)
    // Filter by sessionId to ensure we only accept acks for CURRENT proposal
    // (Watermark-based fetching prevents the relay from returning massive historical batches)
    const ack = await waitForSignal(
      {
        kind: 5005,       // Relay Migration
        isResponse: true,
        sessionId,        // ← Must match CURRENT proposal's sessionId (rejects stale acks)
        fromPubkey: contact.pubkey
      },
      { relays: allListenRelays, timeout: 30_000 }
    );
    
    if (ack) {
      // Acknowledgement received for CURRENT proposal — commit migration
      contact.relays = newInbound;
      contact.relayProposal = null;
      
      // Cleanup: stop dual-listening, keep only new inbound
      removeRelaySubscription(contact.relays, { label: 'relay-proposal' });
      
      // Update signal subscriptions to new inbound
      resetSignalSubscriptions();
      
      await savePairedDevice(contact);
      return true;
    }
  } catch (err) {
    // Ack timeout — peer may be offline or ack lost
    // Relays keep old acks, but they don't match current sessionId so won't confuse retry
    dbg('warn', 'relay-migration', `ack timeout for ${contact.pubkey} after ${Date.now() - proposedAt}ms`);
    
    // Will retry on next startup via resumePendingRelayMigrations()
    return false;
  }
}
```

**Step 4: DeviceB receives proposal and immediately acknowledges**
```typescript
// Signal router delivers: (contactId, kind, payload)
// kind 5005 = Relay Migration; isResponse=false = proposal
onSignal((contactId, kind, payload) => {
  if (kind === 5005 && !payload.isResponse) {
    const msg = payload as RelayMigrationPayload;
    const contact = getPairedDevice(fromPubkey);
    
    // Example scenario:
    // DeviceB receives on [relay-b-1.com] (where we're listening):
    //   msg.newRelays = [relay-a-2.com]
    //   msg.sessionId = UUID
    // DeviceA's proposal: "I'm moving to relay-a-2, start sending to me there"
    
    // Step 4a: Start listening to peer's new inbound
    // This is dual-listening for DeviceB: we'll catch the ack we're about to send
    addRelaySubscription(msg.newRelays, {
      kinds: [5005],  // Relay Migration only
      authors: [contact.inboundChannelKey],  // our inbound channel (DeviceA's outbound)
      since: Math.floor(Date.now() / 1000),  // T+0
      label: 'relay-proposal'
    });
    
    // Step 4b: Send acknowledgement to peer's new inbound
    // Sending to [relay-a-2.com] proves DeviceB can reach DeviceA on the new relay
    await sendSignal(privkey, myPubkey, fromPubkey, {
      // kind 5005 (Relay Migration), isResponse=true = acknowledgement
      isResponse: true,
      sessionId: msg.sessionId,
      timestamp: Math.floor(Date.now() / 1000)
    }, { relays: msg.newRelays, kind: 5005 });  // Send to [relay-a-2.com]
    
    // Step 4c: Update our outbound to peer's new inbound
    // From now on, all signals to DeviceA go to [relay-a-2.com]
    contact.outbound = msg.newRelays;
    
    // Step 4d: Update signal router subscriptions
    resetSignalSubscriptions();
    
    await savePairedDevice(contact);
  }
});
```

**Step 5: Recovery on reload (resume dual-listening)**
```typescript
async function resumePendingRelayMigrations() {
  const devices = await getAllPairedDevices();
  
  for (const contact of devices) {
    // Check if migration was in-flight (proposal stored)
    if (!contact.relayProposal) continue;
    
    const { sessionId, newInbound, proposedAt } = contact.relayProposal;
    
    // Example scenario on reload:
    // contact.relays = [relay-a-1.com]  (old established inbound)
    // contact.relayProposal.newInbound = [relay-a-2.com]  (proposed new inbound)
    // We were proposing before the app crashed; resume waiting for ack
    
    // Use watermark-based fetching (see "Signal Fetching Strategy" section)
    // Only fetch events newer than last known created_at to avoid relay rate limit burn
    
    // Step 5a: Dedup check — prevent duplicate proposals after reload
    // Clock skew and simultaneous reboot race condition:
    // - If both devices reload, initiator re-proposes with same sessionId but potentially different createdAt (±1s drift)
    // - Dedup must be independent of timestamp; sessionId + initiatorPubkey is the unique proposal identifier
    // 
    // Fix: Use sessionId + initiatorPubkey for dedup (not timestamp)
    // Rationale: sessionId is unique per migration attempt; if same (sessionId, initiatorPubkey) appears in history,
    // it's the same migration proposal regardless of timing. Compare createdAt only for tie-breaking: if older,
    // use stored proposal; if newer, update and re-send ack.
    
    const recentProposalHistory = await getRecentRelayProposals(contact.pubkey, since: proposedAt - 60000);
    const existingProposal = recentProposalHistory.find(p => p.sessionId === sessionId && p.initiatorPubkey === contact.pubkey);
    
    if (existingProposal) {
      if (proposedAt < existingProposal.createdAt) {
        // Stored proposal is newer; use it (skip this older one)
        dbg('info', 'relay-migration', `skipping older proposal for ${contact.pubkey} (newer one already stored)`);
        continue;
      } else if (proposedAt === existingProposal.createdAt) {
        // Same timestamp; exact duplicate (already sent before reload)
        dbg('info', 'relay-migration', `skipping duplicate proposal for ${contact.pubkey} (same sessionId+initiator+timestamp)`);
        continue;
      } else {
        // Newer timestamp; update stored proposal and proceed
        dbg('info', 'relay-migration', `updating proposal for ${contact.pubkey} to newer timestamp`);
        contact.relayProposal.proposedAt = proposedAt;
      }
    }
    
    // Step 5b: Re-add dual-listening
    // DeviceA is still listening to both old and new inbound after reload
    addRelaySubscription(newInbound, {
      kinds: [5005],  // Relay Migration only
      authors: [contact.inboundChannelKey],
      since: Math.floor(Date.now() / 1000),  // T+0
      label: 'relay-proposal'
    });
    
    // Step 5c: Continue waiting for acknowledgement
    // Resume the ack wait; timeout will trigger another retry on next startup
    // waitForInboundMigrationAck() MUST filter by sessionId to avoid accepting stale acks
    const ackReceived = await waitForInboundMigrationAck(contact);
    
    if (ackReceived) {
      dbg('info', 'relay-migration', `resumed and completed for ${contact.pubkey}`);
    } else {
      dbg('info', 'relay-migration', `resumed but still waiting for ack from ${contact.pubkey}`);
      // relayProposal stays in IDB; next startup will retry again
    }
  }
}
```

### Key Properties of Dual-Channel Migration

**Communications never break:**
- **DeviceA always sends to `[relay-b-1.com]`** (DeviceB's inbound) throughout migration — never changes
- **DeviceB dual-listens to old+new inbound** during entire handshake — catches proposal and ack on either relay
- All proposals reach destination; all acks reach source

**Multiple concurrent proposals are safe:**
- Each proposal has unique `sessionId`
- Initiator waits for ack matching its **LATEST** proposal's `sessionId`
- Latest proposal implicitly wins; no explicit conflict resolution needed
- Both devices can independently propose inbound changes without coordination

**Cleanup happens only after acknowledgement:**
- **Initiator** (e.g., DeviceA): dual-listens to `[relay-a-1.com, relay-a-2.com]` until ack received
- **Acknowledger** (e.g., DeviceB): starts sending to new inbound `[relay-a-2.com]` immediately upon receiving proposal, sends ack as proof
- After ack, initiator commits and stops dual-listening

**Each device autonomously controls only its own inbound:**
- **DeviceA** can propose A→A2→A3→... without waiting for previous proposals to complete
- **DeviceB** acknowledges **ONE** (latest with highest sessionId) and updates where it sends to DeviceA
- No "agreement phase"—just proposal + proof of listening via acknowledgement
- Example: DeviceA proposes A2, then proposes A3 before A2 ack arrives → DeviceB will eventually acknowledge A3 and ignore A2

---

## PairedDevice Data Model

```typescript
interface PairedDevice {
  pubkey: string;
  
  // Relay lists (independent per device)
  relays: string[];         // MY inbound relays (where I listen for signals)
  outbound: string[];       // PEER's inbound relays (where I send signals to them)
  
  // Relay migration state
  relayProposal?: {
    sessionId: string;
    newInbound: string[];   // my proposed new listening relays
    proposedAt: number;
  };
  
  // ... other fields ...
}
```

---

## Resilience Properties

**Communications never fail:**
- Initiator proposes over peer's inbound (unchanged throughout migration)
- Acknowledger dual-listens to old+new inbound (catches ack anywhere)
- All proposals reach destination; all acks reach source

**Concurrent proposals are safe:**
- Each proposal has unique `sessionId`
- Initiator waits for latest proposal's sessionId
- Latest proposal implicitly wins (no explicit "resolve conflict" logic needed)
- Both devices can independently propose inbound changes without interference

**Graceful failure and recovery:**
- If ack lost: initiator checks for other signals; if peer sending anything, retry proposal
- If app crashes mid-migration: `relayProposal` stored in IDB; resume by checking for matching ack
- If peer offline: keep proposal persisted; retry on each startup until ack found

**Single source of truth per device:**
- Each device controls only its own inbound (where it listens)
- Peer's inbound is read-only (updated via peer's proposals only)
- No "agreement needed"—proposal + proof of listening is sufficient

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

Action signals are the Nostr layer of the Senstry pipeline. When a sensor fires and the pipeline resolves an action that includes a Nostr notification, `TriggerPublisher` sends a targeted channel-key signal to specific paired contacts. There are no real pubkeys, no open subscriptions, no public broadcasts. Action signals use the same encryption and routing as all other post-pairing signals.

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

| Kind | Name | Purpose |
|------|------|---------|
| 5010 | Trigger | Sensor fired — detection type, timestamp, confidence |
| 5011 | Arm State | Monitor armed or disarmed |

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
    const all = this.contactManager.allContactIds()
      .filter(id => !this.contactManager.get(id).expiresAt); // paired only

    switch (config.recipients) {
      case 'all':       return all;
      case 'specific':  return all.filter(id => config.contactIds.includes(id));
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
  for await (const event of nostrClient.fetchKindHistory(contactId, 5010,
    { windowStart: lastOnlineSec }
  )) {
    handleTriggerSignal(contactId, event.decryptedPayload as TriggerPayload);
  }

  for await (const event of nostrClient.fetchKindHistory(contactId, 5011,
    { windowStart: lastOnlineSec }
  )) {
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

Once RTC is open, all data and control requests flow over the data channel. The monitor hosts a data channel server that responds to:

```typescript
// Over RTC controlChannel (JSON requests):
{ type: 'segment-request', segmentId: 'xyz' }
{ type: 'coverage-request', channelId: 'video-1', range: [from, to] }
{ type: 'live-request', channelId: 'video-1' }
{ type: 'metadata-request', kind: 'footage-refs' | 'photos' }
```

**Responses:**
- `segment-data` — binary chunk of segment (over separate data channel)
- `coverage` — coverage map for timeline
- `metadata` — footage refs, photo list, etc.

**Live upgrade renegotiation** (in-band):
```
Viewer sends: { type: 'live-request', channelId: 'video-1' } over RTC data channel
Monitor responds: sends new offer via kind 5001 (isResponse=true, SDP with media tracks)
Viewer sends: answer via kind 5002 (isResponse=false, SDP answer)
[media tracks added to existing RTC connection]
```

**Note:** All data requests happen AFTER RTC connection is established. No data is ever requested over Nostr.

---

## Relay Management

### Per-Device Relay Lists

Each paired device stores two relay lists:

```typescript
interface PairedDevice {
  pubkey: string;
  relays: string[];                    // my inbound (where I listen for signals)
  outbound: string[];                  // peer's inbound (where I send signals)
  channelKeys: { inbound, outbound };
  lastSeenAt?: number;                 // unix timestamp of last status signal (for health checking)
  
  // Relay migration state (persistent)
  relayProposal?: {
    sessionId: string;                 // UUID tracking this proposal
    newInbound: string[];              // relays I want to migrate to
    proposedAt: number;                // timestamp (for debugging/observability)
  };
  
  // ... other fields ...
}
```

### Relay List Updates (Dual-Channel Migration)

When a device wants to migrate its listening relays (e.g., relay shutting down, provider switch), it initiates a **dual-listening migration**:

**Key property:** Each device **independently controls its own inbound** (listening relays). When proposing a change:

1. Initiator proposes new inbound over peer's inbound (outbound)
2. Both devices dual-listen to old+new inbound during negotiation
3. Peer acknowledges by sending to new inbound (proof it's listening)
4. Initiator commits migration after acknowledgement

**Why this works:**
- ✅ Communications never break (outbound to peer is unchanged)
- ✅ Both devices can independently propose inbound changes
- ✅ No "agreement phase" needed—proposal + proof of listening is sufficient
- ✅ Latest proposal implicitly wins (sessionId matching)
- ✅ Offline-tolerant (relayProposal persisted in IDB; retry on startup)
- ✅ **Survives reloads at any stage** (`relayProposal` stored in IDB; resume by checking for matching ack)

---

## Nostr Online State (Auto-Managed)

The system is **online only when there's something to do:**

```typescript
const nostrOnline = $derived(
  $pairedDevices.length > 0 || hasActiveInviteListeners()
);

$effect(() => {
  if ($nostrOnline) {
    startSignalRouter();
  } else {
    stopSignalRouter();
  }
});
```

- **Online:** At least one paired device OR an active invite listener
- **Offline:** Zero paired devices AND no invite listeners
- **No user toggle:** Automatic based on pairing/invite state

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

### Relay Migration (Dual-Listening, Autonomous Inbound)
```
DeviceA wants to migrate from [relay-a-1] to [relay-a-2]
  ↓
DeviceA stores relayProposal in IDB (survive reload)
  ├─ relayProposal.sessionId = UUID
  ├─ relayProposal.newInbound = [relay-a-2]
  └─ relayProposal.proposedAt = now
  ↓
DeviceA starts dual-listening: [relay-a-1] + [relay-a-2]
  ↓
DeviceA sends proposal over [relay-b-1] (DeviceB's inbound):
  "I'm moving to [relay-a-2], please start sending there"
  ↓
DeviceB receives on [relay-b-1]
  ├─ Starts dual-listening: [relay-a-1] + [relay-a-2]
  ├─ Updates outbound = [relay-a-2] (where to send to DeviceA now)
  └─ Sends acknowledgement to [relay-a-2] (proves it's listening)
  ↓
DeviceA receives ack on [relay-a-2]
  ├─ Commits: relays = [relay-a-2]
  ├─ Clears: relayProposal = null
  ├─ Stops dual-listening, keeps only [relay-a-2]
  └─ Updates signal subscriptions
  ↓
Both now communicating over new relays
  [DeviceA.outbound = [relay-b-1], DeviceB.outbound = [relay-a-2]]
  ↓
If either device offline: relayProposal survives reload, retry on next startup
```

---

## Key Principles

✅ **All post-pairing communication uses channel keys** — real pubkeys never appear on Nostr after pairing; this applies to RTC signals, status, relay migration, and action notifications alike  
✅ **Encrypted** — NIP-44 ChaCha20-Poly1305 over ECDH channel keys for all post-pairing events  
✅ **Targeted action signals** — TriggerPublisher sends kind 5010/5011 via `publishSignal(contactId, ...)` to specific paired contacts; no open subscriptions  
✅ **Relay-agnostic** — Each contact entry has its own relay lists; `RelayStateController` handles selection  
✅ **Offline-resilient** — Missed action signals retrieved via `fetchKindHistory` on reconnect  
✅ **Efficient** — Minimal Nostr events (handshake + presence + notifications); all footage data over RTC  
✅ **Flexible** — Action recipients configurable per pipeline action (all / specific / filtered by online state)

