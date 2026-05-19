<script lang="ts">
  import { identity } from '$lib/store/identity';
  import { remoteStream } from '$lib/store/stream';
  import { viewerConnection, selectChannel } from '$lib/store/viewer-connection';
  import { startLiveView, disconnectViewer, cancelConnect } from '$lib/webrtc/viewer-peer';
  import DevSection from './DevSection.svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = null }: Props = $props();

  let liveVideoEl = $state<HTMLVideoElement | undefined>();
  let liveStatus  = $state('');
  let liveLoading = $state(false);

  const vc = $derived($viewerConnection);

  $effect(() => {
    if (liveVideoEl && $remoteStream) liveVideoEl.srcObject = $remoteStream;
  });

  async function handleGoLive() {
    if (!$identity || !selectedMonitorPubkey || !vc.channelId) return;
    liveLoading = true; liveStatus = 'Going live…';
    try {
      await startLiveView($identity.privkey, $identity.pubkey, selectedMonitorPubkey, vc.channelId);
      liveStatus = '✓ Live';
    } catch (e) {
      liveStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally {
      liveLoading = false;
    }
  }

  function handleStopLive() {
    disconnectViewer(selectedMonitorPubkey ?? undefined);
    liveStatus = '';
  }

  function handleCancelLive() {
    if (selectedMonitorPubkey) cancelConnect(selectedMonitorPubkey);
  }

  function enterFullscreen() {
    liveVideoEl?.requestFullscreen?.().catch(() => {});
  }
</script>

<DevSection title="Live View">
  <div class="live-video-wrap">
    <video bind:this={liveVideoEl} autoplay playsinline controls class="live-video"></video>
    <button class="fs-btn" onclick={enterFullscreen} title="Fullscreen">⛶</button>
  </div>
  <div class="row">
    {#if vc.status === 'connecting' && vc.mode === 'live'}
      <button class="act-btn" onclick={handleCancelLive}>Cancel</button>
      <span class="status">Connecting live…</span>
    {:else if vc.status === 'online' && vc.mode === 'live'}
      <button class="act-btn" onclick={handleStopLive}>Stop Live</button>
    {:else if vc.status === 'online' && vc.mode === 'data'}
      <button class="act-btn accent" onclick={handleGoLive} disabled={liveLoading || !vc.channelId}>
        {liveLoading ? 'Connecting…' : 'Go Live'}
      </button>
    {:else}
      <button class="act-btn" disabled>Go Live</button>
      <span class="status">Connect via Devices first</span>
    {/if}
    <select class="source-select"
      onchange={(e) => selectChannel((e.target as HTMLSelectElement).value)}
      disabled={vc.channels.length === 0}>
      {#if vc.channels.length === 0}
        <option value="" disabled selected>No channels</option>
      {:else}
        {#each vc.channels as ch (ch.id)}
          <option value={ch.id} selected={ch.id === vc.channelId}>{ch.name || ch.id.slice(0, 8)}</option>
        {/each}
      {/if}
    </select>
    {#if liveStatus}
      <span class="status" class:ok={liveStatus.startsWith('✓')} class:err={liveStatus.startsWith('✗')}>
        {liveStatus}
      </span>
    {/if}
  </div>
</DevSection>

<style>
  .live-video-wrap { position: relative; width: 100%; margin-bottom: 4px; }
  .live-video { width: 100%; border-radius: 6px; background: #000; max-height: 260px; display: block; }
  .fs-btn { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.55); border: none; color: white; font-size: 14px; padding: 2px 6px; border-radius: 4px; cursor: pointer; line-height: 1; }
  .fs-btn:hover { background: rgba(0,0,0,0.8); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .status { font-size: 10px; }
  .status.ok { color: var(--color-success); }
  .status.err { color: var(--color-danger); }
  .source-select { font-size: 10px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: ui-monospace, monospace; max-width: 160px; }
</style>
