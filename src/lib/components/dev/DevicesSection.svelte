<script lang="ts">
  import { identity, pairedDevices, removePairedDevice } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import {
    getDistinctOriginMonitors, clearForMonitor, cleanupOrphanedOpfsFiles,
    type Segment
  } from '$lib/db/segments';
  import { getAllFootageRefs, clearFootageRefsForMonitor } from '$lib/db/footage';
  import { getViewerSessionInfos, connectToMonitor, cancelConnect, disconnectViewer } from '$lib/webrtc/viewer-peer';
  import { getMonitorSessionInfos } from '$lib/webrtc/monitor-peer';
  import { sendSignal } from '$lib/webrtc/signaling';
  import { peerStatuses } from '$lib/store/peer-status';
  import { nostrOnline, nostrOfflineReason, goOnline, goOffline } from '$lib/store/nostr-online';
  import { relayRateLimits, clearExpiredRateLimits } from '$lib/nostr/client';
  import { viewerConnection } from '$lib/store/viewer-connection';
  import { useNostrAction } from '$lib/nostr/use-nostr-action.svelte';
  import DevSection from './DevSection.svelte';
  import NostrQueuePanel from './NostrQueuePanel.svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
    fetchedCountByMonitor?: Record<string, number>;
    onClearFetchedForMonitor?: (pubkey: string) => void;
  }
  let {
    selectedMonitorPubkey = $bindable(null),
    fetchedCountByMonitor = {},
    onClearFetchedForMonitor,
  }: Props = $props();

  interface DevStats {
    storageBytes: number;
    segCount: number;
    alertCount: number;
  }

  let stats = $state<Record<string, DevStats>>({});
  let orphanedPubkeys = $state<string[]>([]);
  let loading = $state(false);
  const statusActions = new Map<string, ReturnType<typeof useNostrAction>>();
  function getStatusAction(pubkey: string) {
    if (!statusActions.has(pubkey)) statusActions.set(pubkey, useNostrAction());
    return statusActions.get(pubkey)!;
  }

  // ── RTC polling + rate-limit countdown ───────────────────────────────────
  let rtcTick = $state(0);
  const rtcInterval = setInterval(() => { rtcTick++; clearExpiredRateLimits(); }, 2000);
  onDestroy(() => clearInterval(rtcInterval));

  // Active rate-limits with seconds-remaining, refreshed on each tick.
  const activeRateLimits = $derived((() => {
    void rtcTick; // re-evaluate every tick
    const now = Date.now();
    return $relayRateLimits
      .filter(r => r.until > now)
      .map(r => ({ relay: r.relay, reason: r.reason, secsLeft: Math.ceil((r.until - now) / 1000) }));
  })());

  const viewerSessions = $derived(rtcTick >= 0 ? getViewerSessionInfos() : []);
  const monitorSessions = $derived(rtcTick >= 0 ? getMonitorSessionInfos() : []);

  function rtcFor(pubkey: string) {
    const viewing = viewerSessions.some(s => s.monitorPubkey === pubkey && s.iceState === 'connected');
    const watchedBy = monitorSessions.some(s => s.viewerPubkey === pubkey && s.iceState === 'connected');
    return { viewing, watchedBy };
  }

  function ownViewerCount() {
    return monitorSessions.filter(s => s.iceState === 'connected').length;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  async function loadAllStats() {
    loading = true;
    try {
      const { openDB } = await import('$lib/db/idb');
      const db = await openDB();
      const allSegs = await db.getAll('segments') as Segment[];
      const allRefs = await getAllFootageRefs();

      const segByMonitor = new Map<string, { bytes: number; count: number }>();
      for (const s of allSegs) {
        const e = segByMonitor.get(s.originMonitor) ?? { bytes: 0, count: 0 };
        e.bytes += s.sizeBytes; e.count++;
        segByMonitor.set(s.originMonitor, e);
      }
      const alertsByMonitor = new Map<string, number>();
      for (const r of allRefs) {
        if (r.deleted) continue;
        alertsByMonitor.set(r.originMonitor, (alertsByMonitor.get(r.originMonitor) ?? 0) + 1);
      }

      const ownPubkey = $identity?.pubkey;
      const pairedSet = new Set($pairedDevices.map(d => d.pubkey));
      const allMonitors = new Set([
        ...segByMonitor.keys(),
        ...allRefs.map(r => r.originMonitor),
      ]);
      orphanedPubkeys = [...allMonitors].filter(pk => !pairedSet.has(pk) && pk !== ownPubkey);

      const build = (pk: string): DevStats => ({
        storageBytes: segByMonitor.get(pk)?.bytes ?? 0,
        segCount: segByMonitor.get(pk)?.count ?? 0,
        alertCount: alertsByMonitor.get(pk) ?? 0,
      });

      const nextStats: Record<string, DevStats> = {};
      if (ownPubkey) nextStats[ownPubkey] = build(ownPubkey);
      for (const d of $pairedDevices) nextStats[d.pubkey] = build(d.pubkey);
      for (const pk of orphanedPubkeys) nextStats[pk] = build(pk);
      stats = nextStats;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void $pairedDevices;
    void $identity;
    loadAllStats();
  });

  // ── Unpair ────────────────────────────────────────────────────────────────
  async function unpair(pubkey: string) {
    const dev = $pairedDevices.find(d => d.pubkey === pubkey);
    const label = dev?.nickname ?? pubkey.slice(0, 12) + '…';
    if (!confirm(`Unpair "${label}"?`)) return;
    await removePairedDevice(pubkey);
    if (selectedMonitorPubkey === pubkey) selectedMonitorPubkey = null;
  }

  // ── Clear data ────────────────────────────────────────────────────────────
  async function clearData(pubkey: string) {
    const label = $pairedDevices.find(d => d.pubkey === pubkey)?.nickname
      ?? pubkey.slice(0, 12) + '…';
    const s = stats[pubkey];
    if (!confirm(
      `Clear all stored data for ${label}?\n\n${fmtBytes(s?.storageBytes ?? 0)} of segments and ${s?.alertCount ?? 0} alert(s) will be permanently deleted.`
    )) return;
    await clearForMonitor(pubkey);
    await clearFootageRefsForMonitor(pubkey);
    await cleanupOrphanedOpfsFiles();
    await loadAllStats();
    // Deselect if this was an orphaned device now fully cleared
    if (selectedMonitorPubkey === pubkey && !orphanedPubkeys.includes(pubkey) && !$pairedDevices.some(d => d.pubkey === pubkey)) {
      selectedMonitorPubkey = null;
    }
  }

  // ── Status request ───────────────────────────────────────────────────────
  async function requestStatus(pubkey: string) {
    if (!$identity) return;
    const action = getStatusAction(pubkey);
    await action.run(onQueued =>
      sendSignal($identity.privkey, $identity.pubkey, pubkey, {
        type: 'status-request', sessionId: crypto.randomUUID(),
      }, { onQueued })
    );
  }

  function fmtAge(updatedAt: number): string {
    const ageSec = Math.floor(Date.now() / 1000) - updatedAt;
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86400)}d ago`;
  }

  // ── Connection ───────────────────────────────────────────────────────────
  const vc = $derived($viewerConnection);

  async function handleConnect(pk: string) {
    if (!$identity) return;
    try { await connectToMonitor($identity.privkey, $identity.pubkey, pk); }
    catch { /* status='failed' written to store */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fmtBytes(b: number): string {
    if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' kB';
    return b === 0 ? '0 B' : b + ' B';
  }

  function statsLine(pk: string): string {
    const s = stats[pk];
    if (!s) return '…';
    const parts: string[] = [`${fmtBytes(s.storageBytes)}`];
    if (s.segCount > 0) parts.push(`${s.segCount} seg${s.segCount !== 1 ? 's' : ''}`);
    if (s.alertCount > 0) parts.push(`${s.alertCount} alert${s.alertCount !== 1 ? 's' : ''}`);
    return parts.join(' · ');
  }

  // Returns a reason string if unpair is blocked, or null if safe.
  function unpairBlockReason(pubkey: string): string | null {
    const rtc = rtcFor(pubkey);
    if (rtc.viewing || rtc.watchedBy) return 'Active RTC session — disconnect first';
    const s = stats[pubkey];
    if (s && s.storageBytes > 0) return `${fmtBytes(s.storageBytes)} stored — clear data first`;
    if (s && s.alertCount > 0) return `${s.alertCount} alert(s) stored — clear data first`;
    return null;
  }
</script>

<DevSection title="Devices">
  {#snippet actions()}
    <button class="act-btn" onclick={loadAllStats} disabled={loading}>
      {loading ? '…' : 'Refresh'}
    </button>
  {/snippet}

  <NostrQueuePanel />

  <div class="device-list">

    <!-- ── Own Device ──────────────────────────────────────────────────── -->
    {#if $identity}
      {@const ownPk = $identity.pubkey}
      {@const ownSelected = selectedMonitorPubkey === null}
      {@const viewers = ownViewerCount()}
      <div class="device-card" class:is-selected={ownSelected}>
        <div class="card-top">
          <span class="role-badge own">OWN</span>
          <span class="device-name">This device</span>
          {#if $nostrOnline}
            <span class="status-dot online" title="Online">●</span>
            <span class="status-age">online</span>
          {:else if $nostrOfflineReason}
            <span class="status-dot offline" title={$nostrOfflineReason}>⚠</span>
          {/if}
          <span class="stats-line">{statsLine(ownPk)}</span>
          {#if viewers > 0}
            <span class="rtc-pill active">{viewers} viewer{viewers !== 1 ? 's' : ''}</span>
          {/if}
        </div>
        <div class="card-bot">
          <button class="pk-chip" onclick={() => navigator.clipboard.writeText(ownPk)} title={ownPk}>
            {ownPk.slice(0, 12)}…
          </button>
          {#if $nostrOnline}
            <button class="act-btn online-pill" onclick={() => goOffline().catch(() => {})}>● Online</button>
          {:else}
            <button class="act-btn accent" onclick={() => goOnline().catch(() => {})}
              disabled={!$settings.relayUrl}>Go Online</button>
          {/if}
          {#each activeRateLimits as rl (rl.relay)}
            <span class="rl-badge" title={rl.reason}>⏱ {rl.relay} {rl.secsLeft}s</span>
          {/each}
          <span class="spacer"></span>
          {#if (fetchedCountByMonitor[ownPk] ?? 0) > 0}
            <button class="act-btn danger-soft" onclick={() => onClearFetchedForMonitor?.(ownPk)}
              title="Clear {fetchedCountByMonitor[ownPk]} in-memory fetched segment{fetchedCountByMonitor[ownPk] !== 1 ? 's' : ''} for this device">
              Clear Fetched ({fetchedCountByMonitor[ownPk]})
            </button>
          {/if}
          <button
            class="act-btn"
            class:accent={!ownSelected}
            class:selected-btn={ownSelected}
            onclick={() => (selectedMonitorPubkey = null)}
          >
            {ownSelected ? '▶ Viewing' : 'View'}
          </button>
        </div>
      </div>
    {/if}

    <!-- ── Paired Devices ─────────────────────────────────────────────── -->
    {#each $pairedDevices as dev (dev.pubkey)}
      {@const pk = dev.pubkey}
      {@const isSelected = selectedMonitorPubkey === pk}
      {@const rtc = rtcFor(pk)}
      {@const ps = $peerStatuses[pk]}
      {@const blockReason = unpairBlockReason(pk)}
      <div class="device-card" class:is-selected={isSelected}>
        <div class="card-top">
          <span class="role-badge paired">PAIRED</span>
          <span class="device-name">{dev.nickname}</span>
          {#if ps}
            <span class="status-dot" class:online={ps.state === 'online'} class:offline={ps.state === 'offline'} title="{ps.state} · {fmtAge(ps.updatedAt)}">●</span>
            <span class="status-age">{ps.state} · {fmtAge(ps.updatedAt)}</span>
          {/if}
          <span class="stats-line">{statsLine(pk)}</span>
          {#if rtc.viewing}
            <span class="rtc-pill active">● viewing</span>
          {/if}
          {#if rtc.watchedBy}
            <span class="rtc-pill active">● watched</span>
          {/if}
        </div>
        <div class="card-bot">
          <button class="pk-chip" onclick={() => navigator.clipboard.writeText(pk)} title={pk}>
            {pk.slice(0, 12)}…
          </button>
          <!-- Status request -->
          {#if true}
            {@const statusAction = getStatusAction(pk)}
            <button
              class="act-btn"
              disabled={!$nostrOnline && statusAction.pending}
              onclick={statusAction.pending ? statusAction.cancel : () => requestStatus(pk)}
              title={!$nostrOnline && !statusAction.pending ? 'Go online to request status' : statusAction.pending ? 'Cancel request' : 'Ask this device to report its current status'}
            >
              {statusAction.pending ? `⏳ Cancel` : 'Status?'}
            </button>
          {/if}
          <span class="spacer"></span>
          <!-- Select -->
          <button
            class="act-btn"
            class:accent={!isSelected}
            class:selected-btn={isSelected}
            onclick={() => (selectedMonitorPubkey = pk)}
          >
            {isSelected ? '▶ Viewing' : 'View'}
          </button>
          <!-- Clear fetched (in-memory) -->
          {#if (fetchedCountByMonitor[pk] ?? 0) > 0}
            <button class="act-btn danger-soft" onclick={() => onClearFetchedForMonitor?.(pk)}
              title="Clear {fetchedCountByMonitor[pk]} in-memory fetched segment{fetchedCountByMonitor[pk] !== 1 ? 's' : ''}">
              Clear Fetched ({fetchedCountByMonitor[pk]})
            </button>
          {/if}
          <!-- Clear data (IDB + OPFS) -->
          {#if stats[pk] && (stats[pk].storageBytes > 0 || stats[pk].alertCount > 0)}
            <button class="act-btn danger-soft" onclick={() => clearData(pk)}>Clear</button>
          {/if}
          <!-- Unpair — shown always, disabled when blocked -->
          <button
            class="act-btn danger"
            disabled={blockReason !== null}
            title={blockReason ?? 'Remove pairing record'}
            onclick={() => unpair(pk)}
          >
            Unpair
          </button>
        </div>
        {#if isSelected}
          <div class="card-conn">
            {#if vc.status === 'connecting'}
              <span class="conn-dot">◌</span>
              <span class="conn-label">Connecting…</span>
              <button class="act-btn" onclick={() => cancelConnect(pk)}>Cancel</button>
            {:else if vc.status === 'online'}
              <span class="conn-dot ok">●</span>
              <span class="conn-label ok">Online{vc.mode === 'live' ? ' · Live' : ''}</span>
              <button class="act-btn" onclick={() => disconnectViewer(pk)}>Disconnect</button>
            {:else if vc.status === 'failed'}
              <span class="conn-dot err">✗</span>
              <span class="conn-label err">{vc.error}</span>
              <button class="act-btn accent" onclick={() => handleConnect(pk)}
                disabled={!$identity || !$nostrOnline || $peerStatuses[pk]?.state === 'offline'}
                title={!$nostrOnline ? 'Go online first' : $peerStatuses[pk]?.state === 'offline' ? 'Device is offline' : undefined}>Retry</button>
            {:else}
              <button class="act-btn accent" onclick={() => handleConnect(pk)}
                disabled={!$identity || !$nostrOnline || $peerStatuses[pk]?.state === 'offline'}
                title={!$nostrOnline ? 'Go online first' : $peerStatuses[pk]?.state === 'offline' ? 'Device is offline' : undefined}>Connect</button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}

    <!-- ── Orphaned Devices ───────────────────────────────────────────── -->
    {#each orphanedPubkeys as pk (pk)}
      {@const isSelected = selectedMonitorPubkey === pk}
      {@const s = stats[pk]}
      {@const hasData = s && (s.storageBytes > 0 || s.alertCount > 0)}
      <div class="device-card orphaned" class:is-selected={isSelected}>
        <div class="card-top">
          <span class="role-badge unpaired">UNPAIRED</span>
          <span class="device-name mono">{pk.slice(0, 16)}…</span>
          <span class="stats-line">{statsLine(pk)}</span>
        </div>
        <div class="card-bot">
          <button class="pk-chip" onclick={() => navigator.clipboard.writeText(pk)} title={pk}>
            {pk.slice(0, 12)}…
          </button>
          <span class="orphan-note">No pairing record</span>
          <span class="spacer"></span>
          <button
            class="act-btn"
            class:accent={!isSelected}
            class:selected-btn={isSelected}
            onclick={() => (selectedMonitorPubkey = pk)}
          >
            {isSelected ? '▶ Viewing' : 'View'}
          </button>
          {#if (fetchedCountByMonitor[pk] ?? 0) > 0}
            <button class="act-btn danger-soft" onclick={() => onClearFetchedForMonitor?.(pk)}
              title="Clear {fetchedCountByMonitor[pk]} in-memory fetched segment{fetchedCountByMonitor[pk] !== 1 ? 's' : ''}">
              Clear Fetched ({fetchedCountByMonitor[pk]})
            </button>
          {/if}
          {#if hasData}
            <button class="act-btn danger-soft" onclick={() => clearData(pk)}>Clear data</button>
          {/if}
        </div>
        {#if isSelected}
          <div class="card-conn">
            {#if vc.status === 'connecting'}
              <span class="conn-dot">◌</span>
              <span class="conn-label">Connecting…</span>
              <button class="act-btn" onclick={() => cancelConnect(pk)}>Cancel</button>
            {:else if vc.status === 'online'}
              <span class="conn-dot ok">●</span>
              <span class="conn-label ok">Online{vc.mode === 'live' ? ' · Live' : ''}</span>
              <button class="act-btn" onclick={() => disconnectViewer(pk)}>Disconnect</button>
            {:else if vc.status === 'failed'}
              <span class="conn-dot err">✗</span>
              <span class="conn-label err">{vc.error}</span>
              <button class="act-btn accent" onclick={() => handleConnect(pk)}
                disabled={!$identity || !$nostrOnline}
                title={!$nostrOnline ? 'Go online first' : undefined}>Retry</button>
            {:else}
              <button class="act-btn accent" onclick={() => handleConnect(pk)}
                disabled={!$identity || !$nostrOnline}
                title={!$nostrOnline ? 'Go online first' : undefined}>Connect</button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if !$identity && $pairedDevices.length === 0 && orphanedPubkeys.length === 0}
      <div class="empty">No devices — generate an identity or pair a device.</div>
    {/if}

  </div>
</DevSection>

<style>
  .device-list { display: flex; flex-direction: column; gap: 6px; }

  .device-card {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-surface);
  }
  .device-card.is-selected { border-color: var(--color-accent); }
  .device-card.orphaned { border-style: dashed; }
  .device-card.orphaned.is-selected { border-color: var(--color-warning); border-style: solid; }

  .card-top {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 5px 8px;
    background: rgba(255,255,255,0.02);
    border-bottom: 1px solid var(--color-border);
    font-size: 11px;
  }
  .card-bot {
    display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
    padding: 5px 8px;
    font-size: 11px;
  }

  .role-badge {
    font-size: 8px; font-weight: 800; padding: 1px 5px; border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.06em; flex-shrink: 0;
  }
  .role-badge.own     { background: rgba(139,92,246,0.2); color: #a78bfa; }
  .role-badge.paired  { background: rgba(34,197,94,0.15); color: var(--color-success); }
  .role-badge.unpaired { background: rgba(251,191,36,0.15); color: var(--color-warning); }

  .device-name { font-weight: 600; color: var(--color-text); }
  .device-name.mono { font-family: ui-monospace, monospace; font-weight: 400; font-size: 10px; }

  .stats-line { font-size: 10px; color: var(--color-muted); margin-left: auto; }

  .rtc-pill {
    font-size: 9px; padding: 1px 6px; border-radius: 10px; white-space: nowrap;
    background: rgba(34,197,94,0.12); color: var(--color-success);
  }

  .pk-chip {
    font-family: ui-monospace, monospace; font-size: 9px; padding: 1px 5px;
    border-radius: 3px; border: 1px solid var(--color-border);
    background: var(--color-bg); color: var(--color-muted);
    cursor: pointer; white-space: nowrap; flex-shrink: 0;
  }
  .pk-chip:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }

  .orphan-note { font-size: 10px; color: var(--color-warning); opacity: 0.7; }

  .spacer { flex: 1; }

  .act-btn {
    font-size: 10px; padding: 2px 8px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap;
  }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.accent:hover { opacity: 0.9; }
  .act-btn.selected-btn {
    background: rgba(139,92,246,0.12); color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .act-btn.danger { border-color: var(--color-danger); color: var(--color-danger); }
  .act-btn.danger:hover:not(:disabled) { background: var(--color-danger); color: white; }
  .act-btn.danger-soft { border-color: rgba(239,68,68,0.3); color: var(--color-danger); opacity: 0.7; }
  .act-btn.danger-soft:hover:not(:disabled) { opacity: 1; }

  .status-dot { font-size: 9px; flex-shrink: 0; }
  .status-dot.online  { color: var(--color-success); }
  .status-dot.offline { color: var(--color-border); }
  .status-age { font-size: 9px; color: var(--color-muted); white-space: nowrap; }
  .online-pill { color: var(--color-success); border-color: rgba(34,197,94,0.35); font-weight: 600; }
  .online-pill:hover:not(:disabled) { background: rgba(34,197,94,0.08); }
  .rl-badge { font-size: 9px; font-family: ui-monospace, monospace; color: var(--color-warning, #f59e0b); background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); border-radius: 4px; padding: 1px 5px; white-space: nowrap; cursor: default; }

  .empty { font-size: 11px; color: var(--color-muted); text-align: center; padding: 10px 0; }

  .card-conn {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 4px 8px;
    background: rgba(255,255,255,0.015);
    border-top: 1px solid var(--color-border);
    font-size: 10px;
  }
  .conn-dot    { font-size: 9px; color: var(--color-muted); }
  .conn-dot.ok  { color: var(--color-success); }
  .conn-dot.err { color: var(--color-danger); }
  .conn-label   { color: var(--color-muted); }
  .conn-label.ok  { color: var(--color-success); }
  .conn-label.err { color: var(--color-danger); }
</style>
