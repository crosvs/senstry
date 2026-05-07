<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import { remoteStream } from '$lib/store/stream';
  import {
    ensureConnection, requestLiveView, requestSegmentById,
    getViewerSessionInfos, stopViewer, type ViewerSessionInfo
  } from '$lib/webrtc/viewer-peer';
  import { getSegmentById, saveSegment } from '$lib/db/segments';
  import { getFootageRef } from '$lib/db/footage';
  import { dbg } from '$lib/store/debug';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = null }: Props = $props();

  let liveVideoEl: HTMLVideoElement | undefined = $state();
  let segVideoEl: HTMLVideoElement | undefined = $state();
  let liveStatus = $state('');
  let liveLoading = $state(false);
  let segIdInput = $state('');
  let segRtcStatus = $state('');
  let segIdbStatus = $state('');
  let segRtcLoading = $state(false);
  let segIdbLoading = $state(false);
  let segBlob = $state<Blob | null>(null);
  let segMeta = $state<{ mimeType: string; startTime: number; endTime: number; originMonitor: string } | null>(null);
  let locallyStored = $state<boolean | null>(null);
  let saveLoading = $state(false);
  let sessions = $state<ViewerSessionInfo[]>([]);

  let sessionTick: ReturnType<typeof setInterval>;
  sessionTick = setInterval(() => { sessions = getViewerSessionInfos(); }, 2000);

  $effect(() => {
    if (liveVideoEl && $remoteStream) liveVideoEl.srcObject = $remoteStream;
  });

  $effect(() => {
    if (segVideoEl && segBlob) {
      const url = URL.createObjectURL(segBlob);
      segVideoEl.src = url;
      return () => URL.revokeObjectURL(url);
    }
  });

  async function fetchLive() {
    if (!$identity || !selectedMonitorPubkey) { liveStatus = 'Select a monitor device first'; return; }
    liveLoading = true;
    liveStatus = 'Connecting…';
    dbg('info', 'rtc', `live view request → ${selectedMonitorPubkey.slice(0, 8)}`);
    try {
      await requestLiveView($identity.privkey, $identity.pubkey, selectedMonitorPubkey);
      liveStatus = '✓ Connected';
      dbg('info', 'rtc', 'live view connected');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed';
      liveStatus = `✗ ${msg}`;
      dbg('warn', 'rtc', `live view failed: ${msg}`);
    } finally {
      liveLoading = false;
    }
  }

  // Resolve an input string to a segment: accepts segment ID or footage ref ID.
  async function resolveLocalSegment(id: string) {
    // Direct segment lookup
    const seg = await getSegmentById(id);
    if (seg) {
      dbg('info', 'idb', `segment found by id: ${id.slice(0, 8)}…`);
      return seg;
    }
    // Try as footage ref — may reference one or more segments
    const ref = await getFootageRef(id);
    if (ref) {
      dbg('info', 'idb', `footage ref found: ${id.slice(0, 8)}… segmentIds: [${ref.segmentIds.join(', ').slice(0, 40)}]`);
      for (const sid of ref.segmentIds) {
        const s = await getSegmentById(sid);
        if (s) return s;
      }
      dbg('warn', 'idb', `footage ref found but no local segments (segmentIds: ${ref.segmentIds.length})`);
      return null;
    }
    dbg('warn', 'idb', `id not found as segment or footage ref: ${id.slice(0, 8)}…`);
    return null;
  }

  async function checkLocalStorage(startTime: number, originMonitor: string) {
    const { getSegmentAt } = await import('$lib/db/segments');
    const local = await getSegmentAt(startTime, originMonitor);
    locallyStored = !!local;
    dbg('info', 'idb', `local storage check startTime:${startTime} → ${local ? 'stored' : 'not stored'}`);
  }

  async function fetchSegmentRtc() {
    if (!$identity || !selectedMonitorPubkey) { segRtcStatus = 'Select a monitor device first'; return; }
    const id = segIdInput.trim();
    if (!id) { segRtcStatus = '✗ Enter a segment ID'; return; }
    segRtcLoading = true;
    segRtcStatus = 'Fetching…';
    locallyStored = null;
    dbg('info', 'rtc', `segment request by id: ${id.slice(0, 8)}… → ${selectedMonitorPubkey.slice(0, 8)}`);
    try {
      const result = await requestSegmentById(id, $identity.privkey, $identity.pubkey, selectedMonitorPubkey);
      segBlob = result.blob;
      segMeta = { mimeType: result.mimeType, startTime: result.startTime, endTime: result.endTime, originMonitor: result.originMonitor };
      segRtcStatus = `✓ ${result.mimeType} [${result.startTime}–${result.endTime}]`;
      dbg('info', 'rtc', `segment received: ${result.mimeType} ${result.blob.size}B [${result.startTime}–${result.endTime}]`);
      await checkLocalStorage(result.startTime, result.originMonitor);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Not found';
      segRtcStatus = `✗ ${msg}`;
      dbg('warn', 'rtc', `segment fetch failed: ${msg}`);
    } finally {
      segRtcLoading = false;
    }
  }

  async function fetchSegmentIdb() {
    const id = segIdInput.trim();
    if (!id) { segIdbStatus = '✗ Enter a segment or footage ref ID'; return; }
    segIdbLoading = true;
    segIdbStatus = 'Looking up…';
    locallyStored = null;
    dbg('info', 'idb', `local lookup: ${id.slice(0, 8)}…`);
    try {
      const seg = await resolveLocalSegment(id);
      if (seg) {
        segBlob = seg.blob;
        segMeta = { mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, originMonitor: seg.originMonitor };
        segIdbStatus = `✓ Local [${seg.startTime}–${seg.endTime}]`;
        locallyStored = true;
      } else {
        segIdbStatus = '✗ Not found locally';
        locallyStored = false;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error';
      segIdbStatus = `✗ ${msg}`;
      dbg('warn', 'idb', `local lookup error: ${msg}`);
    } finally {
      segIdbLoading = false;
    }
  }

  async function saveLocally() {
    if (!segBlob || !segMeta) return;
    saveLoading = true;
    dbg('info', 'idb', `saving segment locally: ${segMeta.mimeType} [${segMeta.startTime}–${segMeta.endTime}]`);
    try {
      const id = await saveSegment(segBlob, segMeta.mimeType, segMeta.startTime, segMeta.endTime, segMeta.originMonitor);
      locallyStored = true;
      dbg('info', 'idb', `segment saved locally: ${id.slice(0, 8)}…`);
    } catch (e) {
      dbg('warn', 'idb', `save locally failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      saveLoading = false;
    }
  }

  function disconnect() {
    dbg('info', 'rtc', 'viewer disconnect');
    stopViewer(selectedMonitorPubkey ?? undefined);
    liveStatus = 'Disconnected';
    sessions = [];
  }

  onDestroy(() => {
    clearInterval(sessionTick);
  });
</script>

<DevSection title="Content Viewer">

  <!-- Live view -->
  <div class="subsec-title">Live View</div>
  <video bind:this={liveVideoEl} autoplay playsinline class="live-video"></video>
  <div class="row">
    <button class="act-btn accent" onclick={fetchLive} disabled={liveLoading || !selectedMonitorPubkey}>
      {liveLoading ? 'Connecting…' : 'WebRTC Fetch'}
    </button>
    <button class="act-btn" onclick={disconnect} disabled={sessions.length === 0}>Disconnect</button>
    {#if liveStatus}
      <span class="status" class:ok={liveStatus.startsWith('✓')} class:err={liveStatus.startsWith('✗')}>{liveStatus}</span>
    {/if}
  </div>

  {#if sessions.length > 0}
    <div class="sess-info">
      {#each sessions as s (s.monitorPubkey)}
        <span class="sess-badge">ICE: {s.iceState} · DC: {s.dcState ?? '—'}</span>
      {/each}
    </div>
  {/if}

  <!-- Segment fetch -->
  <div class="subsec-title">Segment API</div>
  <div class="seg-input-row">
    <input
      class="text-input"
      bind:value={segIdInput}
      placeholder="Segment ID or footage ref ID"
      type="text"
    />
  </div>
  <div class="row">
    <button class="act-btn accent" onclick={fetchSegmentRtc} disabled={segRtcLoading || !selectedMonitorPubkey}>
      {segRtcLoading ? '…' : 'WebRTC Fetch'}
    </button>
    {#if segRtcStatus}
      <span class="status" class:ok={segRtcStatus.startsWith('✓')} class:err={segRtcStatus.startsWith('✗')}>{segRtcStatus}</span>
    {/if}
  </div>
  <div class="row">
    <button class="act-btn" onclick={fetchSegmentIdb} disabled={segIdbLoading}>
      {segIdbLoading ? '…' : 'Local IDB'}
    </button>
    {#if segIdbStatus}
      <span class="status" class:ok={segIdbStatus.startsWith('✓')} class:err={segIdbStatus.startsWith('✗')}>{segIdbStatus}</span>
    {/if}
  </div>

  {#if segBlob}
    <video bind:this={segVideoEl} controls class="seg-video"></video>

    <!-- Local storage status -->
    <div class="storage-row">
      {#if locallyStored === true}
        <span class="storage-badge stored">✓ Stored locally</span>
      {:else if locallyStored === false}
        <span class="storage-badge not-stored">○ Not stored locally</span>
        <button class="act-btn accent" onclick={saveLocally} disabled={saveLoading}>
          {saveLoading ? 'Saving…' : 'Save locally'}
        </button>
      {:else}
        <span class="storage-badge checking">Checking…</span>
      {/if}
    </div>
  {/if}

  <LogPanel sources={['rtc', 'idb']} />
</DevSection>

<style>
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 4px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .live-video { width: 100%; border-radius: 8px; background: #000; max-height: 220px; }
  .seg-video { width: 100%; border-radius: 8px; background: #000; max-height: 160px; margin-top: 4px; }
  .seg-input-row { display: flex; gap: 6px; }
  .text-input {
    font-size: 11px; padding: 3px 8px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-text); font-family: ui-monospace, monospace; width: 100%; box-sizing: border-box;
  }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .status { font-size: 11px; }
  .status.ok { color: var(--color-success); }
  .status.err { color: var(--color-danger); }
  .sess-info { display: flex; flex-wrap: wrap; gap: 4px; }
  .sess-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border); font-family: ui-monospace, monospace; }
  .storage-row { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .storage-badge { font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 600; }
  .storage-badge.stored { background: rgba(34,197,94,0.12); color: var(--color-success); border: 1px solid var(--color-success); }
  .storage-badge.not-stored { background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border); }
  .storage-badge.checking { background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border); font-style: italic; }
</style>
