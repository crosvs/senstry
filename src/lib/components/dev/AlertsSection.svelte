<script lang="ts">
  import { identity, pairedDevices } from '$lib/store/identity';
  import {
    alertLog, unreadCount, listenerActive, notifPermission,
    startAlertListener, stopAlertListener,
    requestNotifPermission, markAllRead, markRead, clearAlerts,
    type AlertRecord,
  } from '$lib/store/notification-listener';
  import DevSection from './DevSection.svelte';
  import { onDestroy } from 'svelte';

  // ── Permission ────────────────────────────────────────────────────────────
  let requestingPerm = $state(false);

  async function enableNotifications() {
    requestingPerm = true;
    await requestNotifPermission();
    requestingPerm = false;
  }

  // ── Listener lifecycle ────────────────────────────────────────────────────
  function toggleListener() {
    if ($listenerActive) {
      stopAlertListener();
    } else {
      if (!$identity) return;
      const paired = new Set($pairedDevices.map(d => d.pubkey));
      startAlertListener($identity.privkey, $identity.pubkey, paired);
    }
  }

  onDestroy(() => {
    // Don't stop on destroy — keep listening if user navigates away from dev panel.
    // Call stopAlertListener() explicitly if the app is being torn down.
  });

  // ── Formatting ────────────────────────────────────────────────────────────
  function fmtTs(unix: number) {
    return new Date(unix * 1000).toLocaleTimeString();
  }

  function fmtData(data: Record<string, unknown> | undefined): string {
    if (!data) return '';
    return Object.entries(data)
      .map(([k, v]) => {
        if (typeof v === 'number') return `${k}: ${Number.isInteger(v) ? v : v.toFixed(1)}`;
        return `${k}: ${v}`;
      })
      .join('  ·  ');
  }

  function typeColor(type: string): string {
    if (type === 'audio') return '#60a5fa';
    if (type === 'motion') return '#f59e0b';
    if (type === 'schedule') return '#34d399';
    return '#a78bfa';
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
  }

  function nickFor(pubkey: string): string {
    return $pairedDevices.find(d => d.pubkey === pubkey)?.nickname ?? pubkey.slice(0, 8);
  }

  // Permission status display helpers
  const permLabel: Record<NotificationPermission, string> = {
    granted: '🔔 Granted',
    denied:  '🔕 Denied',
    default: '🔔 Not set',
  };
  const permOk = $derived($notifPermission === 'granted');
</script>

<DevSection title="Alert Listener">

  <!-- ── Status bar ───────────────────────────────────────────────────────── -->
  <div class="status-bar">
    <!-- Listener toggle -->
    <button
      class="toggle-btn"
      class:active={$listenerActive}
      onclick={toggleListener}
      disabled={!$identity}
      title={$listenerActive ? 'Stop listening for alerts' : 'Start listening for alerts from paired monitors'}
    >
      <span class="dot" class:on={$listenerActive}></span>
      {$listenerActive ? 'Listening' : 'Stopped'}
    </button>

    <!-- Notification permission -->
    <span class="perm-badge" class:ok={permOk} class:warn={!permOk}>
      {permLabel[$notifPermission]}
    </span>

    {#if $notifPermission !== 'granted' && $notifPermission !== 'denied'}
      <button class="act-btn accent" onclick={enableNotifications} disabled={requestingPerm}>
        {requestingPerm ? 'Requesting…' : 'Enable Notifications'}
      </button>
    {:else if $notifPermission === 'denied'}
      <span class="hint">Allow notifications in browser settings to receive alerts.</span>
    {/if}

    <span class="spacer"></span>

    <!-- Alert log controls -->
    {#if $alertLog.length > 0}
      {#if $unreadCount > 0}
        <button class="act-btn" onclick={markAllRead} title="Mark all alerts as read">
          Mark read ({$unreadCount})
        </button>
      {/if}
      <button class="act-btn danger" onclick={clearAlerts} title="Clear all alerts from this session">
        Clear
      </button>
    {/if}
  </div>

  <!-- ── Alert log ────────────────────────────────────────────────────────── -->
  {#if $alertLog.length === 0}
    <div class="empty">
      {#if $listenerActive}
        Listening — alerts will appear here when monitors trigger.
      {:else}
        Start the listener to receive alerts from paired monitors.
      {/if}
    </div>
  {:else}
    <div class="alert-list">
      {#each $alertLog as alert (alert.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="alert-row"
          class:unread={!alert.read}
          onclick={() => markRead(alert.id)}
        >
          <span class="unread-dot" class:visible={!alert.read}></span>
          <span class="alert-time">{fmtTs(alert.timestamp)}</span>
          <span class="alert-monitor">{nickFor(alert.monitorPubkey)}</span>
          <span class="alert-type" style="color:{typeColor(alert.detectionType)}">{alert.detectionType}</span>
          <span class="alert-source">{alert.channelId || '—'}</span>
          <span class="alert-body">
            {#if alert.message}
              <span class="alert-msg">{alert.message}</span>
            {/if}
            {#if alert.data}
              <span class="alert-data">{fmtData(alert.data)}</span>
            {/if}
          </span>
          {#if alert.footageRefId}
            <button
              class="ref-chip"
              onclick={(e) => { e.stopPropagation(); copyText(alert.footageRefId!); }}
              title="Copy footage ref ID — paste into Content Viewer → Fetch by ID"
            >
              ⟲ Footage
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- ── Background limitation notice ─────────────────────────────────────── -->
  <div class="notice">
    Alerts are delivered while this browser tab is open, including when it's in the background or
    another tab is in focus. Closing the browser stops delivery — Web Push (closed-browser
    notifications) requires a server and is not yet implemented.
  </div>

</DevSection>

<style>
  /* ── Status bar ─────────────────────────────────────────────────────────── */
  .status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }

  .toggle-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    font-family: inherit;
    padding: 3px 8px 3px 6px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-muted);
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .toggle-btn:disabled { opacity: 0.4; cursor: default; }
  .toggle-btn.active {
    border-color: var(--color-success);
    color: var(--color-success);
  }
  .toggle-btn:hover:not(:disabled):not(.active) { color: var(--color-text); }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-muted);
    flex-shrink: 0;
  }
  .dot.on {
    background: var(--color-success);
    box-shadow: 0 0 4px var(--color-success);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.5; }
  }

  .perm-badge {
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-muted);
    font-family: inherit;
  }
  .perm-badge.ok    { color: var(--color-success); border-color: var(--color-success); background: rgba(34,197,94,0.08); }
  .perm-badge.warn  { color: var(--color-warning, #f59e0b); border-color: currentColor; }

  .hint { font-size: 10px; color: var(--color-muted); font-style: italic; }
  .spacer { flex: 1; }

  .act-btn {
    font-size: 9px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-muted);
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.accent:hover:not(:disabled) { opacity: 0.9; }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .act-btn.danger:hover { background: var(--color-danger); color: white; }

  /* ── Alert list ─────────────────────────────────────────────────────────── */
  .alert-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: 5px;
    overflow: hidden;
    margin-bottom: 6px;
  }

  .alert-row {
    display: grid;
    grid-template-columns: 8px 60px 80px 56px 80px 1fr auto;
    gap: 6px;
    align-items: center;
    padding: 5px 8px;
    font-size: 10px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
    cursor: pointer;
    transition: background 0.1s;
  }
  .alert-row:first-child { border-top: none; }
  .alert-row:hover { background: var(--color-surface); }
  .alert-row.unread { background: rgba(139, 92, 246, 0.04); }

  .unread-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: transparent;
    flex-shrink: 0;
  }
  .unread-dot.visible { background: var(--color-accent); }

  .alert-time    { font-family: ui-monospace, monospace; color: var(--color-muted); font-size: 9px; }
  .alert-monitor { font-weight: 600; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alert-type    { font-size: 9px; font-weight: 700; font-family: ui-monospace, monospace; }
  .alert-source  { font-size: 9px; color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alert-body    { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .alert-msg     { color: var(--color-text); font-size: 10px; }
  .alert-data    { color: var(--color-muted); font-size: 9px; font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .ref-chip {
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-accent);
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
  }
  .ref-chip:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }

  /* ── Empty + notice ─────────────────────────────────────────────────────── */
  .empty {
    font-size: 10px;
    color: var(--color-muted);
    padding: 8px 2px;
    font-style: italic;
    margin-bottom: 6px;
  }

  .notice {
    font-size: 9px;
    color: var(--color-muted);
    line-height: 1.5;
    border-top: 1px solid var(--color-border);
    padding-top: 5px;
    margin-top: 2px;
  }
</style>
