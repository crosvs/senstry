# Channel Negotiation: State Machine Model

A cleaner, more symmetric approach to relay migration (and other channel changes) using explicit states rather than counting messages.

## States

Each device tracks one `channelState` per peer:

```typescript
type ChannelState = 'idle' | 'proposing' | 'receiving-proposal' | 'waiting-for-ack' | 'committed';
```

- **idle** — no negotiation in progress
- **proposing** — I sent a proposal, waiting for peer's accept/decline response
- **receiving-proposal** — peer sent a proposal, I'm dual-listening and will respond
- **waiting-for-ack** — peer accepted my proposal; I'm waiting for their acknowledgement proof
- **committed** — both sides agreed and switched

## Dual-Listening Throughout

Key: **both devices listen to both old and new relay lists during the entire handshake.** This ensures:
- Communication never breaks if one relay goes unhealthy
- Messages can be received on either list at any time
- Status pings keep the connection alive even if explicit handshake messages are lost

## Protocol (Symmetric)

### Initiator Path: Propose → Wait for Response → Ack

```
IDLE
  ↓
[proposeChannelMigration]
  ├─ channelState = proposing
  ├─ addRelaySubscription(newRelays)  ← dual-listen
  └─ send proposal over oldRelays
  ↓
PROPOSING + DUAL-LISTENING
  ↓
[waitForChannelResponse]
  ├─ receive response
  ├─ if accepted:
  │   ├─ channelState = waiting-for-ack
  │   ├─ switch subscriptions to newRelays
  │   └─ send acknowledgement over newRelays
  │       (proves I'm on the new relay)
  │   ↓
  │   WAITING-FOR-ACK + DUAL-LISTENING
  │       [eventually cleanup happens]
  │       ↓
  │       COMMITTED
  │
  └─ if declined:
      ├─ channelState = idle
      ├─ removeRelaySubscription(newRelays)
      └─ [cleanup, stay on oldRelays]
```

### Receiver Path: Receive → Decide → Wait for Ack

```
IDLE
  ↓
[receive proposal]
  ├─ check: am I proposing/waiting? (conflict detection)
  │   if yes:
  │   ├─ send decline response  ← both devices reject simultaneous proposals
  │   ├─ cleanup my own proposal
  │   └─ back to IDLE
  │
  └─ no conflict:
      ├─ channelState = receiving-proposal
      ├─ addRelaySubscription(proposedRelays)  ← dual-listen
      ├─ send accept response over oldRelays
      └─ channelState = waiting-for-ack
      ↓
      WAITING-FOR-ACK + DUAL-LISTENING
        ↓
      [waitForChannelAcknowledgement]
        ├─ receive ack on newRelays
        ├─ switch subscriptions to newRelays
        ├─ removeRelaySubscription(oldRelays)
        └─ channelState = committed
      ↓
      COMMITTED
```

## Conflict Resolution

If both devices propose simultaneously:

```
DeviceA: propose relayListA        DeviceB: propose relayListB
         (epoch = 1)                        (epoch = 1)

DeviceA receives DeviceB's proposal:
  ├─ channelState = proposing (mine is in flight)
  ├─ send decline response  ← reject the incoming proposal
  └─ stay in proposing

DeviceB receives DeviceA's proposal:
  ├─ channelState = proposing (mine is in flight)
  ├─ send decline response  ← reject the incoming proposal
  └─ stay in proposing

Both wait for responses to their own proposals:
  ├─ receive decline response
  ├─ channelState = idle
  └─ [cleanup own proposal]

[eventually one retries with higher epoch; latest wins]
```

**Key rule:** If I'm in `proposing` or `waiting-for-ack` state and receive a proposal, I reject it immediately. Both devices follow this rule, so simultaneous proposals cancel each other naturally. Latest epoch wins on the retry.

## Implementation Sketch

### Initiator: Propose

```typescript
async function proposeChannelMigration(contact, newRelays) {
  // Conflict check
  if (contact.channelState === 'proposing' || contact.channelState === 'waiting-for-ack') {
    return;  // already negotiating, skip
  }
  
  // Start dual-listening
  const epoch = (contact.channelProposal?.epoch || 0) + 1;
  const id = nanoid();
  addRelaySubscription(newRelays, {
    kinds: [5001],
    authors: [contact.inboundChannelKey],
    label: 'channel-proposal'
  });
  
  // Move to proposing state
  contact.channelState = 'proposing';
  contact.channelProposal = { relay: newRelays, epoch, id };
  await savePairedDevice(contact);
  
  // Send proposal over established relay
  await sendSignal(privkey, myPubkey, contact.pubkey, {
    type: 'relay-update',
    isResponse: false,
    sessionId: id,
    epoch,
    pendingRelays: newRelays,
    timestamp: Math.floor(Date.now() / 1000)
  }, { relays: contact.relays });
  
  // Continue in background
  waitForChannelResponse(contact);
}
```

### Initiator: Wait for Response

```typescript
async function waitForChannelResponse(contact) {
  try {
    const response = await waitForSignal({
      type: 'relay-update',
      isResponse: true,
      sessionId: contact.channelProposal.id,
      epoch: contact.channelProposal.epoch,
      fromPubkey: contact.pubkey,
      // Listen on BOTH old and new (dual-listen)
      relays: [...contact.relays, ...contact.channelProposal.relay]
    }, { timeout: 60_000 });
    
    if (response.accepted) {
      // Peer accepted — commit to new channel
      contact.relays = contact.channelProposal.relay;
      contact.channelState = 'waiting-for-ack';
      await savePairedDevice(contact);
      
      resetSignalSubscriptions();  // switch main filter to new relays
      
      // Send acknowledgement to prove I'm on the new relay
      await sendSignal(privkey, myPubkey, contact.pubkey, {
        type: 'relay-update',
        isResponse: true,
        isAck: true,  // acknowledgement
        sessionId: response.sessionId,
        epoch: response.epoch,
        timestamp: Math.floor(Date.now() / 1000)
      }, { relays: contact.relays });
      
      // Clean up
      contact.channelState = 'committed';
      contact.channelProposal = null;
      removeRelaySubscription(contact.relays, { label: 'channel-proposal' });
      await savePairedDevice(contact);
    } else {
      // Peer declined
      contact.channelState = 'idle';
      contact.channelProposal = null;
      removeRelaySubscription(contact.channelProposal.relay, { label: 'channel-proposal' });
      await savePairedDevice(contact);
    }
  } catch {
    // Timeout — keep proposing state, will retry on next startup
  }
}
```

### Receiver: Receive and Decide

```typescript
onSignal((msg, fromPubkey) => {
  if (msg.type === 'relay-update' && !msg.isResponse) {
    const contact = getPairedDevice(fromPubkey);
    
    // Ignore stale epochs
    if ((msg.epoch || 0) <= (contact.channelProposal?.epoch || 0)) return;
    
    // CONFLICT: Both sides reject if not idle
    if (contact.channelState === 'proposing' || contact.channelState === 'waiting-for-ack') {
      // Send decline
      await sendSignal(privkey, myPubkey, fromPubkey, {
        type: 'relay-update',
        isResponse: true,
        accepted: false,
        sessionId: msg.sessionId,
        epoch: msg.epoch,
        timestamp: Math.floor(Date.now() / 1000)
      }, { relays: contact.relays });
      
      // Clean up our own proposal
      contact.channelState = 'idle';
      contact.channelProposal = null;
      removeRelaySubscription(contact.channelProposal?.relay, { label: 'channel-proposal' });
      await savePairedDevice(contact);
      return;
    }
    
    // No conflict — dual-listen and respond
    contact.channelState = 'receiving-proposal';
    contact.channelProposal = { relay: msg.pendingRelays, epoch: msg.epoch, id: msg.sessionId };
    
    addRelaySubscription(msg.pendingRelays, {
      kinds: [5001],
      authors: [contact.outboundChannelKey],
      label: 'channel-proposal'
    });
    
    // Send accept response (over old relay where initiator listens)
    await sendSignal(privkey, myPubkey, fromPubkey, {
      type: 'relay-update',
      isResponse: true,
      accepted: true,
      sessionId: msg.sessionId,
      epoch: msg.epoch,
      timestamp: Math.floor(Date.now() / 1000)
    }, { relays: contact.relays });
    
    // Move to waiting for acknowledgement
    contact.channelState = 'waiting-for-ack';
    await savePairedDevice(contact);
    
    // Wait for peer's acknowledgement
    waitForChannelAcknowledgement(contact);
  }
});
```

### Receiver: Wait for Acknowledgement

```typescript
async function waitForChannelAcknowledgement(contact) {
  try {
    await waitForSignal({
      type: 'relay-update',
      isResponse: true,
      isAck: true,
      sessionId: contact.channelProposal.id,
      epoch: contact.channelProposal.epoch,
      fromPubkey: contact.pubkey,
      relays: contact.channelProposal.relay  // listen on new relay
    }, { timeout: 60_000 });
    
    // Peer confirmed on new relay — commit
    contact.relays = contact.channelProposal.relay;
    contact.channelState = 'committed';
    contact.channelProposal = null;
    await savePairedDevice(contact);
    
    resetSignalSubscriptions();  // switch to new relays
    removeRelaySubscription(contact.relays, { label: 'channel-proposal' });
    
  } catch {
    // Timeout — revert to idle
    contact.channelState = 'idle';
    contact.channelProposal = null;
    removeRelaySubscription(contact.channelProposal?.relay, { label: 'channel-proposal' });
    await savePairedDevice(contact);
  }
}
```

### Recovery: Resume from Any State

```typescript
async function resumePendingNegotiations() {
  const devices = await getAllPairedDevices();
  
  for (const contact of devices) {
    if (!contact.channelProposal) continue;  // nothing in flight
    
    const state = contact.channelState;
    const proposal = contact.channelProposal;
    
    switch (state) {
      case 'proposing':
        // I sent a proposal, re-send and wait for response
        // (re-send in case original was lost)
        await proposeChannelMigration(contact, proposal.relay);
        break;
        
      case 'receiving-proposal':
        // Peer sent a proposal, I was deciding
        // Re-add dual-listening and wait for response (or user decision)
        addRelaySubscription(proposal.relay, {
          kinds: [5001],
          authors: [contact.outboundChannelKey],
          label: 'channel-proposal'
        });
        // Eventually waitForChannelAcknowledgement or user action
        break;
        
      case 'waiting-for-ack':
        // Peer accepted my proposal or I accepted theirs
        // Re-add dual-listening and wait for acknowledgement
        addRelaySubscription(proposal.relay, {
          kinds: [5001],
          authors: [contact.outboundChannelKey],  // if receiver
          label: 'channel-proposal'
        });
        waitForChannelAcknowledgement(contact);
        break;
    }
  }
}
```

## Advantages Over Message-Counting

1. **Symmetric** — both devices follow the same state machine; no "initiator vs. receiver" asymmetry
2. **Conflict-free** — simultaneous proposals handled naturally by state check (reject if not idle)
3. **Clear recovery** — restart from state, not from message number
4. **Dual-listening built-in** — it's not an afterthought; it's part of each state transition
5. **Composable** — same pattern works for relay migration, encryption key rotation, protocol upgrades, etc.

## Data Model

```typescript
interface PairedDevice {
  // ... existing fields ...
  
  // Channel negotiation state
  channelState?: ChannelState;
  channelProposal?: {
    relay: string[];
    epoch: number;
    id: string;
  };
}
```

No `relaysMigrationEpoch`, `relaysMigrationId`, `relaysPending`, `relaysHaveSwitched` — just one `channelProposal` object that gets set/cleared based on state.
