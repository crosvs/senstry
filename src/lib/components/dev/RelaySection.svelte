<script lang="ts">
  import {
    getRelays, setRelays, getActiveSubs, subscribe, publish,
    setRateLimit, getRateLimitAvailable, getPublishRate, type ActiveSub
  } from '$lib/nostr/client';
  import { settings, saveSettings, DEFAULT_RELAY } from '$lib/store/settings';
  import { identity } from '$lib/store/identity';
  import { finalizeEvent } from 'nostr-tools/pure';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';

  let activeSubs = $state<ActiveSub[]>([]);
  let relayEdit = $state($settings.relayUrl);
  let editing = $state(false);
  let testStatus = $state('');
  let testLoading = $state(false);
  let rateLimitInput = $state($settings.nostrRateLimit);
  let tokensAvail = $state(0);
  let publishedLast60s = $state(0);
  let newSubKind = $state('5010');
  let newSubPubkey = $state('');
  let addingSubOpen = $state(false);

  // Tick: refresh active subs + rate stats
  $effect(() => {
    const interval = setInterval(() => {
      activeSubs = getActiveSubs();
      tokensAvail = Math.floor(getRateLimitAvailable());
      publishedLast60s = getPublishRate().last60s;
    }, 500);
    return () => clearInterval(interval);
  });

  async function saveRelay() {
    await saveSettings({ ...$settings, relayUrl: relayEdit });
    setRelays([relayEdit]);
    editing = false;
  }

  async function testRelay() {
    if (!$identity) { testStatus = 'No identity'; return; }
    testLoading = true;
    testStatus = 'Testing…';
    const start = Date.now();
    try {
      const ev = finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'senstry-test']],
        content: 'connection test',
      }, $identity.privkey);
      await publish(ev);
      testStatus = `✓ OK (${Date.now() - start}ms)`;
    } catch (e) {
      testStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally {
      testLoading = false;
    }
  }

  async function updateRateLimit() {
    setRateLimit(rateLimitInput);
    await saveSettings({ ...$settings, nostrRateLimit: rateLimitInput });
  }

  function resetDefault() {
    relayEdit = DEFAULT_RELAY;
    saveRelay();
  }

  function addSub() {
    const kind = parseInt(newSubKind);
    if (isNaN(kind)) return;
    const filter: Record<string, unknown> = { kinds: [kind] };
    if (newSubPubkey.trim()) filter['#p'] = [newSubPubkey.trim()];
    subscribe(filter as Parameters<typeof subscribe>[0], () => {});
    newSubKind = '5010';
    newSubPubkey = '';
    addingSubOpen = false;
  }
</script>

<DevSection title="Relay">
  {#snippet summary()}
    {$settings.relayUrl.replace('wss://', '').replace('ws://', '')} · {activeSubs.length} sub{activeSubs.length === 1 ? '' : 's'} · {publishedLast60s}/min
  {/snippet}
  {#snippet actions()}
    <button class="act-btn" onclick={resetDefault}>Reset Default</button>
  {/snippet}

  <!-- Relay URL -->
  <div class="row">
    <span class="lbl">relay</span>
    <div class="val-row flex-1">
      {#if editing}
        <input class="text-input flex-1" bind:value={relayEdit} onkeydown={(e) => e.key === 'Enter' && saveRelay()} />
        <button class="act-btn" onclick={saveRelay}>Save</button>
        <button class="act-btn muted" onclick={() => { editing = false; relayEdit = $settings.relayUrl; }}>Cancel</button>
      {:else}
        <span class="mono small">{$settings.relayUrl}</span>
        <button class="act-btn" onclick={() => (editing = true)}>Edit</button>
      {/if}
      <button class="act-btn" onclick={testRelay} disabled={testLoading}>Test</button>
      {#if testStatus}
        <span class="status" class:ok={testStatus.startsWith('✓')} class:err={testStatus.startsWith('✗')}>{testStatus}</span>
      {/if}
    </div>
  </div>

  <!-- Rate limit -->
  <div class="row">
    <span class="lbl">rate limit</span>
    <div class="val-row">
      <input
        type="number" min="1" max="10000" class="num-input"
        bind:value={rateLimitInput}
        onblur={updateRateLimit}
        onkeydown={(e) => e.key === 'Enter' && updateRateLimit()}
      />
      <span class="small muted">events/min</span>
      <span class="badge-token">{tokensAvail} tokens · {publishedLast60s} sent/min</span>
    </div>
  </div>

  <!-- Subscriptions -->
  <div class="sub-header">
    <span class="lbl">subscriptions ({activeSubs.length})</span>
    <button class="act-btn" onclick={() => (addingSubOpen = !addingSubOpen)}>+ Add</button>
  </div>

  {#if addingSubOpen}
    <div class="add-sub-form">
      <span class="small muted">kind:</span>
      <input class="num-input" bind:value={newSubKind} placeholder="5010" />
      <span class="small muted">#p:</span>
      <input class="text-input" bind:value={newSubPubkey} placeholder="hex pubkey (optional)" style="flex:1" />
      <button class="act-btn accent" onclick={addSub}>Subscribe</button>
    </div>
  {/if}

  <div class="sub-list">
    {#each activeSubs as sub (sub.id)}
      <div class="sub-row">
        <span class="sub-id">{sub.id}</span>
        <span class="sub-kinds">{(sub.filter.kinds ?? []).map(k => `kind:${k}`).join(' ')}</span>
        {#if sub.filter['#p']}
          <span class="sub-filter">#p:{(sub.filter['#p'] as string[])[0]?.slice(0, 8)}…</span>
        {/if}
        <span class="sub-count">{sub.eventCount} events</span>
        <button class="rm-btn" onclick={sub.close}>✕</button>
      </div>
    {:else}
      <div class="empty">No active subscriptions</div>
    {/each}
  </div>

  <LogPanel sources={['nostr']} />
</DevSection>

<style>
  .row { display: flex; align-items: center; gap: 8px; }
  .lbl { font-size: 11px; color: var(--color-muted); width: 90px; flex-shrink: 0; }
  .val-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .flex-1 { flex: 1; }
  .mono { font-family: ui-monospace, monospace; }
  .small { font-size: 11px; color: var(--color-text); }
  .muted { color: var(--color-muted) !important; }
  .text-input {
    font-size: 11px; padding: 3px 8px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-text); font-family: inherit;
  }
  .num-input {
    font-size: 11px; padding: 3px 6px; border-radius: 4px; width: 70px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-text); font-family: inherit;
  }
  .act-btn {
    font-size: 10px; padding: 2px 8px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap;
  }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .status { font-size: 11px; }
  .status.ok { color: var(--color-success); }
  .status.err { color: var(--color-danger); }
  .badge-token {
    font-size: 10px; padding: 1px 6px; border-radius: 3px;
    background: var(--color-surface); color: var(--color-muted); border: 1px solid var(--color-border);
  }
  .sub-header { display: flex; align-items: center; justify-content: space-between; }
  .add-sub-form {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 8px; border-radius: 6px; background: var(--color-surface);
    border: 1px solid var(--color-border);
  }
  .sub-list { display: flex; flex-direction: column; gap: 2px; }
  .sub-row {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    border-radius: 4px; background: var(--color-surface); font-size: 11px;
  }
  .sub-id { color: var(--color-accent); font-family: ui-monospace, monospace; width: 55px; flex-shrink: 0; }
  .sub-kinds { color: var(--color-text); }
  .sub-filter { color: var(--color-muted); font-family: ui-monospace, monospace; font-size: 10px; }
  .sub-count { margin-left: auto; color: var(--color-muted); font-size: 10px; }
  .rm-btn {
    font-size: 10px; padding: 0 5px; border: none; background: none;
    color: var(--color-muted); cursor: pointer;
  }
  .rm-btn:hover { color: var(--color-danger); }
  .empty { font-size: 11px; color: var(--color-muted); padding: 6px 0; text-align: center; }
</style>
