<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import {
    getCoverageMap, getSegmentsInRange, getStorageUsed, clearForMonitor
  } from '$lib/db/segments';
  import {
    getAllFootageRefs, getFootageRefsForDay, softDeleteFootageRef,
    getUnpublishedRefs, markRefPublished, clearFootageRefsForMonitor, type FootageRef
  } from '$lib/db/footage';
  import { subscribe } from '$lib/nostr/client';
  import { KIND_FOOTAGE_REF } from '$lib/nostr/events';
  import { enqueue } from '$lib/db/outbox';
  import { outboxFlusher } from '$lib/nostr/outbox';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = null }: Props = $props();

  // Storage stats
  let usedMb = $state(0);
  let totalSegments = $state(0);

  // Day explorer
  interface DayGroup { date: string; dayStart: number; dayEnd: number; refs?: FootageRef[]; open: boolean; loading: boolean; }
  let dayGroups = $state<DayGroup[]>([]);
  let explorerLoading = $state(false);

  // Segment query
  let fromTs = $state('');
  let toTs = $state('');
  let localCoverage = $state<[number, number][] | null>(null);
  let localSegIds = $state<string[]>([]);
  let localShowRaw = $state(false);
  let localFetchStatus = $state('');
  let syncStatus = $state('');
  let nostrCoverage = $state<{ refId: string }[]>([]);
  let nostrFetchStatus = $state('');
  let nostrSub: { close: () => void } | null = null;

  async function refreshStats() {
    const bytes = await getStorageUsed(selectedMonitorPubkey ?? undefined);
    usedMb = Math.round(bytes / (1024 * 1024) * 10) / 10;
    const { openDB } = await import('$lib/db/idb');
    const db = await openDB();
    const segs = await db.getAll('segments');
    totalSegments = segs.length;
  }

  async function loadDayExplorer() {
    explorerLoading = true;
    const refs = await getAllFootageRefs();
    const grouped = new Map<string, DayGroup>();
    for (const r of refs) {
      if (r.deleted) continue;
      if (selectedMonitorPubkey && r.originMonitor !== selectedMonitorPubkey) continue;
      const d = new Date(r.startTime * 1000);
      const key = d.toISOString().slice(0, 10);
      if (!grouped.has(key)) {
        const dayStart = new Date(key).getTime() / 1000;
        grouped.set(key, { date: key, dayStart, dayEnd: dayStart + 86400, open: false, loading: false });
      }
    }
    dayGroups = Array.from(grouped.values()).sort((a, b) => b.date.localeCompare(a.date));
    explorerLoading = false;
    await refreshStats();
  }

  async function toggleDay(group: DayGroup) {
    if (group.open) {
      group.open = false;
      dayGroups = [...dayGroups];
      return;
    }
    group.loading = true;
    dayGroups = [...dayGroups];
    group.refs = await getFootageRefsForDay(group.dayStart, group.dayEnd, selectedMonitorPubkey ?? undefined);
    group.open = true;
    group.loading = false;
    dayGroups = [...dayGroups];
  }

  async function removeRef(refId: string) {
    if (!confirm('Remove this footage reference?')) return;
    await softDeleteFootageRef(refId);
    await loadDayExplorer();
  }

  async function fetchLocalSegments() {
    const from = parseInt(fromTs);
    const to = parseInt(toTs) || Math.floor(Date.now() / 1000);
    if (isNaN(from)) { localFetchStatus = '✗ Invalid from timestamp'; return; }
    localFetchStatus = 'Fetching…';
    const segs = await getSegmentsInRange(from, to, selectedMonitorPubkey ?? undefined);
    localSegIds = segs.map(s => s.segmentId);
    localCoverage = await getCoverageMap(selectedMonitorPubkey ?? undefined);
    localFetchStatus = `✓ ${segs.length} segments`;
  }

  async function syncToNostr() {
    const unpublished = await getUnpublishedRefs();
    if (unpublished.length === 0) { syncStatus = 'All synced'; return; }
    // Enqueue all unpublished footage refs to the outbox for publishing
    // The outboxFlusher will pick them up and publish to Nostr
    await outboxFlusher.flush();
    syncStatus = `✓ Queued ${unpublished.length} refs`;
  }

  async function fetchNostrCoverage() {
    if (!$identity) { nostrFetchStatus = 'No identity'; return; }
    nostrSub?.close();
    nostrFetchStatus = 'Subscribing…';
    nostrCoverage = [];
    const target = selectedMonitorPubkey ?? $identity.pubkey;
    const received: { refId: string }[] = [];
    const { giftUnwrap } = await import('$lib/nostr/crypto');
    nostrSub = subscribe(
      { kinds: [KIND_FOOTAGE_REF], '#p': [$identity.pubkey] },
      async (event) => {
        try {
          const inner = giftUnwrap(event, $identity!.privkey);
          const payload = JSON.parse(inner.content);
          if (payload.refId && !received.find(r => r.refId === payload.refId)) {
            received.push({ refId: payload.refId });
            nostrCoverage = [...received];
          }
        } catch { /* not for us */ }
      }
    );
    nostrFetchStatus = `Listening… (${nostrCoverage.length} found)`;
    setTimeout(() => {
      nostrSub?.close();
      nostrFetchStatus = `✓ Done — ${nostrCoverage.length} refs`;
    }, 10_000);
  }

  async function clearDevice() {
    const targetPubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    if (!targetPubkey) return;
    const label = deviceLabel();
    if (!confirm(`Clear all segment storage for ${label}?`)) return;
    await clearForMonitor(targetPubkey);
    await clearFootageRefsForMonitor(targetPubkey);
    await loadDayExplorer();
  }

  async function copyId(id: string) {
    await navigator.clipboard.writeText(id);
  }

  $effect(() => {
    loadDayExplorer();
  });

  function deviceLabel() {
    if (!selectedMonitorPubkey) return 'own device';
    return $pairedDevices.find(d => d.pubkey === selectedMonitorPubkey)?.nickname ?? selectedMonitorPubkey.slice(0, 12) + '…';
  }
</script>

<DevSection title="Segment Storage">
  {#snippet actions()}
    <button class="act-btn" onclick={clearDevice}>Clear Device</button>
    <button class="act-btn" onclick={loadDayExplorer}>Refresh</button>
  {/snippet}

  <div class="stats-row">
    <span class="stat-item">Device: <b>{deviceLabel()}</b></span>
    <span class="stat-item">{usedMb} MB used</span>
    <span class="stat-item">{totalSegments} segments</span>
  </div>

  <!-- Local IDB Explorer -->
  <div class="subsec-title">Local IDB Explorer</div>
  {#if explorerLoading}
    <div class="empty">Loading…</div>
  {:else if dayGroups.length === 0}
    <div class="empty">No footage refs found</div>
  {:else}
    {#each dayGroups as group (group.date)}
      <div class="day-row">
        <button class="day-btn" onclick={() => toggleDay(group)}>
          <span class="caret">{group.open ? '▾' : '▸'}</span>
          <span>Day {group.date}</span>
          {#if group.loading}<span class="loading-dot">…</span>{/if}
        </button>
        {#if group.open && group.refs}
          <div class="ref-list">
            {#each group.refs as ref (ref.refId)}
              <div class="ref-row">
                <span class="ref-type-badge" class:video={ref.type === 'video'} class:photo={ref.type === 'photo'}>
                  {ref.type === 'video' ? '🎥' : '📸'}
                </span>
                <button class="id-chip" onclick={() => copyId(ref.refId)} title={ref.refId}>
                  {ref.refId.slice(0, 16)}…
                </button>
                <span class="ref-time">{new Date(ref.startTime * 1000).toLocaleTimeString()}</span>
                <button class="rm-btn" onclick={() => removeRef(ref.refId)}>✕</button>
              </div>
            {:else}
              <div class="empty small">No footage refs this day</div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  <!-- Segment time range -->
  <div class="subsec-title">Segments by Time Range</div>
  <div class="ts-inputs">
    <input class="ts-input" bind:value={fromTs} placeholder="From (unix)" type="number" />
    <input class="ts-input" bind:value={toTs} placeholder="To (unix, optional)" type="number" />
  </div>
  <div class="row">
    <button class="act-btn accent" onclick={fetchLocalSegments}>Fetch Local</button>
    {#if localFetchStatus}
      <span class="status" class:ok={localFetchStatus.startsWith('✓')} class:err={localFetchStatus.startsWith('✗')}>{localFetchStatus}</span>
    {/if}
  </div>

  {#if localCoverage !== null}
    <div class="coverage-block">
      <div class="coverage-header">
        <span class="subsec-title">Local Coverage</span>
        <button class="act-btn small" onclick={() => (localShowRaw = !localShowRaw)}>{localShowRaw ? 'Hide' : 'View'} Raw</button>
        <button class="act-btn small" onclick={syncToNostr}>Sync to Nostr</button>
        {#if syncStatus}<span class="status ok small">{syncStatus}</span>{/if}
      </div>
      {#if localShowRaw}
        <pre class="raw-small">{JSON.stringify(localCoverage, null, 2)}</pre>
      {:else}
        <div class="chip-list">
          {#each localSegIds as id (id)}
            <button class="id-chip" onclick={() => copyId(id)} title={id}>{id.slice(0, 10)}…</button>
          {:else}
            <span class="empty small">No segments in range</span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Nostr coverage -->
  <div class="row">
    <button class="act-btn" onclick={fetchNostrCoverage}>Fetch Nostr Coverage</button>
    {#if nostrFetchStatus}
      <span class="status small" class:ok={nostrFetchStatus.startsWith('✓')}>{nostrFetchStatus}</span>
    {/if}
  </div>
  {#if nostrCoverage.length > 0}
    <div class="chip-list">
      {#each nostrCoverage as r (r.refId)}
        <button class="id-chip" onclick={() => copyId(r.refId)} title={r.refId}>{r.refId.slice(0, 10)}…</button>
      {/each}
    </div>
  {/if}

  <LogPanel sources={['idb', 'nostr']} />
</DevSection>

<style>
  .stats-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-item { font-size: 11px; color: var(--color-muted); }
  .stat-item b { color: var(--color-text); }
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 4px; }
  .day-row { border: 1px solid var(--color-border); border-radius: 5px; overflow: hidden; }
  .day-btn { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; background: var(--color-surface); border: none; cursor: pointer; color: var(--color-text); font-size: 11px; font-family: inherit; text-align: left; }
  .day-btn:hover { background: rgba(255,255,255,0.04); }
  .caret { color: var(--color-muted); font-size: 9px; }
  .loading-dot { color: var(--color-muted); }
  .ref-list { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; background: var(--color-bg); }
  .ref-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11px; }
  .ref-type-badge { font-size: 13px; }
  .ref-time { color: var(--color-muted); font-size: 10px; margin-left: auto; }
  .rm-btn { font-size: 10px; padding: 0 4px; border: none; background: none; color: var(--color-muted); cursor: pointer; }
  .rm-btn:hover { color: var(--color-danger); }
  .ts-inputs { display: flex; gap: 6px; }
  .ts-input { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: inherit; flex: 1; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover { color: var(--color-text); }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.small { font-size: 9px; padding: 1px 5px; }
  .status { font-size: 11px; }
  .status.ok { color: var(--color-success); }
  .status.err { color: var(--color-danger); }
  .status.small { font-size: 10px; }
  .coverage-block { display: flex; flex-direction: column; gap: 4px; }
  .coverage-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .id-chip { font-family: ui-monospace, monospace; font-size: 10px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-accent); cursor: pointer; }
  .id-chip:hover { background: var(--color-accent); color: white; }
  .raw-small { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 8px; border-radius: 4px; overflow: auto; max-height: 200px; color: #a3e635; }
  .empty { font-size: 11px; color: var(--color-muted); text-align: center; padding: 8px 0; }
  .empty.small { font-size: 10px; padding: 4px 0; text-align: left; }
</style>
