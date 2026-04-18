<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { identity, pairedDevices } from "$lib/store/identity";
  import { settings, saveSettings } from "$lib/store/settings";
  import { triggers, loadTriggers } from "$lib/store/triggers";
  import { AudioDetector } from "$lib/detectors/audio";
  import { buildTriggerEvent } from "$lib/nostr/events";
  import { publish } from "$lib/nostr/client";
  import {
    saveSegment,
    pinRange,
    PRE_ROLL_S,
    POST_ROLL_S,
  } from "$lib/db/segments";
  import { openDB } from "$lib/db/idb";
  import {
    startMonitorSignaling,
    stopMonitorSignaling,
  } from "$lib/webrtc/monitor-peer";

  let armed = $state(false);
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let detectors: AudioDetector[] = [];
  let peakDb = $state(-Infinity);
  let videoEl: HTMLVideoElement | undefined = $state();
  let error = $state("");
  let recentEventCount = $state(0);

  // Segment boundary tracking for MediaRecorder
  let segmentStart = 0;

  async function startMonitor() {
    if (!$identity) return;
    error = "";
    await loadTriggers();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (videoEl) videoEl.srcObject = stream;

      startRecording();
      startDetectors();
      startMonitorSignaling($identity.privkey, $identity.pubkey, stream);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to access camera/mic";
    }
  }

  function startRecording() {
    if (!stream) return;

    let mimeType: string;
    let recordStream: MediaStream;
    if ($settings.recordVideo) {
      mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
          ? "video/webm;codecs=vp8,opus"
          : "video/webm";
      recordStream = stream;
    } else {
      mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      recordStream = new MediaStream(stream.getAudioTracks());
    }

    recorder = new MediaRecorder(recordStream, { mimeType });

    // MediaRecorder with timeslice produces WebM fragments: only the first chunk
    // contains the EBML initialization header. Subsequent chunks are bare Clusters
    // that aren't independently decodable. We prepend the init chunk to every
    // subsequent chunk so each saved segment is self-contained.
    let initChunk: Blob | null = null;

    recorder.ondataavailable = async (e) => {
      if (e.data.size === 0) return;
      const now = Math.floor(Date.now() / 1000);
      const start = segmentStart || now - 10;
      const end = now;
      segmentStart = now;
      const blob = initChunk
        ? new Blob([initChunk, e.data], { type: mimeType })
        : new Blob([e.data], { type: mimeType });
      if (!initChunk) initChunk = e.data;
      await saveSegment(blob, mimeType, start, end);
    };

    segmentStart = Math.floor(Date.now() / 1000);
    recorder.start(10_000);
  }

  function startDetectors() {
    if (!stream) return;
    detectors.forEach((d) => d.stop());
    detectors = [];

    const activeTriggers = $triggers.filter((t) => t.enabled);
    for (const cfg of activeTriggers) {
      const det = new AudioDetector(cfg);
      det.onDetection = async (evt) => {
        // Update the audio meter with the latest peak (use first detector for display)
        peakDb = evt.data.peakDb;
        if (!armed || !$identity) return;
        await handleTriggerFired(evt, cfg.name);
      };
      det.start(stream);
      detectors.push(det);
    }

    // Also run a display-only analyser for the audio meter (no threshold)
    const meterDet = new AudioDetector({
      thresholdDb: -Infinity,
      cooldownMs: 0,
      minDurationMs: 0,
    });
    meterDet.onDetection = null;
    // Hack: tap into the analyser for meter display using the first detector's peak readings
    // We instead run a separate loop for the meter
    runMeterLoop();
  }

  let meterCtx: AudioContext | null = null;
  let meterAnalyser: AnalyserNode | null = null;
  let meterRafId: number | null = null;
  let meterBuf: Float32Array<ArrayBuffer> | null = null;

  function runMeterLoop() {
    if (!stream) return;
    meterCtx = new AudioContext();
    meterAnalyser = meterCtx.createAnalyser();
    meterAnalyser.fftSize = 1024;
    meterBuf = new Float32Array(
      meterAnalyser.fftSize,
    ) as unknown as Float32Array<ArrayBuffer>;
    meterCtx.createMediaStreamSource(stream).connect(meterAnalyser);

    const tick = () => {
      if (!meterAnalyser || !meterBuf) return;
      meterRafId = requestAnimationFrame(tick);
      meterAnalyser.getFloatTimeDomainData(meterBuf);
      const rms = Math.sqrt(
        meterBuf.reduce((s, v) => s + v * v, 0) / meterBuf.length,
      );
      peakDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    };
    meterRafId = requestAnimationFrame(tick);
  }

  async function handleTriggerFired(
    evt: {
      type: string;
      data: { peakDb: number; durationMs: number };
      timestamp: number;
    },
    triggerName: string,
  ) {
    const vp = $pairedDevices[0]?.pubkey;
    if (!vp || !$identity) return;

    // Pin the segments surrounding this event
    const eventEndTime = evt.timestamp + Math.ceil(evt.data.durationMs / 1000);
    await pinRange(evt.timestamp - PRE_ROLL_S, eventEndTime + POST_ROLL_S);

    // Publish Nostr trigger event (metadata only, no media payload)
    const nostrEvent = buildTriggerEvent(
      $identity.privkey,
      $identity.pubkey,
      vp,
      evt.type,
      $settings.monitorLabel,
      {
        peakDb: evt.data.peakDb,
        durationMs: evt.data.durationMs,
        triggerName,
      },
    );
    await publish(nostrEvent);

    // Store local copy in IDB for the monitor's own calendar
    const db = await openDB();
    await db.put("events", {
      id: nostrEvent.id,
      kind: nostrEvent.kind,
      created_at: nostrEvent.created_at,
      monitorPubkey: $identity.pubkey,
      type: evt.type,
      monitorLabel: $settings.monitorLabel,
      data: {
        peakDb: evt.data.peakDb,
        durationMs: evt.data.durationMs,
        triggerName,
      },
      raw: nostrEvent,
    });

    recentEventCount++;
  }

  function restartRecording() {
    recorder?.stop();
    recorder = null;
    startRecording();
  }

  async function toggleRecordMode() {
    await saveSettings({ ...$settings, recordVideo: !$settings.recordVideo });
    if (stream) restartRecording();
  }

  function stopMonitor() {
    if (meterRafId !== null) cancelAnimationFrame(meterRafId);
    meterCtx?.close();
    detectors.forEach((d) => d.stop());
    detectors = [];
    recorder?.stop();
    stream?.getTracks().forEach((t) => t.stop());
    stopMonitorSignaling();
    stream = null;
    recorder = null;
  }

  onMount(() => {
    startMonitor();
  });
  onDestroy(() => {
    stopMonitor();
  });
</script>

<svelte:head><title>Monitor — Senstry</title></svelte:head>

<main class="flex-1 flex flex-col gap-4 p-4" style="background:var(--color-bg)">
  <div class="flex items-center justify-between">
    <a href="/" class="text-sm" style="color:var(--color-accent)">← Home</a>
    <h1 class="text-lg font-bold" style="color:var(--color-text)">Monitor</h1>
    <span
      class="text-sm px-2 py-1 rounded"
      style="background:var(--color-surface);color:{armed
        ? 'var(--color-danger)'
        : 'var(--color-muted)'}">{armed ? "ARMED" : "DISARMED"}</span
    >
  </div>

  {#if error}
    <p class="text-sm text-center" style="color:var(--color-danger)">{error}</p>
  {/if}

  <video
    bind:this={videoEl}
    autoplay
    muted
    playsinline
    class="w-full rounded-xl"
    style="background:#000;max-height:40vh"
  ></video>

  <div class="flex items-center gap-3 px-2">
    <span class="text-xs w-16" style="color:var(--color-muted)">Audio</span>
    <div
      class="flex-1 h-2 rounded-full overflow-hidden"
      style="background:var(--color-surface)"
    >
      <div
        class="h-full rounded-full transition-all duration-75"
        style="width:{Math.max(
          0,
          Math.min(100, (peakDb + 60) * (100 / 60)),
        )}%;background:{isFinite(peakDb) &&
        $triggers.some((t) => t.enabled && peakDb > t.thresholdDb)
          ? 'var(--color-danger)'
          : 'var(--color-success)'}"
      ></div>
    </div>
    <span
      class="text-xs w-16 text-right font-mono"
      style="color:var(--color-muted)"
      >{isFinite(peakDb) ? peakDb.toFixed(0) + " dB" : "—"}</span
    >
  </div>

  <div class="flex items-center gap-3 px-2">
    <span class="text-xs w-16" style="color:var(--color-muted)">Record</span>
    <button
      onclick={toggleRecordMode}
      class="w-10 h-6 rounded-full relative shrink-0 transition-colors"
      style="background:{$settings.recordVideo
        ? 'var(--color-accent)'
        : 'var(--color-border)'}"
      aria-label="Toggle video recording"
    >
      <span
        class="absolute top-1 left-0 w-4 h-4 rounded-full transition-transform"
        style="background:white;transform:translateX({$settings.recordVideo
          ? '22px'
          : '4px'})"
      ></span>
    </button>
    <span class="text-xs" style="color:var(--color-muted)"
      >{$settings.recordVideo ? "video + audio" : "audio only"}</span
    >
  </div>

  <button
    onclick={() => (armed = !armed)}
    class="py-4 rounded-xl font-bold text-white text-lg"
    style="background:{armed ? 'var(--color-danger)' : 'var(--color-success)'}"
  >
    {armed ? "Disarm" : "Arm"}
  </button>

  {#if $triggers.filter((t) => t.enabled).length > 0}
    <div class="flex flex-col gap-1 px-1">
      {#each $triggers.filter((t) => t.enabled) as t}
        <p class="text-xs" style="color:var(--color-muted)">
          • {t.name}: {t.thresholdDb} dBFS trigger
        </p>
      {/each}
    </div>
  {/if}

  {#if recentEventCount > 0}
    <p class="text-xs text-center" style="color:var(--color-muted)">
      {recentEventCount} event{recentEventCount > 1 ? "s" : ""} this session
    </p>
  {/if}

  {#if $pairedDevices.length === 0}
    <p class="text-xs text-center" style="color:var(--color-warning)">
      No paired viewer — <a href="/pair" style="color:var(--color-accent)"
        >pair a device</a
      > to receive events.
    </p>
  {/if}
</main>
