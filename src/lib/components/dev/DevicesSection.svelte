<script lang="ts">
  import { identity, pairedDevices, removePairedDevice } from '$lib/store/identity';
  import {
    getDistinctOriginMonitors, clearForMonitor, cleanupOrphanedOpfsFiles,
    type Segment
  } from '$lib/db/segments';
  import { getAllFootageRefs, clearFootageRefsForMonitor } from '$lib/db/footage';
  import { getViewerSessionInfos } from '$lib/webrtc/viewer-peer';
  import { getMonitorSessionInfos } from '$lib/webrtc/monitor-peer';
  import { sendSignal } from '$lib/webrtc/signaling';
  import DevSection from './DevSection.svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
  }
  let { selectedMonitorPubkey = $bindable(null) }: Props = $props();

  interface DevStats {
    storageBytes: number;
    segCount: number;
    alertCount: number;
  }

  interface PingState {
    status: 'pinging' | 'sent' | 'timeout' | 'error';
    latencyMs?: number;
    error?: string;
  }

  let stats = $state<Record<string, DevStats>>({});
  let pingStates = $state<Record<string, PingState>>({});
  let orphanedPubkeys = $state<string[]>([]);
  let loading = $state(false);

  // ── RTC polling ───────────────────────────────────────────────────────────
  let rtcTick = $state(0);
  const rtcInterval = setInterval(() => rtcTick++, 2000);
  onDestroy(() => clearInterval(rtcInterval));

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

  // ── Ping ──────────────────────────────────────────────────────────────────
  async function ping(pubkey: string) {
    if (!$identity) return;
    const sessionId = crypto.randomUUID();
    const t0 = Date.now();
    pingStates = { ...pingStates, [pubkey]: { status: 'pinging' } };
    const timer = setTimeout(() => {
      if (pingStates[pubkey]?.status === 'pinging') {
        pingStates = { ...pingStates, [pubkey]: { status: 'timeout' } };
      }
    }, 5000);
    try {
      await sendSignal($identity.privkey, $identity.pubkey, pubkey, { type: 'ping', sessionId });
      clearTimeout(timer);
      if (pingStates[pubkey]?.status === 'pinging') {
        pingStates = { ...pingStates, [pubkey]: { status: 'sent', latencyMs: Date.now() - t0 } };
      }
    } catch (e) {
      clearTimeout(timer);
      pingStates = { ...pingStates, [pubkey]: { status: 'error', error: e instanceof Error ? e.message : 'Failed' } };
    }
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
          <span class="stats-line">{statsLine(ownPk)}</span>
          {#if viewers > 0}
            <span class="rtc-pill active">{viewers} viewer{viewers !== 1 ? 's' : ''}</span>
          {/if}
        </div>
        <div class="card-bot">
          <button class="pk-chip" onclick={() => navigator.clipboard.writeText(ownPk)} title={ownPk}>
            {ownPk.slice(0, 12)}…
          </button>
          <span class="spacer"></span>
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
      {@const p = pingStates[pk]}
      {@const blockReason = unpairBlockReason(pk)}
      <div class="device-card" class:is-selected={isSelected}>
        <div class="card-top">
          <span class="role-badge paired">PAIRED</span>
          <span class="device-name">{dev.nickname}</span>
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
          <!-- Ping -->
          <button
            class="act-btn ping-btn"
            class:ping-ok={p?.status === 'sent'}
            class:ping-warn={p?.status === 'timeout'}
            class:ping-err={p?.status === 'error'}
            disabled={p?.status === 'pinging'}
            onclick={() => ping(pk)}
            title={p?.status === 'error' ? p.error : undefined}
          >
            {#if !p || p.status === 'pinging'}
              {p?.status === 'pinging' ? '…' : 'Ping'}
            {:else if p.status === 'sent'}
              ✓ {p.latencyMs}ms
            {:else if p.status === 'timeout'}
              ⚠ no reply
            {:else if p.status === 'error'}
              ✗ error
            {/if}
          </button>
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
          <!-- Clear data -->
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
          {#if hasData}
            <button class="act-btn danger-soft" onclick={() => clearData(pk)}>Clear data</button>
          {/if}
        </div>
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

  .ping-btn { min-width: 68px; }
  .ping-btn.ping-ok  { color: var(--color-success); border-color: rgba(34,197,94,0.3); }
  .ping-btn.ping-warn { color: var(--color-warning); border-color: rgba(251,191,36,0.3); }
  .ping-btn.ping-err  { color: var(--color-danger);  border-color: rgba(239,68,68,0.3); }

  .empty { font-size: 11px; color: var(--color-muted); text-align: center; padding: 10px 0; }
</style>
