<script lang="ts">
  import { identity, pairedDevices, addPairedDevice, removePairedDevice, updatePairedDevice } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import { createInviteQR, listenForInviteAck, acceptInvite } from '$lib/pairing/invite';
  import { buildInviteAck } from '$lib/nostr/events';
  import { publish, setRelays } from '$lib/nostr/client';
  import { decodeInviteUri } from '$lib/utils/qr';
  import { generateNickname } from '$lib/utils/nickname';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';
  import { onDestroy } from 'svelte';

  let qrSrc = $state('');
  let qrUri = $state('');
  let qrExpiry = $state(0);
  let qrCountdown = $state('');
  let ackSub: { close: () => void } | null = null;
  let pairedNotice = $state('');
  let qrLoading = $state(false);

  let manualInput = $state('');
  let manualStatus = $state('');
  let manualLoading = $state(false);

  let editingNickname = $state<string | null>(null);
  let editNicknameVal = $state('');

  let countdownInterval: ReturnType<typeof setInterval> | null = null;

  function updateCountdown() {
    const secs = Math.max(0, Math.floor((qrExpiry - Date.now()) / 1000));
    if (secs === 0) {
      qrSrc = '';
      qrUri = '';
      qrCountdown = 'Expired';
      if (countdownInterval) clearInterval(countdownInterval);
    } else {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      qrCountdown = `${m}:${s.toString().padStart(2, '0')}`;
    }
  }

  async function generateQR() {
    if (!$identity) return;
    qrLoading = true;
    ackSub?.close();
    if (countdownInterval) clearInterval(countdownInterval);
    try {
      const result = await createInviteQR($identity.privkey, $identity.pubkey, $settings.selfLabel);
      qrSrc = result.qrDataUrl;
      qrUri = result.uri;
      qrExpiry = Date.now() + 5 * 60 * 1000;
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);
      ackSub = listenForInviteAck($identity.privkey, $identity.pubkey, async (scannerPubkey, scannerRelays) => {
        const nickname = generateNickname();
        await addPairedDevice({ pubkey: scannerPubkey, nickname, addedAt: Date.now(), relays: scannerRelays, capabilities: [], lastSeenAt: null });
        pairedNotice = `Paired as "${nickname}"`;
        setTimeout(() => (pairedNotice = ''), 4000);
      });
    } finally {
      qrLoading = false;
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(qrUri);
  }

  async function pairManual() {
    if (!$identity || !manualInput.trim()) return;
    manualLoading = true;
    manualStatus = '';
    try {
      const payload = decodeInviteUri(manualInput.trim());
      setRelays(payload.relays);
      const result = await acceptInvite($identity.privkey, $identity.pubkey, payload);
      if (!result.valid) { manualStatus = `✗ ${result.reason ?? 'Invalid invite'}`; return; }
      const ack = buildInviteAck($identity.privkey, $identity.pubkey, payload.pk, payload.inviteId, payload.secret, payload.relays);
      await publish(ack);
      manualStatus = `✓ Paired with ${payload.label}`;
      manualInput = '';
    } catch (e) {
      manualStatus = `✗ ${e instanceof Error ? e.message : 'Invalid pairing URI'}`;
    } finally {
      manualLoading = false;
    }
  }

  async function removeDevice(pubkey: string) {
    if (!confirm('Remove this paired device?')) return;
    await removePairedDevice(pubkey);
  }

  async function saveNickname(pubkey: string) {
    await updatePairedDevice(pubkey, { nickname: editNicknameVal });
    editingNickname = null;
  }

  function resetAll() {
    if (!confirm('Remove all paired devices?')) return;
    $pairedDevices.forEach(d => removePairedDevice(d.pubkey));
  }

  onDestroy(() => {
    ackSub?.close();
    if (countdownInterval) clearInterval(countdownInterval);
  });
</script>

<DevSection title="Pairing">
  {#snippet actions()}
    <button class="act-btn danger" onclick={resetAll}>Reset</button>
  {/snippet}

  <!-- Generate invite -->
  <div class="subsection">
    <div class="row">
      <button class="act-btn accent" onclick={generateQR} disabled={qrLoading}>Generate Invite QR</button>
      {#if qrUri}
        <button class="act-btn" onclick={copyLink}>Copy Link</button>
        <span class="countdown">{qrCountdown}</span>
      {/if}
      {#if pairedNotice}
        <span class="ok">{pairedNotice}</span>
      {/if}
    </div>
    {#if qrSrc}
      <img src={qrSrc} alt="Pairing QR" class="qr-img" />
    {/if}
  </div>

  <!-- Accept invite -->
  <div class="subsection">
    <textarea
      class="text-area"
      bind:value={manualInput}
      placeholder="Paste senstry:… invite link here"
      rows="2"
    ></textarea>
    <div class="row">
      <button class="act-btn accent" onclick={pairManual} disabled={manualLoading || !manualInput.trim()}>Pair</button>
      {#if manualStatus}
        <span class="status" class:ok={manualStatus.startsWith('✓')} class:err={manualStatus.startsWith('✗')}>{manualStatus}</span>
      {/if}
    </div>
  </div>

  <!-- Paired devices list -->
  <div class="subsection">
    {#each $pairedDevices as dev (dev.pubkey)}
      <div class="device-row">
        {#if editingNickname === dev.pubkey}
          <input class="text-input" bind:value={editNicknameVal} onblur={() => saveNickname(dev.pubkey)} onkeydown={(e) => e.key === 'Enter' && saveNickname(dev.pubkey)} />
        {:else}
          <span class="nickname">{dev.nickname}</span>
          <button class="act-btn" onclick={() => { editingNickname = dev.pubkey; editNicknameVal = dev.nickname; }}>Edit</button>
        {/if}
        <span class="pubkey-short" title={dev.pubkey}>{dev.pubkey.slice(0, 16)}…</span>
        <button class="rm-btn" onclick={() => removeDevice(dev.pubkey)}>✕</button>
      </div>
    {:else}
      <div class="empty">No paired devices</div>
    {/each}
  </div>

  <LogPanel sources={['nostr']} filter={(e) => e.label.includes('5000') || e.label.includes('invite') || e.label.includes('pair')} />
</DevSection>

<style>
  .subsection { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .qr-img { width: 180px; height: 180px; border-radius: 8px; background: white; padding: 8px; align-self: flex-start; }
  .text-area {
    font-family: ui-monospace, monospace; font-size: 11px; padding: 6px 8px;
    border-radius: 6px; border: 1px solid var(--color-border); background: var(--color-surface);
    color: var(--color-text); resize: vertical; width: 100%; box-sizing: border-box;
  }
  .text-input {
    font-size: 12px; padding: 3px 8px; border-radius: 4px;
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
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .countdown { font-size: 11px; color: var(--color-muted); font-family: ui-monospace, monospace; }
  .status.ok, .ok { color: var(--color-success); font-size: 11px; }
  .status.err { color: var(--color-danger); font-size: 11px; }
  .device-row {
    display: flex; align-items: center; gap: 8px; padding: 5px 8px;
    border-radius: 5px; background: var(--color-surface); border: 1px solid var(--color-border);
    font-size: 11px;
  }
  .nickname { font-weight: 600; color: var(--color-text); flex: 1; min-width: 80px; }
  .pubkey-short { font-family: ui-monospace, monospace; color: var(--color-muted); font-size: 10px; margin-left: auto; }
  .rm-btn { font-size: 11px; padding: 0 4px; border: none; background: none; color: var(--color-muted); cursor: pointer; }
  .rm-btn:hover { color: var(--color-danger); }
  .empty { font-size: 11px; color: var(--color-muted); text-align: center; padding: 8px 0; }
</style>
