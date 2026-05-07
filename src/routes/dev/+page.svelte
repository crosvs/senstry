<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import { outboxFlusher } from '$lib/nostr/outbox';
  import { onMount, onDestroy } from 'svelte';

  import IdentitySection from '$lib/components/dev/IdentitySection.svelte';
  import RelaySection from '$lib/components/dev/RelaySection.svelte';
  import PairingSection from '$lib/components/dev/PairingSection.svelte';
  import TestConnectionSection from '$lib/components/dev/TestConnectionSection.svelte';
  import SettingsSection from '$lib/components/dev/SettingsSection.svelte';
  import SentrySection from '$lib/components/dev/SentrySection.svelte';
  import ContentViewerSection from '$lib/components/dev/ContentViewerSection.svelte';
  import SegmentStorageSection from '$lib/components/dev/SegmentStorageSection.svelte';
  import type { SignalMessage } from '$lib/webrtc/signaling';

  // ── Shared page-level state ───────────────────────────────────────────────
  let selectedMonitorPubkey = $state<string | null>(null);
  let signalRouterActive = $state(false);
  let autoAccept = $state(true);

  interface PendingOffer { fromPubkey: string; msg: SignalMessage; }
  let pendingOffers = $state<PendingOffer[]>([]);
  let acceptingOffer = $state<PendingOffer | null>(null);

  function handlePendingOffer(fromPubkey: string, msg: SignalMessage) {
    if (!pendingOffers.find(o => o.fromPubkey === fromPubkey)) {
      pendingOffers = [...pendingOffers, { fromPubkey, msg }];
    }
  }

  function acceptOffer(offer: PendingOffer) {
    acceptingOffer = offer;
    pendingOffers = pendingOffers.filter(o => o.fromPubkey !== offer.fromPubkey);
    setTimeout(() => (acceptingOffer = null), 500);
  }

  function declineOffer(offer: PendingOffer) {
    pendingOffers = pendingOffers.filter(o => o.fromPubkey !== offer.fromPubkey);
  }

  onMount(() => {
    outboxFlusher.start();
  });

  onDestroy(() => {
    outboxFlusher.stop();
  });
</script>

<svelte:head><title>Dev Panel — Senstry</title></svelte:head>

<div class="dev-page">
  <div class="dev-header">
    <span class="dev-title">SENSTRY DEV</span>
    {#if $identity}
      <span class="dev-identity">{$identity.pubkey.slice(0, 16)}…</span>
    {/if}
  </div>

  <div class="sections">
    <IdentitySection />
    <RelaySection />
    <PairingSection />
    <TestConnectionSection />
    <SettingsSection />

    <SentrySection
      bind:signalRouterActive
      bind:autoAccept
      onPendingOffer={handlePendingOffer}
      acceptOffer={acceptingOffer}
    />

    <!-- Pending RTC requests (shown when auto-accept is off) -->
    {#if pendingOffers.length > 0}
      <div class="pending-offers">
        <div class="pending-title">Pending RTC Requests</div>
        {#each pendingOffers as offer (offer.fromPubkey)}
          <div class="pending-row">
            <span class="pending-name">
              {$pairedDevices.find(d => d.pubkey === offer.fromPubkey)?.nickname ?? offer.fromPubkey.slice(0, 12) + '…'}
            </span>
            <span class="pending-label">is requesting a connection</span>
            <button class="offer-btn accept" onclick={() => acceptOffer(offer)}>Accept</button>
            <button class="offer-btn decline" onclick={() => declineOffer(offer)}>Decline</button>
            <button class="offer-btn ignore" onclick={() => declineOffer(offer)}>Ignore</button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Monitor device picker -->
    <div class="monitor-picker">
      <div class="picker-title">SELECT MONITOR DEVICE</div>
      <div class="picker-row">
        <button
          class="picker-btn"
          class:selected={selectedMonitorPubkey === null}
          onclick={() => (selectedMonitorPubkey = null)}
        >
          Own device
        </button>
        {#each $pairedDevices as dev (dev.pubkey)}
          <button
            class="picker-btn"
            class:selected={selectedMonitorPubkey === dev.pubkey}
            onclick={() => (selectedMonitorPubkey = dev.pubkey)}
          >
            {dev.nickname}
          </button>
        {/each}
      </div>
    </div>

    <ContentViewerSection {selectedMonitorPubkey} />
    <SegmentStorageSection {selectedMonitorPubkey} />
  </div>
</div>

<style>
  .dev-page {
    min-height: 100vh;
    background: var(--color-bg);
    padding: 12px;
    padding-bottom: 40px;
  }
  .dev-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 4px 12px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 12px;
  }
  .dev-title {
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #a78bfa;
  }
  .dev-identity {
    font-size: 10px;
    font-family: ui-monospace, monospace;
    color: var(--color-muted);
  }
  .sections {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 720px;
    margin: 0 auto;
  }
  .pending-offers {
    border: 1px solid var(--color-warning);
    border-radius: 8px;
    overflow: hidden;
  }
  .pending-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-warning);
    padding: 6px 12px;
    background: rgba(251, 191, 36, 0.08);
    border-bottom: 1px solid var(--color-border);
  }
  .pending-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 12px;
    background: var(--color-bg);
    flex-wrap: wrap;
  }
  .pending-name { font-weight: 600; color: var(--color-text); }
  .pending-label { color: var(--color-muted); flex: 1; }
  .offer-btn {
    font-size: 10px;
    padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid;
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
  }
  .offer-btn.accept { background: var(--color-success); color: white; border-color: var(--color-success); }
  .offer-btn.decline { background: none; color: var(--color-danger); border-color: var(--color-danger); }
  .offer-btn.ignore { background: none; color: var(--color-muted); border-color: var(--color-border); }
  .monitor-picker {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--color-surface);
  }
  .picker-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-muted);
    margin-bottom: 8px;
  }
  .picker-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .picker-btn {
    font-size: 11px;
    padding: 4px 12px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-muted);
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
  }
  .picker-btn:hover { color: var(--color-text); }
  .picker-btn.selected {
    background: var(--color-accent);
    color: white;
    border-color: var(--color-accent);
  }
</style>
