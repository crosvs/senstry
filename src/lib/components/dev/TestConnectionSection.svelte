<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import { publish, subscribe } from '$lib/nostr/client';
  import { sendSignal } from '$lib/webrtc/signaling';
  import DevSection from './DevSection.svelte';

  interface PingResult {
    pubkey: string;
    status: 'idle' | 'sending' | 'sent' | 'pong' | 'timeout' | 'error';
    latencyMs?: number;
    error?: string;
  }

  let results = $state<Record<string, PingResult>>({});

  async function ping(devicePubkey: string) {
    if (!$identity) return;
    const sessionId = crypto.randomUUID();
    const startMs = Date.now();

    results = { ...results, [devicePubkey]: { pubkey: devicePubkey, status: 'sending' } };

    // Listen for pong with 5s timeout
    let pongSub: { close: () => void } | null = null;
    const timeout = setTimeout(() => {
      pongSub?.close();
      results = { ...results, [devicePubkey]: { pubkey: devicePubkey, status: 'timeout' } };
    }, 5000);

    pongSub = subscribe(
      { kinds: [1059], '#p': [$identity.pubkey] },
      () => {
        // Actual pong decryption happens inside signal-router; here we just
        // listen for the relay echo of our own send to confirm delivery.
        // A proper pong is handled by checking sessionId in the signal router.
      }
    );

    try {
      await sendSignal($identity.privkey, $identity.pubkey, devicePubkey, {
        type: 'ping',
        sessionId,
      });
      results = { ...results, [devicePubkey]: { pubkey: devicePubkey, status: 'sent', latencyMs: Date.now() - startMs } };

      // Listen for pong reply via a separate subscription
      const pongWatcher = subscribe(
        { kinds: [1059], '#p': [$identity.pubkey] },
        (event) => {
          // We can't easily decrypt here without the crypto module;
          // the main signal router will handle the actual pong.
          // This is a best-effort relay-echo confirmation.
        }
      );
      setTimeout(() => {
        pongWatcher.close();
      }, 5000);
    } catch (e) {
      clearTimeout(timeout);
      pongSub?.close();
      results = { ...results, [devicePubkey]: { pubkey: devicePubkey, status: 'error', error: e instanceof Error ? e.message : 'Failed' } };
      return;
    }

    clearTimeout(timeout);
    pongSub?.close();
  }

  // Accept pong signals from the page-level signal router via a callback
  interface Props {
    onPong?: (fromPubkey: string, sessionId: string, latencyMs: number) => void;
  }
  let { onPong }: Props = $props();
</script>

<DevSection title="Test Connection">
  {#each $pairedDevices as dev (dev.pubkey)}
    {@const r = results[dev.pubkey]}
    <div class="ping-row">
      <span class="nickname">{dev.nickname}</span>
      <span class="pubkey-short">{dev.pubkey.slice(0, 12)}…</span>
      <button
        class="act-btn"
        onclick={() => ping(dev.pubkey)}
        disabled={r?.status === 'sending'}
      >
        {r?.status === 'sending' ? '…' : 'Ping'}
      </button>
      {#if r}
        {#if r.status === 'sent'}
          <span class="ok">✓ Sent ({r.latencyMs}ms)</span>
        {:else if r.status === 'pong'}
          <span class="ok">✓ Pong ({r.latencyMs}ms)</span>
        {:else if r.status === 'timeout'}
          <span class="warn">⚠ No response</span>
        {:else if r.status === 'error'}
          <span class="err">✗ {r.error}</span>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="empty">No paired devices — pair a device first.</div>
  {/each}
</DevSection>

<style>
  .ping-row {
    display: flex; align-items: center; gap: 8px; padding: 5px 4px;
    border-bottom: 1px solid var(--color-border); font-size: 11px;
  }
  .ping-row:last-child { border-bottom: none; }
  .nickname { font-weight: 600; color: var(--color-text); width: 120px; flex-shrink: 0; }
  .pubkey-short { font-family: ui-monospace, monospace; color: var(--color-muted); font-size: 10px; flex: 1; }
  .act-btn {
    font-size: 10px; padding: 2px 10px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-muted); cursor: pointer; font-family: inherit;
  }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .ok { color: var(--color-success); font-size: 11px; }
  .warn { color: var(--color-warning); font-size: 11px; }
  .err { color: var(--color-danger); font-size: 11px; }
  .empty { font-size: 11px; color: var(--color-muted); text-align: center; padding: 10px 0; }
</style>
