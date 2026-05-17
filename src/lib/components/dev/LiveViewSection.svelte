<script lang="ts">
  import { identity } from '$lib/store/identity';
  import { remoteStream } from '$lib/store/stream';
  import { channels } from '$lib/store/pipeline';
  import {
    requestLiveView, getViewerSessionInfos, stopViewer, type ViewerSessionInfo
  } from '$lib/webrtc/viewer-peer';
  import DevSection from './DevSection.svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = null }: Props = $props();

  let liveVideoEl = $state<HTMLVideoElement | undefined>();
  let liveStatus  = $state('');
  let liveLoading = $state(false);
  let sessions    = $state<ViewerSessionInfo[]>([]);
  let channelId   = $state('');

  const sessionTick = setInterval(() => { sessions = getViewerSessionInfos(); }, 2000);

  $effect(() => {
    if (liveVideoEl && $remoteStream) liveVideoEl.srcObject = $remoteStream;
  });

  async function connect() {
    if (!$identity || !selectedMonitorPubkey) { liveStatus = 'Select a monitor device first'; return; }
    liveLoading = true; liveStatus = 'Connecting…';
    try {
      await requestLiveView($identity.privkey, $identity.pubkey, selectedMonitorPubkey, undefined, channelId || undefined);
      liveStatus = '✓ Connected';
    } catch (e) {
      liveStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { liveLoading = false; }
  }

  function disconnect() {
    stopViewer(selectedMonitorPubkey ?? undefined);
    liveStatus = 'Disconnected';
    sessions = [];
  }

  function enterFullscreen() {
    liveVideoEl?.requestFullscreen?.().catch(() => {});
  }

  onDestroy(() => { clearInterval(sessionTick); });
</script>

<DevSection title="Live View">
  <div class="live-video-wrap">
    <video bind:this={liveVideoEl} autoplay playsinline controls class="live-video"></video>
    <button class="fs-btn" onclick={enterFullscreen} title="Fullscreen">⛶</button>
  </div>
  <div class="row">
    <button class="act-btn accent" onclick={connect} disabled={liveLoading || !selectedMonitorPubkey}>
      {liveLoading ? 'Connecting…' : 'Connect'}
    </button>
    <button class="act-btn" onclick={disconnect} disabled={sessions.length === 0}>Disconnect</button>
    <select class="source-select" bind:value={channelId}
      title="Channel to receive — active recording takes priority over the channel's default sources">
      <option value="">All channels</option>
      {#each $channels as ch (ch.id)}
        <option value={ch.id}>{ch.name || ch.id.slice(0, 8)}</option>
      {/each}
    </select>
    {#if liveStatus}
      <span class="status" class:ok={liveStatus.startsWith('✓')} class:err={liveStatus.startsWith('✗')}>{liveStatus}</span>
    {/if}
  </div>
  {#if sessions.length > 0}
    <div class="sess-row">
      {#each sessions as s (s.monitorPubkey)}
        <span class="sess-badge">{s.mode === 'live' ? '📡' : '📦'} ICE:{s.iceState} DC:{s.dcState ?? '—'}</span>
      {/each}
    </div>
  {/if}
</DevSection>

<style>
  .live-video-wrap { position: relative; width: 100%; margin-bottom: 4px; }
  .live-video { width: 100%; border-radius: 6px; background: #000; max-height: 260px; display: block; }
  .fs-btn { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.55); border: none; color: white; font-size: 14px; padding: 2px 6px; border-radius: 4px; cursor: pointer; line-height: 1; }
  .fs-btn:hover { background: rgba(0,0,0,0.8); }
  .sess-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .sess-badge { font-size: 9px; padding: 2px 6px; border-radius: 4px; background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border); font-family: ui-monospace, monospace; }
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
