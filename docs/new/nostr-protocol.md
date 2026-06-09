# Nostr Protocol

Nostr is a decentralized event protocol for censorship-resistant, signed, queryable communication. It is not a blockchain and not a social network, though social apps use it. Every participant is identified by a keypair; identity is cryptographic.

In Senstry, Nostr serves as the signaling layer — WebRTC handshakes, sensor notifications, arm/disarm state, and metadata exchange all flow through Nostr. Media never touches Nostr. All video, audio, and recordings travel point-to-point via WebRTC only.

---

## Event Model

Every Nostr event is a JSON object:

```json
{
  "id": "sha256(canonical_json)",
  "pubkey": "secp256k1(privkey)",
  "created_at": 1700000000,
  "kind": 5001,
  "tags": [
    ["p", "recipient-pubkey"],
    ["s", "session-uuid"]
  ],
  "content": "encrypted or plaintext payload",
  "sig": "secp256k1.sign(id, privkey)"
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `id` | hex (64 chars) | SHA-256 of canonical event JSON; immutable once signed |
| `pubkey` | hex (64 chars) | Secp256k1 public key of the signer |
| `created_at` | integer | Unix seconds at event creation |
| `kind` | integer | Event type discriminator |
| `tags` | array of arrays | Metadata, routing hints, and addressing |
| `content` | string | Plaintext or encrypted payload; interpretation depends on kind |
| `sig` | hex (128 chars) | Secp256k1 signature of the event ID |

### Signing and Verification

**Signing:**
1. Serialize to canonical JSON (NIP-01 field order: `[0, pubkey, created_at, kind, tags, content]`)
2. Compute `id = SHA-256(canonical_json)`
3. Compute `sig = secp256k1.sign(id, privkey)`

**Verification:**
1. Recompute `id` from the event fields; must match the `id` field
2. Verify `secp256k1.verify(id, sig, pubkey)`

Any modification to a published event invalidates the signature or produces a new event ID. Events are immutable once signed.

---

## Relay Protocol

A relay is a server that accepts, stores, and serves Nostr events via WebSocket.

### Commands

**Publish:**
```
["EVENT", <event-json>]
```
Relay validates the signature, stores the event if new, and broadcasts it to matching subscribers.

**Subscribe:**
```
["REQ", "subscription-id", <filter>, ...]
```
Relay returns all stored events matching any filter (OR logic), then sends `["EOSE", "subscription-id"]` to signal end of history. New matching events arrive in real-time after EOSE.

**Unsubscribe:**
```
["CLOSE", "subscription-id"]
```

### What Relays Do and Do Not Guarantee

| Relays do | Relays do not |
|-----------|---------------|
| Store events persistently | Enforce access control or authentication |
| Validate event signatures | Validate content or prevent spam |
| Index by kind, author, tags, timestamp | Delete or update events |
| Broadcast to subscribers in real-time | Transport media (Senstry media is P2P only) |

---

## NIPs Used by Senstry

### NIP-01: Core Protocol

Defines the event format, canonical JSON serialization, signing scheme, and relay wire protocol. Every Senstry event is a NIP-01 event.

### NIP-44: Encrypted Payloads (ChaCha20-Poly1305)

```
encrypt(senderPrivkey, recipientPubkey, plaintext) → ciphertext
decrypt(receiverPrivkey, senderPubkey, ciphertext) → plaintext
```

Key derivation: ECDH over the sender's privkey and recipient's pubkey produces a shared secret; ChaCha20-Poly1305 derives its key from that secret. Content is opaque to relay operators; sender and recipient pubkeys remain visible in the event envelope.

All encrypted events in Senstry use NIP-44. See [Encryption Models](#encryption-models) for how the key material varies by event type.

### NIP-59: Gift Wrap

Three-layer wrapping scheme (Rumor → Seal → Gift Wrap) that obscures sender and recipient from relays using randomized timestamps and one-time outer keys.

**Not used in Senstry.** Pre-contact delivery uses the TOTP Mailbox pattern (kind 5201) instead. Gift wrap exposes real pubkeys in the outer `#p` routing tag, adds three encryption layers, and requires `since`-window scans of ~1.6 hours because timestamps are randomized. The TOTP mailbox achieves pre-contact delivery with one encryption layer, deterministic routing via a derived mailbox pubkey (not a real identity key), and honest timestamps.

### NIP-65: Relay List Metadata

Kind 10002 is a replaceable event where a device publishes its read (inbox) and write (outbox) relay lists. This is the authoritative Nostr-native source for which relays reach a given pubkey.

Querying a device's relay list:
```json
{ "kinds": [10002], "authors": ["<target_pubkey>"], "limit": 1 }
```

Read relays are the device's inbox — where to deliver events to that device. Write relays are where the device publishes; use those when fetching its outbound events.

### NIP-33: Parameterized Replaceable Events

Events with kind ≥ 30000 and a `d` tag are replaceable. Relay deduplicates by `(pubkey, kind, d-tag)` — the latest event wins. Used by kind 30078.

### NIP-78: Arbitrary Custom App Data

Kind 30078 is a parameterized replaceable event for application-defined storage. Content and tags are application-specific; no relay-level schema enforcement. Senstry uses this for contact book storage — an encrypted contact blob recoverable by `(contactBookSigningPubkey, 30078, "senstry-contacts")`.

### NIP-05: DNS-Based Identity Resolution

Maps a human-readable identifier (`name@domain`) to a pubkey via a DNS-hosted HTTPS endpoint:

```
GET https://<domain>/.well-known/nostr.json?name=<name>
```

Response:
```json
{
  "names": { "<name>": "<pubkey_hex>" },
  "relays": { "<pubkey_hex>": ["wss://relay1.com", "wss://relay2.com"] }
}
```

Used for relay discovery as a fallback when NIP-65 returns nothing. NIP-05 is opt-in and exposes the real pubkey via public DNS — only relevant for the pre-pairing discovery phase. Post-pairing signals use channel pubkeys only.

The resolution order Senstry uses during pairing is in [pairing.md](pairing.md).

---

## Encryption Models

Senstry uses two encryption models, each using a distinct key source, depending on the event type and contact state.

### Model 1: NIP-44 over ECDH Channel Keys

Used for all post-contact events: signal kinds 5001–5006 and action signal kinds 5010–5011.

```
Signer:    outboundChannelPrivkey  (derived, not the identity key)
Pubkey:    outboundChannelPubkey   (what the relay sees)
Encrypt:   NIP-44(outboundChannelPrivkey, inboundChannelPubkey, payload)
Decrypt:   NIP-44(inboundChannelPrivkey, outboundChannelPubkey, ciphertext)
```

Channel pubkeys are pseudonymous — they look unrelated to real device identities. A relay operator cannot correlate events to real pubkeys without breaking ECDH.

### Model 2: NIP-44 over TOTP Mailbox Key

Used only for kind 5201 pre-contact delivery, before any channel key exists.

`mailboxPrivkey` is derived via HKDF from the shared TOTP seed — see [contact-model.md § Mailbox Keypair](contact-model.md#mailbox-keypair-tempcontact-only).

```
Sender:    fresh ephemeral keypair; NIP-44 encrypt to mailboxPubkey; #p tag = mailboxPubkey
Recipient: derives mailboxPrivkey, subscribes { kinds: [5201], "#p": [mailboxPubkey] }
```

The relay sees only the derived `mailboxPubkey` in the `#p` tag — never the device's real identity pubkey. The mailbox keypair is discarded once a TempContact is established from the received message.

### Key Derivation: ECDH Channel Keys

This is the key derivation mechanism underlying Model 1, not a standalone encryption model. Full lifecycle details are in [contact-model.md](contact-model.md) § Channel Keys.

See [contact-model.md § Channel Keys](contact-model.md#channel-keys) for the full derivation. Both peers compute the same directional keys independently; one peer's outbound key is the other peer's inbound key.

Channel keys are not persisted. They are re-derived from the stable device keypair at session start. Two devices sharing the same identity key have different device keypairs (and therefore different channels) — events are never delivered cross-device.

Channel key lifecycle and storage are in [contact-model.md](contact-model.md). The TOTP mailbox pairing flow is in [pairing.md](pairing.md).

---

## Event Kinds

Signal kinds 5001–5006 and 5010–5011, their addressing modes, and subscription shapes are defined in [signal-exchange.md](signal-exchange.md).

### Pairing and Pre-Contact Kinds

| Kind | Name | Encrypted | Purpose |
|------|------|-----------|---------|
| 5100 | QR/Mailbox Acceptance | NIP-44 (temp channel key) | Acceptance event signed with ephemeral viewer key; triggered by QR scan or Nostr-delivered invite; monitor decrypts with invite privkey |
| 5201 | TOTP Mailbox Delivery | NIP-44 to HKDF-derived mailbox pubkey | Pre-contact one-shot delivery; `#p` tag routes to `mailboxPubkey` (not real pubkey); closed after TempContact is established |

Kinds 5100 and 5201 are fetched via `#p` tag filtering, not `since` filtering. They do not flow through the signal router.

### Contact Book Kind

| Kind | Name | Encrypted | Purpose |
|------|------|-----------|---------|
| 30078 | Contact Book | HKDF+ChaCha20-Poly1305 | Encrypted contact blob; signed with derived contact book key; recoverable from relay by `(contactBookSigningPubkey, 30078, "senstry-contacts")` |

The contact book event does not flow through the signal router. It is published once per contact list change and fetched only during recovery.

### Relay List Kind

| Kind | Name | Purpose |
|------|------|---------|
| 10002 | Relay List Metadata | Device publishes read/write relay lists (NIP-65); used for relay discovery |

Payload shapes, addressing modes, and routing rules for all signal kinds are defined in [signal-exchange.md](signal-exchange.md).

---

## Subscriptions and Filters

A subscription is a long-lived query that returns historical events up to EOSE, then streams new matching events in real-time.

### Filter Format

```json
{
  "ids":     ["event-id"],
  "kinds":   [5001, 5010],
  "authors": ["pubkey"],
  "#p":      ["pubkey"],
  "#s":      ["session-uuid"],
  "#d":      ["identifier"],
  "since":   1700000000,
  "until":   1700001000,
  "limit":   100
}
```

Multiple filters in a REQ use OR logic — match any filter. Fields within a single filter use AND logic — all fields must match.

Senstry-specific subscription patterns are in [signal-exchange.md](signal-exchange.md).

---

## Timestamps and TTL

### Honest Timestamps

All Senstry events use honest `created_at` values (unix seconds, not randomized). This enables:
- Reliable relay `since` filtering with a 1-hour window for signals
- Accurate event ordering
- Meaningful TTL enforcement

### TTL Enforcement

The signal router discards received events older than a per-kind TTL threshold. TTL applies to live signal router delivery only — events arriving on a live subscription that exceed their TTL are discarded silently. History fetches bypass TTL entirely; they are intentional requests for historical data. Per-kind TTL values are defined in [signal-exchange.md](signal-exchange.md).

---

## Replaceable Events

All signal, action signal, and pairing kinds (5001–5201) are standard non-replaceable events: once published, content cannot change, and multiple events with the same `(pubkey, kind)` coexist on relay.

Kind 30078 (NIP-78, parameterized replaceable per NIP-33) is the exception. The relay deduplicates by `(pubkey, kind, d-tag)` — the latest version is always canonical. The `(contactBookSigningPubkey, 30078, "senstry-contacts")` triple always resolves to the current contact book.

Nostr has no reliable deletion mechanism. Publishers can issue NIP-09 deletion recommendations, but relays are not obligated to honor them.

---

## Privacy Model

### What Is Public on Relay

- Event envelope: `id`, `pubkey`, `kind`, `created_at`, unencrypted tags
- Signature (proof of signer)
- The `#p` tag value in kind 5201 — but this is the derived `mailboxPubkey`, not the real identity pubkey

### Where Real Pubkeys Appear

Real device identity pubkeys appear in kind 5100 events (pairing acceptance), which are signed with an ephemeral viewer key — not the long-term identity key. Kind 30078 contact book events are signed with the derived `contactBookSigningPubkey`. All post-contact signals (5001–5006, 5010, 5011) use channel pubkeys only. Real identity pubkeys never appear in any post-contact event envelope.

### What Is Private

- Event content: encrypted with NIP-44 in all signal and pairing kinds
- Signal parties: channel pubkeys are pseudonymous and computationally unlinkable to real pubkeys without the ECDH secret
- Contact graph: kind 30078 content encrypted with HKDF-derived key; opaque to relay operators even if secp256k1 is broken, because the passphrase is required to derive the decryption key
- Media: never on any relay; all footage travels P2P via WebRTC

### Relay Operator Threat Model

A relay operator can observe pseudonymous channel pubkeys, kind numbers, timestamps, and encrypted ciphertext. They can infer relative timing and volume of signaling. They cannot determine real device identities, event plaintext, TOTP seeds, channel key derivation inputs, or any media content.
