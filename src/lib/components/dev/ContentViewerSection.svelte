<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import { remoteStream } from '$lib/store/stream';
  import {
    ensureConnection, requestLiveView, requestSourceList, requestCoverageMap,
    requestSegment, requestSegmentById,
    getViewerSessionInfos, stopViewer, type ViewerSessionInfo
  } from '$lib/webrtc/viewer-peer';
  import { getSegmentById, getSegmentsInRange, saveSegment, getCoverageMap } from '$lib/db/segments';
  import { getFootageRef } from '$lib/db/footage';
  import { dbg } from '$lib/store/debug';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = null }: Props = $props();

  // ── Live View ────────────────────────────────────────────────────────────
  let liveVideoEl = $state<HTMLVideoElement | undefined>();
  let liveStatus = $state('');
  let liveLoading = $state(false);
  let sessions = $state<ViewerSessionInfo[]>([]);
  // Source selection — '' = all sources (composite), populated after querying monitor
  let liveSourceId = $state('');
  let liveSourceOptions = $state<string[]>([]);
  let fetchingSourceList = $state(false);

  const sessionTick = setInterval(() => { sessions = getViewerSessionInfos(); }, 2000);

  $effect(() => {
    if (liveVideoEl && $remoteStream) liveVideoEl.srcObject = $remoteStream;
  });

  async function fetchLive() {
    if (!$identity || !selectedMonitorPubkey) { liveStatus = 'Select a monitor device first'; return; }
    liveLoading = true; liveStatus = 'Connecting…';
    try {
      await requestLiveView($identity.privkey, $identity.pubkey, selectedMonitorPubkey, liveSourceId || undefined);
      liveStatus = '✓ Connected';
    } catch (e) {
      liveStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { liveLoading = false; }
  }

  function disconnect() {
    stopViewer(selectedMonitorPubkey ?? undefined);
    liveStatus = 'Disconnected'; sessions = [];
  }

  async function fetchSources() {
    if (!$identity || !selectedMonitorPubkey) return;
    fetchingSourceList = true;
    try {
      liveSourceOptions = await requestSourceList($identity.privkey, $identity.pubkey, selectedMonitorPubkey);
    } catch {
      liveSourceOptions = [];
    } finally {
      fetchingSourceList = false;
    }
  }

  // ── Recorded Viewer ──────────────────────────────────────────────────────
  interface FetchedSeg {
    key: string;
    source: 'rtc' | 'idb';
    mimeType: string;
    startTime: number;
    endTime: number;
    blob: Blob;
    // rtc: the canonical monitor segment ID (used as backupOf when saving)
    // idb: the viewer's own local segment ID
    segmentId?: string;
    // idb only: actual backupOf value stored in the DB record
    backupOf?: string | null;
  }

  let fetchedSegs = $state<FetchedSeg[]>([]);
  let currentIdx = $state(-1);
  let currentViewerUrl = $state<string | null>(null);
  let autoPlayNext = $state(false);
  let autoPlayCountdown = $state(0);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  let viewerVideoEl = $state<HTMLVideoElement | undefined>();
  let viewerImgEl = $state<HTMLImageElement | undefined>();
  let viewerError = $state('');

  const currentSeg = $derived(currentIdx >= 0 ? fetchedSegs[currentIdx] : null);

  // Reads an OPFS-backed blob fully into memory so it survives IDB/OPFS deletion.
  async function materializeBlob(blob: Blob): Promise<Blob> {
    const buf = await blob.arrayBuffer();
    return new Blob([buf], { type: blob.type });
  }

  $effect(() => {
    if (!currentSeg) { currentViewerUrl = null; viewerError = ''; return; }
    viewerError = '';
    // Capture url locally so cleanup can revoke it without reading reactive $state
    const url = URL.createObjectURL(currentSeg.blob);
    currentViewerUrl = url;
    return () => { URL.revokeObjectURL(url); currentViewerUrl = null; };
  });

  $effect(() => {
    if (viewerVideoEl && currentViewerUrl && currentSeg?.mimeType.startsWith('video/')) {
      viewerVideoEl.src = currentViewerUrl;
      viewerVideoEl.load();
      viewerVideoEl.play().catch(() => {});
    }
  });

  $effect(() => {
    if (viewerImgEl && currentViewerUrl && currentSeg?.mimeType.startsWith('image/')) {
      viewerImgEl.src = currentViewerUrl;
      // Auto-advance after 3s for photos
      if (autoPlayNext) startPhotoCountdown();
    }
  });

  function startPhotoCountdown() {
    clearAutoPlayTimer();
    autoPlayCountdown = 3;
    countdownTimer = setInterval(() => {
      autoPlayCountdown--;
      if (autoPlayCountdown <= 0) {
        clearAutoPlayTimer();
        advanceToNext();
      }
    }, 1000);
  }

  function clearAutoPlayTimer() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    autoPlayCountdown = 0;
  }

  function handleVideoEnded() {
    if (!autoPlayNext) return;
    advanceToNext();
  }

  function advanceToNext() {
    if (currentIdx + 1 < fetchedSegs.length) showSeg(currentIdx + 1);
  }

  function showSeg(idx: number) {
    if (idx < 0 || idx >= fetchedSegs.length) return;
    clearAutoPlayTimer();
    currentIdx = idx;
  }

  function prevSeg() { showSeg(currentIdx - 1); }
  function nextSeg() { showSeg(currentIdx + 1); }

  function pushSeg(seg: FetchedSeg) {
    if (fetchedSegs.some(s => s.key === seg.key)) return;
    const currentKey = currentIdx >= 0 ? fetchedSegs[currentIdx]?.key : null;
    const sorted = [...fetchedSegs, seg].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    fetchedSegs = sorted;
    if (currentKey != null) currentIdx = sorted.findIndex(s => s.key === currentKey);
  }

  function removeSeg(i: number) {
    const key = fetchedSegs[i]?.key;
    fetchedSegs = fetchedSegs.filter((_, j) => j !== i);
    if (key) { savedKeys.delete(key); savedKeys = new Set(savedKeys); }
    // keep currentIdx pointing at the same logical segment
    if (currentIdx >= fetchedSegs.length) currentIdx = fetchedSegs.length - 1;
    else if (currentIdx > i) currentIdx--;
  }

  // ── Time Range ───────────────────────────────────────────────────────────
  let rangeDate = $state('');
  let rangeTs = $state('');

  function applyDate() {
    if (!rangeDate) return;
    const d = new Date(rangeDate + 'T00:00:00');
    const from = Math.floor(d.getTime() / 1000);
    const e = new Date(rangeDate + 'T23:59:59');
    const to = Math.floor(e.getTime() / 1000);
    rangeTs = `${from}-${to}`;
  }

  function parseRangeInput(input: string): [number, number] | null {
    const t = input.trim();
    const dash = t.lastIndexOf('-');
    if (dash > 0) {
      const f = parseInt(t.slice(0, dash));
      const e = parseInt(t.slice(dash + 1));
      if (!isNaN(f) && !isNaN(e)) return [f, e];
    }
    const ts = parseInt(t);
    if (!isNaN(ts)) return [ts, ts];
    return null;
  }

  // ── Coverage ─────────────────────────────────────────────────────────────
  let remoteCoverage = $state<[number, number][] | null>(null);
  let remoteCoverageStatus = $state('');
  let remoteCoverageLoading = $state(false);

  let localCoverage = $state<[number, number][] | null>(null);
  let localCoverageStatus = $state('');
  let localCoverageLoading = $state(false);

  function fmtTs(unix: number) { return new Date(unix * 1000).toLocaleTimeString(); }
  function fmtDur(s: number) {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), sec = s % 60;
    return sec ? `${m}m ${sec}s` : `${m}m`;
  }

  async function requestRemoteCoverage() {
    if (!$identity || !selectedMonitorPubkey) { remoteCoverageStatus = 'Select a monitor device first'; return; }
    remoteCoverageLoading = true; remoteCoverageStatus = 'Connecting…'; remoteCoverage = null;
    try {
      await ensureConnection($identity.privkey, $identity.pubkey, selectedMonitorPubkey, 'data');
      remoteCoverageStatus = 'Requesting…';
      const map = await requestCoverageMap($identity.privkey, $identity.pubkey, selectedMonitorPubkey);
      remoteCoverage = map;
      remoteCoverageStatus = map.length ? `✓ ${map.length} range${map.length !== 1 ? 's' : ''}` : '✓ No footage';
    } catch (e) {
      remoteCoverageStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { remoteCoverageLoading = false; }
  }

  async function loadLocalCoverage() {
    const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    if (!effectivePubkey) { localCoverageStatus = 'No device selected'; return; }
    localCoverageLoading = true; localCoverageStatus = 'Reading IDB…'; localCoverage = null;
    try {
      const map = await getCoverageMap(effectivePubkey);
      localCoverage = map;
      localCoverageStatus = map.length ? `✓ ${map.length} range${map.length !== 1 ? 's' : ''}` : '✓ Nothing stored';
    } catch (e) {
      localCoverageStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { localCoverageLoading = false; }
  }

  const bothCoverageLoading = $derived(remoteCoverageLoading || localCoverageLoading);

  async function fetchBothCoverage() {
    await Promise.all([requestRemoteCoverage(), loadLocalCoverage()]);
  }

  // ── Type Filter ──────────────────────────────────────────────────────────
  type MimePrefix = 'video/' | 'audio/' | 'image/';
  const TYPE_LABELS: Record<MimePrefix, string> = { 'video/': 'Video', 'audio/': 'Audio', 'image/': 'Photo' };
  const TYPE_STEP: Record<MimePrefix, number> = { 'video/': 10, 'audio/': 10, 'image/': 1 };
  let fetchTypeFilter = $state<Set<MimePrefix>>(new Set(['video/', 'audio/', 'image/']));

  function toggleFetchType(t: MimePrefix) {
    const next = new Set(fetchTypeFilter);
    if (next.has(t) && next.size > 1) next.delete(t);
    else next.add(t);
    fetchTypeFilter = next;
  }

  // ── Fetch Segments in Range ──────────────────────────────────────────────
  let fetchStatus = $state('');
  let fetchLoading = $state(false);

  function rangeOrError(): { from: number; to: number } | null {
    const parsed = parseRangeInput(rangeTs);
    if (!parsed) { fetchStatus = '✗ Set a valid time range'; return null; }
    const [from, to] = parsed;
    if (from > to) { fetchStatus = '✗ Start must be ≤ end'; return null; }
    return { from, to };
  }

  async function fetchSegmentsLocal() {
    const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    if (!effectivePubkey) { fetchStatus = 'No device selected'; return; }
    const range = rangeOrError(); if (!range) return;
    const { from, to } = range;

    fetchLoading = true; fetchStatus = 'Querying local IDB…';
    try {
      const metas = await getSegmentsInRange(from, to, effectivePubkey);
      const filtered = metas.filter(m => [...fetchTypeFilter].some(p => m.mimeType.startsWith(p)));
      if (filtered.length === 0) { fetchStatus = '✗ No local segments in range for selected types'; fetchLoading = false; return; }

      const existing = new Set(fetchedSegs.map(s => s.key));
      let added = 0;
      for (const meta of filtered) {
        const key = `idb-${meta.segmentId}`;
        if (existing.has(key)) continue;
        const withBlob = await getSegmentById(meta.segmentId);
        if (!withBlob) continue;
        existing.add(key);
        const blob = await materializeBlob(withBlob.blob);
        pushSeg({ key, source: 'idb', mimeType: withBlob.mimeType, startTime: withBlob.startTime, endTime: withBlob.endTime, blob, segmentId: withBlob.segmentId, backupOf: withBlob.backupOf });
        added++;
      }
      fetchStatus = added === 0 ? '✗ No new segments' : `✓ ${added} local segment${added !== 1 ? 's' : ''}`;
      if (currentIdx < 0 && fetchedSegs.length > 0) showSeg(0);
    } catch (e) {
      fetchStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { fetchLoading = false; }
  }

  async function fetchSegmentsSmart() {
    const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    if (!$identity || !effectivePubkey) { fetchStatus = 'No device selected'; return; }
    const range = rangeOrError(); if (!range) return;
    const { from, to } = range;

    fetchLoading = true; fetchStatus = 'Checking local IDB…';
    try {
      // Step 1: load locally available segments matching the type filter
      const localMetas = await getSegmentsInRange(from, to, effectivePubkey);
      const localFiltered = localMetas.filter(m => [...fetchTypeFilter].some(p => m.mimeType.startsWith(p)));
      const existing = new Set(fetchedSegs.map(s => s.key));
      let added = 0;

      for (const meta of localFiltered) {
        const key = `idb-${meta.segmentId}`;
        if (existing.has(key)) continue;
        const withBlob = await getSegmentById(meta.segmentId);
        if (!withBlob) continue;
        existing.add(key);
        const blob = await materializeBlob(withBlob.blob);
        pushSeg({ key, source: 'idb', mimeType: withBlob.mimeType, startTime: withBlob.startTime, endTime: withBlob.endTime, blob, segmentId: withBlob.segmentId, backupOf: withBlob.backupOf });
        added++;
      }

      // Per-type local coverage + backupOf sets for gap-fill dedup
      const localCoveredByType = new Map<MimePrefix, [number, number][]>();
      const localBackupOfIds = new Set(localMetas.filter(m => m.backupOf).map(m => m.backupOf!));
      for (const prefix of fetchTypeFilter) {
        localCoveredByType.set(prefix, localMetas.filter(m => m.mimeType.startsWith(prefix)).map(m => [m.startTime, m.endTime] as [number, number]));
      }

      // Step 2: fill gaps per type via WebRTC
      if (selectedMonitorPubkey) {
        fetchStatus = 'Connecting for gap-fill…';
        await ensureConnection($identity.privkey, $identity.pubkey, selectedMonitorPubkey, 'data');
        const MAX = 100;

        for (const mimePrefix of fetchTypeFilter) {
          if (added >= MAX) break;
          const localCovered = localCoveredByType.get(mimePrefix) ?? [];
          fetchStatus = `Getting ${TYPE_LABELS[mimePrefix]} coverage for gap-fill…`;
          let typeCoverage: [number, number][];
          try {
            typeCoverage = await requestCoverageMap($identity.privkey, $identity.pubkey, selectedMonitorPubkey, mimePrefix);
          } catch { continue; }

          const step = TYPE_STEP[mimePrefix];
          for (const [rStart, rEnd] of typeCoverage.filter(([s, e]) => s < to && e > from)) {
            let t = Math.max(rStart, from);
            const end = Math.min(rEnd, to);
            while (t < end && added < MAX) {
              const coveredLocally = localCovered.some(([ls, le]) => t >= ls && t < le);
              if (coveredLocally) { t += step; continue; }

              fetchStatus = `Gap-filling ${TYPE_LABELS[mimePrefix]} at ${fmtTs(t)}…`;
              try {
                const res = await requestSegment(t, $identity.privkey, $identity.pubkey, selectedMonitorPubkey, mimePrefix);
                const key = `rtc-${res.startTime}-${res.endTime}-${res.mimeType.split('/')[0]}`;
                if (!existing.has(key)) {
                  existing.add(key);
                  pushSeg({ key, source: 'rtc', mimeType: res.mimeType, startTime: res.startTime, endTime: res.endTime, blob: res.blob, segmentId: res.segmentId || undefined });
                  added++;
                  if (res.segmentId && localBackupOfIds.has(res.segmentId)) {
                    savedKeys = new Set([...savedKeys, key]);
                  }
                }
                t = res.endTime > t ? res.endTime : t + step;
              } catch {
                t += step;
              }
            }
            if (added >= MAX) break;
          }
        }
      }

      fetchStatus = added === 0 ? '✗ No new segments' : `✓ ${added} segment${added !== 1 ? 's' : ''} (local+rtc)`;
      if (currentIdx < 0 && fetchedSegs.length > 0) showSeg(0);
    } catch (e) {
      fetchStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { fetchLoading = false; }
  }

  async function fetchSegmentsInRange() {
    if (!$identity || !selectedMonitorPubkey) { fetchStatus = 'Select a monitor device first'; return; }
    const range = rangeOrError(); if (!range) return;
    const { from, to } = range;

    fetchLoading = true;
    const existing = new Set(fetchedSegs.map(s => s.key));
    let added = 0;
    const MAX = 100;

    try {
      await ensureConnection($identity.privkey, $identity.pubkey, selectedMonitorPubkey, 'data');

      for (const mimePrefix of fetchTypeFilter) {
        if (added >= MAX) break;
        fetchStatus = `Getting ${TYPE_LABELS[mimePrefix]} coverage…`;
        let typeCoverage: [number, number][];
        try {
          typeCoverage = await requestCoverageMap($identity.privkey, $identity.pubkey, selectedMonitorPubkey, mimePrefix);
        } catch { continue; }

        const step = TYPE_STEP[mimePrefix];
        for (const [rStart, rEnd] of typeCoverage.filter(([s, e]) => s < to && e > from)) {
          let t = Math.max(rStart, from);
          const end = Math.min(rEnd, to);
          while (t < end && added < MAX) {
            fetchStatus = `Fetching ${TYPE_LABELS[mimePrefix]} at ${fmtTs(t)}…`;
            try {
              const res = await requestSegment(t, $identity.privkey, $identity.pubkey, selectedMonitorPubkey, mimePrefix);
              const key = `rtc-${res.startTime}-${res.endTime}-${res.mimeType.split('/')[0]}`;
              if (!existing.has(key)) {
                existing.add(key);
                pushSeg({ key, source: 'rtc', mimeType: res.mimeType, startTime: res.startTime, endTime: res.endTime, blob: res.blob, segmentId: res.segmentId || undefined });
                added++;
              }
              t = res.endTime > t ? res.endTime : t + step;
            } catch {
              t += step;
            }
          }
          if (added >= MAX) break;
        }
      }

      fetchStatus = added === 0 ? '✗ No new segments' : `✓ ${added} segment${added !== 1 ? 's' : ''} fetched`;
      if (currentIdx < 0 && fetchedSegs.length > 0) showSeg(0);
    } catch (e) {
      fetchStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { fetchLoading = false; }
  }

  // ── Fetch by ID ──────────────────────────────────────────────────────────
  let segIdInput = $state('');
  let segIdStatus = $state('');
  let segIdLoading = $state(false);

  async function fetchByIdRtc() {
    if (!$identity || !selectedMonitorPubkey) { segIdStatus = 'Select a monitor device first'; return; }
    const id = segIdInput.trim();
    if (!id) { segIdStatus = '✗ Enter an ID'; return; }
    segIdLoading = true; segIdStatus = 'Fetching…';
    try {
      const res = await requestSegmentById(id, $identity.privkey, $identity.pubkey, selectedMonitorPubkey);
      const key = `rtc-id-${id}`;
      pushSeg({ key, source: 'rtc', mimeType: res.mimeType, startTime: res.startTime, endTime: res.endTime, blob: res.blob, segmentId: res.segmentId || undefined });
      showSeg(fetchedSegs.findIndex(s => s.key === key));
      segIdStatus = `✓ ${res.mimeType} [${fmtTs(res.startTime)}–${fmtTs(res.endTime)}]`;
    } catch (e) {
      segIdStatus = `✗ ${e instanceof Error ? e.message : 'Not found'}`;
    } finally { segIdLoading = false; }
  }

  async function fetchByIdIdb() {
    const id = segIdInput.trim();
    if (!id) { segIdStatus = '✗ Enter an ID'; return; }
    segIdLoading = true; segIdStatus = 'Looking up…';
    try {
      let seg = await getSegmentById(id);
      if (!seg) {
        const ref = await getFootageRef(id);
        if (ref) {
          const segs = await getSegmentsInRange(ref.startTime, ref.endTime, ref.originMonitor);
          if (segs.length > 0) seg = (await getSegmentById(segs[0].segmentId)) ?? undefined;
        }
      }
      if (seg) {
        const key = `idb-${seg.segmentId}`;
        const blob = await materializeBlob(seg.blob);
        pushSeg({ key, source: 'idb', mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, blob, segmentId: seg.segmentId, backupOf: seg.backupOf });
        showSeg(fetchedSegs.findIndex(s => s.key === key));
        segIdStatus = `✓ Local [${fmtTs(seg.startTime)}–${fmtTs(seg.endTime)}]`;
      } else {
        segIdStatus = '✗ Not found locally';
      }
    } catch (e) {
      segIdStatus = `✗ ${e instanceof Error ? e.message : 'Error'}`;
    } finally { segIdLoading = false; }
  }

  let savedKeys  = $state(new Set<string>());
  let savingKeys = $state(new Set<string>());
  let showRaw = $state(false);

  async function saveSeg(i: number) {
    const seg = fetchedSegs[i];
    if (!seg || seg.source !== 'rtc' || !selectedMonitorPubkey) return;
    if (savedKeys.has(seg.key) || savingKeys.has(seg.key)) return;
    savingKeys = new Set([...savingKeys, seg.key]);
    try {
      // segmentId on an RTC fetch is the canonical ID from the monitor chain — use as backupOf
      await saveSegment(seg.blob, seg.mimeType, seg.startTime, seg.endTime, selectedMonitorPubkey, 'default-mic', seg.segmentId ?? null);
      savedKeys = new Set([...savedKeys, seg.key]);
      dbg('info', 'idb', `saved remote segment [${fmtTs(seg.startTime)}–${fmtTs(seg.endTime)}] as monitor ${selectedMonitorPubkey.slice(0, 8)}`);
    } catch (e) {
      dbg('warn', 'idb', `save segment failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      savingKeys = new Set([...savingKeys].filter(k => k !== seg.key));
    }
  }

  async function copyText(s: string) { await navigator.clipboard.writeText(s); }

  function clearSegments() { fetchedSegs = []; currentIdx = -1; currentViewerUrl = null; clearAutoPlayTimer(); savedKeys = new Set(); savingKeys = new Set(); }

  onDestroy(() => { clearInterval(sessionTick); clearAutoPlayTimer(); });
</script>

<DevSection title="Content Viewer">

  <!-- ── Live View ───────────────────────────────────────────────────────── -->
  <div class="subsec-title">Live View</div>
  <video bind:this={liveVideoEl} autoplay muted playsinline class="live-video"></video>
  <div class="row">
    <button class="act-btn accent" onclick={fetchLive} disabled={liveLoading || !selectedMonitorPubkey}>
      {liveLoading ? 'Connecting…' : 'Connect Live'}
    </button>
    <button class="act-btn" onclick={disconnect} disabled={sessions.length === 0}>Disconnect</button>
    <button class="act-btn" onclick={fetchSources} disabled={fetchingSourceList || !selectedMonitorPubkey}
      title="Query the monitor for its available source IDs">
      {fetchingSourceList ? '…' : 'Sources ↓'}
    </button>
    <select class="source-select" bind:value={liveSourceId} title="Select a source to receive, or leave as 'All' for a composite of all sources">
      <option value="">All sources</option>
      {#each liveSourceOptions as srcId}
        <option value={srcId}>{srcId}</option>
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

  <!-- ── Recorded Viewer ──────────────────────────────────────────────────── -->
  <div class="subsec-title" style="margin-top:10px">Recorded Viewer</div>

  <div class="viewer-box">
    {#if viewerError}
      <div class="viewer-empty viewer-err">{viewerError}</div>
    {:else if currentSeg}
      {#if currentSeg.mimeType.startsWith('image/')}
        <img bind:this={viewerImgEl} alt="Snapshot" class="viewer-media"
          onerror={() => { viewerError = '✗ Could not load image — segment may have been deleted from storage'; }} />
      {:else}
        <video bind:this={viewerVideoEl} controls onended={handleVideoEnded} class="viewer-media"
          onerror={() => { viewerError = '✗ Could not load video — segment may have been deleted from storage'; }}></video>
      {/if}
    {:else}
      <div class="viewer-empty">No segment loaded — fetch segments below and click Show</div>
    {/if}
  </div>

  <!-- Playback controls -->
  <div class="playback-bar">
    <button class="nav-btn" onclick={prevSeg} disabled={currentIdx <= 0}>←</button>
    <span class="seg-counter">
      {#if fetchedSegs.length > 0}
        {currentIdx + 1} / {fetchedSegs.length}
        {#if currentSeg}
          · {fmtTs(currentSeg.startTime)}–{fmtTs(currentSeg.endTime)}
          · {currentSeg.mimeType.startsWith('image/') ? 'photo' : 'video'}
        {/if}
      {:else}
        No segments
      {/if}
    </span>
    <button class="nav-btn" onclick={nextSeg} disabled={currentIdx >= fetchedSegs.length - 1}>→</button>
    <span class="sep"></span>
    <label class="toggle-label">
      <input type="checkbox" bind:checked={autoPlayNext} />
      AutoPlay
    </label>
    {#if autoPlayCountdown > 0}
      <span class="countdown">⏱ {autoPlayCountdown}s</span>
    {/if}
    {#if fetchedSegs.length > 0}
      <button class="act-btn small-danger" onclick={clearSegments}>Clear</button>
    {/if}
  </div>

  <!-- ── Time Range + Coverage + Fetch ────────────────────────────────────── -->
  <div class="subsec-title" style="margin-top:10px">Time Range</div>
  <div class="range-row">
    <input type="date" class="date-input" bind:value={rangeDate} onchange={applyDate} />
    <span class="muted-sep">or manually:</span>
    <input class="ts-input" bind:value={rangeTs} placeholder="unix or start-end" style="width:200px" />
  </div>
  <!-- Coverage row -->
  <div class="row" style="margin-top:4px">
    <button class="act-btn accent" onclick={requestRemoteCoverage} disabled={remoteCoverageLoading || !selectedMonitorPubkey} title="Request coverage map from monitor via WebRTC">
      {remoteCoverageLoading ? 'Requesting…' : 'Remote Coverage'}
    </button>
    <button class="act-btn" onclick={loadLocalCoverage} disabled={localCoverageLoading} title="Read coverage from locally saved segments in IDB">
      {localCoverageLoading ? 'Reading…' : 'Local Coverage'}
    </button>
    <button class="act-btn accent-soft" onclick={fetchBothCoverage} disabled={bothCoverageLoading || !selectedMonitorPubkey} title="Fetch remote coverage and read local coverage simultaneously">
      {bothCoverageLoading ? 'Loading…' : 'Local + Remote'}
    </button>
    {#if remoteCoverageStatus}
      <span class="status" class:ok={remoteCoverageStatus.startsWith('✓')} class:err={remoteCoverageStatus.startsWith('✗')}>{remoteCoverageStatus}</span>
    {/if}
    {#if localCoverageStatus}
      <span class="status" class:ok={localCoverageStatus.startsWith('✓')} class:err={localCoverageStatus.startsWith('✗')}>{localCoverageStatus}</span>
    {/if}
  </div>

  {#if remoteCoverage !== null}
    <div class="cov-source-label">Remote</div>
    {#if remoteCoverage.length === 0}
      <div class="empty">Monitor has no stored footage</div>
    {:else}
      <div class="coverage-list">
        {#each remoteCoverage as [start, end] (start)}
          <div class="cov-row">
            <span class="cov-range">{fmtTs(start)} — {fmtTs(end)}</span>
            <span class="cov-dur">{fmtDur(end - start)}</span>
            <button class="ts-chip" onclick={() => copyText(`${start}-${end}`)} title="Copy start-end unix">{start}-{end}</button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if localCoverage !== null}
    <div class="cov-source-label">Local</div>
    {#if localCoverage.length === 0}
      <div class="empty">Nothing stored locally for this device</div>
    {:else}
      <div class="coverage-list">
        {#each localCoverage as [start, end] (start)}
          <div class="cov-row">
            <span class="cov-range">{fmtTs(start)} — {fmtTs(end)}</span>
            <span class="cov-dur">{fmtDur(end - start)}</span>
            <button class="ts-chip" onclick={() => copyText(`${start}-${end}`)} title="Copy start-end unix">{start}-{end}</button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Type filter + fetch row -->
  <div class="row" style="margin-top:4px; gap:4px;">
    <span class="muted-sep">Types:</span>
    {#each (['video/', 'audio/', 'image/'] as MimePrefix[]) as prefix}
      <button
        class="type-filter-btn"
        class:active={fetchTypeFilter.has(prefix)}
        onclick={() => toggleFetchType(prefix)}
        title="Toggle {TYPE_LABELS[prefix]} fetch"
      >{TYPE_LABELS[prefix]}</button>
    {/each}
    <span class="muted-sep" style="margin-left:4px">|</span>
    <button class="act-btn accent" onclick={fetchSegmentsInRange} disabled={fetchLoading || !selectedMonitorPubkey} title="Fetch all segments in range via WebRTC">
      {fetchLoading ? 'Fetching…' : 'Fetch WebRTC'}
    </button>
    <button class="act-btn" onclick={fetchSegmentsLocal} disabled={fetchLoading} title="Load segments already saved in local IDB">
      Fetch Local
    </button>
    <button class="act-btn accent-soft" onclick={fetchSegmentsSmart} disabled={fetchLoading} title="Use local IDB first, then fill gaps via WebRTC">
      Smart Fetch
    </button>
    {#if fetchStatus}
      <span class="status" class:ok={fetchStatus.startsWith('✓')} class:err={fetchStatus.startsWith('✗')}>{fetchStatus}</span>
    {/if}
  </div>

  <!-- ── Fetched Segments Table ─────────────────────────────────────────── -->
  {#if fetchedSegs.length > 0}
    <div class="subsec-title-row" style="margin-top:8px">
      <span class="subsec-title" style="margin-top:0">Fetched Segments ({fetchedSegs.length})</span>
      <button class="raw-toggle" class:active={showRaw} onclick={() => showRaw = !showRaw}>Raw</button>
      <button class="act-btn small-danger" onclick={clearSegments}>Clear All</button>
    </div>
    <div class="seg-table">
      <div class="seg-th">
        <span>#</span><span>Src</span><span>Type</span><span>Start</span><span>End</span><span>Dur</span><span>Timestamps</span><span></span><span></span><span></span>
      </div>
      {#each fetchedSegs as seg, i (seg.key)}
        <div class="seg-tr" class:active={i === currentIdx}>
          <span class="seg-num">{i + 1}</span>
          <span class="src-badge" class:rtc={seg.source === 'rtc'} class:idb={seg.source === 'idb'}>{seg.source}</span>
          <span class="type-badge" class:is-video={seg.mimeType.startsWith('video/')} class:is-img={seg.mimeType.startsWith('image/')}>
            {seg.mimeType.startsWith('image/') ? 'photo' : 'video'}
          </span>
          <span class="seg-time">{fmtTs(seg.startTime)}</span>
          <span class="seg-time">{fmtTs(seg.endTime)}</span>
          <span class="seg-dur">{fmtDur(seg.endTime - seg.startTime)}</span>
          <span class="ts-chips">
            <button class="ts-chip" onclick={() => copyText(`${seg.startTime}-${seg.endTime}`)} title="Copy start-end unix">{seg.startTime}-{seg.endTime}</button>
            {#if seg.segmentId}
              <button class="ts-chip id-ts" onclick={() => copyText(seg.segmentId!)} title="Copy segment ID">{seg.segmentId.slice(0, 8)}…</button>
            {/if}
          </span>
          <button class="show-btn" class:active-show={i === currentIdx} onclick={() => showSeg(i)}>
            {i === currentIdx ? '▶ Showing' : 'Show'}
          </button>
          {#if seg.source === 'rtc'}
            {#if savedKeys.has(seg.key)}
              <span class="saved-badge">✓ Saved</span>
            {:else}
              <button class="save-btn" onclick={() => saveSeg(i)} disabled={savingKeys.has(seg.key) || !selectedMonitorPubkey}>
                {savingKeys.has(seg.key) ? '…' : 'Save'}
              </button>
            {/if}
          {:else}
            <span></span>
          {/if}
          <button class="remove-btn" onclick={() => removeSeg(i)} title="Remove from list">×</button>
        </div>
        {#if showRaw}
          <div class="seg-raw">
            <pre>{JSON.stringify(
              seg.source === 'rtc'
                ? { key: seg.key, source: seg.source, mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, monitorSegmentId: seg.segmentId ?? null, sizeBytes: seg.blob.size }
                : { key: seg.key, source: seg.source, mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, segmentId: seg.segmentId ?? null, backupOf: seg.backupOf ?? null, sizeBytes: seg.blob.size }
            , null, 2)}</pre>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- ── Fetch by ID ─────────────────────────────────────────────────────── -->
  <div class="subsec-title" style="margin-top:8px">Fetch by Segment / Alert ID</div>
  <div class="row">
    <input class="id-input" bind:value={segIdInput} placeholder="Segment ID or alert refId" type="text" />
    <button class="act-btn accent" onclick={fetchByIdRtc} disabled={segIdLoading || !selectedMonitorPubkey}>
      {segIdLoading ? '…' : 'WebRTC'}
    </button>
    <button class="act-btn" onclick={fetchByIdIdb} disabled={segIdLoading}>
      {segIdLoading ? '…' : 'Local IDB'}
    </button>
  </div>
  {#if segIdStatus}
    <span class="status" class:ok={segIdStatus.startsWith('✓')} class:err={segIdStatus.startsWith('✗')}>{segIdStatus}</span>
  {/if}

  <LogPanel sources={['rtc', 'idb']} />
</DevSection>

<style>
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 4px; }
  .subsec-title-row { display: flex; align-items: center; gap: 8px; }
  .raw-toggle { font-size: 9px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: ui-monospace, monospace; }
  .raw-toggle:hover { color: var(--color-text); }
  .raw-toggle.active { background: rgba(139,92,246,0.15); color: var(--color-accent); border-color: var(--color-accent); }
  .seg-raw { background: var(--color-surface); border-top: 1px solid var(--color-border); padding: 4px 8px; }
  .seg-raw pre { margin: 0; font-size: 9px; font-family: ui-monospace, monospace; color: var(--color-muted); white-space: pre-wrap; word-break: break-all; line-height: 1.4; }

  /* Live */
  .live-video { width: 100%; border-radius: 6px; background: #000; max-height: 180px; display: block; }
  .sess-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .sess-badge { font-size: 9px; padding: 2px 6px; border-radius: 4px; background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border); font-family: ui-monospace, monospace; }

  /* Recorded viewer */
  .viewer-box { width: 100%; background: #000; border-radius: 6px; min-height: 120px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-top: 4px; }
  .viewer-media { width: 100%; max-height: 240px; border-radius: 6px; display: block; object-fit: contain; }
  .viewer-empty { font-size: 10px; color: var(--color-muted); text-align: center; padding: 16px; }
  .viewer-err { color: var(--color-danger); }

  .playback-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .nav-btn { font-size: 14px; padding: 2px 10px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); cursor: pointer; }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-btn:hover:not(:disabled) { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .seg-counter { font-size: 10px; color: var(--color-muted); font-family: ui-monospace, monospace; flex: 1; }
  .sep { flex: 1; }
  .toggle-label { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-muted); cursor: pointer; }
  .toggle-label input { cursor: pointer; }
  .countdown { font-size: 11px; color: var(--color-warning); font-family: ui-monospace, monospace; }
  .act-btn.small-danger { font-size: 9px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--color-danger); background: none; color: var(--color-danger); cursor: pointer; }
  .act-btn.small-danger:hover { background: var(--color-danger); color: white; }

  /* Time range */
  .range-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .date-input { font-size: 11px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: inherit; }
  .ts-input { font-size: 11px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: ui-monospace, monospace; width: 130px; }
  .muted-sep { font-size: 10px; color: var(--color-muted); }
  .type-filter-btn { font-size: 9px; padding: 2px 7px; border-radius: 10px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; transition: none; }
  .type-filter-btn:hover { color: var(--color-text); border-color: var(--color-text); }
  .type-filter-btn.active { background: rgba(139,92,246,0.15); color: var(--color-accent); border-color: var(--color-accent); font-weight: 600; }

  /* Coverage */
  .cov-source-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 6px; margin-bottom: 2px; }
  .coverage-list { display: flex; flex-direction: column; gap: 2px; }
  .cov-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; background: var(--color-surface); font-size: 11px; }
  .cov-range { font-family: ui-monospace, monospace; color: var(--color-text); }
  .cov-dur { color: var(--color-muted); font-size: 10px; flex: 1; }

  /* Segment table */
  .seg-table { display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--color-border); border-radius: 5px; overflow: hidden; }
  .seg-th { display: grid; grid-template-columns: 24px 36px 44px 1fr 1fr 36px 1fr 56px 46px 18px; gap: 4px; padding: 3px 8px; background: var(--color-surface); font-size: 9px; color: var(--color-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .seg-tr { display: grid; grid-template-columns: 24px 36px 44px 1fr 1fr 36px 1fr 56px 46px 18px; gap: 4px; padding: 3px 8px; align-items: center; font-size: 10px; background: var(--color-bg); border-top: 1px solid var(--color-border); }
  .seg-tr.active { background: rgba(139,92,246,0.08); }
  .seg-num { color: var(--color-muted); font-family: ui-monospace, monospace; }
  .src-badge { font-size: 8px; padding: 1px 4px; border-radius: 3px; text-align: center; font-weight: 700; }
  .src-badge.rtc { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .src-badge.idb { background: rgba(34,197,94,0.12); color: var(--color-success); }
  .type-badge { font-size: 8px; padding: 1px 4px; border-radius: 3px; text-align: center; }
  .type-badge.is-video { background: rgba(139,92,246,0.15); color: #a78bfa; }
  .type-badge.is-img { background: rgba(251,146,60,0.15); color: #fb923c; }
  .seg-time { font-family: ui-monospace, monospace; color: var(--color-text); font-size: 10px; }
  .seg-dur { color: var(--color-muted); }
  .ts-chips { display: flex; gap: 3px; flex-wrap: wrap; }
  .show-btn { font-size: 9px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .show-btn:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .show-btn.active-show { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .save-btn { font-size: 9px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .save-btn:hover:not(:disabled) { background: var(--color-success); color: white; border-color: var(--color-success); }
  .save-btn:disabled { opacity: 0.4; cursor: default; }
  .saved-badge { font-size: 9px; color: var(--color-success); white-space: nowrap; }
  .remove-btn { font-size: 11px; line-height: 1; padding: 1px 3px; border-radius: 3px; border: 1px solid transparent; background: none; color: var(--color-muted); cursor: pointer; }
  .remove-btn:hover { background: var(--color-danger); color: white; border-color: var(--color-danger); }

  /* Fetch by ID */
  .id-input { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: ui-monospace, monospace; flex: 1; min-width: 0; }

  /* Shared */
  .ts-chip { font-family: ui-monospace, monospace; font-size: 9px; padding: 1px 4px; border-radius: 3px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .ts-chip:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .ts-chip.id-ts { color: var(--color-accent); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.accent-soft { background: rgba(139,92,246,0.15); color: var(--color-accent); border-color: var(--color-accent); }
  .act-btn.accent-soft:hover:not(:disabled) { background: var(--color-accent); color: white; }
  .status { font-size: 10px; }
  .status.ok { color: var(--color-success); }
  .status.err { color: var(--color-danger); }
  .source-select { font-size: 10px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: ui-monospace, monospace; max-width: 160px; }
  .empty { font-size: 11px; color: var(--color-muted); padding: 4px 0; }
</style>
