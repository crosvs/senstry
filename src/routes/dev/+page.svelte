<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import { outboxFlusher } from '$lib/nostr/outbox';
  import { onMount, onDestroy } from 'svelte';

  import IdentitySection from '$lib/components/dev/IdentitySection.svelte';
  import RelaySection from '$lib/components/dev/RelaySection.svelte';
  import PairingSection from '$lib/components/dev/PairingSection.svelte';
  import DevicesSection from '$lib/components/dev/DevicesSection.svelte';
  import SettingsSection from '$lib/components/dev/SettingsSection.svelte';
  import SentrySection from '$lib/components/dev/SentrySection.svelte';
  import ContentViewerSection from '$lib/components/dev/ContentViewerSection.svelte';
  import SegmentStorageSection from '$lib/components/dev/SegmentStorageSection.svelte';
  import type { SignalMessage } from '$lib/webrtc/signaling';
  import type { SensorState, LinkActivationState } from '$lib/store/pipeline';
  import type { AlertSession } from '$lib/components/dev/SentrySection.svelte';

  // ── Shared page-level state ───────────────────────────────────────────────
  let selectedMonitorPubkey = $state<string | null>(null);
  let signalRouterActive = $state(false);
  let autoAccept = $state(true);
  let sensorStates = $state<Record<string, SensorState>>({});
  let linkStates = $state<Record<string, LinkActivationState>>({});
  let activeAlerts = $state<AlertSession[]>([]);

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
    <SettingsSection {sensorStates} {linkStates} {activeAlerts} />

    <SentrySection
      bind:signalRouterActive
      bind:autoAccept
      bind:sensorStates
      bind:linkStates
      bind:activeAlerts
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

    <!-- Device-scoped sections divider -->
    <div class="scope-divider" title="All sections below are scoped to the device selected here. Identity, relay, pairing, settings, and sentry above apply globally.">
      <span class="scope-line"></span>
      <span class="scope-label">Device scope ↓</span>
      <span class="scope-line"></span>
    </div>

    <DevicesSection bind:selectedMonitorPubkey />
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

  .scope-divider {
    display: flex; align-items: center; gap: 8px;
    cursor: help;
    padding: 4px 0;
  }
  .scope-line { flex: 1; height: 1px; background: var(--color-border); }
  .scope-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--color-muted); white-space: nowrap;
  }
</style>
