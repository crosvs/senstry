<script lang="ts">
  import { onDestroy } from 'svelte';
  import { identity, pairedDevices } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import { triggers, loadTriggers } from '$lib/store/triggers';
  import { AudioDetector } from '$lib/detectors/audio';
  import { saveSegment, pinRange, PRE_ROLL_S, POST_ROLL_S } from '$lib/db/segments';
  import { createFootageRef, updateFootageRef } from '$lib/db/footage';
  import { buildTriggerEvent } from '$lib/nostr/events';
  import { publish, getRelays } from '$lib/nostr/client';
  import { enqueue } from '$lib/db/outbox';
  import {
    setMonitorStream, setIdleTimeout, handleOfferRequest,
    handleAnswer, handleHangup, stopAllMonitorSessions,
    getMonitorSessionInfos, type MonitorSessionInfo
  } from '$lib/webrtc/monitor-peer';
  import { handleViewerSignal } from '$lib/webrtc/viewer-peer';
  import { startSignalRouter } from '$lib/webrtc/signal-router';
  import { monitorState, transitionMonitor, isStoring, isPublishing } from '$lib/store/monitor';
  import { dbg } from '$lib/store/debug';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';
  import type { SignalMessage } from '$lib/webrtc/signaling';

  interface Props {
    signalRouterActive?: boolean;
    autoAccept?: boolean;
    onSignalRouterChange?: (active: boolean) => void;
    onAutoAcceptChange?: (auto: boolean) => void;
    onPendingOffer?: (fromPubkey: string, msg: SignalMessage) => void;
    acceptOffer?: { fromPubkey: string; msg: SignalMessage } | null;
  }
  let {
    signalRouterActive = $bindable(false),
    autoAccept = $bindable(true),
    onPendingOffer,
    acceptOffer = null,
  }: Props = $props();

  let stream = $state<MediaStream | null>(null);
  let recorder: MediaRecorder | null = null;
  let detectors: AudioDetector[] = [];
  let peakDb = $state(-Infinity);
  let meterRaf: number | null = null;
  let meterCtx: AudioContext | null = null;
  let meterAnalyser: AnalyserNode | null = null;
  let meterBuf: Float32Array<ArrayBuffer> | null = null;
  let videoEl: HTMLVideoElement | undefined = $state();
  let armed = $state(false);
  let error = $state('');
  let sessions = $state<MonitorSessionInfo[]>([]);
  let showPreview = $state<Record<string, boolean>>({});
  let signalSub: { close: () => void } | null = null;
  let segmentStart = 0;
  let sessionTick: ReturnType<typeof setInterval>;

  sessionTick = setInterval(() => {
    sessions = getMonitorSessionInfos();
  }, 2000);

  // Watch for external accept-offer trigger
  $effect(() => {
    if (acceptOffer && $identity) {
      handleOfferRequest($identity.privkey, $identity.pubkey, acceptOffer.msg, acceptOffer.fromPubkey).catch(() => {});
    }
  });

  function startRouter() {
    if (!$identity || signalSub) return;
    signalSub = startSignalRouter(
      $identity.privkey,
      $identity.pubkey,
      async (msg, fromPubkey) => {
        if (!$identity) return;
        if (msg.type === 'offer-request') {
          if (autoAccept) {
            await handleOfferRequest($identity.privkey, $identity.pubkey, msg, fromPubkey);
          } else {
            onPendingOffer?.(fromPubkey, msg);
          }
        } else if (msg.type === 'answer') {
          await handleAnswer(msg, fromPubkey);
        } else if (msg.type === 'hangup') {
          handleHangup(msg, fromPubkey);
        }
      },
      async (msg, fromPubkey) => {
        await handleViewerSignal(msg, fromPubkey);
      }
    );
    signalRouterActive = true;
  }

  function stopRouter() {
    signalSub?.close();
    signalSub = null;
    signalRouterActive = false;
  }

  async function startMonitor() {
    if (!$identity) return;
    error = '';
    transitionMonitor('starting');
    await loadTriggers();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: $settings.videoConfig.recordVideo,
        audio: true,
      });
      if (videoEl) videoEl.srcObject = stream;
      setMonitorStream(stream);
      setIdleTimeout($settings.rtcIdleTimeoutMs);
      startRecording();
      startDetectors();
      transitionMonitor('active');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to access camera/mic';
      transitionMonitor('idle');
    }
  }

  function startRecording() {
    if (!stream) return;
    const useVideo = $settings.videoConfig.recordVideo;
    const mimeType = useVideo
      ? (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm')
      : (MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm');
    const recordStream = useVideo ? stream : new MediaStream(stream.getAudioTracks());
    recorder = new MediaRecorder(recordStream, { mimeType });
    let initChunk: Blob | null = null;
    recorder.ondataavailable = async (e) => {
      if (e.data.size === 0 || !$identity) return;
      const now = Math.floor(Date.now() / 1000);
      const start = segmentStart || now - 10;
      segmentStart = now;
      const blob = initChunk ? new Blob([initChunk, e.data], { type: mimeType }) : new Blob([e.data], { type: mimeType });
      if (!initChunk) initChunk = e.data;
      try {
        await saveSegment(blob, mimeType, start, now, $identity.pubkey);
      } catch (err) {
        dbg('warn', 'idb', 'segment save failed', err);
      }
    };
    segmentStart = Math.floor(Date.now() / 1000);
    recorder.start(10_000);
  }

  function startDetectors() {
    if (!stream) return;
    detectors.forEach(d => d.stop());
    detectors = [];
    for (const cfg of $triggers.filter(t => t.enabled)) {
      const det = new AudioDetector(cfg);
      det.onDetection = async (evt) => {
        if (!armed || !$identity) return;
        await handleTriggerFired(evt, cfg.name);
      };
      det.start(stream);
      detectors.push(det);
    }
    // Meter
    meterCtx = new AudioContext();
    meterAnalyser = meterCtx.createAnalyser();
    meterAnalyser.fftSize = 1024;
    meterBuf = new Float32Array(meterAnalyser.fftSize) as unknown as Float32Array<ArrayBuffer>;
    meterCtx.createMediaStreamSource(stream).connect(meterAnalyser);
    const tick = () => {
      if (!meterAnalyser || !meterBuf) return;
      meterRaf = requestAnimationFrame(tick);
      meterAnalyser.getFloatTimeDomainData(meterBuf);
      const rms = Math.sqrt(meterBuf.reduce((s, v) => s + v * v, 0) / meterBuf.length);
      peakDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    };
    meterRaf = requestAnimationFrame(tick);
  }

  async function handleTriggerFired(
    evt: { type: string; data: { peakDb: number; durationMs: number }; timestamp: number },
    triggerName: string
  ) {
    if (!$identity) return;
    const eventEnd = evt.timestamp + Math.ceil(evt.data.durationMs / 1000);
    const from = evt.timestamp - PRE_ROLL_S;
    const to = eventEnd + POST_ROLL_S;
    let footageRefId: string | null = null;
    if (isStoring($monitorState)) {
      // Pin any pre-roll segments that exist right now so enforceRollingBuffer won't evict them.
      const preSegIds = await pinRange(from, Math.floor(Date.now() / 1000));
      const ref = await createFootageRef({
        originMonitor: $identity.pubkey,
        type: $settings.videoConfig.recordVideo ? 'video' : 'video',
        startTime: from,
        endTime: to,
        segmentIds: preSegIds,
        snapshotIds: [],
        pinned: false,
      });
      footageRefId = ref.refId;
      // After the post-roll window closes, pin the post-roll segments and update the ref.
      const refId = ref.refId;
      setTimeout(async () => {
        const allSegIds = await pinRange(from, to);
        await updateFootageRef(refId, { segmentIds: allSegIds });
        dbg('info', 'idb', `footage ref updated post-roll: ${refId.slice(0, 8)}… segs:${allSegIds.length}`);
      }, POST_ROLL_S * 1000);
    }
    const relays = getRelays();
    for (const device of $pairedDevices) {
      const ev = buildTriggerEvent(
        $identity.privkey, $identity.pubkey, device.pubkey,
        evt.type, $settings.selfLabel,
        { peakDb: evt.data.peakDb, durationMs: evt.data.durationMs, triggerName },
        footageRefId
      );
      if (isPublishing($monitorState) && !$settings.pauseNostr) {
        try { await publish(ev); } catch { await enqueue(ev, relays); }
      } else {
        await enqueue(ev, relays);
      }
    }
  }

  function stopMonitor() {
    transitionMonitor('stopping');
    if (meterRaf !== null) cancelAnimationFrame(meterRaf);
    meterCtx?.close();
    detectors.forEach(d => d.stop());
    detectors = [];
    recorder?.stop();
    stream?.getTracks().forEach(t => t.stop());
    setMonitorStream(null);
    stopAllMonitorSessions();
    stream = null;
    recorder = null;
    transitionMonitor('idle');
    peakDb = -Infinity;
  }

  onDestroy(() => {
    stopMonitor();
    stopRouter();
    clearInterval(sessionTick);
  });

  const meterPct = $derived(Math.max(0, Math.min(100, (peakDb + 60) * (100 / 60))));
  const isActive = $derived($monitorState === 'active' || $monitorState === 'starting');
</script>

<DevSection title="Sentry" badge={isActive ? 'RUNNING' : armed ? 'ARMED' : 'IDLE'} badgeColor={isActive ? 'var(--color-success)' : armed ? 'var(--color-danger)' : 'var(--color-border)'}>

  <!-- Controls -->
  <div class="ctrl-row">
    {#if isActive}
      <button class="act-btn danger" onclick={stopMonitor}>Stop Monitor</button>
    {:else}
      <button class="act-btn accent" onclick={startMonitor} disabled={$monitorState === 'starting'}>
        {$monitorState === 'starting' ? 'Starting…' : 'Start Monitor'}
      </button>
    {/if}
    <button
      class="arm-btn"
      style="background:{armed ? 'var(--color-danger)' : 'var(--color-success)'}"
      onclick={() => (armed = !armed)}
    >{armed ? 'Disarm' : 'Arm'}</button>
  </div>

  {#if error}
    <div class="err-msg">{error}</div>
  {/if}

  <!-- Camera -->
  <video bind:this={videoEl} autoplay muted playsinline class="camera-preview" class:hidden={!isActive || !$settings.videoConfig.recordVideo}></video>

  <!-- Microphone meter -->
  <div class="meter-row">
    <span class="meter-lbl">Microphone</span>
    <div class="meter-track">
      <div class="meter-fill" style="width:{meterPct}%;background:{isFinite(peakDb) && $triggers.some(t => t.enabled && peakDb > t.thresholdDb) ? 'var(--color-danger)' : 'var(--color-success)'}"></div>
    </div>
    <span class="meter-db">{isFinite(peakDb) ? peakDb.toFixed(1) + ' dB' : '—'}</span>
  </div>

  <!-- Signal router toggle -->
  <div class="toggle-row">
    <span class="toggle-lbl">Listen for Nostr WebRTC requests</span>
    <button
      class="toggle-pill"
      style="background:{signalRouterActive ? 'var(--color-accent)' : 'var(--color-border)'}"
      onclick={() => signalRouterActive ? stopRouter() : startRouter()}
    >
      <span class="pill-thumb" style="transform:translateX({signalRouterActive ? '22px' : '4px'})"></span>
    </button>
    <span class="small muted">{signalRouterActive ? 'On' : 'Off'}</span>
  </div>

  <!-- Auto-accept toggle -->
  <div class="toggle-row">
    <span class="toggle-lbl">Inbound RTC requests Auto-accept</span>
    <button
      class="toggle-pill"
      style="background:{autoAccept ? 'var(--color-success)' : 'var(--color-border)'}"
      onclick={() => (autoAccept = !autoAccept)}
    >
      <span class="pill-thumb" style="transform:translateX({autoAccept ? '22px' : '4px'})"></span>
    </button>
    <span class="small muted">{autoAccept ? 'On' : 'Off'}</span>
  </div>

  <!-- Active RTC sessions -->
  {#if sessions.length > 0}
    <div class="subsec-title">Active connections ({sessions.length})</div>
    {#each sessions as sess (sess.viewerPubkey)}
      <div class="session-row">
        <span class="sess-nick">{$pairedDevices.find(d => d.pubkey === sess.viewerPubkey)?.nickname ?? sess.viewerPubkey.slice(0, 12) + '…'}</span>
        <span class="sess-state">ICE: <b>{sess.iceState}</b></span>
        <span class="sess-state">DC: {sess.dcState ?? '—'}</span>
        <span class="sess-state">{sess.trackCount} tracks</span>
        <button class="act-btn" onclick={() => (showPreview[sess.viewerPubkey] = !showPreview[sess.viewerPubkey])}>
          {showPreview[sess.viewerPubkey] ? 'Hide' : 'Show'} Preview
        </button>
        <button class="act-btn danger" onclick={() => { stopAllMonitorSessions(); sessions = []; }}>Disconnect</button>
      </div>
      {#if showPreview[sess.viewerPubkey] && stream}
        <video class="rtc-preview" autoplay muted playsinline srcObject={stream}></video>
      {/if}
    {/each}
  {/if}

  <LogPanel sources={['rtc', 'detector']} />
</DevSection>

<style>
  .ctrl-row { display: flex; align-items: center; gap: 8px; }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }
  .arm-btn { font-size: 11px; padding: 4px 16px; border-radius: 6px; border: none; color: white; font-weight: 700; cursor: pointer; font-family: inherit; }
  .err-msg { font-size: 11px; color: var(--color-danger); padding: 4px 8px; background: rgba(239,68,68,0.1); border-radius: 4px; }
  .camera-preview { width: 100%; border-radius: 8px; background: #000; max-height: 220px; }
  .camera-preview.hidden { display: none; }
  .meter-row { display: flex; align-items: center; gap: 8px; }
  .meter-lbl { font-size: 11px; color: var(--color-muted); width: 80px; flex-shrink: 0; }
  .meter-track { flex: 1; height: 8px; border-radius: 4px; background: var(--color-surface); overflow: hidden; }
  .meter-fill { height: 100%; border-radius: 4px; transition: width 0.075s; }
  .meter-db { font-size: 11px; color: var(--color-muted); font-family: ui-monospace, monospace; width: 70px; text-align: right; }
  .toggle-row { display: flex; align-items: center; gap: 8px; }
  .toggle-lbl { font-size: 11px; color: var(--color-text); flex: 1; }
  .toggle-pill { width: 36px; height: 20px; border-radius: 10px; border: none; padding: 0; cursor: pointer; position: relative; flex-shrink: 0; overflow: hidden; transition: background 0.15s; }
  .pill-thumb { position: absolute; top: 3px; left: 0; width: 14px; height: 14px; border-radius: 50%; background: white; transition: transform 0.15s; }
  .small { font-size: 11px; }
  .muted { color: var(--color-muted); }
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); }
  .session-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; background: var(--color-surface); font-size: 11px; flex-wrap: wrap; }
  .sess-nick { font-weight: 600; color: var(--color-text); min-width: 80px; }
  .sess-state { color: var(--color-muted); }
  .rtc-preview { width: 100%; border-radius: 6px; background: #000; max-height: 160px; margin-top: 2px; }
</style>
