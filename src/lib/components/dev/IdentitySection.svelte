<script lang="ts">
  import { identity } from '$lib/store/identity';
  import { settings, saveSettings } from '$lib/store/settings';
  import { toNpub, toNsec, loadOrCreateIdentity } from '$lib/nostr/keys';
  import DevSection from './DevSection.svelte';

  let showPrivkey = $state(false);
  let copied = $state('');
  let nameInput = $state($settings.selfLabel);

  async function regenerate() {
    if (!confirm('Generate a new identity? This replaces your current keys.')) return;
    const { openDB } = await import('$lib/db/idb');
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const db = await openDB();
    const privkey = generateSecretKey();
    await db.put('settings', privkey.buffer, 'identity.privkey');
    const { identity: id } = await import('$lib/store/identity');
    id.set({ privkey, pubkey: getPublicKey(privkey) });
  }

  async function copyText(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    copied = key;
    setTimeout(() => (copied = ''), 1500);
  }

  async function saveName() {
    await saveSettings({ ...$settings, selfLabel: nameInput });
  }
</script>

<DevSection title="Identity">
  {#snippet summary()}
    {$settings.selfLabel || 'unnamed'} · {$identity ? toNpub($identity.pubkey).slice(0, 16) + '…' : '—'}
  {/snippet}
  {#snippet actions()}
    <button class="act-btn" onclick={regenerate}>Generate New</button>
  {/snippet}

  <div class="row">
    <span class="lbl">pubkey (npub)</span>
    <div class="val-row">
      <span class="mono small">{$identity ? toNpub($identity.pubkey) : '—'}</span>
      {#if $identity}
        <button class="copy-btn" onclick={() => copyText(toNpub($identity!.pubkey), 'npub')}>{copied === 'npub' ? '✓' : 'Copy'}</button>
      {/if}
    </div>
  </div>

  <div class="row">
    <span class="lbl">pubkey (hex)</span>
    <div class="val-row">
      <span class="mono small">{$identity?.pubkey ?? '—'}</span>
      {#if $identity}
        <button class="copy-btn" onclick={() => copyText($identity!.pubkey, 'hex')}>{copied === 'hex' ? '✓' : 'Copy'}</button>
      {/if}
    </div>
  </div>

  <div class="row">
    <span class="lbl">privkey</span>
    <div class="val-row">
      {#if showPrivkey && $identity}
        <span class="mono small danger">{toNsec($identity.privkey)}</span>
        <button class="copy-btn" onclick={() => copyText(toNsec($identity!.privkey), 'nsec')}>{copied === 'nsec' ? '✓' : 'Copy'}</button>
      {:else}
        <span class="mono small muted">{'•'.repeat(32)}</span>
      {/if}
      <button class="act-btn" onclick={() => (showPrivkey = !showPrivkey)}>
        {showPrivkey ? 'Hide' : 'Reveal'}
      </button>
    </div>
  </div>

  <div class="row">
    <span class="lbl">name</span>
    <div class="val-row">
      <input
        class="text-input"
        bind:value={nameInput}
        onblur={saveName}
        placeholder="Monitor"
      />
    </div>
  </div>
</DevSection>

<style>
  .row { display: flex; align-items: flex-start; gap: 10px; }
  .lbl { font-size: 11px; color: var(--color-muted); width: 110px; flex-shrink: 0; padding-top: 2px; }
  .val-row { display: flex; align-items: center; gap: 6px; flex: 1; flex-wrap: wrap; }
  .mono { font-family: ui-monospace, monospace; word-break: break-all; }
  .small { font-size: 11px; color: var(--color-text); }
  .muted { color: var(--color-muted); }
  .danger { color: var(--color-danger); }
  .copy-btn, .act-btn {
    font-size: 10px; padding: 2px 7px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap;
  }
  .copy-btn:hover, .act-btn:hover { color: var(--color-text); }
  .text-input {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
    border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-text); font-family: inherit; width: 180px;
  }
</style>
