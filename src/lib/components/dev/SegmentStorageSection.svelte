<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import {
    getCoverageMap, getSegmentsInRange, getStorageUsed, clearForMonitor,
    cleanupOrphanedOpfsFiles, deleteSegment, pinSegment, unpinSegment,
    expirePinnedSegments, thinSegments, evictUnpinned, type Segment
  } from '$lib/db/segments';
  import { storageCleanup, loadStorageCleanup } from '$lib/store/pipeline';
  import { onMount } from 'svelte';
  import {
    getAllFootageRefs, softDeleteFootageRef,
    clearFootageRefsForMonitor, receiveFootageRef
  } from '$lib/db/footage';
  import { subscribe, getRelays } from '$lib/nostr/client';
  import { KIND_FOOTAGE_REF, buildFootageDigestEvent } from '$lib/nostr/events';
  import { dbg } from '$lib/store/debug';
  import { enqueue } from '$lib/db/outbox';
  import { outboxFlusher } from '$lib/nostr/outbox';
  import { compactDatabase } from '$lib/db/idb';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = null }: Props = $props();

  // Resolves which device's data to display.
  // null prop = "own device" → fall back to identity pubkey so queries are
  // always scoped to exactly one device, never unfiltered across all devices.
  const effectivePubkey = $derived(selectedMonitorPubkey ?? $identity?.pubkey ?? null);

  // ── Stats ─────────────────────────────────────────────────────────────────
  let usedMb = $state(0);
  let totalSegments = $state(0);
  let quotaUsedMb = $state<number | null>(null);
  let quotaTotalMb = $state<number | null>(null);

  async function refreshStats() {
    const bytes = await getStorageUsed(effectivePubkey ?? undefined);
    usedMb = Math.round(bytes / (1024 * 1024) * 10) / 10;
    const { openDB } = await import('$lib/db/idb');
    const db = await openDB();
    const segs = await db.getAll('segments');
    totalSegments = segs.length;
    try {
      const est = await navigator.storage?.estimate();
      if (est) {
        quotaUsedMb = Math.round((est.usage ?? 0) / (1024 * 1024) * 10) / 10;
        quotaTotalMb = Math.round((est.quota ?? 0) / (1024 * 1024));
      }
    } catch { /* unavailable in some contexts */ }
  }

  // ── Segments explorer ─────────────────────────────────────────────────────
  interface SegGroup { date: string; segments: Segment[]; open: boolean; }
  let segGroups = $state<SegGroup[]>([]);
  let segLoading = $state(false);
  let segRangeTs = $state('');
  let segDate = $state('');

  function applyDateToRange(date: string): string {
    if (!date) return '';
    const from = Math.floor(new Date(date + 'T00:00:00').getTime() / 1000);
    const to   = Math.floor(new Date(date + 'T23:59:59').getTime() / 1000);
    return `${from}-${to}`;
  }

  // Parse "startTime-endTime" or single "timestamp" into [from, to].
  function parseRange(input: string): [number, number] {
    const t = input.trim();
    const dash = t.lastIndexOf('-');
    if (dash > 0) {
      const f = parseInt(t.slice(0, dash));
      const e = parseInt(t.slice(dash + 1));
      if (!isNaN(f) && !isNaN(e)) return [f, e];
    }
    const ts = parseInt(t);
    if (!isNaN(ts)) return [ts, ts];
    return [0, Math.floor(Date.now() / 1000) + 86400];
  }

  async function loadSegments() {
    segLoading = true;
    const expired = await expirePinnedSegments();
    if (expired > 0) dbg('info', 'idb', `expired ${expired} pinned segment(s)`);
    const [from, to] = parseRange(segRangeTs);
    const segs = await getSegmentsInRange(from, to, effectivePubkey ?? undefined);
    const map = new Map<string, Segment[]>();
    for (const s of segs) {
      const d = new Date(s.startTime * 1000).toISOString().slice(0, 10);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(s);
    }
    segGroups = Array.from(map.entries())
      .map(([date, segs]) => ({ date, segments: segs.sort((a, b) => a.startTime - b.startTime), open: false }))
      .sort((a, b) => b.date.localeCompare(a.date));
    segLoading = false;
    await refreshStats();
  }

  function fmtTime(unix: number) {
    return new Date(unix * 1000).toLocaleTimeString();
  }
  function fmtDuration(s: number) {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), sec = s % 60;
    return sec ? `${m}m ${sec}s` : `${m}m`;
  }
  function fmtSize(bytes: number) {
    return bytes >= 1_048_576
      ? (bytes / 1_048_576).toFixed(1) + ' MB'
      : Math.round(bytes / 1024) + ' kB';
  }

  async function removeSeg(segmentId: string) {
    if (!confirm('Delete this segment? The video data will be permanently removed.')) return;
    await deleteSegment(segmentId);
    await loadSegments();
  }

  async function togglePin(seg: Segment) {
    if (seg.pinned) {
      await unpinSegment(seg.segmentId);
    } else {
      await pinSegment(seg.segmentId);
    }
    // Update local state without a full reload
    segGroups = segGroups.map(g => ({
      ...g,
      segments: g.segments.map(s =>
        s.segmentId === seg.segmentId ? { ...s, pinned: !s.pinned } : s
      )
    }));
  }

  // ── Alerts (unified IDB + Nostr) ─────────────────────────────────────────
  interface FetchedAlert {
    key: string;             // == refId
    source: 'nostr' | 'idb' | 'both';
    refId: string;
    triggerType: string;
    startTime: number;
    endTime: number;
    triggerTime: number;
    originMonitor: string;
    channelId: string;
    publishedAt: number | null; // from IDB record; null for nostr-only
  }

  let fetchedAlerts = $state<FetchedAlert[]>([]);
  let alertsStatus = $state('');
  let alertsLoading = $state(false);
  let alertsRangeTs = $state('');
  let alertsDate = $state('');
  let nostrSub: { close: () => void } | null = null;
  let coverageRaw = $state<[number, number][] | null>(null);
  let showCoverage = $state(false);
  let rawSegIds = $state(new Set<string>());
  let rawAlertIds = $state(new Set<string>());
  let sendingKeys = $state(new Set<string>());
  let savingKeys  = $state(new Set<string>());

  function toggleRawSeg(id: string) {
    const s = new Set(rawSegIds);
    if (s.has(id)) s.delete(id); else s.add(id);
    rawSegIds = s;
  }
  function toggleRawAlert(key: string) {
    const s = new Set(rawAlertIds);
    if (s.has(key)) s.delete(key); else s.add(key);
    rawAlertIds = s;
  }

  async function loadFootageRefs() {
    coverageRaw = await getCoverageMap(effectivePubkey ?? undefined);
  }

  async function loadAlertsIdb(): Promise<number> {
    const [from, to] = parseRange(alertsRangeTs);
    const refs = await getAllFootageRefs();
    const filtered = refs.filter(r =>
      !r.deleted &&
      (effectivePubkey == null || r.originMonitor === effectivePubkey) &&
      r.startTime <= to && r.endTime >= from
    ).sort((a, b) => b.startTime - a.startTime);

    let added = 0;
    const next = [...fetchedAlerts];
    const keyToIdx = new Map(next.map((a, i) => [a.key, i]));
    for (const ref of filtered) {
      const idx = keyToIdx.get(ref.refId);
      if (idx !== undefined) {
        if (next[idx].source === 'nostr') { next[idx] = { ...next[idx], source: 'both', publishedAt: ref.publishedAt }; }
      } else {
        next.push({ key: ref.refId, source: 'idb', refId: ref.refId, triggerType: ref.triggerType, startTime: ref.startTime, endTime: ref.endTime, triggerTime: ref.triggerTime, originMonitor: ref.originMonitor, channelId: ref.channelId ?? 'default-channel', publishedAt: ref.publishedAt });
        added++;
      }
    }
    fetchedAlerts = next.sort((a, b) => b.startTime - a.startTime);
    return added;
  }

  async function fetchAlertsNostr(): Promise<void> {
    if (!$identity) { alertsStatus = 'No identity'; return; }
    nostrSub?.close();
    alertsLoading = true;
    alertsStatus = 'Listening…';
    const { decrypt } = await import('$lib/nostr/crypto');
    const myPubkey = $identity.pubkey;
    // '#p' tells the relay to only return events addressed to this viewer (tag filter).
    // Without it the relay returns all kind:5020 events regardless of recipient.
    const filter: import('nostr-tools').Filter = { kinds: [KIND_FOOTAGE_REF], '#p': [myPubkey] };
    if (selectedMonitorPubkey) {
      filter.authors = [selectedMonitorPubkey];
    } else if ($pairedDevices.length > 0) {
      filter.authors = $pairedDevices.map(d => d.pubkey);
    }
    dbg('info', 'nostr', `fetching alerts — me:${myPubkey.slice(0, 8)} from:${selectedMonitorPubkey?.slice(0, 8) ?? 'paired'}`);

    const thisSub = subscribe(
      filter,
      async (event) => {
        if (!event.tags.some(t => t[0] === 'p' && t[1] === myPubkey)) return;
        try {
          const plaintext = decrypt($identity!.privkey, event.pubkey, event.content);
          const payload = JSON.parse(plaintext);
          type IncomingRef = { refId: string; triggerType: string; startTime: number; endTime: number; triggerTime: number };
          const incoming: IncomingRef[] = payload.type === 'digest'
            ? (payload.refs as IncomingRef[])
            : (payload.refId ? [{ refId: payload.refId, triggerType: payload.triggerType ?? 'unknown', startTime: payload.startTime ?? 0, endTime: payload.endTime ?? 0, triggerTime: payload.triggerTime ?? 0 }] : []);
          for (const r of incoming) {
            fetchedAlerts = (() => {
              const next = [...fetchedAlerts];
              const idx = next.findIndex(a => a.key === r.refId);
              if (idx >= 0) {
                if (next[idx].source === 'idb') next[idx] = { ...next[idx], source: 'both' };
              } else {
                next.push({ key: r.refId, source: 'nostr', refId: r.refId, triggerType: r.triggerType, startTime: r.startTime, endTime: r.endTime, triggerTime: r.triggerTime, originMonitor: payload.originMonitor ?? event.pubkey, channelId: (payload.channelId ?? event.tags.find((t: string[]) => t[0] === 's')?.[1] ?? 'default-channel') as string, publishedAt: null });
              }
              return next.sort((a, b) => b.startTime - a.startTime);
            })();
          }
          alertsStatus = `Listening… (${fetchedAlerts.filter(a => a.source !== 'idb').length} from Nostr)`;
        } catch (e) {
          dbg('warn', 'nostr', `alert decrypt failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      () => dbg('info', 'nostr', 'alerts EOSE')
    );
    nostrSub = thisSub;
    return new Promise((resolve) => {
      setTimeout(() => {
        thisSub.close();
        if (nostrSub === thisSub) {
          alertsLoading = false;
          alertsStatus = `✓ Done — ${fetchedAlerts.length} alert${fetchedAlerts.length !== 1 ? 's' : ''}`;
        }
        resolve();
      }, 10_000);
    });
  }

  async function fetchAlertsSmartNostr() {
    alertsLoading = true;
    alertsStatus = 'Loading IDB…';
    const added = await loadAlertsIdb();
    alertsStatus = `${added} from IDB — fetching Nostr…`;
    await fetchAlertsNostr();
  }

  async function saveAlert(key: string) {
    const a = fetchedAlerts.find(x => x.key === key);
    if (!a || a.source !== 'nostr') return;
    savingKeys = new Set([...savingKeys, key]);
    try {
      await receiveFootageRef(a.refId, { originMonitor: a.originMonitor, triggerType: a.triggerType, channelId: a.channelId, startTime: a.startTime, endTime: a.endTime, triggerTime: a.triggerTime }, a.refId);
      fetchedAlerts = fetchedAlerts.map(x => x.key === key ? { ...x, source: 'both', publishedAt: Date.now() } : x);
      dbg('info', 'idb', `alert saved: ${key.slice(0, 8)}`);
    } finally {
      savingKeys = new Set([...savingKeys].filter(k => k !== key));
    }
  }

  async function sendAlert(key: string) {
    const a = fetchedAlerts.find(x => x.key === key);
    if (!a || a.source === 'nostr' || !$identity || $pairedDevices.length === 0) return;
    sendingKeys = new Set([...sendingKeys, key]);
    try {
      const relays = getRelays();
      const digestRefs = [{ refId: a.refId, triggerType: a.triggerType, startTime: a.startTime, endTime: a.endTime, triggerTime: a.triggerTime }];
      for (const device of $pairedDevices) {
        const ev = buildFootageDigestEvent($identity.privkey, $identity.pubkey, device.pubkey, digestRefs);
        await enqueue(ev, relays);
      }
      await outboxFlusher.flush();
      fetchedAlerts = fetchedAlerts.map(x => x.key === key ? { ...x, publishedAt: Date.now() } : x);
      dbg('info', 'nostr', `alert sent: ${key.slice(0, 8)}`);
    } finally {
      sendingKeys = new Set([...sendingKeys].filter(k => k !== key));
    }
  }

  function clearAlert(key: string) {
    const a = fetchedAlerts.find(x => x.key === key);
    if (!a) return;
    if (a.source === 'both') fetchedAlerts = fetchedAlerts.map(x => x.key === key ? { ...x, source: 'idb' } : x);
    else fetchedAlerts = fetchedAlerts.filter(x => x.key !== key);
  }

  async function removeAlertIdb(key: string) {
    if (!confirm('Remove this alert from local storage?')) return;
    await softDeleteFootageRef(key);
    const a = fetchedAlerts.find(x => x.key === key);
    if (a?.source === 'both') fetchedAlerts = fetchedAlerts.map(x => x.key === key ? { ...x, source: 'nostr', publishedAt: null } : x);
    else fetchedAlerts = fetchedAlerts.filter(x => x.key !== key);
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  async function clearDevice() {
    const targetPubkey = effectivePubkey;
    if (!targetPubkey) return;
    if (!confirm(`Clear all storage for ${deviceLabel()}?`)) return;
    await clearForMonitor(targetPubkey);
    await clearFootageRefsForMonitor(targetPubkey);
    await cleanupOrphanedOpfsFiles();
    await loadAll();
  }

  let cleanupRunning = $state(false);
  async function runCleanup() {
    cleanupRunning = true;
    try {
      await loadStorageCleanup();
      const cfg = $storageCleanup;
      const expired = await expirePinnedSegments();
      if (expired > 0) dbg('info', 'idb', `expired ${expired} pinned segment(s)`);
      const thinned = await thinSegments(cfg.thinningRules, effectivePubkey ?? undefined);
      await evictUnpinned(effectivePubkey ?? undefined);
      dbg('info', 'idb', `cleanup done — thinned ${thinned}, expired ${expired}`);
      await loadAll();
    } finally {
      cleanupRunning = false;
    }
  }

  let compacting = $state(false);
  async function runCompact() {
    if (!confirm(
      'Compact database?\n\nPreserves identity, settings, paired devices, footage refs, segment metadata, and outbox. ' +
      'Drops legacy event data. The page will reload when done.'
    )) return;
    compacting = true;
    try { await compactDatabase(); location.reload(); }
    catch (e) { compacting = false; alert(`Compact failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  async function copyId(id: string) {
    await navigator.clipboard.writeText(id);
  }

  async function loadAll() {
    await loadSegments();
    await loadFootageRefs();
    fetchedAlerts = [];
    await loadAlertsIdb();
  }

  function deviceLabel() {
    if (!selectedMonitorPubkey) return 'own device';
    return $pairedDevices.find(d => d.pubkey === selectedMonitorPubkey)?.nickname
      ?? selectedMonitorPubkey.slice(0, 12) + '…';
  }

  onMount(async () => {
    const removed = await cleanupOrphanedOpfsFiles();
    if (removed > 0) console.info(`[segments] cleaned ${removed} orphaned OPFS file(s)`);
  });

  $effect(() => {
    const _trigger = effectivePubkey; // track derived so effect re-runs on device/identity change
    loadAll();
  });
</script>

<DevSection title="Storage">
  {#snippet actions()}
    <button class="act-btn" onclick={loadAll}>Refresh</button>
    <button class="act-btn" onclick={runCleanup} disabled={cleanupRunning}>
      {cleanupRunning ? 'Cleaning…' : 'Run Cleanup'}
    </button>
    <button class="act-btn" onclick={clearDevice}>Clear Device</button>
    <button class="act-btn danger" onclick={runCompact} disabled={compacting}>
      {compacting ? 'Compacting…' : 'Compact DB'}
    </button>
  {/snippet}

  <!-- Stats -->
  <div class="stats-row">
    <span class="stat-item">Device: <b>{deviceLabel()}</b></span>
    <span class="stat-item"
      class:quota-warn={$storageCleanup.quotaMb > 0 && usedMb / $storageCleanup.quotaMb > 0.8}>
      {usedMb} / {$storageCleanup.quotaMb} MB
    </span>
    <span class="stat-item">{totalSegments} segments</span>
    {#if quotaTotalMb !== null}
      <span class="stat-item quota" class:quota-warn={quotaUsedMb !== null && quotaTotalMb > 0 && (quotaUsedMb / quotaTotalMb) > 0.8}>
        OPFS {quotaUsedMb} / {quotaTotalMb} MB
      </span>
    {/if}
  </div>

  <!-- ── Segments ──────────────────────────────────────────────────────── -->
  <div class="subsec-header">
    <span class="subsec-title">Segments</span>
    <span class="subsec-hint">10-second video/audio chunks stored in OPFS</span>
  </div>

  <div class="filter-row">
    <input type="date" class="date-input" bind:value={segDate}
      onchange={() => { segRangeTs = applyDateToRange(segDate); }} />
    <input class="ts-input" bind:value={segRangeTs} placeholder="unix or start-end" />
    <button class="act-btn accent" onclick={loadSegments}>Filter</button>
    <button class="act-btn" onclick={() => { segRangeTs = ''; segDate = ''; loadSegments(); }}>All</button>
  </div>

  {#if segLoading}
    <div class="empty">Loading…</div>
  {:else if segGroups.length === 0}
    <div class="empty">No segments found</div>
  {:else}
    {#each segGroups as group (group.date)}
      <div class="day-row">
        <button class="day-btn" onclick={() => { group.open = !group.open; segGroups = [...segGroups]; }}>
          <span class="caret">{group.open ? '▾' : '▸'}</span>
          <span>{group.date}</span>
          <span class="day-count">{group.segments.length} segment{group.segments.length !== 1 ? 's' : ''}</span>
        </button>
        {#if group.open}
          <div class="seg-list">
            {#each group.segments as seg (seg.segmentId)}
              <div class="seg-card">
                <div class="seg-row">
                  <button class="id-chip" onclick={() => copyId(seg.segmentId)} title={seg.segmentId}>
                    {seg.segmentId.slice(0, 8)}…
                  </button>
                  <span class="type-badge"
                    class:is-photo={seg.mimeType.startsWith('image/')}
                    class:is-video={seg.mimeType.startsWith('video/')}
                    class:is-audio={seg.mimeType.startsWith('audio/')}
                  >{seg.mimeType.startsWith('image/') ? 'photo' : seg.mimeType.startsWith('video/') ? 'video' : seg.mimeType.startsWith('audio/') ? 'audio' : 'data'}</span>
                  <span class="seg-time">{fmtTime(seg.startTime)} – {fmtTime(seg.endTime)}</span>
                  <span class="seg-size">{fmtSize(seg.sizeBytes)}</span>
                  <button
                    class="pin-btn"
                    class:pinned={seg.pinned}
                    onclick={() => togglePin(seg)}
                    title={seg.pinned ? 'Unpin (allow eviction)' : 'Pin (prevent eviction)'}
                  >
                    {seg.pinned ? '📌 Pinned' : 'Pin'}
                  </button>
                  <button class="ts-chip" onclick={() => copyId(`${seg.startTime}-${seg.endTime}`)} title="Copy start-end unix">{seg.startTime}-{seg.endTime}</button>
                  <button class="act-btn small" onclick={() => toggleRawSeg(seg.segmentId)}>raw</button>
                  <button class="rm-btn" onclick={() => removeSeg(seg.segmentId)} title="Delete segment">✕</button>
                </div>
                {#if rawSegIds.has(seg.segmentId)}
                  <pre class="raw-small">{JSON.stringify({ segmentId: seg.segmentId, originMonitor: seg.originMonitor, startTime: seg.startTime, endTime: seg.endTime, mimeType: seg.mimeType, sizeBytes: seg.sizeBytes, pinned: seg.pinned, pinnedUntil: seg.pinnedUntil ?? null, backupOf: seg.backupOf ?? null }, null, 2)}</pre>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  <!-- ── Alerts ───────────────────────────────────────────────────────── -->
  <div class="subsec-header" style="margin-top:8px">
    <span class="subsec-title">Alerts ({fetchedAlerts.length})</span>
    <span class="subsec-hint">Trigger sessions — time windows with pinned segments, published via Nostr kind:5020</span>
    {#if fetchedAlerts.length > 0}
      <button class="act-btn small danger" onclick={() => fetchedAlerts = []}>Clear list</button>
    {/if}
  </div>

  <!-- Alert fetch controls + time filter -->
  <div class="filter-row" style="margin-top:4px">
    <input type="date" class="date-input" bind:value={alertsDate}
      onchange={() => { alertsRangeTs = applyDateToRange(alertsDate); }} />
    <input class="ts-input" bind:value={alertsRangeTs} placeholder="unix or start-end" />
  </div>
  <div class="row" style="margin-top:4px">
    <button class="act-btn accent" onclick={fetchAlertsNostr} disabled={alertsLoading} title="Pull kind:5020 events from relay">
      {alertsLoading ? 'Listening…' : 'Nostr'}
    </button>
    <button class="act-btn" onclick={async () => { fetchedAlerts = []; await loadAlertsIdb(); alertsStatus = `✓ ${fetchedAlerts.length} from IDB`; }} disabled={alertsLoading} title="Load alerts from local IDB">
      IDB
    </button>
    <button class="act-btn accent-soft" onclick={fetchAlertsSmartNostr} disabled={alertsLoading} title="Load IDB first, then fetch Nostr for gaps">
      Smart Fetch
    </button>
    <button class="act-btn" onclick={() => (showCoverage = !showCoverage)} title="Toggle coverage map">
      {showCoverage ? 'Hide Coverage' : 'Coverage'}
    </button>
    {#if alertsStatus}
      <span class="status" class:ok={alertsStatus.startsWith('✓')} class:err={alertsStatus.startsWith('✗')}>{alertsStatus}</span>
    {/if}
  </div>

  {#if showCoverage && coverageRaw !== null}
    <pre class="raw-small" style="margin-top:4px">{JSON.stringify(coverageRaw, null, 2)}</pre>
  {/if}

  <!-- Alert table -->
  {#if fetchedAlerts.length > 0}
    <div class="alert-table" style="margin-top:4px">
      {#each fetchedAlerts as alert (alert.key)}
        <div class="alert-row" class:nostr-row-bg={alert.source === 'nostr'} class:idb-row-bg={alert.source === 'idb'} class:both-row-bg={alert.source === 'both'}>
          <span class="src-badge"
            class:src-nostr={alert.source === 'nostr'}
            class:src-idb={alert.source === 'idb'}
            class:src-both={alert.source === 'both'}
          >{alert.source === 'both' ? 'N+IDB' : alert.source.toUpperCase()}</span>
          <span class="trigger-badge">{alert.triggerType}</span>
          <span class="alert-window">{fmtTime(alert.startTime)} – {fmtTime(alert.endTime)}</span>
          <span class="alert-dur">{fmtDuration(alert.endTime - alert.startTime)}</span>
          <span class="alert-trigger" title="Trigger fired at">⚡ {fmtTime(alert.triggerTime)}</span>
          {#if alert.source !== 'nostr'}
            <span class="pub-badge" class:published={alert.publishedAt !== null} class:unpublished={alert.publishedAt === null}>
              {alert.publishedAt !== null ? '✓ sent' : '○ unsent'}
            </span>
          {:else}
            <span></span>
          {/if}
          <button class="ts-chip" onclick={() => copyId(`${alert.startTime}-${alert.endTime}`)} title="Copy start-end unix">{alert.startTime}-{alert.endTime}</button>
          <button class="id-chip" onclick={() => copyId(alert.refId)} title={alert.refId}>{alert.refId.slice(0, 8)}…</button>
          <button class="act-btn small" onclick={() => toggleRawAlert(alert.key)}>raw</button>
          <!-- Source-specific actions -->
          {#if alert.source === 'nostr'}
            <button class="act-btn small accent" onclick={() => saveAlert(alert.key)} disabled={savingKeys.has(alert.key)}>
              {savingKeys.has(alert.key) ? '…' : 'Save'}
            </button>
            <button class="rm-btn" onclick={() => clearAlert(alert.key)} title="Remove from list">×</button>
          {:else if alert.source === 'idb'}
            <button class="act-btn small" onclick={() => sendAlert(alert.key)} disabled={sendingKeys.has(alert.key) || $pairedDevices.length === 0} title="Send to all paired devices via Nostr">
              {sendingKeys.has(alert.key) ? '…' : 'Send'}
            </button>
            <button class="rm-btn" onclick={() => removeAlertIdb(alert.key)} title="Delete from IDB">rm</button>
          {:else}
            <button class="act-btn small" onclick={() => sendAlert(alert.key)} disabled={sendingKeys.has(alert.key) || $pairedDevices.length === 0}>
              {sendingKeys.has(alert.key) ? '…' : 'Send'}
            </button>
            <button class="rm-btn" onclick={() => removeAlertIdb(alert.key)} title="Delete from IDB">rm</button>
            <button class="rm-btn" onclick={() => clearAlert(alert.key)} title="Remove from list">×</button>
          {/if}
        </div>
        {#if rawAlertIds.has(alert.key)}
          <div class="alert-raw">
            <pre>{JSON.stringify(alert, null, 2)}</pre>
          </div>
        {/if}
      {/each}
    </div>
  {:else if !alertsLoading}
    <div class="empty" style="margin-top:4px">No alerts loaded — use Nostr, IDB, or Smart Fetch above</div>
  {/if}

  <LogPanel sources={['idb', 'nostr']} />
</DevSection>

<style>
  .stats-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-item { font-size: 11px; color: var(--color-muted); }
  .stat-item b { color: var(--color-text); }
  .stat-item.quota-warn { color: var(--color-warning); }

  .subsec-header { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); }
  .subsec-hint { font-size: 10px; color: var(--color-border); }

  .filter-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .date-input { font-size: 11px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: inherit; }
  .ts-input { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: inherit; flex: 1; min-width: 0; }

  .day-row { border: 1px solid var(--color-border); border-radius: 5px; overflow: hidden; }
  .day-btn { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; background: var(--color-surface); border: none; cursor: pointer; color: var(--color-text); font-size: 11px; font-family: inherit; text-align: left; }
  .day-btn:hover { background: rgba(255,255,255,0.04); }
  .caret { color: var(--color-muted); font-size: 9px; }
  .day-count { color: var(--color-muted); font-size: 10px; margin-left: auto; }

  .seg-list { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; background: var(--color-bg); }
  .seg-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 11px; }
  .seg-time { color: var(--color-muted); font-size: 10px; font-family: ui-monospace, monospace; }
  .type-badge { font-size: 8px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; }
  .type-badge.is-photo { background: rgba(251,146,60,0.15); color: #fb923c; }
  .type-badge.is-video { background: rgba(139,92,246,0.15); color: #a78bfa; }
  .type-badge.is-audio { background: rgba(34,197,94,0.12); color: var(--color-success); }
  .type-badge:not(.is-photo):not(.is-video):not(.is-audio) { background: var(--color-surface); color: var(--color-muted); }
  .seg-size { color: var(--color-muted); font-size: 10px; margin-left: auto; }
  .pin-btn { font-size: 9px; padding: 1px 5px; border-radius: 3px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .pin-btn:hover { border-color: var(--color-accent); color: var(--color-accent); }
  .pin-btn.pinned { background: rgba(139,92,246,0.15); border-color: var(--color-accent); color: var(--color-accent); }

  .pub-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-left: auto; }
  .pub-badge.published { background: rgba(34,197,94,0.15); color: var(--color-success); }
  .pub-badge.unpublished { background: rgba(156,163,175,0.1); color: var(--color-muted); }

  .rm-btn { font-size: 10px; padding: 0 4px; border: none; background: none; color: var(--color-muted); cursor: pointer; }
  .rm-btn:hover { color: var(--color-danger); }

  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.danger { border-color: var(--color-danger); color: var(--color-danger); }
  .act-btn.danger:hover { background: var(--color-danger); color: white; }

  .status { font-size: 11px; }
  .status.ok { color: var(--color-success); }

  .id-chip { font-family: ui-monospace, monospace; font-size: 10px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-accent); cursor: pointer; }
  .id-chip:hover { background: var(--color-accent); color: white; }
  .raw-small { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 8px; border-radius: 4px; overflow: auto; max-height: 200px; color: #a3e635; }
  .empty { font-size: 11px; color: var(--color-muted); text-align: center; padding: 8px 0; }
  .seg-card { display: flex; flex-direction: column; gap: 2px; }
  .ts-chip { font-family: ui-monospace, monospace; font-size: 9px; padding: 1px 5px; border-radius: 3px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .ts-chip:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }

  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .act-btn.small { font-size: 9px; padding: 1px 5px; }
  .act-btn.accent-soft { background: rgba(139,92,246,0.15); color: #a78bfa; border-color: rgba(139,92,246,0.3); }
  .act-btn.accent-soft:hover:not(:disabled) { background: rgba(139,92,246,0.3); }

  .alert-table { display: flex; flex-direction: column; gap: 2px; }
  .alert-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding: 3px 6px; border-radius: 4px; font-size: 11px; border: 1px solid var(--color-border); }
  .nostr-row-bg { background: rgba(139,92,246,0.06); }
  .idb-row-bg { background: rgba(34,197,94,0.05); }
  .both-row-bg { background: rgba(251,191,36,0.06); }

  .src-badge { font-size: 8px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; }
  .src-nostr { background: rgba(139,92,246,0.2); color: #a78bfa; }
  .src-idb { background: rgba(34,197,94,0.15); color: var(--color-success); }
  .src-both { background: rgba(251,191,36,0.15); color: #fbbf24; }

  .trigger-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(156,163,175,0.1); color: var(--color-muted); text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }
  .alert-window { font-family: ui-monospace, monospace; font-size: 10px; color: var(--color-text); }
  .alert-dur { font-size: 10px; color: var(--color-muted); }
  .alert-trigger { font-family: ui-monospace, monospace; font-size: 10px; color: var(--color-muted); margin-left: auto; }
  .alert-raw { background: #09090b; border-radius: 4px; overflow: hidden; }
  .alert-raw pre { font-size: 10px; font-family: ui-monospace, monospace; padding: 8px; overflow: auto; max-height: 200px; color: #a3e635; margin: 0; }
</style>
