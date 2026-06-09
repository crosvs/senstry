# Contact Model

Contacts are the unit of peer relationship in Senstry. Every Nostr signal is addressed to a contact; every key lookup, relay selection, and channel subscription is resolved through a contact. Two types exist: `TempContact` and `PairedContact`. Both expose the same API; nothing outside `ContactManager` inspects which type it holds.

---

## Contact Types

### TempContact

Created from a validated TOTP mailbox delivery (kind 5201). The sender's ephemeral pubkey from the mailbox payload becomes the outbound channel pubkey. A fresh inbound channel keypair is generated on creation. The contact is memory-only — never written to IDB — and expires at a caller-supplied `expiresAt` timestamp.

TempContacts have no `identityPubkey` or `devicePubkey`. They are one-shot: once the mailbox delivery is processed and the contact registered, the mailbox subscription closes and the mailbox keypair is discarded.

### PairedContact

Created by completing a pairing flow (QR, URI, or Nostr-delivered invite). Channel keys are ECDH-derived from the two device keypairs. The contact is persisted to IDB and has no expiry. On load, channel keys are re-derived from the stored `devicePubkey`; no channel key material is stored directly.

A `contactId` is a device-pair relationship, not an identity-pair relationship. If a peer has two devices, each device generates a distinct `contactId` with its own channel keys. A device that re-keys (e.g. fresh install, identity recovery) generates a new `devicePubkey` and initiates a new pairing flow with each affected contact (see [pairing.md](pairing.md)). The `identityPubkey` is the stable reference that survives device replacement — re-pairing is accepted because the offer is authenticated by the known `identityPubkey`.

### Comparison

| Property | TempContact | PairedContact |
|----------|-------------|---------------|
| Origin | TOTP mailbox delivery (kind 5201) | Completed pairing flow (QR / URI / Nostr invite) |
| Channel keys | Sender's ephemeral pubkey (outbound) + fresh generated keypair (inbound) | ECDH-derived from both device keypairs |
| `identityPubkey` | Absent | Present — peer's stable long-term identity |
| `devicePubkey` | Absent | Present — peer's device pubkey; used for channel key re-derivation |
| Persistence | Memory-only; expires at TTL | IDB-backed; permanent until unpaired |
| Signal API | Identical (`publishSignal(contactId, kind, payload)`) | Identical |
| Included in contact book | No | Yes |

---

## ContactEntry (Runtime Shape)

`ContactManager` stores both types as a unified `ContactEntry`. The presence of `expiresAt` distinguishes temp from paired.

```typescript
interface ContactEntry {
  contactId: string;            // UUID — stable for the lifetime of the contact

  identityPubkey?: string;      // peer's long-term identity pubkey; absent for TempContacts
  devicePubkey?: string;        // peer's device pubkey; used for ECDH; absent for TempContacts
  peerSessionUUID?: string;     // most recently seen session UUID from peer's kind 5004

  inboundChannelPubkey: string;    // paired: ECDH-derived; temp: freshly generated ephemeral
  inboundChannelPrivkey: Uint8Array; // held in memory; used to decrypt incoming events
  outboundChannelPubkey: string;   // paired: ECDH-derived; temp: sender's replyKey from mailbox payload
  outboundChannelPrivkey: Uint8Array; // held in memory only; never persisted to IDB; re-derived from device keypair and peer identity at session start

  inboundRelayList: string[];  // relays this device listens on for this contact
  outboundRelayList: string[]; // relays this device sends to in order to reach the contact

  addedAt: number;
  expiresAt?: number;          // absent = paired (permanent); present = temp (TTL-bound)
}

// PairedContactEntry extends ContactEntry with fields exclusive to IDB-backed paired contacts.
// TempContacts never carry these fields.
interface PairedContactEntry extends ContactEntry {
  identityPubkey: string;       // required on paired contacts; narrows the optional in ContactEntry
  devicePubkey: string;         // required on paired contacts; narrows the optional in ContactEntry
  nickname?: string;            // local label; set by the user, not exchanged with the peer
  relayProposal?: {             // in-flight relay migration proposal; survives reload so a pending
    sessionId: string;          //   migration resumes on startup
    newInbound: string[];
    proposedAt: number;
  } | null;
}
```

`outboundChannelPubkey` is always non-null. There is no code path that publishes a signal without a resolved channel key.

`peerSessionUUID` is updated on every received kind 5004 from that contact. Session-directed signals (kinds 5001–5003, 5005, 5006) include this value as the `#s` tag target.

---

## Keypairs Used in Contacts

### Device Keypair

Every device generates a **device keypair** on first launch, independent of the identity keypair.

- **Privkey:** 32-byte random value stored in IDB. Never leaves the device. Not included in the contact book backup.
- **Pubkey:** Derived via secp256k1. Exchanged during pairing. Used as the ECDH input for channel key derivation.

The device keypair is stable across restarts within a single IDB. Recovering an identity to a new device generates a fresh device keypair, producing new channel keys for all contacts.

### ECDH Shared Secret

Computed once per device-pair, never persisted:

```
sharedSecret = ECDH(myDevicePrivkey, peerDevicePubkey)
```

Both devices compute the identical value independently. The shared secret is the input to channel key derivation.

### Channel Keys

Derived from the ECDH shared secret. Directional — swapping sender and recipient produces a different key.

```
outboundChannelPrivkey = deriveChannelKey(sharedSecret, myDevicePubkey, peerDevicePubkey)
outboundChannelPubkey  = secp256k1(outboundChannelPrivkey)

inboundChannelPrivkey  = deriveChannelKey(sharedSecret, peerDevicePubkey, myDevicePubkey)
inboundChannelPubkey   = secp256k1(inboundChannelPrivkey)
```

Both devices derive the same keys independently: `myOutbound === peerInbound` and `peerOutbound === myInbound`.

Channel keys are not persisted. They are re-derived from the stable device keypair each session. Events on relay are signed with the channel key — the real identity pubkey never appears in any post-contact signal.

### Mailbox Keypair (TempContact only)

Derived from a TOTP seed when no channel key exists yet. Both sender and recipient compute the same keypair independently:

```typescript
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1";

function deriveMailboxKeypair(totpSeed: Uint8Array): {
  mailboxPrivkey: Uint8Array;
  mailboxPubkey: string;
} {
  const mailboxPrivkey = hkdf(sha256, totpSeed, undefined, "senstry-v1-mailbox", 32);
  const mailboxPubkey = secp256k1.getPublicKey(mailboxPrivkey, true).slice(1);
  return {
    mailboxPrivkey,
    mailboxPubkey: Buffer.from(mailboxPubkey).toString("hex"),
  };
}
```

The `mailboxPubkey` appears as the `#p` routing tag in kind 5201 events. The `mailboxPrivkey` decrypts the delivery. This keypair is ephemeral — discarded after the TempContact is registered. The relay sees only the derived pubkey; it cannot link this to any real device identity.

### Contact Book Keys

Two keys derived from the identity privkey and a user-supplied passphrase. Both are required for any contact book operation.

```
contactBookSigningPrivkey = HKDF(identityPrivkey, passphrase, "senstry-contacts-sign-v1", 32)
contactBookSigningPubkey  = secp256k1(contactBookSigningPrivkey)

contactBookEncKey         = HKDF(identityPrivkey, passphrase, "senstry-contacts-enc-v1", 32)
```

The signing key is the `pubkey` field on kind 30078 events — it is not the identity key and never appears in any signal or pairing event. The encryption key is the ChaCha20-Poly1305 symmetric key for the contact blob. This is not NIP-44 (which uses ECDH) — it is a custom symmetric derivation.

The passphrase is the PQC-resilient factor. A quantum adversary recovering `identityPrivkey` via Shor's algorithm cannot derive either key without it. **Losing the passphrase makes the contact book irrecoverable, even with the privkey.** The passphrase is never stored; it is passed at call time and discarded after key derivation.

---

## Contact Book

PairedContacts are serialized into an encrypted kind 30078 blob for relay-backed backup and recovery. TempContacts are not included.

### Blob Structure

```typescript
interface ContactBook {
  version: 1;
  ownRelays: string[];
  entries: Array<{
    identityPubkey: string;  // peer's stable long-term identity pubkey
    devicePubkey: string;    // peer's device pubkey at time of pairing
    relays: string[];        // peer's relay list
    nickname: string;        // local label
    addedAt: number;         // unix timestamp
  }>;
}
```

Channel keys are not stored. They are re-derived from `devicePubkey` on load. If the peer re-keys (fresh install, identity recovery), they initiate a new pairing flow; the existing `identityPubkey` authenticates the offer (see [pairing.md](pairing.md)). The `identityPubkey` is the stable reference that survives device replacement — the stored entry is updated with the new `devicePubkey` after re-pairing completes.

### Event Structure

Kind 30078 is a NIP-33 parameterized replaceable event. The relay deduplicates by `(signingPubkey, 30078, "senstry-contacts")`, always serving the latest version.

```
event.pubkey  = contactBookSigningPubkey   (derived, not identity key)
event.kind    = 30078
event.tags    = [["d", "senstry-contacts"]]
event.content = ChaCha20-Poly1305(contactBookEncKey, JSON.stringify(ContactBook))
```

### Recovery

To recover contacts from relay:

1. Derive `contactBookSigningPrivkey`, `contactBookSigningPubkey`, and `contactBookEncKey` from `identityPrivkey` + passphrase.
2. Query any relay: `{ kinds: [30078], authors: [contactBookSigningPubkey], "#d": ["senstry-contacts"] }`.
3. Decrypt the latest event's content with `contactBookEncKey`.
4. Re-derive channel keys from each entry's `devicePubkey`.

---

## ContactManager

`ContactManager` is the internal registry for all contacts. No module accesses it directly; `NostrClient` methods look up relay lists, channel keys, and session UUIDs through it.

```typescript
class ContactManager {
  // Paired contacts — IDB-backed, permanent
  registerPaired(contact: PairedContact): string;
  unregisterPaired(contactId: string): void;
  updatePairedRelays(contactId: string, newInboundRelays: string[]): void;
  updatePeerDevicePubkey(contactId: string, newDevicePubkey: string): void;
  updatePeerSession(contactId: string, sessionUUID: string): void;

  // Temp contacts — memory-only, TTL-bound
  registerTemp(entry: Omit<ContactEntry, "contactId" | "inboundChannelPubkey" | "inboundChannelPrivkey" | "outboundChannelPubkey" | "outboundChannelPrivkey">): string;
  expireTemp(contactId: string): void;
  purgeExpired(): void;

  // Lookup
  get(contactId: string): ContactEntry;
  findByIdentityPubkey(pubkey: string): ContactEntry[];
  findByDevicePubkey(pubkey: string): ContactEntry | null;
  findByInboundKey(inboundChannelPubkey: string): ContactEntry | null;
  allMyInboundRelays(): string[];
  allContactIds(): string[];
}
```

**Paired entries** cache channel keys on registration (derived from the stored device keypair). `peerSessionUUID` is updated on every received kind 5004. Relay migration commits via `updatePairedRelays()`; peer re-key via `updatePeerDevicePubkey()` re-derives channel keys.

**Temp entries:** `ContactManager` generates the inbound keypair and sets outbound channel values from the provided `senderEphemeralPubkey`. No `identityPubkey` or `devicePubkey` is set.

**Signal routing** works by `inboundChannelPubkey`: incoming events carry an `authors` pubkey. `findByInboundKey()` maps it back to a `contactId` for delivery to `onSignal`.

**Duplicate detection on pairing completion:**

```typescript
// findByIdentityPubkey locates any existing contacts (including in-progress TempContacts)
// for the incoming peer before the new PairedContact is registered.
const existing = contactManager.findByIdentityPubkey(incomingPubkey);
const pairedId = contactManager.registerPaired(device);
existing
  .filter((e) => e.expiresAt)
  .forEach((e) => contactManager.expireTemp(e.contactId));
```

`allMyInboundRelays()` returns the union of `inboundRelayList` across all contacts (paired and temp). The signal router subscribes across this full union.

---

## ContactBookController

The kind 30078 contact book blob stores encrypted `PairedContact` entries and the device's own relay list; `ContactBookController` handles fetching, multi-relay merge, and publishing of that blob. `ContactBookController` is a `NostrClient` subsystem. Its fetch/merge/publish behavior is documented below.

### Fetch and Merge

On startup, `ContactBookController` queries all `ownRelays` for the latest kind 30078 event signed by `contactBookSigningPubkey`. If a remote event exists and is newer than the local snapshot, it is decrypted and merged with the local contact list using timestamp ordering: each entry's `addedAt` determines precedence when the same `identityPubkey` appears in both sets. The merged result is written back to IDB and published if the remote was authoritative.

### Publish

When the local contact list changes, `ContactBookController` serializes all `PairedContact` entries plus `ownRelays` into a `ContactBook` blob, encrypts it with `contactBookEncKey` (ChaCha20-Poly1305), signs the kind 30078 event with `contactBookSigningPrivkey`, and publishes to all `ownRelays`.

### Merge Conflict: ownRelays

When remote and local `ownRelays` differ, the winning value is determined by the event `created_at` timestamp — last-write-wins. The newer event's `ownRelays` replaces the older without field-level merging.

---

## Relay Lists on PairedContact

Each paired contact carries two independent relay lists:

| Field | Semantics |
|-------|-----------|
| `inboundRelayList` | Relays this device listens on for signals from this contact. This device controls it; peer updates their `outboundRelayList` when this device proposes a migration. |
| `outboundRelayList` | Relays this device sends to in order to reach the contact. This is the contact's `inboundRelayList` as known to this device. Never written directly — updated when the peer proposes a migration. |

Each signal publish goes to **one relay** selected from `outboundRelayList` by `RelayStateController` (LRU among eligible). The receiver subscribes T+0 on all their inbound relays, so the event arriving on any one is sufficient. History fan-fetches from all `outboundRelayList` relays to locate events regardless of which one was used.

The contact book blob stores `relays` (the peer's relay list at time of pairing). On load, this becomes the initial `outboundRelayList`; relay migrations update it at runtime via `ContactManager.updatePairedRelays()`.

---

## IDB Persistence

PairedContacts are persisted to IndexedDB. Channel key material is not stored — only the `devicePubkey` needed to re-derive them. TempContacts are memory-only and are never written to IDB.

Fields persisted per PairedContact:

| Field | Stored |
|-------|--------|
| `contactId` | Yes |
| `identityPubkey` | Yes |
| `devicePubkey` | Yes |
| `inboundChannelPrivkey` | No — re-derived |
| `outboundChannelPrivkey` | No — in-memory only, re-derived from device keypair and peer identity at session start |
| `inboundChannelPubkey` | No — re-derived from inboundChannelPrivkey at startup |
| `outboundChannelPubkey` | No — re-derived |
| `inboundRelayList` | Yes |
| `outboundRelayList` | Yes |
| `relayProposal` | Yes — survives reload; pending migration resumes on startup |
| `nickname` | Yes |
| `addedAt` | Yes |

On load, `ContactManager.registerPaired()` re-derives all channel keys from the stored `devicePubkey` before any signal path accesses the entry.
